// جای‌گذاری متن فارسی روی تصویر (پاک کردن متن قدیمی + نوشتن ترجمه)
(function (root) {
  const FONT = 'Vazirmatn, Tahoma, sans-serif';

  function median(arr) { arr.sort((a, b) => a - b); return arr[Math.floor(arr.length / 2)]; }
  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  // حاشیهٔ هوشمند داخلی کادر: ۲ درصدِ بُعد کادر با سقف حداکثر ۴ پیکسل تا در پاراگراف‌های
  // بزرگ و چندخطی فضای اضافی هدر نرود و در حباب‌های باریک نیز جای متن تنگ نشود.
  function boxInset(dim) {
    const n = Number(dim);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(4, n * 0.02);
  }

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
    const Ls = [];
    for (let i = 0; i < R.length; i += 3) Ls.push(lum(R[i], G[i], B[i]));
    const r = median(R), g = median(G), b = median(B);
    let s = 0; const L = lum(r, g, b);
    for (let i = 0; i < Ls.length; i++) { const d = Ls[i] - L; s += d * d; }
    return { r, g, b, uniform: Math.sqrt(s / Ls.length) < 28 };
  }

  function splitParagraphWords(text) {
    return String(text || '').replace(/\r\n?/g, '\n').split('\n').map((p) => p.split(/\s+/).filter(Boolean));
  }

  function wrapParagraphWords(ctx, paragraphs, maxW) {
    const lines = [];
    let widest = 0;
    // Explicit newlines are paragraph boundaries, including intentionally blank lines.
    for (const words of paragraphs) {
      let cur = '', curW = -1;
      for (const w of words) {
        if (!cur) { cur = w; curW = -1; continue; }
        const t = cur + ' ' + w;
        const tw = ctx.measureText(t).width;
        if (tw <= maxW) { cur = t; curW = tw; }
        else {
          const lw = curW >= 0 ? curW : ctx.measureText(cur).width;
          if (lw > widest) widest = lw;
          lines.push(cur); cur = w; curW = -1;
        }
      }
      const lw = cur ? (curW >= 0 ? curW : ctx.measureText(cur).width) : 0;
      if (lw > widest) widest = lw;
      lines.push(cur);
    }
    return { lines, widest };
  }

  function wrapWords(ctx, text, maxW) {
    return wrapParagraphWords(ctx, splitParagraphWords(text), maxW).lines;
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

  function escapeInlineHtml(value) {
    return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function inlineMarksToHtml(text) {
    return tokenizeInline(String(text || '')).map((run) => {
      let html = escapeInlineHtml(run.t).replace(/\n/g, '<br>');
      if (run.bold) html = `<b>${html}</b>`;
      if (run.italic) html = `<i>${html}</i>`;
      if (run.underline) html = `<u>${html}</u>`;
      const styles = [];
      if (run.size) styles.push(`font-size:${Math.max(8, Math.min(160, Math.round(run.size)))}px`);
      if (run.color) styles.push(`color:${run.color}`);
      if (styles.length) html = `<span style="${styles.join(';')}">${html}</span>`;
      return html;
    }).join('');
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
          if (part.includes('\n')) {
            const breaks = (part.match(/\n/g) || []).length;
            for (let index = 0; index < breaks; index++) {
              if (pendingLineBreak) words.push({ t: '', spaceBefore: false, lineBreakBefore: true });
              pendingLineBreak = true;
            }
            pendingSpace = false;
          } else if (!pendingLineBreak) pendingSpace = true;
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
    const root = document.createElement('template');
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
      if (['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math'].includes(tag)) return;
      // Canvas export has no DOM or clickable links. Show an explicit placeholder
      // for images and a textual approximation of tables and separators.
      if (tag === 'img') { const label = node.getAttribute('alt')?.trim() || 'تصویر'; words.push({ t: `[${label}]`, ...inherited, spaceBefore: pendingSpace, lineBreakBefore: pendingLineBreak }); pendingSpace = false; pendingLineBreak = false; return; }
      if (tag === 'hr') { if (words.length) pendingLineBreak = true; words.push({ t: node.hasAttribute('data-readmore') ? '[ادامه مطلب]' : '────────', ...inherited, spaceBefore: false, lineBreakBefore: pendingLineBreak }); pendingLineBreak = true; pendingSpace = false; return; }
      if ((tag === 'td' || tag === 'th') && node.previousElementSibling) { words.push({ t: '|', ...inherited, spaceBefore: true, lineBreakBefore: pendingLineBreak }); pendingLineBreak = false; pendingSpace = true; }
      if (tag === 'br') {
        // Consecutive explicit breaks represent real empty lines, not a single break.
        if (pendingLineBreak) words.push({ t: '', ...inherited, spaceBefore: false, lineBreakBefore: true });
        pendingLineBreak = true; pendingSpace = false; return;
      }
      const isBlock = ['div', 'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'blockquote', 'tr'].includes(tag);
      if (isBlock && words.length) { pendingLineBreak = true; pendingSpace = false; }
      const style = node.style || {};
      const next = { ...inherited };
      if (isBlock && ['left', 'center', 'right', 'justify'].includes(style.textAlign)) next.lineAlign = style.textAlign;
      const direction = style.direction || node.getAttribute('dir');
      if (isBlock && (direction === 'ltr' || direction === 'rtl')) next.lineDir = direction;
      if (tag === 'b' || tag === 'strong' || /^h[1-6]$/.test(tag) || tag === 'th') next.bold = true;
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
    [...root.content.childNodes].forEach((node) => walk(node));
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
    let curFont = baseFont;
    ctx.font = baseFont;
    const spaceW = ctx.measureText(' ').width;
    const widths = line.map((w) => {
      const nextFont = `${inlineFontPrefix(st, w)}${effWordSize(w, size, st)}px ${FONT}`;
      if (nextFont !== curFont) { curFont = nextFont; ctx.font = nextFont; }
      return ctx.measureText(w.t).width;
    });
    if (curFont !== baseFont) ctx.font = baseFont;
    const width = widths.reduce((sum, v, i) => sum + v + (i && line[i].spaceBefore !== false ? spaceW : 0), 0);
    return { widths, spaceW, width };
  }

  const RTL_CHAR_RE = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/;
  const LTR_CHAR_RE = /[A-Za-z\u00c0-\u02af\u0370-\u052f]/;
  function visualLineOrder(line, lineDir) {
    const n = line.length;
    if (!n) return [];
    if (lineDir !== 'rtl') {
      const runs = [];
      for (let i = 0; i < n;) {
        if (RTL_CHAR_RE.test(line[i].t) && !LTR_CHAR_RE.test(line[i].t)) {
          let j = i + 1;
          while (j < n && RTL_CHAR_RE.test(line[j].t) && !LTR_CHAR_RE.test(line[j].t)) j += 1;
          runs.push({ start: i, end: j - 1, rev: true });
          i = j;
        } else {
          runs.push({ start: i, end: i, rev: false });
          i += 1;
        }
      }
      const out = [];
      runs.forEach((run, ri) => {
        const indices = [];
        for (let k = run.start; k <= run.end; k += 1) indices.push(k);
        if (run.rev) indices.reverse();
        indices.forEach((idx, pos) => {
          const hasGapAfter = pos + 1 < indices.length
            ? (run.rev ? line[idx].spaceBefore !== false : line[idx + 1].spaceBefore !== false)
            : (ri + 1 < runs.length && line[runs[ri + 1].start].spaceBefore !== false);
          out.push({ idx, hasGapAfter });
        });
      });
      return out;
    }
    const runs = [];
    for (let i = 0; i < n;) {
      if (LTR_CHAR_RE.test(line[i].t) && !RTL_CHAR_RE.test(line[i].t)) {
        let j = i + 1;
        while (j < n && !RTL_CHAR_RE.test(line[j].t) && (LTR_CHAR_RE.test(line[j].t) || /\d/.test(line[j].t))) j += 1;
        runs.push({ start: i, end: j - 1, ltr: true });
        i = j;
      } else {
        runs.push({ start: i, end: i, ltr: false });
        i += 1;
      }
    }
    const out = [];
    for (let ri = runs.length - 1; ri >= 0; ri -= 1) {
      const run = runs[ri];
      const indices = [];
      for (let k = run.start; k <= run.end; k += 1) indices.push(k);
      if (!run.ltr) indices.reverse();
      indices.forEach((idx, pos) => {
        const hasGapAfter = pos + 1 < indices.length
          ? (run.ltr ? line[idx + 1].spaceBefore !== false : line[idx].spaceBefore !== false)
          : (ri > 0 && line[run.start].spaceBefore !== false);
        out.push({ idx, hasGapAfter });
      });
    }
    return out;
  }

  function wrapInlineMeasured(ctx, words, maxW, st, size) {
    const baseFont = `${baseFontPrefix(st)}${size}px ${FONT}`;
    let curFont = baseFont;
    ctx.font = baseFont;
    const spaceW = ctx.measureText(' ').width;
    const widthOf = (w) => {
      const nextFont = `${inlineFontPrefix(st, w)}${effWordSize(w, size, st)}px ${FONT}`;
      if (nextFont !== curFont) { curFont = nextFont; ctx.font = nextFont; }
      return ctx.measureText(w.t).width;
    };
    const lines = [];
    let cur = [], curW = 0, widest = -Infinity;
    for (const w of words) {
      if (w.lineBreakBefore && cur.length) { if (curW > widest) widest = curW; lines.push(cur); cur = []; curW = 0; }
      const ww = widthOf(w);
      if (!cur.length) { cur = [w]; curW = ww; }
      else {
        const gap = w.spaceBefore === false ? 0 : spaceW;
        if (curW + gap + ww <= maxW) { cur.push(w); curW = curW + ww + gap; }
        else { if (curW > widest) widest = curW; lines.push(cur); cur = [w]; curW = ww; }
      }
    }
    if (cur.length) { if (curW > widest) widest = curW; lines.push(cur); }
    if (curFont !== baseFont) ctx.font = baseFont;
    return { lines, widest };
  }

  // شکستن خط با اندازهٔ مشخص؛ هر کلمه با فونت خودش اندازه می‌شود
  function wrapInlineAt(ctx, words, maxW, st, size) {
    return wrapInlineMeasured(ctx, words, maxW, st, size).lines;
  }

  // ارتفاع خط بر اساس بلندترین کلمهٔ همان خط (اندازه‌های درون‌متنی متفاوت)
  function lineHeightsFor(lines, st, size) {
    return lines.map((line) => Math.max(...line.map((w) => effWordSize(w, size, st))) * 1.55);
  }

  // معادل fit برای متن‌های دارای مارکر؛ بهترین اندازه‌ای که همهٔ خطوط در کادر جا شوند
  function fitInline(ctx, text, boxW, boxH, maxSize, minSize, st) {
    const words = Array.isArray(text) ? text : inlineWords(text);
    for (let s = maxSize; s >= minSize; s--) {
      const { lines, widest } = wrapInlineMeasured(ctx, words, boxW, st, s);
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
    const paragraphs = splitParagraphWords(text);
    for (let s = maxSize; s >= minSize; s--) {
      ctx.font = `${fontPrefix}${s}px ${FONT}`;
      const { lines, widest } = wrapParagraphWords(ctx, paragraphs, boxW);
      const lh = s * 1.55;
      if (lines.length * lh <= boxH && widest <= boxW * 1.04) return { size: s, lines, lh };
    }
    ctx.font = `${fontPrefix}${minSize}px ${FONT}`;
    return { size: minSize, lines: wrapParagraphWords(ctx, paragraphs, boxW).lines, lh: minSize * 1.55 };
  }

  // قالب‌بندی هر بلوک با پیش‌فرض‌های ایمن برای بلوک‌های قدیمی (ذخیره‌شده قبل از نسخهٔ ۲.۲۸)
  function blockStyle(b) {
    return {
      dir: b.dir === 'ltr' ? 'ltr' : 'rtl',       // جهت متن: پیش‌فرض راست‌به‌چپ
      align: ['center', 'left', 'justify'].includes(b.align) ? b.align : 'right', // physical alignment; old projects default right
      verticalAlign: ['top', 'bottom'].includes(b.verticalAlign) ? b.verticalAlign : 'middle', // old projects keep their centred layout
      bold: b.bold !== false,           // پیش‌فرض مثل گذشته: پررنگ
      italic: !!b.italic,
      underline: !!b.underline,
      size: Number.isFinite(+b.size) && +b.size > 0 ? +b.size : null,
      color: /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : null // null = رنگ خودکار بر اساس پس‌زمینه
    };
  }

  let domMeasureState = null;
  function getDomMeasureBox() {
    if (typeof window === 'undefined' || typeof document === 'undefined' || !document.body || typeof document.createRange !== 'function') return null;
    if (domMeasureState && domMeasureState.host.isConnected) return domMeasureState.supported ? domMeasureState.box : null;
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.dataset.typesetMeasure = '1';
    host.style.cssText = 'position:fixed;left:-100000px;top:0;width:0;height:0;overflow:visible;visibility:hidden;pointer-events:none;z-index:-1;';
    const styleEl = document.createElement('style');
    styleEl.textContent = '[data-typeset-box] p,[data-typeset-box] div,[data-typeset-box] h1,[data-typeset-box] h2,[data-typeset-box] h3,[data-typeset-box] h4,[data-typeset-box] h5,[data-typeset-box] h6,[data-typeset-box] blockquote,[data-typeset-box] pre{margin:0;padding:0;font-size:inherit}';
    const box = document.createElement('div');
    box.dataset.typesetBox = '1';
    host.append(styleEl, box);
    document.body.appendChild(host);
    box.style.cssText = `position:absolute;left:0;top:0;font:700 12px/1.55 ${FONT};white-space:nowrap;`;
    box.textContent = 'ا';
    const probeRange = document.createRange();
    probeRange.selectNodeContents(box);
    const supported = (probeRange.getBoundingClientRect?.()?.width || 0) > 0;
    box.textContent = '';
    domMeasureState = { host, box, supported };
    return supported ? box : null;
  }

  function hasSpecialRichElements(html) {
    return !!html && /<(img|hr|table|ul|ol|li)\b/i.test(String(html));
  }

  function blockRawLayoutHtml(b) {
    if (b._plainText) return escapeInlineHtml(String(b.tr || '')).replace(/\r\n?/g, '\n').replace(/\n/g, '<br>');
    if (typeof b._liveHtml === 'string') return b._liveHtml;
    if (b.richHtml) return String(b.richHtml);
    const src = String(b.tr || '');
    if (hasInlineMarks(src)) return inlineMarksToHtml(src);
    return escapeInlineHtml(src).replace(/\r\n?/g, '\n').replace(/\n/g, '<br>');
  }

  function buildSafeDomTemplate(rawHtml) {
    const clean = root.ComicSanitize?.sanitize ? root.ComicSanitize.sanitize(rawHtml) : rawHtml;
    const tpl = document.createElement('template');
    tpl.innerHTML = clean;
    tpl.content.querySelectorAll('script,style,iframe,object,embed,svg,math,img,video,audio,link,meta').forEach((el) => el.remove());
    tpl.content.querySelectorAll('*').forEach((el) => {
      [...el.attributes].forEach((attr) => {
        const name = attr.name.toLowerCase();
        if (name === 'style') return;
        if (name === 'dir' && (attr.value === 'ltr' || attr.value === 'rtl')) return;
        el.removeAttribute(attr.name);
      });
      const fs = Number.parseFloat(el.style?.fontSize || '');
      if (Number.isFinite(fs) && fs > 0) el.dataset.logicalSize = String(Math.max(8, Math.min(160, Math.round(fs))));
    });
    return tpl;
  }

  function applyDomLayoutStyles(box, tpl, st, bw, padX, size) {
    box.replaceChildren(tpl.content.cloneNode(true));
    box.dir = st.dir;
    box.style.cssText = [
      'position:absolute', 'left:0', 'top:0', 'box-sizing:border-box',
      `width:${bw}px`, `padding:0px ${padX}px`, 'margin:0', 'border:0',
      `font-family:${FONT}`, `font-size:${size}px`, 'line-height:1.55',
      `font-weight:${st.bold ? '700' : '400'}`, `font-style:${st.italic ? 'italic' : 'normal'}`,
      'white-space:pre-line', 'text-justify:inter-word',
      'overflow-wrap:normal', 'word-break:normal',
      'letter-spacing:0px', 'word-spacing:0px', 'font-kerning:auto',
      `direction:${st.dir}`, `text-align:${st.align}`
    ].join(';');
    const ref = st.size || size;
    box.querySelectorAll('[data-logical-size]').forEach((el) => {
      const logical = Number.parseFloat(el.dataset.logicalSize || '');
      if (!Number.isFinite(logical) || logical <= 0) return;
      el.style.fontSize = `${Math.max(8, Math.min(160, Math.round(size * logical / ref)))}px`;
    });
  }

  function computeJsFit(ctx, b, st, bw, bh, richWordsOpt = null) {
    const padX = boxInset(bw), padY = boxInset(bh);
    const usableW = Math.max(1, bw - 2 * padX), usableH = Math.max(1, bh - 2 * padY);
    const sourceText = String(b.tr || '').trim();
    const richWords = richWordsOpt !== null ? richWordsOpt : (!b._plainText && b.richHtml ? richHtmlWords(b.richHtml) : null);
    const maxSize = Math.max(12, Math.min(64, Math.round(b.lineH * 1.1)));
    const inline = st.align === 'justify' || (!b._plainText && (!!b.richHtml || hasInlineMarks(sourceText)));
    const fontPrefix = `${st.italic ? 'italic ' : ''}${st.bold ? '700' : '400'} `;
    if (inline) {
      const inWords = b._plainText ? plainWords(sourceText) : (richWords || inlineWords(sourceText));
      if (st.size) {
        const lines = wrapInlineAt(ctx, inWords, usableW, st, st.size);
        return { inline: true, size: st.size, lines, lh: st.size * 1.55, lineLh: lineHeightsFor(lines, st, st.size) };
      }
      return Object.assign({ inline: true }, fitInline(ctx, inWords, usableW, usableH, maxSize, 7, st));
    }
    if (st.size) {
      ctx.font = `${fontPrefix}${st.size}px ${FONT}`;
      return { inline: false, size: st.size, lines: wrapWords(ctx, sourceText, usableW), lh: st.size * 1.55 };
    }
    return Object.assign({ inline: false }, fit(ctx, sourceText, usableW, usableH, maxSize, 7, fontPrefix));
  }

  function resolveDomNodeStyle(node, rootBox, st, baseSize) {
    let bold = st.bold !== false, italic = !!st.italic, underline = !!st.underline, strike = false;
    let size = baseSize, color = null, dir = st.dir;
    const chain = [];
    let cur = node?.parentElement;
    while (cur && cur !== rootBox) { chain.unshift(cur); cur = cur.parentElement; }
    chain.forEach((el) => {
      const tag = el.tagName;
      if (['B', 'STRONG', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TH'].includes(tag)) bold = true;
      if (tag === 'I' || tag === 'EM') italic = true;
      if (tag === 'U') underline = true;
      if (['S', 'STRIKE', 'DEL'].includes(tag)) strike = true;
      const fw = el.style?.fontWeight || '';
      if (fw === 'bold' || Number(fw) >= 600) bold = true;
      else if (fw === 'normal' || fw === '400') bold = false;
      if (el.style?.fontStyle === 'italic') italic = true;
      else if (el.style?.fontStyle === 'normal') italic = false;
      const deco = el.style?.textDecorationLine || el.style?.textDecoration || '';
      if (deco.includes('underline')) underline = true;
      if (deco.includes('line-through')) strike = true;
      const fs = Number.parseFloat(el.style?.fontSize || '');
      if (Number.isFinite(fs) && fs > 0) size = fs;
      if (el.style?.color) color = el.style.color;
      const d = el.style?.direction || el.getAttribute('dir');
      if (d === 'ltr' || d === 'rtl') dir = d;
    });
    return { bold, italic, underline, strike, size, color, dir };
  }

  function domLayoutBlock(ctx, b, st, bw, bh, richWordsOpt = null) {
    const rawHtml = blockRawLayoutHtml(b);
    if (hasSpecialRichElements(rawHtml)) return null;
    const box = getDomMeasureBox();
    if (!box) return null;
    const padX = boxInset(bw), padY = boxInset(bh);
    const usableW = Math.max(1, bw - 2 * padX), usableH = Math.max(1, bh - 2 * padY);
    const tpl = buildSafeDomTemplate(rawHtml);
    let size = st.size;
    if (!size) {
      const maxSize = Math.max(12, Math.min(64, Math.round(b.lineH * 1.1)));
      if (!Number.isFinite(maxSize)) {
        size = 8;
        applyDomLayoutStyles(box, tpl, st, bw, padX, size);
      } else {
        const jsEst = computeJsFit(ctx, b, st, bw, bh, richWordsOpt).size;
        const startSize = Math.min(maxSize, jsEst + 2);
        size = 7;
        for (let s = startSize; s >= 7; s -= 1) {
          applyDomLayoutStyles(box, tpl, st, bw, padX, s);
          if (box.scrollHeight <= usableH + 0.75 && box.scrollWidth <= bw + usableW * 0.04 + 0.5) {
            size = s;
            break;
          }
        }
        if (Number.parseFloat(box.style.fontSize) !== size) applyDomLayoutStyles(box, tpl, st, bw, padX, size);
      }
    } else {
      applyDomLayoutStyles(box, tpl, st, bw, padX, size);
    }

    const rawScrollH = box.scrollHeight;
    const contentH = rawScrollH > 0 ? rawScrollH : size * 1.55;
    const topUnscaled = st.verticalAlign === 'top' ? padY
      : st.verticalAlign === 'bottom' ? bh - padY - contentH
      : (bh - contentH) / 2;

    const boxRect = box.getBoundingClientRect();
    const walker = document.createTreeWalker(box, 4);
    const r = document.createRange();
    const fragments = [];
    const styleCache = new Map();
    let tn;
    while ((tn = walker.nextNode())) {
      const val = tn.nodeValue || '';
      if (!val.trim()) continue;
      const parentEl = tn.parentElement || box;
      let ns = styleCache.get(parentEl);
      if (!ns) { ns = resolveDomNodeStyle(tn, box, st, size); styleCache.set(parentEl, ns); }
      const re = /\S+/g;
      let m;
      while ((m = re.exec(val))) {
        const s = m.index, e = m.index + m[0].length;
        r.setStart(tn, s); r.setEnd(tn, e);
        const rects = r.getClientRects();
        if (!rects.length) continue;
        if (rects.length === 1) {
          const rb = rects[0];
          if (!(rb.width > 0 && rb.height > 0)) continue;
          let dir = ns.dir;
          if (e - s > 1) {
            r.setStart(tn, s); r.setEnd(tn, s + 1); const b0 = r.getBoundingClientRect();
            r.setStart(tn, e - 1); r.setEnd(tn, e); const b1 = r.getBoundingClientRect();
            if (b0.width > 0 && b1.width > 0 && Math.abs(b0.left - b1.left) > 0.1) dir = b0.left < b1.left ? 'ltr' : 'rtl';
          }
          fragments.push({
            text: val.slice(s, e),
            left: rb.left - boxRect.left, right: rb.right - boxRect.left,
            top: rb.top - boxRect.top, bottom: rb.bottom - boxRect.top,
            dir, bold: ns.bold, italic: ns.italic, underline: ns.underline, strike: ns.strike, size: ns.size, color: ns.color
          });
          continue;
        }
        const chs = [];
        for (let k = s; k < e;) {
          let kEnd = k + 1;
          while (kEnd < e && (val[kEnd] === '\u200c' || val[kEnd] === '\u200d' || /[\u064b-\u065f\u0670]/.test(val[kEnd]))) kEnd += 1;
          r.setStart(tn, k); r.setEnd(tn, kEnd);
          const cb = r.getBoundingClientRect();
          if (cb.width > 0 || cb.height > 0) chs.push({ k, kEnd, left: cb.left, right: cb.right, top: cb.top, bottom: cb.bottom });
          else if (chs.length) chs[chs.length - 1].kEnd = kEnd;
          k = kEnd;
        }
        let i = 0;
        while (i < chs.length) {
          let j = i + 1, runDir = null;
          while (j < chs.length && Math.abs(chs[j].top - chs[i].top) < 3) {
            const prev = chs[j - 1], cur = chs[j];
            const stepLtr = Math.abs(cur.left - prev.right) < 1.5;
            const stepRtl = Math.abs(prev.left - cur.right) < 1.5;
            if (!runDir) {
              if (stepLtr && !stepRtl) runDir = 'ltr';
              else if (stepRtl && !stepLtr) runDir = 'rtl';
              else break;
            } else if ((runDir === 'ltr' && !stepLtr) || (runDir === 'rtl' && !stepRtl)) break;
            j += 1;
          }
          const dir = runDir || (/^[A-Za-z0-9]/.test(val[chs[i].k]) ? 'ltr' : ns.dir);
          const group = chs.slice(i, j);
          fragments.push({
            text: val.slice(chs[i].k, chs[j - 1].kEnd),
            left: Math.min(...group.map((x) => x.left)) - boxRect.left,
            right: Math.max(...group.map((x) => x.right)) - boxRect.left,
            top: Math.min(...group.map((x) => x.top)) - boxRect.top,
            bottom: Math.max(...group.map((x) => x.bottom)) - boxRect.top,
            dir, bold: ns.bold, italic: ns.italic, underline: ns.underline, strike: ns.strike, size: ns.size, color: ns.color
          });
          i = j;
        }
      }
    }
    box.textContent = '';
    return { size, topUnscaled, fragments };
  }

  function fitBlockSize(ctx, b, bw, bh) {
    const st = blockStyle(b);
    if (st.size) return st.size;
    const rawHtml = blockRawLayoutHtml(b);
    if (!hasSpecialRichElements(rawHtml)) {
      const box = getDomMeasureBox();
      if (box) {
        const maxSize = Math.max(12, Math.min(64, Math.round(b.lineH * 1.1)));
        if (!Number.isFinite(maxSize)) return 8;
        const padX = boxInset(bw), padY = boxInset(bh);
        const usableW = Math.max(1, bw - 2 * padX), usableH = Math.max(1, bh - 2 * padY);
        const tpl = buildSafeDomTemplate(rawHtml);
        const jsEst = computeJsFit(ctx, b, st, bw, bh).size;
        const startSize = Math.min(maxSize, jsEst + 2);
        let chosen = 8;
        for (let s = startSize; s >= 8; s -= 1) {
          applyDomLayoutStyles(box, tpl, st, bw, padX, s);
          if (box.scrollHeight <= usableH + 0.75 && box.scrollWidth <= bw + usableW * 0.04 + 0.5) {
            chosen = s;
            break;
          }
        }
        box.textContent = '';
        return chosen;
      }
    }
    return computeJsFit(ctx, b, st, bw, bh).size;
  }

  // bmp: تصویر اصلی؛ blocks: بلوک‌ها؛ برمی‌گرداند canvas نهایی
  function render(bmp, blocks, opts) {
    const o = Object.assign({ createCanvas: null }, opts);
    const mk = o.createCanvas || ((w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; });
    const W = bmp.width, H = bmp.height;
    const cv = mk(W, H);
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    // Paint box backgrounds first so no later box fill can cover an earlier translation's text.
    const targetFills = [], textJobs = [];
    const ascentCache = new Map();

    blocks.forEach((b) => {
      if (!b.enabled) return;
      const sourceText = String(b.tr || '').trim();
      const richWords = !b._plainText && b.richHtml ? richHtmlWords(b.richHtml) : null;
      if (!sourceText && !richWords?.some((word) => String(word.t || '').trim()) && !(typeof b._liveHtml === 'string' && b._liveHtml.trim())) return;
      const st = blockStyle(b);
      const layoutBox = {
        x0: Math.max(0, Number.isFinite(b.tx0) ? b.tx0 : b.x0),
        y0: Math.max(0, Number.isFinite(b.ty0) ? b.ty0 : b.y0),
        x1: Math.min(W, Number.isFinite(b.tx1) ? b.tx1 : b.x1),
        y1: Math.min(H, Number.isFinite(b.ty1) ? b.ty1 : b.y1)
      };
      const bw = layoutBox.x1 - layoutBox.x0, bh = layoutBox.y1 - layoutBox.y0;
      if (bw <= 0 || bh <= 0) return;

      let targetFill = null, txt = '#0b0b0b', stroke = null;
      if (b.bg === 'none') {
        txt = '#ffffff'; stroke = '#000000';
      } else if (b.bg === 'white') { targetFill = '#ffffff'; }
      else if (b.bg === 'black') { targetFill = '#000000'; txt = '#fafafa'; }
      else {
        const targetBg = sampleBg(ctx, layoutBox, W, H);
        targetFill = `rgb(${targetBg.r},${targetBg.g},${targetBg.b})`;
        txt = lum(targetBg.r, targetBg.g, targetBg.b) > 150 ? '#0b0b0b' : '#fafafa';
      }
      // رنگ دستی کاربر بر انتخاب خودکار اولویت دارد (زیرخط هم با همین رنگ رسم می‌شود)
      if (st.color) txt = st.color;
      if (targetFill) targetFills.push([targetFill, layoutBox.x0, layoutBox.y0, bw, bh]);

      // در مرورگر واقعی، جایگاه دقیق کلمه‌ها مستقیماً از همان جعبهٔ چیدمان DOM خوانده می‌شود
      // تا متنِ زمان تایپ، مکان‌نما و خروجی نهایی روی عکس از یک موتور واحد و بدون حتی ۱ پیکسل اختلاف بیایند.
      const domLayout = !o.createCanvas ? domLayoutBlock(ctx, b, st, bw, bh, richWords) : null;
      if (domLayout) {
        textJobs.push(() => {
          ctx.save();
          ctx.beginPath();
          ctx.rect(layoutBox.x0, layoutBox.y0, bw, bh);
          ctx.clip();
          ctx.textAlign = 'left';
          domLayout.fragments.forEach((frag) => {
            const fontSpec = `${frag.italic ? 'italic ' : ''}${frag.bold ? '700' : '400'} ${frag.size}px ${FONT}`;
            ctx.font = fontSpec;
            let ascent = ascentCache.get(fontSpec);
            if (ascent === undefined) {
              const m = ctx.measureText('سلام');
              ascent = Number.isFinite(m?.fontBoundingBoxAscent) ? m.fontBoundingBoxAscent : null;
              ascentCache.set(fontSpec, ascent);
            }
            if ('direction' in ctx) ctx.direction = frag.dir;
            const drawX = layoutBox.x0 + frag.left;
            const midY = layoutBox.y0 + domLayout.topUnscaled + (frag.top + frag.bottom) / 2;
            const drawY = ascent !== null ? (layoutBox.y0 + domLayout.topUnscaled + frag.top + ascent) : midY;
            ctx.textBaseline = ascent !== null ? 'alphabetic' : 'middle';
            const wColor = frag.color || txt;
            if (stroke) { ctx.lineWidth = Math.max(3, frag.size / 5); ctx.strokeStyle = stroke; ctx.lineJoin = 'round'; ctx.strokeText(frag.text, drawX, drawY); }
            ctx.fillStyle = wColor;
            ctx.fillText(frag.text, drawX, drawY);
            const fragW = Math.max(0, frag.right - frag.left);
            if (frag.underline) {
              ctx.strokeStyle = wColor;
              ctx.lineWidth = Math.max(1, frag.size / 14);
              ctx.beginPath();
              ctx.moveTo(drawX, midY + frag.size * 0.55);
              ctx.lineTo(drawX + fragW, midY + frag.size * 0.55);
              ctx.stroke();
            }
            if (frag.strike) {
              ctx.strokeStyle = wColor;
              ctx.lineWidth = Math.max(1, frag.size / 14);
              ctx.beginPath();
              ctx.moveTo(drawX, midY - frag.size * 0.2);
              ctx.lineTo(drawX + fragW, midY - frag.size * 0.2);
              ctx.stroke();
            }
          });
          ctx.restore();
        });
        return;
      }

      const padX = boxInset(bw), padY = boxInset(bh);
      const usableW = Math.max(1, bw - 2 * padX);
      const f = computeJsFit(ctx, b, st, bw, bh, richWords);
      const inline = f.inline;
      textJobs.push(() => {
      // Keep the actual output inside the editable translation box, even for manually enlarged text.
      ctx.save();
      ctx.beginPath();
      ctx.rect(layoutBox.x0, layoutBox.y0, bw, bh);
      ctx.clip();
      if ('direction' in ctx) ctx.direction = st.dir;
      ctx.textBaseline = 'middle';
      const totalH = inline ? f.lineLh.reduce((sum, v) => sum + v, 0) : f.lines.length * f.lh;
      const insetY = padY;
      // Top/bottom anchor the entire text block, including wrapped and blank lines.
      // Preserve the previous centred placement for projects without this option.
      const textTop = st.verticalAlign === 'top' ? layoutBox.y0 + insetY
        : st.verticalAlign === 'bottom' ? layoutBox.y1 - insetY - totalH
        : (layoutBox.y0 + layoutBox.y1 - totalH) / 2;
      let y = textTop + (inline ? (f.lineLh[0] || f.lh) : f.lh) / 2;
      // لنگر هر خط بر اساس چیدمان انتخابی، با حاشیهٔ کوچک از لبهٔ کادر
      const anchorX = st.align === 'left' || (st.align === 'justify' && st.dir === 'ltr') ? layoutBox.x0 + padX
        : st.align === 'center' ? (layoutBox.x0 + layoutBox.x1) / 2
        : layoutBox.x1 - padX;
      if (inline) {
        // مسیر درون‌متنی: هر کلمه با فونت، اندازه و رنگ خودش و در موقعیت فیزیکی محاسبه‌شده رسم می‌شود
        ctx.textAlign = 'left';
        f.lines.forEach((line, li) => {
          const m = measureLine(ctx, line, st, f.size);
          const lineAlign = line[0]?.lineAlign || st.align; const lineDir = line[0]?.lineDir || st.dir;
          if ('direction' in ctx) ctx.direction = lineDir;
          const lineAnchor = lineAlign === 'left' || (lineAlign === 'justify' && lineDir === 'ltr') ? layoutBox.x0 + padX
            : lineAlign === 'center' ? lineAnchorCenter(layoutBox) : layoutBox.x1 - padX;
          const leftAligned = lineAlign === 'left' || (lineAlign === 'justify' && lineDir === 'ltr');
          const gapCount = line.slice(1).filter((word) => word.spaceBefore !== false).length;
          // Do not stretch the last line of a paragraph, explicit line breaks, or single-word lines.
          const nextLine = f.lines[li + 1];
          const justify = lineAlign === 'justify' && nextLine && !nextLine[0].lineBreakBefore && gapCount > 0;
          const extraGap = justify ? Math.max(0, usableW - m.width) / gapCount : 0;
          const paintedWidth = m.width + extraGap * gapCount;
          let x = leftAligned ? lineAnchor
            : lineAlign === 'center' ? lineAnchor - paintedWidth / 2
            : lineAnchor - paintedWidth;
          // در پاراگراف RTL ترتیب دیداری کلمه‌ها با حفظ عبارت‌های LTR متوالی محاسبه می‌شود
          const visual = visualLineOrder(line, lineDir);
          visual.forEach(({ idx, hasGapAfter }) => {
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
            const gapAfter = hasGapAfter ? m.spaceW + extraGap : 0;
            x += m.widths[idx] + gapAfter;
          });
          if (li + 1 < f.lineLh.length) {
            // Keep the exact legacy placement for older projects. Explicit vertical
            // alignment uses the centres of adjacent (possibly different) line heights.
            y += ['top', 'middle', 'bottom'].includes(b.verticalAlign)
              ? (f.lineLh[li] + f.lineLh[li + 1]) / 2 : f.lineLh[li];
          }
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
    targetFills.forEach(paintRect);
    textJobs.forEach((paintText) => paintText());
    return cv;
  }

  function lineAnchorCenter(layoutBox) {
    return (layoutBox.x0 + layoutBox.x1) / 2;
  }

  const api = {
    FONT, render, sampleBg, fit, wrapWords, blockStyle, boxInset, fitBlockSize,
    hasInlineMarks, tokenizeInline, inlineMarksToHtml, stripInlineMarkers, inlineWords, richHtmlWords, fitInline, visualLineOrder
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Typeset = api;
})(typeof window !== 'undefined' ? window : globalThis);
