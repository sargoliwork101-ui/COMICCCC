// Adversarial / edge-case tests for viewer flows.
const fs = require('fs');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfab440000000049454e44ae426082',
  'hex'
);

function makeHarness({ fetchImpl, jobUrls, aiSettings } = {}) {
  const html = fs.readFileSync(__dirname + '/../src/viewer/viewer.html', 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html, { url: 'https://example.com/viewer.html?job=testjob', pretendToBeVisual: true, runScripts: 'dangerously' });
  const { window } = dom;
  const ctx = dom.getInternalVMContext();
  const ev = (code) => vm.runInContext(code, ctx);
  Object.defineProperty(window.Element.prototype, 'innerText', {
    get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true
  });
  const storageMap = new Map();
  storageMap.set('job_testjob', {
    urls: jobUrls || ['https://comic.test/a.png', 'https://comic.test/b.png', 'https://comic.test/c.png', 'https://comic.test/d.png'],
    name: 'comic.pdf', tabId: 7, pageUrl: 'https://comic.test/page', skippedInline: 2
  });
  if (aiSettings) storageMap.set('gemini_translation_settings_v1', aiSettings);
  let scriptingCalls = 0;
  window.chrome = {
    runtime: { id: 'extid123', getURL: (p) => 'chrome-extension://extid123/' + p },
    storage: { local: {
      get: async (k) => ({ [k]: storageMap.get(k) }),
      set: async (o) => Object.entries(o).forEach(([k, v]) => storageMap.set(k, v)),
      remove: async (k) => storageMap.delete(k)
    } },
    declarativeNetRequest: { updateSessionRules: async () => {} },
    tabs: { create: async () => ({}), update: async () => {} },
    scripting: { executeScript: async () => { scriptingCalls++; return [{ result: { data: 'data:image/png;base64,' + PNG.toString('base64') } }]; } },
    downloads: { download: async () => 1 }
  };
  window.fetch = fetchImpl || (async () => ({ ok: true, status: 200, blob: async () => new window.Blob([PNG], { type: 'image/png' }), json: async () => [[['سلام', 'hi']]] }));
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
  window.ClipboardItem = class {};
  window.showDirectoryPicker = undefined;
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  for (const f of ['../vendor/jspdf.umd.min.js', '../src/core/pdfbuilder.js', '../vendor/tesseract.min.js', '../src/core/ocr.js', '../src/core/typeset.js', '../src/core/translate.js', '../src/core/ai-translate.js', '../src/viewer/viewer.js', '../src/viewer/trans.js']) {
    vm.runInContext(fs.readFileSync(__dirname + '/' + f, 'utf8'), ctx, { filename: f });
  }
  return { dom, window, ctx, ev, storageMap, get scriptingCalls() { return scriptingCalls; }, $: (id) => window.document.getElementById(id) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('PASS:', name);
  else { failures++; console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

(async () => {
  // ---------- 1. failed fetch + scripting fallback recovers ----------
  {
    const h = makeHarness({
      fetchImpl: async (url) => {
        if (String(url).includes('b.png')) {
          return { ok: false, status: 403, blob: async () => { throw new Error('no'); }, json: async () => ({}) };
        }
        return { ok: true, status: 200, blob: async () => new h.window.Blob([PNG], { type: 'image/png' }), json: async () => [[]] };
      }
    });
    for (let i = 0; i < 60; i++) { await sleep(80); if (!h.ev('loading')) break; }
    const items = h.ev('items');
    const failed = items.filter((it) => it.state === 'failed');
    check('one failed then recovered via page fallback', failed.length === 0, items.map((i) => i.state));
    check('scripting fallback used', h.scriptingCalls >= 1, h.scriptingCalls);
    check('load error notice shown for skipped inline', /۲|2/.test(h.$('loadErrors').textContent), h.$('loadErrors').textContent);
  }

  // ---------- 2. total failure -> failed card + retry recovers ----------
  {
    let failAll = true;
    const h = makeHarness({
      fetchImpl: async (url) => {
        if (failAll) throw new Error('network down');
        return { ok: true, status: 200, blob: async () => new h.window.Blob([PNG], { type: 'image/png' }), json: async () => [[]] };
      }
    });
    h.window.chrome.scripting.executeScript = async () => { throw new Error('blocked'); };
    for (let i = 0; i < 60; i++) { await sleep(80); if (!h.ev('loading')) break; }
    let items = h.ev('items');
    check('all failed when network down', items.every((it) => it.state === 'failed'), items.map((i) => i.state));
    check('retry button visible', !h.$('btnRetry').classList.contains('hidden'));
    check('toolbar retry-all button visible', !h.$('btnRetryAll').classList.contains('hidden'));
    check('failed cards not selected', items.every((it) => !it.selected));
    // 2.25: every failed card shows its own retry button
    const cardRetryButtons = [...h.$('grid').querySelectorAll('.item .retry')];
    check('one per-card retry button per card', cardRetryButtons.length === items.length);
    check('per-card retry shown on failed items', items.every((it) => it.el.classList.contains('failed')));

    // per-card retry: only the clicked card is retried; others stay failed
    h.window.fetch = async (url) => {
      if (String(url).includes('a.png')) {
        return { ok: true, status: 200, blob: async () => new h.window.Blob([PNG], { type: 'image/png' }), json: async () => [[]] };
      }
      throw new Error('still down');
    };
    cardRetryButtons[0].click();
    for (let i = 0; i < 60; i++) { await sleep(60); if (h.ev('items')[0].state !== 'loading') break; }
    items = h.ev('items');
    check('per-card retry recovers only that card', items[0].state === 'ok' &&
      items.slice(1).every((it) => it.state === 'failed'), items.map((i) => i.state));
    check('recovered card loses the failed class (retry hidden again)', !items[0].el.classList.contains('failed'));
    check('toolbar retry-all stays visible while failures remain', !h.$('btnRetryAll').classList.contains('hidden'));

    // toolbar retry-all recovers the rest
    failAll = false;
    h.window.fetch = async () => ({ ok: true, status: 200, blob: async () => new h.window.Blob([PNG], { type: 'image/png' }), json: async () => [[]] });
    h.$('btnRetryAll').click();
    for (let i = 0; i < 60; i++) { await sleep(80); if (!h.ev('loading')) break; }
    items = h.ev('items');
    check('retry recovers all', items.every((it) => it.state === 'ok'), items.map((i) => i.state));
    check('retry-all hidden after full recovery', h.$('btnRetryAll').classList.contains('hidden'));
  }

  // ---------- 2b. single-card retry: progress indicator + control lock while in flight ----------
  {
    const h = makeHarness({
      fetchImpl: async () => { throw new Error('network down'); }
    });
    h.window.chrome.scripting.executeScript = async () => { throw new Error('blocked'); };
    for (let i = 0; i < 60; i++) { await sleep(80); if (!h.ev('loading')) break; }
    let items = h.ev('items');
    check('2b: all cards failed first', items.every((it) => it.state === 'failed'), items.map((i) => i.state));
    const firstCard = items[0].el;
    check('2b: failed card has no spin before retry', !firstCard.querySelector('.spin'));

    // یک fetch معوق تا تلاش مجدد تکی را در حالت «در حال دریافت» نگه داریم
    let resolveFetch = null;
    h.window.fetch = () => new Promise((resolve) => {
      resolveFetch = () => resolve({
        ok: true, status: 200,
        blob: async () => new h.window.Blob([PNG], { type: 'image/png' }),
        json: async () => [[]]
      });
    });
    firstCard.querySelector('.retry').click();
    for (let i = 0; i < 60; i++) { await sleep(40); if (items[0].state === 'loading') break; }
    check('2b: retry flips the card back to loading', items[0].state === 'loading', items[0].state);
    check('2b: global loading flag armed during single retry', h.ev('loading') === true);
    check('2b: spin recreated inside .tw during retry', !!firstCard.querySelector('.tw .spin'));
    check('2b: card retry button disabled during retry', firstCard.querySelector('.retry').disabled === true);
    check('2b: card delete button disabled during retry', firstCard.querySelector('.delete').disabled === true);
    check('2b: toolbar retry-all hidden while a retry runs', h.$('btnRetryAll').classList.contains('hidden'));
    check('2b: build blocked while a retry runs', h.$('buildBtn').disabled === true);

    resolveFetch();
    for (let i = 0; i < 60; i++) { await sleep(60); if (items[0].state === 'ok') break; }
    items = h.ev('items');
    check('2b: retried card recovers', items[0].state === 'ok', items[0].state);
    check('2b: loading flag cleared after retry', h.ev('loading') === false);
    check('2b: spin removed after successful retry', !items[0].el.querySelector('.spin'));
    check('2b: other cards stay failed and still offer retry',
      items.slice(1).every((it) => it.state === 'failed' && !it.el.querySelector('.retry').disabled),
      items.map((i) => i.state));
  }

  // ---------- 2c. ESC cancels an in-flight single-card retry ----------
  {
    const h = makeHarness({
      fetchImpl: async () => { throw new Error('network down'); }
    });
    h.window.chrome.scripting.executeScript = async () => { throw new Error('blocked'); };
    for (let i = 0; i < 60; i++) { await sleep(80); if (!h.ev('loading')) break; }
    const items = h.ev('items');
    check('2c: all failed before retry', items.every((it) => it.state === 'failed'));
    // مثل بارگیری سراسری: abort سیگنال، fetch را با خطا رد می‌کند
    h.window.fetch = (url, opts) => new Promise((resolve, reject) => {
      if (opts && opts.signal) opts.signal.addEventListener('abort', () => reject(new Error('Aborted')));
    });
    items[0].el.querySelector('.retry').click();
    for (let i = 0; i < 60; i++) { await sleep(40); if (items[0].state === 'loading') break; }
    check('2c: retry started', items[0].state === 'loading' && h.ev('loading') === true);
    h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    for (let i = 0; i < 60; i++) { await sleep(40); if (!h.ev('loading')) break; }
    check('2c: loading flag cleared after ESC', h.ev('loading') === false);
    check('2c: abort controller released', h.ev('loadAbortController') === null);
    check('2c: card back to failed with cancel reason', items[0].state === 'failed' && /لغو/.test(items[0].error || ''), items[0].error);
    check('2c: spin removed again after cancel', !items[0].el.querySelector('.spin'));
    check('2c: retry offered again after cancel', items[0].el.querySelector('.retry').disabled === false);
  }

  // ---------- 3. non-image bytes -> failed ----------
  {
    const h = makeHarness({
      fetchImpl: async (url) => ({
        ok: true, status: 200,
        blob: async () => String(url).includes('a.png')
          ? new h.window.Blob([Buffer.from('this is definitely not an image')], { type: 'text/plain' })
          : new h.window.Blob([PNG], { type: 'image/png' }),
        json: async () => [[]]
      })
    });
    h.window.chrome.scripting.executeScript = async () => [{ result: { error: 'HTTP 500' } }];
    for (let i = 0; i < 60; i++) { await sleep(80); if (!h.ev('loading')) break; }
    const items = h.ev('items');
    check('non-image marked failed', items[0].state === 'failed' && items.slice(1).every((it) => it.state === 'ok'), items.map((i) => i.state));
    check('error message attached', /text|تصویر|HTTP/.test(items[0].error || ''), items[0].error);
  }

  // ---------- 4. two-per-page + seamless builds ----------
  {
    const h = makeHarness();
    for (let i = 0; i < 60; i++) { await sleep(80); if (!h.ev('loading')) break; }
    const calls = [];
    h.ctx.calls = calls; h.ctx.PNG_BYTES = PNG;
    h.ev(`window.jspdf={jsPDF:class{constructor(){}addPage(){}addImage(...a){calls.push(a)}output(){return{blob:()=>new Blob([PNG_BYTES])}}}}`);
    h.$('twoPerPage').checked = true;
    h.$('twoPerPage').dispatchEvent(new h.window.Event('change', { bubbles: true }));
    h.$('buildBtn').click();
    for (let i = 0; i < 80; i++) { await sleep(80); if (!h.ev('building')) break; }
    check('two-per-page: 4 images -> 2 pages', calls.length === 2, calls.length);
    // seamless
    h.$('twoPerPage').checked = false;
    h.$('seamless').checked = true;
    h.$('seamless').dispatchEvent(new h.window.Event('change', { bubbles: true }));
    calls.length = 0;
    h.$('buildBtn').click();
    for (let i = 0; i < 80; i++) { await sleep(80); if (!h.ev('building')) break; }
    check('seamless: all images on one page (1 addImage batch)', calls.length === 4, calls.length);
    check('seamless disables conflicting options', h.$('twoPerPage').disabled && h.$('uniformSize').disabled);
  }

  // ---------- 5. group renumber after member deletion ----------
  {
    const h = makeHarness();
    for (let i = 0; i < 60; i++) { await sleep(80); if (!h.ev('loading')) break; }
    const items = h.ev('items');
    h.ev('items[0].selected=true; items[1].selected=true; items[2].selected=false; items[3].selected=false; refreshAll()');
    h.$('btnGroupPage').click();
    h.ev('items[0].selected=false; items[1].selected=false; items[2].selected=true; items[3].selected=true; refreshAll()');
    h.$('btnGroupPage').click();
    let g = h.ev('items.map(i=>i.pageGroup)');
    check('two groups created (internal ids)', JSON.stringify(g) === JSON.stringify([1, 1, 2, 2]), g);
    // delete one member of group 1 -> it dissolves (singleton); internal id 2 is kept,
    // but the shared display mapping must still show a continuous number ("گروه ۱") on cards and in the list
    h.ev('deleteItem(items[0])');
    g = h.ev('items.map(i=>i.pageGroup)');
    check('internal group id stays stable after deletion', g.length === 3 && JSON.stringify(g) === JSON.stringify([null, 2, 2]), g);
    const badges = [...h.$('grid').querySelectorAll('.page-group-badge:not(.hidden)')].map((n) => n.textContent.trim());
    check('display label is continuous (گروه 1)', badges.length === 2 && badges.every((t) => /^گروه 1/.test(t)), badges);
    const chipLabels = [...h.$('groupList').querySelectorAll('.group-select')].map((n) => n.textContent.trim());
    check('group manager shows continuous label too', chipLabels.length === 1 && /^گروه 1/.test(chipLabels[0]), chipLabels);
    // one shared outline box per surviving group
    const boxes = [...h.$('groupOutlineLayer').querySelectorAll('.group-outline')];
    check('one outline box per group', boxes.length === 1 && boxes[0].dataset.group === '2', boxes.map((b) => b.dataset.group));
    // deleting the other group removes all boxes
    h.ev('deleteItem(items.find(i=>i.pageGroup===2))');
    check('outline layer empties when no groups remain',
      h.$('groupOutlineLayer').classList.contains('hidden') && h.$('groupOutlineLayer').children.length === 0);
  }

  // ---------- 5b. group editor: add/remove members and cancel ----------
  {
    const h = makeHarness();
    for (let i = 0; i < 60; i++) { await sleep(80); if (!h.ev('loading')) break; }
    h.ev('items[0].selected=true; items[1].selected=true; items[2].selected=false; items[3].selected=false; refreshAll()');
    h.$('btnGroupPage').click();
    check('group created', h.ev('items[0].pageGroup') === 1 && h.ev('items[1].pageGroup') === 1);
    // enter edit mode via the manager's edit button
    h.$('groupList').querySelector('.group-edit').click();
    check('edit mode active', h.ev('editingPageGroupId') === 1 && !h.$('btnCancelGroupEdit').classList.contains('hidden'));
    check('edit mode disables global select buttons', h.$('btnAll').disabled && h.$('btnTranslate').disabled);
    // select a third card and save
    h.ev('items[2].selected = true; refreshAll()');
    h.$('btnGroupPage').click();
    check('edit saved with new member', h.ev('items.filter(i=>i.pageGroup===1).length') === 3);
    check('edit mode exits after save', h.ev('editingPageGroupId') === null && h.$('btnCancelGroupEdit').classList.contains('hidden'));
    // cancel restores the previous selection snapshot
    h.$('groupList').querySelector('.group-edit').click();
    const beforeCancel = h.ev('items.map(i=>i.selected)');
    h.ev('items[0].selected = false; refreshAll()');
    h.$('btnCancelGroupEdit').click();
    check('cancel restores selection snapshot', JSON.stringify(h.ev('items.map(i=>i.selected)')) === JSON.stringify(beforeCancel));
  }

  // ---------- 6. manual pdfOrder sorting ----------
  {
    const h = makeHarness();
    for (let i = 0; i < 60; i++) { await sleep(80); if (!h.ev('loading')) break; }
    const grid = h.$('grid');
    const input0 = grid.children[0].querySelector('.page-order');
    input0.value = '9';
    input0.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    const order = [...grid.children].map((n) => n.querySelector('.page-order').value);
    check('manual order moves card to end', order[order.length - 1] === '9' && order[0] === '2', order);
  }

  // ---------- 7. translation cancel ----------
  {
    const h = makeHarness();
    for (let i = 0; i < 60; i++) { await sleep(80); if (!h.ev('loading')) break; }
    h.ev(`OcrTools.createOcrWorker=async()=>({recognize:async()=>new Promise(r=>setTimeout(()=>r({data:{blocks:[]}}),300)),setParameters:async()=>{},terminate:async()=>{}});
    OcrTools.ocrBitmap=async()=>[{text:'Hello',conf:90,x0:10,x1:90,y0:10,y1:30}];
    OcrTools.groupLines=()=>[{id:1,enabled:true,bg:'auto',tr:'',text:'Hello',x0:10,x1:90,y0:10,y1:30,lineH:16}];`);
    h.$('trOnlySel').checked = false;
    h.$('btnTranslate').click();
    h.$('trStart').click();
    h.$('btnStopTr').click();
    for (let i = 0; i < 80; i++) { await sleep(80); if (!h.ev('building')) break; }
    check('cancel ends run', !h.ev('building'));
    check('stop button hidden again', h.$('btnStopTr').classList.contains('hidden'));
    check('cancel mentioned in status', /متوقف/.test(h.$('statusText').textContent), h.$('statusText').textContent);
  }

  // ---------- 8. translation network failure ----------
  {
    const h = makeHarness({
      fetchImpl: async (url) => String(url).includes('translate') || String(url).includes('mymemory')
        ? { ok: false, status: 500, json: async () => ({}) }
        : { ok: true, status: 200, blob: async () => new h.window.Blob([PNG], { type: 'image/png' }), json: async () => ({}) }
    });
    for (let i = 0; i < 60; i++) { await sleep(80); if (!h.ev('loading')) break; }
    h.ev(`OcrTools.createOcrWorker=async()=>({recognize:async()=>({data:{blocks:[]}}),setParameters:async()=>{},terminate:async()=>{}});
    OcrTools.ocrBitmap=async()=>[{text:'Hello',conf:90,x0:10,x1:90,y0:10,y1:30}];
    OcrTools.groupLines=()=>[{id:1,enabled:true,bg:'auto',tr:'',text:'Hello',x0:10,x1:90,y0:10,y1:30,lineH:16}];`);
    h.$('trOnlySel').checked = false;
    h.$('btnTranslate').click();
    h.$('trStart').click();
    for (let i = 0; i < 100; i++) { await sleep(100); if (!h.ev('building')) break; }
    check('network failure reported', /اینترنت|ترجمه/.test(h.$('statusText').textContent), h.$('statusText').textContent);
    const items = h.ev('items');
    check('ocr still attached when translate fails', items.every((it) => it.ocr && it.ocr.blocks.length === 1));
  }

  // ---------- 9. profile with duplicate survives roundtrip ----------
  {
    const h = makeHarness();
    for (let i = 0; i < 60; i++) { await sleep(80); if (!h.ev('loading')) break; }
    h.ev('duplicateItem(items[1])');
    await sleep(50);
    h.ev('items[0].selected=false; refreshAll()');
    h.$('saveProfileBtn').click();
    await sleep(40);
    // mutate live state then restore
    h.ev('items.forEach(i=>i.selected=false); refreshAll()');
    h.$('restoreProfileBtn').click();
    await sleep(80);
    const items = h.ev('items');
    check('duplicate restored from profile', items.filter((it) => it.dupNo).length === 1);
    check('selection restored', items[0].selected === false && items[1].selected === true);
    check('total count stable', items.length === 5, items.length);
  }

  // ---------- 10. editor revert clears edited image ----------
  {
    const h = makeHarness();
    for (let i = 0; i < 60; i++) { await sleep(80); if (!h.ev('loading')) break; }
    h.ev(`OcrTools.createOcrWorker=async()=>({recognize:async()=>({data:{blocks:[]}}),setParameters:async()=>{},terminate:async()=>{}});
    OcrTools.ocrBitmap=async()=>[{text:'Hello',conf:90,x0:10,x1:90,y0:10,y1:30}];
    OcrTools.groupLines=()=>[{id:1,enabled:true,bg:'auto',tr:'سلام',text:'Hello',x0:10,x1:90,y0:10,y1:30,lineH:16}];`);
    h.$('btnTranslate').click(); h.$('trStart').click();
    for (let i = 0; i < 80; i++) { await sleep(80); if (!h.ev('building')) break; }
    const target = h.ev('items.find(i=>i.ocr)');
    check('edited before revert', !!target.edited);
    h.ev('openEditor(items.find(i=>i.ocr))');
    h.$('edRevert').click();
    await sleep(60);
    check('revert clears edited blob', !target.edited);
    check('blocks disabled after revert', target.ocr.blocks.every((b) => !b.enabled));
    await h.ev('closeEditor()');
  }

  // ---------- 10b. profile restores crops and redraws every thumbnail ----------
  {
    const h = makeHarness();
    for (let i = 0; i < 60; i++) { await sleep(80); if (!h.ev('loading')) break; }
    // spy on drawThumb through the shared realm
    h.ctx.__drawLog = [];
    h.ev(`const __origDrawThumb = drawThumb; drawThumb = (it) => { globalThis.__drawLog.push(it.uid); return __origDrawThumb(it); };`);
    h.ev('items[0].cropRect = {x:0.1,y:0.1,w:0.5,h:0.5}; items[0].cropCache = null; refreshAll()');
    h.$('pdfName').value = 'special-name';
    h.$('folderName').value = 'special-folder';
    h.$('outFmt').value = 'png';
    h.$('saveProfileBtn').click();
    await sleep(40);
    // wipe local state, then restore
    h.ev('items[0].cropRect = null; items[0].cropCache = null; refreshAll()');
    h.ctx.__drawLog.length = 0;
    h.$('restoreProfileBtn').click();
    await sleep(80);
    const items = h.ev('items');
    check('crop restored on base item', JSON.stringify(items[0].cropRect) === JSON.stringify({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }), items[0].cropRect);
    check('cropped badge visible after restore', items[0].el.classList.contains('cropped'));
    check('base item thumbnail redrawn after restore', h.ctx.__drawLog.includes(items[0].uid), h.ctx.__drawLog);
    check('file name restored', h.$('pdfName').value === 'special-name', h.$('pdfName').value);
    check('folder and format restored', h.$('folderName').value === 'special-folder' && h.$('outFmt').value === 'png');
    // stored profile really contains the crop and the output settings
    const profile = h.storageMap.get(h.ev('pageProfileKey'));
    check('profile payload keeps crop', !!profile.items.find((e) => e.sourceIndex === 0).cropRect);
    check('profile payload keeps output settings', profile.settings.pdfName === 'special-name' && profile.settings.outFmt === 'png' && profile.settings.folderName === 'special-folder');
  }

  // ---------- 11. translate with no eligible images closes the dialog ----------
  {
    const h = makeHarness();
    for (let i = 0; i < 60; i++) { await sleep(80); if (!h.ev('loading')) break; }
    h.ev('items.forEach(i => i.selected = false); refreshAll()');
    h.$('trOnlySel').checked = true;
    h.$('btnTranslate').click();
    check('empty-run dialog was open', !h.$('trDialog').classList.contains('hidden'));
    h.$('trStart').click();
    await sleep(40);
    check('empty-run closes dialog', h.$('trDialog').classList.contains('hidden'));
    check('empty-run does not lock the UI', !h.ev('building'));
    check('empty-run explains why', /تصویری برای ترجمه/.test(h.$('statusText').textContent), h.$('statusText').textContent);
  }

  // ---------- 12. ESC cancels the initial image load ----------
  {
    const h = makeHarness({
      // honors AbortSignal like the real fetch does
      fetchImpl: (url, opts) => new Promise((res, rej) => {
        if (opts && opts.signal) opts.signal.addEventListener('abort', () => rej(new Error('Aborted')));
      })
    });
    await sleep(80);
    check('load in progress before ESC', h.ev('loading') === true);
    h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check('ESC arms the cancel flag', h.ev('jobCancelRequested') === true &&
      h.ev('loadAbortController && loadAbortController.signal.aborted') === true);
    for (let i = 0; i < 60; i++) { await sleep(60); if (!h.ev('loading')) break; }
    check('loading stops after ESC', h.ev('loading') === false);
    check('loading overlay hidden after cancel', h.$('loadingOverlay').classList.contains('hidden'));
    const items = h.ev('items');
    check('cancelled cards marked failed', items.every((it) => it.state === 'failed'), items.map((i) => i.state));
    check('cancel reason recorded on cards', items.every((it) => /لغو/.test(it.error || '')), items.map((i) => i.error));
    check('retry offered after cancelled load', !h.$('btnRetry').classList.contains('hidden'));
    check('no scripting fallback after abort', h.scriptingCalls === 0, h.scriptingCalls);
  }

  // ---------- 13. ESC mid PDF build cancels; a later rerun resets and succeeds ----------
  {
    const h = makeHarness();
    for (let i = 0; i < 60; i++) { await sleep(80); if (!h.ev('loading')) break; }
    const calls = [];
    h.ctx.calls = calls; h.ctx.PNG_BYTES = PNG;
    h.ev(`window.jspdf={jsPDF:class{constructor(){}addPage(){}addImage(...a){calls.push(a)}output(){return{blob:()=>new Blob([PNG_BYTES])}}}}`);
    h.ev(`globalThis.__origPrepare = prepare;
globalThis.__prepCount = 0;
prepare = async (it, r) => {
  globalThis.__prepCount++;
  if (globalThis.__prepCount === 2) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return globalThis.__origPrepare(it, r);
};`);
    h.$('buildBtn').click();
    for (let i = 0; i < 80; i++) { await sleep(60); if (!h.ev('building')) break; }
    check('pdf build cancelled by ESC', /لغو/.test(h.$('statusText').textContent), h.$('statusText').textContent);
    check('build stopped before all images', h.ev('globalThis.__prepCount') === 2, h.ev('globalThis.__prepCount'));
    check('no download offered for cancelled build', h.$('downloadBtn').classList.contains('hidden'));
    // rerun: flag resets and the full build completes
    h.ev('prepare = globalThis.__origPrepare;');
    h.$('buildBtn').click();
    for (let i = 0; i < 80; i++) { await sleep(60); if (!h.ev('building')) break; }
    check('rerun resets cancel flag', h.ev('jobCancelRequested') === false);
    check('rerun completes with download', !h.$('downloadBtn').classList.contains('hidden'));
    check('success status after rerun', /آماده شد/.test(h.$('statusText').textContent), h.$('statusText').textContent);
  }

  // ---------- 14. ESC during image save stops the loop ----------
  {
    const h = makeHarness();
    for (let i = 0; i < 60; i++) { await sleep(80); if (!h.ev('loading')) break; }
    h.window.chrome.downloads.download = async () => {
      h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return 1;
    };
    h.$('modeImg').click();
    h.$('saveImgBtn').click();
    for (let i = 0; i < 80; i++) { await sleep(60); if (!h.ev('building')) break; }
    check('image save cancelled by ESC', /لغو/.test(h.$('statusText').textContent), h.$('statusText').textContent);
    check('only the first image was saved', h.$('sPages').textContent.trim() === '1', h.$('sPages').textContent);
  }

  // ---------- 15. ESC closes an open menu first instead of cancelling work ----------
  {
    const h = makeHarness();
    for (let i = 0; i < 60; i++) { await sleep(80); if (!h.ev('loading')) break; }
    h.$('topMenu').open = true;
    h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check('ESC closes the hamburger menu', h.$('topMenu').open === false);
    check('menu ESC does not arm cancellation', h.ev('jobCancelRequested') === false);
    h.$('groupMenu').open = true;
    h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check('ESC also closes the group menu', h.$('groupMenu').open === false);
  }

  // ---------- 16. ESC cancels a running translation like the stop button ----------
  {
    const h = makeHarness();
    for (let i = 0; i < 60; i++) { await sleep(80); if (!h.ev('loading')) break; }
    h.ev(`OcrTools.createOcrWorker=async()=>({recognize:async()=>new Promise(r=>setTimeout(()=>r({data:{blocks:[]}}),300)),setParameters:async()=>{},terminate:async()=>{}});
    OcrTools.ocrBitmap=async()=>[{text:'Hello',conf:90,x0:10,x1:90,y0:10,y1:30}];
    OcrTools.groupLines=()=>[{id:1,enabled:true,bg:'auto',tr:'',text:'Hello',x0:10,x1:90,y0:10,y1:30,lineH:16}];`);
    h.$('trOnlySel').checked = false;
    h.$('btnTranslate').click();
    h.$('trStart').click();
    h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check('ESC arms translation cancel', h.ev('TR.cancel') === true && h.ev('jobCancelRequested') === true);
    for (let i = 0; i < 80; i++) { await sleep(60); if (!h.ev('building')) break; }
    check('translation ends after ESC', !h.ev('building'));
    check('stop button hidden again', h.$('btnStopTr').classList.contains('hidden'));
    check('cancel mentioned in status', /متوقف/.test(h.$('statusText').textContent), h.$('statusText').textContent);
    check('job hint hidden when work ends', h.$('jobHint').classList.contains('hidden'));
  }

  // ---------- 17. closing the editor mid-render must not alert or lose the render ----------
  {
    const h = makeHarness();
    for (let i = 0; i < 60; i++) { await sleep(80); if (!h.ev('loading')) break; }
    h.ev(`OcrTools.createOcrWorker=async()=>({recognize:async()=>({data:{blocks:[]}}),setParameters:async()=>{},terminate:async()=>{}});
    OcrTools.ocrBitmap=async()=>[{text:'Hello',conf:90,x0:10,x1:90,y0:10,y1:30}];
    OcrTools.groupLines=()=>[{id:1,enabled:true,bg:'auto',tr:'سلام',text:'Hello',x0:10,x1:90,y0:10,y1:30,lineH:16}];`);
    h.$('btnTranslate').click(); h.$('trStart').click();
    for (let i = 0; i < 80; i++) { await sleep(80); if (!h.ev('building')) break; }
    let alertCount = 0;
    h.window.alert = (m) => { alertCount++; console.log('  [unexpected alert]', m); };
    const target = h.ev('items.find(i=>i.ocr)');
    h.ev('openEditor(items.find(i=>i.ocr))');
    // رندر را پشت یک دروازه نگه می‌داریم تا ویرایشگر دقیقاً وسط await بسته شود
    h.ev(`globalThis.__origRE = renderEdited;
    globalThis.__gate = new Promise((resolve) => { globalThis.__releaseGate = resolve; });
    renderEdited = async (it) => { await globalThis.__gate; return globalThis.__origRE(it); };
    applyEditor();`);
    await sleep(60);
    check('apply was in flight when editor closed', h.ev('edBusy') === true && h.ev('EDI') !== null);
    await h.ev('closeEditor()');
    check('editor closed while render pending', h.ev('EDI') === null && h.$('editor').classList.contains('hidden'));
    h.ev('globalThis.__releaseGate()');
    for (let i = 0; i < 30; i++) { await sleep(60); if (h.ev('edBusy') === false) break; }
    check('no spurious error alert after mid-render close', alertCount === 0, alertCount);
    check('in-flight render still updated the item blob', !!target.edited);
    check('busy flag released after render settles', h.ev('edBusy') === false);
    h.ev('renderEdited = globalThis.__origRE;');
  }

  // ---------- 18. duplicate numbers stay unique after an older copy is removed ----------
  {
    const h = makeHarness();
    for (let i = 0; i < 60; i++) { await sleep(80); if (!h.ev('loading')) break; }
    h.ev('duplicateItem(items[0]); duplicateItem(items[0]);');
    h.ev('removeItemsFromGrid([items.find((it) => it.dupNo === 1)]); duplicateItem(items[0]);');
    const numbers = h.ev('items.filter((it) => it.i === 0 && it.dupNo).map((it) => it.dupNo).sort((a, b) => a - b)');
    check('duplicate numbers are not reused after deletion', JSON.stringify(numbers) === '[2,3]', numbers);
  }

  // ---------- 19. imported PDF source indices do not collide after deleting a card ----------
  {
    const h = makeHarness();
    for (let i = 0; i < 60; i++) { await sleep(80); if (!h.ev('loading')) break; }
    h.ev('removeItemsFromGrid([items[1]])');
    h.ctx.PDFImportStore = {
      getSession: async () => ({ token: 'import-test', status: 'complete', fileName: 'book.pdf', count: 2 }),
      getPages: async () => [1, 2].map((pageNumber) => ({
        token: 'import-test', pageNumber, fileName: 'book.pdf', width: 1, height: 1,
        blob: new h.window.Blob([PNG], { type: 'image/png' })
      })),
      deleteSession: async () => {}
    };
    h.ev('pendingPdfImportToken = "import-test"');
    await h.ev('receiveImportedPdf("import-test")');
    const indices = h.ev('items.map((it) => it.i)');
    check('PDF import keeps every source index unique', new Set(indices).size === indices.length, indices);
    check('PDF import continues after the greatest existing index',
      JSON.stringify(indices) === '[0,2,3,4,5]', indices);
  }

  // ---------- 20. extreme PDF scaling can never produce a zero-height slicing step ----------
  {
    const h = makeHarness();
    for (let i = 0; i < 60; i++) { await sleep(80); if (!h.ev('loading')) break; }
    const originalBitmap = h.window.createImageBitmap;
    try {
      h.window.createImageBitmap = async () => ({ width: 1, height: 2, close() {} });
      const segments = await h.ev(`prepare({
        i: 99, uid: 999, blob: new Blob(['x']), w: 1, h: 2,
        info: { fmt: 'PNG', ok: false, w: 1, h: 2 }, edited: null, cropRect: null
      }, PdfBuilder.SAFE_PT + 1)`);
      check('extreme PDF scaling still slices with a one-pixel minimum step',
        segments.length === 2 && segments.every((segment) => segment.h === 1), segments.map((segment) => segment.h));
    } finally {
      h.window.createImageBitmap = originalBitmap;
    }
  }

  // ---------- 21. closing a dirty editor during a render flushes the latest edit ----------
  {
    const h = makeHarness();
    for (let i = 0; i < 60; i++) { await sleep(80); if (!h.ev('loading')) break; }
    h.ev(`items[0].ocr = { lang: 'eng', blocks: [{
      id: 1, enabled: true, bg: 'auto', tr: 'first', text: 'Hello',
      x0: 0, x1: 10, y0: 0, y1: 10, lineH: 10
    }] };
    openEditor(items[0]);
    globalThis.__renderedTexts = [];
    globalThis.__gate = new Promise((resolve) => { globalThis.__releaseGate = resolve; });
    renderEdited = async (it) => {
      const text = it.ocr.blocks[0].tr;
      globalThis.__renderedTexts.push(text);
      if (globalThis.__renderedTexts.length === 1) await globalThis.__gate;
    };
    applyEditor();`);
    await sleep(60);
    check('dirty-close test begins with a render in flight', h.ev('edBusy') === true);
    h.ev(`items[0].ocr.blocks[0].tr = 'latest';
    edDirty = true;
    globalThis.__closeWithDirty = closeEditor();`);
    await sleep(30);
    h.ev('globalThis.__releaseGate()');
    await h.ev('globalThis.__closeWithDirty');
    const rendered = h.ev('globalThis.__renderedTexts');
    check('queued close renders the latest edit instead of losing its item',
      JSON.stringify(rendered) === '["first","latest"]', rendered);
    check('dirty close finishes and releases the editor', h.ev('EDI') === null && h.ev('edBusy') === false);
  }

  // ---------- 22. PDF conversion avoids unnecessary lossy recompression ----------
  {
    const h = makeHarness();
    for (let i = 0; i < 60; i++) { await sleep(80); if (!h.ev('loading')) break; }
    const encodes = [];
    const originalToDataURL = h.window.HTMLCanvasElement.prototype.toDataURL;
    try {
      h.window.HTMLCanvasElement.prototype.toDataURL = function (type, quality) {
        encodes.push({ type, quality });
        return originalToDataURL.call(this, type, quality);
      };
      const webp = await h.ev(`prepare({
        i: 100, uid: 100, blob: new Blob(['x']), w: 1, h: 1,
        info: { fmt: 'WEBP', ok: false, w: 1, h: 1 }, edited: null, cropRect: null
      }, 1)`);
      const jpeg = await h.ev(`prepare({
        i: 101, uid: 101, blob: new Blob(['x']), w: 1, h: 1,
        info: { fmt: 'JPEG', ok: false, w: 1, h: 1 }, edited: null, cropRect: null
      }, 1)`);
      check('non-JPEG source is converted to lossless PNG for PDF', webp[0].fmt === 'PNG', webp[0]);
      check('JPEG slicing uses maximum encoder quality',
        jpeg[0].fmt === 'JPEG' && encodes.some((entry) => entry.type === 'image/jpeg' && entry.quality === 1), encodes);
    } finally {
      h.window.HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
    }
  }

  // ---------- 23. thumbnails contain every source corner at high quality ----------
  {
    const h = makeHarness();
    for (let i = 0; i < 60; i++) { await sleep(80); if (!h.ev('loading')) break; }
    let options = null, drawing = null, closed = false, bitmap = null;
    let nativeSize = { width: 240, height: 3000 };
    const originalBitmap = h.window.createImageBitmap;
    try {
      h.window.createImageBitmap = async (blob, opts) => {
        options = opts;
        const width = opts && opts.resizeWidth ? opts.resizeWidth : nativeSize.width;
        const height = opts && opts.resizeHeight
          ? opts.resizeHeight : Math.max(1, Math.round(nativeSize.height * width / nativeSize.width));
        bitmap = { width, height, close() { closed = true; } };
        return bitmap;
      };
      const canvas = h.ev('items[0]').el.querySelector('canvas');
      canvas.getContext = () => ({
        fillStyle: '', fillRect() {}, imageSmoothingEnabled: false, imageSmoothingQuality: 'low',
        drawImage(...args) { drawing = args; }
      });
      const capture = async (width, height) => {
        nativeSize = { width, height };
        options = null; drawing = null; closed = false; bitmap = null;
        await h.ev(`items[0].w = ${width}; items[0].h = ${height}; items[0].info = {fmt:'PNG',w:${width},h:${height},ok:false}`);
        await h.ev('drawThumb(items[0])');
        return { options, drawing, closed, bitmap };
      };
      const checkWholeImage = (label, result) => {
        const { drawing: args, bitmap: bmp } = result;
        const scale = bmp ? Math.min(240 / bmp.width, 320 / bmp.height) : 0;
        check(`${label}: complete source rectangle is drawn`, args && args.length === 9 &&
          args[1] === 0 && args[2] === 0 && args[3] === bmp.width && args[4] === bmp.height, args);
        check(`${label}: destination stays inside the card without cropping`, args &&
          args[5] >= 0 && args[6] >= 0 && args[5] + args[7] <= 240 && args[6] + args[8] <= 320 &&
          Math.abs(args[7] - bmp.width * scale) < 0.001 && Math.abs(args[8] - bmp.height * scale) < 0.001, args);
        check(`${label}: bitmap is released`, result.closed === true);
      };
      const tall = await capture(240, 3000);
      check('thumbnail uses high-quality resizing', tall.options && tall.options.resizeQuality === 'high', tall.options);
      checkWholeImage('tall thumbnail', tall);
      check('tall thumbnail fits the complete height', tall.drawing && tall.drawing[8] === 320, tall.drawing);
      const wide = await capture(3000, 240);
      checkWholeImage('wide thumbnail', wide);
      check('wide thumbnail fits the complete width', wide.drawing && wide.drawing[7] === 240, wide.drawing);
    } finally {
      h.window.createImageBitmap = originalBitmap;
    }
  }

  // ---------- 24. optional whole-context AI translation and fallback ----------
  const prepareAiTranslationHarness = async () => {
    const h = makeHarness({ jobUrls: ['https://comic.test/a.png', 'https://comic.test/b.png'] });
    for (let i = 0; i < 60; i++) { await sleep(80); if (!h.ev('loading')) break; }
    await h.ev('aiSettingsReady');
    h.ev(`OcrTools.createOcrWorker=async()=>({recognize:async()=>({data:{blocks:[]}}),setParameters:async()=>{},terminate:async()=>{}});
      OcrTools.ocrBitmap=async()=>[{text:'Hello',conf:90,x0:10,x1:90,y0:10,y1:30}];
      OcrTools.groupLines=()=>[{id:1,enabled:true,bg:'auto',tr:'',text:'Hello',x0:10,x1:90,y0:10,y1:30,lineH:16}];
      window.__aiIds=(options)=>{const body=JSON.parse(options.body);const text=body.contents?body.contents[0].parts[0].text:body.messages[1].content;
        return [...text.matchAll(/^\\[(p[0-9]+-b[0-9]+)\\]/gm)].map(m=>m[1]);};
      window.__aiOk=(translations)=>({ok:true,status:200,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify(translations)}]}}]})});
      window.__openAiOk=(translations)=>({ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify({translations})}}]})});`);
    h.$('trOnlySel').checked = false;
    return h;
  };
  {
    const h = await prepareAiTranslationHarness();
    h.ev(`window.__aiCalls=0; window.__freeCalls=0;
      AiTranslateTools.translateWithFailover=async()=>{window.__aiCalls++;return {translations:new Map()};};
      TranslateTools.translate=async()=>{window.__freeCalls++;return {text:'ترجمه معمولی',ok:true};};`);
    h.$('trAiEnabled').checked = false;
    await h.ev('runTranslate()');
    check('AI opt-in off spends zero Gemini requests', h.ev('window.__aiCalls') === 0);
    check('AI opt-in off preserves the established translation path', h.ev('window.__freeCalls') === 2,
      h.ev('window.__freeCalls'));
  }
  {
    const h = await prepareAiTranslationHarness();
    h.ev(`window.__aiCalls=0; window.__freeCalls=0; window.__aiEntryCount=0;
      window.fetch=async(url,options)=>{window.__aiCalls++;const ids=window.__aiIds(options);window.__aiEntryCount=ids.length;
        return window.__aiOk(ids.map(id=>({id,translation:'ترجمه طبیعی '+id})));};
      TranslateTools.translate=async()=>{window.__freeCalls++;return {text:'ترجمه معمولی',ok:true};};`);
    h.$('trAiEnabled').checked = true;
    h.ev(`aiProfiles=[makeAiProfile('شخصی','test-local-key')];renderAiProfiles();`);
    h.$('trAiSkill').value = 'لحن صمیمی و طبیعی';
    await h.ev('runTranslate()');
    check('AI opt-in sends all selected pages in one request', h.ev('window.__aiCalls') === 1 && h.ev('window.__aiEntryCount') === 2,
      { calls: h.ev('window.__aiCalls'), entries: h.ev('window.__aiEntryCount') });
    check('successful AI batch never spends the old per-bubble fallback', h.ev('window.__freeCalls') === 0);
    check('AI translations render back onto every image', h.ev('items.every(it=>it.edited && it.ocr.blocks[0].tr.startsWith("ترجمه طبیعی"))'));
    check('AI settings stay local for the next use', h.storageMap.get('gemini_translation_settings_v1') &&
      h.storageMap.get('gemini_translation_settings_v1').providers.gemini.profiles[0].apiKey === 'test-local-key' &&
      h.storageMap.get('gemini_translation_settings_v1').providers.gemini.profiles[0].name === 'شخصی' &&
      h.storageMap.get('gemini_translation_settings_v1').skill === 'لحن صمیمی و طبیعی');
    check('API key never enters the page profile', !JSON.stringify(h.ev('collectPageProfile()')).includes('test-local-key'));
    check('completed status safely names the successful profile', /شخصی/.test(h.$('statusText').textContent), h.$('statusText').textContent);
  }
  {
    const h = await prepareAiTranslationHarness();
    h.ev(`window.__aiCalls=0; window.__freeCalls=0;
      window.fetch=async()=>{window.__aiCalls++;return {ok:false,status:429,json:async()=>({})};};
      TranslateTools.translate=async()=>{window.__freeCalls++;return {text:'ترجمه جایگزین',ok:true};};`);
    h.$('trAiEnabled').checked = true;
    h.ev(`aiProfiles=[makeAiProfile('تک‌کلید','test-local-key')];renderAiProfiles();`);
    await h.ev('runTranslate()');
    check('one failed AI profile is not retried to conserve quota', h.ev('window.__aiCalls') === 1);
    check('AI failure falls back only once per missing bubble', h.ev('window.__freeCalls') === 2,
      h.ev('window.__freeCalls'));
    check('fallback still produces translated images', h.ev('items.every(it=>it.edited && it.ocr.blocks[0].tr==="ترجمه جایگزین")'));
    check('fallback is explained without exposing the key', /جایگزین/.test(h.$('statusText').textContent) &&
      !h.$('failed').textContent.includes('test-local-key') && /سقف/.test(h.$('failed').textContent), h.$('failed').textContent);
  }
  {
    const h = await prepareAiTranslationHarness();
    h.ev(`window.__aiCalls=0; window.__freeCalls=0;
      window.fetch=async(url,options)=>{window.__aiCalls++;return new Promise((resolve,reject)=>{
        options.signal.addEventListener('abort',()=>reject(new Error('aborted')));
      });};
      TranslateTools.translate=async()=>{window.__freeCalls++;return {text:'ترجمه معمولی',ok:true};};`);
    h.$('trAiEnabled').checked = true;
    h.ev(`aiProfiles=[makeAiProfile('در حال کار','test-local-key'),makeAiProfile('پشتیبان','backup-key')];renderAiProfiles();`);
    const running = h.ev('runTranslate()');
    for (let i = 0; i < 60 && h.ev('window.__aiCalls') === 0; i++) await sleep(20);
    check('AI request is in flight before cancellation', h.ev('window.__aiCalls') === 1);
    h.$('btnStopTr').click();
    await running;
    check('stopping aborts AI without another key or fallback requests',
      h.ev('window.__freeCalls') === 0 && h.ev('window.__aiCalls') === 1 && h.ev('TR.aiController') === null);
    check('stopped AI run releases the UI and reports cancellation', !h.ev('building') && /متوقف/.test(h.$('statusText').textContent),
      h.$('statusText').textContent);
  }

  {
    const h = await prepareAiTranslationHarness();
    h.ev(`window.__aiCalls=0; window.__freeCalls=0; window.__aiKeys=[];
      window.fetch=async(url,options)=>{window.__aiCalls++;const key=options.headers['x-goog-api-key'];window.__aiKeys.push(key);
        if(key==='first-test-key')return {ok:false,status:429,json:async()=>({})};
        const ids=window.__aiIds(options);return window.__aiOk(ids.map(id=>({id,translation:'ترجمهٔ پشتیبان '+id})));};
      TranslateTools.translate=async()=>{window.__freeCalls++;return {text:'ترجمه معمولی',ok:true};};`);
    h.$('trAiEnabled').checked = true;
    h.ev(`aiProfiles=[makeAiProfile('کلید اول','first-test-key'),makeAiProfile('کلید دوم','second-test-key')];renderAiProfiles();`);
    await h.ev('runTranslate()');
    check('integration moves from exhausted first key to named backup in order',
      h.ev('window.__aiCalls') === 2 && h.ev('window.__aiKeys.join(",")') === 'first-test-key,second-test-key',
      h.ev('window.__aiKeys'));
    check('backup success avoids ordinary fallback and renders every translation',
      h.ev('window.__freeCalls') === 0 && h.ev('items.every(it=>it.edited && it.ocr.blocks[0].tr.startsWith("ترجمهٔ پشتیبان"))'));
    const settings = h.storageMap.get('gemini_translation_settings_v1');
    check('both custom profile names and keys are stored locally in order', settings &&
      settings.providers.gemini.profiles.length === 2 && settings.providers.gemini.profiles[0].name === 'کلید اول' &&
      settings.providers.gemini.profiles[1].name === 'کلید دوم' && settings.providers.gemini.profiles[1].apiKey === 'second-test-key');
    check('neither failover key leaks into errors or the page profile',
      !h.$('failed').textContent.includes('first-test-key') &&
      !JSON.stringify(h.ev('collectPageProfile()')).includes('second-test-key'));
  }
  {
    const h = await prepareAiTranslationHarness();
    h.ev(`window.__aiCalls=0;window.__freeCalls=0;
      window.fetch=async(url,options)=>{window.__aiCalls++;window.__lastProviderRequest={url,options};
        const ids=window.__aiIds(options);return window.__openAiOk(ids.map(id=>({id,translation:'OpenAI UI '+id})));};
      TranslateTools.translate=async()=>{window.__freeCalls++;return {text:'ترجمه معمولی',ok:true};};`);
    h.$('trAiProvider').value = 'openai';
    h.$('trAiProvider').dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await sleep(0);
    h.ev(`aiProfiles=[makeAiProfile('OpenAI من','openai-ui-key')];renderAiProfiles();`);
    h.$('trAiModel').value = 'gpt-4.1-mini';
    h.$('trAiEnabled').checked = true;
    await h.ev('runTranslate()');
    check('OpenAI UI sends the exact custom model to OpenAI, not Gemini',
      h.ev('window.__aiCalls') === 1 && h.ev('window.__lastProviderRequest.url') === 'https://api.openai.com/v1/chat/completions' &&
      h.ev('JSON.parse(window.__lastProviderRequest.options.body).model') === 'gpt-4.1-mini' &&
      h.ev('window.__lastProviderRequest.options.headers.Authorization') === 'Bearer openai-ui-key' &&
      !h.ev('window.__lastProviderRequest.url').includes('googleapis'));
    check('OpenAI UI response renders without ordinary fallback',
      h.ev('window.__freeCalls') === 0 && h.ev('items.every(it=>it.edited && it.ocr.blocks[0].tr.startsWith("OpenAI UI"))'));
    const providerSettings = h.storageMap.get('gemini_translation_settings_v1');
    check('selected provider, custom model, and its own key are stored independently',
      providerSettings.provider === 'openai' && providerSettings.providers.openai.model === 'gpt-4.1-mini' &&
      providerSettings.providers.openai.profiles[0].apiKey === 'openai-ui-key');
    h.$('trAiProvider').value = 'gemini';
    h.$('trAiProvider').dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await sleep(0);
    check('switching to Gemini does not reuse the OpenAI key or model',
      h.$('trAiModel').value === 'gemini-2.5-flash' && h.ev('aiProfiles.every(p=>p.apiKey!=="openai-ui-key")'));
    h.$('trAiProvider').value = 'openai';
    h.$('trAiProvider').dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await sleep(0);
    check('switching back restores the OpenAI custom model and key',
      h.$('trAiModel').value === 'gpt-4.1-mini' && h.ev('aiProfiles[0].apiKey') === 'openai-ui-key');
  }
  {
    const h = await prepareAiTranslationHarness();
    h.ev(`window.__aiCalls=0;window.__freeCalls=0;
      window.fetch=async(url,options)=>{window.__aiCalls++;window.__lastAvalAiRequest={url,options};
        const ids=window.__aiIds(options);return window.__openAiOk(ids.map(id=>({id,translation:'AvalAI UI '+id})));};
      TranslateTools.translate=async()=>{window.__freeCalls++;return {text:'ترجمه معمولی',ok:true};};`);
    h.$('trAiProvider').value = 'avalai';
    h.$('trAiProvider').dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await sleep(0);
    h.ev(`aiProfiles=[makeAiProfile('آوال‌ای من','avalai-ui-key')];renderAiProfiles();`);
    h.$('trAiEnabled').checked = true;
    await h.ev('runTranslate()');
    check('AvalAI UI sends gpt-6-luna to AvalAI with its own key',
      h.ev('window.__aiCalls') === 1 && h.ev('window.__lastAvalAiRequest.url') === 'https://api.avalai.ir/v1/chat/completions' &&
      h.ev('JSON.parse(window.__lastAvalAiRequest.options.body).model') === 'gpt-6-luna' &&
      h.ev('window.__lastAvalAiRequest.options.headers.Authorization') === 'Bearer avalai-ui-key');
    check('AvalAI UI response renders and its settings stay local',
      h.ev('window.__freeCalls') === 0 && h.ev('items.every(it=>it.edited && it.ocr.blocks[0].tr.startsWith("AvalAI UI"))') &&
      h.storageMap.get('gemini_translation_settings_v1').provider === 'avalai' &&
      h.storageMap.get('gemini_translation_settings_v1').providers.avalai.profiles[0].apiKey === 'avalai-ui-key');
  }
  {
    const h = await prepareAiTranslationHarness();
    h.ev(`aiProfiles=[makeAiProfile('تست من','connection-ui-key')];renderAiProfiles();
      window.__connectionCalls=[];
      window.fetch=async(url,options)=>{window.__connectionCalls.push({url,options});
        return {ok:true,status:200,json:async()=>({name:'models/gemini-2.5-flash'})};};`);
    const testButton = h.$('aiProfileList').querySelector('.ai-profile-test');
    testButton.click();
    for (let i = 0; i < 60 && testButton.disabled; i++) await sleep(10);
    const status = h.$('aiProfileList').querySelector('.ai-profile-status');
    check('profile test button checks only that key with a lightweight model GET',
      h.ev('window.__connectionCalls.length') === 1 &&
      h.ev('window.__connectionCalls[0].options.method') === 'GET' &&
      h.ev('window.__connectionCalls[0].options.headers["x-goog-api-key"]') === 'connection-ui-key' &&
      h.ev('window.__connectionCalls[0].url').includes('/v1beta/models/gemini-2.5-flash') &&
      !h.ev('window.__connectionCalls[0].url').includes('generateContent') &&
      h.ev('window.__connectionCalls[0].options.body') === undefined);
    check('successful profile test shows a clear result beside the key',
      /اتصال برقرار است/.test(status.textContent) && status.classList.contains('ok') && !testButton.disabled,
      status.textContent);
    h.ev(`window.fetch=async()=>({ok:false,status:401,json:async()=>({})});`);
    testButton.click();
    for (let i = 0; i < 60 && testButton.disabled; i++) await sleep(10);
    check('failed profile test explains the error without exposing the key',
      /کلید API/.test(status.textContent) && status.classList.contains('bad') &&
      !status.textContent.includes('connection-ui-key') && !testButton.disabled, status.textContent);
  }
  {
    const h = makeHarness({
      jobUrls: ['https://comic.test/a.png'],
      aiSettings: { enabled: true, apiKey: 'legacy-test-key', model: 'gemini-2.5-flash', skill: 'Skill قبلی' }
    });
    await h.ev('aiSettingsReady');
    check('existing single-key settings migrate without losing key, model, Skill, or opt-in',
      h.ev('aiProfiles.length') === 1 && h.ev('aiProfiles[0].apiKey') === 'legacy-test-key' &&
      h.ev('aiProfiles[0].name') === 'کلید اصلی' && h.$('trAiEnabled').checked &&
      h.$('trAiModel').value === 'gemini-2.5-flash' && h.$('trAiSkill').value === 'Skill قبلی');
    check('migrated key appears in a private password row inside collapsed AI settings',
      h.$('aiProfileList').querySelectorAll('.ai-profile-row').length === 1 &&
      h.$('aiProfileList').querySelector('input[type="password"]').value === 'legacy-test-key' &&
      h.$('aiSettings').contains(h.$('aiProfileList')));
    await h.ev('saveAiSettings()');
    check('migration saves the new local profile structure',
      h.storageMap.get('gemini_translation_settings_v1').providers.gemini.profiles[0].apiKey === 'legacy-test-key');
    h.$('trAiAddProfile').click();
    await sleep(0);
    const rows = h.$('aiProfileList').querySelectorAll('.ai-profile-row');
    check('add API creates another named profile row', rows.length === 2 &&
      rows[1].querySelector('input[type="text"]') && rows[1].querySelector('input[type="password"]'));
    const nameInput = rows[1].querySelector('input[type="text"]');
    const keyInput = rows[1].querySelector('input[type="password"]');
    nameInput.value = 'ذخیرهٔ من'; keyInput.value = 'ui-second-key';
    nameInput.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    keyInput.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    await h.ev('saveAiSettings()');
    const saved = h.storageMap.get('gemini_translation_settings_v1');
    check('custom name and second secret entered in the UI persist locally',
      saved.providers.gemini.profiles.length === 2 && saved.providers.gemini.profiles[1].name === 'ذخیرهٔ من' &&
      saved.providers.gemini.profiles[1].apiKey === 'ui-second-key');
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL EDGE-CASE TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(2); });
