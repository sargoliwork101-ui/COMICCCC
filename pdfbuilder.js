// ساخت PDF از تصاویر: حالت عادی (هر تصویر یک صفحه) یا حالت چسبیده (بدون فاصله)
(function (root) {
  const SAFE_PT = 14300; // سقف هدف برای ارتفاع صفحه (محدودیت PDF/jsPDF: ۱۴۴۰۰)
  const HARD_PT = 14400; // حد سخت صفحه
  const OVERLAP = 0.4;   // هم‌پوشانی کوچک برای جلوگیری از خط سفید بین تصاویر

  // رایج‌ترین عرض بین تصاویر (در تساوی، عرض بزرگ‌تر)
  function pickWidth(items) {
    const cnt = new Map();
    items.forEach((it) => cnt.set(it.w, (cnt.get(it.w) || 0) + 1));
    let best = 0, bc = 0;
    cnt.forEach((c, w) => { if (c > bc || (c === bc && w > best)) { best = w; bc = c; } });
    return best;
  }

  // o: { jsPDF, items:[{w,h,...}], seamless, uniformWidth, prepare(it, r), fallback(seg), onProgress(k,n), onPage(n) }
  // prepare باید آرایه‌ای از {data, fmt, w, h, alias} برگرداند (ابعاد به پیکسل)
  async function build(o) {
    const seamless = !!o.seamless;
    const uniformWidth = !!o.uniformWidth;
    const maxW = o.items.length ? Math.max(...o.items.map((it) => it.w)) : 0;
    const W = seamless ? (uniformWidth ? maxW : pickWidth(o.items)) : 0;
    let s = 0.75; // پوینت به‌ازای هر پیکسل
    if (seamless) {
      // کل تصاویر در «یک» صفحه: مقیاس طوری انتخاب می‌شود که مجموع ارتفاع زیر سقف ۱۴۴۰۰ بماند
      let totalPx = 0;
      o.items.forEach((it) => { totalPx += it.h * (W / it.w); });
      s = Math.min(0.75, SAFE_PT / Math.max(totalPx, 1));
    }
    let pdf = null, pages = 0;

    const newPage = (pw, ph) => {
      const orient = pw > ph ? 'landscape' : 'portrait';
      if (!pdf) pdf = new o.jsPDF({ orientation: orient, unit: 'pt', format: [pw, ph], compress: true });
      else pdf.addPage([pw, ph], orient);
      pages++;
      if (o.onPage) o.onPage(pages);
    };

    const put = async (seg, y, pw, ph) => {
      const comp = seg.fmt === 'JPEG' ? 'NONE' : 'FAST';
      try {
        pdf.addImage(seg.data, seg.fmt, 0, y, pw, ph, seg.alias, comp);
      } catch (e) {
        if (!o.fallback) throw e;
        const d = await o.fallback(seg);
        pdf.addImage(d.data, d.fmt, 0, y, pw, ph, seg.alias + 'f', d.fmt === 'JPEG' ? 'NONE' : 'FAST');
      }
    };

    let pend = [], pendH = 0, pendW = 0;
    const flush = async () => {
      if (!pend.length) return;
      newPage(pendW, pendH);
      let y = 0;
      for (let k = 0; k < pend.length; k++) {
        const g = pend[k];
        await put(g.seg, y, pendW, g.hPt + (k < pend.length - 1 ? OVERLAP : 0));
        y += g.hPt;
      }
      pend = []; pendH = 0;
    };

    for (let k = 0; k < o.items.length; k++) {
      const it = o.items[k];
      if (o.onProgress) o.onProgress(k, o.items.length);
      const r = seamless ? (W / it.w) * s : uniformWidth ? (maxW / it.w) * s : s;
      const segs = await o.prepare(it, r);
      for (const seg of segs) {
        const wPt = seg.w * r, hPt = seg.h * r;
        if (seamless) {
          if (pendH + hPt > HARD_PT) await flush();
          pendW = wPt;
          pend.push({ seg, hPt });
          pendH += hPt;
        } else {
          newPage(wPt, hPt);
          await put(seg, 0, wPt, hPt);
        }
      }
    }
    await flush();
    if (o.onProgress) o.onProgress(o.items.length, o.items.length);
    return { pdf, pages };
  }

  const api = { build, SAFE_PT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PdfBuilder = api;
})(typeof window !== 'undefined' ? window : globalThis);
