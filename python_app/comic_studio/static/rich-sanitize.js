/* Safe subset shared by the classic editor and the comic project renderer. */
(function (root) {
  'use strict';
  const ALLOWED = new Set('P DIV BR B STRONG I EM U S STRIKE DEL SPAN H1 H2 H3 H4 H5 H6 PRE CODE BLOCKQUOTE UL OL LI A IMG TABLE THEAD TBODY TFOOT TR TD TH HR'.split(' '));
  const DROP = new Set('SCRIPT STYLE IFRAME OBJECT EMBED SVG MATH FORM INPUT BUTTON TEXTAREA SELECT LINK META BASE TEMPLATE NOSCRIPT'.split(' '));
  const VOID = new Set(['BR', 'IMG', 'HR']);
  const BLOCK = new Set('P DIV H1 H2 H3 H4 H5 H6 PRE BLOCKQUOTE LI TD TH'.split(' '));
  const escape = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function safeURL(value, image = false) {
    const url = String(value || '').trim();
    if (!url || /[\u0000-\u001f\u007f]/.test(url)) return '';
    if (image && /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(url) && url.length <= 2800000) return url;
    if (!image && /^#[a-z0-9_:.\-]+$/i.test(url)) return url;
    try {
      const parsed = new URL(url);
      return (image ? ['https:', 'http:'] : ['https:', 'http:', 'mailto:', 'tel:']).includes(parsed.protocol) ? parsed.href : '';
    } catch { return ''; }
  }
  function safeStyle(node) {
    const s = node.style; if (!s) return '';
    const out = []; const size = parseFloat(s.fontSize);
    if (Number.isFinite(size) && /px$/i.test(s.fontSize)) out.push(`font-size:${Math.max(8, Math.min(160, size))}px`);
    const color = s.color;
    if (/^#[0-9a-f]{6}$/i.test(color)) out.push(`color:${color}`);
    else { const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(color); if (rgb && rgb.slice(1).every((x) => +x <= 255)) out.push(`color:#${rgb.slice(1).map((x) => (+x).toString(16).padStart(2, '0')).join('')}`); }
    if (s.fontWeight) out.push(`font-weight:${s.fontWeight === 'bold' || Number(s.fontWeight) >= 600 ? 'bold' : 'normal'}`);
    if (s.fontStyle === 'italic' || s.fontStyle === 'normal') out.push(`font-style:${s.fontStyle}`);
    const decoration = s.textDecorationLine || s.textDecoration || '';
    const safeDecoration = ['underline', 'line-through'].filter((x) => decoration.includes(x)).join(' ');
    if (safeDecoration) out.push(`text-decoration:${safeDecoration}`);
    if (BLOCK.has(node.tagName)) {
      if (['left', 'center', 'right', 'justify'].includes(s.textAlign)) out.push(`text-align:${s.textAlign}`);
      const direction = s.direction || node.getAttribute('dir'); if (['rtl', 'ltr'].includes(direction)) out.push(`direction:${direction}`);
      for (const prop of ['marginLeft', 'marginRight']) { const n = parseFloat(s[prop]); if (Number.isFinite(n) && /px$/i.test(s[prop])) out.push(`${prop === 'marginLeft' ? 'margin-left' : 'margin-right'}:${Math.max(0, Math.min(240, n))}px`); }
    }
    return out.length ? ` style="${out.join(';')};"` : '';
  }
  function sanitize(html) {
    const container = document.createElement('template'); container.innerHTML = String(html || '');
    function walk(node) {
      if (node.nodeType === 3) return escape(node.nodeValue);
      if (node.nodeType !== 1) return '';
      const tag = node.tagName;
      if (DROP.has(tag)) return '';
      const children = [...node.childNodes].map(walk).join('');
      if (!ALLOWED.has(tag)) return children;
      let attrs = safeStyle(node);
      if (tag === 'A') {
        const href = safeURL(node.getAttribute('href')); if (!href) return children;
        attrs += ` href="${escape(href)}"`;
        if (node.getAttribute('target') === '_blank') attrs += ' target="_blank" rel="noopener noreferrer"';
        if (node.getAttribute('title')) attrs += ` title="${escape(node.getAttribute('title').slice(0, 200))}"`;
      }
      if (tag === 'IMG') {
        const src = safeURL(node.getAttribute('src'), true); if (!src) return '';
        attrs += ` src="${escape(src)}" alt="${escape((node.getAttribute('alt') || '').slice(0, 200))}"`;
        const w = Number(node.getAttribute('width')); const h = Number(node.getAttribute('height'));
        if (w >= 1 && w <= 2048) attrs += ` width="${Math.round(w)}"`; if (h >= 1 && h <= 2048) attrs += ` height="${Math.round(h)}"`;
      }
      if (tag === 'HR' && node.getAttribute('data-readmore') === 'true') attrs += ' data-readmore="true"';
      if (tag === 'TD' || tag === 'TH') for (const attr of ['colspan', 'rowspan']) { const n = Number(node.getAttribute(attr)); if (n >= 2 && n <= 20) attrs += ` ${attr}="${Math.round(n)}"`; }
      return `<${tag.toLowerCase()}${attrs}>${VOID.has(tag) ? '' : `${children}</${tag.toLowerCase()}>`}`;
    }
    return [...container.content.childNodes].map(walk).join('');
  }
  root.ComicSanitize = { sanitize, safeURL };
})(window);
