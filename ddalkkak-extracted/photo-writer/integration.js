// Shared DOM conversion for preview, export and the three destination editors.
const PhotoWriter = (() => {
  if (new URLSearchParams(location.search).get('embedded') === '1') document.documentElement.classList.add('photo-writer-embedded');
  const english = () => ['en', 'ja', 'es'].includes(document.documentElement.lang);
  const text = (ko, en) => english() ? en : ko;
  const imageData = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/i;
  function sanitize(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html || '');
    template.content.querySelectorAll('script,style,iframe,object,embed,form,input,button,textarea,select,link,meta,base,svg,math').forEach(el => el.remove());
    for (const el of Array.from(template.content.querySelectorAll('*'))) {
      for (const attr of Array.from(el.attributes)) {
        if (!['href','src','alt','style','class','colspan','rowspan'].includes(attr.name)) el.removeAttribute(attr.name);
      }
      if (el.hasAttribute('href') && !/^https?:\/\//i.test(el.getAttribute('href'))) el.removeAttribute('href');
      if (el.tagName === 'IMG' && !imageData.test(el.getAttribute('src') || '')) { el.remove(); continue; }
      const allowedStyles = ['color','background-color','font-size','font-weight','font-style','text-align','line-height','margin','margin-top','margin-bottom','padding','border','border-left','border-bottom','border-radius','max-width','height','width','border-collapse','white-space'];
      const saved = el.style;
      const rules = allowedStyles.map(key => [key,saved.getPropertyValue(key)]).filter(([,value]) => value && !/url\s*\(|expression|javascript|var\s*\(/i.test(value));
      el.removeAttribute('style');
      rules.forEach(([key,value]) => el.style.setProperty(key,value));
    }
    return template.innerHTML;
  }
  function toPayload(article) {
    if (!article || !String(article.title || '').trim()) throw new Error(text('완성된 글과 제목을 먼저 확인하세요.', 'Prepare an article and title first.'));
    const html = sanitize(article.html);
    const template = document.createElement('template');
    template.innerHTML = html;
    if (!template.content.textContent.trim()) throw new Error(text('입력할 본문이 없습니다.', 'The article body is empty.'));
    const output = document.createElement('div');
    const images = [];
    let img;
    // Range splits even nested figures/lists into balanced HTML fragments, so
    // the final top-level slots preserve exactly the user's preview order.
    while ((img = template.content.querySelector('img'))) {
      const range = document.createRange();
      range.setStart(template.content, 0);
      range.setEndBefore(img);
      output.appendChild(range.extractContents());
      images.push({ dataUrl: img.getAttribute('src'), alt: img.getAttribute('alt') || '', sequence: images.length });
      img.remove();
      const marker = document.createElement('p');
      marker.setAttribute('data-dd-photo-slot', String(images.length - 1));
      output.appendChild(marker);
    }
    output.appendChild(template.content);
    const payload = { photoWriter: true, title: String(article.title).trim(), html: output.innerHTML, text: output.textContent,
      tags: Array.isArray(article.tags) ? article.tags.map(tag => String(tag).replace(/^#/, '').trim()).filter(Boolean) : [], images };
    if (JSON.stringify(payload).length <= 18 * 1024 * 1024) return payload;
    return optimizePayloadImages(payload).then(() => {
      if (JSON.stringify(payload).length > 20 * 1024 * 1024) throw new Error(text('사진을 자동 최적화했지만 전송 용량이 너무 큽니다. 사용할 사진 수를 줄여 주세요.', 'The photos are still too large after automatic optimization. Use fewer photos.'));
      return payload;
    });
  }

  async function optimizePayloadImages(payload) {
    const limit = 18 * 1024 * 1024;
    if (JSON.stringify(payload).length <= limit) return;
    const profiles = [
      { maxDimension: 2200, quality: 0.88 },
      { maxDimension: 1800, quality: 0.82 },
      { maxDimension: 1440, quality: 0.76 },
    ];
    for (const profile of profiles) {
      payload.images = await Promise.all(payload.images.map(image => optimizeImage(image, profile)));
      if (JSON.stringify(payload).length <= limit) return;
    }
  }

  async function optimizeImage(image, { maxDimension, quality }) {
    const source = String(image?.dataUrl || '');
    if (!imageData.test(source)) return image;
    const decoded = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error(text('게시용 사진을 최적화하지 못했습니다.', 'A photo could not be optimized for posting.')));
      element.src = source;
    });
    const sourceWidth = decoded.naturalWidth || decoded.width;
    const sourceHeight = decoded.naturalHeight || decoded.height;
    const ratio = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * ratio));
    const height = Math.max(1, Math.round(sourceHeight * ratio));
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error(text('게시용 사진을 최적화하지 못했습니다.', 'A photo could not be optimized for posting.'));
    context.fillStyle = '#fff'; context.fillRect(0, 0, width, height);
    context.drawImage(decoded, 0, 0, width, height);
    const optimized = canvas.toDataURL('image/jpeg', quality);
    return optimized.length < source.length ? { ...image, dataUrl: optimized } : image;
  }
  return { english, text, sanitize, toPayload };
})();
