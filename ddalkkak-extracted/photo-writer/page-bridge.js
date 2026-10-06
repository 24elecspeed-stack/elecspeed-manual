(() => {
  const t = PhotoWriter.text;
  const viewer = location.pathname.endsWith('/final-view.html');
  const article = () => viewer ? currentArticle : state.finalArticle;
  // Keep generated markup inert wherever the original writer stores/assembles it.
  const assemble = assembleHtmlWithUserImages;
  assembleHtmlWithUserImages = (...args) => PhotoWriter.sanitize(assemble(...args));
  const parse = parseArticleResponse;
  parseArticleResponse = (...args) => {
    const result = parse(...args);
    if (!/<(?:p|h[1-6]|blockquote|ul|ol|table)\b/i.test(result.html || '')) throw new Error(t('AI가 본문 HTML을 반환하지 않았습니다. 다시 생성하세요.', 'The AI did not return an HTML article. Please retry.'));
    return result;
  };
  let connectedTab = null, inserting = false;
  async function send(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || t('요청을 처리하지 못했습니다.', 'The request failed.'));
    return result;
  }
  document.addEventListener('DOMContentLoaded', () => {
    const card = document.createElement('section');
    card.className = 'photo-destination';
    card.innerHTML = '<h2></h2><p class="photo-help"></p><p class="photo-connected-tab"></p><div class="photo-actions"><button type="button" id="photoBind"></button><button type="button" id="photoInsert" class="photo-insert"></button></div><p class="photo-status" role="status"></p>';
    if (viewer) document.querySelector('.page-body').prepend(card);
    else document.querySelector('#step3CompleteSection')?.append(card);
    const connectedMeta = card.querySelector('.photo-connected-tab');
    const bind = card.querySelector('#photoBind'), status = card.querySelector('.photo-status'), insert = card.querySelector('#photoInsert');
    function render() {
      card.querySelector('h2').textContent = t('최종 입력', 'Final insertion');
      card.querySelector('.photo-help').textContent = t('글쓰기 페이지를 연 뒤 현재 탭을 연결하세요. 완성본의 제목·본문·사진을 배치된 순서대로 입력하며 게시 버튼은 누르지 않습니다.', 'Open a post editor and connect the current tab. The title, article and photos are inserted in their arranged order without publishing.');
      bind.textContent = t('① 현재 탭 연결하기', '① Connect current tab');
      insert.textContent = t('④ 연결된 글쓰기창에 넣기', '④ Insert into connected editor');
      const names = { blog: '네이버 블로그', cafe: '네이버 카페', blogger: 'Google Blogger', tistory: '티스토리' };
      connectedMeta.textContent = connectedTab
        ? t(`연결됨: ${names[connectedTab.kind]} · ${connectedTab.title || connectedTab.url || connectedTab.id}`, `Connected: ${connectedTab.kind === 'blogger' ? 'Google Blogger' : names[connectedTab.kind]} · ${connectedTab.title || connectedTab.url || connectedTab.id}`)
        : t('연결된 글쓰기 페이지가 없습니다.', 'No editor is connected.');
      connectedMeta.classList.toggle('connected', Boolean(connectedTab));
    }
    async function refresh() {
      try {
        const result = await send({ type: 'NB_PHOTO_TARGETS' });
        connectedTab = result.connectedTab || null;
        if (PhotoWriter.english() && connectedTab?.kind !== 'blogger') connectedTab = null;
        render();
      }
      catch (error) { status.textContent = error.message; }
    }
    bind.addEventListener('click', async () => {
      try {
        status.textContent = t('현재 탭을 연결하고 있습니다.', 'Connecting the current tab…');
        const result = await send({ type: 'NB_BIND_ACTIVE_TAB' });
        const tab = result.context?.naverTab || result.naverTab;
        const kind = tab?.editorKind || tab?.kind;
        if (!tab?.id || !['blog', 'cafe', 'blogger', 'tistory'].includes(kind)) throw new Error(t('네이버 블로그·카페·티스토리 또는 Google Blogger 글쓰기 페이지에서 연결해 주세요.', 'Connect a Google Blogger editor tab.'));
        if (PhotoWriter.english() && kind !== 'blogger') throw new Error('English mode supports Google Blogger for blog posts.');
        connectedTab = { id: tab.id, kind, title: tab.title, url: tab.url };
        render();
        status.textContent = t('현재 글쓰기 탭을 연결했습니다.', 'The current editor tab is connected.');
      } catch (error) { connectedTab = null; render(); status.textContent = error.message; }
    });
    insert.addEventListener('click', async () => {
      if (inserting) return;
      try {
        if (!connectedTab?.id) throw new Error(t('현재 글쓰기 탭을 먼저 연결하세요.', 'Connect the current editor tab first.'));
        if (typeof state !== 'undefined' && state.isBusy) throw new Error(t('글 생성이 끝난 뒤 입력하세요.', 'Wait until generation finishes.'));
        const current = article();
        const latest = current && { ...current, html: viewer ? document.getElementById('articleContent').innerHTML : current.html };
        const payload = await PhotoWriter.toPayload(latest);
        inserting = true; insert.disabled = true;
        status.textContent = t('제목·본문·사진을 입력하고 있습니다. 완료될 때까지 작성창을 조작하지 마세요.', 'Inserting title, article and photos. Please leave the editor untouched until completion.');
        const result = await send({ type: 'NB_PHOTO_INSERT', tabId: Number(connectedTab.id), platform: connectedTab.kind, payload });
        const info = result.insertion || {};
        const count = Number(info.imageInsertedCount || 0);
        const partial = !info.titleInserted || !info.bodyInserted || count !== payload.images.length;
        status.textContent = partial
          ? t(`입력 결과를 확인해 주세요. 제목: ${info.titleInserted ? '완료' : '미확인'}, 본문: ${info.bodyInserted ? '완료' : '미확인'}, 사진 ${count}/${payload.images.length}장. 중복 입력되지 않도록 작성창을 먼저 확인해 주세요.`, `Please check the result. Title: ${info.titleInserted ? 'done' : 'unconfirmed'}, body: ${info.bodyInserted ? 'done' : 'unconfirmed'}, photos: ${count}/${payload.images.length}. Check the editor before retrying to avoid duplicates.`)
          : t(`입력이 완료되었습니다. 사진 ${count}/${payload.images.length}장. 제목·본문·사진과 태그를 확인한 뒤 직접 게시해 주세요.`, `Insertion finished. Photos: ${count}/${payload.images.length}. Review the title, article, photos and tags before publishing.`);
      } catch (error) { status.textContent = error.message; }
      finally { inserting = false; insert.disabled = false; }
    });
    document.addEventListener('ddalkkak-language-change', render);
    render(); void refresh();
  });
})();
