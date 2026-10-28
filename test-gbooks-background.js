// Tests for the Google Books jscmd=click3 walker in background.js (mocked chrome.* + fetch).
const fs = require('fs');
const vm = require('vm');

let failures = 0;
const check = (n, c, e) => { if (c) console.log('PASS:', n); else { failures++; console.log('FAIL:', n, e !== undefined ? JSON.stringify(e) : ''); } };
const tick = () => new Promise((r) => setTimeout(r, 0));
// the walker paces requests with real 120ms pauses, so poll for the async response
const waitFor = async (fn, timeout = 3000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return fn();
};

function contentUrl(pid, sig) {
  return `https://books.google.com/books/content?id=B1&pg=${pid}&img=1&zoom=3&hl=en&sig=${sig}&w=600`;
}

function bootBackground(fetchImpl) {
  const store = new Map();
  const listeners = {};
  const fetchCalls = [];
  // each requested pid resolves itself; PA4 intentionally stays null (non-previewable page)
  const srcByPid = { PA1: contentUrl('PA1', 'sig1'), PA2: contentUrl('PA2', 'sig2'), PA3: contentUrl('PA3', 'sig3') };
  const defaultFetch = async (url) => {
    const u = new URL(url);
    const pg = u.searchParams.get('pg');
    let page;
    if (pg === '1') {
      page = ['PA1', 'PA2', 'PA3', 'PA4'].map((pid) => ({ pid, src: pid === 'PA1' ? srcByPid.PA1 : null }));
    } else {
      page = [{ pid: pg, src: srcByPid[pg] || null }];
      // click3 commonly returns adjacent pages too: PA2 response carries PA3 as a bonus
      if (pg === 'PA2') page.push({ pid: 'PA3', src: srcByPid.PA3 });
    }
    const body = (pg === 'PA2' ? ")]}'\n" : '') + JSON.stringify({ page });
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => body };
  };
  const fetchMock = async (url) => {
    fetchCalls.push(url);
    return (fetchImpl || defaultFetch)(url);
  };
  const chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { listeners.message = fn; } },
      onStartup: { addListener: (fn) => { listeners.startup = fn; } },
      onInstalled: { addListener: (fn) => { listeners.installed = fn; } },
      lastError: null,
      getURL: (p) => 'chrome-extension://ext/' + p
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async (o) => Object.entries(o).forEach(([k, v]) => store.set(k, v)),
        remove: async () => {}
      }
    },
    tabs: {
      create: (opts, cb) => cb({ id: 42 }),
      update: (id, patch, cb) => cb(),
      sendMessage: async () => ({})
    }
  };
  const ctx = {
    chrome, console, URL, setTimeout, clearTimeout, Math, Date, Promise,
    AbortController, fetch: fetchMock
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(__dirname + '/background.js', 'utf8'), ctx, { filename: 'background.js' });
  return { ctx, listeners, fetchCalls };
}

(async () => {
  const b = bootBackground();

  // 1. book id parsing: old and new URL shapes
  check('id from old ?id= URL', b.ctx.parseGoogleBooksId('https://books.google.com/books?id=abc123XYZ&pg=PA1') === 'abc123XYZ');
  check('id from edition URL', b.ctx.parseGoogleBooksId('https://www.google.com/books/edition/A_Textbook/4ciReKlOVHIC?hl=en&gbpv=1') === '4ciReKlOVHIC');
  check('id null for unrelated URL', b.ctx.parseGoogleBooksId('https://comic.test/episode/1') === null);
  check('id null for malformed edition segment', b.ctx.parseGoogleBooksId('https://www.google.com/books/edition/Title/ab') === null);

  // 2. origin selection
  check('origin keeps books country domain', b.ctx.googleBooksOrigin('https://books.google.co.uk/books?id=x') === 'https://books.google.co.uk');
  check('origin falls back to global .com', b.ctx.googleBooksOrigin('https://www.google.com/books/edition/T/abcdef') === 'https://books.google.com');

  // 3. src normalization to max width
  check('src w param replaced', b.ctx.normalizeGoogleBooksSrc('https://x.test/c?w=600') === 'https://x.test/c?w=10000');
  check('src w param appended when absent', b.ctx.normalizeGoogleBooksSrc('https://x.test/c?zoom=3') === 'https://x.test/c?zoom=3&w=10000');
  check('protocol-relative src made https', b.ctx.normalizeGoogleBooksSrc('//books.google.com/c?w=10').startsWith('https://books.google.com/'));

  // 4. anti-hijack prefix tolerated
  const parsed = b.ctx.parseGoogleBooksJson(")]}'\n{\"page\":[]}");
  check('anti-hijack prefix stripped before JSON.parse', Array.isArray(parsed.page) && parsed.page.length === 0);

  // 5. full walk: order kept, adjacent bonus applied, unresolvable page skipped, width bumped
  const result = await b.ctx.walkGoogleBooks('https://books.google.com/books?id=B1', null, null);
  check('walk returns 3 available of 4 total', result.availablePages === 3 && result.totalPages === 4, result);
  check('walk reports the unresolvable page count', result.failedPages === 1, result);
  check('walk preserves page order', result.urls.every((u, i) => u.includes(`pg=PA${i + 1}`)), result.urls);
  check('walk requests max resolution (w=10000)', result.urls.every((u) => /[?&]w=10000/.test(u)), result.urls);
  check('walk skipped the non-previewable PA4', !result.urls.some((u) => u.includes('pg=PA4')));
    // initial call plus one request per unresolved pid (the empty PA4 is asked exactly once)
    check('walk queried initial plus unresolved pids only', b.fetchCalls.length === 3, b.fetchCalls.length);
  check('walk used click3 endpoint', b.fetchCalls.every((u) => u.includes('jscmd=click3')));

  // 5a. page limit stops the walk after N collected pages (for very long books)
  {
    const bl = bootBackground();
    const limited = await bl.ctx.walkGoogleBooks('https://books.google.com/books?id=B1', null, null, 2);
    check('limit: only two pages returned', limited.availablePages === 2 && limited.urls.length === 2, limited);
    check('limit: limited flag set and order preserved', limited.limited === true &&
      limited.urls[0].includes('pg=PA1') && limited.urls[1].includes('pg=PA2'), limited);
    check('limit: no requests beyond what the cap needs', bl.fetchCalls.length <= 3, bl.fetchCalls.length);

    let response = null;
    bl.listeners.message(
      { type: 'WTPDF_GBOOKS_SCAN', pageUrl: 'https://books.google.com/books?id=B1', pageLimit: 1 },
      { tab: { id: 31 } },
      (r) => { response = r; }
    );
    await waitFor(() => response !== null);
    check('limit: SCAN message honors pageLimit', response && response.ok && response.urls.length === 1 &&
      response.limited === true, response);

    // zero/garbage limit means unlimited
    const full = await bl.ctx.walkGoogleBooks('https://books.google.com/books?id=B1', null, null, 0);
    check('limit: zero means unlimited', full.availablePages === 3, full);
  }

  // 5b. transient failures are retried with backoff instead of dropping the page
  {
    const flaky = (url) => {
      const u = new URL(url);
      const pg = u.searchParams.get('pg');
      flaky.attempts = (flaky.attempts || 0) + 1;
      const json = (page) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ page }) });
      if (pg === '1') return json([{ pid: 'PA1', src: contentUrl('PA1', 's1') }, { pid: 'PA2', src: null }]);
      // PA2 fails twice (one 500, one 429 with Retry-After: 0) then succeeds
      if (pg === 'PA2') {
        flaky.pa2 = (flaky.pa2 || 0) + 1;
        if (flaky.pa2 === 1) return { ok: false, status: 500, headers: { get: () => null }, text: async () => '' };
        if (flaky.pa2 === 2) return { ok: false, status: 429, headers: { get: (h) => h === 'Retry-After' ? '0' : null }, text: async () => '' };
        return json([{ pid: 'PA2', src: contentUrl('PA2', 's2') }]);
      }
      return json([{ pid: pg, src: null }]);
    };
    const bf = bootBackground(flaky);
    vm.runInContext('GB_BACKOFF_MS = [1, 1, 1]; GB_REQUEST_PAUSE_MS = 1;', bf.ctx);
    const r = await bf.ctx.walkGoogleBooks('https://books.google.com/books?id=B1', null, null);
    check('retry: flaky page recovered after transient HTTP errors', r.availablePages === 2 && r.failedPages === 0, r);
    check('retry: page was attempted more than once', flaky.pa2 === 3, flaky.pa2);
  }

  // 5c. a page that always fails is retried across rounds then reported as failed (not silently partial)
  {
    const dead = (url) => {
      const u = new URL(url);
      const pg = u.searchParams.get('pg');
      dead.counts = dead.counts || {};
      dead.counts[pg] = (dead.counts[pg] || 0) + 1;
      const json = (page) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ page }) });
      if (pg === '1') return json([{ pid: 'PA1', src: contentUrl('PA1', 's1') }, { pid: 'PA2', src: null }]);
      return { ok: false, status: 500, headers: { get: () => null }, text: async () => '' };
    };
    const bd = bootBackground(dead);
    vm.runInContext('GB_BACKOFF_MS = [1, 1, 1]; GB_REQUEST_PAUSE_MS = 1;', bd.ctx);
    const r = await bd.ctx.walkGoogleBooks('https://books.google.com/books?id=B1', null, null);
    check('dead page: available page kept', r.availablePages === 1 && r.failedPages === 1, r);
    check('dead page: retried for three rounds before giving up', dead.counts.PA2 === 3, dead.counts);
  }

  // 5d. single-page resolver used by manual mode
  {
    const bp = bootBackground();
    let response = null;
    bp.listeners.message(
      { type: 'WTPDF_GBOOKS_PAGE', pageUrl: 'https://books.google.com/books?id=B1', pid: 'PA2' },
      { tab: { id: 20 } },
      (r) => { response = r; }
    );
    await waitFor(() => response !== null);
    check('single page: normalized full-res src returned', response && response.ok && response.pid === 'PA2' &&
      /[?&]w=10000/.test(response.src) && response.src.includes('pg=PA2'), response);

    let blocked = null;
    bp.listeners.message(
      { type: 'WTPDF_GBOOKS_PAGE', pageUrl: 'https://books.google.com/books?id=B1', pid: 'PA4' },
      { tab: { id: 20 } },
      (r) => { blocked = r; }
    );
    await waitFor(() => blocked !== null);
    check('single page: non-previewable pid reported cleanly', blocked && blocked.ok === false, blocked);

    // pg=1 listing names the page internally as PA1; resolver must fall back to the src-bearing entry
    let renamed = null;
    bp.listeners.message(
      { type: 'WTPDF_GBOOKS_PAGE', pageUrl: 'https://books.google.com/books?id=B1', pid: '1' },
      { tab: { id: 21 } },
      (r) => { renamed = r; }
    );
    await waitFor(() => renamed !== null);
    check('single page: pid rename tolerated via first src entry',
      renamed && renamed.ok === true && renamed.src.includes('pg=PA1') && /w=10000/.test(renamed.src), renamed);
  }

  // 6. message handler: SCAN responds via sendResponse with the url list
  {
    const b2 = bootBackground();
    let response = null;
    const keepOpen = b2.listeners.message(
      { type: 'WTPDF_GBOOKS_SCAN', pageUrl: 'https://books.google.com/books?id=B1' },
      { tab: { id: 9, url: 'https://books.google.com/books?id=B1' } },
      (r) => { response = r; }
    );
    check('SCAN listener keeps the message channel open', keepOpen === true);
    await waitFor(() => response !== null);
    check('SCAN response ok with ordered urls', response && response.ok === true && response.urls.length === 3 &&
      response.urls[0].includes('pg=PA1'), response);
  }

  // 7. cancel message stops a subsequent scan
  {
    const b3 = bootBackground();
    b3.listeners.message({ type: 'WTPDF_GBOOKS_CANCEL' }, { tab: { id: 11 } }, (r) => {
      check('CANCEL responds immediately', r && r.ok === true);
    });
    let response = null;
    b3.listeners.message(
      { type: 'WTPDF_GBOOKS_SCAN', pageUrl: 'https://books.google.com/books?id=B1' },
      { tab: { id: 11 } },
      (r) => { response = r; }
    );
    await waitFor(() => response !== null);
    check('cancelled scan reports failure with cancelled flag', response && response.ok === false && response.cancelled === true, response);
  }

  // 8. a book id that cannot be parsed yields a clean error
  {
    const b4 = bootBackground();
    let response = null;
    b4.listeners.message(
      { type: 'WTPDF_GBOOKS_SCAN', pageUrl: 'https://example.com/no-book' },
      { tab: { id: 12 } },
      (r) => { response = r; }
    );
    await waitFor(() => response !== null);
    check('unknown URL shape returns ok:false', response && response.ok === false && !response.cancelled, response);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL GBOOKS BACKGROUND TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(2); });
