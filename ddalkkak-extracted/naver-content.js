const NBGA_GLOBAL_KEY = "__naverBlogGeminiAssistantLoaded";
const NBGA_STORAGE_KEY = "naverBlogGeminiAssistantPanelState";
const MAX_GENERATED_IMAGES = 6;

if (!window[NBGA_GLOBAL_KEY]) {
  window[NBGA_GLOBAL_KEY] = true;
  initializeNaverBlogAssistant();
}

function initializeNaverBlogAssistant() {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "NB_PING") {
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "NB_TOGGLE_PANEL") {
      if (isTopFrame()) {
        void ensurePanel().then(() => setPanelOpen(message.open !== false));
      }
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });
}

function isTopFrame() {
  return window.top === window;
}

function onReady(callback) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", callback, { once: true });
  } else {
    callback();
  }
}

let panelHost = null;
let panelShadow = null;
let elements = null;
let panelStateLoaded = false;
let panelActivated = false;
let busy = false;
let saveTimer = 0;

const state = {
  topic: "",
  audience: "",
  keywords: "",
  tone: "friendly",
  length: "medium",
  feedback: "",
  imagePrompt: "",
  rawResponse: "",
  draft: null,
  images: [],
};

async function ensurePanel(shouldOpen = false) {
  if (!panelStateLoaded) {
    await restorePanelState();
  }

  if (!panelHost) {
    createPanel();
    renderPanel();
  }

  if (shouldOpen) {
    setPanelOpen(true);
  } else if (!panelActivated) {
    setPanelOpen(false);
  }
}

async function restorePanelState() {
  panelStateLoaded = true;

  try {
    const stored = await chrome.storage.local.get(NBGA_STORAGE_KEY);
    const saved = stored[NBGA_STORAGE_KEY];

    if (saved && typeof saved === "object") {
      state.topic = typeof saved.topic === "string" ? saved.topic : "";
      state.audience = typeof saved.audience === "string" ? saved.audience : "";
      state.keywords = typeof saved.keywords === "string" ? saved.keywords : "";
      state.tone = normalizeSelectValue(saved.tone, ["friendly", "expert", "review", "story"], "friendly");
      state.length = normalizeSelectValue(saved.length, ["short", "medium", "long"], "medium");
      state.feedback = typeof saved.feedback === "string" ? saved.feedback : "";
      state.imagePrompt = typeof saved.imagePrompt === "string" ? saved.imagePrompt : "";
      state.rawResponse = typeof saved.rawResponse === "string" ? saved.rawResponse : "";
      state.draft = saved.draft && typeof saved.draft === "object" ? saved.draft : null;
    }
  } catch (error) {
    console.warn("Failed to restore Naver Blog Gemini panel state:", error);
  }
}

function createPanel() {
  panelHost = document.createElement("div");
  panelHost.id = "naver-blog-gemini-assistant";
  panelHost.style.position = "fixed";
  panelHost.style.zIndex = "2147483647";
  panelHost.style.inset = "0";
  panelHost.style.pointerEvents = "none";

  panelShadow = panelHost.attachShadow({ mode: "open" });
  panelShadow.innerHTML = buildPanelMarkup();
  document.documentElement.appendChild(panelHost);
  elements = collectPanelElements();
  bindPanelEvents();
}

function buildPanelMarkup() {
  return `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      button, input, textarea, select { font: inherit; }
      .launcher {
        position: fixed;
        top: 112px;
        right: 0;
        pointer-events: auto;
        min-width: 44px;
        min-height: 132px;
        border: 1px solid rgba(22, 35, 58, 0.18);
        border-right: none;
        border-radius: 8px 0 0 8px;
        padding: 12px 9px;
        background: #0b6654;
        color: #fff;
        font: 700 13px/1.2 "Segoe UI", "Malgun Gothic", sans-serif;
        box-shadow: 0 12px 32px rgba(15, 23, 42, 0.2);
        cursor: pointer;
        writing-mode: vertical-rl;
        text-orientation: mixed;
        letter-spacing: 0;
      }
      .panel {
        position: fixed;
        top: 0;
        right: 0;
        width: min(430px, calc(100vw - 12px));
        height: 100vh;
        display: grid;
        grid-template-rows: auto 1fr;
        overflow: hidden;
        pointer-events: auto;
        border-left: 1px solid rgba(22, 35, 58, 0.16);
        background: #f8fafc;
        color: #142033;
        box-shadow: -18px 0 50px rgba(15, 23, 42, 0.18);
        font: 13px/1.45 "Segoe UI", "Malgun Gothic", sans-serif;
      }
      .panel.hidden { display: none; }
      .launcher.hidden { display: none; }
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 12px;
        border-bottom: 1px solid rgba(22, 35, 58, 0.12);
        background: #ffffff;
      }
      .title-block { min-width: 0; }
      .eyebrow {
        margin: 0 0 2px;
        color: #0b6654;
        font-size: 11px;
        font-weight: 800;
      }
      .title {
        margin: 0;
        color: #142033;
        font-size: 16px;
        line-height: 1.2;
        font-weight: 800;
      }
      .header-actions { display: flex; gap: 6px; flex: 0 0 auto; }
      .body {
        overflow: auto;
        padding: 12px;
        display: grid;
        gap: 10px;
        align-content: start;
      }
      .section {
        display: grid;
        gap: 10px;
        border: 1px solid rgba(22, 35, 58, 0.12);
        border-radius: 8px;
        background: #ffffff;
        padding: 12px;
      }
      .section-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
      }
      .section h3 {
        margin: 0;
        color: #142033;
        font-size: 13px;
        line-height: 1.25;
      }
      .grid-2 {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 8px;
      }
      label {
        display: grid;
        gap: 5px;
        color: #4b5b73;
        font-weight: 700;
      }
      input, textarea, select {
        width: 100%;
        border: 1px solid rgba(22, 35, 58, 0.18);
        border-radius: 8px;
        background: #ffffff;
        color: #142033;
        padding: 9px 10px;
        outline: none;
      }
      textarea { min-height: 78px; resize: vertical; }
      input:focus, textarea:focus, select:focus {
        border-color: #0b6654;
        box-shadow: 0 0 0 3px rgba(11, 102, 84, 0.14);
      }
      .actions {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      .actions.single { grid-template-columns: minmax(0, 1fr); }
      button {
        min-height: 36px;
        border-radius: 8px;
        border: 1px solid rgba(22, 35, 58, 0.16);
        padding: 8px 10px;
        background: #ffffff;
        color: #142033;
        font-weight: 800;
        cursor: pointer;
      }
      button:hover { border-color: rgba(11, 102, 84, 0.5); }
      button:disabled { cursor: not-allowed; opacity: 0.55; }
      .primary { background: #0b6654; color: #ffffff; border-color: #0b6654; }
      .secondary { background: #e8f3ef; color: #075444; border-color: rgba(11, 102, 84, 0.22); }
      .danger { background: #fff4ed; color: #a34112; border-color: rgba(163, 65, 18, 0.18); }
      .icon-button {
        width: 36px;
        min-height: 36px;
        padding: 0;
        display: inline-grid;
        place-items: center;
      }
      .status {
        margin: 0;
        min-height: 20px;
        color: #56657d;
        font-size: 12px;
      }
      .status.strong { color: #0b6654; font-weight: 800; }
      .preview-title {
        margin: 0;
        color: #142033;
        font-size: 18px;
        line-height: 1.28;
      }
      .summary {
        margin: 0;
        color: #56657d;
      }
      .tag-list {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .tag {
        border-radius: 8px;
        padding: 4px 7px;
        background: #eef2f7;
        color: #3d4d63;
        font-size: 12px;
        font-weight: 700;
      }
      .preview {
        max-height: 260px;
        overflow: auto;
        border: 1px solid rgba(22, 35, 58, 0.12);
        border-radius: 8px;
        padding: 10px;
        background: #fbfdff;
      }
      .preview :is(h2, h3, p, ul, ol, blockquote) { margin-top: 0; }
      .preview h2 { font-size: 17px; line-height: 1.35; margin-bottom: 8px; }
      .preview h3 { font-size: 15px; line-height: 1.35; margin-bottom: 6px; }
      .preview p, .preview li { font-size: 13px; line-height: 1.6; }
      .preview img { max-width: 100%; height: auto; border-radius: 8px; }
      .empty {
        border: 1px dashed rgba(22, 35, 58, 0.2);
        border-radius: 8px;
        padding: 14px;
        color: #6b7890;
        background: #fbfdff;
      }
      .image-gallery {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      .image-card {
        display: grid;
        gap: 6px;
        border: 1px solid rgba(22, 35, 58, 0.12);
        border-radius: 8px;
        padding: 8px;
        background: #fbfdff;
      }
      .image-card img {
        width: 100%;
        aspect-ratio: 1 / 1;
        object-fit: cover;
        border-radius: 8px;
        background: #e5eaf1;
      }
      .raw-output {
        white-space: pre-wrap;
        max-height: 220px;
        overflow: auto;
        margin: 0;
        border-radius: 8px;
        padding: 10px;
        background: #0f172a;
        color: #e2e8f0;
        font-size: 12px;
      }
      .hidden { display: none !important; }
      @media (max-width: 840px) {
        .panel {
          width: min(100vw, 430px);
        }
      }
      @media (max-width: 520px) {
        .panel { width: 100vw; }
        .launcher {
          top: auto;
          bottom: 18px;
          right: 12px;
          min-width: auto;
          min-height: 40px;
          border-right: 1px solid rgba(22, 35, 58, 0.18);
          border-radius: 8px;
          padding: 10px 12px;
          writing-mode: horizontal-tb;
        }
        .grid-2, .actions { grid-template-columns: minmax(0, 1fr); }
      }
    </style>
    <button id="launcherButton" class="launcher hidden" type="button">AI 블로그</button>
    <aside id="panel" class="panel hidden" aria-label="네이버 블로그 Gemini 자동화">
      <header class="header">
        <div class="title-block">
          <p class="eyebrow">Gemini Web Workflow</p>
          <h2 class="title">네이버 블로그 자동화</h2>
        </div>
        <div class="header-actions">
          <button id="openGeminiButton" class="icon-button secondary" type="button" title="Gemini 열기">G</button>
          <button id="closeButton" class="icon-button" type="button" title="닫기">×</button>
        </div>
      </header>
      <div class="body">
        <section class="section">
          <div class="section-header">
            <h3>초안 입력</h3>
          </div>
          <label>주제
            <textarea id="topicInput" placeholder="예: 초보자를 위한 집에서 시작하는 생성형 AI 활용법"></textarea>
          </label>
          <div class="grid-2">
            <label>대상 독자
              <input id="audienceInput" type="text" placeholder="예: 1인 사업자, 마케터">
            </label>
            <label>핵심 키워드
              <input id="keywordsInput" type="text" placeholder="쉼표로 구분">
            </label>
          </div>
          <div class="grid-2">
            <label>톤
              <select id="toneInput">
                <option value="friendly">친근한 정보형</option>
                <option value="expert">전문가형</option>
                <option value="review">후기형</option>
                <option value="story">스토리형</option>
              </select>
            </label>
            <label>분량
              <select id="lengthInput">
                <option value="short">짧게</option>
                <option value="medium">보통</option>
                <option value="long">길게</option>
              </select>
            </label>
          </div>
          <div class="actions">
            <button id="draftButton" class="primary" type="button">초안 작성</button>
            <button id="copyHtmlButton" class="secondary" type="button">HTML 복사</button>
          </div>
          <p id="statusText" class="status">대기 중</p>
        </section>

        <section class="section">
          <div class="section-header">
            <h3>초안 미리보기</h3>
          </div>
          <div id="draftEmpty" class="empty">아직 작성된 초안이 없습니다.</div>
          <div id="draftView" class="hidden">
            <h3 id="draftTitle" class="preview-title"></h3>
            <p id="draftSummary" class="summary"></p>
            <div id="tagList" class="tag-list"></div>
            <div id="draftPreview" class="preview"></div>
          </div>
        </section>

        <section class="section">
          <div class="section-header">
            <h3>피드백 반영</h3>
          </div>
          <label>수정 요청
            <textarea id="feedbackInput" placeholder="예: 도입부를 더 자연스럽게, 키워드를 덜 반복, 결론에 행동 유도 추가"></textarea>
          </label>
          <div class="actions single">
            <button id="reviseButton" class="secondary" type="button">피드백 적용</button>
          </div>
        </section>

        <section class="section">
          <div class="section-header">
            <h3>이미지 생성</h3>
          </div>
          <label>이미지 요청
            <textarea id="imagePromptInput" placeholder="예: 대표 이미지 1장, 네이버 블로그 썸네일용, 과한 텍스트 없이 밝고 신뢰감 있게"></textarea>
          </label>
          <div class="actions">
            <button id="imageButton" class="secondary" type="button">이미지 생성</button>
            <button id="clearImagesButton" class="danger" type="button">이미지 비우기</button>
          </div>
          <div id="imageGallery" class="image-gallery"></div>
        </section>

        <section class="section">
          <div class="section-header">
            <h3>최종 입력</h3>
          </div>
          <div class="actions single">
            <button id="insertButton" class="primary" type="button">네이버 글쓰기창에 넣기</button>
          </div>
          <pre id="rawOutput" class="raw-output hidden"></pre>
        </section>
      </div>
    </aside>
  `;
}

function collectPanelElements() {
  return {
    launcherButton: panelShadow.getElementById("launcherButton"),
    panel: panelShadow.getElementById("panel"),
    closeButton: panelShadow.getElementById("closeButton"),
    openGeminiButton: panelShadow.getElementById("openGeminiButton"),
    topicInput: panelShadow.getElementById("topicInput"),
    audienceInput: panelShadow.getElementById("audienceInput"),
    keywordsInput: panelShadow.getElementById("keywordsInput"),
    toneInput: panelShadow.getElementById("toneInput"),
    lengthInput: panelShadow.getElementById("lengthInput"),
    draftButton: panelShadow.getElementById("draftButton"),
    copyHtmlButton: panelShadow.getElementById("copyHtmlButton"),
    statusText: panelShadow.getElementById("statusText"),
    draftEmpty: panelShadow.getElementById("draftEmpty"),
    draftView: panelShadow.getElementById("draftView"),
    draftTitle: panelShadow.getElementById("draftTitle"),
    draftSummary: panelShadow.getElementById("draftSummary"),
    tagList: panelShadow.getElementById("tagList"),
    draftPreview: panelShadow.getElementById("draftPreview"),
    feedbackInput: panelShadow.getElementById("feedbackInput"),
    reviseButton: panelShadow.getElementById("reviseButton"),
    imagePromptInput: panelShadow.getElementById("imagePromptInput"),
    imageButton: panelShadow.getElementById("imageButton"),
    clearImagesButton: panelShadow.getElementById("clearImagesButton"),
    imageGallery: panelShadow.getElementById("imageGallery"),
    insertButton: panelShadow.getElementById("insertButton"),
    rawOutput: panelShadow.getElementById("rawOutput"),
  };
}

function bindPanelEvents() {
  elements.launcherButton.addEventListener("click", () => setPanelOpen(true));
  elements.closeButton.addEventListener("click", () => setPanelOpen(false));
  elements.openGeminiButton.addEventListener("click", () => void openGemini());
  elements.draftButton.addEventListener("click", () => void requestDraft());
  elements.reviseButton.addEventListener("click", () => void requestRevision());
  elements.imageButton.addEventListener("click", () => void requestImageGeneration());
  elements.clearImagesButton.addEventListener("click", () => {
    state.images = [];
    renderImages();
    setStatus("이미지 목록을 비웠습니다.");
  });
  elements.insertButton.addEventListener("click", () => void insertDraftIntoNaver());
  elements.copyHtmlButton.addEventListener("click", () => void copyFinalHtml());
  elements.imageGallery.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-remove-image]");
    if (!button) {
      return;
    }
    const index = Number.parseInt(button.dataset.removeImage, 10);
    if (!Number.isNaN(index)) {
      state.images.splice(index, 1);
      renderImages();
    }
  });

  bindStateInput(elements.topicInput, "topic");
  bindStateInput(elements.audienceInput, "audience");
  bindStateInput(elements.keywordsInput, "keywords");
  bindStateInput(elements.toneInput, "tone");
  bindStateInput(elements.lengthInput, "length");
  bindStateInput(elements.feedbackInput, "feedback");
  bindStateInput(elements.imagePromptInput, "imagePrompt");
}

function bindStateInput(input, key) {
  input.addEventListener("input", () => {
    state[key] = input.value;
    schedulePersistPanelState();
  });
}

function setPanelOpen(isOpen) {
  if (!elements) {
    return;
  }

  if (isOpen) {
    panelActivated = true;
  }

  elements.panel.classList.toggle("hidden", !isOpen);
  elements.launcherButton.classList.toggle("hidden", !panelActivated || isOpen);

  if (isOpen) {
    elements.topicInput.focus();
  }
}

function renderPanel() {
  elements.topicInput.value = state.topic;
  elements.audienceInput.value = state.audience;
  elements.keywordsInput.value = state.keywords;
  elements.toneInput.value = state.tone;
  elements.lengthInput.value = state.length;
  elements.feedbackInput.value = state.feedback;
  elements.imagePromptInput.value = state.imagePrompt;
  renderDraft();
  renderImages();
  renderRawOutput();
  setBusy(false);
}

function renderDraft() {
  const draft = normalizeDraft(state.draft);
  state.draft = draft;

  elements.draftEmpty.classList.toggle("hidden", Boolean(draft));
  elements.draftView.classList.toggle("hidden", !draft);

  if (!draft) {
    return;
  }

  elements.draftTitle.textContent = draft.title || "제목 없음";
  elements.draftSummary.textContent = draft.summary || "";
  elements.draftPreview.innerHTML = sanitizeDraftHtml(draft.html || textToHtml(draft.text || ""));
  elements.tagList.replaceChildren(...draft.tags.map((tag) => {
    const node = document.createElement("span");
    node.className = "tag";
    node.textContent = `#${String(tag).replace(/^#/, "")}`;
    return node;
  }));

  if (!state.imagePrompt && draft.imagePrompts[0]?.prompt) {
    state.imagePrompt = draft.imagePrompts[0].prompt;
    elements.imagePromptInput.value = state.imagePrompt;
  }
}

function renderImages() {
  if (!state.images.length) {
    elements.imageGallery.innerHTML = `<div class="empty">생성된 이미지가 없습니다.</div>`;
    return;
  }

  elements.imageGallery.replaceChildren(...state.images.map((image, index) => {
    const card = document.createElement("div");
    card.className = "image-card";
    const img = document.createElement("img");
    img.src = image.dataUrl;
    img.alt = image.alt || "생성 이미지";
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "danger";
    removeButton.dataset.removeImage = String(index);
    removeButton.textContent = "제거";
    card.append(img, removeButton);
    return card;
  }));
}

function renderRawOutput() {
  elements.rawOutput.textContent = state.rawResponse || "";
  elements.rawOutput.classList.toggle("hidden", !state.rawResponse);
}

async function openGemini() {
  setStatus("Gemini 창을 여는 중입니다.");
  const result = await sendRuntimeMessage({ type: "NB_OPEN_GEMINI" });
  if (!result.ok) {
    setStatus(result.error || "Gemini 창을 열지 못했습니다.");
    return;
  }
  setStatus("Gemini 창을 열었습니다.");
}

async function requestDraft() {
  const topic = state.topic.trim();

  if (!topic) {
    setStatus("주제를 입력하세요.");
    elements.topicInput.focus();
    return;
  }

  setBusy(true);
  setStatus("Gemini에 초안을 요청하는 중입니다.");

  try {
    const result = await sendRuntimeMessage({
      type: "NB_SUBMIT_GEMINI",
      prompt: buildInitialDraftPrompt(),
      options: { newChat: true, collectImages: false, timeoutMs: 240000 },
    });

    if (!result.ok) {
      throw new Error(result.error);
    }

    applyGeminiDraftResponse(result.response.text);
    setStatus("초안을 가져왔습니다.", true);
  } catch (error) {
    setStatus(error.message || "초안 작성에 실패했습니다.");
  } finally {
    setBusy(false);
  }
}

async function requestRevision() {
  if (!state.draft) {
    setStatus("먼저 초안을 작성하세요.");
    return;
  }

  if (!state.feedback.trim()) {
    setStatus("수정 요청을 입력하세요.");
    elements.feedbackInput.focus();
    return;
  }

  setBusy(true);
  setStatus("Gemini에 피드백을 전달하는 중입니다.");

  try {
    const result = await sendRuntimeMessage({
      type: "NB_SUBMIT_GEMINI",
      prompt: buildRevisionPrompt(),
      options: { newChat: false, collectImages: false, timeoutMs: 240000 },
    });

    if (!result.ok) {
      throw new Error(result.error);
    }

    applyGeminiDraftResponse(result.response.text);
    setStatus("피드백을 반영했습니다.", true);
  } catch (error) {
    setStatus(error.message || "피드백 반영에 실패했습니다.");
  } finally {
    setBusy(false);
  }
}

async function requestImageGeneration() {
  if (!state.draft) {
    setStatus("이미지를 만들기 전에 초안을 작성하세요.");
    return;
  }

  if (state.images.length >= MAX_GENERATED_IMAGES) {
    setStatus(`이미지는 최대 ${MAX_GENERATED_IMAGES}장까지 보관합니다.`);
    return;
  }

  setBusy(true);
  setStatus("Gemini에 이미지 생성을 요청하는 중입니다.");

  try {
    const result = await sendRuntimeMessage({
      type: "NB_SUBMIT_GEMINI",
      prompt: buildImageGenerationPrompt(),
      options: { newChat: false, imageMode: true, collectImages: true, timeoutMs: 300000 },
    });

    if (!result.ok) {
      throw new Error(result.error);
    }

    const images = Array.isArray(result.response.images) ? result.response.images : [];
    const nextImages = images
      .slice(0, MAX_GENERATED_IMAGES - state.images.length)
      .map((dataUrl, index) => ({
        dataUrl,
        alt: `${state.draft?.title || "블로그"} 이미지 ${state.images.length + index + 1}`,
      }));

    state.images.push(...nextImages);
    state.rawResponse = result.response.text || state.rawResponse;
    renderImages();
    renderRawOutput();
    setStatus(nextImages.length ? "이미지를 가져왔습니다." : "Gemini 응답에서 이미지를 찾지 못했습니다.", Boolean(nextImages.length));
  } catch (error) {
    setStatus(error.message || "이미지 생성에 실패했습니다.");
  } finally {
    setBusy(false);
  }
}

async function insertDraftIntoNaver() {
  const draft = normalizeDraft(state.draft);

  if (!draft) {
    setStatus("입력할 최종안이 없습니다.");
    return;
  }

  setBusy(true);
  setStatus("네이버 글쓰기창에 넣는 중입니다.");

  try {
    const payload = buildFinalPayload(draft);
    const result = await sendRuntimeMessage({ type: "NB_INSERT_POST", payload });

    if (!result.ok) {
      throw new Error(result.error);
    }

    const titleMessage = result.insertion?.titleInserted ? "제목 포함" : "본문만";
    setStatus(`입력 완료: ${titleMessage}`, true);
  } catch (error) {
    setStatus(error.message || "네이버 글쓰기창 입력에 실패했습니다.");
  } finally {
    setBusy(false);
  }
}

async function copyFinalHtml() {
  const draft = normalizeDraft(state.draft);

  if (!draft) {
    setStatus("복사할 초안이 없습니다.");
    return;
  }

  try {
    await navigator.clipboard.writeText(buildFinalPayload(draft).html);
    setStatus("HTML을 복사했습니다.", true);
  } catch {
    setStatus("HTML 복사에 실패했습니다.");
  }
}

function applyGeminiDraftResponse(text) {
  state.rawResponse = text || "";
  state.draft = parseDraftResponse(text);
  renderDraft();
  renderRawOutput();
  schedulePersistPanelState();
}

function buildInitialDraftPrompt() {
  return `당신은 네이버 블로그 전문 에디터입니다. 사용자가 제공한 주제를 바탕으로 블로그 포스팅 초안을 작성해 주세요.

[작성 조건]
- 네이버 블로그에 바로 붙여넣기 좋은 자연스러운 한국어 글로 작성합니다.
- 제목은 검색 노출을 고려하되 과장된 낚시성 표현은 피합니다.
- 본문 글은 HTML 문자열 대신 개별 단락과 소제목들을 구분하는 JSON 객체 배열 형태의 content 필드로 작성합니다.
- content 배열의 각 블록은 type(값: "paragraph", "heading", "blockquote", "list")과 text(내용 문자열)를 가집니다. heading 타입의 경우 level(2 또는 3)을 지정하고, list 타입의 경우 items(문자열 배열)를 포함할 수 있습니다.
- 블로그 글의 단락 구분을 위해 content 내에 여러 개의 paragraph 블록을 세분화하여 생성해야 합니다. 모든 텍스트를 하나의 단락 블록에 합쳐서 쓰지 마세요.
- JSON 문자열의 문법(따옴표 이스케이프 등)을 완벽히 지키고 실제 줄바꿈 문자 대신 JSON 명세를 준수하십시오.
- 본문 안에는 markdown 문법을 쓰지 않습니다.
- 사실로 단정하기 어려운 내용은 보수적으로 표현합니다.
- 마지막에는 자연스러운 마무리 문단을 포함합니다.
- 이미지가 필요할 만한 위치와 생성 프롬프트를 image_prompts에 제안합니다.
- 반드시 JSON만 출력하고 코드블록 표시는 사용하지 않습니다.

[사용자 입력]
주제: ${state.topic.trim()}
대상 독자: ${state.audience.trim() || "일반 독자"}
핵심 키워드: ${state.keywords.trim() || "사용자 주제에 맞게 추천"}
톤: ${getToneLabel(state.tone)}
분량: ${getLengthLabel(state.length)}

[출력 JSON]
{
  "title": "블로그 제목",
  "summary": "글의 핵심 요약 1~2문장",
  "content": [
    { "type": "paragraph", "text": "도입부 문단 내용..." },
    { "type": "heading", "level": 2, "text": "1. 첫 번째 소제목" },
    { "type": "paragraph", "text": "첫 번째 본문 단락..." }
  ],
  "seo_tags": ["태그1", "태그2", "태그3"],
  "image_prompts": [
    {
      "slot": "대표 이미지",
      "prompt": "Gemini 이미지 생성용 프롬프트",
      "alt": "이미지 대체 텍스트"
    }
  ],
  "review_questions": ["사용자에게 확인하면 좋은 질문 1", "질문 2"]
}`;
}

function buildRevisionPrompt() {
  return `아래 네이버 블로그 초안을 사용자 피드백에 맞게 수정해 주세요.

[수정 규칙]
- 기존 글의 장점은 유지하고, 피드백에 해당하는 부분을 명확히 반영합니다.
- 출력 형식은 이전과 같은 JSON만 사용합니다.
- 본문 글은 HTML 문자열 대신 개별 단락과 소제목들을 구분하는 JSON 객체 배열 형태의 content 필드로 작성합니다.
- content 배열의 각 블록은 type(값: "paragraph", "heading", "blockquote", "list")과 text(내용 문자열)를 가집니다. heading 타입의 경우 level(2 또는 3)을 지정하고, list 타입의 경우 items(문자열 배열)를 포함할 수 있습니다.
- 블로그 글의 단락 구분을 위해 content 내에 여러 개의 paragraph 블록을 세분화하여 생성해야 합니다. 모든 텍스트를 하나의 단락 블록에 합쳐서 쓰지 마세요.
- JSON 문자열의 문법(따옴표 이스케이프 등)을 완벽히 지키고 실제 줄바꿈 문자 대신 JSON 명세를 준수하십시오.
- markdown 코드블록이나 추가 설명은 출력하지 않습니다.

[현재 초안 JSON]
${JSON.stringify(state.draft, null, 2)}

[사용자 피드백]
${state.feedback.trim()}

[출력 JSON]
{
  "title": "수정된 제목",
  "summary": "수정된 요약",
  "content": [
    { "type": "paragraph", "text": "수정된 도입부 문단 내용..." },
    { "type": "heading", "level": 2, "text": "1. 수정된 소제목" },
    { "type": "paragraph", "text": "수정된 본문 단락..." }
  ],
  "seo_tags": ["태그1", "태그2"],
  "image_prompts": [{"slot":"대표 이미지","prompt":"이미지 생성 프롬프트","alt":"대체 텍스트"}],
  "review_questions": ["추가 확인 질문"]
}`;
}

function buildImageGenerationPrompt() {
  const draft = normalizeDraft(state.draft);
  const preferredPrompt = state.imagePrompt.trim() || draft.imagePrompts[0]?.prompt || `${draft.title}에 어울리는 네이버 블로그 대표 이미지`;

  return `Gemini 이미지 생성 기능으로 네이버 블로그 포스팅에 사용할 이미지를 만들어 주세요.

[이미지 목적]
${preferredPrompt}

[블로그 글 정보]
제목: ${draft.title}
요약: ${draft.summary || "없음"}
핵심 태그: ${draft.tags.join(", ") || "없음"}

[제작 기준]
- 네이버 블로그 본문이나 썸네일에 어울리는 완성형 이미지 1장을 우선 생성합니다.
- 이미지 안의 텍스트는 최소화하고, 긴 문장을 넣지 않습니다.
- 과장 광고, 허위 수치, 상표 도용, 실제 인물 오인 요소는 피합니다.
- 밝고 선명하며 모바일 화면에서도 알아보기 쉬운 구도로 만듭니다.
- 설명문만 반환하지 말고 가능한 경우 실제 이미지 생성 결과를 우선 반환합니다.`;
}

function parseDraftResponse(text) {
  const parsed = parseJsonFromText(text);

  if (parsed && typeof parsed === "object") {
    return normalizeDraft(parsed);
  }

  const fallbackText = String(text || "").trim();
  return normalizeDraft({
    title: state.topic || "Gemini 초안",
    summary: "Gemini가 반환한 텍스트 초안입니다.",
    html: markdownLikeTextToHtml(fallbackText),
    seo_tags: splitKeywords(state.keywords),
    image_prompts: [],
  });
}

function parseJsonFromText(text) {
  const source = String(text || "").trim();
  const withoutFence = source.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();

  try {
    return JSON.parse(withoutFence);
  } catch {
    const firstBrace = withoutFence.indexOf("{");
    const lastBrace = withoutFence.lastIndexOf("}");

    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(withoutFence.slice(firstBrace, lastBrace + 1));
      } catch {
        return null;
      }
    }
  }

  return null;
}

function normalizeDraft(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const title = String(value.title || value.post_title || value.blog_title || state.topic || "").trim();
  const summary = String(value.summary || value.description || value.excerpt || "").trim();

  let rawHtml = String(value.html || value.body_html || value.content_html || "").trim();
  let rawText = String(value.text || value.body || value.content_text || value.content_string || "").trim();

  const blocks = value.content || value.content_blocks || value.blocks;
  if (Array.isArray(blocks)) {
    const htmlParts = [];
    const textParts = [];
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const type = String(block.type || "paragraph").toLowerCase();
      const text = String(block.text || block.value || block.content || "").trim();
      if (!text && type !== "list" && !Array.isArray(block.items)) continue;

      if (type === "heading" || type === "h2" || type === "h3") {
        const level = block.level || (type === "h3" ? 3 : 2);
        htmlParts.push(`<h${level}>${formatRichText(text)}</h${level}>`);
        textParts.push(text);
      } else if (type === "blockquote" || type === "quote") {
        htmlParts.push(`<blockquote>${formatRichText(text)}</blockquote>`);
        textParts.push(text);
      } else if (type === "list" || Array.isArray(block.items)) {
        const items = Array.isArray(block.items) ? block.items : [text];
        const listTag = type === "ordered-list" || type === "ol" ? "ol" : "ul";
        htmlParts.push(`<${listTag}>${items.map(item => `<li>${formatRichText(String(item || "").trim())}</li>`).join("")}</${listTag}>`);
        textParts.push(items.join("\n"));
      } else {
        htmlParts.push(`<p>${formatRichText(text)}</p>`);
        textParts.push(text);
      }
    }
    if (htmlParts.length > 0) {
      rawHtml = htmlParts.join("");
      rawText = textParts.join("\n\n");
    }
  } else if (!rawText && typeof value.content === "string") {
    rawText = value.content.trim();
  }

  const tags = Array.isArray(value.seo_tags)
    ? value.seo_tags
    : Array.isArray(value.tags)
      ? value.tags
      : splitKeywords(state.keywords);

  const imagePrompts = Array.isArray(value.image_prompts)
    ? value.image_prompts
    : Array.isArray(value.imagePrompts)
      ? value.imagePrompts
      : Array.isArray(value.images)
        ? value.images
        : [];

  return {
    title,
    summary,
    html: rawHtml || markdownLikeTextToHtml(rawText),
    text: rawText,
    tags: tags.map((tag) => String(tag || "").replace(/[^a-zA-Z0-9가-힣ㄱ-ㅎㅏ-ㅣ]/g, "").trim()).filter(Boolean).slice(0, 12),
    imagePrompts: imagePrompts.map((entry) => ({
      slot: String(entry?.slot || entry?.name || "이미지").trim(),
      prompt: String(entry?.prompt || entry?.description || entry || "").trim(),
      alt: String(entry?.alt || entry?.alt_text || "").trim(),
    })).filter((entry) => entry.prompt).slice(0, 5),
    reviewQuestions: Array.isArray(value.review_questions) ? value.review_questions.map(String) : [],
  };
}

function buildFinalPayload(draft) {
  return {
    title: draft.title,
    html: sanitizeDraftHtml(draft.html || textToHtml(draft.text || "")),
    text: draft.text || "",
    tags: draft.tags,
    images: state.images.slice(0, MAX_GENERATED_IMAGES),
  };
}

function sanitizeDraftHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = String(html || "");
  const allowedTags = new Set(["H2", "H3", "P", "DIV", "UL", "OL", "LI", "STRONG", "B", "EM", "I", "BLOCKQUOTE", "BR", "A", "IMG", "SPAN", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD"]);
  const allowedAttrs = new Set(["href", "target", "rel", "src", "alt", "style", "colspan", "rowspan"]);

  sanitizeChildren(template.content);
  return template.innerHTML;

  function sanitizeChildren(parent) {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        continue;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        node.remove();
        continue;
      }

      if (!allowedTags.has(node.tagName)) {
        const fragment = document.createDocumentFragment();
        while (node.firstChild) {
          fragment.appendChild(node.firstChild);
        }
        node.replaceWith(fragment);
        sanitizeChildren(parent);
        continue;
      }

      for (const attribute of Array.from(node.attributes)) {
        const name = attribute.name.toLowerCase();
        if (!allowedAttrs.has(name)) {
          node.removeAttribute(attribute.name);
          continue;
        }

        if (name === "href" && !/^https?:\/\//i.test(attribute.value)) {
          node.removeAttribute(attribute.name);
        }

        if (name === "src" && !/^(data:image\/|https?:\/\/)/i.test(attribute.value)) {
          node.removeAttribute(attribute.name);
        }

        if (name === "style") {
          const sanitizedStyle = sanitizeInlineStyle(attribute.value);
          if (sanitizedStyle) {
            node.setAttribute("style", sanitizedStyle);
          } else {
            node.removeAttribute(attribute.name);
          }
        }
      }

      if (node.tagName === "A") {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }

      sanitizeChildren(node);
    }
  }
}

function markdownLikeTextToHtml(text) {
  return String(text || "")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => {
      if (/^#{2,3}\s+/.test(paragraph)) {
        const level = paragraph.startsWith("###") ? "h3" : "h2";
        return `<${level}>${formatRichText(paragraph.replace(/^#{2,3}\s+/, ""))}</${level}>`;
      }

      return `<p>${formatRichText(paragraph).replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
}

function textToHtml(text) {
  return String(text || "")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${formatRichText(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function splitKeywords(value) {
  return String(value || "")
    .split(/[,#\n]/)
    .map((keyword) => keyword.trim())
    .filter(Boolean);
}

function getToneLabel(value) {
  return ({
    friendly: "친근한 정보형",
    expert: "전문가형",
    review: "후기형",
    story: "스토리형",
  })[value] || "친근한 정보형";
}

function getLengthLabel(value) {
  return ({
    short: "짧게, 핵심 중심",
    medium: "보통 분량, 소제목 4~5개",
    long: "길게, 소제목 6개 이상과 구체적인 예시 포함",
  })[value] || "보통 분량";
}

function setBusy(isBusy) {
  busy = isBusy;
  const controls = [
    elements.openGeminiButton,
    elements.draftButton,
    elements.copyHtmlButton,
    elements.reviseButton,
    elements.imageButton,
    elements.clearImagesButton,
    elements.insertButton,
    elements.topicInput,
    elements.audienceInput,
    elements.keywordsInput,
    elements.toneInput,
    elements.lengthInput,
    elements.feedbackInput,
    elements.imagePromptInput,
  ];

  for (const control of controls) {
    control.disabled = busy;
  }
}

function setStatus(message, positive = false) {
  elements.statusText.textContent = message;
  elements.statusText.classList.toggle("strong", positive);
}

function sendRuntimeMessage(payload) {
  return chrome.runtime.sendMessage(payload);
}

function schedulePersistPanelState() {
  if (saveTimer) {
    clearTimeout(saveTimer);
  }

  saveTimer = setTimeout(() => {
    saveTimer = 0;
    void persistPanelState();
  }, 180);
}

async function persistPanelState() {
  const { images, ...persistableState } = state;
  await chrome.storage.local.set({ [NBGA_STORAGE_KEY]: persistableState }).catch((error) => {
    console.warn("Failed to persist Naver Blog Gemini panel state:", error);
  });
}

function normalizeSelectValue(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[character]));
}

function formatRichText(value) {
  const escaped = escapeHtml(value);
  let formatted = escaped.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  formatted = formatted.replace(/__(.*?)__/g, "<strong>$1</strong>");
  formatted = formatted.replace(/\*(.*?)\*/g, "<em>$1</em>");
  formatted = formatted.replace(/_(.*?)_/g, "<em>$1</em>");
  
  formatted = formatted.replace(/\[(.*?)\]\((.*?)\)/g, (match, text, params) => {
    if (params.includes("color:") || params.includes("bg:")) {
      const styles = [];
      const parts = params.split(",");
      for (const part of parts) {
        const parts2 = part.split(":");
        if (parts2.length !== 2) continue;
        const key = parts2[0].trim().toLowerCase();
        const val = parts2[1].trim();
        if (key === "color") {
          if (/^#[0-9a-f]{3,6}$/i.test(val) || /^[a-z]+$/i.test(val)) {
            styles.push(`color: ${val}`);
          }
        } else if (key === "bg") {
          if (/^#[0-9a-f]{3,6}$/i.test(val) || /^[a-z]+$/i.test(val)) {
            styles.push(`background-color: ${val}`);
          }
        }
      }
      if (styles.length > 0) {
        return `<span style="${styles.join("; ")}">${text}</span>`;
      }
    }
    return match;
  });
  return formatted;
}

function sanitizeInlineStyle(styleText) {
  const allowedProperties = new Set([
    "background-color",
    "border",
    "border-left",
    "border-radius",
    "border-collapse",
    "color",
    "display",
    "font-size",
    "font-weight",
    "letter-spacing",
    "line-height",
    "margin",
    "padding",
    "text-align",
    "text-decoration",
    "white-space",
    "width",
  ]);
  const safeDeclarations = [];

  for (const declaration of String(styleText || "").split(";")) {
    const separatorIndex = declaration.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }

    const property = declaration.slice(0, separatorIndex).trim().toLowerCase();
    const value = declaration.slice(separatorIndex + 1).trim();

    if (!allowedProperties.has(property) || !/^[#(),.%\-+\s\w]+$/i.test(value)) {
      continue;
    }

    safeDeclarations.push(`${property}: ${value}`);
  }

  return safeDeclarations.join("; ");
}