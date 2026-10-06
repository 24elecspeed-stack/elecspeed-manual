// Tistory is a Korean-only destination. Never publish; only fill the open editor.
async function insertPostIntoTistoryEditor(payload, tabId) {
  const tab = await getTabSafely(tabId);
  if (!tab || !isNaverBlogUrl(tab.url || '') || getNaverEditorKind(tab.url || '') !== 'tistory') {
    throw new Error('티스토리 글쓰기 탭을 다시 연결해 주세요.');
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: 'MAIN',
    func: fillTistoryEditor,
    args: [payload],
  });
  const result = results[0]?.result;
  await appendBackgroundDebugLog('tistory.insert.result', {
    tabId,
    titleInserted: Boolean(result?.titleInserted),
    bodyInserted: Boolean(result?.bodyInserted),
    tagRequestedCount: Number(result?.tagRequestedCount || 0),
    tagInsertedCount: Number(result?.tagInsertedCount || 0),
    tagInputSelector: result?.tagInputSelector || '',
    tagInputError: result?.tagInputError || '',
    imageRequestedCount: Number(result?.imageRequestedCount || 0),
    imageInsertedCount: Number(result?.imageInsertedCount || 0),
    imageUploadStage: result?.imageUploadStage || '',
    imageUploadError: result?.imageUploadError || '',
    error: result?.error || '',
  });
  if (!result?.ok) throw new Error(result?.error || '티스토리 글쓰기창 입력을 확인하지 못했습니다.');
  return result;
}

async function fillTistoryEditor(payload) {
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const title = String(payload?.title || '').trim();
  const rawHtml = String(payload?.html || '').trim();
  const rawText = String(payload?.text || '').trim();
  const tags = Array.isArray(payload?.tags)
    ? [...new Set(payload.tags.map(value => String(value || '').replace(/^#/, '').trim()).filter(Boolean))].slice(0, 20)
    : [];
  const images = Array.isArray(payload?.images) ? payload.images.filter(Boolean) : [];
  const result = { ok: false, platform: 'tistory', titleInserted: false, bodyInserted: false,
    tagRequestedCount: tags.length, tagInsertedCount: 0,
    imageRequestedCount: images.length, imageInsertedCount: 0 };
  let editor = null;
  try {
    if (!/^[a-z0-9-]+\.tistory\.com$/i.test(location.hostname)
      || !/^\/manage\/(?:newpost|post)(?:\/|$)/i.test(location.pathname)) {
      throw new Error('티스토리 글쓰기 화면이 아닙니다.');
    }
    const titleInput = document.querySelector('#post-title-inp');
    if (!titleInput) throw new Error('티스토리 제목 입력란을 찾지 못했습니다.');
    for (let attempt = 0; attempt < 40; attempt += 1) {
      editor = window.tinymce?.get?.('editor-tistory') || window.tinymce?.activeEditor || null;
      if (editor?.initialized && editor.getBody?.()) break;
      await wait(250);
    }
    if (!editor?.getBody?.()) throw new Error('티스토리 본문 편집기가 준비되지 않았습니다.');
    if (!title || !(rawHtml || rawText)) throw new Error('입력할 제목과 본문을 확인해 주세요.');

    const template = document.createElement('template');
    template.innerHTML = rawHtml || rawText.split(/\n+/).filter(Boolean)
      .map(line => `<p>${line.replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch])}</p>`).join('');
    template.content.querySelectorAll('script,style,iframe,object,embed,form,input,button,textarea,select,link,meta,base').forEach(node => node.remove());
    for (const node of template.content.querySelectorAll('*')) {
      for (const attribute of [...node.attributes]) {
        if (/^on/i.test(attribute.name) || (['src','href'].includes(attribute.name) && /^\s*(?:javascript:|vbscript:)/i.test(attribute.value))) {
          node.removeAttribute(attribute.name);
        }
      }
    }
    const token = index => `__DD_TISTORY_IMAGE_${index}__`;
    if (payload?.photoWriter === true) {
      const slots = [...template.content.querySelectorAll('[data-dd-photo-slot]')];
      if (slots.length !== images.length || slots.some((slot, index) => slot.getAttribute('data-dd-photo-slot') !== String(index))) {
        throw new Error('사진 순서 정보가 일치하지 않습니다. 완성본을 확인해 주세요.');
      }
      slots.forEach((slot, index) => {
        const marker = document.createElement('p');
        marker.textContent = token(index);
        slot.replaceWith(marker);
      });
    } else if (images.length) {
      // The standard draft keeps images separately. Spread them across body sections.
      const anchors = [...template.content.children].filter(node => /^(P|H2|H3|BLOCKQUOTE|UL|OL)$/i.test(node.tagName));
      const trailingMarkers = new Map();
      images.forEach((image, index) => {
        const marker = document.createElement('p');
        marker.textContent = token(index);
        if (/hero|cover|대표|썸네일/i.test(String(image.slot || ''))) {
          template.content.insertBefore(marker, template.content.firstChild);
        } else if (anchors.length) {
          const anchor = anchors[Math.min(index + 1, anchors.length - 1)];
          (trailingMarkers.get(anchor) || anchor).after(marker);
          trailingMarkers.set(anchor, marker);
        } else template.content.append(marker);
      });
    }
    const html = template.innerHTML.trim();
    if (!template.content.textContent?.trim() && !template.content.querySelector('img')) {
      throw new Error('입력할 본문이 없습니다.');
    }

    const nativeValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    nativeValue?.call(titleInput, title);
    titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    titleInput.dispatchEvent(new Event('change', { bubbles: true }));
    result.titleInserted = titleInput.value.trim() === title;
    editor.setContent(html, { format: 'html' });
    editor.nodeChanged?.();
    editor.save?.();
    await wait(300);
    result.bodyInserted = Boolean(editor.getBody()?.textContent?.trim());

    // A failed photo must not prevent tags from being entered.
    // Tag controls can change independently of the image uploader. A tag failure
    // must be reported, but must not abort uploading the user's images.
    try {
    const tagSelectors = ['#tagText', '#tag-input', 'input[name="tag"]', 'input[name="tags"]',
      'input[placeholder*="태그"]', 'input[aria-label*="태그"]',
      '.editor_tag input', '.tag-input input', '.tag_input input'];
    let tagInput = null;
    for (const selector of tagSelectors) {
      tagInput = [...document.querySelectorAll(selector)].find(node =>
        node instanceof HTMLInputElement && node.type !== 'hidden' && !node.disabled && !node.readOnly
        && !node.closest('[hidden], [aria-hidden="true"]')
        && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden');
      if (tagInput) { result.tagInputSelector = selector; break; }
    }
    if (tags.length && !tagInput) throw new Error('티스토리 태그 입력란을 찾지 못했습니다.');
    for (const tag of tags) {
      tagInput.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(tagInput, tag);
      tagInput.dispatchEvent(new InputEvent('input', { bubbles: true, data: tag, inputType: 'insertText' }));
      tagInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      tagInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      await wait(100);
      if (tagInput.value.trim() === tag) throw new Error(`태그 "${tag}" 입력을 확인하지 못했습니다.`);
      result.tagInsertedCount += 1;
    }
    } catch (error) {
      result.tagInputError = error?.message || String(error);
    }

    for (let index = 0; index < images.length; index += 1) {
      const image = images[index];
      const dataUrl = String(image.dataUrl || image.src || '').trim();
      if (!/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(dataUrl)) {
        throw new Error(`${index + 1}번 사진의 형식을 확인해 주세요.`);
      }
      const marker = [...editor.getBody().querySelectorAll('p')]
        .find(node => node.textContent?.trim() === token(index));
      if (!marker) throw new Error(`${index + 1}번 사진 위치를 찾지 못했습니다.`);
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const extension = blob.type === 'image/jpeg' ? 'jpg' : (blob.type.split('/')[1] || 'png');
      const requestedName = String(image.fileName || image.name || `photo-${index + 1}.${extension}`);
      const safeName = requestedName.replace(/[^\p{L}\p{N}._-]/gu, '_');
      const file = new File([blob], safeName, { type: blob.type || 'image/png' });
      const before = new Set(editor.getBody().querySelectorAll('img'));
      // Tistory's paste plugin uses this command to upload the clipboard File.
      // Call the same editor command directly: a synthetic file-input change may
      // leave the native picker open and never resolve its promise.
      result.imageUploadStage = `upload:${index + 1}`;
      const uploaded = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${index + 1}번 사진 업로드 시간이 초과되었습니다.`)), 45000);
        try {
          editor.execCommand('KImageUploadFile', {
            file, requireDom: true,
            callback: upload => {
              clearTimeout(timer);
              if (!upload?.data?.url || !upload?.dom?.outerHTML) {
                reject(new Error(`${index + 1}번 사진 업로드가 실패했습니다. 티스토리 로그인과 네트워크를 확인해 주세요.`));
                return;
              }
              resolve(upload);
            },
          });
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        }
      });
      result.imageUploadStage = `insert:${index + 1}`;
      editor.selection.select(marker);
      editor.selection.collapse(true);
      editor.insertContent(uploaded.dom.outerHTML, { paste: 'kPaste' });
      const uploadedImage = [...editor.getBody().querySelectorAll('img')].find(node => !before.has(node)
        && (node.getAttribute('data-image-src') === uploaded.data.url
          || String(node.getAttribute('src') || '').includes(uploaded.data.url)));
      if (!uploadedImage) throw new Error(`${index + 1}번 사진은 업로드됐지만 본문 삽입을 확인하지 못했습니다.`);
      if (marker.isConnected) {
        const imageBlock = uploadedImage.closest('figure, [data-ke-type="image"]') || uploadedImage;
        marker.replaceWith(imageBlock);
      }
      result.imageInsertedCount += 1;
      result.imageUploadStage = `done:${index + 1}`;
      editor.save?.();
    }
    for (const marker of [...editor.getBody().querySelectorAll('p')]) {
      if (/^__DD_TISTORY_IMAGE_\d+__$/.test(marker.textContent?.trim() || '')) marker.remove();
    }
    editor.save?.();

    result.titleInserted = titleInput.value.trim() === title;
    result.bodyInserted = Boolean(editor.getBody()?.textContent?.replace(/__DD_TISTORY_IMAGE_\d+__/g, '').trim());
    result.ok = result.titleInserted && result.bodyInserted
      && result.imageInsertedCount === result.imageRequestedCount
      && result.tagInsertedCount === result.tagRequestedCount;
    if (!result.ok) throw new Error(result.tagInputError
      ? `본문과 이미지 입력을 마쳤으나 태그 입력이 완료되지 않았습니다. ${result.tagInputError} 태그는 직접 입력해 주세요.`
      : '티스토리 제목·본문·사진·태그 중 일부 입력을 확인하지 못했습니다.');
    return result;
  } catch (error) {
    result.error = error?.message || String(error);
    if (result.imageUploadStage && !result.imageUploadStage.startsWith('done:')) result.imageUploadError = result.error;
    return result;
  } finally {
    // Never leave internal placement tokens in a user's draft after a partial failure.
    for (const marker of [...(editor?.getBody?.()?.querySelectorAll('p') || [])]) {
      if (/^__DD_TISTORY_IMAGE_\d+__$/.test(marker.textContent?.trim() || '')) marker.remove();
    }
    editor?.save?.();
  }
}
