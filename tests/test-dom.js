// DOM-level integration test: loads viewer.html scripts in jsdom with mocked extension APIs.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '../src/viewer/viewer.html'), 'utf8')
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
window.document.execCommand = (command) => {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount || selection.isCollapsed) return true;
  const tag = { bold: 'strong', italic: 'em', underline: 'u', strikeThrough: 's' }[command];
  if (!tag) return true;
  const range = selection.getRangeAt(0), wrapper = window.document.createElement(tag);
  wrapper.appendChild(range.extractContents()); range.insertNode(wrapper);
  selection.removeAllRanges(); const next = window.document.createRange(); next.selectNodeContents(wrapper); selection.addRange(next);
  return true;
};

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
  runtime: { id: 'extid123', getURL: (p) => 'chrome-extension://extid123/' + p, onMessage: { addListener: (listener) => { window.__runtimeMessageListener = listener; } } },
  storage: { local: {
    get: async (key) => (typeof key === 'string' ? { [key]: storageMap.get(key) } : Object.fromEntries([...storageMap])),
    set: async (obj) => { Object.entries(obj).forEach(([k, v]) => storageMap.set(k, v)); },
    remove: async (key) => { storageMap.delete(key); }
  } },
  declarativeNetRequest: { updateSessionRules: async () => {} },
  tabs: {
    getCurrent: async () => ({ id: 17 }),
    create: async (options) => { window.__openedPdfImportUrl = options.url; return { id: 18 }; },
    update: async () => {}
  },
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

const scripts = ['../vendor/jspdf.umd.min.js', '../src/core/pdfbuilder.js', '../vendor/tesseract.min.js', '../src/core/ocr.js', '../src/core/typeset.js', '../src/core/translate.js', '../src/core/ai-translate.js', '../src/core/pdf-import-store.js', '../src/viewer/viewer.js', '../src/viewer/trans.js'];
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
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../manifest.json'), 'utf8'));
  check('manifest name and action title use PIC TO PDF', manifest.name === 'PIC TO PDF' &&
    manifest.action.default_title === 'PIC TO PDF');
  check('extension remains Manifest V3', manifest.manifest_version === 3);
  check('manifest and viewer version badge are synchronized at 2.63', manifest.version === '2.63' &&
    window.document.querySelector('.version-pill').textContent.includes('۲.۶۳'));
  const viewerCss = fs.readFileSync(path.join(__dirname, '../src/viewer/viewer.css'), 'utf8');
  check('topbar keeps the hamburger visible while the page scrolls',
    /\.topbar\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;/s.test(viewerCss));
  check('stylesheet has no literal newline escape that breaks a selector', !viewerCss.includes('\\n'));
  const hasZeroRadius = (block) => /border-radius:\s*0(?:\D|$)/.test(block);
  const thumbFrame = viewerCss.match(/(?:^|\n)\.tw\s*\{([^}]*)\}/);
  check('thumbnail frame does not round off image corners', !!thumbFrame && hasZeroRadius(thumbFrame[1]));
  const lightboxImage = viewerCss.match(/\.lbscroll img\s*\{([^}]*)\}/);
  const editorImage = viewerCss.match(/\.ed-stage img\s*\{([^}]*)\}/);
  check('large and editor previews keep square image corners',
    !!lightboxImage && !!editorImage && hasZeroRadius(lightboxImage[1]) && hasZeroRadius(editorImage[1]));
  check('PDF-to-image import opens the dedicated converter tab',
    !!window.document.getElementById('btnImportPdf') &&
    /زبانهٔ جدا/.test(window.document.getElementById('btnImportPdf').title));
  check('manifest icon files declared', [16, 32, 48, 128].every((s) => manifest.icons[String(s)] === `assets/icons/icon${s}.png`) &&
    manifest.action.default_icon['128'] === 'assets/icons/icon128.png');
  check('brand logo points at the new icon file',
    window.document.querySelector('.brand-logo img').getAttribute('src') === '../../assets/icons/icon128.png');
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
  check('OCR-only contrast control exists and defaults on', !!$('trContrast') && $('trContrast').checked &&
    /فقط برای OCR/.test($('trContrast').parentElement.textContent));
  check('OCR uses one local Tesseract page-segmentation method',
    !$('trOcrProfile') && /یک روش صفحه‌بندی/.test($('ocrMethodNote').textContent));
  check('optional AI settings stay collapsed to avoid clutter', $('aiSettings') && $('aiSettings').tagName === 'DETAILS' && !$('aiSettings').open);
  check('AI translation is opt-in and defaults off', $('trAiEnabled') && !$('trAiEnabled').checked);
  check('named multi-key controls stay inside the collapsed settings',
    $('aiProfileList') && $('trAiAddProfile') && $('aiSettings').contains($('aiProfileList')) &&
    $('aiSettings').contains($('trAiAddProfile')));
  await ev('aiSettingsReady');
  check('each API profile has a name, private key field, and its own connection test',
    $('aiProfileList').children.length === 1 &&
    $('aiProfileList').querySelector('input[type="text"]') &&
    $('aiProfileList').querySelector('input[type="password"]') &&
    $('aiProfileList').querySelector('.ai-profile-test'));
  check('provider selector offers Gemini, OpenAI, OpenRouter, and AvalAI',
    ['gemini', 'openai', 'openrouter', 'avalai'].every((id) => $('trAiProvider').querySelector(`option[value="${id}"]`)));
  check('editable Skill and reset action are available',
    $('aiSettings').contains($('trAiSkill')) && $('aiSettings').contains($('trAiSkillReset')));
  check('AI key help starts with the official Google AI Studio link',
    window.document.querySelector('#aiSettings a[href="https://aistudio.google.com/apikey"][rel="noopener noreferrer"]') !== null);
  $('trAiProvider').value = 'openrouter';
  $('trAiProvider').dispatchEvent(new window.Event('change', { bubbles: true }));
  check('switching provider updates the model and official key link',
    $('trAiModel').value === 'openai/gpt-4o-mini' && $('trAiKeyHelp').href === 'https://openrouter.ai/settings/keys');
  $('trAiProvider').value = 'avalai';
  $('trAiProvider').dispatchEvent(new window.Event('change', { bubbles: true }));
  check('AvalAI uses its own default model and documentation link',
    $('trAiModel').value === 'gpt-6-luna' && $('trAiKeyHelp').href === 'https://docs.avalai.ir/en/quickstart');
  $('trAiProvider').value = 'gemini';
  $('trAiProvider').dispatchEvent(new window.Event('change', { bubbles: true }));

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
  $('btnImportPdf').click();
  await sleep(20);
  check('PDF converter opens in a separate extension tab',
    /pdf-import\.html\?/.test(window.__openedPdfImportUrl || '') && /returnTab=17/.test(window.__openedPdfImportUrl || ''),
    window.__openedPdfImportUrl);
  ev('pendingPdfImportToken = null');
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
    OcrTools.ocrBitmap = async (bmp, worker, opts) => { window.__ocrCalls = (window.__ocrCalls || 0) + 1; window.__ocrPasses = opts.passes.slice(); return [{ text: 'Hello world from OCR', conf: 90, x0: 10, x1: 90, y0: 10, y1: 30 }]; };
    OcrTools.groupLines = (lines) => [
      { id: 1, enabled: true, bg: 'auto', tr: '', text: 'Hello', conf: 90, x0: 10, x1: 90, y0: 10, y1: 30, lineH: 16 },
      { id: 2, enabled: true, bg: 'auto', tr: '', text: 'uncertain', conf: 30, x0: 10, x1: 90, y0: 50, y1: 70, lineH: 16 },
      { id: 3, enabled: true, bg: 'auto', tr: '', text: 'NG BEYAYN®BIE', conf: 94, x0: 10, x1: 90, y0: 90, y1: 110, lineH: 16 }
    ];`);
  $('trOnlySel').checked = false;
  $('btnTranslate').click();
  check('translate dialog opens', !$('trDialog').classList.contains('hidden'));
  $('trStart').click();
  for (let i = 0; i < 80; i++) { await sleep(100); if (!ev('building')) break; }
  check('translate finished', !ev('building'));
  check('adaptive contrast pass is sent only through OCR processing', ev('window.__ocrPasses.includes("adaptive")'));
  check('one Tesseract OCR call per image uses the standard preprocessing path',
    ev('window.__ocrCalls === 3 && window.__ocrPasses.includes("gray") && window.__ocrPasses.includes("bubbles") && window.__ocrPasses.includes("adaptive")'));
  check('ocr data attached', items.some((it) => it.ocr && it.ocr.blocks.length), items.map((it) => !!(it.ocr && it.ocr.blocks.length)));
  const translated = items.find((it) => it.ocr && it.ocr.blocks.length);
  check('translation filled from mock fetch', translated && translated.ocr.blocks[0].tr === 'سلام', translated && translated.ocr.blocks[0].tr);
  check('single-pass path translates all extracted text, including low-confidence blocks',
    translated && translated.ocr.blocks[1].tr === 'سلام' && translated.ocr.blocks[1].text === 'uncertain');
  check('single-pass path translates the remaining extracted blocks too',
    translated && translated.ocr.blocks[2].tr === 'سلام' && translated.ocr.blocks[2].text === 'NG BEYAYN®BIE');
  check('edited image produced', !!translated.edited);

  ev('openEditor(items.find((it) => it.ocr && it.ocr.blocks.length))');
  check('editor opens', !$('editor').classList.contains('hidden'));
  const richEditor = window.document.querySelector('.blk-editor');
  check('Word-like contenteditable contains translated text', richEditor && richEditor.textContent.trim() === 'سلام', richEditor && richEditor.textContent);
  check('rich editor does not expose formatting marker syntax', richEditor && !richEditor.textContent.includes('**') && !richEditor.textContent.includes('[size=') && !richEditor.textContent.includes('[color='));

  const fmtRow = window.document.querySelector('.blk-format');
  check('rich-text toolbar rendered per block', !!fmtRow);
  const blk0 = translated.ocr.blocks[0];
  const alignSel = fmtRow.querySelector('.blk-align');
  const boldBtn = fmtRow.querySelector('.blk-bold');
  const italicBtn = fmtRow.querySelector('.blk-italic');
  const underBtn = fmtRow.querySelector('.blk-under');
  const sizeInput = fmtRow.querySelector('.blk-size');
  check('alignment starts at right', alignSel.value === 'right');
  check('toolbar has common Word-like controls', !!boldBtn && !!italicBtn && !!underBtn && !!fmtRow.querySelector('.blk-bullet') && !!fmtRow.querySelector('.blk-numbered'));
  alignSel.value = 'center'; alignSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('alignment selection updates block', blk0.align === 'center');

  // Rich formatting is represented as markup in the model, never as literal marker characters in the editor.
  richEditor.focus();
  const textNode = richEditor.firstChild;
  const range = window.document.createRange(); range.selectNodeContents(textNode);
  window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  boldBtn.click();
  check('bold toolbar applies real rich markup', /<strong>|<b>/i.test(blk0.richHtml) && blk0.tr === 'سلام', { html: blk0.richHtml, text: blk0.tr });
  check('canvas renderer receives bold styled words without markers', window.Typeset.richHtmlWords(blk0.richHtml).some((word) => word.bold && word.t === 'سلام'));
  const richParagraphs = window.Typeset.richHtmlWords('<div>سطر اول</div><div><u>سطر دوم</u></div>');
  check('rich-text renderer preserves paragraph breaks and underline styling', richParagraphs.some((word) => word.t === 'سطر' && word.lineBreakBefore && word.underline), richParagraphs);
  const splitWord = window.Typeset.richHtmlWords('hel<strong>lo</strong> there');
  check('formatting inside a word does not insert a fake space', splitWord.map((word) => word.t).join('') === 'hellothere' && splitWord[1].spaceBefore === false, splitWord);
  window.getSelection().collapseToEnd();
  check('rich markup remains hidden from visible text', !richEditor.textContent.includes('**') && !richEditor.textContent.includes('[size=') && !richEditor.textContent.includes('[color='));

  sizeInput.value = '40'; sizeInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('font-size control updates block default when no selection', blk0.size === 40);
  sizeInput.value = '9999'; sizeInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('font size is clamped to safe maximum', blk0.size === 160);
  sizeInput.value = ''; sizeInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('empty font-size restores automatic sizing', blk0.size === null);

  const rtlBtn = fmtRow.querySelector('.blk-dir-rtl');
  const ltrBtn = fmtRow.querySelector('.blk-dir-ltr');
  check('RTL and LTR controls are available', !!rtlBtn && !!ltrBtn);
  ltrBtn.click();
  check('LTR action updates block and both editor surfaces', blk0.dir === 'ltr' && richEditor.getAttribute('dir') === 'ltr' && window.document.querySelector('.ed-box-text').getAttribute('dir') === 'ltr');
  rtlBtn.click();
  check('RTL action restores direction', blk0.dir === 'rtl' && richEditor.getAttribute('dir') === 'rtl');

  const directEditor = window.document.querySelector('.ed-box-text');
  check('image overlay is directly editable', !!directEditor && directEditor.getAttribute('contenteditable') === 'true');
  directEditor.innerHTML = '<div>سطر یک</div><div>سطر دو</div>';
  directEditor.dispatchEvent(new window.Event('input', { bubbles: true }));
  check('paragraph breaks are retained in the translation model', blk0.tr === 'سطر یک\nسطر دو', blk0.tr);
  check('paragraphs render as forced line breaks', window.Typeset.richHtmlWords(blk0.richHtml).some((word) => word.t === 'سطر' && word.lineBreakBefore));
  directEditor.innerHTML = '<span>ترجمهٔ روی تصویر</span>';
  directEditor.dispatchEvent(new window.Event('input', { bubbles: true }));
  check('typing in image box updates translation and sidebar', blk0.tr === 'ترجمهٔ روی تصویر' && richEditor.textContent === 'ترجمهٔ روی تصویر', { text: blk0.tr, sidebar: richEditor.textContent });
  check('resizable overlay handles exist for each text box', window.document.querySelector('.ed-box-text').closest('.ed-box').querySelectorAll('.ed-resize').length === 8);
  await sleep(1000);
  check('edited image survives rich-text edits', !!translated.edited);

  await ev('closeEditor()');
  check('editor closes', $('editor').classList.contains('hidden'));

  blk0.tr = 'قبل **متن پررنگ** بعد'; delete blk0.richHtml;
  ev('openEditor(items.find((it) => it.ocr && it.ocr.blocks.length))');
  const migratedEditor = window.document.querySelector('.blk-editor');
  check('legacy marker translations open as editable formatted text', migratedEditor.textContent === 'قبل متن پررنگ بعد' && /<strong>|<b>/i.test(blk0.richHtml), { text: migratedEditor.textContent, html: blk0.richHtml });
  check('legacy syntax is removed from the editable value', !migratedEditor.textContent.includes('**'));
  await ev('closeEditor()');

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
