// Tests for the consent and duplicate-tab flow of webpage translation.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

let failures = 0;
function check(name, condition, extra) {
  if (condition) console.log('PASS:', name);
  else { failures++; console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

async function bootPage(url, sourceTab) {
  const html = fs.readFileSync(path.join(__dirname, '../src/page-translator/page.html'), 'utf8');
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const calls = { duplicate: [], inject: [], send: [] };
  const listeners = [];
  window.chrome = {
    runtime: {
      getURL: (resource) => `chrome-extension://ext/${resource}`,
      onMessage: { addListener: (callback) => listeners.push(callback) }
    },
    tabs: {
      get: async (id) => ({ ...sourceTab, id }),
      duplicate: async (id) => { calls.duplicate.push(id); return { id: 44, status: 'complete', url: sourceTab.url }; },
      sendMessage: async (id, message) => { calls.send.push({ id, message }); return { ok: true, readyForSelection: true, paragraphs: 4, textNodes: 4 }; },
      update: async (id, update) => ({ id, ...update }),
      onUpdated: { addListener() {}, removeListener() {} }
    },
    scripting: { executeScript: async (details) => { calls.inject.push(details); return []; } },
    storage: { local: { get: async () => ({}) } }
  };
  const code = fs.readFileSync(path.join(__dirname, '../src/page-translator/page.js'), 'utf8');
  vm.runInContext(code, dom.getInternalVMContext(), { filename: 'page.js' });
  return { dom, window, calls, listeners };
}

(async () => {
  {
    const app = await bootPage('chrome-extension://ext/src/page-translator/page.html?tabId=33&host=news.example.test', {
      url: 'https://news.example.test/story/1', title: 'A story'
    });
    const { window, calls } = app;
    const host = window.document.getElementById('sourceHost').textContent;
    const consent = window.document.getElementById('translationConsent');
    const start = window.document.getElementById('startTranslationBtn');
    check('consent screen names the source site and explains text-only translation',
      host === 'news.example.test' && /فقط متن/.test(window.document.body.textContent));
    check('translation cannot start before consent', start.disabled === true);
    start.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    check('no duplicate is opened without consent', calls.duplicate.length === 0);

    consent.checked = true;
    consent.dispatchEvent(new window.Event('change', { bubbles: true }));
    check('explicit consent enables the start button', start.disabled === false);
    start.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    check('consented action duplicates the active page in a new tab', calls.duplicate.length === 1 && calls.duplicate[0] === 33);
    check('only the translation helper and isolated content script are injected into the duplicate',
      calls.inject.length === 1 && calls.inject[0].target.tabId === 44 &&
      calls.inject[0].files.join(',') === 'src/core/page-translation.js,src/page-translator/content.js', calls.inject);
  check('translated copy starts in paragraph-selection mode and reports the available paragraphs',
    calls.send.length === 1 && calls.send[0].id === 44 &&
    calls.send[0].message.type === 'WTPDF_PAGE_TRANSLATE_START' &&
    /4 پاراگراف/.test(window.document.getElementById('pageStatus').textContent), calls);
  }
  {
    const app = await bootPage('chrome-extension://ext/src/page-translator/page.html?tabId=35&host=example.test', {
      url: 'chrome://settings/', title: 'Settings'
    });
    const { window, calls } = app;
    const consent = window.document.getElementById('translationConsent');
    consent.checked = true;
    consent.dispatchEvent(new window.Event('change', { bubbles: true }));
    window.document.getElementById('startTranslationBtn').click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    check('revalidates the source tab and refuses browser-internal pages',
      calls.duplicate.length === 0 && /صفحه‌های داخلی/.test(window.document.getElementById('pageStatus').textContent),
      window.document.getElementById('pageStatus').textContent);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PAGE TRANSLATOR UI TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((error) => { console.error('TEST CRASH:', error); process.exit(2); });
