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
          if (responseMode === 'empty') return { ok: true, provider: 'Google Translate', translations: [] };
          const entries = responseMode === 'partial'
            ? message.entries.filter((entry) => !/world/.test(entry.text))
            : message.entries;
          const aiSelected = message.engine === 'ai:openai';
          return {
            ok: true, provider: aiSelected ? 'OpenAI' : 'Google Translate', model: aiSelected ? 'gpt-test' : '',
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
  const keepOpen = listener({ type: 'WTPDF_PAGE_TRANSLATE_START', jobId: 'job-1',
    availableAiEngines: [{ provider: 'openai', model: 'gpt-test' }] }, {}, (response) => { result = response; });
  await pause();
  const toolbar = window.document.querySelector('[data-wtpdf-page-translation-ui="toolbar"]');
  const pickToggle = window.document.querySelector('[data-action="pick-toggle"]');
  const group = (id) => window.__wtpdfPageTranslation.groups.find((item) => item.id === id);
  const textWithoutBadges = (element) => {
    const clone = element.cloneNode(true);
    clone.querySelectorAll('.wtpdf-page-translation-version-badge').forEach((badge) => badge.remove());
    return clone.textContent;
  };
  check('new copy immediately enters on-page selection with no paragraph-selection window',
    keepOpen === false && result && result.ok && result.readyForSelection && window.__wtpdfPageTranslation.pickMode &&
    !!toolbar && !window.document.querySelector('[data-wtpdf-page-translation-ui="panel"]') &&
    !/پاراگراف‌هایی را که می‌خواهید ترجمه کنید انتخاب کنید/.test(window.document.body.textContent) && requests.length === 0);
  check('toolbar groups engine, selection, translation, and review tools into clear steps',
    /موتور ترجمه/.test(toolbar.querySelector('[data-role="engine-section"]').textContent) &&
    /متن دلخواه/.test(toolbar.querySelector('[data-role="selection-section"]').textContent) &&
    /دریافت ترجمه/.test(toolbar.querySelector('[data-role="translate-section"]').textContent) &&
    /بازبینی و نسخه‌ها/.test(toolbar.querySelector('[data-role="review"]').textContent) &&
    !!toolbar.querySelector('[data-role="translation-engine"]') && !!toolbar.querySelector('[data-action="translate-selected"]') &&
    !toolbar.querySelector('[data-role="version-count"]') && !toolbar.querySelector('[data-action="restore"]') &&
    !toolbar.textContent.includes('Hello') && !toolbar.textContent.includes('This paragraph'));
  check('only configured AI providers and their exact model names appear in the page menu',
    [...toolbar.querySelectorAll('[data-role="translation-engine"] option')].map((option) => option.value).join(',') === 'auto,google,mymemory,ai:openai' &&
    toolbar.querySelector('[data-role="translation-engine"] option[value="ai:openai"]').textContent.includes('gpt-test') &&
    !toolbar.querySelector('[data-role="translation-engine"]').textContent.includes('Gemini') &&
    !toolbar.querySelector('[data-role="translation-engine"]').textContent.includes('OpenRouter'));
  check('each paragraph shows its own saved-translation badge above the text',
    window.document.querySelectorAll('#article > .wtpdf-page-translation-version-badge, #second > .wtpdf-page-translation-version-badge').length === 2 &&
    window.document.querySelector('#article > .wtpdf-page-translation-version-badge').textContent.includes('۰ ترجمه') &&
    window.document.querySelector('#second > .wtpdf-page-translation-version-badge').textContent.includes('۰ ترجمه'));

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
    textWithoutBadges(window.document.querySelector('#second')) === 'This paragraph can remain unchanged.' &&
    !window.document.querySelector('#second').hasAttribute('dir'));

  check('toolbar moves versions while the paragraph-level badge shows this paragraph count',
    group('group-1').versions.length === 2 && toolbar.querySelector('[data-action="version-prev"]').disabled === false &&
    window.document.querySelector('#article > .wtpdf-page-translation-version-badge').textContent.includes('۱ ترجمه') &&
    window.document.querySelector('#article > .wtpdf-page-translation-version-badge').textContent.includes('Google Translate'));
  toolbar.querySelector('[data-action="version-prev"]').click();
  check('previous-version control restores original text for the selected paragraph',
    textWithoutBadges(window.document.querySelector('#article')) === 'Hello world from this page.' &&
    !window.document.querySelector('#article').hasAttribute('dir'));
  toolbar.querySelector('[data-action="version-next"]').click();
  check('next-version control reapplies the saved RTL translation',
    window.document.querySelector('#article').textContent.includes('V1(') &&
    window.document.querySelector('#article').getAttribute('dir') === 'rtl');

  const sameTabResponse = listener({ type: 'WTPDF_PAGE_TRANSLATE_OPEN_SELECTION', engine: 'ai:openai',
    availableAiEngines: [{ provider: 'openai', model: 'gpt-test' }] }, {}, (response) => { result = response; });
  await pause();
  check('reopen request reactivates direct page selection without showing a chooser',
    sameTabResponse === false && result && result.ok && result.translatedCopy &&
    window.__wtpdfPageTranslation.pickMode && !window.document.querySelector('[data-wtpdf-page-translation-ui="panel"]'));
  pickToggle.click();
  toolbar.querySelector('[data-action="translate-selected"]').click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('retranslation creates another version in place without a panel or new tab',
    requests.length === 2 && window.document.querySelector('#article').textContent.includes('V2(') &&
    requests[1].engine === 'ai:openai' &&
    window.document.querySelectorAll('[data-wtpdf-page-translation-ui="toolbar"]').length === 1 &&
    !window.document.querySelector('[data-wtpdf-page-translation-ui="panel"]'));
  check('each saved translation displays its actual AI provider and model above the paragraph',
    window.document.querySelector('#article > .wtpdf-page-translation-version-badge').textContent.includes('OpenAI') &&
    window.document.querySelector('#article > .wtpdf-page-translation-version-badge').textContent.includes('مدل gpt-test'));
  toolbar.querySelector('[data-action="version-prev"]').click();
  check('previous version remains selectable and shows its own translation source',
    window.document.querySelector('#article').textContent.includes('V1(') &&
    window.document.querySelector('#article > .wtpdf-page-translation-version-badge').textContent.includes('Google Translate'));
  toolbar.querySelector('[data-action="version-next"]').click();
  check('next version restores its own translated text and model label',
    window.document.querySelector('#article').textContent.includes('V2(') &&
    window.document.querySelector('#article > .wtpdf-page-translation-version-badge').textContent.includes('مدل gpt-test'));

  responseMode = 'fail';
  toolbar.querySelector('[data-action="translate-selected"]').click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('failed request marks the selected paragraph and keeps the previous translation visible',
    group('group-1').status === 'failed' && window.document.querySelector('#article').textContent.includes('V2(') &&
    /test service failure/.test(toolbar.querySelector('[data-role="status"]').textContent) &&
    !toolbar.querySelector('[data-action="retry-failed"]').disabled);
  responseMode = 'empty';
  toolbar.querySelector('[data-action="retry-failed"]').click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('empty successful responses are reported as no translation instead of silent success',
    group('group-1').status === 'failed' && /پاسخ ترجمهٔ قابل‌استفاده‌ای برنگرداند/.test(toolbar.querySelector('[data-role="status"]').textContent));
  responseMode = 'partial';
  toolbar.querySelector('[data-action="retry-failed"]').click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('retry of a failed paragraph records partial completion without losing saved versions',
    requests[4].entries.length === 3 && group('group-1').status === 'partial' &&
    window.document.querySelector('#article').textContent.includes('V5(') &&
    window.document.querySelector('#article').textContent.includes('world'), { request: requests[4], status: group('group-1').status, text: window.document.querySelector('#article').textContent });
  responseMode = 'full';
  toolbar.querySelector('[data-action="retry-failed"]').click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('retry sends only the missing text segment and combines it with earlier successes',
    requests[5].entries.length === 1 && /world/.test(requests[5].entries[0].text) &&
    group('group-1').status === 'translated' && window.document.querySelector('#article').textContent.includes('V5(') &&
    window.document.querySelector('#article').textContent.includes('V6(world)'));
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
    window.document.querySelector('#history').textContent.includes('V14(') &&
    window.document.querySelector('#history > .wtpdf-page-translation-version-badge').textContent.includes('۶ ترجمه'));
  for (let index = 0; index < 5; index++) toolbar.querySelector('[data-action="version-prev"]').click();
  check('the five earlier saved translations remain reachable after the history limit is reached',
    window.document.querySelector('#history').textContent.includes('V9('));
  for (let index = 0; index < 5; index++) toolbar.querySelector('[data-action="version-next"]').click();
  toolbar.querySelector('[data-action="original"]').click();
  check('global original control restores all paragraphs and original directions',
    textWithoutBadges(window.document.querySelector('#article')) === 'Hello world from this page.' &&
    !window.document.querySelector('#article').hasAttribute('dir') &&
    textWithoutBadges(window.document.querySelector('#second')) === 'This paragraph can remain unchanged.');
  toolbar.querySelector('[data-action="translated"]').click();
  check('global translation control restores each paragraph’s latest saved version',
    window.document.querySelector('#article').textContent.includes('V5(') &&
    window.document.querySelector('#article').textContent.includes('V6(world)'), { request: requests[5], status: group('group-1').status, text: window.document.querySelector('#article').textContent });
  check('translation progress never includes paragraph text', progress.length > 0 && progress.every((item) => !Object.hasOwn(item, 'text')));
  check('there is no misleading restore button that closes the translation toolbar',
    !!window.document.querySelector('[data-wtpdf-page-translation-ui="toolbar"]') &&
    !window.document.querySelector('[data-action="restore"]'));

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PAGE TRANSLATION CONTENT TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((error) => { console.error('TEST CRASH:', error); process.exit(2); });
