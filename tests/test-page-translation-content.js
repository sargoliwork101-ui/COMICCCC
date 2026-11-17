// Integration tests for translating a duplicated webpage while preserving its HTML structure.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
let failures = 0;
function check(name, condition, extra) {
  if (condition) console.log('PASS:', name);
  else { failures++; console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

(async () => {
  const dom = new JSDOM(`<!doctype html><html><body><main>
    <p id="article">Hello <strong>world</strong> from this page.</p>
    <button id="site-button">Do not translate controls</button>
  </main></body></html>`, { url: 'https://example.test/article', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const requests = [], progress = [];
  let listener = null;
  const coreSource = fs.readFileSync(path.join(__dirname, '../src/core/page-translation.js'), 'utf8');
  vm.runInContext(coreSource, dom.getInternalVMContext(), { filename: 'page-translation.js' });
  window.chrome = {
    runtime: {
      onMessage: { addListener: (callback) => { listener = callback; } },
      sendMessage: async (message) => {
        if (message.type === 'WTPDF_TRANSLATE_PAGE_BATCH') {
          requests.push(message);
          return { ok: true, provider: 'Google Translate', translations: message.entries.map((entry) => ({ id: entry.id, text: `FA(${entry.text.trim()})` })) };
        }
        if (message.type === 'WTPDF_PAGE_TRANSLATE_PROGRESS') progress.push(message);
        return { ok: true };
      }
    }
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/page-translator/content.js'), 'utf8');
  vm.runInContext(source, dom.getInternalVMContext(), { filename: 'content.js' });
  check('content script registers the translated-copy message listener', typeof listener === 'function');

  let result = null;
  const keepOpen = listener({ type: 'WTPDF_PAGE_TRANSLATE_START', jobId: 'job-1' }, {}, (response) => { result = response; });
  for (let tries = 0; tries < 50 && result === null; tries++) await new Promise((resolve) => setTimeout(resolve, 2));
  check('translation request keeps the message channel open and reports completion', keepOpen === true && result && result.ok === true, result);
  check('page text is translated through bounded batches without passing API keys',
    requests.length > 0 && requests.every((request) => request.entries.length <= 20 &&
      request.entries.every((entry) => entry.text.length <= 420 && !Object.hasOwn(entry, 'apiKey'))));
  check('inline markup and excluded controls remain intact after translation',
    window.document.querySelector('#article strong') !== null &&
    window.document.querySelector('#site-button').textContent === 'Do not translate controls' &&
    window.document.querySelector('#article').textContent.includes('FA('), window.document.querySelector('#article').innerHTML);
  check('page receives a visible control to toggle source text and restore it',
    !!window.document.querySelector('[data-wtpdf-page-translation-ui] [data-action="original"]') &&
    !!window.document.querySelector('[data-wtpdf-page-translation-ui] [data-action="restore"]'));
  check('translation reports progress without including page content',
    progress.length > 0 && progress.every((item) => !Object.hasOwn(item, 'text')));

  window.document.querySelector('[data-action="original"]').click();
  check('original-text toggle changes only the captured text back',
    window.document.querySelector('#article').textContent === 'Hello world from this page.');
  window.document.querySelector('[data-action="translated"]').click();
  check('translated-text toggle re-applies the saved translations',
    window.document.querySelector('#article').textContent.includes('FA('), window.document.querySelector('#article').innerHTML);
  window.document.querySelector('[data-action="restore"]').click();
  check('restore removes the toolbar and restores the initial page text',
    !window.document.querySelector('[data-wtpdf-page-translation-ui]') &&
    window.document.querySelector('#article').textContent === 'Hello world from this page.');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PAGE TRANSLATION CONTENT TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((error) => { console.error('TEST CRASH:', error); process.exit(2); });
