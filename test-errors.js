// Adversarial / edge-case tests for viewer flows.
const fs = require('fs');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfab440000000049454e44ae426082',
  'hex'
);

function makeHarness({ fetchImpl, jobUrls } = {}) {
  const html = fs.readFileSync(__dirname + '/viewer.html', 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
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
  for (const f of ['jspdf.umd.min.js', 'pdfbuilder.js', 'tesseract.min.js', 'ocr.js', 'typeset.js', 'translate.js', 'viewer.js', 'trans.js']) {
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
    check('failed cards not selected', items.every((it) => !it.selected));
    failAll = false;
    h.$('btnRetry').click();
    for (let i = 0; i < 60; i++) { await sleep(80); if (!h.ev('loading')) break; }
    items = h.ev('items');
    check('retry recovers all', items.every((it) => it.state === 'ok'), items.map((i) => i.state));
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
    check('two groups created', JSON.stringify(g) === JSON.stringify([1, 1, 2, 2]), g);
    // delete one member of group 1 -> it dissolves (singleton), group 2 is renumbered to 1
    h.ev('deleteItem(items[0])');
    g = h.ev('items.map(i=>i.pageGroup)');
    check('group renumbered after deletion', g.length === 3 && JSON.stringify(g) === JSON.stringify([null, 1, 1]), g);
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

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL EDGE-CASE TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(2); });
