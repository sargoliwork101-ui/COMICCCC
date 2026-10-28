// Integration tests for the Google Books paths inside scrapeAndSend():
// - in-frame reader (books.google.*): same-origin click3 fetch (walk + manual)
// - top-frame edition/embedded pages: service-worker message transport
const fs = require('fs');
const vm = require('vm');
const { JSDOM } = require('jsdom');

let failures = 0;
const check = (n, c, e) => { if (c) console.log('PASS:', n); else { failures++; console.log('FAIL:', n, e !== undefined ? JSON.stringify(e) : ''); } };
const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rawSrc = (pid) => `https://books.google.com/books/content?id=B1&pg=${pid}&img=1&zoom=3&sig=${pid.toLowerCase()}&w=600`;
const API_URLS = ['PA1', 'PA2', 'PA3'].map((pid) =>
  `https://books.google.com/books/content?id=B1&pg=${pid}&img=1&zoom=3&sig=${pid.toLowerCase()}&w=10000`);

// fetch implementation factory for the in-frame same-origin walk
function click3Fetch(opts) {
  const pids = opts.pids;                 // e.g. ['PA1','PA2','PA3','PA4']
  const srcPids = new Set(opts.srcPids || []); // pids that carry a preview src
  const failFirst = new Map(opts.failFirst || []); // pid -> number of failing attempts before success
  const alwaysFail = new Set(opts.alwaysFail || []);
  const counts = {};
  const fetchFn = async (url) => {
    const u = new URL(url);
    const pg = u.searchParams.get('pg');
    counts[pg] = (counts[pg] || 0) + 1;
    const json = (page) => ({
      ok: true, status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ page })
    });
    if (pg === '1') {
      return json(pids.map((pid) => ({ pid, src: pid === pids[0] && srcPids.has(pid) ? rawSrc(pid) : null })));
    }
    if (alwaysFail.has(pg) || (failFirst.has(pg) && counts[pg] <= failFirst.get(pg))) {
      return { ok: false, status: 429, headers: { get: () => null }, text: async () => '' };
    }
    return json([{ pid: pg, src: srcPids.has(pg) ? rawSrc(pg) : null }]);
  };
  fetchFn.counts = counts;
  return fetchFn;
}

function makeHarness(pageUrl, fetchImpl) {
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
  let scanBehavior = { type: 'ok' };
  let deferredScan = null;
  let pageSrcByPid = {};
  let pageFailPids = new Set();
  let lastJobNote = '';
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
            totalPages: scanBehavior.totalPages || 0,
            availablePages: (scanBehavior.urls || []).length,
            failedPages: scanBehavior.failedPages || 0
          };
        }
        if (msg.type === 'WTPDF_GBOOKS_PAGE') {
          if (pageFailPids.has(msg.pid)) return { ok: false, error: 'HTTP 429' };
          const src = pageSrcByPid[msg.pid];
          return src ? { ok: true, pid: msg.pid, src } : { ok: false, error: 'not previewable' };
        }
        if (msg.type === 'WTPDF_URLS') {
          // capture the final on-screen note before the run tears its UI down
          lastJobNote = window.document.querySelector('.wtpdf-msg')
            ? window.document.querySelector('.wtpdf-msg').textContent : '';
          return { ok: true };
        }
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
  // same-origin fetch used by the in-frame reader path
  window.fetch = fetchImpl || (async () => { throw new Error('fetch not mocked'); });
  window.AbortController = AbortController;
  window.__wtpdfTimings = {
    poll: 1, clickTimeout: 30, settle: 1, stuckLimit: 2, maxPages: 5,
    manualRescan: 1, gbookManualPoll: 5,
    gbookPause: 1, gbookBackoff: [1, 1, 1], gbookRounds: 3, gbookTimeout: 1000
  };

  const code = fs.readFileSync(__dirname + '/../src/popup/popup.js', 'utf8');
  const start = code.indexOf('async function probeBookFrame');
  vm.runInContext(code.slice(start), ctx, { filename: 'popup.js' });

  return {
    window, img, messages,
    setPageSrc(map, fails = []) { pageSrcByPid = map; pageFailPids = new Set(fails); },
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
    pageJobs: () => messages.filter((m) => m.type === 'WTPDF_GBOOKS_PAGE'),
    cancelJobs: () => messages.filter((m) => m.type === 'WTPDF_GBOOKS_CANCEL'),
    getLastJobNote: () => lastJobNote
  };
}

(async () => {
  // ========== A. in-frame reader on books.google.*: same-origin walk ==========
  {
    const fetchImpl = click3Fetch({ pids: ['PA1', 'PA2', 'PA3', 'PA4'], srcPids: ['PA1', 'PA2', 'PA3'] });
    const h = makeHarness('https://books.google.com/books?id=B1&pg=PA1&jscmd=click3', fetchImpl);
    h.window.document.body.appendChild(h.img('https://books.google.com/books/content?id=B1&pg=PA1&zoom=2&tid=0'));
    const res = await h.window.eval('scrapeAndSend("book.pdf", "auto")');
    check('in-frame auto: walk resolves all previewable pages', res && res.count === 3, res);
    check('in-frame auto: no service-worker scan message', h.scanJobs().length === 0, h.scanJobs().length);
    const job = h.urlJobs()[0];
    check('in-frame auto: urls ordered and full resolution', h.urlJobs().length === 1 &&
      JSON.stringify(job.urls) === JSON.stringify(API_URLS), job && job.urls);
    check('in-frame auto: DOM tiles excluded', !job.urls.some((u) => u.includes('tid=')));
    check('in-frame auto: ending note reports the non-previewable page',
      /غیرقابل‌پیش‌نمایش/.test(h.getLastJobNote()), h.getLastJobNote());
    check('in-frame auto: UI cleaned up', !h.window.document.querySelector('.wtpdf-root'));
  }

  // ========== B. in-frame walk retries transient failures ==========
  {
    const fetchImpl = click3Fetch({
      pids: ['PA1', 'PA2'], srcPids: ['PA1', 'PA2'], failFirst: [['PA2', 2]]
    });
    const h = makeHarness('https://books.google.com/books?id=B1', fetchImpl);
    const res = await h.window.eval('scrapeAndSend("book.pdf", "auto")');
    check('retry: flaky page recovered inside the frame', res && res.count === 2, res);
  }

  // ========== C. in-frame walk gives up after the round limit ==========
  {
    const fetchImpl = click3Fetch({
      pids: ['PA1', 'PA2'], srcPids: ['PA1'], alwaysFail: ['PA2']
    });
    const h = makeHarness('https://books.google.com/books?id=B1', fetchImpl);
    const res = await h.window.eval('scrapeAndSend("book.pdf", "auto")');
    check('dead page: previewable page kept', res && res.count === 1, res);
    check('dead page: failed exactly after three rounds', fetchImpl.counts.PA2 === 3, fetchImpl.counts.PA2);
  }

  // ========== D. in-frame manual mode: real floating panel, one fetch per turned page ==========
  {
    const fetchImpl = click3Fetch({ pids: ['PA1', 'PA2', 'PA3'], srcPids: ['PA1', 'PA2', 'PA3'] });
    const h = makeHarness('https://books.google.com/books?id=B1&pg=PA1', fetchImpl);
    const originalPushState = h.window.history.pushState;
    const originalReplaceState = h.window.history.replaceState;
    const running = h.window.eval('scrapeAndSend("book.pdf", "manual")');
    await tick();
    await tick();
    check('in-frame manual: floating panel, not the dark overlay',
      !!h.window.document.querySelector('.wtpdf-manual') && !h.window.document.querySelector('.wtpdf-overlay'));
    check('in-frame manual: no bulk SW scan', h.scanJobs().length === 0 && h.pageJobs().length === 0);
    check('in-frame manual: first page grabbed immediately',
      h.window.document.querySelector('.wtpdf-count').textContent === '1 تصویر جمع شد');

    h.window.history.replaceState(null, '', 'https://books.google.com/books?id=B1&pg=PA2');
    await sleep(30);
    check('in-frame manual: turning page adds the second image',
      h.window.document.querySelector('.wtpdf-count').textContent === '2 تصویر جمع شد');
    h.window.history.replaceState(null, '', 'https://books.google.com/books?id=B1&pg=PA3');
    await sleep(30);
    check('in-frame manual: third page added',
      h.window.document.querySelector('.wtpdf-count').textContent === '3 تصویر جمع شد');

    h.window.document.querySelector('.wtpdf-done').click();
    const res = await running;
    check('in-frame manual: Done returns viewed pages in order',
      res && res.count === 3 && JSON.stringify(h.urlJobs()[0].urls) === JSON.stringify(API_URLS), res);
    check('in-frame manual: panel removed', !h.window.document.querySelector('.wtpdf-root'));
    check('in-frame manual: history hooks restored exactly',
      h.window.history.pushState === originalPushState && h.window.history.replaceState === originalReplaceState);
  }

  // ========== E. in-frame manual recovers a transient fetch error by polling ==========
  {
    const flaky = click3Fetch({ pids: ['PA1'], srcPids: ['PA1'], failFirst: [['PA1', 2]] });
    const h = makeHarness('https://books.google.com/books?id=B1&pg=PA1', flaky);
    const running = h.window.eval('scrapeAndSend("book.pdf", "manual")');
    await sleep(40);
    h.window.document.querySelector('.wtpdf-done').click();
    const res = await running;
    check('in-frame manual: failed current page retried and recovered', res && res.count === 1, res);
  }

  // ========== F. in-frame ESC cancels the local walk without creating a job ==========
  {
    let release;
    const blocked = new Promise((r) => { release = r; });
    const hanging = async () => { await blocked; throw new Error('should not resolve'); };
    const h = makeHarness('https://books.google.com/books?id=B1', hanging);
    const running = h.window.eval('scrapeAndSend("book.pdf", "auto")');
    await tick();
    h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    release();
    const res = await running;
    check('in-frame ESC: cancelled result', res && res.cancelled === true, res);
    check('in-frame ESC: no URL job', h.urlJobs().length === 0);
  }

  // ========== G. local walk failure falls back to SW, then DOM ==========
  {
    const h = makeHarness('https://books.google.com/books?id=B1', async () => { throw new Error('offline'); });
    h.window.document.body.appendChild(h.img('https://books.google.com/books/content?id=B1&pg=PA1&zoom=2&tid=0'));
    h.setScanBehavior({ type: 'fail', error: 'HTTP 500' });
    const res = await h.window.eval('scrapeAndSend("book.pdf", "auto")');
    check('fallback: SW scan attempted after local failure', h.scanJobs().length === 1);
    check('fallback: DOM tile collected when both dedicated paths fail', res && res.count === 1, res);
  }

  // ========== H. top-frame edition page uses the service-worker transport ==========
  {
    const h = makeHarness('https://www.google.com/books/edition/A_Textbook_of_Electronic_Circuits/4ciReKlOVHIC?hl=en&gbpv=1');
    const deferred = h.deferScan();
    const running = h.window.eval('scrapeAndSend("book.pdf", "auto")');
    await tick();
    check('edition: full-screen overlay shown during the SW walk',
      !!h.window.document.querySelector('.wtpdf-overlay') && !h.window.document.querySelector('.wtpdf-manual'));
    deferred.resolve({ ok: true, urls: API_URLS, totalPages: 4, availablePages: 3, failedPages: 1 });
    const res = await running;
    check('edition: SW walk used', h.scanJobs().length === 1 && res && res.count === 3, res);
  }

  // ========== I. manual mode on a top-frame edition page degrades to the SW auto walk ==========
  {
    const h = makeHarness('https://www.google.com/books/edition/Some_Book/B1abcdef');
    const deferred = h.deferScan();
    const running = h.window.eval('scrapeAndSend("book.pdf", "manual")');
    await tick();
    check('edition manual: degraded to overlay walk (no floating panel)',
      !!h.window.document.querySelector('.wtpdf-overlay') && !h.window.document.querySelector('.wtpdf-manual'));
    deferred.resolve({ ok: true, urls: API_URLS.slice(0, 2), totalPages: 2, availablePages: 2 });
    const res = await running;
    check('edition manual: SW walk still runs', h.scanJobs().length === 1 && res.count === 2, res);
  }

  // ========== J. embedded iframe reader on a foreign page uses the SW walk ==========
  {
    const h = makeHarness('https://example.com/article');
    const frame = h.window.document.createElement('iframe');
    frame.src = 'https://books.google.com/books?id=EMBED99&output=embed';
    h.window.document.body.appendChild(frame);
    const deferred = h.deferScan();
    const running = h.window.eval('scrapeAndSend("book.pdf", "manual")');
    await tick();
    check('embedded: manual degrades to overlay walk (no floating panel)',
      !!h.window.document.querySelector('.wtpdf-overlay') && !h.window.document.querySelector('.wtpdf-manual'));
    deferred.resolve({ ok: true, urls: API_URLS.slice(0, 1), totalPages: 1, availablePages: 1 });
    const res = await running;
    check('embedded: SW walk resolves the book', res && res.count === 1, res);
  }

  // ========== K. unrelated pages never take a Google Books path ==========
  {
    const h = makeHarness('https://comic.test/episode/9');
    h.window.document.body.appendChild(h.img('https://cdn.test/page.jpg', 300, 420));
    const res = await h.window.eval('scrapeAndSend("comic.pdf", "auto")');
    check('non-GB: no scan message', h.scanJobs().length === 0);
    check('non-GB: ordinary DOM collection works', res && res.count === 1 && h.urlJobs().length === 1, res);
    h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    check('non-GB: no stray cancel control message', h.cancelJobs().length === 0, h.cancelJobs().length);
  }

  // ========== L. frame probe identifies only the books.google.* reader frame ==========
  {
    const reader = makeHarness('https://books.google.com/books?id=B1&output=embed');
    const probeReader = await reader.window.eval('probeBookFrame()');
    check('probe: reader frame detected', probeReader.isReader === true && probeReader.id === 'B1', probeReader);
    const plain = makeHarness('https://www.google.com/books/edition/Title/B1abcdef');
    const probePlain = await plain.window.eval('probeBookFrame()');
    check('probe: edition top frame is not itself a reader frame', probePlain.isReader === false, probePlain);
    const other = makeHarness('https://comic.test/ep');
    const probeOther = await other.window.eval('probeBookFrame()');
    check('probe: unrelated frame not detected', probeOther.isReader === false, probeOther);
  }

  // ========== M. in-frame walk honors the page limit ==========
  {
    const fetchImpl = click3Fetch({ pids: ['PA1', 'PA2', 'PA3', 'PA4'], srcPids: ['PA1', 'PA2', 'PA3'] });
    const h = makeHarness('https://books.google.com/books?id=B1', fetchImpl);
    const res = await h.window.eval('scrapeAndSend("book.pdf", "auto", { pageLimit: 2 })');
    check('limit: walk stops after two collected pages', res && res.count === 2, res);
    check('limit: ending note mentions the cap', /سقف/.test(h.getLastJobNote()), h.getLastJobNote());
  }

  // ========== N. manual mode stops adding after the cap ==========
  {
    const fetchImpl = click3Fetch({ pids: ['PA1', 'PA2', 'PA3'], srcPids: ['PA1', 'PA2', 'PA3'] });
    const h = makeHarness('https://books.google.com/books?id=B1&pg=PA1', fetchImpl);
    const running = h.window.eval('scrapeAndSend("book.pdf", "manual", { pageLimit: 2 })');
    await tick();
    h.window.history.replaceState(null, '', 'https://books.google.com/books?id=B1&pg=PA2');
    await sleep(30);
    h.window.history.replaceState(null, '', 'https://books.google.com/books?id=B1&pg=PA3');
    await sleep(30);
    check('manual cap: counter shows the cap message',
      /سقف\s*2/.test(h.window.document.querySelector('.wtpdf-count').textContent),
      h.window.document.querySelector('.wtpdf-count').textContent);
    h.window.document.querySelector('.wtpdf-done').click();
    const res = await running;
    check('manual cap: only two images collected', res && res.count === 2, res);
  }

  // ========== O. manual CSS selector drives the next-button click ==========
  {
    const h = makeHarness('https://comic.test/episode/1');
    const page1 = h.img('https://cdn.test/page-1.jpg', 300, 420);
    h.window.document.body.appendChild(page1);
    // decoy "previous" button the heuristics must ignore
    const prev = h.window.document.createElement('button');
    prev.setAttribute('aria-label', 'Previous page');
    prev.textContent = '‹';
    h.window.document.body.appendChild(prev);
    // unlabeled control that only the manual selector can identify
    const next = h.window.document.createElement('div');
    next.className = 'my-next-control';
    next.setAttribute('role', 'button');
    next.textContent = '›';
    let clicks = 0;
    next.addEventListener('click', () => {
      clicks++;
      if (clicks === 1) h.window.document.body.appendChild(h.img('https://cdn.test/page-2.jpg', 300, 420));
    });
    h.window.document.body.appendChild(next);
    const res = await h.window.eval('scrapeAndSend("c.pdf", "auto", { nextSelector: ".my-next-control" })');
    check('next selector: chosen control was clicked', clicks >= 1, clicks);
    check('next selector: both pages collected', res && res.count === 2, res);
  }

  // ========== P. image CSS selector restricts collection; bad selector falls back ==========
  {
    const h = makeHarness('https://comic.test/episode/2');
    const comic = h.window.document.createElement('div');
    comic.className = 'comic';
    comic.appendChild(h.img('https://cdn.test/comic-1.jpg', 300, 420));
    comic.appendChild(h.img('https://cdn.test/comic-2.jpg', 300, 420));
    h.window.document.body.appendChild(comic);
    // decoy big image outside the container that generic scanning would collect
    h.window.document.body.appendChild(h.img('https://cdn.test/banner-ad.jpg', 500, 300));

    const targeted = await h.window.eval('scrapeAndSend("c.pdf", "scroll", { imageSelector: ".comic img" })');
    const job1 = h.urlJobs().slice(-1)[0];
    check('image selector: only selector matches collected', targeted && targeted.count === 2 &&
      job1.urls.every((u) => u.includes('comic-')), job1 && job1.urls);

    // a selector matching nothing must transparently fall back to the generic scanner
    const h2 = makeHarness('https://comic.test/episode/3');
    h2.window.document.body.appendChild(h2.img('https://cdn.test/only.jpg', 300, 420));
    const fallback = await h2.window.eval('scrapeAndSend("c.pdf", "scroll", { imageSelector: ".nope-missing" })');
    check('image selector: unmatched selector falls back to generic scan', fallback && fallback.count === 1, fallback);

    // an invalid selector string must not throw and must fall back too
    const h3 = makeHarness('https://comic.test/episode/4');
    h3.window.document.body.appendChild(h3.img('https://cdn.test/only2.jpg', 300, 420));
    const invalid = await h3.window.eval('scrapeAndSend("c.pdf", "scroll", { imageSelector: "!!!bad selector(((" })');
    check('image selector: invalid selector falls back without throwing', invalid && invalid.count === 1, invalid);
  }

  // ========== Q. pushState SPA navigation is captured by the history hook ==========
  {
    const fetchImpl = click3Fetch({ pids: ['PA1', 'PA2'], srcPids: ['PA1', 'PA2'] });
    const h = makeHarness('https://books.google.com/books?id=B1&pg=PA1', fetchImpl);
    const running = h.window.eval('scrapeAndSend("book.pdf", "manual")');
    await tick();
    await tick();
    h.window.history.pushState({}, '', 'https://books.google.com/books?id=B1&pg=PA2');
    await sleep(30);
    check('pushState: SPA page turn is grabbed without a reload',
      h.window.document.querySelector('.wtpdf-count').textContent.startsWith('2'),
      h.window.document.querySelector('.wtpdf-count').textContent);
    check('panel: status line reports the current pid',
      /PA2/.test(h.window.document.querySelector('.wtpdf-gb-status').textContent));
    h.window.document.querySelector('.wtpdf-done').click();
    await running;
  }

  // ========== R. hash-based navigation + pid fallback when click3 renames the pid ==========
  {
    const fetchImpl = click3Fetch({ pids: ['PA1', 'PA2'], srcPids: ['PA1', 'PA2'] });
    // URL has no pg query: detectPid falls back to '1', and the click3 response names the page 'PA1'
    const h = makeHarness('https://books.google.com/books?id=B1', fetchImpl);
    const running = h.window.eval('scrapeAndSend("book.pdf", "manual")');
    await tick();
    await tick();
    check('pid fallback: first page resolved despite pid rename',
      h.window.document.querySelector('.wtpdf-count').textContent.startsWith('1'));
    h.window.location.hash = 'pg=PA2';
    await sleep(30);
    check('hashchange: page turn via hash is captured',
      h.window.document.querySelector('.wtpdf-count').textContent.startsWith('2'),
      h.window.document.querySelector('.wtpdf-count').textContent);
    h.window.document.querySelector('.wtpdf-done').click();
    await running;
  }

  // ========== S. force-grab button recovers a failed initial pickup; diagnostics copy works ==========
  {
    // controllable fetch: fails until the test flips the flag, so the error state stays observable
    let shouldFail = true;
    const controlled = async (url) => {
      const u = new URL(url);
      const pg = u.searchParams.get('pg');
      const json = (page) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ page }) });
      if (pg === '1') return json([{ pid: 'PA1', src: shouldFail ? null : rawSrc('PA1') }]);
      if (shouldFail) return { ok: false, status: 500, headers: { get: () => null }, text: async () => '' };
      return json([{ pid: pg, src: rawSrc(pg) }]);
    };
    const h = makeHarness('https://books.google.com/books?id=B1&pg=PA1', controlled);
    let copied = '';
    h.window.navigator.clipboard = { writeText: async (t) => { copied = t; } };
    const running = h.window.eval('scrapeAndSend("book.pdf", "manual")');
    await sleep(30);
    check('error line: failed pickup is surfaced in the panel',
      !h.window.document.querySelector('.wtpdf-gb-error').classList.contains('hidden'),
      h.window.document.querySelector('.wtpdf-gb-error').textContent);
    const grabNow = [...h.window.document.querySelectorAll('.wtpdf-mini-btn')]
      .find((b) => b.textContent.includes('برداشتن'));
    shouldFail = false;
    grabNow.click();
    await sleep(30);
    check('force grab: manual button recovers the failed page',
      h.window.document.querySelector('.wtpdf-count').textContent.startsWith('1'));
    const diag = [...h.window.document.querySelectorAll('.wtpdf-mini-btn')]
      .find((b) => b.textContent.includes('عیب‌یابی'));
    diag.click();
    await tick();
    const payload = JSON.parse(copied);
    check('diagnostics: clipboard payload carries href, pid and error state',
      payload.href.includes('id=B1') && payload.detectedPid === 'PA1' && 'lastError' in payload, payload);
    h.window.document.querySelector('.wtpdf-done').click();
    await running;
  }

  // ========== T. reader without pg in URL: page turns are detected from the DOM content image ==========
  {
    const fetchImpl = click3Fetch({ pids: ['PA1', 'PA7'], srcPids: ['PA1', 'PA7'] });
    // real-world shape from user diagnostics: no pg query, only a v=onepage hash
    const h = makeHarness('https://books.google.com/books?id=4ciReKlOVHIC&hl=en#v=onepage&q&f=false', fetchImpl);
    let copied = '';
    h.window.navigator.clipboard = { writeText: async (t) => { copied = t; } };
    const running = h.window.eval('scrapeAndSend("book.pdf", "manual")');
    await sleep(30);
    check('dom-less start: first page still collected via pg=1 listing',
      h.window.document.querySelector('.wtpdf-count').textContent.startsWith('1'));
    check('status: source label says DOM when URL carries no pg',
      /DOM/.test(h.window.document.querySelector('.wtpdf-gb-status').textContent),
      h.window.document.querySelector('.wtpdf-gb-status').textContent);
    // reader swaps the visible content image without touching the URL
    const pageImg = h.window.document.createElement('img');
    pageImg.setAttribute('src', rawSrc('PA7'));
    h.window.document.body.appendChild(pageImg);
    await sleep(350); // MutationObserver + 250ms debounce
    check('dom turn: new page grabbed after the content image changed',
      h.window.document.querySelector('.wtpdf-count').textContent.startsWith('2'),
      h.window.document.querySelector('.wtpdf-count').textContent);
    check('status: current pid follows the DOM image',
      /PA7/.test(h.window.document.querySelector('.wtpdf-gb-status').textContent));
    // diagnostics expose the DOM-derived pid and the reader media sample
    [...h.window.document.querySelectorAll('.wtpdf-mini-btn')]
      .find((b) => b.textContent.includes('عیب‌یابی')).click();
    await tick();
    const payload = JSON.parse(copied);
    check('diagnostics: domPid and readerMedia captured',
      payload.domPid === 'PA7' && payload.readerMedia.some((s) => s.includes('pg=PA7')), payload);
    h.window.document.querySelector('.wtpdf-done').click();
    await running;
  }

  // ========== U. visible content image wins over a hidden preloaded one; data-pid fallback works ==========
  {
    const fetchImpl = click3Fetch({ pids: ['PA1', 'PA8', 'PA9'], srcPids: ['PA1', 'PA8', 'PA9'] });
    const h = makeHarness('https://books.google.com/books?id=B1#v=onepage', fetchImpl);
    const running = h.window.eval('scrapeAndSend("book.pdf", "manual")');
    await sleep(30);
    const hidden = h.window.document.createElement('img');
    hidden.setAttribute('src', rawSrc('PA9')); // preloaded next page, off-screen
    hidden.getBoundingClientRect = () => ({ width: 10, height: 10, top: 9000, left: 0, right: 10, bottom: 9010 });
    const visible = h.window.document.createElement('img');
    visible.setAttribute('src', rawSrc('PA8')); // currently displayed page
    visible.getBoundingClientRect = () => ({ width: 300, height: 420, top: 0, left: 0, right: 300, bottom: 420 });
    h.window.document.body.append(hidden, visible);
    await sleep(350);
    check('visibility: displayed page pid preferred over the preloaded one',
      /PA8/.test(h.window.document.querySelector('.wtpdf-gb-status').textContent),
      h.window.document.querySelector('.wtpdf-gb-status').textContent);
    check('visibility: only the displayed page was grabbed',
      h.window.document.querySelector('.wtpdf-count').textContent.startsWith('2'),
      h.window.document.querySelector('.wtpdf-count').textContent);
    h.window.document.querySelector('.wtpdf-done').click();
    await running;
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL GBOOKS POPUP TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(2); });
