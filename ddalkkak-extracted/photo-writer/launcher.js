// Retain the same frame when switching modes, preserving photos and ongoing work.
window.loadPhotoWriterMode = () => {
  const frame = document.getElementById('photoWriterFrame');
  if (!frame || frame.hasAttribute('src')) return;
  frame.addEventListener('load', () => {
    const content = frame.contentDocument?.querySelector('.app-container');
    if (!content) return;
    let scheduledFrame = 0;
    let appliedHeight = 0;
    const resize = () => {
      scheduledFrame = 0;
      const measuredHeight = Math.max(
        content.scrollHeight,
        Math.ceil(content.getBoundingClientRect().height)
      );
      // Do not count the iframe viewport itself; that leaves empty space below
      // short active steps such as the completed-article screen.
      const nextHeight = Math.max(120, measuredHeight + 2);
      // Avoid feeding an unchanged iframe height back into ResizeObserver.
      if (Math.abs(nextHeight - appliedHeight) < 2) return;
      appliedHeight = nextHeight;
      frame.style.height = `${nextHeight}px`;
    };
    const scheduleResize = () => {
      if (scheduledFrame) return;
      scheduledFrame = requestAnimationFrame(resize);
    };
    const observer = new ResizeObserver(scheduleResize);
    observer.observe(content);
    scheduleResize();
    window.addEventListener('pagehide', () => {
      observer.disconnect();
      if (scheduledFrame) cancelAnimationFrame(scheduledFrame);
    }, { once: true });
  }, { once: true });
  frame.src = chrome.runtime.getURL('photo-writer/sidepanel.html?embedded=1');
};
