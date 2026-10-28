// Tests for the MV3 service worker (background.js) with mocked chrome.* APIs.
const fs = require('fs');
const vm = require('vm');

let failures = 0;
const check = (n, c, e) => { if (c) console.log('PASS:', n); else { failures++; console.log('FAIL:', n, e !== undefined ? JSON.stringify(e) : ''); } };

function bootBackground(initialStorage) {
  const store = new Map(Object.entries(initialStorage || {}));
  const listeners = {};
  const chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { listeners.message = fn; } },
      onStartup: { addListener: (fn) => { listeners.startup = fn; } },
      onInstalled: { addListener: (fn) => { listeners.installed = fn; } },
      lastError: null,
      getURL: (p) => 'chrome-extension://ext/' + p
    },
    storage: {
      local: {
        get: async (key) => {
          if (key === null) return Object.fromEntries(store);
          return { [key]: store.get(key) };
        },
        set: async (obj) => Object.entries(obj).forEach(([k, v]) => store.set(k, v)),
        remove: async (keys) => (Array.isArray(keys) ? keys : [keys]).forEach((k) => store.delete(k))
      }
    },
    tabs: {
      create: (opts, cb) => cb({ id: 42 }),
      update: (id, patch, cb) => cb(),
      remove: (id, cb) => { removedTabs.push(id); if (cb) cb(); }
    }
  };
  const removedTabs = [];
  const ctx = { chrome, console, URL, setTimeout, Math, Date, Promise };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(__dirname + '/background.js', 'utf8'), ctx, { filename: 'background.js' });
  return { chrome, listeners, store, ctx, removedTabs };
}

(async () => {
  // 1. orphan job pruning on startup keeps non-job keys
  {
    const b = bootBackground({
      job_abc: { urls: ['u'] },
      job_def: { urls: ['v'] },
      page_profile_123: { version: 1 },
      other_setting: { keep: true }
    });
    await b.listeners.startup();
    check('startup removes orphan jobs', !b.store.has('job_abc') && !b.store.has('job_def'));
    check('startup keeps profile and settings', b.store.has('page_profile_123') && b.store.has('other_setting'));
    // idempotent on empty storage
    await b.listeners.installed();
    check('installed pruning is safe with no jobs', b.store.size === 2, b.store.size);
  }

  // 2. normal message flow stores the job and opens the viewer tab
  {
    const b = bootBackground({});
    let response = null;
    const sender = { tab: { id: 7, url: 'https://comic.test/ep' } };
    const keepOpen = b.listeners.message(
      { type: 'WTPDF_URLS', urls: ['a', 'b'], name: 'c.pdf', pageUrl: 'https://comic.test/ep', skippedInline: 1 },
      sender,
      (r) => { response = r; }
    );
    check('listener signals async response', keepOpen === true);
    await new Promise((r) => setTimeout(r, 10));
    const jobKey = [...b.store.keys()].find((k) => k.startsWith('job_'));
    check('job stored', !!jobKey && b.store.get(jobKey).urls.length === 2 && b.store.get(jobKey).tabId === 7);
    check('response ok with tab id', response && response.ok === true && response.tabId === 42, response);
    check('web jobs never close the sender tab', b.removedTabs.length === 0, b.removedTabs);
  }

  // 2b. imported PDF job: sent from the dedicated import tab, which gets closed after the viewer opens
  {
    const b = bootBackground({});
    let response = null;
    b.listeners.message(
      { type: 'WTPDF_LOCAL_JOB', urls: ['pdf-internal://x/0', 'pdf-internal://x/1'], name: 'book.pdf', source: 'pdf-import' },
      { tab: { id: 9, url: 'chrome-extension://ext/pdfimport.html?id=x' } },
      (r) => { response = r; }
    );
    await new Promise((r) => setTimeout(r, 10));
    const jobKey = [...b.store.keys()].find((k) => k.startsWith('job_'));
    const job = b.store.get(jobKey);
    check('local job stored with pdf-import source', job && job.source === 'pdf-import' && job.urls.length === 2 && job.tabId === 9, job);
    check('local job opens viewer and responds', response && response.ok === true && response.tabId === 42, response);
    check('import tab is closed once the viewer opens', b.removedTabs.length === 1 && b.removedTabs[0] === 9, b.removedTabs);
  }

  // 3. unrelated messages are ignored (no return value, no throw)
  {
    const b = bootBackground({});
    const ret = b.listeners.message({ type: 'SOMETHING_ELSE' }, {}, () => {});
    check('unrelated message ignored', ret === undefined);
    check('no job stored for unrelated message', b.store.size === 0);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL BACKGROUND TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(2); });
