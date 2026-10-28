// Tests for the in-extension GitHub update check (update.js)
const fs = require('fs');
const vm = require('vm');
const { JSDOM } = require('jsdom');

let failures = 0;
const check = (n, c, e) => { if (c) console.log('PASS:', n); else { failures++; console.log('FAIL:', n, e !== undefined ? JSON.stringify(e) : ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');

function boot(fetchImpl, downloadsImpl) {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><button id="updateBtn"></button><div id="updateStatus" class="hidden"></div></body></html>',
    { url: 'chrome-extension://ext/popup.html', pretendToBeVisual: true, runScripts: 'dangerously' }
  );
  const { window } = dom;
  const ctx = dom.getInternalVMContext();
  const downloads = [];
  window.chrome = {
    runtime: { getManifest: () => ({ version: '2.46' }) },
    downloads: { download: async (opts) => { downloads.push(opts); if (downloadsImpl) downloadsImpl(opts); return 1; } }
  };
  window.fetch = fetchImpl;
  vm.runInContext(fs.readFileSync(__dirname + '/update.js', 'utf8'), ctx, { filename: 'update.js' });
  return { window, downloads, btn: window.document.getElementById('updateBtn'), status: window.document.getElementById('updateStatus') };
}

const jsonResponse = (manifest) => ({
  ok: true, status: 200,
  json: async () => ({ content: b64(manifest) })
});

(async () => {
  // 1. same version -> up-to-date message, no download
  {
    const h = boot(async () => jsonResponse({ version: '2.46' }));
    h.btn.click();
    await sleep(10);
    check('up-to-date: success message shown', h.status.classList.contains('ok') && /آخرین نسخه/.test(h.status.textContent), h.status.textContent);
    check('up-to-date: nothing downloaded', h.downloads.length === 0);
    check('up-to-date: button re-enabled', !h.btn.disabled);
  }

  // 2. newer version -> download starts with the codeload zip and instructions appear
  {
    const h = boot(async () => jsonResponse({ version: '2.47.1' }));
    h.btn.click();
    await sleep(10);
    check('new version: download requested from codeload',
      h.downloads.length === 1 && /codeload\.github\.com/.test(h.downloads[0].url) && /main/.test(h.downloads[0].url), h.downloads);
    check('new version: instruction message mentions Reload',
      h.status.classList.contains('ok') && /Reload/.test(h.status.textContent) && /2\.47\.1/.test(h.status.textContent), h.status.textContent);
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
