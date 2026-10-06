const DRAFT_PREVIEW_KEY = "naverBlogGeminiAssistantDraftPreview";
const PANEL_STATE_KEY = "naverBlogGeminiAssistantPanelState";
const AI_PROVIDERS = {
  gemini: { id: "gemini", label: "Gemini" },
  chatgpt: { id: "chatgpt", label: "ChatGPT" },
};

const state = {
  preview: null,
  busy: false,
  editing: false,
  editingSnapshot: null,
};

const elements = {};
document.addEventListener('ddalkkak-language-change', () => {
  if (!elements.previewTitle) return;
  if (!state.editing && (!state.preview || !String(state.preview.html || '').trim())) {
    elements.previewTitle.textContent = window.ddalkkakUiText?.('초안 미리보기') || '초안 미리보기';
  } else if (!state.editing && !state.preview?.title) {
    elements.previewTitle.textContent = window.ddalkkakUiText?.('제목 없음') || '제목 없음';
  }
  const updatedAt = Number(state.preview?.updatedAt || 0);
  if (updatedAt > 0) elements.previewUpdatedAt.textContent = window.ddalkkakUiText?.(`${formatDateTime(updatedAt)} 기준`) || `${formatDateTime(updatedAt)} 기준`;
});

document.addEventListener("DOMContentLoaded", () => {
  collectElements();
  bindEvents();
  void renderPreview();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[DRAFT_PREVIEW_KEY]) {
    if (state.editing) {
      return;
    }

    void renderPreview({ preserveFeedbackInput: true });
  }
});

function collectElements() {
  elements.previewTitle = document.getElementById("previewTitle");
  elements.previewUpdatedAt = document.getElementById("previewUpdatedAt");
  elements.previewEmpty = document.getElementById("previewEmpty");
  elements.previewContent = document.getElementById("previewContent");
  elements.previewSummary = document.getElementById("previewSummary");
  elements.previewTags = document.getElementById("previewTags");
  elements.previewHtml = document.getElementById("previewHtml");
  elements.previewFeedbackInput = document.getElementById("previewFeedbackInput");
  elements.editDraftButton = document.getElementById("editDraftButton");
  elements.saveDraftButton = document.getElementById("saveDraftButton");
  elements.cancelEditButton = document.getElementById("cancelEditButton");
  elements.applyFeedbackButton = document.getElementById("applyFeedbackButton");
  elements.previewStatus = document.getElementById("previewStatus");
  elements.refreshButton = document.getElementById("refreshButton");
  elements.closeButton = document.getElementById("closeButton");
}

function bindEvents() {
  elements.refreshButton.addEventListener("click", () => void renderPreview({ preserveFeedbackInput: true }));
  elements.closeButton.addEventListener("click", () => window.close());
  elements.editDraftButton.addEventListener("click", () => enterEditMode());
  elements.saveDraftButton.addEventListener("click", () => void saveManualEdits());
  elements.cancelEditButton.addEventListener("click", () => cancelManualEdits());
  elements.applyFeedbackButton.addEventListener("click", () => void requestRevision());
}

async function renderPreview(options = {}) {
  if(window.ddalkkakLanguageReady) await window.ddalkkakLanguageReady;
  const stored = await chrome.storage.local.get(DRAFT_PREVIEW_KEY);
  const preview = normalizePreviewPayload(stored[DRAFT_PREVIEW_KEY]);
  state.preview = preview;

  if (!preview || !String(preview.html || "").trim()) {
    clearPreview();
    return;
  }

  elements.previewTitle.textContent = String(preview.title || window.ddalkkakUiText?.('제목 없음') || '제목 없음');
  elements.previewSummary.textContent = String(preview.summary || "");
  elements.previewHtml.innerHTML = sanitizeDraftHtml(String(preview.html || ""));

  const tags = Array.isArray(preview.tags) ? preview.tags : [];
  elements.previewTags.replaceChildren(...tags.map((tag) => {
    const badge = document.createElement("span");
    badge.className = "tag";
    badge.textContent = `#${String(tag || "").replace(/^#/, "")}`;
    return badge;
  }));

  if (!options.preserveFeedbackInput || document.activeElement !== elements.previewFeedbackInput) {
    elements.previewFeedbackInput.value = String(preview.feedback || "");
  }

  const updatedAt = Number(preview.updatedAt || 0);
  if (updatedAt > 0) {
    elements.previewUpdatedAt.textContent = window.ddalkkakUiText?.(`${formatDateTime(updatedAt)} 기준`) || `${formatDateTime(updatedAt)} 기준`;
    elements.previewUpdatedAt.classList.remove("hidden");
  } else {
    elements.previewUpdatedAt.textContent = "";
    elements.previewUpdatedAt.classList.add("hidden");
  }

  state.editing = false;
  state.editingSnapshot = null;
  applyTextEditingState(false);
  updateEditingUi();
  elements.previewEmpty.classList.add("hidden");
  elements.previewContent.classList.remove("hidden");
}

function clearPreview() {
  elements.previewTitle.textContent = window.ddalkkakUiText?.('초안 미리보기') || '초안 미리보기';
  elements.previewUpdatedAt.textContent = "";
  elements.previewUpdatedAt.classList.add("hidden");
  elements.previewSummary.textContent = "";
  elements.previewTags.replaceChildren();
  elements.previewHtml.replaceChildren();
  elements.previewFeedbackInput.value = "";
  state.editing = false;
  state.editingSnapshot = null;
  applyTextEditingState(false);
  updateEditingUi();
  elements.previewEmpty.classList.remove("hidden");
  elements.previewContent.classList.add("hidden");
  setStatus("대기 중");
}

function enterEditMode() {
  if (!state.preview?.draft || state.editing) {
    return;
  }

  state.editingSnapshot = captureCurrentEditableState();
  state.editing = true;
  applyTextEditingState(true);
  updateEditingUi();
  setStatus("양식은 유지되고 문구만 직접 수정할 수 있습니다.");
  elements.previewTitle.focus();
}

function cancelManualEdits() {
  if (!state.editing) {
    return;
  }

  restoreEditableState(state.editingSnapshot);
  state.editing = false;
  state.editingSnapshot = null;
  applyTextEditingState(false);
  updateEditingUi();
  setStatus("직접 수정을 취소했습니다.");
}

async function saveManualEdits() {
  const preview = state.preview || await loadPreviewState();

  if (!preview?.draft) {
    setStatus("먼저 초안이 있는 상태에서 팝업을 열어 주세요.");
    return;
  }

  if (!state.editing) {
    return;
  }

  setBusy(true);
  setStatus("직접 수정한 문구를 저장하는 중입니다.");

  try {
    const editedDraft = buildEditedDraftFromDom(preview.draft);
    const feedback = String(elements.previewFeedbackInput.value || preview.feedback || "");
    const rawResponse = String(preview.rawResponse || "");
    const nextPreview = buildDraftPreviewPayload({
      draft: editedDraft,
      textProvider: preview.textProvider || preview.provider,
      chatSessionMode: preview.chatSessionMode,
      articleType: preview.articleType,
      formatPreset: preview.formatPreset,
      templateAccentColor: preview.templateAccentColor,
      feedback,
      rawResponse,
      updatedAt: Date.now(),
    });

    await persistUpdatedDraft(nextPreview, rawResponse, feedback);
    state.preview = nextPreview;
    state.editing = false;
    state.editingSnapshot = null;
    await renderPreview({ preserveFeedbackInput: true });
    setStatus("직접 수정한 문구를 저장했습니다.", true);
  } catch (error) {
    setStatus(error.message || "직접 수정 내용 저장에 실패했습니다.");
  } finally {
    setBusy(false);
  }
}

function updateEditingUi() {
  const editing = Boolean(state.editing);

  elements.editDraftButton.classList.toggle("hidden", editing);
  elements.saveDraftButton.classList.toggle("hidden", !editing);
  elements.cancelEditButton.classList.toggle("hidden", !editing);
  elements.applyFeedbackButton.disabled = state.busy || editing;
  elements.refreshButton.disabled = state.busy || editing;
}

function applyTextEditingState(editing) {
  elements.previewTitle.classList.toggle("editable-text", true);
  elements.previewSummary.classList.toggle("editable-text", true);
  elements.previewTitle.classList.toggle("preview-title-editing", editing);
  elements.previewSummary.classList.toggle("editing", editing);
  elements.previewHtml.classList.toggle("editing", editing);

  setEditableTextTarget(elements.previewTitle, editing, { singleLine: true });
  setEditableTextTarget(elements.previewSummary, editing, { singleLine: true });

  for (const badge of elements.previewTags.querySelectorAll(".tag")) {
    badge.classList.add("editable-text");
    badge.classList.toggle("editing", editing);
    setEditableTextTarget(badge, editing, { singleLine: true });
  }

  for (const node of elements.previewHtml.querySelectorAll("h2, h3, p, li, blockquote")) {
    node.classList.add("editable-text");
    setEditableTextTarget(node, editing, { singleLine: true });
  }
}

function setEditableTextTarget(element, editing, options = {}) {
  if (!element) {
    return;
  }

  element.removeEventListener("keydown", handleEditableKeydown);
  element.removeEventListener("paste", handleEditablePaste);

  if (editing) {
    element.setAttribute("contenteditable", "true");
    element.setAttribute("spellcheck", "true");
    element.dataset.nbSingleLine = options.singleLine ? "true" : "false";
    element.addEventListener("keydown", handleEditableKeydown);
    element.addEventListener("paste", handleEditablePaste);
    return;
  }

  element.removeAttribute("contenteditable");
  element.removeAttribute("spellcheck");
  delete element.dataset.nbSingleLine;
}

function handleEditableKeydown(event) {
  if (event.key === "Enter") {
    event.preventDefault();
  }
}

function handleEditablePaste(event) {
  event.preventDefault();

  const text = event.clipboardData?.getData("text/plain") || "";
  insertPlainTextAtSelection(text.replace(/\r?\n+/g, " "));
}

function insertPlainTextAtSelection(text) {
  const safeText = String(text || "");

  if (!safeText) {
    return;
  }

  try {
    if (document.execCommand("insertText", false, safeText)) {
      return;
    }
  } catch {
    // Ignore environments where execCommand is unavailable.
  }

  const selection = getSelection();
  if (!selection?.rangeCount) {
    return;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();
  const textNode = document.createTextNode(safeText);
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function captureCurrentEditableState() {
  return {
    title: elements.previewTitle.textContent || "",
    summary: elements.previewSummary.textContent || "",
    tags: Array.from(elements.previewTags.querySelectorAll(".tag")).map((badge) => badge.textContent || ""),
    html: elements.previewHtml.innerHTML,
  };
}

function restoreEditableState(snapshot) {
  if (!snapshot) {
    return;
  }

  elements.previewTitle.textContent = String(snapshot.title || "");
  elements.previewSummary.textContent = String(snapshot.summary || "");
  elements.previewTags.replaceChildren(...(Array.isArray(snapshot.tags) ? snapshot.tags : []).map((tagText) => {
    const badge = document.createElement("span");
    badge.className = "tag";
    badge.textContent = String(tagText || "");
    return badge;
  }));
  elements.previewHtml.innerHTML = String(snapshot.html || "");
}

function buildEditedDraftFromDom(fallbackDraft) {
  const title = normalizeTextValue(elements.previewTitle.textContent || "");
  const summary = normalizeTextValue(elements.previewSummary.textContent || "");
  const html = extractEditedHtml();
  const tags = Array.from(elements.previewTags.querySelectorAll(".tag"))
    .map((badge) => normalizeTextValue(badge.textContent || "").replace(/^#/, ""))
    .filter(Boolean)
    .slice(0, 12);

  return {
    title,
    summary,
    html,
    text: htmlToPlainText(html),
    seo_tags: tags,
    image_prompts: Array.isArray(fallbackDraft?.imagePrompts) ? fallbackDraft.imagePrompts : [],
  };
}

function extractEditedHtml() {
  const clone = elements.previewHtml.cloneNode(true);

  for (const node of clone.querySelectorAll("[contenteditable]")) {
    node.removeAttribute("contenteditable");
    node.removeAttribute("spellcheck");
    node.removeAttribute("data-nb-single-line");
    node.classList.remove("editable-text", "editing");
  }

  return sanitizeDraftHtml(clone.innerHTML);
}

function htmlToPlainText(html) {
  const container = document.createElement("div");
  container.innerHTML = String(html || "");
  return normalizeTextValue(container.textContent || "");
}

function normalizeTextValue(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function requestRevision() {
  const preview = state.preview || await loadPreviewState();

  if (!preview?.draft) {
    setStatus("먼저 초안이 있는 상태에서 팝업을 열어 주세요.");
    return;
  }

  const feedback = String(elements.previewFeedbackInput.value || "").trim();
  if (!feedback) {
    setStatus("수정 요청을 입력하세요.");
    elements.previewFeedbackInput.focus();
    return;
  }

  setBusy(true);
  setStatus(`${getProviderLabel(preview.textProvider || preview.provider)}에 수정 요청을 전달하는 중입니다.`);

  try {
    const result = await chrome.runtime.sendMessage({
      type: "NB_SUBMIT_AI",
      provider: normalizeProviderValue(preview.textProvider || preview.provider),
      prompt: buildRevisionPrompt(preview.draft, feedback, preview),
      options: buildAiSubmitOptions(preview.chatSessionMode, { collectImages: false, timeoutMs: 240000 }),
    });

    if (!result?.ok) {
      throw new Error(result?.error || "피드백 반영에 실패했습니다.");
    }

    const nextDraft = parseDraftResponse(result.response?.text || "", preview.draft);
    const nextPreview = buildDraftPreviewPayload({
      draft: nextDraft,
      textProvider: preview.textProvider || preview.provider,
      chatSessionMode: preview.chatSessionMode,
      articleType: preview.articleType,
      formatPreset: preview.formatPreset,
      templateAccentColor: preview.templateAccentColor,
      feedback,
      rawResponse: result.response?.text || "",
      updatedAt: Date.now(),
    });

    await persistUpdatedDraft(nextPreview, result.response?.text || "", feedback);
    state.preview = nextPreview;
    await renderPreview({ preserveFeedbackInput: true });
    setStatus("피드백을 반영했습니다.", true);
  } catch (error) {
    setStatus(error.message || "피드백 반영에 실패했습니다.");
  } finally {
    setBusy(false);
  }
}

async function loadPreviewState() {
  const stored = await chrome.storage.local.get(DRAFT_PREVIEW_KEY);
  return normalizePreviewPayload(stored[DRAFT_PREVIEW_KEY]);
}

async function persistUpdatedDraft(preview, rawResponse, feedback) {
  const stored = await chrome.storage.local.get(PANEL_STATE_KEY);
  const savedPanelState = stored[PANEL_STATE_KEY];
  const nextPanelState = savedPanelState && typeof savedPanelState === "object"
    ? { ...savedPanelState }
    : {};

  nextPanelState.textProvider = normalizeProviderValue(preview.textProvider || preview.provider);
  nextPanelState.provider = nextPanelState.textProvider;
  nextPanelState.chatSessionMode = normalizeChatSessionModeValue(preview.chatSessionMode);
  nextPanelState.articleType = String(preview.articleType || nextPanelState.articleType || "auto");
  nextPanelState.formatPreset = String(preview.formatPreset || nextPanelState.formatPreset || "auto");
  nextPanelState.templateAccentColor = normalizeTemplateAccentColor(preview.templateAccentColor || nextPanelState.templateAccentColor);
  nextPanelState.feedback = String(feedback || "");
  nextPanelState.rawResponse = String(rawResponse || "");
  nextPanelState.draft = preview.draft;

  await chrome.storage.local.set({
    [DRAFT_PREVIEW_KEY]: preview,
    [PANEL_STATE_KEY]: nextPanelState,
  });
}

function buildDraftPreviewPayload({ draft, textProvider, chatSessionMode, articleType = "auto", formatPreset = "auto", templateAccentColor = "", feedback, rawResponse = "", updatedAt = Date.now() }) {
  const normalizedDraft = normalizeDraftValue(draft);

  if (!normalizedDraft) {
    return null;
  }

  return {
    textProvider: normalizeProviderValue(textProvider),
    provider: normalizeProviderValue(textProvider),
    chatSessionMode: normalizeChatSessionModeValue(chatSessionMode),
    articleType: String(articleType || "auto"),
    formatPreset: String(formatPreset || "auto"),
    templateAccentColor: normalizeTemplateAccentColor(templateAccentColor),
    feedback: String(feedback || ""),
    rawResponse: String(rawResponse || ""),
    draft: normalizedDraft,
    title: normalizedDraft.title || "",
    summary: normalizedDraft.summary || "",
    tags: normalizedDraft.tags.slice(0, 12),
    html: sanitizeDraftHtml(normalizedDraft.html || textToHtml(normalizedDraft.text || "")),
    updatedAt,
  };
}

function normalizePreviewPayload(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const rawResponse = String(value.rawResponse || "");
  let draftSource = value.draft || value;
  const savedHtml = String(draftSource?.html || "");
  const savedText = String(draftSource?.text || "");

  if (/\[object Object\]/i.test(`${savedHtml}\n${savedText}`)) {
    const reparsed = parseJsonFromText(rawResponse);
    if (reparsed) {
      draftSource = reparsed;
    }
  }

  const draft = normalizeDraftValue(draftSource);
  if (!draft) {
    return null;
  }

  return buildDraftPreviewPayload({
    draft,
    textProvider: value.textProvider || value.provider,
    chatSessionMode: value.chatSessionMode,
    articleType: value.articleType,
    formatPreset: value.formatPreset,
    templateAccentColor: value.templateAccentColor,
    feedback: value.feedback,
    rawResponse,
    updatedAt: value.updatedAt,
  });
}

function normalizeChatSessionModeValue(value) {
  const normalized = String(value || "new-chat").trim().toLowerCase();
  return ["new-chat", "temporary"].includes(normalized) ? normalized : "new-chat";
}

function buildAiSubmitOptions(chatSessionMode, overrides = {}) {
  return {
    newChat: true,
    temporaryChat: normalizeChatSessionModeValue(chatSessionMode) === "temporary",
    ...overrides,
  };
}

function buildRevisionPrompt(draft, feedback, preview = {}) {
  return `아래 네이버 블로그 초안을 사용자 피드백에 맞게 수정해 주세요.

[수정 규칙]
- 기존 글의 장점은 유지하고, 피드백에 해당하는 부분을 명확히 반영합니다.
- 출력 형식은 이전과 같은 JSON만 사용합니다.
- 본문 글은 HTML 문자열 대신 개별 단락과 소제목들을 구분하는 JSON 객체 배열 형태의 content 필드로 작성합니다.
- content는 paragraph, heading, blockquote, list, lead, callout, checklist, steps, pros_cons, comparison, faq, cta 블록을 사용할 수 있습니다.
- lead, blockquote, cta는 text를, steps는 title과 text 객체 배열을, comparison은 label과 text 객체 배열을 사용합니다.
- pros_cons는 pros와 cons 문자열 배열을, faq는 question과 answer 객체 배열을 사용합니다.
- 기존 글의 확장 블록과 시각적 리듬을 유지하면서 피드백에 필요한 부분만 변경합니다.
- 블로그 글의 단락 구분을 위해 content 내에 여러 개의 paragraph 블록을 세분화하여 생성해야 합니다. 모든 텍스트를 하나의 단락 블록에 합쳐서 쓰지 마세요.
- JSON 문자열의 문법(따옴표 이스케이프 등)을 완벽히 지키고 실제 줄바꿈 문자 대신 JSON 명세를 준수하십시오.
- markdown 코드블록이나 추가 설명은 출력하지 않습니다.
- image_prompts는 수정된 본문 흐름에 맞게 다시 정리하고, slot, prompt, alt, placement_hint, heading_hint를 포함합니다.
- 반드시 JSON.parse 가능한 유효한 JSON만 출력합니다.

[현재 초안 JSON]
${JSON.stringify(draft, null, 2)}

[사용자 피드백]
${String(feedback || "").trim()}

[현재 구성]
- 글 유형: ${String(preview.articleType || "auto")}
- 서식 프리셋: ${String(preview.formatPreset || "auto")}

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
  "image_prompts": [{"slot":"대표 이미지","prompt":"이미지 생성 프롬프트","alt":"대체 텍스트","placement_hint":"도입부 뒤","heading_hint":""}],
  "review_questions": ["추가 확인 질문"]
}`;
}

function parseDraftResponse(text, fallbackDraft) {
  const parsed = parseJsonFromText(text);

  if (parsed && typeof parsed === "object") {
    return normalizeDraftValue(parsed, fallbackDraft);
  }

  return normalizeDraftValue({
    title: fallbackDraft?.title || "",
    summary: "AI가 반환한 텍스트 초안입니다.",
    html: markdownLikeTextToHtml(String(text || "")),
    seo_tags: Array.isArray(fallbackDraft?.tags) ? fallbackDraft.tags : [],
    image_prompts: Array.isArray(fallbackDraft?.imagePrompts) ? fallbackDraft.imagePrompts : [],
  }, fallbackDraft);
}

function parseJsonFromText(text) {
  const source = String(text || "").trim();
  const withoutFence = source.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const directParse = tryParseJsonCandidate(withoutFence);
  if (directParse) {
    return directParse;
  }

  const firstBrace = withoutFence.indexOf("{");
  const lastBrace = withoutFence.lastIndexOf("}");

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return tryParseJsonCandidate(withoutFence.slice(firstBrace, lastBrace + 1));
  }

  return null;
}

function tryParseJsonCandidate(candidate) {
  if (!candidate) {
    return null;
  }

  try {
    return JSON.parse(candidate);
  } catch {
    const repaired = repairJsonMultilineStrings(candidate);

    if (repaired === candidate) {
      return null;
    }

    try {
      return JSON.parse(repaired);
    } catch {
      return null;
    }
  }
}

function repairJsonMultilineStrings(source) {
  let repaired = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (inString) {
      if (escaped) {
        repaired += character;
        escaped = false;
        continue;
      }

      if (character === "\\") {
        repaired += character;
        escaped = true;
        continue;
      }

      if (character === '"') {
        const nextSignificantCharacter = findNextNonWhitespaceCharacter(source, index + 1);

        if (nextSignificantCharacter && ![",", "}", "]", ":"].includes(nextSignificantCharacter)) {
          repaired += '\\"';
          continue;
        }

        repaired += character;
        inString = false;
        continue;
      }

      if (character === "\r") {
        repaired += "\\n";
        if (source[index + 1] === "\n") {
          index += 1;
        }
        continue;
      }

      if (character === "\n") {
        repaired += "\\n";
        continue;
      }

      if (character === "\t") {
        repaired += "\\t";
        continue;
      }

      repaired += character;
      continue;
    }

    if (character === '"') {
      inString = true;
    }

    repaired += character;
  }

  return repaired;
}

function findNextNonWhitespaceCharacter(source, startIndex) {
  for (let index = startIndex; index < source.length; index += 1) {
    const character = source[index];
    if (!/\s/.test(character)) {
      return character;
    }
  }

  return "";
}

function normalizeDraftValue(value, fallbackDraft = null) {
  if (!value || typeof value !== "object") {
    return fallbackDraft || null;
  }

  const title = String(value.title || value.post_title || value.blog_title || fallbackDraft?.title || "").trim();
  const summary = String(value.summary || value.description || value.excerpt || fallbackDraft?.summary || "").trim();

  let rawHtml = String(value.html || value.body_html || value.content_html || fallbackDraft?.html || "").trim();
  let rawText = String(value.text || value.body || value.content_text || value.content_string || fallbackDraft?.text || "").trim();

  const blocks = value.content || value.content_blocks || value.blocks;
  if (Array.isArray(blocks)) {
    const htmlParts = [];
    const textParts = [];
    for (const block of blocks) {
      const renderedBlock = renderPreviewContentBlock(block);
      if (!renderedBlock) continue;
      htmlParts.push(renderedBlock.html);
      textParts.push(renderedBlock.text);
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
      : Array.isArray(fallbackDraft?.tags)
        ? fallbackDraft.tags
        : [];

  const imagePrompts = Array.isArray(value.image_prompts)
    ? value.image_prompts
    : Array.isArray(value.imagePrompts)
      ? value.imagePrompts
      : Array.isArray(value.images)
        ? value.images
        : Array.isArray(fallbackDraft?.imagePrompts)
          ? fallbackDraft.imagePrompts
          : [];

  return {
    title,
    summary,
    html: normalizeDraftHtml(rawHtml, rawText),
    text: rawText,
    tags: tags
      .map((tag) => String(tag || "").replace(/[^a-zA-Z0-9가-힣ㄱ-ㅎㅏ-ㅣ]/g, "").trim())
      .filter(Boolean)
      .slice(0, 12),
    imagePrompts: normalizeImagePromptEntries(imagePrompts),
  };
}

function normalizeTemplateAccentColor(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : "";
}

function renderPreviewContentBlock(block) {
  if (!block || typeof block !== "object") return null;

  const type = String(block.type || "paragraph").trim().toLowerCase();
  const rawText = block.text ?? block.value ?? block.content ?? "";
  const text = formatPreviewContentValue(rawText);
  const title = formatPreviewContentValue(block.title ?? block.label ?? "");

  if (type === "heading" || type === "h2" || type === "h3") {
    if (!text) return null;
    const level = Number(block.level) === 3 || type === "h3" ? 3 : 2;
    return { html: `<h${level}>${formatRichText(text)}</h${level}>`, text };
  }

  if (type === "blockquote" || type === "quote" || type === "lead") {
    return text ? { html: `<blockquote>${formatRichText(text)}</blockquote>`, text } : null;
  }

  if (type === "callout") {
    if (!text && !title) return null;
    const icon = ({ warning: "⚠️", summary: "📌", tip: "💡" })[String(block.variant || "tip").toLowerCase()] || "💡";
    return {
      html: `<blockquote>${title ? `<strong>${icon} ${formatRichText(title)}</strong><br>` : `${icon} `}${formatRichText(text)}</blockquote>`,
      text: [title, text].filter(Boolean).join("\n"),
    };
  }

  if (["list", "ordered-list", "ol", "checklist"].includes(type)) {
    const items = normalizePreviewBlockItems(resolvePreviewBlockItemSource(block, rawText));
    if (!items.length) return null;
    const tag = type === "ordered-list" || type === "ol" ? "ol" : "ul";
    const prefix = type === "checklist" ? "✓ " : "";
    return {
      html: `<${tag}>${items.map((item) => `<li>${formatRichText(prefix + item)}</li>`).join("")}</${tag}>`,
      text: items.map((item) => prefix + item).join("\n"),
    };
  }

  if (type === "steps" || type === "comparison") {
    const fallback = type === "steps" ? "단계" : "비교 항목";
    const items = normalizePreviewStructuredItems(resolvePreviewBlockItemSource(block, rawText), fallback);
    if (!items.length) return null;
    const tag = type === "steps" ? "ol" : "div";
    const inner = items.map((item) => type === "steps"
      ? `<li><strong>${formatRichText(item.label)}</strong>${item.text ? `<br>${formatRichText(item.text)}` : ""}</li>`
      : `<p><strong>🔎 ${formatRichText(item.label)}</strong>${item.text ? `<br>${formatRichText(item.text)}` : ""}</p>`).join("");
    return {
      html: tag === "ol" ? `<ol>${inner}</ol>` : inner,
      text: items.map((item) => `${item.label}${item.text ? `: ${item.text}` : ""}`).join("\n"),
    };
  }

  if (type === "pros_cons" || type === "pros-cons") {
    const pros = normalizePreviewBlockItems(block.pros ?? block.advantages ?? []);
    const cons = normalizePreviewBlockItems(block.cons ?? block.disadvantages ?? block.cautions ?? []);
    if (!pros.length && !cons.length) return null;
    return {
      html: `${pros.length ? `<p><strong>👍 장점</strong></p><ul>${pros.map((item) => `<li>${formatRichText(item)}</li>`).join("")}</ul>` : ""}${cons.length ? `<p><strong>🤔 아쉬운 점</strong></p><ul>${cons.map((item) => `<li>${formatRichText(item)}</li>`).join("")}</ul>` : ""}`,
      text: `${pros.length ? `장점\n${pros.join("\n")}` : ""}${pros.length && cons.length ? "\n\n" : ""}${cons.length ? `아쉬운 점\n${cons.join("\n")}` : ""}`,
    };
  }

  if (type === "faq") {
    const sourceItems = resolvePreviewBlockItemSource(block, rawText);
    const items = (Array.isArray(sourceItems) ? sourceItems : [sourceItems])
      .map((item) => {
        if (!item || typeof item !== "object") {
          return { question: formatPreviewContentValue(item), answer: "" };
        }
        return {
          question: formatPreviewContentValue(item.question ?? item.title ?? item.label ?? ""),
          answer: formatPreviewContentValue(item.answer ?? item.text ?? item.content ?? item.description ?? ""),
        };
      })
      .filter((item) => item.question || item.answer);
    if (!items.length) return null;
    return {
      html: items.map((item) => `<p><strong>Q. ${formatRichText(item.question)}</strong>${item.answer ? `<br>A. ${formatRichText(item.answer)}` : ""}</p>`).join(""),
      text: items.map((item) => `Q. ${item.question}${item.answer ? `\nA. ${item.answer}` : ""}`).join("\n\n"),
    };
  }

  if (type === "cta") {
    return text ? { html: `<blockquote><strong>📣 ${formatRichText(text)}</strong></blockquote>`, text } : null;
  }

  const genericItems = normalizePreviewBlockItems(block.items);
  if (genericItems.length) {
    const headingHtml = title ? `<p><strong>${formatRichText(title)}</strong></p>` : "";
    return {
      html: `${headingHtml}<ul>${genericItems.map((item) => `<li>${formatRichText(item)}</li>`).join("")}</ul>`,
      text: [title, ...genericItems].filter(Boolean).join("\n"),
    };
  }

  return text ? { html: `<p>${formatRichText(text)}</p>`, text } : null;
}

function resolvePreviewBlockItemSource(block, fallbackValue = "") {
  return block?.items
    ?? block?.values
    ?? block?.options
    ?? block?.entries
    ?? fallbackValue;
}

function normalizePreviewBlockItems(items) {
  const source = Array.isArray(items) ? items : (items === null || items === undefined || items === "" ? [] : [items]);
  return source
    .map((item) => formatPreviewContentValue(item))
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizePreviewStructuredItems(items, fallbackLabel) {
  const source = Array.isArray(items) ? items : (items === null || items === undefined || items === "" ? [] : [items]);
  const labelKeys = ["label", "title", "name", "question", "heading"];

  return source.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { label: `${fallbackLabel} ${index + 1}`, text: formatPreviewContentValue(item) };
    }

    const labelKey = labelKeys.find((key) => formatPreviewContentValue(item[key]));
    const label = labelKey ? formatPreviewContentValue(item[labelKey]) : `${fallbackLabel} ${index + 1}`;
    const details = Object.fromEntries(Object.entries(item).filter(([key]) => key !== labelKey));
    return { label, text: formatPreviewContentValue(details) };
  }).filter((item) => item.label || item.text);
}

function formatPreviewContentValue(value, depth = 0) {
  if (value === null || value === undefined || depth > 4) {
    return "";
  }

  if (["string", "number", "boolean"].includes(typeof value)) {
    return String(value).replace(/\[object Object\]/gi, "").trim();
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => formatPreviewContentValue(item, depth + 1))
      .filter(Boolean)
      .join(" · ");
  }

  if (typeof value !== "object") {
    return "";
  }

  const fieldLabels = {
    plan: "요금제",
    price: "가격",
    monthlyPrice: "월 요금",
    cost: "비용",
    discount: "할인",
    benefit: "혜택",
    features: "특징",
    conditions: "조건",
    target: "추천 대상",
    pros: "장점",
    cons: "아쉬운 점",
    web: "웹",
    ios: "iOS",
    iOS: "iOS",
    android: "Android",
    question: "질문",
    answer: "답변",
    type: "유형",
  };
  const labelKeys = ["label", "title", "name", "question", "heading"];
  const primaryKeys = ["text", "content", "description", "value", "answer", "summary"];
  const entries = Object.entries(value).filter(([, nestedValue]) => nestedValue !== null && nestedValue !== undefined && nestedValue !== "");
  const labelKey = labelKeys.find((key) => formatPreviewContentValue(value[key], depth + 1));
  const primaryKey = primaryKeys.find((key) => formatPreviewContentValue(value[key], depth + 1));
  const labelText = labelKey ? formatPreviewContentValue(value[labelKey], depth + 1) : "";
  const primaryText = primaryKey ? formatPreviewContentValue(value[primaryKey], depth + 1) : "";
  const details = entries
    .filter(([key]) => key !== labelKey && key !== primaryKey && !["variant", "level"].includes(key))
    .map(([key, nestedValue]) => {
      const nestedText = formatPreviewContentValue(nestedValue, depth + 1);
      if (!nestedText) return "";
      return `${fieldLabels[key] || key}: ${nestedText}`;
    })
    .filter(Boolean);

  if (labelText && primaryText) {
    return `${labelText}: ${[primaryText, ...details].filter(Boolean).join(" · ")}`;
  }

  return [labelText, primaryText, ...details].filter(Boolean).join(" · ");
}

function normalizeImagePromptEntries(entries) {
  return Array.isArray(entries)
    ? entries.map((entry) => normalizeImagePromptEntry(entry)).filter((entry) => entry.prompt)
    : [];
}

function normalizeImagePromptEntry(entry) {
  return {
    slot: String(entry?.slot || entry?.name || "이미지").trim(),
    prompt: String(entry?.prompt || entry?.description || entry || "").trim(),
    alt: String(entry?.alt || entry?.altText || entry?.alt_text || "").trim(),
    placementHint: String(entry?.placementHint || entry?.placement_hint || entry?.placement || "").trim(),
    headingHint: String(entry?.headingHint || entry?.heading_hint || entry?.section || "").trim(),
  };
}

function normalizeDraftHtml(rawHtml, rawText) {
  const htmlCandidate = String(rawHtml || "").trim();
  if (htmlCandidate) {
    return looksLikeSupportedHtml(htmlCandidate)
      ? sanitizeDraftHtml(htmlCandidate)
      : textToHtml(htmlCandidate);
  }

  return textToHtml(rawText);
}

function looksLikeSupportedHtml(value) {
  return /<\/?(?:h2|h3|p|ul|ol|li|strong|b|em|i|blockquote|br|a|img)\b/i.test(String(value || ""));
}

function sanitizeDraftHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = String(html || "");
  const allowedTags = new Set(["H2", "H3", "P", "UL", "OL", "LI", "STRONG", "B", "EM", "I", "BLOCKQUOTE", "BR", "A", "IMG", "SPAN"]);
  const allowedAttrs = new Set(["href", "target", "rel", "src", "alt", "style"]);

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

function sanitizeInlineStyle(styleText) {
  const allowedProperties = new Set([
    "background-color",
    "border-left",
    "border-radius",
    "color",
    "display",
    "font-size",
    "font-weight",
    "letter-spacing",
    "line-height",
    "margin",
    "padding",
    "text-decoration",
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

function escapeHtml(value) {
  return String(value || "").replace(/[&<>\"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
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

function normalizeProviderValue(value) {
  const normalized = String(value || "gemini").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(AI_PROVIDERS, normalized) ? normalized : "gemini";
}

function getProviderLabel(value) {
  return AI_PROVIDERS[normalizeProviderValue(value)]?.label || AI_PROVIDERS.gemini.label;
}

function setBusy(isBusy) {
  state.busy = Boolean(isBusy);
  elements.previewFeedbackInput.disabled = state.busy;
  elements.editDraftButton.disabled = state.busy;
  elements.saveDraftButton.disabled = state.busy;
  elements.cancelEditButton.disabled = state.busy;
  updateEditingUi();
}

function setStatus(message, positive = false) {
  elements.previewStatus.textContent = String(message || "대기 중");
  elements.previewStatus.classList.toggle("strong", positive);
}

function formatDateTime(timestamp) {
  return new Intl.DateTimeFormat(({ko:'ko-KR',en:'en-US',ja:'ja-JP',es:'es-ES'})[window.ddalkkakLanguage?.()] || 'ko-KR', {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
