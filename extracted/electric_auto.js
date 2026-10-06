// 전기수리 저경쟁 키워드 자동 발행 모듈
// background.js(서비스워커)에서 import만 해서 불러온다. 기존 코드는 건드리지 않고
// 별도의 chrome.runtime.onMessage 리스너를 추가로 등록하는 방식으로 동작한다.

const SETTINGS_KEY = "electricAutoSettings";
const STATE_KEY = "electricAutoState";
const ALARM_NAME = "electricAutoPostAlarm";

function defaultSettings() {
  return {
    mainKeyword: "전기수리",
    wpSiteUrl: "https://24elecspeed.com",
    wpUsername: "",
    wpAppPassword: "",
    postsPerDay: 1,
    windowStartHour: 9,
    windowEndHour: 21,
    // 안전장치: 사용자가 명시적으로 "publish"로 바꾸기 전까지는 항상 임시글(draft)로만 올라간다.
    publishStatus: "draft"
  };
}

function defaultState() {
  return { isRunning: false, queue: [], doneToday: 0, lastRunDate: "", log: [], pendingDraft: null };
}

async function getSettings() {
  const { [SETTINGS_KEY]: s } = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...defaultSettings(), ...(s || {}) };
}

async function saveSettings(partial) {
  const next = { ...(await getSettings()), ...(partial || {}) };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

async function getState() {
  const { [STATE_KEY]: s } = await chrome.storage.local.get(STATE_KEY);
  return { ...defaultState(), ...(s || {}) };
}

async function saveState(partial) {
  const next = { ...(await getState()), ...(partial || {}) };
  await chrome.storage.local.set({ [STATE_KEY]: next });
  return next;
}

async function appendLog(line) {
  const state = await getState();
  const log = [...(state.log || []), `[${new Date().toLocaleString("ko-KR")}] ${line}`].slice(-100);
  return saveState({ log });
}

// ---- 1. 키워드 선정: 기존 "키워드 분석" 탭 결과(lastAnalysisState.analysis)에서 저경쟁 키워드 추출 ----
async function pickLowCompetitionKeywords(mainKeyword, count) {
  const { lastAnalysisState } = await chrome.storage.local.get("lastAnalysisState");
  const analysis = (lastAnalysisState && lastAnalysisState.analysis) || [];
  const kw = (mainKeyword || "전기수리").trim();
  const candidates = analysis.filter(item => item.keyword && item.keyword.includes(kw));
  const pool = candidates.length > 0 ? candidates : [];
  const competitionScore = c => (c === "낮음" ? 0 : c === "중간" ? 1 : 2);
  const sorted = [...pool].sort((a, b) => {
    const ca = competitionScore(a.competition);
    const cb = competitionScore(b.competition);
    if (ca !== cb) return ca - cb;
    const ra = parseFloat(a.competitionRatio);
    const rb = parseFloat(b.competitionRatio);
    return (isNaN(ra) ? 999 : ra) - (isNaN(rb) ? 999 : rb);
  });
  return sorted.slice(0, count);
}

// ---- 2. 키워드 -> WordPress case_type 슬러그 매칭 (사이트에 실제 있는 슬러그만 사용) ----
const WORK_TYPE_LABEL_SLUGS = [
  ["누전 차단기 내려감", "누전-차단기"], ["메인 차단기 내려감", "누전-차단기"],
  ["두꺼비집 안올라감", "두꺼비집-분전반"], ["콘센트 전기 안됨", "콘센트"],
  ["부분정전", "배선-정전"], ["누전 검사", "누전-차단기"], ["절연저항 검사", "누전-차단기"],
  ["전기배선수리", "배선-정전"], ["분전반 점검", "두꺼비집-분전반"],
  ["에어컨 차단기 문제", "누전-차단기"], ["전열 차단기 문제", "누전-차단기"],
  ["누전 수리", "누전-차단기"], ["차단기 교체", "누전-차단기"], ["분전반 교체", "두꺼비집-분전반"],
  ["정전 복구", "배선-정전"], ["콘센트 교체", "콘센트"], ["콘센트 증설", "콘센트"],
  ["스위치 교체", "콘센트"], ["조명 깜빡임", "배선-정전"], ["등기구·조명 교체", "배선-정전"],
  ["전등 안켜짐", "배선-정전"]
];

function matchCaseTypeSlug(keyword) {
  let best = WORK_TYPE_LABEL_SLUGS[0];
  let bestScore = 0;
  for (const pair of WORK_TYPE_LABEL_SLUGS) {
    let score = 0;
    for (const ch of pair[0]) if (keyword.includes(ch)) score++;
    if (score > bestScore) { bestScore = score; best = pair; }
  }
  return best[1];
}

// ---- 3-0. 경쟁 블로그 글 크롤링 (네이버 검색 상위 블로그 글 본문을 참고용으로 수집) ----
async function searchNaverBlogUrls(keyword, limit = 3) {
  try {
    const res = await fetch(`https://m.search.naver.com/search.naver?query=${encodeURIComponent(keyword)}`);
    const html = await res.text();
    const found = html.match(/https:\/\/blog\.naver\.com\/[a-zA-Z0-9_\-]+\/\d+/g) || [];
    return Array.from(new Set(found)).slice(0, limit);
  } catch (e) {
    return [];
  }
}

async function crawlReferenceArticles(keyword, limit = 3) {
  const urls = await searchNaverBlogUrls(keyword, limit);
  const refs = [];
  for (const url of urls) {
    try {
      const resp = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: "crawlSpecificArticle", url }, r => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve(r);
        });
      });
      if (resp && resp.success && resp.contentText) {
        refs.push({ url, text: resp.contentText.slice(0, 1500) });
      }
    } catch (e) {
      // 개별 글 크롤링 실패는 무시하고 계속 진행
    }
  }
  return refs;
}

// ---- 3. Gemini 웹 자동화로 글 생성 (기존 openAndAskGeminiWeb 메시지를 그대로 재사용) ----
function buildPrompt(keyword, references) {
  const refBlock =
    references && references.length
      ? `\n\n[참고용 경쟁 블로그 글 - 그대로 베끼지 말고, 어떤 내용을 다루는지 사실관계와 구성만 참고해서 더 정확하고 풍부하게 새로 작성하세요]\n` +
        references.map((r, i) => `--- 참고글 ${i + 1} ---\n${r.text}`).join("\n\n")
      : "";
  return `당신은 전기 수리 전문 블로그 작가입니다. "${keyword}" 키워드로 SEO에 최적화된 정보성 블로그 글을 작성해주세요.

요구사항:
- 분량: 1500~2000자
- 실제 출장 사례가 아니라, 일반적인 원인/증상/해결방법을 설명하는 정보성 글입니다.
- 특정 지역명·날짜·전화번호 등 실제 출장 정보는 절대 넣지 마세요.
- 아래 형식 그대로, 마커를 포함해서 출력하세요:
[제목]
(여기에 제목)
[본문]
(여기에 본문, ## 로 소제목 구분)
[요약]
(한 문장 요약, 메타설명용, 150자 이내)${refBlock}`;
}

function parseArticle(raw, keyword) {
  const text = String(raw || "");
  const titleMatch = text.match(/\[제목\]\s*([\s\S]*?)\s*\[본문\]/);
  const bodyMatch = text.match(/\[본문\]\s*([\s\S]*?)\s*\[요약\]/);
  const summaryMatch = text.match(/\[요약\]\s*([\s\S]*)$/);
  const title = (titleMatch ? titleMatch[1] : `${keyword} 원인과 해결방법`).trim();
  const bodyRaw = (bodyMatch ? bodyMatch[1] : text).trim();
  const summary = (summaryMatch ? summaryMatch[1] : "").trim().slice(0, 150);
  const html = bodyRaw
    .split("\n")
    .map(line => {
      const h2 = line.match(/^##\s+(.*)/);
      if (h2) return `<h2>${h2[1]}</h2>`;
      if (!line.trim()) return "";
      return `<p>${line}</p>`;
    })
    .filter(Boolean)
    .join("\n");
  return { title, html, summary, keyword };
}

// "AI 글쓰기" 탭이 실제로 쓰는 방식 그대로: Gemini REST API를 저장된 키로 직접 호출한다.
// (탭을 열어 DOM을 긁는 openAndAskGeminiWeb 경로는 "웹 질문" 버튼 전용이고, 버그도 있어서 쓰지 않는다.)
async function callGeminiApi(prompt, apiKey, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  if (!res.ok) {
    const bodyText = await res.text();
    const lower = bodyText.toLowerCase();
    if (res.status === 503 || res.status === 500 || lower.includes("overloaded")) {
      const err = new Error(`일시적인 API 오류 (${res.status})`);
      err.temporary = true;
      throw err;
    }
    if (res.status === 429 || lower.includes("quota") || lower.includes("billing")) {
      const err = new Error(`API 할당량 초과 (${res.status})`);
      err.quotaExceeded = true;
      throw err;
    }
    throw new Error(`Gemini API 호출 실패 (${res.status}): ${bodyText}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("AI 모델로부터 유효한 텍스트 응답을 받지 못했습니다.");
  return text;
}

async function generateArticleViaApi(keyword, references) {
  const prompt = buildPrompt(keyword, references);
  const { geminiApiKeys = [] } = await chrome.storage.local.get({ geminiApiKeys: [] });
  if (geminiApiKeys.length === 0) {
    throw new Error("Gemini API 키가 설정되어 있지 않습니다. '설정' 탭에서 먼저 저장해주세요.");
  }
  const { keywordAnalyzerSettings } = await chrome.storage.local.get("keywordAnalyzerSettings");
  const model = keywordAnalyzerSettings?.aiModel || "gemini-3.5-flash-lite";
  const { currentApiKeyIndex = 0 } = await chrome.storage.local.get("currentApiKeyIndex");

  let lastError = null;
  for (let i = 0; i < geminiApiKeys.length; i++) {
    const idx = (currentApiKeyIndex + i) % geminiApiKeys.length;
    try {
      const raw = await callGeminiApi(prompt, geminiApiKeys[idx], model);
      await chrome.storage.local.set({ currentApiKeyIndex: idx });
      return parseArticle(raw, keyword);
    } catch (e) {
      lastError = e;
      if (e.temporary) {
        await new Promise(r => setTimeout(r, 3000));
      }
      // quotaExceeded나 temporary면 다음 키로, 그 외 에러는 바로 중단
      if (!e.temporary && !e.quotaExceeded) throw e;
    }
  }
  throw lastError || new Error("모든 Gemini API 키에서 실패했습니다.");
}

// ---- 4. WordPress 발행 (featured_media는 절대 건드리지 않는다) ----
async function publishToWordPress(article, settings) {
  if (!settings.wpUsername || !settings.wpAppPassword) {
    throw new Error("설정 탭에서 워드프레스 계정/애플리케이션 비밀번호를 먼저 입력해주세요.");
  }
  const slug =
    article.title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 80) || `electric-${Date.now()}`;

  const auth = "Basic " + btoa(`${settings.wpUsername}:${settings.wpAppPassword.replace(/\s/g, "")}`);
  const base = settings.wpSiteUrl.replace(/\/$/, "");

  const dupCheck = await fetch(
    `${base}/wp-json/wp/v2/electric_case?slug=${encodeURIComponent(slug)}&status=publish,draft,pending,future,private`,
    { headers: { Authorization: auth } }
  ).then(r => (r.ok ? r.json() : []));
  if (Array.isArray(dupCheck) && dupCheck.length > 0) {
    throw new Error(`이미 같은 슬러그("${slug}")의 글이 존재합니다.`);
  }

  const caseTypeSlug = matchCaseTypeSlug(article.keyword);
  let caseTypeTermId = null;
  try {
    const termResp = await fetch(`${base}/wp-json/wp/v2/case_type?slug=${encodeURIComponent(caseTypeSlug)}`, {
      headers: { Authorization: auth }
    }).then(r => (r.ok ? r.json() : []));
    if (Array.isArray(termResp) && termResp[0]) caseTypeTermId = termResp[0].id;
  } catch (e) {
    // case_type 조회 실패해도 발행 자체는 계속 진행 (taxonomy 없이)
  }

  const body = {
    title: article.title,
    slug,
    content: article.html,
    excerpt: article.summary,
    status: settings.publishStatus === "publish" ? "publish" : "draft",
    meta: {
      _yoast_wpseo_title: article.title,
      _yoast_wpseo_metadesc: article.summary,
      _yoast_wpseo_focuskw: article.keyword
    }
  };
  if (caseTypeTermId) body.case_type = [caseTypeTermId];

  const res = await fetch(`${base}/wp-json/wp/v2/electric_case`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `워드프레스 발행 실패 (HTTP ${res.status})`);
  return { id: json.id, link: json.link, status: body.status };
}

// ---- 5. 전체 파이프라인 ----
// 5-1. 키워드 -> 크롤링 -> 글 생성까지만 (발행은 하지 않고 미리보기용으로 돌려준다)
async function generateDraft(keywordObj) {
  const keyword = keywordObj.keyword;
  const references = await crawlReferenceArticles(keyword, 3);
  const article = await generateArticleViaApi(keyword, references);
  return { ...article, referenceUrls: references.map(r => r.url) };
}

// 5-2. (자동발행 모드 전용) 크롤링->생성->발행까지 한 번에
async function runOnePost(keywordObj) {
  const settings = await getSettings();
  const article = await generateDraft(keywordObj);
  const result = await publishToWordPress(article, settings);
  return { keyword: article.keyword, title: article.title, ...result };
}

// ---- 6. 스케줄링 (9시~21시 사이 랜덤 시각) ----
function randomWhenInWindow(settings, dayOffset = 0) {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() + dayOffset);
  start.setHours(settings.windowStartHour, 0, 0, 0);
  const end = new Date(now);
  end.setDate(end.getDate() + dayOffset);
  end.setHours(settings.windowEndHour, 0, 0, 0);
  let base = now > start && dayOffset === 0 ? now : start;
  if (base >= end) return randomWhenInWindow(settings, dayOffset + 1);
  const span = end.getTime() - base.getTime();
  return base.getTime() + Math.random() * Math.max(span, 0);
}

async function scheduleNext() {
  const settings = await getSettings();
  const state = await getState();
  if (!state.isRunning) return;
  const today = new Date().toISOString().slice(0, 10);
  if (state.doneToday >= settings.postsPerDay) {
    const when = randomWhenInWindow(settings, state.lastRunDate === today ? 1 : 0);
    chrome.alarms.create(ALARM_NAME, { when });
    return;
  }
  chrome.alarms.create(ALARM_NAME, { when: randomWhenInWindow(settings, 0) });
}

async function runScheduledCycle() {
  let state = await getState();
  if (!state.isRunning) return;
  const settings = await getSettings();
  const today = new Date().toISOString().slice(0, 10);
  if (state.lastRunDate !== today) {
    state = await saveState({ doneToday: 0, lastRunDate: today, queue: [] });
  }
  if (!state.queue || state.queue.length === 0) {
    const keywords = await pickLowCompetitionKeywords(settings.mainKeyword, Math.max(settings.postsPerDay * 3, 10));
    if (keywords.length === 0) {
      await appendLog("대기 중인 저경쟁 키워드가 없습니다. '키워드 분석' 탭에서 전기수리 관련 분석을 먼저 실행해주세요.");
      await saveState({ isRunning: false });
      return;
    }
    state = await saveState({ queue: keywords });
  }
  const next = state.queue[0];
  try {
    const result = await runOnePost(next);
    await appendLog(`발행 완료: "${result.keyword}" → ${result.link} (${result.status})`);
    state = await saveState({ queue: state.queue.slice(1), doneToday: (state.doneToday || 0) + 1 });
  } catch (e) {
    await appendLog(`실패: "${next.keyword}" - ${e.message}`);
    state = await saveState({ queue: state.queue.slice(1) });
  }
  await scheduleNext();
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) runScheduledCycle();
});

// ---- 7. 팝업에서 호출하는 메시지 핸들러 ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.action) return false;

  switch (msg.action) {
    case "electricGetSettings":
      getSettings().then(data => sendResponse({ success: true, data }));
      return true;

    case "electricSaveSettings":
      saveSettings(msg.settings).then(data => sendResponse({ success: true, data }));
      return true;

    case "electricGetState":
      getState().then(data => sendResponse({ success: true, data }));
      return true;

    case "electricPreviewKeywords":
      getSettings()
        .then(settings => pickLowCompetitionKeywords(settings.mainKeyword, msg.count || 10))
        .then(data => sendResponse({ success: true, data }))
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;

    case "electricGenerateDraft":
      (async () => {
        try {
          const settings = await getSettings();
          const list = await pickLowCompetitionKeywords(settings.mainKeyword, 1);
          if (!list[0]) throw new Error("저경쟁 키워드를 찾지 못했습니다. 먼저 '키워드 분석' 탭에서 전기수리 키워드를 분석해주세요.");
          await appendLog(`"${list[0].keyword}" 경쟁글 크롤링 중...`);
          const draft = await generateDraft(list[0]);
          await saveState({ pendingDraft: draft });
          await appendLog(`초안 작성 완료: "${draft.title}" (참고글 ${draft.referenceUrls.length}개) - 미리보기를 확인하세요.`);
          sendResponse({ success: true, data: draft });
        } catch (e) {
          await appendLog(`초안 작성 실패: ${e.message}`);
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;

    case "electricPublishDraft":
      (async () => {
        try {
          const settings = await getSettings();
          const state = await getState();
          const draft = msg.article || state.pendingDraft;
          if (!draft) throw new Error("발행할 초안이 없습니다. 먼저 초안을 생성해주세요.");
          const result = await publishToWordPress(draft, settings);
          await appendLog(`발행 완료: "${draft.keyword}" → ${result.link} (${result.status})`);
          await saveState({ pendingDraft: null });
          sendResponse({ success: true, data: { keyword: draft.keyword, title: draft.title, ...result } });
        } catch (e) {
          await appendLog(`발행 실패: ${e.message}`);
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;

    case "electricStartAuto":
      (async () => {
        await saveState({
          isRunning: true,
          queue: [],
          doneToday: 0,
          lastRunDate: new Date().toISOString().slice(0, 10)
        });
        await appendLog("자동 발행 시작");
        await scheduleNext();
        sendResponse({ success: true });
      })();
      return true;

    case "electricStopAuto":
      (async () => {
        await chrome.alarms.clear(ALARM_NAME);
        await saveState({ isRunning: false });
        await appendLog("자동 발행 중지");
        sendResponse({ success: true });
      })();
      return true;

    default:
      return false;
  }
});
