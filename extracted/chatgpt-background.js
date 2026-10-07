// 딸깍(ddalkkak-extracted/background.js)의 ChatGPT DOM 관련 소스를 그대로 가져옴.
// 아래 함수 본문은 원본 줄을 잘라 붙인 것이며 수정하지 않았다.
// 원본 handleMessage의 NB_CHATGPT_PHASE / NB_FETCH_IMAGE_AS_DATA_URL / NB_ADD_DEBUG_LOG 처리만 별도 리스너로 연결.

const CHATGPT_URL = "https://chatgpt.com/";
const TAB_COMPLETE_TIMEOUT_MS = 60000;
const DEBUG_LOG_KEY = "naverBlogGeminiAssistantDebugLog";
const DEBUG_LOG_LIMIT = 400;

let debugLogWriteQueue = Promise.resolve();
const chatGptSubmissionPhases = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!["NB_CHATGPT_PHASE", "NB_FETCH_IMAGE_AS_DATA_URL", "NB_ADD_DEBUG_LOG"].includes(message?.type)) return false;
  void handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
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
  let result;

  switch (message?.type) {
    case "NB_FETCH_IMAGE_AS_DATA_URL": {
      const dataUrl = await fetchRemoteImageAsDataUrl(message.url);
      result = { dataUrl };
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
  }

  return result;
}

async function windowExists(windowId) {
  if (!windowId) return false;
  try {
    const win = await chrome.windows.get(windowId);
    return Boolean(win?.id);
  } catch {
    return false;
  }
}

async function getLastFocusedWindowSafe() {
  try {
    return await chrome.windows.getLastFocused();
  } catch {
    return null;
  }
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

async function getTabSafely(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
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


function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export { runChatGptPromptInPopup };
