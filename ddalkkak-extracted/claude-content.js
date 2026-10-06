// Claude web chat bridge. Uses the signed-in page; no API key or hidden endpoint.
(() => {
  if (globalThis.__ddalkkakClaudeBridge) return;
  globalThis.__ddalkkakClaudeBridge = true;

  const EDITOR = '[data-testid="chat-input"][contenteditable="true"]';
  const SEND = 'button[data-testid="chat-input-send"]';
  const ASSISTANT = '[data-is-streaming]';
  let queue = Promise.resolve();

  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.type === 'NB_CLAUDE_PING') {
      reply({ ok: true });
      return false;
    }
    if (message?.type !== 'NB_CLAUDE_SUBMIT') return false;
    queue = queue.then(() => submitClaudePrompt(message.prompt, message.options || {}))
      .then(payload => reply({ ok: true, ...payload }))
      .catch(error => reply({ ok: false, error: error?.message || String(error) }));
    return true;
  });

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function waitFor(getter, timeoutMs, description) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const value = getter();
      if (value) return value;
      await sleep(250);
    }
    throw new Error(`${description}을(를) 찾지 못했습니다. Claude 페이지를 확인해 주세요.`);
  }

  function responseNodes() {
    return [...document.querySelectorAll(ASSISTANT)]
      .filter(node => node.querySelector('.font-claude-response, [data-perf-reply-text]'));
  }

  function responseText(node) {
    return String(node?.querySelector('.font-claude-response, [data-perf-reply-text]')?.innerText || '').trim();
  }

  function generationActive(node) {
    return node?.getAttribute('data-is-streaming') === 'true'
      || Boolean(document.querySelector('button[aria-label="응답 중지"],button[aria-label="Stop response"],button[aria-label="Stop generating"]'));
  }

  async function submitClaudePrompt(prompt, options) {
    if (!String(prompt || '').trim()) throw new Error('Claude에 보낼 프롬프트가 비어 있습니다.');
    if (options.imageMode === true || options.collectImages === true) {
      throw new Error('Claude는 이 확장 프로그램에서 이미지 생성용으로 사용할 수 없습니다.');
    }
    if (options.temporaryChat === true) {
      const incognito = await waitFor(() => [...document.querySelectorAll('button')]
        .find(button => /시크릿 모드 사용|use incognito|incognito mode/i.test(button.getAttribute('aria-label') || '')), 15000, 'Claude 시크릿 채팅 버튼');
      incognito.click();
      await waitFor(() => [...document.querySelectorAll('button')]
        .some(button => /시크릿 모드 종료|exit incognito|close incognito/i.test(button.getAttribute('aria-label') || ''))
        || /incognito|시크릿/i.test(document.title), 15000, 'Claude 시크릿 채팅 시작');
    }
    const editor = await waitFor(() => document.querySelector(EDITOR), 30000, 'Claude 입력창');
    const before = responseNodes().length;
    fillEditor(editor, String(prompt));
    if (Array.isArray(options.inputImages) && options.inputImages.length) {
      await attachInputImages(options.inputImages, options.requireAllInputImages === true);
    }
    const button = await waitFor(() => {
      const found = document.querySelector(SEND);
      return found && !found.disabled ? found : null;
    }, 30000, 'Claude 전송 버튼');
    button.click();
    return waitForClaudeResponse(before, Number(options.timeoutMs) || 240000);
  }

  function fillEditor(editor, prompt) {
    editor.focus();
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.execCommand('delete', false);
    document.execCommand('insertText', false, prompt);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
    if (normalize(editor.innerText || editor.textContent) !== normalize(prompt)) {
      throw new Error('Claude 입력창에 프롬프트를 정확히 넣지 못했습니다.');
    }
  }

  async function attachInputImages(inputImages, requireAll) {
    const limit = requireAll ? 20 : 3;
    const images = inputImages.filter(image => /^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(String(image?.dataUrl || ''))).slice(0, limit);
    if (requireAll && images.length !== inputImages.length) throw new Error('Claude에 요청한 사진을 모두 첨부할 수 없습니다.');
    const input = await waitFor(() => document.querySelector('input[type="file"][data-testid="file-upload"]'), 15000, 'Claude 파일 첨부 입력창');
    if (images.length > 1 && !input.multiple) throw new Error('Claude가 여러 사진 첨부를 허용하지 않습니다.');
    const transfer = new DataTransfer();
    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      const match = String(image.dataUrl).match(/^data:(image\/[\w.+-]+);base64,([\s\S]+)$/i);
      if (!match) throw new Error(`${i + 1}번째 사진 형식이 올바르지 않습니다.`);
      const binary = atob(match[2].replace(/\s/g, ''));
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      const type = String(image.type || match[1]);
      transfer.items.add(new File([bytes], String(image.name || `photo-${i + 1}.png`), { type }));
    }
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(Math.max(1500, images.length * 700));
  }

  async function waitForClaudeResponse(previousCount, timeoutMs) {
    const started = Date.now();
    let lastText = '';
    let stable = 0;
    while (Date.now() - started < timeoutMs) {
      const nodes = responseNodes();
      const node = nodes.length > previousCount ? nodes.at(-1) : null;
      const text = responseText(node);
      if (node && text && !generationActive(node)) {
        stable = text === lastText ? stable + 1 : 0;
        lastText = text;
        if (stable >= 2) return { text, images: [] };
      } else {
        stable = 0;
        lastText = '';
      }
      const alert = [...document.querySelectorAll('[role="alert"]')]
        .map(element => element.innerText || '').find(value => /usage limit|rate limit|사용량 제한|문제가 발생|something went wrong/i.test(value));
      if (alert && !generationActive(node)) throw new Error(`Claude 응답 오류: ${alert}`);
      await sleep(1200);
    }
    throw new Error('Claude 응답 대기 시간이 초과되었습니다. 계정 이용 한도와 채팅 화면을 확인해 주세요.');
  }
})();
