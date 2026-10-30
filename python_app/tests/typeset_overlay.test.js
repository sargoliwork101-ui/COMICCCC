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

function captureLayout({ text, html = '', dir = 'ltr', align = 'justify', plain = false, width = 100, verticalAlign }) {
  const drawn = [];
  const ctx = new Proxy({
    direction: 'inherit',
    measureText: (value) => ({ width: String(value).length * 6 }),
    fillText(value, x, y) { drawn.push({ text: value, x, y, font: this.font, color: this.fillStyle, dir: this.direction }); },
  }, {
    get(target, property) { return property in target ? target[property] : (typeof property === 'string' ? () => {} : undefined); },
    set(target, property, value) { target[property] = value; return true; },
  });
  Typeset.render({ width: 300, height: 200 }, [{ enabled: true, tr: text, richHtml: html, _plainText: plain,
    x0: 0, y0: 0, x1: width, y1: 180, lineH: 12, size: 12, bg: 'white', dir, align, verticalAlign,
  }], { createCanvas: (w, h) => ({ width: w, height: h, getContext: () => ctx }) });
  return drawn;
}
function lineExtents(points) {
  return [Math.min(...points.map((point) => point.x)), Math.max(...points.map((point) => point.x + point.text.length * 6))];
}
assert.equal(Typeset.blockStyle({ align: 'justify' }).align, 'justify');
for (const align of ['left', 'justify']) {
  const multiline = captureLayout({ text: 'one\n\ntwo', align, plain: true });
  assert.deepStrictEqual(multiline.map((point) => point.text), ['one', '', 'two'], `plain ${align} text must preserve blank lines`);
  assert(multiline[2].y > multiline[1].y && multiline[1].y > multiline[0].y);
}
for (const dir of ['ltr', 'rtl']) {
  const points = captureLayout({ text: 'one two three four five six', dir });
  const lines = [...new Set(points.map((point) => point.y))].map((y) => points.filter((point) => point.y === y));
  assert.equal(lines.length, 2);
  assert.deepStrictEqual(lineExtents(lines[0]), [2, 98], `${dir} wrapped line should span both edges`);
  assert(lineExtents(lines[1])[1] - lineExtents(lines[1])[0] < 96, `${dir} last line must not be stretched`);
  assert.equal(dir === 'rtl' ? lineExtents(lines[1])[1] : lineExtents(lines[1])[0], dir === 'rtl' ? 98 : 2);
}
const broken = captureLayout({ text: 'one two\nthree four five six', plain: true });
const firstY = broken[0].y;
assert(lineExtents(broken.filter((p) => p.y === firstY))[1] < 98, 'an explicit paragraph break must not be stretched');
const literal = captureLayout({ text: 'one *two* three four five', plain: true });
assert(literal.some((point) => point.text === '*two*'), 'justified OCR should not interpret literal markers');
console.log('PASS: justified lines fill both edges in RTL and LTR without stretching paragraph endings');

assert.equal(Typeset.blockStyle({}).verticalAlign, 'middle', 'legacy projects stay centred');
assert.equal(Typeset.blockStyle({ verticalAlign: 'invalid' }).verticalAlign, 'middle');
for (const align of ['left', 'justify']) {
  const positions = ['top', 'middle', 'bottom'].map((verticalAlign) => captureLayout({ text: 'one\ntwo', plain: true, align, verticalAlign }));
  const firstYs = positions.map((lines) => lines[0].y);
  assert(firstYs[0] < firstYs[1] && firstYs[1] < firstYs[2], `plain ${align} text respects vertical position`);
  assert(Math.abs(firstYs[0] - 12.9) < 0.01);
  assert(Math.abs(positions[2][1].y - (180 - 3.6 - 9.3)) < 0.01);
  assert.equal(captureLayout({ text: 'one\ntwo', plain: true, align })[0].y, firstYs[1], 'legacy positioning is unchanged');
}
console.log('PASS: vertical top, middle and bottom work for plain and justified OCR');


const { JSDOM } = require('jsdom');
global.document = new JSDOM('').window.document;
const rich = captureLayout({ text: 'one two three four five six', html: '<b>one</b> two three four five six' });
const richFirst = rich.filter((point) => point.y === rich[0].y);
assert.deepStrictEqual(lineExtents(richFirst), [2, 98], 'formatted lines must justify in output too');
const paragraphHtml = '<div style="text-align:left;direction:ltr;font-size:16px;color:#ff0000">first</div><div style="text-align:center">second</div><div style="text-align:right">third</div>';
const paragraphLayout = captureLayout({ text: 'first\nsecond\nthird', html: paragraphHtml, align: 'right', dir: 'rtl' });
const [firstLine, secondLine, thirdLine] = paragraphLayout;
assert.equal(firstLine.x, 2, 'first paragraph must align left');
assert.equal(secondLine.x, (100 - 'second'.length * 6) / 2, 'second paragraph must center independently');
assert.equal(thirdLine.x, 98 - 'third'.length * 6, 'third paragraph must align right');
assert.match(firstLine.font, /16px/); assert.equal(firstLine.dir, 'ltr');
assert.match(firstLine.color, /rgb\(255, 0, 0\)|#ff0000/i);
const mixedSizes = '<div style="font-size:20px">first</div><div style="font-size:40px">second</div>';
const mixedLegacy = captureLayout({ text: 'first\nsecond', html: mixedSizes, align: 'left' });
assert(Math.abs(mixedLegacy[1].y - mixedLegacy[0].y - 31) < 0.01, 'legacy mixed-size placement is unchanged');
const mixedTop = captureLayout({ text: 'first\nsecond', html: mixedSizes, align: 'left', verticalAlign: 'top' });
const mixedBottom = captureLayout({ text: 'first\nsecond', html: mixedSizes, align: 'left', verticalAlign: 'bottom' });
assert(Math.abs(mixedTop[0].y - (3.6 + 15.5)) < 0.01);
assert(Math.abs(mixedTop[1].y - mixedTop[0].y - (31 + 62) / 2) < 0.01, 'different line heights use their own centres');
assert(Math.abs(mixedBottom[1].y - (180 - 3.6 - 31)) < 0.01, 'last large line remains aligned to the bottom');
const blanks = Typeset.richHtmlWords('<div>one</div><div><br></div><div>two</div>');
assert.deepStrictEqual(blanks.map((word) => word.t), ['one', '', 'two'], 'blank paragraphs must remain visible in layout');
const blankLayout = captureLayout({ text: 'one\n\ntwo', html: '<div>one</div><div><br></div><div>two</div>' });
assert(blankLayout[2].y > blankLayout[1].y && blankLayout[1].y > blankLayout[0].y, 'empty paragraph occupies vertical space');
const listWords = Typeset.richHtmlWords('<ol><li>first</li><li>second</li></ol><ul><li>third</li></ul>').map((word) => word.t);
assert.deepStrictEqual(listWords, ['1.', 'first', '2.', 'second', '•', 'third'], 'list markers must reach the final renderer');
const imageOnly = captureLayout({ text: '', html: '<img src="https://example.com/a.png" alt="sample">', align: 'left' });
assert(imageOnly.some((point) => point.text === '[sample]'), 'image-only blocks must show their placeholder even without plain text');
const hrOnly = captureLayout({ text: '', html: '<hr>', align: 'left' });
assert(hrOnly.some((point) => point.text.includes('─')), 'separator-only blocks must not disappear');
delete global.document;
console.log('PASS: rich text justifies and list markers survive output rendering');
