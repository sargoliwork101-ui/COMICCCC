// Safe text-node helpers for the translated copy of a webpage. No markup or attributes are rewritten.
(function (root) {
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'CANVAS',
    'CODE', 'PRE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'BUTTON', 'KBD', 'SAMP'
  ]);
  const LETTER_RE = /\p{L}/u;
  const MAX_SEGMENT_CHARS = 420;
  const MAX_BATCH_ITEMS = 20;
  const MAX_BATCH_CHARS = 5000;

  function splitText(text, id, maxChars = MAX_SEGMENT_CHARS) {
    const source = String(text || '');
    const limit = Math.max(40, Math.floor(Number(maxChars) || MAX_SEGMENT_CHARS));
    if (source.length <= limit) return [{ id: String(id), text: source, after: '' }];
    const pieces = [];
    let remaining = source;
    let serial = 0;
    while (remaining.length > limit) {
      let cut = remaining.lastIndexOf(' ', limit);
      const newline = remaining.lastIndexOf('\n', limit);
      if (newline > cut) cut = newline;
      if (cut < Math.floor(limit * 0.55)) cut = limit;
      const chunk = remaining.slice(0, cut).trimEnd();
      if (!chunk) {
        cut = limit;
        pieces.push({ id: `${id}-s${String(++serial).padStart(3, '0')}`, text: remaining.slice(0, cut), after: '' });
        remaining = remaining.slice(cut);
        continue;
      }
      const tail = remaining.slice(chunk.length);
      const gap = (tail.match(/^\s+/u) || [''])[0];
      pieces.push({ id: `${id}-s${String(++serial).padStart(3, '0')}`, text: chunk, after: gap });
      remaining = tail.slice(gap.length);
    }
    if (remaining) pieces.push({ id: `${id}-s${String(++serial).padStart(3, '0')}`, text: remaining, after: '' });
    return pieces;
  }

  function isSkipped(node, rootElement) {
    let element = node && node.parentElement;
    while (element) {
      if (SKIP_TAGS.has(element.tagName) || element.hidden || element.getAttribute('aria-hidden') === 'true' ||
          element.isContentEditable || element.hasAttribute('data-wtpdf-page-translation-ui')) return true;
      if (element.hasAttribute('contenteditable') && element.getAttribute('contenteditable') !== 'false') return true;
      const style = element.ownerDocument && element.ownerDocument.defaultView
        ? element.ownerDocument.defaultView.getComputedStyle(element) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return true;
      if (element === rootElement) break;
      element = element.parentElement;
    }
    return false;
  }

  function collectTextNodes(rootElement, doc) {
    const rootNode = rootElement || (doc && doc.body) || (typeof document !== 'undefined' ? document.body : null);
    const owner = doc || (rootNode && rootNode.ownerDocument) || (typeof document !== 'undefined' ? document : null);
    if (!rootNode || !owner || !owner.createTreeWalker) return [];
    const walker = owner.createTreeWalker(rootNode, 4);
    const records = [];
    let node;
    while ((node = walker.nextNode())) {
      if (!node.nodeValue || isSkipped(node, rootNode)) continue;
      const original = node.nodeValue;
      const trimmed = original.trim();
      if (trimmed.length < 2 || !LETTER_RE.test(trimmed)) continue;
      const leading = (original.match(/^\s*/u) || [''])[0];
      const trailing = (original.match(/\s*$/u) || [''])[0];
      const core = original.slice(leading.length, original.length - trailing.length);
      if (core.length < 2 || !LETTER_RE.test(core)) continue;
      const id = `p${String(records.length + 1).padStart(6, '0')}`;
      records.push({ id, node, original, leading, trailing, parts: splitText(core, id) });
    }
    return records;
  }

  function createEntries(records) {
    return (Array.isArray(records) ? records : []).flatMap((record) =>
      (record.parts || []).map((part) => ({ id: part.id, page: 1, text: part.text })));
  }

  function splitBatches(entries, options = {}) {
    const maxItems = Math.max(1, Math.floor(Number(options.maxItems) || MAX_BATCH_ITEMS));
    const maxChars = Math.max(1, Math.floor(Number(options.maxChars) || MAX_BATCH_CHARS));
    const batches = [];
    let batch = [], chars = 0;
    (Array.isArray(entries) ? entries : []).forEach((entry) => {
      const length = String(entry && entry.text || '').length;
      if (batch.length && (batch.length >= maxItems || chars + length > maxChars)) {
        batches.push(batch); batch = []; chars = 0;
      }
      batch.push(entry); chars += length;
    });
    if (batch.length) batches.push(batch);
    return batches;
  }

  function applyTranslations(records, translations) {
    const map = translations instanceof Map ? translations : new Map(Object.entries(translations || {}));
    (Array.isArray(records) ? records : []).forEach((record) => {
      const content = (record.parts || []).map((part) => {
        const translated = String(map.get(part.id) || '').trim();
        return (translated || part.text) + (part.after || '');
      }).join('');
      record.translated = record.leading + content + record.trailing;
      if (record.node && record.node.isConnected) record.node.nodeValue = record.translated;
    });
    return records;
  }

  function showOriginal(records) {
    (Array.isArray(records) ? records : []).forEach((record) => {
      if (record.node && record.node.isConnected) record.node.nodeValue = record.original;
    });
  }

  function showTranslations(records) {
    (Array.isArray(records) ? records : []).forEach((record) => {
      if (record.node && record.node.isConnected && typeof record.translated === 'string') record.node.nodeValue = record.translated;
    });
  }

  function restoreOriginal(records) {
    showOriginal(records);
    return [];
  }

  const api = {
    MAX_SEGMENT_CHARS, MAX_BATCH_ITEMS, MAX_BATCH_CHARS,
    collectTextNodes, createEntries, splitText, splitBatches,
    applyTranslations, showOriginal, showTranslations, restoreOriginal
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PageTranslationTools = api;
})(typeof window !== 'undefined' ? window : globalThis);
