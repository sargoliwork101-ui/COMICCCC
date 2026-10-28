// Tests for the two-stage PDF import: popup stashes the raw file, the dedicated tab renders and opens the viewer
const fs = require('fs');
const vm = require('vm');
const fakeIDB = require('fake-indexeddb');
const { JSDOM } = require('jsdom');

let failures = 0;
const check = (n, c, e) => { if (c) console.log('PASS:', n); else { failures++; console.log('FAIL:', n, e !== undefined ? JSON.stringify(e) : ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeout = 2000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(10);
  }
  return fn();
};

global.indexedDB = fakeIDB.indexedDB;
global.IDBKeyRange = fakeIDB.IDBKeyRange;

const PdfStore = require('./pdfstore.js');
const PdfImport = require('./pdfimport.js');

// ---------- fake pdf.js engine ----------
function fakePdfLib() {
  const renders = [];
  const lib = {
    GlobalWorkerOptions: {},
    getDocument() {
      const doc = {
        numPages: 2,
        async getPage() {
          return {
            // base width 800 -> scale 2 reaches the 1600px target width
            getViewport({ scale }) { return { width: 800 * scale, height: 1000 * scale }; },
            render({ canvasContext, viewport }) {
              renders.push({ viewport, fill: canvasContext.__fills });
              return { promise: Promise.resolve() };
            },
            cleanup() {}
          };
        },
        async destroy() {}
      };
      return { promise: Promise.resolve(doc) };
    },
    __renders: renders
  };
  return lib;
}

function installCanvasHarness(dom) {
  dom.window.HTMLCanvasElement.prototype.getContext = function () {
    const ctx = new Proxy({}, {
      get(t, p) {
        if (p === '__fills') return t.__fills;
        if (p === 'fillRect') return (x, y, w, h) => { t.__fills.push([x, y, w, h]); };
        return typeof p === 'string' ? () => {} : undefined;
      },
      set: (t, p, v) => { t[p] = v; return true; }
    });
    ctx.__fills = [];
    return ctx;
  };
  dom.window.HTMLCanvasElement.prototype.toBlob = function (cb, type) {
    // node Blob so fake-indexeddb's native structuredClone can store it
    cb(new Blob(['fake-jpeg'], { type: type || 'image/jpeg' }));
  };
}

(async () => {
  // ---------- 1. PdfStore: pages ----------
  {
    check('scheme detection', PdfStore.isInternalUrl('pdf-internal://abc/3') === true &&
      PdfStore.isInternalUrl('https://example.com/a.jpg') === false);
    const importId = PdfStore.makeImportId();
    check('import id and page url shape', /^[a-z0-9]+$/.test(importId) && PdfStore.pageUrl(importId, 2) === `pdf-internal://${importId}/2`);

    const blob = new Blob(['x'.repeat(16)], { type: 'image/jpeg' });
    const url = PdfStore.pageUrl('jobtest', 0);
    await PdfStore.putPages([{ url, blob }]);
    const back = await PdfStore.getPage(url);
    check('stored blob roundtrips', back instanceof Blob && back.size === blob.size, back && back.size);
    check('missing page returns null', await PdfStore.getPage('pdf-internal://jobtest/99') === null);
    await PdfStore.deleteJobPages(['https://web.test/a.jpg', url]);
    check('deleteJobPages removes only internal pages', await PdfStore.getPage(url) === null);
  }

  // ---------- 2. PdfStore: raw import file handoff (popup -> import tab) ----------
  {
    const raw = new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' });
    await PdfStore.putImport('imp9', 'my book.pdf', raw);
    const rec = await PdfStore.getImport('imp9');
    check('raw file stashed with its name', rec && rec.name === 'my book.pdf' && rec.blob instanceof Blob && rec.blob.size === raw.size);
    check('missing import returns null', await PdfStore.getImport('nope') === null);
    await PdfStore.deleteImport('imp9');
    check('import record can be deleted', await PdfStore.getImport('imp9') === null);
  }

  // ---------- 3. render pipeline with a fake engine ----------
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://example.test/' });
  installCanvasHarness(dom);
  const progress = [];
  const lib = fakePdfLib();
  const pages = await PdfImport.renderPdfToBlobs(new ArrayBuffer(8), {
    lib,
    createCanvas: () => dom.window.document.createElement('canvas'),
    onProgress: (done, total) => progress.push([done, total])
  });
  check('renders every page', pages.length === 2 && lib.__renders.length === 2, pages.length);
  check('scale targets 1600px width', lib.__renders[0].viewport.width === 1600 && lib.__renders[0].viewport.height === 2000, lib.__renders[0].viewport);
  check('progress reported per page', JSON.stringify(progress) === JSON.stringify([[1, 2], [2, 2]]), progress);
  check('output is JPEG blobs', pages.every((p) => p.blob.type === 'image/jpeg' && p.width === 1600 && p.height === 2000));

  // ---------- 4. popup stage: stashFile validation ----------
  {
    const ok = await PdfImport.stashFile(new File([new Uint8Array(8)], 'doc.pdf', { type: 'application/pdf' }), { store: PdfStore });
    check('valid PDF is stashed and returns an id', ok && /^[a-z0-9]+$/.test(ok.id) && ok.name === 'doc.pdf', ok);
    const rec = await PdfStore.getImport(ok.id);
    check('stashed record is readable by the import tab', rec && rec.blob instanceof Blob);
    await PdfStore.deleteImport(ok.id);

    let rejected = false;
    try { await PdfImport.stashFile(new File(['hello'], 'note.txt', { type: 'text/plain' }), { store: PdfStore }); }
    catch { rejected = true; }
    check('non-PDF input is rejected at stash time', rejected);
    rejected = false;
    try { await PdfImport.stashFile(null, { store: PdfStore }); } catch { rejected = true; }
    check('missing file is rejected', rejected);
  }

  // ---------- 5. popup stage: opening the dedicated tab ----------
  {
    const opened = [];
    PdfImport.openImportTab({ id: 'abc123', name: 'کتاب.pdf' }, { openTab: (u) => opened.push(u) });
    check('import tab url carries id and encoded name',
      opened[0] === 'pdfimport.html?id=abc123&name=' + encodeURIComponent('کتاب.pdf'), opened);
  }

  // ---------- 6. import-tab stage: full successful run ----------
  {
    const raw = new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' });
    await PdfStore.putImport('job1', 'my book.pdf', raw);
    const sent = [];
    const result = await PdfImport.runImportJob('job1', {
      store: PdfStore,
      lib: fakePdfLib(),
      createCanvas: () => dom.window.document.createElement('canvas'),
      sendMessage: async (msg) => { sent.push(msg); return { ok: true, tabId: 11 }; }
    });
    check('run reports page count and id', result.pageCount === 2 && result.importId === 'job1' && result.tabId === 11, result);
    check('local job message sent with internal urls',
      sent[0].type === 'WTPDF_LOCAL_JOB' && sent[0].source === 'pdf-import' &&
      sent[0].name === 'my book.pdf' && sent[0].urls.length === 2 &&
      sent[0].urls.every((u) => PdfStore.isInternalUrl(u)), sent[0]);
    const stored = await PdfStore.getPage(sent[0].urls[1]);
    check('every rendered page landed in the page store', stored instanceof Blob && stored.size > 0);
    check('raw file record is removed after a successful handoff', await PdfStore.getImport('job1') === null);
    await PdfStore.deleteJobPages(sent[0].urls);
  }

  // ---------- 7. missing stashed file fails clearly ----------
  {
    let failed = false;
    try {
      await PdfImport.runImportJob('ghost', {
        store: PdfStore, lib, createCanvas: () => dom.window.document.createElement('canvas'),
        sendMessage: async () => ({ ok: true })
      });
    } catch (e) { failed = /حافظه/.test(e.message); }
    check('unknown import id gives a Persian storage error', failed);
  }

  // ---------- 8. failed viewer open: pages roll back, raw file stays for retry ----------
  {
    await PdfStore.putImport('job2', 'rollback.pdf', new Blob(['%PDF'], { type: 'application/pdf' }));
    const sendFailing = async () => ({ ok: false, error: 'boom' });
    let failed = false;
    try {
      await PdfImport.runImportJob('job2', { store: PdfStore, lib: fakePdfLib(),
        createCanvas: () => dom.window.document.createElement('canvas'), sendMessage: sendFailing });
    } catch (e) { failed = /boom/.test(e.message); }
    check('open failure rejects with the background error', failed);
    check('raw file is kept so retry works without re-picking', (await PdfStore.getImport('job2')) !== null);

    // retry with a healthy background succeeds
    const sent = [];
    const retried = await PdfImport.runImportJob('job2', {
      store: PdfStore, lib: fakePdfLib(),
      createCanvas: () => dom.window.document.createElement('canvas'),
      sendMessage: async (m) => { sent.push(m); return { ok: true, tabId: 5 }; }
    });
    check('retry after failure succeeds', retried.pageCount === 2 && sent.length === 1);
    check('retry cleans up the raw file at last', await PdfStore.getImport('job2') === null);
    await PdfStore.deleteJobPages(sent[0].urls);
  }

  // ---------- 9. DOM wiring: popup change handler opens the import tab ----------
  {
    const popup = new JSDOM('<!DOCTYPE html><html><body>' +
      '<input type="file" id="pdfFile"><div id="pdfImportStatus" class="hidden"></div></body></html>',
      { url: 'chrome-extension://ext/popup.html', pretendToBeVisual: true, runScripts: 'dangerously' });
    const pctx = popup.getInternalVMContext();
    pctx.chrome = { tabs: { create: (o) => openedTabs.push(o.url) }, runtime: {} };
    const openedTabs = [];
    const stashed = [];
    pctx.eval(fs.readFileSync(__dirname + '/pdfimport.js', 'utf8'));
    pctx.PdfStore = { makeImportId: () => 'domjob1', putImport: async (id, name) => stashed.push({ id, name }) };
    popup.window.document.dispatchEvent(new popup.window.Event('DOMContentLoaded'));
    const input = popup.window.document.getElementById('pdfFile');
    const file = new popup.window.File([new Uint8Array(4)], 'dom.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new popup.window.Event('change', { bubbles: true }));
    await waitFor(() => openedTabs.length === 1);
    const status = popup.window.document.getElementById('pdfImportStatus');
    check('popup stashes the file before opening a tab', stashed.length === 1 && stashed[0].name === 'dom.pdf', stashed);
    check('popup opens the dedicated import tab (no rendering in popup)',
      openedTabs.length === 1 && /^pdfimport\.html\?id=domjob1&name=dom\.pdf$/.test(openedTabs[0]), openedTabs);
    check('popup shows the success status in Persian', /تب تبدیل/.test(status.textContent), status.textContent);
    check('file input is reset for the next pick', input.value === '');
  }

  // ---------- 10. DOM wiring: import page runs the job and shows progress/success ----------
  {
    const page = new JSDOM('<!DOCTYPE html><html><body><div id="pdfImportPage">' +
      '<div id="impName"></div><div id="impWorking"><div id="impStage"></div>' +
      '<div id="impBar"></div><div id="impPct"></div></div>' +
      '<div id="impDone" class="hidden"></div><div id="impError" class="hidden"><div id="impErrorMsg"></div>' +
      '<button id="impRetry"></button><button id="impClose"></button><button id="impDoneClose"></button></div>' +
      '</div></body></html>',
      { url: 'chrome-extension://ext/pdfimport.html?id=domjob2&name=page.pdf', pretendToBeVisual: true, runScripts: 'dangerously' });
    const c = page.getInternalVMContext();
    c.indexedDB = global.indexedDB; c.IDBKeyRange = global.IDBKeyRange;
    c.chrome = {
      runtime: {
        getURL: (p) => 'chrome-extension://ext/' + p,
        sendMessage: async (m) => { sentMsgs.push(m); return { ok: true, tabId: 3 }; }
      }
    };
    const sentMsgs = [];
    installCanvasHarness(page);
    c.pdfjsLib = fakePdfLib();
    c.eval(fs.readFileSync(__dirname + '/pdfstore.js', 'utf8'));
    c.eval(fs.readFileSync(__dirname + '/pdfimport.js', 'utf8'));
    await c.PdfStore.putImport('domjob2', 'page.pdf', new Blob(['%PDF'], { type: 'application/pdf' }));
    page.window.dispatchEvent(new page.window.Event('DOMContentLoaded'));
    await waitFor(() => sentMsgs.length === 1);
    check('import page sends the local job message', sentMsgs.length === 1 && sentMsgs[0].type === 'WTPDF_LOCAL_JOB', sentMsgs);
    check('import page shows the done state and hides working state',
      !page.window.document.getElementById('impDone').classList.contains('hidden') &&
      page.window.document.getElementById('impWorking').classList.contains('hidden') &&
      page.window.document.getElementById('impError').classList.contains('hidden'));
    check('progress UI reached 100%', page.window.document.getElementById('impBar').style.width === '100%');
    check('file name is shown in the import page', page.window.document.getElementById('impName').textContent === 'page.pdf');
    const rec = await c.PdfStore.getImport('domjob2');
    check('import page deletes the raw file after success', rec === null);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PDF IMPORT TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(2); });
