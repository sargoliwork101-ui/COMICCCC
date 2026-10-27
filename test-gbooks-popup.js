// Integration tests for the Google Books dedicated path inside scrapeAndSend().
const fs = require('fs');
const vm = require('vm');
const { JSDOM } = require('jsdom');

let failures = 0;
const check = (n, c, e) => { if (c) console.log('PASS:', n); else { failures++; console.log('FAIL:', n, e !== undefined ? JSON.stringify(e) : ''); } };
const tick = () => new Promise((r) => setTimeout(r, 0));

function makeHarness(pageUrl) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: pageUrl, pretendToBeVisual: true, runScripts: 'dangerously'
  });
  const { window } = dom;
  const ctx = dom.getInternalVMContext();
  window.Element.prototype.getBoundingClientRect = function () {
    return { width: 300, height: 420, top: 0, left: 0, right: 300, bottom: 420 };
  };

  function img(src, w = 256, h = 256) {
    const el = window.document.createElement('img');
    el.setAttribute('src', src);
    Object.defineProperty(el, 'naturalWidth', { value: w, configurable: true });
    Object.defineProperty(el, 'naturalHeight', { value: h, configurable: true });
    Object.defineProperty(el, 'complete', { value: true, configurable: true });
    el.getBoundingClientRect = () => ({ width: w, height: h, top: 0, left: 0, right: w, bottom: h });
    return el;
  }

  const messages = [];
  const progressListeners = [];
  let gbCancelled = false;
  let scanBehavior = { type: 'ok' }; // 'ok' | 'fail' | 'defer'
  let deferredScan = null;
  window.chrome = {
    runtime: {
      sendMessage: async (msg) => {
        messages.push(msg);
        if (msg.type === 'WTPDF_GBOOKS_CANCEL') { gbCancelled = true; return { ok: true }; }
        if (msg.type === 'WTPDF_GBOOKS_SCAN') {
          if (scanBehavior.type === 'defer' && deferredScan) return deferredScan.promise;
          if (scanBehavior.type === 'fail') return { ok: false, error: scanBehavior.error || 'boom' };
          if (gbCancelled) return { ok: false, cancelled: true, error: 'cancelled' };
          return {
            ok: true, urls: scanBehavior.urls || [],
            totalPages: scanBehavior.totalPages || 0, availablePages: (scanBehavior.urls || []).length
          };
        }
        if (msg.type === 'WTPDF_URLS') return { ok: true };
        return { ok: true };
      },
      onMessage: {
        addListener: (fn) => progressListeners.push(fn),
        removeListener: (fn) => {
          const i = progressListeners.indexOf(fn);
          if (i >= 0) progressListeners.splice(i, 1);
        }
      }
    }
  };
  window.setTimeout = (cb) => global.setTimeout(cb, 0);
  window.setInterval = (cb) => { global.setTimeout(cb, 0); return 1; };
  window.clearInterval = () => {};
  window.__wtpdfTimings = { poll: 1, clickTimeout: 30, settle: 1, stuckLimit: 2, maxPages: 5, manualRescan: 1 };

  const code = fs.readFileSync(__dirname + '/popup.js', 'utf8');
  const fnCode = code.slice(code.indexOf('async function scrapeAndSend'));
  vm.runInContext(fnCode, ctx, { filename: 'popup.js' });

  return {
    window, img, messages, progressListeners,
    setScanBehavior(b) { scanBehavior = b; },
    deferScan() {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      deferredScan = { promise, resolve };
      scanBehavior = { type: 'defer' };
      return deferredScan;
    },
    urlJobs: () => messages.filter((m) => m.type === 'WTPDF_URLS'),
    scanJobs: () => messages.filter((m) => m.type === 'WTPDF_GBOOKS_SCAN'),
    cancelJobs: () => messages.filter((m) => m.type === 'WTPDF_GBOOKS_CANCEL')
  };
}

const API_URLS = [
  'https://books.google.com/books/content?id=B1&pg=PA1&img=1&zoom=3&sig=a&w=10000',
  'https://books.google.com/books/content?id=B1&pg=PA2&img=1&zoom=3&sig=b&w=10000',
  'https://books.google.com/books/content?id=B1&pg=PA3&img=1&zoom=3&sig=c&w=10000'
];

(async () => {
  // 1. old-style books.google.com URL: every user mode routes through the dedicated API path
  for (const mode of ['scroll', 'auto', 'manual']) {
    const h = makeHarness('https://books.google.com/books?id=B1&pg=PA1&jscmd=click3');
    // the DOM only carries 256x256 tiles which must not pollute the result
    h.window.document.body.appendChild(h.img('https://books.google.com/books/content?id=B1&pg=PA1&img=1&zoom=2&tid=0'));
    h.window.document.body.appendChild(h.img('https://books.google.com/books/content?id=B1&pg=PA1&img=1&zoom=2&tid=1'));
    // hold the API response so the in-flight UI can be inspected before the run finishes and removes it
    const deferred = h.deferScan();

    const running = h.window.eval(`scrapeAndSend("book.pdf", "${mode}")`);
    await tick();
    await tick();
    check(`mode ${mode}: full-screen overlay used (no manual panel on GB)`,
      !!h.window.document.querySelector('.wtpdf-overlay') && !h.window.document.querySelector('.wtpdf-manual'));
    check(`mode ${mode}: scan message sent with page url`, h.scanJobs().length === 1 &&
      h.scanJobs()[0].pageUrl.includes('id=B1'), h.scanJobs());
    deferred.resolve({ ok: true, urls: API_URLS, totalPages: 4, availablePages: 3 });
    const res = await running;

    check(`mode ${mode}: result count comes from the API`, res && res.count === 3, res);
    const job = h.urlJobs()[0];
    check(`mode ${mode}: one WTPDF_URLS job carrying API urls`, h.urlJobs().length === 1 &&
      JSON.stringify(job.urls) === JSON.stringify(API_URLS), job && job.urls);
    check(`mode ${mode}: DOM tiles excluded`, !job.urls.some((u) => u.includes('tid=')));
    check(`mode ${mode}: UI cleaned up and flag reset`,
      !h.window.document.querySelector('.wtpdf-root') && h.window.__wtpdfRunning === false);
  }

  // 2. new-style edition URL on www.google.com is detected
  {
    const h = makeHarness('https://www.google.com/books/edition/A_Textbook_of_Electronic_Circuits/4ciReKlOVHIC?hl=en&gbpv=1');
    h.setScanBehavior({ type: 'ok', urls: API_URLS, totalPages: 3 });
    const res = await h.window.eval('scrapeAndSend("book.pdf", "auto")');
    check('edition URL: API path used', h.scanJobs().length === 1 && res.count === 3, res);
  }

  // 3. ESC during the API walk cancels and sends the cancel control message
  {
    const h = makeHarness('https://books.google.com/books?id=B1');
    const deferred = h.deferScan();
    const running = h.window.eval('scrapeAndSend("book.pdf", "auto")');
    await tick();
    h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    deferred.resolve({ ok: false, cancelled: true, error: 'cancelled' });
    const res = await running;
    check('ESC: cancelled result', res && res.cancelled === true, res);
    check('ESC: cancel control message sent', h.cancelJobs().length === 1);
    check('ESC: no URL job created', h.urlJobs().length === 0);
    check('ESC: overlay removed', !h.window.document.querySelector('.wtpdf-root'));
  }

  // 4. API failure falls back to ordinary DOM scanning instead of hard failure
  {
    const h = makeHarness('https://books.google.com/books?id=B1');
    h.window.document.body.appendChild(h.img('https://books.google.com/books/content?id=B1&pg=PA1&img=1&zoom=2&tid=0'));
    h.setScanBehavior({ type: 'fail', error: 'HTTP 429' });
    const res = await h.window.eval('scrapeAndSend("book.pdf", "auto")');
    check('fallback: DOM tile collected after API failure', res && res.count === 1, res);
    check('fallback: scan attempted then URL job sent', h.scanJobs().length === 1 && h.urlJobs().length === 1);
  }

  // 5. embedded Google Books iframe on a non-Google page is detected
  {
    const h = makeHarness('https://example.com/article');
    const frame = h.window.document.createElement('iframe');
    frame.src = 'https://books.google.com/books?id=EMBED99&output=embed';
    h.window.document.body.appendChild(frame);
    h.setScanBehavior({ type: 'ok', urls: API_URLS.slice(0, 1), totalPages: 1 });
    const res = await h.window.eval('scrapeAndSend("book.pdf", "scroll")');
    check('iframe: embedded reader detected via frame src', h.scanJobs().length === 1 && res && res.count === 1, res);
  }

  // 6. unrelated pages never trigger the Google Books path
  {
    const h = makeHarness('https://comic.test/episode/9');
    h.window.document.body.appendChild(h.img('https://cdn.test/page.jpg', 300, 420));
    const res = await h.window.eval('scrapeAndSend("comic.pdf", "auto")');
    check('non-GB: no scan message', h.scanJobs().length === 0);
    check('non-GB: ordinary DOM collection still works', res && res.count === 1 && h.urlJobs().length === 1, res);
    // ESC outside an active Google Books scan must not leave a cancel control message behind
    h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    check('non-GB: no stray cancel control message', h.cancelJobs().length === 0, h.cancelJobs().length);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL GBOOKS POPUP TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(2); });
