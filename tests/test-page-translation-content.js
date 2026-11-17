// Integration tests for paragraph selection, in-page retranslations, and per-paragraph versions.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
let failures = 0;
function check(name, condition, extra) {
  if (condition) console.log('PASS:', name);
  else { failures++; console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

(async () => {
  const dom = new JSDOM(`<!doctype html><html><body dir="ltr"><main>
    <p id="article">Hello <strong>world</strong> from this page.</p>
    <p id="second">This paragraph can remain unchanged.</p>
    <button id="site-button">Do not translate controls</button>
  </main></body></html>`, { url: 'https://example.test/article', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const requests = [], progress = [];
  let listener = null, translationRun = 0;
  const coreSource = fs.readFileSync(path.join(__dirname, '../src/core/page-translation.js'), 'utf8');
  vm.runInContext(coreSource, dom.getInternalVMContext(), { filename: 'page-translation.js' });
  window.chrome = {
    runtime: {
      onMessage: { addListener: (callback) => { listener = callback; } },
      sendMessage: async (message) => {
        if (message.type === 'WTPDF_TRANSLATE_PAGE_BATCH') {
          requests.push(message);
          translationRun++;
          return {
            ok: true, provider: 'Google Translate',
            translations: message.entries.map((entry) => ({ id: entry.id, text: `V${translationRun}(${entry.text.trim()})` }))
          };
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
  await pause();
  check('copy opens a paragraph chooser without translating everything immediately',
    keepOpen === false && result && result.ok && result.readyForSelection && requests.length === 0 &&
    window.document.querySelectorAll('[data-group-select]').length === 2);
  check('all paragraphs are selected for the first run and controls are excluded',
    [...window.document.querySelectorAll('[data-group-select]')].every((input) => input.checked) &&
    !window.document.querySelector('[data-role="paragraph"]').textContent.includes('Do not translate controls'));

  const firstCheckbox = window.document.querySelector('[data-group-select="group-1"]');
  const secondCheckbox = window.document.querySelector('[data-group-select="group-2"]');
  secondCheckbox.checked = false;
  window.document.querySelector('[data-action="translate-selected"]').click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('only the checked paragraph is sent to the selected engine',
    requests.length === 1 && requests[0].entries.every((entry) =>
      /Hello|world|from this page/.test(entry.text)) && requests[0].entries.every((entry) => !/This paragraph/.test(entry.text)));
  check('successful paragraph receives its first RTL translation while unselected text remains unchanged',
    window.document.querySelector('#article').textContent.includes('V1(') &&
    window.document.querySelector('#article').getAttribute('dir') === 'rtl' &&
    window.document.body.getAttribute('dir') === 'ltr' &&
    window.document.querySelector('#second').textContent === 'This paragraph can remain unchanged.' &&
    !window.document.querySelector('#second').hasAttribute('dir'));

  let firstVersions = window.document.querySelector('[data-version-for="group-1"]');
  const secondVersions = window.document.querySelector('[data-version-for="group-2"]');
  check('each paragraph has its own version selector and original text remains an option',
    firstVersions.options.length === 2 && firstVersions.options[0].textContent === 'متن اصلی' && secondVersions.options.length === 1);
  firstVersions.value = '0'; firstVersions.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('choosing original text for one paragraph restores only that block and its direction',
    window.document.querySelector('#article').textContent === 'Hello world from this page.' &&
    !window.document.querySelector('#article').hasAttribute('dir') && window.document.querySelector('#second').textContent.startsWith('This paragraph'));
  firstVersions.value = '1'; firstVersions.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('choosing a saved translation displays it and restores RTL',
    window.document.querySelector('#article').textContent.includes('V1(') && window.document.querySelector('#article').getAttribute('dir') === 'rtl');

  window.document.querySelector('[data-action="select"]')?.click();
  const sameTabResponse = listener({ type: 'WTPDF_PAGE_TRANSLATE_OPEN_SELECTION' }, {}, (response) => { result = response; });
  await pause();
  check('retranslation request is handled by the existing translated tab',
    sameTabResponse === false && result && result.ok && result.translatedCopy && requests.length === 1);
  firstVersions = window.document.querySelector('[data-version-for="group-1"]');
  window.document.querySelector('[data-group-select="group-2"]').checked = false;
  window.document.querySelector('[data-group-select="group-1"]').checked = true;
  window.document.querySelector('[data-action="translate-selected"]').click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('retranslation creates another version in place without changing the page or tab',
    requests.length === 2 && window.document.querySelector('#article').textContent.includes('V2(') &&
    window.document.querySelectorAll('[data-wtpdf-page-translation-ui="toolbar"]').length === 1);
  firstVersions = window.document.querySelector('[data-version-for="group-1"]');
  check('previous and new translations are both selectable for the same paragraph', firstVersions.options.length === 3);
  firstVersions.value = '1'; firstVersions.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('per-paragraph selector restores the previous translation', window.document.querySelector('#article').textContent.includes('V1('));
  firstVersions.value = '2'; firstVersions.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('per-paragraph selector can switch back to the new translation', window.document.querySelector('#article').textContent.includes('V2('));

  window.document.querySelector('[data-action="original"]').click();
  check('global original control restores all paragraphs and original directions',
    window.document.querySelector('#article').textContent === 'Hello world from this page.' &&
    !window.document.querySelector('#article').hasAttribute('dir') &&
    window.document.querySelector('#second').textContent === 'This paragraph can remain unchanged.');
  window.document.querySelector('[data-action="translated"]').click();
  check('global translation control restores each paragraph’s latest saved version',
    window.document.querySelector('#article').textContent.includes('V2('));
  check('translation progress never includes paragraph text', progress.length > 0 && progress.every((item) => !Object.hasOwn(item, 'text')));
  window.document.querySelector('[data-action="restore"]').click();
  check('restore removes the toolbar and chooser and returns the original page text',
    !window.document.querySelector('[data-wtpdf-page-translation-ui]') &&
    window.document.querySelector('#article').textContent === 'Hello world from this page.' &&
    !window.document.querySelector('#article').hasAttribute('dir'));

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PAGE TRANSLATION CONTENT TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((error) => { console.error('TEST CRASH:', error); process.exit(2); });
