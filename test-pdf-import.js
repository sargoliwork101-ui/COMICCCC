// Tests for PDF import: local IndexedDB store and pdf.js-driven page rendering pipeline
const fakeIDB = require('fake-indexeddb');
const { JSDOM } = require('jsdom');

let failures = 0;
const check = (n, c, e) => { if (c) console.log('PASS:', n); else { failures++; console.log('FAIL:', n, e !== undefined ? JSON.stringify(e) : ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

global.indexedDB = fakeIDB.indexedDB;
global.IDBKeyRange = fakeIDB.IDBKeyRange;

const PdfStore = require('./pdfstore.js');
const PdfImport = require('./pdfimport.js');

// ---------- fake pdf.js engine ----------
function fakePdfLib() {
  const renders = [];
  const lib = {
    getDocument() {
      const doc = {
        numPages: 2,
        async getPage(n) {
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
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = function () {
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
  window.HTMLCanvasElement.prototype.toBlob = function (cb, type) {
    // node Blob so fake-indexeddb's native structuredClone can store it
    cb(new Blob(['fake-jpeg'], { type: type || 'image/jpeg' }));
  };
}

(async () => {
  // ---------- 1. PdfStore basics + roundtrip ----------
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

  // ---------- 2. render pipeline with a fake engine ----------
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

  // ---------- 3. full import flow stores blobs and opens a viewer job ----------
  {
    const sent = [];
    const file = new dom.window.File([new Uint8Array(8)], 'my book.pdf', { type: 'application/pdf' });
    const result = await PdfImport.importFile(file, {
      store: PdfStore,
      lib,
      createCanvas: () => dom.window.document.createElement('canvas'),
      sendMessage: async (msg) => { sent.push(msg); return { ok: true, tabId: 11 }; }
    });
    check('import reports page count', result.pageCount === 2 && typeof result.importId === 'string', result);
    check('local job message sent with internal urls',
      sent[0].type === 'WTPDF_LOCAL_JOB' && sent[0].source === 'pdf-import' &&
      sent[0].name === 'my book.pdf' && sent[0].urls.length === 2 &&
      sent[0].urls.every((u) => PdfStore.isInternalUrl(u)), sent[0]);
    const stored = await PdfStore.getPage(sent[0].urls[1]);
    check('every rendered page landed in the local store', stored instanceof Blob && stored.size > 0);
  }

  // ---------- 4. failed viewer open rolls the stored pages back ----------
  {
    const file = new dom.window.File([new Uint8Array(8)], 'rollback.pdf', { type: 'application/pdf' });
    let failed = false;
    let deletedUrls = null;
    const rollbackStore = {
      ...PdfStore,
      deletePages: async (urls) => { deletedUrls = urls; return PdfStore.deletePages(urls); }
    };
    try {
      await PdfImport.importFile(file, {
        store: rollbackStore,
        lib,
        createCanvas: () => dom.window.document.createElement('canvas'),
        sendMessage: async () => ({ ok: false, error: 'boom' })
      });
    } catch (e) { failed = /boom/.test(e.message); }
    check('open failure rejects with the background error', failed);
    check('failed open deletes the stored page blobs', Array.isArray(deletedUrls) && deletedUrls.length === 2 &&
      deletedUrls.every((u) => PdfStore.isInternalUrl(u)), deletedUrls);
  }

  // ---------- 5. non-PDF files are rejected ----------
  {
    const file = new dom.window.File(['hello'], 'note.txt', { type: 'text/plain' });
    let rejected = false;
    try { await PdfImport.importFile(file, { store: PdfStore, lib, sendMessage: async () => ({ ok: true }) }); }
    catch { rejected = true; }
    check('non-PDF input is rejected', rejected);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PDF IMPORT TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(2); });
