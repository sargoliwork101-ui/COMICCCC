// jobهای یتیم (مثلاً وقتی تب viewer کرش کرده یا بسته شده و pagehide اجرا نشده) را پاک کن تا فضای storage پر نشود
async function pruneOrphanJobs() {
  try {
    const all = await chrome.storage.local.get(null);
    const orphanKeys = Object.keys(all).filter((key) => key.startsWith('job_'));
    if (orphanKeys.length) await chrome.storage.local.remove(orphanKeys);
  } catch (e) {
    console.warn('پاک‌سازی jobهای قدیمی ناموفق بود', e);
  }
}
chrome.runtime.onStartup.addListener(pruneOrphanJobs);
chrome.runtime.onInstalled.addListener(pruneOrphanJobs);

// ---------- Google Books: استخراج صفحه‌ها از API رسمی reader (jscmd=click3) ----------
// صفحه‌های کتاب‌خوان گوگل به‌صورت کاشی‌های ۲۵۶px داخل iframe نمایش داده می‌شوند و اسکن DOM تصویر کامل ندارد؛
// این API فهرست همهٔ صفحه‌ها و نشانی مستقیم تصویر کامل هر صفحه (با امضای sig) را برمی‌گرداند.

// شناسهٔ کتاب را از دو شکل آدرس قدیمی (?id=) و جدید (/books/edition/عنوان/ID) استخراج می‌کند
function parseGoogleBooksId(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const qid = u.searchParams.get('id');
  if (qid && /^[\w-]+$/.test(qid)) return qid;
  if (/(^|\.)google\.[a-z.]+$/i.test(u.hostname) && u.pathname.includes('/books/')) {
    const seg = u.pathname.split('/').filter(Boolean).pop();
    if (seg && /^[\w-]{6,}$/.test(seg)) return seg;
  }
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

// دریافت لیست تصاویر از صفحه و باز کردن تب ساخت PDF
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
    walkGoogleBooks(pageUrl, tabId, report, pageLimit)
      .then((result) => { if (tabId != null) gbookCancels.delete(tabId); sendResponse(Object.assign({ ok: true }, result)); })
      .catch((error) => {
        if (tabId != null) gbookCancels.delete(tabId);
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
    resolveGoogleBooksPage(msg.pageUrl || (sender.tab && sender.tab.url) || '', String(msg.pid || '1'))
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error && error.message ? error.message : String(error) }));
    return true;
  }
  if (msg && (msg.type === 'WTPDF_URLS' || msg.type === 'WTPDF_LOCAL_JOB')) {
    const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const job = {
      urls: msg.urls,
      name: msg.name,
      tabId: sender.tab ? sender.tab.id : null,
      pageUrl: (sender.tab && sender.tab.url) || msg.pageUrl || '',
      skippedInline: Number(msg.skippedInline) || 0,
      source: msg.source || 'web'
    };
    chrome.storage.local.set({ ['job_' + jobId]: job }).then(() => {
      chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') + '?job=' + jobId }, (tab) => {
        if (chrome.runtime.lastError || !tab || tab.id == null) {
          const error = chrome.runtime.lastError;
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
