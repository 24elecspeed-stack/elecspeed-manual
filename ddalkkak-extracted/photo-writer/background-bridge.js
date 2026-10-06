// A separate workspace and Gemini tab; existing draft/session keys stay intact.
let photoWriterBusy = false;
const photoWriterInsertionTabs = new Set();

function photoWriterTargetKind(url) {
  if (!isNaverBlogUrl(url)) return null;
  const kind = getNaverEditorKind(url);
  return ['blog', 'cafe', 'blogger', 'tistory'].includes(kind) ? kind : null;
}

async function getPhotoWriterGeminiTab(create = false) {
  const saved = await chrome.storage.session.get('photoWriterGeminiTabId');
  let tab = saved.photoWriterGeminiTabId ? await getTabSafely(saved.photoWriterGeminiTabId) : null;
  if (tab && new URL(tab.url || 'about:blank').hostname !== 'gemini.google.com') tab = null;
  if (!tab && create) {
    const anchorWindow = await getLastFocusedWindowSafe();
    const popup = await chrome.windows.create(buildGeminiPopupCreateData(anchorWindow, true));
    tab = popup.tabs?.[0] || await waitForWindowPrimaryTab(popup.id, 60000);
    await chrome.storage.session.set({ photoWriterGeminiTabId: tab.id });
  } else if (tab && create) {
    const win = await chrome.windows.get(tab.windowId);
    if (win.type !== 'popup') {
      const anchorWindow = await getLastFocusedWindowSafe();
      const popupCreateData = buildGeminiPopupCreateData(anchorWindow, true);
      delete popupCreateData.url;
      await chrome.windows.create({ ...popupCreateData, tabId: tab.id });
    } else {
      await chrome.windows.update(win.id, { focused: true });
    }
  }
  return tab;
}

async function closePhotoWriterGeminiTab() {
  const tab = await getPhotoWriterGeminiTab(false);
  if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
  await chrome.storage.session.remove('photoWriterGeminiTabId');
}

async function getPhotoWriterChatGptTab(create = false) {
  const saved = await chrome.storage.session.get('photoWriterChatGptTabId');
  let tab = saved.photoWriterChatGptTabId ? await getTabSafely(saved.photoWriterChatGptTabId) : null;
  if (tab && !isChatGptUrl(tab.url || '')) tab = null;
  if (!tab && create) {
    const anchorWindow = await getLastFocusedWindowSafe();
    const popup = await chrome.windows.create(buildChatGptPopupCreateData(anchorWindow, true));
    tab = popup.tabs?.[0] || await waitForChatGptWindowPrimaryTab(popup.id, 60000);
    await chrome.storage.session.set({ photoWriterChatGptTabId: tab.id });
  } else if (tab && create) {
    const win = await chrome.windows.get(tab.windowId);
    if (win.type !== 'popup') {
      const anchorWindow = await getLastFocusedWindowSafe();
      const popupCreateData = buildChatGptPopupCreateData(anchorWindow, true);
      delete popupCreateData.url;
      await chrome.windows.create({ ...popupCreateData, tabId: tab.id });
    } else {
      await chrome.windows.update(win.id, { focused: true });
    }
  }
  return tab;
}

async function closePhotoWriterChatGptTab() {
  const tab = await getPhotoWriterChatGptTab(false);
  if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
  await chrome.storage.session.remove('photoWriterChatGptTabId');
}

async function getPhotoWriterClaudeTab(create = false) {
  const saved = await chrome.storage.session.get('photoWriterClaudeTabId');
  let tab = saved.photoWriterClaudeTabId ? await getTabSafely(saved.photoWriterClaudeTabId) : null;
  if (tab && !isClaudeUrl(tab.url || '')) tab = null;
  if (!tab && create) {
    const anchorWindow = await getLastFocusedWindowSafe();
    const createData = { ...buildChatGptPopupCreateData(anchorWindow, true), url: CLAUDE_URL };
    const popup = await chrome.windows.create(createData);
    tab = popup.tabs?.[0] || await waitForWindowPrimaryTab(popup.id, 60000);
    await chrome.storage.session.set({ photoWriterClaudeTabId: tab.id });
  } else if (tab && create) {
    const win = await chrome.windows.get(tab.windowId);
    if (win.type !== 'popup') {
      const anchorWindow = await getLastFocusedWindowSafe();
      const createData = buildChatGptPopupCreateData(anchorWindow, true);
      delete createData.url;
      await chrome.windows.create({ ...createData, tabId: tab.id });
    } else {
      await chrome.windows.update(win.id, { focused: true });
    }
  }
  return tab;
}

async function closePhotoWriterClaudeTab() {
  const tab = await getPhotoWriterClaudeTab(false);
  if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
  await chrome.storage.session.remove('photoWriterClaudeTabId');
}

function photoWriterAiProvider(message) {
  const provider = message.type === 'GB_SUBMIT_GEMINI' ? 'gemini' : String(message.provider || 'gemini');
  if (!['gemini', 'chatgpt', 'claude'].includes(provider)) throw new Error('지원하지 않는 AI 서비스입니다.');
  return provider;
}

async function handlePhotoWriterMessage(message, sender) {
  const root = chrome.runtime.getURL('photo-writer/');
  if (sender?.id !== chrome.runtime.id || !String(sender.url || '').startsWith(root)) {
    throw new Error('내 사진 글쓰기 화면에서만 실행할 수 있습니다.');
  }
  switch (message.type) {
    case 'GB_CHECK_GEMINI_STATUS': {
      const tab = await getPhotoWriterGeminiTab();
      return { hasGeminiTab: Boolean(tab), tabId: tab?.id || null };
    }
    case 'GB_CHECK_AI_STATUS': {
      const provider = photoWriterAiProvider(message);
      const tab = provider === 'claude' ? await getPhotoWriterClaudeTab()
        : provider === 'chatgpt' ? await getPhotoWriterChatGptTab() : await getPhotoWriterGeminiTab();
      return { hasAiTab: Boolean(tab), tabId: tab?.id || null };
    }
    case 'GB_OPEN_GEMINI_TAB': {
      const tab = await getPhotoWriterGeminiTab(true);
      await chrome.tabs.update(tab.id, { active: true });
      return { tabId: tab.id };
    }
    case 'GB_OPEN_AI_TAB': {
      const provider = photoWriterAiProvider(message);
      const tab = provider === 'claude' ? await getPhotoWriterClaudeTab(true)
        : provider === 'chatgpt' ? await getPhotoWriterChatGptTab(true) : await getPhotoWriterGeminiTab(true);
      await chrome.tabs.update(tab.id, { active: true });
      return { tabId: tab.id };
    }
    case 'GB_CLOSE_GEMINI': {
      // 다른 요청이 같은 팝업 탭으로 비전 분석/글 작성을 진행 중이면 탭을 닫지 않습니다.
      // (이 탭이 중간에 닫히면 "No tab with id" 에러로 생성이 실패합니다.)
      if (photoWriterBusy) return { closed: false, skipped: 'busy' };
      await closePhotoWriterGeminiTab();
      return { closed: true };
    }
    case 'GB_CLOSE_AI': {
      if (photoWriterBusy) return { closed: false, skipped: 'busy' };
      const provider = photoWriterAiProvider(message);
      if (provider === 'claude') await closePhotoWriterClaudeTab();
      else if (provider === 'chatgpt') await closePhotoWriterChatGptTab();
      else await closePhotoWriterGeminiTab();
      return { closed: true };
    }
    case 'GB_SUBMIT_GEMINI':
    case 'GB_SUBMIT_AI': {
      if (photoWriterBusy) throw new Error('다른 사진 글쓰기 요청이 진행 중입니다. 완료 후 다시 시도하세요.');
      photoWriterBusy = true;
      try {
        const provider = photoWriterAiProvider(message);
        const getTabForProvider = () => provider === 'claude' ? getPhotoWriterClaudeTab(true)
          : provider === 'chatgpt' ? getPhotoWriterChatGptTab(true) : getPhotoWriterGeminiTab(true);
        const closeTabForProvider = () => provider === 'claude' ? closePhotoWriterClaudeTab()
          : provider === 'chatgpt' ? closePhotoWriterChatGptTab() : closePhotoWriterGeminiTab();
        const navigateUrl = provider === 'claude' ? CLAUDE_URL
          : provider === 'chatgpt' ? 'https://chatgpt.com/' : 'https://gemini.google.com/app';

        let tab = await getTabForProvider();
        try {
          if (message.options?.isNewSession) {
            await chrome.tabs.update(tab.id, { url: navigateUrl, active: true });
          }
          await waitForTabComplete(tab.id, 60000);
        } catch (error) {
          // 팝업 탭이 사용자/시스템에 의해 닫혔을 수 있으니 한 번만 새로 열어 재시도
          if (!/대상 탭을 찾을 수 없습니다|No tab with id/i.test(String(error?.message || ''))) throw error;
          await closeTabForProvider();
          tab = await getTabForProvider();
          await chrome.tabs.update(tab.id, { url: navigateUrl, active: true });
          await waitForTabComplete(tab.id, 60000);
        }
        await sleep(1000);
        const images = Array.isArray(message.options?.images) ? message.options.images : [];
        if (images.length > 10) throw new Error('사진 분석은 한 번에 10장까지 가능합니다.');
        const collectImages = message.options?.collectImages === true;
        const options = {
          newChat: message.options?.newChat === true,
          inputImages: images,
          requireAllInputImages: images.length > 0,
          timeoutMs: Math.max(30000, Number(message.options?.timeoutMs) || 240000),
          collectImages,
          imageMode: message.options?.imageMode === true,
        };
        const result = provider === 'claude' ? await sendPromptToClaude(tab.id, message.prompt, options)
          : provider === 'chatgpt' ? await sendPromptToChatGpt(tab.id, message.prompt, options)
            : await sendPromptToGemini(tab.id, message.prompt, options);
        return { text: result.text, images: collectImages && Array.isArray(result.images) ? result.images : [] };
      } finally { photoWriterBusy = false; }
    }
    case 'GB_ARTICLE_UPDATED': return { acknowledged: true };
    case 'GB_COLLECT_DIAGNOSTIC_REPORT': {
      const provider = photoWriterAiProvider(message);
      const tab = provider === 'claude' ? await getPhotoWriterClaudeTab()
        : provider === 'chatgpt' ? await getPhotoWriterChatGptTab() : await getPhotoWriterGeminiTab();
      return { timestamp: new Date().toISOString(), provider, dedicatedBlogTabId: tab?.id || null,
        tabInfo: tab ? { id: tab.id, active: tab.active, status: tab.status, url: tab.url } : null };
    }
    case 'NB_PHOTO_TARGETS': {
      const tabs = await chrome.tabs.query({});
      const korean = tabs.some(tab => photoWriterTargetKind(tab.url || '') === 'tistory')
        ? await isKoreanTistoryMode() : true;
      const targets = tabs.filter(tab => photoWriterTargetKind(tab.url || '') && (korean || photoWriterTargetKind(tab.url || '') !== 'tistory')).map(tab => ({ id: tab.id, title: tab.title, kind: photoWriterTargetKind(tab.url), url: tab.url }));
      const connected = (await getPanelContext())?.naverTab;
      const connectedKind = photoWriterTargetKind(connected?.url || '');
      return {
        tabs: targets,
        connectedTab: connectedKind && targets.some(tab => tab.id === connected.id)
          ? { id: connected.id, kind: connectedKind, title: connected.title || '', url: connected.url || '' }
          : null,
      };
    }
    case 'NB_PHOTO_INSERT': {
      const tabId = Number(message.tabId);
      if (!Number.isInteger(tabId) || photoWriterInsertionTabs.has(tabId)) throw new Error('작성창을 선택하거나 진행 중인 입력이 끝날 때까지 기다려 주세요.');
      photoWriterInsertionTabs.add(tabId);
      try {
        const tab = await getTabSafely(tabId);
        if (!tab || photoWriterTargetKind(tab.url || '') !== message.platform) throw new Error('선택한 작성창이 닫혔거나 사이트가 변경되었습니다. 목록을 새로고침하세요.');
        if (message.platform === 'tistory' && !(await isKoreanTistoryMode())) throw new Error('티스토리는 한국어 화면에서만 사용할 수 있습니다.');
        if (message.payload?.photoWriter !== true || !String(message.payload.title || '').trim()) throw new Error('완성된 글을 확인하세요.');
        await chrome.tabs.update(tabId, { active: true });
        return { insertion: await insertPostIntoNaverEditor(message.payload, tabId) };
      } finally { photoWriterInsertionTabs.delete(tabId); }
    }
    default: throw new Error('지원하지 않는 사진 글쓰기 요청입니다.');
  }
}
