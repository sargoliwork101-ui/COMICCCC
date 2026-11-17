/* global AiTranslateTools, chrome */
'use strict';

const SETTINGS_KEY = 'gemini_translation_settings_v1';
const providerIds = Object.keys(AiTranslateTools.PROVIDERS);
const $ = (id) => document.getElementById(id);
const state = { providerData: {}, profiles: [] };
let activeProvider = 'gemini';

function makeProfile(name = '', apiKey = '', id = '') {
  return {
    id: String(id || `api-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`),
    name: String(name || ''),
    apiKey: String(apiKey || '')
  };
}

function setStatus(message, error = false) {
  const node = $('settingsStatus');
  node.textContent = message;
  node.classList.toggle('error', error);
}

function updateEngineFields() {
  $('aiProviderSettings').classList.toggle('hidden', $('pageEngine').value !== 'ai');
}

function captureProvider(provider = activeProvider) {
  const data = state.providerData[provider] || {};
  data.model = $('model').value.trim() || AiTranslateTools.DEFAULT_MODELS[provider];
  data.profiles = state.profiles;
  state.providerData[provider] = data;
}

function renderProfiles() {
  const container = $('profiles');
  container.textContent = '';
  state.profiles.forEach((profile, index) => {
    const row = document.createElement('div');
    row.className = 'profile-row';
    const name = document.createElement('input');
    name.type = 'text'; name.className = 'profile-name'; name.value = profile.name;
    name.autocomplete = 'off'; name.placeholder = `کلید ${index + 1}`;
    name.setAttribute('aria-label', `نام دلخواه کلید ${index + 1}`);
    name.addEventListener('input', () => { profile.name = name.value; });
    const key = document.createElement('input');
    key.type = 'password'; key.className = 'profile-key'; key.value = profile.apiKey;
    key.autocomplete = 'off'; key.spellcheck = false; key.placeholder = 'کلید API';
    key.setAttribute('aria-label', `کلید API شمارهٔ ${index + 1}`);
    key.addEventListener('input', () => { profile.apiKey = key.value; });
    const status = document.createElement('span');
    status.className = 'profile-status'; status.setAttribute('role', 'status');
    const test = document.createElement('button');
    test.type = 'button'; test.className = 'btn secondary'; test.textContent = 'تست';
    test.setAttribute('aria-label', `تست اتصال کلید ${index + 1}`);
    test.title = 'فقط اتصال کلید و مدل را بررسی می‌کند؛ متن صفحه ارسال نمی‌شود.';
    test.addEventListener('click', async () => {
      captureProvider();
      const provider = $('provider').value;
      const model = $('model').value.trim() || AiTranslateTools.DEFAULT_MODELS[provider];
      const apiKey = profile.apiKey.trim();
      if (!apiKey) { status.textContent = 'ابتدا کلید API را وارد کنید.'; status.className = 'profile-status bad'; key.focus(); return; }
      test.disabled = true; test.textContent = '…'; status.textContent = 'در حال بررسی اتصال…';
      try {
        await AiTranslateTools.testConnection({ provider, apiKey, model });
        status.textContent = 'اتصال برقرار است ✓'; status.className = 'profile-status ok';
      } catch (error) {
        status.textContent = AiTranslateTools.safeError(error); status.className = 'profile-status bad';
      } finally {
        test.disabled = false; test.textContent = 'تست';
      }
    });
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'btn secondary'; remove.textContent = 'حذف';
    remove.setAttribute('aria-label', `حذف کلید ${index + 1}`);
    remove.disabled = state.profiles.length <= 1;
    remove.addEventListener('click', async () => {
      captureProvider();
      state.profiles.splice(index, 1);
      if (!state.profiles.length) state.profiles.push(makeProfile());
      renderProfiles();
      await saveSettings();
    });
    row.append(name, key, test, remove, status);
    container.appendChild(row);
  });
}

function showProvider(provider) {
  activeProvider = provider;
  const info = AiTranslateTools.PROVIDERS[provider];
  $('provider').value = provider;
  $('model').value = state.providerData[provider].model || AiTranslateTools.DEFAULT_MODELS[provider];
  $('model').placeholder = info.defaultModel;
  state.profiles = state.providerData[provider].profiles;
  if (!state.profiles.length) state.profiles.push(makeProfile());
  const link = document.createElement('a');
  link.href = info.keyUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = info.keyLabel;
  $('keyHelp').replaceChildren(link, document.createTextNode(' · کلیدها برای استفادهٔ افزونه در همین مرورگر نگه‌داری می‌شوند.'));
  renderProfiles();
}

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const settings = stored[SETTINGS_KEY] || {};
    $('aiEnabled').checked = settings.enabled === true;
    const savedEngine = ['auto', 'google', 'mymemory', 'ai'].includes(settings.engine)
      ? settings.engine : (settings.enabled === true ? 'ai' : 'auto');
    $('pageEngine').value = savedEngine;
    updateEngineFields();
    const providerStore = settings.providers && typeof settings.providers === 'object' ? settings.providers : null;
    for (const provider of providerIds) {
      const raw = providerStore && providerStore[provider] && typeof providerStore[provider] === 'object'
        ? providerStore[provider] : {};
      const legacy = provider === 'gemini' && !providerStore;
      let profiles = Array.isArray(legacy ? settings.profiles : raw.profiles)
        ? (legacy ? settings.profiles : raw.profiles).map((profile) => makeProfile(profile && profile.name, profile && profile.apiKey, profile && profile.id))
        : [];
      if (legacy && !profiles.length && typeof settings.apiKey === 'string' && settings.apiKey.trim()) {
        profiles = [makeProfile('کلید اصلی', settings.apiKey)];
      }
      const model = legacy ? settings.model : raw.model;
      state.providerData[provider] = {
        model: typeof model === 'string' && model.trim() ? model.trim() : AiTranslateTools.DEFAULT_MODELS[provider],
        profiles
      };
    }
    $('skill').value = typeof settings.skill === 'string' && settings.skill.trim()
      ? settings.skill : AiTranslateTools.DEFAULT_SKILL;
    const provider = providerIds.includes(settings.provider) ? settings.provider : 'gemini';
    showProvider(provider);
  } catch (error) {
    setStatus('تنظیمات خوانده نشد؛ دوباره بارگذاری کنید. ' + (error && error.message ? error.message : ''), true);
    for (const provider of providerIds) {
      state.providerData[provider] = {
        model: AiTranslateTools.DEFAULT_MODELS[provider], profiles: []
      };
    }
    $('skill').value = AiTranslateTools.DEFAULT_SKILL;
    $('pageEngine').value = 'auto';
    updateEngineFields();
    showProvider('gemini');
  }
}

async function saveSettings() {
  try {
    captureProvider();
    const providers = {};
    for (const provider of providerIds) {
      const data = state.providerData[provider];
      providers[provider] = {
        model: data.model || AiTranslateTools.DEFAULT_MODELS[provider],
        profiles: data.profiles.map((profile) => ({
          id: profile.id, name: profile.name.trim(), apiKey: profile.apiKey.trim()
        }))
      };
    }
    await chrome.storage.local.set({ [SETTINGS_KEY]: {
      engine: $('pageEngine').value,
      enabled: $('aiEnabled').checked,
      provider: $('provider').value,
      providers,
      skill: $('skill').value.trim() || AiTranslateTools.DEFAULT_SKILL
    } });
    setStatus('تنظیمات ذخیره شد. ترجمهٔ صفحه از همین سرویس و کلیدها استفاده می‌کند.');
    return true;
  } catch {
    setStatus('ذخیرهٔ تنظیمات ناموفق بود؛ فضای ذخیره‌سازی افزونه را بررسی کنید.', true);
    return false;
  }
}

$('pageEngine').addEventListener('change', async () => {
  updateEngineFields();
  await saveSettings();
});
$('provider').addEventListener('change', async () => {
  captureProvider(activeProvider);
  showProvider($('provider').value);
  setStatus('');
  await saveSettings();
});
$('model').addEventListener('change', saveSettings);
$('skill').addEventListener('change', saveSettings);
$('aiEnabled').addEventListener('change', saveSettings);
$('addProfile').addEventListener('click', async () => {
  captureProvider();
  state.profiles.push(makeProfile(`کلید ${state.profiles.length + 1}`));
  renderProfiles();
  await saveSettings();
  const keys = $('profiles').querySelectorAll('.profile-key');
  keys[keys.length - 1].focus();
});
$('saveSettings').addEventListener('click', async () => {
  await saveSettings();
});

loadSettings();
