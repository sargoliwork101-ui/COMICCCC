// Interaction tests: cropper pointer math, drag/drop reorder, helpers, keyboard handling.
const fs = require('fs');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfab440000000049454e44ae426082',
  'hex'
);

function boot() {
  const html = fs.readFileSync(__dirname + '/viewer.html', 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html, { url: 'https://example.com/viewer.html?job=testjob', pretendToBeVisual: true, runScripts: 'dangerously' });
  const { window } = dom;
  const ctx = dom.getInternalVMContext();
  const ev = (code) => vm.runInContext(code, ctx);
  Object.defineProperty(window.Element.prototype, 'innerText', {
    get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true
  });
  const storageMap = new Map([['job_testjob', {
    urls: ['https://comic.test/a.png', 'https://comic.test/b.png', 'https://comic.test/c.png'],
    name: 'comic.pdf', tabId: null, pageUrl: 'https://comic.test/page', skippedInline: 0
  }]]);
  window.chrome = {
    runtime: { id: 'extid123', getURL: (p) => 'chrome-extension://extid123/' + p },
    storage: { local: {
      get: async (k) => ({ [k]: storageMap.get(k) }),
      set: async (o) => Object.entries(o).forEach(([k, v]) => storageMap.set(k, v)),
      remove: async (k) => storageMap.delete(k)
    } },
    declarativeNetRequest: { updateSessionRules: async () => {} },
    tabs: { create: async () => ({}), update: async () => {} },
    scripting: { executeScript: async () => [{ result: { data: 'data:image/png;base64,' + PNG.toString('base64') } }] },
    downloads: { download: async () => 1 }
  };
  window.fetch = async () => ({ ok: true, status: 200, blob: async () => new window.Blob([PNG], { type: 'image/png' }), json: async () => [[]] });
  window.URL.createObjectURL = () => 'blob:mock/x';
  window.URL.revokeObjectURL = () => {};
  window.createImageBitmap = async () => ({ width: 100, height: 200, close() {} });
  window.HTMLCanvasElement.prototype.getContext = function () {
    return new Proxy({}, { get: (t, p) => {
      if (p === 'measureText') return (s) => ({ width: String(s).length * 6 });
      if (p === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)) });
      return typeof p === 'string' ? () => {} : undefined;
    }, set: () => true });
  };
  window.HTMLCanvasElement.prototype.toBlob = function (cb) { cb(new window.Blob([PNG], { type: 'image/png' })); };
  window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,' + PNG.toString('base64');
  window.confirm = () => true; window.alert = (m) => console.log('  [alert]', m);
  window.navigator.clipboard = { write: async () => {} };
  window.ClipboardItem = class {};
  window.showDirectoryPicker = undefined;
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  // jsdom lacks pointer capture
  window.Element.prototype.setPointerCapture = () => {};
  window.Element.prototype.releasePointerCapture = () => {};
  // jsdom lacks DragEvent
  window.DragEvent = class DragEvent extends window.MouseEvent {
    constructor(type, init = {}) { super(type, init); this.dataTransfer = init.dataTransfer; }
  };
  for (const f of ['jspdf.umd.min.js', 'pdfbuilder.js', 'tesseract.min.js', 'ocr.js', 'typeset.js', 'translate.js', 'viewer.js', 'trans.js']) {
    vm.runInContext(fs.readFileSync(__dirname + '/' + f, 'utf8'), ctx, { filename: f });
  }
  return { dom, window, ctx, ev, $: (id) => window.document.getElementById(id) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (n, c, e) => { if (c) console.log('PASS:', n); else { failures++; console.log('FAIL:', n, e !== undefined ? JSON.stringify(e) : ''); } };

(async () => {
  const h = boot();
  for (let i = 0; i < 50; i++) { await sleep(80); if (!h.ev('loading')) break; }

  // ---- helpers ----
  check('cleanFolderName strips illegal chars', h.ev(`cleanFolderName('a/b\\\\c:d*e?f"g<h>i|j')`) === 'a_b_c_d_e_f_g_h_i_j');
  check('cleanFolderName trims leading dots', h.ev(`cleanFolderName('...name')`) === 'name');
  check('blobExt png', await h.ev(`blobExt(new Blob([new Uint8Array([0x89,0x50,0x4e,0x47])], {type:'image/png'}))`) === 'png');
  check('blobExt jpg', await h.ev(`blobExt(new Blob([new Uint8Array([0xff,0xd8,0xff])], {type:'image/jpeg'}))`) === 'jpg');
  check('canConvert bounds', h.ev('canConvert(100,100)') === true && h.ev('canConvert(40000,100)') === false);

  // force known intrinsic dimensions (the mock PNG is 1x1 on disk)
  h.ev('items[0].w = 100; items[0].h = 200; items[0].info = {fmt:"PNG", w:100, h:200, ok:true}');

  // ---- cropper draw gesture ----
  h.ev('openCropper(items[0])');
  const stage = h.$('cropStage');
  const img = h.$('cropImg');
  img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 200, right: 100, bottom: 200 });
  function pointer(type, x, y) {
    const ev0 = new h.window.PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true });
    stage.dispatchEvent(ev0);
  }
  pointer('pointerdown', 10, 20);
  pointer('pointermove', 60, 120);
  pointer('pointerup', 60, 120);
  let rect = h.ev('cropRectDraft');
  check('crop draw creates normalized rect', rect && Math.abs(rect.x - 0.1) < 1e-9 && Math.abs(rect.y - 0.1) < 1e-9 &&
    Math.abs(rect.w - 0.5) < 1e-9 && Math.abs(rect.h - 0.5) < 1e-9, rect);
  h.$('cropApply').click();
  check('crop saved on item', JSON.stringify(h.ev('items[0].cropRect')) === JSON.stringify(rect));
  check('cropper closed after apply', h.$('cropper').classList.contains('hidden'));

  // reopen and move selection (dispatch pointerdown on the selection box itself, as a real browser would)
  h.ev('openCropper(items[0])');
  img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 200, right: 100, bottom: 200 });
  const selBox = h.$('cropSelection');
  selBox.getBoundingClientRect = () => ({ left: 10, top: 20, width: 50, height: 100, right: 60, bottom: 120 });
  function pointerOn(target, type, x, y) {
    target.dispatchEvent(new h.window.PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true }));
  }
  pointerOn(selBox, 'pointerdown', 35, 70); // inside existing selection (x 10-60, y 20-120)
  pointer('pointermove', 45, 90);
  pointer('pointerup', 45, 90);
  const moved = h.ev('cropRectDraft');
  check('crop move keeps size', Math.abs(moved.w - 0.5) < 1e-9 && Math.abs(moved.h - 0.5) < 1e-9, moved);
  // Escape closes cropper
  h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('escape closes cropper', h.$('cropper').classList.contains('hidden'));

  // dimension inputs
  h.ev('openCropper(items[0])');
  h.$('cropWidth').value = '50';
  h.$('cropWidth').dispatchEvent(new h.window.Event('input', { bubbles: true }));
  const fromInput = h.ev('cropRectDraft');
  check('crop width input applies (intrinsic width 100)', Math.abs(fromInput.w - 0.5) < 1e-9, fromInput);
  h.$('cropCancel').click();
  check('cancel discards draft but keeps saved rect', h.$('cropper').classList.contains('hidden') && !!h.ev('items[0].cropRect'));

  // ---- drag/drop reorder ----
  const grid = h.$('grid');
  const cards = [...grid.children];
  const dataTransfer = { effectAllowed: '', setData() {}, dropEffect: '' };
  cards[0].dispatchEvent(new h.window.DragEvent('dragstart', { dataTransfer, bubbles: true }));
  const target = cards[2];
  target.getBoundingClientRect = () => ({ left: 0, width: 156, top: 0, height: 200, right: 156, bottom: 200 });
  target.dispatchEvent(new h.window.DragEvent('dragover', { dataTransfer, clientX: 10, bubbles: true })); // left half -> after target
  target.dispatchEvent(new h.window.DragEvent('drop', { dataTransfer, clientX: 10, bubbles: true }));
  cards[0].dispatchEvent(new h.window.DragEvent('dragend', { dataTransfer, bubbles: true }));
  const order = [...grid.children].map((n) => n.querySelector('.page-order').value);
  const uidOrder = h.ev(`[...document.getElementById('grid').children].map((n) => items.find((i) => i.el === n).uid)`);
  check('drag-drop reorders cards', JSON.stringify(uidOrder) === JSON.stringify([1, 2, 0]), uidOrder);
  check('drag-drop renumbers pdf order sequentially', JSON.stringify(order) === JSON.stringify(['1', '2', '3']), order);

  // ---- drag-to-group: drop on the center band of another card ----
  const dt2 = { effectAllowed: '', setData() {}, dropEffect: '' };
  const rect156 = () => ({ left: 0, width: 156, top: 0, height: 200, right: 156, bottom: 200 });
  // A) two ungrouped cards -> a new group of two, DOM order untouched
  cards[1].getBoundingClientRect = rect156;
  cards[0].dispatchEvent(new h.window.DragEvent('dragstart', { dataTransfer: dt2, bubbles: true }));
  cards[1].dispatchEvent(new h.window.DragEvent('dragover', { dataTransfer: dt2, clientX: 78, bubbles: true })); // band 0.5 -> group
  check('center-band dragover shows group hint', cards[1].classList.contains('group-drop-target') && h.ev('dragGroupDrop') === true);
  cards[1].dispatchEvent(new h.window.DragEvent('drop', { dataTransfer: dt2, clientX: 78, bubbles: true }));
  cards[0].dispatchEvent(new h.window.DragEvent('dragend', { dataTransfer: dt2, bubbles: true }));
  const gA = h.ev('items.map(i => i.pageGroup)');
  check('center drop groups two cards', gA[0] !== null && gA[0] === gA[1] && gA[2] === null, gA);
  check('group hint cleared after drop', !cards[1].classList.contains('group-drop-target') && h.ev('dragGroupDrop') === false);
  // 2.20: group members must be laid out adjacent (they share one PDF page); relative order of the rest is kept
  const orderA = h.ev(`[...document.getElementById('grid').children].map(n=>items.find(i=>i.el===n).uid)`);
  check('grouping lays group members adjacent', JSON.stringify(orderA) === JSON.stringify([1, 0, 2]), orderA);
  check('adjacent layout renumbers pdf order', JSON.stringify([...grid.children].map((n) => n.querySelector('.page-order').value)) === JSON.stringify(['1', '2', '3']));
  check('grouped cards keep persistent in-group class', cards[0].classList.contains('in-group') && cards[1].classList.contains('in-group') && !cards[2].classList.contains('in-group'));
  const outlineLayer = h.$('groupOutlineLayer');
  check('drag-group draws one shared outline box', !outlineLayer.classList.contains('hidden') &&
    outlineLayer.querySelectorAll('.group-outline').length === 1);

  // B) ungrouped card dropped onto a grouped card joins its group
  cards[0].getBoundingClientRect = rect156;
  cards[2].dispatchEvent(new h.window.DragEvent('dragstart', { dataTransfer: dt2, bubbles: true }));
  cards[0].dispatchEvent(new h.window.DragEvent('dragover', { dataTransfer: dt2, clientX: 78, bubbles: true }));
  cards[0].dispatchEvent(new h.window.DragEvent('drop', { dataTransfer: dt2, clientX: 78, bubbles: true }));
  cards[2].dispatchEvent(new h.window.DragEvent('dragend', { dataTransfer: dt2, bubbles: true }));
  const gB = h.ev('items.map(i => i.pageGroup)');
  check('drop onto grouped card joins the group', gB[0] === gB[1] && gB[1] === gB[2], gB);

  // C) dropping a card from the same group is a no-op
  const beforeC = h.ev('items.map(i => i.pageGroup)');
  cards[1].dispatchEvent(new h.window.DragEvent('dragstart', { dataTransfer: dt2, bubbles: true }));
  cards[0].dispatchEvent(new h.window.DragEvent('dragover', { dataTransfer: dt2, clientX: 78, bubbles: true }));
  cards[0].dispatchEvent(new h.window.DragEvent('drop', { dataTransfer: dt2, clientX: 78, bubbles: true }));
  cards[1].dispatchEvent(new h.window.DragEvent('dragend', { dataTransfer: dt2, bubbles: true }));
  check('same-group drop is a no-op', JSON.stringify(h.ev('items.map(i => i.pageGroup)')) === JSON.stringify(beforeC));

  // D) edge-band drop still reorders and never changes groups
  const beforeD = h.ev('items.map(i => i.pageGroup)');
  const target2 = cards[1];
  target2.getBoundingClientRect = rect156;
  cards[0].dispatchEvent(new h.window.DragEvent('dragstart', { dataTransfer: dt2, bubbles: true }));
  target2.dispatchEvent(new h.window.DragEvent('dragover', { dataTransfer: dt2, clientX: 8, bubbles: true })); // band ~0.05 -> reorder
  check('edge-band dragover does not arm group drop', h.ev('dragGroupDrop') === false && !target2.classList.contains('group-drop-target'));
  target2.dispatchEvent(new h.window.DragEvent('drop', { dataTransfer: dt2, clientX: 8, bubbles: true }));
  cards[0].dispatchEvent(new h.window.DragEvent('dragend', { dataTransfer: dt2, bubbles: true }));
  check('edge drop preserves groups', JSON.stringify(h.ev('items.map(i => i.pageGroup)')) === JSON.stringify(beforeD));

  // ---- output settings open/close ----
  const settings = h.$('outputSettings');
  settings.open = true;
  h.$('closeOutputSettings').click();
  check('output settings close button', settings.open === false);
  settings.open = true;
  h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('output settings escape closes', settings.open === false);

  // ---- hamburger top menu (profile + OCR) open/close ----
  const topMenu = h.$('topMenu');
  check('top hamburger menu exists', !!topMenu && topMenu.tagName === 'DETAILS');
  topMenu.open = true;
  h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('top menu escape closes', topMenu.open === false);
  topMenu.open = true;
  h.window.document.body.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  check('top menu outside click closes', topMenu.open === false);

  // ---- Enter key applies crop ----
  h.ev('openCropper(items[0])');
  h.ev('cropRectDraft = {x:0.2,y:0.2,w:0.2,h:0.2}');
  h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  check('enter applies crop and closes', h.$('cropper').classList.contains('hidden') &&
    Math.abs(h.ev('items[0].cropRect.w') - 0.2) < 1e-9);

  // ---- lightbox keyboard escape ----
  h.ev('openLightbox(items[1])');
  await sleep(20);
  h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('escape closes lightbox', h.$('lightbox').classList.contains('hidden'));

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL INTERACTION TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(2); });
