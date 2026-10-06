importScripts('instagram-editor.js');
importScripts('threads-editor.js');
importScripts('tistory-editor.js');
importScripts('offline-blog-prompt.js');
importScripts('photo-writer/background-bridge.js');

const GEMINI_URL = "https://gemini.google.com/app";
const CHATGPT_URL = "https://chatgpt.com/";
const CLAUDE_URL = "https://claude.ai/new";
const GAS_BACKEND_URL = "https://script.google.com/macros/s/AKfycbxPo5h8XNl39Nv-jkMaNGY6UqaQh1H30rLc9eQjJ_6k25vSdwHALFcPTwAe5vZY0Iq-Ug/exec";
const SESSION_KEY = "naverBlogGeminiAssistantSession";
const TAB_COMPLETE_TIMEOUT_MS = 60000;
const DEBUG_LOG_KEY = "naverBlogGeminiAssistantDebugLog";
const DEBUG_LOG_LIMIT = 400;

let debugLogWriteQueue = Promise.resolve();
const chatGptSubmissionPhases = new Map();

void configureSidePanelBehavior();

chrome.runtime.onInstalled.addListener(() => {
  void configureSidePanelBehavior();
});

chrome.runtime.onStartup.addListener(() => {
  void configureSidePanelBehavior();
});

chrome.action.onClicked.addListener((tab) => {
  void openControlPanel(tab).catch((error) => {
    console.error("Failed to open Naver Blog AI side panel:", error);
  });
});

// 외부 스케줄러가 창을 포커스한 뒤 이 단축키를 보내면, 그 창의 사이드패널에만
// "한번에 실행"을 트리거합니다. 다른 창의 사이드패널은 windowId가 달라 무시합니다.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "nb-trigger-auto-write") return;
  try {
    const win = await chrome.windows.getLastFocused();
    if (!win?.id) return;
    chrome.runtime.sendMessage({ type: "NB_TRIGGER_RUN_ALL", windowId: win.id }).catch(() => {});
  } catch (error) {
    console.error("[nb-trigger-auto-write] failed:", error);
  }
});

// MV3 서비스 워커는 유휴 상태가 지속되면 중간에 종료될 수 있습니다. 사진 비전 분석·초안
// 생성처럼 수 분이 걸리는 작업 동안, 사이드패널(photo-writer)이 이 이름으로 포트를 열어두면
// 그 연결이 유지되는 동안 서비스 워커가 종료되지 않습니다. "message channel closed before
// a response was received" 오류(서비스 워커가 응답 전에 꺼짐)를 방지하기 위한 장치입니다.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "nb-keepalive") return;
  const ping = setInterval(() => {
    try { port.postMessage({ type: "ping" }); } catch (e) { clearInterval(ping); }
  }, 20000);
  port.onDisconnect.addListener(() => clearInterval(ping));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      void (async () => {
        if (!isDebugLogMessage(message)) {
          await appendBackgroundDebugLog("message.failed", {
            type: String(message?.type || ""),
            error: error?.message || String(error),
            sender: summarizeSender(sender),
          }).catch(() => {});
        }

        sendResponse({ ok: false, error: error?.message || String(error) });
      })();
    });

  return true;
});

async function handleMessage(message, sender) {
  if (message?.type === "NB_CHATGPT_PHASE") {
    const state = chatGptSubmissionPhases.get(String(message.requestId || ""));
    const validPhase = ["preparing", "send_started", "sent"].includes(message.phase);
    if (!state || sender.tab?.id !== state.tabId || !validPhase) return { recorded: false };
    state.phase = message.phase;
    return { recorded: true };
  }
  if (/^(GB_|NB_PHOTO_)/.test(String(message?.type || ''))) {
    return handlePhotoWriterMessage(message, sender);
  }
  if (!isDebugLogMessage(message)) {
    await appendBackgroundDebugLog("message.received", {
      type: String(message?.type || ""),
      sender: summarizeSender(sender),
      payload: summarizeMessageForLog(message),
    });
  }

  let result;

  switch (message?.type) {
    case "NB_OPEN_PANEL": {
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await openControlPanel(activeTab || sender.tab);
      result = { context: await getPanelContext() };
      break;
    }
    case "NB_GET_CONTEXT": {
      result = { context: await getPanelContext() };
      break;
    }
    case "NB_BIND_ACTIVE_TAB": {
      const naverTab = await bindActiveNaverTab();
      result = { context: await getPanelContext(), naverTab };
      break;
    }
    case "NB_AUTO_OPEN_NAVER_WRITE": {
      const naverTab = await autoOpenAndBindNaverWrite(message.blogId, message.categoryNo);
      result = { context: await getPanelContext(), naverTab };
      break;
    }
    case "NB_OPEN_GEMINI": {
      const geminiPopup = await openGeminiPopup({ focus: true });
      result = { geminiTabId: geminiPopup.tabId, context: await getPanelContext() };
      break;
    }
    case "NB_OPEN_AI": {
      const provider = resolveAiProviderValue(message.provider);
      const popup = provider === "claude" ? await openClaudePopup({ focus: true })
        : provider === "chatgpt" ? await openChatGptPopup({ focus: true })
          : await openGeminiPopup({ focus: true });
      result = { provider, aiTabId: popup.tabId, context: await getPanelContext() };
      break;
    }
    case "NB_SUBMIT_GEMINI": {
      const geminiResult = await runGeminiPromptInPopup(message.prompt, message.options || {});
      result = { response: geminiResult.response, geminiTabId: geminiResult.tabId, context: await getPanelContext() };
      break;
    }
    case "NB_SUBMIT_AI": {
      const provider = resolveAiProviderValue(message.provider);
      const aiResult = provider === "claude" ? await runClaudePromptInPopup(message.prompt, message.options || {})
        : provider === "chatgpt" ? await runChatGptPromptInPopup(message.prompt, message.options || {})
          : await runGeminiPromptInPopup(message.prompt, message.options || {});
      result = { provider, response: aiResult.response, aiTabId: aiResult.tabId,
        ...(['chatgpt', 'claude'].includes(provider) ? { popupClosed: aiResult.popupClosed } : {}),
        context: await getPanelContext() };
      break;
    }
    case "NB_CALL_GAS_BACKEND": {
      const gasResponse = await callGasBackend(message.request || {});
      result = { gasResponse };
      break;
    }
    case "FREE_PASS_ISSUED": {
      result = { acknowledged: true };
      break;
    }
    case "NB_FETCH_IMAGE_AS_DATA_URL": {
      const dataUrl = await fetchRemoteImageAsDataUrl(message.url);
      result = { dataUrl };
      break;
    }
    case "NB_SEARCH_GOOGLE_IMAGES": {
      const searchResult = await searchGoogleImages(message.query, {
        maxResults: message.maxResults,
      });
      result = searchResult;
      break;
    }
    case "NB_COLLECT_NAVER_BLOG_SEARCH_RESEARCH": {
      const research = await collectNaverBlogSearchResearch(message.keyword, {
        maxResults: message.maxResults,
        source: message.source,
      });
      result = { research };
      break;
    }
    case "NB_INSERT_POST": {
      const insertion = await insertPostIntoNaverEditor(message.payload || {}, message.tabId);
      result = { insertion, context: await getPanelContext() };
      break;
    }
    case "NB_ADD_DEBUG_LOG": {
      await appendDebugLogEntry(
        String(message?.entry?.source || "unknown"),
        String(message?.entry?.event || "event"),
        message?.entry?.details || {}
      );
      result = { appended: true };
      break;
    }
    case "NB_GET_DEBUG_LOG": {
      const entries = await getDebugLogEntries();
      result = {
        entries,
        formattedLog: formatDebugLogEntries(entries),
      };
      break;
    }
    case "NB_CLOSE_AI": {
      await closeAllAiWindows();
      result = { closed: true };
      break;
    }
    case "NB_CLEAR_DEBUG_LOG": {
      await clearDebugLogEntries();
      result = { cleared: true };
      break;
    }
    default:
      throw new Error("알 수 없는 요청입니다.");
  }

  if (!isDebugLogMessage(message)) {
    await appendBackgroundDebugLog("message.completed", {
      type: String(message?.type || ""),
      result: summarizeResultForLog(message?.type, result),
    });
  }

  return result;
}

async function openControlPanel(tab) {
  if (!tab?.id) {
    throw new Error("현재 탭을 찾지 못했습니다.");
  }

  if (isNaverBlogUrl(tab.url || "") && (getNaverEditorKind(tab.url || '') !== 'tistory' || await isKoreanTistoryMode())) {
    await updateSession({ naverTabId: tab.id });
  }
}

async function configureSidePanelBehavior() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

function resolveAiProviderValue(value) {
  const normalized = String(value || "gemini").trim().toLowerCase();
  return ["gemini", "chatgpt", "claude"].includes(normalized) ? normalized : "gemini";
}

async function callGasBackend(request) {
  const action = String(request?.action || "").trim().toUpperCase();
  const allowedActions = new Set(["VERIFY_KEY", "BUILD_BLOG_PROMPT", "RECORD_YOUTUBE_MEMBERSHIP", "CHECK_YOUTUBE_MEMBERSHIP_TIER"]);

  if (!allowedActions.has(action)) {
    throw new Error("허용되지 않은 백엔드 요청입니다.");
  }

  const requestBody = {
    licenseKey: String(request?.licenseKey || "").trim(),
    deviceId: String(request?.deviceId || "").trim(),
    action,
  };

  if (!requestBody.deviceId) {
    throw new Error("기기 인증 정보를 찾지 못했습니다.");
  }

  if (action === "BUILD_BLOG_PROMPT" || action === "RECORD_YOUTUBE_MEMBERSHIP" || action === "CHECK_YOUTUBE_MEMBERSHIP_TIER") {
    requestBody.payload = request?.payload && typeof request.payload === "object"
      ? request.payload
      : {};
  }

  // 라이선스/리워드 관련 로직을 제거하고, GAS 백엔드를 직접 호출합니다.
  return callGasDirect(requestBody);
}

// GAS 백엔드에 직접 요청을 보내는 함수 (reward-fallback.js의 함수 대체)
async function callGasDirect(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18000);
  try {
    const response = await fetch(GAS_BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(request),
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch {}
    if (data?.ok === false) return data;
    if (!response.ok) {
      throw new Error(data?.error || `Apps Script HTTP ${response.status}`);
    }
    if (typeof data?.ok !== "boolean") {
      throw new Error("Apps Script 백엔드 응답 형식이 올바르지 않습니다.");
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function isNaverBlogUrl(url) {
  try {
    const { hostname, pathname } = new URL(url);
    const isBlogEditor = hostname === "blog.naver.com"
      || hostname === "m.blog.naver.com"
      || hostname === "blog.editor.naver.com"
      || hostname === "editor.naver.com";
    const isCafeEditor = hostname === "cafe.naver.com"
      && (/^\/ca-fe\/cafes\/\d+\/(?:menus\/\d+\/)?articles\/write(?:\/|$)/i.test(pathname)
        || /\/(?:ArticleWrite|ArticleWriteForm)\.nhn$/i.test(pathname));
    const isBloggerEditor = (hostname === "www.blogger.com" || hostname === "draft.blogger.com")
      && /^\/blog\/post\/(?:edit|create)(?:\/|$)/i.test(pathname);
    const isTistoryEditor = /^[a-z0-9-]+\.tistory\.com$/i.test(hostname)
      && /^\/manage\/(?:newpost|post)(?:\/|$)/i.test(pathname);

    const isInstagram = hostname === 'www.instagram.com'
      && !/^\/(accounts|direct|oauth|challenge)(?:\/|$)/i.test(pathname);
    const isThreads = ['www.threads.com', 'www.threads.net'].includes(hostname)
      && (pathname === '/' || /^\/@[^/]+\/?$/.test(pathname) || /^\/(?:for_you|following)\/?$/.test(pathname));
    return isBlogEditor || isCafeEditor || isBloggerEditor || isTistoryEditor || isInstagram || isThreads;
  } catch {
    return false;
  }
}

function getNaverEditorKind(url) {
  try {
    const hostname = new URL(url).hostname;

    if (hostname === 'www.instagram.com') return 'instagram';
    if (['www.threads.com', 'www.threads.net'].includes(hostname)) return 'threads';

    if (hostname === "cafe.naver.com") {
      return "cafe";
    }

    if (hostname === "www.blogger.com" || hostname === "draft.blogger.com") {
      return "blogger";
    }

    if (/^[a-z0-9-]+\.tistory\.com$/i.test(hostname)) return "tistory";

    return "blog";
  } catch {
    return "blog";
  }
}

async function isKoreanTistoryMode() {
  const saved = await chrome.storage.local.get('ddalkkakUiLanguage');
  const selected = String(saved.ddalkkakUiLanguage || 'auto');
  if (selected !== 'auto') return selected === 'ko';
  return /^ko(?:-|$)/i.test(String(chrome.i18n?.getUILanguage?.() || navigator.language || ''));
}

async function bindActiveNaverTab() {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  if (!activeTab?.id || !isNaverBlogUrl(activeTab.url || "")) {
    throw new Error("현재 활성 탭이 지원되는 글쓰기 페이지가 아닙니다.");
  }

  if (getNaverEditorKind(activeTab.url || "") === "tistory" && !(await isKoreanTistoryMode())) {
    throw new Error("티스토리는 한국어 화면에서만 사용할 수 있습니다.");
  }

  await updateSession({ naverTabId: activeTab.id });
  return summarizeTab(activeTab);
}

// 사용자가 등록해 둔 본인 네이버 블로그 ID로, 현재 탭을 글쓰기 화면으로 직접 이동시킨 뒤
// 연결까지 자동으로 처리합니다. "현재 탭 연결하기"를 수동으로 누르는 수고를 줄여줍니다.
async function autoOpenAndBindNaverWrite(blogId, categoryNo) {
  const safeBlogId = String(blogId || "").trim();
  if (!safeBlogId) {
    throw new Error("네이버 블로그 ID가 설정되지 않았습니다. 설정에서 먼저 입력해 주세요.");
  }

  let url = `https://blog.naver.com/${encodeURIComponent(safeBlogId)}?Redirect=Write`;
  const safeCategoryNo = String(categoryNo || "").trim();
  if (safeCategoryNo) {
    url += `&categoryNo=${encodeURIComponent(safeCategoryNo)}`;
  }

  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  let targetTabId;
  if (activeTab?.id) {
    await chrome.tabs.update(activeTab.id, { url, active: true });
    targetTabId = activeTab.id;
  } else {
    const newTab = await chrome.tabs.create({ url, active: true });
    targetTabId = newTab.id;
  }

  await waitForTabComplete(targetTabId, 20000);

  const tab = await getTabSafely(targetTabId);
  if (!tab || !isNaverBlogUrl(tab.url || "")) {
    throw new Error("네이버 블로그 글쓰기 페이지로 이동하지 못했습니다. 블로그 ID를 확인해 주세요.");
  }

  await updateSession({ naverTabId: targetTabId });
  return summarizeTab(tab);
}

async function runGeminiPromptInPopup(prompt, options) {
  await appendBackgroundDebugLog("gemini.popup.run.started", {
    promptLength: String(prompt || "").length,
    promptPreview: summarizeTextForLog(prompt || "", 180),
    options: sanitizeLogValue(options),
  });
  const geminiPopup = await openGeminiPopup({ focus: true });

  try {
    const response = await sendPromptToGemini(geminiPopup.tabId, prompt, options);
    await closeWindowSafely(geminiPopup.windowId);
    await appendBackgroundDebugLog("gemini.popup.run.completed", {
      tabId: geminiPopup.tabId,
      textLength: String(response.text || "").length,
      imageCount: Array.isArray(response.images) ? response.images.length : 0,
    });
    return {
      response,
      tabId: geminiPopup.tabId,
    };
  } catch (error) {
    await appendBackgroundDebugLog("gemini.popup.run.failed", {
      tabId: geminiPopup.tabId,
      error: error?.message || String(error),
    }).catch(() => {});
    throw error;
  }
}

let activeGeminiWindowId = null;
let activeGeminiTabId = null;
let activeChatGptWindowId = null;
let activeChatGptTabId = null;

async function windowExists(windowId) {
  if (!windowId) return false;
  try {
    const win = await chrome.windows.get(windowId);
    return Boolean(win?.id);
  } catch {
    return false;
  }
}

async function closeAllAiWindows() {
  activeGeminiWindowId = null;
  activeGeminiTabId = null;
  activeChatGptWindowId = null;
  activeChatGptTabId = null;

  try {
    const allWindows = await chrome.windows.getAll({ populate: true });
    for (const win of allWindows) {
      const hasAi = win.tabs?.some((t) => t.url && (t.url.includes("gemini.google.com") || t.url.includes("chatgpt.com") || t.url.includes("chat.openai.com")));
      if (hasAi && win.type === "popup") {
        await chrome.windows.remove(win.id).catch(() => {});
      }
    }
  } catch (err) {
    console.warn("AI 팝업 창 일괄 닫기 오류:", err);
  }
}

async function openGeminiPopup({ focus }) {
  // 1. 기존 활성 팝업 재사용
  if (activeGeminiWindowId) {
    const isAlive = await windowExists(activeGeminiWindowId);
    if (isAlive && activeGeminiTabId) {
      if (focus) {
        await chrome.windows.update(activeGeminiWindowId, { focused: true }).catch(() => {});
      }
      return { windowId: activeGeminiWindowId, tabId: activeGeminiTabId };
    }
  }

  // 2. 다른 열려있는 Gemini 팝업 탐색 및 재사용
  try {
    const allWindows = await chrome.windows.getAll({ populate: true });
    for (const win of allWindows) {
      if (win.type === "popup") {
        const geminiTab = win.tabs?.find((t) => t.url && isGeminiUrl(t.url));
        if (geminiTab?.id) {
          activeGeminiWindowId = win.id;
          activeGeminiTabId = geminiTab.id;
          if (focus) {
            await chrome.windows.update(win.id, { focused: true }).catch(() => {});
          }
          await prepareGeminiTab(geminiTab.id, focus);
          return { windowId: win.id, tabId: geminiTab.id };
        }
      }
    }
  } catch {}

  // 3. 새로 생성
  const anchorWindow = await getLastFocusedWindowSafe();
  const popupWindow = await chrome.windows.create(buildGeminiPopupCreateData(anchorWindow, focus));
  const windowId = popupWindow.id;

  try {
    if (!windowId) {
      throw new Error("Gemini 팝업 창을 만들지 못했습니다.");
    }

    const popupTab = await waitForWindowPrimaryTab(windowId, TAB_COMPLETE_TIMEOUT_MS);
    await waitForTabComplete(popupTab.id, TAB_COMPLETE_TIMEOUT_MS);
    await prepareGeminiTab(popupTab.id, focus);

    activeGeminiWindowId = windowId;
    activeGeminiTabId = popupTab.id;

    await appendBackgroundDebugLog("gemini.popup.ready", {
      windowId,
      tabId: popupTab.id,
      focus: Boolean(focus),
    });

    return {
      windowId,
      tabId: popupTab.id,
    };
  } catch (error) {
    if (windowId) {
      await closeWindowSafely(windowId);
    }
    throw error;
  }
}

function buildGeminiPopupCreateData(anchorWindow, focus) {
  const anchorWidth = typeof anchorWindow?.width === "number" ? anchorWindow.width : 1440;
  const anchorHeight = typeof anchorWindow?.height === "number" ? anchorWindow.height : 960;
  const width = Math.max(960, Math.min(1280, Math.round(anchorWidth * 0.82)));
  const height = Math.max(760, Math.min(960, Math.round(anchorHeight * 0.9)));
  const createData = {
    url: GEMINI_URL,
    type: "popup",
    width,
    height,
    focused: Boolean(focus),
  };

  if (
    typeof anchorWindow?.left === "number"
    && typeof anchorWindow?.top === "number"
    && typeof anchorWindow?.width === "number"
    && typeof anchorWindow?.height === "number"
  ) {
    createData.left = anchorWindow.left + Math.max(0, Math.floor((anchorWindow.width - width) / 2));
    createData.top = anchorWindow.top + Math.max(0, Math.floor((anchorWindow.height - height) / 2));
  }

  return createData;
}

async function waitForWindowPrimaryTab(windowId, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const tabs = await chrome.tabs.query({ windowId });
    const popupTab = tabs.find((tab) => tab.active && isGeminiUrl(tab.url || GEMINI_URL))
      || tabs.find((tab) => isGeminiUrl(tab.url || GEMINI_URL))
      || tabs[0];

    if (popupTab?.id) {
      return popupTab;
    }

    await sleep(150);
  }

  throw new Error("Gemini 팝업 탭을 찾지 못했습니다.");
}

function isGeminiUrl(url) {
  try {
    return new URL(url).hostname === "gemini.google.com";
  } catch {
    return false;
  }
}

async function prepareGeminiTab(tabId, focus) {
  await waitForTabComplete(tabId, TAB_COMPLETE_TIMEOUT_MS).catch(() => {});
  await ensureGeminiContentScript(tabId);

  if (focus) {
    const tab = await getTabSafely(tabId);
    if (tab?.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  }
}

async function getLastFocusedWindowSafe() {
  try {
    return await chrome.windows.getLastFocused();
  } catch {
    return null;
  }
}

async function ensureGeminiContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "NB_GEMINI_PING" });
    return;
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["gemini-content.js"],
    });
  }
}

async function sendPromptToGemini(tabId, prompt, options) {
  if (!String(prompt || "").trim()) {
    throw new Error("Gemini에 보낼 프롬프트가 비어 있습니다.");
  }

  // Gemini는 긴 HTML 응답을 종종 Canvas(몰입형 문서)로 전환하는데, Canvas 소스를
  // 긁어오는 과정이 불안정해 "eof" 같은 깨진 텍스트가 섞여 들어가는 문제가 있었습니다.
  // Claude/ChatGPT처럼 일반 채팅 말풍선 코드블록으로만 답하도록 지시해 Canvas 진입 자체를 막습니다.
  const effectivePrompt = options?.imageMode === true
    ? prompt
    : `${prompt}\n\n[중요] 반드시 일반 채팅 말풍선 안에 \`\`\`html 코드블록으로만 답변하세요. Canvas나 몰입형 문서(Immersive) 모드를 사용하지 마세요.`;

  await appendBackgroundDebugLog("gemini.message.send.started", {
    tabId,
    promptLength: String(effectivePrompt || "").length,
    promptPreview: summarizeTextForLog(effectivePrompt || "", 180),
    options: sanitizeLogValue(options),
  });

  await ensureGeminiContentScript(tabId);
  const result = await chrome.tabs.sendMessage(tabId, {
    type: "NB_GEMINI_SUBMIT",
    prompt: effectivePrompt,
    options,
  });

  if (!result?.ok) {
    throw new Error(result?.error || "Gemini 응답을 가져오지 못했습니다.");
  }

  await appendBackgroundDebugLog("gemini.message.send.completed", {
    tabId,
    textLength: String(result.text || "").length,
    imageCount: Array.isArray(result.images) ? result.images.length : 0,
  });

  return {
    text: result.text || "",
    images: Array.isArray(result.images) ? result.images : [],
  };
}

async function runChatGptPromptInPopup(prompt, options) {
  await appendBackgroundDebugLog("chatgpt.popup.run.started", {
    promptLength: String(prompt || "").length,
    promptPreview: summarizeTextForLog(prompt || "", 180),
    options: sanitizeLogValue(options),
  });
  const chatGptPopup = await openChatGptPopup({ focus: true });

  try {
    const response = await sendPromptToChatGpt(chatGptPopup.tabId, prompt, options);
    const popupClose = await closeGeneratedChatGptPopup(chatGptPopup.windowId, chatGptPopup.tabId);
    await appendBackgroundDebugLog("chatgpt.popup.run.completed", {
      tabId: chatGptPopup.tabId,
      textLength: String(response.text || "").length,
      imageCount: Array.isArray(response.images) ? response.images.length : 0,
      popupClosed: popupClose.closed,
      popupCloseMethod: popupClose.method,
    });
    return {
      response,
      tabId: chatGptPopup.tabId,
      popupClosed: popupClose.closed,
    };
  } catch (error) {
    await appendBackgroundDebugLog("chatgpt.popup.run.failed", {
      tabId: chatGptPopup.tabId,
      error: error?.message || String(error),
    }).catch(() => {});
    throw error;
  }
}

async function openChatGptPopup({ focus }) {
  const anchorWindow = await getLastFocusedWindowSafe();
  const popupWindow = await chrome.windows.create(buildChatGptPopupCreateData(anchorWindow, focus));
  const windowId = popupWindow.id;

  try {
    if (!windowId) {
      throw new Error("ChatGPT 팝업 창을 만들지 못했습니다.");
    }

    const popupTab = await waitForChatGptWindowPrimaryTab(windowId, TAB_COMPLETE_TIMEOUT_MS);
    await waitForTabComplete(popupTab.id, TAB_COMPLETE_TIMEOUT_MS);
    await prepareChatGptTab(popupTab.id, focus);

    await appendBackgroundDebugLog("chatgpt.popup.ready", {
      windowId,
      tabId: popupTab.id,
      focus: Boolean(focus),
    });

    return {
      windowId,
      tabId: popupTab.id,
    };
  } catch (error) {
    if (windowId) {
      await closeWindowSafely(windowId);
    }
    throw error;
  }
}

function buildChatGptPopupCreateData(anchorWindow, focus) {
  const anchorWidth = typeof anchorWindow?.width === "number" ? anchorWindow.width : 1440;
  const anchorHeight = typeof anchorWindow?.height === "number" ? anchorWindow.height : 960;
  const width = Math.max(960, Math.min(1280, Math.round(anchorWidth * 0.82)));
  const height = Math.max(760, Math.min(960, Math.round(anchorHeight * 0.9)));
  const createData = {
    url: CHATGPT_URL,
    type: "popup",
    width,
    height,
    focused: Boolean(focus),
  };

  if (
    typeof anchorWindow?.left === "number"
    && typeof anchorWindow?.top === "number"
    && typeof anchorWindow?.width === "number"
    && typeof anchorWindow?.height === "number"
  ) {
    createData.left = anchorWindow.left + Math.max(0, Math.floor((anchorWindow.width - width) / 2));
    createData.top = anchorWindow.top + Math.max(0, Math.floor((anchorWindow.height - height) / 2));
  }

  return createData;
}

async function waitForChatGptWindowPrimaryTab(windowId, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const tabs = await chrome.tabs.query({ windowId });
    const popupTab = tabs.find((tab) => tab.active && isChatGptUrl(tab.url || CHATGPT_URL))
      || tabs.find((tab) => isChatGptUrl(tab.url || CHATGPT_URL))
      || tabs[0];

    if (popupTab?.id) {
      return popupTab;
    }

    await sleep(150);
  }

  throw new Error("ChatGPT 팝업 탭을 찾지 못했습니다.");
}

function isChatGptUrl(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === "chatgpt.com" || hostname === "chat.openai.com";
  } catch {
    return false;
  }
}

async function prepareChatGptTab(tabId, focus) {
  await waitForTabComplete(tabId, TAB_COMPLETE_TIMEOUT_MS).catch(() => {});
  await ensureChatGptContentScript(tabId);

  if (focus) {
    const tab = await getTabSafely(tabId);
    if (tab?.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  }
}

async function ensureChatGptContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "NB_CHATGPT_PING" });
    return;
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["chatgpt-content.js"],
    });
  }
}

async function sendPromptToChatGpt(tabId, prompt, options) {
  if (!String(prompt || "").trim()) {
    throw new Error("ChatGPT에 보낼 프롬프트가 비어 있습니다.");
  }

  await appendBackgroundDebugLog("chatgpt.message.send.started", {
    tabId,
    promptLength: String(prompt || "").length,
    promptPreview: summarizeTextForLog(prompt || "", 180),
    options: sanitizeLogValue(options),
  });

  let result;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const requestId = crypto.randomUUID();
    const submissionState = { tabId, phase: "unknown" };
    chatGptSubmissionPhases.set(requestId, submissionState);
    try {
      await ensureChatGptContentScript(tabId);
      result = await chrome.tabs.sendMessage(tabId, {
        type: "NB_CHATGPT_SUBMIT",
        requestId,
        prompt,
        options,
      });
      break;
    } catch (error) {
      const safeToRetry = attempt === 1 && submissionState.phase === "preparing"
        && /message channel closed before a response|receiving end does not exist/i.test(String(error?.message || ""));
      if (!safeToRetry) throw error;
      await appendBackgroundDebugLog("chatgpt.message.pre_send.retrying", {
        tabId, phase: submissionState.phase, error: error?.message || String(error),
      });
      await waitForTabComplete(tabId, TAB_COMPLETE_TIMEOUT_MS);
      await sleep(1200);
    } finally {
      chatGptSubmissionPhases.delete(requestId);
    }
  }

  if (!result?.ok) {
    throw new Error(result?.error || "ChatGPT 응답을 가져오지 못했습니다.");
  }

  await appendBackgroundDebugLog("chatgpt.message.send.completed", {
    tabId,
    textLength: String(result.text || "").length,
    imageCount: Array.isArray(result.images) ? result.images.length : 0,
  });

  return {
    text: result.text || "",
    images: Array.isArray(result.images) ? result.images : [],
  };
}

function isClaudeUrl(url) {
  try { return new URL(url).hostname === 'claude.ai'; }
  catch { return false; }
}

async function ensureClaudeContentScript(tabId) {
  try { await chrome.tabs.sendMessage(tabId, { type: 'NB_CLAUDE_PING' }); }
  catch { await chrome.scripting.executeScript({ target: { tabId }, files: ['claude-content.js'] }); }
}

async function openClaudePopup({ focus }) {
  const anchorWindow = await getLastFocusedWindowSafe();
  const createData = { ...buildChatGptPopupCreateData(anchorWindow, focus), url: CLAUDE_URL };
  const popup = await chrome.windows.create(createData);
  try {
    if (!popup?.id) throw new Error('Claude 팝업 창을 만들지 못했습니다.');
    const tab = popup.tabs?.[0] || await waitForWindowPrimaryTab(popup.id, TAB_COMPLETE_TIMEOUT_MS);
    await waitForTabComplete(tab.id, TAB_COMPLETE_TIMEOUT_MS);
    await ensureClaudeContentScript(tab.id);
    return { windowId: popup.id, tabId: tab.id };
  } catch (error) {
    if (popup?.id) await closeWindowSafely(popup.id);
    throw error;
  }
}

async function sendPromptToClaude(tabId, prompt, options) {
  if (!String(prompt || '').trim()) throw new Error('Claude에 보낼 프롬프트가 비어 있습니다.');
  if (options?.imageMode || options?.collectImages) throw new Error('Claude는 이미지 생성용으로 사용할 수 없습니다.');
  await ensureClaudeContentScript(tabId);
  const result = await chrome.tabs.sendMessage(tabId, { type: 'NB_CLAUDE_SUBMIT', prompt, options });
  if (!result?.ok) throw new Error(result?.error || 'Claude 응답을 가져오지 못했습니다.');
  return { text: String(result.text || ''), images: [] };
}

async function runClaudePromptInPopup(prompt, options) {
  await appendBackgroundDebugLog('claude.popup.run.started', {
    promptLength: String(prompt || '').length, promptPreview: summarizeTextForLog(prompt || '', 180),
    options: sanitizeLogValue(options),
  });
  const popup = await openClaudePopup({ focus: true });
  try {
    const response = await sendPromptToClaude(popup.tabId, prompt, options);
    const close = await closeGeneratedChatGptPopup(popup.windowId, popup.tabId, 'claude');
    await appendBackgroundDebugLog('claude.popup.run.completed', {
      tabId: popup.tabId, textLength: response.text.length, popupClosed: close.closed,
    });
    return { response, tabId: popup.tabId, popupClosed: close.closed };
  } catch (error) {
    await appendBackgroundDebugLog('claude.popup.run.failed', {
      tabId: popup.tabId, error: error?.message || String(error),
    }).catch(() => {});
    throw error;
  }
}

async function fetchRemoteImageAsDataUrl(url) {
  const imageUrl = String(url || "").trim();

  if (!/^https?:\/\//i.test(imageUrl)) {
    throw new Error("원격 이미지 주소 형식이 올바르지 않습니다.");
  }

  await appendBackgroundDebugLog("image.fetch.started", {
    url: summarizeUrlForLog(imageUrl),
  });

  try {
    const response = await fetch(imageUrl, {
      method: "GET",
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      },
      // Gemini 생성 이미지는 로그인 세션이 필요할 수 있습니다. 리다이렉트되는
      // *.usercontent.google.com 권한을 manifest에 함께 선언해 자격 증명 요청도 허용합니다.
      credentials: "include",
      redirect: "follow",
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`원격 이미지를 가져오지 못했습니다: ${response.status}`);
    }

    const blob = await response.blob();
    const mimeType = String(blob.type || response.headers.get("content-type") || "").toLowerCase();
    if (mimeType && !mimeType.startsWith("image/") && mimeType !== "application/octet-stream") {
      throw new Error(`원격 이미지 응답 형식이 올바르지 않습니다: ${mimeType}`);
    }

    const dataUrl = await blobToDataUrl(blob);
    await appendBackgroundDebugLog("image.fetch.completed", {
      url: summarizeUrlForLog(imageUrl),
      mimeType: blob.type || "image/png",
      dataUrlLength: dataUrl.length,
    });
    return dataUrl;
  } catch (error) {
    await appendBackgroundDebugLog("image.fetch.failed", {
      url: summarizeUrlForLog(imageUrl),
      error: error?.message || String(error),
    }).catch(() => {});
    throw error;
  }
}

async function collectNaverBlogSearchResearch(keyword, options = {}) {
  const searchKeyword = String(keyword || "").trim();
  const maxResults = Math.max(1, Math.min(8, Number(options.maxResults) || 5));
  const searchSource = normalizeNaverBlogSearchSource(options.source);
  const searchUrl = buildNaverBlogSearchUrl(searchKeyword, searchSource);

  if (!searchKeyword) {
    throw new Error("네이버 블로그 검색 키워드가 비어 있습니다.");
  }

  await appendBackgroundDebugLog("naver.blog.research.started", {
    keywordPreview: summarizeTextForLog(searchKeyword, 120),
    maxResults,
    searchSource,
    searchUrl: summarizeUrlForLog(searchUrl),
  });

  const popupResearch = await collectNaverBlogSearchResearchFromPopup(searchKeyword, {
    maxResults,
    focus: true,
    source: searchSource,
  });
  const references = Array.isArray(popupResearch?.references) ? popupResearch.references : [];
  const relatedKeywords = Array.isArray(popupResearch?.relatedKeywords)
    ? popupResearch.relatedKeywords.slice(0, 8)
    : [];
  const collectionMethod = "popup-window";
  const fullContentCount = references.filter((entry) => String(entry?.content || "").trim()).length;

  if (!references.length) {
    throw new Error("네이버 블로그 검색 결과에서 참고할 상위 글을 찾지 못했습니다.");
  }

  if (!fullContentCount) {
    throw new Error("상위 블로그 글에 실제로 접속했지만 본문 전체를 수집하지 못했습니다.");
  }

  await appendBackgroundDebugLog("naver.blog.research.completed", {
    keywordPreview: summarizeTextForLog(searchKeyword, 120),
    collectionMethod,
    referenceCount: references.length,
    fullContentCount,
    relatedKeywordCount: relatedKeywords.length,
    topTitles: references.slice(0, 3).map((entry) => summarizeTextForLog(entry.title, 80)),
  });

  return {
    keyword: searchKeyword,
    searchSource,
    searchUrl,
    requestedReferenceCount: maxResults,
    collectedAt: new Date().toISOString(),
    collectionMethod,
    fullContentCount,
    relatedKeywords,
    references,
  };
}

function normalizeNaverBlogSearchSource(source) {
  const normalized = String(source || "section-blog").trim().toLowerCase();
  return normalized === "naver-search" ? "naver-search" : "section-blog";
}

function buildNaverBlogSearchUrl(keyword, source = "section-blog") {
  return normalizeNaverBlogSearchSource(source) === "naver-search"
    ? buildNaverBlogTabSearchUrl(keyword)
    : buildNaverBlogSectionSearchUrl(keyword);
}

function buildNaverBlogTabSearchUrl(keyword) {
  const url = new URL("https://search.naver.com/search.naver");
  url.searchParams.set("ssc", "tab.blog.all");
  url.searchParams.set("sm", "tab_jum");
  url.searchParams.set("query", String(keyword || "").trim());
  return url.toString();
}

function buildNaverBlogSectionSearchUrl(keyword) {
  const url = new URL("https://section.blog.naver.com/Search/Post.naver");
  url.searchParams.set("pageNo", "1");
  url.searchParams.set("rangeType", "ALL");
  url.searchParams.set("orderBy", "sim");
  url.searchParams.set("keyword", String(keyword || "").trim());
  return url.toString();
}

async function collectNaverBlogSearchResearchFromPopup(keyword, options = {}) {
  const searchKeyword = String(keyword || "").trim();
  const maxResults = Math.max(1, Math.min(8, Number(options.maxResults) || 5));
  const searchSource = normalizeNaverBlogSearchSource(options.source);
  const searchPopup = await openNaverBlogSearchPopup(searchKeyword, {
    focus: options.focus !== false,
    source: searchSource,
  });

  try {
    const searchResult = await collectNaverBlogSearchResultsFromPopup(searchPopup.tabId, searchKeyword, {
      maxResults,
      timeoutMs: 20000,
      source: searchSource,
    });
    const references = await collectNaverBlogPostContentsInPopup(searchPopup.tabId, searchResult.references, {
      timeoutMs: 25000,
    });

    return {
      relatedKeywords: Array.isArray(searchResult?.relatedKeywords) ? searchResult.relatedKeywords : [],
      references,
    };
  } finally {
    await closeWindowSafely(searchPopup.windowId);
  }
}

async function collectNaverBlogSearchResultsFromPopup(tabId, keyword, options = {}) {
  const searchKeyword = String(keyword || "").trim();
  const maxResults = Math.max(1, Math.min(8, Number(options.maxResults) || 5));
  const timeoutMs = Math.max(8000, Number(options.timeoutMs) || 20000);
  const searchSource = normalizeNaverBlogSearchSource(options.source);
  const searchUrl = buildNaverBlogSearchUrl(searchKeyword, searchSource);

  try {
    const result = await waitForNaverBlogSearchResults(tabId, maxResults, timeoutMs);

    await appendBackgroundDebugLog("naver.blog.research.results.collected", {
      searchSource,
      sourceUrl: summarizeUrlForLog(searchUrl),
      referenceCount: Array.isArray(result?.references) ? result.references.length : 0,
      relatedKeywordCount: Array.isArray(result?.relatedKeywords) ? result.relatedKeywords.length : 0,
    }).catch(() => {});

    return result;
  } catch (error) {
    await appendBackgroundDebugLog("naver.blog.research.results.source.failed", {
      searchSource,
      sourceUrl: summarizeUrlForLog(searchUrl),
      error: error?.message || String(error),
    }).catch(() => {});
    throw error;
  }
}

async function openNaverBlogSearchPopup(keyword, { focus, source }) {
  const anchorWindow = await getLastFocusedWindowSafe();
  const popupWindow = await chrome.windows.create(buildNaverBlogSearchPopupCreateData(keyword, anchorWindow, focus, source));
  const windowId = popupWindow.id;

  try {
    if (!windowId) {
      throw new Error("네이버 블로그 검색 팝업 창을 만들지 못했습니다.");
    }

    const popupTab = await waitForNaverBlogSearchWindowPrimaryTab(windowId, TAB_COMPLETE_TIMEOUT_MS);
    await waitForTabComplete(popupTab.id, TAB_COMPLETE_TIMEOUT_MS);

    if (focus) {
      await chrome.windows.update(windowId, { focused: true }).catch(() => {});
      await chrome.tabs.update(popupTab.id, { active: true }).catch(() => {});
    }

    await appendBackgroundDebugLog("naver.blog.research.popup.ready", {
      keywordPreview: summarizeTextForLog(keyword, 120),
      windowId,
      tabId: popupTab.id,
      focus: Boolean(focus),
    });

    return {
      windowId,
      tabId: popupTab.id,
    };
  } catch (error) {
    if (windowId) {
      await closeWindowSafely(windowId);
    }
    throw error;
  }
}

function buildNaverBlogSearchPopupCreateData(keyword, anchorWindow, focus, source) {
  const anchorWidth = typeof anchorWindow?.width === "number" ? anchorWindow.width : 1440;
  const anchorHeight = typeof anchorWindow?.height === "number" ? anchorWindow.height : 960;
  const width = Math.max(980, Math.min(1280, Math.round(anchorWidth * 0.82)));
  const height = Math.max(780, Math.min(980, Math.round(anchorHeight * 0.9)));
  const createData = {
    url: buildNaverBlogSearchUrl(keyword, source),
    type: "popup",
    width,
    height,
    focused: Boolean(focus),
  };

  if (
    typeof anchorWindow?.left === "number"
    && typeof anchorWindow?.top === "number"
    && typeof anchorWindow?.width === "number"
    && typeof anchorWindow?.height === "number"
  ) {
    createData.left = anchorWindow.left + Math.max(0, Math.floor((anchorWindow.width - width) / 2));
    createData.top = anchorWindow.top + Math.max(0, Math.floor((anchorWindow.height - height) / 2));
  }

  return createData;
}

async function waitForNaverBlogSearchWindowPrimaryTab(windowId, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const tabs = await chrome.tabs.query({ windowId });
    const popupTab = tabs.find((tab) => tab.active && isNaverBlogSearchUrl(tab.url || ""))
      || tabs.find((tab) => isNaverBlogSearchUrl(tab.url || ""))
      || tabs[0];

    if (popupTab?.id) {
      return popupTab;
    }

    await sleep(150);
  }

  throw new Error("네이버 블로그 검색 팝업 탭을 찾지 못했습니다.");
}

function isNaverBlogSearchUrl(url) {
  try {
    const parsed = new URL(String(url || ""));

    if (parsed.hostname === "section.blog.naver.com" && parsed.pathname === "/Search/Post.naver") {
      return true;
    }

    return parsed.hostname === "search.naver.com"
      && parsed.pathname === "/search.naver"
      && String(parsed.searchParams.get("ssc") || "").startsWith("tab.blog");
  } catch {
    return false;
  }
}

async function collectNaverBlogPostContentsInPopup(tabId, references, options = {}) {
  const timeoutMs = Math.max(8000, Number(options.timeoutMs) || 25000);
  const entries = Array.isArray(references) ? references : [];
  const collected = [];

  for (const entry of entries) {
    const crawlUrl = String(entry?.mobileUrl || entry?.url || "").trim();

    if (!crawlUrl) {
      collected.push({ ...entry, content: "", contentLength: 0, headings: [] });
      continue;
    }

    try {
      await loadUrlInTab(tabId, crawlUrl, timeoutMs);
      const pageResult = await waitForNaverBlogPostContent(tabId, entry, timeoutMs);
      const content = String(pageResult?.content || "").trim();
      const headings = Array.isArray(pageResult?.headings)
        ? pageResult.headings.map((value) => String(value || "").trim()).filter(Boolean).slice(0, 12)
        : [];

      collected.push({
        ...entry,
        title: String(pageResult?.title || entry?.title || "").trim() || String(entry?.title || "").trim(),
        crawledUrl: String(pageResult?.sourceUrl || crawlUrl),
        content,
        contentLength: Number(pageResult?.contentLength || content.length || 0),
        headings,
      });

      await appendBackgroundDebugLog("naver.blog.research.post.completed", {
        rank: Number(entry?.rank || 0) || collected.length,
        titlePreview: summarizeTextForLog(pageResult?.title || entry?.title || "", 80),
        contentLength: Number(pageResult?.contentLength || content.length || 0),
        headingCount: headings.length,
      });
    } catch (error) {
      collected.push({
        ...entry,
        content: "",
        contentLength: 0,
        headings: [],
        crawledUrl: crawlUrl,
        crawlError: error?.message || String(error),
      });

      await appendBackgroundDebugLog("naver.blog.research.post.failed", {
        rank: Number(entry?.rank || 0) || collected.length,
        titlePreview: summarizeTextForLog(entry?.title || "", 80),
        url: summarizeUrlForLog(crawlUrl),
        error: error?.message || String(error),
      }).catch(() => {});
    }
  }

  return collected;
}

async function loadUrlInTab(tabId, url, timeoutMs) {
  const safeUrl = String(url || "").trim();

  if (!safeUrl) {
    throw new Error("이동할 주소가 비어 있습니다.");
  }

  await chrome.tabs.update(tabId, { url: safeUrl });
  await waitForTabComplete(tabId, timeoutMs);
}

async function waitForNaverBlogPostContent(tabId, reference, timeoutMs) {
  const startedAt = Date.now();
  let lastDiagnostics = null;

  while (Date.now() - startedAt < timeoutMs) {
    const execution = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractNaverBlogPostContentFromPage,
      args: [reference || null],
    });
    const pageResult = execution?.[0]?.result && typeof execution[0].result === "object"
      ? execution[0].result
      : null;
    const content = String(pageResult?.content || "").trim();

    if (content.length >= 180) {
      return pageResult;
    }

    lastDiagnostics = pageResult?.diagnostics || null;

    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        window.scrollBy(0, Math.max(window.innerHeight, 640));
      },
    }).catch(() => {});

    await sleep(500);
  }

  if (lastDiagnostics?.blockedReason) {
    throw new Error(`블로그 본문을 읽지 못했습니다. ${lastDiagnostics.blockedReason}`);
  }

  throw new Error("블로그 본문을 읽지 못했습니다.");
}

function extractNaverBlogPostContentFromPage(reference = null) {
  const documents = collectDocuments();
  const pageText = normalizeMultilineText(document.body?.innerText || document.body?.textContent || "");
  let bestCandidate = null;

  for (const doc of documents) {
    for (const candidate of collectContentCandidates(doc)) {
      const structured = extractStructuredText(candidate);

      if (!structured.text || structured.text.length < 180) {
        continue;
      }

      const score = scoreContentCandidate(candidate, structured, doc);

      if (!bestCandidate || score > bestCandidate.score) {
        bestCandidate = {
          score,
          text: structured.text,
          headings: structured.headings,
          lineCount: structured.lineCount,
          hint: buildElementHint(candidate),
        };
      }
    }
  }

  const resolvedTitle = resolveTitle(documents, reference);

  return {
    title: resolvedTitle,
    sourceUrl: location.href,
    content: String(bestCandidate?.text || "").trim(),
    contentLength: String(bestCandidate?.text || "").trim().length,
    headings: Array.isArray(bestCandidate?.headings) ? bestCandidate.headings : [],
    diagnostics: {
      url: location.href,
      title: document.title || "",
      readyState: document.readyState,
      candidateHint: bestCandidate?.hint || "",
      lineCount: Number(bestCandidate?.lineCount || 0),
      blockedReason: detectBlockedReason(pageText),
    },
  };

  function collectDocuments() {
    const docs = [document];
    const seen = new Set([document]);

    for (const frame of document.querySelectorAll("iframe")) {
      try {
        const frameDoc = frame.contentDocument;

        if (frameDoc?.body && !seen.has(frameDoc)) {
          seen.add(frameDoc);
          docs.push(frameDoc);
        }
      } catch {
        // Ignore inaccessible iframe documents.
      }
    }

    return docs;
  }

  function collectContentCandidates(doc) {
    const selectors = [
      ".se-main-container",
      ".se-viewer",
      "#viewTypeSelector",
      ".post_view",
      ".post-view",
      ".post_ct",
      ".post_area",
      ".post-body",
      ".post_body",
      ".area_view",
      ".wrap_body",
      ".contents_style",
      ".entry-content",
      "article",
      "main",
      "#content",
    ];
    const candidates = [];
    const seen = new Set();

    for (const selector of selectors) {
      for (const element of doc.querySelectorAll(selector)) {
        if (!element || seen.has(element)) {
          continue;
        }

        seen.add(element);
        candidates.push(element);
      }
    }

    if (doc.body && !seen.has(doc.body)) {
      candidates.push(doc.body);
    }

    return candidates;
  }

  function extractStructuredText(root) {
    const blocks = Array.from(root.querySelectorAll("h1, h2, h3, h4, p, li, blockquote, figcaption"));
    const entries = [];
    const seenTexts = new Set();

    for (const block of blocks) {
      const text = normalizeMultilineText(block.innerText || block.textContent || "");

      if (!text || isNoiseText(text)) {
        continue;
      }

      const dedupeKey = `${block.tagName}:${text}`;

      if (seenTexts.has(dedupeKey)) {
        continue;
      }

      seenTexts.add(dedupeKey);
      entries.push({ tag: block.tagName, text });
    }

    const text = entries.length
      ? entries.map((entry) => entry.text).join("\n")
      : normalizeMultilineText(root.innerText || root.textContent || "");

    return {
      text,
      headings: entries
        .filter((entry) => entry.tag === "H1" || entry.tag === "H2" || entry.tag === "H3" || entry.tag === "H4")
        .map((entry) => entry.text)
        .slice(0, 12),
      lineCount: entries.length,
    };
  }

  function scoreContentCandidate(element, structured, doc) {
    const descriptor = String(`${element.className || ""} ${element.id || ""}`).toLowerCase();
    let score = structured.text.length;

    if (element === doc.body) {
      score -= 2500;
    }

    if (containsAny(descriptor, ["se-main-container", "se-viewer", "viewtypeselector"])) {
      score += 1800;
    }

    if (containsAny(descriptor, ["post_view", "post-view", "post_ct", "post-body", "post_body", "post_area", "area_view", "wrap_body", "entry-content"])) {
      score += 1400;
    }

    if (element.tagName === "ARTICLE" || element.tagName === "MAIN") {
      score += 900;
    }

    if (containsAny(descriptor, ["comment", "reply", "profile", "aside", "footer", "header", "nav", "related", "recommend", "advert"])) {
      score -= 3000;
    }

    score += structured.headings.length * 90;
    score += Math.min(800, structured.lineCount * 18);

    if (doc !== document) {
      score += 200;
    }

    return score;
  }

  function resolveTitle(docs, fallbackReference) {
    const fallbackTitle = normalizeSingleLineText(
      fallbackReference?.title
      || document.title
      || ""
    );
    const selectors = [
      ".se-title-text",
      ".se-title-text .se-text-paragraph",
      ".area_title .title",
      ".itemSubjectBoldfont",
      "h1",
      "h2",
    ];

    for (const doc of docs) {
      for (const selector of selectors) {
        const element = doc.querySelector(selector);
        const text = normalizeSingleLineText(element?.innerText || element?.textContent || "");

        if (text && !isGenericTitle(text)) {
          return text;
        }
      }
    }

    return fallbackTitle;
  }

  function buildElementHint(element) {
    const className = String(element.className || "").trim().replace(/\s+/g, ".");
    const id = String(element.id || "").trim();
    return `${element.tagName.toLowerCase()}${id ? `#${id}` : ""}${className ? `.${className}` : ""}`;
  }

  function normalizeSingleLineText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .replace(/\s*:\s*네이버 블로그\s*$/i, "")
      .trim();
  }

  function normalizeMultilineText(value) {
    return String(value || "")
      .replace(/\r/g, "\n")
      .split("\n")
      .map((line) => String(line || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  function isNoiseText(text) {
    const normalized = normalizeSingleLineText(text).toLowerCase();

    if (!normalized) {
      return true;
    }

    if (normalized.length > 40) {
      return false;
    }

    return containsAny(normalized, [
      "공감",
      "댓글",
      "이웃추가",
      "url 복사",
      "본문 기타 기능",
      "카테고리 이동",
      "프로필",
      "공유",
      "좋아요",
      "스크랩",
      "메뉴",
      "구독",
    ]);
  }

  function isGenericTitle(text) {
    const normalized = normalizeSingleLineText(text).toLowerCase();
    return !normalized || normalized === "네이버 블로그" || normalized === "blog";
  }

  function detectBlockedReason(text) {
    const normalized = String(text || "").toLowerCase();

    if (containsAny(normalized, ["자동 입력 방지", "보안 문자", "captcha"])) {
      return "네이버가 자동화 방지 화면을 표시했습니다.";
    }

    if (
      String(location.pathname || "").toLowerCase().includes("nidlogin.login")
      || document.querySelector("form[action*='nidlogin.login'], input#id, input#pw")
    ) {
      return "네이버 로그인 상태를 먼저 확인해 주세요.";
    }

    if (normalized.length < 500 && containsAny(normalized, ["비공개 글", "비공개 게시글", "권한이 없습니다", "이웃만", "멤버만"])) {
      return "비공개 또는 접근 제한된 글입니다.";
    }

    if (normalized.length < 500 && containsAny(normalized, ["삭제된 게시글", "존재하지 않는 게시물", "찾을 수 없는 페이지"])) {
      return "삭제되었거나 존재하지 않는 글입니다.";
    }

    return "";
  }

  function containsAny(value, tokens) {
    const safeValue = String(value || "");
    return Array.isArray(tokens) && tokens.some((token) => safeValue.includes(String(token || "")));
  }
}

async function waitForNaverBlogSearchResults(tabId, maxResults, timeoutMs) {
  const startedAt = Date.now();
  let lastDiagnostics = null;

  while (Date.now() - startedAt < timeoutMs) {
    const execution = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractNaverBlogSearchResultsFromPage,
      args: [maxResults],
    });
    const pageResult = execution?.[0]?.result && typeof execution[0].result === "object"
      ? execution[0].result
      : null;
    const references = Array.isArray(pageResult?.references) ? pageResult.references : [];

    if (references.length) {
      return {
        relatedKeywords: Array.isArray(pageResult?.relatedKeywords) ? pageResult.relatedKeywords : [],
        references,
      };
    }

    lastDiagnostics = pageResult?.diagnostics || null;

    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        window.scrollBy(0, Math.max(window.innerHeight, 720));
      },
    }).catch(() => {});

    await sleep(500);
  }

  if (lastDiagnostics?.blockedReason) {
    throw new Error(`네이버 블로그 검색 결과를 읽지 못했습니다. ${lastDiagnostics.blockedReason}`);
  }

  throw new Error("네이버 블로그 검색 결과를 읽지 못했습니다.");
}

function extractNaverBlogSearchResultsFromPage(maxResults = 5) {
  const safeMaxResults = Math.max(1, Math.min(8, Number(maxResults) || 5));
  const pageType = detectPageType();
  const references = pageType === "search.naver"
    ? collectSearchNaverReferences(safeMaxResults)
    : collectSectionBlogReferences(safeMaxResults);

  const relatedKeywords = [];
  const seenKeywords = new Set();

  for (const element of document.querySelectorAll("a[onclick*='goPostSearch'], a[onclick*='relatedKeyword']")) {
    const keyword = normalizeText(element.textContent || "");

    if (!keyword || seenKeywords.has(keyword)) {
      continue;
    }

    seenKeywords.add(keyword);
    relatedKeywords.push(keyword);

    if (relatedKeywords.length >= 12) {
      break;
    }
  }

  const bodyText = normalizeText(document.body?.innerText || "");

  return {
    references,
    relatedKeywords,
    diagnostics: {
      url: location.href,
      title: document.title || "",
      pageType,
      readyState: document.readyState,
      anchorCount: countReferenceAnchors(pageType),
      blockedReason: detectBlockedReason(bodyText),
    },
  };

  function detectPageType() {
    const hostname = String(location.hostname || "").toLowerCase();

    if (hostname === "search.naver.com") {
      return "search.naver";
    }

    if (hostname === "section.blog.naver.com") {
      return "section.blog";
    }

    return hostname || "unknown";
  }

  function collectSectionBlogReferences(limit) {
    const entries = [];
    const seenUrls = new Set();
    const anchors = Array.from(document.querySelectorAll("a.desc_inner[href]"));

    for (const anchor of anchors) {
      const normalizedUrl = normalizeUrl(anchor.getAttribute("href") || anchor.href || "");

      if (!normalizedUrl || seenUrls.has(normalizedUrl)) {
        continue;
      }

      const identifiers = extractPostIdentifiers(normalizedUrl);

      if (!identifiers?.blogId || !identifiers?.logNo) {
        continue;
      }

      const title = normalizeText(
        anchor.querySelector(".title")?.textContent
        || anchor.textContent
        || ""
      );
      const resultRoot = findSectionBlogResultRoot(anchor);
      const snippetElement = findSectionBlogSnippetElement(resultRoot, anchor);
      const snippet = normalizeText(snippetElement?.textContent || "");

      if (!title || !snippet) {
        continue;
      }

      seenUrls.add(normalizedUrl);
      entries.push({
        rank: entries.length + 1,
        title,
        snippet,
        url: normalizedUrl,
        mobileUrl: buildMobileUrl(identifiers.blogId, identifiers.logNo),
        blogId: identifiers.blogId,
        logNo: identifiers.logNo,
      });

      if (entries.length >= limit) {
        break;
      }
    }

    return entries;
  }

  function collectSearchNaverReferences(limit) {
    const entries = [];
    const seenUrls = new Set();
    const titleAnchors = Array.from(document.querySelectorAll('a[data-heatmap-target=".nblg"][href]')).filter((anchor) => (
      Boolean(anchor.querySelector('span.sds-comps-text-type-headline1, span[class*="headline"]'))
    ));

    for (const anchor of titleAnchors) {
      const normalizedUrl = normalizeUrl(anchor.getAttribute("href") || anchor.href || "");

      if (!normalizedUrl || seenUrls.has(normalizedUrl)) {
        continue;
      }

      const identifiers = extractPostIdentifiers(normalizedUrl);

      if (!identifiers?.blogId || !identifiers?.logNo) {
        continue;
      }

      const resultRoot = findSearchNaverResultRoot(anchor);
      const title = normalizeText(anchor.textContent || "");
      const snippet = extractSearchNaverSnippet(resultRoot, title);

      if (!title || !snippet) {
        continue;
      }

      seenUrls.add(normalizedUrl);
      entries.push({
        rank: entries.length + 1,
        title,
        snippet,
        url: normalizedUrl,
        mobileUrl: buildMobileUrl(identifiers.blogId, identifiers.logNo),
        blogId: identifiers.blogId,
        logNo: identifiers.logNo,
      });

      if (entries.length >= limit) {
        break;
      }
    }

    return entries;
  }

  function countReferenceAnchors(pageTypeValue) {
    if (pageTypeValue === "search.naver") {
      return document.querySelectorAll('a[data-heatmap-target=".nblg"][href] span.sds-comps-text-type-headline1, a[data-heatmap-target=".nblg"][href] span[class*="headline"]').length;
    }

    return document.querySelectorAll("a.desc_inner[href]").length;
  }

  function findSectionBlogResultRoot(anchorElement) {
    const selectors = [
      "li",
      ".view_wrap",
      ".lst_item",
      ".post_item",
      ".list_post",
      ".theme_item",
      ".bx",
      ".total_wrap",
    ];

    for (const selector of selectors) {
      const match = anchorElement.closest(selector);
      if (match) {
        return match;
      }
    }

    return anchorElement.parentElement || document.body;
  }

  function findSectionBlogSnippetElement(root, anchorElement) {
    const candidates = root
      ? Array.from(root.querySelectorAll("a.text, .text, .desc, .dsc, .api_txt_lines"))
      : [];

    return candidates.find((element) => element !== anchorElement && normalizeText(element.textContent || "")) || null;
  }

  function findSearchNaverResultRoot(anchorElement) {
    let current = anchorElement.parentElement;
    let candidate = anchorElement.parentElement || document.body;

    while (current && current !== document.body) {
      const titleCount = current.querySelectorAll('a[data-heatmap-target=".nblg"][href] span.sds-comps-text-type-headline1, a[data-heatmap-target=".nblg"][href] span[class*="headline"]').length;

      if (titleCount === 1) {
        candidate = current;
      } else if (titleCount > 1) {
        break;
      }

      current = current.parentElement;
    }

    return candidate;
  }

  function extractSearchNaverSnippet(root, title) {
    const candidates = root
      ? Array.from(root.querySelectorAll('a[data-heatmap-target=".nblg"] span.sds-comps-text-type-body1, a[data-heatmap-target=".nblg"] span[class*="body1"], a[data-heatmap-target=".nblg"] span[class*="body"]'))
      : [];
    const snippets = candidates
      .map((element) => normalizeText(element.textContent || ""))
      .filter((text) => text && text !== title);

    snippets.sort((left, right) => right.length - left.length);

    return snippets[0] || "";
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeUrl(url) {
    try {
      return new URL(String(url || "").trim(), location.href).toString();
    } catch {
      return "";
    }
  }

  function extractPostIdentifiers(url) {
    try {
      const parsed = new URL(String(url || ""));
      const hostname = parsed.hostname.toLowerCase();

      if (hostname === "blog.naver.com" || hostname === "m.blog.naver.com") {
        const pathSegments = parsed.pathname.split("/").filter(Boolean);

        if (pathSegments.length >= 2 && /^\d+$/.test(pathSegments[1])) {
          return {
            blogId: pathSegments[0],
            logNo: pathSegments[1],
          };
        }

        if (parsed.pathname.endsWith("/PostView.naver")) {
          const blogId = String(parsed.searchParams.get("blogId") || "").trim();
          const logNo = String(parsed.searchParams.get("logNo") || "").trim();

          if (blogId && /^\d+$/.test(logNo)) {
            return { blogId, logNo };
          }
        }
      }
    } catch {
      return null;
    }

    return null;
  }

  function buildMobileUrl(blogId, logNo) {
    return `https://m.blog.naver.com/${encodeURIComponent(String(blogId || "").trim())}/${encodeURIComponent(String(logNo || "").trim())}`;
  }

  function detectBlockedReason(text) {
    if (/자동 입력 방지|보안 문자|captcha/i.test(text)) {
      return "네이버가 자동화 방지 화면을 표시했습니다.";
    }
    if (
      /nidlogin\.login/i.test(location.pathname)
      || document.querySelector("form[action*='nidlogin.login'], input#id, input#pw")
    ) {
      return "네이버 로그인 상태를 먼저 확인해 주세요.";
    }
    if (/검색결과가 없습니다|일치하는 콘텐츠가 없습니다/i.test(text)) {
      return "해당 키워드의 검색 결과가 없습니다.";
    }
    return "";
  }
}

function extractNaverBlogSearchReferences(html, options = {}) {
  const source = String(html || "");
  const maxResults = Math.max(1, Math.min(8, Number(options.maxResults) || 5));
  const references = [];
  const seenUrls = new Set();
  const anchorPattern = /<a[^>]+class="desc_inner"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorPattern.exec(source)) && references.length < maxResults) {
    const normalizedUrl = normalizeNaverBlogResultUrl(match[1]);

    if (!normalizedUrl || seenUrls.has(normalizedUrl) || !isNaverBlogPostUrl(normalizedUrl)) {
      continue;
    }

    const localChunk = source.slice(match.index, match.index + 2500);
    const snippetMatch = localChunk.match(/<a[^>]+class="text"[^>]*>([\s\S]*?)<\/a>/i);
    const title = htmlToPlainText(match[2], 220);
    const snippet = htmlToPlainText(snippetMatch?.[1] || "", 420);
    const identifiers = extractNaverBlogPostIdentifiers(normalizedUrl);

    if (!title || !snippet) {
      continue;
    }

    seenUrls.add(normalizedUrl);
    references.push({
      rank: references.length + 1,
      title,
      snippet,
      url: normalizedUrl,
      mobileUrl: identifiers ? buildMobileNaverBlogPostUrl(identifiers.blogId, identifiers.logNo) : normalizedUrl,
      blogId: identifiers?.blogId || "",
      logNo: identifiers?.logNo || "",
    });
  }

  return references;
}

function extractNaverBlogSearchRelatedKeywords(html) {
  const source = String(html || "");
  const pattern = /goPostSearch\(relatedKeyword\)">([\s\S]*?)<\/a>/gi;
  const keywords = [];
  const seen = new Set();
  let match;

  while ((match = pattern.exec(source)) && keywords.length < 12) {
    const keyword = htmlToPlainText(match[1], 60);
    if (!keyword || seen.has(keyword)) {
      continue;
    }

    seen.add(keyword);
    keywords.push(keyword);
  }

  return keywords;
}

function normalizeNaverBlogResultUrl(url) {
  try {
    return new URL(String(url || "").trim(), "https://section.blog.naver.com").toString();
  } catch {
    return "";
  }
}

function isNaverBlogPostUrl(url) {
  const identifiers = extractNaverBlogPostIdentifiers(url);
  return Boolean(identifiers?.blogId && identifiers?.logNo);
}

function extractNaverBlogPostIdentifiers(url) {
  try {
    const parsed = new URL(String(url || ""));
    const hostname = parsed.hostname.toLowerCase();

    if (hostname === "blog.naver.com" || hostname === "m.blog.naver.com") {
      const pathSegments = parsed.pathname.split("/").filter(Boolean);

      if (pathSegments.length >= 2 && /^\d+$/.test(pathSegments[1])) {
        return {
          blogId: pathSegments[0],
          logNo: pathSegments[1],
        };
      }

      if (parsed.pathname.endsWith("/PostView.naver")) {
        const blogId = String(parsed.searchParams.get("blogId") || "").trim();
        const logNo = String(parsed.searchParams.get("logNo") || "").trim();

        if (blogId && /^\d+$/.test(logNo)) {
          return { blogId, logNo };
        }
      }
    }
  } catch {
    return null;
  }

  return null;
}

function buildMobileNaverBlogPostUrl(blogId, logNo) {
  return `https://m.blog.naver.com/${encodeURIComponent(String(blogId || "").trim())}/${encodeURIComponent(String(logNo || "").trim())}`;
}

function htmlToPlainText(html, maxLength = 0) {
  const decoded = decodeHtmlEntities(String(html || ""))
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\t\r ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();

  if (!maxLength || decoded.length <= maxLength) {
    return decoded;
  }

  return `${decoded.slice(0, maxLength).trim()}...`;
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

async function searchGoogleImages(query, options = {}) {
  const searchQuery = String(query || "").trim();
  const maxResults = Math.max(1, Math.min(8, Number(options.maxResults) || 6));

  if (!searchQuery) {
    throw new Error("이미지 검색어가 비어 있습니다.");
  }

  await appendBackgroundDebugLog("google.image.search.started", {
    queryLength: searchQuery.length,
    queryPreview: summarizeTextForLog(searchQuery, 180),
    maxResults,
  });

  const googleSearchPopup = await openGoogleImageSearchPopup(searchQuery, { focus: true });
  const tabId = googleSearchPopup.tabId;

  try {
    const candidates = await waitForGoogleImageSearchCandidates(tabId, maxResults, 20000);

    // Ensure the popup window is focused and visible to allow screenshot capture
    await chrome.windows.update(googleSearchPopup.windowId, { focused: true }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 1500));

    let screenshot = "";
    try {
      screenshot = await chrome.tabs.captureVisibleTab(googleSearchPopup.windowId, { format: "png" });
    } catch (captureError) {
      await appendBackgroundDebugLog("google.image.capture.failed", {
        error: captureError.message || String(captureError)
      }).catch(() => {});
    }

    await closeWindowSafely(googleSearchPopup.windowId);

    if (!candidates || !candidates.length) {
      throw new Error("구글 이미지 검색 결과에서 후보를 찾지 못했습니다.");
    }

    await appendBackgroundDebugLog("google.image.search.completed", {
      queryPreview: summarizeTextForLog(searchQuery, 180),
      tabId,
      candidateCount: candidates.length,
      hasScreenshot: Boolean(screenshot)
    });

    return {
      query: searchQuery,
      screenshot,
      candidates: candidates.slice(0, maxResults)
    };
  } catch (error) {
    await appendBackgroundDebugLog("google.image.search.failed", {
      queryPreview: summarizeTextForLog(searchQuery, 180),
      tabId,
      error: error?.message || String(error),
    }).catch(() => {});

    if (googleSearchPopup && googleSearchPopup.windowId) {
      await closeWindowSafely(googleSearchPopup.windowId).catch(() => {});
    }
    throw error;
  }
}

async function openGoogleImageSearchPopup(query, { focus }) {
  const anchorWindow = await getLastFocusedWindowSafe();
  const popupWindow = await chrome.windows.create(buildGoogleImageSearchPopupCreateData(query, anchorWindow, focus));
  const windowId = popupWindow.id;

  try {
    if (!windowId) {
      throw new Error("구글 이미지 검색 팝업 창을 만들지 못했습니다.");
    }

    const popupTab = await waitForGoogleImageSearchWindowPrimaryTab(windowId, TAB_COMPLETE_TIMEOUT_MS);
    await waitForTabComplete(popupTab.id, TAB_COMPLETE_TIMEOUT_MS);

    if (focus) {
      await chrome.windows.update(windowId, { focused: true }).catch(() => {});
      await chrome.tabs.update(popupTab.id, { active: true }).catch(() => {});
    }

    await appendBackgroundDebugLog("google.image.search.popup.ready", {
      windowId,
      tabId: popupTab.id,
      focus: Boolean(focus),
    });

    return {
      windowId,
      tabId: popupTab.id,
    };
  } catch (error) {
    if (windowId) {
      await closeWindowSafely(windowId);
    }
    throw error;
  }
}

function buildGoogleImageSearchPopupCreateData(query, anchorWindow, focus) {
  const anchorWidth = typeof anchorWindow?.width === "number" ? anchorWindow.width : 1440;
  const anchorHeight = typeof anchorWindow?.height === "number" ? anchorWindow.height : 960;
  const width = Math.max(960, Math.min(1280, Math.round(anchorWidth * 0.82)));
  const height = Math.max(760, Math.min(960, Math.round(anchorHeight * 0.9)));
  const createData = {
    url: buildGoogleImageSearchUrl(query),
    type: "popup",
    width,
    height,
    focused: Boolean(focus),
  };

  if (
    typeof anchorWindow?.left === "number"
    && typeof anchorWindow?.top === "number"
    && typeof anchorWindow?.width === "number"
    && typeof anchorWindow?.height === "number"
  ) {
    createData.left = anchorWindow.left + Math.max(0, Math.floor((anchorWindow.width - width) / 2));
    createData.top = anchorWindow.top + Math.max(0, Math.floor((anchorWindow.height - height) / 2));
  }

  return createData;
}

async function waitForGoogleImageSearchWindowPrimaryTab(windowId, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const tabs = await chrome.tabs.query({ windowId });
    const popupTab = tabs.find((tab) => tab.active && isGoogleSearchUrl(tab.url || "")) || tabs[0];

    if (popupTab?.id) {
      return popupTab;
    }

    await sleep(150);
  }

  throw new Error("구글 이미지 검색 팝업 탭을 찾지 못했습니다.");
}

function isGoogleSearchUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return parsed.hostname === "www.google.com" && parsed.pathname === "/search";
  } catch {
    return false;
  }
}

function buildGoogleImageSearchUrl(query) {
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("tbm", "isch");
  url.searchParams.set("hl", "ko");
  url.searchParams.set("safe", "off");
  url.searchParams.set("q", String(query || "").trim());
  return url.toString();
}

async function waitForGoogleImageSearchCandidates(tabId, maxResults, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const execution = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractGoogleImageSearchCandidates,
      args: [maxResults],
    });
    const candidates = Array.isArray(execution?.[0]?.result) ? execution[0].result : [];

    if (candidates.length) {
      return candidates;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        window.scrollBy(0, Math.max(window.innerHeight, 720));
      },
    }).catch(() => {});

    await sleep(500);
  }

  throw new Error("구글 이미지 검색 결과를 읽지 못했습니다.");
}

function extractGoogleImageSearchCandidates(maxResults = 4) {
  const candidates = [];
  const seen = new Set();
  const images = Array.from(document.querySelectorAll("img"));

  for (const image of images) {
    const imageUrl = resolveSearchImageUrl(image);
    if (!isGoogleHostedSearchImageUrl(imageUrl)) {
      continue;
    }

    const width = Number(image.naturalWidth || image.width || image.getBoundingClientRect().width || 0);
    const height = Number(image.naturalHeight || image.height || image.getBoundingClientRect().height || 0);

    if (width < 120 || height < 120) {
      continue;
    }

    if (seen.has(imageUrl)) {
      continue;
    }

    seen.add(imageUrl);
    candidates.push({
      url: imageUrl,
      title: normalizeText(image.getAttribute("alt") || ""),
      sourceUrl: "",
      width,
      height,
      score: scoreSearchCandidate(width, height, image.getAttribute("alt") || ""),
    });
  }

  return candidates
    .sort((left, right) => right.score - left.score)
    .slice(0, maxResults)
    .map(({ score, ...candidate }) => candidate);

  function resolveSearchImageUrl(image) {
    const urlCandidates = [
      image.currentSrc,
      image.src,
      image.getAttribute("data-src"),
      image.getAttribute("data-iurl"),
    ];

    for (const candidate of urlCandidates) {
      const safeCandidate = String(candidate || "").trim();
      if (/^https?:\/\//i.test(safeCandidate)) {
        return safeCandidate;
      }
    }

    return "";
  }

  function isGoogleHostedSearchImageUrl(url) {
    try {
      const hostname = new URL(String(url || "")).hostname.toLowerCase();
      return hostname === "gstatic.com"
        || hostname.endsWith(".gstatic.com")
        || hostname === "googleusercontent.com"
        || hostname.endsWith(".googleusercontent.com");
    } catch {
      return false;
    }
  }

  function scoreSearchCandidate(width, height, altText) {
    let score = Math.min(width, height);

    if (normalizeText(altText)) {
      score += 40;
    }

    return score;
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }
}

async function blobToDataUrl(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  const mimeType = blob.type || "image/png";
  return `data:${mimeType};base64,${btoa(binary)}`;
}

async function closeWindowSafely(windowId) {
  try {
    await chrome.windows.remove(windowId);
  } catch {
    // Ignore windows already closed by the user.
  }
}

async function closeTabSafely(tabId) {
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // Ignore tabs already closed by the user.
  }
}

async function getTabSafely(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

async function getSession() {
  const stored = await chrome.storage.local.get(SESSION_KEY);
  const session = stored[SESSION_KEY];

  return session && typeof session === "object" ? session : {};
}

async function updateSession(patch) {
  const current = await getSession();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [SESSION_KEY]: next });
  return next;
}

async function getPanelContext() {
  const session = await getSession();
  const naverTab = await resolveStoredNaverTab(session.naverTabId);

  return {
    naverTab: summarizeTab(naverTab),
    geminiTab: null,
  };
}

async function resolveStoredNaverTab(tabId) {
  const storedTab = tabId ? await getTabSafely(tabId) : null;

  if (storedTab && isNaverBlogUrl(storedTab.url || "")) {
    return storedTab;
  }

  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  if (activeTab?.id && isNaverBlogUrl(activeTab.url || "")) {
    await updateSession({ naverTabId: activeTab.id });
    return activeTab;
  }

  if (tabId) {
    await updateSession({ naverTabId: null });
  }

  return null;
}

async function resolveStoredGeminiTab(tabId) {
  const storedTab = tabId ? await getTabSafely(tabId) : null;

  if (storedTab && isGeminiUrl(storedTab.url || "")) {
    return storedTab;
  }

  if (tabId) {
    await updateSession({ geminiTabId: null });
  }

  return null;
}

function summarizeTab(tab) {
  if (!tab?.id) {
    return null;
  }

  return {
    id: tab.id,
    title: tab.title || "",
    url: tab.url || "",
    editorKind: getNaverEditorKind(tab.url || ""),
  };
}

async function closeGeneratedChatGptPopup(windowId, tabId, provider = 'chatgpt') {
  const allowedUrl = provider === 'claude' ? isClaudeUrl : isChatGptUrl;
  const logPrefix = provider === 'claude' ? 'claude' : 'chatgpt';
  const target = await getTabSafely(tabId);
  if (!target) {
    const closed = !(await windowExists(windowId));
    await appendBackgroundDebugLog(`${logPrefix}.popup.close.checked`, { windowId, tabId, closed, method: 'already-closed' });
    return { closed, method: 'already-closed' };
  }

  // Never close a tab that the user moved to another window or navigated away
  // from ChatGPT while image generation was running.
  if (target.windowId !== windowId || !allowedUrl(target.url || '')) {
    await appendBackgroundDebugLog(`${logPrefix}.popup.close.skipped`, {
      windowId, tabId, reason: target.windowId !== windowId ? 'tab-moved' : 'tab-navigated',
    });
    return { closed: false, method: 'skipped' };
  }

  let method = 'window';
  let removeError = '';
  try {
    const tabs = await chrome.tabs.query({ windowId });
    if (tabs.length === 1 && tabs[0].id === tabId) {
      await chrome.windows.remove(windowId);
    } else {
      method = 'tab';
      await chrome.tabs.remove(tabId);
    }
  } catch (error) {
    removeError = error?.message || String(error);
  }

  let remaining = await getTabSafely(tabId);
  if (remaining?.windowId === windowId && allowedUrl(remaining.url || '')) {
    method = 'tab-fallback';
    try {
      await chrome.tabs.remove(tabId);
    } catch (error) {
      removeError += `${removeError ? '; ' : ''}tab fallback: ${error?.message || String(error)}`;
    }
    remaining = await getTabSafely(tabId);
  }

  const closed = !remaining || remaining.windowId !== windowId;
  await appendBackgroundDebugLog(closed ? `${logPrefix}.popup.close.checked` : `${logPrefix}.popup.close.failed`, {
    windowId, tabId, closed, method, removeError,
    windowStillOpen: await windowExists(windowId),
  });
  return { closed, method };
}

async function waitForTabComplete(tabId, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const tab = await getTabSafely(tabId);
    if (!tab) {
      throw new Error("대상 탭을 찾을 수 없습니다.");
    }
    if (tab.status === "complete") {
      return;
    }
    await sleep(350);
  }

  throw new Error("페이지 로딩 시간이 초과되었습니다.");
}

async function insertPostIntoNaverEditor(payload, requestedTabId) {
  if (payload?.platform === 'threads') {
    const tab = requestedTabId ? await getTabSafely(requestedTabId) : null;
    if (!tab || !isNaverBlogUrl(tab.url || '') || getNaverEditorKind(tab.url || '') !== 'threads') throw new Error('연결된 Threads 탭을 다시 확인하세요.');
    const results = await chrome.scripting.executeScript({target: {tabId: requestedTabId}, func: insertThreadsDraft, args: [payload]});
    const result = results[0]?.result;
    if (!result?.ok) throw new Error(result?.error || 'Threads 입력에 실패했습니다.');
    return result;
  }
  // Instagram requests must never fall back to another stored or active tab.
  if (payload?.platform === 'instagram') {
    const instagramTab = requestedTabId ? await getTabSafely(requestedTabId) : null;
    if (!instagramTab || !isNaverBlogUrl(instagramTab.url || '') || getNaverEditorKind(instagramTab.url || '') !== 'instagram') {
      throw new Error('연결된 Instagram 탭이 닫혔거나 변경되었습니다. 현재 탭을 다시 연결하세요.');
    }
    const results = await chrome.scripting.executeScript({ target: { tabId: requestedTabId }, func: insertInstagramDraft, args: [payload] });
    const result = results[0]?.result;
    if (!result?.ok) throw new Error(result?.error || 'Instagram 작성창에 입력하지 못했습니다.');
    return result;
  }
  const tabId = await resolveTargetNaverTabId(requestedTabId);
  const targetTab = await getTabSafely(tabId);
  if (getNaverEditorKind(targetTab?.url || '') === 'threads') throw new Error('Threads 모드에서 준비한 글을 입력하세요.');

  if (getNaverEditorKind(targetTab?.url || '') === 'instagram') {
    throw new Error('Instagram 탭에는 인스타그램 모드에서 준비한 이미지와 캡션만 입력할 수 있습니다.');
  }

  if (getNaverEditorKind(targetTab?.url || "") === "blogger") {
    return insertPostIntoBloggerEditor(payload, tabId);
  }

  if (getNaverEditorKind(targetTab?.url || "") === "tistory") {
    if (!(await isKoreanTistoryMode())) throw new Error('티스토리는 한국어 화면에서만 사용할 수 있습니다.');
    return insertPostIntoTistoryEditor(payload, tabId);
  }

  const title = String(payload?.title || "").trim();
  const requestedTags = Array.isArray(payload?.tags)
    ? payload.tags.map((tag) => String(tag || "").trim()).filter(Boolean)
    : [];

  await appendBackgroundDebugLog("naver.insert.started", {
    tabId,
    titlePreview: summarizeTextForLog(title, 120),
    htmlLength: String(payload?.html || "").length,
    tagCount: requestedTags.length,
    imageCount: Array.isArray(payload?.images) ? payload.images.length : 0,
  });

  const detections = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: detectNaverEditorFrame,
  });

  const candidates = detections
    .map((entry) => ({ frameId: entry.frameId, result: entry.result }))
    .filter((entry) => entry.result?.bodyFound)
    .sort((left, right) => right.result.score - left.result.score);

  if (!candidates.length) {
    throw new Error("네이버 블로그·카페 본문 입력 영역을 찾지 못했습니다. 글쓰기 편집 화면을 연 뒤 다시 실행해 주세요.");
  }

  const targetFrame = candidates[0];
  const tagsInBody = getNaverEditorKind(targetTab?.url || '') === 'blog';
  const insertionResults = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [targetFrame.frameId] },
    func: insertNaverBlogPost,
    args: [{ ...payload, bodyTags: tagsInBody ? requestedTags : [] }],
  });

  const insertion = insertionResults[0]?.result;

  if (!insertion?.ok) {
    throw new Error(insertion?.error || "네이버 블로그·카페 입력창에 내용을 넣지 못했습니다.");
  }

  // Blog hashtags are already appended to the body; retain Cafe's tag flow.
  if (!tagsInBody && requestedTags.length) {
    await sleep(1000);
  }

  const tagInsertedCount = tagsInBody
    ? Number(insertion.bodyTagInsertedCount || 0)
    : (requestedTags.length ? await insertPostTagsIntoNaverEditor(tabId, requestedTags) : 0);

  await appendBackgroundDebugLog("naver.insert.completed", {
    tabId,
    frameId: targetFrame.frameId,
    candidateCount: candidates.length,
    titleProvided: Boolean(title),
    titleInserted: Boolean(insertion?.titleInserted),
    bodyInserted: Boolean(insertion?.bodyInserted),
    bodyMode: String(insertion?.bodyMode || ""),
    tagRequestedCount: requestedTags.length,
    tagInsertedCount,
    imageRequestedCount: Number(insertion?.imageRequestedCount || 0),
    imageInsertedCount: Number(insertion?.imageInsertedCount || 0),
  });

  return {
    ...insertion,
    titleInserted: Boolean(insertion?.titleInserted),
    tagRequestedCount: requestedTags.length,
    tagInsertedCount,
  };
}

async function insertPostIntoBloggerEditor(payload, tabId) {
  const title = String(payload?.title || "").trim();
  const bodyRequested = Boolean(String(payload?.html || payload?.text || "").trim());
  const requestedImageCount = Array.isArray(payload?.images)
    ? payload.images.filter((image) => /^data:image\//i.test(String(image?.dataUrl || image?.src || "").trim())).length
    : 0;
  const requestedTags = Array.isArray(payload?.tags)
    ? Array.from(new Set(payload.tags
      .map((tag) => String(tag || "").replace(/^#/, "").trim())
      .filter(Boolean)))
        .slice(0, 20)
    : [];

  await appendBackgroundDebugLog("blogger.insert.started", {
    tabId,
    titlePreview: summarizeTextForLog(title, 120),
    htmlLength: String(payload?.html || "").length,
    tagCount: requestedTags.length,
    imageCount: Array.isArray(payload?.images) ? payload.images.length : 0,
  });

  const bodyFrame = await resolveGoogleBloggerBodyFrame(tabId, 15000);

  if (!bodyFrame) {
    throw new Error("Google Blogger 본문 iframe을 찾지 못했습니다. 새 글 편집기가 완전히 열린 뒤 다시 시도해 주세요.");
  }

  let bodyInsertion = await executeGoogleBloggerBodyInsertion(tabId, bodyFrame.frameId, payload);

  // Blogger can replace the editor iframe immediately after the first edit. Resolve
  // the visible frame again and apply the body once more when the active frame changed
  // or the first insertion was not confirmed.
  await sleep(650);
  const verifiedBodyFrame = await resolveGoogleBloggerBodyFrame(tabId, 6000);

  if (verifiedBodyFrame && (
    verifiedBodyFrame.frameId !== bodyFrame.frameId
    || !bodyInsertion.bodyInserted
    || !bodyInsertion.frameVisible
  )) {
    const retryBodyInsertion = await executeGoogleBloggerBodyInsertion(
      tabId,
      verifiedBodyFrame.frameId,
      payload
    );

    if (retryBodyInsertion.bodyInserted || retryBodyInsertion.imageInsertedCount) {
      bodyInsertion = retryBodyInsertion;
    }
  }

  // Blogger keeps the previous editor mounted but hidden while a new post shell is
  // being created. Wait until the post-body remount has started before touching the
  // title and labels so we never update the stale editor instance.
  await sleep(700);
  const shellResults = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: prepareGoogleBloggerPostShell,
    args: [payload],
    world: "MAIN",
  });
  const shellInsertion = shellResults[0]?.result || {};

  // Re-check after Blogger's autosave/render cycle. The helper only targets visible
  // fields and skips writing when the current active field already contains the value.
  await sleep(900);
  const finalShellResults = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: prepareGoogleBloggerPostShell,
    args: [payload],
    world: "MAIN",
  });
  const finalShellInsertion = finalShellResults[0]?.result || {};
  const insertion = {
    ...bodyInsertion,
    ok: Boolean(
      shellInsertion.titleInserted
      || finalShellInsertion.titleInserted
      || shellInsertion.tagInsertedCount
      || finalShellInsertion.tagInsertedCount
      || bodyInsertion.bodyInserted
      || bodyInsertion.imageInsertedCount
    ),
    platform: "blogger",
    titleInserted: Boolean(shellInsertion.titleInserted || finalShellInsertion.titleInserted),
    tagRequestedCount: Number(finalShellInsertion.tagRequestedCount || shellInsertion.tagRequestedCount || requestedTags.length),
    tagInsertedCount: Math.max(
      Number(shellInsertion.tagInsertedCount || 0),
      Number(finalShellInsertion.tagInsertedCount || 0)
    ),
  };

  if (!insertion?.ok) {
    throw new Error(bodyInsertion?.error || shellInsertion?.error || "Google Blogger 입력창에 내용을 넣지 못했습니다.");
  }

  await appendBackgroundDebugLog("blogger.insert.completed", {
    tabId,
    titleInserted: Boolean(insertion.titleInserted),
    bodyInserted: Boolean(insertion.bodyInserted),
    tagInsertedCount: Number(insertion.tagInsertedCount || 0),
    imageRequestedCount: Number(insertion.imageRequestedCount || 0),
    imageInsertedCount: Number(insertion.imageInsertedCount || 0),
    imageMarkerFoundCount: Number(insertion.imageMarkerFoundCount || 0),
    firstShell: shellInsertion,
    finalShell: finalShellInsertion,
    firstBodyFrame: bodyFrame,
    verifiedBodyFrame,
  });

  const missingParts = [];

  if (bodyRequested && !insertion.bodyInserted) {
    missingParts.push("본문");
  }

  if (title && !insertion.titleInserted) {
    missingParts.push("제목");
  }

  if (requestedTags.length && insertion.tagInsertedCount < requestedTags.length) {
    missingParts.push("라벨");
  }

  if (requestedImageCount && insertion.imageInsertedCount < requestedImageCount) {
    missingParts.push("이미지");
  }

  if (missingParts.length) {
    await appendBackgroundDebugLog("blogger.insert.incomplete", {
      missingParts,
      bodyRequested,
      requestedTitle: Boolean(title),
      requestedTagCount: requestedTags.length,
      requestedImageCount,
      firstShell: shellInsertion,
      finalShell: finalShellInsertion,
    });
    throw new Error(`Google Blogger ${missingParts.join("·")} 입력을 확인하지 못했습니다. 진단 로그를 복사해 주세요.`);
  }

  return insertion;
}

async function executeGoogleBloggerBodyInsertion(tabId, frameId, payload) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: insertGoogleBloggerBody,
      args: [payload],
    });
    return results[0]?.result || {};
  } catch (error) {
    return {
      ok: false,
      bodyInserted: false,
      error: error?.message || String(error),
      frameId,
    };
  }
}

async function resolveGoogleBloggerBodyFrame(tabId, timeoutMs = 15000) {
  const startedAt = Date.now();
  let stableFrameId = null;
  let stableSince = 0;

  while (Date.now() - startedAt < timeoutMs) {
    let detections = [];

    try {
      detections = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: detectGoogleBloggerBodyFrame,
      });
    } catch {
      detections = [];
    }

    const candidate = detections
      .map((entry) => ({ frameId: entry.frameId, result: entry.result || {} }))
      .filter((entry) => entry.result.bodyFound)
      .sort((left, right) => Number(right.result.score || 0) - Number(left.result.score || 0))[0] || null;

    if (!candidate) {
      stableFrameId = null;
      stableSince = 0;
      await sleep(200);
      continue;
    }

    if (candidate.frameId !== stableFrameId) {
      stableFrameId = candidate.frameId;
      stableSince = Date.now();
      await sleep(220);
      continue;
    }

    if (Date.now() - stableSince >= 500) {
      return candidate;
    }

    await sleep(150);
  }

  return null;
}

function detectGoogleBloggerBodyFrame() {
  const body = document.body;
  const ownerFrame = window.frameElement;
  const ownerRect = ownerFrame?.getBoundingClientRect?.() || null;
  const ownerStyle = ownerFrame ? getComputedStyle(ownerFrame) : null;
  const frameVisible = window.top === window
    ? true
    : Boolean(
      ownerFrame
      && ownerRect
      && ownerRect.width > 0
      && ownerRect.height > 0
      && ownerStyle?.display !== "none"
      && ownerStyle?.visibility !== "hidden"
      && ownerStyle?.opacity !== "0"
    );
  const isEditableBody = Boolean(
    body
    && (body.getAttribute("g_editable") === "true" || body.getAttribute("contenteditable") !== null)
    && (body.getAttribute("role") === "textbox" || body.classList.contains("editable") || /^nsoPic/i.test(body.id || ""))
  );
  const bodyFound = isEditableBody && frameVisible;

  return {
    bodyFound,
    frameVisible,
    score: bodyFound
      ? 1000
        + (body.getAttribute("g_editable") === "true" ? 40 : 0)
        + (/^nsoPic/i.test(ownerFrame?.id || body.id || "") ? 30 : 0)
        + Math.min(300, Math.round((ownerRect?.width || innerWidth || 0) / 10))
      : 0,
    href: location.href,
    bodyId: body?.id || "",
    ownerFrameId: ownerFrame?.id || "",
    ownerFrameWidth: Math.round(ownerRect?.width || 0),
    ownerFrameHeight: Math.round(ownerRect?.height || 0),
    viewportWidth: Number(innerWidth || 0),
    viewportHeight: Number(innerHeight || 0),
    contentLength: String(body?.innerText || body?.textContent || "").trim().length,
  };
}

async function prepareGoogleBloggerPostShell(payload) {
  try {
    const title = String(payload?.title || "").replace(/\s+/g, " ").trim();
    const tags = Array.isArray(payload?.tags)
      ? Array.from(new Set(payload.tags
        .map((tag) => String(tag || "").replace(/^#/, "").trim())
        .filter(Boolean)))
          .slice(0, 20)
      : [];
    const titleSelector = "input[aria-label='제목'], input[aria-label*='제목'], input[aria-label='Title' i], input[aria-label='タイトル'], input[aria-label='Título' i], input[aria-label='Título de la entrada' i]";
    const labelSelector = "textarea[aria-label='쉼표로 라벨을 구분하세요.'], textarea[aria-label*='라벨'], input[aria-label*='라벨'], textarea[aria-label='Separate labels by commas' i], textarea[aria-label='Labels' i], input[aria-label='Labels' i], textarea[aria-label*='ラベル'], input[aria-label*='ラベル'], textarea[aria-label*='Etiquetas' i], input[aria-label='Etiquetas' i]";
    const labelValue = tags.join(", ");
    const deadline = Date.now() + 7000;
    let stablePasses = 0;
    let titleInserted = !title;
    let labelsInserted = !tags.length;
    let titleVisibleCount = 0;
    let labelVisibleCount = 0;
    let attempts = 0;
    let execCommandInsertions = 0;
    let nativeSetterFallbacks = 0;

    if (tags.length) {
      expandBloggerLabelsPanel();
    }

    while (Date.now() < deadline && stablePasses < 3) {
      attempts += 1;
      const titleFields = findVisibleFields(titleSelector);
      const labelFields = findVisibleFields(labelSelector);
      const titleInput = titleFields[titleFields.length - 1] || null;
      const labelInput = labelFields[labelFields.length - 1] || null;
      titleVisibleCount = titleFields.length;
      labelVisibleCount = labelFields.length;

      if (title && titleInput && normalizeValue(titleInput.value) !== title) {
        const mode = applyFieldValue(titleInput, title);
        execCommandInsertions += mode === "execCommand" ? 1 : 0;
        nativeSetterFallbacks += mode === "nativeSetter" ? 1 : 0;
      }

      if (tags.length && labelInput && normalizeValue(labelInput.value) !== labelValue) {
        const mode = applyFieldValue(labelInput, labelValue);
        execCommandInsertions += mode === "execCommand" ? 1 : 0;
        nativeSetterFallbacks += mode === "nativeSetter" ? 1 : 0;
      }

      await sleep(220);

      const currentTitleInput = findVisibleField(titleSelector);
      const currentLabelInput = findVisibleField(labelSelector);
      titleInserted = !title || normalizeValue(currentTitleInput?.value) === title;
      labelsInserted = !tags.length || normalizeValue(currentLabelInput?.value) === labelValue;

      if (titleInserted && labelsInserted) {
        stablePasses += 1;
      } else {
        stablePasses = 0;

        if (tags.length && !currentLabelInput) {
          expandBloggerLabelsPanel();
        }
      }
    }

    const finalTitleInput = findVisibleField(titleSelector);
    const finalLabelInput = findVisibleField(labelSelector);
    titleInserted = !title || normalizeValue(finalTitleInput?.value) === title;
    labelsInserted = !tags.length || normalizeValue(finalLabelInput?.value) === labelValue;
    const tagInsertedCount = labelsInserted && tags.length ? tags.length : 0;

    return {
      ok: true,
      titleInserted,
      tagRequestedCount: tags.length,
      tagInsertedCount,
      attempts,
      stablePasses,
      titleVisibleCount,
      labelVisibleCount,
      titleCandidateCount: document.querySelectorAll(titleSelector).length,
      labelCandidateCount: document.querySelectorAll(labelSelector).length,
      execCommandInsertions,
      nativeSetterFallbacks,
    };
  } catch (error) {
    return { ok: false, error: error.message || String(error), titleInserted: false, tagInsertedCount: 0 };
  }

  function setNativeValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value")
      || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
      || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");

    if (descriptor?.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  function findVisibleFields(selector) {
    return Array.from(document.querySelectorAll(selector)).filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const hiddenAncestor = element.closest("[hidden], [aria-hidden='true']");

      return element.isConnected
        && !element.disabled
        && element.getAttribute("aria-disabled") !== "true"
        && !hiddenAncestor
        && rect.width > 0
        && rect.height > 0
        && style.display !== "none"
        && style.visibility !== "hidden"
        && style.opacity !== "0";
    });
  }

  function findVisibleField(selector) {
    const visible = findVisibleFields(selector);
    return visible[visible.length - 1] || null;
  }

  function applyFieldValue(element, value) {
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
    element.focus({ preventScroll: true });

    try {
      element.select();
    } catch {
      // Selection is best-effort for fields that do not expose select().
    }

    let insertedWithCommand = false;

    try {
      insertedWithCommand = Boolean(document.execCommand("insertText", false, value));
    } catch {
      insertedWithCommand = false;
    }

    let mode = "execCommand";

    if (!insertedWithCommand || normalizeValue(element.value) !== value) {
      setNativeValue(element, value);
      dispatchValueEvents(element, value);
      mode = "nativeSetter";
    } else {
      element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    }

    element.blur();
    return mode;
  }

  function expandBloggerLabelsPanel() {
    const candidates = Array.from(document.querySelectorAll("button, [role='button']"));
    const labelButton = candidates.find((element) => {
      if (!isElementVisible(element)) {
        return false;
      }

      const ariaLabel = normalizeValue(element.getAttribute("aria-label"));
      const text = normalizeValue(element.textContent);
      return ariaLabel === "라벨" || text.includes("라벨") || ariaLabel === "ラベル" || text.includes("ラベル") || /^etiquetas$/i.test(ariaLabel) || /^etiquetas(?:\s|[\ue000-\uf8ff]|$)/i.test(text)
        || ariaLabel.toLowerCase() === "labels" || /^labels(?:\s|[\ue000-\uf8ff]|$)/i.test(text);
    });

    if (labelButton && labelButton.getAttribute("aria-expanded") !== "true") {
      labelButton.click();
    }
  }

  function isElementVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return element.isConnected
      && !element.closest("[hidden], [aria-hidden='true']")
      && rect.width > 0
      && rect.height > 0
      && style.display !== "none"
      && style.visibility !== "hidden";
  }

  function normalizeValue(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function dispatchValueEvents(element, value) {
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      composed: true,
      data: value,
      inputType: "insertReplacementText",
    }));
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

async function insertGoogleBloggerBody(payload) {
  try {
    const body = document.body;
    const ownerFrame = window.frameElement;
    const ownerRect = ownerFrame?.getBoundingClientRect?.() || null;
    const ownerStyle = ownerFrame ? getComputedStyle(ownerFrame) : null;
    const frameVisible = Boolean(
      ownerFrame
      && ownerRect
      && ownerRect.width > 0
      && ownerRect.height > 0
      && ownerStyle?.display !== "none"
      && ownerStyle?.visibility !== "hidden"
      && ownerStyle?.opacity !== "0"
    );

    const isEditableBody = Boolean(
      body
      && (body.getAttribute("g_editable") === "true" || body.getAttribute("contenteditable") !== null)
    );

    if (!isEditableBody || !frameVisible) {
      return {
        ok: false,
        error: "현재 보이는 Blogger 본문 편집기 프레임이 아닙니다.",
        frameVisible,
        ownerFrameId: ownerFrame?.id || "",
        ownerFrameWidth: Math.round(ownerRect?.width || 0),
        ownerFrameHeight: Math.round(ownerRect?.height || 0),
      };
    }

    const rawHtml = String(payload?.html || "").trim();
    const plainText = String(payload?.text || "").trim();
    const images = Array.isArray(payload?.images) ? payload.images.filter(Boolean) : [];
    const contentHtml = sanitizeHtml(rawHtml || textToHtml(plainText));
    const safeHtml = payload.photoWriter === true
      ? buildPhotoWriterMarkers(contentHtml, images)
      : buildBloggerHtmlWithImageMarkers(contentHtml, images);
    let bodyInserted = false;

    if (safeHtml) {
      body.focus();
      const selection = getSelection();
      const range = document.createRange();
      range.selectNodeContents(body);
      selection?.removeAllRanges();
      selection?.addRange(range);

      let inserted = false;

      try {
        inserted = document.execCommand("insertHTML", false, safeHtml);
      } catch {
        inserted = false;
      }

      if (!inserted || !normalizeText(body.textContent || "")) {
        body.innerHTML = safeHtml;
      }

      dispatchEditorInput(body, "insertFromPaste");
      await sleep(180);
      bodyInserted = Boolean(normalizeText(body.textContent || "") || body.querySelector("img"));
    }

    let imageInsertedCount = 0;
    let imageMarkerFoundCount = 0;
    const imageSizeHints = [];

    for (let index = 0; index < images.length; index += 1) {
      const image = images[index];
      const dataUrl = String(image?.dataUrl || image?.src || "").trim();

      if (!/^data:image\//i.test(dataUrl)) {
        removeBloggerImageMarker(body, index);
        continue;
      }

      const marker = findBloggerImageMarker(body, index)
        || createLiveBloggerImageMarker(body, image, index);

      if (marker) {
        imageMarkerFoundCount += 1;
      }

      const pasteResult = await pasteImage(
        body,
        dataUrl,
        image?.fileName || `blogger-image-${index + 1}.png`,
        marker,
        String(image?.alt || "").trim(),
        index
      );

      imageSizeHints[index] = pasteResult.originalSize;

      if (pasteResult.inserted) {
        imageInsertedCount += 1;
      }
    }

    await stabilizeBloggerVeryLargeImages(body, imageInsertedCount, imageSizeHints);
    cleanupBloggerImageMarkers(body);
    dispatchEditorInput(body, "insertFromPaste");
    await sleep(180);
    bodyInserted = Boolean(normalizeText(body.textContent || "") || body.querySelector("img"));

    return {
      ok: Boolean(bodyInserted || imageInsertedCount),
      platform: "blogger",
      bodyInserted,
      imageRequestedCount: images.length,
      imageInsertedCount,
      imageMarkerFoundCount,
      frameUrl: location.href,
      frameVisible,
      ownerFrameId: ownerFrame?.id || "",
      ownerFrameWidth: Math.round(ownerRect?.width || 0),
      ownerFrameHeight: Math.round(ownerRect?.height || 0),
    };
  } catch (error) {
    return { ok: false, error: error.message || String(error), platform: "blogger" };
  }

  function sanitizeHtml(html) {
    const template = document.createElement("template");
    template.innerHTML = String(html || "");
    template.content.querySelectorAll("script, style, iframe, object, embed").forEach((node) => node.remove());

    for (const strike of Array.from(template.content.querySelectorAll("strike, s, del"))) {
      strike.replaceWith(...Array.from(strike.childNodes));
    }

    for (const element of Array.from(template.content.querySelectorAll("*"))) {
      for (const attribute of Array.from(element.attributes)) {
        if (/^on/i.test(attribute.name)) {
          element.removeAttribute(attribute.name);
        }
      }

      if (/line-through/i.test(element.style?.textDecoration || element.style?.textDecorationLine || "")) {
        element.style.removeProperty("text-decoration");
        element.style.removeProperty("text-decoration-line");
      }
    }

    return template.innerHTML.trim();
  }

  function buildPhotoWriterMarkers(html, images) {
    const template = document.createElement('template');
    template.innerHTML = html;
    const slots = Array.from(template.content.querySelectorAll('[data-dd-photo-slot]'));
    if (slots.length !== images.length) throw new Error('사진 위치 정보가 일치하지 않습니다. 완성본을 다시 확인하세요.');
    slots.forEach((slot, index) => {
      if (slot.getAttribute('data-dd-photo-slot') !== String(index)) throw new Error('사진 순서 정보가 잘못되었습니다.');
      slot.replaceWith(createBloggerImageMarker(index));
    });
    return template.innerHTML;
  }

  function buildBloggerHtmlWithImageMarkers(html, imageEntries) {
    const safeHtml = String(html || "").trim();
    const safeImages = Array.isArray(imageEntries) ? imageEntries.filter(Boolean) : [];

    if (!safeHtml || !safeImages.length) {
      return safeHtml;
    }

    const template = document.createElement("template");
    template.innerHTML = safeHtml;
    const nodes = Array.from(template.content.childNodes).filter((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        return Boolean(normalizeText(node.textContent || ""));
      }

      return node.nodeType === Node.ELEMENT_NODE;
    });

    if (!nodes.length) {
      return safeHtml;
    }

    const headings = nodes
      .map((node, index) => ({
        index,
        text: isHeadingNode(node) ? normalizeText(node.textContent || "") : "",
      }))
      .filter((entry) => entry.text);
    const sectionAnchors = headings.map((entry) => findSectionAnchor(entry.index, nodes));
    const paragraphAnchors = nodes
      .map((node, index) => ({ node, index }))
      .filter((entry) => isParagraphLikeNode(entry.node))
      .map((entry) => entry.index);
    const firstHeadingIndex = headings[0]?.index ?? -1;
    const introAnchor = firstHeadingIndex > 0
      ? firstHeadingIndex - 1
      : (paragraphAnchors[0] ?? 0);
    const insertionMap = new Map();

    for (let index = 0; index < safeImages.length; index += 1) {
      const anchor = resolveBloggerImageAnchor(safeImages[index], index, {
        nodes,
        headings,
        sectionAnchors,
        paragraphAnchors,
        introAnchor,
      });

      if (!insertionMap.has(anchor)) {
        insertionMap.set(anchor, []);
      }

      insertionMap.get(anchor).push(index);
    }

    const leadingIndexes = insertionMap.get(-1) || [];
    let leadingReference = nodes[0];

    for (const imageIndex of leadingIndexes) {
      const marker = createBloggerImageMarker(imageIndex);
      template.content.insertBefore(marker, leadingReference);
    }

    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
      const imageIndexes = insertionMap.get(nodeIndex) || [];
      let reference = nodes[nodeIndex];

      for (const imageIndex of imageIndexes) {
        const marker = createBloggerImageMarker(imageIndex);
        reference.after(marker);
        reference = marker;
      }
    }

    for (const imageIndex of insertionMap.get(nodes.length) || []) {
      template.content.appendChild(createBloggerImageMarker(imageIndex));
    }

    return template.innerHTML.trim();
  }

  function resolveBloggerImageAnchor(image, order, context) {
    const headingAnchor = findMatchingHeadingAnchor(image, context.headings, context.nodes);

    if (headingAnchor >= 0) {
      return headingAnchor;
    }

    const hintText = normalizeComparableText([
      image?.slot,
      image?.placementHint || image?.placement_hint,
      image?.headingHint || image?.heading_hint,
      image?.alt,
    ].join(" "));
    const representativeHintText = normalizeComparableText([
      image?.slot,
      image?.alt,
    ].join(" "));

    if (/(대표|썸네일|thumbnail|hero|cover)/i.test(representativeHintText)) {
      return -1;
    }

    if (/(마무리|결론|마지막|끝|outro|closing)/i.test(hintText)) {
      return context.nodes.length;
    }

    if (/(도입|인트로|대표|썸네일|첫|opening)/i.test(hintText)) {
      return context.introAnchor;
    }

    const fallbackAnchors = context.sectionAnchors.length
      ? context.sectionAnchors
      : context.paragraphAnchors;

    if (fallbackAnchors.length) {
      return fallbackAnchors[Math.min(order, fallbackAnchors.length - 1)];
    }

    return Math.max(0, context.nodes.length - 1);
  }

  function findMatchingHeadingAnchor(image, headings, nodes) {
    const terms = [
      image?.headingHint || image?.heading_hint,
      image?.slot,
      image?.placementHint || image?.placement_hint,
    ].map((value) => normalizeComparableText(value)).filter(Boolean);

    if (!terms.length || !headings.length) {
      return -1;
    }

    let bestHeading = null;
    let bestScore = 0;

    for (const heading of headings) {
      const headingText = normalizeComparableText(heading.text);
      const headingNumber = extractSectionNumber(heading.text);
      let score = 0;

      for (const term of terms) {
        if (headingText === term) {
          score += 120;
        } else if (headingText.includes(term) || term.includes(headingText)) {
          score += 80;
        }

        const termNumber = extractSectionNumber(term);
        if (headingNumber && termNumber && headingNumber === termNumber) {
          score += 90;
        }

        const headingWords = comparableWords(heading.text);
        const termWords = comparableWords(term);
        score += termWords.filter((word) => headingWords.includes(word)).length * 18;
      }

      if (score > bestScore) {
        bestScore = score;
        bestHeading = heading;
      }
    }

    return bestHeading && bestScore >= 18
      ? Math.max(-1, bestHeading.index - 1)
      : -1;
  }

  function findSectionAnchor(headingIndex, nodes) {
    for (let index = headingIndex + 1; index < nodes.length; index += 1) {
      if (isHeadingNode(nodes[index])) {
        break;
      }

      if (isParagraphLikeNode(nodes[index])) {
        return index;
      }
    }

    return headingIndex;
  }

  function createBloggerImageMarker(index) {
    const marker = document.createElement("p");
    const token = getBloggerImageMarkerToken(index);
    const tokenNode = document.createElement("span");
    marker.setAttribute("data-nb-blogger-image-marker", String(index));
    tokenNode.setAttribute("data-nb-blogger-image-token", String(index));
    tokenNode.style.display = "none";
    tokenNode.textContent = token;
    marker.appendChild(tokenNode);
    marker.appendChild(document.createElement("br"));
    return marker;
  }

  function getBloggerImageMarkerToken(index) {
    return `__NB_BLOGGER_IMAGE_${index}__`;
  }

  function findBloggerImageMarker(body, index) {
    const directMarker = body.querySelector(`[data-nb-blogger-image-marker="${index}"]`);

    if (directMarker) {
      return directMarker;
    }

    const token = getBloggerImageMarkerToken(index);
    const tokenNode = Array.from(body.querySelectorAll("span"))
      .find((element) => String(element.textContent || "").includes(token));
    const tokenParagraph = Array.from(body.querySelectorAll("p"))
      .find((element) => normalizeText(element.textContent || "") === token);
    return tokenNode?.closest("p, div") || tokenNode || tokenParagraph || null;
  }

  function removeBloggerImageMarker(body, index) {
    findBloggerImageMarker(body, index)?.remove();
  }

  function createLiveBloggerImageMarker(body, image, index) {
    const nodes = Array.from(body.childNodes).filter((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        return Boolean(normalizeText(node.textContent || ""));
      }

      return node.nodeType === Node.ELEMENT_NODE
        && !node.matches?.("[data-nb-blogger-image-marker]");
    });

    if (!nodes.length) {
      return null;
    }

    const headings = nodes
      .map((node, nodeIndex) => ({
        index: nodeIndex,
        text: isHeadingNode(node) ? normalizeText(node.textContent || "") : "",
      }))
      .filter((entry) => entry.text);
    const sectionAnchors = headings.map((entry) => findSectionAnchor(entry.index, nodes));
    const paragraphAnchors = nodes
      .map((node, nodeIndex) => ({ node, index: nodeIndex }))
      .filter((entry) => isParagraphLikeNode(entry.node))
      .map((entry) => entry.index);
    const firstHeadingIndex = headings[0]?.index ?? -1;
    const introAnchor = firstHeadingIndex > 0
      ? firstHeadingIndex - 1
      : (paragraphAnchors[0] ?? 0);
    const anchor = resolveBloggerImageAnchor(image, index, {
      nodes,
      headings,
      sectionAnchors,
      paragraphAnchors,
      introAnchor,
    });
    const marker = createBloggerImageMarker(index);

    if (anchor < 0) {
      body.insertBefore(marker, nodes[0]);
    } else if (anchor >= nodes.length) {
      body.appendChild(marker);
    } else {
      nodes[anchor].after(marker);
    }

    return marker;
  }

  function cleanupBloggerImageMarkers(body) {
    body.querySelectorAll("[data-nb-blogger-image-marker], [data-nb-blogger-image-token]")
      .forEach((element) => {
        const marker = element.closest("[data-nb-blogger-image-marker]");
        (marker || element).remove();
      });

    for (const element of Array.from(body.querySelectorAll("span, p"))) {
      if (/^__NB_BLOGGER_IMAGE_\d+__$/.test(normalizeText(element.textContent || ""))) {
        const marker = element.closest("p, div");
        (marker || element).remove();
      }
    }
  }

  function isHeadingNode(node) {
    return node?.nodeType === Node.ELEMENT_NODE && /^(H2|H3)$/i.test(node.tagName || "");
  }

  function isParagraphLikeNode(node) {
    return node?.nodeType === Node.ELEMENT_NODE && /^(P|BLOCKQUOTE|UL|OL|IMG)$/i.test(node.tagName || "");
  }

  function normalizeComparableText(value) {
    return normalizeText(value)
      .replace(/[^0-9a-zA-Z가-힣]+/g, "")
      .toLowerCase();
  }

  function comparableWords(value) {
    return normalizeText(value)
      .toLowerCase()
      .split(/[^0-9a-zA-Z가-힣]+/)
      .filter((word) => word.length >= 2);
  }

  function extractSectionNumber(value) {
    const match = String(value || "").match(/(?:^|\s)(\d{1,2})\s*[.)번]?/);
    return match ? Number(match[1]) || 0 : 0;
  }

  function textToHtml(text) {
    return String(text || "")
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
      .join("");
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>\"]/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '\"': "&quot;",
    }[character]));
  }

  function normalizeText(value) {
    return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  function dispatchEditorInput(element, inputType) {
    try {
      element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType }));
    } catch {
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function stabilizeBloggerVeryLargeImages(body, expectedCount, imageSizeHints) {
    const deadline = Date.now() + 3500;
    const minimumObservationUntil = Date.now() + 1800;
    let stablePasses = 0;
    let previousSignature = "";

    while (
      Date.now() < deadline
      && (Date.now() < minimumObservationUntil || stablePasses < 3)
    ) {
      const currentImages = Array.from(body.querySelectorAll("img"));

      for (let index = 0; index < currentImages.length; index += 1) {
        const image = currentImages[index];
        const storedIndexValue = image.getAttribute("data-nb-source-index");
        const storedIndex = storedIndexValue === null ? -1 : Number(storedIndexValue);
        const sourceIndex = Number.isInteger(storedIndex) && storedIndex >= 0
          ? storedIndex
          : index;
        applyBloggerVeryLargeImageSize(image, imageSizeHints?.[sourceIndex], sourceIndex);
      }

      const signature = currentImages.map((image) => [
        image.getAttribute("src") || "",
        image.getAttribute("width") || "",
        image.getAttribute("height") || "",
      ].join("|"));
      const allExpectedImagesPresent = !expectedCount || currentImages.length >= expectedCount;

      if (allExpectedImagesPresent && signature.join("::") === previousSignature) {
        stablePasses += 1;
      } else {
        stablePasses = 0;
      }

      previousSignature = signature.join("::");
      await sleep(220);
    }

    for (const image of body.querySelectorAll("img")) {
      image.removeAttribute("data-nb-source-index");
      image.removeAttribute("data-nb-source-width");
      image.removeAttribute("data-nb-source-height");
    }

    dispatchEditorInput(body, "insertFromPaste");
  }

  function applyBloggerVeryLargeImageSize(image, sourceSize, sourceIndex) {
    const storedWidth = Number(image.getAttribute("data-nb-source-width")) || 0;
    const storedHeight = Number(image.getAttribute("data-nb-source-height")) || 0;
    const sourceWidth = Number(sourceSize?.width) || storedWidth || Number(image.naturalWidth) || 0;
    const sourceHeight = Number(sourceSize?.height) || storedHeight || Number(image.naturalHeight) || 0;
    const targetWidth = 640;

    image.setAttribute("width", String(targetWidth));

    if (sourceWidth > 0 && sourceHeight > 0) {
      image.setAttribute("data-nb-source-width", String(sourceWidth));
      image.setAttribute("data-nb-source-height", String(sourceHeight));
      image.setAttribute("data-original-width", String(sourceWidth));
      image.setAttribute("data-original-height", String(sourceHeight));
      image.setAttribute("height", String(Math.max(1, Math.round(targetWidth * sourceHeight / sourceWidth))));
      image.style.setProperty("aspect-ratio", `${sourceWidth} / ${sourceHeight}`, "important");
    } else {
      image.removeAttribute("height");
      image.style.setProperty("aspect-ratio", "auto", "important");
    }

    if (Number.isInteger(sourceIndex) && sourceIndex >= 0) {
      image.setAttribute("data-nb-source-index", String(sourceIndex));
    }

    image.style.setProperty("display", "block", "important");
    image.style.setProperty("width", "100%", "important");
    image.style.setProperty("max-width", `${targetWidth}px`, "important");
    image.style.setProperty("height", "auto", "important");
    image.style.setProperty("object-fit", "contain", "important");
    image.style.setProperty("margin-left", "auto", "important");
    image.style.setProperty("margin-right", "auto", "important");

    const linkWrapper = image.closest("a");
    if (linkWrapper) {
      linkWrapper.style.setProperty("display", "block", "important");
      linkWrapper.style.setProperty("width", "100%", "important");
      linkWrapper.style.setProperty("max-width", `${targetWidth}px`, "important");
      linkWrapper.style.setProperty("height", "auto", "important");
      linkWrapper.style.setProperty("aspect-ratio", "auto", "important");
      linkWrapper.style.setProperty("margin-left", "auto", "important");
      linkWrapper.style.setProperty("margin-right", "auto", "important");
      linkWrapper.style.setProperty("text-align", "center", "important");
    }
  }

  async function readOriginalImageSize(blob, dataUrl) {
    if (typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(blob);
        const size = {
          width: Number(bitmap.width) || 0,
          height: Number(bitmap.height) || 0,
        };
        bitmap.close?.();

        if (size.width > 0 && size.height > 0) {
          return size;
        }
      } catch {
        // Image 요소를 이용한 폴백으로 원본 크기를 읽습니다.
      }
    }

    return await new Promise((resolve) => {
      const probe = new Image();
      const timeout = setTimeout(() => resolve(null), 1500);

      probe.onload = () => {
        clearTimeout(timeout);
        const width = Number(probe.naturalWidth) || 0;
        const height = Number(probe.naturalHeight) || 0;
        resolve(width > 0 && height > 0 ? { width, height } : null);
      };
      probe.onerror = () => {
        clearTimeout(timeout);
        resolve(null);
      };
      probe.src = dataUrl;
    });
  }

  async function pasteImage(body, dataUrl, fileName, marker, altText, sourceIndex) {
    const beforeImages = new Set(body.querySelectorAll("img"));
    const beforeCount = beforeImages.size;
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const originalSize = await readOriginalImageSize(blob, dataUrl);
    const extension = String(blob.type || "image/png").split("/")[1]?.replace("jpeg", "jpg") || "png";
    const safeName = /\.[a-z0-9]+$/i.test(fileName) ? fileName : `${fileName}.${extension}`;
    const file = new File([blob], safeName, { type: blob.type || "image/png" });
    const selection = getSelection();
    const range = document.createRange();
    body.focus();

    if (marker?.isConnected) {
      range.setStartBefore(marker);
      range.collapse(true);
    } else {
      range.selectNodeContents(body);
      range.collapse(false);
    }

    selection?.removeAllRanges();
    selection?.addRange(range);

    try {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      body.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }));
      await sleep(900);
    } catch {
      // 아래 data URL 이미지 폴백을 사용합니다.
    }

    if (body.querySelectorAll("img").length <= beforeCount) {
      const paragraph = document.createElement("p");
      const image = document.createElement("img");
      image.src = dataUrl;
      image.alt = altText || fileName;
      applyBloggerVeryLargeImageSize(image, originalSize, sourceIndex);
      paragraph.appendChild(image);

      if (marker?.isConnected) {
        marker.replaceWith(paragraph);
      } else {
        body.appendChild(paragraph);
      }

      dispatchEditorInput(body, "insertFromPaste");
      await sleep(120);
    } else {
      const insertedImages = Array.from(body.querySelectorAll("img"))
        .filter((image) => !beforeImages.has(image));

      for (const image of insertedImages) {
        if (altText) {
          image.alt = altText;
        }

        applyBloggerVeryLargeImageSize(image, originalSize, sourceIndex);
      }

      marker?.remove();
    }

    return {
      inserted: body.querySelectorAll("img").length > beforeCount,
      originalSize,
    };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

async function insertGoogleBloggerPost(payload) {
  try {
    const title = String(payload?.title || "").replace(/\s+/g, " ").trim();
    const rawHtml = String(payload?.html || "").trim();
    const plainText = String(payload?.text || "").trim();
    const tags = Array.isArray(payload?.tags)
      ? Array.from(new Set(payload.tags
        .map((tag) => String(tag || "").replace(/^#/, "").trim())
        .filter(Boolean)))
          .slice(0, 20)
      : [];
    const images = Array.isArray(payload?.images) ? payload.images.filter(Boolean) : [];
    const titleInput = document.querySelector("input[aria-label='제목'], input[aria-label*='제목'], input[aria-label='Title' i], input[aria-label='タイトル'], input[aria-label='Título' i], input[aria-label='Título de la entrada' i]");

    let titleInserted = false;

    if (title && titleInput) {
      titleInput.scrollIntoView?.({ block: "center", inline: "nearest" });
      titleInput.focus();
      setNativeValue(titleInput, title);
      titleInput.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        composed: true,
        data: title,
        inputType: "insertText",
      }));
      titleInput.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      titleInput.blur();
      // 새 글에서는 첫 입력 직후 자동 임시저장과 함께 본문 iframe이 교체될 수 있습니다.
      await sleep(500);
      titleInserted = String(titleInput.value || "").trim() === title;
    }

    const editorState = await waitForStableEditorBody(15000);

    if (!editorState) {
      return { ok: false, error: "Blogger 본문 편집 영역이 준비되지 않았습니다. 페이지 로딩 후 다시 시도해 주세요." };
    }

    const { frameDocument, frameWindow, body } = editorState;

    const safeHtml = sanitizeHtml(rawHtml || textToHtml(plainText));
    let bodyInserted = false;

    if (safeHtml) {
      body.focus();
      const selection = frameWindow.getSelection?.();
      const range = frameDocument.createRange();
      range.selectNodeContents(body);
      selection?.removeAllRanges();
      selection?.addRange(range);

      let inserted = false;

      try {
        inserted = frameDocument.execCommand("insertHTML", false, safeHtml);
      } catch {
        inserted = false;
      }

      if (!inserted || !normalizeText(body.textContent || "")) {
        body.innerHTML = safeHtml;
      }

      dispatchEditorInput(frameWindow, body, "insertFromPaste");
      await sleep(160);
      bodyInserted = Boolean(normalizeText(body.textContent || "") || body.querySelector("img"));
    }

    let imageInsertedCount = 0;

    for (let index = 0; index < images.length; index += 1) {
      const image = images[index];
      const dataUrl = String(image?.dataUrl || image?.src || "").trim();

      if (!/^data:image\//i.test(dataUrl)) {
        continue;
      }

      if (await pasteImage(body, frameDocument, frameWindow, dataUrl, image?.fileName || `blogger-image-${index + 1}.png`)) {
        imageInsertedCount += 1;
      }
    }

    let tagInsertedCount = 0;
    const labelInput = document.querySelector(
      "textarea[aria-label='쉼표로 라벨을 구분하세요.'], textarea[aria-label*='라벨'], input[aria-label*='라벨'], textarea[aria-label='Separate labels by commas' i], textarea[aria-label='Labels' i], input[aria-label='Labels' i], textarea[aria-label*='ラベル'], input[aria-label*='ラベル'], textarea[aria-label*='Etiquetas' i], input[aria-label='Etiquetas' i]"
    );

    if (tags.length && labelInput) {
      const value = tags.join(", ");
      labelInput.focus();
      setNativeValue(labelInput, value);
      labelInput.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        composed: true,
        data: value,
        inputType: "insertText",
      }));
      labelInput.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      labelInput.blur();
      await sleep(100);
      tagInsertedCount = String(labelInput.value || "").trim() ? tags.length : 0;
    }

    return {
      ok: Boolean(titleInserted || bodyInserted || imageInsertedCount),
      platform: "blogger",
      titleInserted,
      bodyInserted,
      tagRequestedCount: tags.length,
      tagInsertedCount,
      imageRequestedCount: images.length,
      imageInsertedCount,
      frameUrl: location.href,
    };
  } catch (error) {
    return { ok: false, error: error.message || String(error), platform: "blogger" };
  }

  function setNativeValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value")
      || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
      || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");

    if (descriptor?.set) {
      descriptor.set.call(element, value);
      return;
    }

    element.value = value;
  }

  async function waitForStableEditorBody(timeoutMs = 15000) {
    const startedAt = Date.now();
    let lastFrame = null;
    let stableSince = 0;

    while (Date.now() - startedAt < timeoutMs) {
      const frame = Array.from(document.querySelectorAll("iframe.editable, iframe[id^='nsoPic']"))
        .find((candidate) => {
          try {
            const candidateBody = candidate.contentDocument?.body;
            return Boolean(
              candidate.isConnected
              && candidateBody?.isConnected
              && candidateBody.getAttribute("contenteditable") !== null
            );
          } catch {
            return false;
          }
        }) || null;

      if (!frame) {
        lastFrame = null;
        stableSince = 0;
        await sleep(150);
        continue;
      }

      if (frame !== lastFrame) {
        lastFrame = frame;
        stableSince = Date.now();
        await sleep(180);
        continue;
      }

      if (Date.now() - stableSince < 450) {
        await sleep(120);
        continue;
      }

      try {
        const frameDocument = frame.contentDocument;
        const frameWindow = frame.contentWindow;
        const body = frameDocument?.body;

        if (frameDocument && frameWindow && body?.isConnected) {
          return { frame, frameDocument, frameWindow, body };
        }
      } catch {
        lastFrame = null;
        stableSince = 0;
      }

      await sleep(150);
    }

    return null;
  }

  function sanitizeHtml(html) {
    const template = document.createElement("template");
    template.innerHTML = String(html || "");
    template.content.querySelectorAll("script, style, iframe, object, embed").forEach((node) => node.remove());

    for (const strike of Array.from(template.content.querySelectorAll("strike, s, del"))) {
      strike.replaceWith(...Array.from(strike.childNodes));
    }

    for (const element of Array.from(template.content.querySelectorAll("*"))) {
      for (const attribute of Array.from(element.attributes)) {
        if (/^on/i.test(attribute.name)) {
          element.removeAttribute(attribute.name);
        }
      }

      if (/line-through/i.test(element.style?.textDecoration || element.style?.textDecorationLine || "")) {
        element.style.removeProperty("text-decoration");
        element.style.removeProperty("text-decoration-line");
      }
    }

    return template.innerHTML.trim();
  }

  function textToHtml(text) {
    return String(text || "")
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
      .join("");
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>\"]/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '\"': "&quot;",
    }[character]));
  }

  function normalizeText(value) {
    return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  function dispatchEditorInput(frameWindow, element, inputType) {
    try {
      element.dispatchEvent(new frameWindow.InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType,
      }));
    } catch {
      element.dispatchEvent(new frameWindow.Event("input", { bubbles: true }));
    }

    element.dispatchEvent(new frameWindow.Event("change", { bubbles: true }));
  }

  async function pasteImage(body, frameDocument, frameWindow, dataUrl, fileName) {
    const beforeCount = body.querySelectorAll("img").length;
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const extension = String(blob.type || "image/png").split("/")[1]?.replace("jpeg", "jpg") || "png";
    const safeName = /\.[a-z0-9]+$/i.test(fileName) ? fileName : `${fileName}.${extension}`;
    const file = new File([blob], safeName, { type: blob.type || "image/png" });
    const selection = frameWindow.getSelection?.();
    const range = frameDocument.createRange();
    range.selectNodeContents(body);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    body.focus();

    try {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      body.dispatchEvent(new frameWindow.ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }));
      await sleep(900);
    } catch {
      // 아래 data URL 이미지 폴백을 사용합니다.
    }

    if (body.querySelectorAll("img").length <= beforeCount) {
      const paragraph = frameDocument.createElement("p");
      const image = frameDocument.createElement("img");
      image.src = dataUrl;
      image.alt = fileName;
      image.style.maxWidth = "100%";
      paragraph.appendChild(image);
      body.appendChild(paragraph);
      dispatchEditorInput(frameWindow, body, "insertFromPaste");
      await sleep(120);
    }

    return body.querySelectorAll("img").length > beforeCount;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

async function insertPostTagsIntoNaverEditor(tabId, tags) {
  const detections = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: detectNaverPublishTagFrame,
  });

  const candidates = detections
    .map((entry) => ({ frameId: entry.frameId, result: entry.result }))
    .filter((entry) => entry.result?.publishButtonFound || entry.result?.tagAreaFound || entry.result?.tagInputFound)
    .sort((left, right) => right.result.score - left.result.score);
  const target = candidates[0] || null;
  const tagResults = await chrome.scripting.executeScript({
    target: target?.frameId != null ? { tabId, frameIds: [target.frameId] } : { tabId, allFrames: true },
    func: insertNaverBlogTags,
    args: [tags],
  });
  const bestResult = tagResults
    .map((entry) => ({ frameId: entry.frameId, result: entry.result || {} }))
    .sort((left, right) => Number(right.result?.insertedCount || 0) - Number(left.result?.insertedCount || 0))[0] || null;
  const insertedCount = tagResults
    .map((entry) => Number(entry.result?.insertedCount || 0))
    .reduce((maxValue, value) => Math.max(maxValue, value), 0);

  await appendBackgroundDebugLog(insertedCount > 0 ? "naver.insert.tags.completed" : "naver.insert.tags.missed", {
    tabId,
    detectedCandidateCount: candidates.length,
    selectedFrameId: target?.frameId ?? null,
    selectedFrameUrl: summarizeUrlForLog(target?.result?.href || bestResult?.result?.frameUrl || ""),
    insertedCount,
    requestedCount: Array.isArray(tags) ? tags.length : 0,
    publishButtonFound: Boolean(target?.result?.publishButtonFound),
    tagAreaFound: Boolean(target?.result?.tagAreaFound),
    tagInputFound: Boolean(target?.result?.tagInputFound),
    tagError: bestResult?.result?.error || "",
    diagnostics: bestResult?.result?.diagnostics || null,
  }).catch(() => {});

  return insertedCount;
}

async function resolveTargetNaverTabId(requestedTabId) {
  if (requestedTabId) {
    const requestedTab = await getTabSafely(requestedTabId);
    if (requestedTab?.id && isNaverBlogUrl(requestedTab.url || "")) {
      await updateSession({ naverTabId: requestedTab.id });
      return requestedTab.id;
    }
  }

  const session = await getSession();
  const storedTab = session.naverTabId ? await getTabSafely(session.naverTabId) : null;

  if (storedTab?.id && isNaverBlogUrl(storedTab.url || "")) {
    return storedTab.id;
  }

  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  if (activeTab?.id && isNaverBlogUrl(activeTab.url || "")) {
    await updateSession({ naverTabId: activeTab.id });
    return activeTab.id;
  }

  throw new Error("지원되는 네이버 블로그·카페·티스토리 또는 Google Blogger 글쓰기 탭이 연결되어 있지 않습니다. 작성 페이지를 열고 확장을 다시 실행해 주세요.");
}

function detectNaverEditorFrame() {
  const title = findTitleCandidate();
  const body = findBodyCandidate();
  let score = 0;

  if (title) {
    score += 30;
  }
  if (body) {
    score += 90 + body.score;
  }
  if (/blog|editor|naver/i.test(location.href)) {
    score += 10;
  }
  if (document.querySelector("[class*='se-'], [id*='se_'], [class*='SmartEditor']")) {
    score += 20;
  }

  return {
    score,
    titleFound: Boolean(title),
    bodyFound: Boolean(body),
    href: location.href,
  };

  function findTitleCandidate() {
    const selectors = [
      ".se-component.se-documentTitle[data-a11y-title='제목'] .se-title-text",
      ".se-component.se-documentTitle[data-a11y-title='제목'] .se-section-documentTitle",
      ".se-component.se-documentTitle[data-a11y-title='제목']",
      "[data-a11y-title='제목'] .se-title-text",
      "[data-a11y-title='제목'] .se-section-documentTitle",
      "[data-a11y-title='제목']",
      "textarea[placeholder*='제목']",
      "input[placeholder*='제목']",
      "[contenteditable='true'][aria-label*='제목']",
      "[contenteditable='true'][data-placeholder*='제목']",
      ".se-title [contenteditable='true']",
      ".se-title-text [contenteditable='true']",
      "[class*='title'] [contenteditable='true']",
    ];

    return collectElements(selectors).find(isVisible) || null;
  }

  function findBodyCandidate() {
    const selectors = [
      ".se-component.se-text[data-a11y-title='본문'] [contenteditable='true'][role='textbox']",
      ".se-component[data-a11y-title='본문'] [contenteditable='true'][role='textbox']",
      ".se-component.se-text[data-a11y-title='본문'] [contenteditable='true']",
      ".se-component[data-a11y-title='본문'] [contenteditable='true']",
      ".se-main-container [contenteditable='true']",
      ".se-section-text [contenteditable='true']",
      ".se-text-paragraph[contenteditable='true']",
      ".se-component-content[contenteditable='true']",
      "[contenteditable='true'][role='textbox']",
      "[contenteditable='true']",
    ];

    const editableCandidate = collectElements(selectors)
      .filter(isVisible)
      .map((element) => ({ element, score: scoreBodyCandidate(element) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)[0] || null;

    if (editableCandidate) {
      return editableCandidate;
    }

    // 네이버 카페 SmartEditor는 실제 키 입력을 화면 밖의 버퍼에서 받기 때문에
    // 초기 빈 본문에는 visible contenteditable 요소가 없습니다. 이 경우 눈에 보이는
    // 본문 컴포넌트를 탐지 신호로 사용하고 실제 입력 대상은 삽입 단계에서 찾습니다.
    const structuralSelectors = [
      ".se-component.se-text[data-a11y-title='본문'] .se-module.se-module-text",
      ".se-component[data-a11y-title='본문'] .se-module.se-module-text",
      ".se-component.se-text[data-a11y-title='본문'] .se-section-text",
      ".se-component[data-a11y-title='본문'] .se-section-text",
      ".se-component.se-text[data-a11y-title='본문']",
      ".se-component[data-a11y-title='본문']",
      ".se-components-wrap",
    ];

    return collectElements(structuralSelectors)
      .filter(isVisible)
      .map((element) => ({ element, score: scoreBodyCandidate(element) + 40 }))
      .sort((left, right) => right.score - left.score)[0] || null;
  }

  function scoreBodyCandidate(element) {
    const label = `${element.getAttribute("aria-label") || ""} ${element.getAttribute("data-placeholder") || ""} ${element.getAttribute("data-a11y-title") || ""} ${element.className || ""} ${element.id || ""}`.toLowerCase();
    const rect = element.getBoundingClientRect();
    let score = 1;

    if (/제목|title/.test(label)) {
      score -= 100;
    }
    if (/본문|content|body|text|paragraph/.test(label)) {
      score += 35;
    }
    if (/se-|smarteditor|editor/.test(label)) {
      score += 30;
    }
    if (element.getAttribute("role") === "textbox") {
      score += 12;
    }
    if (rect.height > 80) {
      score += 12;
    }
    if (rect.width > 260) {
      score += 8;
    }

    return score;
  }

  function collectElements(selectors) {
    const seen = new Set();
    const elements = [];

    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!seen.has(element)) {
          seen.add(element);
          elements.push(element);
        }
      }
    }

    return elements;
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }
}

async function insertNaverBlogPost(payload) {
  try {
    // 1. 방해 모달 팝업 자동 해제 (임시저장 복구 취소, 도움말 닫기)
    dismissEditorPopups();

    const postPlan = buildPostInsertPlan(payload || {});
    const titleText = normalizeText(String(payload?.title || ""));
    const bodyEntry = findBodyCandidate();

    if (!bodyEntry?.element) {
      return { ok: false, error: "본문 입력 영역을 찾지 못했습니다." };
    }

    const bodyElement = bodyEntry.element;

    let titleInserted = false;
    let bodyInserted = false;
    let imageInsertedCount = 0;
    let pendingImageCommitCount = 0;
    let bodyTagInsertedCount = 0;
    const baseBlockSequence = Array.isArray(postPlan.blocks) && postPlan.blocks.length
      ? postPlan.blocks
      : [{ type: "html", html: postPlan.contentHtml, images: [] }];
    const bodyHashtagPlan = attachBodyHashtagsToBlocks(baseBlockSequence, payload?.bodyTags);
    const blockSequence = bodyHashtagPlan.blocks;
    const bodyMode = postPlan.images.length
      ? (blockSequence.length > 2 ? "sequenced_blocks" : "html_then_images")
      : "html";
    let bodyEditorActivated = false;

    const ensureBodyEditorActivated = async () => {
      if (bodyEditorActivated || !bodyElement) {
        return bodyEditorActivated;
      }

      bodyEditorActivated = await activateBodyEditor(bodyElement);

      if (bodyEditorActivated) {
        await ensureStrikethroughDisabled(bodyElement);
        bodyEditorActivated = await activateBodyEditor(bodyElement);
      }

      return bodyEditorActivated;
    };

    // 카페 제목은 본문 SmartEditor 바깥의 Vue textarea입니다. 본문 입력 후에는
    // SmartEditor의 숨은 입력 버퍼가 포커스를 되가져갈 수 있으므로 제목을 먼저 넣습니다.
    if (titleText) {
      const titleCandidate = findTitleCandidate();

      if (titleCandidate) {
        titleInserted = await insertNaverBlogTitle(titleCandidate, titleText);
      }
    }

    for (const block of blockSequence) {
      if (block?.type === "html") {
        const blockHtml = String(block.html || "").trim();

        if (!blockHtml) {
          continue;
        }

        await ensureBodyEditorActivated();
        const htmlToInsert = protectInlineNoBreaks(blockHtml);
        let htmlInserted = await insertHtmlIntoEditor(
          bodyElement,
          htmlToInsert,
          htmlToPlainText(htmlToInsert)
        );

        if (!htmlInserted && pendingImageCommitCount > 0) {
          const retrySnapshot = getElementSnapshot(bodyElement);
          const imageCommitted = await waitForEditorChange(bodyElement, retrySnapshot, {
            timeoutMs: 2500,
            pollMs: 150,
          });

          if (imageCommitted) {
            htmlInserted = await insertHtmlIntoEditor(
              bodyElement,
              htmlToInsert,
              htmlToPlainText(htmlToInsert)
            );
          }
        }

        pendingImageCommitCount = 0;
        bodyInserted = bodyInserted || htmlInserted;
        if (htmlInserted && block?.containsBodyHashtags) {
          bodyTagInsertedCount = bodyHashtagPlan.count;
        }
        continue;
      }

      if (block?.type === "images") {
        const blockImages = Array.isArray(block.images) ? block.images : [];

        if (!blockImages.length) {
          continue;
        }

        await ensureBodyEditorActivated();
        const imageInsertResult = await insertImagesIntoEditor(bodyElement, blockImages);
        imageInsertedCount += imageInsertResult.insertedCount;
        pendingImageCommitCount += imageInsertResult.pendingCount;
        bodyInserted = bodyInserted || imageInsertResult.insertedCount > 0;
      }
    }

    await removeGeneratedStrikethrough(bodyElement);

    bodyInserted = bodyInserted || imageInsertedCount > 0;

    return {
      ok: Boolean(titleInserted || bodyInserted),
      titleInserted,
      bodyInserted: Boolean(bodyInserted),
      bodyMode,
      imageRequestedCount: postPlan.images.length,
      imageInsertedCount,
      bodyTagInsertedCount,
      frameUrl: location.href,
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }

  function attachBodyHashtagsToBlocks(blocks, tags) {
    const hashtags = Array.isArray(tags)
      ? Array.from(new Set(tags.map(tag => String(tag || '').trim().replace(/^#+/, '').replace(/\s+/g, '')).filter(Boolean)))
      : [];
    const nextBlocks = Array.isArray(blocks) ? blocks.map(block => ({ ...block })) : [];
    if (!hashtags.length) return { blocks: nextBlocks, count: 0 };

    const line = hashtags.map(tag => '#' + tag).join(' ');
    const hashtagHtml = '<p><br></p><p>' + escapeHtml(line) + '</p>';
    const lastIndex = nextBlocks.length - 1;

    if (lastIndex >= 0 && nextBlocks[lastIndex]?.type === 'html') {
      nextBlocks[lastIndex] = {
        ...nextBlocks[lastIndex],
        html: String(nextBlocks[lastIndex].html || '') + hashtagHtml,
        containsBodyHashtags: true,
      };
    } else {
      nextBlocks.push({ type: 'html', html: hashtagHtml, images: [], containsBodyHashtags: true });
    }

    return { blocks: nextBlocks, count: hashtags.length };
  }

  function dismissEditorPopups() {
    try {
      const cancelButtons = Array.from(document.querySelectorAll("button, a, .se-popup-button")).filter((el) => {
        const text = (el.innerText || el.textContent || "").trim();
        return /취소|작성취소|새로작성/i.test(text);
      });
      for (const btn of cancelButtons) {
        if (isVisible(btn)) {
          btn.click();
        }
      }

      const closeButtons = Array.from(document.querySelectorAll(".se-help-panel-close-button, .se-popup-close-button, button[aria-label*='닫기'], .btn_close")).filter(isVisible);
      for (const btn of closeButtons) {
        btn.click();
      }
    } catch {}
  }

  function findTitleCandidate() {
    const selectors = [
      ".se-component.se-documentTitle[data-a11y-title='제목'] .se-title-text",
      ".se-component.se-documentTitle[data-a11y-title='제목'] .se-section-documentTitle",
      ".se-component.se-documentTitle[data-a11y-title='제목']",
      "[data-a11y-title='제목'] .se-title-text",
      "[data-a11y-title='제목'] .se-section-documentTitle",
      "[data-a11y-title='제목']",
      "textarea[placeholder*='제목']",
      "input[placeholder*='제목']",
      "[contenteditable='true'][aria-label*='제목']",
      "[contenteditable='true'][data-placeholder*='제목']",
      ".se-title [contenteditable='true']",
      ".se-title-text [contenteditable='true']",
      "[class*='title'] [contenteditable='true']",
    ];

    return collectElements(selectors).find(isVisible) || null;
  }

  function findBodyCandidate() {
    const smartEditorHiddenBuffer = findSmartEditorHiddenTypingBuffer();
    const tailEditable = resolveTailBodyEditable(smartEditorHiddenBuffer, { includeHiddenBuffer: false });

    if (tailEditable) {
      attachTypingBridge(tailEditable, smartEditorHiddenBuffer);
      return {
        element: tailEditable,
        score: scoreBodyCandidate(tailEditable) + 280,
      };
    }

    const liveEditable = resolveLiveBodyEditable(
      resolveSelectionEditableHost() || document.activeElement || smartEditorHiddenBuffer,
      { includeHiddenBuffer: false }
    );

    if (liveEditable) {
      attachTypingBridge(liveEditable, smartEditorHiddenBuffer);
      return {
        element: liveEditable,
        score: scoreBodyCandidate(liveEditable) + 260,
      };
    }

    const selectors = [
      ".se-component.se-text[data-a11y-title='본문'] [contenteditable='true'][role='textbox']",
      ".se-component[data-a11y-title='본문'] [contenteditable='true'][role='textbox']",
      ".se-component.se-text[data-a11y-title='본문'] [contenteditable='true']",
      ".se-component[data-a11y-title='본문'] [contenteditable='true']",
      ".se-main-container [contenteditable='true']",
      ".se-section-text [contenteditable='true']",
      ".se-text-paragraph[contenteditable='true']",
      ".se-component-content[contenteditable='true']",
      "[contenteditable='true'][role='textbox']",
      "[contenteditable='true']",
    ];
    const visibleEditable = collectElements(selectors)
      .filter(isVisible)
      .map((element) => ({ element, score: scoreBodyCandidate(element) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)[0] || null;

    if (visibleEditable?.element) {
      attachTypingBridge(visibleEditable.element, smartEditorHiddenBuffer);
      return {
        element: visibleEditable.element,
        score: visibleEditable.score + 200,
      };
    }

    if (smartEditorHiddenBuffer) {
      return {
        element: smartEditorHiddenBuffer,
        score: scoreBodyCandidate(smartEditorHiddenBuffer) + 220,
      };
    }

    return null;
  }

  function findSmartEditorHiddenTypingBuffer() {
    const selectors = [
      ".se-main-container [contenteditable='true'][aria-hidden='true'][allow*='clipboard-read']",
      "[contenteditable='true'][aria-hidden='true'][allow*='clipboard-read']",
      ".se-main-container [contenteditable='true'][aria-hidden='true']",
    ];

    return collectElements(selectors).find(isSmartEditorHiddenTypingBuffer) || null;
  }

  function resolveBodyEditorRoot(element) {
    return element?.closest?.(
      ".se-component.se-text[data-a11y-title='본문'], .se-component[data-a11y-title='본문'], .se-main-container, rich-textarea"
    ) || document.querySelector(
      ".se-component.se-text[data-a11y-title='본문'], .se-component[data-a11y-title='본문'], .se-main-container, rich-textarea"
    ) || null;
  }

  function resolveSelectionEditableHost() {
    const selection = getSelection();
    const anchorNode = selection?.anchorNode
      || (selection?.rangeCount ? selection.getRangeAt(0).startContainer : null)
      || null;
    const anchorElement = anchorNode?.nodeType === Node.ELEMENT_NODE
      ? anchorNode
      : anchorNode?.parentElement || null;

    return anchorElement?.closest?.(
      "input, textarea, [role='textbox'], [contenteditable='true'], [contenteditable=''], [contenteditable]:not([contenteditable='false'])"
    ) || null;
  }

  function isTitleScopeElement(element) {
    return Boolean(element?.closest?.(".se-component.se-documentTitle, [data-a11y-title='제목']"));
  }

  function isBodyEditableCandidate(element, editorRoot) {
    if (!isEditableTypingElement(element) || isTitleScopeElement(element)) {
      return false;
    }

    if (
      editorRoot
      && element !== editorRoot
      && !editorRoot.contains?.(element)
      && !element.contains?.(editorRoot)
    ) {
      return false;
    }

    return Boolean(element.closest?.(
      ".se-main-container, .se-component.se-text[data-a11y-title='본문'], .se-component[data-a11y-title='본문'], .se-section, .se-module, rich-textarea"
    ));
  }

  function resolveLiveBodyEditable(element, options = {}) {
    const { includeHiddenBuffer = false } = options;
    const editorRoot = resolveBodyEditorRoot(element);
    const candidates = [
      resolveSelectionEditableHost(),
      document.activeElement,
      element,
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (!isBodyEditableCandidate(candidate, editorRoot)) {
        continue;
      }

      if (!includeHiddenBuffer && isSmartEditorHiddenTypingBuffer(candidate)) {
        continue;
      }

      return candidate;
    }

    return null;
  }

  function resolveTailBodyEditable(element, options = {}) {
    const { includeHiddenBuffer = false } = options;
    const editorRoot = resolveBodyEditorRoot(element);
    const queryRoot = editorRoot?.querySelectorAll ? editorRoot : document;
    const candidates = Array.from(queryRoot.querySelectorAll(
      ".se-module.se-module-text.__se-unit, .se-module.se-module-text, [role='textbox'], [contenteditable='true'], [contenteditable=''], [contenteditable]:not([contenteditable='false'])"
    ))
      .filter((candidate) => isBodyEditableCandidate(candidate, editorRoot))
      .filter((candidate) => includeHiddenBuffer || !isSmartEditorHiddenTypingBuffer(candidate));

    const visibleCandidates = candidates.filter((candidate) => isVisible(candidate));
    return visibleCandidates[visibleCandidates.length - 1]
      || candidates[candidates.length - 1]
      || null;
  }

  function resolveStructuredBodyEditable(element) {
    if (!element) {
      return null;
    }

    if (isEditableTypingElement(element) && !isSmartEditorHiddenTypingBuffer(element)) {
      return element;
    }

    if (element.matches?.(".se-module.se-module-text, .se-module.se-module-text.__se-unit")) {
      return element;
    }

    const section = element.matches?.(".se-section.se-section-text")
      ? element
      : element.querySelector?.(".se-section.se-section-text");

    if (section) {
      return section.querySelector?.(
        ".se-module.se-module-text.__se-unit, .se-module.se-module-text, [role='textbox'], [contenteditable='true'], [contenteditable=''], [contenteditable]:not([contenteditable='false'])"
      ) || section;
    }

    return element;
  }

  function attachTypingBridge(surfaceElement, typingTarget) {
    if (!surfaceElement) {
      return;
    }

    surfaceElement.__nbTypingActivator = surfaceElement;
    surfaceElement.__nbTypingTarget = typingTarget || null;
  }

  function scoreBodyCandidate(element) {
    const label = `${element.getAttribute("aria-label") || ""} ${element.getAttribute("data-placeholder") || ""} ${element.getAttribute("data-a11y-title") || ""} ${element.className || ""} ${element.id || ""}`.toLowerCase();
    const rect = element.getBoundingClientRect();
    let score = 1;

    if (/제목|title/.test(label)) {
      score -= 100;
    }
    if (/본문|content|body|text|paragraph/.test(label)) {
      score += 35;
    }
    if (/se-|smarteditor|editor/.test(label)) {
      score += 30;
    }
    if (element.getAttribute("role") === "textbox") {
      score += 12;
    }
    if (rect.height > 80) {
      score += 12;
    }
    if (rect.width > 260) {
      score += 8;
    }

    return score;
  }

  function splitHtmlIntoHumanLikeBlocks(html) {
    const template = document.createElement("template");
    template.innerHTML = protectInlineNoBreaks(String(html || "").trim());

    const normalizedNodes = [];

    for (const node of Array.from(template.content.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        const textHtml = textToHtml(String(node.textContent || "").trim());

        if (!textHtml) {
          continue;
        }

        const textTemplate = document.createElement("template");
        textTemplate.innerHTML = textHtml;
        normalizedNodes.push(...Array.from(textTemplate.content.childNodes));
        continue;
      }

      if (node.nodeType === Node.ELEMENT_NODE) {
        normalizedNodes.push(node.cloneNode(true));
      }
    }

    const htmlBlocks = [];
    let currentNodes = [];
    let currentTextLength = 0;

    const flushCurrentNodes = () => {
      if (!currentNodes.length) {
        return;
      }

      const blockHtml = buildChunkHtml(currentNodes);
      if (blockHtml) {
        htmlBlocks.push(blockHtml);
      }

      currentNodes = [];
      currentTextLength = 0;
    };

    for (const node of normalizedNodes) {
      const nodeHtml = buildChunkHtml([node]);

      if (!nodeHtml) {
        continue;
      }

      const nodeTextLength = normalizeTypingText(htmlToPlainText(nodeHtml)).length;
      const tagName = node.nodeType === Node.ELEMENT_NODE
        ? String(node.tagName || "").toUpperCase()
        : "";
      const isStandaloneBlock = ["UL", "OL", "TABLE", "BLOCKQUOTE"].includes(tagName);
      const shouldFlushBefore = currentNodes.length
        && (currentNodes.length >= 3 || currentTextLength >= 260 || isStandaloneBlock);

      if (shouldFlushBefore) {
        flushCurrentNodes();
      }

      currentNodes.push(node);
      currentTextLength += nodeTextLength;

      if (currentNodes.length >= 3 || currentTextLength >= 260 || isStandaloneBlock) {
        flushCurrentNodes();
      }
    }

    flushCurrentNodes();
    return htmlBlocks;
  }

  function getHumanLikeBlockDelay(block) {
    const plainText = htmlToPlainText(block?.html || "");
    const textLength = normalizeTypingText(plainText).length;

    if (!textLength) {
      return 180 + Math.floor(Math.random() * 120);
    }

    if (textLength > 240) {
      return 700 + Math.floor(Math.random() * 280);
    }

    if (textLength > 120) {
      return 520 + Math.floor(Math.random() * 220);
    }

    return 320 + Math.floor(Math.random() * 180);
  }

  function protectInlineNoBreaks(html) {
    const template = document.createElement("template");
    template.innerHTML = String(html || "").trim();

    // 자동 생성 원고에는 취소선을 사용하지 않습니다. 이미지 없는 전체 HTML 붙여넣기
    // 경로에서도 SmartEditor가 line-through 상태를 이어받지 않도록 방어적으로 제거합니다.
    for (const strikeElement of Array.from(template.content.querySelectorAll("s, strike, del"))) {
      strikeElement.replaceWith(...Array.from(strikeElement.childNodes));
    }

    for (const styledElement of Array.from(template.content.querySelectorAll("[style]"))) {
      if (/line-through/i.test(styledElement.style.textDecoration || styledElement.style.textDecorationLine || "")) {
        styledElement.style.removeProperty("text-decoration");
        styledElement.style.removeProperty("text-decoration-line");

        if (!String(styledElement.getAttribute("style") || "").trim()) {
          styledElement.removeAttribute("style");
        }
      }
    }

    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
    const textNodes = [];

    while (walker.nextNode()) {
      textNodes.push(walker.currentNode);
    }

    for (const textNode of textNodes) {
      const originalText = String(textNode.textContent || "");
      const nextText = originalText.replace(/(\d)\.(\d)/g, `$1.\u2060$2`);

      if (nextText !== originalText) {
        textNode.textContent = nextText;
      }
    }

    return template.innerHTML.trim();
  }

  async function typeHtmlIntoStructuredBody(element, html) {
    const typingBlocks = buildStructuredBodyTypingBlocks(html);

    if (!element || !typingBlocks.length) {
      return { inserted: false, blockCount: 0 };
    }

    focusEditableTypingTarget(element);
    const before = getEditableTypingSnapshot(element);
    let blockCount = 0;
    let pendingBreaks = readEditableTypingText(element) ? 1 : 0;

    for (let index = 0; index < typingBlocks.length; index += 1) {
      const block = typingBlocks[index];

      if (!block.text) {
        pendingBreaks += 1;
        continue;
      }

      for (let breakIndex = 0; breakIndex < pendingBreaks; breakIndex += 1) {
        insertStructuredBlockBoundary(element);
        await sleep(80 + Math.floor(Math.random() * 40));
      }

      pendingBreaks = 1;

      const typed = await typeStructuredTypingBlock(element, block);
      if (typed) {
        blockCount += 1;

        if (blockCount === 1) {
          const firstBlockVisible = await waitForEditorChange(element, before, 2200);

          if (!firstBlockVisible) {
            return {
              inserted: false,
              blockCount: 0,
            };
          }
        }
      }

      if (index < typingBlocks.length - 1) {
        await sleep(90 + Math.floor(Math.random() * 50));
      }
    }

    element.dispatchEvent(new Event("change", { bubbles: true }));

    return {
      inserted: getEditableTypingSnapshot(element) !== before && blockCount > 0,
      blockCount,
    };
  }

  function buildStructuredBodyTypingBlocks(html) {
    const template = document.createElement("template");
    template.innerHTML = String(html || "").trim();
    const blocks = [];
    const orderedListState = { index: 1 };

    for (const node of Array.from(template.content.childNodes)) {
      appendStructuredTypingBlocksFromNode(node, blocks, orderedListState);
    }

    while (blocks.length && !blocks[0].text) {
      blocks.shift();
    }

    while (blocks.length && !blocks[blocks.length - 1].text) {
      blocks.pop();
    }

    return blocks;
  }

  function appendStructuredTypingBlocksFromNode(node, blocks, orderedListState) {
    if (!node) {
      return;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      pushStructuredTypingBlockRuns(parseStructuredInlineRuns(node), blocks, { type: "paragraph" });
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const tagName = String(node.tagName || "").toUpperCase();

    if (tagName === "BR") {
      blocks.push(createStructuredTypingBlock("paragraph", [], {}));
      return;
    }

    if (tagName === "UL") {
      for (const item of Array.from(node.children).filter((child) => child.tagName === "LI")) {
        pushStructuredTypingBlockRuns(parseStructuredInlineRuns(item), blocks, {
          type: "paragraph",
          prefix: "• ",
        });
      }
      return;
    }

    if (tagName === "OL") {
      for (const item of Array.from(node.children).filter((child) => child.tagName === "LI")) {
        pushStructuredTypingBlockRuns(parseStructuredInlineRuns(item), blocks, {
          type: "paragraph",
          prefix: `${orderedListState.index}. `,
        });
        orderedListState.index += 1;
      }
      return;
    }

    if (/^H[1-6]$/.test(tagName)) {
      pushStructuredTypingBlockRuns(parseStructuredInlineRuns(node), blocks, {
        type: "heading",
        level: Number(tagName.slice(1)) || 2,
      });
      return;
    }

    if (tagName === "BLOCKQUOTE") {
      pushStructuredTypingBlockRuns(parseStructuredInlineRuns(node), blocks, { type: "blockquote" });
      return;
    }

    if (tagName === "P" || tagName === "LI") {
      pushStructuredTypingBlockRuns(parseStructuredInlineRuns(node), blocks, { type: "paragraph" });
      return;
    }

    if (hasStructuredBlockChildren(node)) {
      for (const child of Array.from(node.childNodes)) {
        appendStructuredTypingBlocksFromNode(child, blocks, orderedListState);
      }
      return;
    }

    pushStructuredTypingBlockRuns(parseStructuredInlineRuns(node), blocks, { type: "paragraph" });
  }

  function parseStructuredInlineRuns(node, formats = {}) {
    if (!node) {
      return [];
    }

    if (node.nodeType === Node.TEXT_NODE) {
      const text = normalizeStructuredInlineText(node.textContent || "");
      return text ? [{ type: "text", text, formats: { ...formats } }] : [];
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return [];
    }

    const tagName = String(node.tagName || "").toUpperCase();

    if (tagName === "BR") {
      return [{ type: "break" }];
    }

    const nextFormats = { ...formats };

    if (tagName === "B" || tagName === "STRONG") {
      nextFormats.bold = true;
    }
    if (tagName === "I" || tagName === "EM") {
      nextFormats.italic = true;
    }
    if (tagName === "U") {
      nextFormats.underline = true;
    }
    if (tagName === "S" || tagName === "STRIKE" || tagName === "DEL") {
      nextFormats.strike = true;
    }

    return Array.from(node.childNodes).flatMap((child) => parseStructuredInlineRuns(child, nextFormats));
  }

  function pushStructuredTypingBlockRuns(runs, blocks, options = {}) {
    const lines = splitStructuredRunsIntoLines(runs);

    if (!lines.length) {
      blocks.push(createStructuredTypingBlock(options.type || "paragraph", [], options));
      return;
    }

    for (let index = 0; index < lines.length; index += 1) {
      const lineRuns = mergeStructuredTypingRuns(lines[index]);
      const prefix = index === 0 ? options.prefix || "" : "";
      blocks.push(createStructuredTypingBlock(options.type || "paragraph", lineRuns, {
        ...options,
        prefix,
      }));
    }
  }

  function splitStructuredRunsIntoLines(runs) {
    const lines = [[]];

    for (const run of Array.isArray(runs) ? runs : []) {
      if (!run) {
        continue;
      }

      if (run.type === "break") {
        lines.push([]);
        continue;
      }

      lines[lines.length - 1].push(run);
    }

    return lines;
  }

  function mergeStructuredTypingRuns(runs) {
    const mergedRuns = [];

    for (const run of Array.isArray(runs) ? runs : []) {
      if (!run?.text) {
        continue;
      }

      const lastRun = mergedRuns[mergedRuns.length - 1];

      if (lastRun && areStructuredFormatsEqual(lastRun.formats, run.formats)) {
        lastRun.text += run.text;
        continue;
      }

      mergedRuns.push({ text: run.text, formats: { ...(run.formats || {}) } });
    }

    return mergedRuns;
  }

  function createStructuredTypingBlock(type, runs, options = {}) {
    const prefix = String(options.prefix || "");
    const text = `${prefix}${runs.map((run) => run.text).join("")}`;

    return {
      type,
      level: Number.isFinite(Number(options.level)) ? Number(options.level) : null,
      prefix,
      runs,
      text: normalizeTypingText(text),
    };
  }

  function hasStructuredBlockChildren(node) {
    return Array.from(node.childNodes).some((child) => {
      if (child.nodeType !== Node.ELEMENT_NODE) {
        return false;
      }

      const tagName = String(child.tagName || "").toUpperCase();
      return tagName === "BR"
        || tagName === "P"
        || tagName === "UL"
        || tagName === "OL"
        || tagName === "LI"
        || tagName === "BLOCKQUOTE"
        || /^H[1-6]$/.test(tagName);
    });
  }

  function normalizeStructuredInlineText(value) {
    return String(value || "")
      .replace(/\r\n/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/[\t\f\v ]+/g, " ");
  }

  function areStructuredFormatsEqual(left, right) {
    return Boolean(left?.bold) === Boolean(right?.bold)
      && Boolean(left?.italic) === Boolean(right?.italic)
      && Boolean(left?.underline) === Boolean(right?.underline)
      && Boolean(left?.strike) === Boolean(right?.strike);
  }

  async function typeStructuredTypingBlock(element, block) {
    focusEditableTypingTarget(element);
    applyStructuredBlockFormat(element, block);
    const baseFormats = getStructuredBlockBaseFormats(block);

    if (block.prefix) {
      await typeStructuredTypingRun(element, { text: block.prefix, formats: { ...baseFormats } }, block.text.length);
    }

    for (const run of block.runs) {
      await typeStructuredTypingRun(element, {
        ...run,
        formats: {
          ...baseFormats,
          ...(run.formats || {}),
        },
      }, block.text.length);
    }

    syncStructuredInlineFormats(element, {});
    return Boolean(block.text);
  }

  function getStructuredBlockBaseFormats(block) {
    if (block?.type === "heading") {
      return { bold: true };
    }

    if (block?.type === "blockquote") {
      return { bold: true };
    }

    return {};
  }

  async function typeStructuredTypingRun(element, run, totalLength) {
    if (!run?.text) {
      return;
    }

    syncStructuredInlineFormats(element, run.formats || {});

    for (const chunk of buildTypingChunks(run.text)) {
      insertTypingChunk(element, chunk);
      await sleep(getTypingDelay(chunk, totalLength));
    }
  }

  function applyStructuredBlockFormat(element, block) {
    execStructuredCommand(element, "formatBlock", resolveStructuredBlockTag(block));
  }

  function resolveStructuredBlockTag(block) {
    return "p";
  }

  function insertStructuredBlockBoundary(element) {
    insertTypingChunk(element, "\n");
  }

  function syncStructuredInlineFormats(element, formats = {}) {
    const commands = [
      ["bold", "bold"],
      ["italic", "italic"],
      ["underline", "underline"],
      ["strike", "strikeThrough"],
    ];

    for (const [formatKey, command] of commands) {
      const desired = Boolean(formats[formatKey]);
      const current = queryStructuredCommandState(command);

      if (current !== desired) {
        execStructuredCommand(element, command);
      }
    }
  }

  function queryStructuredCommandState(command) {
    try {
      return Boolean(document.queryCommandState(command));
    } catch {
      return false;
    }
  }

  function execStructuredCommand(element, command, value) {
    try {
      focusEditableTypingTarget(element);
      return document.execCommand(command, false, value);
    } catch {
      return false;
    }
  }

  function focusEditableTypingTarget(element) {
    const focusTarget = resolveTypingFocusTarget(element);

    if (!isSmartEditorHiddenTypingBuffer(focusTarget)) {
      focusTarget?.scrollIntoView?.({ block: "center", inline: "nearest" });
      focusTarget?.click?.();
    }

    focusTarget?.focus?.();

    const typingTarget = resolveTypingInputElement(element, focusTarget) || focusTarget;
    typingTarget?.focus?.();

    if (isEditableTypingElement(typingTarget)) {
      placeCaretAtEnd(typingTarget);
    }

    return typingTarget;
  }

  function getEditableTypingSnapshot(element) {
    return getElementSnapshot(element);
  }

  function readEditableTypingText(element) {
    if (!element) {
      return "";
    }

    const clone = element.cloneNode(true);
    clone.querySelectorAll?.(".se-placeholder, .__se_placeholder, .__se-toolbar-slot").forEach((node) => node.remove());
    return normalizeText(clone.innerText || clone.textContent || "");
  }

  function buildPostInsertPlan(source) {
    const images = Array.isArray(source.images)
      ? source.images
        .filter((image) => typeof image?.dataUrl === "string" && image.dataUrl.startsWith("data:image/"))
        .map((image, index) => ({
          dataUrl: image.dataUrl,
          fileName: buildImageFileName(source.title, index, image.dataUrl),
          alt: String(image.alt || "").trim(),
          slot: String(image.slot || "").trim(),
          placementHint: String(image.placementHint || image.placement_hint || "").trim(),
          headingHint: String(image.headingHint || image.heading_hint || "").trim(),
          sequence: Number.isFinite(Number(image.sequence)) ? Number(image.sequence) : index,
        }))
        .sort((left, right) => left.sequence - right.sequence)
      : [];
    const contentHtml = String(source.html || "").trim() || textToHtml(String(source.text || ""));
    const blocks = source.photoWriter === true
      ? buildPhotoWriterBlocks(contentHtml, images)
      : buildContentBlocks(contentHtml, images);

    return {
      contentHtml,
      images,
      blocks,
    };
  }

  function buildPhotoWriterBlocks(html, images) {
    const template = document.createElement('template');
    template.innerHTML = preparePhotoWriterHtmlForNaver(html);
    const blocks = [];
    let chunk = document.createElement('div');
    let imageIndex = 0;
    const flush = () => {
      if (chunk.innerHTML.trim()) blocks.push({ type: 'html', html: chunk.innerHTML });
      chunk = document.createElement('div');
    };
    for (const node of Array.from(template.content.childNodes)) {
      if (node.nodeType === Node.ELEMENT_NODE && node.hasAttribute('data-dd-photo-slot')) {
        if (node.getAttribute('data-dd-photo-slot') !== String(imageIndex) || !images[imageIndex]) throw new Error('사진 위치 정보가 일치하지 않습니다.');
        flush();
        blocks.push({ type: 'images', images: [images[imageIndex++]] });
      } else {
        chunk.appendChild(node.cloneNode(true));
      }
    }
    flush();
    if (imageIndex !== images.length) throw new Error('본문에 배치할 사진이 누락되었습니다.');
    return blocks;
  }

  function preparePhotoWriterHtmlForNaver(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html || '').trim();
    const content = template.content;

    // SmartEditor ONE은 웹용 margin과 일부 CSS를 제거합니다. 네이버가 안정적으로
    // 유지하는 글자/색/정렬 속성과 실제 빈 문단을 함께 사용해 읽는 리듬을 만듭니다.
    for (const heading of Array.from(content.querySelectorAll('h2, h3'))) {
      // 템플릿 강조색이 이미 지정한 배경/글자색(color, background-color 등)은 덮어쓰지 않고 그대로 둡니다.
      heading.style.setProperty('font-size', heading.tagName === 'H2' ? '22px' : '19px');
      heading.style.setProperty('font-weight', '700');
      heading.style.setProperty('line-height', '1.55');
      if (!heading.style.color) heading.style.setProperty('color', '#0f766e');
      if (!heading.style.backgroundColor && heading.tagName === 'H2') {
        heading.style.setProperty('background-color', '#f0fdfa');
        heading.style.setProperty('padding', '12px 16px');
        heading.style.setProperty('border-radius', '10px');
      }
      heading.style.setProperty('margin-top', '30px');
      heading.style.setProperty('margin-bottom', '14px');
    }

    for (const paragraph of Array.from(content.querySelectorAll('p'))) {
      if (paragraph.hasAttribute('data-dd-photo-slot')) continue;
      paragraph.style.setProperty('font-size', '16px');
      paragraph.style.setProperty('line-height', '1.9');
      paragraph.style.setProperty('color', '#334155');
      paragraph.style.setProperty('margin-bottom', '16px');
    }

    for (const caption of Array.from(content.querySelectorAll('figcaption'))) {
      caption.textContent = String(caption.textContent || '').replace(/^\s*📷\s*/, '').trim();
      caption.style.setProperty('font-size', '13px');
      caption.style.setProperty('line-height', '1.6');
      caption.style.setProperty('color', '#64748b');
      caption.style.setProperty('text-align', 'center');
      caption.style.setProperty('margin-top', '9px');
      caption.style.setProperty('margin-bottom', '12px');
    }

    for (const quote of Array.from(content.querySelectorAll('blockquote'))) {
      // 템플릿 강조색이 이미 지정한 배경/테두리/글자색은 덮어쓰지 않고 그대로 둡니다.
      quote.style.setProperty('font-size', '15px');
      quote.style.setProperty('line-height', '1.8');
      if (!quote.style.color) quote.style.setProperty('color', '#334155');
      if (!quote.style.backgroundColor) quote.style.setProperty('background-color', '#f0fdfa');
      if (!quote.style.borderLeft) quote.style.setProperty('border-left', '4px solid #14b8a6');
      if (!quote.style.padding) quote.style.setProperty('padding', '16px 18px');
      if (!quote.style.borderRadius) quote.style.setProperty('border-radius', '10px');
      quote.style.setProperty('margin-top', '22px');
      quote.style.setProperty('margin-bottom', '22px');
    }

    for (const listItem of Array.from(content.querySelectorAll('li'))) {
      listItem.style.setProperty('font-size', '16px');
      listItem.style.setProperty('line-height', '1.8');
      listItem.style.setProperty('color', '#334155');
    }

    // 동일한 광고/협찬 고지가 AI 응답의 앞뒤에 반복되면 첫 문장만 남깁니다.
    const disclosureNodes = Array.from(content.querySelectorAll('p')).filter((node) =>
      /(?:본\s*포스팅.{0,40}(?:원고료|제품|광고|협찬)|소정의\s*원고료|제품을?\s*제공받아\s*작성|유료\s*광고를?\s*포함|협찬을?\s*받아\s*작성)/.test(String(node.textContent || ''))
    );
    const seenDisclosures = new Set();
    for (const node of disclosureNodes) {
      const key = String(node.textContent || '').replace(/\s+/g, ' ').trim();
      if (seenDisclosures.has(key)) {
        node.remove();
        continue;
      }
      seenDisclosures.add(key);
      node.style.setProperty('font-size', '13px');
      node.style.setProperty('line-height', '1.7');
      node.style.setProperty('color', '#64748b');
      node.style.setProperty('text-align', 'center');
      node.style.setProperty('background-color', '#f8fafc');
      node.style.setProperty('padding', '10px 12px');
      node.style.setProperty('margin-bottom', '24px');
    }

    // 연속 빈 문단은 한 개로 제한하고, 소제목 앞에는 실제 한 줄 여백을 둡니다.
    for (const empty of Array.from(content.querySelectorAll('p')).filter((node) =>
      !node.hasAttribute('data-dd-photo-slot') && !String(node.textContent || '').trim() && !node.querySelector('br')
    )) {
      empty.remove();
    }
    for (const heading of Array.from(content.querySelectorAll('h2, h3'))) {
      const previous = heading.previousElementSibling;
      if (previous?.hasAttribute?.('data-dd-photo-slot')) continue;
      if (previous?.matches?.('p[data-dd-naver-spacer]')) continue;
      const spacer = document.createElement('p');
      spacer.setAttribute('data-dd-naver-spacer', 'heading');
      spacer.innerHTML = '<br>';
      heading.before(spacer);
    }

    return template.innerHTML.trim();
  }

  function buildContentBlocks(contentHtml, images) {
    const safeHtml = String(contentHtml || "").trim();
    const safeImages = Array.isArray(images) ? images.filter(Boolean) : [];

    if (!safeHtml) {
      return safeImages.length ? [{ type: "images", images: safeImages }] : [];
    }

    if (!safeImages.length) {
      return [{ type: "html", html: safeHtml }];
    }

    const template = document.createElement("template");
    template.innerHTML = safeHtml;
    const nodes = Array.from(template.content.childNodes).filter((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        return Boolean(String(node.textContent || "").trim());
      }

      return node.nodeType === Node.ELEMENT_NODE;
    });

    if (!nodes.length) {
      return [{ type: "images", images: safeImages }];
    }

    const insertionMap = resolveImageInsertionMap(nodes, safeImages);
    const blocks = [];
    let currentNodes = [];

    const leadingImages = insertionMap.get(-1) || [];
    if (leadingImages.length) {
      blocks.push({ type: "images", images: leadingImages });
    }

    for (let index = 0; index < nodes.length; index += 1) {
      currentNodes.push(nodes[index].cloneNode(true));

      const imagesAfterNode = insertionMap.get(index) || [];
      if (!imagesAfterNode.length) {
        continue;
      }

      const htmlChunk = buildChunkHtml(currentNodes);
      if (htmlChunk) {
        blocks.push({ type: "html", html: htmlChunk });
      }

      blocks.push({ type: "images", images: imagesAfterNode });
      currentNodes = [];
    }

    const tailHtml = buildChunkHtml(currentNodes);
    if (tailHtml) {
      blocks.push({ type: "html", html: tailHtml });
    }

    const trailingImages = insertionMap.get(nodes.length) || [];
    if (trailingImages.length) {
      blocks.push({ type: "images", images: trailingImages });
    }

    return blocks.length ? blocks : [{ type: "html", html: safeHtml }];
  }

  function resolveImageInsertionMap(nodes, images) {
    const map = new Map();
    const headingEntries = nodes
      .map((node, index) => ({
        index,
        node,
        text: isHeadingNode(node) ? normalizeText(node.textContent || "") : "",
      }))
      .filter((entry) => entry.text);
    const introAnchor = headingEntries.length
      ? Math.max(0, headingEntries[0].index - 1)
      : Math.min(1, Math.max(0, nodes.length - 1));
    const defaultAnchors = headingEntries.length
      ? headingEntries.map((entry) => findSectionBodyAnchorIndex(entry.index, nodes))
      : nodes
        .map((node, index) => ({ node, index }))
        .filter((entry) => isParagraphLikeNode(entry.node))
        .map((entry) => entry.index);

    for (let index = 0; index < images.length; index += 1) {
      const image = images[index];
      const targetIndex = resolveImageInsertionIndex(image, index, {
        nodes,
        headingEntries,
        introAnchor,
        defaultAnchors,
      });

      if (!map.has(targetIndex)) {
        map.set(targetIndex, []);
      }

      map.get(targetIndex).push(image);
    }

    return map;
  }

  function resolveImageInsertionIndex(image, order, context) {
    const hintText = normalizeText([
      image.slot,
      image.placementHint,
      image.headingHint,
      image.alt,
    ].join(" "));
    const representativeHintText = normalizeText([
      image.slot,
      image.alt,
    ].join(" "));
    const headingMatchIndex = findBestHeadingAnchorIndex(image, context.headingEntries, context.nodes);

    if (headingMatchIndex >= 0) {
      return headingMatchIndex;
    }

    if (/(대표|썸네일|thumbnail|hero|cover)/i.test(representativeHintText)) {
      return -1;
    }

    if (/(도입|인트로|대표|썸네일|첫|opening)/i.test(hintText)) {
      return context.introAnchor;
    }

    if (/(마무리|결론|마지막|끝|outro|closing)/i.test(hintText)) {
      return context.nodes.length;
    }

    if (context.defaultAnchors.length) {
      return context.defaultAnchors[Math.min(order, context.defaultAnchors.length - 1)];
    }

    return Math.max(0, context.nodes.length - 1);
  }

  function findBestHeadingAnchorIndex(image, headingEntries, nodes) {
    const searchTerms = [image.headingHint, image.slot, image.placementHint]
      .map((value) => normalizeText(value))
      .filter(Boolean);

    if (!searchTerms.length || !headingEntries.length) {
      return -1;
    }

    let bestEntry = null;
    let bestScore = 0;

    for (const entry of headingEntries) {
      let score = 0;

      for (const term of searchTerms) {
        if (!term) {
          continue;
        }

        if (entry.text === term) {
          score += 120;
          continue;
        }

        if (entry.text.includes(term) || term.includes(entry.text)) {
          score += 80;
          continue;
        }

        const entryWords = entry.text.split(/\s+/).filter(Boolean);
        const termWords = term.split(/\s+/).filter(Boolean);
        const overlapCount = termWords.filter((word) => entryWords.includes(word)).length;
        score += overlapCount * 18;
      }

      if (score > bestScore) {
        bestScore = score;
        bestEntry = entry;
      }
    }

    if (!bestEntry || bestScore < 18) {
      return -1;
    }

    return Math.max(-1, bestEntry.index - 1);
  }

  function findSectionBodyAnchorIndex(headingIndex, nodes) {
    for (let index = headingIndex + 1; index < nodes.length; index += 1) {
      if (isHeadingNode(nodes[index])) {
        break;
      }

      if (isParagraphLikeNode(nodes[index])) {
        return index;
      }
    }

    return headingIndex;
  }

  function buildChunkHtml(nodes) {
    if (!Array.isArray(nodes) || !nodes.length) {
      return "";
    }

    const container = document.createElement("div");
    for (const node of nodes) {
      container.appendChild(node.cloneNode(true));
    }

    return container.innerHTML.trim();
  }

  function isHeadingNode(node) {
    return node?.nodeType === Node.ELEMENT_NODE && /^(H2|H3)$/i.test(node.tagName || "");
  }

  function isParagraphLikeNode(node) {
    return node?.nodeType === Node.ELEMENT_NODE && /^(P|BLOCKQUOTE|UL|OL|IMG)$/i.test(node.tagName || "");
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function titleWithoutDecorativeIcons(value) {
    return normalizeText(String(value || '')
      .replace(/\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*/gu, '')
      .replace(/[\uFE0E\uFE0F\u200D]/g, ''));
  }

  function titleTextMatchesExpected(actualTitle, expectedTitle) {
    const actual = normalizeText(actualTitle);
    const expected = normalizeText(expectedTitle);
    if (actual === expected) return true;
    const expectedText = titleWithoutDecorativeIcons(expected);
    // SmartEditor can render an emoji as a separate icon node that is absent
    // from textContent. Never treat an icon-only or partial title as success.
    return Boolean(expectedText) && expectedText !== expected
      && titleWithoutDecorativeIcons(actual) === expectedText;
  }

  async function insertNaverBlogTitle(titleCandidate, title) {
    const safeTitle = normalizeText(title);

    if (!safeTitle) {
      return false;
    }

    if (titleTextMatchesExpected(readTitleText(titleCandidate), safeTitle)) {
      return true;
    }

    // 카페 글쓰기 제목은 SmartEditor 컴포넌트가 아니라 일반 textarea입니다.
    if (isNativeTextInput(titleCandidate)) {
      return insertTitleIntoNativeInput(titleCandidate, safeTitle);
    }

    const activation = await activateTitleEditor(titleCandidate);

    if (activation.editable) {
      const inserted = await insertTitleIntoEditableHost(activation.editable, safeTitle, titleCandidate);

      if (inserted && await waitForTitleText(titleCandidate, safeTitle)) {
        return true;
      }
    }

    if (activation.inputFrame) {
      const inserted = await insertTitleIntoInputBufferFrame(activation.inputFrame, safeTitle);

      if (inserted && await waitForTitleText(titleCandidate, safeTitle)) {
        return true;
      }
    }

    const fallbackEditable = resolveTitleEditableHost(titleCandidate);

    if (fallbackEditable) {
      const inserted = await insertTitleIntoEditableHost(fallbackEditable, safeTitle, titleCandidate);

      if (inserted && await waitForTitleText(titleCandidate, safeTitle)) {
        return true;
      }
    }

    if (titleTextMatchesExpected(readTitleText(titleCandidate), safeTitle)) {
      return true;
    }

    // If an emoji survives but the words do not, prefer a complete plain-text
    // title over leaving a visually empty icon-only heading.
    const plainTitle = titleWithoutDecorativeIcons(safeTitle);
    if (plainTitle && plainTitle !== safeTitle) {
      const recoveryEditable = resolveTitleEditableHost(titleCandidate);
      const recovered = recoveryEditable
        ? await insertTitleIntoEditableHost(recoveryEditable, plainTitle, titleCandidate)
        : activation.inputFrame
          ? await insertTitleIntoInputBufferFrame(activation.inputFrame, plainTitle)
          : false;
      if (recovered && await waitForTitleText(titleCandidate, plainTitle)) {
        return true;
      }
    }

    return titleTextMatchesExpected(readTitleText(titleCandidate), safeTitle);
  }

  async function insertTitleIntoNativeInput(element, title) {
    if (!isNativeTextInput(element)) {
      return false;
    }

    const safeTitle = normalizeText(title);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      element.scrollIntoView?.({ block: "center", inline: "nearest" });
      dispatchPointerSequence(element);
      element.focus();
      element.select?.();

      setNativeValue(element, "");
      dispatchTypingEvents(element, "", "deleteContentBackward");

      if (attempt === 1) {
        try {
          document.execCommand("insertText", false, safeTitle);
        } catch {
          setNativeValue(element, safeTitle);
        }
      } else {
        setNativeValue(element, safeTitle);
      }

      if (element.value !== safeTitle) {
        element.value = safeTitle;
      }

      element.setAttribute?.("value", safeTitle);
      dispatchTypingEvents(element, safeTitle, "insertText");
      element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      element.dispatchEvent(new KeyboardEvent("keyup", {
        bubbles: true,
        composed: true,
        key: "Unidentified",
      }));

      await sleep(180 + (attempt * 120));

      if (await waitForTitleText(element, safeTitle, 900)) {
        element.blur?.();
        return true;
      }
    }

    return normalizeText(element.value || "") === safeTitle;
  }

  async function waitForTitleText(titleCandidate, expectedTitle, timeoutMs = 1500) {
    const safeExpected = normalizeText(expectedTitle);
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (titleTextMatchesExpected(readTitleText(titleCandidate), safeExpected)) {
        return true;
      }

      await sleep(80);
    }

    return titleTextMatchesExpected(readTitleText(titleCandidate), safeExpected);
  }

  function resolveTitleComponent(titleCandidate) {
    if (!titleCandidate) {
      return null;
    }

    return titleCandidate.closest?.(".se-component.se-documentTitle[data-a11y-title='제목'], .se-component.se-documentTitle, [data-a11y-title='제목']")
      || titleCandidate;
  }

  function resolveTitleSurface(titleCandidate) {
    const component = resolveTitleComponent(titleCandidate);

    if (!component) {
      return null;
    }

    return component.matches?.(".se-title-text, .se-section-documentTitle")
      ? component
      : component.querySelector?.(".se-title-text, .se-section-documentTitle, .se-module.se-module-text.__se-unit, .se-module.se-module-text") || component;
  }

  function resolveTitleSelectionTarget(titleCandidate, fallbackTarget = null) {
    const surface = resolveTitleSurface(titleCandidate);

    if (!surface) {
      return fallbackTarget;
    }

    return surface.querySelector?.(".se-text-paragraph, .__se-node:not(.se-placeholder):not(.__se_placeholder)")
      || fallbackTarget
      || surface;
  }

  function readTitleText(titleCandidate) {
    const surface = resolveTitleSurface(titleCandidate);

    if (!surface) {
      return "";
    }

    if (isNativeTextInput(surface)) {
      return normalizeText(surface.value || "");
    }

    const clone = surface.cloneNode(true);
    clone.querySelectorAll?.(".se-placeholder, .__se_placeholder, .se-placeholder-focused").forEach((node) => node.remove());

    return normalizeText(clone.innerText || clone.textContent || "");
  }

  async function activateTitleEditor(titleCandidate) {
    const component = resolveTitleComponent(titleCandidate);
    const surface = resolveTitleSurface(titleCandidate) || component || titleCandidate;

    blurCurrentFocus();
    clearDocumentSelection();
    dispatchPointerSequence(component || surface);
    await sleep(40);
    dispatchPointerSequence(surface);
    surface?.focus?.();

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const editable = resolveTitleEditableHost(titleCandidate);
      const inputFrame = findTitleInputBufferFrame();

      if (editable || inputFrame) {
        return { editable, inputFrame };
      }

      await sleep(70);
    }

    return {
      editable: resolveTitleEditableHost(titleCandidate),
      inputFrame: findTitleInputBufferFrame(),
    };
  }

  async function activateBodyEditor(bodyElement) {
    const surface = resolveBodyActivationSurface(bodyElement);

    if (!surface) {
      return false;
    }

    blurCurrentFocus();
    clearDocumentSelection();
    dispatchPointerSequence(surface);
    surface.focus?.();
    await sleep(80);
    return true;
  }

  async function ensureStrikethroughDisabled(bodyElement) {
    const strikeButton = collectElements([
      ".se-strikethrough-toolbar-button.se-is-selected",
      "button[data-name='strikethrough'].se-is-selected",
      "button[data-log='prt.strike'].se-is-selected",
    ]).find(isVisible) || null;

    if (strikeButton) {
      dispatchPointerSequence(strikeButton);
      await sleep(120);
    }

    const surface = resolveBodyActivationSurface(bodyElement);

    if (surface) {
      dispatchPointerSequence(surface);
      surface.focus?.();
      await sleep(60);
    }

    try {
      if (document.queryCommandState?.("strikeThrough")) {
        document.execCommand("strikeThrough", false);
        await sleep(60);
      }
    } catch {
      // SmartEditor 환경에서 queryCommandState를 지원하지 않으면 툴바 상태만 사용합니다.
    }
  }

  async function removeGeneratedStrikethrough(bodyElement) {
    const editorRoot = resolveBodyEditorRoot(bodyElement)
      || document.querySelector(".se-components-wrap, .se-container")
      || document;
    let removedCount = 0;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const strikeElements = Array.from(editorRoot.querySelectorAll("strike, s, del"));

      for (const strikeElement of strikeElements) {
        strikeElement.replaceWith(...Array.from(strikeElement.childNodes));
        removedCount += 1;
      }

      for (const styledElement of Array.from(editorRoot.querySelectorAll("[style]"))) {
        if (!/line-through/i.test(styledElement.style.textDecoration || styledElement.style.textDecorationLine || "")) {
          continue;
        }

        styledElement.style.removeProperty("text-decoration");
        styledElement.style.removeProperty("text-decoration-line");
        removedCount += 1;
      }

      if (removedCount > 0) {
        dispatchInputEvents(bodyElement);
        bodyElement.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      }

      await ensureStrikethroughDisabled(bodyElement);
      await sleep(160);
    }

    return removedCount;
  }

  function resolveBodyActivationSurface(bodyElement) {
    const candidates = [
      bodyElement?.__nbTypingActivator || null,
      bodyElement && !isSmartEditorHiddenTypingBuffer(bodyElement) && isVisible(bodyElement) ? bodyElement : null,
      ...collectElements([
        ".se-component.se-text[data-a11y-title='본문'] .se-module.se-module-text.__se-unit",
        ".se-component.se-text[data-a11y-title='본문'] .se-module.se-module-text",
        ".se-component[data-a11y-title='본문'] .se-module.se-module-text.__se-unit",
        ".se-component[data-a11y-title='본문'] .se-module.se-module-text",
        ".se-component.se-text[data-a11y-title='본문'] .se-component-content",
        ".se-component[data-a11y-title='본문'] .se-component-content",
        ".se-component.se-text[data-a11y-title='본문'] .se-section",
        ".se-component[data-a11y-title='본문'] .se-section",
      ]).filter(isVisible),
    ].filter(Boolean);

    return candidates.find((candidate) => !isSmartEditorHiddenTypingBuffer(candidate)) || null;
  }

  function blurCurrentFocus() {
    try {
      document.activeElement?.blur?.();
    } catch {
      // Ignore blur failures.
    }
  }

  function clearDocumentSelection() {
    try {
      getSelection()?.removeAllRanges();
    } catch {
      // Ignore selection reset failures.
    }
  }

  function dispatchPointerSequence(element) {
    if (!element) {
      return;
    }

    element.scrollIntoView?.({ block: "center", inline: "nearest" });
    const rect = element.getBoundingClientRect();
    const baseInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      clientX: rect.left + Math.min(Math.max(rect.width / 2, 6), Math.max(rect.width - 2, 6)),
      clientY: rect.top + Math.min(Math.max(rect.height / 2, 6), Math.max(rect.height - 2, 6)),
    };

    if (typeof PointerEvent === "function") {
      element.dispatchEvent(new PointerEvent("pointerdown", baseInit));
      element.dispatchEvent(new PointerEvent("pointerup", baseInit));
    }

    element.dispatchEvent(new MouseEvent("mousedown", baseInit));
    element.dispatchEvent(new MouseEvent("mouseup", baseInit));
    element.dispatchEvent(new MouseEvent("click", baseInit));
  }

  function resolveTitleEditableHost(titleCandidate) {
    const component = resolveTitleComponent(titleCandidate);
    const surface = resolveTitleSurface(titleCandidate);
    const candidates = [
      surface,
      component,
      surface?.querySelector?.("[contenteditable='true'], [contenteditable=''], [contenteditable]:not([contenteditable='false'])"),
      component?.querySelector?.("[contenteditable='true'], [contenteditable=''], [contenteditable]:not([contenteditable='false'])"),
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (candidate?.isContentEditable) {
        return candidate;
      }
    }

    let current = resolveTitleSelectionTarget(titleCandidate);

    while (current && current !== component?.parentElement) {
      if (current.isContentEditable) {
        return current;
      }

      current = current.parentElement;
    }

    return null;
  }

  function findTitleInputBufferFrame() {
    if (isTitleInputBufferFrame(document.activeElement)) {
      return document.activeElement;
    }

    const frames = collectElements([
      "iframe[id*='input_buffer']",
      "iframe[name*='input_buffer']",
      "iframe[class*='input_buffer']",
    ]);

    return frames.find((frame) => isTitleInputBufferFrame(frame)) || null;
  }

  function isTitleInputBufferFrame(element) {
    if (!element || String(element.tagName || "").toUpperCase() !== "IFRAME") {
      return false;
    }

    const label = `${element.id || ""} ${element.name || ""} ${element.className || ""}`;
    return /input_buffer|buffer/i.test(label);
  }

  async function insertTitleIntoEditableHost(element, title, titleCandidate) {
    if (!element) {
      return false;
    }

    focusTitleEditableTarget(element, titleCandidate);
    selectTitleTextRange(titleCandidate, element);

    if (isNativeTextInput(element)) {
      setNativeValue(element, "");
      dispatchTypingEvents(element, "", "deleteContentBackward");
      setNativeValue(element, title);
      element.setAttribute?.("value", title);
      dispatchTypingEvents(element, title, "insertText");
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    const pasteWorked = dispatchPlainTextPaste(element, title);
    await sleep(120);

    if (pasteWorked && titleTextMatchesExpected(readTitleText(titleCandidate), title)) {
      dispatchInputEvents(element);
      return true;
    }

    focusTitleEditableTarget(element, titleCandidate);
    selectTitleTextRange(titleCandidate, element);

    let inserted = false;

    try {
      document.execCommand("delete", false);
      inserted = document.execCommand("insertText", false, title);
    } catch {
      inserted = false;
    }

    if (!inserted) {
      inserted = insertTextAtSelection(title);
    }

    if (inserted) {
      dispatchTypingEvents(element, title, "insertText");
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }

    return inserted;
  }

  function focusTitleEditableTarget(element, titleCandidate) {
    const surface = resolveTitleSurface(titleCandidate) || element;
    surface?.scrollIntoView?.({ block: "center", inline: "nearest" });
    surface?.click?.();
    element.focus?.();
  }

  function selectTitleTextRange(titleCandidate, fallbackTarget) {
    const target = resolveTitleSelectionTarget(titleCandidate, fallbackTarget);
    const selection = getSelection();

    if (!target || !selection) {
      return false;
    }

    try {
      const range = document.createRange();
      range.selectNodeContents(target);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    } catch {
      return false;
    }
  }

  function dispatchPlainTextPaste(element, text) {
    const target = element.closest?.("rich-textarea") || element;
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", text);

    try {
      const pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      });
      return target.dispatchEvent(pasteEvent);
    } catch {
      const fallbackEvent = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(fallbackEvent, "clipboardData", { configurable: true, value: dataTransfer });
      return target.dispatchEvent(fallbackEvent);
    }
  }

  async function insertTitleIntoInputBufferFrame(frame, title) {
    const frameWindow = frame?.contentWindow;
    const frameDocument = frameWindow?.document || frame?.contentDocument;

    if (!frameWindow || !frameDocument) {
      return false;
    }

    const target = resolveFrameInputTarget(frameDocument);

    if (!target) {
      return false;
    }

    try {
      frameWindow.focus();
      frame.focus?.();
      target.focus?.();
    } catch {
      // Ignore focus failures.
    }

    if (isNativeTextInput(target)) {
      setNativeValue(target, "");
      dispatchFrameInputEvents(frameWindow, target, "", "deleteContentBackward");
      setNativeValue(target, title);
      target.setAttribute?.("value", title);
      dispatchFrameInputEvents(frameWindow, target, title, "insertText");
      target.dispatchEvent(new frameWindow.Event("change", { bubbles: true }));
      await sleep(160);
      return true;
    }

    selectFrameTargetContents(frameDocument, target);

    let inserted = false;

    try {
      frameDocument.execCommand("delete", false);
      inserted = frameDocument.execCommand("insertText", false, title);
    } catch {
      inserted = false;
    }

    if (!inserted) {
      target.textContent = title;
    }

    dispatchFrameInputEvents(frameWindow, target, title, "insertText");
    target.dispatchEvent(new frameWindow.Event("change", { bubbles: true }));
    await sleep(160);
    return true;
  }

  function resolveFrameInputTarget(frameDocument) {
    const activeElement = frameDocument.activeElement;

    if (isEditableLikeElement(activeElement)) {
      return activeElement;
    }

    return frameDocument.querySelector?.("textarea, input, [contenteditable='true'], [contenteditable=''], [contenteditable]:not([contenteditable='false'])")
      || (frameDocument.body?.isContentEditable ? frameDocument.body : null);
  }

  function selectFrameTargetContents(frameDocument, target) {
    try {
      const selection = frameDocument.getSelection?.();
      const range = frameDocument.createRange?.();

      if (!selection || !range) {
        return false;
      }

      range.selectNodeContents(target);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    } catch {
      return false;
    }
  }

  function dispatchFrameInputEvents(frameWindow, element, value, inputType) {
    try {
      element.dispatchEvent(new frameWindow.InputEvent("beforeinput", { bubbles: true, data: value, inputType }));
    } catch {
      // Ignore environments without beforeinput support.
    }

    try {
      element.dispatchEvent(new frameWindow.InputEvent("input", { bubbles: true, data: value, inputType }));
    } catch {
      element.dispatchEvent(new frameWindow.Event("input", { bubbles: true }));
    }
  }

  function isEditableLikeElement(element) {
    return isNativeTextInput(element)
      || Boolean(element?.isContentEditable)
      || element?.getAttribute?.("role") === "textbox";
  }

  function isNativeTextInput(element) {
    const tagName = String(element?.tagName || "").toUpperCase();
    return tagName === "INPUT" || tagName === "TEXTAREA";
  }

  function insertTitle(element, title) {
    element.focus();

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.value = title;
      dispatchInputEvents(element);
      return true;
    }

    element.textContent = title;
    dispatchInputEvents(element);
    return true;
  }

  // 네이버 인용구는 스타일이 여러 개(인용구1/2/3/4 등)이며 붙여넣기 직후엔 박스가 없는
  // 기본(인용구1) 스타일로 들어갑니다. 소스 HTML의 커스텀 박스 스타일(배경색+왼쪽 테두리)은
  // 네이버가 붙여넣기 시 전부 무시하므로, 사용자가 지정한 "인용구2" 프리셋으로 바꿔줍니다.
  // data-value 문자열은 네이버 쪽 구현에 따라 바뀔 수 있어, 툴바에 노출되는 순서(2번째 버튼)로 선택합니다.
  async function switchQuoteBlocksToBubbleStyle(root) {
    try {
      const quotes = Array.from(root.querySelectorAll("blockquote:not([data-dd-quote-styled])"));
      for (const quote of quotes) {
        quote.setAttribute("data-dd-quote-styled", "1");
        quote.scrollIntoView({ block: "center" });
        quote.click();
        await sleep(200);
        const layoutButtons = Array.from(document.querySelectorAll(
          'button[data-group="contextToolbar"][data-name="quotation-layout"]'
        ));
        const secondQuoteButton = layoutButtons[1];
        if (secondQuoteButton) {
          secondQuoteButton.click();
          await sleep(200);
        }
      }
    } catch (e) {
      // 네이버 에디터 구조가 바뀌었을 수 있으니 실패해도 전체 입력은 계속 진행합니다.
    }
  }

  function applyTableWidthFix(root) {
    for (const table of Array.from(root.querySelectorAll("table"))) {
      // 네이버 에디터가 붙여넣은 표를 자기 컴포넌트로 감싸면서 width:100%를 무시하고
      // 고정 픽셀 폭의 좁은 표로 축소시킨 뒤 가운데 정렬해버리는 경우가 있어,
      // 폭을 가로채는 colgroup/col의 고정폭을 지우고 폭을 다시 강제합니다.
      table.style.setProperty("width", "100%");
      table.style.setProperty("max-width", "100%");
      table.style.setProperty("margin-left", "0");
      table.style.setProperty("margin-right", "0");
      // table-layout 속성을 지우기만 하면 네이버 자체 스타일시트의 fixed 값이 그대로 적용돼
      // 칸이 내용 길이와 무관하게 균등 분할됩니다. auto로 명시해야 내용 폭에 맞춰집니다.
      table.style.setProperty("table-layout", "auto");
      for (const col of Array.from(table.querySelectorAll("col"))) {
        col.removeAttribute("width");
        col.style.removeProperty("width");
      }
      // 네이버가 각 셀(td/th)에 직접 고정 픽셀 width를 박아넣는 경우도 있어 같이 풀어줍니다.
      for (const cell of Array.from(table.querySelectorAll("td, th"))) {
        cell.removeAttribute("width");
        cell.style.removeProperty("width");
      }
      // 첫 번째 열(항목명)은 글자 길이에 맞춰 줄어들도록 줄바꿈을 막습니다.
      for (const row of Array.from(table.querySelectorAll("tr"))) {
        const firstCell = row.firstElementChild;
        if (firstCell) {
          firstCell.style.setProperty("white-space", "nowrap");
          firstCell.style.setProperty("width", "1%");
        }
      }
      let node = table.parentElement;
      while (node && node !== root) {
        if (node.classList && (node.classList.contains("se-table-content") || node.classList.contains("se-component") || node.classList.contains("se-component-content"))) {
          node.style.setProperty("width", "100%");
          node.style.setProperty("max-width", "100%");
        }
        node = node.parentElement;
      }
    }
  }

  async function fixTableWidths(root) {
    try {
      if (!root.querySelector("table")) {
        return;
      }
      // 네이버가 붙여넣기 직후 비동기로 표를 자체 컴포넌트로 재조립하면서 폭을
      // 다시 덮어쓰는 경우가 있어, 한 번만 고치지 않고 짧은 간격으로 재적용합니다.
      applyTableWidthFix(root);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await sleep(300);
        applyTableWidthFix(root);
      }
    } catch (e) {
      // 실패해도 전체 입력은 계속 진행합니다.
    }
  }

  async function insertHtmlIntoEditor(element, html, plainText) {
    element.focus();
    placeCaretAtEnd(element);

    const before = getElementSnapshot(element);
    const pasteWorked = dispatchPaste(element, html, plainText);
    await sleep(120);

    if (pasteWorked && getElementSnapshot(element) !== before) {
      dispatchInputEvents(element);
      await switchQuoteBlocksToBubbleStyle(element);
      await fixTableWidths(element);
      return true;
    }

    document.execCommand("insertHTML", false, html);
    await sleep(80);

    if (getElementSnapshot(element) !== before) {
      dispatchInputEvents(element);
      await switchQuoteBlocksToBubbleStyle(element);
      await fixTableWidths(element);
      return true;
    }

    appendHtml(element, html);
    dispatchInputEvents(element);
    return getElementSnapshot(element) !== before;
  }

  function resolveHtmlInsertionTarget(element) {
    if (!element) {
      return null;
    }

    const structuredEditable = resolveStructuredBodyEditable(element);

    if (structuredEditable && !isSmartEditorHiddenTypingBuffer(structuredEditable)) {
      return structuredEditable;
    }

    const focusTarget = resolveTypingFocusTarget(element);

    if (focusTarget && !isSmartEditorHiddenTypingBuffer(focusTarget)) {
      return focusTarget;
    }

    return element;
  }

  function isSmartEditorHiddenTypingBuffer(element) {
    if (!element?.isContentEditable) {
      return false;
    }

    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const allowValue = String(element.getAttribute("allow") || "").toLowerCase();
    const ariaHidden = element.getAttribute("aria-hidden") === "true";
    const leftValue = Number.parseFloat(style.left || "0");

    return ariaHidden
      && allowValue.includes("clipboard-read")
      && (style.position === "fixed" || style.position === "absolute")
      && (String(style.left || "").startsWith("-") || leftValue < -200 || rect.left < -200);
  }

  async function typeTextIntoEditor(element, plainText) {
    const safeText = normalizeTypingText(plainText);

    if (!safeText) {
      return false;
    }

    const typingTarget = focusEditableTypingTarget(element) || element;

    const before = getElementSnapshot(element);
    const chunks = buildTypingChunks(safeText);

    for (const chunk of chunks) {
      insertTypingChunk(typingTarget, chunk);
      await sleep(getTypingDelay(chunk, safeText.length));
    }

    typingTarget.dispatchEvent(new Event("change", { bubbles: true }));
    return getElementSnapshot(element) !== before;
  }

  function insertTypingChunk(element, chunk) {
    const typingTarget = resolveTypingInputElement(element) || element;
    const inputType = chunk === "\n"
      ? (typingTarget?.isContentEditable || typingTarget?.getAttribute?.("role") === "textbox"
        ? "insertParagraph"
        : "insertLineBreak")
      : "insertText";

    if (typingTarget instanceof HTMLInputElement || typingTarget instanceof HTMLTextAreaElement) {
      const nextValue = `${typingTarget.value || ""}${chunk === "\n" ? "\n" : chunk}`;
      setNativeValue(typingTarget, nextValue);
      typingTarget.setAttribute("value", nextValue);
      dispatchTypingEvents(typingTarget, chunk, inputType);
      return;
    }

    if (typingTarget.isContentEditable || typingTarget.getAttribute("role") === "textbox") {
      placeCaretAtEnd(typingTarget);

      let inserted = false;

      try {
        if (chunk === "\n") {
          inserted = document.execCommand("insertParagraph", false);
        } else {
          inserted = document.execCommand("insertText", false, chunk);
        }
      } catch {
        inserted = false;
      }

      if (!inserted) {
        inserted = insertTextAtSelection(chunk === "\n" ? "\n" : chunk);
      }

      if (!inserted) {
        typingTarget.textContent = `${typingTarget.textContent || ""}${chunk === "\n" ? "\n" : chunk}`;
      }

      dispatchTypingEvents(typingTarget, chunk, inputType);
      return;
    }

    typingTarget.textContent = `${typingTarget.textContent || ""}${chunk === "\n" ? "\n" : chunk}`;
    dispatchTypingEvents(typingTarget, chunk, inputType);
  }

  function resolveTypingFocusTarget(element) {
    if (!element) {
      return null;
    }

    if (element.__nbTypingActivator) {
      return element.__nbTypingActivator;
    }

    if (isEditableTypingElement(element)) {
      return element;
    }

    return element.querySelector?.(
      ".se-component-content, .se-section, .se-module, .se-text-paragraph, [role='textbox'], [contenteditable='true'], [contenteditable=''], [contenteditable]:not([contenteditable='false'])"
    ) || element;
  }

  function resolveTypingInputElement(element, preferredTarget) {
    const scopeRoot = element?.closest?.(".se-main-container, .se-component, .se-section, .se-module") || element || null;
    const scopedActiveElement = isScopedTypingElement(document.activeElement, scopeRoot)
      ? document.activeElement
      : null;
    const candidates = [
      preferredTarget,
      scopedActiveElement,
      element?.__nbTypingTarget || null,
      element,
      resolveTypingFocusTarget(element),
      ...collectTypingScopeCandidates(element),
      findSmartEditorHiddenTypingBuffer(),
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (!isEditableTypingElement(candidate)) {
        continue;
      }

      if (isSmartEditorHiddenTypingBuffer(candidate)) {
        continue;
      }

      return candidate;
    }

    for (const candidate of candidates) {
      if (isEditableTypingElement(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  function isScopedTypingElement(element, scopeRoot) {
    if (!element || !scopeRoot) {
      return false;
    }

    return element === scopeRoot || Boolean(scopeRoot.contains?.(element));
  }

  function collectTypingScopeCandidates(element) {
    const bridgedTarget = element?.__nbTypingTarget;
    const scopeRoot = element?.closest?.(".se-main-container, .se-component, .se-section, .se-module") || element;

    if (!scopeRoot?.querySelectorAll) {
      return bridgedTarget ? [bridgedTarget] : [];
    }

    return [
      ...(bridgedTarget ? [bridgedTarget] : []),
      ...Array.from(scopeRoot.querySelectorAll(
      "input, textarea, [role='textbox'], [contenteditable='true'], [contenteditable=''], [contenteditable]:not([contenteditable='false'])"
      )),
    ];
  }

  function isEditableTypingElement(element) {
    return element instanceof HTMLInputElement
      || element instanceof HTMLTextAreaElement
      || Boolean(element?.isContentEditable)
      || element?.getAttribute?.("role") === "textbox";
  }

  function insertTextAtSelection(value) {
    try {
      const selection = getSelection();
      if (!selection?.rangeCount) {
        return false;
      }

      const range = selection.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(value);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    } catch {
      return false;
    }
  }

  function dispatchTypingEvents(element, value, inputType) {
    try {
      element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, composed: true, data: value, inputType }));
    } catch {
      // Ignore environments without full beforeinput support.
    }

    element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: value, inputType }));
  }

  function setNativeValue(element, value) {
    if (!element) {
      return;
    }

    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value")
      || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
      || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");

    if (descriptor?.set) {
      descriptor.set.call(element, value);
      return;
    }

    element.value = value;
  }

  function buildTypingChunks(text) {
    const safeText = normalizeTypingText(text);
    const chunks = [];

    for (let index = 0; index < safeText.length;) {
      if (safeText[index] === "\n") {
        chunks.push("\n");
        index += 1;
        continue;
      }

      const protectedToken = readProtectedTypingToken(safeText, index);

      if (protectedToken) {
        chunks.push(protectedToken);
        index += protectedToken.length;
        continue;
      }

      const chunkSize = 1;
      const nextProtectedIndex = findNextProtectedTypingTokenIndex(safeText, index + 1);

      if (nextProtectedIndex > index && nextProtectedIndex < index + chunkSize) {
        chunks.push(safeText.slice(index, nextProtectedIndex));
        index = nextProtectedIndex;
        continue;
      }

      chunks.push(safeText.slice(index, index + chunkSize));
      index += chunkSize;
    }

    return chunks;
  }

  function readProtectedTypingToken(text, startIndex) {
    if (!isProtectedTypingTokenStart(text, startIndex)) {
      return "";
    }

    let endIndex = startIndex + 4;

    while (endIndex < text.length && !isProtectedTypingTokenBoundary(text[endIndex])) {
      endIndex += 1;
    }

    return text.slice(startIndex, endIndex);
  }

  function findNextProtectedTypingTokenIndex(text, startIndex) {
    for (let index = startIndex; index < text.length; index += 1) {
      if (text[index] === "\n") {
        return -1;
      }

      if (isProtectedTypingTokenStart(text, index)) {
        return index;
      }
    }

    return -1;
  }

  function isProtectedTypingTokenStart(text, index) {
    return /\d/.test(text[index] || "")
      && text[index + 1] === "."
      && text[index + 2] === "\u2060"
      && /\d/.test(text[index + 3] || "");
  }

  function isProtectedTypingTokenBoundary(character) {
    return !character || /[\s\n,!?;:(){}\[\]<>"'`“”‘’]/.test(character);
  }

  function getTypingDelay(chunk, totalLength) {
    const baseDelay = chunk === "\n"
      ? 36
      : totalLength > 1800
        ? 5
        : totalLength > 900
          ? 7
          : 10;

    return baseDelay + Math.floor(Math.random() * (chunk === "\n" ? 22 : 10));
  }

  function normalizeTypingText(value) {
    return String(value || "")
      .replace(/\r\n/g, "\n")
      .replace(/\u00a0/g, " ")
      .trim();
  }

  async function insertImagesIntoEditor(element, images) {
    let insertedCount = 0;
    let pendingCount = 0;

    for (const image of images) {
      const file = await dataUrlToSupportedImageFile(image.dataUrl, image.fileName);
      const imageInsertResult = await pasteImageIntoEditor(element, file);

      if (imageInsertResult.accepted) {
        insertedCount += 1;
      }

      if (imageInsertResult.pending) {
        pendingCount += 1;
      }
    }

    return {
      insertedCount,
      pendingCount,
    };
  }

  async function pasteImageIntoEditor(element, file) {
    element.focus();
    placeCaretAtEnd(element);

    const before = getElementSnapshot(element);
    const target = element.closest("rich-textarea") || element;
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    let accepted = false;

    try {
      const pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      });
      target.dispatchEvent(pasteEvent);
      accepted = true;
    } catch {
      const fallbackEvent = new Event("paste", {
        bubbles: true,
        cancelable: true,
      });

      Object.defineProperty(fallbackEvent, "clipboardData", {
        configurable: true,
        value: dataTransfer,
      });

      target.dispatchEvent(fallbackEvent);
      accepted = true;
    }

    const changed = getElementSnapshot(element) !== before;

    if (changed) {
      dispatchInputEvents(element);
    }

    return {
      accepted,
      pending: accepted && !changed,
    };
  }

  async function waitForEditorChange(element, previousSnapshot, options = {}) {
    const timeoutMs = typeof options === "number" ? options : Number(options.timeoutMs || 0);
    const pollMs = typeof options === "number" ? 250 : Number(options.pollMs || 250);
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (getElementSnapshot(element) !== previousSnapshot) {
        return true;
      }

      await sleep(pollMs);
    }

    return getElementSnapshot(element) !== previousSnapshot;
  }

  function dispatchPaste(element, html, plainText) {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/html", html);
    dataTransfer.setData("text/plain", plainText);

    try {
      const pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      });
      return element.dispatchEvent(pasteEvent);
    } catch {
      const fallbackEvent = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(fallbackEvent, "clipboardData", { configurable: true, value: dataTransfer });
      return element.dispatchEvent(fallbackEvent);
    }
  }

  function appendHtml(element, html) {
    const template = document.createElement("template");
    template.innerHTML = html;
    element.appendChild(template.content.cloneNode(true));
  }

  async function dataUrlToSupportedImageFile(dataUrl, fileName) {
    const blob = await dataUrlToBlob(dataUrl);
    const normalizedBlob = await normalizeImageBlob(blob);
    const mimeType = normalizedBlob.type || "image/png";
    const extension = mimeType === "image/jpeg" ? "jpg" : "png";
    const safeFileName = ensureFileExtension(fileName, extension);

    return new File([normalizedBlob], safeFileName, { type: mimeType });
  }

  async function dataUrlToBlob(dataUrl) {
    const response = await fetch(dataUrl);
    return response.blob();
  }

  async function normalizeImageBlob(blob) {
    const mimeType = String(blob.type || "").toLowerCase();

    if (mimeType === "image/png" || mimeType === "image/jpeg") {
      return blob;
    }

    return convertBlobToPng(blob);
  }

  async function convertBlobToPng(blob) {
    const objectUrl = URL.createObjectURL(blob);

    try {
      const image = await loadImage(objectUrl);
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth || image.width;
      canvas.height = image.naturalHeight || image.height;

      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("이미지 변환용 캔버스를 만들지 못했습니다.");
      }

      context.drawImage(image, 0, 0);

      return await new Promise((resolve, reject) => {
        canvas.toBlob((value) => {
          if (value) {
            resolve(value);
            return;
          }

          reject(new Error("네이버 업로드용 이미지 변환에 실패했습니다."));
        }, "image/png");
      });
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("이미지 파일을 읽지 못했습니다."));
      image.src = src;
    });
  }

  function buildImageFileName(title, index, dataUrl) {
    const base = String(title || "naver-blog-image")
      .trim()
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "naver-blog-image";
    const mimeType = /^data:([^;,]+)/i.exec(String(dataUrl || ""))?.[1]?.toLowerCase() || "image/png";
    const extension = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/png" ? "png" : "png";
    return `${base}-${index + 1}.${extension}`;
  }

  function ensureFileExtension(fileName, extension) {
    const safeBaseName = String(fileName || "image")
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "") || "image";

    return safeBaseName.replace(/\.[a-z0-9]+$/i, "") + `.${extension}`;
  }

  function placeCaretAtBodyEnd(element) {
    const selection = getSelection();

    if (!selection) {
      placeCaretAtEnd(element);
      return;
    }

    const tailNode = resolveBodyTailSelectionNode(element);

    if (!tailNode) {
      placeCaretAtEnd(element);
      return;
    }

    const range = document.createRange();

    if (tailNode.nodeType === Node.TEXT_NODE) {
      range.setStart(tailNode, String(tailNode.textContent || "").length);
      range.collapse(true);
    } else {
      range.selectNodeContents(tailNode);
      range.collapse(false);
    }

    selection.removeAllRanges();
    selection.addRange(range);
  }

  function resolveBodyTailSelectionNode(element) {
    const editorRoot = resolveBodyEditorRoot(element);
    const queryRoot = editorRoot?.querySelectorAll ? editorRoot : element;

    if (!queryRoot?.querySelectorAll) {
      return null;
    }

    const paragraphCandidates = Array.from(queryRoot.querySelectorAll(
      ".se-text-paragraph, .se-module.se-module-text.__se-unit, .se-module.se-module-text"
    ))
      .filter((candidate) => !isTitleScopeElement(candidate))
      .filter((candidate) => isVisible(candidate))
      .filter((candidate) => isBodyTailScopeCandidate(candidate, editorRoot));
    const tailContainer = paragraphCandidates[paragraphCandidates.length - 1] || null;

    if (!tailContainer) {
      return null;
    }

    const textWalker = document.createTreeWalker(tailContainer, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return String(node.textContent || "").trim()
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    });
    const textNodes = [];

    while (textWalker.nextNode()) {
      textNodes.push(textWalker.currentNode);
    }

    if (textNodes.length) {
      return textNodes[textNodes.length - 1];
    }

    const inlineCandidates = Array.from(tailContainer.querySelectorAll(
      ".__se-node:not(.se-placeholder):not(.__se_placeholder), br"
    ));

    return inlineCandidates[inlineCandidates.length - 1] || tailContainer;
  }

  function isBodyTailScopeCandidate(element, editorRoot) {
    if (!element) {
      return false;
    }

    if (editorRoot && !editorRoot.contains(element) && !element.contains?.(editorRoot)) {
      return false;
    }

    return Boolean(element.closest?.(
      ".se-main-container, .se-component.se-text[data-a11y-title='본문'], .se-component[data-a11y-title='본문'], .se-section, .se-module, rich-textarea"
    ));
  }

  function placeCaretAtEnd(element) {
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function getElementSnapshot(element) {
    return `${element.innerHTML || ""}\n${element.textContent || ""}`;
  }

  function dispatchInputEvents(element) {
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function collectElements(selectors) {
    const seen = new Set();
    const elements = [];

    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!seen.has(element)) {
          seen.add(element);
          elements.push(element);
        }
      }
    }

    return elements;
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function textToHtml(text) {
    return text
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
      .join("");
  }

  function htmlToPlainText(html) {
    const container = document.createElement("div");
    container.innerHTML = html;
    return container.innerText || container.textContent || "";
  }

  function escapeHtml(value) {
    return value.replace(/[&<>"]/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
    }[character]));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function insertNaverBlogTags(tags) {
  try {
    const tagLimit = location.hostname === "cafe.naver.com" ? 10 : 12;
    const normalizedTags = Array.isArray(tags)
      ? Array.from(new Set(tags
        .map((tag) => String(tag || "").replace(/^#/, "").trim())
        .filter(Boolean)))
          .slice(0, tagLimit)
      : [];

    if (!normalizedTags.length) {
      return { ok: true, insertedCount: 0, frameUrl: location.href, diagnostics: collectTagDiagnostics() };
    }

    const initialTagInput = await ensureTagInputReady();

    if (!initialTagInput) {
      return { ok: true, insertedCount: 0, frameUrl: location.href, diagnostics: collectTagDiagnostics() };
    }

    let insertedCount = 0;

    for (const tag of normalizedTags) {
      const currentInput = await ensureTagInputReady(initialTagInput);
      if (await commitTag(currentInput, tag)) {
        insertedCount += 1;
      }
    }

    return {
      ok: true,
      insertedCount,
      requestedCount: normalizedTags.length,
      frameUrl: location.href,
      diagnostics: collectTagDiagnostics(),
    };
  } catch (error) {
    return {
      ok: false,
      insertedCount: 0,
      error: error.message,
      frameUrl: location.href,
      diagnostics: collectTagDiagnostics(),
    };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function ensureTagInputReady(fallbackInput = null) {
    let input = findExactTagInput() || findTagInput();

    if (!input) {
      await ensurePublishLayerOpen();
      input = await waitForTagInput(4200);
    }

    if (!input) {
      input = await openTagInputArea() || fallbackInput;
    }

    if (!input) {
      return null;
    }

    await focusTagInput(input);
    return findTagInput() || input;
  }

  async function ensurePublishLayerOpen() {
    if (isPublishLayerReady()) {
      return true;
    }

    const publishButton = findPublishLayerButton();

    if (!publishButton) {
      return false;
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      clickElement(publishButton);
      await sleep(220 + (attempt * 160));

      if (await waitForPublishLayerReady(2200 + (attempt * 700))) {
        return true;
      }
    }

    return false;
  }

  async function waitForPublishLayerReady(timeoutMs = 2500) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (isPublishLayerReady()) {
        return true;
      }

      await sleep(100);
    }

    return false;
  }

  async function waitForTagInput(timeoutMs = 1200) {
    const startedAt = Date.now();
    let attempts = 0;

    while (Date.now() - startedAt < timeoutMs) {
      const input = findExactTagInput() || findTagInput();

      if (input) {
        return input;
      }

      if (attempts % 3 === 0) {
        revealTagSection();
      }

      attempts += 1;

      await sleep(90);
    }

    return null;
  }

  function findPublishLayerButton() {
    const selectors = [
      'button[data-click-area="tpb.publish"]',
      'button.publish_btn__m9KHH',
      '.publish_btn_area__KjA2i button[type="button"]',
      '[data-focus-lock="publishLayer"] > button[type="button"]',
    ];

    return collectElements(selectors)
      .filter(isVisible)
      .find((element) => /발행/.test(normalizeText(element.textContent || element.getAttribute("aria-label") || ""))) || null;
  }

  async function openTagInputArea() {
    const publishTagInput = findExactTagInput() || findTagInput();

    if (publishTagInput) {
      return publishTagInput;
    }

    revealTagSection();

    const tagArea = findVisibleTagArea();

    if (tagArea) {
      clickElement(tagArea);
      const readyInput = await waitForTagInput(1200);
      if (readyInput) {
        return readyInput;
      }
    }

    const opener = findVisibleTagOpeners()[0] || null;

    if (opener) {
      clickElement(opener);
      return await waitForTagInput(1200);
    }

    const fakeInputTarget = findFakeTagActivationTarget();

    if (fakeInputTarget) {
      clickElement(fakeInputTarget);
      await sleep(180);
      const activatedInput = findExactTagInput() || findTagInput();

      if (activatedInput) {
        return activatedInput;
      }

      const fallbackInput = findFakeTagInput();

      if (fallbackInput) {
        return fallbackInput;
      }

      return await waitForTagInput(1200);
    }

    return findExactTagInput() || findTagInput();
  }

  function findExactTagInput() {
    return collectTagLayerElements([
      '#tag-input',
      '.option_tag__M5E_f #tag-input',
      '.option_tag__M5E_f input#tag-input',
      '.option_tag__M5E_f input[data-click-area="tpb*i.tag"]',
      '.WritingTag input.tag_input',
      'input.tag_input[placeholder*="태그"]',
    ]).find((element) => {
      if (!element || String(element.id || '') === 'fake-input') {
        return false;
      }

      return isTagInputVisible(element);
    }) || null;
  }

  function findFakeTagInput() {
    const scopedFakeInput = collectTagLayerElements([
      '#fake-input',
      '.option_tag__M5E_f #fake-input',
      '.option_tag__M5E_f .fake_input__Y86t_',
    ])[0];

    if (scopedFakeInput) {
      return scopedFakeInput;
    }

    return collectElements([
      '.option_tag__M5E_f #fake-input',
      '.option_tag__M5E_f .fake_input__Y86t_',
    ])[0] || null;
  }

  function findTagInput() {
    const preferredSelectors = [
      '#tag-input',
      '.option_tag__M5E_f #tag-input',
      '.option_tag__M5E_f .tag_input__rvUB5',
      '.option_tag__M5E_f input[data-click-area="tpb*i.tag"]',
    ];
    const selectors = [
      "input[placeholder*='태그']",
      "textarea[placeholder*='태그']",
      "input[aria-label*='태그']",
      "textarea[aria-label*='태그']",
      "input[data-placeholder*='태그']",
      "textarea[data-placeholder*='태그']",
      "input[placeholder*='해시']",
      "input[aria-label*='해시']",
      "input[placeholder*='키워드']",
      "input[aria-label*='키워드']",
      "[contenteditable='true'][aria-label*='태그']",
      "[contenteditable='true'][data-placeholder*='태그']",
      "[role='textbox'][aria-label*='태그']",
      "[id*='tag'] input",
      "[class*='tag'] input",
      "[id*='keyword'] input",
      "[class*='keyword'] input",
      "input[id*='tag']",
      "input[class*='tag']",
      "input[id*='keyword']",
      "input[class*='keyword']",
      "[contenteditable='true'][id*='tag']",
      "[contenteditable='true'][class*='tag']",
    ];

    const preferredInput = collectTagLayerElements(preferredSelectors)
      .filter((element) => String(element.id || '') !== 'fake-input')
      .filter(isTagInputVisible)
      .map((element) => ({ element, score: 400 + scoreTagInputCandidate(element) }))
      .sort((left, right) => right.score - left.score)[0]?.element;

    if (preferredInput) {
      return preferredInput;
    }

    return collectTagLayerElements(selectors)
      .filter((element) => String(element.id || '') !== 'fake-input')
      .filter((element) => element.getAttribute('aria-hidden') !== 'true')
      .filter((element) => Number(element.tabIndex) >= 0 || !String(element.id || '').includes('fake'))
      .filter(isTagInputVisible)
      .map((element) => ({ element, score: scoreTagInputCandidate(element) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)[0]?.element || null;
  }

  function isPublishLayerVisible() {
    return Boolean(collectElements([
      '.layer_publish__vA9PX',
      '.layer_popup__i0QOY.is_show__TMSLq',
      '.layer_popup__i0QOY .layer_publish__vA9PX',
      '[data-focus-lock="publishLayer"] .layer_publish__vA9PX',
      '.option_tag__M5E_f',
    ]).find(isVisible));
  }

  function isPublishLayerReady() {
    return Boolean(findExactTagInput() || findVisibleTagArea() || findVisiblePublishConfirmButton());
  }

  function findVisiblePublishConfirmButton() {
    return collectElementsWithin(getPublishLayerSearchRoots(true), [
      'button[data-testid="seOnePublishBtn"]',
      'button[data-click-area="tpb*i.publish"]',
      '.layer_btn_area__UzyKH button[type="button"]',
    ]).filter(isVisible)
      .find((element) => /발행/.test(normalizeText(element.textContent || element.getAttribute('aria-label') || ''))) || null;
  }

  function findVisibleTagArea() {
    return collectTagLayerElements([
      '.option_tag__M5E_f .tag_textarea__CD7pC',
      '.option_tag__M5E_f .tag_area__V1MvI',
      '.option_tag__M5E_f',
    ]).find(isVisible) || null;
  }

  function isTagInputVisible(element) {
    if (!element) {
      return false;
    }

    if (String(element.id || '') === 'fake-input') {
      return Boolean(element.closest('.option_tag__M5E_f, .tag_textarea__CD7pC, .tag_area__V1MvI'));
    }

    if (isVisible(element)) {
      return true;
    }

    return Boolean([
      element.closest('.tag_input_wrap__zQUUR'),
      element.closest('.tag_textarea__CD7pC'),
      element.closest('.tag_area__V1MvI'),
      element.closest('.option_tag__M5E_f'),
    ].find(isVisible));
  }

  function findVisibleTagOpeners() {
    const candidates = collectElementsWithin(getPublishLayerSearchRoots(true), ['button', '[role="button"]', 'summary', 'label', 'strong']);

    return candidates
      .filter(isVisible)
      .filter((element) => {
        const label = getTagLabelText(element);
        return label.length <= 18 && /(태그|해시태그|키워드|hash ?tag|keyword)/i.test(label);
      });
  }

  function revealTagSection() {
    scrollPublishLayerForTagSection();

    const tagSection = findTagSectionContainer();

    if (tagSection) {
      tagSection.scrollIntoView({ block: 'center', inline: 'nearest' });
    }

    const fakeInputTarget = findFakeTagActivationTarget();

    if (fakeInputTarget) {
      clickElement(fakeInputTarget);
    }

    if (tagSection && !findVisibleTagArea()) {
      clickElement(tagSection);
    }
  }

  function scrollPublishLayerForTagSection() {
    const scrollContainer = findPublishLayerScrollContainer();
    const tagSection = findTagSectionContainer();

    if (!scrollContainer) {
      return false;
    }

    if (tagSection) {
      try {
        const containerRect = scrollContainer.getBoundingClientRect();
        const sectionRect = tagSection.getBoundingClientRect();
        scrollContainer.scrollTop += sectionRect.top - containerRect.top - 48;
      } catch {
        // Ignore scroll position failures.
      }
    } else {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }

    scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
    return true;
  }

  function findTagSectionContainer() {
    return collectTagLayerElements([
      '.option_tag__M5E_f',
      '.option_tag__M5E_f .set_option_detail__gvcHR',
      '.option_tag__M5E_f .tag_area__V1MvI',
      '.option_tag__M5E_f .tag_textarea__CD7pC',
    ])[0] || null;
  }

  function findFakeTagActivationTarget() {
    const fakeInput = findFakeTagInput();

    return fakeInput?.closest('.tag_textarea__CD7pC, .tag_area__V1MvI, .option_tag__M5E_f') || null;
  }

  function findPublishLayerScrollContainer() {
    return collectElementsWithin(getPublishLayerSearchRoots(false), [
      '.layer_content_set_publish__KDvaV',
      '.layer_publish__vA9PX',
      '.layer_popup__i0QOY.is_show__TMSLq',
    ]).find((element) => element.scrollHeight > element.clientHeight + 20) || null;
  }

  function getPublishLayerSearchRoots(includeDocumentFallback = false) {
    const roots = [];
    const publishLayer = findVisiblePublishLayerContainer();
    const publishContent = publishLayer?.querySelector('.layer_content_set_publish__KDvaV') || null;
    const publishInnerLayer = publishLayer?.querySelector('.layer_publish__vA9PX') || null;

    if (publishContent) {
      roots.push(publishContent);
    }
    if (publishInnerLayer && !roots.includes(publishInnerLayer)) {
      roots.push(publishInnerLayer);
    }
    if (publishLayer && !roots.includes(publishLayer)) {
      roots.push(publishLayer);
    }
    if (!roots.length || includeDocumentFallback) {
      roots.push(document);
    }

    return roots;
  }

  function collectTagLayerElements(selectors) {
    const roots = getPublishLayerSearchRoots(false);
    return collectElementsWithin(roots.length ? roots : [document], selectors);
  }

  function collectElementsWithin(roots, selectors) {
    const rootList = Array.isArray(roots) ? roots : [];
    const selectorList = Array.isArray(selectors) ? selectors : [];
    const seen = new Set();
    const elements = [];

    for (const root of rootList) {
      if (!root?.querySelectorAll) {
        continue;
      }

      for (const selector of selectorList) {
        for (const element of root.querySelectorAll(selector)) {
          if (!seen.has(element)) {
            seen.add(element);
            elements.push(element);
          }
        }
      }
    }

    return elements;
  }

  function scoreTagInputCandidate(element) {
    const label = getTagLabelText(element);
    const rect = element.getBoundingClientRect();
    let score = 0;

    if (/(태그|해시태그|hash ?tag)/i.test(label)) {
      score += 110;
    }
    if (/(키워드|keyword)/i.test(label)) {
      score += 70;
    }
    if (/tag|keyword|hash/i.test(element.id || "")) {
      score += 40;
    }
    if (/tag|keyword|hash/i.test(String(element.className || ""))) {
      score += 35;
    }
    if (element.matches('input, textarea')) {
      score += 20;
    }
    if (element.isContentEditable || element.getAttribute('role') === 'textbox') {
      score += 14;
    }
    if (rect.width > 140) {
      score += 10;
    }
    if (rect.height >= 20 && rect.height <= 80) {
      score += 8;
    }
    if (/(제목|본문|content|body|paragraph)/i.test(label)) {
      score -= 140;
    }

    return score;
  }

  function getTagLabelText(element) {
    const parts = [
      element.getAttribute('placeholder'),
      element.getAttribute('aria-label'),
      element.getAttribute('data-placeholder'),
      element.getAttribute('title'),
      element.id,
      element.className,
      element.textContent,
      element.parentElement?.textContent,
      element.closest('label, div, li, section, article, form')?.textContent,
    ];

    return normalizeText(parts.filter(Boolean).join(' '));
  }

  async function commitTag(element, tag) {
    const target = element.closest('rich-textarea') || element;
    const container = target.closest('label, div, li, section, article, form') || target.parentElement || target;
    const before = getTagContainerSnapshot(container, target);
    const beforeValue = normalizeText(readTagValue(target)).replace(/,$/, '');

    await focusTagInput(target);

    if (normalizeText(readTagValue(target))) {
      clearTagValue(target);
      await sleep(70);
      await focusTagInput(target);
    }

    await typeTagValue(target, tag);
    return finalizeTag(target, container, before, beforeValue, 'Enter');
  }

  async function typeTagValue(element, value) {
    const safeValue = String(value || '').replace(/^#/, '').trim();

    if (!safeValue) {
      return;
    }

    for (const chunk of buildTagTypingChunks(safeValue)) {
      appendTagChunk(element, chunk);
      await sleep(getTagTypingDelay(chunk, safeValue.length));
    }

    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function finalizeTag(target, container, before, beforeValue, key) {
    dispatchKeyboardSequence(target, key);
    blurIfPossible(target);
    const after = getTagContainerSnapshot(container, target);
    const currentValue = normalizeText(readTagValue(target)).replace(/,$/, '');

    return after !== before
      || !currentValue
      || currentValue !== beforeValue;
  }

  function clearTagValue(element) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      setNativeValue(element, '');
      element.setAttribute('value', '');
      dispatchTagInputEvents(element, '', 'deleteContentBackward', true);
      return;
    }

    if (element.isContentEditable || element.getAttribute('role') === 'textbox') {
      const selection = getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand('delete', false);
      element.textContent = '';
      dispatchTagInputEvents(element, '', 'deleteContentBackward', true);
      return;
    }

    element.textContent = '';
    dispatchTagInputEvents(element, '', 'deleteContentBackward', true);
  }

  function appendTagChunk(element, value) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      dispatchCharacterKeyboardSequence(element, value);
      const nextValue = `${element.value || ''}${value}`;
      setNativeValue(element, nextValue);
      element.setAttribute('value', nextValue);
      dispatchTagInputEvents(element, value, 'insertText');
      return;
    }

    if (element.isContentEditable || element.getAttribute('role') === 'textbox') {
      dispatchCharacterKeyboardSequence(element, value);
      const selection = getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);

      let inserted = false;

      try {
        inserted = document.execCommand('insertText', false, value);
      } catch {
        inserted = false;
      }

      if (!inserted) {
        element.textContent = `${element.textContent || ''}${value}`;
      }

      dispatchTagInputEvents(element, value, 'insertText');

      return;
    }

    element.textContent = `${element.textContent || ''}${value}`;
    dispatchTagInputEvents(element, value, 'insertText');
  }

  function readTagValue(element) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return element.value || '';
    }

    return element.innerText || element.textContent || '';
  }

  function dispatchTagInputEvents(element, value, inputType = 'insertText', emitChange = false) {
    try {
      element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, data: value, inputType }));
    } catch {
      // Ignore browsers without beforeinput support.
    }

    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType }));

    if (emitChange) {
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function buildTagTypingChunks(text) {
    const safeText = String(text || '');
    const chunks = [];

    for (let index = 0; index < safeText.length; index += 1) {
      chunks.push(safeText[index]);
    }

    return chunks;
  }

  function getTagTypingDelay(chunk, totalLength) {
    const baseDelay = totalLength > 10 ? 34 : 44;
    return baseDelay + Math.floor(Math.random() * Math.max(12, chunk.length * 6));
  }

  async function focusTagInput(element) {
    const exactInput = findExactTagInput() || element;
    const fakeInput = findFakeTagInput();
    const tagArea = exactInput.closest('.tag_textarea__CD7pC, .tag_area__V1MvI, .option_tag__M5E_f');
    const clickableTarget = exactInput.closest('.tag_input_wrap__zQUUR') || exactInput;

    (tagArea || clickableTarget).scrollIntoView({ block: 'center', inline: 'nearest' });

    if (exactInput !== fakeInput) {
      fakeInput?.blur?.();
    }

    if (tagArea) {
      clickElement(tagArea);
      await sleep(80);
    }

    clickElement(clickableTarget);

    if (clickableTarget !== exactInput) {
      clickElement(exactInput);
    }

    exactInput.focus();
    exactInput.dispatchEvent(new Event('focus', { bubbles: false }));
    exactInput.dispatchEvent(new Event('focusin', { bubbles: true }));

    if (exactInput instanceof HTMLInputElement || exactInput instanceof HTMLTextAreaElement) {
      const length = String(exactInput.value || '').length;
      try {
        exactInput.setSelectionRange(length, length);
      } catch {
        // Ignore selection errors.
      }
    }

    await sleep(120);

    if (document.activeElement !== exactInput) {
      clickElement(exactInput);
      exactInput.focus();

      if (exactInput instanceof HTMLInputElement || exactInput instanceof HTMLTextAreaElement) {
        const length = String(exactInput.value || '').length;
        try {
          exactInput.setSelectionRange(length, length);
        } catch {
          // Ignore selection errors.
        }
      }

      await sleep(120);
    }
  }

  function clickElement(element) {
    const options = { bubbles: true, cancelable: true, view: window };

    try {
      element.dispatchEvent(new PointerEvent('pointerdown', options));
      element.dispatchEvent(new MouseEvent('mousedown', options));
      element.dispatchEvent(new PointerEvent('pointerup', options));
      element.dispatchEvent(new MouseEvent('mouseup', options));
    } catch {
      // Ignore PointerEvent constructor failures.
    }

    element.click?.();
  }

  function dispatchCharacterKeyboardSequence(element, value) {
    const text = String(value || '');

    for (const character of text) {
      const isSpace = character === ' ';
      const keyCode = isSpace ? 32 : (character.toUpperCase().charCodeAt(0) || 0);
      const options = {
        bubbles: true,
        cancelable: true,
        key: character,
        code: isSpace ? 'Space' : '',
        keyCode,
        which: keyCode,
      };

      element.dispatchEvent(new KeyboardEvent('keydown', options));
      element.dispatchEvent(new KeyboardEvent('keypress', options));
      element.dispatchEvent(new KeyboardEvent('keyup', options));
    }
  }

  function collectTagDiagnostics() {
    const activeElement = document.activeElement;
    const exactTagInput = findExactTagInput();
    const publishButton = findPublishLayerButton();
    const publishConfirmButton = findVisiblePublishConfirmButton();
    const tagArea = findVisibleTagArea();
    const publishLayer = findVisiblePublishLayerContainer();
    const fakeTagInput = findFakeTagInput();
    const tagSection = findTagSectionContainer();
    const publishScrollContainer = findPublishLayerScrollContainer();

    return {
      href: location.href,
      publishLayerVisible: isPublishLayerVisible(),
      publishLayerReady: isPublishLayerReady(),
      tagSectionFound: Boolean(tagSection),
      tagAreaVisible: Boolean(tagArea),
      exactTagInputFound: Boolean(exactTagInput),
      fakeTagInputFound: Boolean(fakeTagInput),
      tagInputFound: Boolean(findTagInput()),
      activeElementIsTagInput: Boolean(exactTagInput && activeElement === exactTagInput),
      publishLayerSearchRootCount: getPublishLayerSearchRoots(false).length,
      publishScrollTop: Number(publishScrollContainer?.scrollTop || 0),
      publishScrollHeight: Number(publishScrollContainer?.scrollHeight || 0),
      publishClientHeight: Number(publishScrollContainer?.clientHeight || 0),
      publishButtonFound: Boolean(publishButton),
      publishButtonExpanded: publishButton?.getAttribute('aria-expanded') || '',
      publishConfirmFound: Boolean(publishConfirmButton),
      activeElementTag: String(activeElement?.tagName || '').toLowerCase(),
      activeElementId: String(activeElement?.id || ''),
      activeElementClass: String(activeElement?.className || ''),
      activeElementHtml: getElementHtmlPreview(activeElement),
      publishButtonHtml: getElementHtmlPreview(publishButton),
      publishConfirmHtml: getElementHtmlPreview(publishConfirmButton),
      publishLayerHtml: getElementHtmlPreview(publishLayer),
      tagSectionHtml: getElementHtmlPreview(tagSection),
      tagAreaHtml: getElementHtmlPreview(tagArea),
      exactTagInputHtml: getElementHtmlPreview(exactTagInput),
      fakeTagInputHtml: getElementHtmlPreview(fakeTagInput),
    };
  }

  function findVisiblePublishLayerContainer() {
    return collectElements([
      '.layer_popup__i0QOY.is_show__TMSLq',
      '[data-focus-lock="publishLayer"] .layer_popup__i0QOY',
      '.layer_publish__vA9PX',
    ]).find(isVisible) || null;
  }

  function getElementHtmlPreview(element) {
    if (!element || typeof element.outerHTML !== 'string') {
      return '';
    }

    return element.outerHTML
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 600);
  }

  function getTypingDelay(chunk, totalLength) {
    const baseDelay = totalLength > 18 ? 18 : 26;
    return baseDelay + Math.floor(Math.random() * Math.max(10, chunk.length * 4));
  }

  function dispatchKeyboardSequence(element, key) {
    const keyCode = key === 'Tab' ? 9 : 13;
    const options = {
      bubbles: true,
      cancelable: true,
      key,
      code: key === 'Tab' ? 'Tab' : 'Enter',
      keyCode,
      which: keyCode,
    };

    element.dispatchEvent(new KeyboardEvent('keydown', options));
    element.dispatchEvent(new KeyboardEvent('keypress', options));
    element.dispatchEvent(new KeyboardEvent('keyup', options));
  }

  function getTagContainerSnapshot(container, target) {
    return [
      normalizeText(container?.textContent || ''),
      container?.childElementCount || 0,
      normalizeText(readTagValue(target)),
    ].join('|');
  }

  function blurIfPossible(element) {
    try {
      element.blur?.();
    } catch {
      // Ignore blur failures.
    }
  }

  function setNativeValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
      || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
      || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');

    if (descriptor?.set) {
      descriptor.set.call(element, value);
      return;
    }

    element.value = value;
  }

  function collectElements(selectors) {
    const seen = new Set();
    const elements = [];

    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!seen.has(element)) {
          seen.add(element);
          elements.push(element);
        }
      }
    }

    return elements;
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }
}

function isDebugLogMessage(message) {
  return ["NB_ADD_DEBUG_LOG", "NB_GET_DEBUG_LOG", "NB_CLEAR_DEBUG_LOG"].includes(String(message?.type || ""));
}

function summarizeSender(sender) {
  return {
    id: sender?.id || "",
    tabId: sender?.tab?.id || null,
    frameId: Number.isFinite(sender?.frameId) ? sender.frameId : null,
    url: summarizeTextForLog(sender?.tab?.url || "", 220),
  };
}

function summarizeMessageForLog(message) {
  const type = String(message?.type || "");

  switch (type) {
    case "NB_OPEN_AI":
      return {
        provider: resolveAiProviderValue(message?.provider),
      };
    case "NB_SUBMIT_AI":
    case "NB_SUBMIT_GEMINI":
      return {
        provider: resolveAiProviderValue(message?.provider),
        promptLength: String(message?.prompt || "").length,
        promptPreview: summarizeTextForLog(message?.prompt || "", 180),
        options: sanitizeLogValue(message?.options),
      };
    case "NB_INSERT_POST":
      return {
        tabId: message?.tabId || null,
        payload: summarizePostPayloadForLog(message?.payload),
      };
    case "NB_FETCH_IMAGE_AS_DATA_URL":
      return {
        url: summarizeUrlForLog(message?.url || ""),
      };
    case "NB_SEARCH_GOOGLE_IMAGES":
      return {
        queryLength: String(message?.query || "").length,
        queryPreview: summarizeTextForLog(message?.query || "", 180),
        maxResults: Number(message?.maxResults || 0) || null,
      };
    case "NB_COLLECT_NAVER_BLOG_SEARCH_RESEARCH":
      return {
        keywordLength: String(message?.keyword || "").length,
        keywordPreview: summarizeTextForLog(message?.keyword || "", 180),
        maxResults: Number(message?.maxResults || 0) || null,
      };
    case "FREE_PASS_ISSUED":
      return {
        hasDeviceId: Boolean(String(message?.deviceId || "").trim()),
      };
    case "NB_CALL_GAS_BACKEND":
      return {
        action: String(message?.request?.action || ""),
        hasLicenseKey: Boolean(String(message?.request?.licenseKey || "").trim()),
        hasDeviceId: Boolean(String(message?.request?.deviceId || "").trim()),
        hasPayload: Boolean(message?.request?.payload && typeof message.request.payload === "object"),
      };
    default:
      return sanitizeLogValue(message);
  }
}

function summarizeResultForLog(type, result) {
  const safeType = String(type || "");

  switch (safeType) {
    case "NB_OPEN_AI":
      return {
        provider: resolveAiProviderValue(result?.provider),
        aiTabId: result?.aiTabId || null,
      };
    case "NB_SUBMIT_AI":
    case "NB_SUBMIT_GEMINI":
      return {
        provider: resolveAiProviderValue(result?.provider),
        aiTabId: result?.aiTabId || result?.geminiTabId || null,
        textLength: String(result?.response?.text || "").length,
        imageCount: Array.isArray(result?.response?.images) ? result.response.images.length : 0,
      };
    case "NB_INSERT_POST":
      return sanitizeLogValue(result?.insertion);
    case "NB_SEARCH_GOOGLE_IMAGES":
      return {
        imageCount: Array.isArray(result?.images) ? result.images.length : 0,
        candidateCount: Array.isArray(result?.candidates) ? result.candidates.length : 0,
      };
    case "NB_COLLECT_NAVER_BLOG_SEARCH_RESEARCH":
      return {
        keywordPreview: summarizeTextForLog(result?.research?.keyword || "", 180),
        collectionMethod: String(result?.research?.collectionMethod || ""),
        referenceCount: Array.isArray(result?.research?.references) ? result.research.references.length : 0,
        fullContentCount: Number(result?.research?.fullContentCount || 0),
        relatedKeywordCount: Array.isArray(result?.research?.relatedKeywords) ? result.research.relatedKeywords.length : 0,
      };
    case "NB_CALL_GAS_BACKEND":
      return {
        backendOk: Boolean(result?.gasResponse?.ok),
        valid: Boolean(result?.gasResponse?.data?.valid),
        authType: String(result?.gasResponse?.data?.authType || ""),
        hasFinalPrompt: Boolean(result?.gasResponse?.data?.finalPrompt),
      };
    default:
      return sanitizeLogValue(result);
  }
}

function summarizePostPayloadForLog(payload) {
  return {
    titlePreview: summarizeTextForLog(payload?.title || "", 120),
    htmlLength: String(payload?.html || "").length,
    textLength: String(payload?.text || "").length,
    tagCount: Array.isArray(payload?.tags) ? payload.tags.length : 0,
    imageCount: Array.isArray(payload?.images) ? payload.images.length : 0,
  };
}

function summarizeUrlForLog(url) {
  try {
    const parsed = new URL(String(url || ""));
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return summarizeTextForLog(url || "", 220);
  }
}

function summarizeTextForLog(value, maxLength = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}... (${text.length} chars)`;
}

function sanitizeLogValue(value, depth = 0) {
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return summarizeTextForLog(value, 240);
  }

  if (depth >= 3) {
    return "[max-depth]";
  }

  if (Array.isArray(value)) {
    return value.slice(0, 10).map((entry) => sanitizeLogValue(entry, depth + 1));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 20)
        .map(([key, entryValue]) => [key, sanitizeLogValue(entryValue, depth + 1)])
    );
  }

  return summarizeTextForLog(String(value), 240);
}

function enqueueDebugLogMutation(task) {
  const scheduled = debugLogWriteQueue.then(task, task);
  debugLogWriteQueue = scheduled.catch(() => {});
  return scheduled;
}

async function readStoredDebugLogEntries() {
  const stored = await chrome.storage.local.get(DEBUG_LOG_KEY);
  const entries = stored[DEBUG_LOG_KEY];
  return Array.isArray(entries) ? entries : [];
}

async function appendDebugLogEntry(source, event, details = {}) {
  return enqueueDebugLogMutation(async () => {
    const entries = await readStoredDebugLogEntries();
    entries.push({
      timestamp: new Date().toISOString(),
      source: String(source || "unknown"),
      event: String(event || "event"),
      details: sanitizeLogValue(details),
    });

    await chrome.storage.local.set({
      [DEBUG_LOG_KEY]: entries.slice(-DEBUG_LOG_LIMIT),
    });
  });
}

function appendBackgroundDebugLog(event, details = {}) {
  return appendDebugLogEntry("background", event, details);
}

async function getDebugLogEntries() {
  await debugLogWriteQueue;
  return readStoredDebugLogEntries();
}

async function clearDebugLogEntries() {
  return enqueueDebugLogMutation(async () => {
    await chrome.storage.local.set({ [DEBUG_LOG_KEY]: [] });
  });
}

function formatDebugLogEntries(entries) {
  const safeEntries = Array.isArray(entries) ? entries : [];

  if (!safeEntries.length) {
    return "No log entries captured.";
  }

  return safeEntries.map((entry, index) => {
    const header = `${index + 1}. ${entry.timestamp || ""} [${entry.source || "unknown"}] ${entry.event || ""}`;
    const details = entry?.details && Object.keys(entry.details).length
      ? JSON.stringify(entry.details, null, 2)
      : "{}";
    return `${header}\n${details}`;
  }).join("\n\n");
}

function detectNaverPublishTagFrame() {
  const publishButton = collectElements([
    'button[data-click-area="tpb.publish"]',
    'button.publish_btn__m9KHH',
    '[data-focus-lock="publishLayer"] > button[type="button"]',
    '.publish_btn_area__KjA2i button[type="button"]',
  ]).find(isVisible) || null;
  const tagArea = collectElements([
    '.option_tag__M5E_f',
    '.option_tag__M5E_f .tag_area__V1MvI',
    '.option_tag__M5E_f .tag_textarea__CD7pC',
    '.layer_publish__vA9PX .option_tag__M5E_f',
    '.WritingTag',
    '.WritingTag .tag_input_box',
  ]).find(isVisible) || null;
  const tagInput = collectElements([
    '#tag-input',
    '.option_tag__M5E_f #tag-input',
    '.option_tag__M5E_f .tag_input__rvUB5',
    '.option_tag__M5E_f input[data-click-area="tpb*i.tag"]',
    '.WritingTag input.tag_input',
    'input.tag_input[placeholder*="태그"]',
  ]).find((element) => isVisible(element) || isVisible(element.closest('.tag_input_wrap__zQUUR, .tag_textarea__CD7pC, .tag_area__V1MvI, .option_tag__M5E_f'))) || null;
  const publishLayer = collectElements([
    '.layer_publish__vA9PX',
    '.layer_popup__i0QOY .layer_publish__vA9PX',
    '[data-focus-lock="publishLayer"] .layer_publish__vA9PX',
  ]).find(isVisible) || null;
  let score = 0;

  if (publishButton) {
    score += 120;
  }
  if (publishLayer) {
    score += 160;
  }
  if (tagArea) {
    score += 220;
  }
  if (tagInput) {
    score += 320;
  }
  if (/PostWriteForm|blog\.naver\.com|cafe\.naver\.com\/ca-fe\/cafes\/\d+\/(?:menus\/\d+\/)?articles\/write/i.test(location.href)) {
    score += 25;
  }

  return {
    score,
    href: location.href,
    publishButtonFound: Boolean(publishButton),
    publishLayerVisible: Boolean(publishLayer),
    tagAreaFound: Boolean(tagArea),
    tagInputFound: Boolean(tagInput),
  };

  function collectElements(selectors) {
    const seen = new Set();
    const elements = [];

    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!seen.has(element)) {
          seen.add(element);
          elements.push(element);
        }
      }
    }

    return elements;
  }

  function isVisible(element) {
    if (!element) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }
}
