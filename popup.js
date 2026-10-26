document.getElementById('startBtn').addEventListener('click', async () => {
  const startBtn = document.getElementById('startBtn');
  const statusText = document.getElementById('statusText');
  let pdfName = document.getElementById('pdfName').value.trim() || 'comic';
  if (!pdfName.toLowerCase().endsWith('.pdf')) pdfName += '.pdf';

  startBtn.disabled = true;
  statusText.innerText = 'در حال اسکرول صفحه برای لود تصاویر...\n(می‌توانید popup را ببندید؛ پیشرفت روی خود صفحه نمایش داده می‌شود)';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeAndSend,
      args: [pdfName]
    });
    const res = results[0] && results[0].result;
    if (res && res.busy) {
      statusText.innerText = 'عملیات روی این صفحه از قبل در حال اجراست.';
    } else if (!res || res.count === 0) {
      statusText.innerText = res && res.skippedInline
        ? `تصاویر داخلی پیدا شدند، اما ${res.skippedInline} مورد از حد مجاز بزرگ‌تر بودند.`
        : 'هیچ تصویری در این صفحه پیدا نشد!';
    } else {
      const skipped = res.skippedInline ? ` (${res.skippedInline} تصویر داخلی بزرگ نادیده گرفته شد)` : '';
      statusText.innerText = `${res.count} تصویر پیدا شد${skipped}. تب پیش‌نمایش باز شد؛ تصاویر دلخواه را انتخاب کنید.`;
    }
  } catch (err) {
    console.error(err);
    statusText.innerText = 'خطا: ' + (err && err.message ? err.message : err) +
      '\n(روی صفحات chrome:// و فروشگاه کروم اکستنشن کار نمی‌کند)';
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

  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
    'background:rgba(17,21,28,.96);color:#e9ecf3;padding:11px 20px;border-radius:14px;border:1px solid rgba(139,123,255,.55);' +
    'font:600 13.5px Tahoma,sans-serif;box-shadow:0 14px 40px rgba(0,0,0,.55),0 0 0 3px rgba(139,123,255,.18);direction:rtl;pointer-events:none';
  document.documentElement.appendChild(box);
  const say = (t) => { box.textContent = t; };

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
        try { abs = new URL(src, location.href).href; } catch (e) { return; }
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
    box.remove();
    window.__wtpdfRunning = false;
  }
}
