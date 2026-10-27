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
  check('idle status box hidden with no filler text', pdoc.getElementById('statusBox').classList.contains('hidden') &&
    pdoc.getElementById('statusText').textContent.trim() === '');
}
// popup.js exposes a helper that reveals the status box only for real messages
const popupCode = fs.readFileSync(__dirname + '/popup.js', 'utf8');
check('popup has setStatus helper', /const setStatus = \(text\)/.test(popupCode));
check('popup status box is unhidden via helper', /statusBox\.classList\.remove\('hidden'\)/.test(popupCode));

(async () => {
  // start scraping without awaiting: the overlay is created synchronously before the first await,
  // so it is already in the DOM while the job is in flight
  const running = window.eval('scrapeAndSend("comic.pdf")');
  await new Promise((r) => setTimeout(r, 0));
  const probe = window.eval('(() => {' +
    'const style = [...document.querySelectorAll("style")].map((s) => s.textContent).join("");' +
    'return {' +
    'overlay: !!document.querySelector(".wtpdf-overlay"),' +
    'card: !!document.querySelector(".wtpdf-card"),' +
    'msg: !!document.querySelector(".wtpdf-msg"),' +
    'spinner: !!document.querySelector(".wtpdf-spinner"),' +
    'hasDarkBackdrop: style.includes("rgba(3,5,10,.88)"),' +
    'hasCenteredFlex: style.includes("align-items:center") && style.includes("justify-content:center"),' +
    'hasBigFont: /font:700 26px/.test(style),' +
    'hasMaxZ: style.includes("z-index:2147483647")}; })()');
  const res = await running;
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

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL POPUP TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(2); });
