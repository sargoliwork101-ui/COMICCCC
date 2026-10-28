const startBtn = document.getElementById('startBtn');
const statusBox = document.getElementById('statusBox');
const statusText = document.getElementById('statusText');
// متن وضعیت (پیشرفت) را بدون نمایش باکس به‌روز می‌کند؛ پیشرفت واقعی روی خود صفحه با پوشش تمام‌صفحه دیده می‌شود
const setStatus = (text) => {
  statusText.innerText = text;
};
// باکس فقط برای خطاها و هشدارهایی که کاربر باید ببیند نمایش داده می‌شود
const showError = (text) => {
  statusText.innerText = text;
  statusBox.classList.remove('hidden');
};
const hideStatus = () => {
  statusText.innerText = '';
  statusBox.classList.add('hidden');
};

// سه روش جمع‌آوری: اسکرول (کمیک تودرتو)، ورق‌زدن خودکار (کلیک روی دکمهٔ بعدی)، ورق‌زدن دستی
let collectMode = 'scroll';
const modeSeg = document.getElementById('modeSeg');
if (modeSeg) {
  modeSeg.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.mode-btn');
    if (!btn) return;
    collectMode = btn.dataset.mode || 'scroll';
    modeSeg.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b === btn));
  });
}

const MODE_STATUS = {
  scroll: 'در حال اسکرول صفحه برای لود تصاویر...',
  auto: 'در حال ورق‌زدن خودکار صفحات (کلیک روی مثلث/دکمهٔ بعدی)...',
  manual: 'پنل حالت دستی روی صفحه باز می‌شود؛ خودت صفحه‌ها را ورق بزن و در پایان «تمام شد» را بزن...'
};

startBtn.addEventListener('click', async () => {
  let pdfName = document.getElementById('pdfName').value.trim() || 'comic';
  if (!pdfName.toLowerCase().endsWith('.pdf')) pdfName += '.pdf';

  // سقف صفحات Google Books: صفر/خالی یعنی بدون محدودیت
  const parsedLimit = Number.parseInt(document.getElementById('pageLimit').value, 10);
  const pageLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 0;
  const options = {
    pageLimit,
    nextSelector: document.getElementById('nextSelector').value.trim(),
    imageSelector: document.getElementById('imageSelector').value.trim()
  };

  startBtn.disabled = true;
  // خطای اجرای قبلی را پاک کن؛ این بار فقط در صورت بروز خطا باکس ظاهر می‌شود
  hideStatus();
  setStatus((MODE_STATUS[collectMode] || MODE_STATUS.scroll) +
    '\n(می‌توانید popup را ببندید؛ پیشرفت روی خود صفحه نمایش داده می‌شود)');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // مرحلهٔ ۱: کاوش همهٔ فریم‌ها برای پیدا کردن فریم اصلی reader گوگل‌بوک (در صفحات edition داخل iframe است)
    let injectionTarget = { tabId: tab.id };
    try {
      const probes = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: probeBookFrame
      });
      const reader = (probes || []).find((r) => r && r.result && r.result.isReader);
      if (reader && typeof reader.frameId === 'number') {
        injectionTarget = { tabId: tab.id, frameIds: [reader.frameId] };
      }
    } catch (probeErr) {
      // بعضی فریم‌ها دسترسی‌ناپذیرند؛ تزریق در فریم بالایی به‌عنوان fallback کافی است
      console.warn('کاوش فریم‌ها ناموفق بود، تزریق در فریم اصلی', probeErr);
    }
    // مرحلهٔ ۲: تزریق اسکریپت کامل فقط در فریم انتخاب‌شده (reader یا فریم بالایی)
    const results = await chrome.scripting.executeScript({
      target: injectionTarget,
      func: scrapeAndSend,
      args: [pdfName, collectMode, options]
    });
    const res = results[0] && results[0].result;
    if (res && res.busy) {
      showError('عملیات روی این صفحه از قبل در حال اجراست.');
    } else if (res && res.cancelled) {
      showError('جمع‌آوری تصاویر با کلید ESC لغو شد.');
    } else if (!res || res.count === 0) {
      showError(res && res.skippedInline
        ? `تصاویر داخلی پیدا شدند، اما ${res.skippedInline} مورد از حد مجاز بزرگ‌تر بودند.`
        : 'هیچ تصویری در این صفحه پیدا نشد!');
    } else {
      // موفقیت: تب پیش‌نمایش خودکار باز می‌شود، پس نیازی به نمایش باکس در popup نیست
      hideStatus();
    }
  } catch (err) {
    console.error(err);
    showError('خطا: ' + (err && err.message ? err.message : err) +
      '\n(روی صفحات chrome:// و فروشگاه کروم اکستنشن کار نمی‌کند)');
  } finally {
    startBtn.disabled = false;
  }
});

// در هر فریم تب اجرا می‌شود و می‌گوید آیا این فریم همان reader گوگل‌بوک است یا نه
async function probeBookFrame() {
  try {
    const u = new URL(location.href);
    const id = u.searchParams.get('id') || u.searchParams.get('nid') || '';
    return { isReader: u.hostname.startsWith('books.google.') && !!id, href: location.href, id };
  } catch {
    return { isReader: false, href: '', id: '' };
  }
}

// این تابع داخل صفحهٔ وب اجرا می‌شود
// mode: 'scroll' (پیش‌فرض) | 'auto' (ورق‌زدن خودکار) | 'manual' (ورق‌زدن دستی کاربر)
// opts: { pageLimit, nextSelector, imageSelector }
async function scrapeAndSend(pdfName, mode, opts) {
  mode = mode === 'auto' || mode === 'manual' ? mode : 'scroll';
  opts = opts || {};
  const pageLimit = Number.isFinite(opts.pageLimit) && opts.pageLimit > 0 ? Math.floor(opts.pageLimit) : 0;
  const nextSelector = typeof opts.nextSelector === 'string' ? opts.nextSelector : '';
  const imageSelector = typeof opts.imageSelector === 'string' ? opts.imageSelector : '';
  if (window.__wtpdfRunning) return { busy: true };
  window.__wtpdfRunning = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const getH = () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);

  // زمان‌بندی‌ها ثابت‌اند؛ تست‌ها می‌توانند با window.__wtpdfTimings آن‌ها را کوتاه کنند
  const T = Object.assign({
    poll: 250,          // فاصلهٔ بررسی آمدن تصویر تازه پس از هر کلیک
    clickTimeout: 7000, // حداکثر انتظار برای تصویر تازه پس از کلیک روی بعدی
    settle: 500,        // مکث پس از دیدن تصویر تازه برای اطمینان از لود کامل
    stuckLimit: 2,      // چند کلیک پشت‌سرهم بدون تصویر تازه = پایان کار
    maxPages: 1000,     // سقف تعداد صفحه/کلیک در حالت خودکار
    manualRescan: 1500, // اسکن دوره‌ای حالت دستی (پشتیبان MutationObserver)
    scrollStep: 0.7,    // سهم ارتفاع پنجره در هر گام اسکرول
    scrollSleep: 200,   // مکث هر گام اسکرول
    scrollMax: 800,     // سقف تعداد گام‌های اسکرول
    gbookManualPoll: 700, // فاصلهٔ بررسی تغییر صفحه در حالت دستی Google Books
    gbookPause: 450,    // مکث پایه بین درخواست‌های click3 (با jitter) برای جلوگیری از throttle
    gbookBackoff: [700, 2000, 5000], // backoff تلاش‌های مجدد هر صفحه در دورهای بعدی
    gbookRounds: 3,     // هر صفحهٔ خطادار حداکثر در سه دور تلاش می‌شود
    gbookTimeout: 20000 // timeout هر درخواست click3
  }, window.__wtpdfTimings || {});

  // ---------- تشخیص کتاب‌خوان Google Books ----------
  // کتاب‌های گوگل به‌جای تصویر کامل، کاشی‌های ۲۵۶px داخل iframe دارند؛ برای همین مسیر اختصاصی API لازم است.
  // inFrame یعنی اسکریپت داخل خود فریم reader (دامنهٔ books.google.*) اجرا شده: fetch هم‌مبدا و ردیابی ورق‌زدن ممکن است.
  const detectGoogleBooks = (href) => {
    let u;
    try { u = new URL(href); } catch { return null; }
    const inFrame = u.hostname.startsWith('books.google.');
    const byId = u.searchParams.get('id');
    if (byId && /^[\w-]+$/.test(byId) && /(^|\.)google\./i.test(u.hostname)) {
      return { id: byId, origin: inFrame ? u.origin : 'https://books.google.com', inFrame, embedded: false };
    }
    if (/(^|\.)google\.[a-z.]+$/i.test(u.hostname) && u.pathname.includes('/books/edition/')) {
      const seg = u.pathname.split('/').filter(Boolean).pop();
      if (seg && /^[\w-]{6,}$/.test(seg)) return { id: seg, origin: 'https://books.google.com', inFrame: false, embedded: false };
    }
    // reader جاسازی‌شده در iframe (نشانی books.google.* داخل قاب صفحه)
    const frame = document.querySelector('iframe[src*="books.google."]');
    if (frame && frame.src) {
      try {
        const fu = new URL(frame.src);
        const fid = fu.searchParams.get('id');
        if (fid && /^[\w-]+$/.test(fid)) return { id: fid, origin: fu.origin, inFrame: false, embedded: true };
      } catch { /* قاب نامعتبر */ }
    }
    return null;
  };
  const gbook = detectGoogleBooks(location.href);
  // حالت دستی واقعی فقط داخل فریم reader ممکن است (ورق‌زدن، آدرس همان فریم را عوض می‌کند)؛
  // در فریم بالاییِ صفحات edition یا reader جاسازی‌شده، دستی به پیمایش خودکار تبدیل می‌شود
  const effectiveMode = gbook
    ? (mode === 'manual' && gbook.inFrame ? 'manual' : 'auto')
    : mode;

  const PLACEHOLDER = /blank|loading|placeholder|spacer|pixel|1x1|lazy\.(gif|png|jpg)/i;

  // منبعی را بردار که خود مرورگر با موفقیت نمایش داده؛ در غیر این صورت سراغ آدرس‌های lazy و srcset برو.
  const bestSrc = (img) => {
    const active = img.currentSrc || img.src;
    if (img.complete && img.naturalWidth > 0 && active && !PLACEHOLDER.test(active)) return active;
    const lazy = img.dataset.original || img.dataset.full || img.dataset.zoom || img.dataset.src ||
      img.dataset.lazySrc || img.getAttribute('data-url');
    if (lazy && !PLACEHOLDER.test(lazy)) return lazy;

    const cands = [];
    const parseSet = (s) => {
      (s || '').split(',').forEach((part) => {
        const p = part.trim().split(/\s+/);
        if (!p[0]) return;
        let w = 0;
        if (p[1] && p[1].endsWith('w')) w = parseFloat(p[1]);
        else if (p[1] && p[1].endsWith('x')) w = parseFloat(p[1]) * 1000;
        cands.push({ url: p[0], w });
      });
    };
    parseSet(img.srcset);
    parseSet(img.dataset.srcset);
    const pic = img.closest('picture');
    if (pic) pic.querySelectorAll('source').forEach((s) => parseSet(s.srcset));
    const withW = cands.filter((c) => c.w > 0).sort((a, b) => b.w - a.w);
    if (withW.length) return withW[0].url;
    return active || lazy || (cands[0] && cands[0].url);
  };

  // ---------- مخزن مشترک تصاویر (هر سه حالت از همین استفاده می‌کنند) ----------
  const urls = [];
  const seen = new Set();
  const INLINE_DATA_BUDGET = 4 * 1024 * 1024;
  let inlineDataBytes = 0, skippedInline = 0;
  const add = (src) => {
    if (!src) return;
    let abs;
    if (/^data:image\//i.test(src)) {
      abs = src;
      if (seen.has(abs)) return;
      const bytes = Math.ceil(src.length * 0.75);
      if (inlineDataBytes + bytes > INLINE_DATA_BUDGET) { skippedInline++; return; }
      inlineDataBytes += bytes;
    } else if (/^blob:/i.test(src)) abs = src;
    else {
      if (/^data:/i.test(src)) return;
      try { abs = new URL(src, location.href).href; } catch { return; }
    }
    if (!seen.has(abs)) { seen.add(abs); urls.push(abs); }
  };

  // اسکن محدود به انتخابگر CSS دستی کاربر (کپی‌شده از F12)؛ اگر انتخابگر چیزی نیافت، false یعنی به اسکن عمومی برگرد
  const scanImagesBySelector = () => {
    let nodes;
    try { nodes = Array.from(document.querySelectorAll(imageSelector)); }
    catch { return false; } // انتخابگر نامعتبر؛ اسکن عمومی ادامه می‌کند
    if (!nodes.length) return false;
    nodes.forEach((el) => {
      if (!el || !el.isConnected) return;
      if (el.tagName === 'IMG') { add(bestSrc(el)); return; }
      if (el.tagName === 'SOURCE') {
        const srcset = el.getAttribute('srcset') || el.getAttribute('data-srcset');
        if (srcset) { const first = srcset.split(',')[0].trim().split(/\s+/)[0]; add(first); }
        return;
      }
      // المان‌های container: هم تصاویر داخلی و هم background-image خودشان
      if (el.querySelectorAll) el.querySelectorAll('img').forEach((img) => add(bestSrc(img)));
      const r = el.getBoundingClientRect();
      if (r.width >= 250 || r.height >= 250) {
        const bg = getComputedStyle(el).backgroundImage;
        const m = bg && bg.match(/url\(["']?(.*?)["']?\)/);
        if (m) add(m[1]);
      }
    });
    return true;
  };

  // یک بار کل DOM را اسکن می‌کند و فقط تعداد تصاویر «تازه» را برمی‌گرداند
  const scanImages = () => {
    const before = urls.length;
    if (imageSelector && scanImagesBySelector()) return urls.length - before;
    document.querySelectorAll('img').forEach((img) => {
      const src = bestSrc(img);
      const rect = img.getBoundingClientRect();
      const w = Math.max(img.naturalWidth || 0, rect.width);
      const h = Math.max(img.naturalHeight || 0, rect.height);
      if (Math.max(w, h) < 250) return;
      if (/logo|icon|avatar|sprite|emoji/i.test(src || '')) return;
      add(src);
    });
    // بعضی سایت‌ها کمیک را با CSS background می‌سازند
    document.querySelectorAll('div, section, span, a').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 250 || r.height < 250) return;
      const bg = getComputedStyle(el).backgroundImage;
      const m = bg && bg.match(/url\(["']?(.*?)["']?\)/);
      if (m && !/logo|icon|avatar|sprite|emoji/i.test(m[1])) add(m[1]);
    });
    return urls.length - before;
  };

  // ---------- رابط کاربری روی صفحه ----------
  const styleTag = document.createElement('style');
  styleTag.textContent =
    '@keyframes wtpdfSpin{to{transform:rotate(360deg)}}' +
    '.wtpdf-overlay{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;' +
    'padding:24px;background:rgba(3,5,10,.88);backdrop-filter:blur(4px);direction:rtl;pointer-events:none}' +
    '.wtpdf-card{max-width:86vw;display:flex;flex-direction:column;align-items:center;gap:18px;' +
    'background:rgba(15,19,28,.98);border:1px solid rgba(139,123,255,.55);border-radius:22px;padding:30px 38px;' +
    'box-shadow:0 26px 80px rgba(0,0,0,.75),0 0 0 4px rgba(139,123,255,.16);text-align:center}' +
    '.wtpdf-spinner{width:46px;height:46px;border-radius:50%;border:4px solid rgba(255,255,255,.16);' +
    'border-top-color:#8b7bff;animation:wtpdfSpin .8s linear infinite}' +
    '.wtpdf-card.wtpdf-cancel .wtpdf-spinner{animation:none;border-top-color:#fb7185}' +
    '.wtpdf-msg{font:700 26px/1.7 Vazirmatn,Tahoma,sans-serif;color:#f2f4fb;white-space:pre-line}' +
    '.wtpdf-hint{font:600 16px/1.6 Vazirmatn,Tahoma,sans-serif;color:#c9c2ff;opacity:.85}' +
    // پنل کوچک تعاملی حالت دستی: فقط خود کارت کلیک می‌خورد، بقیه صفحه برای کاربر آزاد است
    '.wtpdf-manual{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;direction:rtl;max-width:92vw}' +
    '.wtpdf-manual-card{display:flex;flex-direction:column;align-items:center;gap:10px;pointer-events:auto;' +
    'background:rgba(15,19,28,.98);border:1px solid rgba(52,211,153,.55);border-radius:18px;padding:18px 24px;' +
    'box-shadow:0 22px 70px rgba(0,0,0,.7),0 0 0 4px rgba(52,211,153,.14);text-align:center}' +
    '.wtpdf-manual .wtpdf-msg{font:700 17px/1.6 Vazirmatn,Tahoma,sans-serif;color:#f2f4fb;white-space:pre-line;max-width:440px}' +
    '.wtpdf-count{font:800 24px/1.4 Vazirmatn,Tahoma,sans-serif;color:#34d399}' +
    '.wtpdf-manual .wtpdf-hint{font:600 12.5px/1.6 Vazirmatn,Tahoma,sans-serif;color:#c9c2ff;opacity:.9}' +
    '.wtpdf-done{border:0;border-radius:12px;padding:11px 30px;cursor:pointer;' +
    'background:linear-gradient(135deg,#34d399,#10b981);color:#06281d;' +
    'font:800 15px/1 Vazirmatn,Tahoma,sans-serif;box-shadow:0 10px 28px -10px rgba(16,185,129,.85);transition:filter .15s,transform .15s}' +
    '.wtpdf-done:hover{filter:brightness(1.08);transform:translateY(-1px)}' +
    '.wtpdf-done:active{transform:scale(.97)}';
  document.documentElement.appendChild(styleTag);

  let uiRoot = null, card = null, say = () => {}, countEl = null;
  let resolveManual = null;
  const manualDone = new Promise((resolve) => { resolveManual = resolve; });

  if (effectiveMode === 'manual') {
    // پنل شناور بالای صفحه؛ بدون پوشش تیره تا کاربر سایت را ببیند و روی مثلث‌های خودش کلیک کند
    uiRoot = document.createElement('div');
    uiRoot.className = 'wtpdf-manual wtpdf-root';
    uiRoot.innerHTML =
      '<div class="wtpdf-manual-card">' +
      '<strong class="wtpdf-msg"></strong>' +
      '<span class="wtpdf-count">0 تصویر</span>' +
      '<span class="wtpdf-hint">روی مثلث یا دکمهٔ صفحهٔ بعدیِ خود سایت بزن؛ تصویر هر صفحه خودکار اضافه می‌شود.</span>' +
      '<button type="button" class="wtpdf-done">تمام شد ✓</button>' +
      '<span class="wtpdf-hint">برای لغو کامل عملیات، کلید ESC را بزنید</span>' +
      '</div>';
    document.documentElement.appendChild(uiRoot);
    const msgEl = uiRoot.querySelector('.wtpdf-msg');
    countEl = uiRoot.querySelector('.wtpdf-count');
    say = (t) => { msgEl.textContent = t; };
    // دکمهٔ «تمام شد» در فاز capture مصرف می‌شود تا کلیک به خود سایت نرسد
    uiRoot.querySelector('.wtpdf-done').addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      resolveManual('done');
    }, true);
  } else {
    // پوشش تمام‌صفحهٔ تیره با کارت وسط‌چین و قلم درشت (اسکرول و ورق‌زدن خودکار)
    uiRoot = document.createElement('div');
    uiRoot.className = 'wtpdf-overlay wtpdf-root';
    card = document.createElement('div');
    card.className = 'wtpdf-card';
    card.innerHTML = '<span class="wtpdf-spinner" aria-hidden="true"></span><span class="wtpdf-msg"></span>' +
      '<span class="wtpdf-hint">برای لغو عملیات، کلید ESC را بزنید</span>';
    uiRoot.appendChild(card);
    document.documentElement.appendChild(uiRoot);
    say = (t) => { card.querySelector('.wtpdf-msg').textContent = t; };
  }
  const removeUi = () => {
    if (uiRoot && uiRoot.parentNode) uiRoot.parentNode.removeChild(uiRoot);
    styleTag.remove();
  };

  // لغو با ESC (این کد داخل خود صفحهٔ وب اجرا می‌شود)؛ در حالت دستی قول انتظار را هم حل می‌کند
  let cancelled = false;
  // فقط وقتی اسکن Google Books واقعاً در جریان است پیام لغو به service worker برود تا پرچم کهنه نماند
  let gbookScanActive = false;
  const onCancelKey = (e) => {
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      e.stopPropagation();
      cancelled = true;
      if (effectiveMode === 'manual') resolveManual('cancel');
      if (gbookScanActive) {
        try {
          const cancelMsg = chrome.runtime.sendMessage({ type: 'WTPDF_GBOOKS_CANCEL' });
          if (cancelMsg && typeof cancelMsg.catch === 'function') cancelMsg.catch(() => {});
        } catch { /* افزونه در دسترس نیست */ }
      }
    }
  };
  document.addEventListener('keydown', onCancelKey, true);

  // ---------- مسیر اختصاصی Google Books (API رسمی reader، بدون نیاز به کلیک/DOM) ----------
  const runGoogleBooks = async () => {
    const onProgress = (m) => {
      if (m && m.type === 'WTPDF_GBOOKS_PROGRESS' && m.phase === 'walk') {
        say(`در حال خواندن صفحات کتاب از Google Books...\n${m.resolved || 0} صفحهٔ قابل‌پیش‌نمایش از ${m.total || 0} صفحه پیدا شد`);
      }
    };
    chrome.runtime.onMessage.addListener(onProgress);
    gbookScanActive = true;
    try {
      say('در حال اتصال به کتاب‌خوان Google Books و خواندن فهرست صفحه‌ها...');
      const res = await chrome.runtime.sendMessage({
        type: 'WTPDF_GBOOKS_SCAN', pageUrl: location.href, pageLimit
      });
      if (!res || !res.ok) {
        if (res && res.cancelled) cancelled = true;
        throw new Error(res && res.error ? res.error : 'پاسخی از Google Books دریافت نشد');
      }
      say(`${res.availablePages} صفحهٔ قابل‌پیش‌نمایش از ${res.totalPages} صفحهٔ کتاب پیدا شد.`);
      return res;
    } finally {
      gbookScanActive = false;
      chrome.runtime.onMessage.removeListener(onProgress);
    }
  };

  // ---------- مسیر درون‌قاب Google Books: fetch هم‌مبدا از خود فریم reader (طبیعی‌ترین حالت برای گوگل) ----------
  const gbNormalizeSrc = (src) => {
    let abs = src;
    if (abs.startsWith('//')) abs = 'https:' + abs;
    if (/[?&]w=\d+/.test(abs)) return abs.replace(/([?&]w=)\d+/, '$1' + '10000');
    return abs + (abs.includes('?') ? '&' : '?') + 'w=10000';
  };
  const gbParseJson = (text) => {
    const clean = text.replace(/^\)\]\}'?\s*/, '').replace(/^while\s*\(\s*1\s*\)\s*;?\s*/, '').trim();
    return JSON.parse(clean);
  };
  // یک درخواست تک‌تلاش click3 هم‌مبدا با timeout؛ retry در خود walker مدیریت می‌شود
  const gbFetchClick3 = async (pid) => {
    if (cancelled) { const e = new Error('cancelled'); e.cancelled = true; throw e; }
    const url = `${gbook.origin}/books?id=${encodeURIComponent(gbook.id)}&hl=en&lpg=${encodeURIComponent('1')}` +
      `&pg=${encodeURIComponent(pid)}&jscmd=click3`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), T.gbookTimeout);
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
      return gbParseJson(await res.text());
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('request timeout');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };

  // پیمایش کامل کتاب داخل فریم reader؛ همان منطق مقاوم service worker ولی با fetch هم‌مبدا
  const runGoogleBooksWalkInPage = async () => {
    const first = await gbFetchClick3('1');
    if (!first || !Array.isArray(first.page) || !first.page.length) {
      throw new Error('فهرست صفحه‌های کتاب خالی بود یا این کتاب پیش‌نمایش ندارد');
    }
    const order = [];
    const srcByPid = new Map();
    // صفحه‌ای که پاسخ اختصاصی‌اش بدون src برگردد قطعاً قابل‌پیش‌نمایش نیست و دوباره درخواست نمی‌شود
    const definitiveEmpty = new Set();
    const merge = (data) => {
      if (!data || !Array.isArray(data.page)) return;
      data.page.forEach((p) => {
        if (!p || !p.pid) return;
        if (!order.includes(p.pid)) order.push(p.pid);
        if (typeof p.src === 'string' && p.src && !srcByPid.has(p.pid)) srcByPid.set(p.pid, p.src);
      });
    };
    merge(first);

    const attempts = new Map();
    let consecutiveErrors = 0;
    let lastError = null;
    let limited = false;
    let lastAttemptedIndex = -1;
    while (true) {
      if (cancelled) { const e = new Error('cancelled'); e.cancelled = true; throw e; }
      // سقف تعداد صفحه: به محض رسیدن به N صفحهٔ برداشت‌شده پیمایش تمام می‌شود
      if (pageLimit > 0 && srcByPid.size >= pageLimit) { limited = true; break; }
      const pidIndex = order.findIndex((candidate) =>
        !srcByPid.has(candidate) && !definitiveEmpty.has(candidate) && (attempts.get(candidate) || 0) < T.gbookRounds);
      if (pidIndex < 0) break;
      const pid = order[pidIndex];
      lastAttemptedIndex = Math.max(lastAttemptedIndex, pidIndex);
      const round = (attempts.get(pid) || 0) + 1;
      attempts.set(pid, round);
      say(`در حال خواندن صفحات کتاب از Google Books...\n${srcByPid.size} صفحهٔ قابل‌پیش‌نمایش از ${order.length} صفحه` +
        (pageLimit ? ` (سقف: ${pageLimit})` : ''));
      try {
        const data = await gbFetchClick3(pid);
        merge(data);
        if (!srcByPid.has(pid)) definitiveEmpty.add(pid);
        consecutiveErrors = 0;
        lastError = null;
      } catch (e) {
        if (e && e.cancelled) throw e;
        consecutiveErrors += 1;
        lastError = e;
      }
      const stillRetrying = !srcByPid.has(pid) && !definitiveEmpty.has(pid) && round < T.gbookRounds;
      let pause;
      if (stillRetrying) {
        const base = lastError && lastError.retryAfterMs ? lastError.retryAfterMs : (T.gbookBackoff[round - 1] || 5000);
        pause = base * Math.min(4, 1 + consecutiveErrors * 0.5);
      } else {
        // jitter تصادفی الگوی رباتیک درخواست‌ها را می‌شکند
        pause = T.gbookPause + Math.random() * 150;
      }
      await sleep(Math.round(pause));
    }
    // با سقف، پاسخ‌های هدیهٔ مجاور ممکن است چند صفحهٔ اضافه آورده باشند؛ به N صفحهٔ اول برش می‌زنیم
    let picked = order.filter((pid) => srcByPid.has(pid));
    if (pageLimit > 0) { limited = limited || picked.length > pageLimit; picked = picked.slice(0, pageLimit); }
    const urls = picked.map((pid) => gbNormalizeSrc(srcByPid.get(pid)));
    if (!urls.length) throw new Error('هیچ صفحهٔ قابل‌پیش‌نمایشی برای این کتاب پیدا نشد');
    // صفحات ناموفق فقط در محدودهٔ پردازش‌شده شمرده می‌شوند تا با سقف اشتباه گزارش نشوند
    const scope = limited ? order.slice(0, lastAttemptedIndex + 1) : order;
    const failedPages = scope.filter((pid) => !srcByPid.has(pid)).length;
    return {
      ok: true, urls, totalPages: order.length, availablePages: urls.length,
      failedPages, limited: limited || (pageLimit > 0 && urls.length >= pageLimit)
    };
  };

  // حل یک صفحهٔ منفرد برای حالت دستی داخل فریم (یک درخواست سبک هم‌مبدا)
  const resolveGoogleBooksPageInPage = async (pid) => {
    const data = await gbFetchClick3(pid);
    const entry = (data.page || []).find((p) => p && p.pid === pid && typeof p.src === 'string' && p.src);
    if (!entry) return { ok: false, error: 'این صفحه قابل‌پیش‌نمایش نیست' };
    return { ok: true, pid: entry.pid, src: gbNormalizeSrc(entry.src) };
  };

  // ---------- حالت دستی Google Books: کاربر ورق می‌زند، افزونه فقط همان صفحه را از API برمی‌دارد ----------
  const runGoogleBooksManual = async () => {
    // داخل فریم reader درخواست هم‌مبدا مستقیم است؛ در فریم بالایی از service worker کمک می‌گیریم
    const transport = gbook.inFrame ? 'inpage' : 'sw';
    const pidFromHref = (href) => {
      try { return new URL(href).searchParams.get('pg') || '1'; } catch { return '1'; }
    };
    const collectedPids = new Set();
    const inFlight = new Set();
    let limitReached = false;
    const refreshCount = () => {
      countEl.textContent = limitReached && pageLimit
        ? `${urls.length} تصویر (به سقف ${pageLimit} رسیدی)`
        : `${urls.length} تصویر جمع شد`;
    };
    const grab = async (pid) => {
      if (!pid || inFlight.has(pid) || cancelled || limitReached) return;
      inFlight.add(pid);
      try {
        const res = transport === 'inpage'
          ? await resolveGoogleBooksPageInPage(pid)
          : await chrome.runtime.sendMessage({
            type: 'WTPDF_GBOOKS_PAGE', pageUrl: location.href, pid
          });
        if (!cancelled && res && res.ok && res.src) {
          add(res.src);
          collectedPids.add(pid);
          if (pageLimit > 0 && urls.length >= pageLimit) {
            limitReached = true;
            say(`به سقف ${pageLimit} صفحه رسیدی؛ صفحه‌های جدید دیگر برداشته نمی‌شوند. برای پایان «تمام شد ✓» را بزن.`);
          }
          refreshCount();
        }
      } catch {
        // خطای موقت؛ دور بعدی interval همان صفحه را دوباره امتحان می‌کند
      } finally {
        inFlight.delete(pid);
      }
    };
    say('حالت دستی Google Books: با مثلث‌های خود گوگل صفحه‌ها را ورق بزن');
    refreshCount();
    await grab(pidFromHref(location.href));
    // گوگل‌بوک با هر ورق، پارامتر pg آدرس را عوض می‌کند؛ همان شاخص برای دنبال‌کردن صفحه‌ها کافی است
    const timer = setInterval(() => {
      if (cancelled || limitReached) return;
      const pid = pidFromHref(location.href);
      if (!collectedPids.has(pid)) grab(pid);
    }, T.gbookManualPoll);

    const outcome = await manualDone;
    clearInterval(timer);
    if (outcome === 'cancel') cancelled = true;
  };

  // ---------- حالت ۱: اسکرول تا انتهای صفحه (رفتار پیش‌فرض قبلی) ----------
  const runScroll = async () => {
    say('در حال اسکرول برای لود تصاویر...');
    window.scrollTo(0, 0);
    await sleep(300);

    let stable = 0;
    let last = getH();
    for (let i = 0; i < T.scrollMax; i++) {
      if (cancelled) break;
      window.scrollBy(0, Math.round(window.innerHeight * T.scrollStep));
      const pct = Math.min(100, Math.round(((window.scrollY + window.innerHeight) / getH()) * 100));
      say(`در حال اسکرول برای لود تصاویر... ${pct}٪`);
      await sleep(T.scrollSleep);
      const h = getH();
      const atBottom = window.innerHeight + window.scrollY >= h - 5;
      if (atBottom && h === last) {
        if (++stable >= 4) break;
        await sleep(500);
      } else {
        stable = 0;
      }
      last = h;
    }
    await sleep(800);
    scanImages();
  };

  // ---------- تشخیص دکمهٔ «بعدی» در صفحه ----------
  const classText = (el) => {
    // className المان‌های SVG رشته نیست؛ baseVal آن را می‌خوانیم
    const c = el.className;
    return String(c && c.baseVal !== undefined ? c.baseVal : c || '') + ' ' + (el.id || '');
  };
  const NEXT_WORDS = /next|forward|بعدی|صفحه[ٔ‌\s]?بعد/i;
  const PREV_WORDS = /prev|previous|back|قبل|قبلی|بازگشت/i;
  const CHEVRON_ONLY = /^[›»❯➤▶→⟩\s‌]+$/;

  const isUsableControl = (el) => {
    if (!el || !el.isConnected) return false;
    if (el.closest && el.closest('.wtpdf-root')) return false;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    if (/disabled|inactive|is-off/i.test(classText(el))) return false;
    const r = el.getBoundingClientRect();
    if (!r || r.width < 8 || r.height < 8) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    return true;
  };

  // امتیازدارترین دکمهٔ قابل‌مشاهدهٔ «بعدی» را برمی‌گرداند یا null
  const findNextButton = () => {
    // انتخابگر دستی کاربر (کپی از F12) در اولویت مطلق است؛ اگر نامعتبر/مخفی بود به heuristic عمومی برمی‌گردیم
    if (nextSelector) {
      let manual;
      try { manual = document.querySelector(nextSelector); } catch { manual = null; }
      if (manual && isUsableControl(manual)) return manual;
    }
    const scored = new Map();
    const consider = (el, score) => { if (el && el.isConnected && !scored.has(el)) scored.set(el, score); };

    document.querySelectorAll('[rel~="next"]').forEach((el) => consider(el, 100));

    document.querySelectorAll('button, a, [role="button"], [onclick], [aria-label], [title]').forEach((el) => {
      if (el.tagName === 'IMG' || (el.closest && el.closest('.wtpdf-root'))) return;
      const label = [el.getAttribute('aria-label'), el.title, el.getAttribute('data-title')].filter(Boolean).join(' ');
      const cls = classText(el);
      const text = (el.textContent || '').trim();
      // هر چیزی که بوی «قبلی/بازگشت» بدهد قطعاً هدف نیست
      if (PREV_WORDS.test(label) || /prev|back/i.test(cls)) return;
      if (NEXT_WORDS.test(label)) { consider(el, 85); return; }
      if (/(^|[^a-z])(next|forward|nav-next|page-next)([^a-z]|$)/i.test(cls)) { consider(el, 65); return; }
      if (NEXT_WORDS.test(text) && text.length < 40) { consider(el, 35); return; }
      if (CHEVRON_ONLY.test(text) && text.length <= 3) consider(el, 25);
    });

    let best = null, bestScore = 0;
    scored.forEach((score, el) => {
      // تساوی امتیاز به نفع اولین المان در ترتیب سند است (Map ترتیب درج را حفظ می‌کند)
      if (score > bestScore && isUsableControl(el)) { best = el; bestScore = score; }
    });
    return best;
  };

  // تا آمدن تصویر تازه (یا رسیدن به زمان‌سنج) صبر می‌کند؛ تعداد تصاویر تازه را برمی‌گرداند
  const waitForNewImages = async (baseline) => {
    const deadline = Date.now() + T.clickTimeout;
    while (Date.now() < deadline) {
      if (cancelled) return 0;
      if (scanImages() > 0 || urls.length > baseline) {
        await sleep(T.settle);
        scanImages();
        return urls.length - baseline;
      }
      await sleep(T.poll);
    }
    scanImages();
    return urls.length - baseline;
  };

  // ---------- حالت ۲: ورق‌زدن خودکار ----------
  const runAuto = async () => {
    await sleep(300);
    scanImages();
    let page = 1, stuck = 0;
    say(`ورق‌زدن خودکار — صفحهٔ ${page} — ${urls.length} تصویر`);

    while (page < T.maxPages && !cancelled) {
      const btn = findNextButton();
      if (!btn) {
        say(`دکمهٔ «بعدی» پیدا نشد؛ به پایان رسیدیم.\nدر مجموع ${urls.length} تصویر جمع شد.`);
        return;
      }
      try { btn.scrollIntoView({ block: 'center', inline: 'center' }); } catch { /* بعضی المان‌ها scrollIntoView ندارند */ }
      await sleep(60);
      if (cancelled) return;
      btn.click();
      page += 1;

      const gained = await waitForNewImages(urls.length);
      if (cancelled) return;
      if (gained > 0) {
        stuck = 0;
        say(`ورق‌زدن خودکار — صفحهٔ ${page} — ${urls.length} تصویر جمع شد`);
      } else {
        stuck += 1;
        say(`صفحهٔ ${page}: تصویر تازه‌ای نیامد (تلاش ${stuck} از ${T.stuckLimit})`);
        if (stuck >= T.stuckLimit) {
          say(`تصویر تازه‌ای پیدا نشد؛ جمع‌آوری تمام شد.\nدر مجموع ${urls.length} تصویر.`);
          return;
        }
      }
    }
    if (!cancelled) say(`به سقف ${T.maxPages} صفحه رسیدیم؛ جمع‌آوری متوقف شد.\nدر مجموع ${urls.length} تصویر.`);
  };

  // ---------- حالت ۳: ورق‌زدن دستی (کاربر کلیک می‌کند، افزونه برمی‌دارد) ----------
  const runManual = async () => {
    let lastCount = -1;
    const refreshCount = () => {
      if (urls.length !== lastCount) {
        lastCount = urls.length;
        countEl.textContent = `${urls.length} تصویر جمع شد`;
      }
    };
    scanImages();
    refreshCount();
    say('حالت دستی فعال است؛ تو صفحه‌ها را ورق بزن');

    // هر تغییر DOM (تعویض src، اضافه‌شدن img جدید و...) بلافاصله یک اسکن می‌خورد
    const observer = new MutationObserver((mutations) => {
      // تغییرات خود پنل افزونه نباید اسکن بی‌مورد بسازد
      if (mutations.every((m) => m.target && m.target.closest && m.target.closest('.wtpdf-root'))) return;
      scanImages();
      refreshCount();
    });
    observer.observe(document.documentElement, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ['src', 'srcset', 'style', 'class', 'data-src', 'data-url']
    });
    // پشتیبان دوره‌ای برای سایت‌هایی که تغییرشان را observer نمی‌گیرد
    const timer = setInterval(() => { scanImages(); refreshCount(); }, T.manualRescan);

    const outcome = await manualDone;
    observer.disconnect();
    clearInterval(timer);
    if (outcome === 'cancel') cancelled = true;
  };

  const runSelectedMode = async (selectedMode) => {
    if (selectedMode === 'scroll') return runScroll();
    if (selectedMode === 'auto') return runAuto();
    return runManual();
  };

  let usedGoogleBooks = false;
  let gbookResult = null;
  try {
    if (gbook) {
      if (effectiveMode === 'manual') {
        // حالت دستی گوگل‌بوک: پنل شناور، کاربر ورق می‌زند و هر صفحه فقط به اندازهٔ یک درخواست سبک برداشته می‌شود
        await runGoogleBooksManual();
        usedGoogleBooks = true;
      } else {
        // مسیر اختصاصی Google Books: فهرست کامل صفحه‌ها از API رسمی، بدون کلیک و بدون اسکن کاشی‌های DOM
        let gbRes = null;
        try {
          // اولویت با fetch هم‌مبدا داخل فریم reader است (طبیعی‌ترین درخواست، کمترین خطر throttle)
          gbRes = gbook.inFrame ? await runGoogleBooksWalkInPage() : await runGoogleBooks();
        } catch {
          if (cancelled) return { cancelled: true, count: 0, skippedInline: 0 };
          if (gbook.inFrame) {
            say('مسیر درون‌قاب Google Books جواب نداد؛ از service worker تلاش می‌شود...');
            await sleep(1000);
            try { gbRes = await runGoogleBooks(); }
            catch {
              if (cancelled) return { cancelled: true, count: 0, skippedInline: 0 };
            }
          } else {
            say('مسیر اختصاصی Google Books جواب نداد؛ اسکن عادی صفحه امتحان می‌شود...');
            await sleep(1200);
          }
        }
        if (gbRes && gbRes.ok && Array.isArray(gbRes.urls) && gbRes.urls.length) {
          gbRes.urls.forEach(add);
          usedGoogleBooks = true;
          gbookResult = gbRes;
        } else {
          await runSelectedMode(effectiveMode);
        }
      }
    } else {
      await runSelectedMode(effectiveMode);
    }

    if (cancelled) {
      if (card) {
        card.classList.add('wtpdf-cancel');
        say('عملیات با کلید ESC لغو شد.');
      }
      await sleep(effectiveMode === 'manual' ? 0 : 1200);
      return { cancelled: true, count: 0, skippedInline: 0 };
    }

    // اسکن نهایی تضمینی فقط برای مسیرهای DOM؛ در Google Books اسکن صفحه کاشی‌های ۲۵۶px بی‌ربط می‌آورد
    if (!usedGoogleBooks) scanImages();
    if (urls.length === 0) {
      say(skippedInline ? `تصاویر داخلی پیدا شدند اما ${skippedInline} مورد از حد مجاز بزرگ‌تر بودند.` : 'هیچ تصویری پیدا نشد!');
      await sleep(3000);
      return { count: 0, skippedInline };
    }

    const notes = [];
    if (gbookResult && gbookResult.limited) notes.push('به سقف تعیین‌شده رسیدیم');
    if (gbookResult && gbookResult.failedPages) notes.push(`${gbookResult.failedPages} صفحهٔ غیرقابل‌پیش‌نمایش کنار گذاشته شد`);
    const gbNote = notes.length ? ` (${notes.join('؛ ')})` : '';
    say(effectiveMode === 'manual'
      ? `${urls.length} تصویر آماده است. در حال باز کردن پیش‌نمایش...`
      : `${urls.length} تصویر پیدا شد${gbNote}. در حال باز کردن پیش‌نمایش...`);
    const response = await chrome.runtime.sendMessage({
      type: 'WTPDF_URLS', urls, name: pdfName, pageUrl: location.href, skippedInline
    });
    if (!response || !response.ok) {
      throw new Error(`ذخیرهٔ فهرست تصویرها ناموفق بود${response && response.error ? `: ${response.error}` : ''}`);
    }
    await sleep(1500);
    return { count: urls.length, skippedInline };
  } finally {
    document.removeEventListener('keydown', onCancelKey, true);
    removeUi();
    window.__wtpdfRunning = false;
  }
}
