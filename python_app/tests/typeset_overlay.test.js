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
assert.deepStrictEqual(eraseOperations.rects, [[200, 50, 150, 40]]);
assert(eraseOperations.texts.includes('ترجمه'));
eraseOperations.rects.length = 0;
Typeset.render({ width: 500, height: 120 }, [{
  enabled: true, tr: 'ترجمه', richHtml: '', x0: 10, y0: 10, x1: 110, y1: 40,
  lineH: 30, bg: 'white', dir: 'rtl', align: 'right',
}], { createCanvas: (width, height) => ({ width, height, getContext: () => eraseCtx }) });
assert.deepStrictEqual(eraseOperations.rects, [[10, 10, 100, 30]]);
eraseOperations.rects.length = 0;
Typeset.render({ width: 500, height: 120 }, [{
  enabled: true, tr: 'ترجمه', richHtml: '', x0: 10, y0: 10, x1: 110, y1: 40,
  lineH: 30, bg: 'auto', dir: 'rtl', align: 'right',
}], { eraseOriginal: false, createCanvas: (width, height) => ({ width, height, getContext: () => eraseCtx }) });
assert.deepStrictEqual(eraseOperations.rects, [], 'eraseOriginal: false skips auto background fill');
console.log('PASS: background fill strictly matches the box position and dimensions without erasing outside or at old coordinates');

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
{
  const twoColorCtx = {
    getImageData: (_x, _y, w, h) => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let p = 0; p < w * h; p++) {
        const red = p % 2 === 0;
        data[p * 4] = red ? 255 : 0;
        data[p * 4 + 1] = red ? 0 : 255;
        data[p * 4 + 2] = 0;
        data[p * 4 + 3] = 255;
      }
      return { data };
    }
  };
  const sampled = Typeset.sampleBg(twoColorCtx, { x0: 10, y0: 10, x1: 50, y1: 50 }, 60, 60);
  assert.equal(sampled.uniform, false, 'high-contrast red/green border must not look uniform due to sorted channels');
}
{
  assert.match(Typeset.FONT, /^Vazirmatn\b/, 'Typeset.FONT must match CSS @font-face family name');
  const markHtml = Typeset.inlineMarksToHtml('*سرفه* سلام **قهرمان** و __تأکید__ [size=18]درشت[/size] [color=#c0392b]سرخ[/color]\nخط <دوم>');
  assert.equal(
    markHtml,
    '<i>سرفه</i> سلام <b>قهرمان</b> و <u>تأکید</u> <span style="font-size:18px">درشت</span> <span style="color:#c0392b">سرخ</span><br>خط &lt;دوم&gt;',
    'inlineMarksToHtml must convert inline markers and escape HTML entities cleanly',
  );
  const rtlMixed = [{ t: 'سلام' }, { t: 'World' }, { t: '2026' }, { t: 'خوبی' }];
  const vRtl = Typeset.visualLineOrder(rtlMixed, 'rtl');
  assert.deepStrictEqual(vRtl.map((x) => rtlMixed[x.idx].t), ['خوبی', 'World', '2026', 'سلام'], 'RTL visualLineOrder must return left-to-right visual order keeping LTR + trailing digits left-to-right');
  assert.equal(vRtl.filter((x) => x.hasGapAfter).length, rtlMixed.length - 1, 'RTL visualLineOrder must preserve exact gap bijection');

  const rtlNumThenLtr = [{ t: 'سرعت' }, { t: '120' }, { t: 'km/h' }, { t: 'است' }];
  const vNum = Typeset.visualLineOrder(rtlNumThenLtr, 'rtl');
  assert.deepStrictEqual(vNum.map((x) => rtlNumThenLtr[x.idx].t), ['است', 'km/h', '120', 'سرعت'], 'pure numeric token immediately after RTL stays on RTL side right of LTR unit');
  assert.equal(vNum.filter((x) => x.hasGapAfter).length, rtlNumThenLtr.length - 1);

  const ltrMixed = [{ t: 'Hello' }, { t: 'سلام' }, { t: 'دنیا' }, { t: 'World' }];
  const vLtr = Typeset.visualLineOrder(ltrMixed, 'ltr');
  assert.deepStrictEqual(vLtr.map((x) => ltrMixed[x.idx].t), ['Hello', 'دنیا', 'سلام', 'World'], 'LTR visualLineOrder must reverse embedded RTL run');
  assert.equal(vLtr.filter((x) => x.hasGapAfter).length, ltrMixed.length - 1);
  assert.equal(Typeset.boxInset(85), 1.7, 'narrow bubbles keep proportional 2% inset');
  assert.equal(Typeset.boxInset(200), 4, '200px dimension reaches 4px inset cap');
  assert.equal(Typeset.boxInset(500), 4, '10-line tall/wide boxes cap inset at 4px');
  console.log('PASS: v3.63 inlineMarksToHtml and bidirectional visualLineOrder');
}
{
  assert.ok(Typeset.FONT_STACKS && Typeset.FONT_STACKS.tahoma.includes('Tahoma'), 'FONT_STACKS exposes curated font families');
  assert.match(Typeset.resolveFontStack('Comic Sans MS'), /Comic Sans MS/, 'resolveFontStack resolves Comic Sans MS');
  assert.deepStrictEqual(Typeset.BOX_SHAPES, ['rect', 'ellipse', 'pill', 'diamond', 'hexagon', 'cloud'], 'BOX_SHAPES exposes all 6 shapes');
  assert.equal(Typeset.normalizeBoxShape('cloud'), 'cloud');
  assert.equal(Typeset.normalizeBoxShape('unknown'), 'rect');
  assert.equal(Typeset.normalizeCornerRadius(145), 100);
  assert.equal(Typeset.normalizeBoxAngle(375), 15);

  const shapeOps = [];
  const savedCreate = global.document.createElement;
  global.document.createElement = (tag) => {
    if (String(tag).toLowerCase() !== 'canvas') return savedCreate.call(global.document, tag);
    return {
      width: 0, height: 0,
      getContext() {
        return {
          font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, textAlign: 'start', textBaseline: 'alphabetic', direction: 'rtl',
          drawImage() { shapeOps.push(['drawImage']); },
          getImageData(_x, _y, w, h) { return { data: new Uint8ClampedArray(w * h * 4).fill(255) }; },
          fillRect(x, y, w, h) { shapeOps.push(['fillRect', x, y, w, h, this.fillStyle]); },
          save() { shapeOps.push(['save']); },
          restore() { shapeOps.push(['restore']); },
          translate(x, y) { shapeOps.push(['translate', x, y]); },
          rotate(r) { shapeOps.push(['rotate', Number(r.toFixed(4))]); },
          beginPath() { shapeOps.push(['beginPath']); },
          moveTo() {}, lineTo() {}, quadraticCurveTo() {}, arc() {},
          ellipse(cx, cy, rx, ry) { shapeOps.push(['ellipse', cx, cy, rx, ry]); },
          closePath() {},
          fill() { shapeOps.push(['fill', this.fillStyle]); },
          clip() { shapeOps.push(['clip']); },
          stroke() {},
          measureText(s) { return { width: [...String(s)].length * 7 }; },
          fillText(s) { shapeOps.push(['fillText', s, this.font]); },
        };
      },
    };
  };
  Typeset.render({ width: 200, height: 120 }, [{
    id: 1, x0: 20, y0: 20, x1: 140, y1: 80,
    tr: 'سلام کمیک', richHtml: '<span style="font-family:Tahoma">سلام کمیک</span>',
    enabled: true, bg: '#ffeeaa', shape: 'ellipse', angle: 30, fontFamily: 'Impact',
  }]);
  global.document.createElement = savedCreate;
  assert.ok(shapeOps.some((op) => op[0] === 'fillRect' && op[1] === 20 && op[2] === 20), 'rotated non-rect box erases original source rect first');
  assert.ok(shapeOps.some((op) => op[0] === 'rotate' && Math.abs(op[1] - 0.5236) < 0.01), '30deg box rotates canvas context around box center');
  assert.ok(shapeOps.some((op) => op[0] === 'ellipse' && op[3] === 60 && op[4] === 30), 'ellipse shape builds exact half-width/half-height path');
  assert.ok(shapeOps.some((op) => op[0] === 'fill' && op[1] === '#ffeeaa'), 'custom hex bg fills shaped path');
  assert.ok(shapeOps.some((op) => op[0] === 'fillText' && String(op[2]).includes('Tahoma')), 'inline span font-family reaches fillText font');
  console.log('PASS: v4.12 font stacks, shapes, corner radius, rotation, and custom hex bg in Typeset');
}
delete global.document;
console.log('PASS: rich text justifies and list markers survive output rendering');
