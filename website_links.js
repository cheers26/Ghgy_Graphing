(() => {
  'use strict';

  const root = document.getElementById('websiteHub');
  const grid = document.getElementById('websiteLinkGrid');
  const count = document.getElementById('websiteLinkCount');
  const status = document.getElementById('websiteLinkStatus');
  if (!root || !grid || !count) return;

  function safeUrl(value) {
    try {
      const text = String(value || '');
      const parsed = new URL(text);
      if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || /[\u0000-\u001f\u007f]/.test(text)) return null;
      return parsed.href;
    } catch {
      return null;
    }
  }

  function hostLabel(value) {
    try { return new URL(value).hostname; } catch { return '外部网站'; }
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  const rows = Array.isArray(window.GALLERY_BOOTSTRAP?.website_links)
    ? window.GALLERY_BOOTSTRAP.website_links
    : [];
  const visible = rows
    .map(item => ({
      title: String(item?.title || '').trim(),
      description: String(item?.description || '').trim(),
      href: safeUrl(item?.url),
    }))
    .filter(item => item.title && item.href);

  grid.replaceChildren();
  count.textContent = `${visible.length} 个网站`;
  if (!visible.length) {
    grid.append(element('div', 'website-hub-empty-v1', '暂无可公开的网站导航。'));
  } else {
    for (const item of visible) {
      const card = element('article', 'website-card-v1');
      const heading = element('div', 'website-card-heading-v1');
      const headingText = element('div');
      headingText.append(element('h3', '', item.title), element('span', '', hostLabel(item.href)));
      heading.append(headingText);
      card.append(heading);
      card.append(element('p', item.description ? '' : 'is-empty', item.description || '点击进入专题网页。'));
      const actions = element('div', 'website-card-actions-v1');
      const open = element('a', 'website-open-link-v1', '打开网站 ↗');
      open.href = item.href;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      actions.append(open);
      card.append(actions);
      grid.append(card);
    }
  }
  if (status) {
    status.textContent = '';
    status.dataset.kind = '';
  }
  root.classList.add('website-hub-public-v1');
})();
