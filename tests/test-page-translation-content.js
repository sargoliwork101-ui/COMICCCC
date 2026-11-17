// Integration tests for direct on-page selection, translation retries, and version controls.
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
    <p id="history">This paragraph will collect several saved translations.</p>
    <button id="site-button">Do not translate controls</button>
  </main></body></html>`, { url: 'https://example.test/article', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const requests = [], progress = [];
  let listener = null, translationRun = 0, responseMode = 'full';
  const coreSource = fs.readFileSync(path.join(__dirname, '../src/core/page-translation.js'), 'utf8');
  vm.runInContext(coreSource, dom.getInternalVMContext(), { filename: 'page-translation.js' });
  window.chrome = {
    runtime: {
      onMessage: { addListener: (callback) => { listener = callback; } },
      sendMessage: async (message) => {
        if (message.type === 'WTPDF_TRANSLATE_PAGE_BATCH') {
          requests.push(message);
          translationRun++;
          if (responseMode === 'fail') return { ok: false, error: 'test service failure' };
          const entries = responseMode === 'partial'
            ? message.entries.filter((entry) => !/world/.test(entry.text))
            : message.entries;
          return {
            ok: true, provider: 'Google Translate',
            translations: entries.map((entry) => ({ id: entry.id, text: `V${translationRun}(${entry.text.trim()})` }))
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
  const toolbar = window.document.querySelector('[data-wtpdf-page-translation-ui="toolbar"]');
  const pickToggle = window.document.querySelector('[data-action="pick-toggle"]');
  const group = (id) => window.__wtpdfPageTranslation.groups.find((item) => item.id === id);
  check('new copy immediately enters on-page selection with no paragraph-selection window',
    keepOpen === false && result && result.ok && result.readyForSelection && window.__wtpdfPageTranslation.pickMode &&
    !!toolbar && !window.document.querySelector('[data-wtpdf-page-translation-ui="panel"]') &&
    !/پاراگراف‌هایی را که می‌خواهید ترجمه کنید انتخاب کنید/.test(window.document.body.textContent) && requests.length === 0);
  check('selection toolbar exposes engine and translation controls without listing page text',
    !!toolbar.querySelector('[data-role="translation-engine"]') && !!toolbar.querySelector('[data-action="translate-selected"]') &&
    !toolbar.textContent.includes('Hello') && !toolbar.textContent.includes('This paragraph'));

  const clickBlock = (element) => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  clickBlock(window.document.getElementById('article'));
  clickBlock(window.document.getElementById('second'));
  check('clicking page paragraphs selects and highlights them directly',
    window.__wtpdfPageTranslation.selectedGroups.size === 2 &&
    window.document.getElementById('article').classList.contains('wtpdf-page-translation-picked') &&
    window.document.getElementById('second').classList.contains('wtpdf-page-translation-picked'));
  pickToggle.click();
  check('ending selection keeps the chosen paragraphs highlighted and enables translation',
    !window.__wtpdfPageTranslation.pickMode && window.__wtpdfPageTranslation.selectedGroups.size === 2 &&
    !toolbar.querySelector('[data-action="translate-selected"]').disabled &&
    !window.document.querySelector('[data-wtpdf-page-translation-ui="panel"]'));
  pickToggle.click();
  clickBlock(window.document.getElementById('second'));
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  check('Escape ends on-page selection while keeping only the page clicks that remain selected',
    !window.__wtpdfPageTranslation.pickMode && window.__wtpdfPageTranslation.selectedGroups.size === 1 &&
    window.__wtpdfPageTranslation.selectedGroups.has('group-1') &&
    window.document.getElementById('article').classList.contains('wtpdf-page-translation-picked') &&
    !window.document.getElementById('second').classList.contains('wtpdf-page-translation-picked'));

  const engineSelect = toolbar.querySelector('[data-role="translation-engine"]');
  engineSelect.value = 'google'; engineSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  toolbar.querySelector('[data-action="translate-selected"]').click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('only the clicked paragraph is sent to the selected engine',
    requests.length === 1 && requests[0].engine === 'google' && requests[0].entries.every((entry) =>
      /Hello|world|from this page/.test(entry.text)) && requests[0].entries.every((entry) => !/This paragraph/.test(entry.text)));
  check('translation status is attached to the selected page block, not a chooser list',
    group('group-1').status === 'translated' && group('group-2').status === 'pending' &&
    window.document.getElementById('article').dataset.wtpdfTranslationStatus === 'translated');
  check('successful paragraph receives its first RTL translation while unselected text remains unchanged',
    window.document.querySelector('#article').textContent.includes('V1(') &&
    window.document.querySelector('#article').getAttribute('dir') === 'rtl' &&
    window.document.body.getAttribute('dir') === 'ltr' &&
    window.document.querySelector('#second').textContent === 'This paragraph can remain unchanged.' &&
    !window.document.querySelector('#second').hasAttribute('dir'));

  check('toolbar can move the selected paragraph between original and translated versions and reports its saved count',
    group('group-1').versions.length === 2 && toolbar.querySelector('[data-action="version-prev"]').disabled === false &&
    toolbar.querySelector('[data-role="version-count"]').textContent.includes('۱ ترجمه'));
  toolbar.querySelector('[data-action="version-prev"]').click();
  check('previous-version control restores original text for the selected paragraph',
    window.document.querySelector('#article').textContent === 'Hello world from this page.' &&
    !window.document.querySelector('#article').hasAttribute('dir'));
  toolbar.querySelector('[data-action="version-next"]').click();
  check('next-version control reapplies the saved RTL translation',
    window.document.querySelector('#article').textContent.includes('V1(') &&
    window.document.querySelector('#article').getAttribute('dir') === 'rtl');

  const sameTabResponse = listener({ type: 'WTPDF_PAGE_TRANSLATE_OPEN_SELECTION', engine: 'google' }, {}, (response) => { result = response; });
  await pause();
  check('reopen request reactivates direct page selection without showing a chooser',
    sameTabResponse === false && result && result.ok && result.translatedCopy &&
    window.__wtpdfPageTranslation.pickMode && !window.document.querySelector('[data-wtpdf-page-translation-ui="panel"]'));
  pickToggle.click();
  toolbar.querySelector('[data-action="translate-selected"]').click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('retranslation creates another version in place without a panel or new tab',
    requests.length === 2 && window.document.querySelector('#article').textContent.includes('V2(') &&
    window.document.querySelectorAll('[data-wtpdf-page-translation-ui="toolbar"]').length === 1 &&
    !window.document.querySelector('[data-wtpdf-page-translation-ui="panel"]'));
  toolbar.querySelector('[data-action="version-prev"]').click();
  check('previous version remains selectable from the compact toolbar', window.document.querySelector('#article').textContent.includes('V1('));
  toolbar.querySelector('[data-action="version-next"]').click();
  check('latest version can be restored after reviewing an older one', window.document.querySelector('#article').textContent.includes('V2('));

  responseMode = 'fail';
  toolbar.querySelector('[data-action="translate-selected"]').click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('failed request marks the selected paragraph and keeps the previous translation visible',
    group('group-1').status === 'failed' && window.document.querySelector('#article').textContent.includes('V2(') &&
    !toolbar.querySelector('[data-action="retry-failed"]').disabled);
  responseMode = 'partial';
  toolbar.querySelector('[data-action="retry-failed"]').click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('retry of a failed paragraph records partial completion without losing saved versions',
    requests[3].entries.length === 3 && group('group-1').status === 'partial' &&
    window.document.querySelector('#article').textContent.includes('V4(') &&
    window.document.querySelector('#article').textContent.includes('world'));
  responseMode = 'full';
  toolbar.querySelector('[data-action="retry-failed"]').click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('retry sends only the missing text segment and combines it with earlier successes',
    requests[4].entries.length === 1 && /world/.test(requests[4].entries[0].text) &&
    group('group-1').status === 'translated' && window.document.querySelector('#article').textContent.includes('V4(') &&
    window.document.querySelector('#article').textContent.includes('V5(world)'));
  toolbar.querySelector('[data-action="version-prev"]').click();
  toolbar.querySelector('[data-action="version-prev"]').click();
  check('older complete translation remains selectable after failed and partial retries',
    window.document.querySelector('#article').textContent.includes('V2('));
  toolbar.querySelector('[data-action="version-next"]').click();
  toolbar.querySelector('[data-action="version-next"]').click();

  pickToggle.click();
  clickBlock(window.document.getElementById('article'));
  clickBlock(window.document.getElementById('history'));
  pickToggle.click();
  for (let index = 0; index < 8; index++) {
    toolbar.querySelector('[data-action="translate-selected"]').click();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  check('keeps the latest six translations for a paragraph, including five prior versions',
    group('group-3').versions.length === 7 && group('group-3').activeVersion === 6 &&
    window.document.querySelector('#history').textContent.includes('V13(') &&
    toolbar.querySelector('[data-role="version-count"]').textContent.includes('۶ ترجمه'));
  for (let index = 0; index < 5; index++) toolbar.querySelector('[data-action="version-prev"]').click();
  check('the five earlier saved translations remain reachable after the history limit is reached',
    window.document.querySelector('#history').textContent.includes('V8('));
  for (let index = 0; index < 5; index++) toolbar.querySelector('[data-action="version-next"]').click();
  check('version counter explains the restore button affects only the translated copy',
    toolbar.querySelector('[data-action="restore"]').title.includes('صفحهٔ اصلی تغییر نمی‌کند'));

  toolbar.querySelector('[data-action="original"]').click();
  check('global original control restores all paragraphs and original directions',
    window.document.querySelector('#article').textContent === 'Hello world from this page.' &&
    !window.document.querySelector('#article').hasAttribute('dir') &&
    window.document.querySelector('#second').textContent === 'This paragraph can remain unchanged.');
  toolbar.querySelector('[data-action="translated"]').click();
  check('global translation control restores each paragraph’s latest saved version',
    window.document.querySelector('#article').textContent.includes('V4(') &&
    window.document.querySelector('#article').textContent.includes('V5(world)'));
  check('translation progress never includes paragraph text', progress.length > 0 && progress.every((item) => !Object.hasOwn(item, 'text')));
  toolbar.querySelector('[data-action="restore"]').click();
  check('restore removes the compact toolbar and returns original page text',
    !window.document.querySelector('[data-wtpdf-page-translation-ui]') &&
    window.document.querySelector('#article').textContent === 'Hello world from this page.' &&
    !window.document.querySelector('#article').hasAttribute('dir'));

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PAGE TRANSLATION CONTENT TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((error) => { console.error('TEST CRASH:', error); process.exit(2); });
