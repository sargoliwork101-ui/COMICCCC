// Tests for the paged-navigation modes of scrapeAndSend(): auto page-turning and manual pickup.
const fs = require('fs');
const vm = require('vm');
const { JSDOM } = require('jsdom');

let failures = 0;
const check = (n, c, e) => { if (c) console.log('PASS:', n); else { failures++; console.log('FAIL:', n, e !== undefined ? JSON.stringify(e) : ''); } };

function makeHarness() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://books.test/read/1?gbpv=1', pretendToBeVisual: true, runScripts: 'dangerously'
  });
  const { window } = dom;
  const ctx = dom.getInternalVMContext();

  // jsdom reports zero-size rectangles by default; give every element a visible rect (per-element overrides win)
  window.Element.prototype.getBoundingClientRect = function () {
    return { width: 120, height: 40, top: 0, left: 0, right: 120, bottom: 40 };
  };

  function img(src, w = 300, h = 420) {
    const el = window.document.createElement('img');
    el.setAttribute('src', src);
    Object.defineProperty(el, 'naturalWidth', { value: w, configurable: true });
    Object.defineProperty(el, 'naturalHeight', { value: h, configurable: true });
    Object.defineProperty(el, 'complete', { value: true, configurable: true });
    el.getBoundingClientRect = () => ({ width: w, height: h, top: 0, left: 0, right: w, bottom: h });
    return el;
  }

  const sent = [];
  window.chrome = { runtime: { sendMessage: async (msg) => { sent.push(msg); return { ok: true }; } } };
  window.scrollTo = () => {};
  window.scrollBy = () => {};
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  // timers run immediately but stay async; interval becomes a single delayed shot so the process can exit
  window.setTimeout = (cb) => global.setTimeout(cb, 0);
  window.setInterval = (cb) => { global.setTimeout(cb, 0); return 1; };
  window.clearInterval = () => {};
  // snappy timings for the navigation state machine
  window.__wtpdfTimings = { poll: 1, clickTimeout: 40, settle: 1, stuckLimit: 2, maxPages: 10, manualRescan: 1 };

  const code = fs.readFileSync(__dirname + '/popup.js', 'utf8');
  const fnCode = code.slice(code.indexOf('async function scrapeAndSend'));
  vm.runInContext(fnCode, ctx, { filename: 'popup.js' });

  const flush = () => new Promise((r) => global.setTimeout(r, 0));
  return { window, ctx, img, sent, flush };
}

(async () => {
  // ---------- 1. auto mode: clicks the next button, picks up every swapped page image ----------
  {
    const h = makeHarness();
    const { window, img, sent, flush } = h;
    const page = img('https://cdn.test/page-1.jpg');
    window.document.body.appendChild(page);
    // a thumbnail-strip image must stay filtered out by the size rule
    const thumb = img('https://cdn.test/thumb-1.jpg', 90, 130);
    window.document.body.appendChild(thumb);
    const next = window.document.createElement('button');
    next.setAttribute('aria-label', 'Next page');
    next.textContent = '›';
    window.document.body.appendChild(next);
    const sequence = ['https://cdn.test/page-2.jpg', 'https://cdn.test/page-3.jpg'];
    next.addEventListener('click', () => {
      if (sequence.length) { page.setAttribute('src', sequence.shift()); thumb.setAttribute('src', 'https://cdn.test/thumb-2.jpg'); }
      else next.setAttribute('aria-disabled', 'true');
    });

    const res = await window.eval('scrapeAndSend("book.pdf", "auto")');
    const urls = sent[0] && sent[0].urls;
    check('auto: one message sent at the end', sent.length === 1, sent.length);
    check('auto: result count is 3', res && res.count === 3, res);
    check('auto: first page collected', urls.includes('https://cdn.test/page-1.jpg'), urls);
    check('auto: swapped page 2 collected', urls.includes('https://cdn.test/page-2.jpg'), urls);
    check('auto: swapped page 3 collected', urls.includes('https://cdn.test/page-3.jpg'), urls);
    check('auto: small thumbnails filtered', !urls.some((u) => u.includes('thumb')), urls);
    check('auto: no duplicate urls', new Set(urls).size === urls.length, urls);
    check('auto: payload metadata', sent[0].type === 'WTPDF_URLS' && sent[0].name === 'book.pdf' &&
      sent[0].pageUrl === 'https://books.test/read/1?gbpv=1', sent[0]);
    check('auto: overlay removed after finish', !window.document.querySelector('.wtpdf-overlay'));
    check('auto: style tag removed after finish', !window.document.querySelector('style'));
    check('auto: running flag reset', window.__wtpdfRunning === false);
  }

  // ---------- 2. auto mode: clicks that never produce a new image end after the stuck limit ----------
  {
    const h = makeHarness();
    const { window, img, sent, flush } = h;
    window.document.body.appendChild(img('https://cdn.test/only.jpg'));
    const next = window.document.createElement('button');
    next.className = 'nav-next';
    next.textContent = 'Next';
    next.addEventListener('click', () => { /* page does not react */ });
    window.document.body.appendChild(next);

    const res = await window.eval('scrapeAndSend("stuck.pdf", "auto")');
    check('stuck: still returns the images found so far', res && res.count === 1, res);
    check('stuck: exactly one message', sent.length === 1, sent.length);
    check('stuck: class-based next button was recognized', sent.length === 1);
  }

  // ---------- 3. auto mode without any next button ends after the initial scan ----------
  {
    const h = makeHarness();
    const { window, img, sent } = h;
    window.document.body.appendChild(img('https://cdn.test/solo.jpg'));
    const res = await window.eval('scrapeAndSend("solo.pdf", "auto")');
    check('no-next: initial image sent', res && res.count === 1 && sent.length === 1, res);
  }

  // ---------- 4. previous/back controls must never be treated as next ----------
  {
    const h = makeHarness();
    const { window, img, sent } = h;
    window.document.body.appendChild(img('https://cdn.test/p.jpg'));
    const prev = window.document.createElement('button');
    prev.setAttribute('aria-label', 'Previous page');
    prev.className = 'back-btn';
    prev.textContent = '‹';
    window.document.body.appendChild(prev);
    const res = await window.eval('scrapeAndSend("prev.pdf", "auto")');
    check('prev: previous button ignored, run ends cleanly', res && res.count === 1 && sent.length === 1, res);
  }

  // ---------- 5. a disabled next button is treated as absent ----------
  {
    const h = makeHarness();
    const { window, img, sent } = h;
    window.document.body.appendChild(img('https://cdn.test/d.jpg'));
    const next = window.document.createElement('button');
    next.setAttribute('aria-label', 'Next page');
    next.setAttribute('aria-disabled', 'true');
    window.document.body.appendChild(next);
    const res = await window.eval('scrapeAndSend("disabled.pdf", "auto")');
    check('disabled: run ends without clicking', res && res.count === 1 && sent.length === 1, res);
  }

  // ---------- 6. rel="next" link is the highest-priority signal ----------
  {
    const h = makeHarness();
    const { window, img, sent } = h;
    const page = img('https://cdn.test/r1.jpg');
    window.document.body.appendChild(page);
    const link = window.document.createElement('a');
    link.setAttribute('rel', 'next');
    link.textContent = '»';
    let clicks = 0;
    link.addEventListener('click', (e) => {
      e.preventDefault();
      clicks++;
      if (clicks === 1) page.setAttribute('src', 'https://cdn.test/r2.jpg');
      else link.style.display = 'none';
    });
    window.document.body.appendChild(link);
    const res = await window.eval('scrapeAndSend("rel.pdf", "auto")');
    check('rel-next: both pages collected via rel=next', res && res.count === 2, res);
    check('rel-next: hidden control stops the loop', sent.length === 1 && clicks === 2, { clicks, sent: sent.length });
  }

  // ---------- 7. manual mode: user turns pages, extension picks images up, Done finishes ----------
  {
    const h = makeHarness();
    const { window, img, sent, flush } = h;
    const page = img('https://cdn.test/m1.jpg');
    window.document.body.appendChild(page);

    const running = window.eval('scrapeAndSend("manual.pdf", "manual")');
    await flush();
    await flush();
    const panel = window.document.querySelector('.wtpdf-manual');
    check('manual: compact panel shown (no full-screen overlay)',
      !!panel && !window.document.querySelector('.wtpdf-overlay'));
    check('manual: done button present', !!window.document.querySelector('.wtpdf-done'));
    check('manual: counter starts at 1', window.document.querySelector('.wtpdf-count').textContent === '1 تصویر جمع شد');

    // simulate the site swapping in the next page image
    page.setAttribute('src', 'https://cdn.test/m2.jpg');
    await flush();
    await flush();
    check('manual: new image picked up automatically',
      window.document.querySelector('.wtpdf-count').textContent === '2 تصویر جمع شد',
      window.document.querySelector('.wtpdf-count').textContent);

    window.document.querySelector('.wtpdf-done').click();
    const res = await running;
    check('manual: Done sends both images', res && res.count === 2 && sent.length === 1, res);
    const urls = sent[0] && sent[0].urls;
    check('manual: both urls present in order', urls[0].endsWith('/m1.jpg') && urls[1].endsWith('/m2.jpg'), urls);
    check('manual: panel removed after Done', !window.document.querySelector('.wtpdf-manual'));
    check('manual: style tag removed after Done', !window.document.querySelector('style'));
    check('manual: running flag reset', window.__wtpdfRunning === false);
  }

  // ---------- 8. manual mode: ESC cancels and sends nothing ----------
  {
    const h = makeHarness();
    const { window, img, sent, flush } = h;
    window.document.body.appendChild(img('https://cdn.test/c1.jpg'));
    const running = window.eval('scrapeAndSend("cancel.pdf", "manual")');
    await flush();
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const res = await running;
    check('manual-esc: cancelled result', res && res.cancelled === true && res.count === 0, res);
    check('manual-esc: no message sent', sent.length === 0, sent.length);
    check('manual-esc: panel removed', !window.document.querySelector('.wtpdf-manual'));
    check('manual-esc: running flag reset', window.__wtpdfRunning === false);
  }

  // ---------- 9. auto mode also honours ESC ----------
  {
    const h = makeHarness();
    const { window, img, sent, flush } = h;
    const page = img('https://cdn.test/e1.jpg');
    window.document.body.appendChild(page);
    const next = window.document.createElement('button');
    next.setAttribute('aria-label', 'Next page');
    next.addEventListener('click', () => page.setAttribute('src', 'https://cdn.test/e2.jpg'));
    window.document.body.appendChild(next);
    const running = window.eval('scrapeAndSend("esc.pdf", "auto")');
    await flush();
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const res = await running;
    check('auto-esc: cancelled result', res && res.cancelled === true, res);
    check('auto-esc: no message sent', sent.length === 0, sent.length);
  }

  // ---------- 10. default argument keeps the classic scroll mode (no next-button clicking) ----------
  {
    const h = makeHarness();
    const { window, img, sent } = h;
    window.document.body.appendChild(img('https://cdn.test/scroll.jpg'));
    const next = window.document.createElement('button');
    next.setAttribute('aria-label', 'Next page');
    let clicked = false;
    next.addEventListener('click', () => { clicked = true; });
    window.document.body.appendChild(next);
    Object.defineProperty(window.document.documentElement, 'scrollHeight', { value: 800, configurable: true });
    Object.defineProperty(window.document.body, 'scrollHeight', { value: 800, configurable: true });
    const res = await window.eval('scrapeAndSend("classic.pdf")');
    check('default: scroll mode never clicks next', clicked === false, clicked);
    check('default: scroll mode still collects images', res && res.count === 1 && sent.length === 1, res);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL NAVIGATION TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(2); });
