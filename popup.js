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

startBtn.addEventListener('click', async () => {
  let pdfName = document.getElementById('pdfName').value.trim() || 'comic';
  if (!pdfName.toLowerCase().endsWith('.pdf')) pdfName += '.pdf';

  startBtn.disabled = true;
  // خطای اجرای قبلی را پاک کن؛ این بار فقط در صورت بروز خطا باکس ظاهر می‌شود
  hideStatus();
  setStatus('در حال اسکرول صفحه برای لود تصاویر...\n(می‌توانید popup را ببندید؛ پیشرفت روی خود صفحه نمایش داده می‌شود)');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeAndSend,
      args: [pdfName]
    });
    const res = results[0] && results[0].result;
    if (res && res.busy) {
      showError('عملیات روی این صفحه از قبل در حال اجراست.');
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

// این تابع داخل صفحهٔ وب اجرا می‌شود
async function scrapeAndSend(pdfName) {
  if (window.__wtpdfRunning) return { busy: true };
  window.__wtpdfRunning = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const getH = () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);

  // پوشش تمام‌صفحهٔ تیره با کارت وسط‌چین و قلم درشت (حدود دو برابر قلم قبلی) تا کاربر هنگام اسکرول حتماً پیشرفت را ببیند
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
    '.wtpdf-msg{font:700 26px/1.7 Vazirmatn,Tahoma,sans-serif;color:#f2f4fb;white-space:pre-line}';
  document.documentElement.appendChild(styleTag);
  const overlay = document.createElement('div');
  overlay.className = 'wtpdf-overlay';
  const box = document.createElement('div');
  box.className = 'wtpdf-card';
  box.innerHTML = '<span class="wtpdf-spinner" aria-hidden="true"></span><span class="wtpdf-msg"></span>';
  overlay.appendChild(box);
  document.documentElement.appendChild(overlay);
  const say = (t) => { box.querySelector('.wtpdf-msg').textContent = t; };

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

  try {
    say('در حال اسکرول برای لود تصاویر...');
    window.scrollTo(0, 0);
    await sleep(300);

    let stable = 0;
    let last = getH();
    for (let i = 0; i < 800; i++) {
      window.scrollBy(0, Math.round(window.innerHeight * 0.7));
      const pct = Math.min(100, Math.round(((window.scrollY + window.innerHeight) / getH()) * 100));
      say(`در حال اسکرول برای لود تصاویر... ${pct}٪`);
      await sleep(200);
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

    document.querySelectorAll('img').forEach((img) => {
      const src = bestSrc(img);
      const rect = img.getBoundingClientRect();
      const w = Math.max(img.naturalWidth || 0, rect.width);
      const h = Math.max(img.naturalHeight || 0, rect.height);
      if (Math.max(w, h) < 250) return;
      if (/logo|icon|avatar|sprite|emoji/i.test(src || '')) return;
      add(src);
    });

    // بعضی سایت‌ها کمیک را با CSS background می‌سازند و در کنار imgها هم ممکن است تصویر داشته باشند.
    document.querySelectorAll('div, section, span, a').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 250 || r.height < 250) return;
      const bg = getComputedStyle(el).backgroundImage;
      const m = bg && bg.match(/url\(["']?(.*?)["']?\)/);
      if (m && !/logo|icon|avatar|sprite|emoji/i.test(m[1])) add(m[1]);
    });

    if (urls.length === 0) {
      say(skippedInline ? `تصاویر داخلی پیدا شدند اما ${skippedInline} مورد از حد مجاز بزرگ‌تر بودند.` : 'هیچ تصویری پیدا نشد!');
      await sleep(3000);
      return { count: 0, skippedInline };
    }

    say(`${urls.length} تصویر پیدا شد. در حال باز کردن پیش‌نمایش...`);
    const response = await chrome.runtime.sendMessage({ type: 'WTPDF_URLS', urls, name: pdfName, pageUrl: location.href, skippedInline });
    if (!response || !response.ok) throw new Error(`ذخیرهٔ فهرست تصویرها ناموفق بود${response && response.error ? `: ${response.error}` : ''}`);
    await sleep(1500);
    return { count: urls.length, skippedInline };
  } finally {
    overlay.remove();
    styleTag.remove();
    window.__wtpdfRunning = false;
  }
}
