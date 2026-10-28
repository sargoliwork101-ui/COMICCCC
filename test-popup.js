// Test for popup.js scrapeAndSend() running inside a simulated web page.
const fs = require('fs');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, {
  url: 'https://comic.test/episode/1?x=1', pretendToBeVisual: true, runScripts: 'dangerously'
});
const { window } = dom;
const ctx = dom.getInternalVMContext();

// image element factory
function img(attrs, w = 300, h = 400) {
  const el = window.document.createElement('img');
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  Object.defineProperty(el, 'naturalWidth', { value: w, configurable: true });
  Object.defineProperty(el, 'naturalHeight', { value: h, configurable: true });
  Object.defineProperty(el, 'complete', { value: true, configurable: true });
  el.getBoundingClientRect = () => ({ width: w, height: h, top: 0, left: 0, right: w, bottom: h });
  return el;
}
window.document.body.appendChild(img({ src: 'https://cdn.test/a.jpg' }));
window.document.body.appendChild(img({ 'data-src': 'https://cdn.test/lazy.png' }, 300, 300)); // lazy, current src placeholder
window.document.body.appendChild(img({ src: 'https://cdn.test/logo.png' }, 300, 300)); // logo filtered
window.document.body.appendChild(img({ src: '/relative/x.jpg' })); // relative URL
window.document.body.appendChild(img({ src: 'https://cdn.test/small.gif' }, 100, 100)); // too small
// placeholder src forces bestSrc() to parse srcset (in real browsers currentSrc already points at the picked candidate)
const srcset = img({ src: 'https://cdn.test/loading.gif' }, 300, 300);
srcset.setAttribute('srcset', 'https://cdn.test/set-1x.jpg 1x, https://cdn.test/set-2x.jpg 2x');
window.document.body.appendChild(srcset);
// CSS background element
const div = window.document.createElement('div');
div.style.backgroundImage = 'url("https://cdn.test/bg.webp")';
div.getBoundingClientRect = () => ({ width: 500, height: 500, top: 0, left: 0, right: 500, bottom: 500 });
window.document.body.appendChild(div);

// page mocks
const sent = [];
window.chrome = { runtime: { sendMessage: async (msg) => { sent.push(msg); return { ok: true }; } } };
let y = 0;
window.scrollTo = () => { y = 0; };
window.scrollBy = (_x, dy) => { y += dy; };
Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
Object.defineProperty(window, 'scrollY', { get: () => y, configurable: true });
Object.defineProperty(window.document.documentElement, 'scrollHeight', { value: 1600, configurable: true });
Object.defineProperty(window.document.body, 'scrollHeight', { value: 1600, configurable: true });
// run timers immediately so the scroll settle loop finishes fast
window.setTimeout = (cb) => global.setTimeout(cb, 0);

const code = fs.readFileSync(__dirname + '/popup.js', 'utf8');
// extract only scrapeAndSend (the top-level click listener needs extension chrome.tabs which is absent here)
const fnCode = code.slice(code.indexOf('async function scrapeAndSend'));
vm.runInContext(fnCode, ctx, { filename: 'popup.js' });

let failures = 0;
const check = (n, c, e) => { if (c) console.log('PASS:', n); else { failures++; console.log('FAIL:', n, e !== undefined ? JSON.stringify(e) : ''); } };

// popup.html shell: chips removed, modern brand kept, single start button
{
  const popupDom = new JSDOM(fs.readFileSync(__dirname + '/popup.html', 'utf8'));
  const pdoc = popupDom.window.document;
  check('chips block removed from popup', !pdoc.querySelector('.chips, .chip'));
  check('modern brand logo in popup', !!pdoc.querySelector('.brand .brand-logo img'));
  check('version pill present', !!pdoc.querySelector('.version-pill'));
  check('start button present', !!pdoc.getElementById('startBtn'));
  check('file name input present', !!pdoc.getElementById('pdfName'));
  check('page limit input present', pdoc.getElementById('pageLimit') &&
    pdoc.getElementById('pageLimit').type === 'number');
  check('manual next selector input present', !!pdoc.getElementById('nextSelector'));
  check('manual image selector input present', !!pdoc.getElementById('imageSelector'));
  check('advanced F12 section present', !!pdoc.querySelector('.advanced summary'));
  const pagedFields = pdoc.getElementById('pagedModeFields');
  check('paged-mode container exists and hides both controls by default',
    pagedFields && pagedFields.classList.contains('hidden') &&
    pagedFields.contains(pdoc.getElementById('pageLimit')) &&
    !!pagedFields.querySelector('.advanced'));
  check('page limit label is generic (no site name)',
    !/Google Books/i.test(pdoc.querySelector('label[for="pageLimit"]').textContent));
  check('idle status box hidden with no filler text', pdoc.getElementById('statusBox').classList.contains('hidden') &&
    pdoc.getElementById('statusText').textContent.trim() === '');
}
// popup.js keeps the status box hidden unless an error/warning actually happens
const popupCode = fs.readFileSync(__dirname + '/popup.js', 'utf8');
check('popup has setStatus helper (text only)', /const setStatus = \(text\)/.test(popupCode));
check('popup reveals the box only via showError', /const showError = \(text\)/.test(popupCode) &&
  /statusBox\.classList\.remove\('hidden'\)/.test(popupCode));

// mode-gated visibility helper, extracted from popup.js and unit-tested directly
{
  const match = popupCode.match(/const applyPagedModeFields = \(mode\) => \{[\s\S]*?\};/);
  const stub = window.document.createElement('div');
  stub.className = 'hidden';
  window.pagedModeFields = stub;
  // const bindings do not survive separate eval calls; assign the helper onto the global instead
  window.eval(match[0].replace('const applyPagedModeFields', 'window.applyPagedModeFields'));
  window.eval('applyPagedModeFields("scroll")');
  check('helper: scroll mode hides the paged fields', stub.classList.contains('hidden'));
  window.eval('applyPagedModeFields("auto")');
  check('helper: auto mode reveals the paged fields', !stub.classList.contains('hidden'));
  window.eval('applyPagedModeFields("manual")');
  check('helper: manual mode keeps the paged fields visible', !stub.classList.contains('hidden'));
  window.eval('applyPagedModeFields("scroll")');
  check('helper: returning to scroll hides the fields again', stub.classList.contains('hidden'));
}

// interactive behavior: run the real popup.html + popup.js with a mocked chrome API
async function runPopupOnce(executeResult, shouldReject, clickStart = true) {
  const dom2 = new JSDOM(fs.readFileSync(__dirname + '/popup.html', 'utf8'), {
    url: 'chrome-extension://ext/popup.html', runScripts: 'dangerously', pretendToBeVisual: true
  });
  const w = dom2.window;
  const c = dom2.getInternalVMContext();
  // jsdom does not implement innerText; map it to textContent like the viewer harnesses do
  Object.defineProperty(w.Element.prototype, 'innerText', {
    get() { return this.textContent; },
    set(v) { this.textContent = v; },
    configurable: true
  });
  w.chrome = {
    // start handler resolves the active tab before injecting; the popup itself no longer uses tabs for field visibility
    tabs: { query: async () => [{ id: 1 }] },
    scripting: {
      executeScript: shouldReject
        ? async () => { throw new Error('Cannot access chrome:// URLs'); }
        : async (opts) => {
          // stage 1: frame probe; stage 2: the real scrape injection
          if (opts.func && opts.func.name === 'probeBookFrame') {
            return [{ frameId: 0, result: { isReader: false, href: 'https://comic.test/ep', id: '' } }];
          }
          return [{ result: executeResult }];
        }
    }
  };
  vm.runInContext(popupCode, c, { filename: 'popup.js' });
  if (clickStart) {
    w.document.getElementById('startBtn').click();
    await new Promise((r) => setTimeout(r, 10));
  }
  return {
    win: w,
    boxHidden: w.document.getElementById('statusBox').classList.contains('hidden'),
    text: w.document.getElementById('statusText').textContent,
    pagedHidden: w.document.getElementById('pagedModeFields').classList.contains('hidden')
  };
}

(async () => {
  // start scraping without awaiting: the overlay is created synchronously before the first await,
  // so it is already in the DOM while the job is in flight
  const running = window.eval('scrapeAndSend("comic.pdf")');
  await new Promise((r) => setTimeout(r, 0));
  const probe = window.eval('(() => {' +
    'const style = [...document.querySelectorAll("style")].map((s) => s.textContent).join("");' +
    'const hint = document.querySelector(".wtpdf-hint");' +
    'return {' +
    'overlay: !!document.querySelector(".wtpdf-overlay"),' +
    'card: !!document.querySelector(".wtpdf-card"),' +
    'msg: !!document.querySelector(".wtpdf-msg"),' +
    'spinner: !!document.querySelector(".wtpdf-spinner"),' +
    'hintText: hint ? hint.textContent : "",' +
    'hasDarkBackdrop: style.includes("rgba(3,5,10,.88)"),' +
    'hasCenteredFlex: style.includes("align-items:center") && style.includes("justify-content:center"),' +
    'hasBigFont: /font:700 26px/.test(style),' +
    'hasMaxZ: style.includes("z-index:2147483647")}; })()');
  const res = await running;
  check('overlay advertises ESC cancellation hint', /ESC/.test(probe.hintText), probe.hintText);
  check('full-screen overlay shown while scraping', probe.overlay && probe.card && probe.msg && probe.spinner, probe);
  check('overlay centered on screen', probe.hasCenteredFlex, probe);
  check('overlay dark backdrop', probe.hasDarkBackdrop, probe);
  check('message font about 2x (26px)', probe.hasBigFont, probe);
  check('overlay on top of page (max z-index)', probe.hasMaxZ, probe);
  check('overlay removed after finish', !window.document.querySelector('.wtpdf-overlay') && !window.document.querySelector('style'));
  check('count returned', res.count === sent[0].urls.length, res);
  const urls = sent[0].urls;
  console.log('scraped:', urls);
  check('absolute jpg collected', urls.includes('https://cdn.test/a.jpg'));
  check('lazy data-src collected', urls.includes('https://cdn.test/lazy.png'));
  check('logo filtered', !urls.some((u) => u.includes('logo')));
  check('relative URL resolved', urls.includes('https://comic.test/relative/x.jpg'));
  check('small image filtered', !urls.some((u) => u.includes('small.gif')));
  check('srcset 2x chosen', urls.includes('https://cdn.test/set-2x.jpg') && !urls.includes('https://cdn.test/place.gif'));
  check('css background collected', urls.includes('https://cdn.test/bg.webp'));
  check('no duplicates', new Set(urls).size === urls.length);
  check('message payload fields', sent[0].type === 'WTPDF_URLS' && sent[0].name === 'comic.pdf' && sent[0].pageUrl === 'https://comic.test/episode/1?x=1');
  check('running flag reset', window.__wtpdfRunning === false);

  // busy guard
  window.__wtpdfRunning = true;
  const busy = await window.eval('scrapeAndSend("x.pdf")');
  check('busy guard', busy && busy.busy === true, busy);

  // ESC during the scroll/scrape phase cancels before any message is sent
  window.__wtpdfRunning = false; // the busy-guard path intentionally leaves this flag untouched
  const messagesBefore = sent.length;
  const cancelRun = window.eval('scrapeAndSend("cancel.pdf")');
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  const cancelRes = await cancelRun;
  check('ESC returns a cancelled result', cancelRes && cancelRes.cancelled === true && cancelRes.count === 0, cancelRes);
  // ESC may also send a WTPDF_GBOOKS_CANCEL control message; only WTPDF_URLS jobs must be counted
  const urlJobs = () => sent.filter((m) => m.type === 'WTPDF_URLS').length;
  check('cancelled scrape sends no WTPDF_URLS message', urlJobs() === messagesBefore, urlJobs());
  check('overlay removed after cancel', !window.document.querySelector('.wtpdf-overlay'));
  check('running flag reset after cancel', window.__wtpdfRunning === false);
  // leftover ESC keypress must not start or cancel anything new (listener was removed in finally)
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  check('no overlay reappears from a stray ESC', !window.document.querySelector('.wtpdf-overlay') && urlJobs() === messagesBefore);

  // interactive popup status box: hidden on success, visible only on error/warning
  const successRun = await runPopupOnce({ count: 5, skippedInline: 0 });
  check('success run keeps the status box hidden', successRun.boxHidden && successRun.text === '', successRun);
  const emptyRun = await runPopupOnce({ count: 0 });
  check('no-images run shows the box with an error', !emptyRun.boxHidden && /هیچ تصویری/.test(emptyRun.text), emptyRun);
  const busyRun = await runPopupOnce({ busy: true });
  check('busy run shows the box with a warning', !busyRun.boxHidden && /از قبل/.test(busyRun.text), busyRun);
  const cancelledRun = await runPopupOnce({ cancelled: true, count: 0 });
  check('cancelled run shows the box with the ESC notice', !cancelledRun.boxHidden && /لغو/.test(cancelledRun.text), cancelledRun);
  const errorRun = await runPopupOnce(null, true);
  check('failed run shows the box with the error', !errorRun.boxHidden && /خطا/.test(errorRun.text), errorRun);
  const secondSuccess = await runPopupOnce({ count: 2 });
  check('later success clears a previously shown error', secondSuccess.boxHidden && secondSuccess.text === '', secondSuccess);
  // paged-mode controls follow the selected collection mode, never the site hostname
  const modePopup = await runPopupOnce({ count: 1 }, false, false);
  const mpw = modePopup.win;
  const fieldsEl = mpw.document.getElementById('pagedModeFields');
  check('default scroll mode hides the paged controls', fieldsEl.classList.contains('hidden'));
  mpw.document.querySelector('.mode-btn[data-mode="auto"]').click();
  check('switching to auto mode reveals the paged controls on any site',
    !fieldsEl.classList.contains('hidden') && mpw.document.getElementById('pageLimit'));
  mpw.document.querySelector('.mode-btn[data-mode="manual"]').click();
  check('manual mode keeps the paged controls visible', !fieldsEl.classList.contains('hidden'));
  mpw.document.querySelector('.mode-btn[data-mode="scroll"]').click();
  check('switching back to scroll hides the paged controls', fieldsEl.classList.contains('hidden'));

  // two-stage injection: a reader frame reported by the probe must become the scrape target
  {
    const calls = [];
    const dom3 = new JSDOM(fs.readFileSync(__dirname + '/popup.html', 'utf8'), {
      url: 'chrome-extension://ext/popup.html', runScripts: 'dangerously', pretendToBeVisual: true
    });
    const w3 = dom3.window;
    Object.defineProperty(w3.Element.prototype, 'innerText', {
      get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true
    });
    w3.chrome = {
      tabs: { query: async () => [{ id: 1 }] },
      scripting: {
        executeScript: async (opts) => {
          calls.push(opts);
          if (opts.func && opts.func.name === 'probeBookFrame') {
            return [
              { frameId: 0, result: { isReader: false, href: 'https://www.google.com/books/edition/T/B1abcdef', id: '' } },
              { frameId: 77, result: { isReader: true, href: 'https://books.google.com/books?id=B1abcdef&output=embed', id: 'B1abcdef' } }
            ];
          }
          return [{ result: { count: 4, skippedInline: 0 } }];
        }
      }
    };
    vm.runInContext(popupCode, dom3.getInternalVMContext(), { filename: 'popup.js' });
    w3.document.getElementById('startBtn').click();
    await new Promise((r) => setTimeout(r, 10));
    check('frame probe runs across all frames', calls[0] && calls[0].target && calls[0].target.allFrames === true, calls[0]);
    check('scrape injected into the reader frame only',
      calls[1] && calls[1].target && calls[1].target.frameIds && calls[1].target.frameIds[0] === 77, calls[1] && calls[1].target);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL POPUP TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(2); });
