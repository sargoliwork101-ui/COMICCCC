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
  const coreSource = fs.readFileSync(path.join(__dirname, '../extension/src/core/page-translation.js'), 'utf8');
  vm.runInContext(coreSource, dom.getInternalVMContext(), { filename: 'page-translation.js' });
  window.chrome = {
    runtime: {
      onMessage: { addListener: (callback) => { listener = callback; } },
      sendMessage: async (message) => {
        if (message.type === 'WTPDF_TRANSLATE_PAGE_BATCH') {
          requests.push(message);
          translationRun++;
          if (responseMode === 'fail') return { ok: false, error: 'test service failure' };
          if (responseMode === 'invalidated') throw new Error('Extension context invalidated.');
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
  const source = fs.readFileSync(path.join(__dirname, '../extension/src/page-translator/content.js'), 'utf8');
  vm.runInContext(source, dom.getInternalVMContext(), { filename: 'content.js' });
  check('content script registers the translated-copy message listener', typeof listener === 'function');

  let result = null;
  const keepOpen = listener({ type: 'WTPDF_PAGE_TRANSLATE_START', jobId: 'job-1',
    availableAiEngines: [{ provider: 'openai', model: 'gpt-test' }] }, {}, (response) => { result = response; });
  await pause();
  const toolbar = window.document.querySelector('[data-wtpdf-page-translation-ui="toolbar"]');
  const pickToggle = window.document.querySelector('[data-action="pick-toggle"]');
  const group = (id) => window.__wtpdfPageTranslation.groups.find((item) => item.id === id);
  const versionControls = (id) => window.document.getElementById(id).querySelector('.wtpdf-page-translation-version-controls');
  const stepVersion = (id, direction) => versionControls(id).querySelector(
    direction < 0 ? 'button[aria-label^="نمایش ترجمهٔ قبلی"]' : 'button[aria-label^="نمایش ترجمهٔ بعدی"]'
  ).click();
  const textWithoutBadges = (element) => {
    const clone = element.cloneNode(true);
    clone.querySelectorAll('.wtpdf-page-translation-version-controls, .wtpdf-page-translation-version-badge')
      .forEach((badge) => badge.remove());
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
  const toolbarCss = window.document.querySelector('style[data-wtpdf-page-translation-ui="style"]').textContent;
  const iconButtons = [...toolbar.querySelectorAll('button[data-action]')];
  check('toolbar is a compact bottom dock with labeled outline-icon actions',
    /bottom:calc\(/.test(toolbarCss) && /grid-template-areas:"workflow review"/.test(toolbarCss) &&
    !/top:12px/.test(toolbarCss) && /data-collapsed="true"/.test(toolbarCss) && iconButtons.length === 6 &&
    !toolbar.querySelector('[data-action="version-prev"], [data-action="version-next"]') &&
    iconButtons.every((button) => button.querySelector('svg') && button.getAttribute('aria-label')),
    iconButtons.map((button) => [button.dataset.action, button.getAttribute('aria-label')]));
  const dockToggle = toolbar.querySelector('[data-action="dock-toggle"]');
  dockToggle.click();
  const dockCollapsed = toolbar.dataset.collapsed === 'true' && dockToggle.getAttribute('aria-expanded') === 'false' &&
    dockToggle.getAttribute('aria-label') === 'بازکردن نوار ابزار';
  dockToggle.click();
  check('bottom dock can collapse to a small accessible handle and expand again',
    dockCollapsed && toolbar.dataset.collapsed === 'false' && dockToggle.getAttribute('aria-expanded') === 'true' &&
    dockToggle.getAttribute('aria-label') === 'جمع‌کردن نوار ابزار');
  check('only configured AI providers and their exact model names appear in the page menu',
    [...toolbar.querySelectorAll('[data-role="translation-engine"] option')].map((option) => option.value).join(',') === 'auto,google,mymemory,ai:openai' &&
    toolbar.querySelector('[data-role="translation-engine"] option[value="ai:openai"]').textContent.includes('gpt-test') &&
    !toolbar.querySelector('[data-role="translation-engine"]').textContent.includes('Gemini') &&
    !toolbar.querySelector('[data-role="translation-engine"]').textContent.includes('OpenRouter'));
  check('paragraphs without a saved translation show no version box at all',
    window.document.querySelectorAll('#article > .wtpdf-page-translation-version-controls, #second > .wtpdf-page-translation-version-controls').length === 0 &&
    !window.document.getElementById('article').classList.contains('wtpdf-page-translation-has-version-controls') &&
    !window.document.getElementById('second').classList.contains('wtpdf-page-translation-has-version-controls'));
  check('version box is a hover tooltip hidden until the mouse is over a translated paragraph',
    /wtpdf-page-translation-version-controls\{[^}]*position:absolute/.test(toolbarCss) &&
    /wtpdf-page-translation-version-controls\{[^}]*opacity:0/.test(toolbarCss) &&
    /wtpdf-page-translation-has-version-controls:hover > \.wtpdf-page-translation-version-controls/.test(toolbarCss) &&
    /wtpdf-page-translation-version-badge\{[^}]*font:600 clamp\(11px/.test(toolbarCss) &&
    /@media\(max-width:640px\)[\s\S]*?wtpdf-page-translation-version-badge\{font-size:10px/.test(toolbarCss) &&
    !window.document.getElementById('article').classList.contains('wtpdf-page-translation-has-version-controls'));

  const clickBlock = (element) => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  clickBlock(window.document.getElementById('article'));
  clickBlock(window.document.getElementById('second'));
  check('clicking page paragraphs selects and highlights them directly',
    window.__wtpdfPageTranslation.selectedGroups.size === 2 &&
    window.document.getElementById('article').classList.contains('wtpdf-page-translation-picked') &&
    window.document.getElementById('second').classList.contains('wtpdf-page-translation-picked'));
  pickToggle.click();
  check('ending selection keeps the chosen paragraphs highlighted, updates its icon label, and enables translation',
    !window.__wtpdfPageTranslation.pickMode && window.__wtpdfPageTranslation.selectedGroups.size === 2 &&
    pickToggle.getAttribute('aria-label') === 'انتخاب متن روی صفحه' &&
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

  check('per-paragraph version arrows enable previous/next and show that paragraph’s saved count',
    group('group-1').versions.length === 2 && !versionControls('article').children[0].disabled &&
    versionControls('article').children[2].disabled &&
    versionControls('article').querySelector('.wtpdf-page-translation-version-badge').textContent.includes('۱ ترجمه') &&
    versionControls('article').querySelector('.wtpdf-page-translation-version-badge').textContent.includes('Google Translate'));
  stepVersion('article', -1);
  check('previous-version control restores original text for the selected paragraph',
    textWithoutBadges(window.document.querySelector('#article')) === 'Hello world from this page.' &&
    !window.document.querySelector('#article').hasAttribute('dir'));
  stepVersion('article', 1);
  check('next-version control reapplies the saved RTL translation',
    window.document.querySelector('#article').textContent.includes('V1(') &&
    window.document.querySelector('#article').getAttribute('dir') === 'rtl');
  check('the still-untranslated paragraph keeps no version box after a sibling is translated',
    !versionControls('second') &&
    !window.document.getElementById('second').classList.contains('wtpdf-page-translation-has-version-controls'));

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
    versionControls('article').querySelector('.wtpdf-page-translation-version-badge').textContent.includes('OpenAI') &&
    versionControls('article').querySelector('.wtpdf-page-translation-version-badge').textContent.includes('مدل gpt-test'));
  stepVersion('article', -1);
  check('previous version remains selectable and shows its own translation source',
    window.document.querySelector('#article').textContent.includes('V1(') &&
    versionControls('article').querySelector('.wtpdf-page-translation-version-badge').textContent.includes('Google Translate'));
  stepVersion('article', 1);
  check('next version restores its own translated text and model label',
    window.document.querySelector('#article').textContent.includes('V2(') &&
    versionControls('article').querySelector('.wtpdf-page-translation-version-badge').textContent.includes('مدل gpt-test'));

  // کلیک دوباره با همان موتور، پاراگراف ترجمه‌شده را دوباره به سرویس نمی‌فرستد
  {
    const requestCountBefore = requests.length;
    toolbar.querySelector('[data-action="translate-selected"]').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    check('re-clicking translate with the same engine skips the already-translated paragraph',
      requests.length === requestCountBefore &&
      /قبلاً ترجمه شده‌اند و دوباره ارسال نمی‌شوند/.test(toolbar.querySelector('[data-role="status"]').textContent) &&
      group('group-1').status === 'translated', { requests: requests.length, status: group('group-1').status });
  }

  // موتور را عوض می‌کنیم تا پاراگراف ترجمه‌شده رد نشود و مسیر خطا تست شود
  engineSelect.value = 'google'; engineSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
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
  stepVersion('article', -1);
  stepVersion('article', -1);
  check('older complete translation remains selectable after failed and partial retries',
    window.document.querySelector('#article').textContent.includes('V2('));
  stepVersion('article', 1);
  stepVersion('article', 1);

  pickToggle.click();
  clickBlock(window.document.getElementById('article'));
  clickBlock(window.document.getElementById('history'));
  pickToggle.click();
  // هر کلیک با موتور متفاوت نسخهٔ جدید می‌سازد (با موتور یکسان رد می‌شود)
  for (let index = 0; index < 8; index++) {
    engineSelect.value = index % 2 === 0 ? 'google' : 'ai:openai';
    engineSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    toolbar.querySelector('[data-action="translate-selected"]').click();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  check('keeps the latest six translations for a paragraph, including five prior versions',
    group('group-3').versions.length === 7 && group('group-3').activeVersion === 6 &&
    window.document.querySelector('#history').textContent.includes('V14(') &&
    versionControls('history').querySelector('.wtpdf-page-translation-version-badge').textContent.includes('۶ ترجمه'));
  for (let index = 0; index < 5; index++) stepVersion('history', -1);
  check('the five earlier saved translations remain reachable after the history limit is reached',
    window.document.querySelector('#history').textContent.includes('V9('));
  for (let index = 0; index < 5; index++) stepVersion('history', 1);
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
