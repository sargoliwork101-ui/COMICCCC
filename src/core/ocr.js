// خواندن متن تصاویر (OCR) و گروه‌بندی خط‌ها در قالب «حباب/بلوک»
(function (root) {
  const LANGS = {
    eng: { sl: 'en', cjk: false, name: 'English' },
    kor: { sl: 'ko', cjk: false, name: '한국어' },
    jpn: { sl: 'ja', cjk: true, name: '日本語' },
    chi_sim: { sl: 'zh-CN', cjk: true, name: '中文' }
  };

  const letterCount = (s) => { const m = s.match(/\p{L}/gu); return m ? m.length : 0; };

  const SCRIPT = {
    eng: /[A-Za-z]/g,
    kor: /[\uAC00-\uD7A3]/g,
    jpn: /[\u3040-\u30FF\u4E00-\u9FFF]/g,
    chi_sim: /[\u4E00-\u9FFF]/g
  };
  const ALLOWED = /[0-9.,!?'"“”‘’:;…~\-—()（）、。！？「」]/g;

  // آیا این خط واقعاً از زبان انتخاب‌شده است؟ (حذف خروجی‌های بی‌معنی OCR)
  function looksReal(text, lang) {
    const flat = text.replace(/\s+/g, '');
    if (!flat) return false;
    const re = SCRIPT[lang];
    if (!re) return true;
    const sc = (flat.match(re) || []).length;
    const al = (flat.match(ALLOWED) || []).length;
    return sc / flat.length >= 0.55 && (sc + al) / flat.length >= 0.9;
  }

  // خروجی خام tesseract (blocks) را به آرایهٔ ساده از خط‌ها تبدیل می‌کند
  function extractLines(data, yOffset, cjk, minConf, lang, stats, xOffset) {
    xOffset = xOffset || 0;
    const out = [];
    (data.blocks || []).forEach((b) => (b.paragraphs || []).forEach((p) => (p.lines || []).forEach((l) => {
      let text = (l.text || '').replace(/\s+/g, ' ').trim();
      if (cjk) text = text.replace(/\s+/g, '');
      if (stats) stats.raw++;
      const h = l.bbox.y1 - l.bbox.y0;
      if (!text || l.confidence < minConf || letterCount(text) < (cjk ? 1 : 2)) return;
      if (h < 8 || h > 220) return;
      if (!looksReal(text, lang)) return;
      // خط‌های خیلی کوتاه فقط با اطمینان بالا پذیرفته می‌شوند (حذف نویز)
      if (letterCount(text) < (cjk ? 2 : 5) && l.confidence < 70) return;
      out.push({ text, conf: l.confidence, x0: l.bbox.x0 + xOffset, x1: l.bbox.x1 + xOffset, y0: l.bbox.y0 + yOffset, y1: l.bbox.y1 + yOffset });
    })));
    return out;
  }

  // خط‌های نزدیک و هم‌تراز را در یک بلوک (یک حباب گفتگو) جمع می‌کند
  function groupLines(lines, cjk) {
    const L = lines.slice().sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    const n = L.length;
    const parent = L.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };

    for (let i = 0; i < n; i++) {
      const a = L[i], ha = a.y1 - a.y0, wa = a.x1 - a.x0;
      for (let j = i + 1; j < n; j++) {
        const b = L[j], hb = b.y1 - b.y0, wb = b.x1 - b.x0;
        if (b.y0 > a.y1 + 1.5 * Math.max(ha, hb)) break; // لیست بر اساس y مرتب است
        const gap = b.y0 - a.y1;
        const avgH = (ha + hb) / 2;
        if (gap > 0.95 * avgH || gap < -0.4 * Math.min(ha, hb)) continue;
        const ratio = ha / hb;
        if (ratio < 0.6 || ratio > 1.67) continue;
        const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        if (overlap < 0.2 * Math.min(wa, wb)) continue;
        const cdiff = Math.abs((a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2);
        if (cdiff > 0.6 * Math.max(wa, wb)) continue;
        uni(i, j);
      }
    }

    const groups = new Map();
    L.forEach((l, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(l); });

    const blocks = [];
    groups.forEach((g) => {
      g.sort((a, b) => a.y0 - b.y0);
      const x0 = Math.min(...g.map((l) => l.x0)), x1 = Math.max(...g.map((l) => l.x1));
      const y0 = Math.min(...g.map((l) => l.y0)), y1 = Math.max(...g.map((l) => l.y1));
      blocks.push({
        x0, y0, x1, y1,
        text: g.map((l) => l.text).join(cjk ? '' : ' ').replace(/\s+/g, ' ').trim(),
        conf: g.reduce((s, l) => s + l.conf, 0) / g.length,
        lineH: g.reduce((s, l) => s + (l.y1 - l.y0), 0) / g.length,
        lines: g.length
      });
    });
    blocks.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    blocks.forEach((b, i) => { b.id = i + 1; b.enabled = true; b.bg = 'auto'; b.tr = ''; });
    return blocks;
  }

  // پیش‌پردازش: 'gray' = خاکستری + کشیدن کنتراست ، 'wmask' = جداکردن متن سفید (مثلاً متن با حاشیه روی نقاشی)
  function makePass(src, w, h, mode, mk) {
    const ctx = src.getContext('2d');
    const id = ctx.getImageData(0, 0, w, h), d = id.data;
    if (mode === 'wmask') {
      for (let i = 0; i < d.length; i += 4) {
        const v = Math.min(d[i], d[i + 1], d[i + 2]) > 215 ? 0 : 255;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    } else if (mode === 'adaptive') {
      // OCR-only local contrast: adaptive thresholding reads dark lettering over uneven artwork.
      // A rolling row buffer avoids allocating a full-size integral image for long webtoon pages.
      const radius = Math.min(15, Math.floor((Math.min(w, h) - 1) / 2));
      const windowSize = radius * 2 + 1;
      const ring = new Array(windowSize);
      const vertical = new Uint32Array(w);
      const horizontalRow = (y) => {
        const gray = new Uint8Array(w);
        const sums = new Uint16Array(w);
        const row = y * w * 4;
        for (let x = 0; x < w; x++) {
          const i = row + x * 4;
          gray[x] = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
        }
        let sum = 0;
        for (let x = 0; x <= radius && x < w; x++) sum += gray[x];
        for (let x = 0; x < w; x++) {
          const left = Math.max(0, x - radius), right = Math.min(w - 1, x + radius);
          const count = right - left + 1;
          sums[x] = Math.min(65535, Math.round(sum * windowSize / count));
          if (x - radius >= 0) sum -= gray[x - radius];
          if (x + radius + 1 < w) sum += gray[x + radius + 1];
        }
        return sums;
      };
      let firstRow = 0, lastRow = -1;
      for (let y = 0; y < h; y++) {
        const wantedFirst = Math.max(0, y - radius);
        while (firstRow < wantedFirst) {
          const old = ring[firstRow % windowSize];
          for (let x = 0; x < w; x++) vertical[x] -= old[x];
          firstRow++;
        }
        const wantedLast = Math.min(h - 1, y + radius);
        while (lastRow < wantedLast) {
          lastRow++;
          const values = horizontalRow(lastRow);
          ring[lastRow % windowSize] = values;
          for (let x = 0; x < w; x++) vertical[x] += values[x];
        }
        const verticalCount = lastRow - firstRow + 1;
        const row = y * w * 4;
        for (let x = 0; x < w; x++) {
          const i = row + x * 4;
          const gray = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
          const mean = vertical[x] / (windowSize * verticalCount);
          const value = gray <= mean - 7 ? 0 : 255;
          d[i] = d[i + 1] = d[i + 2] = value;
        }
      }
    } else {
      const hist = new Uint32Array(256);
      for (let i = 0; i < d.length; i += 4) {
        const v = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
        d[i] = d[i + 1] = d[i + 2] = v; hist[v]++;
      }
      const total = d.length / 4;
      let acc = 0, lo = 0, hi = 255;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.01) { lo = v; break; } }
      acc = 0;
      for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.01) { hi = v; break; } }
      // Stretch even low-contrast artwork (unless the slice is a single flat color).
      if (hi > lo) {
        const k = 255 / (hi - lo);
        for (let i = 0; i < d.length; i += 4) {
          const v = Math.max(0, Math.min(255, (d[i] - lo) * k));
          d[i] = d[i + 1] = d[i + 2] = v;
        }
      }
    }
    const out = mk(w, h);
    out.getContext('2d').putImageData(id, 0, 0);
    return out;
  }

  // پیدا کردن ناحیه‌های روشن بزرگ (حباب‌های گفتگو) با برچسب‌گذاری اجزای متصل
  function findBubbles(cv, w, h, maxCount) {
    const d = cv.getContext('2d').getImageData(0, 0, w, h).data;
    const white = new Uint8Array(w * h);
    for (let p = 0, i = 0; p < white.length; p++, i += 4) white[p] = (d[i] > 225 && d[i + 1] > 225 && d[i + 2] > 225) ? 1 : 0;
    const label = new Int32Array(w * h);
    const stack = new Int32Array(w * h);
    const comps = [];
    let id = 0;
    for (let start = 0; start < white.length; start++) {
      if (!white[start] || label[start]) continue;
      id++;
      let sp = 0, area = 0, minx = w, maxx = 0, miny = h, maxy = 0;
      stack[sp++] = start; label[start] = id;
      while (sp) {
        const p = stack[--sp]; area++;
        const x = p % w, y = (p / w) | 0;
        if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
        if (x > 0 && white[p - 1] && !label[p - 1]) { label[p - 1] = id; stack[sp++] = p - 1; }
        if (x < w - 1 && white[p + 1] && !label[p + 1]) { label[p + 1] = id; stack[sp++] = p + 1; }
        if (y > 0 && white[p - w] && !label[p - w]) { label[p - w] = id; stack[sp++] = p - w; }
        if (y < h - 1 && white[p + w] && !label[p + w]) { label[p + w] = id; stack[sp++] = p + w; }
      }
      const bw = maxx - minx + 1, bh = maxy - miny + 1;
      if (area < 2500 || bw < 70 || bh < 35) continue;
      if (area > 0.5 * w * h) continue; // پس‌زمینهٔ سفید کل صفحه، حباب نیست
      comps.push({ id, area, minx, maxx, miny, maxy });
    }
    comps.sort((a, b) => b.area - a.area);
    const top = comps.slice(0, maxCount || 14);
    // بازهٔ افقی هر ردیف (برای پر کردن سوراخ‌های حباب = خود متن)
    top.forEach((c) => {
      c.rows = [];
      for (let y = c.miny; y <= c.maxy; y++) {
        let a = -1, b = -1;
        for (let x = c.minx; x <= c.maxx; x++) if (label[y * w + x] === c.id) { if (a < 0) a = x; b = x; }
        c.rows.push([a, b]);
      }
    });
    return top;
  }

  // هر حباب جدا برش می‌خورد (بیرون حباب سفید می‌شود) و همان تکه خوانده می‌شود
  async function ocrBubbles(cv, w, h, worker, mk, o, yOffset) {
    const out = [];
    const bubbles = findBubbles(cv, w, h, 14);
    const M = 14;
    for (const c of bubbles) {
      const bw = c.maxx - c.minx + 1, bh = c.maxy - c.miny + 1;
      const crop = mk(bw + 2 * M, bh + 2 * M);
      const cx = crop.getContext('2d');
      cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, crop.width, crop.height);
      for (let r = 0; r < c.rows.length; r++) {
        const [a, b] = c.rows[r];
        if (a < 0) continue;
        cx.drawImage(cv, a, c.miny + r, b - a + 1, 1, a - c.minx + M, r + M, b - a + 1, 1);
      }
      const res = await worker.recognize(crop, {}, { blocks: true });
      extractLines(res.data, yOffset + c.miny - M, o.cjk, o.minConf, o.lang, o.stats, c.minx - M).forEach((l) => out.push(l));
      crop.width = crop.height = 0;
    }
    return out;
  }

  const overlapRatio = (a, b) => {
    const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
    const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
    const minArea = Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
    return minArea > 0 ? (ix * iy) / minArea : 0;
  };

  // تصویر بلند را تکه‌تکه می‌خواند (با هم‌پوشانی)؛ هر تکه با چند روش پیش‌پردازش خوانده و نتایج ادغام می‌شوند
  async function ocrBitmap(bmp, worker, opts) {
    const o = Object.assign({ sliceH: 2200, overlap: 160, minConf: 40, cjk: false, lang: 'eng',
      passes: ['gray', 'bubbles', 'wmask'], createCanvas: null, onSlice: null, stats: null }, opts);
    const mk = o.createCanvas || ((w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; });
    const raw = [];
    for (let s = 0; s < bmp.height; s += o.sliceH) {
      const e = Math.min(bmp.height, s + o.sliceH);
      const y0 = Math.max(0, s - o.overlap), y1 = Math.min(bmp.height, e + o.overlap), h = y1 - y0;
      const cv = mk(bmp.width, h);
      cv.getContext('2d', { willReadFrequently: true }).drawImage(bmp, 0, y0, bmp.width, h, 0, 0, bmp.width, h);

      let cand = [];
      for (const mode of o.passes) {
        if (mode === 'bubbles') { cand = cand.concat(await ocrBubbles(cv, bmp.width, h, worker, mk, o, y0)); continue; }
        const pc = makePass(cv, bmp.width, h, mode, mk);
        const r = await worker.recognize(pc, {}, { blocks: true });
        cand = cand.concat(extractLines(r.data, y0, o.cjk, o.minConf, o.lang, o.stats));
        pc.width = pc.height = 0;
      }
      cand.sort((a, b) => b.conf - a.conf);
      const kept = [];
      cand.forEach((c) => {
        const cy = (c.y0 + c.y1) / 2;
        if (cy < s || cy >= e) return; // هر خط فقط در تکه‌ای ثبت می‌شود که مرکزش در آن است
        if (!kept.some((k) => overlapRatio(k, c) > 0.4)) kept.push(c);
      });
      kept.forEach((k) => raw.push(k));
      cv.width = cv.height = 0;
      if (o.onSlice) o.onSlice(e / bmp.height);
    }
    if (o.stats) o.stats.kept += raw.length;
    return raw;
  }

  async function createOcrWorker(lang, logger) {
    const base = chrome.runtime.getURL('vendor/ocr/');
    const worker = await Tesseract.createWorker(lang, 1, {
      workerPath: base + 'worker.min.js',
      corePath: base + 'core',
      langPath: base + 'lang',
      workerBlobURL: false,
      gzip: true,
      cacheMethod: 'none',
      logger: logger || (() => {})
    });
    await worker.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1' });
    return worker;
  }

  const api = { LANGS, extractLines, groupLines, makePass, ocrBitmap, createOcrWorker, looksReal };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.OcrTools = api;
})(typeof window !== 'undefined' ? window : globalThis);
