// Tests for the in-extension GitHub update check (update.js)
const fs = require('fs');
const vm = require('vm');
const { JSDOM } = require('jsdom');

let failures = 0;
const check = (n, c, e) => { if (c) console.log('PASS:', n); else { failures++; console.log('FAIL:', n, e !== undefined ? JSON.stringify(e) : ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');

function boot(fetchImpl, downloadsImpl, currentVersion = '2.46', confirmImpl = () => true) {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><button id="updateBtn"></button><div id="updateStatus" class="hidden"></div>' +
      '<input id="updateBranch"><button id="saveUpdateBranch"></button></body></html>',
    { url: 'chrome-extension://ext/popup.html', pretendToBeVisual: true, runScripts: 'dangerously' }
  );
  const { window } = dom;
  const ctx = dom.getInternalVMContext();
  const downloads = [];
  const stored = {};
  const confirmCalls = [];
  window.chrome = {
    runtime: { getManifest: () => ({ version: currentVersion }) },
    storage: { local: {
      get: async (key) => ({ [key]: stored[key] }),
      set: async (values) => Object.assign(stored, values)
    } },
    downloads: { download: async (opts) => { downloads.push(opts); if (downloadsImpl) downloadsImpl(opts); return 1; } }
  };
  window.confirm = (message) => { confirmCalls.push(message); return confirmImpl(message); };
  window.fetch = fetchImpl;
  window.PIC_TO_PDF_UPDATE_BRANCH = 'arena/test-updater';
  vm.runInContext(fs.readFileSync(__dirname + '/update.js', 'utf8'), ctx, { filename: 'update.js' });
  return {
    window, downloads, confirmCalls,
    btn: window.document.getElementById('updateBtn'),
    status: window.document.getElementById('updateStatus'),
    branchInput: window.document.getElementById('updateBranch')
  };
}

const jsonResponse = (manifest) => ({
  ok: true, status: 200,
  json: async () => ({ content: b64(manifest) })
});

(async () => {
  // 1. same version -> up-to-date message, no download
  {
    let checkedUrl = '';
    const h = boot(async (url) => { checkedUrl = url; return jsonResponse({ version: '2.46' }); });
    h.btn.click();
    await sleep(10);
    check('up-to-date: success message shown', h.status.classList.contains('ok') && /آخرین نسخه/.test(h.status.textContent), h.status.textContent);
    check('version check uses the configured update branch', /ref=arena%2Ftest-updater/.test(checkedUrl), checkedUrl);
    check('up-to-date: nothing downloaded', h.downloads.length === 0);
    check('up-to-date: button re-enabled', !h.btn.disabled);
  }

  // 2. newer version -> download starts with the codeload zip and instructions appear
  {
    const h = boot(async () => jsonResponse({ version: '2.47.1' }));
    h.btn.click();
    await sleep(10);
    check('new version: download requested from the configured codeload branch',
      h.downloads.length === 1 && /codeload\.github\.com/.test(h.downloads[0].url) && /arena\/test-updater/.test(h.downloads[0].url), h.downloads);
    check('new version: asks for approval before downloading', h.confirmCalls.length === 1 && /دانلود/.test(h.confirmCalls[0]));
    check('new version: instruction message mentions Reload',
      h.status.classList.contains('ok') && /Reload/.test(h.status.textContent) && /2\.47\.1/.test(h.status.textContent), h.status.textContent);
  }

  // A user may target any valid GitHub branch without changing the extension source.
  {
    let checkedUrl = '';
    const h = boot(async (url) => { checkedUrl = url; return jsonResponse({ version: '2.47.1' }); });
    h.branchInput.value = 'feature/other-branch';
    h.btn.click();
    await sleep(10);
    check('custom branch: manifest request uses the entered branch', /ref=feature%2Fother-branch/.test(checkedUrl), checkedUrl);
    check('custom branch: download uses the same branch', /feature\/other-branch/.test(h.downloads[0] && h.downloads[0].url));
  }

  // Declining confirmation cancels the update without downloading anything.
  {
    const h = boot(async () => jsonResponse({ version: '2.47.1' }), null, '2.46', () => false);
    h.btn.click();
    await sleep(10);
    check('cancelled update: asks once and downloads nothing', h.confirmCalls.length === 1 && h.downloads.length === 0);
    check('cancelled update: shows cancellation status', /لغو شد/.test(h.status.textContent), h.status.textContent);
  }

  // A newer installed build must never be mislabeled as the latest published channel build.
  {
    const h = boot(async () => jsonResponse({ version: '2.45' }), null, '2.46');
    h.btn.click();
    await sleep(10);
    check('newer local version: correctly reports channel is older',
      h.status.classList.contains('ok') && /جدیدتر/.test(h.status.textContent), h.status.textContent);
    check('newer local version: does not download or downgrade', h.downloads.length === 0);
  }

  // 3. GitHub rate limit (403) -> friendly Persian error, no download
  {
    const h = boot(async () => ({ ok: false, status: 403, json: async () => ({}) }));
    h.btn.click();
    await sleep(10);
    check('rate limit: error message shown', h.status.classList.contains('err') && /محدودیت/.test(h.status.textContent), h.status.textContent);
    check('rate limit: nothing downloaded', h.downloads.length === 0);
  }

  // 4. network failure -> error state, button re-enabled
  {
    const h = boot(async () => { throw new Error('Failed to fetch'); });
    h.btn.click();
    await sleep(10);
    check('network error: error message shown', h.status.classList.contains('err') && /ناموفق/.test(h.status.textContent), h.status.textContent);
    check('network error: button re-enabled', !h.btn.disabled && !h.btn.classList.contains('spinning'));
  }

  // 5. malformed payload -> handled as an error, not a crash
  {
    const h = boot(async () => ({ ok: true, status: 200, json: async () => ({ content: b64({}) }) }));
    h.btn.click();
    await sleep(10);
    check('malformed manifest: graceful error', h.status.classList.contains('err'), h.status.textContent);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL UPDATE TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(2); });
