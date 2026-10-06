// This function is serialized by chrome.scripting; keep all helpers inside it.
// Deliberately no publish/share action. Only prepare a draft for user review.
async function insertInstagramDraft(payload) {
  let ownsLock = false;
  let stage = 'validate';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalize = (text) => String(text || '').replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').trim();
  function visible(el) {
    if (!el || el.closest('[hidden],[aria-hidden="true"]')) return false;
    const rect = el.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    for (let ancestor = el; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  }
  function name(el) {
    // SVG <title> is included in textContent without a separating space:
    // "원본" + "사진 윤곽선 아이콘" used to become an unmatchable label.
    // Read label text without decorative SVGs; retain icon-only controls.
    const label = normalize(el.getAttribute('aria-label'));
    if (label) return label;
    const textOnly = el.cloneNode(true);
    textOnly.querySelectorAll('svg,[hidden],[aria-hidden="true"]').forEach((node) => node.remove());
    return normalize(textOnly.textContent).replace(/\s+/g, ' ')
      || normalize(el.querySelector('svg[aria-label]')?.getAttribute('aria-label'));
  }
  function find(scope, pattern) {
    return Array.from(scope.querySelectorAll('button,[role="button"],a,[role="link"],[role="menuitem"]'))
      .filter((el) => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && pattern.test(name(el))).pop();
  }
  function dialog() {
    return Array.from(document.querySelectorAll('[role="dialog"]')).find(visible);
  }
  function createControl() {
    const pattern = /^(새로운 게시물(?:\s*만들기)?|새 게시물|만들기|Create|New post|Create new post|作成|新規投稿|新しい投稿を作成|Crear|Nueva publicación|Crear nueva publicación)$/i;
    return Array.from(document.querySelectorAll('a,button,[role="link"],[role="button"]'))
      .filter((el) => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !el.closest('[role="dialog"]'))
      .filter((el) => pattern.test(name(el)) || Array.from(el.querySelectorAll('svg[aria-label]')).some((icon) => pattern.test(normalize(icon.getAttribute('aria-label')))))
      .pop();
  }
  function postMenuControl(create) {
    const pattern = /^(게시물(?:\s*게시물)?|Post(?:\s+Post)?|投稿|Publicación)$/i;
    const scopes = Array.from(document.querySelectorAll('[role="menu"]')).filter(visible);
    // Instagram renders the Post submenu beside Create in the same nav wrapper.
    // Never search arbitrary page buttons: English comment submit buttons say Post.
    const parent = create?.parentElement;
    if (parent && !/^(BODY|HTML|MAIN)$/.test(parent.tagName)) scopes.push(parent);
    for (const scope of scopes) {
      const item = find(scope, pattern);
      if (item) return item;
    }
    return Array.from(document.querySelectorAll('a[href="#"],[role="menuitem"]'))
      .filter((el) => visible(el) && el.getAttribute('aria-disabled') !== 'true' && pattern.test(name(el))).pop();
  }
  function captionField() {
    const current = dialog();
    if (!current) return null;
    return Array.from(current.querySelectorAll('textarea,[role="textbox"],[contenteditable]:not([contenteditable="false"])'))
      .find((el) => {
        if (!visible(el)) return false;
        const editable = el.tagName === 'TEXTAREA'
          || el.getAttribute('contenteditable') === 'true'
          || el.getAttribute('contenteditable') === 'plaintext-only'
          || el.isContentEditable;
        const hint = [el.getAttribute('aria-label'), el.getAttribute('aria-placeholder'), el.getAttribute('placeholder')]
          .filter(Boolean).join(' ');
        // Instagram's Korean UI changed this from "문구를 입력하세요" to
        // "캡션 추가...". Check both accessible label and aria-placeholder.
        return editable && /문구|캡션|caption|write a caption|add a caption|キャプション|pie de foto|descripción/i.test(hint);
      });
  }
  function atStage(pattern) {
    const current = dialog();
    return current && Array.from(current.querySelectorAll('[role="heading"],h1,h2,h3')).some((el) => pattern.test(normalize(el.textContent)));
  }
  async function waitFor(check, message, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const result = check();
      if (result) return result;
      await sleep(180);
    }
    throw new Error(message);
  }
  async function clickInDialog(pattern, message) {
    const button = await waitFor(() => dialog() && find(dialog(), pattern), message);
    button.click();
  }
  try {
    if (location.hostname !== 'www.instagram.com') throw new Error('Instagram 탭에서만 입력할 수 있습니다.');
    const caption = normalize(payload?.caption);
    const images = Array.isArray(payload?.images) ? payload.images : [];
    if (!caption || Array.from(caption).length > 2200) throw new Error('캡션은 1~2,200자여야 합니다.');
    if (images.length < 1 || images.length > 10) throw new Error('Instagram 이미지는 1~10장을 준비하세요.');
    const image = images[0];
    for (const entry of images) {
      if (!/^data:image\/(jpeg|png);base64,/i.test(entry?.dataUrl || '')) throw new Error('JPEG 또는 PNG 이미지가 필요합니다.');
      if (entry.dataUrl.length > 16 * 1024 * 1024) throw new Error('이미지 용량이 너무 큽니다. 작은 이미지로 다시 준비하세요.');
      if (!(entry.width > 0 && entry.height > 0)) throw new Error('원본 이미지 크기를 확인하지 못했습니다. 이미지를 다시 선택하세요.');
      if (Math.abs(entry.width / entry.height - image.width / image.height) > 0.005) throw new Error('여러 이미지는 동일한 비율로 준비해야 합니다. 패널에서 다시 입력하세요.');
    }
    if (images.reduce((sum, entry) => sum + entry.dataUrl.length, 0) > 24 * 1024 * 1024) throw new Error('이미지 전체 용량이 너무 큽니다.');
    if (window.__nbInstagramPreparing) throw new Error('이미 Instagram 입력 작업이 진행 중입니다.');
    window.__nbInstagramPreparing = true;
    ownsLock = true;
    // Never replace an existing draft, even when the caption is still empty.
    if (captionField() || atStage(/^(자르기|편집|Crop|Edit|切り取り|トリミング|編集|Recortar|Editar)$/i)) {
      throw new Error('이미 작성 중인 Instagram 게시물이 있습니다. 내용을 확인하고 직접 닫은 뒤 다시 입력하세요.');
    }
    if (document.querySelector('input[type="password"]')) throw new Error('Instagram에 먼저 로그인해 주세요.');
    stage = 'open';
    if (!dialog()) {
      stage = 'open-create';
      const navigation = await waitFor(() => {
        if (dialog()) return { opened: true };
        const create = createControl();
        const post = postMenuControl(create);
        return (create || post) && { create, post };
      }, 'Instagram 만들기 메뉴가 준비되지 않았습니다. 로그인과 페이지 로딩 상태를 확인하세요.');
      if (!navigation.opened) {
        // If the user already opened Create, continue without toggling it closed.
        if (!navigation.post) navigation.create.click();
        stage = 'open-post';
        const next = await waitFor(() => dialog() || postMenuControl(createControl()), '만들기 메뉴의 게시물 항목을 찾지 못했습니다. Instagram 화면을 확인하세요.');
        if (!dialog()) next.click();
      }
    }
    await waitFor(() => dialog() && /새 게시물|Create new post|新規投稿|新しい投稿を作成|Crear|Nueva publicación|Crear nueva publicación/i.test(dialog().textContent), '빈 새 게시물 작성창을 찾지 못했습니다.');
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'))
      .filter((el) => !el.disabled && /image\//i.test(el.accept));
    if (inputs.length !== 1 || inputs[0].files?.length) throw new Error('빈 이미지 업로드 입력란을 확인하지 못했습니다. 새 게시물 창을 다시 열어 주세요.');
    if (images.length > 1 && !inputs[0].multiple) throw new Error('이 작성창은 여러 이미지 선택을 지원하지 않습니다.');
    const transfer = new DataTransfer();
    for (let index = 0; index < images.length; index += 1) {
      const blob = await (await fetch(images[index].dataUrl)).blob();
      const file = new File([blob], `instagram-${String(index + 1).padStart(2, '0')}.` + (blob.type === 'image/png' ? 'png' : 'jpg'), { type: blob.type });
      transfer.items.add(file);
    }
    stage = 'upload';
    inputs[0].files = transfer.files;
    if (inputs[0].files.length !== images.length) throw new Error('이미지 파일 개수가 일치하지 않아 업로드를 중단했습니다.');
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => atStage(/^(자르기|Crop|切り取り|トリミング|Recortar)$/i), '이미지 업로드가 반영되지 않았습니다. 작성창을 확인하세요.', 25000 + images.length * 2000);
    if (images.length > 1) {
      stage = 'image-count';
      await clickInDialog(/^(미디어 갤러리 열기|Open media gallery|Abrir galería multimedia|Abrir galería de contenido multimedia)$/i, '업로드 이미지 목록을 찾지 못했습니다.');
      const thumbnailCount = () => new Set(Array.from(dialog().querySelectorAll('[style]'))
        .filter((el) => /url\(/i.test(el.style.backgroundImage) && visible(el))
        .map((el) => el.closest('button,[role="button"]')).filter(Boolean)).size;
      await waitFor(() => thumbnailCount() >= images.length, `이미지 ${images.length}장이 모두 업로드되었는지 확인하지 못했습니다.`, 30000);
      if (thumbnailCount() !== images.length) throw new Error('업로드된 이미지 개수가 요청과 다릅니다. 작성창을 확인하세요.');
      await clickInDialog(/^(미디어 갤러리 열기|Open media gallery|Abrir galería multimedia|Abrir galería de contenido multimedia)$/i, '이미지 목록을 닫지 못했습니다.');
    }
    stage = 'ratio';
    await clickInDialog(/^(자르기 선택|Select crop|切り取りを選択|トリミングを選択|Seleccionar recorte)$/i, '자르기 선택 버튼을 찾지 못했습니다.');
    await clickInDialog(/^(원본|Original|元のサイズ|オリジナル)(?:\s.*)?$/i, '원본 비율 메뉴를 찾지 못했습니다.');
    await clickInDialog(/^(다음|Next|次へ|Siguiente)$/i, '자르기 단계의 다음 버튼을 찾지 못했습니다.');
    await waitFor(() => atStage(/^(편집|Edit|編集|Editar)$/i), '이미지 편집 단계로 이동하지 못했습니다.');
    await clickInDialog(/^(다음|Next|次へ|Siguiente)$/i, '편집 단계의 다음 버튼을 찾지 못했습니다.');
    stage = 'caption';
    let field = await waitFor(captionField, '캡션 입력란을 찾지 못했습니다.');
    const previewImage = () => Array.from(dialog().querySelectorAll('img')).find((el) => visible(el) && el.naturalWidth > 100 && el.naturalHeight > 100 && el.getBoundingClientRect().width > 200);
    let preview = await waitFor(previewImage, '이미지 미리보기를 확인하지 못했습니다.');
    const rightArrow = /^(오른쪽 방향 아이콘|Right (?:arrow|chevron)(?: icon)?|(?:Icono de )?flecha (?:hacia la |a la )?derecha)$/i;
    const leftArrow = /^(왼쪽 방향 아이콘|Left (?:arrow|chevron)(?: icon)?|(?:Icono de )?flecha (?:hacia la |a la )?izquierda)$/i;
    for (let index = 0; index < images.length; index += 1) {
      const expectedRatio = images[index].width / images[index].height;
      if (Math.abs(preview.naturalWidth / preview.naturalHeight - expectedRatio) / expectedRatio > 0.03) {
        throw new Error(`${index + 1}번째 이미지 비율이 변경되었습니다. 원본 자르기 설정을 직접 확인하세요.`);
      }
      if (index < images.length - 1) {
        const previousSrc = preview.currentSrc || preview.src;
        await clickInDialog(rightArrow, `${index + 2}번째 이미지를 찾지 못했습니다.`);
        preview = await waitFor(() => { const next = previewImage(); return next && (next.currentSrc || next.src) !== previousSrc && next; }, '다음 이미지 미리보기가 갱신되지 않았습니다.');
      }
    }
    if (images.length > 1) {
      if (find(dialog(), rightArrow)) throw new Error('요청보다 많은 이미지가 작성창에 있습니다. 확인 후 다시 시도하세요.');
      for (let index = images.length - 1; index > 0; index -= 1) {
        const previousSrc = preview.currentSrc || preview.src;
        await clickInDialog(leftArrow, '첫 이미지로 돌아가지 못했습니다.');
        preview = await waitFor(() => { const previous = previewImage(); return previous && (previous.currentSrc || previous.src) !== previousSrc && previous; }, '이전 이미지 미리보기가 갱신되지 않았습니다.');
      }
    }
    field = captionField();
    if (normalize(field.value || field.textContent)) throw new Error('캡션에 기존 내용이 있어 덮어쓰지 않았습니다.');
    field.focus();
    if (field.tagName === 'TEXTAREA') {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, caption);
      field.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: caption }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const range = document.createRange();
      range.selectNodeContents(field);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      // Give the controlled editor time to synchronize its selection.
      await sleep(180);
      if (field.getAttribute('data-lexical-editor') === 'true') {
        // Let Lexical own its DOM and paragraph/hashtag state. One plain-text
        // paste, never execCommand + a second synthetic insertText notification.
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', caption);
        const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData });
        field.dispatchEvent(paste);
        if (!paste.defaultPrevented) throw new Error('Instagram 편집기가 캡션 붙여넣기를 처리하지 않았습니다. 캡션을 직접 붙여넣어 주세요.');
      } else {
        let inserted = false;
        try { inserted = document.execCommand('insertText', false, caption); } catch { /* fail closed below */ }
        // Native editing already emits its input events. Do not send another
        // event or replace textContent after a failed/partial insertion.
        if (!inserted) throw new Error('캡션 입력을 완료하지 못했습니다. 작성창을 확인하고 직접 붙여넣어 주세요.');
      }
    }
    const captionMatches = () => {
      const current = captionField();
      return current && normalize(current.value || current.innerText || current.textContent) === caption;
    };
    await waitFor(captionMatches, '캡션 입력 결과가 일치하지 않습니다. 재입력하지 않고 중단했습니다. 작성창을 확인하세요.', 5000);
    field = captionField();
    if (field.getAttribute('data-lexical-editor') === 'true') {
      // Paste can update Lexical's DOM without updating Instagram's post state.
      // Commit a native edit, then remove only our trailing space. Native editing
      // owns input events; synthetic insertText events would duplicate the caption.
      field.focus();
      const moveToEnd = () => {
        const range = document.createRange();
        range.selectNodeContents(field);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      };
      const text = () => String(field.innerText || field.textContent || '').replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ');
      moveToEnd();
      await sleep(180);
      const before = text();
      let edited = false;
      try { edited = document.execCommand('insertText', false, ' '); } catch { /* report below */ }
      if (!edited) throw new Error('캡션 입력 확정을 완료하지 못했습니다. 캡션 끝을 클릭해 스페이스바를 누른 뒤 공유해 주세요.');
      await sleep(300);
      field = captionField();
      if (!field || text() !== before + ' ') throw new Error('캡션 입력 확정 결과를 확인하지 못했습니다. 작성창의 문구를 확인한 뒤 직접 공유해 주세요.');
      moveToEnd();
      let removed = false;
      try { removed = document.execCommand('delete', false); } catch { /* report below */ }
      if (!removed) throw new Error('캡션 끝의 임시 공백을 지우지 못했습니다. 문구를 확인한 뒤 직접 공유해 주세요.');
      await sleep(300);
      field = captionField();
      if (!field || text() !== before || !captionMatches()) throw new Error('캡션 입력 확정 후 문구가 달라졌습니다. 작성창을 확인해 주세요.');
    }
    field.blur();
    // Check after blur and delayed reconciliation, not only the immediate DOM.
    for (let pass = 0; pass < 6; pass += 1) {
      await sleep(250);
      if (!captionMatches()) throw new Error('캡션이 입력 후 변경되었습니다. 중복·줄바꿈을 확인해 주세요. 자동 재입력은 하지 않았습니다.');
    }
    return { ok: true, platform: 'instagram', stagedOnly: true, published: false, imageInsertedCount: images.length, captionInserted: true };
  } catch (error) {
    return { ok: false, platform: 'instagram', stage, published: false, error: error.message || String(error) };
  } finally {
    if (ownsLock) delete window.__nbInstagramPreparing;
  }
}

if (typeof module !== 'undefined') module.exports = { insertInstagramDraft };
