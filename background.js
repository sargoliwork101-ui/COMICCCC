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

async function fetchClick3(origin, id, firstPid, pid) {
  const url = `${origin}/books?id=${encodeURIComponent(id)}&hl=en&lpg=${encodeURIComponent(firstPid)}` +
    `&pg=${encodeURIComponent(pid)}&jscmd=click3`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return parseGoogleBooksJson(await res.text());
}

// کلید لغو per-tab؛ فقط یک عملیات در هر تب فعال است
const gbookCancels = new Map();
const GB_REQUEST_PAUSE_MS = 120;

async function walkGoogleBooks(pageUrl, tabId, onProgress) {
  const id = parseGoogleBooksId(pageUrl);
  if (!id) throw new Error('شناسهٔ کتاب در آدرس صفحه پیدا نشد');
  const origin = googleBooksOrigin(pageUrl);
  const isCancelled = () => tabId != null && gbookCancels.get(tabId) === true;
  if (isCancelled()) { const e = new Error('cancelled'); e.cancelled = true; throw e; }

  const first = await fetchClick3(origin, id, '1', '1');
  if (!first || !Array.isArray(first.page) || !first.page.length) {
    throw new Error('فهرست صفحه‌های کتاب خالی بود یا این کتاب پیش‌نمایش ندارد');
  }

  // ترتیب صفحه‌ها از اولین پاسخ گرفته می‌شود و پاسخ‌های بعدی فقط انتهای فهرست را گسترش می‌دهند
  const order = [];
  const srcByPid = new Map();
  first.page.forEach((p) => {
    if (!p || !p.pid) return;
    order.push(p.pid);
    if (typeof p.src === 'string' && p.src) srcByPid.set(p.pid, p.src);
  });

  const attempted = new Set();
  // هر صفحهٔ بدون src دقیقاً یک بار با click3 پرسیده می‌شود؛ صفحات غیرقابل‌پیش‌نمایش تا آخر بدون src می‌مانند و رد می‌شوند
  while (true) {
    if (isCancelled()) { const e = new Error('cancelled'); e.cancelled = true; throw e; }
    const pid = order.find((candidate) => !srcByPid.has(candidate) && !attempted.has(candidate));
    if (!pid) break;
    attempted.add(pid);
    if (onProgress) {
      await onProgress({ phase: 'walk', round: attempted.size, total: order.length, resolved: srcByPid.size });
    }
    try {
      const data = await fetchClick3(origin, id, order[0], pid);
      if (data && Array.isArray(data.page)) {
        data.page.forEach((p) => {
          if (!p || !p.pid) return;
          if (!order.includes(p.pid)) order.push(p.pid);
          if (typeof p.src === 'string' && p.src && !srcByPid.has(p.pid)) srcByPid.set(p.pid, p.src);
        });
      }
    } catch (e) {
      // خطای یک صفحه کل کتاب را نشکند؛ آن صفحه رد می‌شود و بقیه ادامه می‌یابند
      console.warn('Google Books page failed', pid, e);
    }
    await new Promise((r) => setTimeout(r, GB_REQUEST_PAUSE_MS));
  }

  const urls = order
    .filter((pid) => srcByPid.has(pid))
    .map((pid) => normalizeGoogleBooksSrc(srcByPid.get(pid)));
  if (!urls.length) throw new Error('هیچ صفحهٔ قابل‌پیش‌نمایشی برای این کتاب پیدا نشد');
  return { urls, totalPages: order.length, availablePages: urls.length, origin, id };
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
    walkGoogleBooks(pageUrl, tabId, report)
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
  if (msg && msg.type === 'WTPDF_URLS') {
    const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const job = {
      urls: msg.urls,
      name: msg.name,
      tabId: sender.tab ? sender.tab.id : null,
      pageUrl: (sender.tab && sender.tab.url) || msg.pageUrl || '',
      skippedInline: Number(msg.skippedInline) || 0
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
