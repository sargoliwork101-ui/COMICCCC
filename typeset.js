// جای‌گذاری متن فارسی روی تصویر (پاک کردن متن قدیمی + نوشتن ترجمه)
(function (root) {
  const FONT = 'Vazirmatn';

  function median(arr) { arr.sort((a, b) => a - b); return arr[Math.floor(arr.length / 2)]; }
  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  // رنگ پس‌زمینهٔ اطراف کادر متن را از نوار باریک بیرون آن می‌خواند
  function sampleBg(ctx, box, W, H) {
    const t = 3, off = 2;
    const strips = [
      [box.x0, box.y0 - off - t, box.x1 - box.x0, t],
      [box.x0, box.y1 + off, box.x1 - box.x0, t],
      [box.x0 - off - t, box.y0, t, box.y1 - box.y0],
      [box.x1 + off, box.y0, t, box.y1 - box.y0]
    ];
    const R = [], G = [], B = [];
    strips.forEach(([x, y, w, h]) => {
      x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
      w = Math.min(W - x, Math.round(w)); h = Math.min(H - y, Math.round(h));
      if (w <= 0 || h <= 0) return;
      const d = ctx.getImageData(x, y, w, h).data;
      for (let i = 0; i < d.length; i += 4) { R.push(d[i]); G.push(d[i + 1]); B.push(d[i + 2]); }
    });
    if (!R.length) return { r: 255, g: 255, b: 255, uniform: true };
    const r = median(R), g = median(G), b = median(B);
    let s = 0; const L = lum(r, g, b);
    for (let i = 0; i < R.length; i += 3) { const d = lum(R[i], G[i], B[i]) - L; s += d * d; }
    return { r, g, b, uniform: Math.sqrt(s / Math.ceil(R.length / 3)) < 28 };
  }

  function wrapWords(ctx, text, maxW) {
    const words = text.split(/\s+/).filter(Boolean);
    const lines = []; let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (!cur || ctx.measureText(t).width <= maxW) cur = t; else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  // ---------- قالب‌بندی درون‌متنی: استایل یک کلمه/عبارت داخل متن یک بلوک ----------
  // نشانگرها: **پررنگ** *ایتالیک* __زیرخط__؛ نشانگر جفت‌نشده مثل متن عادی رفتار می‌کند و تو در تو پشتیبانی نمی‌شود.
  const INLINE_TEST_RE = /(\*\*[\s\S]+?\*\*|__[\s\S]+?__|\*[^*\n]+?\*)/;
  const INLINE_TOKEN_RE = /\*\*[\s\S]+?\*\*|__[\s\S]+?__|\*[^*\n]+?\*/g;

  function hasInlineMarks(text) { return INLINE_TEST_RE.test(String(text || '')); }

  // متن را به قطعه‌هایی با استایل درون‌متنی می‌شکند؛ قطعهٔ عادی بدون پرچم است
  function tokenizeInline(text) {
    const runs = [];
    const push = (t, style) => { if (t) runs.push(Object.assign({ t }, style)); };
    let last = 0, m;
    INLINE_TOKEN_RE.lastIndex = 0;
    while ((m = INLINE_TOKEN_RE.exec(text))) {
      if (m.index > last) push(text.slice(last, m.index), {});
      const tok = m[0];
      if (tok.startsWith('**')) push(tok.slice(2, -2), { bold: true });
      else if (tok.startsWith('__')) push(tok.slice(2, -2), { underline: true });
      else push(tok.slice(1, -1), { italic: true });
      last = INLINE_TOKEN_RE.lastIndex;
    }
    if (last < text.length) push(text.slice(last), {});
    return runs;
  }

  // برای خروجی متنی ساده: فقط نشانگرها حذف می‌شوند و خود کلمه‌ها می‌مانند
  function stripInlineMarkers(text) {
    return String(text || '')
      .replace(/\*\*([\s\S]+?)\*\*/g, '$1')
      .replace(/__([\s\S]+?)__/g, '$1')
      .replace(/\*([^*\n]+?)\*/g, '$1');
  }

  // توکن‌های کلمه‌ای با استایل چسبیده؛ فاصله‌های چندتایی مثل wrapWords قدیمی به یک فاصله تقلیل می‌یابند
  function inlineWords(text) {
    const words = [];
    tokenizeInline(text).forEach((run) => {
      run.t.split(/\s+/).filter(Boolean).forEach((w) => {
        words.push({ t: w, bold: !!run.bold, italic: !!run.italic, underline: !!run.underline });
      });
    });
    return words;
  }

  // پیشوند فونت یک کلمه = پیش‌فرض بلوک + استایل درون‌متنی (مارکر صریح همیشه روشن می‌کند)
  function inlineFontPrefix(st, w) {
    const weight = w.bold ? true : st.bold !== false;
    const italic = w.italic || st.italic;
    return `${italic ? 'italic ' : ''}${weight ? '700' : '400'} `;
  }
  const baseFontPrefix = (st) => `${st.italic ? 'italic ' : ''}${st.bold !== false ? '700' : '400'} `;

  // عرض هر کلمه با فونت خودش + عرض فاصله با فونت پایهٔ بلوک
  function measureLine(ctx, line, st, size) {
    const baseFont = `${baseFontPrefix(st)}${size}px ${FONT}`;
    ctx.font = baseFont;
    const spaceW = ctx.measureText(' ').width;
    const widths = line.map((w) => {
      ctx.font = `${inlineFontPrefix(st, w)}${size}px ${FONT}`;
      return ctx.measureText(w.t).width;
    });
    ctx.font = baseFont;
    const width = widths.reduce((sum, v, i) => sum + v + (i ? spaceW : 0), 0);
    return { widths, spaceW, width };
  }

  // شکستن خط با اندازهٔ مشخص؛ هر کلمه با فونت خودش اندازه می‌شود
  function wrapInlineAt(ctx, words, maxW, st, size) {
    const baseFont = `${baseFontPrefix(st)}${size}px ${FONT}`;
    ctx.font = baseFont;
    const spaceW = ctx.measureText(' ').width;
    const widthOf = (w) => {
      ctx.font = `${inlineFontPrefix(st, w)}${size}px ${FONT}`;
      return ctx.measureText(w.t).width;
    };
    const lines = [];
    let cur = [], curW = 0;
    for (const w of words) {
      const ww = widthOf(w);
      if (!cur.length) { cur = [w]; curW = ww; }
      else if (curW + spaceW + ww <= maxW) { cur.push(w); curW += spaceW + ww; }
      else { lines.push(cur); cur = [w]; curW = ww; }
    }
    if (cur.length) lines.push(cur);
    ctx.font = baseFont;
    return lines;
  }

  // معادل fit برای متن‌های دارای مارکر؛ بهترین اندازه‌ای که همهٔ خطوط در کادر جا شوند
  function fitInline(ctx, text, boxW, boxH, maxSize, minSize, st) {
    const words = inlineWords(text);
    for (let s = maxSize; s >= minSize; s--) {
      const lines = wrapInlineAt(ctx, words, boxW, st, s);
      const widest = Math.max(...lines.map((ln) => measureLine(ctx, ln, st, s).width));
      const lh = s * 1.55;
      if (lines.length * lh <= boxH * 1.2 && widest <= boxW * 1.04) return { size: s, lines, lh };
    }
    return { size: minSize, lines: wrapInlineAt(ctx, words, boxW, st, minSize), lh: minSize * 1.55 };
  }

  function fit(ctx, text, boxW, boxH, maxSize, minSize, fontPrefix = '700 ') {
    for (let s = maxSize; s >= minSize; s--) {
      ctx.font = `${fontPrefix}${s}px ${FONT}`;
      const lines = wrapWords(ctx, text, boxW);
      const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
      const lh = s * 1.55;
      if (lines.length * lh <= boxH * 1.2 && widest <= boxW * 1.04) return { size: s, lines, lh };
    }
    ctx.font = `${fontPrefix}${minSize}px ${FONT}`;
    return { size: minSize, lines: wrapWords(ctx, text, boxW), lh: minSize * 1.55 };
  }

  // قالب‌بندی هر بلوک با پیش‌فرض‌های ایمن برای بلوک‌های قدیمی (ذخیره‌شده قبل از نسخهٔ ۲.۲۸)
  function blockStyle(b) {
    return {
      dir: b.dir === 'ltr' ? 'ltr' : 'rtl',       // جهت متن: پیش‌فرض راست‌به‌چپ
      align: b.align === 'center' || b.align === 'left' ? b.align : 'right', // چیدمان فیزیکی: پیش‌فرض راست‌چین
      bold: b.bold !== false,           // پیش‌فرض مثل گذشته: پررنگ
      italic: !!b.italic,
      underline: !!b.underline,
      size: Number.isFinite(+b.size) && +b.size > 0 ? +b.size : null,
      color: /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : null // null = رنگ خودکار بر اساس پس‌زمینه
    };
  }

  // bmp: تصویر اصلی؛ blocks: بلوک‌ها؛ برمی‌گرداند canvas نهایی
  function render(bmp, blocks, opts) {
    const o = Object.assign({ createCanvas: null }, opts);
    const mk = o.createCanvas || ((w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; });
    const W = bmp.width, H = bmp.height;
    const cv = mk(W, H);
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0);

    blocks.forEach((b) => {
      if (!b.enabled || !b.tr || !b.tr.trim()) return;
      const st = blockStyle(b);
      const fontPrefix = `${st.italic ? 'italic ' : ''}${st.bold ? '700' : '400'} `;
      const pad = Math.max(4, Math.round(b.lineH * 0.3));
      const box = {
        x0: Math.max(0, b.x0 - pad), y0: Math.max(0, b.y0 - pad),
        x1: Math.min(W, b.x1 + pad), y1: Math.min(H, b.y1 + pad)
      };
      const bw = box.x1 - box.x0, bh = box.y1 - box.y0;

      let fill = null, txt = '#0b0b0b', stroke = null;
      if (b.bg === 'none') {
        txt = '#ffffff'; stroke = '#000000';
      } else if (b.bg === 'white') { fill = '#ffffff'; }
      else if (b.bg === 'black') { fill = '#000000'; txt = '#fafafa'; }
      else {
        const s = sampleBg(ctx, box, W, H);
        fill = `rgb(${s.r},${s.g},${s.b})`;
        txt = lum(s.r, s.g, s.b) > 150 ? '#0b0b0b' : '#fafafa';
      }
      // رنگ دستی کاربر بر انتخاب خودکار اولویت دارد (زیرخط هم با همین رنگ رسم می‌شود)
      if (st.color) txt = st.color;
      if (fill) { ctx.fillStyle = fill; ctx.fillRect(box.x0, box.y0, bw, bh); }

      const maxSize = Math.max(12, Math.min(64, Math.round(b.lineH * 1.1)));
      const sourceText = b.tr.trim();
      const inline = hasInlineMarks(sourceText);
      // سایز دستی کاربر جای حالت خودکار می‌نشیند؛ در غیر این صورت بهترین سایز برای جاشدن در کادر
      let f;
      if (inline) {
        f = st.size
          ? { size: st.size, lines: wrapInlineAt(ctx, inlineWords(sourceText), bw * 0.96, st, st.size), lh: st.size * 1.55 }
          : fitInline(ctx, sourceText, bw * 0.96, bh * 0.96, maxSize, 10, st);
      } else if (st.size) {
        ctx.font = `${fontPrefix}${st.size}px ${FONT}`;
        f = { size: st.size, lines: wrapWords(ctx, sourceText, bw * 0.96), lh: st.size * 1.55 };
      } else {
        f = fit(ctx, sourceText, bw * 0.96, bh * 0.96, maxSize, 10, fontPrefix);
      }
      if ('direction' in ctx) ctx.direction = st.dir;
      ctx.textBaseline = 'middle';
      const totalH = f.lines.length * f.lh;
      let y = (box.y0 + box.y1) / 2 - totalH / 2 + f.lh / 2;
      // لنگر هر خط بر اساس چیدمان انتخابی، با حاشیهٔ کوچک از لبهٔ کادر
      const anchorX = st.align === 'left' ? box.x0 + bw * 0.02
        : st.align === 'center' ? (box.x0 + box.x1) / 2
        : box.x1 - bw * 0.02;
      if (inline) {
        // مسیر درون‌متنی: هر کلمه با فونت خودش و در موقعیت فیزیکی محاسبه‌شده رسم می‌شود
        ctx.textAlign = 'left';
        f.lines.forEach((line) => {
          const m = measureLine(ctx, line, st, f.size);
          let x = st.align === 'left' ? anchorX
            : st.align === 'center' ? anchorX - m.width / 2
            : anchorX - m.width;
          // در پاراگراف RTL اولین کلمهٔ منطقی سمت راست است؛ پس ترتیب دیداری برعکس می‌شود
          const visual = st.dir === 'rtl' ? line.map((_, i) => line.length - 1 - i) : line.map((_, i) => i);
          visual.forEach((idx) => {
            const w = line[idx];
            ctx.font = `${inlineFontPrefix(st, w)}${f.size}px ${FONT}`;
            if (stroke) { ctx.lineWidth = Math.max(3, f.size / 5); ctx.strokeStyle = stroke; ctx.lineJoin = 'round'; ctx.strokeText(w.t, x, y); }
            ctx.fillStyle = txt;
            ctx.fillText(w.t, x, y);
            if (st.underline || w.underline) {
              ctx.strokeStyle = txt;
              ctx.lineWidth = Math.max(1, f.size / 14);
              ctx.beginPath();
              ctx.moveTo(x, y + f.size * 0.55);
              ctx.lineTo(x + m.widths[idx], y + f.size * 0.55);
              ctx.stroke();
            }
            x += m.widths[idx] + m.spaceW;
          });
          y += f.lh;
        });
        return;
      }
      ctx.textAlign = st.align;
      f.lines.forEach((ln) => {
        if (stroke) { ctx.lineWidth = Math.max(3, f.size / 5); ctx.strokeStyle = stroke; ctx.lineJoin = 'round'; ctx.strokeText(ln, anchorX, y); }
        ctx.fillStyle = txt;
        ctx.fillText(ln, anchorX, y);
        if (st.underline) {
          const lineW = ctx.measureText(ln).width;
          const ux = st.align === 'left' ? anchorX : st.align === 'center' ? anchorX - lineW / 2 : anchorX - lineW;
          const uy = y + f.size * 0.55;
          ctx.strokeStyle = txt;
          ctx.lineWidth = Math.max(1, f.size / 14);
          ctx.beginPath();
          ctx.moveTo(ux, uy);
          ctx.lineTo(ux + lineW, uy);
          ctx.stroke();
        }
        y += f.lh;
      });
    });
    return cv;
  }

  const api = {
    render, sampleBg, fit, wrapWords, blockStyle,
    hasInlineMarks, tokenizeInline, stripInlineMarkers, inlineWords, fitInline
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Typeset = api;
})(typeof window !== 'undefined' ? window : globalThis);
