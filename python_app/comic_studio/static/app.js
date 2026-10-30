/* global Typeset, createImageBitmap, StudioGroups, ClipboardItem */
'use strict';

const $ = (id) => document.getElementById(id);
const G = window.StudioGroups;
const GROUP_COLORS = ['#34d399', '#60a5fa', '#f472b6', '#fbbf24', '#a78bfa', '#2dd4bf', '#fb923c', '#e879f9'];
const state = {
  project: null, engines: [], ai: null, editorId: null, editorBitmap: null, editorScale: 1, editorFitScale: 1, editorPan: null, activeBlockId: null, selectedBlockIds: [],
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
let activityGeneration = 0;
let sessionTimer = null;
let localActivityId = 0;
let editorCloseTask = null;
let editorCanvasFrame = 0;
let jobBusy = false;
let translationRunning = false;
let translationPreviewAction = null;
let translationPreviewTask = Promise.resolve();
let overlayPreviewTask = Promise.resolve();
let downloadUrl = null;
let previewRevision = 0;
const imageRenderTasks = new Map();
const imagePreviewVersions = new Map();

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
  const generation = activityGeneration;
  try {
    const response = await fetch(`/api/activity?after=${activityAfter}`, { cache: 'no-store' });
    if (!response.ok) return;
    const payload = await response.json();
    if (generation !== activityGeneration) return;
    activityAfter = Math.max(activityAfter, Number(payload.next) || 0);
    (payload.entries || []).forEach((entry) => {
      if (!activityEntries.some((existing) => existing.id === entry.id)) activityEntries.push(entry);
    });
    activityEntries = activityEntries.slice(-100);
    const latest = payload.entries?.at(-1);
    if (jobBusy && latest) {
      $('jobStatus').textContent = latest.message;
      if (latest.progress !== null && latest.progress !== undefined) $('jobProgress').style.width = `${Math.round(latest.progress * 100)}%`;
      if (translationRunning) {
        $('translationStatus').textContent = latest.message;
        if (latest.progress !== null && latest.progress !== undefined) $('translationProgress').style.width = `${Math.round(latest.progress * 100)}%`;
      }
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
async function clearActivity(notify = true) {
  ++activityGeneration; activityEntries = []; renderActivity();
  let succeeded = false;
  try {
    const result = await api('/api/activity/clear', { method: 'POST' });
    activityAfter = Math.max(activityAfter, Number(result?.next) || 0); succeeded = true;
  } catch (error) {
    if (notify) toast(error.message || 'پاک‌کردن گزارش ممکن نبود', true);
  } finally {
    // Invalidate polls that began before or during the clear so old entries cannot reappear.
    ++activityGeneration; activityEntries = []; renderActivity();
    if (!jobBusy) { $('jobStatus').textContent = 'آماده'; $('jobProgress').style.width = '0'; }
  }
  if (notify && succeeded) toast('گزارش کارها پاک شد');
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
  if (downloadUrl) { URL.revokeObjectURL(downloadUrl); downloadUrl = null; }
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
  if (edited) {
    query.set('edited', 'true');
    const version = imagePreviewVersions.get(`${state.project?.id}:${item.id}`);
    if (version) query.set('v', String(version));
  }
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
  if (translationRunning) { $('translationStatus').textContent = message || 'آماده'; $('translationProgress').style.width = message ? '65%' : '0'; }
  document.querySelectorAll('.main-actions button, .main-actions .file-button, #dock button').forEach((el) => { el.disabled = !!message; });
}
async function runJob(message, task) {
  await clearActivity(false);
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
  const project = state.project;
  G.normalizeLayout(project.images);
  const result = await api(`/api/projects/${project.id}/state`, jsonOptions('PUT', { state: project }));
  // Keep the live object identity: cards and editor fields must never point at a detached pre-save project.
  // The response is a snapshot and may also be older than edits made while the request was in flight.
  if (state.project === project) {
    project.updatedAt = result.updatedAt || project.updatedAt;
    $('saveState').textContent = 'ذخیره شد';
  }
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
function normalizeOverlayMode(mode) { return mode === 'ocr' || mode === 'none' ? mode : 'translation'; }
function currentOverlayMode() { return normalizeOverlayMode(state.project?.settings?.overlayMode); }
function queueOverlayPreviewRefresh() {
  // Serialize rapid selector changes so an older render can never replace the final choice.
  overlayPreviewTask = overlayPreviewTask.catch(() => {}).then(async () => {
    await saveProject();
    await renderImagesText();
  });
  overlayPreviewTask.catch((error) => toast(`به‌روزرسانی متن روی تصویر ممکن نبود: ${error.message || error}`, true));
  return overlayPreviewTask;
}
function setOverlayMode(mode, redraw = true) {
  if (!state.project) return overlayPreviewTask;
  state.project.settings = state.project.settings || {};
  state.project.settings.overlayMode = normalizeOverlayMode(mode);
  $('overlayMode').value = state.project.settings.overlayMode;
  $('exportOverlayMode').value = state.project.settings.overlayMode;
  const item = state.project.images.find((entry) => entry.id === state.editorId);
  const cards = [...document.querySelectorAll('#blockList .block-card')];
  (item?.blocks || []).forEach((block) => {
    const selector = cards.find((card) => card.dataset.id === String(block.id))?.querySelector('[data-text-mode]');
    if (selector) selector.value = blockTextMode(block);
  });
  if (redraw && state.editorId) { drawEditor(); scheduleSave(); }
  else if (redraw) queueOverlayPreviewRefresh();
  return overlayPreviewTask;
}
function normalizeBlockTextMode(mode) { return mode === 'ocr' ? 'ocr' : 'translation'; }
function blockTextMode(block, mode = currentOverlayMode()) {
  if (block.textMode === 'ocr' || block.textMode === 'translation') return block.textMode;
  return mode === 'ocr' ? 'ocr' : 'translation';
}
function blockOverlayMode(block, mode = currentOverlayMode()) {
  return mode === 'none' ? 'none' : blockTextMode(block, mode);
}
function overlayBlock(block, mode = currentOverlayMode()) {
  const effectiveMode = blockOverlayMode(block, mode);
  if (effectiveMode === 'none') return { ...block, tr: '', richHtml: '' };
  if (effectiveMode !== 'ocr') return block;
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
function updateSelectionDisplay() {
  const byId = new Map((state.project?.images || []).map((item) => [item.id, item]));
  document.querySelectorAll('#grid .item').forEach((card) => {
    const item = byId.get(card.dataset.id); if (!item) return;
    card.classList.toggle('selected', !!item.selected);
    const tick = card.querySelector('.tick'); if (tick) tick.checked = !!item.selected;
  });
  updateSummary();
}
function setSelected(item, value, event = null) {
  if (event?.shiftKey && state.lastSelectedId) {
    const ordered = sortedImages(); const a = ordered.findIndex((entry) => entry.id === state.lastSelectedId); const b = ordered.findIndex((entry) => entry.id === item.id);
    if (a >= 0 && b >= 0) ordered.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((entry) => { entry.selected = value; });
  } else item.selected = value;
  state.lastSelectedId = item.id; updateSelectionDisplay(); scheduleSave();
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
      // The browser has already applied the new checkbox value; consume this one click without cancelling it.
      event.stopPropagation(); setSelected(item, tick.checked, event);
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
      if (event.target.closest('button,input,select,textarea')) { event.preventDefault(); return; }
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
async function loadProject(id) { const project = await api(`/api/projects/${id}`); adoptProject(project); await refreshProjectList(); await renderImagesText(); }
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
function showTranslationRequestPreview(preview, action) {
  translationPreviewAction = action;
  $('translationPreviewSummary').textContent = `${preview.blockCount} متن · ${preview.requestCount} درخواست واقعی برای بررسی`;
  const destination = [preview.providerLabel, preview.model && `مدل: ${preview.model}`, preview.base_url && `نشانی: ${preview.base_url}`, preview.fallback_url && `فقط هنگام خطا: ${preview.fallback_url}`].filter(Boolean).join(' · ');
  $('translationPreviewDestination').textContent = destination;
  $('translationPreviewNote').textContent = preview.note || '';
  const container = $('translationPreviewRequests'); container.textContent = '';
  (preview.requests || []).forEach((request, index) => {
    const details = document.createElement('details'); details.className = 'payload-request'; details.open = (preview.requests.length === 1 || index === 0);
    const summary = document.createElement('summary'); summary.textContent = `درخواست ${request.index} · ${request.characters} نویسه`;
    const text = document.createElement('pre'); text.dir = 'auto'; text.textContent = request.text;
    details.append(summary, text); container.appendChild(details);
  });
  const hasSystemPrompt = !!preview.systemPrompt;
  $('translationPreviewSystemWrap').classList.toggle('hidden', !hasSystemPrompt);
  $('translationPreviewSystem').textContent = preview.systemPrompt || '';
  $('translationPreviewConfirm').disabled = !preview.requests?.length;
  showDialog('translationPreviewDialog');
}
function cancelTranslationRequestPreview() { translationPreviewAction = null; closeDialog('translationPreviewDialog'); }
async function confirmTranslationRequestPreview() {
  const action = translationPreviewAction;
  if (!action) return;
  translationPreviewAction = null; $('translationPreviewConfirm').disabled = true;
  closeDialog('translationPreviewDialog');
  try { translationPreviewTask = action(); await translationPreviewTask; }
  catch (error) { toast(error.message || 'ترجمه ناموفق بود', true); }
  finally { $('translationPreviewConfirm').disabled = false; }
}
async function runTranslation() {
  const ids = selectedImages().map((item) => item.id); if (!ids.length) { toast('حداقل یک تصویر را انتخاب کنید', true); return; }
  if (translationRunning) return;
  try {
    await saveProject();
    const provider = state.ai?.provider || 'free';
    const preview = await api(`/api/projects/${state.project.id}/translation-preview`, jsonOptions('POST', { image_ids: ids, provider, source_language: $('ocrLanguage').value }));
    showTranslationRequestPreview(preview, () => performTranslation(ids, provider, preview.signature));
  } catch (error) { toast(`ساخت پیش‌نمایش ترجمه ممکن نبود: ${error.message || error}`, true); }
}
async function performTranslation(ids, provider, confirmation) {
  translationRunning = true; showDialog('translationDialog'); $('translationStatus').textContent = 'در حال آماده‌سازی ترجمه…'; $('translationProgress').style.width = '0';
  try {
    await runJob('در حال ترجمهٔ متن‌ها…', async () => {
      const result = await api(`/api/projects/${state.project.id}/translate`, jsonOptions('POST', { image_ids: ids, provider, source_language: $('ocrLanguage').value, confirmation }));
      adoptProject(result); setOverlayMode('translation', false); await saveProject(); await renderImagesText();
    });
    closeDialog('translationDialog'); toast('ترجمه روی تصویر آمد و پیش‌نمایش آماده شد');
  } catch (error) {
    $('translationStatus').textContent = `ترجمه ناموفق بود: ${error.message || error}`; throw error;
  } finally {
    translationRunning = false;
  }
}

// ---------- Typeset preview and export ----------
async function ensureFont() { if (document.fonts?.load) { try { await document.fonts.load('700 24px Vazirmatn', 'ابپتثجچ'); } catch { /* fallback */ } } }
async function renderAndUploadNow(item, projectId, mode) {
  const blocks = overlayBlocks(item, mode); const active = blocks.some((block) => block.enabled && block.tr?.trim());
  if (!active) {
    await api(`/api/projects/${projectId}/images/${item.id}/revert`, { method: 'POST' });
    imagePreviewVersions.set(`${projectId}:${item.id}`, ++previewRevision);
    const current = state.project?.id === projectId ? state.project.images.find((entry) => entry.id === item.id) : null; if (current) current.edited = false; return;
  }
  await ensureFont(); const response = await fetch(`/api/projects/${projectId}/images/${item.id}/content`); if (!response.ok) throw new Error('تصویر اصلی باز نشد');
  const bitmap = await createImageBitmap(await response.blob()); let canvas;
  try { canvas = Typeset.render(bitmap, blocks); } finally { bitmap.close(); }
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error(`ساخت PNG برای «${item.name}» ممکن نشد؛ تصویر خیلی بزرگ یا حافظهٔ مرورگر کم است`);
  await api(`/api/projects/${projectId}/images/${item.id}/rendered`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob });
  imagePreviewVersions.set(`${projectId}:${item.id}`, ++previewRevision);
  canvas.width = canvas.height = 0; const current = state.project?.id === projectId ? state.project.images.find((entry) => entry.id === item.id) : null; if (current) current.edited = true;
}
function renderAndUpload(item) {
  const projectId = state.project?.id;
  if (!projectId) return Promise.resolve();
  const key = `${projectId}:${item.id}`;
  const mode = currentOverlayMode();
  const previous = imageRenderTasks.get(key) || Promise.resolve();
  // A slow older canvas/upload must finish before the newer request for this same image.
  // Other images remain independent, and a failed earlier render does not block later attempts.
  const task = previous.catch(() => {}).then(() => renderAndUploadNow(item, projectId, mode));
  imageRenderTasks.set(key, task);
  task.finally(() => { if (imageRenderTasks.get(key) === task) imageRenderTasks.delete(key); }).catch(() => {});
  return task;
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
  await overlayPreviewTask;
  collectOutputSettings(); await saveProject(); const exportKind = $('exportKind').value;
  if (exportKind !== 'txt') { for (const item of selectedImages()) if (hasOverlayText(item) || item.edited) await renderAndUpload(item); renderGrid(); }
  const response = await fetch(`/api/projects/${state.project.id}/export`, jsonOptions('POST', { kind: exportKind, image_ids: selectedImages().map((item) => item.id), name: safeName($('exportName').value), seamless: $('exportSeamless').checked, uniform_size: $('exportUniform').checked, two_per_page: $('exportTwo').checked, image_format: $('exportFormat').value, folder_name: $('exportFolder').value }));
  if (!response.ok) { const payload = await response.json().catch(() => null); throw new Error(payload?.detail || `خروجی ساخته نشد (HTTP ${response.status})`); }
  const blob = await response.blob();
  if (!blob.size) throw new Error('سرور فایل خروجی خالی فرستاد؛ گزارش کارها را بررسی و دوباره تلاش کنید');
  const disposition = response.headers.get('content-disposition') || ''; const match = disposition.match(/filename\*?=(?:UTF-8''|\")?([^\";]+)/i);
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = URL.createObjectURL(blob);
  const link = $('downloadLink'); link.href = downloadUrl; link.download = match ? decodeURIComponent(match[1]) : `${safeName($('exportName').value)}.${exportKind === 'images' ? 'zip' : exportKind}`;
  link.textContent = `دانلود ${link.download}`; link.classList.remove('hidden'); link.click();
  closeDialog('exportDialog'); $('jobStatus').textContent = `خروجی ${exportKind.toUpperCase()} آماده شد · ${(blob.size / 1024).toFixed(0)} کیلوبایت`; toast('خروجی آماده شد؛ اگر دانلود خودکار نشد، پیوند «دانلود» را بزنید');
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
const AI_PROVIDER_IDS = ['gemini', 'openai', 'openrouter', 'avalai'];
const AI_FALLBACKS = {
  gemini: { label: 'Google Gemini', model: 'gemini-2.5-flash', defaultModel: 'gemini-2.5-flash', base_url: 'https://generativelanguage.googleapis.com/v1beta', keyUrl: 'https://aistudio.google.com/apikey', keyLabel: 'ساخت کلید در Google AI Studio', profiles: [] },
  openai: { label: 'OpenAI', model: 'gpt-4o-mini', defaultModel: 'gpt-4o-mini', base_url: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys', keyLabel: 'ساخت کلید در OpenAI', profiles: [] },
  openrouter: { label: 'OpenRouter', model: 'openai/gpt-4o-mini', defaultModel: 'openai/gpt-4o-mini', base_url: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/settings/keys', keyLabel: 'ساخت کلید در OpenRouter', profiles: [] },
  avalai: { label: 'AvalAI', model: 'gpt-6-luna', defaultModel: 'gpt-6-luna', base_url: 'https://api.avalai.ir/v1', keyUrl: 'https://docs.avalai.ir/en/quickstart', keyLabel: 'راهنمای AvalAI', profiles: [] },
};
let aiEditorProvider = 'free';
let aiEditorProfiles = [];
let aiProfileSerial = 0;
const aiEditorDrafts = new Map();
function aiInfo(provider = aiEditorProvider) { return state.ai?.providers?.[provider] || AI_FALLBACKS[provider] || AI_FALLBACKS.avalai; }
function makeAiProfile(profile = {}, index = 0) {
  aiProfileSerial += 1;
  return {
    id: String(profile.id || `api-${Date.now().toString(36)}-${aiProfileSerial}`),
    name: String(profile.name || ''), hasApiKey: profile.hasApiKey === true,
    apiKey: String(profile.apiKey || ''),
  };
}
function captureAiProvider() {
  if (!AI_PROVIDER_IDS.includes(aiEditorProvider)) return;
  aiEditorDrafts.set(aiEditorProvider, {
    model: $('aiModel').value.trim(), base_url: $('aiBaseUrl').value.trim(),
    profiles: aiEditorProfiles.map((profile) => ({ ...profile })),
  });
}
function updateAiProviderUi() {
  const info = aiInfo();
  $('aiKeyHelp').href = info.keyUrl;
  $('aiKeyHelp').textContent = info.keyLabel;
  $('aiBaseUrlField').classList.toggle('hidden', aiEditorProvider === 'gemini');
  $('aiModel').placeholder = info.defaultModel || info.model || '';
}
function renderAiProfiles() {
  const container = $('aiProfiles');
  container.textContent = '';
  aiEditorProfiles.forEach((profile, index) => {
    const row = document.createElement('div');
    row.className = 'ai-profile-row'; row.dataset.profileId = profile.id;
    const name = document.createElement('input');
    name.type = 'text'; name.className = 'ai-profile-name'; name.value = profile.name;
    name.placeholder = `API ${index + 1}`; name.setAttribute('aria-label', `نام دلخواه API ${index + 1}`);
    name.addEventListener('input', () => { profile.name = name.value; });
    const key = document.createElement('input');
    key.type = 'password'; key.className = 'ai-profile-key'; key.dir = 'ltr';
    key.autocomplete = 'off'; key.spellcheck = false; key.value = profile.apiKey;
    key.placeholder = profile.hasApiKey ? 'کلید ذخیره شده؛ برای تغییر، کلید تازه بدهید' : 'کلید API';
    key.setAttribute('aria-label', `کلید API ${index + 1}`);
    key.addEventListener('input', () => { profile.apiKey = key.value; $('aiStatus').textContent = ''; });
    const test = document.createElement('button');
    test.type = 'button'; test.className = 'bt ai-profile-test'; test.textContent = 'تست';
    test.title = 'تست همین کلید و مدل بدون ارسال متن کمیک';
    test.setAttribute('aria-label', `تست اتصال API ${index + 1}`);
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'bt danger ai-profile-remove'; remove.textContent = '×';
    remove.title = 'حذف این API'; remove.setAttribute('aria-label', `حذف API ${index + 1}`);
    remove.disabled = aiEditorProfiles.length === 1;
    remove.addEventListener('click', () => {
      aiEditorProfiles.splice(index, 1);
      if (!aiEditorProfiles.length) aiEditorProfiles.push(makeAiProfile());
      renderAiProfiles();
    });
    const status = document.createElement('span');
    status.className = 'ai-profile-status'; status.setAttribute('role', 'status');
    test.addEventListener('click', async () => {
      const provider = aiEditorProvider;
      const profileId = profile.id;
      const model = $('aiModel').value.trim();
      const baseUrl = $('aiBaseUrl').value.trim();
      if (!profile.apiKey.trim() && !profile.hasApiKey) {
        status.textContent = 'ابتدا کلید API را وارد کنید.'; key.focus(); return;
      }
      test.disabled = true; test.textContent = '…'; status.textContent = 'در حال بررسی…';
      try {
        await saveAiSettings({ quiet: true });
        const result = await api('/api/ai-settings/test', jsonOptions('POST', {
          provider, profile_id: profileId, model, base_url: baseUrl,
        }));
        $('aiStatus').textContent = result.message;
        const currentRow = [...container.querySelectorAll('.ai-profile-row')].find((item) => item.dataset.profileId === profileId);
        if (currentRow) currentRow.querySelector('.ai-profile-status').textContent = 'اتصال برقرار است ✓';
      } catch (error) {
        $('aiStatus').textContent = error.message;
        const currentRow = [...container.querySelectorAll('.ai-profile-row')].find((item) => item.dataset.profileId === profileId);
        (currentRow?.querySelector('.ai-profile-status') || status).textContent = error.message;
      } finally {
        const currentRow = [...container.querySelectorAll('.ai-profile-row')].find((item) => item.dataset.profileId === profileId);
        const currentTest = currentRow?.querySelector('.ai-profile-test') || test;
        currentTest.disabled = false; currentTest.textContent = 'تست';
      }
    });
    row.append(name, key, test, remove, status); container.appendChild(row);
  });
}
function showAiProvider(provider, capture = true) {
  if (capture && provider !== aiEditorProvider) captureAiProvider();
  aiEditorProvider = AI_PROVIDER_IDS.includes(provider) ? provider : 'free';
  $('aiProvider').value = aiEditorProvider;
  $('aiFields').classList.toggle('hidden', aiEditorProvider === 'free');
  if (aiEditorProvider === 'free') { $('aiStatus').textContent = ''; return; }
  const info = aiInfo();
  const draft = aiEditorDrafts.get(aiEditorProvider);
  const sourceProfiles = draft?.profiles || info.profiles || [];
  aiEditorProfiles = sourceProfiles.map((profile, index) => makeAiProfile(profile, index));
  if (!aiEditorProfiles.length) aiEditorProfiles.push(makeAiProfile({ name: 'کلید اول' }));
  $('aiModel').value = draft?.model || info.model || info.defaultModel || '';
  $('aiBaseUrl').value = draft?.base_url || info.base_url || '';
  updateAiProviderUi(); renderAiProfiles(); $('aiStatus').textContent = '';
}
async function loadAiSettings() {
  state.ai = await api('/api/ai-settings');
  aiEditorDrafts.clear(); showAiProvider(state.ai.provider || 'free', false);
}
function aiSettingsPayload() {
  captureAiProvider();
  const providers = {};
  AI_PROVIDER_IDS.forEach((provider) => {
    const info = aiInfo(provider);
    const draft = aiEditorDrafts.get(provider);
    const profiles = draft?.profiles || info.profiles || [];
    providers[provider] = {
      model: draft?.model || info.model || info.defaultModel,
      base_url: draft?.base_url || info.base_url,
      profiles: profiles.map((profile) => ({
        id: profile.id, name: profile.name || '',
        ...(profile.apiKey?.trim() ? { api_key: profile.apiKey.trim() } : {}),
      })),
    };
  });
  const active = providers[aiEditorProvider];
  return { provider: aiEditorProvider, model: active?.model || null, base_url: active?.base_url || null, providers };
}
async function saveAiSettings(options = {}) {
  state.ai = await api('/api/ai-settings', jsonOptions('PUT', aiSettingsPayload()));
  aiEditorDrafts.clear(); showAiProvider(state.ai.provider || 'free', false);
  if (!options.quiet) toast('تنظیمات ترجمه ذخیره شد');
  return state.ai;
}

// ---------- Full-page translation editor ----------
function editorItem() { return state.project?.images.find((item) => item.id === state.editorId); }
function boxOf(block) { return { x0: Number.isFinite(block.tx0) ? block.tx0 : block.x0, y0: Number.isFinite(block.ty0) ? block.ty0 : block.y0, x1: Number.isFinite(block.tx1) ? block.tx1 : block.x1, y1: Number.isFinite(block.ty1) ? block.ty1 : block.y1 }; }
async function openEditor(imageId) {
  await ensureFont(); state.editorId = imageId; state.richFields = new Map(); state.activeBlockId = null; state.selectedBlockIds = []; state.editorPan = null; $('editorStage').classList.remove('panning'); const item = state.project.images.find((entry) => entry.id === imageId); $('editorTitle').textContent = `ویرایش — ${item.name}`; showDialog('editorDialog');
  const response = await fetch(imageUrl(item)); state.editorBitmap?.close?.(); state.editorBitmap = await createImageBitmap(await response.blob()); $('editorCanvas').width = state.editorBitmap.width; $('editorCanvas').height = state.editorBitmap.height; buildBlockList(); fitEditor(); drawEditor();
}
function resizeEditorStage() {
  const item = editorItem(); if (!item) return;
  const scale = state.editorScale || 1; const w = item.width * scale; const h = item.height * scale; const preview = document.querySelector('.editor-preview');
  $('editorStage').style.width = `${w}px`; $('editorStage').style.height = `${h}px`; $('editorCanvas').style.width = `${w}px`; $('editorCanvas').style.height = `${h}px`;
  preview.classList.toggle('oversized', w > Math.max(0, preview.clientWidth - 30) + 1);
  $('editorZoomLabel').textContent = `${Math.round(scale * 100)}٪`;
  renderEditorBoxes();
}
function fitEditor() {
  const item = editorItem(); if (!item) return;
  const available = Math.max(250, document.querySelector('.editor-preview').clientWidth - 35); state.editorFitScale = Math.min(1, available / item.width); setEditorZoom(state.editorFitScale);
}
function setEditorZoom(value, anchor = null) {
  const item = editorItem(); if (!item) return;
  const preview = document.querySelector('.editor-preview'); const stage = $('editorStage'); const oldScale = state.editorScale || 1;
  const minScale = Math.min(.1, state.editorFitScale || .1); const scale = Math.max(minScale, Math.min(4, Number(value) || oldScale));
  const viewportX = anchor?.x ?? preview.clientWidth / 2; const viewportY = anchor?.y ?? preview.clientHeight / 2;
  const imageX = (preview.scrollLeft + viewportX - stage.offsetLeft) / oldScale; const imageY = (preview.scrollTop + viewportY - stage.offsetTop) / oldScale;
  state.editorScale = scale; resizeEditorStage();
  preview.scrollLeft = Math.max(0, stage.offsetLeft + imageX * scale - viewportX); preview.scrollTop = Math.max(0, stage.offsetTop + imageY * scale - viewportY);
}
function startEditorPan(event) {
  if (!state.editorId || (event.button !== 0 && event.button !== 1) || event.target.closest('.editor-box')) return;
  const preview = document.querySelector('.editor-preview'); const stage = $('editorStage');
  state.editorPan = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: preview.scrollLeft, top: preview.scrollTop };
  stage.setPointerCapture(event.pointerId); stage.classList.add('panning'); event.preventDefault();
}
function moveEditorPan(event) {
  const pan = state.editorPan; if (!pan || pan.pointerId !== event.pointerId) return;
  const preview = document.querySelector('.editor-preview'); preview.scrollLeft = pan.left - (event.clientX - pan.x); preview.scrollTop = pan.top - (event.clientY - pan.y); event.preventDefault();
}
function stopEditorPan(event) {
  const pan = state.editorPan; if (!pan || (event.pointerId !== undefined && pan.pointerId !== event.pointerId)) return;
  const stage = $('editorStage'); state.editorPan = null; stage.classList.remove('panning'); if (stage.hasPointerCapture?.(pan.pointerId)) stage.releasePointerCapture(pan.pointerId);
}
function handleEditorWheel(event) {
  if (!state.editorId) return;
  event.preventDefault(); const rect = document.querySelector('.editor-preview').getBoundingClientRect();
  setEditorZoom(state.editorScale * (event.deltaY < 0 ? 1.15 : 1 / 1.15), { x: event.clientX - rect.left, y: event.clientY - rect.top });
}
function drawEditorCanvas() {
  const item = editorItem(); if (!item || !state.editorBitmap) return;
  const rendered = Typeset.render(state.editorBitmap, overlayBlocks(item)); const canvas = $('editorCanvas'); const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(rendered, 0, 0);
}
function scheduleEditorCanvasDraw() {
  if (editorCanvasFrame) return;
  editorCanvasFrame = requestAnimationFrame(() => { editorCanvasFrame = 0; drawEditorCanvas(); });
}
function drawEditor() { drawEditorCanvas(); renderEditorBoxes(); }
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
  const box = boxOf(block); const style = Typeset.blockStyle(block); element.dir = style.dir; element.style.direction = style.dir; element.style.textAlign = style.align; element.style.fontSize = `${overlaySize(block, box.x1 - box.x0, box.y1 - box.y0) * scale}px`; element.style.fontWeight = style.bold ? '700' : '400'; element.style.fontStyle = style.italic ? 'italic' : 'normal'; element.style.color = style.color || (block.bg === 'white' ? '#0b0b0b' : '#fff'); element.style.caretColor = element.style.color; element.style.textDecoration = style.underline ? 'underline' : '';
}
function updateRichBlock(block, element) {
  block.tr = element.innerText.replace(/\u00a0/g, ' '); block.richHtml = sanitizeHtml(element.innerHTML);
  const fields = state.richFields.get(String(block.id)) || []; fields.forEach((other) => { if (other !== element) { other.innerHTML = block.richHtml || plainToHtml(block.tr); } });
  scheduleEditorCanvasDraw(); scheduleSave();
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
    scheduleEditorCanvasDraw(); scheduleSave();
  });
  element.addEventListener('paste', (event) => { event.preventDefault(); document.execCommand('insertText', false, event.clipboardData.getData('text/plain')); });
}
function runRichCommand(command, value = null) {
  const element = state.richEditor; if (!element) return;
  element.focus(); if (state.richRange && element.contains(state.richRange.startContainer)) { const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(state.richRange); }
  document.execCommand('styleWithCSS', false, true); document.execCommand(command, false, value); element.dispatchEvent(new Event('input')); rememberRichSelection(element);
}
function editorSelectedKeys() {
  const item = editorItem(); const valid = new Set((item?.blocks || []).map((block) => String(block.id)));
  return (state.selectedBlockIds || []).map(String).filter((key) => valid.has(key));
}
function selectedEditorBlocks() {
  const item = editorItem(); if (!item) return [];
  const byId = new Map((item.blocks || []).map((block) => [String(block.id), block]));
  return editorSelectedKeys().map((key) => byId.get(key)).filter(Boolean);
}
function updateEditorSelection() {
  const selected = new Set(editorSelectedKeys()); state.selectedBlockIds = [...selected];
  if (!selected.has(String(state.activeBlockId))) state.activeBlockId = [...selected].at(-1) || null;
  document.querySelectorAll('#editorBoxes .editor-box').forEach((box) => {
    box.classList.toggle('selected', selected.has(box.dataset.id)); box.classList.toggle('active', box.dataset.id === String(state.activeBlockId));
  });
  document.querySelectorAll('#blockList .block-card').forEach((card) => {
    card.classList.toggle('selected', selected.has(card.dataset.id)); card.classList.toggle('active', card.dataset.id === String(state.activeBlockId));
  });
  if ($('editorSelectionStatus')) $('editorSelectionStatus').textContent = selected.size ? `${selected.size.toLocaleString('fa-IR')} متن انتخاب شده · مرجع: متن ${state.selectedBlockIds[0]}` : 'متنی انتخاب نشده';
}
function selectEditorBlock(blockId, scroll = true, additive = false) {
  const key = String(blockId); const selected = new Set(editorSelectedKeys());
  if (additive) { if (selected.has(key)) selected.delete(key); else selected.add(key); }
  else { selected.clear(); selected.add(key); }
  state.selectedBlockIds = [...selected]; state.activeBlockId = selected.has(key) ? key : [...selected].at(-1) || null;
  updateEditorSelection();
  const selectedCard = [...document.querySelectorAll('#blockList .block-card')].find((card) => card.dataset.id === String(state.activeBlockId));
  // Do not focus the sidebar field: the user can keep typing exactly where they clicked on the image.
  if (scroll && selectedCard) selectedCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function selectAllEditorBlocks() {
  const item = editorItem(); if (!item) return;
  state.selectedBlockIds = (item.blocks || []).map((block) => String(block.id));
  if (!state.selectedBlockIds.includes(String(state.activeBlockId))) state.activeBlockId = state.selectedBlockIds.at(-1) || null;
  updateEditorSelection();
}
function clearEditorSelection() { state.selectedBlockIds = []; state.activeBlockId = null; updateEditorSelection(); }
function sameSizeSelectedBoxes() {
  const item = editorItem(); const blocks = selectedEditorBlocks();
  if (!item || blocks.length < 2) { toast('اول یک کادر مرجع و سپس حداقل یک کادر دیگر را انتخاب کنید', true); return; }
  const [reference, ...targets] = blocks; const referenceBox = boxOf(reference);
  const width = referenceBox.x1 - referenceBox.x0, height = referenceBox.y1 - referenceBox.y0;
  targets.forEach((block) => {
    const box = boxOf(block); const centerX = (box.x0 + box.x1) / 2, centerY = (box.y0 + box.y1) / 2;
    const x0 = Math.max(0, Math.min(item.width - width, centerX - width / 2));
    const y0 = Math.max(0, Math.min(item.height - height, centerY - height / 2));
    block.tx0 = x0; block.tx1 = x0 + width; block.ty0 = y0; block.ty1 = y0 + height;
  });
  drawEditor(); scheduleSave();
}
function alignSelectedBoxes(direction) {
  const item = editorItem(); const blocks = selectedEditorBlocks();
  if (!item || blocks.length < 2) { toast('برای تراز گروهی حداقل دو متن را انتخاب کنید', true); return; }
  const entries = blocks.map((block) => { const box = boxOf(block); return { block, box, width: box.x1 - box.x0, height: box.y1 - box.y0 }; });
  const W = item.width, H = item.height;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  let reference;
  if (direction === 'left') reference = clamp(Math.min(...entries.map((entry) => entry.box.x0)), 0, Math.min(...entries.map((entry) => W - entry.width)));
  if (direction === 'right') reference = clamp(Math.max(...entries.map((entry) => entry.box.x1)), Math.max(...entries.map((entry) => entry.width)), W);
  if (direction === 'center') reference = clamp((Math.min(...entries.map((entry) => entry.box.x0)) + Math.max(...entries.map((entry) => entry.box.x1))) / 2, Math.max(...entries.map((entry) => entry.width / 2)), Math.min(...entries.map((entry) => W - entry.width / 2)));
  if (direction === 'top') reference = clamp(Math.min(...entries.map((entry) => entry.box.y0)), 0, Math.min(...entries.map((entry) => H - entry.height)));
  if (direction === 'bottom') reference = clamp(Math.max(...entries.map((entry) => entry.box.y1)), Math.max(...entries.map((entry) => entry.height)), H);
  if (direction === 'middle') reference = clamp((Math.min(...entries.map((entry) => entry.box.y0)) + Math.max(...entries.map((entry) => entry.box.y1))) / 2, Math.max(...entries.map((entry) => entry.height / 2)), Math.min(...entries.map((entry) => H - entry.height / 2)));
  entries.forEach(({ block, box, width, height }) => {
    let x0 = box.x0, y0 = box.y0;
    if (direction === 'left') x0 = reference;
    if (direction === 'right') x0 = reference - width;
    if (direction === 'center') x0 = reference - width / 2;
    if (direction === 'top') y0 = reference;
    if (direction === 'bottom') y0 = reference - height;
    if (direction === 'middle') y0 = reference - height / 2;
    block.tx0 = x0; block.tx1 = x0 + width; block.ty0 = y0; block.ty1 = y0 + height;
  });
  drawEditor(); scheduleSave();
}
function setBlockVisibility(block, visible) {
  block.enabled = !!visible;
  const card = [...document.querySelectorAll('#blockList .block-card')].find((entry) => entry.dataset.id === String(block.id));
  card?.classList.toggle('disabled', !block.enabled);
  const toggle = card?.querySelector('[data-visibility]'); if (toggle) toggle.checked = block.enabled;
  renderEditorBoxes(); scheduleEditorCanvasDraw(); scheduleSave();
}
function setBlockTextMode(block, mode) {
  block.textMode = normalizeBlockTextMode(mode);
  const card = [...document.querySelectorAll('#blockList .block-card')].find((entry) => entry.dataset.id === String(block.id));
  const selector = card?.querySelector('[data-text-mode]'); if (selector) selector.value = block.textMode;
  renderEditorBoxes(); scheduleEditorCanvasDraw(); scheduleSave();
}
function renderEditorBoxes() {
  const item = editorItem(); const layer = $('editorBoxes'); if (!item || !layer) return; layer.textContent = '';
  const mode = currentOverlayMode(); const selected = new Set(editorSelectedKeys());
  (item.blocks || []).forEach((block) => {
    const display = overlayBlock(block, mode); const displayMode = blockOverlayMode(block, mode);
    if (!display.enabled || !display.tr?.trim()) return; const box = boxOf(display); const scale = state.editorScale; const el = document.createElement('div'); el.className = `editor-box${selected.has(String(block.id)) ? ' selected' : ''}${String(state.activeBlockId) === String(block.id) ? ' active' : ''}`; el.dataset.id = block.id;
    el.style.left = `${box.x0 * scale}px`; el.style.top = `${box.y0 * scale}px`; el.style.width = `${(box.x1 - box.x0) * scale}px`; el.style.height = `${(box.y1 - box.y0) * scale}px`;
    const move = document.createElement('button'); move.type = 'button'; move.className = 'box-move'; move.textContent = `⠿ متن ${block.id}`; move.dataset.move = '1'; move.title = 'برای جابه‌جایی کادر بکشید'; move.setAttribute('aria-label', `جابه‌جایی کادر متن ${block.id}`);
    const visibility = document.createElement('button'); visibility.type = 'button'; visibility.className = 'box-visibility'; visibility.textContent = '👁'; visibility.title = 'پنهان‌کردن فقط همین خط روی تصویر'; visibility.setAttribute('aria-label', `پنهان‌کردن متن ${block.id} روی تصویر`); visibility.addEventListener('pointerdown', (event) => event.stopPropagation()); visibility.addEventListener('click', (event) => { event.stopPropagation(); setBlockVisibility(block, false); });
    const language = document.createElement('button'); language.type = 'button'; language.className = 'box-language'; language.dataset.language = displayMode; language.textContent = displayMode === 'ocr' ? 'EN' : 'فا'; language.title = displayMode === 'ocr' ? 'این متن انگلیسی/OCR است؛ برای نمایش فارسی کلیک کنید' : 'این متن فارسی/ترجمه است؛ برای نمایش انگلیسی کلیک کنید'; language.setAttribute('aria-label', `تغییر زبان متن ${block.id} روی تصویر`); language.addEventListener('pointerdown', (event) => event.stopPropagation()); language.addEventListener('click', (event) => { event.stopPropagation(); setBlockTextMode(block, displayMode === 'ocr' ? 'translation' : 'ocr'); });
    const text = document.createElement('div'); text.className = 'editor-box-text'; text.contentEditable = 'true'; text.innerHTML = display.richHtml || plainToHtml(display.tr); styleRichElement(text, display, scale);
    if (displayMode === 'ocr') wireOcrElement(text, block); else wireRichElement(text, block);
    el.append(move, visibility, language, text); ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach((dir) => { const handle = document.createElement('i'); handle.className = `resize-handle ${dir}`; handle.dataset.dir = dir; el.appendChild(handle); });
    el.addEventListener('pointerdown', (event) => {
      const additive = event.ctrlKey || event.metaKey; const dragTarget = event.target.closest('[data-move],[data-dir]') || event.target === el;
      if (!(dragTarget && !additive && editorSelectedKeys().includes(String(block.id)))) selectEditorBlock(block.id, true, additive);
      startBoxDrag(event, block, el);
    }); layer.appendChild(el);
  });
  updateEditorSelection();
}
function startBoxDrag(event, block, el) {
  if (event.button !== 0) return;
  const resize = event.target.closest('[data-dir]'); const moveHandle = event.target.closest('[data-move]');
  // Text remains editable: dragging starts on the visible handle or the box border, not inside the text itself.
  if (!resize && !moveHandle && event.target !== el) return;
  const item = editorItem(); if (!item) return;
  event.preventDefault(); event.stopPropagation();
  const direction = resize?.dataset.dir || 'move'; const start = boxOf(block); const origin = { x: event.clientX, y: event.clientY }; const scale = state.editorScale || 1;
  const selected = selectedEditorBlocks();
  const movingBlocks = direction === 'move' && selected.includes(block) ? selected : [block];
  const movingStarts = movingBlocks.map((movingBlock) => ({ block: movingBlock, start: boxOf(movingBlock) }));
  let changed = false; let finished = false;
  el.setPointerCapture(event.pointerId); el.classList.add('dragging');
  const move = (ev) => {
    const dx = (ev.clientX - origin.x) / scale; const dy = (ev.clientY - origin.y) / scale;
    if (direction === 'move') {
      const minDx = Math.max(...movingStarts.map((entry) => -entry.start.x0));
      const maxDx = Math.min(...movingStarts.map((entry) => item.width - entry.start.x1));
      const minDy = Math.max(...movingStarts.map((entry) => -entry.start.y0));
      const maxDy = Math.min(...movingStarts.map((entry) => item.height - entry.start.y1));
      const groupDx = Math.max(minDx, Math.min(maxDx, dx)); const groupDy = Math.max(minDy, Math.min(maxDy, dy));
      movingStarts.forEach((entry) => {
        const moving = entry.block; const initial = entry.start; const width = initial.x1 - initial.x0; const height = initial.y1 - initial.y0;
        moving.tx0 = initial.x0 + groupDx; moving.tx1 = moving.tx0 + width; moving.ty0 = initial.y0 + groupDy; moving.ty1 = moving.ty0 + height;
        const boxEl = moving === block ? el : [...document.querySelectorAll('#editorBoxes .editor-box')].find((candidate) => candidate.dataset.id === String(moving.id));
        if (boxEl) { boxEl.style.left = `${moving.tx0 * scale}px`; boxEl.style.top = `${moving.ty0 * scale}px`; }
      });
    } else {
      let { x0, y0, x1, y1 } = start; const minW = Math.min(20, item.width); const minH = Math.min(16, item.height);
      if (direction.includes('w')) x0 = Math.max(0, Math.min(start.x1 - minW, start.x0 + dx));
      if (direction.includes('e')) x1 = Math.min(item.width, Math.max(start.x0 + minW, start.x1 + dx));
      if (direction.includes('n')) y0 = Math.max(0, Math.min(start.y1 - minH, start.y0 + dy));
      if (direction.includes('s')) y1 = Math.min(item.height, Math.max(start.y0 + minH, start.y1 + dy));
      block.tx0 = x0; block.tx1 = x1; block.ty0 = y0; block.ty1 = y1;
    }
    el.style.left = `${block.tx0 * scale}px`; el.style.top = `${block.ty0 * scale}px`; el.style.width = `${(block.tx1 - block.tx0) * scale}px`; el.style.height = `${(block.ty1 - block.ty0) * scale}px`;
    scheduleEditorCanvasDraw(); changed = true;
  };
  const stop = () => {
    if (finished) return; finished = true;
    el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', stop); el.removeEventListener('pointercancel', stop); el.removeEventListener('lostpointercapture', stop);
    el.classList.remove('dragging'); if (el.hasPointerCapture?.(event.pointerId)) el.releasePointerCapture(event.pointerId);
    if (changed) { drawEditor(); scheduleSave(); }
  };
  el.addEventListener('pointermove', move); el.addEventListener('pointerup', stop); el.addEventListener('pointercancel', stop); el.addEventListener('lostpointercapture', stop);
}
async function retranslateBlock(block, source, translation) {
  const text = source.value;
  const provider = state.ai?.provider || 'free';
  const sourceLanguage = $('ocrLanguage').value;
  try {
    const preview = await api('/api/translate-text/preview', jsonOptions('POST', { text, source_language: sourceLanguage, provider }));
    showTranslationRequestPreview(preview, async () => {
      const result = await api('/api/translate-text', jsonOptions('POST', { text, source_language: sourceLanguage, provider, confirmation: preview.signature }));
      block.text = text; block.tr = result.text; block.richHtml = plainToHtml(result.text);
      translation.innerHTML = block.richHtml; drawEditor(); scheduleSave();
    });
  } catch (error) { toast(`ساخت پیش‌نمایش ترجمه ممکن نبود: ${error.message || error}`, true); }
}
function buildBlockList() {
  const item = editorItem(); const list = $('blockList'); list.textContent = ''; state.richFields = new Map(); const selected = new Set(editorSelectedKeys()); if (!item.blocks?.length) { list.textContent = 'ابتدا OCR را روی این تصویر اجرا کنید.'; updateEditorSelection(); return; }
  item.blocks.forEach((block) => {
    const card = document.createElement('section'); card.className = `block-card${block.enabled ? '' : ' disabled'}${selected.has(String(block.id)) ? ' selected' : ''}${String(state.activeBlockId) === String(block.id) ? ' active' : ''}`; card.dataset.id = block.id; card.addEventListener('pointerdown', (event) => selectEditorBlock(block.id, false, event.ctrlKey || event.metaKey));
    const head = document.createElement('div'); head.className = 'block-head'; const enabledLabel = document.createElement('label'); const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = !!block.enabled; enabled.dataset.visibility = 'sidebar'; enabled.setAttribute('aria-label', `نمایش متن ${block.id} روی تصویر`); enabledLabel.append(enabled, document.createTextNode(` نمایش متن ${block.id} روی تصویر · اطمینان ${Math.round(block.conf || 0)}٪`)); head.appendChild(enabledLabel);
    const bg = document.createElement('select'); [['auto', 'پس‌زمینه خودکار'], ['white', 'سفید'], ['black', 'مشکی'], ['none', 'بدون پاک‌کردن']].forEach(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; bg.appendChild(option); }); bg.value = block.bg || 'auto'; head.appendChild(bg);
    const languageRow = document.createElement('div'); languageRow.className = 'block-tools block-language-tools';
    const languageLabel = document.createElement('label'); languageLabel.className = 'block-language-label'; languageLabel.appendChild(document.createTextNode('نمایش همین متن:'));
    const language = document.createElement('select'); language.dataset.textMode = 'sidebar'; language.setAttribute('aria-label', `زبان نمایش متن ${block.id} روی تصویر`); [['translation', 'فارسی / ترجمه'], ['ocr', 'انگلیسی / OCR']].forEach(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; language.appendChild(option); }); language.value = blockTextMode(block); languageLabel.appendChild(language); languageRow.appendChild(languageLabel);
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
    actions.append(makeButton('کپی متن اصلی', async () => { if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(source.value); else { source.focus(); source.select(); document.execCommand('copy'); } toast('کپی شد'); }), makeButton('ترجمهٔ دوباره', () => retranslateBlock(block, source, translation)), makeButton('پاک‌کردن ترجمه', () => { block.tr = ''; block.richHtml = ''; translation.innerHTML = ''; drawEditor(); scheduleSave(); }));
    enabled.addEventListener('change', () => setBlockVisibility(block, enabled.checked)); language.addEventListener('change', () => setBlockTextMode(block, language.value)); bg.addEventListener('change', () => { block.bg = bg.value; scheduleSave(); }); source.addEventListener('input', () => { block.text = source.value; if (blockOverlayMode(block) === 'ocr') drawEditor(); scheduleSave(); });
    align.addEventListener('change', () => { block.align = align.value; styleRichElement(translation, block); drawEditor(); scheduleSave(); }); size.addEventListener('change', () => { const value = Number(size.value); block.size = value >= 8 ? Math.min(160, value) : null; styleRichElement(translation, block); drawEditor(); scheduleSave(); }); color.addEventListener('input', () => { block.color = color.value; styleRichElement(translation, block); drawEditor(); scheduleSave(); });
    card.append(head, languageRow, source, translation, tools, actions); list.appendChild(card);
  });
  updateEditorSelection();
}
async function applyEditor() { const item = editorItem(); if (!item) return; await overlayPreviewTask; await saveProject(); await renderAndUpload(item); renderGrid(); }
async function closeEditor() {
  if (editorCloseTask) return editorCloseTask;
  editorCloseTask = (async () => {
    await applyEditor(); closeDialog('editorDialog'); state.editorBitmap?.close?.(); state.editorBitmap = null; state.editorId = null; state.editorPan = null; state.activeBlockId = null; state.selectedBlockIds = [];
  })();
  try { await editorCloseTask; } finally { editorCloseTask = null; }
}
async function revertEditor() { const item = editorItem(); if (!item) return; item.blocks.forEach((block) => { block.enabled = false; }); await saveProject(); await renderAndUpload(item); drawEditor(); buildBlockList(); renderGrid(); toast('تصویر اصلی بازیابی شد؛ متن‌ها برای استفادهٔ بعدی باقی ماندند'); }

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
  $('newProjectBtn').addEventListener('click', async () => { if (!confirm('پروژهٔ جدید ساخته شود؟ پروژهٔ فعلی ذخیره می‌ماند.')) return; await saveProject(); await clearActivity(false); adoptProject(await api('/api/projects', jsonOptions('POST', { name: 'پروژهٔ کمیک' }))); await refreshProjectList(); });
  $('clearActivityBtn').addEventListener('click', () => clearActivity());
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
  $('translationPreviewConfirm').addEventListener('click', () => confirmTranslationRequestPreview().catch(() => {})); $('translationPreviewCancel').addEventListener('click', cancelTranslationRequestPreview); $('translationPreviewDialog').addEventListener('close', () => { translationPreviewAction = null; });
  $('modelsBtn').addEventListener('click', () => { renderModels(); showDialog('modelsDialog'); $('menu').classList.add('hidden'); }); $('testLanguage').addEventListener('change', renderModels); $('aiBtn').addEventListener('click', () => { loadAiSettings().then(() => { showDialog('aiDialog'); $('menu').classList.add('hidden'); }).catch((error) => toast(error.message, true)); }); $('aiProvider').addEventListener('change', () => showAiProvider($('aiProvider').value)); $('aiAddProfile').addEventListener('click', () => { aiEditorProfiles.push(makeAiProfile()); renderAiProfiles(); }); $('saveAiBtn').addEventListener('click', () => saveAiSettings().catch((error) => { $('aiStatus').textContent = error.message; toast(error.message, true); }));
  $('exportBtn').addEventListener('click', () => { updateExportFields(); showDialog('exportDialog'); }); $('exportKind').addEventListener('change', updateExportFields); $('overlayMode').addEventListener('change', () => setOverlayMode($('overlayMode').value)); $('exportOverlayMode').addEventListener('change', () => setOverlayMode($('exportOverlayMode').value)); $('startExportBtn').addEventListener('click', () => runJob('در حال ساخت خروجی…', () => exportResult()).catch(() => {})); $('exportPdfBtn').addEventListener('click', () => runJob('در حال ساخت PDF…', () => exportResult('pdf')).catch(() => {})); $('exportImagesBtn').addEventListener('click', () => runJob('در حال ساخت ZIP…', () => exportResult('images')).catch(() => {})); $('exportTxtBtn').addEventListener('click', () => runJob('در حال ساخت TXT…', () => exportResult('txt')).catch(() => {}));
  $('editorSelectAll').addEventListener('click', selectAllEditorBlocks); $('editorSelectNone').addEventListener('click', clearEditorSelection);
  $('editorSameSize').addEventListener('click', sameSizeSelectedBoxes);
  [['editorAlignLeft', 'left'], ['editorAlignCenter', 'center'], ['editorAlignRight', 'right'], ['editorAlignTop', 'top'], ['editorAlignMiddle', 'middle'], ['editorAlignBottom', 'bottom']].forEach(([id, direction]) => $(id).addEventListener('click', () => alignSelectedBoxes(direction)));
  $('editorApply').addEventListener('click', () => applyEditor().catch((error) => toast(error.message, true))); $('editorClose').addEventListener('click', () => closeEditor().catch((error) => toast(error.message, true))); $('editorRevert').addEventListener('click', () => revertEditor().catch((error) => toast(error.message, true))); $('editorDialog').addEventListener('cancel', (event) => { event.preventDefault(); closeEditor().catch((error) => toast(error.message, true)); });
  $('editorZoomOut').addEventListener('click', () => setEditorZoom(state.editorScale / 1.25)); $('editorZoomIn').addEventListener('click', () => setEditorZoom(state.editorScale * 1.25)); $('editorZoomActual').addEventListener('click', () => setEditorZoom(1)); $('editorZoomFit').addEventListener('click', fitEditor);
  document.querySelector('.editor-preview').addEventListener('wheel', handleEditorWheel, { passive: false });
  $('editorStage').addEventListener('pointerdown', startEditorPan); $('editorStage').addEventListener('pointermove', moveEditorPan); $('editorStage').addEventListener('pointerup', stopEditorPan); $('editorStage').addEventListener('pointercancel', stopEditorPan); $('editorStage').addEventListener('lostpointercapture', stopEditorPan);
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
  try { const [projects, engines, ai] = await Promise.all([api('/api/projects'), api('/api/engines'), api('/api/ai-settings')]); state.engines = engines; state.ai = ai; const project = projects.length ? await api(`/api/projects/${projects[0].id}`) : await api('/api/projects', jsonOptions('POST', { name: 'پروژهٔ کمیک' })); adoptProject(project); await refreshProjectList(); await loadAiSettings(); await renderImagesText(); }
  catch (error) { toast(`راه‌اندازی ناموفق: ${error.message}`, true); }
}
init();
