const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..', 'comic_studio', 'static');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: 'http://127.0.0.1:8765/', pretendToBeVisual: true, runScripts: 'dangerously' });
const { window } = dom;
const context = dom.getInternalVMContext();
const project = {
  id: 'project-ui', name: 'آزمایش', updatedAt: '', images: [{
    id: 'image-ui', name: 'page.png', file: 'page.png', width: 320, height: 200,
    order: 0, selected: true, groupId: null, crop: null, blocks: [], edited: false,
  }], settings: { output: {} },
};
const summary = { id: project.id, name: project.name, updatedAt: '', images: 1 };
const engine = { id: 'rapidocr-v6', name: 'RapidOCR', selectable: true, runtimeInstalled: true, languages: ['eng'], readyLanguages: ['eng'], description: '', family: '' };
const overlayProject = (text, translation) => ({
  ...project, settings: { output: {} }, images: [{ ...project.images[0], selected: true, edited: false, blocks: [{
    id: 1, text, tr: translation, richHtml: translation ? `<b>${translation}</b>` : '', enabled: true,
    bg: 'white', x0: 5, y0: 5, x1: 150, y1: 45, lineH: 40, dir: 'rtl', align: 'right',
  }] }],
});
const beacons = [];
let renderedBlocks = null;
let renderedUploads = 0;
const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => 'application/json' },
  json: async () => payload,
});
window.fetch = async (url, options = {}) => {
  const parsed = new URL(url, 'http://127.0.0.1:8765');
  const pathname = parsed.pathname;
  if (pathname === '/api/projects' && (!options.method || options.method === 'GET')) return jsonResponse([summary]);
  if (pathname === '/api/projects' && options.method === 'POST') return jsonResponse(project, 201);
  if (pathname === `/api/projects/${project.id}`) return jsonResponse(project);
  if (pathname === '/api/engines') return jsonResponse([engine]);
  if (pathname === '/api/ai-settings') return jsonResponse({ provider: 'free', base_url: '', model: '', hasApiKey: false });
  if (pathname === '/api/activity') return jsonResponse({ entries: [], next: 0 });
  if (pathname === '/api/session/heartbeat') return jsonResponse({ ok: true, active: 1 });
  if (pathname === `/api/projects/${project.id}/state`) return jsonResponse(JSON.parse(options.body).state);
  if (pathname === `/api/projects/${project.id}/ocr`) return jsonResponse(overlayProject('NEW OCR', ''));
  if (pathname === `/api/projects/${project.id}/translate`) return jsonResponse(overlayProject('NEW OCR', 'ترجمهٔ تازه'));
  if (pathname === `/api/projects/${project.id}/images/${project.images[0].id}/rendered`) { renderedUploads += 1; return jsonResponse({ ok: true }); }
  if (pathname === `/api/projects/${project.id}/images/${project.images[0].id}/content`) return { ok: true, blob: async () => new window.Blob() };
  throw new Error(`Unmocked request: ${options.method || 'GET'} ${url}`);
};
window.navigator.sendBeacon = (url, body) => { beacons.push({ url, body }); return true; };
window.confirm = () => true;
window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
window.cancelAnimationFrame = (id) => clearTimeout(id);
window.HTMLElement.prototype.scrollIntoView = () => {};
window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
window.HTMLDialogElement.prototype.close = function () { this.open = false; };
window.document.execCommand = () => true;
window.URL.createObjectURL = () => 'blob:ui-test';
window.URL.revokeObjectURL = () => {};
window.createImageBitmap = async () => ({ width: 320, height: 200, close() {} });
window.HTMLCanvasElement.prototype.getContext = () => ({});
window.HTMLElement.prototype.setPointerCapture = function (pointerId) { this._capturedPointerId = pointerId; };
window.HTMLElement.prototype.hasPointerCapture = function (pointerId) { return this._capturedPointerId === pointerId; };
window.HTMLElement.prototype.releasePointerCapture = function (pointerId) { if (this._capturedPointerId === pointerId) delete this._capturedPointerId; };
window.Typeset = {
  blockStyle(block) { return { dir: block.dir === 'ltr' ? 'ltr' : 'rtl', align: block.align || 'right', bold: true, italic: false, underline: false, size: 12, color: null }; },
  hasInlineMarks() { return false; },
  render(bitmap, blocks) {
    renderedBlocks = blocks;
    return { width: 320, height: 200, toBlob(callback) { callback(new window.Blob(['png'], { type: 'image/png' })); } };
  },
};

for (const file of ['groups.js', 'app.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
function check(name, condition) {
  if (condition) console.log(`PASS: ${name}`);
  else { failures += 1; console.error(`FAIL: ${name}`); }
}

(async () => {
  await sleep(60);
  const $ = (id) => window.document.getElementById(id);
  check('one image card is rendered', window.document.querySelectorAll('#grid .item').length === 1);
  check('image starts selected', $('grid').querySelector('.item').classList.contains('selected'));

  $('grid').querySelector('img').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('clicking the image deselects the card', !$('grid').querySelector('.item').classList.contains('selected'));
  check('selection summary follows image clicks', $('selectionSummary').textContent.includes('0 از 1'));

  $('grid').querySelector('img').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('clicking the image again selects the card', $('grid').querySelector('.item').classList.contains('selected'));

  $('grid').querySelector('.act button').click();
  check('eye button still opens preview instead of changing selection', $('previewDialog').open && $('grid').querySelector('.item').classList.contains('selected'));
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  check('Escape closes the preview dialog', !$('previewDialog').open);

  $('grid').querySelector('.tick').click();
  check('one checkbox click deselects the image', !$('grid').querySelector('.item').classList.contains('selected'));
  $('grid').querySelector('.tick').click();
  check('one checkbox click selects the image again', $('grid').querySelector('.item').classList.contains('selected'));

  for (let round = 0; round < 6; round += 1) {
    await vm.runInContext('saveProject()', context);
    const before = vm.runInContext('state.project.images[0].selected', context);
    $('grid').querySelector('.tick').click();
    const after = vm.runInContext('state.project.images[0].selected', context);
    check(`checkbox stays one-click after save ${round + 1}`, after === !before && $('grid').querySelector('.tick').checked === after && $('grid').querySelector('.item').classList.contains('selected') === after);
  }
  for (let round = 0; round < 2; round += 1) {
    await vm.runInContext('saveProject()', context);
    const before = vm.runInContext('state.project.images[0].selected', context);
    $('grid').querySelector('img').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    check(`image stays one-click after save ${round + 1}`, vm.runInContext('state.project.images[0].selected', context) === !before);
  }

  $('modelsBtn').click();
  check('models dialog opens', $('modelsDialog').open);
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  check('Escape closes the models dialog', !$('modelsDialog').open);
  for (const id of ['ocrDialog', 'aiDialog', 'exportDialog', 'cropDialog']) {
    vm.runInContext(`showDialog('${id}')`, context);
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    check(`Escape closes ${id}`, !$(id).open);
  }
  vm.runInContext("showDialog('editorDialog')", context);
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(0);
  check('Escape closes the editor dialog', !$('editorDialog').open);

  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  const unselectedRules = css.match(/\.item:not\(\.selected\) \.tw\{[^}]*\}/g) || [];
  check('unselected thumbnails are visibly gray without a bright override', unselectedRules.some((rule) => rule.includes('grayscale(')) && unselectedRules.every((rule) => !rule.includes('filter:none')));
  check('model cards are in one vertical column', /\.model-group-grid\{[^}]*grid-template-columns:minmax\(0,1fr\)/.test(css));
  check('dialog headers remain sticky', /\.dlg>\.dialog-head\{[^}]*position:sticky/.test(css));
  check('success activity keeps readable message text', /\.activity-line\.success\{color:var\(--text\)\}/.test(css));
  check('multiline OCR activity preserves line breaks', /\.activity-message\{[^}]*white-space:pre-wrap/.test(css));
  check('existing projects default to translation overlays', $('overlayMode').value === 'translation' && $('exportOverlayMode').value === 'translation');

  vm.runInContext(`state.project.images[0].blocks = [{ id: 1, text: 'HELLO WORLD', tr: 'سلام دنیا', richHtml: '<b>سلام دنیا</b>', enabled: true, bg: 'white', x0: 5, y0: 5, x1: 150, y1: 45, lineH: 40, dir: 'rtl', align: 'right' }]`, context);
  vm.runInContext("setOverlayMode('ocr', false)", context);
  check('OCR mode is synchronized between editor and export', $('overlayMode').value === 'ocr' && $('exportOverlayMode').value === 'ocr');
  await vm.runInContext('renderAndUpload(state.project.images[0])', context);
  check('OCR preview renders the recognized source text', renderedBlocks[0].tr === 'HELLO WORLD' && renderedBlocks[0]._plainText === true && renderedBlocks[0].richHtml === '');
  check('OCR preview does not overwrite the saved translation', vm.runInContext("state.project.images[0].blocks[0].tr === 'سلام دنیا'", context));
  vm.runInContext("setOverlayMode('translation', false)", context);
  await vm.runInContext('renderAndUpload(state.project.images[0])', context);
  check('translation mode restores translated preview text and formatting', renderedBlocks[0].tr === 'سلام دنیا' && renderedBlocks[0].richHtml === '<b>سلام دنیا</b>' && !renderedBlocks[0]._plainText);
  check('both overlay modes upload a rendered image', renderedUploads === 2);
  vm.runInContext("state.editorId = 'image-ui'; state.editorScale = 1; setOverlayMode('ocr', false); buildBlockList(); renderEditorBoxes()", context);
  const ocrOverlay = $('editorBoxes').querySelector('.editor-box-text');
  check('editor shows recognized OCR text directly on the image', ocrOverlay?.textContent === 'HELLO WORLD' && ocrOverlay?.dir === 'ltr');
  ocrOverlay.innerText = 'CORRECTED OCR';
  ocrOverlay.dispatchEvent(new window.Event('input', { bubbles: true }));
  check('editing the OCR overlay updates source text without changing translation', vm.runInContext("state.project.images[0].blocks[0].text === 'CORRECTED OCR' && state.project.images[0].blocks[0].tr === 'سلام دنیا'", context));
  check('OCR overlay editing stays synchronized with the source field', $('blockList').querySelector('textarea').value === 'CORRECTED OCR');
  vm.runInContext("setOverlayMode('translation', false); renderEditorBoxes()", context);
  check('editor selector restores the translated overlay', $('editorBoxes').querySelector('.editor-box-text')?.textContent === 'سلام دنیا');
  const editorBox = $('editorBoxes').querySelector('.editor-box');
  const moveHandle = editorBox.querySelector('[data-move]');
  check('editor box has a visible button for dragging', moveHandle?.tagName === 'BUTTON' && moveHandle.title.includes('جابه‌جایی'));
  const pointer = (type, x, y) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y }, pointerId: { value: 1 }, button: { value: 0 } });
    return event;
  };
  const geometry = () => vm.runInContext(`(() => { const b = state.project.images[0].blocks[0]; return { x0: b.tx0, y0: b.ty0, width: b.tx1 - b.tx0, height: b.ty1 - b.ty0 }; })()`, context);
  moveHandle.dispatchEvent(pointer('pointerdown', 100, 100));
  editorBox.dispatchEvent(pointer('pointermove', 120, 130));
  editorBox.dispatchEvent(pointer('pointerup', 120, 130));
  const afterHandle = geometry();
  check('dragging the visible handle moves without resizing', afterHandle.x0 === 25 && afterHandle.y0 === 35 && afterHandle.width === 145 && afterHandle.height === 40);
  editorBox.dispatchEvent(pointer('pointerdown', 25, 35));
  editorBox.dispatchEvent(pointer('pointermove', 35, 30));
  editorBox.dispatchEvent(pointer('pointerup', 35, 30));
  const afterBorder = geometry();
  check('dragging the box border also moves the whole box', afterBorder.x0 === 35 && afterBorder.y0 === 30 && afterBorder.width === 145 && afterBorder.height === 40);
  moveHandle.dispatchEvent(pointer('pointerdown', 100, 100));
  editorBox.dispatchEvent(pointer('pointermove', -900, -900));
  editorBox.dispatchEvent(pointer('pointerup', -900, -900));
  const atBounds = geometry();
  check('dragging beyond page bounds preserves box dimensions', atBounds.x0 === 0 && atBounds.y0 === 0 && atBounds.width === 145 && atBounds.height === 40);
  const beforeTextPointer = geometry();
  const translatedText = editorBox.querySelector('.editor-box-text');
  translatedText.dispatchEvent(pointer('pointerdown', 10, 10));
  editorBox.dispatchEvent(pointer('pointermove', 40, 40));
  editorBox.dispatchEvent(pointer('pointerup', 40, 40));
  const afterTextPointer = geometry();
  check('text editing pointer input does not accidentally move the box', JSON.stringify(afterTextPointer) === JSON.stringify(beforeTextPointer));
  const resizeHandle = editorBox.querySelector('[data-dir="se"]');
  resizeHandle.dispatchEvent(pointer('pointerdown', 145, 40));
  editorBox.dispatchEvent(pointer('pointermove', 165, 55));
  editorBox.dispatchEvent(pointer('pointerup', 165, 55));
  const afterResize = geometry();
  check('resize handles still work after adding box dragging', afterResize.x0 === 0 && afterResize.y0 === 0 && afterResize.width === 165 && afterResize.height === 55);
  vm.runInContext('state.editorId = null', context);
  await vm.runInContext('runOcr()', context);
  check('finishing OCR automatically selects OCR display mode', $('overlayMode').value === 'ocr' && $('exportOverlayMode').value === 'ocr');
  check('finishing OCR places the new recognized text on the image', renderedBlocks[0].tr === 'NEW OCR' && renderedBlocks[0]._plainText === true);
  await vm.runInContext('runTranslation()', context);
  check('finishing translation automatically selects translation display mode', $('overlayMode').value === 'translation' && $('exportOverlayMode').value === 'translation');
  check('finishing translation places translated text on the image', renderedBlocks[0].tr === 'ترجمهٔ تازه' && !renderedBlocks[0]._plainText);

  vm.runInContext("appendLocalActivity('در حال دانلود آزمایشی')", context);
  check('live activity is visible on the page', $('activityLog').textContent.includes('در حال دانلود آزمایشی'));
  check('live activity is mirrored in model dialog', $('modelActivityLog').textContent.includes('در حال دانلود آزمایشی'));

  window.dispatchEvent(new window.Event('pagehide'));
  check('closing a tab sends a close beacon', beacons.some((entry) => entry.url === '/api/session/close'));
  window.close();
  if (failures) process.exitCode = 1;
})().catch((error) => { console.error(error); window.close(); process.exitCode = 1; });
