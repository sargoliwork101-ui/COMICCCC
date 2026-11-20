/* global importScripts */
if (typeof importScripts === 'function') importScripts('core/translate.js', 'core/ai-translate.js');

// Jobهای تازه ممکن است متعلق به تب‌های بازیابی‌شدهٔ مرورگر باشند؛ فقط داده‌های بیشتر از ۷ روز پاک می‌شوند.
const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
async function pruneOrphanJobs() {
  try {
    const all = await chrome.storage.local.get(null);
    const now = Date.now();
    const expiredKeys = Object.entries(all)
      .filter(([key, job]) => key.startsWith('job_') && Number.isFinite(job && job.createdAt) &&
        now - job.createdAt > JOB_RETENTION_MS)
      .map(([key]) => key);
    if (expiredKeys.length) await chrome.storage.local.remove(expiredKeys);
  } catch (e) {
    console.warn('پاک‌سازی jobهای قدیمی ناموفق بود', e);
  }
}
chrome.runtime.onStartup.addListener(pruneOrphanJobs);
// به‌روزرسانی افزونه نباید jobهای باز تب‌های فعلی را حذف کند؛ فقط نصب اولیه پاک‌سازی می‌شود.
chrome.runtime.onInstalled.addListener((details = {}) => {
  if (details.reason === 'install') return pruneOrphanJobs();
});

// ---------- Google Books: استخراج صفحه‌ها از API رسمی reader (jscmd=click3) ----------
// صفحه‌های کتاب‌خوان گوگل به‌صورت کاشی‌های ۲۵۶px داخل iframe نمایش داده می‌شوند و اسکن DOM تصویر کامل ندارد؛
// این API فهرست همهٔ صفحه‌ها و نشانی مستقیم تصویر کامل هر صفحه (با امضای sig) را برمی‌گرداند.

// شناسهٔ کتاب را از دو شکل آدرس قدیمی (?id=) و جدید (/books/edition/عنوان/ID) استخراج می‌کند
function parseGoogleBooksId(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const pathParts = u.pathname.split('/').filter(Boolean);
  const isBooksUrl = /(^|\.)google\.[a-z.]+$/i.test(u.hostname) && pathParts[0] === 'books';
  if (!isBooksUrl) return null;
  const qid = u.searchParams.get('id');
  if (qid && /^[\w-]+$/.test(qid)) return qid;
  const seg = pathParts[pathParts.length - 1];
  if (seg && /^[\w-]{6,}$/.test(seg)) return seg;
  return null;
}

function googleBooksOrigin(url) {
  try {
    const u = new URL(url);
    if (u.hostname.startsWith('books.google.')) return u.origin;
  } catch { /* آدرس نامعتبر؛ پیش‌فرض دامنهٔ جهانی */ }
  return 'https://books.google.com';
}

// بیشینهٔ وضوح درخواستی؛ گوگل خودش تصویر را به ابعاد واقعی صفحه محدود می‌کند
function normalizeGoogleBooksSrc(src) {
  let abs = src;
  if (abs.startsWith('//')) abs = 'https:' + abs;
  if (/[?&]w=\d+/.test(abs)) return abs.replace(/([?&]w=)\d+/, '$1' + '10000');
  return abs + (abs.includes('?') ? '&' : '?') + 'w=10000';
}

// پاسخ بعضی سرویس‌های گوگل پیشوند ضد‌ربایش دارد؛ قبل از JSON.parse حذفش می‌کنیم
function parseGoogleBooksJson(text) {
  const clean = text.replace(/^\)\]\}'?\s*/, '').replace(/^while\s*\(\s*1\s*\)\s*;?\s*/, '').trim();
  return JSON.parse(clean);
}

// تست‌ها می‌توانند این دو را در همان context کوتاه کنند؛ در production مقادیر پیش‌فرض محافظه‌کارانه‌اند
let GB_BACKOFF_MS = [600, 1800, 5000];
let GB_REQUEST_PAUSE_MS = 350;   // مکث پایه بین درخواست‌ها برای جلوگیری از throttle
const GB_MAX_ROUNDS = 3;        // هر صفحهٔ خطادار حداکثر در سه دور جداگانه تلاش می‌شود

// یک درخواست تک‌تلاش؛ مکانیزم retry و backoff در walkGoogleBooks پیاده شده تا هر صفحه دقیقاً یک بار در هر دور درخواست شود
async function fetchClick3(origin, id, firstPid, pid, shouldCancel) {
  if (shouldCancel && shouldCancel()) {
    const e = new Error('cancelled'); e.cancelled = true; throw e;
  }
  const url = `${origin}/books?id=${encodeURIComponent(id)}&hl=en&lpg=${encodeURIComponent(firstPid)}` +
    `&pg=${encodeURIComponent(pid)}&jscmd=click3`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { credentials: 'include', signal: ctrl.signal });
    if (!res.ok) {
      const e = new Error('HTTP ' + res.status);
      if (res.status === 429 || res.status === 503) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || '', 10);
        if (Number.isFinite(retryAfter) && retryAfter > 0) e.retryAfterMs = retryAfter * 1000;
      }
      throw e;
    }
    return parseGoogleBooksJson(await res.text());
  } catch (e) {
    if (e && e.cancelled) throw e;
    if (e && e.name === 'AbortError') throw new Error('request timeout');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// کلید لغو per-tab؛ فقط یک عملیات در هر تب فعال است
const gbookCancels = new Map();

async function walkGoogleBooks(pageUrl, tabId, onProgress, limit) {
  limit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0; // 0 = بدون محدودیت
  const id = parseGoogleBooksId(pageUrl);
  if (!id) throw new Error('شناسهٔ کتاب در آدرس صفحه پیدا نشد');
  const origin = googleBooksOrigin(pageUrl);
  const isCancelled = () => tabId != null && gbookCancels.get(tabId) === true;
  if (isCancelled()) { const e = new Error('cancelled'); e.cancelled = true; throw e; }

  const first = await fetchClick3(origin, id, '1', '1', isCancelled);
  if (!first || !Array.isArray(first.page) || !first.page.length) {
    throw new Error('فهرست صفحه‌های کتاب خالی بود یا این کتاب پیش‌نمایش ندارد');
  }

  // ترتیب صفحه‌ها از اولین پاسخ گرفته می‌شود و پاسخ‌های بعدی فقط انتهای فهرست را گسترش می‌دهند
  const order = [];
  const srcByPid = new Map();
  // صفحه‌ای که کلیک‌۳ موفق به آن پاسخ داده ولی src نداشته، یعنی قطعاً قابل‌پیش‌نمایش نیست؛ دوباره درخواست نمی‌شود
  const definitiveEmpty = new Set();
  const mergePage = (data) => {
    if (!data || !Array.isArray(data.page)) return;
    data.page.forEach((p) => {
      if (!p || !p.pid) return;
      if (!order.includes(p.pid)) order.push(p.pid);
      if (typeof p.src === 'string' && p.src && !srcByPid.has(p.pid)) srcByPid.set(p.pid, p.src);
    });
  };
  mergePage(first);
  // توجه: null بودن src در فهرست اولیه به‌معنای قفل‌بودن نیست؛ آن صفحات بعداً تک‌تک پرسیده می‌شوند.
  // definitiveEmpty فقط وقتی مقدار می‌گیرد که پاسخ اختصاصی خودِ همان pid بدون src برگردد.

  // هر صفحهٔ خطادار در دورهای بعدی با backoff فزاینده دوباره تلاش می‌شود تا throttle موقت دائمی تلقی نشود
  const attempts = new Map();
  let consecutiveErrors = 0;
  let lastError = null;
  let limited = false;
  let lastAttemptedIndex = -1;
  while (true) {
    if (isCancelled()) { const e = new Error('cancelled'); e.cancelled = true; throw e; }
    // سقف تعداد صفحه: به محض رسیدن به N صفحهٔ برداشت‌شده پیمایش تمام می‌شود
    if (limit > 0 && srcByPid.size >= limit) { limited = true; break; }
    const pidIndex = order.findIndex((candidate) =>
      !srcByPid.has(candidate) && !definitiveEmpty.has(candidate) && (attempts.get(candidate) || 0) < GB_MAX_ROUNDS);
    if (pidIndex < 0) break;
    const pid = order[pidIndex];
    lastAttemptedIndex = Math.max(lastAttemptedIndex, pidIndex);
    const round = (attempts.get(pid) || 0) + 1;
    attempts.set(pid, round);
    if (onProgress) {
      await onProgress({
        phase: 'walk', round, total: order.length,
        resolved: srcByPid.size, failed: order.filter((p) => !srcByPid.has(p)).length
      });
    }
    try {
      const data = await fetchClick3(origin, id, order[0], pid, isCancelled);
      mergePage(data);
      if (!srcByPid.has(pid)) definitiveEmpty.add(pid);
      consecutiveErrors = 0;
      lastError = null;
    } catch (e) {
      if (e && e.cancelled) throw e;
      consecutiveErrors += 1;
      lastError = e;
      // خطای یک صفحه در این دور کل کتاب را نمی‌شکند؛ دور بعدی با فاصلهٔ بیشتر دوباره تلاش می‌شود
      console.warn('Google Books page failed', pid, e);
    }
    // مکث عادی بین صفحه‌ها؛ اما اگر همین صفحه دور دیگری دارد، backoff مخصوص retry اعمال می‌شود
    const stillRetrying = !srcByPid.has(pid) && !definitiveEmpty.has(pid) && round < GB_MAX_ROUNDS;
    let pause;
    if (stillRetrying) {
      const base = lastError && lastError.retryAfterMs ? lastError.retryAfterMs : (GB_BACKOFF_MS[round - 1] || 5000);
      pause = base * Math.min(4, 1 + consecutiveErrors * 0.5);
    } else {
      pause = GB_REQUEST_PAUSE_MS;
    }
    await new Promise((r) => setTimeout(r, Math.round(pause)));
  }

  // با سقف، پاسخ‌های هدیهٔ مجاور ممکن است چند صفحهٔ اضافه آورده باشند؛ به N صفحهٔ اول برش می‌زنیم
  let picked = order.filter((pid) => srcByPid.has(pid));
  if (limit > 0) { limited = limited || picked.length > limit; picked = picked.slice(0, limit); }
  const urls = picked.map((pid) => normalizeGoogleBooksSrc(srcByPid.get(pid)));
  if (!urls.length) throw new Error('هیچ صفحهٔ قابل‌پیش‌نمایشی برای این کتاب پیدا نشد');
  // صفحات ناموفق فقط در محدودهٔ پردازش‌شده شمرده می‌شوند تا با سقف اشتباه گزارش نشوند
  const scope = limited ? order.slice(0, lastAttemptedIndex + 1) : order;
  const failedPids = scope.filter((pid) => !srcByPid.has(pid));
  return {
    urls, totalPages: order.length, availablePages: urls.length,
    failedPages: failedPids.length, limited: limited || (limit > 0 && urls.length >= limit), origin, id
  };
}

// حل یک صفحهٔ منفرد برای حالت دستی؛ وقتی کاربر خودش صفحه را ورق می‌زند فقط همان صفحه درخواست می‌شود
async function resolveGoogleBooksPage(pageUrl, pid, lpgPid) {
  const id = parseGoogleBooksId(pageUrl);
  if (!id) throw new Error('شناسهٔ کتاب در آدرس صفحه پیدا نشد');
  const origin = googleBooksOrigin(pageUrl);
  const data = await fetchClick3(origin, id, lpgPid || pid, pid, null);
  const pages = data.page || [];
  // تطابق دقیق ارجح است؛ بعضی پاسخ‌ها شناسهٔ داخلی متفاوتی برای صفحه برمی‌گردانند
  const entry = pages.find((p) => p && p.pid === pid && typeof p.src === 'string' && p.src) ||
    pages.find((p) => p && typeof p.src === 'string' && p.src);
  if (!entry) return { ok: false, error: 'این صفحه قابل‌پیش‌نمایش نیست' };
  return { ok: true, pid: entry.pid, src: normalizeGoogleBooksSrc(entry.src) };
}

const activeGbookWalks = new Set();
if (chrome.tabs && chrome.tabs.onRemoved && typeof chrome.tabs.onRemoved.addListener === 'function') {
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (activeGbookWalks.has(tabId)) {
      gbookCancels.set(tabId, true);
    } else {
      gbookCancels.delete(tabId);
    }
  });
}

const WEBPAGE_TRANSLATION_SETTINGS_KEY = 'gemini_translation_settings_v1';
const WEBPAGE_AI_PROVIDERS = new Set(['gemini', 'openai', 'openrouter', 'avalai']);
const WEBPAGE_ENTRY_ID = /^p\d{6}(?:-s\d{3})?$/;
const WEBPAGE_MAX_ENTRIES = 20;
const WEBPAGE_MAX_CHARS = 5000;

function validateWebpageEntries(rawEntries) {
  if (!Array.isArray(rawEntries) || rawEntries.length < 1 || rawEntries.length > WEBPAGE_MAX_ENTRIES) {
    throw new Error('تعداد متن‌های این بسته برای ترجمه معتبر نیست.');
  }
  const seen = new Set();
  let totalChars = 0;
  const entries = rawEntries.map((entry) => {
    const id = String(entry && entry.id || '');
    const text = String(entry && entry.text || '').trim();
    if (!WEBPAGE_ENTRY_ID.test(id) || seen.has(id) || !text || text.length > 1000) {
      throw new Error('شناسه یا متن یکی از بخش‌های صفحه برای ترجمه معتبر نیست.');
    }
    seen.add(id);
    totalChars += text.length;
    return { id, page: 1, text };
  });
  if (totalChars > WEBPAGE_MAX_CHARS) throw new Error('حجم این بستهٔ ترجمه بیش از حد مجاز است.');
  return entries;
}

function webpageAiConfig(settings, providerOverride = '') {
  const savedProvider = settings && typeof settings.provider === 'string' ? settings.provider : 'gemini';
  const provider = WEBPAGE_AI_PROVIDERS.has(providerOverride) ? providerOverride : savedProvider;
  const providerData = settings && settings.providers && settings.providers[provider];
  let profiles = providerData && Array.isArray(providerData.profiles) ? providerData.profiles : [];
  if (!profiles.length && provider === 'gemini') {
    // تنظیمات قدیمی کلید را در سطح بالا نگه می‌داشت؛ اگر فرمت جدید پروفایل خالی دارد،
    // کلید سطح بالا را هم بررسی کن تا Gemini از فهرست نیفتد.
    if (Array.isArray(settings.profiles) && settings.profiles.length) profiles = settings.profiles;
    else if (typeof settings.apiKey === 'string' && settings.apiKey.trim()) {
      profiles = [{ name: 'کلید اصلی', apiKey: settings.apiKey }];
    }
  }
  const defaultSkill = typeof AiTranslateTools !== 'undefined' ? AiTranslateTools.DEFAULT_SKILL : '';
  return {
    provider,
    model: providerData && providerData.model || (provider === 'gemini' ? settings.model : '') || '',
    profiles: profiles.map((profile, index) => ({
      id: String(profile && profile.id || `api-${index + 1}`),
      name: String(profile && profile.name || `API ${index + 1}`),
      apiKey: String(profile && profile.apiKey || '')
    })).filter((profile) => profile.apiKey.trim()),
    skill: typeof settings.skill === 'string' && settings.skill !== defaultSkill ? settings.skill : ''
  };
}

function configuredWebpageAiEngines(settings) {
  const providerLabels = { gemini: 'Google Gemini', openai: 'OpenAI', openrouter: 'OpenRouter', avalai: 'AvalAI' };
  const defaults = { gemini: 'gemini-flash-latest', openai: 'gpt-4o-mini', openrouter: 'openai/gpt-4o-mini', avalai: 'gpt-6-luna' };
  return [...WEBPAGE_AI_PROVIDERS].flatMap((provider) => {
    const config = webpageAiConfig(settings || {}, provider);
    if (!config.profiles.length) return [];
    let model = String(config.model || defaults[provider]).trim() || defaults[provider];
    if (provider === 'gemini') model = model.replace(/^models\//, '');
    if (typeof AiTranslateTools !== 'undefined' && typeof AiTranslateTools.normalizeModel === 'function') {
      try { model = AiTranslateTools.normalizeModel(model, provider); } catch { /* keep the user's model visible so it can be corrected in settings */ }
    }
    return [{ value: `ai:${provider}`, provider, model, label: `${providerLabels[provider]} · ${model}` }];
  });
}

async function translateWebpageBatch(rawEntries, requestedEngine = '') {
  const entries = validateWebpageEntries(rawEntries);
  const stored = await chrome.storage.local.get([WEBPAGE_TRANSLATION_SETTINGS_KEY]);
  const settings = stored[WEBPAGE_TRANSLATION_SETTINGS_KEY] || {};
  let engine, providerOverride = '';
  if (!requestedEngine) {
    engine = ['google', 'mymemory', 'ai'].includes(settings.engine)
      ? settings.engine : (settings.enabled === true ? 'ai' : 'google');
    if (engine === 'ai') providerOverride = settings.provider || 'gemini';
  } else if (['google', 'mymemory'].includes(requestedEngine)) {
    engine = requestedEngine;
  } else if (typeof requestedEngine === 'string' && requestedEngine.startsWith('ai:') &&
      WEBPAGE_AI_PROVIDERS.has(requestedEngine.slice(3))) {
    engine = 'ai';
    providerOverride = requestedEngine.slice(3);
  } else {
    throw new Error('موتور انتخاب‌شده معتبر نیست؛ از فهرست موتورهای ترجمه انتخاب کنید.');
  }
  if (engine === 'ai') {
    if (typeof AiTranslateTools === 'undefined') throw new Error('موتور ترجمهٔ هوش مصنوعی بارگذاری نشد.');
    const config = webpageAiConfig(settings, providerOverride);
    const result = await AiTranslateTools.translateWithFailover({
      ...config, entries, sourceLang: 'auto', context: 'webpage'
    });
    const model = typeof AiTranslateTools.normalizeModel === 'function'
      ? AiTranslateTools.normalizeModel(config.model, config.provider)
      : config.model;
    return {
      ok: true,
      provider: ({ gemini: 'Google Gemini', openai: 'OpenAI', openrouter: 'OpenRouter', avalai: 'AvalAI' })[config.provider] || 'هوش مصنوعی',
      model,
      translations: [...result.translations.entries()].map(([id, text]) => ({ id, text }))
    };
  }
  if (typeof TranslateTools === 'undefined') throw new Error('موتور ترجمهٔ آنلاین بارگذاری نشد.');
  const translations = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, entries.length) }, async () => {
    while (next < entries.length) {
      const entry = entries[next++];
      const result = await TranslateTools.translate(entry.text, 'auto', undefined, engine);
      if (result && result.ok && result.text) translations.push({ id: entry.id, text: result.text });
    }
  }));
  const provider = engine === 'mymemory' ? 'MyMemory' : 'Google Translate';
  return { ok: true, provider, engine, translations };
}

function supportedTranslationPageUrl(rawUrl) {
  try {
    const url = new URL(rawUrl || '');
    const webStore = url.hostname === 'chromewebstore.google.com' ||
      (url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore'));
    return ['http:', 'https:'].includes(url.protocol) && !webStore;
  } catch { return false; }
}

function waitForTranslationTabComplete(tab) {
  if (tab && tab.status === 'complete') return Promise.resolve(tab);
  if (!tab || !Number.isSafeInteger(tab.id) || !chrome.tabs.onUpdated) {
    return Promise.reject(new Error('بارگذاری کپی صفحه را نمی‌توان بررسی کرد.'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('بارگذاری کپی صفحه بیش از حد طول کشید.')), 60000);
    const onUpdated = (tabId, changeInfo, updatedTab) => {
      if (tabId === tab.id && changeInfo.status === 'complete') finish(null, updatedTab || tab);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tab.id).then((latest) => {
      if (latest && latest.status === 'complete') finish(null, latest);
    }).catch(() => {});
  });
}

async function createTranslatedPageCopy(sourceTabId, engine) {
  const stored = await chrome.storage.local.get([WEBPAGE_TRANSLATION_SETTINGS_KEY]);
  if (!Number.isSafeInteger(sourceTabId) || sourceTabId < 0) throw new Error('صفحهٔ فعالی برای ترجمه پیدا نشد.');
  const availableAiEngines = configuredWebpageAiEngines(stored[WEBPAGE_TRANSLATION_SETTINGS_KEY] || {});
  const validEngines = ['google', 'mymemory', ...availableAiEngines.map((item) => item.value)];
  if (!validEngines.includes(engine)) {
    throw new Error('برای نمایش این سرویس در فهرست، ابتدا مدل و کلید API آن را در تنظیمات وارد کنید.');
  }
  const sourceTab = await chrome.tabs.get(sourceTabId);
  if (!sourceTab || !supportedTranslationPageUrl(sourceTab.url)) {
    throw new Error('ترجمه فقط روی صفحه‌های وب معمولی انجام می‌شود؛ صفحه‌های داخلی مرورگر و فروشگاه افزونه پشتیبانی نمی‌شوند.');
  }
  const duplicate = await chrome.tabs.duplicate(sourceTabId);
  if (!duplicate || !Number.isSafeInteger(duplicate.id)) throw new Error('کپی صفحه در زبانهٔ تازه باز نشد.');
  try {
    const loadedTab = await waitForTranslationTabComplete(duplicate);
    const currentTab = await chrome.tabs.get(duplicate.id);
    if (!supportedTranslationPageUrl((currentTab && currentTab.url) || (loadedTab && loadedTab.url))) {
      throw new Error('کپی صفحه به نشانی پشتیبانی‌نشده هدایت شد و ترجمه متوقف شد.');
    }
    await chrome.scripting.executeScript({
      target: { tabId: duplicate.id },
      files: ['src/core/page-translation.js', 'src/page-translator/content.js']
    });
    const result = await chrome.tabs.sendMessage(duplicate.id, {
      type: 'WTPDF_PAGE_TRANSLATE_START',
      jobId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      engine,
      availableAiEngines
    });
    if (!result || !result.ok) throw new Error(result && result.error || 'متن قابل ترجمه‌ای در صفحه پیدا نشد.');
    try { await chrome.tabs.update(duplicate.id, { active: true }); } catch { /* duplicate may already be active */ }
    return { ok: true, tabId: duplicate.id, paragraphs: result.paragraphs || 0 };
  } catch (error) {
    try { await chrome.tabs.remove(duplicate.id); } catch { /* duplicate may already be closed */ }
    throw error;
  }
}

// دریافت لیست تصاویر از صفحه و باز کردن تب ساخت PDF
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'WTPDF_PAGE_TRANSLATE_CREATE_COPY') {
    if (!sender || sender.id !== chrome.runtime.id || sender.tab) {
      sendResponse({ ok: false, error: 'درخواست ساخت کپی ترجمه معتبر نیست.' });
      return false;
    }
    createTranslatedPageCopy(msg.tabId, msg.engine)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error && error.message ? error.message : String(error) }));
    return true;
  }
  if (msg && msg.type === 'WTPDF_TRANSLATE_PAGE_BATCH') {
    if (!sender || !sender.tab || !/^https?:$/.test((() => { try { return new URL(sender.tab.url).protocol; } catch { return ''; } })())) {
      sendResponse({ ok: false, error: 'ترجمه فقط در صفحه‌های وب معمولی اجرا می‌شود.' });
      return false;
    }
    translateWebpageBatch(msg.entries, msg.engine)
      .then(sendResponse)
      .catch((error) => {
        const message = typeof AiTranslateTools !== 'undefined' && typeof AiTranslateTools.safeError === 'function'
          ? AiTranslateTools.safeError(error) : (error && error.message ? error.message : String(error));
        sendResponse({ ok: false, error: message });
      });
    return true;
  }
  // اسکن اختصاصی Google Books از طریق API رسمی reader (اجرا در service worker برای دورزدن CORS)
  if (msg && msg.type === 'WTPDF_GBOOKS_SCAN') {
    const tabId = sender.tab ? sender.tab.id : null;
    // پرچم لغو اینجا پاک نمی‌شود تا ESCی که درست قبل از شروع خورده هم محترم شمرده شود؛
    // پاک‌سازی فقط در پایان موفق یا ناموفق اجرا (then/catch) انجام می‌شود
    const pageUrl = msg.pageUrl || (sender.tab && sender.tab.url) || '';
    const report = async (progress) => {
      if (tabId == null) return;
      try { await chrome.tabs.sendMessage(tabId, Object.assign({ type: 'WTPDF_GBOOKS_PROGRESS' }, progress)); }
      catch { /* تب بسته شده یا ناوبری کرده؛ بی‌خطر */ }
    };
    const pageLimit = Number.isFinite(msg.pageLimit) && msg.pageLimit > 0 ? Math.floor(msg.pageLimit) : 0;
    if (tabId != null) activeGbookWalks.add(tabId);
    walkGoogleBooks(pageUrl, tabId, report, pageLimit)
      .then((result) => {
        if (tabId != null) { activeGbookWalks.delete(tabId); gbookCancels.delete(tabId); }
        sendResponse(Object.assign({ ok: true }, result));
      })
      .catch((error) => {
        if (tabId != null) { activeGbookWalks.delete(tabId); gbookCancels.delete(tabId); }
        sendResponse({ ok: false, cancelled: !!error.cancelled, error: error && error.message ? error.message : String(error) });
      });
    return true;
  }
  if (msg && msg.type === 'WTPDF_GBOOKS_CANCEL') {
    const tabId = sender.tab ? sender.tab.id : null;
    if (tabId != null) gbookCancels.set(tabId, true);
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.type === 'WTPDF_GBOOKS_PAGE') {
    resolveGoogleBooksPage(
      msg.pageUrl || (sender.tab && sender.tab.url) || '',
      String(msg.pid || '1'),
      msg.lpgPid ? String(msg.lpgPid) : undefined
    )
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error && error.message ? error.message : String(error) }));
    return true;
  }
  if (msg && msg.type === 'WTPDF_URLS') {
    const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const job = {
      createdAt: Date.now(),
      urls: msg.urls,
      name: msg.name,
      tabId: sender.tab ? sender.tab.id : null,
      pageUrl: (sender.tab && sender.tab.url) || msg.pageUrl || '',
      skippedInline: Number(msg.skippedInline) || 0
    };
    chrome.storage.local.set({ ['job_' + jobId]: job }).then(() => {
      chrome.tabs.create({ url: chrome.runtime.getURL('src/viewer/viewer.html') + '?job=' + jobId }, (tab) => {
        if (chrome.runtime.lastError || !tab || tab.id == null) {
          const error = chrome.runtime.lastError;
          // اگر تب پیش‌نمایش باز نشد، job بدون مصرف‌کننده نباید تا پاک‌سازی دوره‌ای باقی بماند.
          chrome.storage.local.remove('job_' + jobId).catch((cleanupError) => {
            console.warn('پاک‌سازی job ناموفق ممکن نشد', cleanupError);
          });
          sendResponse({ ok: false, error: error ? error.message : 'preview tab could not be opened' });
          return;
        }
        // Keep the work tab from being auto-discarded while the user switches to other tabs.
        try {
          chrome.tabs.update(tab.id, { autoDiscardable: false }, () => {
            if (chrome.runtime.lastError) console.warn('Could not disable automatic tab discard:', chrome.runtime.lastError.message);
            sendResponse({ ok: true, tabId: tab.id });
          });
        } catch (error) {
          console.warn('Could not protect the work tab from automatic discard:', error);
          sendResponse({ ok: true, tabId: tab.id });
        }
      });
    }).catch((error) => {
      console.error('ذخیرهٔ فهرست تصاویر ناموفق بود', error);
      sendResponse({ ok: false, error: error && error.message ? error.message : 'storage quota exceeded' });
    });
    return true;
  }
});
