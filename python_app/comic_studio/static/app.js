/* global Typeset, createImageBitmap, StudioGroups, ClipboardItem */
'use strict';

const $ = (id) => document.getElementById(id);
const G = window.StudioGroups;
const GROUP_COLORS = ['#34d399', '#60a5fa', '#f472b6', '#fbbf24', '#a78bfa', '#2dd4bf', '#fb923c', '#e879f9'];
const state = {
  project: null, engines: [], ai: null, editorId: null, editorBitmap: null, editorScale: 1,
  cropId: null, crop: null, cropPointer: null, modelBusy: null, dragId: null, dragIds: [],
  dragMode: null, groupEditId: null, groupSnapshot: null, lastSelectedId: null,
  previewId: null, richEditor: null, richRange: null, richFields: new Map(),
};
let saveTimer = null;
let toastTimer = null;
let outlineFrame = null;
let activityAfter = 0;
let activityEntries = [];
let activityPollTimer = null;
let activityPollInFlight = false;
let sessionTimer = null;
let localActivityId = 0;
let editorCloseTask = null;
let jobBusy = false;

function browserTabId() {
  try {
    const existing = sessionStorage.getItem('comic-studio-tab-id');
    if (existing) return existing;
  } catch { /* storage can be unavailable in private contexts */ }
  const id = globalThis.crypto?.randomUUID?.() || `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try { sessionStorage.setItem('comic-studio-tab-id', id); } catch { /* keep the in-memory id */ }
  return id;
}
const TAB_ID = browserTabId();

function renderActivity() {
  document.querySelectorAll('.activity-log').forEach((target) => {
    target.textContent = '';
    activityEntries.slice(-100).forEach((entry) => {
      const line = document.createElement('div'); line.className = `activity-line ${entry.kind || 'info'}`;
      const time = document.createElement('span'); time.className = 'activity-time';
      const date = new Date(entry.time || Date.now()); time.textContent = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const message = document.createElement('span'); message.className = 'activity-message'; message.textContent = entry.message;
      line.append(time, message); target.appendChild(line);
    });
    target.scrollTop = target.scrollHeight;
  });
}
function appendLocalActivity(message, kind = 'info') {
  if (!message) return;
  activityEntries.push({ id: --localActivityId, message: String(message), kind, time: new Date().toISOString() });
  activityEntries = activityEntries.slice(-100); renderActivity();
}
async function pollActivity() {
  if (activityPollInFlight) return;
  activityPollInFlight = true;
  try {
    const response = await fetch(`/api/activity?after=${activityAfter}`, { cache: 'no-store' });
    if (!response.ok) return;
    const payload = await response.json();
    (payload.entries || []).forEach((entry) => {
      if (!activityEntries.some((existing) => existing.id === entry.id)) activityEntries.push(entry);
    });
    activityAfter = Math.max(activityAfter, Number(payload.next) || 0);
    activityEntries = activityEntries.slice(-100);
    const latest = payload.entries?.at(-1);
    if (jobBusy && latest) {
      $('jobStatus').textContent = latest.message;
      if (latest.progress !== null && latest.progress !== undefined) $('jobProgress').style.width = `${Math.round(latest.progress * 100)}%`;
    }
    if (payload.entries?.length) renderActivity();
  } catch { /* the server may be shutting down; do not create a toast loop */ }
  finally { activityPollInFlight = false; }
}
function startActivityFeed() {
  pollActivity();
  if (!activityPollTimer) {
    activityPollTimer = setInterval(pollActivity, 700);
    activityPollTimer.unref?.();
  }
}
async function heartbeat() {
  try {
    await fetch('/api/session/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: TAB_ID }), cache: 'no-store' });
  } catch { /* a closed server needs no further browser-side error */ }
}
function startSession() {
  heartbeat();
  if (!sessionTimer) {
    sessionTimer = setInterval(heartbeat, 15000);
    sessionTimer.unref?.();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) heartbeat(); });
}
function closeSession() {
  const body = JSON.stringify({ client_id: TAB_ID });
  try {
    if (navigator.sendBeacon?.('/api/session/close', new Blob([body], { type: 'application/json' }))) return;
  } catch { /* use the keepalive fallback below */ }
  fetch('/api/session/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
}

function toast(message, error = false) {
  const el = $('toast');
  el.textContent = String(message || '');
  el.style.borderColor = error ? 'var(--danger)' : 'var(--line-2)';
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), error ? 7000 : 3200);
}
async function api(url, options = {}) {
  const response = await fetch(url, options);
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('json') ? await response.json() : null;
  if (!response.ok) {
    const error = new Error(payload && (payload.detail || payload.message) || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}
function jsonOptions(method, value) { return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }; }
function showDialog(id) { if (!$(id).open) $(id).showModal(); }
function closeDialog(id) { if ($(id).open) $(id).close(); }
function closeTopDialog() {
  const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
  if (!dialog) return false;
  if (dialog.id === 'editorDialog') closeEditor().catch((error) => toast(error.message, true));
  else closeDialog(dialog.id);
  return true;
}
function sortedImages() { return G.byOrder(state.project?.images || []); }
function selectedImages() { return sortedImages().filter((item) => item.selected); }
function imageUrl(item, edited = false, cropped = false) {
  const query = new URLSearchParams();
  if (edited) query.set('edited', 'true');
  if (cropped) query.set('cropped', 'true');
  return `/api/projects/${state.project.id}/images/${item.id}/content${query.toString() ? `?${query}` : ''}`;
}
function escapeHtml(value) { const el = document.createElement('div'); el.textContent = String(value ?? ''); return el.innerHTML; }
function plainToHtml(value) { return escapeHtml(value).replace(/\n/g, '<br>'); }
function safeName(value) { return String(value || 'comic-translated').replace(/[<>:\"/\\|?*]/g, '-'); }
function sanitizeHtml(html) {
  const root = document.createElement('div'); root.innerHTML = html || '';
  const allowed = new Set(['DIV', 'P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'SPAN', 'UL', 'OL', 'LI']);
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.nodeValue);
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName;
    const children = [...node.childNodes].map(walk).join('');
    if (tag === 'BR') return '<br>';
    if (!allowed.has(tag)) return children;
    let style = '';
    if (tag === 'SPAN') {
      const size = parseFloat(node.style.fontSize);
      if (Number.isFinite(size)) style += `font-size:${Math.max(8, Math.min(160, size))}px;`;
      if (/^#[0-9a-f]{6}$/i.test(node.style.color)) style += `color:${node.style.color};`;
      if (node.style.fontWeight) style += `font-weight:${node.style.fontWeight === 'bold' ? 'bold' : 'normal'};`;
      if (node.style.fontStyle) style += `font-style:${node.style.fontStyle === 'italic' ? 'italic' : 'normal'};`;
      if (node.style.textDecorationLine) style += `text-decoration:${node.style.textDecorationLine};`;
    }
    return `<${tag.toLowerCase()}${style ? ` style="${style}"` : ''}>${children}</${tag.toLowerCase()}>`;
  };
  return [...root.childNodes].map(walk).join('');
}
function setBusy(message) {
  jobBusy = !!message;
  $('jobStatus').textContent = message || 'آماده';
  $('jobProgress').style.width = message ? '65%' : '0';
  document.querySelectorAll('.main-actions button, .main-actions .file-button, #dock button').forEach((el) => { el.disabled = !!message; });
}
async function runJob(message, task) {
  setBusy(message); appendLocalActivity(message); $('activityDetails').open = true;
  try { return await task(); }
  catch (error) { console.error(error); appendLocalActivity(`خطا: ${error.message || error}`, 'error'); toast(error.message || error, true); throw error; }
  finally { setBusy(''); }
}
function scheduleSave() {
  clearTimeout(saveTimer); $('saveState').textContent = 'در حال ذخیره…';
  saveTimer = setTimeout(() => saveProject().catch((error) => toast(error.message, true)), 350);
}
async function saveProject() {
  clearTimeout(saveTimer);
  if (!state.project) return;
  G.normalizeLayout(state.project.images);
  const result = await api(`/api/projects/${state.project.id}/state`, jsonOptions('PUT', { state: state.project }));
  state.project = result; G.normalizeLayout(state.project.images);
  $('saveState').textContent = 'ذخیره شد';
  refreshProjectList().catch(() => {});
}
function adoptProject(project) {
  state.project = project;
  state.project.images = project.images || [];
  G.normalizeLayout(state.project.images);
  state.groupEditId = null; state.groupSnapshot = null;
  $('projectName').value = project.name || 'پروژهٔ کمیک';
  const settings = project.settings || {};
  $('ocrEngine').value = settings.ocrEngine || 'rapidocr-v6';
  $('ocrLanguage').value = settings.ocrLanguage || 'eng';
  $('ocrContrast').checked = settings.contrast !== false;
  $('ocrPrecise').checked = settings.precise !== false;
  $('ocrErase').checked = settings.eraseOriginal !== false;
  const output = settings.output || {};
  $('exportName').value = output.name || 'comic-translated';
  $('exportSeamless').checked = !!output.seamless;
  $('exportUniform').checked = !!output.uniformSize;
  $('exportTwo').checked = !!output.twoPerPage;
  $('exportFormat').value = output.imageFormat || 'orig';
  $('exportFolder').value = output.folderName || '';
  setOverlayMode(settings.overlayMode || 'translation', false);
  renderAll();
}
function currentOverlayMode() { return state.project?.settings?.overlayMode === 'ocr' ? 'ocr' : 'translation'; }
function setOverlayMode(mode, redraw = true) {
  if (!state.project) return;
  state.project.settings = state.project.settings || {};
  state.project.settings.overlayMode = mode === 'ocr' ? 'ocr' : 'translation';
  $('overlayMode').value = state.project.settings.overlayMode;
  $('exportOverlayMode').value = state.project.settings.overlayMode;
  if (redraw && state.editorId) drawEditor();
  if (redraw) scheduleSave();
}
function overlayBlock(block, mode = currentOverlayMode()) {
  if (mode !== 'ocr') return block;
  return { ...block, tr: block.text || '', richHtml: '', dir: 'ltr', align: block.align === 'center' ? 'center' : 'left', _plainText: true };
}
function overlayBlocks(item, mode = currentOverlayMode()) { return (item.blocks || []).map((block) => overlayBlock(block, mode)); }
function hasOverlayText(item, mode = currentOverlayMode()) { return overlayBlocks(item, mode).some((block) => block.enabled && block.tr?.trim()); }
function renderAll() { renderGrid(); updateEngineOptions(); }
function updateSummary() {
  const total = state.project?.images.length || 0;
  const selected = selectedImages().length;
  const groups = G.info(state.project?.images || []).length;
  $('selectionSummary').textContent = total ? `${selected} از ${total} تصویر انتخاب شده · ${groups} گروه` : 'هنوز فایلی وارد نشده است';
  $('emptyState').classList.toggle('hidden', total > 0);
  $('ocrBtn').disabled = !total; $('translateBtn').disabled = !total;
  $('exportBtn').disabled = !total;
}
function makeButton(label, handler, className = 'bt') {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.className = className;
  button.addEventListener('click', (event) => { event.stopPropagation(); const result = handler(event); if (result?.catch) result.catch((error) => toast(error.message, true)); });
  return button;
}
function groupColor(groupId) { return GROUP_COLORS[(Math.max(1, Number(groupId) || 1) - 1) % GROUP_COLORS.length]; }
function setSelected(item, value, event = null) {
  if (event?.shiftKey && state.lastSelectedId) {
    const ordered = sortedImages(); const a = ordered.findIndex((entry) => entry.id === state.lastSelectedId); const b = ordered.findIndex((entry) => entry.id === item.id);
    if (a >= 0 && b >= 0) ordered.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((entry) => { entry.selected = value; });
  } else item.selected = value;
  state.lastSelectedId = item.id; renderGrid(); scheduleSave();
}

// ---------- Grid, group manager, and drag/drop ----------
function renderGrid() {
  const grid = $('grid'); if (!state.project) return;
  G.normalizeLayout(state.project.images); grid.textContent = '';
  const infos = G.info(state.project.images); const byId = new Map(infos.map((info) => [info.key, info]));
  sortedImages().forEach((item, index) => {
    const info = G.validId(item.groupId) ? byId.get(G.idKey(item.groupId)) : null;
    const card = document.createElement('article');
    card.className = `item${item.selected ? ' selected' : ''}${info ? ' in-group' : ''}${state.groupEditId && info && G.idKey(state.groupEditId) === info.key ? ' group-focus' : ''}`;
    card.dataset.id = item.id; card.draggable = true;
    if (info) card.style.setProperty('--group-color', groupColor(info.id));
    const frame = document.createElement('div'); frame.className = 'tw';
    const image = document.createElement('img'); image.src = imageUrl(item, !!item.edited, true); image.alt = item.name; image.loading = 'lazy'; image.draggable = false;
    image.addEventListener('load', scheduleOutlines); image.addEventListener('click', (event) => { event.stopPropagation(); setSelected(item, !item.selected, event); });
    frame.appendChild(image);
    const tick = document.createElement('input'); tick.type = 'checkbox'; tick.className = 'tick'; tick.checked = !!item.selected; tick.setAttribute('aria-label', `انتخاب ${item.name}`);
    tick.addEventListener('click', (event) => {
      // Handle the native click once; rendering below restores the visual checked state.
      event.preventDefault(); event.stopPropagation(); setSelected(item, !item.selected, event);
    });
    const act = document.createElement('div'); act.className = 'act';
    act.append(makeButton('👁', () => openPreview(item), 'bt'), makeButton('✎', () => openEditor(item.id), 'bt'), makeButton('✂', () => openCrop(item.id), 'bt crop-mark'), makeButton('⧉', () => duplicateImages([item.id]), 'bt'), makeButton('🗑', () => deleteImages([item.id]), 'bt danger'));
    const name = document.createElement('div'); name.className = 'name';
    const nameText = document.createElement('span'); nameText.className = 'name-text'; nameText.textContent = item.name; nameText.title = item.name; nameText.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:10px';
    const order = document.createElement('input'); order.type = 'number'; order.min = '1'; order.value = String(index + 1); order.className = 'mini'; order.title = 'ترتیب'; order.setAttribute('aria-label', 'ترتیب تصویر');
    order.addEventListener('click', (event) => event.stopPropagation());
    order.addEventListener('change', () => {
      const target = Math.max(0, Math.min(state.project.images.length - 1, Number(order.value) - 1));
      const current = state.project.images.indexOf(item); state.project.images.splice(current, 1); state.project.images.splice(target, 0, item);
      G.normalizeLayout(state.project.images); renderGrid(); scheduleSave();
    });
    name.append(nameText, order, makeButton('↑', () => moveImageBy(item.id, -1), 'bt mini'), makeButton('↓', () => moveImageBy(item.id, 1), 'bt mini'));
    const meta = document.createElement('div'); meta.className = 'meta';
    meta.textContent = `${item.width}×${item.height} · ${item.blocks?.length || 0} متن${item.crop ? ' · برش' : ''}${item.edited ? ' · ویرایش' : ''}`;
    card.append(frame, tick, act, name, meta);
    if (info) {
      const badge = document.createElement('span'); badge.className = 'grp'; badge.textContent = `گروه ${info.id}`; badge.title = `${info.members.length} عضو`; card.appendChild(badge);
    }
    card.addEventListener('click', (event) => {
      if (event.target.closest('button,input,img')) return;
      setSelected(item, !item.selected, event);
    });
    card.addEventListener('dragstart', (event) => {
      state.dragId = item.id; state.dragIds = info ? info.members.map((entry) => entry.id) : [item.id];
      card.classList.add('dragging');
      if (info) info.members.forEach((entry) => grid.querySelector(`[data-id="${entry.id}"]`)?.classList.add('group-moving'));
      event.dataTransfer?.setData('text/plain', item.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', clearDrag);
    grid.appendChild(card);
  });
  renderGroupPanel(); updateSummary(); scheduleOutlines();
}
function moveImageBy(imageId, delta) { G.moveUnit(state.project.images, imageId, delta); renderGrid(); scheduleSave(); }
async function duplicateImages(ids) { if (!ids.length) return; await saveProject(); adoptProject(await api(`/api/projects/${state.project.id}/duplicate`, jsonOptions('POST', ids))); }
async function deleteImages(ids) { if (!ids.length || !confirm(`${ids.length} تصویر از پروژه حذف شود؟`)) return; await saveProject(); adoptProject(await api(`/api/projects/${state.project.id}/delete`, jsonOptions('POST', ids))); }
function renderGroupPanel() {
  const infos = G.info(state.project?.images || []); const panel = $('groupPanel');
  panel.classList.toggle('hidden', !infos.length && !state.groupEditId);
  $('cancelGroupEdit').classList.toggle('hidden', !state.groupEditId);
  const list = $('groupList'); list.textContent = '';
  infos.forEach((info) => {
    const chip = document.createElement('div'); chip.className = `group-chip${state.groupEditId && G.idKey(state.groupEditId) === info.key ? ' active' : ''}`; chip.style.setProperty('--group-color', groupColor(info.id));
    const dot = document.createElement('span'); dot.className = 'dot';
    const label = document.createElement('strong'); label.textContent = `گروه ${info.id} · ${info.members.length} عضو`;
    chip.append(dot, label,
      makeButton('انتخاب', () => selectGroup(info.id), 'bt'),
      makeButton(state.groupEditId && G.idKey(state.groupEditId) === info.key ? 'ذخیره' : 'ویرایش', () => state.groupEditId && G.idKey(state.groupEditId) === info.key ? finishGroupEdit(false) : startGroupEdit(info.id), 'bt'),
      makeButton('حذف', () => { G.removeGroup(state.project.images, info.id); renderGrid(); scheduleSave(); }, 'bt danger'));
    list.appendChild(chip);
  });
  $('groupEditStatus').textContent = state.groupEditId ? `در حال ویرایش گروه ${state.groupEditId}: کارت‌ها را انتخاب/لغو انتخاب کنید؛ ذخیره، اعضای انتخاب‌شده را به گروه برمی‌گرداند.` : 'برای ویرایش اعضا، «ویرایش» یک گروه را بزنید و سپس کارت‌ها را انتخاب یا لغو انتخاب کنید.';
}
function selectGroup(groupId) {
  const info = G.info(state.project.images).find((entry) => G.idKey(entry.id) === G.idKey(groupId)); if (!info) return;
  const ids = new Set(info.members.map((item) => item.id)); state.project.images.forEach((item) => { item.selected = ids.has(item.id); });
  state.lastSelectedId = info.members[0]?.id || null; renderGrid(); scheduleSave();
  document.querySelector(`#grid [data-id="${info.members[0]?.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function startGroupEdit(groupId) {
  const info = G.info(state.project.images).find((entry) => G.idKey(entry.id) === G.idKey(groupId)); if (!info) return;
  state.groupSnapshot = new Map(state.project.images.map((item) => [item.id, { selected: item.selected, groupId: item.groupId }]));
  state.groupEditId = info.id; selectGroup(info.id); renderGroupPanel();
}
function finishGroupEdit(cancel) {
  if (!state.groupEditId) return;
  if (cancel && state.groupSnapshot) {
    state.project.images.forEach((item) => { const old = state.groupSnapshot.get(item.id); if (old) { item.selected = old.selected; item.groupId = old.groupId; } });
  } else if (!cancel) {
    const ids = selectedImages().map((item) => item.id);
    if (ids.length >= 2) { G.create(state.project.images, ids); }
    else { toast('یک گروه دست‌کم دو عضو لازم دارد؛ ویرایش لغو شد', true); return finishGroupEdit(true); }
  }
  state.groupEditId = null; state.groupSnapshot = null; G.cleanup(state.project.images); renderGrid(); scheduleSave();
}
function clearDrag() {
  state.dragId = null; state.dragIds = []; state.dragMode = null; state.dragTarget = null; state.dragAfter = false;
  document.querySelectorAll('.item').forEach((el) => el.classList.remove('dragging', 'group-moving', 'drag-insert-before', 'drag-insert-after', 'drag-group-target'));
  $('grid').classList.remove('extract-zone');
}
function nearestGridIndex(event) {
  const cards = [...document.querySelectorAll('#grid .item')]; let best = cards.length; let distance = Infinity;
  cards.forEach((card, index) => { const r = card.getBoundingClientRect(); const d = Math.hypot(event.clientX - (r.left + r.width / 2), event.clientY - (r.top + r.height / 2)); if (d < distance) { distance = d; best = index + (event.clientX > r.left + r.width / 2 ? 1 : 0); } });
  return best;
}
function bindGridDrop() {
  const grid = $('grid');
  grid.addEventListener('dragover', (event) => {
    if (!state.dragId) return; event.preventDefault();
    document.querySelectorAll('.item').forEach((el) => el.classList.remove('drag-insert-before', 'drag-insert-after', 'drag-group-target'));
    const card = event.target.closest('.item');
    if (!card) { state.dragMode = 'extract'; state.dragTarget = null; grid.classList.add('extract-zone'); return; }
    if (card.dataset.id === state.dragId) { state.dragMode = null; state.dragTarget = null; grid.classList.remove('extract-zone'); return; }
    grid.classList.remove('extract-zone'); const r = card.getBoundingClientRect();
    const band = r.width ? (event.clientX - r.left) / r.width : 0;
    const targetItem = state.project.images.find((item) => item.id === card.dataset.id);
    const sameGroup = targetItem && state.dragIds.includes(targetItem.id) && state.dragIds.length > 1;
    if (band > .28 && band < .72) { state.dragMode = 'group'; state.dragTarget = card.dataset.id; card.classList.add('drag-group-target'); }
    else {
      state.dragMode = sameGroup ? 'internal' : 'move'; state.dragTarget = card.dataset.id;
      // RTL: the right half inserts before the target, just as in the extension.
      state.dragAfter = event.clientX <= r.left + r.width / 2;
      card.classList.add(state.dragAfter ? 'drag-insert-after' : 'drag-insert-before');
    }
  });
  grid.addEventListener('drop', (event) => {
    event.preventDefault(); if (!state.dragId) return;
    const target = state.dragTarget; const mode = state.dragMode;
    if (mode === 'group' && target) G.dropToGroup(state.project.images, state.dragIds, target);
    else if (mode === 'internal' && target) G.move(state.project.images, [state.dragId], target, state.dragAfter);
    else if (mode === 'move' && target) G.move(state.project.images, state.dragIds, target, state.dragAfter);
    else if (mode === 'extract') G.extract(state.project.images, state.dragId, nearestGridIndex(event));
    clearDrag(); renderGrid(); scheduleSave();
  });
  grid.addEventListener('dragleave', (event) => { if (!grid.contains(event.relatedTarget)) { grid.classList.remove('extract-zone'); document.querySelectorAll('.item').forEach((el) => el.classList.remove('drag-insert-before', 'drag-insert-after', 'drag-group-target')); } });
}
function scheduleOutlines() { cancelAnimationFrame(outlineFrame); outlineFrame = requestAnimationFrame(drawGroupOutlines); }
function drawGroupOutlines() {
  const layer = $('groupOutlines'); if (!layer || !state.project) return; layer.textContent = '';
  const wrap = $('mainwrap').getBoundingClientRect();
  G.info(state.project.images).forEach((info) => {
    const cards = info.members.map((item) => document.querySelector(`#grid .item[data-id="${item.id}"]`)).filter(Boolean);
    const rows = new Map();
    cards.forEach((card) => { const r = card.getBoundingClientRect(); const key = Math.round(r.top); if (!rows.has(key)) rows.set(key, []); rows.get(key).push(r); });
    rows.forEach((rects) => {
      const left = Math.min(...rects.map((r) => r.left)) - 7 - wrap.left; const top = Math.min(...rects.map((r) => r.top)) - 7 - wrap.top;
      const right = Math.max(...rects.map((r) => r.right)) + 7 - wrap.left; const bottom = Math.max(...rects.map((r) => r.bottom)) + 7 - wrap.top;
      const outline = document.createElement('div'); outline.className = 'group-outline'; outline.style.setProperty('--group-color', groupColor(info.id));
      outline.style.cssText += `left:${left}px;top:${top}px;width:${right - left}px;height:${bottom - top}px`;
      const label = document.createElement('span'); label.className = 'group-outline-label'; label.textContent = `گروه ${info.id} · ${info.members.length} عضو`; outline.appendChild(label); layer.appendChild(outline);
    });
  });
}

// ---------- Projects and settings ----------
async function refreshProjectList() {
  const projects = await api('/api/projects'); const select = $('projectSelect'); const current = state.project?.id; select.textContent = '';
  projects.forEach((project) => { const option = document.createElement('option'); option.value = project.id; option.textContent = `${project.name} (${project.images})`; option.selected = project.id === current; select.appendChild(option); });
}
async function loadProject(id) { const project = await api(`/api/projects/${id}`); adoptProject(project); await refreshProjectList(); }
function collectOutputSettings() {
  if (!state.project) return; state.project.settings = state.project.settings || {};
  state.project.settings.output = { name: $('exportName').value, seamless: $('exportSeamless').checked, uniformSize: $('exportUniform').checked, twoPerPage: $('exportTwo').checked, imageFormat: $('exportFormat').value, folderName: $('exportFolder').value };
}
function collectOcrSettings() {
  state.project.settings = state.project.settings || {};
  Object.assign(state.project.settings, { ocrEngine: $('ocrEngine').value, ocrLanguage: $('ocrLanguage').value, contrast: $('ocrContrast').checked, precise: $('ocrPrecise').checked, eraseOriginal: $('ocrErase').checked });
}
function updateEngineOptions() {
  const select = $('ocrEngine'); const previous = select.value || state.project?.settings?.ocrEngine || 'rapidocr-v6'; select.textContent = '';
  state.engines.filter((engine) => engine.selectable !== false).forEach((engine) => { const option = document.createElement('option'); option.value = engine.id; option.textContent = `${engine.name}${engine.runtimeInstalled ? '' : ' (نیازمند نصب)'}`; select.appendChild(option); });
  select.value = state.engines.some((engine) => engine.id === previous) ? previous : 'rapidocr-v6'; updateOcrEngineStatus();
}
function updateOcrEngineStatus() {
  const engine = state.engines.find((entry) => entry.id === $('ocrEngine').value); if (!engine) return;
  $('ocrEngineStatus').textContent = engine.runtimeInstalled ? `${engine.description} وضعیت: آمادهٔ اجرا روی همین کامپیوتر.` : 'ابزار اجرای این مدل نصب نشده است؛ از «مدل‌ها و آزمایش» دکمهٔ آماده‌سازی را بزنید.';
  [...$('ocrLanguage').options].forEach((option) => { option.disabled = !engine.languages.includes(option.value); });
  if (!engine.languages.includes($('ocrLanguage').value)) $('ocrLanguage').value = engine.languages[0];
}
async function importFiles(files) {
  if (!files.length) return;
  await runJob('در حال خواندن فایل‌ها…', async () => { await saveProject(); const form = new FormData(); [...files].forEach((file) => form.append('files', file)); const result = await api(`/api/projects/${state.project.id}/files`, { method: 'POST', body: form }); adoptProject(result); toast(`${files.length} فایل وارد شد`); });
}
async function runOcr() {
  collectOcrSettings(); await saveProject();
  const ids = $('ocrOnlySelected').checked ? selectedImages().map((item) => item.id) : sortedImages().map((item) => item.id);
  if (!ids.length) throw new Error('حداقل یک تصویر را انتخاب کنید');
  await runJob('OCR محلی در حال اجراست…', async () => {
    const result = await api(`/api/projects/${state.project.id}/ocr`, jsonOptions('POST', { image_ids: ids, engine: $('ocrEngine').value, language: $('ocrLanguage').value, contrast: $('ocrContrast').checked, precise: $('ocrPrecise').checked, min_confidence: Number($('ocrConfidence').value) || .35 }));
    adoptProject(result); setOverlayMode('ocr', false); await saveProject(); await renderImagesText(); closeDialog('ocrDialog'); toast('متن OCR روی تصویر آمد؛ برای بررسی و ویرایش، دکمهٔ ✎ را بزنید');
  });
}
async function runTranslation() {
  const ids = selectedImages().map((item) => item.id); if (!ids.length) { toast('حداقل یک تصویر را انتخاب کنید', true); return; }
  await runJob('در حال ترجمهٔ متن‌ها…', async () => { await saveProject(); const result = await api(`/api/projects/${state.project.id}/translate`, jsonOptions('POST', { image_ids: ids, provider: state.ai?.provider || 'free', source_language: $('ocrLanguage').value })); adoptProject(result); setOverlayMode('translation', false); await saveProject(); await renderImagesText(); toast('ترجمه روی تصویر آمد و پیش‌نمایش آماده شد'); });
}

// ---------- Typeset preview and export ----------
async function ensureFont() { if (document.fonts?.load) { try { await document.fonts.load('700 24px Vazirmatn', 'ابپتثجچ'); } catch { /* fallback */ } } }
async function renderAndUpload(item) {
  const blocks = overlayBlocks(item); const active = blocks.some((block) => block.enabled && block.tr?.trim());
  if (!active) {
    await api(`/api/projects/${state.project.id}/images/${item.id}/revert`, { method: 'POST' });
    const current = state.project.images.find((entry) => entry.id === item.id); if (current) current.edited = false; return;
  }
  await ensureFont(); const response = await fetch(imageUrl(item)); if (!response.ok) throw new Error('تصویر اصلی باز نشد');
  const bitmap = await createImageBitmap(await response.blob()); let canvas;
  try { canvas = Typeset.render(bitmap, blocks); } finally { bitmap.close(); }
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  await api(`/api/projects/${state.project.id}/images/${item.id}/rendered`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob });
  canvas.width = canvas.height = 0; const current = state.project.images.find((entry) => entry.id === item.id); if (current) current.edited = true;
}
async function renderImagesText(ids = null) {
  const wanted = ids ? new Set(ids) : null;
  for (const item of sortedImages()) if ((!wanted || wanted.has(item.id)) && (hasOverlayText(item) || item.edited)) await renderAndUpload(item);
  renderGrid();
}
function updateExportFields() { const kind = $('exportKind').value; $('pdfExportFields').classList.toggle('hidden', kind !== 'pdf'); $('imageExportFields').classList.toggle('hidden', kind !== 'images'); }
async function exportResult(kind = null) {
  if (kind) $('exportKind').value = kind;
  if (!selectedImages().length) throw new Error('حداقل یک تصویر را برای خروجی انتخاب کنید');
  collectOutputSettings(); await saveProject(); const exportKind = $('exportKind').value;
  if (exportKind !== 'txt') { for (const item of selectedImages()) if (hasOverlayText(item) || item.edited) await renderAndUpload(item); renderGrid(); }
  const response = await fetch(`/api/projects/${state.project.id}/export`, jsonOptions('POST', { kind: exportKind, image_ids: selectedImages().map((item) => item.id), name: safeName($('exportName').value), seamless: $('exportSeamless').checked, uniform_size: $('exportUniform').checked, two_per_page: $('exportTwo').checked, image_format: $('exportFormat').value, folder_name: $('exportFolder').value }));
  if (!response.ok) { const payload = await response.json(); throw new Error(payload.detail || 'خروجی ساخته نشد'); }
  const blob = await response.blob(); const disposition = response.headers.get('content-disposition') || ''; const match = disposition.match(/filename\*?=(?:UTF-8''|\")?([^\";]+)/i);
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = match ? decodeURIComponent(match[1]) : `${safeName($('exportName').value)}.${exportKind === 'images' ? 'zip' : exportKind}`; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 5000);
  closeDialog('exportDialog'); $('jobStatus').textContent = `خروجی ${exportKind.toUpperCase()} آماده شد · ${(blob.size / 1024).toFixed(0)} کیلوبایت`; toast('خروجی آماده شد');
}

// ---------- Models and AI (explicit downloads remain user initiated) ----------
function renderModels() {
  const container = $('engineCards'); container.textContent = ''; const language = $('testLanguage').value;
  const addGroup = (title, engines, external = false) => {
    if (!engines.length) return;
    const group = document.createElement('section'); group.className = 'model-group';
    const heading = document.createElement('h3'); heading.className = 'model-group-title'; heading.textContent = title; group.appendChild(heading);
    const cards = document.createElement('div'); cards.className = 'model-group-grid'; group.appendChild(cards); container.appendChild(group);
    engines.forEach((engine) => {
      const card = document.createElement('section'); card.className = `engine-card${external ? ' external-engine' : ''}`;
      const titleEl = document.createElement('h3'); titleEl.textContent = engine.name;
      const family = document.createElement('div'); family.className = 'hint'; family.textContent = engine.family;
      const description = document.createElement('p'); description.textContent = engine.description;
      const status = document.createElement('div'); status.className = 'engine-status';
      card.append(titleEl, family, description, status);
      if (external) {
        status.textContent = 'اجرای جداگانه · آداپتور مستقیم OCR کمیک ندارد';
        const requirements = document.createElement('div'); requirements.className = 'engine-limit'; requirements.textContent = engine.requirements || '';
        const limitations = document.createElement('div'); limitations.className = 'engine-limit'; limitations.textContent = engine.limitations || '';
        const buttons = document.createElement('div'); buttons.className = 'card-buttons';
        const guide = document.createElement('a'); guide.className = 'bt'; guide.href = engine.repository; guide.target = '_blank'; guide.rel = 'noopener noreferrer'; guide.textContent = 'دانلود / راهنمای رسمی';
        buttons.appendChild(guide); card.append(requirements, limitations, buttons);
      } else {
        const supported = engine.languages.includes(language); const ready = supported && (engine.readyLanguages || []).includes(language);
        status.textContent = state.modelBusy === engine.id ? 'در حال نصب بسته و دانلود مدل؛ لطفاً صبر کنید…' : !supported ? 'این موتور زبان انتخاب‌شده را پشتیبانی نمی‌کند.' : !engine.runtimeInstalled ? 'بسته یا برنامهٔ اجرایی نصب نیست؛ دکمهٔ آماده‌سازی را بزنید.' : ready ? 'مدل زبان انتخاب‌شده آماده و آفلاین است.' : 'مدل زبان انتخاب‌شده هنوز آماده نیست؛ دکمهٔ آماده‌سازی را بزنید.';
        if (engine.requirements) { const requirements = document.createElement('div'); requirements.className = 'engine-limit'; requirements.textContent = engine.requirements; card.appendChild(requirements); }
        const buttons = document.createElement('div'); buttons.className = 'card-buttons';
        const prepare = makeButton('آماده‌سازی / دانلود مدل', () => downloadEngine(engine)); const test = makeButton('آزمایش روی تصویر', () => testEngine(engine.id));
        prepare.disabled = !!state.modelBusy || !supported; test.disabled = !!state.modelBusy || !supported; buttons.append(prepare, test);
        if (engine.repository) { const guide = document.createElement('a'); guide.className = 'bt'; guide.href = engine.repository; guide.target = '_blank'; guide.rel = 'noopener noreferrer'; guide.textContent = 'نصب / راهنمای رسمی'; buttons.appendChild(guide); }
        card.appendChild(buttons);
      }
      cards.appendChild(card);
    });
  };
  addGroup('قابل اجرا در برنامه — خروجی موقعیت‌دار', state.engines.filter((engine) => engine.selectable !== false));
  addGroup('دانلود و راه‌اندازی جداگانه — فعلاً خارج از OCR داخلی', state.engines.filter((engine) => engine.selectable === false), true);
}
async function downloadEngine(engine) {
  if (state.modelBusy) return; const language = $('testLanguage').value; if (!engine.languages.includes(language)) { toast('این موتور زبان انتخاب‌شده را پشتیبانی نمی‌کند', true); return; }
  state.modelBusy = engine.id; $('modelTestResult').textContent = `آماده‌سازی ${engine.name} برای ${language} آغاز شد؛ فقط مدل همین زبان دانلود می‌شود.`; appendLocalActivity(`آماده‌سازی ${engine.name} برای ${language} آغاز شد`); renderModels();
  try { const result = await api(`/api/engines/${engine.id}/download`, jsonOptions('POST', { language })); state.engines = result.engines; $('modelTestResult').textContent = `مدل ${engine.name} برای ${language} آماده است.`; appendLocalActivity(`مدل ${engine.name} آماده شد`, 'success'); updateEngineOptions(); toast('مدل آماده است'); }
  catch (error) { $('modelTestResult').textContent = `آماده‌سازی ناموفق بود:\n${error.message}\n\nاتصال اینترنت و دسترسی به میزبان مدل را بررسی کنید.`; appendLocalActivity(`آماده‌سازی ناموفق بود: ${error.message}`, 'error'); toast(error.message, true); }
  finally { state.modelBusy = null; renderModels(); }
}
async function testEngine(engineId) {
  if (state.modelBusy) return; const item = selectedImages()[0] || sortedImages()[0]; if (!item) { toast('ابتدا یک تصویر وارد کنید', true); return; }
  $('modelTestResult').textContent = 'در حال اجرای آزمایش محلی…'; appendLocalActivity(`آزمایش موتور ${engineId} آغاز شد`);
  try { const result = await api(`/api/engines/${engineId}/test`, jsonOptions('POST', { project_id: state.project.id, image_id: item.id, language: $('testLanguage').value })); $('modelTestResult').textContent = result.blocks.length ? result.blocks.map((block) => `${' '.repeat(block.sourceIndent || 0)}${block.text}  (${block.conf}%)`).join('\n') : 'متنی تشخیص داده نشد.'; appendLocalActivity('آزمایش موتور تمام شد', 'success'); }
  catch (error) { $('modelTestResult').textContent = error.message; appendLocalActivity(`آزمایش موتور ناموفق بود: ${error.message}`, 'error'); }
}
async function loadAiSettings() { state.ai = await api('/api/ai-settings'); $('aiProvider').value = state.ai.provider || 'free'; $('aiBaseUrl').value = state.ai.base_url || 'https://api.avalai.ir/v1'; $('aiModel').value = state.ai.model || 'gpt-6-luna'; $('aiKey').placeholder = state.ai.hasApiKey ? 'کلید ذخیره شده؛ برای تغییر، کلید تازه بدهید' : 'کلید API'; updateAiFields(); }
function updateAiFields() { $('aiFields').classList.toggle('hidden', $('aiProvider').value !== 'openai'); }
async function saveAiSettings() { state.ai = await api('/api/ai-settings', jsonOptions('PUT', { provider: $('aiProvider').value, base_url: $('aiBaseUrl').value, model: $('aiModel').value, api_key: $('aiKey').value || null })); $('aiKey').value = ''; await loadAiSettings(); toast('تنظیمات ترجمه ذخیره شد'); }

// ---------- Full-page translation editor ----------
function editorItem() { return state.project?.images.find((item) => item.id === state.editorId); }
function boxOf(block) { return { x0: Number.isFinite(block.tx0) ? block.tx0 : block.x0, y0: Number.isFinite(block.ty0) ? block.ty0 : block.y0, x1: Number.isFinite(block.tx1) ? block.tx1 : block.x1, y1: Number.isFinite(block.ty1) ? block.ty1 : block.y1 }; }
async function openEditor(imageId) {
  await ensureFont(); state.editorId = imageId; state.richFields = new Map(); const item = state.project.images.find((entry) => entry.id === imageId); $('editorTitle').textContent = `ویرایش — ${item.name}`; showDialog('editorDialog');
  const response = await fetch(imageUrl(item)); state.editorBitmap?.close?.(); state.editorBitmap = await createImageBitmap(await response.blob()); $('editorCanvas').width = state.editorBitmap.width; $('editorCanvas').height = state.editorBitmap.height; buildBlockList(); fitEditor(); drawEditor();
}
function fitEditor() {
  const item = editorItem(); if (!item) return; const available = Math.max(250, document.querySelector('.editor-preview').clientWidth - 35); state.editorScale = Math.min(1, available / item.width); const w = item.width * state.editorScale; const h = item.height * state.editorScale; $('editorStage').style.width = `${w}px`; $('editorStage').style.height = `${h}px`; $('editorCanvas').style.width = `${w}px`; $('editorCanvas').style.height = `${h}px`; renderEditorBoxes();
}
function drawEditor() {
  const item = editorItem(); if (!item || !state.editorBitmap) return; const canvas = $('editorCanvas'); const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(state.editorBitmap, 0, 0); renderEditorBoxes();
}
function overlaySize(block, width, height) {
  try {
    const style = Typeset.blockStyle(block); const maxSize = Math.max(12, Math.min(64, Math.round((block.lineH || height) * 1.1)));
    const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d');
    if (style.size) return style.size;
    if (!block._plainText && (block.richHtml || Typeset.hasInlineMarks(block.tr || ''))) {
      const words = block.richHtml ? Typeset.richHtmlWords(block.richHtml) : Typeset.inlineWords(block.tr || '');
      return Typeset.fitInline(ctx, words, width * .96, height * .96, maxSize, 8, style).size;
    }
    const prefix = `${style.italic ? 'italic ' : ''}${style.bold ? '700' : '400'} `;
    return Typeset.fit(ctx, block.tr || '', width * .96, height * .96, maxSize, 8, prefix).size;
  } catch {
    return Math.max(8, Math.min(160, Number(block.size) || Math.min(42, Math.max(10, height / Math.max(1.8, String(block.tr || '').split('\n').length * 1.65)))));
  }
}
function styleRichElement(element, block, scale = 1) {
  const box = boxOf(block); const style = Typeset.blockStyle(block); element.dir = style.dir; element.style.direction = style.dir; element.style.textAlign = style.align; element.style.fontSize = `${overlaySize(block, box.x1 - box.x0, box.y1 - box.y0) * scale}px`; element.style.fontWeight = style.bold ? '700' : '400'; element.style.fontStyle = style.italic ? 'italic' : 'normal'; element.style.color = style.color || (block.bg === 'white' ? '#0b0b0b' : '#fff'); element.style.textDecoration = style.underline ? 'underline' : '';
}
function updateRichBlock(block, element) {
  block.tr = element.innerText.replace(/\u00a0/g, ' '); block.richHtml = sanitizeHtml(element.innerHTML);
  const fields = state.richFields.get(String(block.id)) || []; fields.forEach((other) => { if (other !== element) { other.innerHTML = block.richHtml || plainToHtml(block.tr); } });
  scheduleSave();
}
function rememberRichSelection(element) {
  state.richEditor = element; const selection = window.getSelection(); if (selection?.rangeCount && element.contains(selection.anchorNode)) state.richRange = selection.getRangeAt(0).cloneRange();
}
function wireRichElement(element, block) {
  const key = String(block.id); if (!state.richFields.has(key)) state.richFields.set(key, []); state.richFields.get(key).push(element);
  element.addEventListener('focus', () => rememberRichSelection(element)); element.addEventListener('keyup', () => rememberRichSelection(element)); element.addEventListener('mouseup', () => rememberRichSelection(element));
  element.addEventListener('input', () => updateRichBlock(block, element));
  element.addEventListener('paste', (event) => { event.preventDefault(); document.execCommand('insertText', false, event.clipboardData.getData('text/plain')); });
}
function wireOcrElement(element, block) {
  element.addEventListener('input', () => {
    block.text = (element.innerText ?? element.textContent ?? '').replace(/\u00a0/g, ' ');
    const card = [...document.querySelectorAll('#blockList .block-card')].find((entry) => entry.dataset.id === String(block.id));
    const source = card?.querySelector('textarea'); if (source) source.value = block.text;
    scheduleSave();
  });
  element.addEventListener('paste', (event) => { event.preventDefault(); document.execCommand('insertText', false, event.clipboardData.getData('text/plain')); });
}
function runRichCommand(command, value = null) {
  const element = state.richEditor; if (!element) return;
  element.focus(); if (state.richRange && element.contains(state.richRange.startContainer)) { const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(state.richRange); }
  document.execCommand('styleWithCSS', false, true); document.execCommand(command, false, value); element.dispatchEvent(new Event('input')); rememberRichSelection(element);
}
function renderEditorBoxes() {
  const item = editorItem(); const layer = $('editorBoxes'); if (!item || !layer) return; layer.textContent = '';
  const mode = currentOverlayMode();
  (item.blocks || []).forEach((block) => {
    const display = overlayBlock(block, mode);
    if (!display.enabled || !display.tr?.trim()) return; const box = boxOf(display); const scale = state.editorScale; const el = document.createElement('div'); el.className = 'editor-box'; el.dataset.id = block.id;
    el.style.left = `${box.x0 * scale}px`; el.style.top = `${box.y0 * scale}px`; el.style.width = `${(box.x1 - box.x0) * scale}px`; el.style.height = `${(box.y1 - box.y0) * scale}px`;
    const move = document.createElement('span'); move.className = 'box-move'; move.textContent = `متن ${block.id}`; move.dataset.move = '1';
    const text = document.createElement('div'); text.className = 'editor-box-text'; text.contentEditable = 'true'; text.innerHTML = display.richHtml || plainToHtml(display.tr); styleRichElement(text, display, scale);
    if ((display.bg || 'auto') !== 'none') {
      let fill = display.bg === 'white' ? '#ffffff' : display.bg === 'black' ? '#000000' : null;
      if (!fill) { const sample = Typeset.sampleBg($('editorCanvas').getContext('2d'), box, item.width, item.height); fill = `rgb(${sample.r},${sample.g},${sample.b})`; const luminance = .2126 * sample.r + .7152 * sample.g + .0722 * sample.b; if (!display.color) text.style.color = luminance > 150 ? '#0b0b0b' : '#fafafa'; }
      text.style.background = fill; text.style.textShadow = 'none';
    }
    if (mode === 'ocr') wireOcrElement(text, block); else wireRichElement(text, block);
    el.append(move, text); ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach((dir) => { const handle = document.createElement('i'); handle.className = `resize-handle ${dir}`; handle.dataset.dir = dir; el.appendChild(handle); });
    el.addEventListener('pointerdown', (event) => startBoxDrag(event, block, el)); layer.appendChild(el);
  });
}
function startBoxDrag(event, block, el) {
  const handle = event.target.closest('[data-dir], [data-move]'); if (!handle) return; event.preventDefault(); event.stopPropagation(); const direction = handle.dataset.dir || 'move'; const start = boxOf(block); const origin = { x: event.clientX, y: event.clientY }; el.setPointerCapture(event.pointerId);
  const move = (ev) => { const dx = (ev.clientX - origin.x) / state.editorScale; const dy = (ev.clientY - origin.y) / state.editorScale; const item = editorItem(); let { x0, y0, x1, y1 } = start; if (direction === 'move') { x0 += dx; x1 += dx; y0 += dy; y1 += dy; } else { if (direction.includes('w')) x0 += dx; if (direction.includes('e')) x1 += dx; if (direction.includes('n')) y0 += dy; if (direction.includes('s')) y1 += dy; } if (x1 - x0 < 20 || y1 - y0 < 16) return; block.tx0 = Math.max(0, Math.min(item.width, x0)); block.tx1 = Math.max(0, Math.min(item.width, x1)); block.ty0 = Math.max(0, Math.min(item.height, y0)); block.ty1 = Math.max(0, Math.min(item.height, y1)); const scale = state.editorScale; el.style.left = `${block.tx0 * scale}px`; el.style.top = `${block.ty0 * scale}px`; el.style.width = `${(block.tx1 - block.tx0) * scale}px`; el.style.height = `${(block.ty1 - block.ty0) * scale}px`; };
  const stop = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', stop); el.removeEventListener('pointercancel', stop); drawEditor(); scheduleSave(); }; el.addEventListener('pointermove', move); el.addEventListener('pointerup', stop); el.addEventListener('pointercancel', stop);
}
function buildBlockList() {
  const item = editorItem(); const list = $('blockList'); list.textContent = ''; state.richFields = new Map(); if (!item.blocks?.length) { list.textContent = 'ابتدا OCR را روی این تصویر اجرا کنید.'; return; }
  item.blocks.forEach((block) => {
    const card = document.createElement('section'); card.className = `block-card${block.enabled ? '' : ' disabled'}`; card.dataset.id = block.id;
    const head = document.createElement('div'); head.className = 'block-head'; const enabledLabel = document.createElement('label'); const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = !!block.enabled; enabledLabel.append(enabled, document.createTextNode(` متن ${block.id} · اطمینان ${Math.round(block.conf || 0)}٪`)); head.appendChild(enabledLabel);
    const bg = document.createElement('select'); [['auto', 'پس‌زمینه خودکار'], ['white', 'سفید'], ['black', 'مشکی'], ['none', 'بدون پاک‌کردن']].forEach(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; bg.appendChild(option); }); bg.value = block.bg || 'auto'; head.appendChild(bg);
    const source = document.createElement('textarea'); source.value = block.text || ''; source.dir = 'auto'; source.setAttribute('aria-label', 'متن OCR');
    const translation = document.createElement('div'); translation.contentEditable = 'true'; translation.innerHTML = block.richHtml || plainToHtml(block.tr || ''); styleRichElement(translation, block); wireRichElement(translation, block);
    const tools = document.createElement('div'); tools.className = 'block-tools';
    const command = (label, name, title = label) => { const button = makeButton(label, () => runRichCommand(name), 'bt'); button.title = title; return button; };
    tools.append(command('B', 'bold', 'پررنگ'), command('I', 'italic', 'ایتالیک'), command('U', 'underline', 'زیرخط'), command('S', 'strikeThrough', 'خط‌خورده'), command('•', 'insertUnorderedList', 'فهرست'), command('1.', 'insertOrderedList', 'فهرست عددی'), command('↶', 'undo', 'واگرد'), command('↷', 'redo', 'ازنو'), command('⌫', 'removeFormat', 'حذف قالب'));
    const rtl = makeButton('راست‌به‌چپ', () => { block.dir = 'rtl'; translation.dir = 'rtl'; runRichCommand('justifyRight'); drawEditor(); scheduleSave(); }); const ltr = makeButton('چپ‌به‌راست', () => { block.dir = 'ltr'; translation.dir = 'ltr'; runRichCommand('justifyLeft'); drawEditor(); scheduleSave(); });
    const align = document.createElement('select'); [['right', 'راست'], ['center', 'وسط'], ['left', 'چپ']].forEach(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; align.appendChild(option); }); align.value = block.align || 'right';
    const size = document.createElement('input'); size.type = 'number'; size.min = '8'; size.max = '160'; size.placeholder = 'اندازه'; size.value = block.size || ''; const color = document.createElement('input'); color.type = 'color'; color.value = block.color || '#ffffff';
    tools.append(rtl, ltr, align, size, color);
    const actions = document.createElement('div'); actions.className = 'block-tools';
    actions.append(makeButton('کپی متن اصلی', async () => { if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(source.value); else { source.focus(); source.select(); document.execCommand('copy'); } toast('کپی شد'); }), makeButton('ترجمهٔ دوباره', async () => { const result = await api('/api/translate-text', jsonOptions('POST', { text: source.value, source_language: $('ocrLanguage').value, provider: state.ai?.provider || 'free' })); block.text = source.value; block.tr = result.text; block.richHtml = plainToHtml(result.text); translation.innerHTML = block.richHtml; drawEditor(); scheduleSave(); }), makeButton('پاک‌کردن ترجمه', () => { block.tr = ''; block.richHtml = ''; translation.innerHTML = ''; drawEditor(); scheduleSave(); }));
    enabled.addEventListener('change', () => { block.enabled = enabled.checked; card.classList.toggle('disabled', !block.enabled); drawEditor(); scheduleSave(); }); bg.addEventListener('change', () => { block.bg = bg.value; scheduleSave(); }); source.addEventListener('input', () => { block.text = source.value; if (currentOverlayMode() === 'ocr') drawEditor(); scheduleSave(); });
    align.addEventListener('change', () => { block.align = align.value; styleRichElement(translation, block); drawEditor(); scheduleSave(); }); size.addEventListener('change', () => { const value = Number(size.value); block.size = value >= 8 ? Math.min(160, value) : null; styleRichElement(translation, block); drawEditor(); scheduleSave(); }); color.addEventListener('input', () => { block.color = color.value; styleRichElement(translation, block); drawEditor(); scheduleSave(); });
    card.append(head, source, translation, tools, actions); list.appendChild(card);
  });
}
async function applyEditor() { const item = editorItem(); if (!item) return; await saveProject(); await renderAndUpload(item); renderGrid(); }
async function closeEditor() {
  if (editorCloseTask) return editorCloseTask;
  editorCloseTask = (async () => {
    await applyEditor(); closeDialog('editorDialog'); state.editorBitmap?.close?.(); state.editorBitmap = null; state.editorId = null;
  })();
  try { await editorCloseTask; } finally { editorCloseTask = null; }
}
async function revertEditor() { const item = editorItem(); if (!item) return; item.blocks.forEach((block) => { block.enabled = false; }); await saveProject(); await api(`/api/projects/${state.project.id}/images/${item.id}/revert`, { method: 'POST' }); item.edited = false; drawEditor(); buildBlockList(); renderGrid(); toast('تصویر اصلی بازیابی شد؛ متن‌ها برای استفادهٔ بعدی باقی ماندند'); }

// ---------- Crop with aspect ratio, moving, and eight handles ----------
function cropItem() { return state.project.images.find((item) => item.id === state.cropId); }
function openCrop(imageId) { state.cropId = imageId; const item = state.project.images.find((entry) => entry.id === imageId); state.crop = item.crop ? { ...item.crop } : null; $('cropRatio').value = String(item.crop?.ratio || 0); $('cropImage').src = imageUrl(item, !!item.edited); $('cropImage').onload = () => { normalizeCropInputs(); drawCropRect(); }; showDialog('cropDialog'); }
function normalizeCropInputs() { const item = cropItem(); if (!item) return; const crop = state.crop || { x: 0, y: 0, w: item.width, h: item.height }; $('cropX').value = Math.round(crop.x); $('cropY').value = Math.round(crop.y); $('cropW').value = Math.round(crop.w); $('cropH').value = Math.round(crop.h); }
function readCropInputs(event) { const item = cropItem(); if (!item) return; const x = Math.max(0, Math.min(item.width - 1, Number($('cropX').value) || 0)); const y = Math.max(0, Math.min(item.height - 1, Number($('cropY').value) || 0)); let w = Math.max(1, Math.min(item.width - x, Number($('cropW').value) || 1)); let h = Math.max(1, Math.min(item.height - y, Number($('cropH').value) || 1)); const ratio = Number($('cropRatio').value); if (ratio > 0) { if (event?.target?.id === 'cropH') { w = Math.min(item.width - x, h * ratio); h = w / ratio; } else { h = Math.min(item.height - y, w / ratio); w = h * ratio; } } state.crop = { x, y, w, h, ratio: ratio || 0 }; drawCropRect(); }
function drawCropRect() { const item = cropItem(); const rect = $('cropRect'); if (!item || !state.crop || !$('cropImage').clientWidth) { rect.style.display = 'none'; return; } const sx = $('cropImage').clientWidth / item.width; const sy = $('cropImage').clientHeight / item.height; rect.style.display = 'block'; rect.style.left = `${state.crop.x * sx}px`; rect.style.top = `${state.crop.y * sy}px`; rect.style.width = `${state.crop.w * sx}px`; rect.style.height = `${state.crop.h * sy}px`; }
function changeCropRatio() { const item = cropItem(); const ratio = Number($('cropRatio').value); if (!item || !ratio) { if (state.crop) state.crop.ratio = 0; return; } const old = state.crop || { x: 0, y: 0, w: item.width, h: item.height }; const cx = old.x + old.w / 2; const cy = old.y + old.h / 2; let w = Math.min(item.width, old.w); let h = w / ratio; if (h > item.height) { h = item.height; w = h * ratio; } state.crop = { x: Math.max(0, Math.min(item.width - w, cx - w / 2)), y: Math.max(0, Math.min(item.height - h, cy - h / 2)), w, h, ratio }; normalizeCropInputs(); drawCropRect(); }
function cropPointerDown(event) {
  const item = cropItem(); if (!item) return; const bounds = $('cropImage').getBoundingClientRect(); const handle = event.target.closest('#cropRect i'); const inside = event.target.closest('#cropRect');
  let mode = 'draw'; let dir = ''; if (handle) { mode = 'resize'; dir = handle.dataset.dir; } else if (inside && state.crop) mode = 'move';
  state.cropPointer = { mode, dir, x: event.clientX, y: event.clientY, bounds, original: state.crop ? { ...state.crop } : null }; $('cropStage').setPointerCapture(event.pointerId); event.preventDefault();
}
function cropPointerMove(event) {
  const start = state.cropPointer; const item = cropItem(); if (!start || !item) return; const b = start.bounds; const sx = item.width / b.width; const sy = item.height / b.height; const dx = (event.clientX - start.x) * sx; const dy = (event.clientY - start.y) * sy; const ratio = Number($('cropRatio').value) || 0;
  if (start.mode === 'draw') {
    const ax = (Math.max(b.left, Math.min(b.right, start.x)) - b.left) * sx;
    const ay = (Math.max(b.top, Math.min(b.bottom, start.y)) - b.top) * sy;
    const bx = (Math.max(b.left, Math.min(b.right, event.clientX)) - b.left) * sx;
    const by = (Math.max(b.top, Math.min(b.bottom, event.clientY)) - b.top) * sy;
    let w = Math.max(1, Math.abs(bx - ax)); let h = Math.max(1, Math.abs(by - ay));
    if (ratio) { if (w / ratio >= h) h = w / ratio; else w = h * ratio; }
    w = Math.min(item.width, w); h = Math.min(item.height, h);
    let x = bx < ax ? ax - w : ax; let y = by < ay ? ay - h : ay;
    x = Math.max(0, Math.min(item.width - w, x)); y = Math.max(0, Math.min(item.height - h, y));
    state.crop = { x, y, w, h, ratio };
  }
  else if (start.mode === 'move') { const old = start.original; state.crop = { ...old, x: Math.max(0, Math.min(item.width - old.w, old.x + dx)), y: Math.max(0, Math.min(item.height - old.h, old.y + dy)) }; }
  else { const old = start.original; let { x, y, w, h } = old; if (start.dir.includes('w')) { x = old.x + dx; w = old.w - dx; } if (start.dir.includes('e')) w = old.w + dx; if (start.dir.includes('n')) { y = old.y + dy; h = old.h - dy; } if (start.dir.includes('s')) h = old.h + dy; if (w < 8) w = 8; if (h < 8) h = 8; if (ratio) { if (start.dir === 'n' || start.dir === 's') w = h * ratio; else h = w / ratio; } if (start.dir.includes('w')) x = old.x + old.w - w; if (start.dir.includes('n')) y = old.y + old.h - h; x = Math.max(0, Math.min(item.width - w, x)); y = Math.max(0, Math.min(item.height - h, y)); state.crop = { x, y, w: Math.min(item.width, w), h: Math.min(item.height, h), ratio }; }
  normalizeCropInputs(); drawCropRect();
}

// ---------- Preview ----------
function openPreview(item) { state.previewId = item.id; $('previewImage').src = imageUrl(item, !!item.edited, true); showDialog('previewDialog'); }
async function copyPreview() {
  const item = state.project.images.find((entry) => entry.id === state.previewId); if (!item) return;
  try { const response = await fetch(imageUrl(item, !!item.edited, true)); const bitmap = await createImageBitmap(await response.blob()); const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close(); const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png')); if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('مرورگر اجازهٔ کپی تصویر نمی‌دهد'); await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('تصویر کپی شد'); } catch (error) { toast(error.message || 'کپی تصویر ممکن نبود', true); }
}

// ---------- Events and startup ----------
function bindEvents() {
  window.addEventListener('pagehide', closeSession);
  bindGridDrop();
  $('menuBtn').addEventListener('click', () => $('menu').classList.toggle('hidden'));
  $('themeBtn').addEventListener('click', () => { document.body.classList.toggle('light'); localStorage.setItem('comic-studio-theme', document.body.classList.contains('light') ? 'light' : 'dark'); });
  $('newProjectBtn').addEventListener('click', async () => { if (!confirm('پروژهٔ جدید ساخته شود؟ پروژهٔ فعلی ذخیره می‌ماند.')) return; await saveProject(); adoptProject(await api('/api/projects', jsonOptions('POST', { name: 'پروژهٔ کمیک' }))); await refreshProjectList(); });
  $('deleteProjectBtn').addEventListener('click', async () => { if (!state.project || !confirm('این پروژه و تصاویرش برای همیشه حذف شود؟')) return; await api(`/api/projects/${state.project.id}`, { method: 'DELETE' }); const projects = await api('/api/projects'); const project = projects.length ? await api(`/api/projects/${projects[0].id}`) : await api('/api/projects', jsonOptions('POST', { name: 'پروژهٔ کمیک' })); adoptProject(project); await refreshProjectList(); $('menu').classList.add('hidden'); });
  $('projectSelect').addEventListener('change', () => loadProject($('projectSelect').value).catch((error) => toast(error.message, true)));
  $('projectName').addEventListener('change', () => { state.project.name = $('projectName').value; scheduleSave(); });
  $('fileInput').addEventListener('change', () => importFiles($('fileInput').files).catch(() => {}).finally(() => { $('fileInput').value = ''; }));
  $('selectAllBtn').addEventListener('click', () => { state.project.images.forEach((item) => { item.selected = true; }); renderGrid(); scheduleSave(); });
  $('selectNoneBtn').addEventListener('click', () => { state.project.images.forEach((item) => { item.selected = false; }); renderGrid(); scheduleSave(); });
  $('invertBtn').addEventListener('click', () => { state.project.images.forEach((item) => { item.selected = !item.selected; }); renderGrid(); scheduleSave(); });
  $('groupBtn').addEventListener('click', () => { if (state.groupEditId) return finishGroupEdit(false); const ids = selectedImages().map((item) => item.id); if (ids.length < 2) { toast('برای گروه‌سازی حداقل دو تصویر انتخاب کنید', true); return; } const id = G.create(state.project.images, ids); renderGrid(); scheduleSave(); toast(`گروه ${id} ساخته یا ادغام شد`); });
  $('ungroupBtn').addEventListener('click', () => { const ids = selectedImages().map((item) => item.id); G.ungroup(state.project.images, ids); renderGrid(); scheduleSave(); });
  $('cancelGroupEdit').addEventListener('click', () => finishGroupEdit(true));
  $('duplicateBtn').addEventListener('click', () => duplicateImages(selectedImages().map((item) => item.id)).catch((error) => toast(error.message, true)));
  $('deleteBtn').addEventListener('click', () => deleteImages(selectedImages().map((item) => item.id)).catch((error) => toast(error.message, true)));
  $('ocrBtn').addEventListener('click', () => { updateEngineOptions(); showDialog('ocrDialog'); }); $('ocrEngine').addEventListener('change', updateOcrEngineStatus); $('startOcrBtn').addEventListener('click', () => runOcr().catch(() => {})); $('translateBtn').addEventListener('click', () => runTranslation().catch(() => {}));
  $('modelsBtn').addEventListener('click', () => { renderModels(); showDialog('modelsDialog'); $('menu').classList.add('hidden'); }); $('testLanguage').addEventListener('change', renderModels); $('aiBtn').addEventListener('click', () => { loadAiSettings().then(() => { showDialog('aiDialog'); $('menu').classList.add('hidden'); }).catch((error) => toast(error.message, true)); }); $('aiProvider').addEventListener('change', updateAiFields); $('saveAiBtn').addEventListener('click', () => saveAiSettings().catch((error) => toast(error.message, true))); $('testAiBtn').addEventListener('click', async () => { try { await saveAiSettings(); const result = await api('/api/ai-settings/test', { method: 'POST' }); $('aiStatus').textContent = result.message; } catch (error) { $('aiStatus').textContent = error.message; } });
  $('exportBtn').addEventListener('click', () => { updateExportFields(); showDialog('exportDialog'); }); $('exportKind').addEventListener('change', updateExportFields); $('overlayMode').addEventListener('change', () => setOverlayMode($('overlayMode').value)); $('exportOverlayMode').addEventListener('change', () => setOverlayMode($('exportOverlayMode').value)); $('startExportBtn').addEventListener('click', () => runJob('در حال ساخت خروجی…', () => exportResult()).catch(() => {})); $('exportPdfBtn').addEventListener('click', () => runJob('در حال ساخت PDF…', () => exportResult('pdf')).catch(() => {})); $('exportImagesBtn').addEventListener('click', () => runJob('در حال ساخت ZIP…', () => exportResult('images')).catch(() => {})); $('exportTxtBtn').addEventListener('click', () => runJob('در حال ساخت TXT…', () => exportResult('txt')).catch(() => {}));
  $('editorApply').addEventListener('click', () => applyEditor().catch((error) => toast(error.message, true))); $('editorClose').addEventListener('click', () => closeEditor().catch((error) => toast(error.message, true))); $('editorRevert').addEventListener('click', () => revertEditor().catch((error) => toast(error.message, true))); $('editorDialog').addEventListener('cancel', (event) => { event.preventDefault(); closeEditor().catch((error) => toast(error.message, true)); });
  $('previewCopy').addEventListener('click', copyPreview);
  window.addEventListener('resize', () => { if (state.editorId) fitEditor(); if (state.cropId) drawCropRect(); scheduleOutlines(); });
  ['cropX', 'cropY', 'cropW', 'cropH'].forEach((id) => $(id).addEventListener('change', readCropInputs)); $('cropRatio').addEventListener('change', changeCropRatio); $('cropStage').addEventListener('pointerdown', cropPointerDown); $('cropStage').addEventListener('pointermove', cropPointerMove); const stopCrop = () => { state.cropPointer = null; }; $('cropStage').addEventListener('pointerup', stopCrop); $('cropStage').addEventListener('pointercancel', stopCrop);
  $('cropReset').addEventListener('click', () => { cropItem().crop = null; state.crop = null; closeDialog('cropDialog'); renderGrid(); scheduleSave(); }); $('cropApply').addEventListener('click', () => { readCropInputs(); cropItem().crop = state.crop; closeDialog('cropDialog'); renderGrid(); scheduleSave(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (closeTopDialog()) { event.preventDefault(); event.stopPropagation(); }
      else $('menu').classList.add('hidden');
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && state.editorId) { event.preventDefault(); applyEditor().catch((error) => toast(error.message, true)); }
    if (event.key === 'Enter' && state.cropId && $('cropDialog').open && !event.target.matches('input,select')) { event.preventDefault(); $('cropApply').click(); }
  });
  if (localStorage.getItem('comic-studio-theme') === 'light') document.body.classList.add('light');
}
async function init() {
  bindEvents(); startActivityFeed(); startSession();
  try { const [projects, engines, ai] = await Promise.all([api('/api/projects'), api('/api/engines'), api('/api/ai-settings')]); state.engines = engines; state.ai = ai; const project = projects.length ? await api(`/api/projects/${projects[0].id}`) : await api('/api/projects', jsonOptions('POST', { name: 'پروژهٔ کمیک' })); adoptProject(project); await refreshProjectList(); await loadAiSettings(); }
  catch (error) { toast(`راه‌اندازی ناموفق: ${error.message}`, true); }
}
init();
