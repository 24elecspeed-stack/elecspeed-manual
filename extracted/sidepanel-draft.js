// 딸깍(ddalkkak-extracted/sidepanel.js)에서 초안 JSON 검증/파싱/HTML 변환에 쓰는 함수를 원본 줄 그대로 잘라 붙임.
// 원본 줄 번호: BACKEND_RESEARCH_TOTAL_CHAR_LIMIT 8-8, AI_PROVIDERS 10-14, state 20-48, buildBackendResearchPayload 1704-1748, validateBlogDraftResponse 3738-3789, stripLeadingBareLabelLines 3833-3845, parseDraftResponse 3847-3862, parseJsonFromText 3864-3880, normalizeDraft 3882-3949, isBareContentLabel 3953-3957, renderDraftContentBlock 3959-4076, resolveDraftBlockItemSource 4078-4084, normalizeDraftBlockItems 4086-4092, normalizeStructuredDraftBlockItems 4094-4108, formatDraftContentValue 4110-4171, resolveDraftTags 4173-4191, coerceDraftTagValues 4193-4203, normalizeDraftTags 4205-4227, normalizeDraftTagValue 4229-4235, deriveFallbackDraftTags 4237-4261, splitDraftTagPhrases 4263-4279, isUsableDraftTag 4281-4289, extractDraftTagTokens 4291-4370, normalizeImagePromptEntries 4372-4384, mergeImagePromptEntries 4386-4417, completeImagePromptEntry 4419-4429, isRepresentativeImagePromptEntry 4431-4442, findMatchingImagePromptIndex 4444-4462, scoreImagePromptHeadingMatch 4464-4485, normalizeImagePromptComparableText 4487-4491, extractImagePromptSectionNumber 4493-4496, normalizeImagePromptEntry 4498-4506, deriveFallbackImagePrompts 4508-4540, getDefaultAutoImageCount 4542-4544, resolveRequestedAutoImageCount 4546-4555, getAutoImageUpperBoundFromHtml 4633-4635, analyzeAutoImageStructure 4637-4648, extractMaxNumberedSection 4650-4660, extractHeadingTexts 4662-4669, repairTruncatedJson 4673-4707, tryParseJsonCandidate 4709-4738, repairJsonMultilineStrings 4740-4804, findNextNonWhitespaceCharacter 4806-4816, normalizeDraftHtml 4818-4830, looksLikeSupportedHtml 4832-4834, formatPlainBlogTextAsHtml 4836-4863, normalizeBlogPlainText 4876-4888, splitNumberedSections 4890-4924, splitSectionHeadingAndBody 4926-4958, findHeadingSplitIndex 4960-4970, findFirstBlogSentenceBoundary 4972-4980, splitBlogSentences 4982-5004, isBlogSentenceBoundary 5006-5018, buildReadableParagraphs 5020-5058, paragraphsToHtml 5060-5065, mergeInlineStyle 5067-5078, normalizeTemplateAccentColor 5080-5083, mixHexColors 5085-5095, applyEditorialThemeToHtml 5137-5251, getEditorialTheme 5253-5332, cleanMarkdownText 5446-5457, sanitizeDraftHtml 5459-5525, repairBrokenDecimalParagraphs 5527-5549, endsWithBrokenDecimalPrefix 5551-5553, startsWithBrokenDecimalSuffix 5555-5557, trimLeadingInlineWhitespace 5559-5568, sanitizeInlineStyle 5570-5615, markdownLikeTextToHtml 5617-5631, splitKeywords 5642-5647, normalizeCustomLength 5658-5661, withBlogGenerationTargets 5668-5684, normalizeArticleTypeValue 5865-5870, normalizeFormatPresetValue 5872-5877, resolveFormatPresetValue 5879-5894, normalizeNaverSearchSourceValue 5921-5924, normalizeProviderValue 5950-5953, getSelectedAiProvider 5955-5958, getSelectedAiLabel 5960-5962, escapeHtml 6197-6204
// 기존 offscreen.js의 전역 이름과 겹치지 않도록 바깥만 즉시실행함수로 감싸고, 필요한 함수만 globalThis.ddalkkakDraft로 내보냄.
(() => {
const BACKEND_RESEARCH_TOTAL_CHAR_LIMIT = 24000;

const AI_PROVIDERS = {
  gemini: { id: "gemini", label: "Gemini" },
  chatgpt: { id: "chatgpt", label: "ChatGPT" },
  claude: { id: "claude", label: "Claude" },
};

const state = {
  textProvider: "gemini",
  imageProvider: "gemini",
  chatSessionMode: "new-chat",
  topic: "",
  naverSearchResearchEnabled: false,
  naverSearchSource: "section-blog",
  naverSearchKeyword: "",
  naverSearchReferenceCount: "5",
  draftRequirements: "",
  audience: "",
  keywords: "",
  tone: "friendly",
  length: "medium",
  customLength: 2000,
  articleType: "auto",
  formatPreset: "auto",
  templateAccentColor: "",
  feedback: "",
  autoImageCount: "auto",
  autoImageStyle: "standard",
  autoImageRequirements: "",
  autoImageReferencePrompt: "",
  autoImageReferenceImage: null,
  imagePrompt: "",
  rawResponse: "",
  draft: null,
  images: [],
};

function buildBackendResearchPayload(research) {
  if (!research || typeof research !== "object") {
    return null;
  }

  const references = Array.isArray(research.references) ? research.references : [];
  const compactReferences = [];
  let remainingContentBudget = BACKEND_RESEARCH_TOTAL_CHAR_LIMIT;

  for (const entry of references.slice(0, 8)) {
    if (remainingContentBudget <= 0) {
      break;
    }

    const rawContent = String(entry?.content || "")
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const contentLimit = Math.min(6500, remainingContentBudget);
    const content = rawContent.slice(0, contentLimit);
    remainingContentBudget -= content.length;

    compactReferences.push({
      rank: Number(entry?.rank || 0) || compactReferences.length + 1,
      title: String(entry?.title || "").trim().slice(0, 180),
      snippet: String(entry?.snippet || "").trim().slice(0, 500),
      url: String(entry?.mobileUrl || entry?.url || "").trim().slice(0, 500),
      headings: Array.isArray(entry?.headings)
        ? entry.headings.map((heading) => String(heading || "").trim().slice(0, 160)).filter(Boolean).slice(0, 10)
        : [],
      content,
    });
  }

  return {
    keyword: String(research.keyword || state.naverSearchKeyword || state.topic || "").trim().slice(0, 200),
    searchSource: normalizeNaverSearchSourceValue(research.searchSource || state.naverSearchSource),
    requestedReferenceCount: Number(research.requestedReferenceCount || compactReferences.length || 0),
    relatedKeywords: Array.isArray(research.relatedKeywords)
      ? research.relatedKeywords.map((keyword) => String(keyword || "").trim().slice(0, 80)).filter(Boolean).slice(0, 8)
      : [],
    references: compactReferences,
  };
}

function validateBlogDraftResponse(text) {
  const value = parseJsonFromText(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("초안은 JSON 객체여야 합니다.");
  }
  const title = value.title || value.post_title || value.blog_title;
  if (typeof title !== "string" || !title.trim()) {
    throw new Error("제목(title)은 비어 있지 않은 문자열이어야 합니다.");
  }
  const blocks = value.content ?? value.content_blocks ?? value.blocks;
  let body = "";
  if (Array.isArray(blocks)) {
    if (!blocks.length || blocks.some((block) => !block || typeof block !== "object" || Array.isArray(block))) {
      throw new Error("content에는 본문 블록 객체가 필요합니다.");
    }
    const rendered = blocks.map(renderDraftContentBlock);
    if (rendered.some((block) => !block || !String(block.text || "").trim())) {
      throw new Error("content에 비어 있거나 읽을 수 없는 본문 블록이 있습니다.");
    }
    body = rendered.map((block) => block.text).join("\n");
  } else {
    if (blocks != null && typeof blocks !== "string") {
      throw new Error("본문 content는 블록 배열 또는 문자열이어야 합니다.");
    }
    const bodyValue = value.html || value.body_html || value.content_html
      || value.text || value.body || value.content_text || value.content_string || blocks;
    if (typeof bodyValue === "string") {
      const template = document.createElement("template");
      template.innerHTML = sanitizeDraftHtml(bodyValue);
      body = template.content.textContent || "";
    }
  }
  if (!body.trim()) throw new Error("초안 JSON에 비어 있지 않은 본문이 필요합니다.");
  for (const key of ["summary", "description", "excerpt"]) {
    if (value[key] != null && typeof value[key] !== "string") throw new Error(`${key}는 문자열이어야 합니다.`);
  }
  for (const key of ["seo_tags", "tags", "image_prompts", "imagePrompts", "images", "review_questions"]) {
    if (value[key] != null && !Array.isArray(value[key])) throw new Error(`${key}는 배열이어야 합니다.`);
  }
  for (const key of ["seo_tags", "tags", "review_questions"]) {
    if (Array.isArray(value[key]) && value[key].some((entry) => typeof entry !== "string")) {
      throw new Error(`${key}의 항목은 문자열이어야 합니다.`);
    }
  }
  for (const key of ["image_prompts", "imagePrompts", "images"]) {
    if (Array.isArray(value[key]) && value[key].some((entry) => {
      const prompt = typeof entry === "string" ? entry : entry?.prompt || entry?.description;
      return typeof prompt !== "string" || !prompt.trim();
    })) throw new Error(`${key}에 유효한 이미지 프롬프트가 필요합니다.`);
  }
  return value;
}

function stripLeadingBareLabelLines(text) {
  const lines = String(text || "").split(/\r?\n/);
  let start = 0;
  while (start < lines.length) {
    const line = lines[start].trim();
    if (!line || isBareContentLabel(line) || /^```/.test(line)) {
      start += 1;
      continue;
    }
    break;
  }
  return lines.slice(start).join("\n").trim();
}

function parseDraftResponse(text) {
  const parsed = parseJsonFromText(text);

  if (parsed && typeof parsed === "object") {
    return normalizeDraft(parsed);
  }

  const fallbackText = stripLeadingBareLabelLines(String(text || "").trim());
  return normalizeDraft({
    title: state.topic || `${getSelectedAiLabel("text")} 초안`,
    summary: "AI가 반환한 텍스트 초안입니다.",
    html: markdownLikeTextToHtml(fallbackText),
    seo_tags: splitKeywords(state.keywords),
    image_prompts: [],
  });
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
      const renderedBlock = renderDraftContentBlock(block);
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

  const imagePrompts = Array.isArray(value.image_prompts)
    ? value.image_prompts
    : Array.isArray(value.imagePrompts)
      ? value.imagePrompts
      : Array.isArray(value.images)
        ? value.images
        : [];
  const normalizedHtml = normalizeDraftHtml(rawHtml, rawText, {
    title,
    summary,
  });
  const imageLimit = getAutoImageUpperBoundFromHtml(normalizedHtml);
  const tags = resolveDraftTags(value, {
    title,
    summary,
    html: normalizedHtml,
    rawText,
    topic: state.topic,
    keywords: state.keywords,
  });

  return {
    title,
    summary,
    html: normalizedHtml,
    text: rawText,
    tags: tags.slice(0, 12),
    imagePrompts: normalizeImagePromptEntries(
      imagePrompts.map((entry) => ({
        slot: String(entry?.slot || entry?.name || "이미지").trim(),
        prompt: String(entry?.prompt || entry?.description || entry || "").trim(),
        alt: String(entry?.alt || entry?.alt_text || "").trim(),
        placementHint: String(entry?.placement_hint || entry?.placementHint || entry?.placement || "").trim(),
        headingHint: String(entry?.heading_hint || entry?.headingHint || entry?.section || "").trim(),
      })),
      { title, summary, html: normalizedHtml, tags }
    ).slice(0, imageLimit),
  };
}

function isBareContentLabel(text) {
  return /^(?:html|xml|markdown|md|json|text|code|복사|코드\s*복사|copy(?:\s*code)?|content_copy|download)$/i.test(
    String(text || "").trim()
  );
}

function renderDraftContentBlock(block) {
  if (!block || typeof block !== "object") {
    return null;
  }

  const type = String(block.type || "paragraph").trim().toLowerCase();
  const rawText = block.text ?? block.value ?? block.content ?? "";
  const text = formatDraftContentValue(rawText);
  const title = formatDraftContentValue(block.title ?? block.label ?? "");
  if (isBareContentLabel(text) && !isBareContentLabel(title)) {
    return null;
  }

  if (type === "heading" || type === "h2" || type === "h3") {
    if (!text) return null;
    const level = Number(block.level) === 3 || type === "h3" ? 3 : 2;
    return { html: `<h${level}>${escapeHtml(text)}</h${level}>`, text };
  }

  if (type === "blockquote" || type === "quote" || type === "lead") {
    if (!text) return null;
    return { html: `<blockquote>${escapeHtml(text)}</blockquote>`, text };
  }

  if (type === "callout") {
    if (!text && !title) return null;
    const variant = String(block.variant || "tip").trim().toLowerCase();
    const icon = ({ warning: "⚠️", summary: "📌", tip: "💡" })[variant] || "💡";
    const headingHtml = title ? `<strong>${icon} ${escapeHtml(title)}</strong><br>` : `${icon} `;
    const combinedText = [title, text].filter(Boolean).join("\n");
    return { html: `<blockquote>${headingHtml}${escapeHtml(text)}</blockquote>`, text: combinedText };
  }

  if (type === "list" || type === "ordered-list" || type === "ol" || type === "checklist") {
    const items = normalizeDraftBlockItems(resolveDraftBlockItemSource(block, rawText));
    if (!items.length) return null;
    const ordered = type === "ordered-list" || type === "ol";
    const listTag = ordered ? "ol" : "ul";
    const prefix = type === "checklist" ? "✓ " : "";
    return {
      html: `<${listTag}>${items.map((item) => `<li>${escapeHtml(prefix + item)}</li>`).join("")}</${listTag}>`,
      text: items.map((item) => prefix + item).join("\n"),
    };
  }

  if (type === "steps") {
    const items = normalizeStructuredDraftBlockItems(resolveDraftBlockItemSource(block, rawText), "단계");
    if (!items.length) return null;
    return {
      html: `<ol>${items.map((item) => `<li><strong>${escapeHtml(item.label)}</strong>${item.text ? `<br>${escapeHtml(item.text)}` : ""}</li>`).join("")}</ol>`,
      text: items.map((item, index) => `${index + 1}. ${item.label}${item.text ? `: ${item.text}` : ""}`).join("\n"),
    };
  }

  if (type === "pros_cons" || type === "pros-cons") {
    const pros = normalizeDraftBlockItems(block.pros ?? block.advantages ?? []);
    const cons = normalizeDraftBlockItems(block.cons ?? block.disadvantages ?? block.cautions ?? []);
    if (!pros.length && !cons.length) return null;
    const html = [
      pros.length ? `<p><strong>👍 장점</strong></p><ul>${pros.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "",
      cons.length ? `<p><strong>🤔 아쉬운 점</strong></p><ul>${cons.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "",
    ].join("");
    const plainText = [
      pros.length ? `장점\n${pros.join("\n")}` : "",
      cons.length ? `아쉬운 점\n${cons.join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
    return { html, text: plainText };
  }

  if (type === "comparison") {
    const items = normalizeStructuredDraftBlockItems(resolveDraftBlockItemSource(block, rawText), "비교 항목");
    if (!items.length) return null;
    return {
      html: `<table><tbody>${items.map((item) => `<tr><th>${escapeHtml(item.label)}</th><td>${escapeHtml(item.text || "")}</td></tr>`).join("")}</tbody></table>`,
      text: items.map((item) => `${item.label}${item.text ? `: ${item.text}` : ""}`).join("\n"),
    };
  }

  if (type === "faq") {
    const sourceItems = resolveDraftBlockItemSource(block, rawText);
    const items = (Array.isArray(sourceItems) ? sourceItems : [sourceItems])
      .map((item) => {
        if (!item || typeof item !== "object") {
          return { question: formatDraftContentValue(item), answer: "" };
        }
        return {
          question: formatDraftContentValue(item.question ?? item.title ?? item.label ?? ""),
          answer: formatDraftContentValue(item.answer ?? item.text ?? item.content ?? item.description ?? ""),
        };
      })
      .filter((item) => item.question || item.answer);
    if (!items.length) return null;
    return {
      html: items.map((item) => `<p><strong>Q. ${escapeHtml(item.question)}</strong>${item.answer ? `<br>A. ${escapeHtml(item.answer)}` : ""}</p>`).join(""),
      text: items.map((item) => `Q. ${item.question}${item.answer ? `\nA. ${item.answer}` : ""}`).join("\n\n"),
    };
  }

  if (type === "cta") {
    if (!text) return null;
    return { html: `<blockquote><strong>📣 ${escapeHtml(text)}</strong></blockquote>`, text };
  }

  const genericItems = normalizeDraftBlockItems(block.items);
  if (genericItems.length) {
    const headingHtml = title ? `<p><strong>${escapeHtml(title)}</strong></p>` : "";
    return {
      html: `${headingHtml}<ul>${genericItems.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`,
      text: [title, ...genericItems].filter(Boolean).join("\n"),
    };
  }

  if (!text) {
    return null;
  }

  return { html: `<p>${escapeHtml(text)}</p>`, text };
}

function resolveDraftBlockItemSource(block, fallbackValue = "") {
  return block?.items
    ?? block?.values
    ?? block?.options
    ?? block?.entries
    ?? fallbackValue;
}

function normalizeDraftBlockItems(items) {
  const source = Array.isArray(items) ? items : (items === null || items === undefined || items === "" ? [] : [items]);
  return source
    .map((item) => formatDraftContentValue(item))
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeStructuredDraftBlockItems(items, fallbackLabel) {
  const source = Array.isArray(items) ? items : (items === null || items === undefined || items === "" ? [] : [items]);
  const labelKeys = ["label", "title", "name", "question", "heading"];

  return source.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { label: `${fallbackLabel} ${index + 1}`, text: formatDraftContentValue(item) };
    }

    const labelKey = labelKeys.find((key) => formatDraftContentValue(item[key]));
    const label = labelKey ? formatDraftContentValue(item[labelKey]) : `${fallbackLabel} ${index + 1}`;
    const details = Object.fromEntries(Object.entries(item).filter(([key]) => key !== labelKey));
    return { label, text: formatDraftContentValue(details) };
  }).filter((item) => item.label || item.text);
}

function formatDraftContentValue(value, depth = 0) {
  if (value === null || value === undefined || depth > 4) {
    return "";
  }

  if (["string", "number", "boolean"].includes(typeof value)) {
    return String(value).replace(/\[object Object\]/gi, "").trim();
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => formatDraftContentValue(item, depth + 1))
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
  const labelKey = labelKeys.find((key) => formatDraftContentValue(value[key], depth + 1));
  const primaryKey = primaryKeys.find((key) => formatDraftContentValue(value[key], depth + 1));
  const labelText = labelKey ? formatDraftContentValue(value[labelKey], depth + 1) : "";
  const primaryText = primaryKey ? formatDraftContentValue(value[primaryKey], depth + 1) : "";
  const details = entries
    .filter(([key]) => key !== labelKey && key !== primaryKey && !["variant", "level"].includes(key))
    .map(([key, nestedValue]) => {
      const nestedText = formatDraftContentValue(nestedValue, depth + 1);
      if (!nestedText) return "";
      return `${fieldLabels[key] || key}: ${nestedText}`;
    })
    .filter(Boolean);

  if (labelText && primaryText) {
    return `${labelText}: ${[primaryText, ...details].filter(Boolean).join(" · ")}`;
  }

  return [labelText, primaryText, ...details].filter(Boolean).join(" · ");
}

function resolveDraftTags(value, draftContext = {}) {
  const explicitTags = normalizeDraftTags([
    ...coerceDraftTagValues(value?.seo_tags),
    ...coerceDraftTagValues(value?.tags),
    ...coerceDraftTagValues(value?.seoTags),
    ...coerceDraftTagValues(value?.hash_tags),
    ...coerceDraftTagValues(value?.hashtags),
    ...coerceDraftTagValues(value?.keyword_tags),
    ...coerceDraftTagValues(value?.keywords),
    ...coerceDraftTagValues(value?.keyword),
    ...coerceDraftTagValues(draftContext.keywords),
  ]);

  if (explicitTags.length) {
    return explicitTags.slice(0, 12);
  }

  return deriveFallbackDraftTags(draftContext).slice(0, 12);
}

function coerceDraftTagValues(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string") {
    return splitKeywords(value);
  }

  return [];
}

function normalizeDraftTags(values) {
  const normalizedTags = [];
  const seen = new Set();

  for (const value of Array.isArray(values) ? values : []) {
    const normalizedTag = normalizeDraftTagValue(value);

    if (!normalizedTag) {
      continue;
    }

    const key = normalizedTag.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalizedTags.push(normalizedTag);
  }

  return normalizedTags;
}

function normalizeDraftTagValue(value) {
  return String(value || "")
    .replace(/^#+/, "")
    .replace(/^[,./|]+|[,./|]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function deriveFallbackDraftTags(draftContext = {}) {
  const headings = extractHeadingTexts(draftContext.html || "");
  const phraseCandidates = [
    ...splitDraftTagPhrases(draftContext.topic),
    ...splitDraftTagPhrases(draftContext.title),
    ...splitDraftTagPhrases(draftContext.summary),
    ...headings.flatMap((heading) => splitDraftTagPhrases(heading)),
  ];
  const normalizedPhrases = normalizeDraftTags(phraseCandidates).filter(isUsableDraftTag);

  if (normalizedPhrases.length >= 3) {
    return normalizedPhrases;
  }

  const tokenCandidates = extractDraftTagTokens([
    draftContext.topic,
    draftContext.title,
    draftContext.summary,
    ...headings,
    draftContext.rawText,
    draftContext.html,
  ]);

  return normalizeDraftTags([...normalizedPhrases, ...tokenCandidates]).filter(isUsableDraftTag);
}

function splitDraftTagPhrases(value) {
  const normalized = normalizeBlogPlainText(value)
    .replace(/^\d+\s*[.)]\s*/, "")
    .replace(/^마치며\s*[:：-]?\s*/i, "")
    .trim();

  if (!normalized) {
    return [];
  }

  const phrases = normalized
    .split(/[,:|·/]/)
    .map((phrase) => normalizeDraftTagValue(phrase))
    .filter(Boolean);

  return phrases.length ? phrases : [normalizeDraftTagValue(normalized)];
}

function isUsableDraftTag(value) {
  const normalized = normalizeDraftTagValue(value);

  if (!normalized || normalized.length < 2 || normalized.length > 24) {
    return false;
  }

  return !/^(마치며|정리|요약)$/i.test(normalized);
}

function extractDraftTagTokens(values) {
  const stopWords = new Set([
    "가장",
    "같은",
    "기반",
    "기본",
    "내용",
    "도입",
    "마무리",
    "문단",
    "미래",
    "바로",
    "분석",
    "사항",
    "사용자",
    "시점",
    "시사점",
    "요약",
    "우리",
    "이제",
    "정리",
    "정보",
    "제공",
    "중심",
    "지금",
    "최신",
    "추가",
    "트랜드",
    "트렌드",
    "포인트",
    "핵심",
    "현장",
    "현실화",
    "활용",
    "완벽",
  ]);
  const scores = new Map();
  const originals = new Map();

  for (const [index, value] of (Array.isArray(values) ? values : []).entries()) {
    const weight = index <= 1 ? 4 : index <= 3 ? 3 : 2;
    const tokens = String(normalizeBlogPlainText(value)).match(/[A-Za-z0-9가-힣+-]{2,24}/g) || [];

    for (const token of tokens) {
      const normalizedToken = normalizeDraftTagValue(token);

      if (!isUsableDraftTag(normalizedToken)) {
        continue;
      }

      const key = normalizedToken.toLowerCase();

      if (stopWords.has(key)) {
        continue;
      }

      if (/^\d+$/.test(normalizedToken) && normalizedToken.length < 4) {
        continue;
      }

      scores.set(key, (scores.get(key) || 0) + weight);

      if (!originals.has(key)) {
        originals.set(key, normalizedToken);
      }
    }
  }

  return Array.from(scores.entries())
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }

      return String(originals.get(left[0]) || "").localeCompare(String(originals.get(right[0]) || ""), "ko");
    })
    .map(([key]) => originals.get(key) || "")
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeImagePromptEntries(entries, draftContext = {}) {
  const normalizedEntries = Array.isArray(entries)
    ? entries.map((entry) => normalizeImagePromptEntry(entry)).filter((entry) => entry.prompt)
    : [];
  const imageTargetCount = resolveRequestedAutoImageCount(state.autoImageCount, draftContext);
  const fallbackEntries = deriveFallbackImagePrompts(draftContext, imageTargetCount);

  if (!normalizedEntries.length) {
    return fallbackEntries;
  }

  return mergeImagePromptEntries(normalizedEntries, fallbackEntries, draftContext).slice(0, imageTargetCount);
}

function mergeImagePromptEntries(entries, fallbackEntries, draftContext = {}) {
  const safeEntries = Array.isArray(entries) ? entries : [];
  const safeFallbacks = Array.isArray(fallbackEntries) && fallbackEntries.length
    ? fallbackEntries
    : deriveFallbackImagePrompts(draftContext, getAutoImageUpperBoundFromHtml(draftContext.html || ""));
  const usedIndexes = new Set();
  const mergedEntries = [];

  const representativeIndex = safeEntries.findIndex(isRepresentativeImagePromptEntry);
  const representativeFallback = safeFallbacks[0] || null;

  if (representativeIndex >= 0) {
    usedIndexes.add(representativeIndex);
    mergedEntries.push(completeImagePromptEntry(safeEntries[representativeIndex], representativeFallback));
  } else if (representativeFallback) {
    mergedEntries.push(representativeFallback);
  }

  for (const fallbackEntry of safeFallbacks.slice(1)) {
    const matchIndex = findMatchingImagePromptIndex(safeEntries, fallbackEntry, usedIndexes);

    if (matchIndex >= 0) {
      usedIndexes.add(matchIndex);
      mergedEntries.push(completeImagePromptEntry(safeEntries[matchIndex], fallbackEntry));
      continue;
    }

    mergedEntries.push(fallbackEntry);
  }

  return mergedEntries;
}

function completeImagePromptEntry(entry, fallbackEntry) {
  const fallback = fallbackEntry || {};

  return {
    slot: entry.slot || fallback.slot || "본문 이미지",
    prompt: entry.prompt || fallback.prompt || "네이버 블로그 본문용 설명 이미지",
    alt: entry.alt || fallback.alt || "블로그 이미지",
    placementHint: entry.placementHint || fallback.placementHint || "문단 중간 배치",
    headingHint: entry.headingHint || fallback.headingHint || "",
  };
}

function isRepresentativeImagePromptEntry(entry) {
  const label = normalizeImagePromptComparableText([
    entry?.slot,
    entry?.placementHint,
    entry?.headingHint,
  ].join(" "));

  return !String(entry?.headingHint || "").trim()
    || label.includes("대표")
    || label.includes("도입부")
    || /hero|cover|main/i.test(String(entry?.slot || ""));
}

function findMatchingImagePromptIndex(entries, fallbackEntry, usedIndexes) {
  let bestIndex = -1;
  let bestScore = 0;

  for (const [index, entry] of entries.entries()) {
    if (usedIndexes.has(index) || isRepresentativeImagePromptEntry(entry)) {
      continue;
    }

    const score = scoreImagePromptHeadingMatch(entry, fallbackEntry);

    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }

  return bestScore > 0 ? bestIndex : -1;
}

function scoreImagePromptHeadingMatch(entry, fallbackEntry) {
  const entryText = normalizeImagePromptComparableText([
    entry?.slot,
    entry?.headingHint,
    entry?.placementHint,
    entry?.prompt,
  ].join(" "));
  const fallbackHeading = normalizeImagePromptComparableText(fallbackEntry?.headingHint || fallbackEntry?.slot || "");
  const entrySectionNumber = extractImagePromptSectionNumber(entry?.headingHint || entry?.slot || entry?.placementHint || "");
  const fallbackSectionNumber = extractImagePromptSectionNumber(fallbackEntry?.headingHint || fallbackEntry?.slot || fallbackEntry?.placementHint || "");
  let score = 0;

  if (fallbackHeading && entryText.includes(fallbackHeading)) {
    score += 100;
  }

  if (entrySectionNumber && fallbackSectionNumber && entrySectionNumber === fallbackSectionNumber) {
    score += 80;
  }

  return score;
}

function normalizeImagePromptComparableText(value) {
  return normalizeBlogPlainText(value)
    .replace(/\s+/g, "")
    .toLowerCase();
}

function extractImagePromptSectionNumber(value) {
  const match = String(value || "").trim().match(/^(\d{1,2})\s*[.)번]?/);
  return match ? Number(match[1]) || 0 : 0;
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

function deriveFallbackImagePrompts(draftContext = {}, desiredCount = getDefaultAutoImageCount()) {
  const title = String(draftContext.title || state.topic || "블로그 포스팅").trim();
  const summary = String(draftContext.summary || "").trim();
  const tags = Array.isArray(draftContext.tags) ? draftContext.tags.filter(Boolean) : [];
  const headings = extractHeadingTexts(draftContext.html || "");
  const prompts = [];
  const targetCount = Math.max(1, Math.min(10, Number(desiredCount) || getDefaultAutoImageCount()));

  prompts.push({
    slot: "대표 이미지",
    prompt: typeof useEnglishPrompts==='function'&&useEnglishPrompts()?`Create a clear cover image about ${title}. Bright, clean, mobile-readable composition with minimal text. Context: ${summary}`:`${title} 주제를 직관적으로 보여주는 네이버 블로그 대표 이미지. 밝고 깔끔한 구도, 모바일 화면에서도 잘 보이는 구성, 과한 텍스트 없이 핵심 분위기만 전달.${summary ? ` 참고 요약: ${summary}` : ""}`,
    alt: `${title} 대표 이미지`,
    placementHint: "도입부 뒤",
    headingHint: "",
  });

  for (const heading of headings.slice(0, Math.max(0, targetCount - 1))) {
    prompts.push({
      slot: `${heading} 설명 이미지`,
      prompt: typeof useEnglishPrompts==='function'&&useEnglishPrompts()?`Illustrate ${heading} for the article ${title}. Use a clear informative scene focused on the key concepts, with minimal text.`:`${heading} 내용을 시각적으로 이해시키는 네이버 블로그 본문용 이미지. 제목 주제는 ${title}이며, 정보형 블로그에 어울리게 선명하고 설명적인 장면으로 구성. 과도한 텍스트 없이 핵심 요소만 표현.`,
      alt: `${heading} 관련 이미지`,
      placementHint: `${heading} 소제목 뒤`,
      headingHint: heading,
    });
  }

  while (prompts.length < targetCount) {
    const number = prompts.length + 1;
    const heading = headings[(number - 2) % Math.max(1, headings.length)] || title;
    prompts.push({ slot: `Supporting image ${number}`, prompt: `Create a distinct supporting scene ${number} about ${heading} for the article ${title}. Context: ${summary}. Use a different composition from other images.`, alt: heading, placementHint: "After a related paragraph", headingHint: headings.length ? heading : "" });
  }
  return prompts.slice(0, targetCount);
}

function getDefaultAutoImageCount() {
  return state.length === "long" ? 4 : state.length === "short" ? 1 : 3;
}

function resolveRequestedAutoImageCount(value, draftContext = state.draft) {
  const selectedValue = String(value || state.autoImageCount || "auto");
  const upperBound = getAutoImageUpperBoundFromHtml(draftContext?.html || "");

  if (selectedValue === "auto") {
    return Math.max(1, upperBound);
  }

  return Math.max(1, Math.min(10, Number(selectedValue) || getDefaultAutoImageCount()));
}

function getAutoImageUpperBoundFromHtml(html) {
  return analyzeAutoImageStructure(html).upperBound;
}

function analyzeAutoImageStructure(html) {
  const headings = extractHeadingTexts(html);
  const headingCount = headings.length;
  const numberedSectionMax = extractMaxNumberedSection(headings);
  const sectionCount = numberedSectionMax > 0 ? numberedSectionMax : headingCount;

  return {
    headingCount,
    numberedSectionMax,
    upperBound: Math.max(1, 1 + sectionCount),
  };
}

function extractMaxNumberedSection(headings) {
  return (Array.isArray(headings) ? headings : []).reduce((maxValue, heading) => {
    const match = String(heading || "").trim().match(/^(\d{1,2})\s*[.)]/);

    if (!match) {
      return maxValue;
    }

    return Math.max(maxValue, Number(match[1]) || 0);
  }, 0);
}

function extractHeadingTexts(html) {
  const template = document.createElement("template");
  template.innerHTML = String(html || "");

  return Array.from(template.content.querySelectorAll("h2, h3"))
    .map((heading) => normalizeBlogPlainText(heading.textContent || ""))
    .filter(Boolean);
}

function repairTruncatedJson(text) {
  let s = String(text || "");
  if (!s) return null;

  // 끝에서부터 마지막으로 등장하는 안전한 종료 지점(",", "}", "]")까지 자르기
  const lastSafe = Math.max(s.lastIndexOf('",'), s.lastIndexOf('},'), s.lastIndexOf('],'), s.lastIndexOf('"}'), s.lastIndexOf('"]'));
  if (lastSafe > 0 && lastSafe < s.length - 1) {
    s = s.slice(0, lastSafe + 1);
  }

  // 닫히지 않은 문자열이 있으면 닫기 (이스케이프되지 않은 따옴표 개수가 홀수인 경우)
  const quoteCount = (s.match(/(?<!\\)"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    s += '"';
  }

  // 트레일링 콤마 제거
  s = s.replace(/,\s*$/, "");

  // 열린 괄호/대괄호 개수만큼 닫기
  const opens = (s.match(/[{[]/g) || []).length;
  const closes = (s.match(/[}\]]/g) || []).length;
  const stack = [];
  for (const ch of s) {
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" && stack[stack.length - 1] === "{") stack.pop();
    else if (ch === "]" && stack[stack.length - 1] === "[") stack.pop();
  }
  while (stack.length) {
    const open = stack.pop();
    s += open === "{" ? "}" : "]";
  }

  return opens > closes ? s : null;
}

function tryParseJsonCandidate(candidate) {
  if (!candidate) {
    return null;
  }

  try {
    return JSON.parse(candidate);
  } catch {
    const repaired = repairJsonMultilineStrings(candidate);

    if (repaired !== candidate) {
      try {
        return JSON.parse(repaired);
      } catch {
        // 계속해서 잘림 복구 시도
      }
    }

    try {
      const truncationRepaired = repairTruncatedJson(candidate);
      if (truncationRepaired) {
        return JSON.parse(truncationRepaired);
      }
    } catch {
      // 복구 실패
    }

    return null;
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

function normalizeDraftHtml(rawHtml, rawText, options = {}) {
  const htmlCandidate = String(rawHtml || "").trim();

  if (htmlCandidate) {
    const baseHtml = looksLikeSupportedHtml(htmlCandidate)
      ? htmlCandidate
      : formatPlainBlogTextAsHtml(htmlCandidate, options);

    return applyEditorialThemeToHtml(baseHtml);
  }

  return applyEditorialThemeToHtml(formatPlainBlogTextAsHtml(rawText, options));
}

function looksLikeSupportedHtml(value) {
  return /<\/?(?:h2|h3|p|ul|ol|li|strong|b|em|i|blockquote|br|a|img)\b/i.test(String(value || ""));
}

function formatPlainBlogTextAsHtml(text, options = {}) {
  const normalized = normalizeBlogPlainText(text);

  if (!normalized) {
    return "";
  }

  const fragments = [];
  const summary = String(options.summary || "").trim();
  const { intro, sections, outro } = splitNumberedSections(normalized);

  if (summary) {
    fragments.push(`<blockquote>${escapeHtml(summary)}</blockquote>`);
  }

  fragments.push(...paragraphsToHtml(buildReadableParagraphs(intro)));

  for (const section of sections) {
    const splitSection = splitSectionHeadingAndBody(section.content, section.number);
    fragments.push(`<h2>${escapeHtml(`${section.number}. ${splitSection.heading}`)}</h2>`);
    fragments.push(...paragraphsToHtml(buildReadableParagraphs(splitSection.body)));
  }

  fragments.push(...paragraphsToHtml(buildReadableParagraphs(outro)));

  const html = fragments.join("");
  return html || markdownLikeTextToHtml(normalized);
}

function normalizeBlogPlainText(text) {
  return String(text || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/([.!?])\s*(\d+\.\s)/g, "$1\n\n$2")
    .replace(/(다\.)\s*(\d+\.\s)/g, "$1\n\n$2")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function splitNumberedSections(text) {
  const prepared = normalizeBlogPlainText(text);
  const sectionPattern = /(?:^|\n)(\d+)\.\s*([\s\S]*?)(?=(?:\n\d+\.\s)|$)/g;
  const sections = [];
  let lastIndex = 0;
  let firstMatchIndex = -1;
  let match = null;

  while ((match = sectionPattern.exec(prepared))) {
    if (firstMatchIndex === -1) {
      firstMatchIndex = match.index;
    }

    sections.push({
      number: match[1],
      content: String(match[2] || "").trim(),
    });

    lastIndex = sectionPattern.lastIndex;
  }

  if (!sections.length) {
    return {
      intro: prepared,
      sections: [],
      outro: "",
    };
  }

  return {
    intro: prepared.slice(0, firstMatchIndex).trim(),
    sections,
    outro: prepared.slice(lastIndex).trim(),
  };
}

function splitSectionHeadingAndBody(sectionText, number) {
  const normalized = normalizeBlogPlainText(sectionText);

  if (!normalized) {
    return {
      heading: `포인트 ${number}`,
      body: "",
    };
  }

  const sentenceBoundary = findFirstBlogSentenceBoundary(normalized);
  if (sentenceBoundary >= 16 && sentenceBoundary <= 44) {
    const heading = normalized.slice(0, sentenceBoundary + 1).trim();
    const body = normalized.slice(sentenceBoundary + 1).trim();
    return {
      heading,
      body: body || normalized,
    };
  }

  const splitIndex = findHeadingSplitIndex(normalized, 18, 34);
  if (splitIndex >= 0 && normalized.length - splitIndex >= 20) {
    return {
      heading: normalized.slice(0, splitIndex).trim(),
      body: normalized.slice(splitIndex).trim(),
    };
  }

  return {
    heading: `포인트 ${number}`,
    body: normalized,
  };
}

function findHeadingSplitIndex(text, minIndex, maxIndex) {
  const safeMax = Math.min(maxIndex, text.length - 1);

  for (let index = safeMax; index >= minIndex; index -= 1) {
    if (/\s/.test(text[index])) {
      return index;
    }
  }

  return -1;
}

function findFirstBlogSentenceBoundary(text) {
  for (let index = 0; index < text.length; index += 1) {
    if (isBlogSentenceBoundary(text, index)) {
      return index;
    }
  }

  return -1;
}

function splitBlogSentences(text) {
  const sentences = [];
  let startIndex = 0;

  for (let index = 0; index < text.length; index += 1) {
    if (!isBlogSentenceBoundary(text, index)) {
      continue;
    }

    const sentence = text.slice(startIndex, index + 1).trim();
    if (sentence) {
      sentences.push(sentence);
    }
    startIndex = index + 1;
  }

  const tail = text.slice(startIndex).trim();
  if (tail) {
    sentences.push(tail);
  }

  return sentences;
}

function isBlogSentenceBoundary(text, index) {
  const character = text[index];

  if (!/[.!?]/.test(character || "")) {
    return false;
  }

  if (character === "." && /\d/.test(text[index - 1] || "") && /\d/.test(text[index + 1] || "")) {
    return false;
  }

  return true;
}

function buildReadableParagraphs(text) {
  const normalized = normalizeBlogPlainText(text);

  if (!normalized) {
    return [];
  }

  if (normalized.includes("\n\n")) {
    return normalized
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);
  }

  const sentences = splitBlogSentences(normalized);

  if (sentences.length <= 2) {
    return [sentences.join(" ").trim()];
  }

  const paragraphs = [];
  let bucket = [];

  for (const sentence of sentences) {
    bucket.push(sentence);
    const bucketText = bucket.join(" ");

    if (bucket.length >= 2 || bucketText.length >= 110) {
      paragraphs.push(bucketText.trim());
      bucket = [];
    }
  }

  if (bucket.length) {
    paragraphs.push(bucket.join(" ").trim());
  }

  return paragraphs;
}

function paragraphsToHtml(paragraphs) {
  return paragraphs
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`);
}

function mergeInlineStyle(element, declarations) {
  if (!element?.style || !declarations || typeof declarations !== "object") {
    return;
  }

  for (const [property, value] of Object.entries(declarations)) {
    if (value === null || value === undefined || value === "") {
      continue;
    }
    element.style.setProperty(property, String(value));
  }
}

function normalizeTemplateAccentColor(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : "";
}

function mixHexColors(baseColor, targetColor, targetWeight) {
  const base = normalizeTemplateAccentColor(baseColor) || "#7d9463";
  const target = normalizeTemplateAccentColor(targetColor) || "#ffffff";
  const weight = Math.min(1, Math.max(0, Number(targetWeight) || 0));
  const channel = (color, offset) => Number.parseInt(color.slice(offset, offset + 2), 16);
  const mixed = [1, 3, 5].map((offset) => {
    const value = Math.round(channel(base, offset) * (1 - weight) + channel(target, offset) * weight);
    return value.toString(16).padStart(2, "0");
  });
  return `#${mixed.join("")}`;
}

function applyEditorialThemeToHtml(html) {
  const source = String(html || "").trim();

  if (!source) {
    return "";
  }

  const template = document.createElement("template");
  template.innerHTML = source;
  const content = template.content;
  const paragraphs = Array.from(content.querySelectorAll("p"));
  const firstParagraph = paragraphs[0] || null;
  const theme = getEditorialTheme(resolveFormatPresetValue());

  for (const node of Array.from(content.querySelectorAll("blockquote, h2, h3, p, ul, ol, li, a, img"))) {
    if (node.tagName === "BLOCKQUOTE") {
      // 네이버 에디터는 <blockquote>를 붙여넣는 즉시 자체 인용구 컴포넌트로 바꿔치기하면서
      // 인라인 배경/테두리 스타일을 전부 버립니다. <div>는 그런 자동 변환 대상이 아니라서
      // 커스텀 콜아웃 박스 색상이 그대로 유지되므로, 태그 자체를 div로 바꿔줍니다.
      const calloutDiv = document.createElement("div");
      while (node.firstChild) calloutDiv.appendChild(node.firstChild);
      node.replaceWith(calloutDiv);
      mergeInlineStyle(calloutDiv, {
        margin: "30px 0 34px",
        padding: "22px 24px",
        "background-color": theme.calloutBackground,
        color: theme.calloutText,
        "border-left": `4px solid ${theme.accent}`,
        "border-radius": "14px",
        "font-size": "17px",
        "font-weight": "600",
        "line-height": "1.95",
        "letter-spacing": "-0.01em",
      });
      continue;
    }

    if (node.tagName === "H2") {
      // 실제 운영 중인 다른 확장(전기 블로그 키워드 리서치)의 검증된 패턴을 따라,
      // border(테두리)+background-color를 함께 쓰는 실제 <h2> 태그를 그대로 유지합니다.
      mergeInlineStyle(node, {
        margin: "20px 0",
        padding: "15px",
        border: `2px solid ${theme.accent}`,
        "background-color": theme.headingBackground,
        color: theme.headingText,
        "font-size": "25px",
        "font-weight": "700",
        "line-height": "1.5",
        "letter-spacing": "-0.02em",
      });
      continue;
    }

    if (node.tagName === "H3") {
      mergeInlineStyle(node, {
        margin: "28px 0 14px",
        color: theme.subheadingText,
        "font-size": "21px",
        "font-weight": "700",
        "line-height": "1.55",
        "letter-spacing": "-0.015em",
      });
      continue;
    }

    if (node.tagName === "P") {
      mergeInlineStyle(node, {
        margin: node === firstParagraph ? "0 0 20px" : "0 0 18px",
        color: theme.bodyText,
        "font-size": node === firstParagraph ? "18px" : "17px",
        "line-height": node === firstParagraph ? "2" : "1.95",
        "letter-spacing": "-0.01em",
      });
      continue;
    }

    if (node.tagName === "UL" || node.tagName === "OL") {
      mergeInlineStyle(node, {
        margin: "0 0 20px",
        padding: "0 0 0 22px",
        color: theme.bodyText,
        "font-size": "16px",
        "line-height": "1.9",
      });
      continue;
    }

    if (node.tagName === "LI") {
      mergeInlineStyle(node, {
        margin: "0 0 8px",
      });
      continue;
    }

    if (node.tagName === "A") {
      mergeInlineStyle(node, {
        color: theme.linkText,
        "text-decoration": "underline",
      });
      continue;
    }

    if (node.tagName === "IMG") {
      mergeInlineStyle(node, {
        display: "block",
        margin: "26px auto",
        "border-radius": "16px",
        width: "100%",
      });
    }
  }

  return template.innerHTML;
}

function getEditorialTheme(preset) {
  const themes = {
    clean: {
      accent: "#7d9463",
      headingBackground: "#f5f8f1",
      headingText: "#24321f",
      subheadingText: "#5f744d",
      calloutBackground: "#f7faf4",
      calloutText: "#405337",
      bodyText: "#2d2924",
      linkText: "#2f6b5f",
    },
    magazine: {
      accent: "#315a8c",
      headingBackground: "#f1f5fb",
      headingText: "#1f3552",
      subheadingText: "#315a8c",
      calloutBackground: "#f5f8fc",
      calloutText: "#334b67",
      bodyText: "#272b31",
      linkText: "#245f9e",
    },
    review: {
      accent: "#d97745",
      headingBackground: "#fff5ee",
      headingText: "#713c24",
      subheadingText: "#a35431",
      calloutBackground: "#fff8f2",
      calloutText: "#74462f",
      bodyText: "#332b27",
      linkText: "#aa542e",
    },
    comparison: {
      accent: "#6657a5",
      headingBackground: "#f5f3fb",
      headingText: "#392f62",
      subheadingText: "#6657a5",
      calloutBackground: "#f8f6fd",
      calloutText: "#4d426f",
      bodyText: "#2d2a35",
      linkText: "#5d4fa0",
    },
    checklist: {
      accent: "#16847b",
      headingBackground: "#eef9f7",
      headingText: "#174d49",
      subheadingText: "#16736b",
      calloutBackground: "#f0faf8",
      calloutText: "#285e59",
      bodyText: "#263331",
      linkText: "#0e756d",
    },
    emotional: {
      accent: "#b76d7d",
      headingBackground: "#fcf3f5",
      headingText: "#663b45",
      subheadingText: "#9b5867",
      calloutBackground: "#fdf7f1",
      calloutText: "#705044",
      bodyText: "#352d2f",
      linkText: "#9c5364",
    },
  };
  const baseTheme = themes[resolveFormatPresetValue(preset)] || themes.clean;
  const customAccent = normalizeTemplateAccentColor(state.templateAccentColor);
  if (!customAccent) {
    return { ...baseTheme };
  }

  return {
    ...baseTheme,
    accent: customAccent,
    headingBackground: mixHexColors(customAccent, "#ffffff", 0.9),
    headingText: mixHexColors(customAccent, "#000000", 0.55),
    subheadingText: mixHexColors(customAccent, "#000000", 0.24),
    calloutBackground: mixHexColors(customAccent, "#ffffff", 0.94),
    calloutText: mixHexColors(customAccent, "#000000", 0.5),
    linkText: mixHexColors(customAccent, "#000000", 0.2),
  };
}

function cleanMarkdownText(text) {
  if (!text) return "";
  let clean = String(text);
  clean = clean.replace(/\[(.*?)\]\([^)]*\)/g, "$1");
  clean = clean.replace(/\*\*(.*?)\*\*/g, "$1");
  clean = clean.replace(/__(.*?)__/g, "$1");
  clean = clean.replace(/\*(.*?)\*/g, "$1");
  clean = clean.replace(/_(.*?)_/g, "$1");
  clean = clean.replace(/~~(.*?)~~/g, "$1");
  clean = clean.replace(/^#{1,6}\s+/gm, "");
  return clean;
}

function sanitizeDraftHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = String(html || "");
  const allowedTags = new Set(["H2", "H3", "P", "DIV", "UL", "OL", "LI", "STRONG", "B", "EM", "I", "BLOCKQUOTE", "BR", "A", "IMG", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD"]);
  const allowedAttrs = new Set(["href", "target", "rel", "src", "alt", "style", "colspan", "rowspan"]);

  sanitizeChildren(template.content);
  repairBrokenDecimalParagraphs(template.content);
  return template.innerHTML;

  function sanitizeChildren(parent) {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        node.nodeValue = cleanMarkdownText(node.nodeValue);
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

function repairBrokenDecimalParagraphs(root) {
  const paragraphs = Array.from(root.querySelectorAll("p"));

  for (const paragraph of paragraphs) {
    let nextParagraph = paragraph.nextElementSibling;

    while (
      nextParagraph?.tagName === "P"
      && endsWithBrokenDecimalPrefix(paragraph.textContent || "")
      && startsWithBrokenDecimalSuffix(nextParagraph.textContent || "")
    ) {
      trimLeadingInlineWhitespace(nextParagraph);

      while (nextParagraph.firstChild) {
        paragraph.appendChild(nextParagraph.firstChild);
      }

      const consumedParagraph = nextParagraph;
      nextParagraph = nextParagraph.nextElementSibling;
      consumedParagraph.remove();
    }
  }
}

function endsWithBrokenDecimalPrefix(text) {
  return /\d\.$/.test(String(text || "").trim());
}

function startsWithBrokenDecimalSuffix(text) {
  return /^\d(?:\d|[a-zA-Z가-힣%])/u.test(String(text || "").trim());
}

function trimLeadingInlineWhitespace(element) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const firstTextNode = walker.nextNode();

  if (!firstTextNode) {
    return;
  }

  firstTextNode.textContent = String(firstTextNode.textContent || "").replace(/^\s+/, "");
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

    // AI 응답이나 이전 저장본에 남은 취소선 스타일이 SmartEditor로 전달되지 않게 합니다.
    if (property === "text-decoration" && /line-through/i.test(value)) {
      continue;
    }

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
        return `<${level}>${escapeHtml(paragraph.replace(/^#{2,3}\s+/, ""))}</${level}>`;
      }

      return `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
}

function splitKeywords(value) {
  return String(value || "")
    .split(/[,#\n]/)
    .map((keyword) => keyword.trim())
    .filter(Boolean);
}

function normalizeCustomLength(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.max(500, Math.min(10000, Math.round(count))) : 2000;
}

function withBlogGenerationTargets(prompt) {
  const english = typeof useEnglishPrompts === "function" && useEnglishPrompts();
  const rules = [];
  if (state.length === "custom") {
    const target = normalizeCustomLength(state.customLength);
    rules.push(english
      ? `The article body must target ${target} characters excluding whitespace (not words), within ${Math.ceil(target * 0.9)}–${Math.floor(target * 1.1)} characters. Exclude title, summary, tags and image prompts from the count.`
      : `본문은 공백 제외 ${target}자를 목표로 ${Math.ceil(target * 0.9)}~${Math.floor(target * 1.1)}자 범위로 작성하세요. 제목, summary, 태그, 이미지 프롬프트는 글자 수에서 제외합니다.`);
  }
  if (state.autoImageCount !== "auto") {
    const count = resolveRequestedAutoImageCount(state.autoImageCount);
    rules.push(english
      ? `Provide exactly ${count} distinct image_prompts, including the cover. Match images to relevant paragraphs or headings; the image count need not match the number of headings. This overrides the default image count rule.`
      : `대표 이미지를 포함하여 image_prompts를 정확히 ${count}개 작성하세요. 관련 문단이나 소제목에 배치하고 개수에 맞게 서로 다른 장면을 구성하세요. 소제목 개수와 이미지 개수가 같을 필요는 없으며, 이 개수는 기본 이미지 개수 규칙보다 우선합니다.`);
  }
  return rules.length ? `${prompt}\n\n${rules.join("\n")}` : prompt;
}

function normalizeArticleTypeValue(value) {
  const normalized = String(value || "auto").trim().toLowerCase();
  return ["auto", "information", "review", "comparison", "howto", "place", "story", "checklist"].includes(normalized)
    ? normalized
    : "auto";
}

function normalizeFormatPresetValue(value) {
  const normalized = String(value || "auto").trim().toLowerCase();
  return ["auto", "clean", "magazine", "review", "comparison", "checklist", "emotional"].includes(normalized)
    ? normalized
    : "auto";
}

function resolveFormatPresetValue(formatPreset = state.formatPreset, articleType = state.articleType) {
  const normalizedPreset = normalizeFormatPresetValue(formatPreset);

  if (normalizedPreset !== "auto") {
    return normalizedPreset;
  }

  return ({
    review: "review",
    comparison: "comparison",
    howto: "checklist",
    checklist: "checklist",
    place: "magazine",
    story: "emotional",
  })[normalizeArticleTypeValue(articleType)] || "clean";
}

function normalizeNaverSearchSourceValue(value) {
  const normalized = String(value || "section-blog").trim().toLowerCase();
  return ["section-blog", "naver-search"].includes(normalized) ? normalized : "section-blog";
}

function normalizeProviderValue(value) {
  const normalized = String(value || "gemini").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(AI_PROVIDERS, normalized) ? normalized : "gemini";
}

function getSelectedAiProvider(kind = "text") {
  const providerId = kind === "image" ? state.imageProvider : state.textProvider;
  return AI_PROVIDERS[normalizeProviderValue(providerId)] || AI_PROVIDERS.gemini;
}

function getSelectedAiLabel(kind = "text") {
  return getSelectedAiProvider(kind).label;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[character]));
}

globalThis.ddalkkakDraft = { state, withBlogGenerationTargets, validateBlogDraftResponse, parseDraftResponse, buildBackendResearchPayload };
})();
