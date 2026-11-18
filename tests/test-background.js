// Tests for the MV3 service worker (background.js) with mocked chrome.* APIs.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../extension');
const vm = require('vm');

let failures = 0;
const check = (n, c, e) => { if (c) console.log('PASS:', n); else { failures++; console.log('FAIL:', n, e !== undefined ? JSON.stringify(e) : ''); } };

function bootBackground(initialStorage, translationApis = {}) {
  const store = new Map(Object.entries(initialStorage || {}));
  const listeners = {};
  const chrome = {
    runtime: {
      id: 'ext',
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
          if (Array.isArray(key)) return Object.fromEntries(key.map((item) => [item, store.get(item)]));
          return { [key]: store.get(key) };
        },
        set: async (obj) => Object.entries(obj).forEach(([k, v]) => store.set(k, v)),
        remove: async (keys) => (Array.isArray(keys) ? keys : [keys]).forEach((k) => store.delete(k))
      }
    },
    tabs: {
      create: (opts, cb) => cb({ id: 42 }),
      update: (id, patch, cb) => cb(),
      get: async () => null,
      duplicate: async () => null,
      sendMessage: async () => null,
      remove: async () => {},
      onUpdated: { addListener: () => {}, removeListener: () => {} }
    },
    scripting: { executeScript: async () => [] }
  };
  const ctx = { chrome, console, URL, setTimeout, Math, Date, Promise, ...translationApis };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/background.js'), 'utf8'), ctx, { filename: 'background.js' });
  return { chrome, listeners, store, ctx };
}

(async () => {
  // 1. startup cleanup removes only expired jobs; active and legacy jobs survive tab restoration
  {
    const b = bootBackground({
      job_active: { createdAt: Date.now(), urls: ['u'] },
      job_expired: { createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000, urls: ['v'] },
      job_legacy: { urls: ['legacy'] },
      page_profile_123: { version: 1 },
      other_setting: { keep: true }
    });
    await b.listeners.startup();
    check('startup removes expired jobs only', !b.store.has('job_expired') && b.store.has('job_active'));
    check('startup preserves legacy jobs without timestamps', b.store.has('job_legacy'));
    check('startup keeps profile and settings', b.store.has('page_profile_123') && b.store.has('other_setting'));
    await b.listeners.installed({ reason: 'update' });
    check('extension update preserves active jobs', b.store.has('job_active'));
    await b.listeners.installed({ reason: 'install' });
    check('install cleanup remains safe', b.store.has('job_active') && b.store.has('job_legacy'));
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
    check('job stored with cleanup timestamp', !!jobKey && b.store.get(jobKey).urls.length === 2 &&
      b.store.get(jobKey).tabId === 7 && Number.isFinite(b.store.get(jobKey).createdAt));
    check('response ok with tab id', response && response.ok === true && response.tabId === 42, response);
  }

  // 3. a failed preview-tab creation removes its orphaned job
  {
    const b = bootBackground({});
    b.chrome.tabs.create = (opts, cb) => {
      b.chrome.runtime.lastError = { message: 'tab creation blocked' };
      cb(null);
      b.chrome.runtime.lastError = null;
    };
    let response = null;
    b.listeners.message(
      { type: 'WTPDF_URLS', urls: ['a'], name: 'c.pdf' },
      { tab: { id: 7, url: 'https://comic.test/ep' } },
      (r) => { response = r; }
    );
    await new Promise((r) => setTimeout(r, 10));
    check('failed tab creation reports the error', response && response.ok === false, response);
    check('failed tab creation leaves no orphan job', ![...b.store.keys()].some((k) => k.startsWith('job_')));
  }

  // 4. webpage text is translated without any stored consent flag (the consent checkbox was removed)
  {
    let translateCalls = 0;
    const b = bootBackground({}, {
      TranslateTools: { translate: async () => { translateCalls++; return { ok: true, text: 'x' }; } },
      AiTranslateTools: {}
    });
    let response = null;
    b.listeners.message({ type: 'WTPDF_TRANSLATE_PAGE_BATCH', entries: [{ id: 'p000001', text: 'Private text.' }] },
      { tab: { id: 19, url: 'https://example.test/' } }, (result) => { response = result; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    check('webpage translation runs without a stored consent flag',
      response && response.ok === true && translateCalls === 1, response);
  }

  // 5. webpage text is translated only through the explicit extension message and uses the configured route
  {
    const calls = [];
    const b = bootBackground({}, {
      TranslateTools: { translate: async (text, sourceLang, _fetchFn, engine) => {
        calls.push({ text, sourceLang, engine });
        return { ok: true, text: `FA:${text}` };
      } },
      AiTranslateTools: { translateWithFailover: async () => { throw new Error('AI should not run'); } }
    });
    let response = null;
    const keepOpen = b.listeners.message({
      type: 'WTPDF_TRANSLATE_PAGE_BATCH', entries: [{ id: 'p000001', text: 'Hello world.' }]
    }, { tab: { id: 18, url: 'https://example.test/article' } }, (result) => { response = result; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    check('page translation keeps async response open and defaults to free translation', keepOpen === true &&
      calls.length === 1 && calls[0].text === 'Hello world.' && calls[0].sourceLang === 'auto' && calls[0].engine === 'auto');
    check('free page translation returns only the translated text keyed by its source ID',
      response && response.ok === true && response.translations[0].id === 'p000001' &&
      response.translations[0].text === 'FA:Hello world.' && response.provider === 'Google Translate / MyMemory', response);
  }
  {
    const calls = [];
    const settings = {
      engine: 'ai', enabled: false, provider: 'openai', skill: 'web style',
      providers: { openai: { model: 'gpt-web', profiles: [{ name: 'Saved', apiKey: 'private-key' }] } }
    };
    const b = bootBackground({ gemini_translation_settings_v1: settings }, {
      TranslateTools: { translate: async () => { throw new Error('free fallback must not run'); } },
      AiTranslateTools: {
        translateWithFailover: async (options) => {
          calls.push(options);
          return { translations: new Map([[options.entries[0].id, 'سلام']]), profileName: 'Saved' };
        }
      }
    });
    let response = null;
    b.listeners.message({ type: 'WTPDF_TRANSLATE_PAGE_BATCH', entries: [{ id: 'p000002', text: 'Good morning.' }] },
      { tab: { id: 19, url: 'https://example.test/' } }, (result) => { response = result; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    check('configured AI is used for webpage text with a general webpage context',
      calls.length === 1 && calls[0].provider === 'openai' && calls[0].context === 'webpage' &&
      calls[0].entries[0].text === 'Good morning.' && calls[0].profiles[0].apiKey === 'private-key' &&
      response && response.provider === 'OpenAI' && response.model === 'gpt-web');
    check('AI response does not return or expose saved API keys',
      response && response.translations[0].text === 'سلام' && !JSON.stringify(response).includes('private-key'), response);
  }
  {
    const calls = [];
    const settings = {
      engine: 'auto', provider: 'gemini',
      providers: { openrouter: { model: 'openrouter/model-x', profiles: [{ name: 'Routed', apiKey: 'router-secret' }] } }
    };
    const b = bootBackground({ gemini_translation_settings_v1: settings }, {
      TranslateTools: { translate: async () => { throw new Error('explicit AI selection must not use free translation'); } },
      AiTranslateTools: { translateWithFailover: async (options) => {
        calls.push(options);
        return { translations: new Map([[options.entries[0].id, 'ترجمهٔ OpenRouter']]) };
      } }
    });
    let response = null;
    b.listeners.message({ type: 'WTPDF_TRANSLATE_PAGE_BATCH', engine: 'ai:openrouter',
      entries: [{ id: 'p000003', text: 'Choose this AI engine.' }] },
    { tab: { id: 20, url: 'https://example.test/' } }, (result) => { response = result; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    check('page selector chooses an AI provider independently of the saved default',
      calls.length === 1 && calls[0].provider === 'openrouter' && calls[0].model === 'openrouter/model-x' &&
      calls[0].profiles[0].apiKey === 'router-secret' && response && response.provider === 'OpenRouter' &&
      response.translations[0].text === 'ترجمهٔ OpenRouter' && !JSON.stringify(response).includes('router-secret'));
  }
  {
    const calls = [];
    const b = bootBackground({ gemini_translation_settings_v1: { engine: 'mymemory', enabled: false } }, {
      TranslateTools: { translate: async (text, sourceLang, _fetchFn, engine) => {
        calls.push({ text, sourceLang, engine });
        return { ok: true, text: 'ترجمهٔ Google' };
      } },
      AiTranslateTools: { translateWithFailover: async () => { throw new Error('selected Google, not AI'); } }
    });
    let response = null;
    b.listeners.message({ type: 'WTPDF_TRANSLATE_PAGE_BATCH', engine: 'google', entries: [{ id: 'p000003', text: 'Sample.' }] },
      { tab: { id: 20, url: 'https://example.test/' } }, (result) => { response = result; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    check('page translation honors the explicit Google Translate choice',
      calls.length === 1 && calls[0].engine === 'google' && response &&
      response.provider === 'Google Translate' && response.translations[0].text === 'ترجمهٔ Google');
  }
  {
    const calls = [];
    const b = bootBackground({ gemini_translation_settings_v1: { engine: 'mymemory', enabled: false } }, {
      TranslateTools: { translate: async (text, sourceLang, _fetchFn, engine) => {
        calls.push({ text, sourceLang, engine });
        return { ok: true, text: 'ترجمهٔ MyMemory' };
      } },
      AiTranslateTools: { translateWithFailover: async () => { throw new Error('selected MyMemory, not AI'); } }
    });
    let response = null;
    b.listeners.message({ type: 'WTPDF_TRANSLATE_PAGE_BATCH', entries: [{ id: 'p000003', text: 'Sample.' }] },
      { tab: { id: 21, url: 'https://example.test/' } }, (result) => { response = result; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    check('page translation honors the explicitly selected MyMemory engine',
      calls.length === 1 && calls[0].engine === 'mymemory' && response &&
      response.provider === 'MyMemory' && response.translations[0].text === 'ترجمهٔ MyMemory');
  }
  {
    let translateCalls = 0;
    const b = bootBackground({}, {
      TranslateTools: { translate: async () => { translateCalls++; return { ok: true, text: 'x' }; } },
      AiTranslateTools: {}
    });
    let response = null;
    b.listeners.message({ type: 'WTPDF_TRANSLATE_PAGE_BATCH', entries: [{ id: 'bad id', text: 'No.' }] },
      { tab: { id: 20, url: 'https://example.test/' } }, (result) => { response = result; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    check('page translation rejects invalid IDs before contacting a provider',
      response && response.ok === false && translateCalls === 0, response);
  }

  // 6. the popup launches a translated copy directly, without an intermediate consent page
  {
    const b = bootBackground({});
    const calls = { duplicate: [], inject: [], send: [], update: [] };
    b.chrome.tabs.get = async (id) => ({ id, status: 'complete', url: 'https://example.test/story' });
    b.chrome.tabs.duplicate = async (id) => { calls.duplicate.push(id); return { id: 44, status: 'complete', url: 'https://example.test/story' }; };
    b.chrome.tabs.sendMessage = async (id, message) => {
      calls.send.push({ id, message });
      return { ok: true, readyForSelection: true, paragraphs: 3 };
    };
    b.chrome.tabs.update = async (id, patch) => { calls.update.push({ id, patch }); };
    b.chrome.scripting.executeScript = async (details) => { calls.inject.push(details); return []; };
    let response = null;
    const keepOpen = b.listeners.message({ type: 'WTPDF_PAGE_TRANSLATE_CREATE_COPY', tabId: 19, engine: 'google' },
      { id: 'ext', url: 'chrome-extension://ext/src/popup/popup.html' }, (result) => { response = result; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    check('popup copy-launch request stays alive while the translated tab is prepared', keepOpen === true);
    check('translated copy is duplicated, injected, and started directly with the chosen engine',
      calls.duplicate[0] === 19 && calls.inject[0].target.tabId === 44 &&
      calls.inject[0].files.join(',') === 'src/core/page-translation.js,src/page-translator/content.js' &&
      calls.send[0].message.type === 'WTPDF_PAGE_TRANSLATE_START' && calls.send[0].message.engine === 'google' &&
      Array.isArray(calls.send[0].message.availableAiEngines) && calls.send[0].message.availableAiEngines.length === 0 &&
      response && response.ok && response.paragraphs === 3 && calls.update[0].patch.active === true, { calls, response });
  }
  {
    const b = bootBackground({
      gemini_translation_settings_v1: {
        providers: { openai: { model: 'gpt-configured', profiles: [{ name: 'Ready', apiKey: 'must-not-leak' }] } }
      }
    });
    const calls = { send: [], duplicate: 0 };
    b.chrome.tabs.get = async (id) => ({ id, status: 'complete', url: 'https://example.test/' });
    b.chrome.tabs.duplicate = async () => { calls.duplicate++; return { id: 46, status: 'complete', url: 'https://example.test/' }; };
    b.chrome.tabs.sendMessage = async (_id, message) => { calls.send.push(message); return { ok: true, paragraphs: 1 }; };
    let response = null;
    b.listeners.message({ type: 'WTPDF_PAGE_TRANSLATE_CREATE_COPY', tabId: 19, engine: 'ai:openai' },
      { id: 'ext', url: 'chrome-extension://ext/src/popup/popup.html' }, (result) => { response = result; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    check('translated copy receives only configured AI provider/model metadata, never API keys',
      calls.duplicate === 1 && calls.send[0].availableAiEngines.length === 1 &&
      calls.send[0].availableAiEngines[0].value === 'ai:openai' && calls.send[0].availableAiEngines[0].model === 'gpt-configured' &&
      !JSON.stringify(calls.send[0]).includes('must-not-leak') && response && response.ok);
  }
  {
    const b = bootBackground({});
    let duplicateCalls = 0, response = null;
    b.chrome.tabs.duplicate = async () => { duplicateCalls++; return { id: 45, status: 'complete' }; };
    b.listeners.message({ type: 'WTPDF_PAGE_TRANSLATE_CREATE_COPY', tabId: 19, engine: 'ai:gemini' },
      { id: 'ext', url: 'chrome-extension://ext/src/popup/popup.html' }, (result) => { response = result; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    check('unconfigured AI providers cannot be selected or opened',
      duplicateCalls === 0 && response && !response.ok && /کلید API/.test(response.error));
  }
  {
    // تنظیمات قدیمی کلید Gemini را در سطح بالا نگه می‌داشت؛ اگر فرمت جدید
    // providers وجود دارد ولی پروفایل Gemini خالی است، کلید سطح بالا باید پیدا شود.
    const b = bootBackground({
      gemini_translation_settings_v1: {
        providers: { openai: { model: 'gpt-configured', profiles: [{ name: 'Ready', apiKey: 'openai-key' }] } },
        apiKey: 'legacy-gemini-key', model: 'gemini-2.5-flash'
      }
    });
    const calls = { send: [], duplicate: 0 };
    b.chrome.tabs.get = async (id) => ({ id, status: 'complete', url: 'https://example.test/' });
    b.chrome.tabs.duplicate = async () => { calls.duplicate++; return { id: 48, status: 'complete', url: 'https://example.test/' }; };
    b.chrome.tabs.sendMessage = async (_id, message) => { calls.send.push(message); return { ok: true, paragraphs: 1 }; };
    b.chrome.tabs.update = async () => {};
    b.chrome.scripting.executeScript = async () => [];
    let response = null;
    b.listeners.message({ type: 'WTPDF_PAGE_TRANSLATE_CREATE_COPY', tabId: 19, engine: 'ai:gemini' },
      { id: 'ext', url: 'chrome-extension://ext/src/popup/popup.html' }, (result) => { response = result; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    check('legacy top-level Gemini key is found when new-format providers exist but Gemini profiles are empty',
      calls.duplicate === 1 && response && response.ok &&
      calls.send[0].availableAiEngines.some((item) => item.value === 'ai:gemini') &&
      !JSON.stringify(calls.send[0]).includes('legacy-gemini-key'), { calls, response });
  }
  {
    const b = bootBackground({});
    const calls = { duplicate: [], inject: [], send: [] };
    b.chrome.tabs.get = async (id) => ({ id, status: 'complete', url: 'https://example.test/story' });
    b.chrome.tabs.duplicate = async (id) => { calls.duplicate.push(id); return { id: 47, status: 'complete', url: 'https://example.test/story' }; };
    b.chrome.tabs.sendMessage = async (id, message) => { calls.send.push({ id, message }); return { ok: true, paragraphs: 2 }; };
    b.chrome.tabs.update = async () => {};
    b.chrome.scripting.executeScript = async (details) => { calls.inject.push(details); return []; };
    let response = null;
    b.listeners.message({ type: 'WTPDF_PAGE_TRANSLATE_CREATE_COPY', tabId: 19, engine: 'auto' },
      { id: 'ext', url: 'chrome-extension://ext/src/popup/popup.html' }, (result) => { response = result; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    check('translated copy opens without any stored consent flag',
      calls.duplicate[0] === 19 && calls.inject.length === 1 && response && response.ok && response.paragraphs === 2, { calls, response });
  }

  // 7. unrelated messages are ignored (no return value, no throw)
  {
    const b = bootBackground({});
    const ret = b.listeners.message({ type: 'SOMETHING_ELSE' }, {}, () => {});
    check('unrelated message ignored', ret === undefined);
    check('no job stored for unrelated message', b.store.size === 0);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL BACKGROUND TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(2); });
