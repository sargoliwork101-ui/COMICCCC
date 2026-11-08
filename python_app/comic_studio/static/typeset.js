// جای‌گذاری متن فارسی روی تصویر (پاک کردن متن قدیمی + نوشتن ترجمه)
(function (root) {
  const FONT = 'Vazirmatn, Tahoma, sans-serif';
  const FONT_STACKS = Object.freeze({
    vazirmatn: FONT,
    tahoma: 'Tahoma, Vazirmatn, sans-serif',
    'segoe ui': '"Segoe UI", Vazirmatn, sans-serif',
    arial: 'Arial, Vazirmatn, sans-serif',
    'arial black': '"Arial Black", Impact, Vazirmatn, sans-serif',
    'times new roman': '"Times New Roman", Georgia, Vazirmatn, serif',
    georgia: 'Georgia, "Times New Roman", Vazirmatn, serif',
    impact: 'Impact, "Arial Black", Vazirmatn, sans-serif',
    'comic sans ms': '"Comic Sans MS", cursive, Vazirmatn, sans-serif',
    'courier new': '"Courier New", monospace, Vazirmatn',
  });
  const BOX_SHAPES = Object.freeze([
    'rect', 'ellipse', 'pill', 'cloud', 'thought', 'speech',
    'star', 'burst', 'seal', 'diamond', 'hexagon', 'octagon', 'heart', 'banner',
  ]);

  function resolveFontStack(fontFamily) {
    const raw = String(fontFamily || '').trim();
    if (!raw) return FONT;
    const primary = raw.split(',')[0].trim().replace(/^['"]+|['"]+$/g, '').replace(/\s+/g, ' ').toLowerCase();
    return FONT_STACKS[primary] || FONT;
  }

  function normalizeBoxShape(shape) {
    const key = String(shape || '').trim().toLowerCase();
    return BOX_SHAPES.includes(key) ? key : 'rect';
  }

  function normalizeCornerRadius(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  function normalizeBoxAngle(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || Math.abs(n) < 0.05) return 0;
    let wrapped = ((n + 180) % 360 + 360) % 360 - 180;
    if (wrapped === -180 && n > 0) wrapped = 180;
    return Math.round(wrapped * 10) / 10;
  }

  function shapeInsets(bw, bh, shape, cornerRadius) {
    const baseX = boxInset(bw), baseY = boxInset(bh);
    const sh = normalizeBoxShape(shape);
    const cr = normalizeCornerRadius(cornerRadius);
    const sym = (px, py) => ({ padX: px, padY: py, padTop: py, padBottom: py });
    if (sh === 'rect') {
      if (cr <= 0) return sym(baseX, baseY);
      const rPx = (cr / 100) * (Math.min(bw, bh) / 2);
      const diag = rPx * 0.293;
      return sym(Math.max(baseX, diag), Math.max(baseY, diag));
    }
    if (sh === 'pill') {
      const rPx = Math.min(bw, bh) / 2;
      return sym(Math.max(baseX, rPx * 0.32), Math.max(baseY, rPx * 0.16));
    }
    if (sh === 'ellipse') return sym(Math.max(baseX, bw * 0.12), Math.max(baseY, bh * 0.12));
    if (sh === 'cloud') return sym(Math.max(baseX, bw * 0.14), Math.max(baseY, bh * 0.15));
    if (sh === 'thought') {
      const px = Math.max(baseX, bw * 0.14);
      const pt = Math.max(baseY, bh * 0.13);
      const pb = Math.max(baseY, bh * 0.29);
      return { padX: px, padY: (pt + pb) / 2, padTop: pt, padBottom: pb };
    }
    if (sh === 'speech') {
      const px = Math.max(baseX, bw * 0.10);
      const pt = Math.max(baseY, bh * 0.10);
      const pb = Math.max(baseY, bh * 0.24);
      return { padX: px, padY: (pt + pb) / 2, padTop: pt, padBottom: pb };
    }
    if (sh === 'star') return sym(Math.max(baseX, bw * 0.23), Math.max(baseY, bh * 0.24));
    if (sh === 'burst') return sym(Math.max(baseX, bw * 0.16), Math.max(baseY, bh * 0.16));
    if (sh === 'seal') return sym(Math.max(baseX, bw * 0.16), Math.max(baseY, bh * 0.16));
    if (sh === 'diamond') return sym(Math.max(baseX, bw * 0.18), Math.max(baseY, bh * 0.18));
    if (sh === 'hexagon') return sym(Math.max(baseX, bw * 0.11), Math.max(baseY, bh * 0.08));
    if (sh === 'octagon') return sym(Math.max(baseX, bw * 0.11), Math.max(baseY, bh * 0.11));
    if (sh === 'heart') {
      const px = Math.max(baseX, bw * 0.19);
      const pt = Math.max(baseY, bh * 0.20);
      const pb = Math.max(baseY, bh * 0.27);
      return { padX: px, padY: (pt + pb) / 2, padTop: pt, padBottom: pb };
    }
    if (sh === 'banner') return sym(Math.max(baseX, bw * 0.12), baseY);
    return sym(baseX, baseY);
  }

  function cloudContourBumps() {
    return [
      [0.05, 0.18, 0.16, 0.05, 0.29, 0.14],
      [0.32, 0.01, 0.46, 0.00, 0.50, 0.11],
      [0.54, 0.00, 0.68, 0.01, 0.71, 0.14],
      [0.84, 0.05, 0.95, 0.18, 0.88, 0.34],
      [1.00, 0.39, 1.00, 0.61, 0.88, 0.66],
      [0.95, 0.82, 0.84, 0.95, 0.71, 0.86],
      [0.68, 0.99, 0.54, 1.00, 0.50, 0.89],
      [0.46, 1.00, 0.32, 0.99, 0.29, 0.86],
      [0.16, 0.95, 0.05, 0.82, 0.12, 0.66],
      [0.00, 0.61, 0.00, 0.39, 0.12, 0.34],
    ];
  }

  function heartContourCurves() {
    return [
      [0.58, 0.02, 0.96, 0.02, 0.99, 0.31],
      [0.99, 0.58, 0.74, 0.78, 0.50, 0.98],
      [0.26, 0.78, 0.01, 0.58, 0.01, 0.31],
      [0.04, 0.02, 0.42, 0.02, 0.50, 0.21],
    ];
  }

  function starNormalizedVertices(points, innerRatio) {
    const raw = [];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < points * 2; i += 1) {
      const ang = -Math.PI / 2 + (i * Math.PI) / points;
      const r = i % 2 === 0 ? 0.5 : 0.5 * innerRatio;
      const px = 0.5 + r * Math.cos(ang);
      const py = 0.5 + r * Math.sin(ang);
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      raw.push([px, py]);
    }
    const spanX = Math.max(1e-6, maxX - minX);
    const spanY = Math.max(1e-6, maxY - minY);
    return raw.map(([px, py]) => [(px - minX) / spanX, (py - minY) / spanY]);
  }

  function polygonNormalizedVertices(sh) {
    if (sh === 'star') return starNormalizedVertices(5, 0.52);
    if (sh === 'burst') return starNormalizedVertices(12, 0.76);
    if (sh === 'seal') return starNormalizedVertices(8, 0.74);
    if (sh === 'diamond') return [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];
    if (sh === 'hexagon') return [[0.18, 0], [0.82, 0], [1, 0.5], [0.82, 1], [0.18, 1], [0, 0.5]];
    if (sh === 'octagon') return [[0.22, 0], [0.78, 0], [1, 0.22], [1, 0.78], [0.78, 1], [0.22, 1], [0, 0.78], [0, 0.22]];
    if (sh === 'banner') return [[0, 0], [1, 0], [0.90, 0.5], [1, 1], [0, 1], [0.10, 0.5]];
    return null;
  }

  function traceCubicSegments(ctx, x, y, w, h, startFx, startFy, segments) {
    let curX = x + startFx * w, curY = y + startFy * h;
    if (typeof ctx.moveTo === 'function') ctx.moveTo(curX, curY);
    if (typeof ctx.bezierCurveTo === 'function') {
      segments.forEach(([cx1, cy1, cx2, cy2, ex, ey]) => {
        ctx.bezierCurveTo(x + cx1 * w, y + cy1 * h, x + cx2 * w, y + cy2 * h, x + ex * w, y + ey * h);
      });
    } else if (typeof ctx.lineTo === 'function') {
      segments.forEach(([cx1, cy1, cx2, cy2, ex, ey]) => {
        const p1x = x + cx1 * w, p1y = y + cy1 * h;
        const p2x = x + cx2 * w, p2y = y + cy2 * h;
        const p3x = x + ex * w, p3y = y + ey * h;
        for (let step = 1; step <= 10; step += 1) {
          const t = step / 10, mt = 1 - t;
          const bx = mt * mt * mt * curX + 3 * mt * mt * t * p1x + 3 * mt * t * t * p2x + t * t * t * p3x;
          const by = mt * mt * mt * curY + 3 * mt * mt * t * p1y + 3 * mt * t * t * p2y + t * t * t * p3y;
          ctx.lineTo(bx, by);
        }
        curX = p3x; curY = p3y;
      });
    }
    if (typeof ctx.closePath === 'function') ctx.closePath();
  }

  function shapeSvgPath(w, h, shape, cornerRadius) {
    const bw = Math.max(1, Number(w) || 1), bh = Math.max(1, Number(h) || 1);
    const sh = normalizeBoxShape(shape);
    if (sh === 'ellipse') {
      const rx = bw / 2, ry = bh / 2;
      return `M ${rx} 0 A ${rx} ${ry} 0 1 1 ${rx} ${bh} A ${rx} ${ry} 0 1 1 ${rx} 0 Z`;
    }
    const poly = polygonNormalizedVertices(sh);
    if (poly) {
      return `M ${poly.map(([fx, fy]) => `${(fx * bw).toFixed(1)} ${(fy * bh).toFixed(1)}`).join(' L ')} Z`;
    }
    if (sh === 'cloud' || sh === 'thought') {
      const yScale = sh === 'thought' ? 0.82 : 1.0;
      let d = `M ${(0.12 * bw).toFixed(1)} ${(0.34 * bh * yScale).toFixed(1)}`;
      cloudContourBumps().forEach(([cx1, cy1, cx2, cy2, ex, ey]) => {
        d += ` C ${(cx1 * bw).toFixed(1)} ${(cy1 * bh * yScale).toFixed(1)}, ${(cx2 * bw).toFixed(1)} ${(cy2 * bh * yScale).toFixed(1)}, ${(ex * bw).toFixed(1)} ${(ey * bh * yScale).toFixed(1)}`;
      });
      d += ' Z';
      if (sh === 'thought') {
        const b1x = (0.27 * bw).toFixed(1), b1rX = (0.055 * bw).toFixed(1), b1rY = (0.042 * bh).toFixed(1);
        const b1Top = ((0.885 - 0.042) * bh).toFixed(1), b1Bot = ((0.885 + 0.042) * bh).toFixed(1);
        const b2x = (0.18 * bw).toFixed(1), b2rX = (0.034 * bw).toFixed(1), b2rY = (0.028 * bh).toFixed(1);
        const b2Top = ((0.960 - 0.028) * bh).toFixed(1), b2Bot = ((0.960 + 0.028) * bh).toFixed(1);
        d += ` M ${b1x} ${b1Top} A ${b1rX} ${b1rY} 0 1 1 ${b1x} ${b1Bot} A ${b1rX} ${b1rY} 0 1 1 ${b1x} ${b1Top} Z`;
        d += ` M ${b2x} ${b2Top} A ${b2rX} ${b2rY} 0 1 1 ${b2x} ${b2Bot} A ${b2rX} ${b2rY} 0 1 1 ${b2x} ${b2Top} Z`;
      }
      return d;
    }
    if (sh === 'speech') {
      const bodyH = 0.82 * bh;
      const r = Math.min(bw / 2, bodyH / 2, Math.min(bw, bodyH) * 0.28);
      const tailL = Math.max(r + 1, 0.26 * bw);
      const tailR = Math.min(bw - r - 1, Math.max(tailL + 4, 0.42 * bw));
      const tipX = 0.22 * bw, tipY = 0.99 * bh;
      return `M ${r.toFixed(1)} 0 H ${(bw - r).toFixed(1)} A ${r.toFixed(1)} ${r.toFixed(1)} 0 0 1 ${bw.toFixed(1)} ${r.toFixed(1)} V ${(bodyH - r).toFixed(1)} A ${r.toFixed(1)} ${r.toFixed(1)} 0 0 1 ${(bw - r).toFixed(1)} ${bodyH.toFixed(1)} H ${tailR.toFixed(1)} L ${tipX.toFixed(1)} ${tipY.toFixed(1)} L ${tailL.toFixed(1)} ${bodyH.toFixed(1)} H ${r.toFixed(1)} A ${r.toFixed(1)} ${r.toFixed(1)} 0 0 1 0 ${(bodyH - r).toFixed(1)} V ${r.toFixed(1)} A ${r.toFixed(1)} ${r.toFixed(1)} 0 0 1 ${r.toFixed(1)} 0 Z`;
    }
    if (sh === 'heart') {
      let d = `M ${(0.50 * bw).toFixed(1)} ${(0.21 * bh).toFixed(1)}`;
      heartContourCurves().forEach(([cx1, cy1, cx2, cy2, ex, ey]) => {
        d += ` C ${(cx1 * bw).toFixed(1)} ${(cy1 * bh).toFixed(1)}, ${(cx2 * bw).toFixed(1)} ${(cy2 * bh).toFixed(1)}, ${(ex * bw).toFixed(1)} ${(ey * bh).toFixed(1)}`;
      });
      return `${d} Z`;
    }
    const r = sh === 'pill'
      ? Math.min(bw, bh) / 2
      : (normalizeCornerRadius(cornerRadius) / 100) * (Math.min(bw, bh) / 2);
    if (r <= 0.5) return `M 0 0 H ${bw} V ${bh} H 0 Z`;
    const cr = Math.min(r, bw / 2, bh / 2);
    return `M ${cr} 0 H ${bw - cr} A ${cr} ${cr} 0 0 1 ${bw} ${cr} V ${bh - cr} A ${cr} ${cr} 0 0 1 ${bw - cr} ${bh} H ${cr} A ${cr} ${cr} 0 0 1 0 ${bh - cr} V ${cr} A ${cr} ${cr} 0 0 1 ${cr} 0 Z`;
  }

  function drawBoxShapePath(ctx, x, y, w, h, shape, cornerRadius) {
    const sh = normalizeBoxShape(shape);
    const cr = normalizeCornerRadius(cornerRadius);
    if (sh === 'rect' && cr <= 0) {
      if (typeof ctx.beginPath === 'function') ctx.beginPath();
      if (typeof ctx.rect === 'function') ctx.rect(x, y, w, h);
      return;
    }
    if (sh === 'rect' || sh === 'pill') {
      const rad = sh === 'pill' ? Math.min(w, h) / 2 : (cr / 100) * (Math.min(w, h) / 2);
      roundedRectPath(ctx, x, y, w, h, rad);
      return;
    }
    if (typeof ctx.beginPath === 'function') ctx.beginPath();
    if (sh === 'ellipse') {
      if (typeof ctx.ellipse === 'function') {
        ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      } else if (typeof ctx.rect === 'function') {
        ctx.rect(x, y, w, h);
      }
      if (typeof ctx.closePath === 'function') ctx.closePath();
      return;
    }
    const poly = polygonNormalizedVertices(sh);
    if (poly && typeof ctx.moveTo === 'function' && typeof ctx.lineTo === 'function') {
      poly.forEach(([fx, fy], idx) => {
        if (idx === 0) ctx.moveTo(x + fx * w, y + fy * h);
        else ctx.lineTo(x + fx * w, y + fy * h);
      });
      if (typeof ctx.closePath === 'function') ctx.closePath();
      return;
    }
    if ((sh === 'cloud' || sh === 'thought') && typeof ctx.moveTo === 'function') {
      const yScale = sh === 'thought' ? 0.82 : 1.0;
      traceCubicSegments(ctx, x, y, w, h * yScale, 0.12, 0.34, cloudContourBumps());
      if (sh === 'thought' && typeof ctx.ellipse === 'function') {
        const b1x = x + 0.27 * w, b1y = y + 0.885 * h, b1rx = 0.055 * w, b1ry = 0.042 * h;
        ctx.moveTo(b1x + b1rx, b1y);
        ctx.ellipse(b1x, b1y, b1rx, b1ry, 0, 0, Math.PI * 2);
        const b2x = x + 0.18 * w, b2y = y + 0.960 * h, b2rx = 0.034 * w, b2ry = 0.028 * h;
        ctx.moveTo(b2x + b2rx, b2y);
        ctx.ellipse(b2x, b2y, b2rx, b2ry, 0, 0, Math.PI * 2);
      }
      return;
    }
    if (sh === 'speech' && typeof ctx.moveTo === 'function' && typeof ctx.lineTo === 'function') {
      const bodyH = 0.82 * h;
      const r = Math.min(w / 2, bodyH / 2, Math.min(w, bodyH) * 0.28);
      const tailL = Math.max(r + 1, 0.26 * w);
      const tailR = Math.min(w - r - 1, Math.max(tailL + 4, 0.42 * w));
      const qCurve = typeof ctx.quadraticCurveTo === 'function'
        ? (cx, cy, ex, ey) => ctx.quadraticCurveTo(cx, cy, ex, ey)
        : (_cx, _cy, ex, ey) => ctx.lineTo(ex, ey);
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      qCurve(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + bodyH - r);
      qCurve(x + w, y + bodyH, x + w - r, y + bodyH);
      ctx.lineTo(x + tailR, y + bodyH);
      ctx.lineTo(x + 0.22 * w, y + 0.99 * h);
      ctx.lineTo(x + tailL, y + bodyH);
      ctx.lineTo(x + r, y + bodyH);
      qCurve(x, y + bodyH, x, y + bodyH - r);
      ctx.lineTo(x, y + r);
      qCurve(x, y, x + r, y);
      if (typeof ctx.closePath === 'function') ctx.closePath();
      return;
    }
    if (sh === 'heart' && typeof ctx.moveTo === 'function') {
      traceCubicSegments(ctx, x, y, w, h, 0.50, 0.21, heartContourCurves());
      return;
    }
    if (typeof ctx.rect === 'function') ctx.rect(x, y, w, h);
  }

  const _histR = new Uint32Array(256);
  const _histG = new Uint32Array(256);
  const _histB = new Uint32Array(256);
  function histMedian(hist, total) {
    const target = Math.floor(total / 2);
    let acc = 0;
    for (let v = 0; v < 256; v += 1) {
      acc += hist[v];
      if (acc > target) return v;
    }
    return 255;
  }
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
    _histR.fill(0); _histG.fill(0); _histB.fill(0);
    let count = 0;
    const Ls = [];
    strips.forEach(([x, y, w, h]) => {
      x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
      w = Math.min(W - x, Math.round(w)); h = Math.min(H - y, Math.round(h));
      if (w <= 0 || h <= 0) return;
      const d = ctx.getImageData(x, y, w, h).data;
      for (let i = 0; i < d.length; i += 4) {
        const rv = d[i], gv = d[i + 1], bv = d[i + 2];
        _histR[rv] += 1; _histG[gv] += 1; _histB[bv] += 1;
        if (count % 3 === 0) Ls.push(lum(rv, gv, bv));
        count += 1;
      }
    });
    if (!count) return { r: 255, g: 255, b: 255, uniform: true };
    const r = histMedian(_histR, count), g = histMedian(_histG, count), b = histMedian(_histB, count);
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
      if (style.fontFamily) next.fontFamily = style.fontFamily;
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
    const blockFont = resolveFontStack(st?.fontFamily);
    const baseFont = `${baseFontPrefix(st)}${size}px ${blockFont}`;
    let curFont = baseFont;
    ctx.font = baseFont;
    const spaceW = ctx.measureText(' ').width;
    const widths = line.map((w) => {
      const wFont = w.fontFamily ? resolveFontStack(w.fontFamily) : blockFont;
      const nextFont = `${inlineFontPrefix(st, w)}${effWordSize(w, size, st)}px ${wFont}`;
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
    const blockFont = resolveFontStack(st?.fontFamily);
    const baseFont = `${baseFontPrefix(st)}${size}px ${blockFont}`;
    let curFont = baseFont;
    ctx.font = baseFont;
    const spaceW = ctx.measureText(' ').width;
    const widthOf = (w) => {
      const wFont = w.fontFamily ? resolveFontStack(w.fontFamily) : blockFont;
      const nextFont = `${inlineFontPrefix(st, w)}${effWordSize(w, size, st)}px ${wFont}`;
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

  function fit(ctx, text, boxW, boxH, maxSize, minSize, fontPrefix = '700 ', fontStack = FONT) {
    const paragraphs = splitParagraphWords(text);
    for (let s = maxSize; s >= minSize; s--) {
      ctx.font = `${fontPrefix}${s}px ${fontStack}`;
      const { lines, widest } = wrapParagraphWords(ctx, paragraphs, boxW);
      const lh = s * 1.55;
      if (lines.length * lh <= boxH && widest <= boxW * 1.04) return { size: s, lines, lh };
    }
    ctx.font = `${fontPrefix}${minSize}px ${fontStack}`;
    return { size: minSize, lines: wrapParagraphWords(ctx, paragraphs, boxW).lines, lh: minSize * 1.55 };
  }

  // قالب‌بندی هر بلوک با پیش‌فرض‌های ایمن برای بلوک‌های قدیمی (ذخیره‌شده قبل از نسخهٔ ۲.۲۸)
  function blockStyle(b) {
    const isHeading = b.pageRole === 'heading';
    const rawFf = String(b.fontFamily || '').trim();
    return {
      dir: b.dir === 'ltr' ? 'ltr' : 'rtl',       // جهت متن: پیش‌فرض راست‌به‌چپ
      align: ['center', 'left', 'justify'].includes(b.align) ? b.align : 'right', // physical alignment; old projects default right
      verticalAlign: ['top', 'bottom'].includes(b.verticalAlign) ? b.verticalAlign : 'middle', // old projects keep their centred layout
      bold: b.bold !== false,           // پیش‌فرض مثل گذشته: پررنگ
      italic: !!b.italic,
      underline: !!b.underline,
      strike: !!b.strike,
      size: Number.isFinite(+b.size) && +b.size > 0 ? +b.size : null,
      color: /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : null, // null = رنگ خودکار بر اساس پس‌زمینه
      fontFamily: rawFf || null,
      shape: normalizeBoxShape(b.shape),
      cornerRadius: normalizeCornerRadius(b.cornerRadius),
      angle: normalizeBoxAngle(b.angle),
      firstLineIndent: !isHeading && Number.isFinite(+b.firstLineIndent) && +b.firstLineIndent > 0 ? Math.min(4, +b.firstLineIndent) : 0,
      hangingIndent: !isHeading && Number.isFinite(+b.hangingIndent) && +b.hangingIndent > 0 ? Math.min(4, +b.hangingIndent) : 0,
    };
  }

  function indentGeometry(st, padX, size) {
    const hangPx = st.hangingIndent > 0 ? Math.round(st.hangingIndent * size) : 0;
    const textIndentPx = hangPx > 0 ? -hangPx : (st.firstLineIndent > 0 ? Math.round(st.firstLineIndent * size) : 0);
    const padLeft = padX + (st.dir === 'ltr' ? hangPx : 0);
    const padRight = padX + (st.dir === 'rtl' ? hangPx : 0);
    return { textIndentPx, padLeft, padRight, hangPx };
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

  function releaseCaches() {
    if (!domMeasureState) return;
    if (domMeasureState.box) {
      domMeasureState.box.replaceChildren();
      domMeasureState.box.removeAttribute('style');
    }
  }

  function fitDomSizeFast(box, tpl, st, bw, padX, usableW, usableH, startSize, minSize) {
    const fitsAt = (s) => {
      applyDomLayoutStyles(box, tpl, st, bw, padX, s);
      return box.scrollHeight <= usableH + 0.75 && box.scrollWidth <= bw + usableW * 0.04 + 0.5;
    };
    const hiStart = Math.max(minSize, startSize);
    for (let s = hiStart; s >= Math.max(minSize, hiStart - 2); s -= 1) {
      if (fitsAt(s)) return s;
    }
    let lo = minSize, hi = hiStart - 3, best = minSize;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (fitsAt(mid)) { best = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    while (best + 1 <= hiStart - 3 && fitsAt(best + 1)) best += 1;
    return best;
  }

  function applyDomLayoutStyles(box, tpl, st, bw, padX, size) {
    box.replaceChildren(tpl.content.cloneNode(true));
    box.dir = st.dir;
    const ind = indentGeometry(st, padX, size);
    const blockFont = resolveFontStack(st?.fontFamily);
    box.style.cssText = [
      'position:absolute', 'left:0', 'top:0', 'box-sizing:border-box',
      `width:${bw}px`, `padding:0px ${ind.padRight}px 0px ${ind.padLeft}px`, 'margin:0', 'border:0',
      `font-family:${blockFont}`, `font-size:${size}px`, 'line-height:1.55',
      `font-weight:${st.bold ? '700' : '400'}`, `font-style:${st.italic ? 'italic' : 'normal'}`,
      'white-space:pre-line', 'text-justify:inter-word',
      `text-indent:${ind.textIndentPx}px`,
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
    const { padX, padY } = shapeInsets(bw, bh, st.shape, st.cornerRadius);
    const usableW = Math.max(1, bw - 2 * padX), usableH = Math.max(1, bh - 2 * padY);
    const sourceText = String(b.tr || '').trim();
    const richWords = richWordsOpt !== null ? richWordsOpt : (!b._plainText && b.richHtml ? richHtmlWords(b.richHtml) : null);
    const maxSize = Math.max(12, Math.min(64, Math.round(b.lineH * 1.1)));
    const inline = st.align === 'justify' || (!b._plainText && (!!b.richHtml || hasInlineMarks(sourceText)));
    const fontPrefix = `${st.italic ? 'italic ' : ''}${st.bold ? '700' : '400'} `;
    const blockFont = resolveFontStack(st?.fontFamily);
    if (inline) {
      const inWords = b._plainText ? plainWords(sourceText) : (richWords || inlineWords(sourceText));
      if (st.size) {
        const lines = wrapInlineAt(ctx, inWords, usableW, st, st.size);
        return { inline: true, size: st.size, lines, lh: st.size * 1.55, lineLh: lineHeightsFor(lines, st, st.size) };
      }
      return Object.assign({ inline: true }, fitInline(ctx, inWords, usableW, usableH, maxSize, 7, st));
    }
    if (st.size) {
      ctx.font = `${fontPrefix}${st.size}px ${blockFont}`;
      return { inline: false, size: st.size, lines: wrapWords(ctx, sourceText, usableW), lh: st.size * 1.55 };
    }
    return Object.assign({ inline: false }, fit(ctx, sourceText, usableW, usableH, maxSize, 7, fontPrefix, blockFont));
  }

  function resolveDomNodeStyle(node, rootBox, st, baseSize) {
    let bold = st.bold !== false, italic = !!st.italic, underline = !!st.underline, strike = !!st.strike;
    let size = baseSize, color = null, dir = st.dir, fontFamily = st.fontFamily || null;
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
      if (el.style?.fontFamily) fontFamily = el.style.fontFamily;
      const d = el.style?.direction || el.getAttribute('dir');
      if (d === 'ltr' || d === 'rtl') dir = d;
    });
    return { bold, italic, underline, strike, size, color, dir, fontFamily };
  }

  function domLayoutBlock(ctx, b, st, bw, bh, richWordsOpt = null) {
    const rawHtml = blockRawLayoutHtml(b);
    if (hasSpecialRichElements(rawHtml)) return null;
    const box = getDomMeasureBox();
    if (!box) return null;
    const { padX, padY, padTop = padY, padBottom = padY } = shapeInsets(bw, bh, st.shape, st.cornerRadius);
    const usableW = Math.max(1, bw - 2 * padX), usableH = Math.max(1, bh - padTop - padBottom);
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
        size = fitDomSizeFast(box, tpl, st, bw, padX, usableW, usableH, startSize, 7);
        if (Number.parseFloat(box.style.fontSize) !== size) applyDomLayoutStyles(box, tpl, st, bw, padX, size);
      }
    } else {
      applyDomLayoutStyles(box, tpl, st, bw, padX, size);
    }

    const rawScrollH = box.scrollHeight;
    const contentH = rawScrollH > 0 ? rawScrollH : size * 1.55;
    const topUnscaled = st.verticalAlign === 'top' ? padTop
      : st.verticalAlign === 'bottom' ? bh - padBottom - contentH
      : padTop + (bh - padTop - padBottom - contentH) / 2;

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
            dir, bold: ns.bold, italic: ns.italic, underline: ns.underline, strike: ns.strike, size: ns.size, color: ns.color, fontFamily: ns.fontFamily
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
            dir, bold: ns.bold, italic: ns.italic, underline: ns.underline, strike: ns.strike, size: ns.size, color: ns.color, fontFamily: ns.fontFamily
          });
          i = j;
        }
      }
    }
    r.detach?.();
    tpl.innerHTML = '';
    box.replaceChildren();
    box.removeAttribute('style');
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
        const { padX, padY } = shapeInsets(bw, bh, st.shape, st.cornerRadius);
        const usableW = Math.max(1, bw - 2 * padX), usableH = Math.max(1, bh - 2 * padY);
        const tpl = buildSafeDomTemplate(rawHtml);
        const jsEst = computeJsFit(ctx, b, st, bw, bh).size;
        const startSize = Math.min(maxSize, jsEst + 2);
        const chosen = fitDomSizeFast(box, tpl, st, bw, padX, usableW, usableH, startSize, 8);
        tpl.innerHTML = '';
        box.replaceChildren();
        box.removeAttribute('style');
        return chosen;
      }
    }
    return computeJsFit(ctx, b, st, bw, bh).size;
  }

  function applyBoxRotationTransform(ctx, cx, cy, angleDeg) {
    if (!angleDeg || typeof ctx.translate !== 'function' || typeof ctx.rotate !== 'function') return;
    ctx.translate(cx, cy);
    ctx.rotate((angleDeg * Math.PI) / 180);
    ctx.translate(-cx, -cy);
  }

  // bmp: تصویر اصلی؛ blocks: بلوک‌ها؛ برمی‌گرداند canvas نهایی
  function render(bmp, blocks, opts) {
    const o = Object.assign({ createCanvas: null, eraseOriginal: true }, opts);
    const mk = o.createCanvas || ((w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; });
    const W = bmp.width, H = bmp.height;
    const cv = mk(W, H);
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    // Paint box backgrounds first so no later box fill can cover an earlier translation's text.
    const sourceErases = [], targetFills = [], textJobs = [];
    const ascentCache = new Map();

    blocks.forEach((b) => {
      if (!b.enabled) return;
      const sourceText = String(b.tr || '').trim();
      const richWords = !b._plainText && b.richHtml ? richHtmlWords(b.richHtml) : null;
      const hasText = Boolean(
        sourceText
        || richWords?.some((word) => String(word.t || '').trim())
        || (typeof b._liveHtml === 'string' && b._liveHtml.replace(/<[^>]*>/g, '').trim())
      );
      const st = blockStyle(b);
      const hasManualShapeBg = Boolean(
        b.manual
        && b.bg
        && b.bg !== 'none'
        && (st.shape !== 'rect' || st.cornerRadius > 0)
      );
      if (!hasText && !hasManualShapeBg) return;
      const layoutBox = {
        x0: Math.max(0, Number.isFinite(b.tx0) ? b.tx0 : b.x0),
        y0: Math.max(0, Number.isFinite(b.ty0) ? b.ty0 : b.y0),
        x1: Math.min(W, Number.isFinite(b.tx1) ? b.tx1 : b.x1),
        y1: Math.min(H, Number.isFinite(b.ty1) ? b.ty1 : b.y1)
      };
      const bw = layoutBox.x1 - layoutBox.x0, bh = layoutBox.y1 - layoutBox.y0;
      if (bw <= 0 || bh <= 0) return;
      const cx = layoutBox.x0 + bw / 2, cy = layoutBox.y0 + bh / 2;
      const isPlainAxisRect = st.shape === 'rect' && st.cornerRadius <= 0 && !st.angle;
      const blockFont = resolveFontStack(st.fontFamily);

      let targetFill = null, txt = '#0b0b0b', stroke = null;
      if (b.bg === 'none' || (o.eraseOriginal === false && (!b.bg || b.bg === 'auto'))) {
        txt = '#ffffff'; stroke = '#000000';
      } else if (b.bg === 'white') { targetFill = '#ffffff'; }
      else if (b.bg === 'black') { targetFill = '#000000'; txt = '#fafafa'; }
      else if (/^#[0-9a-fA-F]{6}$/.test(String(b.bg || ''))) {
        const hex = String(b.bg);
        targetFill = hex;
        const rv = parseInt(hex.slice(1, 3), 16), gv = parseInt(hex.slice(3, 5), 16), bv = parseInt(hex.slice(5, 7), 16);
        txt = lum(rv, gv, bv) > 150 ? '#0b0b0b' : '#fafafa';
      } else {
        const targetBg = sampleBg(ctx, layoutBox, W, H);
        targetFill = `rgb(${targetBg.r},${targetBg.g},${targetBg.b})`;
        txt = lum(targetBg.r, targetBg.g, targetBg.b) > 150 ? '#0b0b0b' : '#fafafa';
      }
      // If an OCR box was rotated or reshaped (ellipse/diamond/rounded), erase the original source
      // text rectangle underneath with sampled bubble background so old corners don't peek out.
      if (!isPlainAxisRect && !b.manual && o.eraseOriginal !== false && b.bg !== 'none') {
        const ox0 = Math.max(0, Number(b.x0) || 0), oy0 = Math.max(0, Number(b.y0) || 0);
        const ox1 = Math.min(W, Number(b.x1) || 0), oy1 = Math.min(H, Number(b.y1) || 0);
        if (ox1 > ox0 && oy1 > oy0) {
          const origBg = sampleBg(ctx, { x0: ox0, y0: oy0, x1: ox1, y1: oy1 }, W, H);
          sourceErases.push([`rgb(${origBg.r},${origBg.g},${origBg.b})`, ox0, oy0, ox1 - ox0, oy1 - oy0]);
        }
      }
      // رنگ دستی کاربر بر انتخاب خودکار اولویت دارد (زیرخط هم با همین رنگ رسم می‌شود)
      if (st.color) txt = st.color;
      if (targetFill) targetFills.push({ style: targetFill, x: layoutBox.x0, y: layoutBox.y0, w: bw, h: bh, cx, cy, st, isPlainAxisRect });
      if (!hasText) return;

      // در مرورگر واقعی، جایگاه دقیق کلمه‌ها مستقیماً از همان جعبهٔ چیدمان DOM خوانده می‌شود
      // تا متنِ زمان تایپ، مکان‌نما و خروجی نهایی روی عکس از یک موتور واحد و بدون حتی ۱ پیکسل اختلاف بیایند.
      const domLayout = !o.createCanvas ? domLayoutBlock(ctx, b, st, bw, bh, richWords) : null;
      if (domLayout) {
        textJobs.push(() => {
          ctx.save();
          if (st.angle) applyBoxRotationTransform(ctx, cx, cy, st.angle);
          drawBoxShapePath(ctx, layoutBox.x0, layoutBox.y0, bw, bh, st.shape, st.cornerRadius);
          ctx.clip();
          ctx.textAlign = 'left';
          domLayout.fragments.forEach((frag) => {
            const fragFont = frag.fontFamily ? resolveFontStack(frag.fontFamily) : blockFont;
            const fontSpec = `${frag.italic ? 'italic ' : ''}${frag.bold ? '700' : '400'} ${frag.size}px ${fragFont}`;
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

      const { padX, padY, padTop = padY, padBottom = padY } = shapeInsets(bw, bh, st.shape, st.cornerRadius);
      const usableW = Math.max(1, bw - 2 * padX);
      const f = computeJsFit(ctx, b, st, bw, bh, richWords);
      const inline = f.inline;
      textJobs.push(() => {
      // Keep the actual output inside the editable translation box, even for manually enlarged text.
      ctx.save();
      if (st.angle) applyBoxRotationTransform(ctx, cx, cy, st.angle);
      drawBoxShapePath(ctx, layoutBox.x0, layoutBox.y0, bw, bh, st.shape, st.cornerRadius);
      ctx.clip();
      if ('direction' in ctx) ctx.direction = st.dir;
      ctx.textBaseline = 'middle';
      const totalH = inline ? f.lineLh.reduce((sum, v) => sum + v, 0) : f.lines.length * f.lh;
      // Top/bottom anchor the entire text block, including wrapped and blank lines.
      // Preserve centred placement for symmetric shapes while shifting away from bottom tails/bubbles.
      const textTop = st.verticalAlign === 'top' ? layoutBox.y0 + padTop
        : st.verticalAlign === 'bottom' ? layoutBox.y1 - padBottom - totalH
        : layoutBox.y0 + padTop + (bh - padTop - padBottom - totalH) / 2;
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
            const wFont = w.fontFamily ? resolveFontStack(w.fontFamily) : blockFont;
            ctx.font = `${inlineFontPrefix(st, w)}${wSize}px ${wFont}`;
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
            if (st.strike || w.strike) {
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
      ctx.font = `${baseFontPrefix(st)}${f.size}px ${blockFont}`;
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
        if (st.strike) {
          const lineW = ctx.measureText(ln).width;
          const sx = st.align === 'left' ? anchorX : st.align === 'center' ? anchorX - lineW / 2 : anchorX - lineW;
          const sy = y - f.size * 0.2;
          ctx.strokeStyle = txt;
          ctx.lineWidth = Math.max(1, f.size / 14);
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(sx + lineW, sy);
          ctx.stroke();
        }
        y += f.lh;
      });
      ctx.restore();
      });
    });
    sourceErases.forEach(([style, x, y, width, height]) => { ctx.fillStyle = style; ctx.fillRect(x, y, width, height); });
    targetFills.forEach((item) => {
      if (item.isPlainAxisRect) {
        ctx.fillStyle = item.style;
        ctx.fillRect(item.x, item.y, item.w, item.h);
        return;
      }
      ctx.save();
      if (item.st.angle) applyBoxRotationTransform(ctx, item.cx, item.cy, item.st.angle);
      drawBoxShapePath(ctx, item.x, item.y, item.w, item.h, item.st.shape, item.st.cornerRadius);
      ctx.fillStyle = item.style;
      if (typeof ctx.fill === 'function') ctx.fill();
      else ctx.fillRect(item.x, item.y, item.w, item.h);
      ctx.restore();
    });
    textJobs.forEach((paintText) => paintText());
    if (hasActiveWatermark(o.watermark)) {
      drawWatermark(ctx, W, H, o.watermark, o.watermarkLogos);
    }
    return cv;
  }

  const RTL_WM_RE = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

  function hasActiveWatermark(wm) {
    if (!wm || typeof wm !== 'object' || wm.enabled === false) return false;
    const text = String(wm.text || '').trim();
    const hasLogo = Boolean((wm.logoId && String(wm.logoId).trim()) || (wm.logoDataUrl && String(wm.logoDataUrl).trim()));
    return Boolean(text || hasLogo);
  }

  function roundedRectPath(ctx, x, y, w, h, r) {
    const rad = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, rad);
      return;
    }
    if (typeof ctx.moveTo === 'function' && typeof ctx.arcTo === 'function') {
      ctx.moveTo(x + rad, y);
      ctx.arcTo(x + w, y, x + w, y + h, rad);
      ctx.arcTo(x + w, y + h, x, y + h, rad);
      ctx.arcTo(x, y + h, x, y, rad);
      ctx.arcTo(x, y, x + w, y, rad);
      if (typeof ctx.closePath === 'function') ctx.closePath();
      return;
    }
  }

  function resolveLogoDrawable(wm, logosMap) {
    if (!wm || typeof wm !== 'object') return null;
    const map = logosMap && typeof logosMap === 'object' ? logosMap : null;
    if (wm._logoDrawable) return wm._logoDrawable;
    const logoId = String(wm.logoId || '').trim();
    if (logoId && map) {
      const entry = map instanceof Map ? map.get(logoId) : map[logoId];
      if (!entry) return null;
      if (entry._drawable) return entry._drawable;
      if (typeof entry.width === 'number' && typeof entry.height === 'number' && !entry.dataUrl) return entry;
    }
    return null;
  }

  function drawWatermarkStamp(ctx, W, H, wm, logoImg, stampOpts) {
    const textRaw = String(wm.text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    const lines = textRaw ? textRaw.split('\n').map((s) => s.trim()).filter(Boolean) : [];
    if (!lines.length && !logoImg) return null;
    const minDim = Math.max(200, Math.min(W, H));
    const scalePct = Math.max(1.0, Math.min(25.0, Number(wm.sizePct) || 3.5));
    const fontPx = Math.max(12, Math.round(minDim * (scalePct / 100)));
    const bold = wm.bold !== false;
    const color = /^#[0-9a-fA-F]{6}$/.test(String(wm.color || '').trim()) ? String(wm.color).trim() : '#ffffff';
    const outline = wm.outline !== false;
    const outlineColor = /^#[0-9a-fA-F]{6}$/.test(String(wm.outlineColor || '').trim()) ? String(wm.outlineColor).trim() : '#000000';
    const bgPill = Boolean(wm.bgPill);
    const bgColor = /^#[0-9a-fA-F]{6}$/.test(String(wm.bgColor || '').trim()) ? String(wm.bgColor).trim() : '#000000';
    const fontSpec = `${bold ? '700' : '400'} ${fontPx}px ${FONT}`;

    ctx.font = fontSpec;
    const lh = Math.max(fontPx + 4, Math.round(fontPx * 1.32));
    const lineWidths = lines.map((ln) => Math.max(1, Math.ceil((typeof ctx.measureText === 'function' ? ctx.measureText(ln)?.width : 0) || (ln.length * fontPx * 0.55))));
    const textW = lineWidths.length ? Math.max(...lineWidths) : 0;
    const textH = lines.length ? lines.length * lh : 0;

    let logoW = 0, logoH = 0;
    if (logoImg) {
      const srcW = Math.max(1, Number(logoImg.naturalWidth || logoImg.width || 64));
      const srcH = Math.max(1, Number(logoImg.naturalHeight || logoImg.height || 64));
      const logoScalePct = Math.max(2.0, Math.min(45.0, Number(wm.logoScalePct) || Math.max(6.0, scalePct * 2.2)));
      const targetMax = Math.max(20, Math.round(minDim * (logoScalePct / 100)));
      const ratio = Math.min(targetMax / srcW, targetMax / srcH);
      logoW = Math.max(12, Math.round(srcW * ratio));
      logoH = Math.max(12, Math.round(srcH * ratio));
    }

    const gap = (logoW && textW) ? Math.max(6, Math.round(fontPx * 0.42)) : 0;
    const padX = bgPill ? Math.max(10, Math.round(fontPx * 0.58)) : Math.max(4, Math.round(fontPx * 0.2));
    const padY = bgPill ? Math.max(6, Math.round(fontPx * 0.36)) : Math.max(4, Math.round(fontPx * 0.2));
    const contentW = logoW + gap + textW;
    const contentH = Math.max(logoH, textH, 1);
    const boxW = contentW + padX * 2;
    const boxH = contentH + padY * 2;

    if (stampOpts?.measureOnly) {
      return { boxW, boxH, fontPx };
    }

    const cx = Number(stampOpts?.cx) || W / 2;
    const cy = Number(stampOpts?.cy) || H / 2;
    const angleDeg = Number(stampOpts?.angleDeg) || 0;
    const opacity = Math.max(0.05, Math.min(1.0, (Number(wm.opacity) || 55) / 100));
    const isRtl = lines.some((ln) => RTL_WM_RE.test(ln));

    ctx.save?.();
    ctx.globalAlpha = opacity;
    if (typeof ctx.translate === 'function') ctx.translate(cx, cy);
    if (angleDeg && typeof ctx.rotate === 'function') ctx.rotate((angleDeg * Math.PI) / 180);

    const x0 = typeof ctx.translate === 'function' ? -boxW / 2 : cx - boxW / 2;
    const y0 = typeof ctx.translate === 'function' ? -boxH / 2 : cy - boxH / 2;

    if (bgPill) {
      ctx.save?.();
      ctx.globalAlpha = opacity * 0.58;
      ctx.fillStyle = bgColor;
      if ((typeof ctx.roundRect === 'function' || typeof ctx.arcTo === 'function') && typeof ctx.fill === 'function') {
        roundedRectPath(ctx, x0, y0, boxW, boxH, Math.max(6, Math.round(fontPx * 0.42)));
        ctx.fill();
      } else {
        ctx.fillRect?.(x0, y0, boxW, boxH);
      }
      ctx.restore?.();
    }

    // In RTL, place logo on the right side of text (or left in LTR) for natural reading order.
    let logoX = x0 + padX;
    let textLeft = x0 + padX + (logoW ? logoW + gap : 0);
    if (isRtl && logoW && textW) {
      textLeft = x0 + padX;
      logoX = x0 + padX + textW + gap;
    }

    if (logoImg && logoW > 0 && logoH > 0) {
      const logoY = y0 + Math.round((boxH - logoH) / 2);
      ctx.drawImage?.(logoImg, logoX, logoY, logoW, logoH);
    }

    if (lines.length) {
      ctx.font = fontSpec;
      ctx.textBaseline = 'middle';
      if ('direction' in ctx) ctx.direction = isRtl ? 'rtl' : 'ltr';
      ctx.textAlign = 'center';
      const textCenterX = textLeft + textW / 2;
      let curY = y0 + (boxH - textH) / 2 + lh / 2;
      const strokeW = Math.max(2, Math.round(fontPx * 0.14));
      lines.forEach((ln) => {
        if (outline && typeof ctx.strokeText === 'function') {
          ctx.lineWidth = strokeW;
          ctx.strokeStyle = outlineColor;
          ctx.lineJoin = 'round';
          ctx.strokeText(ln, textCenterX, curY);
        }
        ctx.fillStyle = color;
        ctx.fillText?.(ln, textCenterX, curY);
        curY += lh;
      });
    }
    ctx.restore?.();
    return { boxW, boxH, fontPx };
  }

  function drawWatermark(ctx, W, H, wm, logosMap) {
    if (!hasActiveWatermark(wm) || !ctx || W <= 0 || H <= 0) return false;
    const logoImg = resolveLogoDrawable(wm, logosMap);
    const measured = drawWatermarkStamp(ctx, W, H, wm, logoImg, { measureOnly: true });
    if (!measured) return false;

    const position = ['bottom-left', 'bottom-right', 'top-left', 'top-right', 'center', 'diagonal', 'tile'].includes(String(wm.position || ''))
      ? String(wm.position)
      : 'bottom-left';
    const minDim = Math.max(200, Math.min(W, H));
    const marginPct = Math.max(0.5, Math.min(20.0, Number(wm.marginPct ?? 2.5)));
    const marginPx = Math.max(8, Math.round(minDim * (marginPct / 100)));
    const rawAngle = wm.angle !== undefined && wm.angle !== null && wm.angle !== ''
      ? Number(wm.angle)
      : (position === 'diagonal' || position === 'tile' ? -30 : 0);
    const angleDeg = Math.max(-90, Math.min(90, Number.isFinite(rawAngle) ? rawAngle : 0));

    if (position === 'tile') {
      const tileGapPct = Math.max(6.0, Math.min(60.0, Number(wm.tileGapPct) || 22.0));
      const rad = Math.abs((angleDeg * Math.PI) / 180);
      const rotW = Math.abs(measured.boxW * Math.cos(rad)) + Math.abs(measured.boxH * Math.sin(rad));
      const rotH = Math.abs(measured.boxW * Math.sin(rad)) + Math.abs(measured.boxH * Math.cos(rad));
      const stepX = Math.max(Math.round(rotW) + 28, Math.round(W * (tileGapPct / 100)) + Math.round(rotW * 0.55));
      const stepY = Math.max(Math.round(rotH) + 24, Math.round(H * (tileGapPct / 100) * 0.85) + Math.round(rotH * 0.55));
      let rowIdx = 0;
      for (let cy = Math.round(-rotH / 2); cy < H + Math.round(rotH); cy += stepY) {
        const offsetX = rowIdx % 2 === 1 ? Math.round(stepX / 2) : 0;
        for (let cx = Math.round(-rotW / 2) + offsetX; cx < W + Math.round(rotW); cx += stepX) {
          drawWatermarkStamp(ctx, W, H, wm, logoImg, { cx, cy, angleDeg });
        }
        rowIdx += 1;
      }
      return true;
    }

    const rad = Math.abs((angleDeg * Math.PI) / 180);
    const effW = angleDeg ? Math.abs(measured.boxW * Math.cos(rad)) + Math.abs(measured.boxH * Math.sin(rad)) : measured.boxW;
    const effH = angleDeg ? Math.abs(measured.boxW * Math.sin(rad)) + Math.abs(measured.boxH * Math.cos(rad)) : measured.boxH;
    let cx = W / 2, cy = H / 2;
    if (position === 'bottom-left') {
      cx = marginPx + effW / 2;
      cy = H - marginPx - effH / 2;
    } else if (position === 'bottom-right') {
      cx = W - marginPx - effW / 2;
      cy = H - marginPx - effH / 2;
    } else if (position === 'top-left') {
      cx = marginPx + effW / 2;
      cy = marginPx + effH / 2;
    } else if (position === 'top-right') {
      cx = W - marginPx - effW / 2;
      cy = marginPx + effH / 2;
    }
    cx = Math.max(effW / 2, Math.min(W - effW / 2, cx));
    cy = Math.max(effH / 2, Math.min(H - effH / 2, cy));
    drawWatermarkStamp(ctx, W, H, wm, logoImg, { cx, cy, angleDeg });
    return true;
  }

  function lineAnchorCenter(layoutBox) {
    return (layoutBox.x0 + layoutBox.x1) / 2;
  }

  const api = {
    FONT, FONT_STACKS, BOX_SHAPES,
    resolveFontStack, normalizeBoxShape, normalizeCornerRadius, normalizeBoxAngle,
    shapeInsets, shapeSvgPath, drawBoxShapePath,
    render, releaseCaches, sampleBg, fit, wrapWords, blockStyle, boxInset, indentGeometry, fitBlockSize,
    hasInlineMarks, tokenizeInline, inlineMarksToHtml, stripInlineMarkers, inlineWords, richHtmlWords, fitInline, visualLineOrder,
    hasActiveWatermark, drawWatermark
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Typeset = api;
})(typeof window !== 'undefined' ? window : globalThis);
