const assert = require('assert');
const Typeset = require('../comic_studio/static/typeset.js');

function renderText(block) {
  const drawn = [];
  const ctx = new Proxy({
    measureText: (text) => ({ width: String(text).length * 6 }),
    fillText: (text) => drawn.push(text),
  }, {
    get(target, property) {
      if (property in target) return target[property];
      return typeof property === 'string' ? () => {} : undefined;
    },
    set() { return true; },
  });
  Typeset.render({ width: 500, height: 120 }, [{
    enabled: true, tr: '', richHtml: '', x0: 10, y0: 10, x1: 490, y1: 100,
    lineH: 30, bg: 'white', dir: 'ltr', align: 'left', ...block,
  }], { createCanvas: (width, height) => ({ width, height, getContext: () => ctx }) });
  return drawn;
}

const plain = renderText({ tr: 'HELLO *WORLD*', _plainText: true });
assert.deepStrictEqual(plain, ['HELLO *WORLD*']);
console.log('PASS: OCR plain-text mode preserves literal source markers');

const translated = renderText({ tr: 'HELLO *WORLD*' });
assert(translated.includes('HELLO') && translated.includes('WORLD'));
assert(translated.every((text) => !text.includes('*')));
console.log('PASS: translation mode keeps existing inline formatting behavior');

const eraseOperations = { rects: [], texts: [] };
const eraseCtx = new Proxy({
  measureText: (text) => ({ width: String(text).length * 6 }),
  fillRect: (...args) => eraseOperations.rects.push(args),
  fillText: (text) => eraseOperations.texts.push(text),
}, {
  get(target, property) {
    if (property in target) return target[property];
    return typeof property === 'string' ? () => {} : undefined;
  },
  set() { return true; },
});
Typeset.render({ width: 500, height: 120 }, [{
  enabled: true, tr: 'ترجمه', richHtml: '', x0: 10, y0: 10, x1: 110, y1: 40,
  tx0: 200, ty0: 50, tx1: 350, ty1: 90, lineH: 30, bg: 'white', dir: 'rtl', align: 'right',
}], { createCanvas: (width, height) => ({ width, height, getContext: () => eraseCtx }) });
assert(eraseOperations.rects.some((rect) => JSON.stringify(rect) === JSON.stringify([1, 1, 118, 48])));
assert(eraseOperations.rects.some((rect) => JSON.stringify(rect) === JSON.stringify([200, 50, 150, 40])));
assert(eraseOperations.texts.includes('ترجمه'));
console.log('PASS: translated output erases the original OCR area even when the translation box moves');

const paintOrder = [];
const overlapCtx = new Proxy({
  measureText: (text) => ({ width: String(text).length * 6 }),
  fillRect: (...args) => paintOrder.push({ rect: args }),
  fillText: (text) => paintOrder.push({ text }),
}, {
  get(target, property) {
    if (property in target) return target[property];
    return typeof property === 'string' ? () => {} : undefined;
  },
  set() { return true; },
});
Typeset.render({ width: 500, height: 220 }, [
  { enabled: true, tr: 'FIRST', richHtml: '', x0: 10, y0: 10, x1: 50, y1: 30, tx0: 100, ty0: 100, tx1: 180, ty1: 140, lineH: 20, bg: 'white', dir: 'ltr', align: 'left' },
  { enabled: true, tr: 'SECOND', richHtml: '', x0: 90, y0: 90, x1: 190, y1: 150, tx0: 300, ty0: 100, tx1: 400, ty1: 140, lineH: 20, bg: 'white', dir: 'ltr', align: 'left' },
], { createCanvas: (width, height) => ({ width, height, getContext: () => overlapCtx }) });
const firstTextIndex = paintOrder.findIndex((entry) => entry.text);
const lastFillIndex = paintOrder.findLastIndex((entry) => entry.rect);
assert(firstTextIndex >= 0 && lastFillIndex >= 0 && lastFillIndex < firstTextIndex, 'all erasures and target fills must finish before any text is painted');
console.log('PASS: later erasures and box fills cannot cover previously rendered text');
