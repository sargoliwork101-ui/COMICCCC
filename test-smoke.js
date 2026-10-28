// Smoke tests (node) for pure logic of the extension
const PdfBuilder = require('./pdfbuilder.js');
const OcrTools = require('./ocr.js');
const Typeset = require('./typeset.js');
const TranslateTools = require('./translate.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('PASS:', name);
  else { failures++; console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

// ---------- mock jsPDF ----------
function makeMockJsPDF() {
  const calls = [];
  const pages = [];
  class Mock {
    constructor(opts) { pages.push({ dims: opts.format, orient: opts.orientation, images: [] }); }
    addPage(dims, orient) { pages.push({ dims, orient, images: [] }); }
    addImage(data, fmt, x, y, w, h, alias, comp) {
      pages[pages.length - 1].images.push({ data, fmt, x, y, w, h, alias, comp });
      calls.push({ fmt, alias, w, h });
    }
    output() { return { blob: () => ({ size: 1 }) }; }
  }
  return { Mock, calls, pages };
}

const mkItem = (i, w = 100, h = 200, fmt = 'JPEG', ok = true) => ({
  i, w, h, fmt, info: { fmt, w, h, ok }, data: new Uint8Array([1, 2, 3]), alias: 'a' + i
});
const prepare = async (it) => [{ data: it.data, fmt: it.fmt, w: it.w, h: it.h, alias: it.alias }];

(async () => {
  // 1. normal build: one page per item
  {
    const { Mock, calls, pages } = makeMockJsPDF();
    const items = [mkItem(0), mkItem(1), mkItem(2)];
    const res = await PdfBuilder.build({ jsPDF: Mock, items, prepare, fallback: async (s) => ({ data: 'x', fmt: 'JPEG' }) });
    check('normal: pdf created', !!res.pdf);
    check('normal: 3 pages', pages.length === 3, pages.length);
    check('normal: 3 images', calls.length === 3, calls.length);
  }

  // 2. empty items -> pdf null, no throw
  {
    const { Mock, pages } = makeMockJsPDF();
    const res = await PdfBuilder.build({ jsPDF: Mock, items: [], prepare });
    check('empty: pdf null', res.pdf === null);
    check('empty: zero pages', res.pages === 0);
  }

  // 3. seamless: single tall page, all images queued
  {
    const { Mock, calls, pages } = makeMockJsPDF();
    const items = [mkItem(0, 100, 500), mkItem(1, 100, 500), mkItem(2, 100, 500)];
    const res = await PdfBuilder.build({ jsPDF: Mock, items, seamless: true, prepare });
    check('seamless: pdf created', !!res.pdf);
    check('seamless: 1 page', pages.length === 1, pages.length);
    check('seamless: 3 images on page', calls.length === 3, calls.length);
  }

  // 4. uniform size pages
  {
    const { Mock, pages } = makeMockJsPDF();
    const items = [mkItem(0, 100, 100), mkItem(1, 300, 400)];
    const res = await PdfBuilder.build({ jsPDF: Mock, items, uniformSize: true, prepare });
    check('uniform: 2 pages same dims', pages.length === 2 &&
      pages[0].dims && pages[1].dims &&
      pages[0].dims[0] === pages[1].dims[0] && pages[0].dims[1] === pages[1].dims[1]);
  }

  // 5. fallback when addImage throws
  {
    const { Mock, calls } = makeMockJsPDF();
    class Failing extends Mock {
      addImage(data, fmt, x, y, w, h, alias) {
        if (!String(alias).endsWith('f')) throw new Error('bad image');
        super.addImage(data, fmt, x, y, w, h, alias);
      }
    }
    const items = [mkItem(0)];
    const res = await PdfBuilder.build({ jsPDF: Failing, items, prepare, fallback: async (s) => ({ data: 'fb', fmt: 'JPEG' }) });
    check('fallback: recovered', calls.length === 1 && calls[0].alias === 'a0f', calls);
  }

  // 6. very tall image in seamless -> multiple pages, each under HARD_PT
  // prepare mirrors viewer.js: slice at floor(SAFE_PT / r) like decodeSlices
  {
    const { Mock, pages } = makeMockJsPDF();
    const tall = mkItem(0, 800, 40000);
    const slicingPrepare = async (it, r) => {
      const maxSrcH = Math.min(Math.floor(PdfBuilder.SAFE_PT / r), 16000); // viewer caps slices at MAX_CANVAS_H
      const segs = [];
      for (let y = 0; y < it.h; y += maxSrcH) {
        const sh = Math.min(maxSrcH, it.h - y);
        segs.push({ data: it.data, fmt: it.fmt, w: it.w, h: sh, alias: `${it.alias}_${y}` });
      }
      return segs;
    };
    const res = await PdfBuilder.build({ jsPDF: Mock, items: [tall], seamless: false, prepare: slicingPrepare });
    const maxH = Math.max(...pages.map((p) => p.dims[1]));
    check('tall image: slices become multiple pages', pages.length === 3, pages.length);
    check('tall image: every page height <= 14400', maxH <= 14400, maxH);
    // seamless mode intentionally fits the whole strip on one long page
    const s2 = makeMockJsPDF();
    await PdfBuilder.build({ jsPDF: s2.Mock, items: [tall], seamless: true, prepare: slicingPrepare });
    check('seamless: single long page within limit', s2.pages.length === 1 && s2.pages[0].dims[1] <= 14400, s2.pages.map((p) => p.dims[1]));
  }

  // 7. isCancelled stops the build loop and reports the cancellation
  {
    const { Mock, calls } = makeMockJsPDF();
    const items = [mkItem(0), mkItem(1), mkItem(2), mkItem(3)];
    let cancel = false;
    const cancelPrepare = async (it) => {
      if (it.i === 1) cancel = true; // flipped while item 1 is being prepared
      return prepare(it);
    };
    const res = await PdfBuilder.build({ jsPDF: Mock, items, prepare: cancelPrepare, isCancelled: () => cancel });
    check('cancel: result flagged cancelled', res.cancelled === true, res.cancelled);
    check('cancel: remaining items never processed', calls.length === 2, calls.length);
  }

  // 7b. without isCancelled the new field stays false (backward compatible)
  {
    const { Mock } = makeMockJsPDF();
    const res = await PdfBuilder.build({ jsPDF: Mock, items: [mkItem(0)], prepare });
    check('normal run: cancelled flag is false', res.cancelled === false, res.cancelled);
  }

  // ---------- OCR ----------
  check('looksReal eng accepts sentence', OcrTools.looksReal('Hello world this is real', 'eng') === true);
  check('looksReal eng rejects noise', OcrTools.looksReal('--- ... !!!', 'eng') === false);
  check('looksReal jpn accepts kana', OcrTools.looksReal('こんにちは', 'jpn') === true);
  check('looksReal kor', OcrTools.looksReal('안녕하세요 세상', 'kor') === true);

  // groupLines: two close lines merge into one block
  {
    const lines = [
      { text: 'Hello', conf: 90, x0: 10, x1: 100, y0: 10, y1: 30 },
      { text: 'world', conf: 90, x0: 12, x1: 95, y0: 32, y1: 52 }
    ];
    const blocks = OcrTools.groupLines(lines, false);
    check('groupLines merges close lines', blocks.length === 1, blocks.length);
    check('groupLines block has id/enabled/bg/tr', blocks[0] && blocks[0].id === 1 && blocks[0].enabled === true && blocks[0].bg === 'auto' && blocks[0].tr === '');
  }
  // groupLines: far apart lines stay separate
  {
    const lines = [
      { text: 'Hello', conf: 90, x0: 10, x1: 100, y0: 10, y1: 30 },
      { text: 'world', conf: 90, x0: 12, x1: 95, y0: 400, y1: 420 }
    ];
    const blocks = OcrTools.groupLines(lines, false);
    check('groupLines keeps distant lines separate', blocks.length === 2, blocks.length);
  }
  // groupLines empty
  {
    const blocks = OcrTools.groupLines([], false);
    check('groupLines empty', Array.isArray(blocks) && blocks.length === 0);
  }

  // extractLines with fake tesseract data
  {
    const data = { blocks: [{ paragraphs: [{ lines: [
      { text: 'Recognizable text here', confidence: 80, bbox: { x0: 0, x1: 100, y0: 0, y1: 20 } },
      { text: 'x', confidence: 10, bbox: { x0: 0, x1: 5, y0: 0, y1: 10 } }
    ] }] }] };
    const out = OcrTools.extractLines(data, 0, false, 40, 'eng', { raw: 0 });
    check('extractLines keeps high-conf line', out.length === 1, out);
    check('extractLines offset applied', out[0] && out[0].y0 === 0);
    const out2 = OcrTools.extractLines(data, 50, false, 40, 'eng', null, 30);
    check('extractLines x/y offsets', out2[0] && out2[0].y0 === 50 && out2[0].x0 === 30, out2[0]);
  }

  // ---------- Typeset ----------
  // mock 2d context + canvas
  function mockCtx() {
    return new Proxy({}, {
      get(t, prop) {
        if (prop === 'measureText') return (s) => ({ width: String(s).length * 6 });
        if (prop === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) });
        return typeof prop === 'string' ? (() => {}) : undefined;
      },
      set() { return true; }
    });
  }
  global.document = { createElement: () => ({ width: 0, height: 0, getContext: () => mockCtx() }) };
  {
    const bmp = { width: 200, height: 200 };
    const blocks = [
      { enabled: true, tr: 'سلام دنیا', x0: 10, y0: 10, x1: 100, y1: 60, lineH: 16, bg: 'white' },
      { enabled: false, tr: 'مخفی', x0: 10, y0: 80, x1: 100, y1: 130, lineH: 16, bg: 'white' },
      { enabled: true, tr: '   ', x0: 10, y0: 140, x1: 100, y1: 180, lineH: 16, bg: 'black' }
    ];
    const cv = Typeset.render(bmp, blocks, {});
    check('Typeset render returns canvas', cv && cv.width === 200 && cv.height === 200);
  }
  {
    const ctx = mockCtx();
    const lines = Typeset.wrapWords(ctx, 'one two three four five six seven', 20);
    check('wrapWords returns array', Array.isArray(lines) && lines.length >= 1);
    const f = Typeset.fit(ctx, 'hello', 100, 100, 40, 10);
    check('fit returns size/lines/lh', f && f.size >= 10 && Array.isArray(f.lines) && f.lh > 0, f);
  }

  // ---------- Typeset per-block formatting (2.27) ----------
  function recordingCtx() {
    const calls = { font: [], textAlign: [], direction: [], fillStyles: [], fillText: [], strokeText: 0, beginPath: 0, stroke: 0, lineTo: 0 };
    const ctx = {
      textBaseline: '', lineWidth: 0, strokeStyle: '', lineJoin: '',
      drawImage() {}, fillRect() {},
      measureText: (s) => ({ width: String(s).length * 6 }),
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }),
      fillText(t, x, y) { calls.fillText.push({ t, x, y }); },
      strokeText() { calls.strokeText++; },
      beginPath() { calls.beginPath++; },
      stroke() { calls.stroke++; },
      moveTo() {}, lineTo() { calls.lineTo++; }
    };
    let font = '', textAlign = '', direction = '', fillStyle = '';
    Object.defineProperty(ctx, 'font', { get: () => font, set: (v) => { font = v; calls.font.push(v); }, configurable: true });
    Object.defineProperty(ctx, 'textAlign', { get: () => textAlign, set: (v) => { textAlign = v; calls.textAlign.push(v); }, configurable: true });
    Object.defineProperty(ctx, 'direction', { get: () => direction, set: (v) => { direction = v; calls.direction.push(v); }, configurable: true });
    Object.defineProperty(ctx, 'fillStyle', { get: () => fillStyle, set: (v) => { fillStyle = v; calls.fillStyles.push(v); }, configurable: true });
    return { ctx, calls };
  }
  const fmtBase = { enabled: true, tr: 'سلام دنیا', x0: 10, y0: 10, x1: 190, y1: 80, lineH: 16, bg: 'white' };
  const renderWith = (extra) => {
    const { ctx, calls } = recordingCtx();
    Typeset.render({ width: 200, height: 200 }, [{ ...fmtBase, ...extra }],
      { createCanvas: () => ({ width: 200, height: 200, getContext: () => ctx }) });
    return calls;
  };
  {
    const calls = renderWith({});
    check('legacy block defaults to right align', calls.textAlign.every((a) => a === 'right'), calls.textAlign);
    check('default font is bold 700 without italic', calls.font.some((f) => /700/.test(f) && !/italic/.test(f)), calls.font);
    check('no underline path by default', calls.stroke === 0 && calls.beginPath === 0);
    check('fillText invoked for translation', calls.fillText.length >= 1);
  }
  {
    const calls = renderWith({ align: 'left', bold: false, italic: true });
    check('left align applied to canvas', calls.textAlign.every((a) => a === 'left'));
    check('italic regular-weight font built', calls.font.some((f) => /^italic 400 /.test(f)), calls.font);
  }
  {
    const calls = renderWith({ align: 'center', size: 33 });
    check('center align applied to canvas', calls.textAlign.every((a) => a === 'center'));
    check('manual font size honored over auto-fit', calls.font.some((f) => f.includes('33px')), calls.font);
  }
  {
    const calls = renderWith({ underline: true });
    check('underline draws a stroked path', calls.beginPath >= 1 && calls.stroke >= 1 && calls.lineTo >= 1);
  }
  {
    const calls = renderWith({ bg: 'none' });
    check('bg none keeps outline strokeText', calls.strokeText >= 1);
  }
  {
    const st = Typeset.blockStyle({});
    check('blockStyle safe defaults', st.dir === 'rtl' && st.align === 'right' && st.bold === true &&
      st.italic === false && st.underline === false && st.size === null && st.color === null, st);
  }
  {
    const calls = renderWith({});
    check('default canvas direction is rtl', calls.direction.every((d) => d === 'rtl'), calls.direction);
  }
  {
    const calls = renderWith({ dir: 'ltr' });
    check('ltr block sets canvas direction ltr', calls.direction.every((d) => d === 'ltr'), calls.direction);
  }
  {
    const calls = renderWith({ color: '#e11d48' });
    check('manual text color reaches fillStyle before drawing', calls.fillStyles.includes('#e11d48'), calls.fillStyles);
  }
  {
    const st = Typeset.blockStyle({ color: 'not-a-color', dir: 'sideways' });
    check('invalid color/dir fall back safely', st.color === null && st.dir === 'rtl', st);
  }

  // ---------- Typeset inline (per-word) formatting (2.44) ----------
  {
    check('hasInlineMarks detects markers',
      Typeset.hasInlineMarks('a **b** c *d* e __f__') === true &&
      Typeset.hasInlineMarks('plain text with * unmatched') === false);
    const runs = Typeset.tokenizeInline('سلام **دنیا** *کج* __خط__');
    check('tokenizeInline splits styled runs',
      runs.some((r) => r.t === 'دنیا' && r.bold) &&
      runs.some((r) => r.t === 'کج' && r.italic) &&
      runs.some((r) => r.t === 'خط' && r.underline) &&
      runs.some((r) => r.t.includes('سلام') && !r.bold && !r.italic && !r.underline), runs);
    check('stripInlineMarkers keeps the words only',
      Typeset.stripInlineMarkers('سلام **دنیا** *کج* __خط__') === 'سلام دنیا کج خط');
  }
  {
    // block is non-bold; the inline bold word must switch font to 700 while neighbors stay 400
    const calls = renderWith({ bold: false, tr: 'one **two** three' });
    check('inline bold word drawn separately',
      calls.fillText.some((f) => f.t === 'two') &&
      calls.fillText.some((f) => f.t === 'one') &&
      calls.fillText.some((f) => f.t === 'three'), calls.fillText.map((f) => f.t));
    check('inline bold uses 700 while plain words use 400 in a non-bold block',
      calls.font.some((f) => /700/.test(f)) && calls.font.some((f) => /400/.test(f)), calls.font);
  }
  {
    const calls = renderWith({ bold: false, underline: false, tr: 'base __u__ base' });
    check('inline underline draws a stroked path without block underline',
      calls.beginPath >= 1 && calls.stroke >= 1 && calls.lineTo >= 1);
  }
  {
    const calls = renderWith({ tr: 'no markers here' });
    check('plain text still uses the single-run path (right align)',
      calls.textAlign.every((a) => a === 'right') &&
      calls.fillText.some((f) => f.t === 'no markers here'), calls.textAlign);
  }
  {
    const runs = Typeset.tokenizeInline('a [size=24]big[/size] b [color=#ff0000]red[/color]');
    const sizeRun = runs.find((r) => r.t === 'big');
    const colorRun = runs.find((r) => r.t === 'red');
    check('tokenizeInline parses size and color tags',
      sizeRun && sizeRun.size === 24 && colorRun && colorRun.color === '#ff0000', runs);
    check('stripInlineMarkers removes size/color tags too',
      Typeset.stripInlineMarkers('a [size=24]big[/size] [color=#ff0000]red[/color]') === 'a big red');
  }
  {
    const calls = renderWith({ tr: 'a [size=24]big[/size] b' });
    check('inline size word renders at its own font size',
      calls.fillText.some((f) => f.t === 'big') && calls.font.some((f) => f.includes('24px')), calls.font);
  }
  {
    const calls = renderWith({ tr: 'x [color=#ff0000]red[/color] y' });
    check('inline color word reaches fillStyle', calls.fillStyles.includes('#ff0000'), calls.fillStyles);
  }

  // ---------- Translate with mock fetch ----------
  {
    const fetchFn = async (url) => ({
      ok: true,
      json: async () => [[['سلام', 'hi']], null, null]
    });
    const r = await TranslateTools.translate('hi', 'en', fetchFn);
    check('translate google mock', r.ok === true && r.text === 'سلام', r);
  }
  {
    // google fails twice, mymemory succeeds
    let calls = 0;
    const fetchFn = async (url) => {
      calls++;
      if (url.includes('google')) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => ({ responseData: { translatedText: 'سلام' } }) };
    };
    const r = await TranslateTools.translate('hi', 'en', fetchFn);
    check('translate fallback mymemory', r.ok === true && r.text === 'سلام', r);
    check('translate tried google first', calls >= 2, calls);
  }
  {
    const fetchFn = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const r = await TranslateTools.translate('hi', 'en', fetchFn);
    check('translate all fail -> ok false', r.ok === false && r.text === '', r);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(2); });
