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
  // نشانگرها: **پررنگ** *ایتالیک* __زیرخط__ [size=24]اندازه[/size] [color=#hex]رنگ[/color]؛
  // نشانگر جفت‌نشده مثل متن عادی رفتار می‌کند و تو در تو پشتیبانی نمی‌شود.
  const INLINE_TEST_RE = /(\*\*[\s\S]+?\*\*|__[\s\S]+?__|\*[^*\n]+?\*|\[size=\d{1,3}\][\s\S]+?\[\/size\]|\[color=#[0-9a-fA-F]{6}\][\s\S]+?\[\/color\])/;
  const INLINE_TOKEN_RE = /\*\*[\s\S]+?\*\*|__[\s\S]+?__|\*[^*\n]+?\*|\[size=(\d{1,3})\][\s\S]+?\[\/size\]|\[color=(#[0-9a-fA-F]{6})\][\s\S]+?\[\/color\]/g;

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
      else if (tok.startsWith('*')) push(tok.slice(1, -1), { italic: true });
      else if (tok.startsWith('[size')) push(tok.replace(/^\[size=\d+\]/, '').replace(/\[\/size\]$/, ''), { size: Number(m[1]) });
      else if (tok.startsWith('[color')) push(tok.replace(/^\[color=#[0-9a-fA-F]{6}\]/, '').replace(/\[\/color\]$/, ''), { color: m[2] });
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
      .replace(/\*([^*\n]+?)\*/g, '$1')
      .replace(/\[size=\d{1,3}\]([\s\S]+?)\[\/size\]/g, '$1')
      .replace(/\[color=#[0-9a-fA-F]{6}\]([\s\S]+?)\[\/color\]/g, '$1');
  }

  // توکن‌های کلمه‌ای با استایل چسبیده؛ فاصله‌های چندتایی مثل wrapWords قدیمی به یک فاصله تقلیل می‌یابند
  function wordsFromRuns(runs) {
    const words = [];
    let pendingSpace = false, pendingLineBreak = false;
    runs.forEach((run) => {
      run.t.split(/(\s+)/).filter(Boolean).forEach((part) => {
        if (/^\s+$/.test(part)) {
          if (part.includes('\n')) { pendingLineBreak = true; pendingSpace = false; }
          else if (!pendingLineBreak) pendingSpace = true;
          return;
        }
        words.push({
          t: part, bold: run.bold ? true : undefined, italic: run.italic ? true : undefined, underline: !!run.underline,
          size: run.size || null, color: run.color || null, spaceBefore: pendingSpace, lineBreakBefore: pendingLineBreak
        });
        pendingSpace = false; pendingLineBreak = false;
      });
    });
    return words;
  }
  function inlineWords(text) { return wordsFromRuns(tokenizeInline(text)); }
  function plainWords(text) { return wordsFromRuns([{ t: String(text || '') }]); }

  // محتوای ویرایشگر غنی را به کلمه‌های امن با استایل محاسبه‌شده تبدیل می‌کند.
  // مارکرهای قدیمی هم از همان مسیر قدیمی پشتیبانی می‌شوند.
  function richHtmlWords(html) {
    if (!html || typeof document === 'undefined') return [];
    const root = document.createElement('div');
    root.innerHTML = html;
    const words = [];
    let pendingLineBreak = false, pendingSpace = false;
    const walk = (node, inherited = {}, list = null) => {
      if (node.nodeType === 3) {
        String(node.nodeValue || '').split(/(\s+)/).filter(Boolean).forEach((part) => {
          if (/^\s+$/.test(part)) {
            if (part.includes('\n')) { pendingLineBreak = true; pendingSpace = false; }
            else if (!pendingLineBreak) pendingSpace = true;
            return;
          }
          words.push({ t: part, ...inherited, spaceBefore: pendingSpace, lineBreakBefore: pendingLineBreak });
          pendingSpace = false; pendingLineBreak = false;
        });
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.tagName.toLowerCase();
      if (tag === 'br') {
        // Consecutive explicit breaks represent real empty lines, not a single break.
        if (pendingLineBreak) words.push({ t: '', ...inherited, spaceBefore: false, lineBreakBefore: true });
        pendingLineBreak = true; pendingSpace = false; return;
      }
      const isBlock = ['div', 'p', 'li'].includes(tag);
      if (isBlock && words.length) { pendingLineBreak = true; pendingSpace = false; }
      const style = node.style || {};
      const next = { ...inherited };
      if (isBlock && ['left', 'center', 'right', 'justify'].includes(style.textAlign)) next.lineAlign = style.textAlign;
      const direction = style.direction || node.getAttribute('dir');
      if (isBlock && (direction === 'ltr' || direction === 'rtl')) next.lineDir = direction;
      if (tag === 'b' || tag === 'strong') next.bold = true;
      if (tag === 'i' || tag === 'em') next.italic = true;
      if (tag === 'u') next.underline = true;
      if (tag === 's' || tag === 'strike' || tag === 'del') next.strike = true;
      if (style.fontWeight === 'bold' || Number(style.fontWeight) >= 600) next.bold = true;
      else if (style.fontWeight === 'normal' || style.fontWeight === '400') next.bold = false;
      if (style.fontStyle === 'italic') next.italic = true;
      else if (style.fontStyle === 'normal') next.italic = false;
      const decoration = style.textDecorationLine || style.textDecoration || '';
      if (decoration.includes('underline')) next.underline = true;
      if (decoration.includes('line-through')) next.strike = true;
      const size = Number.parseFloat(style.fontSize);
      if (Number.isFinite(size)) next.size = Math.max(8, Math.min(160, size));
      if (style.color) next.color = style.color;
      if (isBlock && !String(node.textContent || '').trim() && !node.querySelector('img')) {
        words.push({ t: '', ...next, spaceBefore: false, lineBreakBefore: words.length > 0 });
        pendingLineBreak = true; pendingSpace = false; return;
      }
      if (tag === 'li' && list) {
        const marker = list.ordered ? `${list.next++}.` : '•';
        words.push({ t: marker, ...next, spaceBefore: false, lineBreakBefore: pendingLineBreak });
        pendingLineBreak = false; pendingSpace = true;
      }
      const childList = tag === 'ol' || tag === 'ul' ? { ordered: tag === 'ol', next: 1 } : list;
      [...node.childNodes].forEach((child) => walk(child, next, childList));
      if (isBlock && words.length) pendingLineBreak = true;
    };
    [...root.childNodes].forEach((node) => walk(node));
    return words;
  }

  // پیشوند فونت یک کلمه = پیش‌فرض بلوک + قالب‌بندی صریح همان قطعه
  function inlineFontPrefix(st, w) {
    const weight = typeof w.bold === 'boolean' ? w.bold : st.bold !== false;
    const italic = typeof w.italic === 'boolean' ? w.italic : st.italic;
    return `${italic ? 'italic ' : ''}${weight ? '700' : '400'} `;
  }
  const baseFontPrefix = (st) => `${st.italic ? 'italic ' : ''}${st.bold !== false ? '700' : '400'} `;

  // اندازهٔ مؤثر یک کلمه: اندازهٔ درون‌متنی نسبت به مرجع بلوک، روی سایز پایه مقیاس می‌خورد
  function effWordSize(w, baseSize, st) {
    if (!w.size) return baseSize;
    const ref = st.size || baseSize;
    return Math.max(8, Math.min(160, Math.round(baseSize * w.size / ref)));
  }

  // عرض هر کلمه با فونت خودش + عرض فاصله با فونت پایهٔ بلوک
  function measureLine(ctx, line, st, size) {
    const baseFont = `${baseFontPrefix(st)}${size}px ${FONT}`;
    ctx.font = baseFont;
    const spaceW = ctx.measureText(' ').width;
    const widths = line.map((w) => {
      ctx.font = `${inlineFontPrefix(st, w)}${effWordSize(w, size, st)}px ${FONT}`;
      return ctx.measureText(w.t).width;
    });
    ctx.font = baseFont;
    const width = widths.reduce((sum, v, i) => sum + v + (i && line[i].spaceBefore !== false ? spaceW : 0), 0);
    return { widths, spaceW, width };
  }

  // شکستن خط با اندازهٔ مشخص؛ هر کلمه با فونت خودش اندازه می‌شود
  function wrapInlineAt(ctx, words, maxW, st, size) {
    const baseFont = `${baseFontPrefix(st)}${size}px ${FONT}`;
    ctx.font = baseFont;
    const spaceW = ctx.measureText(' ').width;
    const widthOf = (w) => {
      ctx.font = `${inlineFontPrefix(st, w)}${effWordSize(w, size, st)}px ${FONT}`;
      return ctx.measureText(w.t).width;
    };
    const lines = [];
    let cur = [], curW = 0;
    for (const w of words) {
      if (w.lineBreakBefore && cur.length) { lines.push(cur); cur = []; curW = 0; }
      const ww = widthOf(w);
      if (!cur.length) { cur = [w]; curW = ww; }
      else {
        const gap = w.spaceBefore === false ? 0 : spaceW;
        if (curW + gap + ww <= maxW) { cur.push(w); curW += gap + ww; }
        else { lines.push(cur); cur = [w]; curW = ww; }
      }
    }
    if (cur.length) lines.push(cur);
    ctx.font = baseFont;
    return lines;
  }

  // ارتفاع خط بر اساس بلندترین کلمهٔ همان خط (اندازه‌های درون‌متنی متفاوت)
  function lineHeightsFor(lines, st, size) {
    return lines.map((line) => Math.max(...line.map((w) => effWordSize(w, size, st))) * 1.55);
  }

  // معادل fit برای متن‌های دارای مارکر؛ بهترین اندازه‌ای که همهٔ خطوط در کادر جا شوند
  function fitInline(ctx, text, boxW, boxH, maxSize, minSize, st) {
    const words = Array.isArray(text) ? text : inlineWords(text);
    for (let s = maxSize; s >= minSize; s--) {
      const lines = wrapInlineAt(ctx, words, boxW, st, s);
      const widest = Math.max(...lines.map((ln) => measureLine(ctx, ln, st, s).width));
      const lhList = lineHeightsFor(lines, st, s);
      const totalH = lhList.reduce((sum, v) => sum + v, 0);
      if (totalH <= boxH && widest <= boxW * 1.04) {
        return { size: s, lines, lh: s * 1.55, lineLh: lhList };
      }
    }
    const lines = wrapInlineAt(ctx, words, boxW, st, minSize);
    return { size: minSize, lines, lh: minSize * 1.55, lineLh: lineHeightsFor(lines, st, minSize) };
  }

  function fit(ctx, text, boxW, boxH, maxSize, minSize, fontPrefix = '700 ') {
    for (let s = maxSize; s >= minSize; s--) {
      ctx.font = `${fontPrefix}${s}px ${FONT}`;
      const lines = wrapWords(ctx, text, boxW);
      const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
      const lh = s * 1.55;
      if (lines.length * lh <= boxH && widest <= boxW * 1.04) return { size: s, lines, lh };
    }
    ctx.font = `${fontPrefix}${minSize}px ${FONT}`;
    return { size: minSize, lines: wrapWords(ctx, text, boxW), lh: minSize * 1.55 };
  }

  // قالب‌بندی هر بلوک با پیش‌فرض‌های ایمن برای بلوک‌های قدیمی (ذخیره‌شده قبل از نسخهٔ ۲.۲۸)
  function blockStyle(b) {
    return {
      dir: b.dir === 'ltr' ? 'ltr' : 'rtl',       // جهت متن: پیش‌فرض راست‌به‌چپ
      align: ['center', 'left', 'justify'].includes(b.align) ? b.align : 'right', // physical alignment; old projects default right
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
    // Paint in three phases so no later erasure/background can hide an earlier translation.
    const sourceFills = [], targetFills = [], textJobs = [];

    blocks.forEach((b) => {
      if (!b.enabled || !b.tr || !b.tr.trim()) return;
      const st = blockStyle(b);
      const fontPrefix = `${st.italic ? 'italic ' : ''}${st.bold ? '700' : '400'} `;
      const pad = Math.max(4, Math.round(b.lineH * 0.3));
      // محدودهٔ پاک‌کردن متن اصلی و محدودهٔ چیدمان ترجمه جدا هستند تا تغییر اندازهٔ کادر، تصویر اطراف را پاک نکند.
      const box = {
        x0: Math.max(0, b.x0 - pad), y0: Math.max(0, b.y0 - pad),
        x1: Math.min(W, b.x1 + pad), y1: Math.min(H, b.y1 + pad)
      };
      const layoutBox = {
        x0: Math.max(0, Number.isFinite(b.tx0) ? b.tx0 : b.x0),
        y0: Math.max(0, Number.isFinite(b.ty0) ? b.ty0 : b.y0),
        x1: Math.min(W, Number.isFinite(b.tx1) ? b.tx1 : b.x1),
        y1: Math.min(H, Number.isFinite(b.ty1) ? b.ty1 : b.y1)
      };
      const bw = layoutBox.x1 - layoutBox.x0, bh = layoutBox.y1 - layoutBox.y0;

      let sourceFill = null, targetFill = null, txt = '#0b0b0b', stroke = null;
      if (b.bg === 'none') {
        txt = '#ffffff'; stroke = '#000000';
      } else if (b.bg === 'white') { sourceFill = targetFill = '#ffffff'; }
      else if (b.bg === 'black') { sourceFill = targetFill = '#000000'; txt = '#fafafa'; }
      else {
        // هر دو محل را قبل از هرگونه پاک‌کردن نمونه‌برداری کن: محل OCR و کل سطح زیر کادر نهایی.
        const sourceBg = sampleBg(ctx, box, W, H);
        const targetBg = sampleBg(ctx, layoutBox, W, H);
        sourceFill = `rgb(${sourceBg.r},${sourceBg.g},${sourceBg.b})`;
        targetFill = `rgb(${targetBg.r},${targetBg.g},${targetBg.b})`;
        txt = lum(targetBg.r, targetBg.g, targetBg.b) > 150 ? '#0b0b0b' : '#fafafa';
      }
      // رنگ دستی کاربر بر انتخاب خودکار اولویت دارد (زیرخط هم با همین رنگ رسم می‌شود)
      if (st.color) txt = st.color;
      if (sourceFill) sourceFills.push([sourceFill, box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0]);
      if (targetFill) targetFills.push([targetFill, layoutBox.x0, layoutBox.y0, bw, bh]);

      const maxSize = Math.max(12, Math.min(64, Math.round(b.lineH * 1.1)));
      const sourceText = b.tr.trim();
      // Justified text uses word runs too, even for plain OCR; literal OCR markers remain literal.
      const inline = st.align === 'justify' || (!b._plainText && (!!b.richHtml || hasInlineMarks(sourceText)));
      // سایز دستی کاربر جای حالت خودکار می‌نشیند؛ در غیر این صورت بهترین سایز برای جاشدن در کادر
      let f;
      if (inline) {
        const inWords = b._plainText ? plainWords(sourceText) : (b.richHtml ? richHtmlWords(b.richHtml) : inlineWords(sourceText));
        if (st.size) {
          const lines = wrapInlineAt(ctx, inWords, bw * 0.96, st, st.size);
          f = { size: st.size, lines, lh: st.size * 1.55, lineLh: lineHeightsFor(lines, st, st.size) };
        } else {
          f = fitInline(ctx, inWords, bw * 0.96, bh * 0.96, maxSize, 8, st);
        }
      } else if (st.size) {
        ctx.font = `${fontPrefix}${st.size}px ${FONT}`;
        f = { size: st.size, lines: wrapWords(ctx, sourceText, bw * 0.96), lh: st.size * 1.55 };
      } else {
        f = fit(ctx, sourceText, bw * 0.96, bh * 0.96, maxSize, 8, fontPrefix);
      }
      textJobs.push(() => {
      // Keep the actual output inside the editable translation box, even for manually enlarged text.
      ctx.save();
      ctx.beginPath();
      ctx.rect(layoutBox.x0, layoutBox.y0, bw, bh);
      ctx.clip();
      if ('direction' in ctx) ctx.direction = st.dir;
      ctx.textBaseline = 'middle';
      const totalH = inline ? f.lineLh.reduce((sum, v) => sum + v, 0) : f.lines.length * f.lh;
      let y = (layoutBox.y0 + layoutBox.y1) / 2 - totalH / 2 + (inline ? f.lineLh[0] : f.lh) / 2;
      // لنگر هر خط بر اساس چیدمان انتخابی، با حاشیهٔ کوچک از لبهٔ کادر
      const anchorX = st.align === 'left' || (st.align === 'justify' && st.dir === 'ltr') ? layoutBox.x0 + bw * 0.02
        : st.align === 'center' ? (layoutBox.x0 + layoutBox.x1) / 2
        : layoutBox.x1 - bw * 0.02;
      if (inline) {
        // مسیر درون‌متنی: هر کلمه با فونت، اندازه و رنگ خودش و در موقعیت فیزیکی محاسبه‌شده رسم می‌شود
        ctx.textAlign = 'left';
        f.lines.forEach((line, li) => {
          const m = measureLine(ctx, line, st, f.size);
          const lineAlign = line[0]?.lineAlign || st.align; const lineDir = line[0]?.lineDir || st.dir;
          if ('direction' in ctx) ctx.direction = lineDir;
          const lineAnchor = lineAlign === 'left' || (lineAlign === 'justify' && lineDir === 'ltr') ? layoutBox.x0 + bw * 0.02
            : lineAlign === 'center' ? (layoutBox.x0 + layoutBox.x1) / 2 : layoutBox.x1 - bw * 0.02;
          const leftAligned = lineAlign === 'left' || (lineAlign === 'justify' && lineDir === 'ltr');
          const gapCount = line.slice(1).filter((word) => word.spaceBefore !== false).length;
          // Do not stretch the last line of a paragraph, explicit line breaks, or single-word lines.
          const nextLine = f.lines[li + 1];
          const justify = lineAlign === 'justify' && nextLine && !nextLine[0].lineBreakBefore && gapCount > 0;
          const extraGap = justify ? Math.max(0, bw * 0.96 - m.width) / gapCount : 0;
          const paintedWidth = m.width + extraGap * gapCount;
          let x = leftAligned ? lineAnchor
            : lineAlign === 'center' ? lineAnchor - paintedWidth / 2
            : lineAnchor - paintedWidth;
          // در پاراگراف RTL اولین کلمهٔ منطقی سمت راست است؛ پس ترتیب دیداری برعکس می‌شود
          const visual = lineDir === 'rtl' ? line.map((_, i) => line.length - 1 - i) : line.map((_, i) => i);
          visual.forEach((idx) => {
            const w = line[idx];
            const wSize = effWordSize(w, f.size, st);
            ctx.font = `${inlineFontPrefix(st, w)}${wSize}px ${FONT}`;
            const wColor = w.color || txt;
            if (stroke) { ctx.lineWidth = Math.max(3, wSize / 5); ctx.strokeStyle = stroke; ctx.lineJoin = 'round'; ctx.strokeText(w.t, x, y); }
            ctx.fillStyle = wColor;
            ctx.fillText(w.t, x, y);
            if (st.underline || w.underline) {
              ctx.strokeStyle = wColor;
              ctx.lineWidth = Math.max(1, wSize / 14);
              ctx.beginPath();
              ctx.moveTo(x, y + wSize * 0.55);
              ctx.lineTo(x + m.widths[idx], y + wSize * 0.55);
              ctx.stroke();
            }
            if (w.strike) {
              ctx.strokeStyle = wColor;
              ctx.lineWidth = Math.max(1, wSize / 14);
              ctx.beginPath();
              ctx.moveTo(x, y - wSize * 0.2);
              ctx.lineTo(x + m.widths[idx], y - wSize * 0.2);
              ctx.stroke();
            }
            const hasGapAfter = lineDir === 'rtl'
              ? (idx > 0 && line[idx].spaceBefore !== false)
              : (idx + 1 < line.length && line[idx + 1].spaceBefore !== false);
            const gapAfter = hasGapAfter ? m.spaceW + extraGap : 0;
            x += m.widths[idx] + gapAfter;
          });
          y += f.lineLh[li];
        });
        ctx.restore();
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
      ctx.restore();
      });
    });
    const paintRect = ([style, x, y, width, height]) => { ctx.fillStyle = style; ctx.fillRect(x, y, width, height); };
    sourceFills.forEach(paintRect);
    targetFills.forEach(paintRect);
    textJobs.forEach((paintText) => paintText());
    return cv;
  }

  const api = {
    render, sampleBg, fit, wrapWords, blockStyle,
    hasInlineMarks, tokenizeInline, stripInlineMarkers, inlineWords, richHtmlWords, fitInline
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Typeset = api;
})(typeof window !== 'undefined' ? window : globalThis);
