if (window.__geminiContentScriptLoaded) {
  // 중복 주입 방지
} else {
  window.__geminiContentScriptLoaded = true;

const promptSelectorCandidates = [
  'rich-textarea div[contenteditable="true"]',
  'div[contenteditable="true"][role="textbox"]',
  'div.ql-editor[contenteditable="true"]',
  'div[aria-label*="프롬프트 입력"]',
  'div[aria-label*="Prompt"]',
  'div.ql-editor',
  "textarea",
];

const sendButtonSelectorCandidates = [
  'button[aria-label*="보내기"]',
  'button[aria-label*="보내"]',
  'button[aria-label*="Send message"]',
  'button[aria-label*="Send"]',
  'button:has(mat-icon[fonticon="arrow_upward"])',
  'button:has(gem-icon)',
  'button[mattooltip*="Send"]',
  'button[mattooltip*="보내"]',
  'button[data-test-id="send-button"]',
];

const responseSelectorCandidates = [
  "model-response",
  "response-container",
  ".response-container",
  '[data-message-author-role="model"]',
  "message-content[model-response]",
  "message-content",
];

const newChatSelectorCandidates = [
  'a[data-test-id="side-nav-sparkle-button"]',
  '[data-test-id*="sparkle-button"]',
  'button[aria-label*="New chat"]',
  'button[aria-label*="새 채팅"]',
  'a[aria-label*="New chat"]',
  'a[aria-label*="새 채팅"]',
  '[data-test-id="new-chat-button"]',
];

const temporaryChatSelectorCandidates = [
  'button[aria-label*="Temporary chat"]',
  'a[aria-label*="Temporary chat"]',
  'button[aria-label*="Temporary"]',
  'a[aria-label*="Temporary"]',
  'button[aria-label*="임시 채팅"]',
  'a[aria-label*="임시 채팅"]',
  'button[mattooltip*="Temporary"]',
  'button[title*="Temporary"]',
  '[data-test-id*="temporary"]',
];

const temporaryChatTextCandidates = [
  "temporary chat",
  "temporary",
  "임시 채팅",
  "임시채팅",
];

const imageModeSelectorCandidates = [
  'button[aria-label*="Create an image"]',
  'button[aria-label*="create image"]',
  'button[aria-label*="이미지 만들기"]',
  'button[aria-label*="이미지 생성"]',
  'button.toolbox-drawer-item-list-button',
  'button[mat-list-item]',
  '[role="button"][aria-label*="Create an image"]',
  '[role="button"][aria-label*="create image"]',
  '[role="button"][aria-label*="이미지 만들기"]',
  '[role="button"][aria-label*="이미지 생성"]',
  '[role="tab"][aria-label*="Create an image"]',
  '[role="tab"][aria-label*="이미지 만들기"]',
  '[role="option"][aria-label*="Create an image"]',
  '[role="option"][aria-label*="이미지 만들기"]',
  'button[mattooltip*="Create an image"]',
  'button[mattooltip*="이미지 만들기"]',
  'button[title*="Create an image"]',
  'button[title*="이미지 만들기"]',
  '[data-test-id*="image"]',
];

const imageModeTextCandidates = [
  "create an image",
  "create image",
  "이미지 만들기",
  "이미지 생성",
];
const DEBUG_LOG_SOURCE = "gemini-content";

let submissionQueue = Promise.resolve();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "NB_GEMINI_PING") {
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type !== "NB_GEMINI_SUBMIT") {
    return false;
  }

  submissionQueue = submissionQueue
    .then(async () => {
      await appendDebugLog("submit.request.received", {
        promptLength: String(message.prompt || "").length,
        promptPreview: summarizeTextForLog(message.prompt || "", 180),
        options: sanitizeLogValue(message.options || {}),
      });
    })
    .then(() => submitPrompt(message.prompt, message.options || {}))
    .then((payload) => sendResponse({ ok: true, ...payload }))
    .catch((error) => {
      void appendDebugLog("submit.request.failed", {
        error: error?.message || String(error),
      });
      sendResponse({ ok: false, error: error?.message || String(error) });
    });

  return true;
});

async function submitPrompt(prompt, options) {
  await appendDebugLog("submit.started", {
    href: location.href,
    promptLength: String(prompt || "").length,
    promptPreview: summarizeTextForLog(prompt || "", 180),
    options: sanitizeLogValue(options),
  });

  if (options.temporaryChat === true) {
    const temporaryChatStarted = await tryStartTemporaryChat();
    if (temporaryChatStarted) await waitForNewChatReady();
    if (!temporaryChatStarted && options.newChat === true) {
      await tryStartNewChat();
    }
  } else if (options.newChat === true) {
    await tryStartNewChat();
  }

  if (options.imageMode === true) {
    try {
      await ensureImageGenerationMode();
    } catch (error) {
      if (options.requireImageMode === true) {
        throw error;
      }
    }
  }

  const editor = await waitForPromptEditor();
  const previousSignature = getLatestResponseSignature();
  fillPromptEditor(editor, prompt);
  const attachedImages = await attachInputImages(editor, options.inputImages || [], options.requireAllInputImages === true ? 10 : 3);
  if (options.requireAllInputImages === true && attachedImages !== (options.inputImages || []).length) {
    throw new Error('사진을 모두 첨부하지 못했습니다. Gemini의 첨부 상태를 확인한 뒤 다시 시도하세요.');
  }

  // Angular/Quill의 상태 변경 인식을 돕기 위해 input 이벤트를 한 번 더 디스패치합니다.
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(150);

  // 엔터 키 입력 이벤트를 전송하여 제미나이의 자체 전송 함수를 실행시킵니다.
  const enterEvents = ["keydown", "keypress", "keyup"];
  for (const type of enterEvents) {
    editor.dispatchEvent(new KeyboardEvent(type, {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    }));
  }

  await appendDebugLog("submit.sent", {
    previousSignature,
    collectImages: options.collectImages === true,
  });

  return waitForCompletedResponse(previousSignature, {
    timeoutMs: options.timeoutMs || 240000,
    collectImages: options.collectImages === true,
  });
}

async function waitForPromptEditor(timeoutMs = 30000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const editor = findFirstVisibleElement(promptSelectorCandidates);
    if (editor) {
      return editor;
    }
    await sleep(300);
  }

  throw new Error("Gemini 입력창을 찾지 못했습니다. Gemini에 로그인되어 있고 채팅 화면이 열려 있는지 확인해 주세요.");
}

async function waitForSendButton(timeoutMs = 15000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const button = findFirstVisibleElement(sendButtonSelectorCandidates);
    if (button && !isElementDisabled(button)) {
      return button;
    }
    await sleep(250);
  }

  throw new Error("Gemini 보내기 버튼을 찾지 못했습니다.");
}

async function waitForCompletedResponse(previousSignature, options) {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs;
  const requiresImages = options.collectImages === true;
  let seenNewResponse = false;
  let lastText = "";
  let lastImageCount = 0;
  let stablePasses = 0;

  while (Date.now() - startedAt < timeoutMs) {
    const latest = getLatestResponse();
    const hasNewSignature = latest.signature && latest.signature !== previousSignature;
    const hasContent = requiresImages ? latest.imageCount > 0 : (latest.text || latest.imageCount > 0);

    if (hasNewSignature && hasContent) {
      seenNewResponse = true;
    }

    // Pro can pause for several seconds while thinking or streaming JSON.
    // Only count stability after generation stops; a pause is not completion.
    if (isGenerating() || !hasNewSignature || !hasContent) {
      stablePasses = 0;
      lastText = "";
      lastImageCount = 0;
    } else if (seenNewResponse && hasContent) {
      if (latest.text === lastText && latest.imageCount === lastImageCount) {
        stablePasses += 1;
      } else {
        stablePasses = 0;
        lastText = latest.text;
        lastImageCount = latest.imageCount;
      }

      if (stablePasses >= 2) {
        // Canvas source is virtualized: innerText contains only the visible lines.
        // Read it only for this new response, never a previously open Canvas.
        if (!requiresImages && latest.element?.querySelector('immersive-entry-chip, inline-preview')) {
          latest.text = await collectCanvasSource(latest.element);
        }
        await appendDebugLog("response.completed", {
          previousSignature,
          timeoutMs,
          requiresImages,
          textLength: latest.text.length,
          imageCount: latest.imageCount,
          stablePasses,
        });
        return buildResponsePayload(latest, options.collectImages);
      }

    }

    await sleep(1200);
  }

  await appendDebugLog("response.timeout", {
    previousSignature,
    timeoutMs,
    requiresImages,
    seenNewResponse,
    lastTextLength: lastText.length,
    lastImageCount,
  });
  throw new Error("Gemini 응답 대기 시간이 초과되었습니다.");
}

async function buildResponsePayload(responseState, collectImages) {
  const images = collectImages && responseState.element ? await extractResponseImages(responseState.element) : [];

  await appendDebugLog("response.payload.ready", {
    collectImages: Boolean(collectImages),
    textLength: String(responseState.text || "").length,
    imageCount: images.length,
  });

  return {
    text: responseState.text,
    images,
  };
}

function fillPromptEditor(editor, prompt) {
  editor.focus();

  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    editor.value = "";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    editor.value = prompt;
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  const selection = getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.execCommand("delete", false);
  pasteTextIntoEditor(editor, prompt);

  if (normalizeText(editor.innerText || editor.textContent || "") !== normalizeText(prompt)) {
    editor.focus();
    const selection2 = getSelection();
    const range2 = document.createRange();
    range2.selectNodeContents(editor);
    selection2?.removeAllRanges();
    selection2?.addRange(range2);
    document.execCommand("delete", false);

    // HTML 특수문자 이스케이프 및 줄바꿈 -> <br> 변환
    const htmlContent = String(prompt || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");

    // 구글의 Trusted Types 정책 우회를 위한 헬퍼 구성
    let geminiPolicy;
    try {
      if (window.trustedTypes) {
        const policyName = "geminiExtensionPolicy_" + Math.random().toString(36).substring(2, 9);
        geminiPolicy = window.trustedTypes.createPolicy(policyName, {
          createHTML: (string) => string
        });
      }
    } catch {
      // 정책 생성이 실패할 경우 예외를 무시하고 일반 문자열 전달
    }

    const trustedHTML = geminiPolicy ? geminiPolicy.createHTML(htmlContent) : htmlContent;
    document.execCommand("insertHTML", false, trustedHTML);
  }
}

function pasteTextIntoEditor(editor, text) {
  const target = editor.closest("rich-textarea") || editor;
  const dataTransfer = new DataTransfer();
  dataTransfer.setData("text/plain", text);

  try {
    const pasteEvent = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer,
    });
    target.dispatchEvent(pasteEvent);
  } catch {
    const fallbackEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(fallbackEvent, "clipboardData", { configurable: true, value: dataTransfer });
    target.dispatchEvent(fallbackEvent);
  }
}

async function attachInputImages(editor, inputImages, maxImages = 3) {
  const images = normalizeInputImages(inputImages, maxImages);
  if (!images.length) return 0;
  const container = getAttachmentContainer(editor);
  const chipsBefore = countAttachedChips(container);
  const files = images.map(image => dataUrlToFile(image.dataUrl, image.name, image.type));
  await appendDebugLog('input.images.batch.prepared', {
    diagnosticVersion: 1, requestedCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    files: files.map((file, index) => ({ index: index + 1, bytes: file.size, type: file.type,
      extension: file.name.split('.').pop().toLowerCase().slice(0, 10) })),
    ...collectUploadDiagnostics(editor),
  });
  // One FileList/change event preserves the batch order and avoids replacing
  // an in-flight upload with the next single-file selection.
  const attachedByInput = await attachImageWithFileInput(files);
  if (!attachedByInput) {
    await appendDebugLog('input.images.paste.dispatched', pasteImageFileIntoEditor(editor, files));
  }
  const expectedCount = chipsBefore + files.length;
  const completed = await waitForImageUploadsToComplete(editor, expectedCount, 60000);
  const attachedCount = Math.max(0, countAttachedChips(container) - chipsBefore);
  await appendDebugLog('input.images.attached', {
    requestedCount: files.length, attachedCount, chipsBefore, completed,
    method: attachedByInput ? 'batch-file-input' : 'batch-paste',
  });
  // Never retry an uncertain batch: it can duplicate already queued photos.
  if (!completed || attachedCount !== files.length) {
    throw new Error('사진 첨부 또는 업로드 완료를 확인하지 못했습니다. Gemini 첨부 상태를 확인한 뒤 다시 시도하세요.');
  }
  return attachedCount;
}

async function collectCanvasSource(responseElement) {
  const canvas = responseElement.querySelector('inline-preview');
  const fail = () => new Error('Gemini Canvas source could not be read completely. Please ask Gemini to return the complete HTML or JSON in a code block in the chat, without Canvas, and try again.');
  if (!canvas) throw fail();
  const codeTab = canvas.querySelector('mat-button-toggle[value="code"] button');
  const previewTab = canvas.querySelector('mat-button-toggle[value="preview"] button');
  const restorePreview = previewTab?.getAttribute('aria-checked') === 'true';
  const previousFocus = document.activeElement;
  try {
    if (codeTab?.getAttribute('aria-checked') !== 'true') codeTab?.click();
    let editor;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      editor = canvas.querySelector('.monaco-editor textarea.inputarea');
      if (editor && isVisible(editor)) break;
      await sleep(200);
    }
    if (!editor || !isVisible(editor)) throw fail();
    // Monaco's textarea is an accessibility excerpt, not the full model.
    // Its copy handler supplies the full selection to this in-memory transfer.
    // No system clipboard read/write or extra permission is needed.
    const mac = /Mac/i.test(navigator.platform || '');
    let previous = '';
    let stable = 0;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      if (!responseElement.isConnected) throw fail();
      editor.focus();
      editor.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'a', code: 'KeyA', keyCode: 65, which: 65,
        ctrlKey: !mac, metaKey: mac, bubbles: true, cancelable: true,
      }));
      await sleep(100);
      const transfer = new DataTransfer();
      const copy = new ClipboardEvent('copy', { clipboardData: transfer, bubbles: true, cancelable: true });
      editor.dispatchEvent(copy);
      const text = transfer.getData('text/plain').replace(/\r\n/g, '\n').trim();
      // Require Monaco to handle the event; never fall back to truncated view-lines.
      if (!copy.defaultPrevented) throw fail();
      stable = !isGenerating() && isCanvasSourceComplete(text) && text === previous ? stable + 1 : 0;
      previous = text;
      if (stable >= 2) {
        await appendDebugLog('response.canvas.collected', { textLength: text.length });
        return text;
      }
      await sleep(1200);
    }
    throw fail();
  } catch (error) {
    await appendDebugLog('response.canvas.failed', { reason: error?.message || String(error) });
    throw fail();
  } finally {
    if (restorePreview) previewTab?.click();
    if (previousFocus?.isConnected) previousFocus.focus();
  }
}

function isCanvasSourceComplete(text) {
  if (!text || /^\s*…/m.test(text)) return false;
  try { JSON.parse(text); return true; } catch (_) { /* HTML below */ }
  return /<(?:p|div|article|section|html|h[1-6])\b/i.test(text)
    && /<\/(?:p|div|article|section|html|body|ul|ol|blockquote|h[1-6])>\s*(?:<!--[\s\S]*?-->\s*)*$/i.test(text);
}

function getAttachmentContainer(editor) {
  // Thumbnails are siblings of rich-textarea, not its children.
  return editor.closest('input-container, .input-area-container, .input-area, form') || document.body;
}

async function waitForImageUploadsToComplete(editor, expectedCount, timeoutMs = 25000) {
  if (expectedCount <= 0) return;

  const container = getAttachmentContainer(editor);
  await appendDebugLog("input.upload.wait.started", {
    expectedCount,
    containerTagName: container.tagName,
  });

  const startedAt = Date.now();

  // 1단계: DOM에 첨부 칩(썸네일)들이 나타날 때까지 대기 (최대 5초)
  let chipsDetected = false;
  while (Date.now() - startedAt < 5000) {
    const currentChipsCount = countAttachedChips(container);
    if (currentChipsCount >= expectedCount) {
      chipsDetected = true;
      break;
    }
    await sleep(200);
  }

  await appendDebugLog("input.upload.chips.detected", {
    chipsDetected,
    currentCount: countAttachedChips(container),
    elapsedMs: Date.now() - startedAt,
    ...collectUploadDiagnostics(editor),
  });

  // 2단계: 로딩/업로드 중임을 표시하는 모든 프로그레스 바/스피너가 사라질 때까지 대기
  const progressSelectors = [
    'mat-progress-bar',
    'mat-progress-spinner',
    '[role="progressbar"]',
    '.loading',
    '.spinner',
    'input-attachment-chip[loading]',
    '.upload-progress',
    'div:has(> mat-progress-spinner)'
  ];

  let checkCount = 0;
  while (Date.now() - startedAt < timeoutMs) {
    let hasProgress = false;
    for (const selector of progressSelectors) {
      const el = container.querySelector(selector);
      if (el && isVisible(el)) {
        hasProgress = true;
        break;
      }
    }

    if (!hasProgress && countAttachedChips(container) >= expectedCount) {
      // 업로드 완료 직후 미세한 딜레이를 두고 다시 확인해 레이스 컨디션 방지
      await sleep(500);
      let stillNoProgress = true;
      for (const selector of progressSelectors) {
        const el = container.querySelector(selector);
        if (el && isVisible(el)) {
          stillNoProgress = false;
          break;
        }
      }
      if (stillNoProgress && countAttachedChips(container) >= expectedCount) {
        await appendDebugLog("input.upload.wait.completed", {
          elapsedMs: Date.now() - startedAt,
          checkCount,
        });
        return true;
      }
    }

    checkCount++;
    await sleep(250);
  }

  await appendDebugLog("input.upload.wait.timeout", {
    elapsedMs: Date.now() - startedAt,
    checkCount,
    expectedCount,
    ...collectUploadDiagnostics(editor),
  });
  return false;
}

function countAttachedChips(container) {
  const chipSelectors = [
    'input-attachment-chip',
    '.attachment-chip',
    '.input-attachment',
    '[data-test-id="input-attachment-chip"]',
    '.thumbnail-container',
    '.image-preview',
    'mat-chip',
    'mat-basic-chip',
    'mat-mdc-basic-chip',
    'mat-mdc-chip',
    'img[alt="attachment"]',
    'img.gem-attachment-style-img'
  ];
  
  for (const selector of chipSelectors) {
    const chips = container.querySelectorAll(selector);
    if (chips.length > 0) {
      return chips.length;
    }
  }
  return 0;
}

// Capabilities and counts only: no photo bytes, file names, image URLs or chat text.
function collectUploadDiagnostics(editor) {
  try {
    const container = getAttachmentContainer(editor);
    const selectors = ['input-attachment-chip', '.attachment-chip', '.input-attachment',
      '[data-test-id="input-attachment-chip"]', '.thumbnail-container', '.image-preview',
      'mat-chip', 'mat-basic-chip', 'mat-mdc-basic-chip', 'mat-mdc-chip',
      'img[alt="attachment"]', 'img.gem-attachment-style-img'];
    const counts = root => Object.fromEntries(selectors.map(selector => [selector, root.querySelectorAll(selector).length]));
    const progress = Array.from(container.querySelectorAll('mat-progress-bar, mat-progress-spinner, [role="progressbar"], .loading, .spinner, .upload-progress'));
    return {
      editorTag: editor.tagName, editorConnected: editor.isConnected,
      containerTag: container.tagName, containerConnected: container.isConnected,
      containerChipCounts: counts(container), pageChipCounts: counts(document),
      containerImageCount: container.querySelectorAll('img').length,
      visibleProgressCount: progress.filter(isVisible).length,
      fileInputs: Array.from(document.querySelectorAll('input[type="file"]')).slice(0, 10)
        .map(input => ({ accept: String(input.accept || '').slice(0, 160), multiple: input.multiple, disabled: input.disabled })),
    };
  } catch (error) {
    return { diagnosticError: error?.name || 'Error' };
  }
}

function normalizeInputImages(inputImages, maxImages = 3) {
  return Array.isArray(inputImages)
    ? inputImages
      .map((image) => ({
        dataUrl: String(image?.dataUrl || "").trim(),
        name: sanitizeFileName(image?.name || "reference-image"),
        type: String(image?.type || "").trim(),
      }))
      .filter((image) => image.dataUrl.startsWith("data:image/"))
      .slice(0, maxImages)
    : [];
}

async function attachImageWithFileInput(file) {
  const files = Array.isArray(file) ? file : [file];
  const acceptsBatch = input => !input.disabled && (files.length === 1 || input.multiple) && files.every(item => acceptsImageFile(input, item));
  let inputs = Array.from(document.querySelectorAll('input[type="file"]'))
    .filter(acceptsBatch);
  // Batch paste works without opening an OS file picker. A content-script
  // prototype patch cannot reliably intercept the page world's picker click.
  if (!inputs.length && files.length > 1) {
    await appendDebugLog('input.images.file_input.unavailable', {
      requestedCount: files.length, totalInputCount: document.querySelectorAll('input[type="file"]').length,
      reason: 'no-compatible-multiple-input; batch-menu-discovery-skipped', fallback: 'batch-paste',
    });
    return false;
  }

  // 만약 input[type="file"]이 DOM에 없다면 "업로드 및 도구" 메뉴를 열어서 동적으로 생성하도록 유도합니다.
  if (!inputs.length) {
    const drawerSelectors = [
      'button[aria-label*="업로드 및 도구"]',
      'button[aria-label*="업로드"]',
      'button[aria-label*="Upload and tools"]',
      'button[aria-label*="Upload"]',
      'button[aria-label*="tools"]',
      'button:has(mat-icon[fonticon="plus"])',
      'button:has(gem-icon)',
    ];
    
    // 1단계: 업로드 및 도구 버튼 클릭해서 서랍/메뉴 열기
    let drawerButton = null;
    for (const selector of drawerSelectors) {
      const btn = document.querySelector(selector);
      if (btn && btn.offsetWidth > 0 && btn.offsetHeight > 0) {
        drawerButton = btn;
        break;
      }
    }
    
    if (drawerButton) {
      const isExpanded = drawerButton.getAttribute("aria-expanded") === "true" || 
                         drawerButton.getAttribute("aria-pressed") === "true";
      if (!isExpanded) {
        drawerButton.click();
        await sleep(600); // 메뉴가 렌더링되기를 대기
      }
      
      // 2단계: "파일 업로드" 메뉴 아이템 찾아서 클릭
      const uploadTextCandidates = ["파일 업로드", "파일", "Upload file", "Upload", "File"];
      const menuItems = Array.from(document.querySelectorAll('[role="menuitem"], button, a'))
        .filter(el => el.offsetWidth > 0 && el.offsetHeight > 0);
      
      let uploadItemButton = null;
      for (const candidate of uploadTextCandidates) {
        uploadItemButton = menuItems.find(el => (el.textContent || '').includes(candidate));
        if (uploadItemButton) break;
      }
      
      if (uploadItemButton) {
        // 3단계: HTMLInputElement.prototype.click 몽키 패치 적용 (파일 팝업 차단)
        const originalClick = HTMLInputElement.prototype.click;
        let clickIntercepted = false;
        
        HTMLInputElement.prototype.click = function() {
          if (this.type === 'file') {
            clickIntercepted = true;
            try {
              const dataTransfer = new DataTransfer();
              files.forEach(item => dataTransfer.items.add(item));
              
              try {
                this.files = dataTransfer.files;
              } catch {
                Object.defineProperty(this, "files", { configurable: true, value: dataTransfer.files });
              }
              
              this.dispatchEvent(new Event("input", { bubbles: true }));
              this.dispatchEvent(new Event("change", { bubbles: true }));
            } catch (e) {
              console.error("Image inject error in monkey patch:", e);
            }
            return;
          }
          return originalClick.call(this);
        };
        
        try {
          uploadItemButton.click();
          await sleep(800);
        } finally {
          HTMLInputElement.prototype.click = originalClick;
        }
        
        if (clickIntercepted) {
          await sleep(500);
          return true;
        }
      }
    }
    
    // 다시 inputs을 검색해봅니다.
    inputs = Array.from(document.querySelectorAll('input[type="file"]'))
      .filter(acceptsBatch);
  }

  for (const input of inputs.reverse()) {
    try {
      const dataTransfer = new DataTransfer();
      files.forEach(item => dataTransfer.items.add(item));

      try {
        input.files = dataTransfer.files;
      } catch {
        Object.defineProperty(input, "files", { configurable: true, value: dataTransfer.files });
      }

      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await appendDebugLog('input.images.file_input.dispatched', {
        requestedCount: files.length, assignedCount: input.files?.length || 0,
        accept: String(input.accept || '').slice(0, 160), multiple: input.multiple,
      });
      await sleep(500);
      return true;
    } catch (e) {
      // Try the next file input.
      await appendDebugLog('input.images.file_input.failed', { errorType: e?.name || 'Error', requestedCount: files.length });
    }
  }

  return false;
}

function pasteImageFileIntoEditor(editor, file) {
  const target = editor.closest("rich-textarea") || editor;
  target.focus();
  const dataTransfer = new DataTransfer();
  (Array.isArray(file) ? file : [file]).forEach(item => dataTransfer.items.add(item));

  let handled = false;
  let eventFallback = false;
  try {
    const pasteEvent = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer,
    });
    target.dispatchEvent(pasteEvent);
    handled = pasteEvent.defaultPrevented;
  } catch {
    eventFallback = true;
    const fallbackEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(fallbackEvent, "clipboardData", { configurable: true, value: dataTransfer });
    target.dispatchEvent(fallbackEvent);
    handled = fallbackEvent.defaultPrevented;
  }
  target.dispatchEvent(new Event("input", { bubbles: true }));
  return { targetTag: target.tagName, targetConnected: target.isConnected,
    requestedCount: dataTransfer.files.length, clipboardItemCount: dataTransfer.items.length,
    defaultPrevented: handled, eventFallback, trusted: false };
}

function acceptsImageFile(input, file) {
  const accept = String(input.accept || "").toLowerCase();

  if (!accept) {
    return true;
  }

  const type = String(file.type || "").toLowerCase();
  const extension = `.${String(file.name || "").split(".").pop().toLowerCase()}`;

  return accept.includes("image") || accept.includes(type) || accept.includes(extension);
}

function dataUrlToFile(dataUrl, name, fallbackType) {
  const safeDataUrl = String(dataUrl || "");
  const commaIndex = safeDataUrl.indexOf(",");

  if (commaIndex < 0) {
    throw new Error("첨부 이미지 data URL 형식이 올바르지 않습니다.");
  }

  const header = safeDataUrl.slice(0, commaIndex);
  const data = safeDataUrl.slice(commaIndex + 1);
  const type = (/^data:([^;,]+)/i.exec(header)?.[1] || fallbackType || "image/png").toLowerCase();
  const binary = /;base64/i.test(header) ? atob(data) : decodeURIComponent(data);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new File([bytes], ensureImageFileName(name, type), { type });
}

function ensureImageFileName(name, type) {
  const safeName = sanitizeFileName(name || "reference-image");

  if (/\.(png|jpe?g|webp|gif)$/i.test(safeName)) {
    return safeName;
  }

  const extension = type.includes("jpeg") ? "jpg" : type.includes("webp") ? "webp" : type.includes("gif") ? "gif" : "png";
  return `${safeName}.${extension}`;
}

function sanitizeFileName(value) {
  return String(value || "reference-image")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "reference-image";
}

async function tryStartNewChat() {
  // An already-empty start page is safe even when the sidebar is collapsed.
  if (isFreshChatPage()) {
    await appendDebugLog("new.chat.ready", { alreadyFresh: true });
    return;
  }
  const button = findFirstVisibleElement(newChatSelectorCandidates);
  if (!button || isElementDisabled(button)) {
    await appendDebugLog("new.chat.skipped", {
      reason: "button_not_found_or_disabled",
    });
    throw new Error("새 대화를 시작하지 못했습니다. AI 사이트에서 새 대화를 연 뒤 다시 시도해 주세요. 기존 대화에는 요청을 보내지 않았습니다.");
  }

  button.click();
  await appendDebugLog("new.chat.clicked", {
    label: summarizeTextForLog(getElementLabel(button), 120),
  });
  await sleep(1200);
  await waitForNewChatReady();
}

function isFreshChatPage() {
  return /^\/app\/?$/.test(location.pathname) && !getLatestResponseSignature();
}

async function waitForNewChatReady() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (isFreshChatPage()) {
      await appendDebugLog("new.chat.ready", { href: location.href });
      return;
    }
    await sleep(250);
  }
  await appendDebugLog("new.chat.failed", {
    reason: "fresh_page_not_confirmed", href: location.href,
    hasPreviousResponse: Boolean(getLatestResponseSignature()),
  });
  throw new Error("새 대화 전환을 확인하지 못했습니다. AI 사이트에서 새 대화를 연 뒤 다시 시도해 주세요. 기존 대화에는 요청을 보내지 않았습니다.");
}

async function tryStartTemporaryChat() {
  const button = findTemporaryChatButton();
  if (!button || isElementDisabled(button)) {
    await appendDebugLog("temporary.chat.skipped", {
      reason: "button_not_found_or_disabled",
    });
    return false;
  }

  activateElement(button);
  await appendDebugLog("temporary.chat.clicked", {
    label: summarizeTextForLog(getElementLabel(button), 120),
  });
  await sleep(1400);
  return true;
}

async function ensureImageGenerationMode(timeoutMs = 20000) {
  if (isImageGenerationModeActive()) {
    await appendDebugLog("image.mode.already_active", {});
    return;
  }

  // 최신 제미나이 UI에서는 "업로드 및 도구" 서랍 메뉴 안에 "이미지 만들기" 버튼이 숨겨져 있을 수 있습니다.
  // 따라서 서랍 메뉴가 존재하고 닫혀 있다면 먼저 열어줍니다.
  try {
    await ensureToolsDrawerOpen();
  } catch (error) {
    await appendDebugLog("image.mode.drawer_open_failed", {
      error: error?.message || String(error),
    });
  }

  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const button = findImageModeButton();
    if (button && !isElementDisabled(button)) {
      activateElement(button);
      await appendDebugLog("image.mode.activated", {
        label: summarizeTextForLog(getElementLabel(button), 120),
      });
      await sleep(900);
      return;
    }
    await sleep(250);
  }

  throw new Error("Gemini 이미지 생성 모드를 찾지 못했습니다.");
}

async function ensureToolsDrawerOpen() {
  const drawerSelectors = [
    'button[aria-label*="업로드 및 도구"]',
    'button[aria-label*="업로드"]',
    'button[aria-label*="Upload and tools"]',
    'button[aria-label*="Upload"]',
    'button[aria-label*="tools"]',
  ];
  const drawerButton = findFirstVisibleElement(drawerSelectors);
  if (drawerButton) {
    const isExpanded = drawerButton.getAttribute("aria-expanded") === "true" || 
                       drawerButton.getAttribute("aria-pressed") === "true" ||
                       hasSelectedState(drawerButton);
    if (!isExpanded) {
      drawerButton.click();
      await sleep(600); // 서랍 메뉴가 애니메이션과 함께 열리기를 대기
    }
  }
}


function getLatestResponse() {
  const matches = Array.from(document.querySelectorAll(responseSelectorCandidates.join(",")))
    .filter(isVisible)
    .map((element) => ({
      element,
      text: normalizeText(element.innerText || element.textContent || ""),
      imageCount: getVisibleResponseImages(element).length,
    }))
    .filter((candidate) => candidate.text || candidate.imageCount > 0);

  const latest = matches.at(-1);

  if (!latest) {
    return { signature: "", text: "", imageCount: 0, element: null };
  }

  return {
    signature: `${matches.length}:${latest.text.slice(0, 160)}:${latest.imageCount}`,
    text: latest.text,
    imageCount: latest.imageCount,
    element: latest.element,
  };
}

function getLatestResponseSignature() {
  return getLatestResponse().signature;
}

function getVisibleResponseImages(container) {
  const selectors = [
    ".attachment-container.generated-images img",
    "generated-image img",
    "single-image.generated-image img",
    ".inline-image-container img",
    "img",
  ];
  const images = collectUniqueElements(
    selectors.flatMap((selector) => Array.from(container.querySelectorAll(selector)))
  );

  return images.filter((image) => {
    if (!isVisible(image)) {
      return false;
    }

    const rect = image.getBoundingClientRect();
    return rect.width >= 96 && rect.height >= 96;
  });
}

async function extractResponseImages(container) {
  const images = getVisibleResponseImages(container);
  const payloads = [];

  for (const image of images) {
    const dataUrl = await imageSourceToDataUrl(image.currentSrc || image.src);
    if (dataUrl) {
      payloads.push(dataUrl);
    }
  }

  await appendDebugLog("response.images.extracted", {
    visibleCount: images.length,
    convertedCount: payloads.length,
  });

  return payloads;
}

async function imageSourceToDataUrl(src) {
  if (!src) {
    return "";
  }
  if (src.startsWith("data:")) {
    return src;
  }

  if (/^https?:\/\//i.test(src)) {
    try {
      const remoteResult = await chrome.runtime.sendMessage({
        type: "NB_FETCH_IMAGE_AS_DATA_URL",
        url: src,
      });

      if (remoteResult?.ok && typeof remoteResult.dataUrl === "string" && remoteResult.dataUrl.startsWith("data:image/")) {
        return remoteResult.dataUrl;
      }
    } catch (error) {
      await appendDebugLog("response.image.remote_fetch_failed", {
        host: summarizeImageSourceHost(src),
        error: error?.message || String(error),
      });
    }

    // HTTP(S) 이미지는 콘텐츠 스크립트에서 직접 fetch하면 CORS에 막힐 수 있습니다.
    // 백그라운드 프록시가 실패한 경우 빈 값으로 종료해 브라우저 CORS 오류를 방지합니다.
    return "";
  }

  try {
    const response = await fetch(src);
    const blob = await response.blob();
    return await blobToDataUrl(blob);
  } catch {
    return "";
  }
}

function summarizeImageSourceHost(src) {
  try {
    return new URL(String(src || "")).hostname;
  } catch {
    return "";
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function isGenerating() {
  return Boolean(findFirstVisibleElement([
    'button[aria-label*="Stop"]',
    'button[aria-label*="중지"]',
    'button[mattooltip*="Stop"]',
    'button[mattooltip*="중지"]',
  ]));
}

function findImageModeButton() {
  const exactMatch = findFirstVisibleElement(imageModeSelectorCandidates, isImageModeElement);
  if (exactMatch) {
    return exactMatch;
  }

  const broadMatches = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"], [role="option"], mat-chip-option'));
  return broadMatches.find((element) => isVisible(element) && isImageModeElement(element)) || null;
}

function isImageGenerationModeActive() {
  const button = findImageModeButton();
  return Boolean(button && hasSelectedState(button));
}

function findTemporaryChatButton() {
  const exactMatch = findFirstVisibleElement(temporaryChatSelectorCandidates, isTemporaryChatElement);
  if (exactMatch) {
    return exactMatch;
  }

  const broadMatches = Array.from(document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="option"], [role="tab"], mat-chip-option'));
  return broadMatches.find((element) => isVisible(element) && isTemporaryChatElement(element)) || null;
}

function isImageModeElement(element) {
  const label = getElementLabel(element).toLowerCase();
  return imageModeTextCandidates.some((candidate) => label.includes(candidate));
}

function isTemporaryChatElement(element) {
  const label = getElementLabel(element).toLowerCase();
  return temporaryChatTextCandidates.some((candidate) => label.includes(candidate));
}

function getElementLabel(element) {
  return normalizeText(
    element.getAttribute("aria-label")
      || element.getAttribute("mattooltip")
      || element.getAttribute("title")
      || element.innerText
      || element.textContent
      || ""
  );
}

function hasSelectedState(element) {
  const nodes = [element, ...getAncestorChain(element, 3)];
  return nodes.some((node) => {
    const className = typeof node.className === "string" ? node.className : "";
    return node.getAttribute("aria-pressed") === "true"
      || node.getAttribute("aria-selected") === "true"
      || node.getAttribute("aria-checked") === "true"
      || node.getAttribute("data-selected") === "true"
      || /selected|active|checked|current|mdc-evolution-chip--selected/i.test(className);
  });
}

function getAncestorChain(element, maxDepth) {
  const nodes = [];
  let current = element.parentElement;

  while (current && nodes.length < maxDepth) {
    nodes.push(current);
    current = current.parentElement;
  }

  return nodes;
}

function activateElement(element) {
  element.scrollIntoView({ block: "center", inline: "center" });
  element.focus();
  element.click();
}

function findFirstVisibleElement(selectors, predicate = null) {
  for (const selector of selectors) {
    const matches = Array.from(document.querySelectorAll(selector));
    const visible = matches.find((element) => isVisible(element) && (!predicate || predicate(element)));
    if (visible) {
      return visible;
    }
  }
  return null;
}

function collectUniqueElements(elements) {
  return Array.from(new Set(elements));
}

function isElementDisabled(element) {
  return element.disabled || element.getAttribute("aria-disabled") === "true";
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function normalizeText(value) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function appendDebugLog(event, details = {}) {
  try {
    await chrome.runtime.sendMessage({
      type: "NB_ADD_DEBUG_LOG",
      entry: {
        source: DEBUG_LOG_SOURCE,
        event,
        details,
      },
    });
  } catch {
    // Ignore debug logging failures.
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
}
