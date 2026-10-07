// 전기수리 자동발행(electric_auto.js) <-> 딸깍 초안 함수(offline-blog-prompt.js / sidepanel-draft.js) 연결.
// 기존 offscreen.html 안에서 실행된다 (확장당 offscreen 문서는 하나만 만들 수 있으므로 기존 문서를 같이 씀).

// 딸깍 스크립트가 아직 안 불러와졌으면 직접 불러오고, 실패하면 어느 파일/몇 번째 줄 오류인지 그대로 돌려준다.
function loadDdalkkakScript(file) {
  return new Promise((resolve, reject) => {
    const errors = [];
    const onError = (event) => {
      if (String(event.filename || "").includes(file)) {
        errors.push(`${event.message} (${file}:${event.lineno}:${event.colno})`);
      }
    };
    window.addEventListener("error", onError);
    const script = document.createElement("script");
    script.charset = "utf-8"; // offscreen.html에 charset 지정이 없어 한글이 깨지므로 명시
    script.src = chrome.runtime.getURL(file);
    script.onload = () => {
      window.removeEventListener("error", onError);
      errors.length ? reject(new Error(errors.join(" / "))) : resolve();
    };
    script.onerror = () => {
      window.removeEventListener("error", onError);
      reject(new Error(`${file} 파일을 불러오지 못했습니다.`));
    };
    document.body.appendChild(script);
  });
}

async function ensureDdalkkakScripts() {
  if (typeof globalThis.buildOfflineBlogPrompt !== "function") {
    await loadDdalkkakScript("offline-blog-prompt.js");
  }
  if (!globalThis.ddalkkakDraft) {
    await loadDdalkkakScript("sidepanel-draft.js");
  }
  if (typeof globalThis.buildOfflineBlogPrompt !== "function") {
    throw new Error("offline-blog-prompt.js를 불러왔지만 buildOfflineBlogPrompt가 없습니다.");
  }
  if (!globalThis.ddalkkakDraft) {
    throw new Error("sidepanel-draft.js를 불러왔지만 ddalkkakDraft가 없습니다.");
  }
  return globalThis.ddalkkakDraft;
}

async function handleDdalkkakRequest(request) {
  const d = await ensureDdalkkakScripts();
  if (request.type === "BUILD_PROMPT") {
    Object.assign(d.state, request.state || {});
    const state = d.state;
    // 딸깍 sidepanel.js executeDraftRequest의 promptInput 구성과 동일 (targetPlatform은 원본 기본값 "blog").
    const promptInput = {
      topic: request.topic,
      keywords: state.keywords,
      tone: state.tone,
      audience: state.audience,
      length: state.length,
      articleType: state.articleType,
      formatPreset: state.formatPreset,
      draftRequirements: state.draftRequirements,
      research: d.buildBackendResearchPayload(request.research),
      targetPlatform: "blog",
    };
    const securedPrompt = buildOfflineBlogPrompt(promptInput).finalPrompt;
    // 딸깍 requestValidatedBlogDraft 첫 줄: originalPrompt = withBlogGenerationTargets(originalPrompt)
    return { ok: true, prompt: d.withBlogGenerationTargets(securedPrompt) };
  }
  if (request.type === "VALIDATE") {
    d.validateBlogDraftResponse(request.text);
    return { ok: true };
  }
  if (request.type === "PARSE") {
    return { ok: true, draft: d.parseDraftResponse(request.text) };
  }
  throw new Error("알 수 없는 요청입니다.");
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.target !== "ddalkkak-draft") return false;
  handleDdalkkakRequest(request)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
