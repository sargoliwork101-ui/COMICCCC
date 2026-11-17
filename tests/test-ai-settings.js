// Regression tests for the extension's standalone AI API settings page.
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
  const html = fs.readFileSync(path.join(__dirname, '../src/ai-settings/settings.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'chrome-extension://test/src/ai-settings/settings.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const key = 'gemini_translation_settings_v1';
  const storedValue = {
    enabled: true,
    provider: 'openai',
    providers: {
      openai: { model: 'gpt-4o-mini', profiles: [{ id: 'p1', name: 'کار اصلی', apiKey: 'secret-existing' }] },
      gemini: { model: 'gemini-2.5-flash', profiles: [] },
      openrouter: { model: 'openai/gpt-4o-mini', profiles: [] },
      avalai: { model: 'gpt-6-luna', profiles: [] }
    },
    skill: 'ترجمهٔ روان'
  };
  const calls = { gets: [], sets: [], fetch: [] };
  window.chrome = { storage: { local: {
    get: async (name) => { calls.gets.push(name); return { [key]: storedValue }; },
    set: async (value) => { calls.sets.push(JSON.parse(JSON.stringify(value))); }
  } } };
  window.fetch = async (url, options) => {
    calls.fetch.push({ url, options });
    const data = url.includes('generativelanguage.googleapis.com')
      ? { name: 'models/gemini-2.5-flash' } : { data: [{ id: 'gpt-4o-mini' }] };
    return { ok: true, status: 200, json: async () => data };
  };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/core/ai-translate.js'), 'utf8'), dom.getInternalVMContext(), { filename: 'ai-translate.js' });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/ai-settings/settings.js'), 'utf8'), dom.getInternalVMContext(), { filename: 'settings.js' });
  await pause();

  const $ = (id) => window.document.getElementById(id);
  check('settings page loads the same local key used by the viewer and webpage translator',
    calls.gets[0] === key && $('provider').value === 'openai' && $('model').value === 'gpt-4o-mini');
  check('existing API profile, enable switch, and translation instructions are restored',
    $('aiEnabled').checked && $('profiles').querySelector('input[type=password]').value === 'secret-existing' && $('skill').value === 'ترجمهٔ روان');
  check('provider choices include all services supported by the extension',
    [...$('provider').options].map((option) => option.value).join(',') === 'gemini,openai,openrouter,avalai');

  $('provider').value = 'gemini';
  $('provider').dispatchEvent(new window.Event('change', { bubbles: true }));
  await pause();
  $('model').value = 'gemini-2.5-flash';
  $('profiles').querySelector('input[type=password]').value = 'new-secret';
  $('profiles').querySelector('input[type=password]').dispatchEvent(new window.Event('input', { bubbles: true }));
  $('skill').value = 'ترجمهٔ رسمی';
  $('aiEnabled').checked = true;
  $('saveSettings').click();
  await pause();
  const saved = calls.sets.at(-1) && calls.sets.at(-1)[key];
  check('saving writes the shared settings key and new API data for webpage translation',
    !!saved && saved.provider === 'gemini' && saved.enabled === true &&
    saved.providers.gemini.profiles[0].apiKey === 'new-secret' && saved.skill === 'ترجمهٔ رسمی');
  check('saving preserves other provider profiles and models',
    !!saved && saved.providers.openai.profiles[0].apiKey === 'secret-existing' && saved.providers.openai.model === 'gpt-4o-mini', saved && saved.providers.openai);

  $('profiles').querySelector('button[aria-label="تست اتصال کلید 1"]').click();
  await pause();
  check('test action checks the selected API connection without placing the key in its URL',
    calls.fetch.length === 1 && calls.fetch[0].url === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash' &&
    calls.fetch[0].options.headers['x-goog-api-key'] === 'new-secret' && !calls.fetch[0].url.includes('new-secret') &&
    /اتصال برقرار است/.test($('profiles').querySelector('.profile-status').textContent));
  check('status gives feedback after saving', /ذخیره شد/.test($('settingsStatus').textContent));

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL AI SETTINGS TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((error) => { console.error('TEST CRASH:', error); process.exit(2); });
