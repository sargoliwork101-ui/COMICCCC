const $ = (id) => document.getElementById(id);

const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const ICON_ZOOM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></svg>';
const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/></svg>';
const ICON_CROP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v13a2 2 0 0 0 2 2h13M3 6h13a2 2 0 0 1 2 2v13"/></svg>';
const ICON_DUPLICATE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>';
const CONCURRENCY = 4;
const MAX_CANVAS_H = 16000;

let job = null;
let jobKey = '';
let items = [];
let loading = true;
let building = false;
let lastClicked = null;
let lastObjUrl = null;
let draggedItem = null;
let suppressCardClickUntil = 0;
let lbItem = null;
let cropItem = null;
let cropObjectUrl = null;
let cropRectDraft = null;
let cropDragStart = null;
let nextPageGroupId = 1;
let nextItemUid = 0;

// ---------- دانلود تصاویر ----------
async function setRefererRule(pageUrl) {
  try {
    const origin = new URL(pageUrl).origin + '/';
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [1],
      addRules: [{
        id: 1, priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: origin }] },
        condition: { resourceTypes: ['xmlhttprequest'], initiatorDomains: [chrome.runtime.id] }
      }]
    });
  } catch (e) { console.warn('Referer rule failed', e); }
}
async function clearRefererRule() {
  try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1] }); } catch (e) {}
}

function looksLikeImage(b) {
  return b && b.size > 0 && !/^(text|application\/json)/i.test(b.type || '');
}

async function fetchImageBlob(url, tabId) {
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (res.ok) {
      const b = await res.blob();
      if (looksLikeImage(b)) return b;
    }
  } catch (e) { /* روش دوم */ }

  if (tabId != null) {
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        args: [url],
        func: async (u) => {
          try {
            const res = await fetch(u, { credentials: 'include' });
            if (!res.ok) return null;
            const b = await res.blob();
            return await new Promise((resolve) => {
              const fr = new FileReader();
              fr.onloadend = () => resolve(fr.result);
              fr.readAsDataURL(b);
            });
          } catch (e) { return null; }
        }
      });
      if (r && r.result) {
        const b = await (await fetch(r.result)).blob();
        if (looksLikeImage(b)) return b;
      }
    } catch (e) { /* نادیده */ }
  }
  return null;
}

// ---------- تشخیص فرمت از روی بایت‌ها ----------
function sniff(u) {
  if (u.length > 30 && u[0] === 0xFF && u[1] === 0xD8 && u[2] === 0xFF) {
    let i = 2;
    while (i + 9 < u.length) {
      if (u[i] !== 0xFF) { i++; continue; }
      const m = u[i + 1];
      if (m === 0xFF) { i++; continue; }
      if (m === 0xC0 || m === 0xC1 || m === 0xC2) {
        const comps = u[i + 9];
        return { fmt: 'JPEG', h: (u[i + 5] << 8) | u[i + 6], w: (u[i + 7] << 8) | u[i + 8], ok: comps === 1 || comps === 3 };
      }
      if (m >= 0xC3 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { fmt: 'JPEG', ok: false };
      i += 2 + ((u[i + 2] << 8) | u[i + 3]);
    }
    return { fmt: 'JPEG', ok: false };
  }
  if (u.length > 33 && u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4E && u[3] === 0x47) {
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
    return { fmt: 'PNG', w: dv.getUint32(16), h: dv.getUint32(20), ok: u[24] <= 8 && u[28] === 0 };
  }
  return null;
}

async function analyze(it) {
  const u8 = new Uint8Array(await it.blob.arrayBuffer());
  let info = sniff(u8);
  if (!info || !info.w || !info.h) {
    try {
      const b = await createImageBitmap(it.blob, { imageOrientation: 'none' });
      info = { fmt: info ? info.fmt : null, ok: false, w: b.width, h: b.height };
      b.close();
    } catch (e) { info = null; }
  }
  it.info = info;
  if (info) { it.w = info.w; it.h = info.h; }
}

// ---------- کارت‌های پیش‌نمایش ----------
function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

function makeCard(it) {
  const el = document.createElement('div');
  el.className = 'item selected';
  el.draggable = true;
  el.title = 'برای تغییر ترتیب در PDF، تصویر را بکشید و رها کنید';
  el.innerHTML = `<div class="tw"><canvas width="240" height="320"></canvas><div class="spin">در حال دریافت...</div>
    <span class="idx">${it.i + 1}${it.dupNo ? ` · کپی ${it.dupNo}` : ''}</span><span class="tick">${ICON_CHECK}</span>
    <button class="zoom" title="مشاهدهٔ بزرگ">${ICON_ZOOM}</button>
    <button class="crop" title="کراپ دستی">${ICON_CROP}</button>
    <button class="edit" title="ویرایش ترجمه">${ICON_EDIT}</button>
    <button class="duplicate" title="ساخت نسخهٔ مستقل">${ICON_DUPLICATE}</button><span class="fa-badge">ترجمه شد</span>
    <span class="page-group-badge hidden"></span></div><div class="meta">…</div>
    <div class="order-control"><span>ترتیب در PDF</span><input class="page-order" type="number" min="1" step="1" value="${it.pdfOrder || it.i + 1}" aria-label="ترتیب در PDF"></div>
    <div class="scale-control"><span>اندازه در PDF (%)</span><input class="pdf-scale" type="number" min="25" max="200" step="5" value="${it.pdfScale || 100}" aria-label="اندازهٔ مستقل این تصویر در PDF، درصد"></div>`;
  const orderInput = el.querySelector('.page-order');
  const scaleInput = el.querySelector('.pdf-scale');
  scaleInput.addEventListener('click', (ev) => ev.stopPropagation());
  scaleInput.addEventListener('change', () => {
    const value = Number.parseFloat(scaleInput.value);
    it.pdfScale = Number.isFinite(value) ? Math.max(25, Math.min(200, value)) : 100;
    scaleInput.value = String(it.pdfScale);
  });
  orderInput.addEventListener('click', (ev) => ev.stopPropagation());
  orderInput.addEventListener('change', () => {
    const value = Number.parseInt(orderInput.value, 10);
    it.pdfOrder = Number.isFinite(value) && value > 0 ? value : (it.pdfOrder || it.i + 1);
    orderInput.value = String(it.pdfOrder);
    sortGridByPdfOrder();
  });
  el.addEventListener('dragstart', (ev) => {
    if (ev.target.closest('input, button, select, textarea')) { ev.preventDefault(); return; }
    draggedItem = it;
    el.classList.add('dragging');
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', String(it.uid));
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    draggedItem = null;
  });
  el.addEventListener('click', (ev) => {
    if (Date.now() < suppressCardClickUntil) { ev.preventDefault(); return; }
    if (ev.target.closest('.page-order, .pdf-scale')) return;
    if (ev.target.closest('.zoom')) { openLightbox(it); return; }
    if (ev.target.closest('.crop')) { openCropper(it); return; }
    if (ev.target.closest('.edit')) { if (typeof openEditor === 'function') openEditor(it); return; }
    if (ev.target.closest('.duplicate')) { duplicateItem(it); return; }
    if (it.state !== 'ok') return;
    if (ev.shiftKey && lastClicked != null) {
      const ordered = Array.from($('grid').children).map((node) => items.find((item) => item.el === node)).filter((item) => item && item.state === 'ok');
      const from = ordered.findIndex((item) => item.uid === lastClicked), to = ordered.findIndex((item) => item.uid === it.uid);
      if (from >= 0 && to >= 0) {
        const [a, b] = [Math.min(from, to), Math.max(from, to)];
        const val = !it.selected;
        for (let k = a; k <= b; k++) ordered[k].selected = val;
      }
    } else {
      it.selected = !it.selected;
    }
    lastClicked = it.uid;
    refreshAll();
  });
  it.el = el;
  return el;
}

function makeDuplicateData(source) {
  const { el, ...state } = source;
  return {
    ...state,
    uid: nextItemUid++,
    dupNo: items.filter((it) => it.i === source.i).length,
    selected: true,
    pageGroup: null,
    cropRect: source.cropRect ? { ...source.cropRect } : null,
    cropCache: null,
    pdfScale: source.pdfScale || 100,
    ocr: source.ocr ? { lang: source.ocr.lang, blocks: source.ocr.blocks.map((block) => ({ ...block })) } : null,
    edited: source.edited ? { ...source.edited } : null,
    el: null
  };
}
function duplicateItem(source) {
  if (!source || source.state !== 'ok') return;
  const duplicate = makeDuplicateData(source);
  const card = makeCard(duplicate);
  items.push(duplicate);
  $('grid').insertBefore(card, source.el.nextSibling);
  updatePdfOrderFromGrid();
  refreshAll();
  drawThumb(duplicate);
}

function refreshCard(it) {
  const el = it.el;
  el.classList.toggle('selected', !!it.selected);
  el.classList.toggle('failed', it.state === 'failed');
  el.classList.toggle('translated', !!it.edited);
  el.classList.toggle('cropped', !!it.cropRect);
  el.classList.toggle('has-ocr', !!it.ocr);
  const groupBadge = el.querySelector('.page-group-badge');
  groupBadge.classList.toggle('hidden', !it.pageGroup);
  if (it.pageGroup) {
    groupBadge.innerText = `گروه ${it.pageGroup}`;
    groupBadge.title = 'تصاویر این گروه در یک صفحهٔ PDF قرار می‌گیرند';
  }
  const meta = el.querySelector('.meta');
  const spin = el.querySelector('.spin');
  if (it.state === 'ok') {
    if (spin && spin.parentNode) spin.parentNode.removeChild(spin);
    meta.innerText = `${it.w}×${it.h} · ${fmtSize(it.blob.size)}`;
  } else if (it.state === 'failed') {
    if (spin && spin.parentNode) spin.parentNode.removeChild(spin);
    meta.innerText = 'دانلود نشد';
  } else {
    meta.innerText = '…';
  }
}

async function getDisplaySource(it) {
  const base = it.edited || it;
  const rect = it.cropRect;
  if (!rect) return base;
  const key = [rect.x, rect.y, rect.w, rect.h].join(':');
  if (it.cropCache && it.cropCache.base === base && it.cropCache.key === key) return it.cropCache;

  const bmp = await createImageBitmap(base.blob, { imageOrientation: 'none' });
  try {
    const x = Math.max(0, Math.min(bmp.width - 1, Math.round(rect.x * bmp.width)));
    const y = Math.max(0, Math.min(bmp.height - 1, Math.round(rect.y * bmp.height)));
    const w = Math.max(1, Math.min(bmp.width - x, Math.round(rect.w * bmp.width)));
    const h = Math.max(1, Math.min(bmp.height - y, Math.round(rect.h * bmp.height)));
    if (!canConvert(w, h)) throw new Error('ابعاد ناحیهٔ برش برای پردازش بیش از حد بزرگ است');
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(bmp, x, y, w, h, 0, 0, w, h);
    const blob = await canvasToBlob(cv, 'image/png');
    cv.width = cv.height = 0;
    const info = sniff(new Uint8Array(await blob.arrayBuffer()));
    it.cropCache = { i: it.i, blob, info, w, h, base, key };
    return it.cropCache;
  } finally { bmp.close(); }
}

async function drawThumb(it) {
  try {
    const src = await getDisplaySource(it);
    const bmp = await createImageBitmap(src.blob, { resizeWidth: 240, resizeQuality: 'medium' });
    const c = it.el.querySelector('canvas'), ctx = c.getContext('2d');
    ctx.fillStyle = '#171c26'; ctx.fillRect(0, 0, c.width, c.height);
    const dh = Math.min(bmp.height, c.height);
    const dy = bmp.height < c.height ? Math.round((c.height - bmp.height) / 2) : 0;
    ctx.drawImage(bmp, 0, 0, bmp.width, dh, 0, dy, bmp.width, dh);
    bmp.close();
  } catch (e) { console.warn('پیش‌نمایش تصویر ناموفق', e); }
}

async function loadOne(it) {
  it.state = 'loading';
  const blob = await fetchImageBlob(it.url, job.tabId);
  if (!blob) { it.state = 'failed'; it.selected = false; refreshCard(it); return; }
  it.blob = blob;
  try { await analyze(it); } catch (e) { it.info = null; }
  if (!it.info) { it.state = 'failed'; it.selected = false; it.blob = null; refreshCard(it); return; }
  it.state = 'ok';
  it.selected = true;
  refreshCard(it);
  drawThumb(it);
}

async function loadAll(list) {
  loading = true;
  $('loadText').parentNode.classList.remove('finished');
  let next = 0, done = 0;
  const total = list.length;
  const update = () => {
    $('loadBar').style.width = Math.round((done / total) * 100) + '%';
    $('loadText').innerText = `در حال دریافت تصاویر... ${done} از ${total}`;
    refreshSummary();
  };
  update();
  const worker = async () => {
    while (next < total) {
      const it = list[next++];
      await loadOne(it);
      done++;
      update();
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
  loading = false;
  $('loadText').parentNode.classList.add('finished');
  refreshAll();
}

// ---------- مرتب‌سازی کارت‌ها / ترتیب خروجی PDF ----------
function sortGridByPdfOrder() {
  const grid = $('grid');
  items.slice().sort((a, b) => (a.pdfOrder || a.i + 1) - (b.pdfOrder || b.i + 1) || a.uid - b.uid)
    .forEach((it) => grid.appendChild(it.el));
}

function updatePdfOrderFromGrid() {
  Array.from($('grid').children).forEach((el, index) => {
    const it = items.find((item) => item.el === el);
    if (!it) return;
    it.pdfOrder = index + 1;
    const input = el.querySelector('.page-order');
    if (input) input.value = String(it.pdfOrder);
  });
}

// ---------- انتخاب‌ها ----------
function refreshSummary() {
  const ok = items.filter((it) => it.state === 'ok').length;
  const selectedItems = items.filter((it) => it.state === 'ok' && it.selected);
  const sel = selectedItems.length;
  const failedN = items.filter((it) => it.state === 'failed').length;
  $('selCount').innerText = `${sel} از ${ok} تصویر انتخاب شده`;
  $('btnRetry').classList.toggle('hidden', failedN === 0 || loading);
  $('buildBtn').disabled = loading || building || sel === 0;
  $('saveImgBtn').disabled = loading || building || sel === 0;
  $('seamless').disabled = loading || building || $('twoPerPage').checked;
  $('twoPerPage').disabled = loading || building || $('seamless').checked;
  $('uniformWidth').disabled = loading || building;
  $('btnGroupPage').disabled = loading || building || sel < 2;
  $('btnGroupPage').innerText = `گروه‌بندی ${sel} تصویر در یک صفحه`;
  $('btnUngroupPage').disabled = loading || building || !selectedItems.some((it) => it.pageGroup);
  $('ocrEnabled').disabled = loading || building;
  $('btnTranslate').disabled = loading || building || ok === 0 || !$('ocrEnabled').checked;
  $('btnTxt').classList.toggle('hidden', !items.some((it) => it.ocr));
}
function refreshAll() { items.forEach(refreshCard); refreshSummary(); }
function groupSelectedItems() {
  const selected = items.filter((it) => it.state === 'ok' && it.selected);
  if (selected.length < 2) return;
  const groupId = nextPageGroupId++;
  selected.forEach((it) => { it.pageGroup = groupId; });
  refreshAll();
}
function ungroupSelectedItems() {
  items.filter((it) => it.state === 'ok' && it.selected).forEach((it) => { it.pageGroup = null; });
  refreshAll();
}

// ---------- نمایش بزرگ، کپی و کراپ دستی ----------
let lbUrl = null;
async function openLightbox(it) {
  if (!it.blob) return;
  try {
    const src = await getDisplaySource(it);
    lbItem = it;
    if (lbUrl) URL.revokeObjectURL(lbUrl);
    lbUrl = URL.createObjectURL(src.blob);
    $('lbImg').src = lbUrl;
    $('lightbox').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  } catch (e) { alert('بازکردن تصویر ناموفق بود: ' + (e.message || e)); }
}
function closeLightbox() {
  $('lightbox').classList.add('hidden');
  $('lbImg').removeAttribute('src');
  if (lbUrl) { URL.revokeObjectURL(lbUrl); lbUrl = null; }
  lbItem = null;
  document.body.style.overflow = '';
}

async function copyLightboxImage() {
  if (!lbItem) return;
  try {
    if (!navigator.clipboard || !window.ClipboardItem) throw new Error('مرورگر اجازهٔ کپی تصویر به کلیپ‌بورد را نمی‌دهد');
    const src = await getDisplaySource(lbItem);
    let blob = src.blob;
    if (blob.type !== 'image/png') {
      const bmp = await createImageBitmap(blob);
      const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
      cv.getContext('2d').drawImage(bmp, 0, 0); bmp.close();
      blob = await canvasToBlob(cv, 'image/png'); cv.width = cv.height = 0;
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    const btn = $('lbCopy');
    btn.innerText = 'کپی شد ✓';
    setTimeout(() => { if (btn.isConnected) btn.innerText = 'کپی تصویر'; }, 1400);
  } catch (e) { alert('کپی تصویر ناموفق بود: ' + (e.message || e)); }
}

function cropPoint(ev) {
  const r = $('cropImg').getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { x: Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)) };
}
function paintCropSelection(rect) {
  const el = $('cropSelection');
  if (!rect || rect.w <= 0 || rect.h <= 0) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.style.left = (rect.x * 100) + '%'; el.style.top = (rect.y * 100) + '%';
  el.style.width = (rect.w * 100) + '%'; el.style.height = (rect.h * 100) + '%';
}
async function openCropper(it) {
  if (!it || !it.blob) return;
  cropItem = it;
  cropRectDraft = it.cropRect ? { ...it.cropRect } : null;
  const base = it.edited || it;
  if (cropObjectUrl) URL.revokeObjectURL(cropObjectUrl);
  cropObjectUrl = URL.createObjectURL(base.blob);
  $('cropImg').src = cropObjectUrl;
  $('cropTitle').innerText = `کراپ تصویر ${it.i + 1}`;
  $('cropper').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  paintCropSelection(cropRectDraft);
}
function closeCropper() {
  $('cropper').classList.add('hidden');
  $('cropImg').removeAttribute('src');
  $('cropSelection').style.display = 'none';
  if (cropObjectUrl) { URL.revokeObjectURL(cropObjectUrl); cropObjectUrl = null; }
  cropItem = null; cropDragStart = null;
  document.body.style.overflow = '';
}
function applyCrop() {
  if (!cropItem) return;
  if (cropRectDraft === null) cropItem.cropRect = null;
  else if (cropRectDraft.w >= 0.01 && cropRectDraft.h >= 0.01) cropItem.cropRect = { ...cropRectDraft };
  cropItem.cropCache = null;
  const it = cropItem;
  closeCropper();
  refreshCard(it);
  drawThumb(it);
}
function beginCropSelection(ev) {
  if (!cropItem || ev.button !== 0) return;
  ev.preventDefault();
  const p = cropPoint(ev);
  if (!p) return;
  cropDragStart = p;
  cropRectDraft = { x: p.x, y: p.y, w: 0, h: 0 };
  paintCropSelection(cropRectDraft);
  $('cropStage').setPointerCapture(ev.pointerId);
}
function moveCropSelection(ev) {
  if (!cropDragStart) return;
  const p = cropPoint(ev);
  if (!p) return;
  const x = Math.min(p.x, cropDragStart.x), y = Math.min(p.y, cropDragStart.y);
  cropRectDraft = { x, y, w: Math.abs(p.x - cropDragStart.x), h: Math.abs(p.y - cropDragStart.y) };
  paintCropSelection(cropRectDraft);
}
function endCropSelection() { cropDragStart = null; }

// ---------- آماده‌سازی تصاویر برای PDF ----------
async function decodeSlices(it, maxSrcH) {
  // it می‌تواند خود تصویر یا نسخهٔ ویرایش‌شده (edited) باشد
  const bmp = await createImageBitmap(it.blob, { imageOrientation: 'none' });
  const asPng = it.info && it.info.fmt === 'PNG';
  const segs = [];
  try {
    for (let y = 0; y < bmp.height; y += maxSrcH) {
      const sh = Math.min(maxSrcH, bmp.height - y);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = sh;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bmp, 0, y, bmp.width, sh, 0, 0, bmp.width, sh);
      const data = canvas.toDataURL(asPng ? 'image/png' : 'image/jpeg', 0.98);
      canvas.width = canvas.height = 0;
      segs.push({ data, fmt: asPng ? 'PNG' : 'JPEG', w: bmp.width, h: sh, alias: `i${it.pdfKey || it.uid || it.i}_${y}` });
    }
  } finally { bmp.close(); }
  return segs;
}

async function prepare(it, r) {
  const src = await getDisplaySource(it);
  const rawMax = Math.floor(PdfBuilder.SAFE_PT / r);
  const inf = src.info;
  const key = it.pdfKey || it.uid || it.i;
  // فایل JPEG/PNG بدون هیچ فشرده‌سازی مجدد
  if (inf && inf.ok && inf.h <= rawMax) {
    const u8 = new Uint8Array(await src.blob.arrayBuffer());
    return [{ data: u8, fmt: inf.fmt, w: inf.w, h: inf.h, alias: `i${key}` }];
  }
  return decodeSlices({ i: key, pdfKey: key, blob: src.blob, info: src.info }, Math.min(rawMax, MAX_CANVAS_H));
}

async function fallback(seg) {
  const blob = typeof seg.data === 'string' ? await (await fetch(seg.data)).blob() : new Blob([seg.data]);
  const bmp = await createImageBitmap(blob, { imageOrientation: 'none' });
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width; canvas.height = bmp.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const data = canvas.toDataURL('image/jpeg', 0.98);
  canvas.width = canvas.height = 0;
  return { data, fmt: 'JPEG' };
}

async function composeVertically(group, pageKey) {
  const sources = await Promise.all(group.map(getDisplaySource));
  const itemScales = group.map((it) => Math.max(0.25, Math.min(2, (Number(it.pdfScale) || 100) / 100)));
  const targetWidths = sources.map((src, i) => src.w * itemScales[i]);
  const maxW = Math.max(...targetWidths);
  const rawHeights = sources.map((src, i) => src.h * targetWidths[i] / src.w);
  const rawH = rawHeights.reduce((sum, h) => sum + h, 0);
  const scale = Math.min(1, 16000 / maxW, 16000 / rawH, Math.sqrt(180000000 / (maxW * rawH)));
  const w = Math.max(1, Math.floor(maxW * scale));
  const widths = targetWidths.map((width) => Math.min(w, Math.max(1, Math.round(width * scale))));
  const heights = rawHeights.map((h) => Math.max(1, Math.round(h * scale)));
  const h = heights.reduce((sum, n) => sum + n, 0);
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
  let y = 0;
  for (let k = 0; k < sources.length; k++) {
    const bmp = await createImageBitmap(sources[k].blob, { imageOrientation: 'none' });
    const x = Math.round((w - widths[k]) / 2);
    try { ctx.drawImage(bmp, x, y, widths[k], heights[k]); }
    finally { bmp.close(); }
    y += heights[k];
  }
  const blob = await canvasToBlob(cv, 'image/png');
  cv.width = cv.height = 0;
  return {
    i: group[0].i, pdfKey: pageKey, pageOrder: Math.min(...group.map((it) => it.pdfOrder || it.i + 1)),
    sequence: Math.min(...group.map((it) => it.sequence)), blob, w, h, pdfScale: 100,
    info: sniff(new Uint8Array(await blob.arrayBuffer()))
  };
}

async function makePdfItems(selected, twoPerPage) {
  let sequence = 0;
  const expanded = [];
  for (const it of selected) {
    const source = await getDisplaySource(it);
    expanded.push({
      ...it, blob: source.blob, info: source.info, w: source.w, h: source.h,
      edited: null, cropRect: null, cropCache: null,
      pdfKey: `image_${it.uid ?? it.i}`, sequence: sequence++, pageOrder: it.pdfOrder || it.i + 1
    });
  }

  const groups = new Map(), ungrouped = [];
  expanded.forEach((it) => {
    if (it.pageGroup) {
      if (!groups.has(it.pageGroup)) groups.set(it.pageGroup, []);
      groups.get(it.pageGroup).push(it);
    } else ungrouped.push(it);
  });

  const pages = [];
  for (const [groupId, members] of groups) {
    members.sort((a, b) => a.sequence - b.sequence);
    pages.push(members.length > 1 ? await composeVertically(members, `group_${groupId}`) : members[0]);
  }
  const chunkSize = twoPerPage ? 2 : 1;
  for (let i = 0; i < ungrouped.length; i += chunkSize) {
    const chunk = ungrouped.slice(i, i + chunkSize);
    pages.push(chunk.length > 1 ? await composeVertically(chunk, `pair_${chunk[0].sequence}`) : chunk[0]);
  }
  pages.sort((a, b) => (a.pageOrder || a.i + 1) - (b.pageOrder || b.i + 1) || a.sequence - b.sequence);
  return pages;
}

// ---------- ساخت PDF ----------
async function onBuild() {
  if (building || loading) return;
  const sel = items.filter((it) => it.state === 'ok' && it.selected)
    .sort((a, b) => (a.pdfOrder || a.i + 1) - (b.pdfOrder || b.i + 1) || a.uid - b.uid);
  if (!sel.length) return;
  const jsPDFLib = window.jspdf && window.jspdf.jsPDF;
  if (!jsPDFLib) { alert('فایل jspdf.umd.min.js پیدا نشد!'); return; }

  building = true;
  refreshSummary();
  let name = $('pdfName').value.trim() || 'comic';
  if (!name.toLowerCase().endsWith('.pdf')) name += '.pdf';
  const seamless = $('seamless').checked;
  const twoPerPage = $('twoPerPage').checked && !seamless;
  const uniformWidth = $('uniformWidth').checked;

  const result = $('result');
  result.classList.remove('hidden', 'done');
  $('downloadBtn').classList.add('hidden');
  $('failed').innerText = '';
  $('sPages').innerText = '0';
  $('sSize').innerText = '0';
  $('lblPages').innerText = 'صفحهٔ PDF';
  $('progressBar').style.width = '0';
  setStatus('در حال ساخت PDF...');
  window.scrollTo({ top: 0, behavior: 'smooth' });

  try {
    setStatus(twoPerPage ? 'در حال چیدن تصاویر دوتایی در صفحه‌های عمودی...' : 'در حال آماده‌سازی تصاویر PDF...');
    const pdfItems = await makePdfItems(sel, twoPerPage);
    const res = await PdfBuilder.build({
      jsPDF: jsPDFLib,
      items: pdfItems,
      seamless,
      uniformWidth,
      prepare,
      fallback,
      onProgress: (k, n) => {
        $('progressBar').style.width = Math.round((k / n) * 95) + '%';
        if (k < n) setStatus(`در حال پردازش تصویر ${k + 1} از ${n}...`);
      },
      onPage: (p) => { $('sPages').innerText = p; }
    });

    if (!res.pdf) { setStatus('هیچ تصویری قابل تبدیل به PDF نبود!'); return; }

    setStatus('در حال نهایی کردن فایل PDF...');
    await new Promise((r) => setTimeout(r, 50));
    const outBlob = res.pdf.output('blob');
    if (lastObjUrl) URL.revokeObjectURL(lastObjUrl);
    lastObjUrl = URL.createObjectURL(outBlob);
    const mb = (outBlob.size / 1048576).toFixed(1);

    const btn = $('downloadBtn');
    btn.href = lastObjUrl;
    btn.download = name;
    btn.classList.remove('hidden');
    $('dlLabel').innerText = `دانلود PDF (${mb} مگابایت)`;
    $('sSize').innerText = mb;
    result.classList.add('done');
    $('progressBar').style.width = '100%';
    const layoutNotes = [];
    if (seamless) layoutNotes.push('یک صفحهٔ بلند');
    else if (twoPerPage) layoutNotes.push('دو تصویر عمودی در هر صفحه');
    if (uniformWidth) layoutNotes.push('عرض یکسان');
    const layoutNote = layoutNotes.length ? ` (${layoutNotes.join('، ')})` : '';
    setStatus(`آماده شد! فایل PDF با ${res.pages} صفحه${layoutNote} ساخته شد. اگر دانلود شروع نشد، دکمهٔ «دانلود PDF» را بزنید.`);
    btn.click();
  } catch (e) {
    console.error(e);
    setStatus('خطا در ساخت PDF: ' + (e && e.message ? e.message : e));
  } finally {
    building = false;
    refreshSummary();
  }
}
function setStatus(t) { $('statusText').innerText = t; }

// ---------- ذخیرهٔ تصاویر به‌صورت جدا ----------
let mode = 'pdf';
function setMode(m) {
  mode = m;
  $('modePdf').classList.toggle('active', m === 'pdf');
  $('modeImg').classList.toggle('active', m === 'img');
  $('pdfOpts').classList.toggle('hidden', m !== 'pdf');
  $('imgOpts').classList.toggle('hidden', m !== 'img');
}

// پسوند واقعی فایل از روی بایت‌های ابتدایی
async function blobExt(blob) {
  const u = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  if (u[0] === 0xFF && u[1] === 0xD8 && u[2] === 0xFF) return 'jpg';
  if (u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4E && u[3] === 0x47) return 'png';
  if (u[0] === 0x47 && u[1] === 0x49 && u[2] === 0x46) return 'gif';
  if (u[0] === 0x52 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x46 && u[8] === 0x57 && u[9] === 0x45) return 'webp';
  if (u[4] === 0x66 && u[5] === 0x74 && u[6] === 0x79 && u[7] === 0x70) {
    const brand = String.fromCharCode(u[8], u[9], u[10], u[11]);
    if (brand === 'avif' || brand === 'avis') return 'avif';
  }
  const t = ((blob.type || '').split('/')[1] || 'img').replace('jpeg', 'jpg').replace(/\+.*/, '');
  return t || 'img';
}

const canConvert = (w, h) => w > 0 && h > 0 && w <= 32767 && h <= 32767 && w * h <= 268000000;
const canvasToBlob = (cv, type, q) => new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), type, q));

// خروجی هر تصویر: فایل اصلی بدون دستکاری، یا تبدیل به PNG (بدون افت) / JPEG (بالاترین کیفیت)
async function exportBlob(it, fmt) {
  const src = await getDisplaySource(it);
  const srcExt = await blobExt(src.blob);
  const want = fmt === 'png' ? 'png' : fmt === 'jpg' ? 'jpg' : null;
  if (!want || srcExt === want) return { blob: src.blob, ext: srcExt };
  if (!canConvert(src.w, src.h)) return { blob: src.blob, ext: srcExt, note: 'ابعاد برای تبدیل بیش از حد بزرگ است؛ فایل اصلی ذخیره شد' };
  const bmp = await createImageBitmap(src.blob, { imageOrientation: 'none' });
  try {
    const cv = document.createElement('canvas');
    cv.width = bmp.width; cv.height = bmp.height;
    const ctx = cv.getContext('2d');
    if (want === 'jpg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height); }
    ctx.drawImage(bmp, 0, 0);
    const blob = await canvasToBlob(cv, want === 'png' ? 'image/png' : 'image/jpeg', 1);
    cv.width = cv.height = 0;
    return { blob, ext: want };
  } finally { bmp.close(); }
}

function cleanFolderName(s) {
  return (s || '').replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').trim();
}

async function fileExists(dir, name) {
  try { await dir.getFileHandle(name); return true; }
  catch (e) {
    if (e && e.name === 'NotFoundError') return false;
    if (e && e.name === 'TypeMismatchError') return true;
    throw e;
  }
}
// فایل‌های موجود هرگز بازنویسی نمی‌شوند؛ در صورت تکراری بودن، پسوند عددی اضافه می‌شود
async function uniqueName(dir, base, ext) {
  let name = `${base}.${ext}`, n = 2;
  while (await fileExists(dir, name)) name = `${base}_${n++}.${ext}`;
  return name;
}

async function onSaveImages() {
  if (building || loading) return;
  const sel = items.filter((it) => it.state === 'ok' && it.selected)
    .sort((a, b) => (a.pdfOrder || a.i + 1) - (b.pdfOrder || b.i + 1) || a.uid - b.uid);
  if (!sel.length) return;

  // انتخاب پوشه باید مستقیماً با کلیک کاربر باز شود
  let rootDir = null;
  let useDownloads = false;
  let note = '';
  if (window.showDirectoryPicker) {
    try {
      rootDir = await window.showDirectoryPicker({ id: 'comic-to-pdf', mode: 'readwrite', startIn: 'downloads' });
    } catch (e) {
      if (e && e.name === 'AbortError') { return; }
      console.warn('انتخاب پوشه ممکن نشد', e);
      useDownloads = true;
      note = 'کروم اجازهٔ انتخاب آن پوشه را نداد (پوشه‌های سیستمی مثل Downloads یا Documents مستقیم قابل انتخاب نیستند). ';
    }
  } else {
    useDownloads = true;
  }

  const sub = cleanFolderName($('folderName').value);
  const folderLabel = useDownloads ? ('Downloads/' + (sub || 'comic')) : (rootDir.name + (sub ? '/' + sub : ''));

  building = true;
  refreshSummary();
  const result = $('result');
  result.classList.remove('hidden', 'done');
  $('downloadBtn').classList.add('hidden');
  $('failed').innerText = '';
  $('sPages').innerText = '0';
  $('sSize').innerText = '0';
  $('lblPages').innerText = 'تصویر ذخیره‌شده';
  $('progressBar').style.width = '0';
  setStatus(note + `در حال ذخیرهٔ تصاویر در «${folderLabel}»...`);
  window.scrollTo({ top: 0, behavior: 'smooth' });

  let saved = 0, bytes = 0;
  const errors = [];
  const fmt = $('outFmt').value;
  try {
    let dir = null;
    if (!useDownloads) dir = sub ? await rootDir.getDirectoryHandle(sub, { create: true }) : rootDir;

    const pad = Math.max(3, String(sel.length).length);
    for (let k = 0; k < sel.length; k++) {
      const it = sel[k];
      let ext = 'img';
      const base = String(k + 1).padStart(pad, '0');
      try {
        const ex = await exportBlob(it, fmt);
        ext = ex.ext;
        if (ex.note) errors.push(`${base}: ${ex.note}`);
        if (useDownloads) {
          const url = URL.createObjectURL(ex.blob);
          await chrome.downloads.download({
            url, filename: `${sub || 'comic'}/${base}.${ext}`, conflictAction: 'uniquify', saveAs: false
          });
          setTimeout(() => URL.revokeObjectURL(url), 120000);
        } else {
          const fname = await uniqueName(dir, base, ext);
          const fh = await dir.getFileHandle(fname, { create: true });
          const w = await fh.createWritable();
          await w.write(ex.blob);
          await w.close();
        }
        saved++;
        bytes += ex.blob.size;
      } catch (e) {
        console.warn('ذخیرهٔ تصویر ناموفق', base, e);
        errors.push(`${base}.${ext}: ${e && e.message ? e.message : e}`);
      }
      $('sPages').innerText = saved;
      $('sSize').innerText = (bytes / 1048576).toFixed(1);
      $('progressBar').style.width = Math.round(((k + 1) / sel.length) * 100) + '%';
      setStatus(`در حال ذخیرهٔ تصاویر... ${k + 1} از ${sel.length}`);
    }

    result.classList.add('done');
    setStatus(saved
      ? `${note}${saved} تصویر ${fmt === 'png' ? 'با فرمت PNG (بدون افت کیفیت)' : fmt === 'jpg' ? 'با فرمت JPEG (کیفیت ۱۰۰٪؛ فایل‌های JPEG اصلی دست‌نخورده)' : 'با فرمت و کیفیت اصلی'} در «${folderLabel}» ذخیره شد.`
      : 'هیچ تصویری ذخیره نشد.');
    if (errors.length) $('failed').innerText = `${errors.length} تصویر ذخیره نشد:\n` + errors.slice(0, 5).join('\n');
  } catch (e) {
    console.error(e);
    setStatus('خطا در ذخیرهٔ تصاویر: ' + (e && e.message ? e.message : e));
  } finally {
    building = false;
    refreshSummary();
  }
}

// ---------- شروع ----------
async function main() {
  const jobId = new URLSearchParams(location.search).get('job');
  jobKey = 'job_' + jobId;
  const stored = await chrome.storage.local.get(jobKey);
  job = stored[jobKey];
  if (!job) {
    $('loadText').innerText = 'اطلاعات کار پیدا نشد. دوباره از popup شروع کنید.';
    return;
  }
  $('pdfName').value = (job.name || 'comic').replace(/\.pdf$/i, '');
  await setRefererRule(job.pageUrl);

  const grid = $('grid');
  grid.addEventListener('dragover', (ev) => {
    if (!draggedItem) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
  });
  grid.addEventListener('drop', (ev) => {
    if (!draggedItem) return;
    ev.preventDefault();
    const target = ev.target.closest('.item');
    if (!target || target === draggedItem.el) return;
    const rect = target.getBoundingClientRect();
    // شبکه از راست به چپ است: سمت راست کارت یعنی درج قبل از آن در ترتیب DOM.
    const insertBefore = ev.clientX > rect.left + rect.width / 2 ? target : target.nextSibling;
    grid.insertBefore(draggedItem.el, insertBefore);
    updatePdfOrderFromGrid();
    suppressCardClickUntil = Date.now() + 350;
  });
  items = job.urls.map((url, i) => ({ i, uid: i, url, pdfOrder: i + 1, pdfScale: 100, pageGroup: null, state: 'loading', selected: true }));
  nextItemUid = items.length;
  items.forEach((it) => grid.appendChild(makeCard(it)));

  $('btnAll').onclick = () => { items.forEach((it) => { if (it.state === 'ok') it.selected = true; }); refreshAll(); };
  $('btnNone').onclick = () => { items.forEach((it) => { it.selected = false; }); refreshAll(); };
  $('btnInv').onclick = () => { items.forEach((it) => { if (it.state === 'ok') it.selected = !it.selected; }); refreshAll(); };
  $('btnGroupPage').onclick = groupSelectedItems;
  $('btnUngroupPage').onclick = ungroupSelectedItems;
  $('btnRetry').onclick = () => { loadAll(items.filter((it) => it.state === 'failed')); };
  $('buildBtn').onclick = onBuild;
  $('saveImgBtn').onclick = onSaveImages;
  $('modePdf').onclick = () => setMode('pdf');
  $('modeImg').onclick = () => setMode('img');
  $('seamless').addEventListener('change', () => {
    if ($('seamless').checked) $('twoPerPage').checked = false;
    refreshSummary();
  });
  $('twoPerPage').addEventListener('change', () => {
    if ($('twoPerPage').checked) $('seamless').checked = false;
    refreshSummary();
  });
  $('lbClose').onclick = closeLightbox;
  $('lbCopy').onclick = copyLightboxImage;
  $('lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') closeLightbox(); });
  $('cropCancel').onclick = closeCropper;
  $('cropReset').onclick = () => { cropRectDraft = null; paintCropSelection(null); };
  $('cropApply').onclick = applyCrop;
  $('cropStage').addEventListener('pointerdown', beginCropSelection);
  $('cropStage').addEventListener('pointermove', moveCropSelection);
  $('cropStage').addEventListener('pointerup', endCropSelection);
  $('cropStage').addEventListener('pointercancel', endCropSelection);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('cropper').classList.contains('hidden')) closeCropper();
    else if (!$('lightbox').classList.contains('hidden')) closeLightbox();
  });
  window.addEventListener('pagehide', () => { chrome.storage.local.remove(jobKey); clearRefererRule(); });

  await loadAll(items);
}

main().catch((e) => {
  console.error(e);
  $('loadText').innerText = 'خطا: ' + (e && e.message ? e.message : e);
});
