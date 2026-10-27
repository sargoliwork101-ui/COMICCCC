// DOM-level integration test: loads viewer.html scripts in jsdom with mocked extension APIs.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, 'viewer.html'), 'utf8')
  .replace(/<script[\s\S]*?<\/script>/g, ''); // scripts evaluated manually in the window realm

const dom = new JSDOM(html, {
  url: 'https://example.com/viewer.html?job=testjob',
  pretendToBeVisual: true,
  runScripts: 'dangerously'
});
const { window } = dom;
const ctx = dom.getInternalVMContext();
const ev = (code) => vm.runInContext(code, ctx);

// jsdom does not implement innerText; map it to textContent for assertion purposes
Object.defineProperty(window.Element.prototype, 'innerText', {
  get() { return this.textContent; },
  set(v) { this.textContent = v; },
  configurable: true
});

// ---- minimal 1x1 PNG bytes ----
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfab440000000049454e44ae426082',
  'hex'
);

// ---- mocks ----
const storageMap = new Map();
storageMap.set('job_testjob', {
  urls: ['https://comic.test/a.png', 'https://comic.test/b.png', 'blob:https://comic.test/xyz'],
  name: 'comic.pdf', tabId: 7, pageUrl: 'https://comic.test/page', skippedInline: 0
});

window.chrome = {
  runtime: { id: 'extid123', getURL: (p) => 'chrome-extension://extid123/' + p },
  storage: { local: {
    get: async (key) => (typeof key === 'string' ? { [key]: storageMap.get(key) } : Object.fromEntries([...storageMap])),
    set: async (obj) => { Object.entries(obj).forEach(([k, v]) => storageMap.set(k, v)); },
    remove: async (key) => { storageMap.delete(key); }
  } },
  declarativeNetRequest: { updateSessionRules: async () => {} },
  tabs: { create: async () => ({}), update: async () => {} },
  scripting: { executeScript: async () => [{ result: { data: 'data:image/png;base64,' + PNG.toString('base64') } }] },
  downloads: { download: async () => 1 }
};
window.fetch = async (url) => ({
  ok: true,
  status: 200,
  blob: async () => new window.Blob([PNG], { type: 'image/png' }),
  json: async () => [[['سلام', 'hi']]]
});
window.URL.createObjectURL = () => 'blob:mock/' + Math.random().toString(36).slice(2);
window.URL.revokeObjectURL = () => {};
window.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
window.HTMLCanvasElement.prototype.getContext = function () {
  return new Proxy({}, { get: (t, p) => {
    if (p === 'measureText') return (s) => ({ width: String(s).length * 6 });
    if (p === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)) });
    return typeof p === 'string' ? () => {} : undefined;
  }, set: () => true });
};
window.HTMLCanvasElement.prototype.toBlob = function (cb) { cb(new window.Blob([PNG], { type: 'image/png' })); };
window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,' + PNG.toString('base64');
window.confirm = () => true;
window.alert = (m) => console.log('  [alert]', m);
window.navigator.clipboard = { write: async () => {} };
window.ClipboardItem = class { constructor(o) { this.o = o; } };
window.showDirectoryPicker = undefined; // force downloads path
window.scrollTo = () => {};
window.HTMLElement.prototype.scrollIntoView = () => {};
window.requestAnimationFrame = (cb) => setTimeout(cb, 0);

const scripts = ['jspdf.umd.min.js', 'pdfbuilder.js', 'tesseract.min.js', 'ocr.js', 'typeset.js', 'translate.js', 'viewer.js', 'trans.js'];
for (const f of scripts) {
  const code = fs.readFileSync(path.join(__dirname, f), 'utf8');
  try {
    vm.runInContext(code, ctx, { filename: f });
  } catch (e) {
    console.error('LOAD ERROR in', f, e);
    process.exit(1);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('PASS:', name);
  else { failures++; console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
const $ = (id) => window.document.getElementById(id);

(async () => {
  // meaningful seamless label replaces the old vague "صفحهٔ بلند"
  const seamlessLabel = window.document.querySelector('label[for="seamless"], #seamless').closest('label').textContent;
  check('seamless option labeled meaningfully', /همه تصاویر در یک صفحه/.test(seamlessLabel), seamlessLabel);

  // modernized header/footer shell keeps every functional id
  check('modern topbar present', !!window.document.querySelector('.topbar .brand-logo') &&
    !!window.document.querySelector('.brand-text h1') && !!window.document.querySelector('.version-pill'));
  // 2.24: rebranded to PIC TO PDF
  check('viewer title uses PIC TO PDF', /PIC TO PDF/.test(window.document.title), window.document.title);
  check('viewer brand h1 uses PIC TO PDF', window.document.querySelector('.brand-text h1').textContent.trim() === 'PIC TO PDF');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
  check('manifest name and action title use PIC TO PDF', manifest.name === 'PIC TO PDF' &&
    manifest.action.default_title === 'PIC TO PDF');
  check('manifest icon files declared', [16, 32, 48, 128].every((s) => manifest.icons[String(s)] === `icon${s}.png`) &&
    manifest.action.default_icon['128'] === 'icon128.png');
  check('brand logo points at the new icon file',
    window.document.querySelector('.brand-logo img').getAttribute('src') === 'icon128.png');
  check('footer grouped shell present', !!window.document.querySelector('.dock .dock-side') &&
    !!window.document.querySelector('.dock .dock-center') && !!window.document.querySelector('.dock .dock-actions'));
  for (const id of ['selCount', 'modePdf', 'modeImg', 'outputSettings', 'buildBtn', 'saveImgBtn']) {
    check(`footer id #${id} preserved`, !!window.document.getElementById(id));
  }

  // 2.20: profile + OCR controls live inside the header hamburger; group menu stays independent in the toolbar
  const topMenu = $('topMenu');
  check('hamburger top menu present in header', !!window.document.querySelector('.topbar #topMenu') && topMenu.tagName === 'DETAILS');
  for (const id of ['saveProfileBtn', 'restoreProfileBtn', 'deleteProfileBtn', 'profileStatus',
    'ocrEnabled', 'btnTranslate', 'btnTxt', 'btnRetry']) {
    check(`top menu hosts #${id}`, !!topMenu.contains($(id)));
  }
  check('group menu stays in toolbar, outside hamburger', !!window.document.querySelector('.toolbar #groupMenu') &&
    !topMenu.contains($('groupMenu')));

  // 2.21: ESC cancellation affordances exist in the shell
  const jobHint = $('jobHint');
  check('ESC hint exists inside result panel', !!jobHint && jobHint.closest('#result') &&
    jobHint.classList.contains('hidden') && /ESC/.test(jobHint.textContent));
  const loadingHint = window.document.querySelector('#loadingOverlay .loading-hint');
  check('loading overlay shows ESC cancel hint', !!loadingHint && /ESC/.test(loadingHint.textContent));
  check('translation stop button advertises ESC', /ESC/.test($('btnStopTr').textContent));
  check('toolbar hosts only the group menu now', window.document.querySelectorAll('.toolbar-menus details').length === 1 &&
    !!window.document.querySelector('.toolbar-menus #groupMenu'));

  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (!ev('loading')) break;
  }
  const items = ev('items');
  check('all 3 images loaded ok', items.length === 3 && items.every((it) => it.state === 'ok'), items.map((i) => i.state));
  check('cards rendered', $('grid').children.length === 3);
  check('summary shows 3 selected', /3/.test($('selCount').textContent), $('selCount').textContent);
  check('build button enabled', !$('buildBtn').disabled);
  check('retry hidden (no failures)', $('btnRetry').classList.contains('hidden'));
  // 2.25: visible retry-all button in the toolbar and a per-card retry button template
  check('toolbar retry-all button exists', !!$('btnRetryAll') && $('btnRetryAll').classList.contains('hidden'));
  const firstCard = $('grid').children[0];
  const cardRetry = firstCard.querySelector('.retry');
  check('each card carries a retry button', !!cardRetry && cardRetry.tagName === 'BUTTON');
  check('ok cards do not get the failed class (retry stays visually hidden)', !firstCard.classList.contains('failed'));

  $('btnNone').click();
  check('select none', items.every((it) => !it.selected) && $('buildBtn').disabled);
  $('btnAll').click();
  check('select all', items.every((it) => it.selected));
  $('btnInv').click();
  check('invert -> none selected', items.every((it) => !it.selected));
  $('btnAll').click();

  items[0].selected = true; items[1].selected = true; items[2].selected = false;
  ev('refreshAll()');
  $('btnGroupPage').click();
  check('group created', items[0].pageGroup === 1 && items[1].pageGroup === 1 && !items[2].pageGroup, items.map((i) => i.pageGroup));
  check('grouped cards carry persistent in-group class',
    items[0].el.classList.contains('in-group') && items[1].el.classList.contains('in-group') &&
    !items[2].el.classList.contains('in-group'));
  check('grouped cards are adjacent in the grid', (() => {
    const kids = [...$('grid').children];
    return kids.indexOf(items[0].el) + 1 === kids.indexOf(items[1].el);
  })());
  // 2.22: one shared outline box wraps the whole group instead of per-card dashed outlines
  const outlineLayer = $('groupOutlineLayer');
  check('outline layer lives inside the page wrap', !!outlineLayer && outlineLayer.closest('.wrap') &&
    outlineLayer.closest('.wrap') === window.document.querySelector('.wrap'));
  check('one group -> one shared outline box', !outlineLayer.classList.contains('hidden') &&
    outlineLayer.querySelectorAll('.group-outline').length === 1);
  check('outline box is tagged with the group id',
    outlineLayer.querySelector('.group-outline').dataset.group === String(items[0].pageGroup));
  $('btnUngroupPage').click();
  check('ungroup', items.every((it) => !it.pageGroup));
  check('in-group class removed after ungroup', items.every((it) => !it.el.classList.contains('in-group')));
  check('outline layer hidden and emptied after ungroup',
    outlineLayer.classList.contains('hidden') && outlineLayer.children.length === 0);

  const before = items.length;
  ev('duplicateItem(items[0])');
  check('duplicate added', items.length === before + 1 && items[items.length - 1].dupNo === 1);
  const dup = items[items.length - 1];
  ev(`deleteItem(items.find((x) => x.uid === ${dup.uid}))`);
  const itemsAfterDelete = ev('items'); // deleteItem reassigns the global items binding
  check('delete removed', itemsAfterDelete.length === before && $('grid').children.length === before);

  $('modeImg').click();
  check('img mode', ev('mode') === 'img' && !$('saveImgBtn').classList.contains('hidden') && $('buildBtn').classList.contains('hidden'));
  $('modePdf').click();

  ev('openCropper(items[0])');
  check('cropper opens', !$('cropper').classList.contains('hidden'));
  ev('cropRectDraft = {x:0.1,y:0.1,w:0.5,h:0.5}; paintCropSelection(cropRectDraft)');
  $('cropApply').click();
  check('crop applied', !!items[0].cropRect, items[0].cropRect);
  ev('openCropper(items[0])');
  $('cropReset').click();
  $('cropApply').click();
  check('crop reset', !items[0].cropRect);

  ev('openLightbox(items[0])');
  await sleep(20);
  check('lightbox opens', !$('lightbox').classList.contains('hidden'));
  $('lbCopy').click();
  await sleep(20);
  $('lbClose').click();
  check('lightbox closes', $('lightbox').classList.contains('hidden'));

  $('saveProfileBtn').click();
  await sleep(30);
  check('profile stored', storageMap.has(ev('pageProfileKey')));
  items[0].selected = false;
  $('restoreProfileBtn').click();
  await sleep(60);
  check('profile restored selection', items[0].selected === true);

  $('ocrEnabled').checked = false;
  $('ocrEnabled').dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(20);
  check('ocr off disables translate btn', $('btnTranslate').disabled);
  $('ocrEnabled').checked = true;
  $('ocrEnabled').dispatchEvent(new window.Event('change', { bubbles: true }));
  check('ocr on re-enables translate', !$('btnTranslate').disabled);

  ev(`OcrTools.createOcrWorker = async () => ({ recognize: async () => ({ data: { blocks: [] } }), setParameters: async () => {}, terminate: async () => {} });
    OcrTools.ocrBitmap = async () => [{ text: 'Hello', conf: 90, x0: 10, x1: 90, y0: 10, y1: 30 }];
    OcrTools.groupLines = (lines) => [{ id: 1, enabled: true, bg: 'auto', tr: '', text: 'Hello', x0: 10, x1: 90, y0: 10, y1: 30, lineH: 16 }];`);
  $('trOnlySel').checked = false;
  $('btnTranslate').click();
  check('translate dialog opens', !$('trDialog').classList.contains('hidden'));
  $('trStart').click();
  for (let i = 0; i < 80; i++) { await sleep(100); if (!ev('building')) break; }
  check('translate finished', !ev('building'));
  check('ocr data attached', items.some((it) => it.ocr && it.ocr.blocks.length), items.map((it) => !!(it.ocr && it.ocr.blocks.length)));
  const translated = items.find((it) => it.ocr && it.ocr.blocks.length);
  check('translation filled from mock fetch', translated && translated.ocr.blocks[0].tr === 'سلام', translated && translated.ocr.blocks[0].tr);
  check('edited image produced', !!translated.edited);

  ev('openEditor(items.find((it) => it.ocr && it.ocr.blocks.length))');
  check('editor opens', !$('editor').classList.contains('hidden'));
  const ta = window.document.querySelector('.blk textarea');
  check('editor textarea has translation', ta && ta.value === 'سلام', ta && ta.value);

  // 2.27: per-block formatting toolbar
  const fmtRow = window.document.querySelector('.blk-format');
  check('format toolbar rendered per block', !!fmtRow);
  const blk0 = translated.ocr.blocks[0];
  check('block normalized to right/bold defaults', blk0.align === 'right' && blk0.bold === true &&
    blk0.italic === false && blk0.underline === false && blk0.size === null, blk0);
  const alignSel = fmtRow.querySelector('.blk-align');
  const boldBtn = fmtRow.querySelector('.blk-bold');
  const italicBtn = fmtRow.querySelector('.blk-italic');
  const underBtn = fmtRow.querySelector('.blk-under');
  const sizeInput = fmtRow.querySelector('.blk-size');
  check('align select starts on right', alignSel.value === 'right');
  check('bold button shows active state', boldBtn.classList.contains('active'));
  boldBtn.click();
  check('bold toggle flips block and button', blk0.bold === false && !boldBtn.classList.contains('active'));
  italicBtn.click();
  check('italic toggle flips block and button', blk0.italic === true && italicBtn.classList.contains('active'));
  underBtn.click();
  check('underline toggle flips block and button', blk0.underline === true && underBtn.classList.contains('active'));
  alignSel.value = 'center';
  alignSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('align select updates block', blk0.align === 'center');
  check('size input blank means auto size', sizeInput.value === '');
  sizeInput.value = '40';
  sizeInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('manual size stored on block', blk0.size === 40 && sizeInput.value === '40');
  sizeInput.value = '9999';
  sizeInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('oversized font clamped to 160', blk0.size === 160 && sizeInput.value === '160');
  sizeInput.value = '';
  sizeInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('clearing size returns to auto (null)', blk0.size === null && sizeInput.value === '');
  await sleep(1000); // اجازه بده رندر debounceشدهٔ ویرایشگر کامل شود
  check('edited image survives formatting edits', !!translated.edited);

  // 2.28: جهت متن RTL/LTR، رنگ دستی و بازنشانی
  const rtlBtn = fmtRow.querySelector('.blk-dir-rtl');
  const ltrBtn = fmtRow.querySelector('.blk-dir-ltr');
  const colorInput = fmtRow.querySelector('.blk-color');
  const colorAutoBtn = fmtRow.querySelector('.blk-color-auto');
  const resetBtn = fmtRow.querySelector('.blk-reset');
  check('direction controls rendered', !!rtlBtn && !!ltrBtn);
  check('block defaults to rtl direction', blk0.dir === 'rtl' && rtlBtn.classList.contains('active'));
  check('textarea reflects rtl direction', ta.style.direction === 'rtl', ta.style.direction);
  ltrBtn.click();
  check('ltr toggle flips block, button and textarea', blk0.dir === 'ltr' &&
    ltrBtn.classList.contains('active') && !rtlBtn.classList.contains('active') && ta.style.direction === 'ltr');
  rtlBtn.click();
  check('rtl toggle restores direction', blk0.dir === 'rtl' && rtlBtn.classList.contains('active'));
  check('color starts in auto mode', blk0.color === null && colorAutoBtn.classList.contains('active') &&
    colorInput.classList.contains('is-auto'));
  colorInput.value = '#e11d48';
  colorInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  check('picking a color stores it and exits auto', blk0.color === '#e11d48' &&
    !colorAutoBtn.classList.contains('active') && !colorInput.classList.contains('is-auto'));
  colorAutoBtn.click();
  check('auto color button clears manual color', blk0.color === null && colorAutoBtn.classList.contains('active'));
  // چند تغییر بده و بعد بازنشانی کن؛ همه‌چیز باید به پیش‌فرض برگردد
  ltrBtn.click();
  alignSel.value = 'left';
  alignSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  italicBtn.click();
  sizeInput.value = '55';
  sizeInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  resetBtn.click();
  check('reset restores all formatting defaults', blk0.dir === 'rtl' && blk0.align === 'right' &&
    blk0.bold === true && blk0.italic === false && blk0.underline === false &&
    blk0.size === null && blk0.color === null,
    { dir: blk0.dir, align: blk0.align, bold: blk0.bold, italic: blk0.italic, under: blk0.underline, size: blk0.size, color: blk0.color });
  check('reset re-syncs the controls', rtlBtn.classList.contains('active') && boldBtn.classList.contains('active') &&
    !italicBtn.classList.contains('active') && alignSel.value === 'right' && sizeInput.value === '' &&
    colorAutoBtn.classList.contains('active') && ta.style.direction === 'rtl');
  await sleep(1000);
  check('edited image survives reset', !!translated.edited);

  await ev('closeEditor()');
  check('editor closes', $('editor').classList.contains('hidden'));

  check('txt button visible', !$('btnTxt').classList.contains('hidden'));
  $('btnTxt').click();
  await sleep(20);

  $('btnAll').click(); // re-select everything before building
  const addImageCalls = [];
  ctx.addImageCalls = addImageCalls;
  ctx.PNG_BYTES = PNG;
  ev(`window.jspdf = { jsPDF: class { addPage() {} addImage(...a) { addImageCalls.push(a); } output() { return { blob: () => new Blob([PNG_BYTES]) }; } } };`);
  $('buildBtn').click();
  for (let i = 0; i < 80; i++) { await sleep(100); if (!ev('building')) break; }
  check('pdf build finished', !ev('building'));
  check('pdf addImage called', addImageCalls.length >= 3, addImageCalls.length);
  check('download link shown', !$('downloadBtn').classList.contains('hidden'));

  $('modeImg').click();
  $('saveImgBtn').click();
  for (let i = 0; i < 80; i++) { await sleep(100); if (!ev('building')) break; }
  check('image save finished', !ev('building'));

  // 2.30: حذف دسته‌جمعی کارت‌های انتخاب‌شده
  {
    const beforeCount = ev('items').length;
    check('bulk delete button exists in toolbar', !!$('btnDeleteSel'));
    check('bulk delete enabled while cards are selected', !$('btnDeleteSel').disabled);
    $('btnNone').click();
    check('bulk delete disabled when nothing is selected', $('btnDeleteSel').disabled);
    // مسیر لغو تأیید: هیچ کارتی نباید حذف شود
    ev('items.forEach((it) => { if (it.state === "ok") it.selected = true; }); refreshAll()');
    let confirmMsg = '';
    window.confirm = (m) => { confirmMsg = m; return false; };
    $('btnDeleteSel').click();
    check('cancelled bulk delete keeps every card', ev('items').length === beforeCount);
    check('bulk confirm states how many images are removed', new RegExp(String(beforeCount)).test(confirmMsg), confirmMsg);
    // حذف واقعی فقط دو کارت انتخاب‌شده
    window.confirm = () => true;
    const keptUrl = ev('items[2].url');
    ev('items[0].selected = true; items[1].selected = true; items[2].selected = false; refreshAll()');
    $('btnDeleteSel').click();
    const after = ev('items');
    check('bulk delete removed exactly the selected cards', after.length === beforeCount - 2 &&
      after.every((it) => it.selected === false), after.map((it) => it.url));
    check('grid DOM matches the remaining items', window.document.querySelectorAll('#grid .item').length === after.length);
    check('unselected card survives the bulk delete', after.length === 1 && after[0].url === keptUrl);
    check('bulk delete disabled once nothing remains selected', $('btnDeleteSel').disabled);
    window.confirm = () => true;
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL DOM TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(2); });
