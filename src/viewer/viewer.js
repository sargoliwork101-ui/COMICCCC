const $ = (id) => document.getElementById(id);

const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const ICON_ZOOM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></svg>';
const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/></svg>';
const ICON_CROP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v13a2 2 0 0 0 2 2h13M3 6h13a2 2 0 0 1 2 2v13"/></svg>';
const ICON_DUPLICATE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>';
const ICON_DELETE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m4 4v6m6-6v6"/></svg>';
const ICON_RETRY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';
const CONCURRENCY = 4;
const MAX_CANVAS_H = 16000;
const APP_TITLE = 'PIC TO PDF';
function setTaskTitle(message = '') {
  document.title = message ? `${message} · ${APP_TITLE}` : APP_TITLE;
}

// درخواست لغو همهٔ کارهای در حال اجرا (بارگیری، ساخت PDF، ذخیرهٔ تصاویر و ترجمه)
function requestJobCancel() {
  jobCancelRequested = true;
  if (loadAbortController) { try { loadAbortController.abort(); } catch { /* کنترلر قبلاً بسته شده */ } }
  // TR در trans.js تعریف شده و حلقهٔ ترجمه همان پرچم را می‌خواند
  try { if (typeof TR !== 'undefined' && TR) TR.cancel = true; } catch { /* trans.js هنوز بارگذاری نشده */ }
}

// راهنمای لغو با ESC در پنل نتیجه، فقط هنگام اجرای کار دیده می‌شود
function setJobHint(visible) {
  const el = $('jobHint');
  if (el) el.classList.toggle('hidden', !visible);
}

let job = null;
let jobKey = '';
let pageProfileKey = '';
let pageProfileAvailable = false;
let items = [];
let loading = true;
let building = false;
// لغو کار در حال اجرا با ESC؛ بارگیری از AbortController و بقیه کارها از همین پرچم در مرز حلقه‌ها استفاده می‌کنند
let jobCancelRequested = false;
let loadAbortController = null;
let lastClicked = null;
let lastObjUrl = null;
let draggedItem = null;
let dragGroupDrop = false;
let dragDropTargetEl = null;
let suppressCardClickUntil = 0;
// وقتی کارتی از یک گروه کشیده می‌شود، کل اعضای گروه به‌صورت یک بلوک جابه‌جا می‌شوند
let draggedGroupItems = null;
let insertMarkerEl = null;

// انیمیشن FLIP: موقعیت کارت‌ها قبل از تغییر DOM را ذخیره و بعد از جابه‌جایی، لغزش نرم می‌سازد
function captureGridRects() {
  const map = new Map();
  Array.from($('grid').children).forEach((el) => map.set(el, el.getBoundingClientRect()));
  return map;
}
function playGridMove(firstRects) {
  if (typeof requestAnimationFrame === 'undefined') return;
  Array.from($('grid').children).forEach((el) => {
    const old = firstRects.get(el);
    if (!old) return;
    const now = el.getBoundingClientRect();
    const dx = old.left - now.left;
    const dy = old.top - now.top;
    if (!dx && !dy) return;
    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.style.transition = 'transform .22s ease';
      el.style.transform = '';
      const done = () => { el.style.transition = ''; el.removeEventListener('transitionend', done); };
      el.addEventListener('transitionend', done);
    }));
  });
}
// اعضای یک گروه به ترتیب فعلی شبکه (پیوسته‌اند)
function gridGroupBlock(groupId) {
  return Array.from($('grid').children).filter((el) => {
    const it = items.find((x) => x.el === el);
    return it && Number(it.pageGroup) === groupId;
  });
}
function clearInsertMarker() {
  if (insertMarkerEl) {
    insertMarkerEl.classList.remove('drag-insert-before', 'drag-insert-after', 'drag-insert-group');
    insertMarkerEl = null;
  }
}
function setInsertMarker(targetEl, before, isGroup) {
  const sameEdge = targetEl.classList.contains(before ? 'drag-insert-before' : 'drag-insert-after');
  const sameMode = targetEl.classList.contains('drag-insert-group') === isGroup;
  if (insertMarkerEl === targetEl && sameEdge && sameMode) return;
  clearInsertMarker();
  insertMarkerEl = targetEl;
  targetEl.classList.add(before ? 'drag-insert-before' : 'drag-insert-after');
  if (isGroup) targetEl.classList.add('drag-insert-group');
}
let lbItem = null;
let cropItem = null;
let cropObjectUrl = null;
let cropRectDraft = null;
let cropDragStart = null;
let nextPageGroupId = 1;
let editingPageGroupId = null;
let editingPageGroupSelection = null;
let nextItemUid = 0;
let pendingPdfImportToken = null;
let receivingPdfImport = false;

// ---------- دانلود تصاویر ----------
async function setRefererRule(pageUrl) {
  try {
    const origin = new URL(pageUrl).origin + '/';
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [1],
      addRules: [{
        id: 1, priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: origin }] },
        // فقط برای دریافت تصویرها؛ درخواست سرویس‌های ترجمه نباید Referer سایت کمیک را بگیرند
        condition: {
          resourceTypes: ['xmlhttprequest'],
          initiatorDomains: [chrome.runtime.id],
          excludedRequestDomains: ['translate.googleapis.com', 'api.mymemory.translated.net']
        }
      }]
    });
  } catch (e) { console.warn('Referer rule failed', e); }
}
async function clearRefererRule() {
  try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1] }); } catch {}
}

function looksLikeImage(b) {
  return b && b.size > 0 && !/^(text|application\/json)/i.test(b.type || '');
}

async function fetchImageBlob(url, tabId, signal) {
  let directError = 'دریافت مستقیم ناموفق بود';
  try {
    const res = await fetch(url, { credentials: 'include', signal });
    if (!res.ok) directError = `پاسخ سرور: HTTP ${res.status}`;
    else {
      const blob = await res.blob();
      if (looksLikeImage(blob)) return { blob, error: null };
      directError = `پاسخ سرور تصویر نبود${blob.type ? ` (${blob.type})` : ''}`;
    }
  } catch (e) {
    if (signal && signal.aborted) return { blob: null, error: 'بارگیری با کلید ESC لغو شد' };
    directError = `دریافت مستقیم: ${e && e.message ? e.message : 'خطای شبکه یا دسترسی'}`;
  }
  // اگر کاربر لغو کرده، fetch جایگزین از داخل صفحه هم بی‌فایده است
  if (signal && signal.aborted) return { blob: null, error: 'بارگیری با کلید ESC لغو شد' };

  let pageError = 'دسترسی به صفحهٔ مبدأ در دسترس نیست';
  if (tabId != null) {
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        args: [url],
        func: async (u) => {
          try {
            const res = await fetch(u, { credentials: 'include' });
            if (!res.ok) return { error: `HTTP ${res.status}` };
            const blob = await res.blob();
            const data = await new Promise((resolve, reject) => {
              const fr = new FileReader();
              fr.onloadend = () => fr.error ? reject(fr.error) : resolve(fr.result);
              fr.readAsDataURL(blob);
            });
            return { data };
          } catch (e) { return { error: e && e.message ? e.message : 'خطای fetch در صفحه' }; }
        }
      });
      const result = r && r.result;
      if (result && result.data) {
        const blob = await (await fetch(result.data)).blob();
        if (looksLikeImage(blob)) return { blob, error: null };
        pageError = 'صفحه پاسخ تصویری برنگرداند';
      } else pageError = result && result.error ? `دریافت از صفحه: ${result.error}` : 'صفحه تصویر را برنگرداند';
    } catch (e) { pageError = `دسترسی به صفحه: ${e && e.message ? e.message : 'مجاز نیست'}`; }
  }
  return { blob: null, error: `${directError}؛ ${pageError}` };
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
    } catch { info = null; }
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
  el.title = 'برای جابه‌جایی بکشید و روی لبهٔ کارت رها کنید؛ برای گروه‌بندی، روی وسط کارت دیگر رها کنید. داخل یک گروه، رهاکردن روی لبهٔ کارت هم‌گروه فقط ترتیب داخلی گروه را عوض می‌کند؛ برای خروج از گروه، کارت را در فضای خالی شبکه رها کنید';
  el.innerHTML = `<div class="tw"><canvas width="240" height="320"></canvas><div class="spin">در حال دریافت...</div>
    <span class="idx">${it.i + 1}${it.dupNo ? ` · کپی ${it.dupNo}` : ''}</span><span class="tick">${ICON_CHECK}</span>
    <button class="zoom" title="مشاهدهٔ بزرگ">${ICON_ZOOM}</button>
    <button class="crop" title="کراپ دستی">${ICON_CROP}</button>
    <button class="edit" title="ویرایش ترجمه">${ICON_EDIT}</button>
    <button class="duplicate" title="ساخت نسخهٔ مستقل">${ICON_DUPLICATE}</button>
    <button class="delete" title="حذف این تصویر" aria-label="حذف تصویر">${ICON_DELETE}</button>
    <span class="fa-badge">ترجمه شد</span><span class="page-group-badge hidden"></span></div>
    <button class="retry" type="button" title="تلاش مجدد برای بارگیری این تصویر" aria-label="تلاش مجدد برای بارگیری">${ICON_RETRY}<span>تلاش مجدد</span></button>
    <div class="meta">…</div>
    <div class="order-control"><span>ترتیب در PDF</span><input class="page-order" type="number" min="1" step="1" value="${it.pdfOrder || it.i + 1}" aria-label="ترتیب در PDF"></div>`;
  const orderInput = el.querySelector('.page-order');
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
    $('grid').classList.add('order-live');
    // اگر کارت عضو یک گروه معتبر است، کل اعضای گروه برای جابه‌جایی بلوکی علامت‌گذاری می‌شوند
    const gid = Number(it.pageGroup);
    const groupMembers = gid > 0 ? items.filter((x) => x.state === 'ok' && Number(x.pageGroup) === gid) : [];
    if (groupMembers.length >= 2) {
      draggedGroupItems = groupMembers;
      const color = groupColorFor(buildPageGroupView().numberById.get(gid));
      $('grid').style.setProperty('--group-color', color.hex);
      groupMembers.forEach((member) => member.el.classList.add('group-moving'));
    } else {
      draggedGroupItems = null;
    }
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', String(it.uid));
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    if (draggedGroupItems) {
      draggedGroupItems.forEach((member) => member.el.classList.remove('group-moving'));
      draggedGroupItems = null;
    }
    $('grid').style.removeProperty('--group-color');
    $('grid').classList.remove('order-live');
    clearDragDropHint();
    // اگر دراپ معتبری رخ نداده باشد، شماره‌های پیش‌نمایشی به ترتیب واقعی برگردند
    restoreDragOrderPreview();
    draggedItem = null;
  });
  el.addEventListener('click', (ev) => {
    if (Date.now() < suppressCardClickUntil) { ev.preventDefault(); return; }
    if (ev.target.closest('.page-order')) return;
    if (ev.target.closest('.zoom')) { openLightbox(it); return; }
    if (ev.target.closest('.crop')) { openCropper(it); return; }
    if (ev.target.closest('.edit')) { if (typeof openEditor === 'function') openEditor(it); return; }
    if (ev.target.closest('.duplicate')) { duplicateItem(it); return; }
    if (ev.target.closest('.delete')) { deleteItem(it); return; }
    if (ev.target.closest('.retry')) { retryItem(it); return; }
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
  const state = { ...source };
  delete state.el; // مرجع DOM کارت مبدأ نباید به نسخهٔ کپی منتقل شود
  return {
    ...state,
    uid: nextItemUid++,
    dupNo: items.reduce((max, it) => it.i === source.i ? Math.max(max, Number(it.dupNo) || 0) : max, 0) + 1,
    selected: true,
    pageGroup: null,
    cropRect: source.cropRect ? { ...source.cropRect } : null,
    cropCache: null,
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
// حذف واقعی مجموعه‌ای از کارت‌ها پس از تأیید؛ مشترک بین حذف تکی و حذف دسته‌جمعی
function removeItemsFromGrid(targets) {
  const remove = new Set(targets);
  if (cropItem && remove.has(cropItem)) closeCropper();
  if (lbItem && remove.has(lbItem)) closeLightbox();
  targets.forEach((it) => {
    if (it.el && it.el.parentNode) it.el.parentNode.removeChild(it.el);
    if (lastClicked === it.uid) lastClicked = null;
  });
  items = items.filter((item) => !remove.has(item));
  cleanupPageGroups();
  updatePdfOrderFromGrid();
  refreshAll();
}
function deleteItem(it) {
  if (!it || building || loading) return;
  if (!confirm(`تصویر ${it.i + 1} حذف شود؟`)) return;
  if (editingPageGroupId !== null) cancelPageGroupEdit();
  removeItemsFromGrid([it]);
}
// حذف دسته‌جمعی: فقط کارت‌های بارگیری‌شده و انتخاب‌شده؛ یک تأیید برای کل مجموعه
function deleteSelectedItems() {
  if (building || loading) return;
  const targets = items.filter((it) => it.state === 'ok' && it.selected);
  if (!targets.length) return;
  if (!confirm(`${targets.length} تصویر انتخاب‌شده حذف شوند؟`)) return;
  if (editingPageGroupId !== null) cancelPageGroupEdit();
  removeItemsFromGrid(targets);
}

// پالت رنگی گروه‌ها: هر گروه شمارهٔ نمایشی خودش رنگ ثابتی دارد تا گروه‌ها به‌راحتی از هم تفکیک شوند
const GROUP_PALETTE = [
  { hex: '#34d399', rgb: '52,211,153' },  // سبز
  { hex: '#8b7bff', rgb: '139,123,255' }, // بنفش
  { hex: '#fbbf24', rgb: '251,191,36' },  // کهربایی
  { hex: '#38bdf8', rgb: '56,189,248' },  // آسمانی
  { hex: '#fb7185', rgb: '251,113,133' }, // سرخ‌صورتی
  { hex: '#fb923c', rgb: '251,146,60' },  // نارنجی
  { hex: '#22d3ee', rgb: '34,211,238' },  // فیروزه‌ای
  { hex: '#e879f9', rgb: '232,121,249' }, // سرخابی
  { hex: '#a3e635', rgb: '163,230,53' },  // لیمویی
  { hex: '#818cf8', rgb: '129,140,248' }  // نیلی
];
function groupColorFor(displayNumber) {
  return GROUP_PALETTE[(Math.max(1, Number(displayNumber) || 1) - 1) % GROUP_PALETTE.length];
}
function buildPageGroupView() {
  const membersById = new Map();
  items.forEach((it) => {
    const id = Number(it.pageGroup);
    if (it.state !== 'ok' || !Number.isInteger(id) || id < 1) return;
    if (!membersById.has(id)) membersById.set(id, []);
    membersById.get(id).push(it);
  });
  for (const [id, members] of membersById) if (members.length < 2) membersById.delete(id);
  const orderedIds = [...membersById.keys()].sort((a, b) => a - b);
  const numberById = new Map(orderedIds.map((id, index) => [id, index + 1]));
  return { membersById, numberById };
}
function formatGroupLabel(displayNumber, memberCount) {
  return `گروه ${displayNumber} · ${memberCount} عضو`;
}

// یک کادر سبز واحد دور «همهٔ» اعضای هر گروه رسم می‌کند؛ اگر اعضای گروه در چند ردیف شبکه شکسته شوند،
// هر ردیف کادر پیوستهٔ خودش را می‌گیرد تا کادر هیچ کارت بیگانه‌ای را در بر نگیرد.
function drawGroupOutlines(groupView = buildPageGroupView()) {
  const layer = $('groupOutlineLayer');
  const grid = $('grid');
  const wrap = document.querySelector('.wrap');
  if (!layer || !grid || !wrap) return;
  layer.innerHTML = '';
  const groups = [...groupView.membersById.entries()];
  if (!groups.length) { layer.classList.add('hidden'); return; }
  const gridRect = grid.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  layer.classList.remove('hidden');
  // لایه دقیقاً روی محدودهٔ شبکه تراز می‌شود تا مختصات کادرها نسبت به خود شبکه حساب شود
  layer.style.left = `${gridRect.left - wrapRect.left}px`;
  layer.style.top = `${gridRect.top - wrapRect.top}px`;
  layer.style.width = `${gridRect.width}px`;
  layer.style.height = `${gridRect.height}px`;
  const PAD = 7;
  for (const [groupId, members] of groups) {
    const displayNumber = groupView.numberById.get(groupId);
    const color = groupColorFor(displayNumber);
    const rects = members.map((it) => it.el.getBoundingClientRect());
    // خوشه‌بندی اعضا بر اساس ردیف (تحمل ۴ پیکسل برای تفاوت گردشدن مرورگر)
    const rows = [];
    for (const r of rects) {
      const row = rows.find((c) => Math.abs(c.top - r.top) <= 4);
      if (row) {
        row.top = Math.min(row.top, r.top);
        row.left = Math.min(row.left, r.left);
        row.right = Math.max(row.right, r.right);
        row.bottom = Math.max(row.bottom, r.bottom);
      } else {
        rows.push({ top: r.top, left: r.left, right: r.right, bottom: r.bottom });
      }
    }
    rows.forEach((row, idx) => {
      const box = document.createElement('div');
      box.className = 'group-outline';
      box.dataset.group = String(groupId);
      box.dataset.row = String(idx + 1);
      box.style.left = `${row.left - gridRect.left - PAD}px`;
      box.style.top = `${row.top - gridRect.top - PAD}px`;
      box.style.width = `${row.right - row.left + PAD * 2}px`;
      box.style.height = `${row.bottom - row.top + PAD * 2}px`;
      box.style.borderColor = color.hex;
      box.style.background = `rgba(${color.rgb},.08)`;
      box.style.boxShadow = `0 0 0 1px rgba(${color.rgb},.22), 0 14px 34px -20px rgba(${color.rgb},.8)`;
      layer.appendChild(box);
    });
  }
}
function refreshCard(it, groupView = buildPageGroupView()) {
  const el = it.el;
  el.classList.toggle('selected', !!it.selected);
  el.classList.toggle('failed', it.state === 'failed');
  el.classList.toggle('translated', !!it.edited);
  el.classList.toggle('cropped', !!it.cropRect);
  el.classList.toggle('has-ocr', !!it.ocr);
  const groupBadge = el.querySelector('.page-group-badge');
  const deleteButton = el.querySelector('.delete');
  if (deleteButton) deleteButton.disabled = loading || building;
  const retryButton = el.querySelector('.retry');
  if (retryButton) retryButton.disabled = loading || building;
  const groupId = Number(it.pageGroup);
  const groupMembers = groupView.membersById.get(groupId);
  const displayNumber = groupView.numberById.get(groupId);
  const hasVisibleGroup = !!groupMembers && !!displayNumber;
  // خط چین سبز ماندگار دور اعضای هر گروه تا گروه بودنشان همیشه مشخص باشد
  el.classList.toggle('in-group', hasVisibleGroup);
  groupBadge.classList.toggle('hidden', !hasVisibleGroup);
  if (hasVisibleGroup) {
    const label = formatGroupLabel(displayNumber, groupMembers.length);
    groupBadge.innerText = label;
    groupBadge.title = `${label}; این اعضا در یک صفحهٔ PDF قرار می‌گیرند`;
    // رنگ مخصوص همان گروه روی badge، هماهنگ با کادر دور اعضا
    const color = groupColorFor(displayNumber);
    groupBadge.style.background = color.hex;
    groupBadge.style.color = '#0b1220';
    groupBadge.style.borderColor = 'rgba(255,255,255,.4)';
  } else {
    groupBadge.style.background = '';
    groupBadge.style.color = '';
    groupBadge.style.borderColor = '';
  }
  const meta = el.querySelector('.meta');
  const spin = el.querySelector('.spin');
  if (it.state === 'failed') el.title = it.error || 'بارگیری این تصویر ناموفق بود';
  else el.title = 'برای جابه‌جایی بکشید و روی لبهٔ کارت رها کنید؛ برای گروه‌بندی، روی وسط کارت دیگر رها کنید';
  if (it.state === 'ok') {
    if (spin && spin.parentNode) spin.parentNode.removeChild(spin);
    meta.innerText = `${it.w}×${it.h} · ${fmtSize(it.blob.size)}`;
    meta.title = '';
  } else if (it.state === 'failed') {
    if (spin && spin.parentNode) spin.parentNode.removeChild(spin);
    meta.innerText = 'دانلود نشد';
    meta.title = it.error || 'علت دقیق بارگیری نامشخص است';
  } else {
    // حالت بارگیری: کارتی که قبلاً شکست خورده و دوباره تلاش می‌شود، spin خود را از دست داده؛ بازسازی‌اش کن
    const tw = el.querySelector('.tw');
    if (tw && !spin) {
      const freshSpin = document.createElement('div');
      freshSpin.className = 'spin';
      freshSpin.innerText = 'در حال دریافت...';
      tw.appendChild(freshSpin);
    }
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
  // فقط آخرین درخواست پیش‌نمایش مجاز است روی کارت بنویسد تا نتیجهٔ قدیمی جای کراپ/ویرایش تازه را نگیرد.
  const request = (it.thumbRequest || 0) + 1;
  it.thumbRequest = request;
  try {
    const src = await getDisplaySource(it);
    const bmp = await createImageBitmap(src.blob, { resizeWidth: 240, resizeQuality: 'high' });
    try {
      if (it.thumbRequest !== request) return;
      const c = it.el.querySelector('canvas'), ctx = c && c.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = '#171c26'; ctx.fillRect(0, 0, c.width, c.height);
      // کل تصویر با حفظ نسبت داخل کادر می‌آید؛ برشِ ناخواستهٔ انتهای تصاویر بلند حذف شد.
      const scale = Math.min(c.width / bmp.width, c.height / bmp.height);
      const dw = Math.max(1, bmp.width * scale), dh = Math.max(1, bmp.height * scale);
      const dx = (c.width - dw) / 2, dy = (c.height - dh) / 2;
      ctx.drawImage(bmp, dx, dy, dw, dh);
    } finally { bmp.close(); }
  } catch (e) { console.warn('پیش‌نمایش تصویر ناموفق', e); }
}

async function loadOne(it, signal) {
  it.state = 'loading';
  const result = await fetchImageBlob(it.url, job.tabId, signal);
  if (!result.blob) { it.state = 'failed'; it.error = result.error; it.selected = false; refreshCard(it); return; }
  it.blob = result.blob;
  try { await analyze(it); } catch (e) { it.info = null; it.error = e && e.message ? e.message : 'تحلیل تصویر ناموفق بود'; }
  if (!it.info) { it.state = 'failed'; it.error = it.error || 'قالب یا ابعاد تصویر قابل‌خواندن نبود'; it.selected = false; it.blob = null; refreshCard(it); return; }
  it.error = '';
  it.state = 'ok';
  it.selected = true;
  refreshCard(it);
  drawThumb(it);
}

async function loadAll(list) {
  loading = true;
  jobCancelRequested = false;
  loadAbortController = new AbortController();
  const signal = loadAbortController.signal;
  $('loadText').parentNode.classList.remove('finished');
  const overlay = $('loadingOverlay');
  overlay.classList.remove('hidden');
  let next = 0, done = 0;
  const total = list.length;
  const update = () => {
    const percent = total ? Math.round((done / total) * 100) : 100;
    $('loadBar').style.width = percent + '%';
    $('loadingOverlayBar').style.width = percent + '%';
    $('loadText').innerText = `در حال دریافت تصاویر... ${done} از ${total}`;
    $('loadingOverlayText').innerText = done >= total ? 'آماده‌سازی تصاویر کامل شد' : 'در حال دریافت تصاویر...';
    $('loadingOverlayCount').innerText = `${done} از ${total} تصویر`;
    setTaskTitle(done < total ? `در حال دریافت تصویر ${done} از ${total}` : 'بارگیری تصویرها کامل شد');
    refreshSummary();
  };
  update();
  const worker = async () => {
    while (next < total && !jobCancelRequested) {
      const it = list[next++];
      await loadOne(it, signal);
      done++;
      update();
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
  } finally {
    loading = false;
    loadAbortController = null;
    // کارت‌هایی که فرصت بارگیری پیدا نکردند یا درخواستشان لغو شد، ناموفقِ قابل‌تلاش‌مجدد می‌شوند
    if (jobCancelRequested) {
      list.filter((it) => it.state === 'loading').forEach((it) => {
        it.state = 'failed';
        it.error = 'بارگیری با کلید ESC لغو شد';
        it.selected = false;
        refreshCard(it);
      });
      $('loadingOverlayText').innerText = 'بارگیری لغو شد';
    }
    overlay.classList.add('hidden');
    $('loadText').parentNode.classList.add('finished');
    setTaskTitle();
    refreshAll();
  }
}

// بازکردن ابزار PDF در یک تب جدا؛ فایل بزرگ از طریق IndexedDB بین دو تب ردوبدل می‌شود.
async function openPdfImportTab() {
  if (loading || building || editingPageGroupId !== null) return;
  const token = (globalThis.crypto && globalThis.crypto.randomUUID)
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let returnTabId = null;
  try {
    const currentTab = await chrome.tabs.getCurrent();
    if (currentTab && Number.isInteger(currentTab.id)) returnTabId = currentTab.id;
  } catch { /* پیش‌نمایش ممکن است در محیطی بدون tabs.getCurrent باز شده باشد */ }

  pendingPdfImportToken = token;
  const query = new URLSearchParams({ token });
  if (returnTabId !== null) query.set('returnTab', String(returnTabId));
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`src/pdf-import/pdf-import.html?${query}`), active: true });
    $('loadText').innerText = 'فایل PDF را در زبانهٔ تازه انتخاب کنید؛ پس از تبدیل به این پیش‌نمایش برمی‌گردد.';
  } catch (error) {
    pendingPdfImportToken = null;
    alert(`بازکردن زبانهٔ تبدیل PDF ناموفق بود: ${error && error.message ? error.message : error}`);
  }
}

async function receiveImportedPdf(token = pendingPdfImportToken) {
  if (!token || token !== pendingPdfImportToken || receivingPdfImport || typeof PDFImportStore === 'undefined') return;
  receivingPdfImport = true;
  try {
    const session = await PDFImportStore.getSession(token);
    if (!session || !['complete', 'failed'].includes(session.status)) return;
    const pages = await PDFImportStore.getPages(token);
    if (!pages.length) {
      $('loadText').innerText = session.error
        ? `تبدیل PDF ناموفق بود: ${session.error}`
        : 'فایلی از زبانهٔ تبدیل دریافت نشد.';
      pendingPdfImportToken = null;
      await PDFImportStore.deleteSession(token);
      return;
    }

    loading = true;
    const overlay = $('loadingOverlay');
    overlay.classList.remove('hidden');
    $('loadingOverlayText').innerText = 'در حال افزودن تصویرهای PDF...';
    $('loadingOverlayCount').innerText = `۰ از ${pages.length} صفحه`;
    $('loadingOverlayBar').style.width = '0%';
    setTaskTitle('در حال دریافت صفحه‌های PDF');
    refreshSummary();

    let nextSourceIndex = items.reduce((max, it) =>
      Number.isInteger(it.i) ? Math.max(max, it.i + 1) : max, 0);
    for (let index = 0; index < pages.length; index++) {
      const page = pages[index];
      const itemIndex = nextSourceIndex++;
      const item = {
        i: itemIndex, uid: nextItemUid++, url: '', pdfOrder: itemIndex + 1, pageGroup: null,
        state: 'ok', selected: true, blob: page.blob,
        info: { fmt: 'PNG', w: page.width, h: page.height, ok: true },
        w: page.width, h: page.height, error: '', edited: null, cropRect: null, cropCache: null, ocr: null,
        sourcePdf: page.fileName || session.fileName || 'document.pdf', sourcePdfPage: page.pageNumber
      };
      items.push(item);
      $('grid').appendChild(makeCard(item));
      drawThumb(item);
      const done = index + 1;
      const percent = Math.round((done / pages.length) * 100);
      $('loadingOverlayCount').innerText = `${done} از ${pages.length} صفحه`;
      $('loadingOverlayBar').style.width = `${percent}%`;
      $('loadText').innerText = `افزودن صفحه‌های PDF به فهرست... ${done} از ${pages.length}`;
    }

    pendingPdfImportToken = null;
    await PDFImportStore.deleteSession(token);
    $('loadText').innerText = session.status === 'failed'
      ? `${pages.length} صفحه اضافه شد؛ تبدیل PDF در صفحهٔ ${session.count + 1} متوقف شد: ${session.error || 'خطای ناشناخته'}`
      : `${pages.length} صفحه از «${session.fileName || 'PDF'}» به فهرست تصاویر اضافه شد.`;
  } catch (error) {
    console.error('Receiving converted PDF pages failed', error);
    $('loadText').innerText = `دریافت تصویرهای PDF ناموفق بود: ${error && error.message ? error.message : error}`;
  } finally {
    loading = false;
    $('loadingOverlay').classList.add('hidden');
    setTaskTitle();
    updatePdfOrderFromGrid();
    refreshAll();
    receivingPdfImport = false;
  }
}

// تلاش مجدد برای بارگیری یک کارت ناموفق، بدون نمایش overlay تمام‌صفحه
async function retryItem(it) {
  if (!it || loading || building || it.state !== 'failed') return;
  // تلاش مجدد تکی هم یک «بارگیری» واقعی است؛ فلگ سراسری فعال شود تا دکمه‌های کارت/نوار ابزار
  // و شمارش هشدارها همان رفتار بارگیری سراسری را داشته باشند و کلیک هم‌زمان ممکن نباشد
  loading = true;
  jobCancelRequested = false;
  loadAbortController = new AbortController();
  const signal = loadAbortController.signal;
  it.state = 'loading';
  it.error = '';
  it.selected = false;
  refreshCard(it);
  refreshSummary();
  try {
    // با سیگنال اختصاصی، ESC همانند بارگیری سراسری این تلاش تکی را هم لغو می‌کند
    await loadOne(it, signal);
  } finally {
    loading = false;
    loadAbortController = null;
  }
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
  // جابه‌جایی درگ/دراپ یا مرتب‌سازی دستی، محل کادر گروه‌ها را عوض می‌کند
  drawGroupOutlines();
}

// ---------- انتخاب‌ها ----------
function refreshSummary(groupView = buildPageGroupView()) {
  const ok = items.filter((it) => it.state === 'ok').length;
  const selectedItems = items.filter((it) => it.state === 'ok' && it.selected);
  const sel = selectedItems.length;
  const selectedGroups = [...new Set(selectedItems.map((it) => Number(it.pageGroup)).filter((id) => Number.isInteger(id) && id > 0 && groupView.numberById.has(id)))].sort((a, b) => a - b);
  const failedN = items.filter((it) => it.state === 'failed').length;
  $('selCount').innerText = `${sel} از ${ok} تصویر انتخاب شده`;
  const topCount = $('toolbarSelectionCount');
  if (topCount) topCount.innerText = `${sel} انتخاب`;
  $('btnRetry').classList.toggle('hidden', failedN === 0 || loading);
  $('btnRetry').disabled = building || editingPageGroupId !== null;
  const retryAllButton = $('btnRetryAll');
  if (retryAllButton) {
    retryAllButton.classList.toggle('hidden', failedN === 0 || loading);
    retryAllButton.disabled = building || editingPageGroupId !== null;
  }
  const importPdfButton = $('btnImportPdf');
  if (importPdfButton) importPdfButton.disabled = loading || building || editingPageGroupId !== null;
  ['btnAll', 'btnNone', 'btnInv'].forEach((id) => { $(id).disabled = building || editingPageGroupId !== null; });
  // حذف دسته‌جمعی فقط وقتی ممکن است که حداقل یک کارت سالم انتخاب‌شده وجود داشته باشد
  const deleteSelButton = $('btnDeleteSel');
  if (deleteSelButton) deleteSelButton.disabled = loading || building || editingPageGroupId !== null || sel === 0;
  $('buildBtn').disabled = loading || building || editingPageGroupId !== null || sel === 0;
  $('saveImgBtn').disabled = loading || building || editingPageGroupId !== null || sel === 0;
  $('seamless').disabled = loading || building || $('twoPerPage').checked;
  $('twoPerPage').disabled = loading || building || $('seamless').checked;
  $('uniformSize').disabled = loading || building || $('seamless').checked;
  const groupingUnchanged = selectedGroups.length === 1 && selectedItems.every((it) => Number(it.pageGroup) === selectedGroups[0]);
  const targetGroupNumber = selectedGroups.length ? groupView.numberById.get(selectedGroups[0]) : null;
  if (editingPageGroupId !== null) {
    const currentMembers = new Set(selectedItems.map((it) => it.uid));
    const originalMembers = new Set(items.filter((it) => Number(it.pageGroup) === editingPageGroupId).map((it) => it.uid));
    const changed = currentMembers.size !== originalMembers.size || [...currentMembers].some((uid) => !originalMembers.has(uid));
    const editingNumber = groupView.numberById.get(editingPageGroupId) || editingPageGroupId;
    $('btnGroupPage').disabled = loading || building || sel < 2 || !changed;
    $('btnGroupPage').innerText = `ذخیرهٔ ویرایش گروه ${editingNumber}`;
    $('groupEditStatus').innerText = sel < 2
      ? 'برای حفظ گروه دست‌کم دو کارت را نگه دارید؛ برای حذف کامل گروه از × استفاده کنید.'
      : `ویرایش گروه ${editingNumber}: کارت‌ها را انتخاب یا از انتخاب خارج کنید، سپس تغییرات را ذخیره کنید.`;
    $('btnCancelGroupEdit').classList.remove('hidden');
  } else {
    $('btnGroupPage').disabled = loading || building || sel < 2 || groupingUnchanged;
    $('btnGroupPage').innerText = selectedGroups.length > 1
      ? `ادغام گروه‌ها در گروه ${targetGroupNumber || selectedGroups[0]}`
      : selectedGroups.length === 1
        ? `افزودن انتخاب‌ها به گروه ${targetGroupNumber || selectedGroups[0]}`
        : `ساخت یک گروه از ${sel} انتخاب`;
    $('btnCancelGroupEdit').classList.add('hidden');
  }
  $('btnUngroupPage').disabled = loading || building || editingPageGroupId !== null || !selectedItems.some((it) => it.pageGroup);
  $('ocrEnabled').disabled = loading || building || editingPageGroupId !== null;
  $('btnTranslate').disabled = loading || building || editingPageGroupId !== null || ok === 0 || !$('ocrEnabled').checked;
  $('btnTxt').classList.toggle('hidden', !items.some((it) => it.ocr));
  updateProfileButtons();
  refreshGroupManager(groupView);
  refreshImageWarnings();
}
function refreshAll() {
  const groupView = buildPageGroupView();
  items.forEach((it) => refreshCard(it, groupView));
  refreshSummary(groupView);
  drawGroupOutlines(groupView);
}
function refreshGroupManager(groupView = buildPageGroupView()) {
  const container = $('groupList');
  if (!container) return;
  const groups = groupView.membersById;
  if (!groups.size) {
    container.innerHTML = '<span class="group-empty">هنوز گروهی نساخته‌اید؛ کارت‌های یک صفحه را انتخاب و «ساخت گروه» را بزنید.</span>';
    return;
  }
  container.innerHTML = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([id, members]) => {
    const number = groupView.numberById.get(id);
    const allSelected = members.every((it) => it.selected);
    const label = formatGroupLabel(number, members.length);
    const color = groupColorFor(number);
    const chipStyle = `style="--gc:${color.hex};--gc-rgb:${color.rgb}"`;
    return `<span class="group-chip" ${chipStyle}><button type="button" class="group-select" data-group="${id}" aria-pressed="${allSelected}" title="اعضای گروه را انتخاب می‌کند و به اولین تصویر می‌برد">${label}</button><button type="button" class="group-edit" data-group="${id}" aria-label="ویرایش گروه ${number}" title="ویرایش اعضای این گروه">ویرایش</button><button type="button" class="group-remove" data-group="${id}" aria-label="حذف گروه ${number}" title="حذف این گروه">×</button></span>`;
  }).join('');
  container.querySelectorAll('.group-select').forEach((button) => button.addEventListener('click', () => {
    if (editingPageGroupId !== null) cancelPageGroupEdit();
    const groupId = Number(button.dataset.group);
    const members = items.filter((it) => it.state === 'ok' && Number(it.pageGroup) === groupId);
    items.forEach((it) => { it.selected = members.includes(it); });
    lastClicked = null;
    refreshAll();
    const groupMenu = $('groupMenu');
    if (groupMenu) groupMenu.open = false;
    members.forEach((it) => it.el.classList.add('group-focus'));
    const first = members[0] && members[0].el;
    if (first) {
      first.tabIndex = -1;
      requestAnimationFrame(() => {
        first.focus({ preventScroll: true });
        first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
    setTimeout(() => members.forEach((it) => it.el.classList.remove('group-focus')), 2400);
  }));
  container.querySelectorAll('.group-edit').forEach((button) => button.addEventListener('click', () => {
    if (editingPageGroupId !== null) cancelPageGroupEdit();
    beginPageGroupEdit(Number(button.dataset.group));
  }));
  container.querySelectorAll('.group-remove').forEach((button) => button.addEventListener('click', () => {
    const groupId = Number(button.dataset.group);
    if (editingPageGroupId !== null) cancelPageGroupEdit();
    items.filter((it) => Number(it.pageGroup) === groupId).forEach((it) => { it.pageGroup = null; });
    cleanupPageGroups();
    refreshAll();
  }));
}
function refreshImageWarnings() {
  const notice = $('loadErrors');
  if (!notice) return;
  const failed = items.filter((it) => it.state === 'failed').length;
  const skipped = Number(job && job.skippedInline) || 0;
  const messages = [];
  if (failed) messages.push(`${failed} تصویر بارگیری نشد؛ برای دیدن علت، نشانگر را روی کارت ناموفق نگه دارید.`);
  if (skipped) messages.push(`${skipped} تصویر داخلیِ بزرگ برای جلوگیری از پرشدن فضای افزونه نادیده گرفته شد.`);
  notice.innerText = messages.join(' ');
  notice.classList.toggle('hidden', messages.length === 0);
}
function cleanupPageGroups() {
  const sizes = new Map();
  items.forEach((it) => {
    const id = Number(it.pageGroup);
    if (it.state === 'ok' && Number.isInteger(id) && id > 0) sizes.set(id, (sizes.get(id) || 0) + 1);
    else it.pageGroup = null;
  });
  items.forEach((it) => {
    const id = Number(it.pageGroup);
    if (id && sizes.get(id) < 2) it.pageGroup = null;
  });
  // Internal IDs never change; display ordinals are computed once for both the header and cards.
  const activeIds = [...sizes.keys()].filter((id) => sizes.get(id) >= 2);
  nextPageGroupId = activeIds.length ? Math.max(...activeIds) + 1 : 1;
}
function beginPageGroupEdit(groupId) {
  const members = items.filter((it) => it.state === 'ok' && Number(it.pageGroup) === groupId);
  if (members.length < 2) return;
  editingPageGroupId = groupId;
  editingPageGroupSelection = new Map(items.map((it) => [it.uid, !!it.selected]));
  items.forEach((it) => { if (it.state === 'ok') it.selected = members.includes(it); });
  lastClicked = null;
  const number = buildPageGroupView().numberById.get(groupId) || groupId;
  const status = $('groupEditStatus');
  status.innerText = `ویرایش گروه ${number}: کارت‌ها را انتخاب یا از انتخاب خارج کنید، سپس تغییرات را ذخیره کنید.`;
  status.classList.remove('hidden');
  if ($('groupMenu')) $('groupMenu').open = false;
  refreshAll();
  const first = members[0] && members[0].el;
  if (first) requestAnimationFrame(() => first.scrollIntoView({ behavior: 'smooth', block: 'center' }));
}
function cancelPageGroupEdit() {
  if (editingPageGroupId === null) return;
  if (editingPageGroupSelection) {
    items.forEach((it) => {
      if (editingPageGroupSelection.has(it.uid)) {
        it.selected = editingPageGroupSelection.get(it.uid);
      }
    });
  }
  editingPageGroupId = null;
  editingPageGroupSelection = null;
  $('groupEditStatus').classList.add('hidden');
  refreshAll();
}
function savePageGroupEdit() {
  if (editingPageGroupId === null) return false;
  const selected = items.filter((it) => it.state === 'ok' && it.selected);
  if (selected.length < 2) {
    $('groupEditStatus').innerText = 'برای ذخیرهٔ گروه، دست‌کم دو کارت را انتخاب کنید.';
    $('groupEditStatus').classList.remove('hidden');
    return false;
  }
  const groupId = editingPageGroupId;
  items.filter((it) => Number(it.pageGroup) === groupId).forEach((it) => { it.pageGroup = null; });
  selected.forEach((it) => { it.pageGroup = groupId; });
  editingPageGroupId = null;
  editingPageGroupSelection = null;
  $('groupEditStatus').classList.add('hidden');
  cleanupPageGroups();
  normalizeGroupLayout();
  refreshAll();
  return true;
}
// اعضای هر گروه را در شبکه پشت سر هم (کنار هم) می‌چیند چون قرار است در یک صفحهٔ PDF بیایند؛
// ترتیب نسبی بقیهٔ کارت‌ها دست‌نخورده می‌ماند.
function normalizeGroupLayout() {
  const grid = $('grid');
  const firstRects = captureGridRects();
  const ordered = Array.from(grid.children)
    .map((el) => items.find((it) => it.el === el))
    .filter(Boolean);
  const placed = new Set();
  const nextOrder = [];
  for (const it of ordered) {
    if (placed.has(it)) continue;
    const gid = Number(it.pageGroup);
    if (gid && gid > 0) {
      ordered.filter((x) => Number(x.pageGroup) === gid).forEach((member) => {
        placed.add(member);
        nextOrder.push(member);
      });
    } else {
      placed.add(it);
      nextOrder.push(it);
    }
  }
  nextOrder.forEach((it) => grid.appendChild(it.el));
  updatePdfOrderFromGrid();
  playGridMove(firstRects);
}
function groupSelectedItems() {
  if (editingPageGroupId !== null) { savePageGroupEdit(); return; }
  const selected = items.filter((it) => it.state === 'ok' && it.selected);
  if (selected.length < 2) return;
  const existingIds = [...new Set(selected.map((it) => Number(it.pageGroup)).filter((id) => Number.isInteger(id) && id > 0))].sort((a, b) => a - b);
  const groupId = existingIds[0] || nextPageGroupId++;
  if (selected.every((it) => Number(it.pageGroup) === groupId)) return;
  selected.forEach((it) => { it.pageGroup = groupId; });
  cleanupPageGroups();
  normalizeGroupLayout();
  refreshAll();
}
function ungroupSelectedItems() {
  items.filter((it) => it.state === 'ok' && it.selected).forEach((it) => { it.pageGroup = null; });
  cleanupPageGroups();
  refreshAll();
}

// ---------- گروه‌بندی با کشیدن کارت روی کارت ----------
function clearDragDropHint() {
  if (dragDropTargetEl) {
    dragDropTargetEl.classList.remove('group-drop-target');
    dragDropTargetEl = null;
  }
  dragGroupDrop = false;
  $('grid').classList.remove('extract-zone');
  clearInsertMarker();
}

// جابه‌جایی ترتیبی با درگ: اگر کارت کشیده‌شده عضو گروه باشد، کل بلوک گروه با هم جابه‌جا می‌شود.
// طرح درج: کدام المان‌ها جابه‌جا می‌شوند (تکی یا بلوک گروه) و لنگر کجاست.
// لنگر هرگز داخل بلوک یک گروه بیگانه نمی‌افتد تا گروهی از هم نپاشد.
function planDrop(dragged, targetEl, before) {
  const gid = Number(dragged.pageGroup);
  const hasGroup = gid > 0 && items.some((it) => it.state === 'ok' && Number(it.pageGroup) === gid);
  const movingEls = hasGroup ? gridGroupBlock(gid) : [dragged.el];
  if (movingEls.includes(targetEl)) return null; // روی اعضای بلوک خودی، جابه‌جایی بی‌اثر است
  let anchor = before ? targetEl : targetEl.nextSibling;
  // اگر هدف عضو یک گروه بیگانه است، لنگر را به لبهٔ بیرونی بلوک آن گروه محدود کن
  const targetItem = items.find((it) => it.el === targetEl);
  const tg = Number(targetItem && targetItem.pageGroup);
  if (tg > 0 && tg !== gid) {
    const foreignBlock = gridGroupBlock(tg);
    if (foreignBlock.includes(targetEl)) {
      anchor = before ? foreignBlock[0] : foreignBlock[foreignBlock.length - 1].nextSibling;
    }
  }
  if (anchor && movingEls.includes(anchor)) return null;
  return { movingEls, anchor };
}

// پیش‌نمایش زندهٔ شماره صفحه‌ها حین درگ (بدون جابه‌جایی DOM تا لحظهٔ رهاکردن)
function previewOrderFor(movingEls, anchorNode) {
  const grid = $('grid');
  const tentative = Array.from(grid.children).filter((el) => !movingEls.includes(el));
  const anchorIndex = anchorNode ? tentative.indexOf(anchorNode) : tentative.length;
  tentative.splice(anchorIndex, 0, ...movingEls);
  tentative.forEach((el, index) => {
    const input = el.querySelector('.page-order');
    if (!input) return;
    const next = String(index + 1);
    // فقط ورودی‌هایی که شماره‌شان واقعاً عوض شده به‌روز و فلش می‌شوند (جلوگیری از reflow و انیمیشن بی‌مورد در هر dragover)
    if (input.value === next) return;
    input.value = next;
    input.classList.remove('order-flash');
    void input.offsetWidth;
    input.classList.add('order-flash');
  });
}
function previewDragOrder(dragged, targetEl, before) {
  const plan = planDrop(dragged, targetEl, before);
  if (!plan) { restoreDragOrderPreview(); return; }
  previewOrderFor(plan.movingEls, plan.anchor);
}
// بازگرداندن شماره‌ها به ترتیب واقعی فعلی شبکه (وقتی درگ لغو می‌شود یا روی نوار گروهی می‌رویم)
function restoreDragOrderPreview() {
  Array.from($('grid').children).forEach((el, index) => {
    const input = el.querySelector('.page-order');
    if (!input) return;
    if (input.classList.contains('order-flash')) input.classList.remove('order-flash');
    const next = String(index + 1);
    if (input.value !== next) input.value = next;
  });
}

function reorderByDrop(dragged, targetEl, before) {
  const grid = $('grid');
  const plan = planDrop(dragged, targetEl, before);
  if (!plan) return false;
  const firstRects = captureGridRects();
  plan.movingEls.forEach((el) => grid.insertBefore(el, plan.anchor));
  updatePdfOrderFromGrid();
  playGridMove(firstRects);
  return true;
}

// چیدمان داخلی گروه: فقط همان کارتِ کشیده‌شده بین اعضای «همین» بلوک جابه‌جا می‌شود؛
// بلوک گروه پیوسته و سرجایش می‌ماند و عضویت گروه هیچ تغییری نمی‌کند.
function buildInternalOrder(dragged, targetEl, before) {
  const gid = Number(dragged.pageGroup);
  if (!gid) return null;
  const blockEls = gridGroupBlock(gid);
  if (!blockEls.includes(dragged.el) || !blockEls.includes(targetEl)) return null;
  const remaining = blockEls.filter((el) => el !== dragged.el);
  const targetIndex = remaining.indexOf(targetEl);
  if (targetIndex < 0) return null;
  const insertAt = before ? targetIndex : targetIndex + 1;
  remaining.splice(insertAt, 0, dragged.el);
  return { blockEls, nextBlockEls: remaining };
}

// پیش‌نمایش شماره صفحه‌ها برای جابه‌جایی داخل گروه (بدون تغییر DOM تا لحظهٔ رهاکردن)
function previewInternalOrder(dragged, targetEl, before) {
  const grid = $('grid');
  const plan = buildInternalOrder(dragged, targetEl, before);
  if (!plan) { restoreDragOrderPreview(); return; }
  const tentative = [];
  for (const el of Array.from(grid.children)) {
    if (el === plan.blockEls[0]) tentative.push(...plan.nextBlockEls);
    if (plan.blockEls.includes(el)) continue;
    tentative.push(el);
  }
  tentative.forEach((el, index) => {
    const input = el.querySelector('.page-order');
    if (!input) return;
    const next = String(index + 1);
    if (input.value === next) return;
    input.value = next;
    input.classList.remove('order-flash');
    void input.offsetWidth;
    input.classList.add('order-flash');
  });
}

// اعمال جابه‌جایی داخل گروه روی DOM؛ اگر عملاً ترتیبی عوض نشده false برمی‌گرداند
function reorderWithinGroup(dragged, targetEl, before) {
  const plan = buildInternalOrder(dragged, targetEl, before);
  if (!plan) return false;
  const unchanged = plan.nextBlockEls.every((el, i) => el === plan.blockEls[i]);
  if (unchanged) return false;
  const grid = $('grid');
  // لنگرِ بعد از بلوک ثابت می‌ماند تا گروه پیوسته و در همان موقعیت قبلی بازچیده شود
  const anchorAfterBlock = plan.blockEls[plan.blockEls.length - 1].nextSibling;
  const firstRects = captureGridRects();
  plan.nextBlockEls.forEach((el) => grid.insertBefore(el, anchorAfterBlock));
  updatePdfOrderFromGrid();
  playGridMove(firstRects);
  return true;
}

// ---------- رهاکردن در فضای خالی شبکه: استخراج تک‌کارت از گروه ----------
// نزدیک‌ترین کارت به نشانگر را لنگر درج می‌کند؛ RTL: نیمهٔ راست کارت یعنی درج قبل از آن
function nearestCardAnchor(clientX, clientY) {
  const cards = Array.from($('grid').querySelectorAll('.item'));
  if (!cards.length) return { anchorEl: null, before: false };
  let anchorEl = null, bestDist = Infinity;
  for (const el of cards) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const dist = Math.hypot(cx - clientX, cy - clientY);
    if (dist < bestDist) { bestDist = dist; anchorEl = el; }
  }
  const r = anchorEl.getBoundingClientRect();
  return { anchorEl, before: clientX > r.left + r.width / 2 };
}

// پیش‌نمایش رهاکردن در فضای خالی: همیشه حرکت یک کارت تکی است (نه بلوک گروه)
function previewEmptyAreaDrop(clientX, clientY) {
  const { anchorEl, before } = nearestCardAnchor(clientX, clientY);
  if (!anchorEl || anchorEl === draggedItem.el) {
    $('grid').classList.remove('extract-zone');
    clearInsertMarker();
    restoreDragOrderPreview();
    return;
  }
  $('grid').classList.add('extract-zone');
  setInsertMarker(anchorEl, before, false);
  previewOrderFor([draggedItem.el], before ? anchorEl : anchorEl.nextSibling);
}

// کارت کشیده‌شده در فضای خالی رها شده؛ اگر عضو گروه باشد فقط همان کارت از گروه خارج می‌شود
function dropOnEmptyArea(clientX, clientY) {
  const { anchorEl, before } = nearestCardAnchor(clientX, clientY);
  if (!anchorEl || anchorEl === draggedItem.el) return false;
  const anchorNode = before ? anchorEl : anchorEl.nextSibling;
  if (anchorNode === draggedItem.el) return false;
  const wasGrouped = Number(draggedItem.pageGroup) > 0;
  const grid = $('grid');
  const firstRects = captureGridRects();
  if (wasGrouped) draggedItem.pageGroup = null;
  grid.insertBefore(draggedItem.el, anchorNode);
  // اگر گروه با خروج این کارت تک‌عضو شود، cleanup خودش آن گروه را منحل می‌کند
  if (wasGrouped) cleanupPageGroups();
  updatePdfOrderFromGrid();
  playGridMove(firstRects);
  return true;
}

// رهاکردن کارت کشیده‌شده روی کارت هدف: گروه تازه، یا عضویت در گروه موجود
function groupCardsByDrop(dragged, targetItem) {
  if (!dragged || !targetItem || dragged === targetItem) return;
  if (dragged.state !== 'ok' || targetItem.state !== 'ok') return;
  const targetGroup = Number(targetItem.pageGroup) || null;
  const draggedGroup = Number(dragged.pageGroup) || null;
  if (targetGroup && draggedGroup === targetGroup) return; // از قبل هم‌گروه‌اند
  if (targetGroup) {
    // کارت کشیده‌شده به گروه کارت هدف ملحق می‌شود (اگر گروه قبلی تک‌عضو شود، cleanup حذفش می‌کند)
    dragged.pageGroup = targetGroup;
  } else if (draggedGroup) {
    // کارت هدف به گروه کارت کشیده‌شده ملحق می‌شود
    targetItem.pageGroup = draggedGroup;
  } else {
    // هیچ‌کدام گروه ندارند: گروه تازه با هر دو
    const groupId = nextPageGroupId++;
    dragged.pageGroup = groupId;
    targetItem.pageGroup = groupId;
  }
  cleanupPageGroups();
  normalizeGroupLayout();
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

function cropImageDimensions() {
  const base = cropItem && (cropItem.edited || cropItem);
  return { w: Math.max(1, Number(base && base.w) || Number(cropItem && cropItem.w) || 1), h: Math.max(1, Number(base && base.h) || Number(cropItem && cropItem.h) || 1) };
}
function cropAspectRatio() {
  const value = $('cropRatio').value;
  if (!value || value === 'free') return null;
  const parts = value.split('/').map(Number);
  return parts.length === 2 && parts[0] > 0 && parts[1] > 0 ? parts[0] / parts[1] : null;
}
function syncCropDimensionInputs(rect = cropRectDraft) {
  const { w, h } = cropImageDimensions();
  $('cropWidth').placeholder = String(w);
  $('cropHeight').placeholder = String(h);
  $('cropWidth').max = String(w);
  $('cropHeight').max = String(h);
  $('cropWidth').value = rect && rect.w > 0 ? String(Math.max(1, Math.round(rect.w * w))) : '';
  $('cropHeight').value = rect && rect.h > 0 ? String(Math.max(1, Math.round(rect.h * h))) : '';
}
function cropPoint(ev) {
  const r = $('cropImg').getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { x: Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)) };
}
function paintCropSelection(rect, preserveInput = null) {
  const preservedValue = preserveInput ? $(preserveInput).value : null;
  const el = $('cropSelection');
  if (!rect || rect.w <= 0 || rect.h <= 0) {
    el.style.display = 'none';
    syncCropDimensionInputs(null);
  } else {
    el.style.display = 'block';
    el.style.left = (rect.x * 100) + '%'; el.style.top = (rect.y * 100) + '%';
    el.style.width = (rect.w * 100) + '%'; el.style.height = (rect.h * 100) + '%';
    syncCropDimensionInputs(rect);
  }
  if (preserveInput) $(preserveInput).value = preservedValue;
}
function updateCropFromInputs(changed, live = false) {
  if (!cropItem) return;
  const size = cropImageDimensions();
  const old = cropRectDraft || { x: 0, y: 0, w: 1, h: 1 };
  const oldW = Math.max(1, Math.round(old.w * size.w)), oldH = Math.max(1, Math.round(old.h * size.h));
  const read = (id, fallback) => {
    const n = Number.parseInt($(id).value, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  let width = Math.min(size.w, read('cropWidth', oldW));
  let height = Math.min(size.h, read('cropHeight', oldH));
  const ratio = cropAspectRatio();
  if (ratio) {
    if (changed === 'width') height = Math.max(1, Math.round(width / ratio));
    else if (changed === 'height') width = Math.max(1, Math.round(height * ratio));
    const fit = Math.min(1, size.w / width, size.h / height);
    width = Math.max(1, Math.round(width * fit));
    height = Math.max(1, Math.round(height * fit));
  }
  width = Math.min(size.w, width); height = Math.min(size.h, height);
  const centerX = old.x + old.w / 2, centerY = old.y + old.h / 2;
  const w = width / size.w, h = height / size.h;
  const x = Math.max(0, Math.min(1 - w, centerX - w / 2));
  const y = Math.max(0, Math.min(1 - h, centerY - h / 2));
  cropRectDraft = { x, y, w, h };
  paintCropSelection(cropRectDraft, live ? (changed === 'height' ? 'cropHeight' : 'cropWidth') : null);
}
function adjustCropToRatio() {
  if (!cropItem || !cropRectDraft) return;
  const ratio = cropAspectRatio();
  if (!ratio) return;
  const size = cropImageDimensions();
  let width = cropRectDraft.w * size.w, height = cropRectDraft.h * size.h;
  if (width / height > ratio) width = height * ratio;
  else height = width / ratio;
  const w = width / size.w, h = height / size.h;
  cropRectDraft = {
    x: Math.max(0, Math.min(1 - w, cropRectDraft.x + (cropRectDraft.w - w) / 2)),
    y: Math.max(0, Math.min(1 - h, cropRectDraft.y + (cropRectDraft.h - h) / 2)),
    w, h
  };
  paintCropSelection(cropRectDraft);
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
  $('cropStage').focus();
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
  else if (cropRectDraft.w > 0 && cropRectDraft.h > 0) cropItem.cropRect = { ...cropRectDraft };
  cropItem.cropCache = null;
  const it = cropItem;
  closeCropper();
  refreshCard(it);
  drawThumb(it);
}
function cropPxRect(rect, size) {
  return { x1: rect.x * size.w, y1: rect.y * size.h, x2: (rect.x + rect.w) * size.w, y2: (rect.y + rect.h) * size.h };
}
function saveCropPxRect(r, size) {
  const x1 = Math.max(0, Math.min(size.w - 1, Math.min(r.x1, r.x2)));
  const y1 = Math.max(0, Math.min(size.h - 1, Math.min(r.y1, r.y2)));
  const x2 = Math.max(x1 + 1, Math.min(size.w, Math.max(r.x1, r.x2)));
  const y2 = Math.max(y1 + 1, Math.min(size.h, Math.max(r.y1, r.y2)));
  cropRectDraft = { x: x1 / size.w, y: y1 / size.h, w: (x2 - x1) / size.w, h: (y2 - y1) / size.h };
  paintCropSelection(cropRectDraft);
}
function beginCropSelection(ev) {
  if (!cropItem || ev.button !== 0) return;
  ev.preventDefault();
  const p = cropPoint(ev);
  if (!p) return;
  const size = cropImageDimensions();
  const handleEl = ev.target && ev.target.closest ? ev.target.closest('.crop-handle') : null;
  const inside = ev.target && ev.target.closest && ev.target.closest('#cropSelection') && cropRectDraft && cropRectDraft.w > 0;
  if (inside) {
    cropDragStart = {
      mode: handleEl ? 'resize' : 'move',
      handle: handleEl ? handleEl.dataset.handle : null,
      point: p,
      rect: cropPxRect(cropRectDraft, size)
    };
  } else {
    // انتخاب تازه دقیقاً از نقطهٔ فشار موس شروع می‌شود و با محل رهاکردن تمام می‌شود.
    cropDragStart = { mode: 'draw', point: p };
    cropRectDraft = { x: p.x, y: p.y, w: 0, h: 0 };
    paintCropSelection(cropRectDraft);
  }
  $('cropStage').setPointerCapture(ev.pointerId);
}
function updateCropDraw(p, size, start) {
  const dx = (p.x - start.x) * size.w, dy = (p.y - start.y) * size.h;
  let width = Math.abs(dx), height = Math.abs(dy);
  const ratio = cropAspectRatio();
  if (ratio && width > 0 && height > 0) {
    width = Math.min(width, height * ratio);
    height = width / ratio;
  }
  const x = dx < 0 ? start.x - width / size.w : start.x;
  const y = dy < 0 ? start.y - height / size.h : start.y;
  cropRectDraft = { x, y, w: width / size.w, h: height / size.h };
  paintCropSelection(cropRectDraft);
}
function resizeCrop(p, size, drag) {
  const r = { ...drag.rect };
  const dx = (p.x - drag.point.x) * size.w, dy = (p.y - drag.point.y) * size.h;
  const h = drag.handle;
  if (h.includes('w')) r.x1 += dx;
  if (h.includes('e')) r.x2 += dx;
  if (h.includes('n')) r.y1 += dy;
  if (h.includes('s')) r.y2 += dy;
  r.x1 = Math.max(0, Math.min(size.w - 1, r.x1)); r.x2 = Math.max(1, Math.min(size.w, r.x2));
  r.y1 = Math.max(0, Math.min(size.h - 1, r.y1)); r.y2 = Math.max(1, Math.min(size.h, r.y2));
  if (r.x2 <= r.x1) { if (h.includes('w')) r.x1 = r.x2 - 1; else r.x2 = r.x1 + 1; }
  if (r.y2 <= r.y1) { if (h.includes('n')) r.y1 = r.y2 - 1; else r.y2 = r.y1 + 1; }
  const ratio = cropAspectRatio();
  if (ratio) {
    let width = r.x2 - r.x1, height = r.y2 - r.y1;
    if (h === 'e' || h === 'w') height = width / ratio;
    else if (h === 'n' || h === 's') width = height * ratio;
    else if (width / height > ratio) height = width / ratio;
    else width = height * ratio;
    if (h.includes('w')) r.x1 = r.x2 - width; else if (h.includes('e')) r.x2 = r.x1 + width; else { const cx = (r.x1 + r.x2) / 2; r.x1 = cx - width / 2; r.x2 = cx + width / 2; }
    if (h.includes('n')) r.y1 = r.y2 - height; else if (h.includes('s')) r.y2 = r.y1 + height; else { const cy = (r.y1 + r.y2) / 2; r.y1 = cy - height / 2; r.y2 = cy + height / 2; }
    const shiftX = Math.max(0, -r.x1) + Math.min(0, size.w - r.x2);
    const shiftY = Math.max(0, -r.y1) + Math.min(0, size.h - r.y2);
    r.x1 += shiftX; r.x2 += shiftX; r.y1 += shiftY; r.y2 += shiftY;
    r.x1 = Math.max(0, r.x1); r.y1 = Math.max(0, r.y1); r.x2 = Math.min(size.w, r.x2); r.y2 = Math.min(size.h, r.y2);
  }
  saveCropPxRect(r, size);
}
function moveCropSelection(ev) {
  if (!cropDragStart) return;
  const p = cropPoint(ev);
  if (!p) return;
  const size = cropImageDimensions();
  const drag = cropDragStart;
  if (drag.mode === 'draw') { updateCropDraw(p, size, drag.point); return; }
  if (drag.mode === 'resize') { resizeCrop(p, size, drag); return; }
  const dx = (p.x - drag.point.x) * size.w, dy = (p.y - drag.point.y) * size.h;
  const width = drag.rect.x2 - drag.rect.x1, height = drag.rect.y2 - drag.rect.y1;
  const x1 = Math.max(0, Math.min(size.w - width, drag.rect.x1 + dx));
  const y1 = Math.max(0, Math.min(size.h - height, drag.rect.y1 + dy));
  saveCropPxRect({ x1, y1, x2: x1 + width, y2: y1 + height }, size);
}
function endCropSelection(ev) {
  if (cropDragStart && ev && Number.isFinite(ev.clientX) && Number.isFinite(ev.clientY)) moveCropSelection(ev);
  cropDragStart = null;
}
function cancelCropSelection() { cropDragStart = null; }
function handleOverlayKeydown(e) {
  const cropOpen = !$('cropper').classList.contains('hidden');
  if (e.key === 'Enter' && cropOpen) {
    if (e.target && e.target.closest && e.target.closest('.crop-actions button')) return;
    if (e.target && e.target.id === 'cropWidth') updateCropFromInputs('width');
    else if (e.target && e.target.id === 'cropHeight') updateCropFromInputs('height');
    else if (e.target && e.target.id === 'cropRatio') adjustCropToRatio();
    e.preventDefault();
    applyCrop();
    return;
  }
  if (e.key !== 'Escape') return;
  if (cropOpen) closeCropper();
  else if (!$('lightbox').classList.contains('hidden')) closeLightbox();
}

// ---------- آماده‌سازی تصاویر برای PDF ----------
async function decodeSlices(it, maxSrcH) {
  // it می‌تواند خود تصویر یا نسخهٔ ویرایش‌شده (edited) باشد
  const bmp = await createImageBitmap(it.blob, { imageOrientation: 'none' });
  // JPEG فقط برای منبع JPEG استفاده می‌شود؛ WebP/AVIF/SVG و سایر فرمت‌ها بدون افتِ اضافه به PNG می‌روند.
  const asPng = !it.info || it.info.fmt !== 'JPEG';
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
      const data = canvas.toDataURL(asPng ? 'image/png' : 'image/jpeg', 1);
      canvas.width = canvas.height = 0;
      segs.push({ data, fmt: asPng ? 'PNG' : 'JPEG', w: bmp.width, h: sh, alias: `i${it.pdfKey || it.uid || it.i}_${y}` });
    }
  } finally { bmp.close(); }
  return segs;
}

async function prepare(it, r) {
  const src = await getDisplaySource(it);
  // در نسبت‌های بسیار بزرگ، مقدار صفر باعث حلقهٔ بی‌پایان decodeSlices می‌شد؛ حداقل یک پیکسل کافی است.
  const rawMax = Math.max(1, Math.floor(PdfBuilder.SAFE_PT / r));
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
  const data = canvas.toDataURL('image/jpeg', 1);
  canvas.width = canvas.height = 0;
  return { data, fmt: 'JPEG' };
}

async function composeVertically(group, pageKey) {
  const sources = await Promise.all(group.map(getDisplaySource));
  const targetWidths = sources.map((src) => src.w);
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
    if (jobCancelRequested) break;
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
    sequence: Math.min(...group.map((it) => it.sequence)), blob, w, h,
    info: sniff(new Uint8Array(await blob.arrayBuffer()))
  };
}

async function makePdfItems(selected, twoPerPage) {
  let sequence = 0;
  const expanded = [];
  for (const it of selected) {
    if (jobCancelRequested) break;
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
    if (jobCancelRequested) break;
    members.sort((a, b) => a.sequence - b.sequence);
    pages.push(members.length > 1 ? await composeVertically(members, `group_${groupId}`) : members[0]);
  }
  const chunkSize = twoPerPage ? 2 : 1;
  for (let i = 0; i < ungrouped.length && !jobCancelRequested; i += chunkSize) {
    const chunk = ungrouped.slice(i, i + chunkSize);
    pages.push(chunk.length > 1 ? await composeVertically(chunk, `pair_${chunk[0].sequence}`) : chunk[0]);
  }
  if (jobCancelRequested) return [];
  // Group IDs only define membership; PDF page order always follows the earliest card position.
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
  jobCancelRequested = false;
  setJobHint(true);
  refreshSummary();
  let name = $('pdfName').value.trim() || 'comic';
  if (!name.toLowerCase().endsWith('.pdf')) name += '.pdf';
  const seamless = $('seamless').checked;
  const twoPerPage = $('twoPerPage').checked && !seamless;
  const uniformSize = $('uniformSize').checked;

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
    if (jobCancelRequested) { setStatus('ساخت PDF با کلید ESC لغو شد.'); return; }
    const res = await PdfBuilder.build({
      jsPDF: jsPDFLib,
      items: pdfItems,
      seamless,
      uniformSize,
      prepare,
      fallback,
      isCancelled: () => jobCancelRequested,
      onProgress: (k, n) => {
        $('progressBar').style.width = Math.round((k / n) * 95) + '%';
        if (k < n) setStatus(`در حال پردازش تصویر ${k + 1} از ${n}...`);
      },
      onPage: (p) => { $('sPages').innerText = p; }
    });

    if (res.cancelled || jobCancelRequested) { setStatus('ساخت PDF با کلید ESC لغو شد.'); return; }
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
    if (seamless) layoutNotes.push('همه تصاویر در یک صفحه');
    else if (twoPerPage) layoutNotes.push('دو تصویر عمودی در هر صفحه');
    if (uniformSize) layoutNotes.push('اندازهٔ قاب صفحه‌ها یکسان');
    const layoutNote = layoutNotes.length ? ` (${layoutNotes.join('، ')})` : '';
    setStatus(`آماده شد! فایل PDF با ${res.pages} صفحه${layoutNote} ساخته شد. اگر دانلود شروع نشد، دکمهٔ «دانلود PDF» را بزنید.`);
    btn.click();
  } catch (e) {
    console.error(e);
    setStatus('خطا در ساخت PDF: ' + (e && e.message ? e.message : e));
  } finally {
    building = false;
    setJobHint(false);
    setTaskTitle();
    refreshSummary();
  }
}
function setStatus(t) { $('statusText').innerText = t; if (building) setTaskTitle(t); }

// ---------- ذخیرهٔ تصاویر به‌صورت جدا ----------
let mode = 'pdf';
function setMode(m) {
  mode = m;
  $('outputSettings').dataset.mode = m;
  $('modePdf').classList.toggle('active', m === 'pdf');
  $('modeImg').classList.toggle('active', m === 'img');
  $('modePdf').setAttribute('aria-pressed', String(m === 'pdf'));
  $('modeImg').setAttribute('aria-pressed', String(m === 'img'));
  $('pdfOpts').classList.toggle('hidden', m !== 'pdf');
  $('imgOpts').classList.toggle('hidden', m !== 'img');
  $('buildBtn').classList.toggle('hidden', m !== 'pdf');
  $('saveImgBtn').classList.toggle('hidden', m !== 'img');
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
  jobCancelRequested = false;
  setJobHint(true);
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
      if (jobCancelRequested) break;
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
          try {
            await w.write(ex.blob);
          } finally {
            // بستن stream حتی هنگام خطا، فایل موقت ناقص را پاک می‌کند
            await w.close();
          }
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
    if (jobCancelRequested) {
      setStatus(saved
        ? `ذخیره‌سازی با کلید ESC لغو شد؛ ${saved} تصویر از ${sel.length} تصویر قبلاً در «${folderLabel}» ذخیره شده بود.`
        : 'ذخیره‌سازی تصاویر با کلید ESC لغو شد.');
    } else {
      setStatus(saved
        ? `${note}${saved} تصویر ${fmt === 'png' ? 'با فرمت PNG (بدون افت کیفیت)' : fmt === 'jpg' ? 'با فرمت JPEG (کیفیت ۱۰۰٪؛ فایل‌های JPEG اصلی دست‌نخورده)' : 'با فرمت و کیفیت اصلی'} در «${folderLabel}» ذخیره شد.`
        : 'هیچ تصویری ذخیره نشد.');
    }
    if (errors.length) $('failed').innerText = `${errors.length} تصویر ذخیره نشد:\n` + errors.slice(0, 5).join('\n');
  } catch (e) {
    console.error(e);
    setStatus('خطا در ذخیرهٔ تصاویر: ' + (e && e.message ? e.message : e));
  } finally {
    building = false;
    setJobHint(false);
    setTaskTitle();
    refreshSummary();
  }
}

// ---------- پروفایل تنظیمات برای هر صفحه ----------
function makePageProfileKey(url) {
  if (!url) return '';
  let hash = 2166136261;
  for (let i = 0; i < url.length; i++) { hash ^= url.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return `page_profile_${(hash >>> 0).toString(16)}`;
}
function profileImageIdentity(url) {
  const text = String(url || '');
  let stable = text;
  if (/^blob:/i.test(text)) return 'blob';
  if (/^https?:\/\//i.test(text)) {
    try { const parsed = new URL(text); stable = `${parsed.origin}${parsed.pathname}`; } catch {}
  } else if (text.length > 2048) stable = `${text.slice(0, 1024)}${text.slice(-256)}_${text.length}`;
  let hash = 2166136261;
  for (let i = 0; i < stable.length; i++) { hash ^= stable.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return `${stable.length}_${(hash >>> 0).toString(16)}`;
}
function updateProfileButtons() {
  const saving = $('saveProfileBtn');
  if (!saving) return;
  saving.disabled = loading || building || editingPageGroupId !== null || !pageProfileKey;
  $('restoreProfileBtn').disabled = loading || building || editingPageGroupId !== null || !pageProfileAvailable;
  $('deleteProfileBtn').disabled = loading || building || editingPageGroupId !== null || !pageProfileAvailable;
  $('deleteProfileBtn').classList.toggle('hidden', !pageProfileAvailable);
}
async function checkSavedPageProfile() {
  if (!pageProfileKey) {
    pageProfileAvailable = false;
    $('profileStatus').innerText = 'نشانی این صفحه برای ساخت پروفایل در دسترس نیست.';
    updateProfileButtons();
    return;
  }
  try {
    const stored = await chrome.storage.local.get(pageProfileKey);
    const profile = stored[pageProfileKey];
    pageProfileAvailable = !!(profile && profile.pageUrl === job.pageUrl && Array.isArray(profile.items));
    $('profileStatus').innerText = pageProfileAvailable
      ? 'برای این صفحه پروفایل ذخیره‌شده دارید؛ هر زمان خواستید آن را بازیابی کنید.'
      : 'برای این صفحه هنوز پروفایلی ذخیره نشده است.';
  } catch {
    pageProfileAvailable = false;
    $('profileStatus').innerText = 'خواندن پروفایل ذخیره‌شده ناموفق بود.';
  }
  updateProfileButtons();
}
function collectPageProfile() {
  const gridOrder = Array.from($('grid').children)
    .map((el) => items.find((it) => it.el === el)).filter(Boolean);
  return {
    version: 1,
    pageUrl: job.pageUrl || '',
    savedAt: Date.now(),
    sourceImages: (job.urls || []).map((url, sourceIndex) => ({ sourceIndex, identity: profileImageIdentity(url) })),
    settings: {
      mode,
      seamless: $('seamless').checked,
      uniformSize: $('uniformSize').checked,
      twoPerPage: $('twoPerPage').checked,
      pdfName: $('pdfName').value,
      folderName: $('folderName').value,
      outFmt: $('outFmt').value,
      ocrEnabled: $('ocrEnabled').checked,
      trLang: $('trLang').value,
      trOnlySel: $('trOnlySel').checked,
      trErase: $('trErase').checked,
      trPrecise: $('trPrecise').checked,
      cropRatio: $('cropRatio').value
    },
    items: gridOrder.map((it) => ({
      uid: it.uid,
      sourceIndex: it.i,
      sourceIdentity: profileImageIdentity(it.url),
      isDuplicate: !!it.dupNo,
      dupNo: it.dupNo || 0,
      selected: !!it.selected,
      pdfOrder: Number(it.pdfOrder) || it.i + 1,
      pageGroup: it.pageGroup || null,
      cropRect: it.cropRect ? { ...it.cropRect } : null
    }))
  };
}
async function savePageProfile() {
  if (!pageProfileKey || loading || building) return;
  try {
    const profile = collectPageProfile();
    await chrome.storage.local.set({ [pageProfileKey]: profile });
    pageProfileAvailable = true;
    $('profileStatus').innerText = `پروفایل این صفحه ذخیره شد (${profile.items.length} تصویر/کپی).`;
    updateProfileButtons();
  } catch (e) {
    console.error('ذخیرهٔ پروفایل ناموفق بود', e);
    $('profileStatus').innerText = 'ذخیرهٔ پروفایل ناموفق بود؛ فضای ذخیره‌سازی را بررسی کنید.';
  }
}
async function deletePageProfile() {
  if (!pageProfileKey || !pageProfileAvailable || loading || building) return;
  if (!confirm('پروفایل ذخیره‌شدهٔ این صفحه حذف شود؟')) return;
  try {
    await chrome.storage.local.remove(pageProfileKey);
    pageProfileAvailable = false;
    $('profileStatus').innerText = 'پروفایل این صفحه حذف شد.';
    updateProfileButtons();
  } catch { $('profileStatus').innerText = 'حذف پروفایل ناموفق بود.'; }
}
function applyProfileSettings(settings = {}) {
  if (typeof settings.pdfName === 'string') $('pdfName').value = settings.pdfName;
  if (typeof settings.folderName === 'string') $('folderName').value = settings.folderName;
  if (['orig', 'png', 'jpg'].includes(settings.outFmt)) $('outFmt').value = settings.outFmt;
  if (['free', '1/1', '4/3', '3/4', '16/9', '9/16'].includes(settings.cropRatio)) $('cropRatio').value = settings.cropRatio;
  if (['eng', 'kor', 'jpn', 'chi_sim'].includes(settings.trLang)) $('trLang').value = settings.trLang;
  for (const id of ['trOnlySel', 'trErase', 'trPrecise']) if (typeof settings[id] === 'boolean') $(id).checked = settings[id];
  const seamless = !!settings.seamless;
  $('seamless').checked = seamless;
  $('twoPerPage').checked = !seamless && !!settings.twoPerPage;
  $('uniformSize').checked = !seamless && !!settings.uniformSize;
  if (settings.mode === 'pdf' || settings.mode === 'img') setMode(settings.mode);
  if (typeof settings.ocrEnabled === 'boolean' && $('ocrEnabled').checked !== settings.ocrEnabled) {
    $('ocrEnabled').checked = settings.ocrEnabled;
    $('ocrEnabled').dispatchEvent(new Event('change', { bubbles: true }));
  }
}
async function restorePageProfile() {
  if (!pageProfileKey || !pageProfileAvailable || loading || building) return;
  if (editingPageGroupId !== null) cancelPageGroupEdit();
  try {
    const stored = await chrome.storage.local.get(pageProfileKey);
    const profile = stored[pageProfileKey];
    if (!profile || profile.pageUrl !== job.pageUrl || !Array.isArray(profile.items)) {
      pageProfileAvailable = false;
      $('profileStatus').innerText = 'پروفایل معتبر برای این صفحه پیدا نشد.';
      updateProfileButtons();
      return;
    }
    const grid = $('grid');
    const baseItems = items.filter((it) => !it.dupNo);
    items.filter((it) => it.dupNo && it.el && it.el.parentNode).forEach((it) => it.el.parentNode.removeChild(it.el));
    items = baseItems.slice();
    applyProfileSettings(profile.settings || {});
    const usedUids = new Set();
    let fallbackUid = Math.max(nextItemUid, ...baseItems.map((it) => it.uid + 1), 0);
    const restored = [];
    const sourceRecords = profile.sourceImages || profile.items;
    const sourceIndices = new Set(sourceRecords.filter((record) => {
      const source = baseItems.find((it) => it.i === Number(record.sourceIndex));
      return !!source && (!record.identity || record.identity === profileImageIdentity(source.url));
    }).map((record) => Number(record.sourceIndex)));
    for (const entry of profile.items) {
      const sourceIndex = Number(entry.sourceIndex);
      const source = baseItems.find((it) => it.i === sourceIndex);
      if (!source || (entry.sourceIdentity && entry.sourceIdentity !== profileImageIdentity(source.url))) continue;
      let it;
      if (entry.isDuplicate) {
        if (source.state !== 'ok') continue;
        it = makeDuplicateData(source);
        it.dupNo = Number(entry.dupNo) || (items.filter((x) => x.i === sourceIndex && x.dupNo).length + 1);
        it.el = makeCard(it);
      } else it = source;
      const proposedUid = Number(entry.uid);
      if (Number.isInteger(proposedUid) && proposedUid >= 0 && !usedUids.has(proposedUid)) it.uid = proposedUid;
      else { while (usedUids.has(fallbackUid)) fallbackUid++; it.uid = fallbackUid++; }
      usedUids.add(it.uid);
      it.selected = source.state === 'ok' && !!entry.selected;
      it.pdfOrder = Number.isFinite(Number(entry.pdfOrder)) && Number(entry.pdfOrder) > 0 ? Number(entry.pdfOrder) : sourceIndex + 1;
      it.pageGroup = Number(entry.pageGroup) > 0 ? Number(entry.pageGroup) : null;
      it.cropRect = entry.cropRect && entry.cropRect.w > 0 && entry.cropRect.h > 0 ? { ...entry.cropRect } : null;
      it.cropCache = null;
      restored.push(it);
      if (entry.isDuplicate) items.push(it);
    }
    const maxOrder = restored.reduce((max, it) => Math.max(max, Number(it.pdfOrder) || 0), 0);
    const newSources = baseItems.filter((it) => !sourceIndices.has(it.i));
    newSources.forEach((it, index) => {
      it.selected = it.state === 'ok'; it.pageGroup = null; it.cropRect = null; it.cropCache = null;
      it.pdfOrder = maxOrder + index + 1;
    });
    const finalItems = restored.concat(newSources);
    const keep = new Set(finalItems);
    baseItems.filter((it) => !keep.has(it)).forEach((it) => { if (it.el && it.el.parentNode) it.el.parentNode.removeChild(it.el); });
    items = finalItems;
    cleanupPageGroups();
    finalItems.forEach((it) => grid.appendChild(it.el));
    normalizeGroupLayout();
    nextItemUid = Math.max(0, ...items.map((it) => it.uid + 1));
    lastClicked = null;
    if ($('groupMenu')) $('groupMenu').open = false;
    refreshAll();
    // کراپ‌های بازیابی‌شده باید روی پیش‌نمایش کارت‌ها هم دیده شوند؛ فقط کپی‌ها تازه ساخته می‌شدند و کارت‌های اصلی تصویر بدون برش را نشان می‌دادند
    items.filter((it) => it.state === 'ok').forEach((it) => drawThumb(it));
    $('profileStatus').innerText = `پروفایل این صفحه بازیابی شد (${restored.length} تصویر/کپی).`;
    pageProfileAvailable = true;
    updateProfileButtons();
  } catch (e) {
    console.error('بازیابی پروفایل ناموفق بود', e);
    $('profileStatus').innerText = `بازیابی پروفایل ناموفق بود: ${e && e.message ? e.message : e}`;
  }
}

// ---------- شروع ----------
async function main() {
  const params = new URLSearchParams(location.search);
  const jobId = params.get('job');
  const standalonePdfWorkspace = params.get('pdfWorkspace') === '1';
  jobKey = 'job_' + (jobId || 'pdf_workspace');
  const stored = jobId ? await chrome.storage.local.get(jobKey) : {};
  job = stored[jobKey] || (standalonePdfWorkspace
    ? { urls: [], name: 'comic.pdf', tabId: null, pageUrl: '' }
    : null);
  if (!job) {
    $('loadText').innerText = 'اطلاعات کار پیدا نشد. دوباره از popup شروع کنید.';
    return;
  }
  $('pdfName').value = (job.name || 'comic').replace(/\.pdf$/i, '');
  pageProfileKey = makePageProfileKey(job.pageUrl || '');
  await checkSavedPageProfile();
  if (job.pageUrl) await setRefererRule(job.pageUrl);

  const grid = $('grid');
  grid.addEventListener('dragover', (ev) => {
    if (!draggedItem) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    const target = ev.target.closest ? ev.target.closest('.item') : null;
    // فضای خالی شبکه: رهاکردن اینجا کارت را از گروه خارج و در همان محل درج می‌کند
    if (!target) { previewEmptyAreaDrop(ev.clientX, ev.clientY); return; }
    if (target === draggedItem.el) { clearDragDropHint(); clearInsertMarker(); restoreDragOrderPreview(); return; }
    const rect = target.getBoundingClientRect();
    const targetItem = items.find((it) => it.el === target);
    const groupable = targetItem && targetItem.state === 'ok' && draggedItem.state === 'ok';
    // نوار میانی کارت (۴۴٪ وسط) یعنی گروه‌بندی؛ لبه‌ها مثل قبل جابه‌جایی ترتیب است
    const band = rect.width ? (ev.clientX - rect.left) / rect.width : 0;
    const isGroupDrop = groupable && band > 0.28 && band < 0.72;
    if (isGroupDrop) {
      clearInsertMarker();
      restoreDragOrderPreview();
      if (dragDropTargetEl !== target) {
        clearDragDropHint();
        target.classList.add('group-drop-target');
        dragDropTargetEl = target;
      }
      dragGroupDrop = true;
    } else {
      clearDragDropHint();
      const sameGroupBlock = !!draggedGroupItems && draggedGroupItems.some((member) => member.el === target);
      // RTL: نیمهٔ راست کارت یعنی درج قبل از آن، نیمهٔ چپ یعنی بعد از آن
      const before = ev.clientX > rect.left + rect.width / 2;
      if (sameGroupBlock) {
        // چیدمان داخلی گروه: روی لبهٔ کارتِ هم‌گروه، فقط همین کارت داخل بلوک جابه‌جا می‌شود
        setInsertMarker(target, before, false);
        previewInternalOrder(draggedItem, target, before);
        return;
      }
      // نشانگر محل درج؛ برای جابه‌جایی گروهی با رنگ و ضخامت متفاوت از کارت تکی
      setInsertMarker(target, before, !!draggedGroupItems);
      // شماره صفحه‌های زیر کارت‌ها به‌صورت زنده با محل درج جدید به‌روز می‌شوند
      previewDragOrder(draggedItem, target, before);
    }
  });
  // با ترک محدودهٔ شبکه، پیش‌نمایش شماره‌ها به ترتیب واقعی برمی‌گردد
  grid.addEventListener('dragleave', (ev) => {
    if (!draggedItem) return;
    if (ev.target === grid || !grid.contains(ev.relatedTarget)) {
      clearInsertMarker();
      restoreDragOrderPreview();
    }
  });
  grid.addEventListener('drop', (ev) => {
    if (!draggedItem) return;
    ev.preventDefault();
    const target = ev.target.closest('.item');
    const wantGroup = dragGroupDrop;
    clearDragDropHint();
    clearInsertMarker();
    if (!target) { dropOnEmptyArea(ev.clientX, ev.clientY); suppressCardClickUntil = Date.now() + 350; return; }
    if (target === draggedItem.el) return;
    if (wantGroup) {
      const targetItem = items.find((it) => it.el === target);
      groupCardsByDrop(draggedItem, targetItem);
      suppressCardClickUntil = Date.now() + 350;
      return;
    }
    const rect = target.getBoundingClientRect();
    // شبکه از راست به چپ است: سمت راست کارت یعنی درج قبل از آن در ترتیب DOM.
    const before = ev.clientX > rect.left + rect.width / 2;
    const sameGroupBlock = !!draggedGroupItems && draggedGroupItems.some((member) => member.el === target);
    if (sameGroupBlock) reorderWithinGroup(draggedItem, target, before);
    else reorderByDrop(draggedItem, target, before);
    suppressCardClickUntil = Date.now() + 350;
  });
  items = (job.urls || []).map((url, i) => ({ i, uid: i, url, pdfOrder: i + 1, pageGroup: null, state: 'loading', selected: true }));
  nextItemUid = items.length;
  items.forEach((it) => grid.appendChild(makeCard(it)));

  $('btnAll').onclick = () => { items.forEach((it) => { if (it.state === 'ok') it.selected = true; }); refreshAll(); };
  $('btnNone').onclick = () => { items.forEach((it) => { it.selected = false; }); refreshAll(); };
  $('btnInv').onclick = () => { items.forEach((it) => { if (it.state === 'ok') it.selected = !it.selected; }); refreshAll(); };
  $('btnDeleteSel').onclick = deleteSelectedItems;
  $('btnGroupPage').onclick = groupSelectedItems;
  $('btnCancelGroupEdit').onclick = cancelPageGroupEdit;
  $('btnUngroupPage').onclick = ungroupSelectedItems;
  $('saveProfileBtn').onclick = savePageProfile;
  $('restoreProfileBtn').onclick = restorePageProfile;
  $('deleteProfileBtn').onclick = deletePageProfile;
  $('btnRetry').onclick = () => { loadAll(items.filter((it) => it.state === 'failed')); };
  $('btnRetryAll').onclick = () => { loadAll(items.filter((it) => it.state === 'failed')); };
  $('buildBtn').onclick = onBuild;
  $('saveImgBtn').onclick = onSaveImages;
  $('btnImportPdf').onclick = openPdfImportTab;
  if (chrome.runtime.onMessage && chrome.runtime.onMessage.addListener) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || message.type !== 'PIC_TO_PDF_IMPORT_COMPLETE' || message.token !== pendingPdfImportToken) return false;
      receiveImportedPdf(message.token).then(() => sendResponse({ ok: true })).catch((error) => {
        sendResponse({ ok: false, error: error && error.message ? error.message : String(error) });
      });
      return true;
    });
  }
  window.addEventListener('focus', () => receiveImportedPdf());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') receiveImportedPdf();
  });
  $('modePdf').onclick = () => setMode('pdf');
  $('modeImg').onclick = () => setMode('img');
  const outputSettings = $('outputSettings');
  $('closeOutputSettings').onclick = () => {
    outputSettings.open = false;
    outputSettings.querySelector('summary').focus();
  };
  const topMenu = $('topMenu');
  document.addEventListener('click', (e) => {
    if (outputSettings.open && !outputSettings.contains(e.target)) outputSettings.open = false;
    if (topMenu && topMenu.open && !topMenu.contains(e.target)) topMenu.open = false;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // اولویت اول: منوها و پنل‌های باز با ESC بسته شوند، نه اینکه کار لغو شود
    let menuConsumed = false;
    if (outputSettings.open) {
      outputSettings.open = false;
      outputSettings.querySelector('summary').focus();
      menuConsumed = true;
    }
    if (topMenu && topMenu.open) {
      topMenu.open = false;
      topMenu.querySelector('summary').focus();
      menuConsumed = true;
    }
    const groupMenu = $('groupMenu');
    if (groupMenu && groupMenu.open) {
      groupMenu.open = false;
      menuConsumed = true;
    }
    if (menuConsumed) return;
    // اگر پنجرهٔ تمام‌صفحه‌ای باز است، ESC همان را می‌بندد (هندلرهای خودشان)
    const overlayOpen = ['lightbox', 'cropper', 'editor', 'trDialog']
      .some((id) => !$(id).classList.contains('hidden'));
    if (overlayOpen) return;
    // اولویت دوم: لغو کار در حال اجرا (بارگیری / ساخت / ذخیره / ترجمه)
    if (building || loading) {
      e.preventDefault();
      requestJobCancel();
    }
  });
  $('seamless').addEventListener('change', () => {
    if ($('seamless').checked) {
      $('twoPerPage').checked = false;
      $('uniformSize').checked = false;
    }
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
  $('cropRatio').addEventListener('change', adjustCropToRatio);
  $('cropWidth').addEventListener('input', () => updateCropFromInputs('width', true));
  $('cropHeight').addEventListener('input', () => updateCropFromInputs('height', true));
  $('cropWidth').addEventListener('change', () => updateCropFromInputs('width'));
  $('cropHeight').addEventListener('change', () => updateCropFromInputs('height'));
  $('cropStage').addEventListener('pointerdown', beginCropSelection);
  $('cropStage').addEventListener('pointermove', moveCropSelection);
  $('cropStage').addEventListener('pointerup', endCropSelection);
  $('cropStage').addEventListener('pointercancel', cancelCropSelection);
  document.addEventListener('keydown', handleOverlayKeydown);
  // ارتفاع شبکه با بارگیری بند‌انگشتی‌ها و تغییر اندازهٔ پنجره عوض می‌شود؛ کادر گروه‌ها باید هم‌تراز بمانند
  if (typeof ResizeObserver !== 'undefined') {
    // هر تغییر اندازهٔ شبکه (بند‌انگشتی‌ها) یا جابه‌جایی آن (پنل نتیجه، منوی گروه‌ها) اندازهٔ .wrap را عوض می‌کند
    const outlineObserver = new ResizeObserver(() => drawGroupOutlines());
    outlineObserver.observe($('grid'));
    outlineObserver.observe(document.querySelector('.wrap'));
  }
  window.addEventListener('resize', () => drawGroupOutlines());
  window.addEventListener('pagehide', () => { chrome.storage.local.remove(jobKey); clearRefererRule(); });

  await loadAll(items);
  if (standalonePdfWorkspace) await openPdfImportTab();
}

main().catch((e) => {
  console.error(e);
  $('loadText').innerText = 'خطا: ' + (e && e.message ? e.message : e);
});
