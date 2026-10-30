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
