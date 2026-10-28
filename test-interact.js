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

  // 2.24: page numbers under the cards update live while dragging (before any drop)
  const dtLive = { effectAllowed: '', setData() {}, dropEffect: '' };
  cards[0].dispatchEvent(new h.window.DragEvent('dragstart', { dataTransfer: dtLive, bubbles: true }));
  check('grid enters live-order mode on dragstart', grid.classList.contains('order-live'));
  const liveTarget = cards[2];
  liveTarget.getBoundingClientRect = () => ({ left: 0, width: 156, top: 0, height: 200, right: 156, bottom: 200 });
  liveTarget.dispatchEvent(new h.window.DragEvent('dragover', { dataTransfer: dtLive, clientX: 10, bubbles: true }));
  const liveDomOrder = h.ev(`[...document.getElementById('grid').children].map(n=>items.find(i=>i.el===n).uid)`);
  check('dragover does not move DOM yet', JSON.stringify(liveDomOrder) === JSON.stringify([0, 1, 2]), liveDomOrder);
  const liveInputs = cards.map((c) => c.querySelector('.page-order').value);
  check('page numbers preview the tentative order live', JSON.stringify(liveInputs) === JSON.stringify(['3', '1', '2']), liveInputs);
  // abort without dropping: numbers return to the real grid order
  cards[0].dispatchEvent(new h.window.DragEvent('dragend', { dataTransfer: dtLive, bubbles: true }));
  check('live-order mode cleared on dragend', !grid.classList.contains('order-live'));
  check('numbers restored after a cancelled drag',
    JSON.stringify(cards.map((c) => c.querySelector('.page-order').value)) === JSON.stringify(['1', '2', '3']));

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

  // ---- 2.23: insertion marker animation for single-card reorder ----
  h.ev('items.forEach(i => i.pageGroup = null); cleanupPageGroups(); normalizeGroupLayout(); refreshAll()');
  const dt3 = { effectAllowed: '', setData() {}, dropEffect: '' };
  cards[0].dispatchEvent(new h.window.DragEvent('dragstart', { dataTransfer: dt3, bubbles: true }));
  cards[2].getBoundingClientRect = rect156;
  cards[2].dispatchEvent(new h.window.DragEvent('dragover', { dataTransfer: dt3, clientX: 10, bubbles: true })); // left half -> after
  check('edge dragover shows single insertion marker', cards[2].classList.contains('drag-insert-after') &&
    !cards[2].classList.contains('drag-insert-group'));
  check('single drag does not mark group moving', h.ev('draggedGroupItems') === null);
  cards[0].dispatchEvent(new h.window.DragEvent('dragend', { dataTransfer: dt3, bubbles: true }));
  check('insertion marker cleared on dragend', !cards[2].classList.contains('drag-insert-after') &&
    h.ev('insertMarkerEl') === null);

  // ---- 2.23: dragging one group member moves the whole block, with a distinct marker ----
  h.ev('items[0].pageGroup = 1; items[1].pageGroup = 1; items[2].pageGroup = null; cleanupPageGroups(); normalizeGroupLayout(); refreshAll()');
  const dt4 = { effectAllowed: '', setData() {}, dropEffect: '' };
  cards[0].dispatchEvent(new h.window.DragEvent('dragstart', { dataTransfer: dt4, bubbles: true }));
  check('group drag arms block move', h.ev('draggedGroupItems && draggedGroupItems.length') === 2);
  check('all group members get group-moving class', cards[0].classList.contains('group-moving') &&
    cards[1].classList.contains('group-moving') && !cards[2].classList.contains('group-moving'));
  check('grid gets the group color variable', /^#/.test(grid.style.getPropertyValue('--group-color')));
  cards[2].dispatchEvent(new h.window.DragEvent('dragover', { dataTransfer: dt4, clientX: 10, bubbles: true }));
  check('group reorder uses the distinct group marker', cards[2].classList.contains('drag-insert-after') &&
    cards[2].classList.contains('drag-insert-group'));
  // live preview shows the whole block's tentative numbering while DOM is untouched
  const groupDomBefore = h.ev(`[...document.getElementById('grid').children].map(n=>items.find(i=>i.el===n).uid)`);
  check('group dragover keeps DOM untouched', JSON.stringify(groupDomBefore) === JSON.stringify([1, 0, 2]), groupDomBefore);
  check('group block numbers preview live',
    JSON.stringify(cards.map((c) => c.querySelector('.page-order').value)) === JSON.stringify(['3', '2', '1']),
    cards.map((c) => c.querySelector('.page-order').value));
  cards[2].dispatchEvent(new h.window.DragEvent('drop', { dataTransfer: dt4, clientX: 10, bubbles: true }));
  cards[0].dispatchEvent(new h.window.DragEvent('dragend', { dataTransfer: dt4, bubbles: true }));
  const groupMoveOrder = h.ev(`[...document.getElementById('grid').children].map(n=>items.find(i=>i.el===n).uid)`);
  // internal order of the block is preserved ([1,0] was the current grid order); the block stays contiguous
  check('whole group block moves together', JSON.stringify(groupMoveOrder) === JSON.stringify([2, 1, 0]), groupMoveOrder);
  check('group stays intact after block move', h.ev('items[0].pageGroup') === h.ev('items[1].pageGroup') &&
    h.ev('items[2].pageGroup') === null);
  check('group-moving class and color var cleared after dragend',
    !cards[0].classList.contains('group-moving') && !cards[1].classList.contains('group-moving') &&
    grid.style.getPropertyValue('--group-color') === '');

  // ---- 2.23: each group gets its own distinguishable color ----
  h.ev('duplicateItem(items[2])');
  await sleep(40);
  h.ev('const g2 = nextPageGroupId++; items[2].pageGroup = g2; items[3].pageGroup = g2; cleanupPageGroups(); normalizeGroupLayout(); refreshAll()');
  const boxes = [...outlineLayer.querySelectorAll('.group-outline')];
  check('two groups render two outline boxes', boxes.length === 2, boxes.length);
  check('group outline colors differ', boxes[0].style.borderColor !== boxes[1].style.borderColor &&
    !!boxes[0].style.borderColor && !!boxes[1].style.borderColor);
  const badge0 = cards[0].querySelector('.page-group-badge');
  const badge2 = cards[2].querySelector('.page-group-badge');
  check('group badges carry distinct inline colors', !!badge0.style.background &&
    badge0.style.background !== badge2.style.background);
  const chips = [...h.$('groupList').querySelectorAll('.group-chip')];
  check('manager chips carry per-group color vars', chips.length === 2 &&
    /--gc:/.test(chips[0].getAttribute('style')) &&
    chips[0].style.getPropertyValue('--gc') !== chips[1].style.getPropertyValue('--gc'));
  h.ev('items.forEach(i => i.pageGroup = null); cleanupPageGroups(); normalizeGroupLayout(); refreshAll()');

  // ---- in-group reorder: edge drop on a same-group member moves only that card inside the block ----
  // start from a known grid order [0,1,2,3]; the duplicate card (uid 3) stays outside the group
  h.ev('[...items].sort((a,b)=>a.uid-b.uid).forEach(i => document.getElementById("grid").appendChild(i.el)); updatePdfOrderFromGrid()');
  h.ev('items[0].pageGroup = 1; items[1].pageGroup = 1; items[2].pageGroup = 1; cleanupPageGroups(); normalizeGroupLayout(); refreshAll()');
  const dt5 = { effectAllowed: '', setData() {}, dropEffect: '' };
  const groupBefore = h.ev('items.map(i => i.pageGroup)');
  // drag the first card to after the last member
  cards[0].getBoundingClientRect = rect156;
  cards[2].getBoundingClientRect = rect156;
  cards[0].dispatchEvent(new h.window.DragEvent('dragstart', { dataTransfer: dt5, bubbles: true }));
  cards[2].dispatchEvent(new h.window.DragEvent('dragover', { dataTransfer: dt5, clientX: 10, bubbles: true })); // left edge -> after
  check('in-group edge dragover uses a single (non-group) insertion marker',
    cards[2].classList.contains('drag-insert-after') && !cards[2].classList.contains('drag-insert-group'));
  const internalPreview = cards.map((c) => c.querySelector('.page-order').value);
  check('in-group drag previews tentative internal order live',
    JSON.stringify(internalPreview) === JSON.stringify(['3', '1', '2']), internalPreview);
  const domStillStable = h.ev(`[...document.getElementById('grid').children].map(n=>items.find(i=>i.el===n).uid)`);
  check('in-group dragover keeps DOM untouched until drop',
    JSON.stringify(domStillStable) === JSON.stringify([0, 1, 2, 3]), domStillStable);
  cards[2].dispatchEvent(new h.window.DragEvent('drop', { dataTransfer: dt5, clientX: 10, bubbles: true }));
  cards[0].dispatchEvent(new h.window.DragEvent('dragend', { dataTransfer: dt5, bubbles: true }));
  const internalOrder = h.ev(`[...document.getElementById('grid').children].map(n=>items.find(i=>i.el===n).uid)`);
  check('edge drop reorders within the group', JSON.stringify(internalOrder) === JSON.stringify([1, 2, 0, 3]), internalOrder);
  check('in-group reorder never changes membership',
    JSON.stringify(h.ev('items.map(i => i.pageGroup)')) === JSON.stringify(groupBefore));
  check('in-group reorder renumbers pdf order',
    JSON.stringify([...grid.children].map((n) => n.querySelector('.page-order').value)) === JSON.stringify(['1', '2', '3', '4']));
  check('group stays one contiguous block after internal reorder',
    outlineLayer.querySelectorAll('.group-outline').length === 1);

  // move the same card back before the first member via the right edge
  cards[1].getBoundingClientRect = rect156;
  cards[0].dispatchEvent(new h.window.DragEvent('dragstart', { dataTransfer: dt5, bubbles: true }));
  cards[1].dispatchEvent(new h.window.DragEvent('dragover', { dataTransfer: dt5, clientX: 150, bubbles: true })); // right edge -> before
  cards[1].dispatchEvent(new h.window.DragEvent('drop', { dataTransfer: dt5, clientX: 150, bubbles: true }));
  cards[0].dispatchEvent(new h.window.DragEvent('dragend', { dataTransfer: dt5, bubbles: true }));
  const restoredOrder = h.ev(`[...document.getElementById('grid').children].map(n=>items.find(i=>i.el===n).uid)`);
  check('before-edge drop moves the card to the start of the group',
    JSON.stringify(restoredOrder) === JSON.stringify([0, 1, 2, 3]), restoredOrder);

  // center-band drop on a same-group member is still a no-op
  cards[0].dispatchEvent(new h.window.DragEvent('dragstart', { dataTransfer: dt5, bubbles: true }));
  cards[1].dispatchEvent(new h.window.DragEvent('dragover', { dataTransfer: dt5, clientX: 78, bubbles: true }));
  cards[1].dispatchEvent(new h.window.DragEvent('drop', { dataTransfer: dt5, clientX: 78, bubbles: true }));
  cards[0].dispatchEvent(new h.window.DragEvent('dragend', { dataTransfer: dt5, bubbles: true }));
  check('center-band same-group drop stays a no-op',
    JSON.stringify(h.ev(`[...document.getElementById('grid').children].map(n=>items.find(i=>i.el===n).uid)`)) === JSON.stringify([0, 1, 2, 3]));
  h.ev('items.forEach(i => i.pageGroup = null); cleanupPageGroups(); normalizeGroupLayout(); refreshAll()');

  // ---- empty-area drop: drag a group member into grid whitespace to extract just that card ----
  const gcards = () => [...grid.children];
  const rectAt = (left) => ({ left, width: 156, top: 0, height: 200, right: left + 156, bottom: 200 });
  const resetGrid = () => h.ev('[...items].sort((a,b)=>a.uid-b.uid).forEach(i => document.getElementById("grid").appendChild(i.el)); updatePdfOrderFromGrid()');
  const pinRects = () => gcards().forEach((c, i) => { c.getBoundingClientRect = () => rectAt(i * 166); });
  resetGrid();
  h.ev('items[0].pageGroup = 1; items[1].pageGroup = 1; items[2].pageGroup = 1; cleanupPageGroups(); normalizeGroupLayout(); refreshAll()');
  pinRects();
  const dt6 = { effectAllowed: '', setData() {}, dropEffect: '' };
  gcards()[0].dispatchEvent(new h.window.DragEvent('dragstart', { dataTransfer: dt6, bubbles: true }));
  // dragover over the grid itself (whitespace past the last card); nearest anchor is card 3
  grid.dispatchEvent(new h.window.DragEvent('dragover', { dataTransfer: dt6, clientX: 600, clientY: 100, bubbles: true }));
  check('empty-area dragover marks the grid as an extract zone', grid.classList.contains('extract-zone'));
  check('empty-area dragover shows a single insertion marker on the anchor',
    gcards()[3].classList.contains('drag-insert-before') && !gcards()[3].classList.contains('drag-insert-group'));
  check('empty-area drag previews the extracted single-card order',
    JSON.stringify(gcards().map((c) => c.querySelector('.page-order').value)) === JSON.stringify(['3', '1', '2', '4']));
  check('empty-area dragover keeps DOM untouched',
    JSON.stringify(h.ev(`[...document.getElementById('grid').children].map(n=>items.find(i=>i.el===n).uid)`)) === JSON.stringify([0, 1, 2, 3]));
  grid.dispatchEvent(new h.window.DragEvent('drop', { dataTransfer: dt6, clientX: 600, clientY: 100, bubbles: true }));
  gcards()[0].dispatchEvent(new h.window.DragEvent('dragend', { dataTransfer: dt6, bubbles: true }));
  check('empty-area drop moves only the dragged card',
    JSON.stringify(h.ev(`[...document.getElementById('grid').children].map(n=>items.find(i=>i.el===n).uid)`)) === JSON.stringify([1, 2, 0, 3]));
  check('empty-area drop removes the card from its group',
    JSON.stringify(h.ev('items.map(i => i.pageGroup)')) === JSON.stringify([null, 1, 1, null]),
    h.ev('items.map(i => i.pageGroup)'));
  check('remaining group stays one contiguous outline box',
    outlineLayer.querySelectorAll('.group-outline').length === 1);
  check('extract-zone visual cleared after drop', !grid.classList.contains('extract-zone'));

  // a two-member group dissolves when one card is extracted
  resetGrid();
  h.ev('items.forEach(i => i.pageGroup = null); items[1].pageGroup = 2; items[2].pageGroup = 2; cleanupPageGroups(); normalizeGroupLayout(); refreshAll()');
  pinRects();
  gcards()[1].dispatchEvent(new h.window.DragEvent('dragstart', { dataTransfer: dt6, bubbles: true }));
  grid.dispatchEvent(new h.window.DragEvent('drop', { dataTransfer: dt6, clientX: 600, clientY: 100, bubbles: true }));
  gcards()[1].dispatchEvent(new h.window.DragEvent('dragend', { dataTransfer: dt6, bubbles: true }));
  check('extracting from a two-member group dissolves the group',
    h.ev('items.every(i => !i.pageGroup)') === true, h.ev('items.map(i => i.pageGroup)'));
  check('dissolved group leaves no outline box', outlineLayer.classList.contains('hidden') ||
    outlineLayer.querySelectorAll('.group-outline').length === 0);

  // ungrouped cards can also be reordered via an empty-area drop without touching membership
  resetGrid();
  pinRects();
  gcards()[3].dispatchEvent(new h.window.DragEvent('dragstart', { dataTransfer: dt6, bubbles: true }));
  grid.dispatchEvent(new h.window.DragEvent('drop', { dataTransfer: dt6, clientX: 50, clientY: 100, bubbles: true }));
  gcards()[3].dispatchEvent(new h.window.DragEvent('dragend', { dataTransfer: dt6, bubbles: true }));
  check('empty-area drop reorders an ungrouped card too',
    JSON.stringify(h.ev(`[...document.getElementById('grid').children].map(n=>items.find(i=>i.el===n).uid)`)) === JSON.stringify([0, 3, 1, 2]));
  h.ev('items.forEach(i => i.pageGroup = null); cleanupPageGroups(); normalizeGroupLayout(); refreshAll()');

  // ---- Word-like character styling: the block toolbar acts on the textarea selection (2.44/2.46) ----
  {
    const ta = h.window.document.createElement('textarea');
    ta.value = 'hello brave world';
    h.window.document.body.appendChild(ta);
    h.window.__wrapTa = ta;
    ta.focus();
    // wrap the selected word "brave" with bold markers
    ta.setSelectionRange(6, 11);
    h.ev(`wrapSelection(__wrapTa, '**', '**')`);
    check('inline wrap inserts bold markers around the selection', ta.value === 'hello **brave** world', ta.value);
    check('inline wrap keeps the inner text selected', ta.selectionStart === 8 && ta.selectionEnd === 13, [ta.selectionStart, ta.selectionEnd]);
    // pressing the same button again on the same selection removes the markers
    h.ev(`wrapSelection(__wrapTa, '**', '**')`);
    check('inline wrap toggles off when the marked selection is wrapped again', ta.value === 'hello brave world', ta.value);
    // no selection -> an empty marker pair is inserted with the caret inside
    ta.value = 'abc'; ta.setSelectionRange(1, 1);
    h.ev(`wrapSelection(__wrapTa, '__', '__')`);
    check('inline wrap with no selection inserts an empty pair', ta.value === 'a____bc', ta.value);
    check('caret lands inside the empty marker pair', ta.selectionStart === 3 && ta.selectionEnd === 3, [ta.selectionStart, ta.selectionEnd]);
    // italic and bold markers coexist on different words and survive the round trip
    ta.value = 'one two'; ta.setSelectionRange(0, 3);
    h.ev(`wrapSelection(__wrapTa, '*', '*')`);
    check('italic marker applied independently', ta.value === '*one* two', ta.value);
    ta.remove();
  }
  {
    // parameter tags: size wraps the selection, re-applying replaces the parameter; color can be unwrapped
    const ta = h.window.document.createElement('textarea');
    ta.value = 'hello world';
    h.window.document.body.appendChild(ta);
    h.window.__tagTa = ta;
    ta.setSelectionRange(6, 11);
    h.ev(`wrapTagSelection(__tagTa, 'size', '24')`);
    check('size tag wraps the selection', ta.value === 'hello [size=24]world[/size]', ta.value);
    h.ev(`wrapTagSelection(__tagTa, 'size', '30')`);
    check('re-applying size replaces the parameter in place', ta.value === 'hello [size=30]world[/size]', ta.value);
    h.ev(`wrapTagSelection(__tagTa, 'color', '#ff0000')`);
    check('color tag wraps the same selection inside the size tag',
      ta.value === 'hello [size=30][color=#ff0000]world[/color][/size]', ta.value);
    check('color auto unwrap removes only the color tag',
      h.ev(`unwrapTagSelection(__tagTa, 'color')`) === true &&
      ta.value === 'hello [size=30]world[/size]', ta.value);
    ta.remove();
  }
  // ---- OCR source text copy button inside the editor ----
  {
    let copied = '';
    h.window.navigator.clipboard = { writeText: async (t) => { copied = t; } };
    h.ev('items[0].ocr = { lang: "eng", blocks: [{ id: 1, text: "Recognizable english sentence", tr: "ترجمه", enabled: true, bg: "white", x0: 0, y0: 0, x1: 120, y1: 40, lineH: 16 }] }; openEditor(items[0])');
    const copyBtn = h.$('edList').querySelector('.blk-copy-orig');
    check('editor exposes an OCR copy button', !!copyBtn);
    check('copy button sits next to the English OCR text, not the block toolbar',
      !!copyBtn.closest('.blk-orig') && !copyBtn.closest('.blk-top') &&
      copyBtn.parentElement.querySelector('.blk-orig-text').textContent === 'Recognizable english sentence');
    copyBtn.click();
    await sleep(10);
    check('copy button puts the English OCR text on the clipboard', copied === 'Recognizable english sentence', copied);
    check('copy button shows the copied state', copyBtn.classList.contains('copied'));
    h.$('edClose').click();
  }

  {
    // the shared block toolbar drives both block-level (no selection) and inline (selection) styling
    h.ev('items[0].ocr = { lang: "eng", blocks: [{ id: 1, text: "hi", tr: "hello world", enabled: true, bg: "white", x0: 0, y0: 0, x1: 120, y1: 40, lineH: 16 }] }; openEditor(items[0])');
    const edList = h.$('edList');
    const edTa = edList.querySelector('textarea');
    const boldBtn = edList.querySelector('.blk-bold');
    const underBtn = edList.querySelector('.blk-under');
    check('separate inline row removed; only the block toolbar exists',
      !edList.querySelector('.blk-inline') && !!boldBtn && !!underBtn);
    // no selection: bold toggles the whole block flag
    edTa.setSelectionRange(0, 0);
    boldBtn.click();
    check('bold without selection toggles the block flag', h.ev('items[0].ocr.blocks[0].bold') === false);
    // with a selection: the same button inserts inline markers and leaves the block flag untouched
    edTa.setSelectionRange(6, 11);
    boldBtn.click();
    check('bold with selection inserts inline markers only',
      edTa.value === 'hello **world**' && h.ev('items[0].ocr.blocks[0].bold') === false, edTa.value);
    check('bold button shows active state for the marked selection', boldBtn.classList.contains('active'));
    // selecting everything and underlining applies underline to the whole line via markers
    edTa.setSelectionRange(0, edTa.value.length);
    underBtn.click();
    check('select-all underline marks the whole line', edTa.value === '__hello **world**__', edTa.value);
    h.$('edClose').click();
  }

  // ---- custom undo/redo for editor textareas (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y) ----
  {
    h.ev('items[0].ocr = { lang: "eng", blocks: [{ id: 1, text: "hi", tr: "", enabled: true, bg: "white", x0: 0, y0: 0, x1: 120, y1: 40, lineH: 16 }] }; openEditor(items[0])');
    const edList = h.$('edList');
    const ta = edList.querySelector('textarea');
    const type = (val) => { ta.value = val; ta.dispatchEvent(new h.window.Event('input', { bubbles: true })); };
    const press = (init) => {
      const evt = new h.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      ta.dispatchEvent(evt);
      return evt;
    };
    // two rapid edits coalesce into a single undo step
    type('hello'); type('hello world');
    check('typing updates the block model live', h.ev('items[0].ocr.blocks[0].tr') === 'hello world');
    await sleep(750); // past the coalesce window -> next edit starts a fresh undo step
    type('hello world!');
    const undoEvt = press({ key: 'z', ctrlKey: true });
    check('Ctrl+Z is intercepted (preventDefault) by the editor', undoEvt.defaultPrevented === true);
    check('Ctrl+Z restores the previous typing step', ta.value === 'hello world', ta.value);
    check('undo keeps the block model in sync', h.ev('items[0].ocr.blocks[0].tr') === 'hello world');
    press({ key: 'y', ctrlKey: true });
    check('Ctrl+Y redoes the undone step', ta.value === 'hello world!', ta.value);
    press({ key: 'z', ctrlKey: true });
    press({ key: 'z', ctrlKey: true, shiftKey: true });
    check('Ctrl+Shift+Z redoes too', ta.value === 'hello world!', ta.value);
    // formatting changes are discrete, individually undoable steps
    ta.setSelectionRange(0, 5);
    edList.querySelector('.blk-bold').click();
    check('bold inserts inline markers', ta.value === '**hello** world!', ta.value);
    press({ key: 'z', ctrlKey: true });
    check('Ctrl+Z removes the formatting markers as one step', ta.value === 'hello world!', ta.value);
    press({ key: 'z', ctrlKey: true, shiftKey: true });
    check('redo restores the formatting markers', ta.value === '**hello** world!', ta.value);
    // undo all the way to the original value is a safe no-op beyond the baseline
    press({ key: 'z', ctrlKey: true });
    press({ key: 'z', ctrlKey: true });
    press({ key: 'z', ctrlKey: true });
    check('undo at baseline never throws and stops at the initial value', ta.value === '', ta.value);
    h.$('edClose').click();
  }

  // ---- editor refresh gating: no re-render while a field is focused, flush on blur (2.45) ----
  {
    h.ev('items[0].ocr = { lang: "eng", blocks: [' +
      '{ id: 1, text: "a", tr: "one", enabled: true, bg: "white", x0: 0, y0: 0, x1: 80, y1: 40, lineH: 16 },' +
      '{ id: 2, text: "b", tr: "two", enabled: true, bg: "white", x0: 0, y0: 50, x1: 80, y1: 90, lineH: 16 }] };' +
      'openEditor(items[0])');
    h.ev('window.__applyCalls = 0; window.__origApplyEditor = applyEditor;' +
      'applyEditor = async function(){ window.__applyCalls++; return window.__origApplyEditor.apply(this, arguments); }');
    const edList2 = h.$('edList');
    const tas = [...edList2.querySelectorAll('textarea')];
    tas[0].focus();
    tas[0].value = 'edited while focused';
    tas[0].dispatchEvent(new h.window.Event('input', { bubbles: true }));
    await sleep(1000); // longer than the 900ms time trigger
    check('no re-render while the textarea stays focused', h.ev('window.__applyCalls') === 0, h.ev('window.__applyCalls'));
    // moving focus straight to another block's field also must not flush (user is still editing)
    tas[1].focus();
    await sleep(60);
    check('switching to another editor field keeps the render pending', h.ev('window.__applyCalls') === 0);
    // leaving the editor fields flushes immediately
    h.window.document.body.focus();
    tas[1].blur();
    await sleep(120);
    check('blur out of the editor flushes the pending render', h.ev('window.__applyCalls') === 1, h.ev('window.__applyCalls'));
    // without any focused field, the 900ms time trigger works as the fallback
    h.ev('window.__applyCalls = 0');
    tas[0].value = 'unfocused edit';
    tas[0].dispatchEvent(new h.window.Event('input', { bubbles: true }));
    await sleep(1000);
    check('time trigger renders when no editor field is focused', h.ev('window.__applyCalls') >= 1, h.ev('window.__applyCalls'));
    h.ev('applyEditor = window.__origApplyEditor');
    h.$('edClose').click();
  }

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
