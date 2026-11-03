/* global Typeset, createImageBitmap, StudioGroups, ClipboardItem */
'use strict';

const $ = (id) => document.getElementById(id);
const G = window.StudioGroups;
const GROUP_COLORS = ['#34d399', '#60a5fa', '#f472b6', '#fbbf24', '#a78bfa', '#2dd4bf', '#fb923c', '#e879f9'];
const state = {
  project: null, engines: [], ai: null, editorId: null, editorBitmap: null, editorScale: 1, editorFitScale: 1, editorPan: null, activeBlockId: null, selectedBlockIds: [],
  cropId: null, crop: null, cropPointer: null, modelBusy: null, dragId: null, dragIds: [],
  dragMode: null, groupEditId: null, groupSnapshot: null, lastSelectedId: null,
  previewId: null,
};
let saveTimer = null;
let saveTask = Promise.resolve();
let saveRevision = 0;
let projectLoadRevision = 0;
const projectLoadTasks = new Set();
let toastTimer = null;
let outlineFrame = null;
let activityAfter = 0;
let activityEntries = [];
let activityPollTimer = null;
let activityPollInFlight = false;
let activityGeneration = 0;
let activeProgressId = null;
let sessionTimer = null;
let sessionCloseSent = false;
let heartbeatInFlight = false;
let sessionVisibilityBound = false;
let localActivityId = 0;
let editorCloseTask = null;
let editorCanvasFrame = 0;
let editorLoadSeq = 0;
let overlayMeasureCtx = null;
let sampleScratchCanvas = null;
let inlineDraft = null;
let inlineEditSession = null;
let classicEditor = null;
let imageOverview = null;
let jobBusy = false;
let translationRunning = false;
let ocrRunning = false;
let exportRunning = false;
const openDialogStack = [];
let ocrAbortController = null;
let ocrCancelledByUser = false;
let ocrClosingNormally = false;
let translationAbortController = null;
let translationCancelledByUser = false;
let translationClosingNormally = false;
let exportAbortController = null;
let exportCancelledByUser = false;
let modelAbortController = null;
let modelCancelledByUser = false;
let currentJobAbortController = null;
let activeModalState = null;
let modalQueue = Promise.resolve();
let pendingTranslationAfterOcr = null;
let translationRetryAction = null;
let translationRepairAction = null;
let translationDecisionBusy = false;
let translationPreviewAction = null;
let translationPreviewRefresh = null;
let translationPreviewData = null;
let translationPreviewTask = Promise.resolve();
let overlayPreviewTask = Promise.resolve();
let downloadUrl = null;
let backupDownloadUrl = null;
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
function setProgress(id, progress = null, active = false) {
  const fill = $(id); if (!fill) return;
  const bar = fill.closest('.bar'); if (!bar) return;
  const determinate = typeof progress === 'number' && Number.isFinite(progress);
  const percentage = determinate ? Math.round(Math.max(0, Math.min(1, progress)) * 100) : (active ? 30 : 0);
  fill.style.width = `${percentage}%`;
  bar.classList.toggle('indeterminate', active && !determinate);
  if (determinate) {
    bar.setAttribute('aria-valuenow', String(percentage));
    bar.removeAttribute('aria-valuetext');
  } else {
    bar.removeAttribute('aria-valuenow');
    if (active) bar.setAttribute('aria-valuetext', 'در حال انجام');
    else bar.removeAttribute('aria-valuetext');
  }
  const pctEl = bar.parentElement?.querySelector?.('.bar-percent');
  if (pctEl) pctEl.textContent = determinate ? `${percentage}%` : (active ? '…' : '0%');
  if (id === 'dockProgress' && $('dockProgressPercent')) {
    $('dockProgressPercent').textContent = determinate ? `${percentage}%` : (active ? '…' : '0%');
  }
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
      if ($('dockProgressStatus')) $('dockProgressStatus').textContent = latest.message;
      if (translationRunning) $('translationStatus').textContent = latest.message;
    }
    if (latest && typeof latest.progress === 'number' && Number.isFinite(latest.progress)) {
      if (jobBusy) {
        setProgress('jobProgress', latest.progress, true);
        setProgress('dockProgress', latest.progress, true);
        if ($('editorDialog')?.open) setProgress('editorProgress', latest.progress, true);
      }
      if (activeProgressId) setProgress(activeProgressId, latest.progress, true);
      if (translationRunning) setProgress('translationProgress', latest.progress, true);
      if (state.modelBusy) setProgress('modelProgress', latest.progress, true);
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
    if (!jobBusy) { $('jobStatus').textContent = 'آماده'; setProgress('jobProgress', 0, false); }
  }
  if (notify && succeeded) toast('گزارش کارها پاک شد');
}
async function heartbeat() {
  if (sessionCloseSent || heartbeatInFlight) return;
  heartbeatInFlight = true;
  try {
    await fetch('/api/session/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: TAB_ID }), cache: 'no-store' });
  } catch { /* a closed server needs no further browser-side error */ }
  finally { heartbeatInFlight = false; }
}
function startSession() {
  sessionCloseSent = false;
  heartbeat();
  if (!sessionTimer) {
    sessionTimer = setInterval(heartbeat, 15000);
    sessionTimer.unref?.();
  }
  if (!sessionVisibilityBound) {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) heartbeat(); });
    sessionVisibilityBound = true;
  }
}
function closeSession() {
  if (sessionCloseSent) return;
  sessionCloseSent = true;
  if (sessionTimer) { clearInterval(sessionTimer); sessionTimer = null; }
  if (downloadUrl) { URL.revokeObjectURL(downloadUrl); downloadUrl = null; }
  if (backupDownloadUrl) { URL.revokeObjectURL(backupDownloadUrl); backupDownloadUrl = null; }
  const body = JSON.stringify({ client_id: TAB_ID });
  try {
    if (navigator.sendBeacon?.('/api/session/close', new Blob([body], { type: 'application/json' }))) return;
  } catch { /* use the keepalive fallback below */ }
  fetch('/api/session/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
}

function localizeToastMessage(raw) {
  return String(raw || '')
    .replace(/\bFailed to fetch\b/gi, 'عدم برقراری ارتباط با سرور')
    .replace(/\bNetworkError when attempting to fetch resource\.?\b/gi, 'خطای شبکه هنگام ارتباط با سرور')
    .replace(/\bLoad failed\b/gi, 'دریافت اطلاعات از سرور ناموفق بود');
}
function toast(message, error = false) {
  const el = $('toast');
  if (!el) return;
  const text = localizeToastMessage(message);
  el.textContent = text;
  el.classList.toggle('toast-error', !!error);
  el.classList.toggle('toast-warn', !error && /متوقف|لغو/.test(text));
  el.style.borderColor = error ? 'var(--danger)' : '';
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), error ? 7000 : 3400);
}
async function api(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  let path = '';
  try { path = new URL(url, location.href).pathname; } catch { path = '(نشانی نامعتبر)'; }
  let response;
  try { response = await fetch(url, options); }
  catch (cause) {
    if (cause?.name === 'AbortError' || options.signal?.aborted) {
      const abortErr = new Error('عملیات توسط کاربر لغو شد.');
      abortErr.name = 'AbortError'; abortErr.cancelled = true;
      throw abortErr;
    }
    const error = new Error(`خطای ارتباط با برنامه (${method} ${path})؛ ${cause?.name || 'Error'}: ${cause?.message || cause}. سرور و اتصال را بررسی کنید.`);
    error.status = 0; throw error;
  }
  const type = response.headers.get('content-type') || '';
  let payload = null, parseError = '';
  if (type.includes('json')) {
    try { payload = await response.json(); } catch (cause) { parseError = `پاسخ JSON نامعتبر: ${cause?.message || cause}`; }
  } else if (!response.ok && type.includes('text/plain') && response.text) {
    try { parseError = (await response.text()).slice(0, 1000); } catch { /* status remains available */ }
  }
  if (!response.ok || parseError) {
    const raw = payload && (payload.detail || payload.message);
    const detail = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map(item => `${(item.loc || []).join('.')}: ${item.msg || item.type || 'خطای اعتبارسنجی'}`).join('؛ ') : raw ? JSON.stringify(raw) : parseError || 'سرور جزئیاتی برنگرداند.';
    const error = new Error(`${method} ${path} — HTTP ${response.status}: ${detail}`);
    error.status = response.status; error.errorId = payload?.error_id;
    if (payload?.kind === 'invalid_context_response') { error.responseText = payload.response_text; error.recoveryToken = payload.recovery_token; error.responseTruncated = payload.response_truncated; }
    if (payload?.kind === 'pending_result') { error.pendingId = payload.pending_id; error.pendingKind = payload.pending_kind; }
    if (payload?.kind === 'unstored_result') error.unstoredResult = `${payload.translation || ''}\nخلاصه: ${payload.summary || ''}`;
    throw error;
  }
  return payload;
}
function jsonOptions(method, value) { return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }; }
function setMenuOpen(open) {
  const menu = $('menu');
  if (!menu) return;
  menu.classList.toggle('hidden', !open);
  $('menuBtn')?.setAttribute('aria-expanded', open ? 'true' : 'false');
}
const pendingCancelModals = new Map();
function resolveActiveModal(result) {
  if (!activeModalState) return;
  const current = activeModalState;
  activeModalState = null;
  if (current.cancelJobKind) pendingCancelModals.delete(current.cancelJobKind);
  closeDialog('appModalDialog');
  try { current.returnFocus?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
  current.resolve(Boolean(result));
}
function dismissJobCancelModal(kind) {
  if (activeModalState && (!kind || activeModalState.cancelJobKind === kind)) resolveActiveModal(false);
}
function showAppModal(options = {}) {
  const {
    title = 'تأیید عملیات',
    message = '',
    hint = '',
    confirmText = 'تأیید',
    cancelText = 'انصراف',
    variant = 'confirm',
    destructive = false,
    alertOnly = false,
    cancelJobKind = null,
  } = options;
  if (cancelJobKind && pendingCancelModals.has(cancelJobKind)) return pendingCancelModals.get(cancelJobKind);
  const dlg = $('appModalDialog');
  if (!dlg) return Promise.resolve(!alertOnly);
  let queued = null;
  const run = () => new Promise((resolve) => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dlg.dataset.variant = variant;
    const badgeMap = { confirm: '؟', warning: '!', danger: '!', info: 'ℹ' };
    if ($('appModalBadge')) $('appModalBadge').textContent = badgeMap[variant] || '؟';
    if ($('appModalTitle')) $('appModalTitle').textContent = title;
    if ($('appModalMessage')) $('appModalMessage').textContent = localizeToastMessage(message);
    const hintEl = $('appModalHint');
    if (hintEl) {
      hintEl.textContent = hint || '';
      hintEl.classList.toggle('hidden', !hint);
    }
    const cancelBtn = $('appModalCancel');
    const confirmBtn = $('appModalConfirm');
    if (cancelBtn) {
      cancelBtn.textContent = cancelText;
      cancelBtn.classList.toggle('hidden', !!alertOnly);
    }
    if (confirmBtn) {
      confirmBtn.textContent = confirmText;
      confirmBtn.classList.toggle('danger-solid', !!destructive);
      confirmBtn.classList.toggle('primary', !destructive);
    }
    activeModalState = { resolve, returnFocus, cancelJobKind, alertOnly, promise: queued };
    showDialog('appModalDialog');
    queueMicrotask(() => {
      const target = (destructive && !alertOnly ? cancelBtn : confirmBtn) || confirmBtn;
      try { target?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
    });
  });
  queued = modalQueue.then(run, run);
  if (cancelJobKind) {
    pendingCancelModals.set(cancelJobKind, queued);
    queued.finally(() => {
      if (pendingCancelModals.get(cancelJobKind) === queued) pendingCancelModals.delete(cancelJobKind);
    });
  }
  modalQueue = queued.then(() => {}, () => {});
  return queued;
}
function appConfirm(message, options = {}) {
  return showAppModal({
    title: options.title || 'تأیید عملیات',
    message,
    hint: options.hint || '',
    confirmText: options.confirmText || 'بله، انجام شود',
    cancelText: options.cancelText || 'انصراف',
    variant: options.variant || 'confirm',
    destructive: !!options.destructive,
    alertOnly: false,
    cancelJobKind: options.cancelJobKind || null,
  });
}
function appAlert(message, options = {}) {
  return showAppModal({
    title: options.title || 'اعلان برنامه',
    message,
    hint: options.hint || '',
    confirmText: options.confirmText || 'متوجه شدم',
    variant: options.variant || 'warning',
    destructive: false,
    alertOnly: true,
  });
}
window.appConfirm = appConfirm;
window.appAlert = appAlert;
window.alert = (msg) => { appAlert(String(msg ?? ''), { title: 'اعلان برنامه', variant: 'warning' }); };

function abortRunningOcr() {
  if (!ocrRunning) return;
  ocrCancelledByUser = true;
  clearPendingTranslationOcr();
  try { ocrAbortController?.abort(); } catch { /* ignore */ }
}
function abortRunningTranslation() {
  if (!translationRunning && !translationDecisionBusy) return;
  translationCancelledByUser = true;
  try { translationAbortController?.abort(); } catch { /* ignore */ }
}
function abortRunningExport() {
  if (!exportRunning) return;
  exportCancelledByUser = true;
  try { exportAbortController?.abort(); } catch { /* ignore */ }
}
function abortRunningModelJob() {
  if (!state.modelBusy) return;
  modelCancelledByUser = true;
  try { modelAbortController?.abort(); } catch { /* ignore */ }
}
function showDialog(id) {
  setMenuOpen(false);
  const dlg = $(id);
  if (!dlg) return;
  const idx = openDialogStack.indexOf(id);
  if (idx >= 0) openDialogStack.splice(idx, 1);
  openDialogStack.push(id);
  if (!dlg.open) dlg.showModal();
}
function closeDialog(id) {
  const idx = openDialogStack.indexOf(id);
  if (idx >= 0) openDialogStack.splice(idx, 1);
  if ($(id)?.open) $(id).close();
}
async function requestCancelOcrDialog() {
  if (!ocrRunning || ocrClosingNormally) { closeDialog('ocrDialog'); return true; }
  const ok = await appConfirm('عملیات خواندن متن (OCR) در حال اجراست. آیا مطمئن هستید که می‌خواهید این کار را متوقف و لغو کنید؟', {
    title: 'توقف عملیات در حال اجرا',
    confirmText: 'بله، متوقف شود',
    cancelText: 'خیر، ادامه دهد',
    variant: 'warning',
    destructive: true,
    cancelJobKind: 'ocr',
  });
  if (!ok) return false;
  if (ocrRunning && !ocrClosingNormally) abortRunningOcr();
  closeDialog('ocrDialog');
  return true;
}
async function requestCancelTranslationDialog() {
  if ((!translationRunning && !translationDecisionBusy) || translationClosingNormally) { closeDialog('translationDialog'); return true; }
  const ok = await appConfirm('عملیات ترجمه در حال اجراست. آیا مطمئن هستید که می‌خواهید این کار را متوقف و لغو کنید؟', {
    title: 'توقف عملیات در حال اجرا',
    hint: 'بخش‌هایی که تا این لحظه ذخیره شده‌اند در پروژه حفظ می‌شوند و ادامهٔ ارسال متوقف خواهد شد.',
    confirmText: 'بله، متوقف شود',
    cancelText: 'خیر، ادامه دهد',
    variant: 'warning',
    destructive: true,
    cancelJobKind: 'translation',
  });
  if (!ok) return false;
  if ((translationRunning || translationDecisionBusy) && !translationClosingNormally) abortRunningTranslation();
  closeDialog('translationDialog');
  return true;
}
async function requestCancelExport(dialogId = null) {
  if (!exportRunning) { if (dialogId) closeDialog(dialogId); return true; }
  const ok = await appConfirm('ساخت فایل خروجی در حال اجراست. آیا مطمئن هستید که می‌خواهید این کار را متوقف و لغو کنید؟', {
    title: 'توقف ساخت خروجی',
    confirmText: 'بله، متوقف شود',
    cancelText: 'خیر، ادامه دهد',
    variant: 'warning',
    destructive: true,
    cancelJobKind: 'export',
  });
  if (!ok) return false;
  if (exportRunning) abortRunningExport();
  if (dialogId) closeDialog(dialogId);
  return true;
}
async function requestCancelModelJob() {
  if (!state.modelBusy) { closeDialog('modelsDialog'); return true; }
  const ok = await appConfirm('عملیات آماده‌سازی یا آزمایش مدل OCR در حال اجراست. آیا مطمئن هستید که می‌خواهید این کار را متوقف و لغو کنید؟', {
    title: 'توقف عملیات مدل OCR',
    confirmText: 'بله، متوقف شود',
    cancelText: 'خیر، ادامه دهد',
    variant: 'warning',
    destructive: true,
    cancelJobKind: 'model',
  });
  if (!ok) return false;
  if (state.modelBusy) abortRunningModelJob();
  closeDialog('modelsDialog');
  return true;
}
async function requestCancelActiveJob() {
  if (ocrRunning) return requestCancelOcrDialog();
  if (translationRunning || translationDecisionBusy) return requestCancelTranslationDialog();
  if (exportRunning) return requestCancelExport($('docxExportDialog')?.open ? 'docxExportDialog' : ($('exportDialog')?.open ? 'exportDialog' : null));
  if (state.modelBusy) return requestCancelModelJob();
  if (!jobBusy) return false;
  const ok = await appConfirm('عملیات در حال اجراست. آیا مطمئن هستید که می‌خواهید این کار را متوقف و لغو کنید؟', {
    title: 'توقف عملیات در حال اجرا',
    confirmText: 'بله، متوقف شود',
    cancelText: 'خیر، ادامه دهد',
    variant: 'warning',
    destructive: true,
    cancelJobKind: 'job',
  });
  if (!ok) return false;
  try { currentJobAbortController?.abort(); } catch { /* ignore */ }
  return true;
}
function closeTopDialog() {
  if ($('appModalDialog')?.open) { resolveActiveModal(false); return true; }
  const stackedId = [...openDialogStack].reverse().find((id) => $(id)?.open);
  const dialog = stackedId ? $(stackedId) : [...document.querySelectorAll('dialog[open]')].at(-1);
  if (!dialog) {
    if (jobBusy || state.modelBusy) { requestCancelActiveJob().catch(() => {}); return true; }
    return false;
  }
  if (dialog.id === 'editorDialog') closeEditor().catch((error) => toast(error.message, true));
  else if (dialog.id === 'ocrDialog') requestCancelOcrDialog().catch(() => {});
  else if (dialog.id === 'translationDialog') requestCancelTranslationDialog().catch(() => {});
  else if (dialog.id === 'exportDialog') requestCancelExport('exportDialog').catch(() => {});
  else if (dialog.id === 'docxExportDialog') requestCancelExport('docxExportDialog').catch(() => {});
  else if (dialog.id === 'modelsDialog') requestCancelModelJob().catch(() => {});
  else if (dialog.id === 'translationPreviewDialog') cancelTranslationRequestPreview();
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
function sanitizeHtml(html) { return window.ComicSanitize.sanitize(html); }

function setBusy(message) {
  jobBusy = !!message;
  $('jobStatus').textContent = message || 'آماده';
  setProgress('jobProgress', null, !!message);
  if ($('dockProgressWrap')) {
    $('dockProgressWrap').classList.toggle('hidden', !message);
    if ($('dockProgressStatus')) $('dockProgressStatus').textContent = message || 'آماده';
    setProgress('dockProgress', null, !!message);
  }
  if ($('editorProgressWrap')) {
    const showEditorBar = !!message && !!$('editorDialog')?.open;
    $('editorProgressWrap').classList.toggle('hidden', !showEditorBar);
    setProgress('editorProgress', null, showEditorBar);
  }
  if (translationRunning) {
    $('translationStatus').textContent = message || 'آماده';
    setProgress('translationProgress', null, !!message);
  }
  document.querySelectorAll('.main-actions button, .main-actions .file-button, #dock button:not(#dockCancelJobBtn), #backupProjectBtn, #restoreProjectBtn, #restoreProjectInput, #newProjectBtn, #deleteProjectBtn, #projectSelect, #projectName').forEach((el) => { el.disabled = !!message; });
}
async function runJob(message, task, progressId = null) {
  await clearActivity(false);
  const jobController = new AbortController();
  currentJobAbortController = jobController;
  setBusy(message); activeProgressId = progressId;
  if (progressId) setProgress(progressId, null, true);
  appendLocalActivity(message); $('activityDetails').open = true;
  let completed = false;
  try { const result = await task(jobController.signal); completed = true; return result; }
  catch (error) {
    if (error?.cancelled || error?.name === 'AbortError' || jobController.signal.aborted) {
      appendLocalActivity('عملیات به درخواست شما لغو و متوقف شد.', 'warning');
      const abortErr = error?.cancelled ? error : Object.assign(new Error('عملیات به درخواست شما لغو شد.'), { name: 'AbortError', cancelled: true });
      throw abortErr;
    }
    console.error(error); appendLocalActivity(`خطا: ${error.message || error}`, 'error'); toast(error.message || error, true); throw error;
  }
  finally {
    if (currentJobAbortController === jobController) currentJobAbortController = null;
    dismissJobCancelModal('job');
    if (progressId) setProgress(progressId, completed ? 1 : 0, false);
    setProgress('dockProgress', completed ? 1 : 0, false);
    if ($('editorDialog')?.open) setProgress('editorProgress', completed ? 1 : 0, false);
    activeProgressId = null; setBusy('');
    setProgress('jobProgress', completed ? 1 : 0, false);
  }
}
function scheduleSave() {
  clearTimeout(saveTimer); ++saveRevision; $('saveState').textContent = 'در حال ذخیره…';
  saveTimer = setTimeout(() => saveProject().catch((error) => toast(error.message, true)), 350);
}
async function saveProject() {
  clearTimeout(saveTimer);
  if (!state.project) return;
  const project = state.project;
  G.normalizeLayout(project.images);
  const revision = ++saveRevision;
  // Capture the state now, but serialize requests so a slow older save cannot overwrite a newer one.
  const options = jsonOptions('PUT', { state: project });
  const task = saveTask.catch(() => {}).then(async () => {
    const result = await api(`/api/projects/${project.id}/state`, options);
    // Keep the live object identity: cards and editor fields must never point at a detached snapshot.
    if (state.project === project) {
      project.updatedAt = result.updatedAt || project.updatedAt;
      if (revision === saveRevision) $('saveState').textContent = 'ذخیره شد';
    }
    refreshProjectList().catch(() => {});
  });
  saveTask = task;
  return task;
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
  $('ocrGroupLines').checked = settings.groupOcrLines !== false;
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
  if (inlineDraft && normalizeOverlayMode(mode) !== currentOverlayMode() && !closeInlineEditor()) {
    $('overlayMode').value = currentOverlayMode(); $('exportOverlayMode').value = currentOverlayMode(); return overlayPreviewTask;
  }
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
  return { ...block, tr: block.text || '', richHtml: '', dir: 'ltr', align: ['center', 'justify'].includes(block.align) ? block.align : 'left', _plainText: true };
}
function overlayBlocks(item, mode = currentOverlayMode()) { return (item.blocks || []).map((block) => overlayBlock(block, mode)); }
function hasRenderableText(block) { return !!block.tr?.trim() || !!(!block._plainText && block.richHtml && Typeset.richHtmlWords(block.richHtml).some((word) => String(word.t || '').trim())); }
function hasOverlayText(item, mode = currentOverlayMode()) { return overlayBlocks(item, mode).some((block) => block.enabled && hasRenderableText(block)); }
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
async function deleteImages(ids) {
  if (!ids.length) return;
  const ok = await appConfirm(`آیا مطمئن هستید که می‌خواهید ${ids.length} تصویر انتخاب‌شده را از پروژه حذف کنید؟`, {
    title: 'حذف تصاویر',
    confirmText: 'بله، حذف شود',
    cancelText: 'انصراف',
    variant: 'danger',
    destructive: true,
  });
  if (!ok) return;
  await saveProject();
  adoptProject(await api(`/api/projects/${state.project.id}/delete`, jsonOptions('POST', ids)));
}
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
async function loadProject(id) {
  const revision = ++projectLoadRevision;
  const previous = state.project;
  // Flush edits before switching. If another edit arrives while saving/loading, flush it too.
  while (state.project === previous && revision === projectLoadRevision) {
    const saving = saveProject();
    const savedRevision = saveRevision;
    await saving;
    if (state.project !== previous || revision !== projectLoadRevision) return;
    const project = await api(`/api/projects/${id}`);
    if (state.project !== previous || revision !== projectLoadRevision) return;
    if (savedRevision !== saveRevision) continue;
    adoptProject(project); await refreshProjectList(); await renderImagesText();
    return;
  }
}
function requestProjectLoad(id) {
  const task = loadProject(id);
  projectLoadTasks.add(task);
  task.finally(() => projectLoadTasks.delete(task)).catch(() => {});
  return task;
}
async function waitForProjectLoads() {
  while (projectLoadTasks.size) await Promise.all([...projectLoadTasks]);
}
function collectOutputSettings() {
  if (!state.project) return; state.project.settings = state.project.settings || {};
  state.project.settings.output = { name: $('exportName').value, seamless: $('exportSeamless').checked, uniformSize: $('exportUniform').checked, twoPerPage: $('exportTwo').checked, imageFormat: $('exportFormat').value, folderName: $('exportFolder').value };
}
function collectOcrSettings() {
  state.project.settings = state.project.settings || {};
  Object.assign(state.project.settings, { ocrEngine: $('ocrEngine').value, ocrLanguage: $('ocrLanguage').value, contrast: $('ocrContrast').checked, precise: $('ocrPrecise').checked, groupOcrLines: $('ocrGroupLines').checked, eraseOriginal: $('ocrErase').checked });
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
function projectBrowserDrafts(project) {
  const prefix = `comic-studio-draft:${encodeURIComponent(project.id)}:`;
  const valid = new Set(project.images.flatMap((image) => (image.blocks || []).filter((block) => block.id !== undefined).map((block) => `${image.id}\0${String(block.id)}`)));
  const drafts = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index); if (!key?.startsWith(prefix)) continue;
      const parts = key.slice(prefix.length).split(':'); if (parts.length !== 3) continue;
      const [imageId, blockId] = parts.slice(0, 2).map(decodeURIComponent); const mode = parts[2];
      if (!valid.has(`${imageId}\0${blockId}`) || !['ocr', 'translation'].includes(mode)) continue;
      const value = JSON.parse(localStorage.getItem(key));
      if (!value || typeof value.html !== 'string') throw new Error('پیش‌نویس مرورگر نامعتبر است');
      drafts.push({ imageId, blockId, mode, value });
    }
  } catch { throw new Error('خواندن پیش‌نویس‌های این مرورگر ممکن نبود؛ بک‌آپ ناقص ساخته نشد.'); }
  return drafts;
}
async function backupCurrentProject() {
  if (!state.project) return;
  await runJob('در حال ساخت بک‌آپ پروژه…', async (signal) => {
    await overlayPreviewTask;
    const project = state.project; let revision;
    do { const saving = saveProject(); revision = saveRevision; await saving; } while (state.project === project && revision !== saveRevision);
    if (state.project !== project) throw new Error('پروژه تغییر کرد؛ دوباره بک‌آپ بگیرید.');
    const drafts = projectBrowserDrafts(project);
    const response = await fetch(`/api/projects/${project.id}/backup`, { ...jsonOptions('POST', { drafts, expected_updated_at: project.updatedAt }), signal });
    if (!response.ok) { const payload = await response.json().catch(() => null); throw new Error(payload?.detail || `ساخت بک‌آپ ممکن نشد (HTTP ${response.status})`); }
    const blob = await response.blob(); if (!blob.size) throw new Error('فایل بک‌آپ خالی است');
    if (state.project !== project || revision !== saveRevision) throw new Error('پروژه هنگام ساخت بک‌آپ تغییر کرد؛ برای ثبت آخرین تغییرها دوباره بک‌آپ بگیرید.');
    if (backupDownloadUrl) URL.revokeObjectURL(backupDownloadUrl);
    backupDownloadUrl = URL.createObjectURL(blob);
    const link = $('backupDownloadLink'); link.href = backupDownloadUrl;
    link.download = `${safeName(project.name) || 'comic-studio'}-backup.zip`; link.textContent = 'دانلود دوبارهٔ بک‌آپ'; link.classList.remove('hidden'); link.click();
    toast('بک‌آپ پروژه آماده شد؛ کلیدهای API داخل آن نیستند.');
  });
}
async function restoreProjectBackup(file) {
  if (!file) return;
  const ok = await appConfirm('بک‌آپ به‌صورت یک پروژهٔ جدید بازیابی شود؟ پروژه‌های فعلی شما حذف یا جایگزین نمی‌شوند.', {
    title: 'بازیابی بک‌آپ پروژه',
    confirmText: 'بله، بازیابی شود',
    cancelText: 'انصراف',
    variant: 'confirm',
  });
  if (!ok) return;
  await runJob('در حال بازیابی بک‌آپ…', async (signal) => {
    await saveProject(); const previous = state.project;
    const form = new FormData(); form.append('file', file);
    const result = await api('/api/projects/restore', { method: 'POST', body: form, signal });
    let failedDrafts = 0;
    for (const draft of result.drafts || []) {
      const key = `comic-studio-draft:${encodeURIComponent(result.project.id)}:${encodeURIComponent(draft.imageId)}:${encodeURIComponent(draft.blockId)}:${draft.mode}`;
      try { localStorage.setItem(key, JSON.stringify(draft.value)); } catch { failedDrafts += 1; }
    }
    // Flush any edits made while the upload ran; never overwrite another opened project.
    let opened = false;
    while (state.project === previous) {
      const saving = saveProject(); const revision = saveRevision; await saving;
      if (state.project === previous && revision === saveRevision) { adoptProject(result.project); opened = true; break; }
    }
    await refreshProjectList(); setMenuOpen(false);
    if (failedDrafts) toast(`پروژه بازیابی شد، ولی ${failedDrafts} پیش‌نویس در حافظهٔ مرورگر ذخیره نشد؛ فایل ZIP را نگه دارید.`, true);
    else toast(opened ? 'بک‌آپ به‌صورت پروژهٔ جدید بازیابی شد.' : 'بک‌آپ بازیابی شد؛ پروژهٔ جدید را از فهرست پروژه‌ها باز کنید.');
  });
}
async function importFiles(files) {
  if (!files.length) return;
  await runJob('در حال خواندن فایل‌ها…', async (signal) => { await saveProject(); const form = new FormData(); [...files].forEach((file) => form.append('files', file)); const result = await api(`/api/projects/${state.project.id}/files`, { method: 'POST', body: form, signal }); adoptProject(result); toast(`${files.length} فایل وارد شد`); });
}
let pendingReview = null;
async function openPendingResults(token = null) {
  if (!state.project) return;
  const projectId = state.project.id; pendingReview = null;
  $('pendingList').textContent = ''; $('pendingDetail').textContent = ''; $('pendingDetail').classList.add('hidden');
  $('pendingStatus').textContent = ''; for (const id of ['pendingCopy','pendingDiscard','pendingApply']) $(id).classList.add('hidden');
  showDialog('pendingDialog');
  try {
    if (!token) {
      const items = await api(`/api/projects/${projectId}/pending`);
      if (state.project?.id !== projectId || !$('pendingDialog').open) return;
      if (!items.length) { $('pendingList').textContent = 'نتیجهٔ منتظری وجود ندارد.'; return; }
      items.forEach(item => { const button = document.createElement('button'); button.className = 'bt'; button.type = 'button'; button.textContent = `${item.kind === 'ocr' ? 'OCR' : 'ترجمه'} · ${item.createdAt}`; button.addEventListener('click', () => openPendingResults(item.id)); $('pendingList').append(button); });
      return;
    }
    const view = await api(`/api/projects/${projectId}/pending/${token}`);
    if (state.project?.id !== projectId || !$('pendingDialog').open) return;
    pendingReview = {projectId, view}; $('pendingDetail').classList.remove('hidden');
    const heading = document.createElement('p'); heading.textContent = view.canApply ? 'برای موارد دارای تعارض، انتخاب خود را مشخص کنید؛ سایر موارد به‌طور خودکار حفظ و ثبت می‌شوند.' : 'نوبت ترجمه تغییر کرده است؛ نتیجه قابل اعمال خودکار نیست. می‌توانید آن را کپی کنید.'; $('pendingDetail').append(heading);
    view.rows.forEach((row, index) => {
      const box = document.createElement('section'); box.className = 'block-card';
      const title = document.createElement('strong'); title.textContent = `${index + 1}. ${row.name || 'تصویر'} — ${row.missing ? 'حذف‌شده' : row.conflict ? 'تعارض' : 'بدون تعارض'}`; box.append(title);
      for (const [label, value] of [['متن مبدأ ارسال‌شده', row.source], ['متن مبدأ فعلی', row.currentSource], ['متن قبلی', row.original], ['متن فعلی', row.current], ['نتیجهٔ آماده', row.result]]) {
        if (value == null) continue; const heading = document.createElement('p'); heading.textContent = label; const pre = document.createElement('pre'); pre.className = 'diagnostic-message'; pre.dir = 'auto'; pre.textContent = value || '—'; box.append(heading, pre);
      }
      if (row.conflict && !row.missing && view.canApply) {
        const label = document.createElement('label'); label.textContent = 'انتخاب شما';
        const select = document.createElement('select'); select.dataset.pendingKey = row.key;
        for (const [value, text] of [['keep','حفظ ویرایش فعلی'],['apply','استفاده از نتیجهٔ آماده']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option); }
        label.append(select); box.append(label);
      }
      $('pendingDetail').append(box);
    });
    if (view.summary) { const p = document.createElement('p'); p.className = 'diagnostic-message'; p.textContent = `خلاصهٔ آماده: ${view.summary}`; $('pendingDetail').append(p); }
    $('pendingCopy').classList.remove('hidden'); $('pendingDiscard').classList.remove('hidden'); $('pendingApply').classList.toggle('hidden', !view.canApply);
  } catch (error) { $('pendingStatus').textContent = error.message || String(error); }
}
async function applyPendingResult() {
  const review = pendingReview; if (!review || state.project?.id !== review.projectId) return;
  const choices = Object.fromEntries([...$('pendingDetail').querySelectorAll('[data-pending-key]')].map(el => [el.dataset.pendingKey, el.value]));
  review.view.rows.filter(row => row.missing).forEach(row => { choices[row.key] = 'keep'; });
  $('pendingApply').disabled = true; $('pendingDiscard').disabled = true;
  let committed = false;
  try {
    const result = await api(`/api/projects/${review.projectId}/pending/${review.view.id}/resolve`, jsonOptions('POST', {revision:review.view.revision, choices}));
    committed = true;
    if (state.project?.id !== review.projectId) throw new Error('نتیجه ثبت شد اما پروژهٔ باز تغییر کرد؛ برای دیدن نتیجه پروژه را دوباره باز کنید.');
    const afterOcr = result.kind === 'ocr' ? pendingTranslationAfterOcr : null;
    adoptProject(result.project); setOverlayMode(result.kind === 'ocr' ? 'ocr' : 'translation', false);
    let previewError = null;
    try { if (result.affectedImageIds?.length) await renderImagesText(result.affectedImageIds); } catch (error) { previewError = error; }
    closeDialog('pendingDialog'); closeDialog('translationDialog'); closeDialog('ocrDialog'); clearPendingTranslationOcr();
    toast(previewError ? `نتیجه ثبت شد اما پیش‌نمایش خطا داشت: ${previewError.message || previewError}` : result.done ? 'نتیجهٔ ذخیره‌شده اعمال شد.' : 'نتیجه ثبت شد؛ برای ادامهٔ ترجمه پیش‌نمایش تازه را بررسی کنید.', !!previewError);
    if (afterOcr && state.project?.id === afterOcr.projectId && JSON.stringify(selectedImages().map(item => item.id)) === JSON.stringify(afterOcr.imageIds) && !selectedImages().some(item => !item.ocrCompleted && !(item.blocks || []).length)) await runTranslation();
  } catch (error) { const message = committed ? `نتیجه ثبت شد؛ ${error.message || error}` : `${error.message || error}؛ نتیجه همچنان نگهداری می‌شود.`; $('pendingStatus').textContent = message; if (committed) toast(message, true); }
  finally { $('pendingApply').disabled = false; $('pendingDiscard').disabled = false; }
}

function clearPendingTranslationOcr() {
  pendingTranslationAfterOcr = null;
  $('ocrTranslationNotice').classList.add('hidden');
  $('ocrOnlySelected').disabled = false;
}
function reportOcrError(error) {
  const message = `فرایند OCR/ترجمه متوقف شد؛ ترجمه هنوز ارسال نشده است. ${error.message || error}`;
  $('ocrStatus').textContent = message; $('copyOcrError').classList.remove('hidden');
  appendLocalActivity(message, 'error'); toast(message, true);
}
async function runOcr() {
  if (ocrRunning) return;
  const pending = pendingTranslationAfterOcr;
  const controller = new AbortController();
  ocrAbortController = controller; ocrCancelledByUser = false; ocrClosingNormally = false;
  ocrRunning = true; setProgress('ocrProgress', null, true); $('startOcrBtn').disabled = true; $('cancelOcrBtn')?.classList.remove('hidden');
  $('ocrStatus').textContent = ''; $('copyOcrError').classList.add('hidden');
  let ocrSucceeded = false;
  try {
    if (pending && (state.project?.id !== pending.projectId || JSON.stringify(selectedImages().map(item => item.id)) !== JSON.stringify(pending.imageIds))) {
      throw new Error('پروژه یا تصاویر انتخاب‌شده تغییر کردند؛ پنجره را ببندید و دوباره ترجمه را شروع کنید.');
    }
    collectOcrSettings(); await saveProject();
    if (ocrCancelledByUser || controller.signal.aborted) { const e = new Error('لغو شد'); e.cancelled = true; throw e; }
    if (pending && (state.project?.id !== pending.projectId || JSON.stringify(selectedImages().map(item => item.id)) !== JSON.stringify(pending.imageIds))) {
      throw new Error('پروژه یا تصاویر انتخاب‌شده تغییر کردند؛ پنجره را ببندید و دوباره ترجمه را شروع کنید.');
    }
    const ids = pending ? pending.missingIds : ($('ocrOnlySelected').checked ? selectedImages().map((item) => item.id) : sortedImages().map((item) => item.id));
    if (!ids.length) throw new Error('حداقل یک تصویر را انتخاب کنید.');
    if (pending && ids.some(id => {
      const item = state.project.images.find(image => image.id === id);
      return !item || item.ocrCompleted || (item.blocks || []).length;
    })) throw new Error('متن یا وضعیت یکی از تصاویر تغییر کرده است؛ برای جلوگیری از بازنویسی OCR انجام نشد.');
    await runJob('OCR محلی در حال اجراست…', async () => {
      const confidence = $('ocrConfidence').value.trim();
      const result = await api(`/api/projects/${state.project.id}/ocr`, {
        ...jsonOptions('POST', { image_ids: ids, engine: $('ocrEngine').value, language: $('ocrLanguage').value, contrast: $('ocrContrast').checked, precise: $('ocrPrecise').checked, group_lines: $('ocrGroupLines').checked, min_confidence: confidence === '' ? .35 : Number(confidence) }),
        signal: controller.signal,
      });
      if (ocrCancelledByUser || controller.signal.aborted) { const e = new Error('لغو شد'); e.cancelled = true; throw e; }
      if (pending && (state.project?.id !== pending.projectId || JSON.stringify(selectedImages().map(item => item.id)) !== JSON.stringify(pending.imageIds))) {
        throw new Error('OCR در سرور ذخیره شد، اما پروژه یا انتخاب تغییر کرد؛ ترجمه ادامه نیافت. برای دیدن نتیجه پروژه را دوباره باز کنید.');
      }
      adoptProject(result); setOverlayMode('ocr', false); await renderImagesText(ids);
    }, 'ocrProgress');
    ocrSucceeded = true; ocrClosingNormally = true;
    clearPendingTranslationOcr(); closeDialog('ocrDialog');
    toast('متن OCR روی تصویر آمد؛ برای بررسی و ویرایش، دکمهٔ ✎ را بزنید');
    if (pending) await runTranslation();
  } catch (error) {
    if (ocrCancelledByUser || error?.cancelled || error?.name === 'AbortError') {
      clearPendingTranslationOcr();
      toast('پنجرهٔ OCR بسته شد و عملیات متوقف گردید');
      return;
    }
    reportOcrError(error); if (error.pendingId) openPendingResults(error.pendingId); throw error;
  } finally {
    if (!ocrSucceeded) setProgress('ocrProgress', 0, false);
    if (ocrAbortController === controller) ocrAbortController = null;
    ocrClosingNormally = false; ocrRunning = false; $('startOcrBtn').disabled = false; $('cancelOcrBtn')?.classList.add('hidden');
    dismissJobCancelModal('ocr');
  }
}

function savedTranslationSkill(projectId) {
  try { return localStorage.getItem(`comic-studio-ai-skill:${projectId}`); } catch { return null; }
}
function rememberTranslationSkill(projectId, preview) {
  if (preview.provider === 'free') return;
  try { localStorage.setItem(`comic-studio-ai-skill:${projectId}`, preview.skill ?? ''); } catch { /* the next preview can still use the default */ }
}
function updateTranslationSkillStatus() {
  const preview = translationPreviewData;
  const skill = $('translationSkill').value.trim();
  const context = $('translationContext').value.trim();
  const skillCount = Array.from(skill).length;
  const contextCount = Array.from(context).length;
  const skillTooLong = preview?.contextMode && skillCount > preview.skillLimit;
  const contextTooLong = preview?.contextMode && contextCount > preview.contextLimit;
  const updateBudgetCounter = (inputId, counterId, count, limit, visible) => {
    const input = $(inputId); const counter = $(counterId);
    input.classList.toggle('budget-over-limit', !!visible && count > limit);
    counter.classList.toggle('over-budget', !!visible && count > limit);
    counter.classList.toggle('hidden', !visible);
    counter.textContent = visible ? `${count} / ${limit} نویسه` : '';
  };
  updateBudgetCounter('translationSkill', 'translationSkillCounter', skillCount, preview?.skillLimit ?? 0, !!preview?.contextMode);
  updateBudgetCounter('translationContext', 'translationContextCounter', contextCount, preview?.contextLimit ?? 0, !!preview?.contextMode);
  const changed = preview && ((preview.provider !== 'free' && (skill !== (preview.skill ?? '') || (preview.contextMode && context !== (preview.summary ?? '')))) || (preview.rollingMode && $('translationContextResume').checked !== !!preview.resume));
  const message = skillTooLong ? `اسکیل ذخیره‌شده بیش از سقف ${preview.skillLimit} نویسه است؛ پیش از ارسال کوتاه کنید.` :
    contextTooLong ? `خلاصه بیش از سقف ${preview.contextLimit} نویسه است؛ پیش از ارسال کوتاه کنید.` :
    changed ? 'اطلاعات تغییر کرد؛ ابتدا پیش‌نمایش تازه را بازبینی کنید.' : '';
  $('translationSkillStatus').textContent = message;
  $('translationPreviewConfirm').textContent = changed ? 'به‌روزرسانی پیش‌نمایش' : 'تأیید و ارسال برای ترجمه';
  $('translationPreviewConfirm').disabled = !preview || skillTooLong || contextTooLong || (changed ? !translationPreviewRefresh : !preview.requests?.length);
}
function showTranslationRequestPreview(preview, action, refresh = null) {
  translationPreviewAction = action; translationPreviewRefresh = refresh; translationPreviewData = preview;
  $('translationSkillWrap').classList.toggle('hidden', preview.provider === 'free');
  $('translationContextWrap').classList.toggle('hidden', !preview.rollingMode);
  $('translationContextLabel').classList.toggle('hidden', !preview.contextMode); $('translationContext').classList.toggle('hidden', !preview.contextMode); $('translationContextHelp').classList.toggle('hidden', !preview.contextMode);
  $('translationContext').value = preview.displaySummary ?? preview.summary ?? '';
  $('translationContext').maxLength = preview.contextMode ? preview.contextLimit * 2 : 200000;
  $('translationContextResume').checked = !!preview.resume; $('translationContextResume').parentElement.classList.toggle('hidden', !!preview.singleContext);
  $('translationContextHelp').textContent = preview.contextMode ? `سهم خلاصه ${preview.contextPercent ?? 15}٪ (حداکثر ${preview.contextLimit} نویسه) · سهم اسکیل ${preview.skillPercent ?? 15}٪ (حداکثر ${preview.skillLimit} نویسه) از سقف کل ${preview.totalLimit} نویسه؛ سهم استفاده‌نشده به متن می‌رسد.` : '';
  $('translationSkill').maxLength = preview.contextMode ? preview.skillLimit * 2 : 4000;
  $('translationSkill').disabled = false; $('translationSkillReset').disabled = false; $('translationContext').disabled = false; $('translationContextResume').disabled = false;
  $('translationSkill').value = preview.displaySkill ?? preview.skill ?? '';
  updateTranslationSkillStatus();
  $('translationPreviewSummary').textContent = preview.rollingMode ? `${preview.blockCount} متن · پیش‌نمایش درخواست اول${preview.contextMode ? ' (تعداد درخواست‌های بعدی وابسته به خلاصه است)' : ''}` : `${preview.blockCount} متن · ${preview.requestCount} درخواست پایه برای بررسی (بدون تکرار)`;
  const destination = [preview.providerLabel, preview.model && `مدل: ${preview.model}`, preview.base_url && `نشانی: ${preview.base_url}`, preview.fallback_url && `فقط هنگام خطا: ${preview.fallback_url}`].filter(Boolean).join(' · ');
  $('translationPreviewDestination').textContent = destination;
  $('translationPreviewNote').textContent = preview.note || ''; $('translationPreviewError').textContent = preview.previewError ? `${preview.previewError} هیچ متنی ارسال نشده است؛ سقف کل یا متن/راهنما را اصلاح و پیش‌نمایش را تازه کنید.` : ''; $('translationPreviewError').classList.toggle('hidden', !preview.previewError); $('copyTranslationPreviewError').classList.toggle('hidden', !preview.previewError); $('openAiLimitFromPreview')?.classList.toggle('hidden', !(preview.previewError && preview.provider !== 'free'));
  setProgress('previewPrepProgress', preview.previewError ? 0 : 1, false);
  const container = $('translationPreviewRequests'); container.textContent = '';
  (preview.requests || []).forEach((request, index) => {
    const details = document.createElement('details'); details.className = 'payload-request'; details.open = (preview.requests.length === 1 || index === 0);
    const summary = document.createElement('summary'); summary.textContent = `درخواست ${request.index}${request.imageName ? ` · صفحه: ${request.imageName}` : ''}${request.paragraph ? ` · بند ${request.paragraph}${request.partCount > 1 ? `، بخش ${request.part} از ${request.partCount}` : ''}` : ''} · ${request.characters} نویسه`;
    const text = document.createElement('pre'); text.dir = 'auto'; text.textContent = request.text;
    details.append(summary, text); container.appendChild(details);
  });
  const hasSystemPrompt = !!preview.systemPrompt;
  $('translationPreviewSystemWrap').classList.toggle('hidden', !hasSystemPrompt);
  $('translationPreviewSystem').textContent = preview.systemPrompt || '';
  showDialog('translationPreviewDialog');
}
function cancelTranslationRequestPreview() { translationPreviewAction = null; translationPreviewRefresh = null; translationPreviewData = null; closeDialog('translationPreviewDialog'); }
function clearResponseRepair() {
  translationRepairAction = null; $('responseRepair').classList.add('hidden'); $('responseRepairText').value = ''; $('repairTranslation').value = ''; $('repairSummary').value = ''; $('responseRepairStatus').textContent = '';
}
function offerResponseRepair(error, action) {
  if (!error.recoveryToken || typeof error.responseText !== 'string') return;
  $('responseRepairText').value = error.responseText;
  try { const parsed = JSON.parse(error.responseText); $('repairTranslation').value = typeof parsed.translation === 'string' ? parsed.translation : ''; $('repairSummary').value = typeof parsed.summary === 'string' ? parsed.summary : ''; } catch { $('repairTranslation').value = ''; $('repairSummary').value = ''; }
  $('responseRepairStatus').textContent = error.responseTruncated ? 'پاسخ بزرگ‌تر از حد مجاز بود و فقط ۲۰۰٬۰۰۰ نویسهٔ اول نمایش داده شده است.' : '';
  $('responseRepair').classList.remove('hidden');
  translationRepairAction = value => action({recovery_token: error.recoveryToken, corrected_response: value});
}
function showSingleTranslationError(error, action) {
  $('translationStatus').textContent = `ترجمه ناموفق بود: ${error.message || error}`;
  translationRetryAction = error.status === 409 ? null : async () => {
    try { await action(); closeDialog('translationDialog'); }
    catch (nextError) { showSingleTranslationError(nextError, action); throw nextError; }
  };
  $('retryTranslation').classList.toggle('hidden', !translationRetryAction);
  offerResponseRepair(error, async repair => {
    try { await action(repair); clearResponseRepair(); closeDialog('translationDialog'); }
    catch (nextError) { showSingleTranslationError(nextError, action); throw nextError; }
  });
  $('copyTranslationError').classList.remove('hidden'); $('translationErrorChoice').classList.remove('hidden'); showDialog('translationDialog');
}
async function confirmTranslationRequestPreview() {
  const action = translationPreviewAction; const preview = translationPreviewData; const refresh = translationPreviewRefresh;
  if (!action || !preview) return;
  $('translationPreviewConfirm').disabled = true;
  const changed = (preview.provider !== 'free' && ($('translationSkill').value.trim() !== (preview.skill ?? '') || (preview.contextMode && $('translationContext').value.trim() !== (preview.summary ?? '')))) || (preview.rollingMode && $('translationContextResume').checked !== !!preview.resume);
  if (changed) {
    $('translationSkill').disabled = true; $('translationSkillReset').disabled = true; $('translationContext').disabled = true; $('translationContextResume').disabled = true;
    setProgress('previewPrepProgress', null, true);
    try {
      if (!refresh) throw new Error('به‌روزرسانی پیش‌نمایش ممکن نیست؛ دوباره ترجمه را شروع کنید.');
      const updated = await refresh($('translationSkill').value.trim(), $('translationContext').value.trim(), $('translationContextResume').checked);
      // Cancel/close during the local preview request must not reopen it or send.
      if ($('translationPreviewDialog').open && translationPreviewAction === action) showTranslationRequestPreview(updated, action, refresh);
    } catch (error) {
      setProgress('previewPrepProgress', 0, false);
      if ($('translationPreviewDialog').open && translationPreviewAction === action) { $('translationSkillStatus').textContent = `به‌روزرسانی ممکن نبود: ${error.message || error}`; $('translationPreviewError').textContent = `${$('translationSkillStatus').textContent}\nپیش از ارسال گزارش، اطلاعات محرمانه را بررسی کنید.`; $('translationPreviewError').classList.remove('hidden'); $('copyTranslationPreviewError').classList.remove('hidden'); toast(error.message || 'پیش‌نمایش ناموفق بود', true); }
    } finally {
      if ($('translationPreviewDialog').open && translationPreviewAction === action) {
        $('translationSkill').disabled = false; $('translationSkillReset').disabled = false; $('translationContext').disabled = false; $('translationContextResume').disabled = false;
        const message = $('translationSkillStatus').textContent; updateTranslationSkillStatus();
        if (message.startsWith('به‌روزرسانی ممکن نبود:')) $('translationSkillStatus').textContent = message;
      }
    }
    return;
  }
  translationPreviewAction = null; translationPreviewRefresh = null; translationPreviewData = null;
  closeDialog('translationPreviewDialog');
  try { translationPreviewTask = action(preview); await translationPreviewTask; }
  catch (error) {
    if (error?.cancelled || error?.name === 'AbortError' || translationCancelledByUser) return;
    if (!$('translationDialog').open) showSingleTranslationError(error, repair => action(preview, repair));
    toast(error.message || 'ترجمه ناموفق بود', true);
  }
  finally { $('translationPreviewConfirm').disabled = false; }
}
async function runTranslation() {
  if (translationRunning) return;
  try {
    // Loading a project also uploads previews; do not race those writes against
    // the translation's optimistic version check or snapshot the old selection.
    await waitForProjectLoads();
    const selected = selectedImages(); const ids = selected.map((item) => item.id);
    if (!ids.length) throw new Error('حداقل یک تصویر را انتخاب کنید.');
    const missing = selected.filter(item => !item.ocrCompleted && !(item.blocks || []).length);
    if (missing.length) {
      const old = state.project._aiContextRun;
      if (old?.jobs?.some(job => job.remaining)) {
        const proceed = await appConfirm('نوبت ترجمهٔ ناتمام وجود دارد. اجرای OCR روی تصاویر جدید می‌تواند ادامهٔ آن را نامعتبر کند و ممکن است برای نوبت تازه تأیید و ارسال دوباره لازم شود. آیا ادامه می‌دهید؟', {
          title: 'هشدار نوبت ترجمهٔ ناتمام',
          confirmText: 'بله، ادامه بده',
          cancelText: 'انصراف',
          variant: 'warning',
        });
        if (!proceed) return;
      }
      pendingTranslationAfterOcr = {projectId: state.project.id, imageIds: ids, missingIds: missing.map(item => item.id)};
      $('ocrTranslationNotice').textContent = `${missing.length} تصویر انتخاب‌شده هنوز OCR نشده‌اند. پس از تنظیم موتور و شروع OCR، فقط همین تصاویر خوانده می‌شوند و سپس پیش‌نمایش ترجمه باز خواهد شد؛ متن‌های موجود بازنویسی نمی‌شوند.`;
      $('ocrTranslationNotice').classList.remove('hidden'); $('ocrStatus').textContent = ''; $('copyOcrError').classList.add('hidden');
      $('ocrOnlySelected').disabled = true; updateEngineOptions(); showDialog('ocrDialog'); return;
    }
    if (!selected.some(item => (item.blocks || []).some(block => block.enabled !== false && String(block.text || '').trim()))) {
      throw new Error('هیچ کادر فعال دارای متن در تصاویر انتخاب‌شده نیست. اگر OCR متنی پیدا نکرده، تنظیمات یا تصویر را بررسی و OCR را دوباره اجرا کنید.');
    }
    await saveProject();
    const provider = state.ai?.provider || 'free'; const projectId = state.project.id;
    const request = { image_ids: ids, provider, source_language: $('ocrLanguage').value, reuse_repeated: state.ai?.reuse_repeated !== false };
    if (state.project.images.some(item => ids.includes(item.id) && (item._aiPageProgress || item.blocks?.some(block => block._aiTranslationParts)))) {
      const okLegacy = await appConfirm('پیشرفت ناتمام ترجمه از نسخهٔ قبلی وجود دارد و با حافظهٔ جدید سازگار نیست. برای جلوگیری از ارسال دوباره می‌توانید در نسخهٔ قبلی ادامه دهید. آیا با حذف پیشرفت ناتمام و شروع ترجمهٔ تازه موافقید؟', {
        title: 'هشدار پیشرفت ناتمام قبلی',
        confirmText: 'بله، شروع تازه',
        cancelText: 'انصراف',
        variant: 'warning',
        destructive: true,
      });
      if (!okLegacy) return;
      request.restart_legacy = true;
    }
    const previousRun = state.project._aiContextRun;
    const confirmRestart = async (nextResume) => {
      if (!nextResume && previousRun?.jobs?.some(job => job.remaining) && !request.restart_existing) {
        const okRestart = await appConfirm('نوبت ترجمهٔ ناتمام وجود دارد. آیا با شروع نوبت تازه و جایگزینی پیشرفت ناتمام موافقید؟ ممکن است متن دوباره ارسال شود.', {
          title: 'شروع نوبت تازهٔ ترجمه',
          confirmText: 'بله، نوبت تازه شروع شود',
          cancelText: 'انصراف',
          variant: 'warning',
          destructive: true,
        });
        if (!okRestart) {
          const cancelledErr = new Error('شروع نوبت تازه لغو شد.');
          cancelledErr.cancelled = true;
          throw cancelledErr;
        }
        request.restart_existing = true;
      }
    };
    if (provider === 'free') {
      const previous = previousRun;
      const resume = !!(previous && previous.jobs?.some(job => job.remaining) && previous.provider === provider && JSON.stringify(previous.imageIds) === JSON.stringify(ids));
      const refresh = async (_skill, _summary, nextResume) => { await confirmRestart(nextResume); return api(`/api/projects/${projectId}/context-preview`, jsonOptions('POST', { ...request, skill: '', summary: '', resume: nextResume })); };
      let preview;
      try { preview = await refresh('', '', resume); }
      catch (error) {
        if (!resume || error.status !== 409) throw error;
        preview = await refresh('', '', false);
        preview.note += ' نوبت ناتمام با تنظیمات فعلی سازگار نیست؛ تأیید نوبت تازه‌ای شروع می‌کند.';
      }
      if (!preview.requests?.length) throw new Error('هیچ درخواست ترجمه‌ای ساخته نشد؛ کادرهای فعال و انتخاب تصاویر را بررسی کنید.');
      const emptyPages = selected.filter(item => !(item.blocks || []).some(block => block.enabled !== false && String(block.text || '').trim()));
      if (emptyPages.length) preview.note += ` ${emptyPages.length} تصویر بدون متن فعال از ترجمه کنار گذاشته می‌شوند.`;
      showTranslationRequestPreview(preview, accepted => performContextTranslation(request, accepted), refresh);
      return;
    }
    const profiles = state.ai?.providers?.[provider]?.profiles?.filter(p => p.hasApiKey) || [];
    const limit = profiles.length ? Math.min(...profiles.map(p => p.source_limit ?? 1000)) : 1000;
    const skillLimit = Math.floor(limit * (state.ai?.skill_percent ?? 15) / 100);
    const contextLimit = Math.floor(limit * (state.ai?.context_percent ?? 15) / 100);
    const oldSkill = savedTranslationSkill(projectId);
    const skill = oldSkill ?? 'ترجمه را روان و طبیعی و متناسب با لحن شخصیت‌ها بنویس؛ نام‌ها، اعداد و آواها را با دقت حفظ کن.';
    const previous = previousRun;
    const resume = !!(previous && previous.jobs?.some(job => job.remaining) && previous.provider === provider && JSON.stringify(previous.imageIds) === JSON.stringify(ids));
    // A new translation starts without stale story context; only an explicit
    // resume carries the previous run's rolling summary into its first request.
    const summary = resume ? (previous.context || '') : '';
    const refresh = async (nextSkill, nextSummary, nextResume) => { await confirmRestart(nextResume); return api(`/api/projects/${projectId}/context-preview`, jsonOptions('POST', { ...request, skill: nextSkill, summary: nextSummary, resume: nextResume })); };
    const safeSkill = Array.from(skill).length <= skillLimit ? skill : '';
    const safeSummary = Array.from(summary).length <= contextLimit ? summary : '';
    let preview;
    try { preview = await refresh(safeSkill, safeSummary, resume && safeSkill === skill); }
    catch (error) {
      if (!resume || error.status !== 409) throw error;
      preview = await refresh(safeSkill, safeSummary, false);
      preview.note += ' نوبت ناتمام با تنظیمات فعلی سازگار نیست؛ تأیید، نوبت تازه‌ای شروع می‌کند.';
    }
    if (!preview.requests?.length && !preview.previewError) throw new Error('هیچ درخواست ترجمه‌ای ساخته نشد؛ کادرهای فعال و انتخاب تصاویر را بررسی کنید.');
    const emptyPages = selected.filter(item => !(item.blocks || []).some(block => block.enabled !== false && String(block.text || '').trim()));
    if (emptyPages.length) preview.note += ` ${emptyPages.length} تصویر بدون متن فعال از ترجمه کنار گذاشته می‌شوند.`;
    if (safeSkill !== skill) preview.displaySkill = skill;
    if (safeSummary !== summary) preview.displaySummary = summary;
    showTranslationRequestPreview(preview, accepted => { rememberTranslationSkill(projectId, accepted); return performContextTranslation(request, accepted); }, refresh);
  } catch (error) {
    if (error?.cancelled || error?.name === 'AbortError') return;
    const message = `مرحلهٔ آماده‌سازی یا پیش‌نمایش ترجمه ناموفق بود؛ هیچ درخواست ترجمه‌ای ارسال نشد. ${error.message || error}`;
    $('translationStatus').textContent = message; appendLocalActivity(message, 'error');
    translationRetryAction = async () => { closeDialog('translationDialog'); await runTranslation(); };
    $('retryTranslation').classList.remove('hidden'); $('copyTranslationError').classList.remove('hidden'); $('translationErrorChoice').classList.remove('hidden');
    showDialog('translationDialog'); toast(message, true);
  }
}
async function performContextTranslation(request, preview, ongoing = null, correction = null) {
  translationRetryAction = null; $('retryTranslation').classList.add('hidden'); $('translationErrorChoice').classList.add('hidden');
  $('copyUnstoredResult').classList.add('hidden'); $('copyUnstoredResult').dataset.result = '';
  const controller = new AbortController();
  translationAbortController = controller; translationCancelledByUser = false; translationClosingNormally = false;
  translationRunning = true; $('cancelTranslationBtn')?.classList.remove('hidden'); showDialog('translationDialog'); $('copyTranslationError').classList.add('hidden');
  const projectId = state.project.id; let run = ongoing; let phase = 'start';
  const checkNotCancelled = () => {
    if (translationCancelledByUser || controller.signal.aborted) {
      const err = new Error('عملیات توسط کاربر لغو شد.'); err.name = 'AbortError'; err.cancelled = true; throw err;
    }
  };
  try {
    await runJob(request.provider === 'free' ? 'در حال ترجمهٔ رایگان…' : 'در حال ترجمه با حافظهٔ داستان…', async () => {
      if (!run) {
        const started = await api(`/api/projects/${projectId}/context-start`, {
          ...jsonOptions('POST', { ...request, skill: preview.skill, summary: preview.summary, resume: preview.resume, confirmation: preview.signature }),
          signal: controller.signal,
        });
        checkNotCancelled();
        adoptProject(started.project); run = {id: started.runId, completed: started.completed};
      }
      while (true) {
        checkNotCancelled();
        phase = 'translation'; $('translationStatus').textContent = request.provider === 'free' ? `در حال ترجمهٔ درخواست ${run.completed + 1}…` : `در حال ترجمهٔ درخواست ${run.completed + 1} با خلاصهٔ قبلی…`;
        const result = await api(`/api/projects/${projectId}/context-step`, {
          ...jsonOptions('POST', {run_id: run.id, completed: run.completed, skill: preview.skill, ...(correction || {})}),
          signal: controller.signal,
        });
        checkNotCancelled();
        if (correction) { correction = null; clearResponseRepair(); }
        adoptProject(result.project); run.completed = result.completed ?? run.completed;
        phase = 'preview'; setOverlayMode('translation', false);
        if (result.affectedImageIds?.length) {
          try { await renderImagesText(result.affectedImageIds); }
          catch (error) { toast(`ترجمه ذخیره شد، اما همگام‌سازی پیش‌نمایش ناموفق بود: ${error.message || error}`, true); }
        }
        if (result.done) break;
      }
      phase = 'save'; setOverlayMode('translation', false);
    }, 'translationProgress');
    translationClosingNormally = true;
    closeDialog('translationDialog'); toast(request.provider === 'free' ? 'ترجمه ذخیره شد' : 'ترجمه و خلاصه ذخیره شد');
  } catch (error) {
    if (translationCancelledByUser || error?.cancelled || error?.name === 'AbortError') {
      toast(run?.completed ? `پنجره بسته شد؛ ${run.completed} بخش ذخیره‌شده باقی ماند و ادامهٔ ترجمه متوقف شد` : 'پنجرهٔ ترجمه بسته شد و عملیات متوقف گردید');
      api(`/api/projects/${projectId}`).then((fresh) => { if (state.project?.id === projectId && !inlineDraft) adoptProject(fresh); }).catch(() => {});
      return;
    }
    const uncertainty = phase === 'translation' ? 'وضعیت درخواست جاری در قطع ارتباط ممکن است نامشخص باشد و تکرار هزینه داشته باشد.' : 'درخواست‌های موفق ذخیره شده‌اند؛ پروژه را بررسی کنید.';
    error.message = `${run?.completed || 0} درخواست ذخیره شد؛ ترجمه متوقف شد. ${uncertainty} ${error.message || ''}`;
    $('translationStatus').textContent = `ترجمه ناموفق بود: ${error.message}`;
    if (run) offerResponseRepair(error, repair => performContextTranslation(request, preview, run, repair));
    if (error.pendingId) openPendingResults(error.pendingId);
    if (error.unstoredResult) { $('copyUnstoredResult').dataset.result = error.unstoredResult; $('copyUnstoredResult').classList.remove('hidden'); }
    translationRetryAction = phase === 'translation' && error.status !== 409 && !error.unstoredResult && run ? () => performContextTranslation(request, preview, run) : null;
    $('retryTranslation').classList.toggle('hidden', !translationRetryAction); $('translationErrorChoice').classList.remove('hidden'); $('copyTranslationError').classList.remove('hidden'); throw error;
  } finally {
    if (translationAbortController === controller) translationAbortController = null;
    translationClosingNormally = false; translationRunning = false; $('cancelTranslationBtn')?.classList.add('hidden');
    dismissJobCancelModal('translation');
  }
}

// ---------- Typeset preview and export ----------
async function ensureFont() { if (document.fonts?.load) { try { await Promise.all([document.fonts.load('700 24px Vazirmatn', 'ابپتثجچ'), document.fonts.load('400 16px Vazirmatn', 'ابپتثجچ')]); } catch { /* fallback */ } } }
async function renderAndUploadNow(item, projectId, mode) {
  const blocks = overlayBlocks(item, mode); const active = blocks.some((block) => block.enabled && hasRenderableText(block));
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
async function renderImagesText(ids = null, onStep = null) {
  const wanted = ids ? new Set(ids) : null;
  const targets = sortedImages().filter((item) => (!wanted || wanted.has(item.id)) && (hasOverlayText(item) || item.edited));
  for (let idx = 0; idx < targets.length; idx += 1) {
    await renderAndUpload(targets[idx]);
    if (onStep) onStep(idx + 1, targets.length);
  }
  renderGrid();
}
function updateExportFields() {
  const kind = $('exportKind').value;
  $('pdfExportFields').classList.toggle('hidden', kind !== 'pdf');
  $('imageExportFields').classList.toggle('hidden', kind !== 'images');
  $('docxExportFields')?.classList.toggle('hidden', kind !== 'docx');
  $('exportOverlayModeWrap')?.classList.toggle('hidden', kind === 'txt' || kind === 'docx');
}
async function exportResult(kind = null, docxModeOverride = null) {
  if (kind) { $('exportKind').value = kind; updateExportFields(); }
  if (!selectedImages().length) throw new Error('حداقل یک تصویر را برای خروجی انتخاب کنید');
  const controller = new AbortController();
  exportAbortController = controller; exportCancelledByUser = false; exportRunning = true;
  const checkNotCancelled = () => {
    if (exportCancelledByUser || controller.signal.aborted) {
      const err = new Error('ساخت خروجی لغو شد.'); err.name = 'AbortError'; err.cancelled = true; throw err;
    }
  };
  try {
    await overlayPreviewTask;
    checkNotCancelled();
    collectOutputSettings(); await saveProject(); const exportKind = $('exportKind').value;
    const docxMode = docxModeOverride || $('exportDocxMode')?.value || 'translation';
    if (exportKind !== 'txt' && exportKind !== 'docx') {
      const targets = selectedImages().filter((item) => hasOverlayText(item) || item.edited);
      for (let idx = 0; idx < targets.length; idx += 1) {
        checkNotCancelled();
        await renderAndUpload(targets[idx]);
        const p = ((idx + 1) / Math.max(1, targets.length)) * 0.5;
        if (activeProgressId) setProgress(activeProgressId, p, true);
        setProgress('jobProgress', p, true); setProgress('dockProgress', p, true);
      }
      renderGrid();
    } else {
      if (activeProgressId) setProgress(activeProgressId, 0.18, true);
      setProgress('jobProgress', 0.18, true); setProgress('dockProgress', 0.18, true);
    }
    checkNotCancelled();
    const baseExportName = safeName($('exportName').value);
    const finalExportName = exportKind === 'docx' && docxMode === 'ocr' && !/-(?:en|ocr)$/i.test(baseExportName) ? `${baseExportName}-en` : baseExportName;
    let response;
    try {
      response = await fetch(`/api/projects/${state.project.id}/export`, {
        ...jsonOptions('POST', { kind: exportKind, image_ids: selectedImages().map((item) => item.id), name: finalExportName, seamless: $('exportSeamless').checked, uniform_size: $('exportUniform').checked, two_per_page: $('exportTwo').checked, image_format: $('exportFormat').value, folder_name: $('exportFolder').value, docx_mode: docxMode }),
        signal: controller.signal,
      });
    } catch (cause) {
      if (cause?.name === 'AbortError' || controller.signal.aborted) checkNotCancelled();
      throw cause;
    }
    if (!response.ok) { const payload = await response.json().catch(() => null); throw new Error(payload?.detail || `خروجی ساخته نشد (HTTP ${response.status})`); }
    const blob = await response.blob();
    checkNotCancelled();
    if (!blob.size) throw new Error('سرور فایل خروجی خالی فرستاد؛ گزارش کارها را بررسی و دوباره تلاش کنید');
    if (activeProgressId) setProgress(activeProgressId, 1, false);
    const disposition = response.headers.get('content-disposition') || ''; const match = disposition.match(/filename\*?=(?:UTF-8''|\")?([^\";]+)/i);
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(blob);
    const link = $('downloadLink'); link.href = downloadUrl; link.download = match ? decodeURIComponent(match[1]) : `${finalExportName}.${exportKind === 'images' ? 'zip' : exportKind}`;
    link.textContent = `دانلود ${link.download}`; link.classList.remove('hidden'); link.click();
    closeDialog('exportDialog'); closeDialog('docxExportDialog'); $('jobStatus').textContent = `خروجی ${exportKind.toUpperCase()} آماده شد · ${(blob.size / 1024).toFixed(0)} کیلوبایت`; toast('خروجی آماده شد؛ اگر دانلود خودکار نشد، پیوند «دانلود» را بزنید');
  } catch (error) {
    if (exportCancelledByUser || error?.cancelled || error?.name === 'AbortError') {
      toast('ساخت خروجی به درخواست شما متوقف شد');
      throw error;
    }
    throw error;
  } finally {
    if (exportAbortController === controller) exportAbortController = null;
    exportRunning = false;
    dismissJobCancelModal('export');
  }
}
function openDocxExportPrompt() {
  if (!selectedImages().length) { toast('حداقل یک تصویر را برای خروجی انتخاب کنید', true); return; }
  setProgress('docxProgress', 0, false);
  showDialog('docxExportDialog');
}
async function runDocxChoiceExport(mode) {
  const buttons = ['docxChoiceTranslation', 'docxChoiceOcr'].map((id) => $(id)).filter(Boolean);
  buttons.forEach((btn) => { btn.disabled = true; });
  if ($('exportDocxMode')) $('exportDocxMode').value = mode;
  const label = mode === 'ocr' ? 'در حال ساخت فایل Word (متن انگلیسی / OCR)…' : 'در حال ساخت فایل Word (متن ترجمه‌شده)…';
  try { await runJob(label, () => exportResult('docx', mode), 'docxProgress'); }
  finally { buttons.forEach((btn) => { btn.disabled = false; }); }
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
  const controller = new AbortController();
  modelAbortController = controller; modelCancelledByUser = false;
  state.modelBusy = engine.id; setProgress('modelProgress', null, true); $('modelTestResult').textContent = `آماده‌سازی ${engine.name} برای ${language} آغاز شد؛ فقط مدل همین زبان دانلود می‌شود.`; appendLocalActivity(`آماده‌سازی ${engine.name} برای ${language} آغاز شد`); renderModels();
  try { const result = await api(`/api/engines/${engine.id}/download`, { ...jsonOptions('POST', { language }), signal: controller.signal }); state.engines = result.engines; setProgress('modelProgress', 1, false); $('modelTestResult').textContent = `مدل ${engine.name} برای ${language} آماده است.`; appendLocalActivity(`مدل ${engine.name} آماده شد`, 'success'); updateEngineOptions(); toast('مدل آماده است'); }
  catch (error) {
    setProgress('modelProgress', 0, false);
    if (modelCancelledByUser || error?.cancelled || error?.name === 'AbortError') {
      $('modelTestResult').textContent = 'عملیات آماده‌سازی مدل به درخواست شما لغو شد.';
      appendLocalActivity('آماده‌سازی مدل لغو شد', 'warning');
      toast('آماده‌سازی مدل متوقف شد');
    } else {
      $('modelTestResult').textContent = `آماده‌سازی ناموفق بود:\n${error.message}\n\nاتصال اینترنت و دسترسی به میزبان مدل را بررسی کنید.`;
      appendLocalActivity(`آماده‌سازی ناموفق بود: ${error.message}`, 'error'); toast(error.message, true);
    }
  }
  finally { if (modelAbortController === controller) modelAbortController = null; state.modelBusy = null; dismissJobCancelModal('model'); renderModels(); }
}
async function testEngine(engineId) {
  if (state.modelBusy) return; const item = selectedImages()[0] || sortedImages()[0]; if (!item) { toast('ابتدا یک تصویر وارد کنید', true); return; }
  const controller = new AbortController();
  modelAbortController = controller; modelCancelledByUser = false;
  state.modelBusy = engineId; setProgress('modelProgress', null, true); renderModels(); $('modelTestResult').textContent = 'در حال اجرای آزمایش محلی…'; appendLocalActivity(`آزمایش موتور ${engineId} آغاز شد`);
  try { const result = await api(`/api/engines/${engineId}/test`, { ...jsonOptions('POST', { project_id: state.project.id, image_id: item.id, language: $('testLanguage').value }), signal: controller.signal }); setProgress('modelProgress', 1, false); $('modelTestResult').textContent = result.blocks.length ? result.blocks.map((block) => `${' '.repeat(block.sourceIndent || 0)}${block.text}  (${block.conf}%)`).join('\n') : 'متنی تشخیص داده نشد.'; appendLocalActivity('آزمایش موتور تمام شد', 'success'); }
  catch (error) {
    setProgress('modelProgress', 0, false);
    if (modelCancelledByUser || error?.cancelled || error?.name === 'AbortError') {
      $('modelTestResult').textContent = 'آزمایش موتور به درخواست شما لغو شد.';
      appendLocalActivity('آزمایش موتور لغو شد', 'warning');
    } else {
      $('modelTestResult').textContent = error.message; appendLocalActivity(`آزمایش موتور ناموفق بود: ${error.message}`, 'error');
    }
  }
  finally { if (modelAbortController === controller) modelAbortController = null; state.modelBusy = null; dismissJobCancelModal('model'); renderModels(); }
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
    apiKey: String(profile.apiKey || ''), timeout_seconds: String(profile.timeout_seconds ?? 90), retry_count: String(profile.retry_count ?? 0), retry_wait_seconds: String(profile.retry_wait_seconds ?? 20), source_limit: String(profile.source_limit ?? 1000),
  };
}
function captureAiProvider() {
  if (!AI_PROVIDER_IDS.includes(aiEditorProvider)) return;
  aiEditorDrafts.set(aiEditorProvider, {
    model: $('aiModel').value.trim(), base_url: $('aiBaseUrl').value.trim(), response_mode: $('aiResponseMode').value,
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
      test.disabled = true; test.textContent = '…'; status.textContent = 'در حال بررسی…'; $('copyAiError').classList.add('hidden'); setProgress('aiProgress', null, true);
      try {
        await saveAiSettings({ quiet: true });
        setProgress('aiProgress', 0.45, true);
        const result = await api('/api/ai-settings/test', jsonOptions('POST', {
          provider, profile_id: profileId, model, base_url: baseUrl,
        }));
        setProgress('aiProgress', 1, false);
        $('aiStatus').textContent = result.message;
        const currentRow = [...container.querySelectorAll('.ai-profile-row')].find((item) => item.dataset.profileId === profileId);
        if (currentRow) currentRow.querySelector('.ai-profile-status').textContent = 'اتصال برقرار است ✓';
      } catch (error) {
        setProgress('aiProgress', 0, false);
        $('aiStatus').textContent = error.message; $('copyAiError').classList.remove('hidden');
        const currentRow = [...container.querySelectorAll('.ai-profile-row')].find((item) => item.dataset.profileId === profileId);
        (currentRow?.querySelector('.ai-profile-status') || status).textContent = error.message;
      } finally {
        const currentRow = [...container.querySelectorAll('.ai-profile-row')].find((item) => item.dataset.profileId === profileId);
        const currentTest = currentRow?.querySelector('.ai-profile-test') || test;
        currentTest.disabled = false; currentTest.textContent = 'تست';
      }
    });
    const options = document.createElement('div'); options.className = 'ai-profile-options';
    const addSetting = (labelText, field, min, max) => {
      const label = document.createElement('label'); label.textContent = labelText;
      const input = document.createElement('input'); input.type = 'number'; input.dir = 'ltr';
      input.className = `ai-profile-${field}`; input.min = String(min); input.max = String(max); input.step = '1';
      input.value = profile[field]; input.setAttribute('aria-label', `${labelText} API ${index + 1}`);
      input.addEventListener('input', () => { profile[field] = input.value; }); label.appendChild(input); options.appendChild(label);
    };
    addSetting('زمان انتظار (ثانیه، ۵ تا ۶۰۰)', 'timeout_seconds', 5, 600);
    addSetting('تکرار اضافی (۰ تا ۵)', 'retry_count', 0, 5);
    addSetting('فاصلهٔ تلاش مجدد (ثانیه، ۰ تا ۳۰۰)', 'retry_wait_seconds', 0, 300);
    addSetting('سقف نویسهٔ کل درخواست AI (۱ تا ۱۰۰۰۰۰)', 'source_limit', 1, 100000);
    row.append(name, key, test, remove, options, status); container.appendChild(row);
  });
}
function showAiProvider(provider, capture = true) {
  if (capture && provider !== aiEditorProvider) captureAiProvider();
  aiEditorProvider = AI_PROVIDER_IDS.includes(provider) ? provider : 'free';
  $('aiProvider').value = aiEditorProvider;
  $('aiFields').classList.toggle('hidden', aiEditorProvider === 'free');
  $('freeFields').classList.toggle('hidden', aiEditorProvider !== 'free');
  if (aiEditorProvider === 'free') { $('aiStatus').textContent = ''; $('copyAiError').classList.add('hidden'); return; }
  const info = aiInfo();
  const draft = aiEditorDrafts.get(aiEditorProvider);
  const sourceProfiles = draft?.profiles || info.profiles || [];
  aiEditorProfiles = sourceProfiles.map((profile, index) => makeAiProfile(profile, index));
  if (!aiEditorProfiles.length) aiEditorProfiles.push(makeAiProfile({ name: 'کلید اول' }));
  $('aiModel').value = draft?.model || info.model || info.defaultModel || '';
  $('aiBaseUrl').value = draft?.base_url || info.base_url || ''; $('aiResponseMode').value = draft?.response_mode || info.response_mode || 'auto';
  updateAiProviderUi(); renderAiProfiles(); $('aiStatus').textContent = ''; $('copyAiError').classList.add('hidden');
}
const FREE_FIELDS = [['timeout_seconds','زمان انتظار (ثانیه، ۵ تا ۶۰۰)',5,600,90], ['retry_count','تکرار اضافی (۰ تا ۵)',0,5,0], ['retry_wait_seconds','فاصلهٔ تکرار (ثانیه، ۰ تا ۳۰۰)',0,300,20], ['source_limit','سقف نویسه (۱ تا ۱۰۰۰۰۰)',1,100000,1000]];
function renderFreeServices() {
  const container = $('freeServices'); container.textContent = '';
  for (const [name, title] of [['google','Google Translate'],['mymemory','MyMemory']]) {
    const heading = document.createElement('h3'); heading.textContent = title;
    const row = document.createElement('div'); row.className = 'form-grid';
    for (const [field, labelText, min, max, fallback] of FREE_FIELDS) {
      const label = document.createElement('label'); label.textContent = labelText;
      const input = document.createElement('input'); input.id = `free-${name}-${field}`; input.type = 'number'; input.dir = 'ltr'; input.min = min; input.max = max; input.step = '1';
      input.value = state.ai?.free_services?.[name]?.[field] ?? (name === 'mymemory' && field === 'source_limit' ? 500 : fallback);
      label.appendChild(input); row.appendChild(label);
    }
    container.append(heading,row);
  }
}
function freeSettingsPayload() {
  const result = {};
  for (const name of ['google','mymemory']) {
    result[name] = {};
    for (const [field, label, min, max] of FREE_FIELDS) {
      const raw = $(`free-${name}-${field}`).value.trim(), value = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name}: ${label} باید عدد صحیح معتبر باشد.`);
      result[name][field] = value;
    }
  }
  return result;
}
async function loadAiSettings() {
  state.ai = await api('/api/ai-settings');
  aiEditorDrafts.clear(); renderFreeServices(); $('aiReuseRepeated').checked = state.ai.reuse_repeated !== false; $('aiContextPercent').value = state.ai.context_percent ?? 15; $('aiSkillPercent').value = state.ai.skill_percent ?? 15; showAiProvider(state.ai.provider || 'free', false);
}
function aiSettingsPayload() {
  captureAiProvider();
  const providers = {};
  AI_PROVIDER_IDS.forEach((provider) => {
    const info = aiInfo(provider);
    const draft = aiEditorDrafts.get(provider);
    const profiles = draft?.profiles || info.profiles || [];
    const intSetting = (profile, key, min, max) => {
      const raw = String(profile[key] ?? (key === 'timeout_seconds' ? 90 : key === 'retry_wait_seconds' ? 20 : key === 'source_limit' ? 1000 : 0));
      const value = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`تنظیم ${profile.name || 'API'}: ${key === 'timeout_seconds' ? 'زمان انتظار باید بین ۵ تا ۶۰۰' : key === 'retry_wait_seconds' ? 'فاصلهٔ تکرار باید بین ۰ تا ۳۰۰' : key === 'source_limit' ? 'سقف نویسه باید بین ۱ تا ۱۰۰۰۰۰' : 'تکرار باید بین ۰ تا ۵'} و عدد صحیح باشد.`);
      return value;
    };
    providers[provider] = {
      model: draft?.model || info.model || info.defaultModel,
      base_url: draft?.base_url || info.base_url,
      response_mode: draft?.response_mode || info.response_mode || 'auto',
      profiles: profiles.map((profile) => ({
        id: profile.id, name: profile.name || '',
        timeout_seconds: intSetting(profile, 'timeout_seconds', 5, 600), retry_count: intSetting(profile, 'retry_count', 0, 5), retry_wait_seconds: intSetting(profile, 'retry_wait_seconds', 0, 300), source_limit: intSetting(profile, 'source_limit', 1, 100000),
        ...(profile.apiKey?.trim() ? { api_key: profile.apiKey.trim() } : {}),
      })),
    };
  });
  const active = providers[aiEditorProvider];
  const contextPercent = Number($('aiContextPercent').value), skillPercent = Number($('aiSkillPercent').value);
  if ($('aiContextPercent').value.trim() === '' || $('aiSkillPercent').value.trim() === '' || !Number.isInteger(contextPercent) || !Number.isInteger(skillPercent) || contextPercent < 0 || skillPercent < 0 || contextPercent + skillPercent > 100) throw new Error('درصدهای خلاصه و اسکیل باید عدد صحیح غیرمنفی و جمع آن‌ها حداکثر ۱۰۰ باشد.');
  return { provider: aiEditorProvider, free_services: freeSettingsPayload(), reuse_repeated: $('aiReuseRepeated').checked, context_percent: contextPercent, skill_percent: skillPercent, model: active?.model || null, base_url: active?.base_url || null, providers };
}
async function saveAiSettings(options = {}) {
  state.ai = await api('/api/ai-settings', jsonOptions('PUT', aiSettingsPayload()));
  aiEditorDrafts.clear(); $('aiReuseRepeated').checked = state.ai.reuse_repeated !== false; showAiProvider(state.ai.provider || 'free', false);
  if (!options.quiet) toast('تنظیمات ترجمه ذخیره شد');
  return state.ai;
}

// ---------- Full-page translation editor ----------
function editorItem() { return state.project?.images.find((item) => item.id === state.editorId); }
function boxOf(block) { return { x0: Number.isFinite(block.tx0) ? block.tx0 : block.x0, y0: Number.isFinite(block.ty0) ? block.ty0 : block.y0, x1: Number.isFinite(block.tx1) ? block.tx1 : block.x1, y1: Number.isFinite(block.ty1) ? block.ty1 : block.y1 }; }
async function openEditor(imageId) {
  const loadSeq = ++editorLoadSeq;
  await ensureFont();
  if (loadSeq !== editorLoadSeq) return;
  const item = state.project?.images.find((entry) => entry.id === imageId);
  if (!item) return;
  if (inlineDraft) closeInlineEditor(true); else syncInlineDockIdleState();
  state.editorId = imageId; state.activeBlockId = null; state.selectedBlockIds = []; state.editorPan = null; $('editorStage').classList.remove('panning'); $('editorTitle').textContent = `ویرایش — ${item.name}`; $('blockList').textContent = ''; showDialog('editorDialog');
  const response = await fetch(imageUrl(item));
  if (response.ok === false) throw new Error('تصویر اصلی باز نشد');
  const bitmap = await createImageBitmap(await response.blob());
  if (loadSeq !== editorLoadSeq || state.editorId !== imageId) { bitmap.close?.(); return; }
  state.editorBitmap?.close?.(); state.editorBitmap = bitmap; $('editorCanvas').width = state.editorBitmap.width; $('editorCanvas').height = state.editorBitmap.height; buildBlockList(); fitEditor(); drawEditor();
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
  const minScale = imageOverview ? Math.min(.01, imageOverview.fitScale || .01) : Math.min(.1, state.editorFitScale || .1); const scale = Math.max(minScale, Math.min(4, Number(value) || oldScale));
  const viewportX = anchor?.x ?? preview.clientWidth / 2; const viewportY = anchor?.y ?? preview.clientHeight / 2;
  const imageX = (preview.scrollLeft + viewportX - stage.offsetLeft) / oldScale; const imageY = (preview.scrollTop + viewportY - stage.offsetTop) / oldScale;
  state.editorScale = scale; resizeEditorStage();
  preview.scrollLeft = Math.max(0, stage.offsetLeft + imageX * scale - viewportX); preview.scrollTop = Math.max(0, stage.offsetTop + imageY * scale - viewportY);
  positionInlineEditor();
}
// Fit both dimensions; unlike the existing width-fit this shows a tall page in full.
function fitWholeEditorImage() {
  const item = editorItem(); if (!item || !imageOverview) return;
  const preview = document.querySelector('.editor-preview');
  const width = Math.max(1, preview.clientWidth - 30); const height = Math.max(1, preview.clientHeight - 30);
  imageOverview.fitScale = Math.min(4, width / item.width, height / item.height);
  setEditorZoom(imageOverview.fitScale); preview.scrollLeft = 0; preview.scrollTop = 0;
}
async function enterImageOverview() {
  if (imageOverview || !editorItem()) return;
  const preview = document.querySelector('.editor-preview'); const dialog = $('editorDialog');
  // Capture the draft before its field is hidden; the project itself remains untouched.
  imageOverview = { scale: state.editorScale, fitScaleBefore: state.editorFitScale,
    left: preview.scrollLeft, top: preview.scrollTop, draft: inlineDraft ? draftBlockForPreview() : null, native: false };
  dialog.classList.add('image-fullscreen'); $('editorImageFullscreen').textContent = 'خروج از تمام‌صفحه';
  $('editorImageFullscreen').setAttribute('aria-pressed', 'true'); $('editorImageFullscreen').setAttribute('aria-label', 'خروج از تمام‌صفحهٔ تصویر');
  drawEditorCanvas(); fitWholeEditorImage();
  if (dialog.requestFullscreen && !document.fullscreenElement) {
    try { await dialog.requestFullscreen(); if (imageOverview) imageOverview.native = true; }
    catch { /* Embedded browsers can deny fullscreen; the viewport-sized fallback remains usable. */ }
  }
  if (imageOverview) requestAnimationFrame(fitWholeEditorImage);
}
async function exitImageOverview(fromBrowser = false) {
  if (!imageOverview) return;
  const previous = imageOverview; imageOverview = null;
  const dialog = $('editorDialog'); dialog.classList.remove('image-fullscreen');
  $('editorImageFullscreen').textContent = 'تمام‌صفحه تصویر'; $('editorImageFullscreen').setAttribute('aria-pressed', 'false');
  $('editorImageFullscreen').setAttribute('aria-label', 'تمام‌صفحهٔ تصویر');
  if (!fromBrowser && document.fullscreenElement === dialog && document.exitFullscreen) {
    try { await document.exitFullscreen(); } catch { /* The browser may already have exited. */ }
  }
  state.editorFitScale = previous.fitScaleBefore; setEditorZoom(previous.scale);
  const preview = document.querySelector('.editor-preview'); preview.scrollLeft = previous.left; preview.scrollTop = previous.top;
  drawEditorCanvas(); positionInlineEditor();
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
  if (!state.editorId || !event.ctrlKey) return;
  event.preventDefault(); const rect = document.querySelector('.editor-preview').getBoundingClientRect();
  setEditorZoom(state.editorScale * (event.deltaY < 0 ? 1.15 : 1 / 1.15), { x: event.clientX - rect.left, y: event.clientY - rect.top });
}
// The session is the single source of truth for both live output and persistence.
function draftBlockForPreview() {
  return inlineEditSession?.previewBlock() || null;
}
function drawEditorCanvas() {
  const item = editorItem(); if (!item || !state.editorBitmap) return;
  // Keep the committed renderer live while typing: the editable DOM is only an
  // interaction layer; the canvas beneath it always shows the exact draft output.
  const draft = imageOverview ? imageOverview.draft : (inlineDraft ? draftBlockForPreview() : null);
  const liveHtml = inlineDraft && !imageOverview && inlineDraft.mode !== 'ocr' && classicEditor?.field ? classicEditor.getHTML() : null;
  const blocks = item.blocks.map((block) => {
    if (draft && block === inlineDraft?.block) {
      const ov = overlayBlock(draft);
      return liveHtml !== null ? { ...ov, _liveHtml: liveHtml } : ov;
    }
    return overlayBlock(block);
  });
  const rendered = Typeset.render(state.editorBitmap, blocks); const canvas = $('editorCanvas'); const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(rendered, 0, 0);
  if (rendered && rendered !== canvas) { rendered.width = 0; rendered.height = 0; }
}
function scheduleEditorCanvasDraw() {
  if (editorCanvasFrame) return;
  editorCanvasFrame = requestAnimationFrame(() => { editorCanvasFrame = 0; drawEditorCanvas(); });
}
function drawEditor() { drawEditorCanvas(); renderEditorBoxes(); positionInlineEditor(); }
function clampedBoxOf(block) {
  const raw = boxOf(block);
  const item = editorItem();
  const maxW = state.editorBitmap?.width || item?.width;
  const maxH = state.editorBitmap?.height || item?.height;
  if (!(maxW > 0 && maxH > 0)) return raw;
  return { x0: Math.max(0, raw.x0), y0: Math.max(0, raw.y0), x1: Math.min(maxW, raw.x1), y1: Math.min(maxH, raw.y1) };
}
function overlaySize(block, width, height) {
  try {
    overlayMeasureCtx = overlayMeasureCtx || document.createElement('canvas').getContext('2d');
    if (typeof Typeset.fitBlockSize === 'function') {
      return Typeset.fitBlockSize(overlayMeasureCtx, block, width, height);
    }
    const style = Typeset.blockStyle(block);
    if (style.size) return style.size;
    const sourceText = String(block.tr || '').trim();
    const richWords = !block._plainText && block.richHtml ? Typeset.richHtmlWords(block.richHtml) : null;
    const maxSize = Math.max(12, Math.min(64, Math.round(block.lineH * 1.1)));
    const ctx = overlayMeasureCtx;
    const padX = Typeset.boxInset ? Typeset.boxInset(width) : Math.min(4, Math.max(0, width * 0.02));
    const padY = Typeset.boxInset ? Typeset.boxInset(height) : Math.min(4, Math.max(0, height * 0.02));
    const usableW = Math.max(1, width - 2 * padX), usableH = Math.max(1, height - 2 * padY);
    const inline = style.align === 'justify' || (!block._plainText && (!!block.richHtml || Typeset.hasInlineMarks(sourceText)));
    if (inline) {
      const words = block._plainText ? Typeset.richHtmlWords(plainToHtml(sourceText)) : (richWords || Typeset.inlineWords(sourceText));
      return Typeset.fitInline(ctx, words, usableW, usableH, maxSize, 8, style).size;
    }
    const prefix = `${style.italic ? 'italic ' : ''}${style.bold ? '700' : '400'} `;
    return Typeset.fit(ctx, sourceText, usableW, usableH, maxSize, 8, prefix).size;
  } catch {
    return Math.max(8, Math.min(160, Number(block.size) || Math.min(42, Math.max(10, height / Math.max(1.8, String(block.tr || '').split('\n').length * 1.65)))));
  }
}
function styleRichElement(element, block, scale = 1, preview = false) {
  const box = clampedBoxOf(block); const style = Typeset.blockStyle(block);
  element.dir = style.dir; element.style.direction = style.dir; element.style.textAlign = style.align;
  element.style.justifyContent = style.verticalAlign === 'top' ? 'flex-start' : style.verticalAlign === 'bottom' ? 'flex-end' : 'center';
  // The sidebar is an editing surface, not the output: output size and colour affect only the image.
  element.style.fontSize = preview ? `${overlaySize(block, box.x1 - box.x0, box.y1 - box.y0) * scale}px` : '';
  element.style.fontWeight = style.bold ? '700' : '400'; element.style.fontStyle = style.italic ? 'italic' : 'normal';
  element.style.color = preview ? (style.color || (block.bg === 'white' ? '#0b0b0b' : '#fff')) : '';
  element.style.caretColor = preview ? (style.color || (block.bg === 'white' ? '#0b0b0b' : '#fff')) : '';
  element.style.textDecoration = style.underline ? 'underline' : '';
}
function logicalFontSizeOf(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
  const stored = Number.parseFloat(element.dataset?.logicalSize || '');
  if (Number.isFinite(stored) && stored > 0) return Math.max(8, Math.min(160, stored));
  const raw = Number.parseFloat(element.style?.fontSize || '');
  if (Number.isFinite(raw) && raw > 0) return Math.max(8, Math.min(160, raw));
  return null;
}
function applyLogicalFontSize(element, cssValue) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return;
  const parsed = Number.parseFloat(cssValue || '');
  if (cssValue && Number.isFinite(parsed) && parsed > 0) {
    const clamped = Math.max(8, Math.min(160, Math.round(parsed)));
    element.dataset.logicalSize = String(clamped);
    element.style.fontSize = `${clamped}px`;
  } else {
    delete element.dataset.logicalSize;
    element.style.fontSize = '';
  }
}
function serializeInlineFieldHtml(field) {
  if (!field?.querySelector?.('[data-logical-size]')) return field?.innerHTML || '';
  const clone = field.cloneNode(true);
  clone.querySelectorAll('[data-logical-size]').forEach((el) => {
    const n = Number.parseFloat(el.dataset.logicalSize || '');
    if (Number.isFinite(n) && n > 0) el.style.fontSize = `${Math.max(8, Math.min(160, Math.round(n)))}px`;
    el.removeAttribute('data-logical-size');
  });
  return clone.innerHTML;
}
function updateInlineSelectionHighlight() {
  if (!window.CSS?.highlights || typeof window.Highlight !== 'function') return;
  const field = $('inlineEditorField');
  if (hasInlineWordSelection() && document.activeElement !== field) {
    window.CSS.highlights.set('comic-inline-selection', new window.Highlight(inlineDraft.range));
  } else {
    window.CSS.highlights.delete('comic-inline-selection');
  }
}
// Keep the transparent caret layer aligned over the exact live canvas output.
function refreshInlineTypography() {
  if (!inlineDraft || !classicEditor) return;
  const field = classicEditor.field; const previewBlock = draftBlockForPreview(); if (!previewBlock) return;
  const draft = overlayBlock(previewBlock); const style = Typeset.blockStyle(draft);
  const host = field.parentElement?.classList.contains('editor-box') ? field.parentElement : null;
  if (!host) {
    field.removeAttribute('style');
    delete field.dataset.layoutZoom; delete field.dataset.visualFontSize;
    field.dir = style.dir; field.style.direction = style.dir; field.style.textAlign = style.align;
    field.querySelectorAll?.('[data-logical-size]').forEach((el) => { el.style.fontSize = `${el.dataset.logicalSize}px`; });
    scheduleEditorCanvasDraw();
    return;
  }
  const box = clampedBoxOf(draft); const scale = state.editorScale || 1;
  const bw = Math.max(1, box.x1 - box.x0); const bh = Math.max(1, box.y1 - box.y0);
  const baseSize = overlaySize(draft, bw, bh);
  // Lay out at the exact unscaled logical font size used by Typeset.render so
  // per-glyph hinting advances and line-wrap break points match Canvas 1:1, then
  // scale visually via CSS transform to match the zoomed image stage.
  const layoutZoom = 1;
  field.dataset.layoutZoom = '1';
  field.dataset.visualFontSize = String(baseSize * scale);
  field.style.fontSize = `${baseSize}px`;
  field.style.lineHeight = '1.55'; field.style.fontWeight = style.bold ? '700' : '400';
  field.style.fontStyle = style.italic ? 'italic' : 'normal'; field.style.textDecoration = style.underline ? 'underline' : '';
  field.style.whiteSpace = 'pre-line'; field.style.textJustify = 'inter-word';
  field.style.letterSpacing = '0px'; field.style.wordSpacing = '0px'; field.style.fontKerning = 'auto';
  field.style.background = 'transparent'; field.style.color = 'transparent'; field.style.webkitTextFillColor = 'transparent'; field.style.caretColor = 'var(--a1)';
  field.dir = style.dir; field.style.direction = style.dir; field.style.textAlign = style.align;
  field.querySelectorAll?.('[style],[data-logical-size]').forEach((el) => {
    if (!el.style?.fontSize && el.dataset?.logicalSize) { delete el.dataset.logicalSize; return; }
    const logical = logicalFontSizeOf(el);
    if (logical == null) return;
    el.dataset.logicalSize = String(Math.round(logical));
    const ref = style.size || baseSize;
    const eff = Math.max(8, Math.min(160, Math.round(baseSize * logical / ref)));
    el.style.fontSize = `${eff * layoutZoom}px`;
  });
  const insetX = (Typeset.boxInset ? Typeset.boxInset(bw) : Math.min(4, Math.max(0, bw * 0.02))) * layoutZoom;
  field.style.right = 'auto'; field.style.bottom = 'auto';
  field.style.width = `${bw * layoutZoom}px`;
  field.style.paddingLeft = `${insetX}px`; field.style.paddingRight = `${insetX}px`;
  field.style.paddingTop = '0px'; field.style.paddingBottom = '0px';
  field.style.minHeight = '0px'; field.style.height = 'auto';
  field.style.transformOrigin = '0 0';
  field.style.transform = `scale(${scale / layoutZoom})`;
  const rawScrollH = field.scrollHeight;
  const contentH = (rawScrollH > 0 ? rawScrollH : baseSize * layoutZoom * 1.55) / layoutZoom;
  const insetY = Typeset.boxInset ? Typeset.boxInset(bh) : Math.min(4, Math.max(0, bh * 0.02));
  const topUnscaled = style.verticalAlign === 'top' ? insetY : style.verticalAlign === 'bottom' ? bh - insetY - contentH : (bh - contentH) / 2;
  field.style.left = `${-(host.clientLeft || 0)}px`;
  field.style.top = `${-(host.clientTop || 0) + topUnscaled * scale}px`;
  const fieldHLayout = Math.max(Math.max(1, bh - topUnscaled) * layoutZoom, rawScrollH + 4);
  field.style.height = `${fieldHLayout}px`;
  const clipTop = Math.max(0, -topUnscaled) * layoutZoom;
  const clipBottom = Math.max(0, topUnscaled + fieldHLayout / layoutZoom - bh) * layoutZoom;
  field.style.clipPath = (clipTop > 0.5 || clipBottom > 0.5) ? `inset(${clipTop}px 0px ${clipBottom}px 0px)` : 'none';
  if (field.scrollTop) field.scrollTop = 0;
  if (field.scrollLeft) field.scrollLeft = 0;
  scheduleEditorCanvasDraw();
}
function syncVerticalAlignButtons() {
  const dock = $('inlineEditor');
  const buttons = document.querySelectorAll('.inline-valign-btn');
  if (!buttons.length) return;
  const selected = selectedEditorBlocks();
  const multiSelected = selected.length > 1 || (selected.length === 1 && (!inlineDraft || selected[0] !== inlineDraft.block));
  let activeValue = null;
  let enabled = false;
  if (inlineDraft && !multiSelected) {
    enabled = true;
    activeValue = ['top', 'bottom'].includes($('inlineVerticalAlign')?.value) ? $('inlineVerticalAlign').value : 'middle';
    dock?.classList.remove('has-selection');
  } else {
    enabled = selected.length > 0 || !!inlineDraft;
    if (!inlineDraft) dock?.classList.toggle('has-selection', selected.length > 0);
    else dock?.classList.remove('has-selection');
    if (selected.length > 0) {
      const values = new Set(selected.map((b) => (b === inlineDraft?.block
        ? (['top', 'bottom'].includes($('inlineVerticalAlign')?.value) ? $('inlineVerticalAlign').value : 'middle')
        : (['top', 'bottom'].includes(b.verticalAlign) ? b.verticalAlign : 'middle'))));
      activeValue = values.size === 1 ? [...values][0] : null;
      if (!inlineDraft && $('inlineVerticalAlign') && activeValue) $('inlineVerticalAlign').value = activeValue;
    }
  }
  buttons.forEach((btn) => {
    btn.disabled = !enabled;
    btn.setAttribute('aria-pressed', String(enabled && btn.dataset.valign === activeValue));
  });
}
function setVerticalPlacement(value) {
  if (!['top', 'middle', 'bottom'].includes(value)) return;
  const selected = selectedEditorBlocks();
  let updatedOther = false;
  selected.forEach((block) => {
    if (block !== inlineDraft?.block) { block.verticalAlign = value; updatedOther = true; }
  });
  if (inlineDraft) {
    inlineDraft.verticalAlignTouched = true;
    $('inlineVerticalAlign').value = value;
    syncVerticalAlignButtons();
    classicEditor.notifyChange();
    if (updatedOther) { drawEditor(); scheduleSave(); }
    return;
  }
  if (!selected.length) return;
  if ($('inlineVerticalAlign')) $('inlineVerticalAlign').value = value;
  syncVerticalAlignButtons();
  drawEditor();
  scheduleSave();
}
function setInlineDockDisabled(disabled) {
  ['inlinePreview', 'inlineEditorApply', 'inlineVerticalAlign', 'inlineLineSize', 'inlineSizeUp', 'inlineSizeDown', 'inlineLineReset',
    'inlineEditorDirection', 'inlineEditorAlign', 'inlineEditorSize', 'inlineEditorColor', 'inlineEditorAutoColor']
    .forEach((id) => { const el = $(id); if (el) el.disabled = disabled; });
  document.querySelectorAll('#inlineEditor .classic-toolbar button, #inlineEditor .classic-toolbar select, #inlineEditor .classic-toolbar input, #inlineEditor .classic-tabs button')
    .forEach((el) => { el.disabled = disabled; });
  syncVerticalAlignButtons();
}
function syncInlineDockIdleState() {
  const dock = $('inlineEditor');
  if (!dock) return;
  classicEditor?.setPlainMode(false);
  classicEditor?.resetToolbar?.();
  dock.classList.remove('hidden', 'show-output', 'plain-mode');
  dock.classList.add('is-idle');
  dock.querySelector('.inline-box-settings')?.removeAttribute('open');
  $('inlineEditorTitle').textContent = 'ویرایشگر متن آماده است · برای ویرایش، روی هر کادر متن در تصویر کلیک کنید';
  const badge = $('inlineTargetBadge');
  if (badge) { badge.textContent = ''; badge.classList.add('hidden'); badge.classList.remove('is-word'); }
  if ($('inlineLineSize')) $('inlineLineSize').value = '';
  $('inlinePreview').textContent = 'پیش‌نمایش دقیق';
  $('inlinePreview').setAttribute('aria-pressed', 'false');
  $('inlineEditorCancel').classList.add('hidden');
  $('inlineLineTools').classList.remove('hidden');
  setInlineDockDisabled(true);
}
function setInlineOutputPreview(enabled) {
  if (!inlineDraft) return;
  inlineDraft.showOutput = !!enabled;
  $('inlineEditor').classList.toggle('show-output', inlineDraft.showOutput);
  const activeBox = [...document.querySelectorAll('#editorBoxes .editor-box')].find((el) => el.dataset.id === String(inlineDraft.block.id));
  activeBox?.classList.toggle('show-output', inlineDraft.showOutput);
  const button = $('inlinePreview'); button.setAttribute('aria-pressed', String(inlineDraft.showOutput));
  button.textContent = inlineDraft.showOutput ? 'ادامهٔ ویرایش' : 'پیش‌نمایش دقیق';
  drawEditorCanvas();
  if (!enabled) {
    const range = inlineDraft.range; classicEditor.focus();
    if (range && classicEditor.field.contains(range.startContainer) && classicEditor.field.contains(range.endContainer)) {
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }
  } else classicEditor.field.blur();
}
// A draft belongs to one image box; the docked toolbar stays permanently open at the top.
function inlineBlockSnapshot(block) {
  return JSON.stringify([block.text || '', block.tr || '', block.richHtml || '', block.dir || '', block.align || '', block.size ?? null, block.color || null, block.verticalAlign || '']);
}
function inlineDraftChanged() { return !!inlineEditSession?.isDirty(); }
function closeInlineEditor(force = false) {
  if (!inlineDraft) return true;
  if (!force && document.activeElement === $('inlineLineSize')) $('inlineLineSize').blur();
  const committed = inlineEditSession?.close({ discardConflict: force }) ?? false;
  if (!committed && !force) return false;
  if (committed) classicEditor.clearDraft(); else classicEditor.saveDraft();
  classicEditor.closeModal?.({ restoreFocus: false });
  classicEditor.exitFullscreen(); classicEditor.detachField();
  const box = [...document.querySelectorAll('#editorBoxes .editor-box')].find((el) => el.dataset.id === String(inlineDraft.block.id));
  box?.classList.remove('editing', 'show-output');
  inlineDraft = null; inlineEditSession = null;
  updateInlineSelectionHighlight();
  syncInlineDockIdleState();
  if (!imageOverview) drawEditorCanvas();
  document.querySelector('.editor-preview').style.paddingTop = '';
  if (!committed && force) toast('تغییر هم‌زمان بود؛ متن پروژه حفظ شد و نسخهٔ محلی برای بازیابی نگه داشته شد.', true);
  return true;
}
function positionInlineEditor() {
  // The editor toolbar is docked under the filename/title now, not positioned
  // over the page. Keep this hook for resize/scroll calls that refresh preview typography.
  if (!inlineDraft || imageOverview) return;
  refreshInlineTypography();
}
function rememberInlineRange() {
  if (!inlineDraft) return;
  const field = $('inlineEditorField'); const selection = window.getSelection?.();
  if (selection?.rangeCount && field.contains(selection.anchorNode) && field.contains(selection.focusNode)) {
    inlineDraft.range = selection.getRangeAt(0).cloneRange();
    classicEditor?.syncRange?.(inlineDraft.range);
  }
}
function inlineRangePath(node, root) {
  const path = []; while (node && node !== root) { const parent = node.parentNode; if (!parent) return null; path.unshift([...parent.childNodes].indexOf(node)); node = parent; }
  return node === root ? path : null;
}
function inlineHistoryEntry() {
  const field = $('inlineEditorField'); const selection = window.getSelection();
  const range = selection?.rangeCount && field.contains(selection.anchorNode) && field.contains(selection.focusNode) ? selection.getRangeAt(0) : inlineDraft?.range;
  return { html: field.innerHTML, start: range ? inlineRangePath(range.startContainer, field) : null, startOffset: range?.startOffset || 0,
    end: range ? inlineRangePath(range.endContainer, field) : null, endOffset: range?.endOffset || 0 };
}
function recordInlineHistory() {
  if (!inlineDraft || inlineDraft.muteHistory) return;
  const entry = inlineHistoryEntry(); const history = inlineDraft.history;
  if (history[inlineDraft.historyIndex]?.html === entry.html) { history[inlineDraft.historyIndex] = entry; return; }
  history.splice(inlineDraft.historyIndex + 1); history.push(entry);
  if (history.length > 100) history.shift();
  inlineDraft.historyIndex = history.length - 1;
}
function restoreInlineHistory(step) {
  if (!inlineDraft) return;
  const index = inlineDraft.historyIndex + step;
  if (index < 0 || index >= inlineDraft.history.length) return;
  inlineDraft.historyIndex = index; const entry = inlineDraft.history[index]; const field = $('inlineEditorField');
  field.innerHTML = entry.html; field.focus();
  const resolve = (path) => Array.isArray(path) ? path.reduce((node, i) => node?.childNodes[i], field) : null;
  const start = resolve(entry.start); const end = resolve(entry.end);
  const maxOffset = (node) => node.nodeType === Node.TEXT_NODE ? node.length : node.childNodes.length;
  if (start && end) {
    const range = document.createRange(); range.setStart(start, Math.min(entry.startOffset, maxOffset(start))); range.setEnd(end, Math.min(entry.endOffset, maxOffset(end)));
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }
  rememberInlineRange(); syncInlineLineControls(); classicEditor.notifyChange();
}
function inlineParagraphFrom(node) {
  const field = $('inlineEditorField');
  let element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  while (element && element !== field) {
    if (['DIV', 'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE'].includes(element.tagName)) return element;
    element = element.parentElement;
  }
  return null;
}
function hasInlineWordSelection() {
  const field = $('inlineEditorField'); const range = inlineDraft?.range;
  return !!(inlineDraft && inlineDraft.mode !== 'ocr' && range && !range.collapsed && field.contains(range.startContainer) && field.contains(range.endContainer) && String(range.toString() || '').trim());
}
function inlineSelectionSpan(range) {
  if (!range || range.collapsed) return null;
  const field = $('inlineEditorField'); const selected = range.toString();
  let node = range.commonAncestorContainer;
  if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
  while (node && node !== field) {
    if (node.tagName === 'SPAN' && node.textContent === selected) return node;
    node = node.parentElement;
  }
  return null;
}
function normalizeHexColor(raw) {
  if (!raw) return '';
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(raw);
  return rgb ? `#${rgb.slice(1).map((x) => Math.min(255, Number(x)).toString(16).padStart(2, '0')).join('')}` : '';
}
function inlineInheritedStyle(node, prop) {
  const field = $('inlineEditorField');
  let cur = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  while (cur && cur !== field) {
    if (cur.style?.[prop]) return cur.style[prop];
    cur = cur.parentElement;
  }
  return '';
}
function inlineInheritedLogicalSize(node) {
  const field = $('inlineEditorField');
  let cur = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  while (cur && cur !== field) {
    const val = logicalFontSizeOf(cur);
    if (val != null) return Math.round(val);
    cur = cur.parentElement;
  }
  return null;
}
function inlineSelectionStyleState(range) {
  const field = $('inlineEditorField');
  const base = Typeset.blockStyle(overlayBlock(inlineDraft.block));
  let bold = base.bold !== false, italic = !!base.italic, underline = !!base.underline, strike = false;
  const chain = [];
  let cur = inlineSelectionSpan(range) || (range?.startContainer?.nodeType === Node.ELEMENT_NODE ? range.startContainer : range?.startContainer?.parentElement);
  while (cur && cur !== field) { chain.unshift(cur); cur = cur.parentElement; }
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
  });
  return { bold, italic, underline, strike };
}
function syncInlineLineControls() {
  const badge = $('inlineTargetBadge');
  const sizeInput = $('inlineLineSize');
  const typingSize = document.activeElement === sizeInput;
  updateInlineSelectionHighlight();
  if (!inlineDraft || inlineDraft.mode === 'ocr') {
    if (badge) {
      badge.textContent = inlineDraft?.mode === 'ocr' ? 'متن سادهٔ OCR' : '';
      badge.classList.toggle('hidden', !inlineDraft);
      badge.classList.remove('is-word');
    }
    if (inlineDraft?.mode === 'ocr' && !typingSize && sizeInput) {
      sizeInput.value = inlineDraft.initialAutoSize && !inlineDraft.sizeTouched ? '' : $('inlineEditorSize').value;
    }
    return;
  }
  if (hasInlineWordSelection()) {
    const raw = inlineDraft.range.toString().trim().replace(/\s+/g, ' ');
    const snippet = Array.from(raw).length > 18 ? `${Array.from(raw).slice(0, 18).join('')}…` : raw;
    if (badge) { badge.textContent = `بخش انتخابی: «${snippet}»`; badge.classList.remove('hidden'); badge.classList.add('is-word'); }
    const span = inlineSelectionSpan(inlineDraft.range) || (inlineDraft.range.startContainer.nodeType === Node.ELEMENT_NODE ? inlineDraft.range.startContainer : inlineDraft.range.startContainer.parentElement);
    const sizeVal = inlineInheritedLogicalSize(span);
    if (!typingSize) sizeInput.value = sizeVal != null ? String(sizeVal) : '';
    const hex = normalizeHexColor(inlineInheritedStyle(span, 'color'));
    if (hex && classicEditor?.colorInput) classicEditor.colorInput.value = hex;
    return;
  }
  if (badge) { badge.textContent = 'هدف: خط فعلی'; badge.classList.remove('hidden', 'is-word'); }
  const line = inlineParagraphFrom(inlineDraft.range?.startContainer);
  const lineSize = logicalFontSizeOf(line);
  if (!typingSize) sizeInput.value = lineSize != null ? String(Math.round(lineSize)) : '';
  const lineHex = normalizeHexColor(line?.style.color) || effectiveInlineColor(inlineDraft.block);
  if (lineHex && classicEditor?.colorInput) classicEditor.colorInput.value = lineHex;
}
function applyStylePatchToElement(element, styles) {
  Object.entries(styles).forEach(([key, val]) => {
    if (key === 'fontSize') applyLogicalFontSize(element, val);
    else element.style[key] = val;
  });
}
function applyInlineWordStyle(styles, options = {}) {
  const { restoreFocus = true } = options;
  const field = $('inlineEditorField');
  if (!hasInlineWordSelection()) return false;
  const range = inlineDraft.range.cloneRange();
  if (restoreFocus) field.focus({ preventScroll: true });
  let nextRange = null;
  let target = inlineSelectionSpan(range);
  if (target) {
    applyStylePatchToElement(target, styles);
    if (!target.getAttribute('style')?.trim()) {
      const parent = target.parentNode; const first = target.firstChild; const last = target.lastChild;
      while (target.firstChild) parent.insertBefore(target.firstChild, target);
      target.remove();
      if (first && last) {
        nextRange = document.createRange(); nextRange.setStartBefore(first); nextRange.setEndAfter(last);
      }
    } else {
      nextRange = document.createRange(); nextRange.selectNodeContents(target);
    }
  } else {
    const fragment = range.extractContents();
    const unwrapTags = [];
    if ('fontWeight' in styles) unwrapTags.push('b', 'strong');
    if ('fontStyle' in styles) unwrapTags.push('i', 'em');
    if ('textDecoration' in styles) unwrapTags.push('u', 's', 'strike', 'del');
    if (unwrapTags.length) {
      [...fragment.querySelectorAll(unwrapTags.join(','))].reverse().forEach((el) => el.replaceWith(...el.childNodes));
    }
    fragment.querySelectorAll('span').forEach((child) => {
      Object.keys(styles).forEach((key) => {
        if (key === 'fontSize') applyLogicalFontSize(child, '');
        else child.style[key] = '';
      });
      if (!child.getAttribute('style')?.trim()) child.replaceWith(...child.childNodes);
    });
    const wrapper = document.createElement('span');
    applyStylePatchToElement(wrapper, styles);
    if (wrapper.getAttribute('style')?.trim()) {
      wrapper.appendChild(fragment);
      range.insertNode(wrapper);
      nextRange = document.createRange(); nextRange.selectNodeContents(wrapper);
    } else {
      const nodes = [...fragment.childNodes];
      range.insertNode(fragment);
      if (nodes.length) {
        nextRange = document.createRange(); nextRange.setStartBefore(nodes[0]); nextRange.setEndAfter(nodes.at(-1));
      }
    }
  }
  if (nextRange) {
    inlineDraft.range = nextRange.cloneRange();
    classicEditor.syncRange?.(inlineDraft.range);
    if (restoreFocus) {
      const selection = window.getSelection();
      selection.removeAllRanges(); selection.addRange(nextRange);
    }
  }
  recordInlineHistory(); syncInlineLineControls(); refreshInlineTypography(); classicEditor.notifyChange();
  return true;
}
function ensureInlineParagraph(options = {}) {
  const { restoreFocus = true } = options;
  const field = $('inlineEditorField'); const range = inlineDraft?.range;
  if (!inlineDraft || inlineDraft.mode === 'ocr' || !range || !field.contains(range.startContainer)) {
    toast('ابتدا داخل خط موردنظر کلیک کنید.', true); return null;
  }
  let existing = inlineParagraphFrom(range.startContainer);
  if (existing && !restoreFocus) return existing;
  const activeControl = !restoreFocus && document.activeElement && document.activeElement !== field
    ? { el: document.activeElement, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd }
    : null;
  field.focus(); const selection = window.getSelection(); const cursor = range.cloneRange(); cursor.collapse(true);
  selection.removeAllRanges(); selection.addRange(cursor);
  let line = inlineParagraphFrom(selection.anchorNode);
  if (!line) {
    // Browser paragraph boundaries include existing BRs, so only the chosen logical line is wrapped.
    inlineDraft.muteHistory = true;
    try { document.execCommand('formatBlock', false, 'div'); } finally { inlineDraft.muteHistory = false; }
    line = inlineParagraphFrom(selection.anchorNode);
    // Chromium leaves the BR immediately before its new DIV, which otherwise
    // turns one legacy line break into two in innerText and saved translations.
    if (line?.previousSibling?.nodeName === 'BR') line.previousSibling.remove();
  }
  if (!line) { toast('انتخاب این خط ممکن نشد؛ دوباره داخل متن کلیک کنید.', true); return null; }
  rememberInlineRange();
  if (activeControl?.el) {
    activeControl.el.focus();
    if (typeof activeControl.start === 'number' && activeControl.el.setSelectionRange) {
      try { activeControl.el.setSelectionRange(activeControl.start, activeControl.end); } catch {}
    }
  }
  return line;
}
function setInlineLineStyle(property, value, options = {}) {
  const field = $('inlineEditorField');
  const fullBoxSelected = hasInlineWordSelection()
    && inlineDraft.range.toString().trim() === field.textContent.trim()
    && field.textContent.trim().length > 0;
  if (inlineDraft && inlineDraft.mode !== 'ocr' && (fullBoxSelected || (!field.textContent && !field.querySelector('div,p')))) {
    if (property === 'textAlign') {
      $('inlineEditorAlign').value = value; field.style.textAlign = value;
      field.querySelectorAll('div,p').forEach((el) => { el.style.textAlign = ''; });
      recordInlineHistory(); syncInlineLineControls(); refreshInlineTypography(); classicEditor.notifyChange(); return;
    }
    if (property === 'direction') {
      $('inlineEditorDirection').value = value; field.dir = value; field.style.direction = value;
      field.querySelectorAll('div,p').forEach((el) => { el.style.direction = ''; });
      recordInlineHistory(); syncInlineLineControls(); refreshInlineTypography(); classicEditor.notifyChange(); return;
    }
  }
  const line = ensureInlineParagraph(options); if (!line) return;
  if (property === 'fontSize') applyLogicalFontSize(line, value);
  else line.style[property] = value;
  if (options.restoreFocus !== false) rememberInlineRange();
  recordInlineHistory(); syncInlineLineControls(); refreshInlineTypography(); classicEditor.notifyChange();
}
function setSelectionOrLineSize(value, options = {}) {
  if (!inlineDraft) return;
  if (inlineDraft.mode === 'ocr') {
    const parsed = Number.parseFloat(value || '');
    if (value && Number.isFinite(parsed) && parsed >= 8) {
      $('inlineEditorSize').value = String(Math.round(parsed));
      inlineDraft.sizeTouched = true;
      inlineDraft.initialAutoSize = false;
    } else {
      inlineDraft.sizeTouched = false;
      inlineDraft.initialAutoSize = true;
      $('inlineEditorSize').value = String(effectiveInlineSize({ ...inlineDraft.block, size: null }));
    }
    syncInlineLineControls(); refreshInlineTypography(); classicEditor.notifyChange();
    return;
  }
  if (hasInlineWordSelection()) { applyInlineWordStyle({ fontSize: value }, options); return; }
  setInlineLineStyle('fontSize', value, options);
}
function stepSelectionOrLineSize(delta) {
  if (!inlineDraft) return;
  if (inlineDraft.mode === 'ocr') {
    const cur = Number($('inlineEditorSize').value) || effectiveInlineSize(inlineDraft.block);
    const next = Math.max(8, Math.min(160, Math.round(cur + delta)));
    $('inlineLineSize').value = String(next);
    setSelectionOrLineSize(`${next}px`);
    return;
  }
  const currentInput = Number($('inlineLineSize').value);
  const inherited = inlineInheritedLogicalSize(inlineSelectionSpan(inlineDraft.range) || inlineDraft.range?.startContainer);
  const base = Number.isFinite(currentInput) && currentInput >= 8 ? currentInput : (inherited ?? effectiveInlineSize(inlineDraft.block));
  const next = Math.max(8, Math.min(160, Math.round(base + delta)));
  $('inlineLineSize').value = String(next);
  setSelectionOrLineSize(`${next}px`);
}
function toggleInlineCommand(cmd) {
  if (!inlineDraft || inlineDraft.mode === 'ocr') return;
  if (hasInlineWordSelection()) {
    const cur = inlineSelectionStyleState(inlineDraft.range);
    if (cmd === 'bold') applyInlineWordStyle({ fontWeight: cur.bold ? 'normal' : 'bold' });
    else if (cmd === 'italic') applyInlineWordStyle({ fontStyle: cur.italic ? 'normal' : 'italic' });
    else if (cmd === 'underline' || cmd === 'strikeThrough') {
      const nextUnderline = cmd === 'underline' ? !cur.underline : cur.underline;
      const nextStrike = cmd === 'strikeThrough' ? !cur.strike : cur.strike;
      applyInlineWordStyle({ textDecoration: [nextUnderline ? 'underline' : '', nextStrike ? 'line-through' : ''].filter(Boolean).join(' ') });
    }
    return;
  }
  const line = ensureInlineParagraph(); if (!line) return;
  if (cmd === 'bold') {
    const defaultBold = Typeset.blockStyle(overlayBlock(inlineDraft.block)).bold !== false;
    const isNormal = line.style.fontWeight === 'normal' || line.style.fontWeight === '400';
    const isBold = line.style.fontWeight === 'bold' || Number(line.style.fontWeight) >= 600;
    line.style.fontWeight = defaultBold ? (isNormal ? 'bold' : 'normal') : (isBold ? 'normal' : 'bold');
  } else if (cmd === 'italic') {
    line.style.fontStyle = line.style.fontStyle === 'italic' ? 'normal' : 'italic';
  } else if (cmd === 'underline' || cmd === 'strikeThrough') {
    const token = cmd === 'underline' ? 'underline' : 'line-through';
    const parts = new Set((line.style.textDecoration || '').split(/\s+/).filter((x) => x === 'underline' || x === 'line-through'));
    if (parts.has(token)) parts.delete(token); else parts.add(token);
    line.style.textDecoration = [...parts].join(' ');
  }
  rememberInlineRange(); recordInlineHistory(); syncInlineLineControls(); refreshInlineTypography(); classicEditor.notifyChange();
}
function resetInlineLineStyle() {
  if (hasInlineWordSelection()) {
    const field = $('inlineEditorField'); field.focus();
    const range = inlineDraft.range.cloneRange(); const selection = window.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
    const span = inlineSelectionSpan(range);
    if (span) {
      const parent = span.parentNode; const first = span.firstChild; const last = span.lastChild;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      span.remove();
      if (first && last) {
        const nextRange = document.createRange(); nextRange.setStartBefore(first); nextRange.setEndAfter(last);
        selection.removeAllRanges(); selection.addRange(nextRange);
      }
    } else {
      const fragment = range.extractContents();
      const unwrap = (rootNode) => {
        [...rootNode.querySelectorAll('span,b,strong,i,em,u,s,strike,del')].reverse().forEach((el) => el.replaceWith(...el.childNodes));
      };
      unwrap(fragment);
      const nodes = [...fragment.childNodes];
      range.insertNode(fragment);
      if (nodes.length) {
        const nextRange = document.createRange(); nextRange.setStartBefore(nodes[0]); nextRange.setEndAfter(nodes.at(-1));
        selection.removeAllRanges(); selection.addRange(nextRange);
      }
    }
    rememberInlineRange(); recordInlineHistory(); syncInlineLineControls(); refreshInlineTypography(); classicEditor.notifyChange();
    return;
  }
  const line = ensureInlineParagraph(); if (!line) return;
  delete line.dataset.logicalSize;
  ['textAlign', 'direction', 'fontSize', 'color', 'fontWeight', 'fontStyle', 'textDecoration'].forEach((key) => { line.style[key] = ''; });
  [...line.querySelectorAll('span,b,strong,i,em,u,s,strike,del')].reverse().forEach((el) => el.replaceWith(...el.childNodes));
  rememberInlineRange(); recordInlineHistory(); syncInlineLineControls(); refreshInlineTypography(); classicEditor.notifyChange();
}
function effectiveInlineSize(block) {
  const output = overlayBlock(block);
  if (Number(block.size) > 0) return Number(block.size);
  const bounds = clampedBoxOf(output);
  if (!hasRenderableText(output)) return 24;
  const base = overlaySize(output, bounds.x1 - bounds.x0, bounds.y1 - bounds.y0);
  if (!output._plainText && output.richHtml) {
    const words = Typeset.richHtmlWords(output.richHtml).filter((w) => String(w.t || '').trim());
    if (words.length && words.every((w) => Number.isFinite(w.size) && w.size === words[0].size)) {
      return Math.round(words[0].size);
    }
  }
  return base;
}
function effectiveInlineColor(block) {
  const output = overlayBlock(block); const style = Typeset.blockStyle(output);
  if (style.color) return style.color.toLowerCase();
  if (block.bg === 'none') return '#ffffff';
  if (block.bg === 'white') return '#0b0b0b';
  if (block.bg === 'black') return '#fafafa';
  try {
    const bitmap = state.editorBitmap;
    if (!bitmap?.width || !bitmap?.height) return '#ffffff';
    const bounds = boxOf(output);
    const sx = Math.max(0, Math.floor(bounds.x0) - 8); const sy = Math.max(0, Math.floor(bounds.y0) - 8);
    const ex = Math.min(bitmap.width, Math.ceil(bounds.x1) + 8); const ey = Math.min(bitmap.height, Math.ceil(bounds.y1) + 8);
    if (ex <= sx || ey <= sy) return '#0b0b0b';
    const sw = ex - sx; const sh = ey - sy;
    sampleScratchCanvas = sampleScratchCanvas || document.createElement('canvas');
    sampleScratchCanvas.width = sw; sampleScratchCanvas.height = sh;
    const context = sampleScratchCanvas.getContext('2d', { willReadFrequently: true }) || sampleScratchCanvas.getContext('2d');
    context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    const localBounds = { x0: bounds.x0 - sx, y0: bounds.y0 - sy, x1: bounds.x1 - sx, y1: bounds.y1 - sy };
    const bg = Typeset.sampleBg(context, localBounds, sw, sh);
    return 0.2126 * bg.r + 0.7152 * bg.g + 0.0722 * bg.b > 150 ? '#0b0b0b' : '#fafafa';
  } catch { return '#ffffff'; }
}
let lastInlineOpenClick = null;
function resolveVisualInlineCaret(field, clientX, clientY) {
  if (!field || typeof document.createTreeWalker !== 'function' || typeof document.createRange !== 'function') return null;
  const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
  const r = document.createRange();
  const lines = [];
  const addLineItem = (item) => {
    let line = lines.find((ln) => item.top < ln.bottom - 2 && item.bottom > ln.top + 2);
    if (!line) { line = { top: item.top, bottom: item.bottom, items: [] }; lines.push(line); }
    line.top = Math.min(line.top, item.top);
    line.bottom = Math.max(line.bottom, item.bottom);
    line.items.push(item);
  };
  let tn;
  while ((tn = walker.nextNode())) {
    const value = tn.nodeValue || '';
    if (!value.length) continue;
    const parent = tn.parentElement || field;
    const defaultRtl = (window.getComputedStyle?.(parent)?.direction || field.dir || 'rtl') === 'rtl';
    for (let k = 0; k < value.length; k += 1) {
      const ch = value[k];
      if (ch === '\r' || ch === '\u200c') continue;
      if (ch === '\n') {
        if (k === 0 || value[k - 1] === '\n') {
          r.setStart(tn, k); r.collapse(true);
          const cr = r.getClientRects?.()?.[0];
          if (cr && cr.height > 0 && !lines.some((ln) => cr.top < ln.bottom - 2 && cr.bottom > ln.top + 2)) {
            addLineItem({ node: tn, k, endK: k, left: cr.left, right: cr.right, top: cr.top, bottom: cr.bottom, startEdge: cr.left, endEdge: cr.right });
          }
        }
        continue;
      }
      r.setStart(tn, k); r.setEnd(tn, k + 1);
      const rr = r.getBoundingClientRect?.();
      if (!rr || !(rr.width > 0 && rr.height > 0)) continue;
      const isRtlChar = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/.test(ch) && !/[\u0660-\u0669\u06f0-\u06f9]/.test(ch) ? true
        : /[A-Za-z0-9\u0660-\u0669\u06f0-\u06f9\u00c0-\u02af\u0370-\u052f]/.test(ch) ? false : defaultRtl;
      addLineItem({
        node: tn, k, endK: (k + 1 < value.length && value[k + 1] === '\u200c') ? k + 2 : k + 1,
        left: rr.left, right: rr.right, top: rr.top, bottom: rr.bottom,
        startEdge: isRtlChar ? rr.right : rr.left,
        endEdge: isRtlChar ? rr.left : rr.right,
      });
    }
    if (value.endsWith('\n')) {
      r.setStart(tn, value.length); r.collapse(true);
      const cr = r.getClientRects?.()?.[0];
      if (cr && cr.height > 0 && !lines.some((ln) => cr.top < ln.bottom - 2 && cr.bottom > ln.top + 2)) {
        addLineItem({ node: tn, k: value.length, endK: value.length, left: cr.left, right: cr.right, top: cr.top, bottom: cr.bottom, startEdge: cr.left, endEdge: cr.right });
      }
    }
  }
  (field.querySelectorAll ? [...field.querySelectorAll('br')] : []).forEach((br) => {
    const parent = br.parentNode;
    if (!parent) return;
    const idx = [...parent.childNodes].indexOf(br);
    if (idx < 0) return;
    r.setStart(parent, idx); r.collapse(true);
    const cr = r.getClientRects?.()?.[0] || br.getBoundingClientRect?.();
    if (cr && cr.height > 0 && !lines.some((ln) => cr.top < ln.bottom - 2 && cr.bottom > ln.top + 2)) {
      addLineItem({ node: parent, k: idx, endK: idx, left: cr.left, right: cr.right, top: cr.top, bottom: cr.bottom, startEdge: cr.left, endEdge: cr.right });
    }
  });
  if (!lines.length) return null;
  let bestLine = lines[0], bestYDist = Infinity;
  for (const ln of lines) {
    const yDist = clientY < ln.top ? ln.top - clientY : clientY > ln.bottom ? clientY - ln.bottom : 0;
    if (yDist < bestYDist) { bestYDist = yDist; bestLine = ln; }
  }
  const direct = bestLine.items.filter((it) => clientX >= it.left - 0.5 && clientX <= it.right + 0.5);
  const pool = direct.length ? direct : bestLine.items;
  let bestHit = null, bestXDist = Infinity;
  for (const it of pool) {
    const dStart = Math.abs(clientX - it.startEdge);
    if (dStart < bestXDist) { bestXDist = dStart; bestHit = { node: it.node, offset: it.k }; }
    const dEnd = Math.abs(clientX - it.endEdge);
    if (dEnd < bestXDist) { bestXDist = dEnd; bestHit = { node: it.node, offset: it.endK }; }
  }
  return bestHit;
}
function inlineCaretPoint(field, clientX, clientY) {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const visual = resolveVisualInlineCaret(field, clientX, clientY);
  if (visual) return visual;
  const position = document.caretPositionFromPoint?.(clientX, clientY);
  if (position && field.contains(position.offsetNode)) return { node: position.offsetNode, offset: position.offset };
  const range = document.caretRangeFromPoint?.(clientX, clientY) || null;
  if (range && field.contains(range.startContainer)) return { node: range.startContainer, offset: range.startOffset };
  return null;
}
function expandInlineWordAtPoint(field, clientX, clientY) {
  const pt = inlineCaretPoint(field, clientX, clientY);
  if (!pt) return false;
  let { node, offset } = pt;
  while (node && node.nodeType === Node.ELEMENT_NODE && node.childNodes.length) {
    const idxChild = Math.min(Math.max(0, offset), node.childNodes.length - 1);
    node = node.childNodes[idxChild];
    offset = 0;
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) return false;
  const value = node.nodeValue || '';
  if (!value.trim()) return false;
  const isWordChar = (ch) => !!ch && /[\p{L}\p{N}\u200c_]/u.test(ch);
  let idx = Math.min(Math.max(0, offset), value.length);
  if (idx === value.length || !isWordChar(value[idx])) {
    if (idx > 0 && isWordChar(value[idx - 1])) idx -= 1;
    else return false;
  }
  let start = idx, end = idx + 1;
  while (start > 0 && isWordChar(value[start - 1])) start -= 1;
  while (end < value.length && isWordChar(value[end])) end += 1;
  const range = document.createRange();
  range.setStart(node, start); range.setEnd(node, end);
  const selection = window.getSelection?.();
  if (selection) { selection.removeAllRanges(); selection.addRange(range); }
  rememberInlineRange(); syncInlineLineControls();
  return true;
}
function placeInlineCaret(field, event) {
  if (!event || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
  const pt = inlineCaretPoint(field, event.clientX, event.clientY);
  if (!pt) return;
  const range = document.createRange(); range.setStart(pt.node, pt.offset); range.collapse(true);
  const selection = window.getSelection?.();
  if (selection) { selection.removeAllRanges(); selection.addRange(range); }
}
function openInlineEditor(block, clickEvent = null) {
  if (!block || !editorItem()) return;
  if (inlineDraft?.block === block && inlineDraft.mode === blockOverlayMode(block)) { classicEditor.focus(); return; }
  if (document.activeElement === $('inlineLineSize')) $('inlineLineSize').blur();
  if (!closeInlineEditor()) return;
  const mode = blockOverlayMode(block);
  if (mode === 'none') return;
  selectEditorBlock(block.id, true);
  const box = [...document.querySelectorAll('#editorBoxes .editor-box')].find((entry) => entry.dataset.id === String(block.id));
  if (!box) { toast('ابتدا نمایش این کادر را فعال کنید.', true); return; }

  const field = $('inlineEditorField'); const direction = mode === 'ocr' ? 'ltr' : (block.dir === 'ltr' ? 'ltr' : 'rtl');
  const hasMarks = mode !== 'ocr' && !block.richHtml && !!Typeset.hasInlineMarks?.(block.tr || '') && typeof Typeset.inlineMarksToHtml === 'function';
  const originalHtml = mode === 'ocr' ? plainToHtml(block.text || '') : (block.richHtml || (hasMarks ? sanitizeHtml(Typeset.inlineMarksToHtml(block.tr || '')) : plainToHtml(block.tr || '')));
  const draftKey = `comic-studio-draft:${encodeURIComponent(state.project.id)}:${encodeURIComponent(editorItem().id)}:${encodeURIComponent(block.id)}:${mode}`;
  setInlineDockDisabled(false);
  classicEditor.setPlainMode(mode === 'ocr');
  field.removeAttribute('style'); field.dir = direction; field.style.direction = direction;
  $('inlineEditorTitle').textContent = `کادر ${block.id} · ویرایش مستقیم ${mode === 'ocr' ? 'متن اصلی' : 'ترجمه'} · ذخیرهٔ خودکار`;
  $('inlineEditorCancel').classList.add('hidden');
  $('inlineLineTools').classList.remove('hidden');
  if ($('inlineLineSize')) $('inlineLineSize').value = '';
  ['inlineLineSize', 'inlineSizeUp', 'inlineSizeDown'].forEach((id) => { const el = $(id); if (el) el.disabled = false; });
  if ($('inlineLineReset')) $('inlineLineReset').disabled = mode === 'ocr';
  $('inlineEditorDirection').value = direction; $('inlineEditorDirection').disabled = mode === 'ocr';
  $('inlineEditorAlign').value = mode === 'ocr' ? overlayBlock(block).align : (block.align || 'right');
  const verticalAlignTouched = ['top', 'middle', 'bottom'].includes(block.verticalAlign);
  $('inlineVerticalAlign').value = ['top', 'bottom'].includes(block.verticalAlign) ? block.verticalAlign : 'middle';
  const initialAutoSize = !(Number.isFinite(+block.size) && +block.size > 0);
  const initialSizeValue = String(effectiveInlineSize(block));
  $('inlineEditorSize').value = initialSizeValue;
  $('inlineEditorColor').value = effectiveInlineColor(block);

  inlineDraft = { block, mode, snapshot: inlineBlockSnapshot(block), html: originalHtml,
    dir: $('inlineEditorDirection').value, align: $('inlineEditorAlign').value,
    verticalAlign: $('inlineVerticalAlign').value, verticalAlignTouched, size: initialSizeValue,
    initialAutoSize, initialSizeValue, sizeTouched: false,
    color: block.color || null, originalColor: block.color || null,
    range: null, history: [], historyIndex: -1, muteHistory: false, conflictReported: false };
  const draftRestore = classicEditor.setContext(draftKey, originalHtml, inlineDraft.snapshot);
  if (draftRestore && typeof draftRestore.then === 'function') {
    draftRestore.then((restored) => {
      if (inlineDraft?.block !== block) return;
      if (restored) { recordInlineHistory(); syncInlineLineControls(); }
      classicEditor.focus();
    }).catch(() => {});
  }
  const background = block.bg || 'auto';
  box.style.setProperty('--editing-bg', background === 'white' ? '#fff' : background === 'black' ? '#101010' : 'var(--surface)');
  box.style.setProperty('--editing-fg', background === 'white' ? '#202020' : background === 'black' ? '#fff' : 'var(--text)');
  box.classList.add('editing'); classicEditor.attachField(box);

  inlineEditSession = window.createInlineEditSession({
    block, mode, snapshot: inlineBlockSnapshot, getBaseline: () => inlineDraft?.snapshot,
    read: () => {
      const textVal = classicEditor.getText();
      const htmlVal = mode === 'ocr' ? '' : classicEditor.getHTML();
      const normNbsp = (s) => String(s || '').replace(/&nbsp;|\u00a0/g, ' ');
      const hasMultiSpace = /(?: |&nbsp;|\u00a0){2,}/.test(htmlVal);
      const plainEquiv = mode !== 'ocr' && !block.richHtml && !hasMarks && !hasMultiSpace && normNbsp(htmlVal) === normNbsp(sanitizeHtml(plainToHtml(textVal)));
      const rawSize = $('inlineEditorSize').value.trim();
      const keepAuto = !!(inlineDraft?.initialAutoSize && !inlineDraft?.sizeTouched && rawSize === inlineDraft?.initialSizeValue);
      const keepLegacyVertical = !inlineDraft?.verticalAlignTouched && !['top', 'middle', 'bottom'].includes(block.verticalAlign);
      return { text: textVal, richHtml: plainEquiv ? '' : htmlVal,
        dir: $('inlineEditorDirection').value, align: $('inlineEditorAlign').value,
        verticalAlign: keepLegacyVertical ? undefined : $('inlineVerticalAlign').value,
        size: keepAuto ? null : (rawSize ? Number(rawSize) : null), color: inlineDraft?.color ?? null };
    },
    onCommit: (savedBlock, revision) => {
      inlineDraft.snapshot = revision;
      inlineDraft.html = mode === 'ocr' ? plainToHtml(savedBlock.text || '') : (savedBlock.richHtml || plainToHtml(savedBlock.tr || ''));
      inlineDraft.dir = $('inlineEditorDirection').value; inlineDraft.align = $('inlineEditorAlign').value;
      inlineDraft.verticalAlign = $('inlineVerticalAlign').value;
      inlineDraft.initialAutoSize = !(Number.isFinite(+savedBlock.size) && +savedBlock.size > 0);
      if (inlineDraft.initialAutoSize && !inlineDraft.sizeTouched && document.activeElement !== $('inlineEditorSize')) {
        const nextShown = String(effectiveInlineSize(savedBlock));
        $('inlineEditorSize').value = nextShown;
        inlineDraft.initialSizeValue = nextShown;
      }
      inlineDraft.size = $('inlineEditorSize').value;
      inlineDraft.originalColor = inlineDraft.color = savedBlock.color || null; inlineDraft.conflictReported = false;
      $('inlineEditorCancel').classList.add('hidden');
      buildBlockList(); scheduleEditorCanvasDraw(); scheduleSave();
    },
    onConflict: () => {
      if (!inlineDraft.conflictReported) toast('این کادر هم‌زمان در جای دیگری تغییر کرده؛ نسخهٔ پروژه حفظ شد.', true);
      inlineDraft.conflictReported = true; $('inlineEditorCancel').classList.remove('hidden');
    },
  });
  $('inlineEditor').classList.remove('hidden', 'is-idle');
  $('inlineEditor').classList.toggle('plain-mode', mode === 'ocr');
  syncVerticalAlignButtons();
  positionInlineEditor(); classicEditor.focus();
  placeInlineCaret(field, clickEvent); rememberInlineRange(); recordInlineHistory(); syncInlineLineControls();
}
function autoApplyInlineDraft() {
  if (!inlineDraft || !inlineEditSession) return true;
  const committed = inlineEditSession.commit();
  if (!committed) $('inlineEditorCancel').classList.remove('hidden');
  return committed;
}
function applyInlineEditor() { return closeInlineEditor(); }

function editorSelectedKeys() {
  const item = editorItem(); const valid = new Set((item?.blocks || []).map((block) => String(block.id)));
  return (state.selectedBlockIds || []).map(String).filter((key) => valid.has(key));
}
function selectedEditorBlocks() {
  const item = editorItem(); if (!item) return [];
  const byId = new Map((item.blocks || []).map((block) => [String(block.id), block]));
  return editorSelectedKeys().map((key) => byId.get(key)).filter(Boolean);
}
function nonEmptyLines(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
function isBlockSplittable(block) {
  if (!block) return false;
  const liveText = inlineDraft?.block === block && inlineDraft.mode === 'ocr' ? (classicEditor?.getText?.() ?? block.text) : block.text;
  const liveTr = inlineDraft?.block === block && inlineDraft.mode !== 'ocr' ? (classicEditor?.getText?.() ?? block.tr) : block.tr;
  const hasSource = Array.isArray(block.sourceLines) && block.sourceLines.length >= 2;
  const hasTr = Boolean(String(liveTr || '').trim() || String(block.richHtml || '').trim());
  if (!hasTr) {
    return (hasSource && String(liveText || '') === joinedOcrText(block.sourceLines)) || nonEmptyLines(liveText).length >= 2;
  }
  if (nonEmptyLines(liveTr).length >= 2) return true;
  return hasSource && block.sourceLines.every((s) => String(s.tr || '').trim())
    && String(liveTr || '').trim() === block.sourceLines.map((s) => String(s.tr || '').trim()).join(' ');
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
  const selectedBlocks = selectedEditorBlocks();
  $('editorMergeText')?.classList.toggle('is-ready', selectedBlocks.length >= 2);
  $('editorSplitText')?.classList.toggle('is-ready', selectedBlocks.some((block) => isBlockSplittable(block)));
  if ($('editorSelectionStatus')) $('editorSelectionStatus').textContent = selected.size ? `${selected.size.toLocaleString('fa-IR')} متن انتخاب شده · مرجع: متن ${state.selectedBlockIds[0]}` : 'متنی انتخاب نشده';
  syncVerticalAlignButtons();
}
function selectEditorBlock(blockId, scroll = true, additive = false) {
  const key = String(blockId); const selected = new Set(editorSelectedKeys());
  const alreadyActive = selected.size === 1 && selected.has(key) && String(state.activeBlockId) === key;
  if (additive) { if (selected.has(key)) selected.delete(key); else selected.add(key); }
  else { selected.clear(); selected.add(key); }
  state.selectedBlockIds = [...selected]; state.activeBlockId = selected.has(key) ? key : [...selected].at(-1) || null;
  updateEditorSelection();
  const selectedCard = [...document.querySelectorAll('#blockList .block-card')].find((card) => card.dataset.id === String(state.activeBlockId));
  // Do not focus the sidebar field: the user can keep typing exactly where they clicked on the image.
  if (scroll && selectedCard && !alreadyActive) {
    // Scroll only the sidebar, not the dialog/page or the image underneath the pointer.
    const side = document.querySelector('.editor-side');
    if (side) {
      const viewport = side.getBoundingClientRect(); const card = selectedCard.getBoundingClientRect();
      if (card.top < viewport.top) side.scrollTop -= viewport.top - card.top;
      else if (card.bottom > viewport.bottom) side.scrollTop += card.bottom - viewport.bottom;
    }
  }
}
function selectAllEditorBlocks() {
  if (inlineDraft && !closeInlineEditor()) return;
  const item = editorItem(); if (!item) return;
  state.selectedBlockIds = (item.blocks || []).map((block) => String(block.id));
  if (!state.selectedBlockIds.includes(String(state.activeBlockId))) state.activeBlockId = state.selectedBlockIds.at(-1) || null;
  updateEditorSelection();
}
function clearEditorSelection() { if (inlineDraft && !closeInlineEditor()) return; state.selectedBlockIds = []; state.activeBlockId = null; updateEditorSelection(); }
function joinedOcrText(blocks) {
  return blocks.map((block) => String(block.text || '').trim().replace(/\s+/g, ' ')).filter(Boolean).join(' ');
}
function mergeSelectedText() {
  if (inlineDraft && !closeInlineEditor()) return;
  const item = editorItem(); const blocks = selectedEditorBlocks();
  if (!item || blocks.length < 2) { toast('برای ادغام، حداقل دو کادر را انتخاب کنید (با Ctrl+کلیک روی کادرها)', true); return; }
  const ordered = [...blocks].sort((a, b) => boxOf(a).y0 - boxOf(b).y0 || boxOf(a).x0 - boxOf(b).x0);
  const x0 = Math.min(...ordered.map((b) => b.x0)); const y0 = Math.min(...ordered.map((b) => b.y0));
  const x1 = Math.max(...ordered.map((b) => b.x1)); const y1 = Math.max(...ordered.map((b) => b.y1));
  const snapshots = JSON.parse(JSON.stringify(ordered));
  const hasTr = snapshots.some((b) => String(b.tr || '').trim() || String(b.richHtml || '').trim());
  const mergedTr = hasTr ? snapshots.map((b) => String(b.tr || '').trim()).filter(Boolean).join('\n') : '';
  const mergedRichHtml = hasTr && snapshots.some((b) => String(b.richHtml || '').trim())
    ? sanitizeHtml(snapshots.filter((b) => String(b.tr || '').trim() || String(b.richHtml || '').trim())
      .map((b) => String(b.richHtml || '').trim() || plainToHtml(String(b.tr || '').trim())).join('<br>'))
    : '';
  const merged = { ...snapshots[0], text: joinedOcrText(snapshots), tr: mergedTr, richHtml: mergedRichHtml, x0, y0, x1, y1,
    polygon: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], sourceLines: snapshots };
  if (ordered.some((b) => Number.isFinite(b.tx0) || Number.isFinite(b.ty0) || Number.isFinite(b.tx1) || Number.isFinite(b.ty1))) {
    merged.tx0 = Math.min(...ordered.map((b) => boxOf(b).x0));
    merged.ty0 = Math.min(...ordered.map((b) => boxOf(b).y0));
    merged.tx1 = Math.max(...ordered.map((b) => boxOf(b).x1));
    merged.ty1 = Math.max(...ordered.map((b) => boxOf(b).y1));
  } else {
    delete merged.tx0; delete merged.ty0; delete merged.tx1; delete merged.ty1;
  }
  const selected = new Set(blocks.map((block) => String(block.id)));
  const firstIndex = item.blocks.findIndex((block) => selected.has(String(block.id)));
  item.blocks = item.blocks.filter((block) => !selected.has(String(block.id)));
  item.blocks.splice(firstIndex, 0, merged);
  state.selectedBlockIds = [String(merged.id)]; state.activeBlockId = String(merged.id);
  buildBlockList(); drawEditor(); scheduleSave();
  toast('کادرهای انتخابی ادغام شدند');
}
function buildProportionalSplitBlocks(block, item, ocrLines, trLines, nextIdRef) {
  const count = trLines.length >= 2 ? trLines.length : ocrLines.length;
  const b = boxOf(block);
  const totalH = Math.max(count * 16, b.y1 - b.y0);
  const gap = totalH >= count * 26 ? 2 : 0;
  return Array.from({ length: count }, (_, idx) => {
    const sy0 = Math.round(b.y0 + (totalH * idx) / count + (idx > 0 ? gap / 2 : 0));
    const sy1 = Math.max(sy0 + 12, Math.round(b.y0 + (totalH * (idx + 1)) / count - (idx + 1 < count ? gap / 2 : 0)));
    const clone = JSON.parse(JSON.stringify(block));
    clone.id = idx === 0 ? block.id : ++nextIdRef.maxId;
    clone.text = ocrLines.length === count ? ocrLines[idx] : (idx === 0 ? String(block.text || '') : '');
    clone.tr = trLines.length === count ? trLines[idx] : '';
    clone.richHtml = '';
    clone.x0 = b.x0; clone.y0 = sy0; clone.x1 = b.x1; clone.y1 = sy1;
    clone.polygon = [[b.x0, sy0], [b.x1, sy0], [b.x1, sy1], [b.x0, sy1]];
    clone.lineH = Math.max(14, Math.min(block.lineH || 24, Math.round((sy1 - sy0) * 0.8)));
    delete clone.tx0; delete clone.ty0; delete clone.tx1; delete clone.ty1; delete clone.sourceLines;
    return clone;
  });
}
function splitSingleEditorBlock(block, item, nextIdRef) {
  const hasSource = Array.isArray(block.sourceLines) && block.sourceLines.length >= 2;
  const hasTr = Boolean(String(block.tr || '').trim() || String(block.richHtml || '').trim());
  const trLines = nonEmptyLines(block.tr);
  const ocrLines = nonEmptyLines(block.text);
  if (!hasTr) {
    if (hasSource && String(block.text || '') === joinedOcrText(block.sourceLines)) {
      return JSON.parse(JSON.stringify(block.sourceLines));
    }
    if (hasSource && ocrLines.length === block.sourceLines.length) {
      const originals = JSON.parse(JSON.stringify(block.sourceLines));
      originals.forEach((entry, idx) => { entry.text = ocrLines[idx]; entry.tr = ''; entry.richHtml = ''; });
      return originals;
    }
    if (ocrLines.length >= 2) return buildProportionalSplitBlocks(block, item, ocrLines, [], nextIdRef);
    return null;
  }
  if (hasSource && trLines.length === block.sourceLines.length) {
    const originals = JSON.parse(JSON.stringify(block.sourceLines));
    originals.forEach((entry, idx) => {
      ['dir', 'align', 'size', 'verticalAlign', 'color', 'bg'].forEach((k) => { if (entry[k] === undefined && block[k] !== undefined) entry[k] = block[k]; });
      const prevTr = String(entry.tr || '').trim();
      entry.tr = trLines[idx];
      if (prevTr !== trLines[idx]) entry.richHtml = '';
      if (ocrLines.length === originals.length) entry.text = ocrLines[idx];
    });
    return originals;
  }
  if (hasSource && trLines.length === 1 && block.sourceLines.every((s) => String(s.tr || '').trim())
    && trLines[0] === block.sourceLines.map((s) => String(s.tr || '').trim()).join(' ')) {
    return JSON.parse(JSON.stringify(block.sourceLines));
  }
  if (trLines.length >= 2) return buildProportionalSplitBlocks(block, item, ocrLines, trLines, nextIdRef);
  return null;
}
function splitSelectedText() {
  if (inlineDraft && !closeInlineEditor()) return;
  const item = editorItem(); const blocks = selectedEditorBlocks();
  if (!item || !blocks.length) { toast('ابتدا کادر موردنظر برای جداکردن را انتخاب کنید', true); return; }
  const nextIdRef = { maxId: Math.max(0, ...(item.blocks || []).map((entry) => Number(entry.id) || 0)) };
  const newSelection = [];
  let splitCount = 0;
  blocks.forEach((block) => {
    const replacements = splitSingleEditorBlock(block, item, nextIdRef);
    if (!replacements) { newSelection.push(String(block.id)); return; }
    const index = item.blocks.indexOf(block);
    if (index < 0) return;
    item.blocks.splice(index, 1, ...replacements);
    replacements.forEach((entry) => newSelection.push(String(entry.id)));
    splitCount += 1;
  });
  if (!splitCount) {
    const hasOneLineTr = blocks.some((b) => String(b.tr || '').trim() && nonEmptyLines(b.tr).length < 2);
    toast(hasOneLineTr
      ? 'متن ترجمه یک‌خطی است؛ ابتدا در جای موردنظر با کلید Enter خط را بشکنید و سپس «جداکردن خط‌ها» را بزنید'
      : 'این کادر خط جداشدنی ندارد؛ برای جداکردن، ابتدا با Enter خط‌ها را جدا کنید', true);
    return;
  }
  state.selectedBlockIds = newSelection; state.activeBlockId = newSelection[0] || null;
  buildBlockList(); drawEditor(); scheduleSave();
  toast('خط‌های کادر با موفقیت به کادرهای جداگانه تبدیل شدند');
}
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
  if (inlineDraft?.block === block && !closeInlineEditor()) {
    const card = [...document.querySelectorAll('#blockList .block-card')].find((entry) => entry.dataset.id === String(block.id));
    const toggle = card?.querySelector('[data-visibility]');
    if (toggle) toggle.checked = !!block.enabled;
    return;
  }
  block.enabled = !!visible;
  const card = [...document.querySelectorAll('#blockList .block-card')].find((entry) => entry.dataset.id === String(block.id));
  card?.classList.toggle('disabled', !block.enabled);
  const toggle = card?.querySelector('[data-visibility]'); if (toggle) toggle.checked = block.enabled;
  renderEditorBoxes(); scheduleEditorCanvasDraw(); scheduleSave();
}
function editOcrText(block) {
  if (!block?.enabled) { toast('برای ویرایش متن انگلیسی، ابتدا نمایش همان کادر را فعال کنید.', true); return; }
  if (currentOverlayMode() === 'none') setOverlayMode('ocr');
  if (blockTextMode(block) !== 'ocr') setBlockTextMode(block, 'ocr');
  openInlineEditor(block);
}
function setBlockTextMode(block, mode) {
  if (inlineDraft?.block === block && !closeInlineEditor()) {
    const card = [...document.querySelectorAll('#blockList .block-card')].find((entry) => entry.dataset.id === String(block.id));
    const selector = card?.querySelector('[data-text-mode]'); if (selector) selector.value = blockTextMode(block);
    return;
  }
  block.textMode = normalizeBlockTextMode(mode);
  const card = [...document.querySelectorAll('#blockList .block-card')].find((entry) => entry.dataset.id === String(block.id));
  const selector = card?.querySelector('[data-text-mode]'); if (selector) selector.value = block.textMode;
  renderEditorBoxes(); scheduleEditorCanvasDraw(); scheduleSave();
}
function renderEditorBoxes() {
  const item = editorItem(); const layer = $('editorBoxes'); if (!item || !layer) return;
  const mode = currentOverlayMode(); const selected = new Set(editorSelectedKeys());
  const existing = new Map([...layer.children].map((element) => [element.dataset.id, element]));
  const visible = new Set();
  (item.blocks || []).forEach((block) => {
    const display = overlayBlock(block, mode); const displayMode = blockOverlayMode(block, mode);
    const key = String(block.id);
    if (!display.enabled || displayMode === 'none') return;
    visible.add(key);
    const box = clampedBoxOf(display); const scale = state.editorScale;
    let el = existing.get(key);
    if (!el) {
      el = document.createElement('div'); el.className = 'editor-box'; el.dataset.id = key;
      const move = document.createElement('button'); move.type = 'button'; move.className = 'box-move'; move.textContent = `⠿ متن ${block.id}`; move.dataset.move = '1'; move.title = 'برای جابه‌جایی کادر بکشید'; move.setAttribute('aria-label', `جابه‌جایی کادر متن ${block.id}`);
      const visibility = document.createElement('button'); visibility.type = 'button'; visibility.className = 'box-visibility'; visibility.textContent = '👁'; visibility.title = 'پنهان‌کردن فقط همین خط روی تصویر'; visibility.setAttribute('aria-label', `پنهان‌کردن متن ${block.id} روی تصویر`); visibility.addEventListener('pointerdown', (event) => event.stopPropagation()); visibility.addEventListener('click', (event) => { event.stopPropagation(); setBlockVisibility(el._block, false); });
      const language = document.createElement('button'); language.type = 'button'; language.className = 'box-language'; language.setAttribute('aria-label', `تغییر زبان متن ${block.id} روی تصویر`); language.addEventListener('pointerdown', (event) => event.stopPropagation()); language.addEventListener('click', (event) => { event.stopPropagation(); setBlockTextMode(el._block, el.dataset.mode === 'ocr' ? 'translation' : 'ocr'); });
      el.append(move, visibility, language);
      ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach((dir) => { const handle = document.createElement('i'); handle.className = `resize-handle ${dir}`; handle.dataset.dir = dir; el.appendChild(handle); });
      el.addEventListener('pointerdown', (event) => {
        const activeBlock = el._block; const additive = event.ctrlKey || event.metaKey; const dragTarget = event.target.closest('[data-move],[data-dir]') || event.target === el;
        if (inlineDraft && additive) {
          if (!closeInlineEditor()) return;
        } else if (inlineDraft && inlineDraft.block !== activeBlock && !additive) {
          if (!dragTarget || !closeInlineEditor()) return;
        }
        if (!(dragTarget && !additive && editorSelectedKeys().includes(String(activeBlock.id)))) selectEditorBlock(activeBlock.id, true, additive);
        startBoxDrag(event, activeBlock, el);
      });
      layer.appendChild(el);
    }
    // Reuse the actual editing node so zoom, redraw and other controls do not destroy the caret or undo history.
    el._block = block;
    el.classList.toggle('selected', selected.has(key)); el.classList.toggle('active', String(state.activeBlockId) === key); el.classList.toggle('empty', !hasRenderableText(display));
    el.style.left = `${box.x0 * scale}px`; el.style.top = `${box.y0 * scale}px`; el.style.width = `${(box.x1 - box.x0) * scale}px`; el.style.height = `${(box.y1 - box.y0) * scale}px`;
    const language = el.querySelector('.box-language'); language.dataset.language = displayMode; language.textContent = displayMode === 'ocr' ? 'EN' : 'فا'; language.title = displayMode === 'ocr' ? 'این متن انگلیسی/OCR است؛ برای نمایش فارسی کلیک کنید' : 'این متن فارسی/ترجمه است؛ برای نمایش انگلیسی کلیک کنید';
    let text = el.querySelector('.editor-box-text');
    if (!text || el.dataset.mode !== displayMode || text._block !== block) {
      if (text) text.remove();
      text = document.createElement('div'); text.className = 'editor-box-text'; text.contentEditable = 'false'; text._block = block;
      text.setAttribute('aria-label', `ویرایش متن ${block.id} روی تصویر`); text.setAttribute('role', 'button'); text.tabIndex = 0;
      text.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey) return;
        event.preventDefault(); event.stopPropagation();
        const beforeBox = el.getBoundingClientRect();
        openInlineEditor(el._block, null);
        const field = $('inlineEditorField');
        if (!inlineDraft || inlineDraft.block !== el._block || !el.contains(field)) return;
        const afterBox = el.getBoundingClientRect();
        const adjX = event.clientX + (afterBox.left - beforeBox.left);
        const adjY = event.clientY + (afterBox.top - beforeBox.top);
        placeInlineCaret(field, { clientX: adjX, clientY: adjY });
        rememberInlineRange(); recordInlineHistory(); syncInlineLineControls();
        if (event.detail >= 2) {
          lastInlineOpenClick = null;
          expandInlineWordAtPoint(field, adjX, adjY);
          return;
        }
        lastInlineOpenClick = { time: performance.now(), x: adjX, y: adjY };
        const originX = adjX, originY = adjY;
        const start = inlineCaretPoint(field, originX, originY);
        if (!start || !window.addEventListener) return;
        const onMove = (moveEvent) => {
          if (moveEvent.buttons !== undefined && !(moveEvent.buttons & 1)) { cleanup(); return; }
          if (Math.hypot(moveEvent.clientX - originX, moveEvent.clientY - originY) < 2) return;
          const cur = inlineCaretPoint(field, moveEvent.clientX, moveEvent.clientY);
          if (!cur) return;
          const sel = window.getSelection?.();
          if (sel?.setBaseAndExtent) sel.setBaseAndExtent(start.node, start.offset, cur.node, cur.offset);
          else if (sel) {
            const r = document.createRange();
            try { r.setStart(start.node, start.offset); r.setEnd(cur.node, cur.offset); } catch {}
            if (r.collapsed && (cur.node !== start.node || cur.offset !== start.offset)) {
              try { r.setStart(cur.node, cur.offset); r.setEnd(start.node, start.offset); } catch {}
            }
            sel.removeAllRanges(); sel.addRange(r);
          }
          rememberInlineRange(); syncInlineLineControls();
        };
        const cleanup = () => {
          window.removeEventListener('pointermove', onMove, true);
          window.removeEventListener('pointerup', cleanup, true);
          window.removeEventListener('pointercancel', cleanup, true);
          rememberInlineRange(); syncInlineLineControls();
        };
        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', cleanup, true);
        window.addEventListener('pointercancel', cleanup, true);
      });
      text.addEventListener('click', (event) => { event.preventDefault(); if (!event.ctrlKey && !event.metaKey) { event.stopPropagation(); openInlineEditor(el._block, event); } });
      text.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openInlineEditor(el._block); } });
      text.innerHTML = plainToHtml(display.tr || '');
      el.insertBefore(text, el.querySelector('.resize-handle')); el.dataset.mode = displayMode;
    } else if (document.activeElement !== text) {
      const html = plainToHtml(display.tr || '');
      if (text.innerHTML !== html) text.innerHTML = html;
    }
    styleRichElement(text, display, scale, true);
  });
  existing.forEach((el, key) => { if (!visible.has(key)) el.remove(); });
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
    if (inlineDraft?.block === block) positionInlineEditor();
    scheduleEditorCanvasDraw(); changed = true;
  };
  const stop = () => {
    if (finished) return; finished = true;
    el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', stop); el.removeEventListener('pointercancel', stop); el.removeEventListener('lostpointercapture', stop);
    el.classList.remove('dragging'); if (el.hasPointerCapture?.(event.pointerId)) el.releasePointerCapture(event.pointerId);
    if (changed) { if (inlineDraft?.block === block) refreshInlineTypography(); drawEditor(); scheduleSave(); }
  };
  el.addEventListener('pointermove', move); el.addEventListener('pointerup', stop); el.addEventListener('pointercancel', stop); el.addEventListener('lostpointercapture', stop);
}
async function runSingleBlockTranslation(task) {
  const controller = new AbortController();
  translationAbortController = controller; translationCancelledByUser = false; translationClosingNormally = false;
  translationRunning = true; $('cancelTranslationBtn')?.classList.remove('hidden');
  $('translationStatus').textContent = 'در حال ترجمهٔ دوبارهٔ یک کادر…';
  $('copyTranslationError').classList.add('hidden');
  showDialog('translationDialog');
  try {
    const out = await runJob('در حال ترجمهٔ دوبارهٔ یک کادر…', () => task(controller.signal), 'translationProgress');
    translationClosingNormally = true;
    return out;
  } catch (error) {
    if (translationCancelledByUser || error?.cancelled || error?.name === 'AbortError') {
      toast('پنجرهٔ ترجمه بسته شد و عملیات متوقف گردید');
      return { cancelled: true };
    }
    throw error;
  } finally {
    if (translationAbortController === controller) translationAbortController = null;
    translationClosingNormally = false; translationRunning = false; $('cancelTranslationBtn')?.classList.add('hidden');
    dismissJobCancelModal('translation');
    if ($('translationDialog').open) closeDialog('translationDialog');
  }
}
function applyTranslatedBlockDefaults(block, text) {
  block.tr = text;
  block.richHtml = '';
  block.align = 'justify';
  block.size = 12;
  block.verticalAlign = 'top';
}
async function retranslateBlock(block) {
  if (inlineDraft?.block === block && !closeInlineEditor()) return;
  const text = block.text || ''; const snapshot = inlineBlockSnapshot(block);
  const provider = state.ai?.provider || 'free'; const sourceLanguage = $('ocrLanguage').value;
  try {
    const projectId = state.project.id;
    const request = { text, source_lines: block.sourceLines || null, source_language: sourceLanguage, provider };
    if (provider === 'free') {
      const refresh = () => api('/api/translate-text/context-preview', jsonOptions('POST', { ...request, skill: '', summary: '' }));
      const preview = await refresh();
      showTranslationRequestPreview(preview, async accepted => {
        if (inlineDraft?.block === block || inlineBlockSnapshot(block) !== snapshot) { toast('این کادر تغییر کرده است؛ ترجمهٔ قبلی حفظ شد. دوباره تلاش کنید.', true); return; }
        const result = await runSingleBlockTranslation((signal) => api('/api/translate-text/context', { ...jsonOptions('POST', { ...request, skill:'', summary:'', confirmation: accepted.signature }), signal }));
        if (!result || result.cancelled) return;
        if (inlineDraft?.block === block || inlineBlockSnapshot(block) !== snapshot) { toast('در حین ترجمه کادر تغییر کرد؛ نتیجه جایگزین نشد.', true); return; }
        applyTranslatedBlockDefaults(block, result.text); buildBlockList(); drawEditor(); scheduleSave();
      }, refresh);
      return;
    }
    const profiles = state.ai?.providers?.[provider]?.profiles?.filter(p => p.hasApiKey) || [];
    const limit = profiles.length ? Math.min(...profiles.map(p => p.source_limit ?? 1000)) : 1000;
    const skillLimit = Math.floor(limit * (state.ai?.skill_percent ?? 15) / 100);
    const contextLimit = Math.floor(limit * (state.ai?.context_percent ?? 15) / 100);
    const skill = savedTranslationSkill(projectId) ?? 'ترجمه را روان و طبیعی و متناسب با لحن شخصیت‌ها بنویس؛ نام‌ها، اعداد و آواها را با دقت حفظ کن.';
    const summary = state.project._aiStorySummary || '';
    const safeSkill = Array.from(skill).length <= skillLimit ? skill : '';
    const safeSummary = Array.from(summary).length <= contextLimit ? summary : '';
    const refresh = (nextSkill, nextSummary) => api('/api/translate-text/context-preview', jsonOptions('POST', { ...request, skill: nextSkill, summary: nextSummary }));
    const preview = await refresh(safeSkill, safeSummary);
    if (safeSkill !== skill) preview.displaySkill = skill;
    if (safeSummary !== summary) preview.displaySummary = summary;
    showTranslationRequestPreview(preview, async (accepted, repair = null) => {
      if (inlineDraft?.block === block || inlineBlockSnapshot(block) !== snapshot) { toast('این کادر تغییر کرده است؛ ترجمهٔ قبلی حفظ شد. دوباره تلاش کنید.', true); return; }
      rememberTranslationSkill(projectId, accepted);
      const result = await runSingleBlockTranslation((signal) => api('/api/translate-text/context', { ...jsonOptions('POST', { ...request, skill: accepted.skill, summary: accepted.summary, confirmation: accepted.signature, ...(repair || {}) }), signal }));
      if (!result || result.cancelled) return;
      if (inlineDraft?.block === block || inlineBlockSnapshot(block) !== snapshot) { toast('در حین ترجمه کادر تغییر کرد؛ نتیجه جایگزین نشد.', true); return; }
      applyTranslatedBlockDefaults(block, result.text); buildBlockList(); drawEditor(); scheduleSave();
    }, refresh);
  } catch (error) { toast(`ساخت پیش‌نمایش ترجمه ممکن نبود: ${error.message || error}`, true); }
}
async function copyBlockText(text) {
  if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
  else { const temp = document.createElement('textarea'); temp.value = text; temp.style.position = 'fixed'; temp.style.opacity = '0'; document.body.appendChild(temp); try { temp.select(); if (!document.execCommand('copy')) throw new Error('مرورگر اجازهٔ کپی نداد'); } finally { temp.remove(); } }
  toast('کپی شد');
}
function buildBlockList() {
  const item = editorItem(); const list = $('blockList'); list.textContent = ''; const selected = new Set(editorSelectedKeys()); if (!item?.blocks?.length) { list.textContent = 'ابتدا OCR را روی این تصویر اجرا کنید.'; updateEditorSelection(); return; }
  item.blocks.forEach((block) => {
    const card = document.createElement('section'); card.className = `block-card${block.enabled ? '' : ' disabled'}${selected.has(String(block.id)) ? ' selected' : ''}${String(state.activeBlockId) === String(block.id) ? ' active' : ''}`; card.dataset.id = block.id; card.addEventListener('pointerdown', (event) => { const additive = event.ctrlKey || event.metaKey; if (additive && inlineDraft && !closeInlineEditor()) return; selectEditorBlock(block.id, false, additive); });
    const head = document.createElement('div'); head.className = 'block-head'; const enabledLabel = document.createElement('label'); const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = !!block.enabled; enabled.dataset.visibility = 'sidebar'; enabled.setAttribute('aria-label', `نمایش متن ${block.id} روی تصویر`); enabledLabel.append(enabled, document.createTextNode(` نمایش متن ${block.id} روی تصویر · اطمینان ${Math.round(block.conf || 0)}٪`)); head.appendChild(enabledLabel);
    const bg = document.createElement('select'); [['auto', 'پس‌زمینه خودکار'], ['white', 'سفید'], ['black', 'مشکی'], ['none', 'بدون پاک‌کردن']].forEach(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; bg.appendChild(option); }); bg.value = block.bg || 'auto'; head.appendChild(bg);
    const languageRow = document.createElement('div'); languageRow.className = 'block-tools block-language-tools';
    const languageLabel = document.createElement('label'); languageLabel.className = 'block-language-label'; languageLabel.appendChild(document.createTextNode('نمایش همین متن:'));
    const language = document.createElement('select'); language.dataset.textMode = 'sidebar'; language.setAttribute('aria-label', `زبان نمایش متن ${block.id} روی تصویر`); [['translation', 'فارسی / ترجمه'], ['ocr', 'انگلیسی / OCR']].forEach(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; language.appendChild(option); }); language.value = blockTextMode(block); languageLabel.appendChild(language); languageRow.appendChild(languageLabel);
    const source = document.createElement('p'); source.className = 'block-readonly block-source-edit'; source.dir = 'auto'; source.textContent = `متن اصلی: ${block.text || '—'}`; source.tabIndex = 0; source.setAttribute('role', 'button'); source.setAttribute('aria-label', `ویرایش متن انگلیسی/OCR کادر ${block.id}`); source.title = 'برای ویرایش متن اصلی کلیک کنید';
    source.addEventListener('click', () => editOcrText(block));
    source.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); editOcrText(block); } });
    const translation = document.createElement('p'); translation.className = 'block-readonly block-tr-edit'; translation.dir = 'auto'; translation.textContent = `ترجمه: ${block.tr || '—'}`; translation.tabIndex = 0; translation.setAttribute('role', 'button'); translation.setAttribute('aria-label', `ویرایش ترجمهٔ کادر ${block.id} روی تصویر`); translation.title = 'برای ویرایش ترجمه روی تصویر کلیک کنید';
    const openBlockTranslation = () => { if (!block.enabled || blockOverlayMode(block) === 'none') { toast('ابتدا نمایش متن روی تصویر را فعال کنید.', true); return; } if (blockTextMode(block) === 'ocr') setBlockTextMode(block, 'translation'); openInlineEditor(block); };
    translation.addEventListener('click', openBlockTranslation);
    translation.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openBlockTranslation(); } });
    const actions = document.createElement('div'); actions.className = 'block-tools';
    actions.append(makeButton('کپی متن اصلی', () => copyBlockText(block.text || '').catch((e) => toast(e.message, true))), makeButton('ترجمهٔ دوباره', () => retranslateBlock(block)), makeButton('پاک‌کردن ترجمه', async () => {
      if (inlineDraft?.block === block && !closeInlineEditor()) return;
      const ok = await appConfirm('آیا مطمئن هستید که می‌خواهید ترجمهٔ این کادر را پاک کنید؟', {
        title: 'پاک‌کردن ترجمهٔ کادر',
        confirmText: 'بله، پاک شود',
        cancelText: 'انصراف',
        variant: 'danger',
        destructive: true,
      });
      if (!ok) return;
      block.tr = ''; block.richHtml = ''; buildBlockList(); drawEditor(); scheduleSave();
    }));
    enabled.addEventListener('change', () => setBlockVisibility(block, enabled.checked)); language.addEventListener('change', () => setBlockTextMode(block, language.value)); bg.addEventListener('change', () => { block.bg = bg.value; drawEditor(); scheduleSave(); });
    card.append(head, languageRow, source, translation, actions); list.appendChild(card);
  });
  updateEditorSelection();
}
async function applyEditor() {
  const item = editorItem(); if (!item) return !inlineDraft; if (!applyInlineEditor()) return false;
  $('editorProgressWrap')?.classList.remove('hidden'); setProgress('editorProgress', 0.25, true);
  try { await overlayPreviewTask; setProgress('editorProgress', 0.55, true); await saveProject(); await renderAndUpload(item); renderGrid(); setProgress('editorProgress', 1, false); return true; }
  finally { $('editorProgressWrap')?.classList.add('hidden'); }
}
async function closeEditor() {
  if (imageOverview) await exitImageOverview();
  if (editorCloseTask) return editorCloseTask;
  editorCloseTask = (async () => {
    const item = editorItem();
    if (item ? !applyInlineEditor() : !!inlineDraft) return;
    editorLoadSeq += 1;
    if (item) { await overlayPreviewTask; await saveProject(); await renderAndUpload(item); renderGrid(); }
    if (editorCanvasFrame) { cancelAnimationFrame(editorCanvasFrame); editorCanvasFrame = 0; }
    closeDialog('editorDialog'); state.editorBitmap?.close?.(); state.editorBitmap = null; $('editorCanvas').width = $('editorCanvas').height = 0; state.editorId = null; state.editorPan = null; state.activeBlockId = null; state.selectedBlockIds = [];
  })();
  try { await editorCloseTask; } finally { editorCloseTask = null; }
}
async function revertEditor() { const item = editorItem(); if (!item || !closeInlineEditor()) return; item.blocks.forEach((block) => { block.enabled = false; }); await saveProject(); await renderAndUpload(item); drawEditor(); buildBlockList(); renderGrid(); toast('تصویر اصلی بازیابی شد؛ متن‌ها برای استفادهٔ بعدی باقی ماندند'); }

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
  try { const response = await fetch(imageUrl(item, !!item.edited, true)); const bitmap = await createImageBitmap(await response.blob()); const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close(); const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png')); canvas.width = canvas.height = 0; if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('مرورگر اجازهٔ کپی تصویر نمی‌دهد'); await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('تصویر کپی شد'); } catch (error) { toast(error.message || 'کپی تصویر ممکن نبود', true); }
}

// ---------- Events and startup ----------
function bindEvents() {
  const finishBrowserSession = () => { if (inlineDraft && !sessionCloseSent) classicEditor.saveDraft(); closeSession(); };
  window.addEventListener('pagehide', finishBrowserSession);
  window.addEventListener('beforeunload', finishBrowserSession);
  window.addEventListener('pageshow', (event) => { if (event.persisted) startSession(); });
  bindGridDrop();
  $('menuBtn').addEventListener('click', () => setMenuOpen($('menu').classList.contains('hidden')));
  const closeMenuOutside = (event) => {
    if ($('menu')?.classList.contains('hidden')) return;
    if (event.target?.closest?.('#menu, #menuBtn')) return;
    setMenuOpen(false);
  };
  document.addEventListener('pointerdown', closeMenuOutside, true);
  document.addEventListener('click', closeMenuOutside, true);
  let lastEscapeKeyAt = -1000;
  document.addEventListener('keyup', (event) => {
    if (event.key === 'Escape') lastEscapeKeyAt = performance.now();
  }, true);
  document.querySelectorAll('dialog').forEach((dlg) => {
    dlg.addEventListener('cancel', (event) => {
      if (performance.now() - lastEscapeKeyAt < 400) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
    dlg.addEventListener('close', () => {
      if (dlg.open) return;
      const idx = openDialogStack.indexOf(dlg.id);
      if (idx >= 0) openDialogStack.splice(idx, 1);
    });
    dlg.querySelectorAll('form[method="dialog"] button.icon').forEach((closeBtn) => {
      closeBtn.addEventListener('click', (event) => {
        event.preventDefault();
        if (dlg.id === 'ocrDialog') requestCancelOcrDialog().catch(() => {});
        else if (dlg.id === 'translationDialog') requestCancelTranslationDialog().catch(() => {});
        else if (dlg.id === 'exportDialog') requestCancelExport('exportDialog').catch(() => {});
        else if (dlg.id === 'docxExportDialog') requestCancelExport('docxExportDialog').catch(() => {});
        else if (dlg.id === 'modelsDialog') requestCancelModelJob().catch(() => {});
        else if (dlg.id === 'translationPreviewDialog') cancelTranslationRequestPreview();
        else closeDialog(dlg.id);
      });
    });
  });
  $('appModalConfirm')?.addEventListener('click', () => resolveActiveModal(true));
  $('appModalCancel')?.addEventListener('click', () => resolveActiveModal(false));
  $('appModalClose')?.addEventListener('click', () => resolveActiveModal(false));
  $('appModalDialog')?.addEventListener('cancel', (event) => { event.preventDefault(); resolveActiveModal(false); });
  $('appModalDialog')?.addEventListener('close', () => { if (activeModalState && !$('appModalDialog')?.open) resolveActiveModal(false); });
  $('dockCancelJobBtn')?.addEventListener('click', () => requestCancelActiveJob().catch(() => {}));
  $('themeBtn').addEventListener('click', () => { document.body.classList.toggle('light'); localStorage.setItem('comic-studio-theme', document.body.classList.contains('light') ? 'light' : 'dark'); });
  $('backupProjectBtn').addEventListener('click', () => backupCurrentProject().catch(() => {}));
  $('restoreProjectBtn').addEventListener('click', () => $('restoreProjectInput').click());
  $('restoreProjectInput').addEventListener('change', () => restoreProjectBackup($('restoreProjectInput').files?.[0]).catch(() => {}).finally(() => { $('restoreProjectInput').value = ''; }));
  $('newProjectBtn').addEventListener('click', async () => {
    const ok = await appConfirm('پروژهٔ جدید ساخته شود؟ پروژهٔ فعلی شما ذخیره و محفوظ می‌ماند.', {
      title: 'ساخت پروژهٔ جدید',
      confirmText: 'بله، پروژهٔ جدید بساز',
      cancelText: 'انصراف',
      variant: 'confirm',
    });
    if (!ok) return;
    await saveProject(); await clearActivity(false);
    adoptProject(await api('/api/projects', jsonOptions('POST', { name: 'پروژهٔ کمیک' })));
    await refreshProjectList(); setMenuOpen(false);
  });
  $('clearActivityBtn').addEventListener('click', () => clearActivity());
  $('copyUnstoredResult').addEventListener('click', () => copyBlockText($('copyUnstoredResult').dataset.result || '').catch(error => toast(error.message || String(error), true)));
  $('pendingResultsBtn').addEventListener('click', () => openPendingResults());
  $('pendingApply').addEventListener('click', () => applyPendingResult());
  $('pendingCopy').addEventListener('click', () => { if (pendingReview) copyBlockText(pendingReview.view.rows.map(row => `${row.name}: ${row.result}`).join('\n') + (pendingReview.view.summary ? `\nخلاصه: ${pendingReview.view.summary}` : '')).catch(error => toast(error.message || String(error), true)); });
  $('pendingDiscard').addEventListener('click', async () => {
    const review = pendingReview; if (!review) return;
    const ok = await appConfirm('آیا مطمئن هستید که این نتیجهٔ ذخیره‌شده برای همیشه حذف شود؟', {
      title: 'حذف نتیجهٔ منتظر بررسی',
      confirmText: 'بله، حذف شود',
      cancelText: 'انصراف',
      variant: 'danger',
      destructive: true,
    });
    if (!ok) return;
    try { await api(`/api/projects/${review.projectId}/pending/${review.view.id}`, {method:'DELETE'}); await openPendingResults(); }
    catch (error) { $('pendingStatus').textContent = error.message || String(error); }
  });
  $('deleteProjectBtn').addEventListener('click', async () => {
    if (!state.project) return;
    const ok = await appConfirm('آیا مطمئن هستید که این پروژه و تمام تصاویر آن برای همیشه حذف شوند؟', {
      title: 'حذف کامل پروژه',
      confirmText: 'بله، حذف شود',
      cancelText: 'انصراف',
      variant: 'danger',
      destructive: true,
    });
    if (!ok) return;
    await api(`/api/projects/${state.project.id}`, { method: 'DELETE' });
    const projects = await api('/api/projects');
    const project = projects.length ? await api(`/api/projects/${projects[0].id}`) : await api('/api/projects', jsonOptions('POST', { name: 'پروژهٔ کمیک' }));
    adoptProject(project); await refreshProjectList(); setMenuOpen(false);
  });
  $('projectSelect').addEventListener('change', () => requestProjectLoad($('projectSelect').value).catch((error) => toast(error.message, true)));
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
  $('ocrBtn').addEventListener('click', () => { clearPendingTranslationOcr(); $('ocrStatus').textContent = ''; $('copyOcrError').classList.add('hidden'); updateEngineOptions(); showDialog('ocrDialog'); }); $('ocrEngine').addEventListener('change', updateOcrEngineStatus); $('startOcrBtn').addEventListener('click', () => runOcr().catch(() => {})); $('cancelOcrBtn')?.addEventListener('click', () => requestCancelOcrDialog().catch(() => {})); $('cancelTranslationBtn')?.addEventListener('click', () => requestCancelTranslationDialog().catch(() => {})); $('translateBtn').addEventListener('click', () => runTranslation().catch(() => {}));
  $('ocrDialog').addEventListener('cancel', (event) => {
    if (ocrRunning && !ocrClosingNormally) { event.preventDefault(); requestCancelOcrDialog().catch(() => {}); }
  });
  $('ocrDialog').addEventListener('close', () => {
    if (ocrRunning && !ocrClosingNormally) abortRunningOcr();
    if (!$('ocrDialog').open) clearPendingTranslationOcr();
  });
  $('copyOcrError').addEventListener('click', () => copyBlockText($('ocrStatus').textContent).catch(error => toast(`کپی ممکن نبود: ${error.message || error}`, true)));
  $('copyTranslationPreviewError').addEventListener('click', () => copyBlockText($('translationPreviewError').textContent).catch(error => toast(`کپی ممکن نبود: ${error.message || error}`, true)));
  $('openAiLimitFromPreview')?.addEventListener('click', () => {
    cancelTranslationRequestPreview();
    loadAiSettings().then(() => showDialog('aiDialog')).catch((error) => toast(error.message, true));
  });
  $('retryTranslation').addEventListener('click', async () => {
    const retry = translationRetryAction; if (!retry || translationRunning || translationDecisionBusy) return;
    translationDecisionBusy = true; $('applyResponseRepair').disabled = true; $('applyResponseFields').disabled = true;
    translationRetryAction = null; $('retryTranslation').classList.add('hidden');
    try { await retry(); } catch (error) { if (!error?.cancelled && error?.name !== 'AbortError') toast(error.message || 'ترجمه ناموفق بود', true); }
    finally { translationDecisionBusy = false; $('applyResponseRepair').disabled = false; $('applyResponseFields').disabled = false; if (!$('translationDialog').open) clearResponseRepair(); }
  });
  async function submitResponseRepair(value) {
    const action = translationRepairAction; if (!action || translationRunning || translationDecisionBusy) return;
    translationDecisionBusy = true; $('retryTranslation').disabled = true;
    $('applyResponseRepair').disabled = true; $('applyResponseFields').disabled = true; $('responseRepairStatus').textContent = 'در حال بررسی پاسخ اصلاح‌شده…';
    try { await action(value); }
    catch (error) { if (!error?.cancelled && error?.name !== 'AbortError') $('responseRepairStatus').textContent = error.message || String(error); }
    finally { translationDecisionBusy = false; $('retryTranslation').disabled = false; $('applyResponseRepair').disabled = false; $('applyResponseFields').disabled = false; if (!$('translationDialog').open) clearResponseRepair(); }
  }
  $('applyResponseRepair').addEventListener('click', () => submitResponseRepair($('responseRepairText').value));
  $('applyResponseFields').addEventListener('click', () => submitResponseRepair(JSON.stringify({translation: $('repairTranslation').value, summary: $('repairSummary').value})));
  $('copyTranslationError').addEventListener('click', async () => {
    try { await copyBlockText($('translationStatus').textContent); translationRetryAction = null; closeDialog('translationDialog'); }
    catch (error) { toast(`کپی ممکن نبود؛ متن خطا را دستی انتخاب و کپی کنید: ${error.message || error}`, true); }
  });
  $('translationDialog').addEventListener('cancel', (event) => {
    if ((translationRunning || translationDecisionBusy) && !translationClosingNormally) { event.preventDefault(); requestCancelTranslationDialog().catch(() => {}); }
  });
  $('translationDialog').addEventListener('close', () => {
    if ((translationRunning || translationDecisionBusy) && !translationClosingNormally) abortRunningTranslation();
    if (!$('translationDialog').open) { translationRetryAction = null; clearResponseRepair(); $('copyUnstoredResult').dataset.result = ''; $('copyUnstoredResult').classList.add('hidden'); }
  });
  $('exportDialog')?.addEventListener('cancel', (event) => {
    if (exportRunning) { event.preventDefault(); requestCancelExport('exportDialog').catch(() => {}); }
  });
  $('docxExportDialog')?.addEventListener('cancel', (event) => {
    if (exportRunning) { event.preventDefault(); requestCancelExport('docxExportDialog').catch(() => {}); }
  });
  $('modelsDialog')?.addEventListener('cancel', (event) => {
    if (state.modelBusy) { event.preventDefault(); requestCancelModelJob().catch(() => {}); }
  });
  $('copyAiError').addEventListener('click', () => copyBlockText($('aiStatus').textContent).catch((error) => toast(error.message, true)));
  for (const [element, field] of [[$('translationSkill'), 'skillLimit'], [$('translationContext'), 'contextLimit']]) {
    element.addEventListener('beforeinput', event => {
      const limit = translationPreviewData?.contextMode ? translationPreviewData[field] : null;
      if (limit == null || !event.inputType?.startsWith('insert')) return;
      const inserted = event.data ?? event.dataTransfer?.getData('text/plain');
      if (inserted == null) return;
      const next = element.value.slice(0, element.selectionStart) + inserted + element.value.slice(element.selectionEnd);
      if (Array.from(next).length > limit) event.preventDefault();
    });
    element.addEventListener('paste', event => {
      const limit = translationPreviewData?.contextMode ? translationPreviewData[field] : null;
      if (limit == null) return;
      const next = element.value.slice(0, element.selectionStart) + event.clipboardData.getData('text/plain') + element.value.slice(element.selectionEnd);
      if (Array.from(next).length > limit) { event.preventDefault(); toast(`سقف ${limit} نویسه است.`, true); }
    });
  }
  $('translationSkill').addEventListener('input', updateTranslationSkillStatus); $('translationContext').addEventListener('input', updateTranslationSkillStatus); $('translationContextResume').addEventListener('change', updateTranslationSkillStatus);
  $('translationSkillReset').addEventListener('click', () => { $('translationSkill').value = translationPreviewData?.defaultSkill ?? ''; updateTranslationSkillStatus(); });
  $('translationPreviewConfirm').addEventListener('click', () => confirmTranslationRequestPreview().catch(() => {})); $('translationPreviewCancel').addEventListener('click', cancelTranslationRequestPreview); $('translationPreviewDialog').addEventListener('close', () => { if (!$('translationPreviewDialog').open) { translationPreviewAction = null; translationPreviewRefresh = null; translationPreviewData = null; } });
  $('modelsBtn').addEventListener('click', () => { renderModels(); showDialog('modelsDialog'); $('menu').classList.add('hidden'); }); $('testLanguage').addEventListener('change', renderModels); $('aiBtn').addEventListener('click', () => { setProgress('aiProgress', 0, false); loadAiSettings().then(() => { showDialog('aiDialog'); $('menu').classList.add('hidden'); }).catch((error) => toast(error.message, true)); }); $('aiProvider').addEventListener('change', () => showAiProvider($('aiProvider').value)); $('aiAddProfile').addEventListener('click', () => { aiEditorProfiles.push(makeAiProfile()); renderAiProfiles(); }); $('saveAiBtn').addEventListener('click', async () => { $('saveAiBtn').disabled = true; setProgress('aiProgress', null, true); try { await saveAiSettings(); setProgress('aiProgress', 1, false); closeDialog('aiDialog'); } catch (error) { setProgress('aiProgress', 0, false); $('aiStatus').textContent = error.message; $('copyAiError').classList.remove('hidden'); toast(error.message, true); } finally { $('saveAiBtn').disabled = false; } });
  $('exportBtn').addEventListener('click', () => { updateExportFields(); showDialog('exportDialog'); }); $('exportKind').addEventListener('change', updateExportFields); $('overlayMode').addEventListener('change', () => setOverlayMode($('overlayMode').value)); $('exportOverlayMode').addEventListener('change', () => setOverlayMode($('exportOverlayMode').value)); $('startExportBtn').addEventListener('click', () => runJob('در حال ساخت خروجی…', () => exportResult(), 'exportProgress').catch(() => {})); $('exportPdfBtn').addEventListener('click', () => runJob('در حال ساخت PDF…', () => exportResult('pdf'), 'exportProgress').catch(() => {})); $('exportImagesBtn').addEventListener('click', () => runJob('در حال ساخت ZIP…', () => exportResult('images'), 'exportProgress').catch(() => {})); $('exportTxtBtn').addEventListener('click', () => runJob('در حال ساخت TXT…', () => exportResult('txt'), 'exportProgress').catch(() => {})); $('exportDocxBtn')?.addEventListener('click', () => openDocxExportPrompt()); $('docxChoiceTranslation')?.addEventListener('click', () => runDocxChoiceExport('translation').catch(() => {})); $('docxChoiceOcr')?.addEventListener('click', () => runDocxChoiceExport('ocr').catch(() => {})); $('docxExportCancel')?.addEventListener('click', () => requestCancelExport('docxExportDialog').catch(() => {}));
  $('editorSelectAll').addEventListener('click', selectAllEditorBlocks); $('editorSelectNone').addEventListener('click', clearEditorSelection);
  $('editorMergeText').addEventListener('click', mergeSelectedText); $('editorSplitText').addEventListener('click', splitSelectedText);
  $('editorSameSize').addEventListener('click', sameSizeSelectedBoxes);
  [['editorAlignLeft', 'left'], ['editorAlignCenter', 'center'], ['editorAlignRight', 'right'], ['editorAlignTop', 'top'], ['editorAlignMiddle', 'middle'], ['editorAlignBottom', 'bottom']].forEach(([id, direction]) => $(id).addEventListener('click', () => alignSelectedBoxes(direction)));
  $('editorApply').addEventListener('click', () => applyEditor().catch((error) => toast(error.message, true))); $('editorClose').addEventListener('click', () => closeEditor().catch((error) => toast(error.message, true))); $('editorRevert').addEventListener('click', () => revertEditor().catch((error) => toast(error.message, true))); $('editorDialog').addEventListener('cancel', (event) => { event.preventDefault(); if (classicEditor?.hasOpenModal?.()) classicEditor.closeModal(); else if (imageOverview) exitImageOverview().catch((error) => toast(error.message, true)); else if (inlineDraft) closeInlineEditor(); else closeEditor().catch((error) => toast(error.message, true)); });
  $('inlineEditorApply').addEventListener('click', applyInlineEditor);
  $('inlinePreview').addEventListener('mousedown', (event) => event.preventDefault());
  $('inlinePreview').addEventListener('click', () => setInlineOutputPreview(!inlineDraft?.showOutput));
  $('inlineEditorCancel').addEventListener('click', () => closeInlineEditor(true));
  classicEditor = window.createEditor('#inlineEditorField', {
    clearFormatId: 'inlineLineReset',
    confirmDraft: (message) => appConfirm(message, {
      title: 'بازیابی پیش‌نویس ذخیره‌شده',
      confirmText: 'بله، بازیابی شود',
      cancelText: 'خیر، حذف پیش‌نویس',
      variant: 'warning',
    }),
    serializeHTML: serializeInlineFieldHtml,
    undo: () => restoreInlineHistory(-1), redo: () => restoreInlineHistory(1),
    inlineCommand: (cmd) => toggleInlineCommand(cmd),
    clearFormat: () => resetInlineLineStyle(),
    align: (value) => setInlineLineStyle('textAlign', value),
    direction: (value) => setInlineLineStyle('direction', value),
    color: (value) => {
      if (hasInlineWordSelection()) return applyInlineWordStyle({ color: value }, { restoreFocus: false });
      if (inlineDraft?.range?.collapsed) { setInlineLineStyle('color', value, { restoreFocus: false }); return true; }
      return false;
    },
    onFullscreen: (enabled) => {
      if (!inlineDraft) return;
      const box = [...document.querySelectorAll('#editorBoxes .editor-box')].find((el) => el.dataset.id === String(inlineDraft.block.id));
      if (enabled) { classicEditor.field.style.padding = ''; classicEditor.detachField(); refreshInlineTypography(); }
      else if (box) { classicEditor.attachField(box); refreshInlineTypography(); }
    },
    onChange: () => { if (inlineDraft) { rememberInlineRange(); recordInlineHistory(); syncInlineLineControls(); refreshInlineTypography(); autoApplyInlineDraft(); updateEditorSelection(); } },
    getDraftMetadata: () => inlineDraft ? { dir: $('inlineEditorDirection').value, align: $('inlineEditorAlign').value, verticalAlign: $('inlineVerticalAlign').value, size: (inlineDraft.initialAutoSize && !inlineDraft.sizeTouched && $('inlineEditorSize').value.trim() === inlineDraft.initialSizeValue) ? '' : $('inlineEditorSize').value, color: inlineDraft.color } : null,
    onRestore: (meta) => { if (!inlineDraft || !meta) return; if (['rtl', 'ltr'].includes(meta.dir)) $('inlineEditorDirection').value = meta.dir; if (['right','left','center','justify'].includes(meta.align)) $('inlineEditorAlign').value = meta.align; if (['top','middle','bottom'].includes(meta.verticalAlign)) { inlineDraft.verticalAlignTouched = true; $('inlineVerticalAlign').value = meta.verticalAlign; } if (meta.size === '') { inlineDraft.sizeTouched = false; inlineDraft.initialAutoSize = true; const shown = String(effectiveInlineSize(inlineDraft.block)); $('inlineEditorSize').value = shown; inlineDraft.initialSizeValue = shown; } else if (+meta.size >= 8 && +meta.size <= 160) { inlineDraft.sizeTouched = true; inlineDraft.initialAutoSize = false; $('inlineEditorSize').value = meta.size; } if (meta.color === null || /^#[0-9a-f]{6}$/i.test(meta.color || '')) { inlineDraft.color = meta.color; $('inlineEditorColor').value = meta.color || effectiveInlineColor(inlineDraft.block); } $('inlineEditorField').dir = $('inlineEditorDirection').value; $('inlineEditorField').style.textAlign = $('inlineEditorAlign').value; syncVerticalAlignButtons(); },
  });
  const inlineField = $('inlineEditorField');
  inlineField.addEventListener('scroll', () => {
    if (inlineField.scrollTop) inlineField.scrollTop = 0;
    if (inlineField.scrollLeft) inlineField.scrollLeft = 0;
  });
  ['keyup', 'mouseup', 'focus'].forEach((name) => inlineField.addEventListener(name, () => { rememberInlineRange(); syncInlineLineControls(); }));
  inlineField.addEventListener('blur', () => updateInlineSelectionHighlight());
  document.addEventListener('selectionchange', () => {
    if (inlineDraft && document.activeElement === inlineField) { rememberInlineRange(); syncInlineLineControls(); }
  });
  inlineField.addEventListener('input', () => { rememberInlineRange(); recordInlineHistory(); syncInlineLineControls(); });
  let inlineDownPt = null;
  inlineField.addEventListener('pointerdown', (event) => {
    if (event.ctrlKey || event.metaKey) {
      const blk = inlineDraft?.block;
      inlineDownPt = null;
      event.preventDefault(); event.stopPropagation();
      if (blk && closeInlineEditor()) selectEditorBlock(blk.id, true, true);
      return;
    }
    event.stopPropagation();
    inlineDownPt = event.button === 0 && !event.shiftKey ? { x: event.clientX, y: event.clientY } : null;
    if (event.button === 0 && lastInlineOpenClick && performance.now() - lastInlineOpenClick.time < 360
      && Math.hypot(event.clientX - lastInlineOpenClick.x, event.clientY - lastInlineOpenClick.y) <= 6) {
      lastInlineOpenClick = null; inlineDownPt = null;
      if (expandInlineWordAtPoint(inlineField, event.clientX, event.clientY)) event.preventDefault();
    } else {
      lastInlineOpenClick = null;
    }
  });
  inlineField.addEventListener('dblclick', (event) => {
    inlineDownPt = null;
    event.stopPropagation();
    expandInlineWordAtPoint(inlineField, event.clientX, event.clientY);
  });
  inlineField.addEventListener('click', (event) => {
    event.stopPropagation();
    const down = inlineDownPt; inlineDownPt = null;
    if (!down || event.detail !== 1 || event.shiftKey || !inlineField.parentElement?.classList.contains('editor-box')) return;
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 3) return;
    const sel = window.getSelection?.();
    if (!sel || !sel.isCollapsed) return;
    placeInlineCaret(inlineField, event);
    rememberInlineRange(); syncInlineLineControls();
  });
  $('inlineEditor').addEventListener('pointerdown', (event) => {
    if (inlineDraft?.showOutput && !event.target.closest('#inlinePreview, #inlineEditorApply, #inlineEditorCancel, .editor-zoom-controls')) setInlineOutputPreview(false);
    const boxDetails = $('inlineEditor').querySelector('.inline-box-settings');
    if (boxDetails?.open && !event.target.closest('.inline-box-settings')) boxDetails.removeAttribute('open');
  }, true);
  $('inlineEditor').addEventListener('click', () => requestAnimationFrame(positionInlineEditor));
  $('inlineEditor').querySelector('details')?.addEventListener('toggle', () => requestAnimationFrame(positionInlineEditor));
  syncInlineDockIdleState();
  $('inlineLineSize').addEventListener('input', () => {
    const value = $('inlineLineSize').value.trim(); const size = Number(value);
    if (value && Number.isFinite(size) && size >= 8 && size <= 160) setSelectionOrLineSize(`${Math.round(size)}px`, { restoreFocus: false });
  });
  $('inlineLineSize').addEventListener('change', () => {
    const value = $('inlineLineSize').value.trim(); const size = Number(value);
    if (value && (!Number.isFinite(size) || size < 8 || size > 160)) { toast('اندازه باید بین ۸ و ۱۶۰ باشد.', true); return; }
    setSelectionOrLineSize(value ? `${Math.round(size)}px` : '', { restoreFocus: false });
  });
  $('inlineLineSize').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const value = $('inlineLineSize').value.trim(); const size = Number(value);
    if (value && (!Number.isFinite(size) || size < 8 || size > 160)) { toast('اندازه باید بین ۸ و ۱۶۰ باشد.', true); return; }
    setSelectionOrLineSize(value ? `${Math.round(size)}px` : '', { restoreFocus: true });
  });
  ['inlineSizeUp', 'inlineSizeDown'].forEach((id) => $(id)?.addEventListener('mousedown', (event) => event.preventDefault()));
  document.querySelectorAll('.inline-box-layout-tools button, .inline-merge-split-tools button').forEach((btn) => btn.addEventListener('mousedown', (event) => event.preventDefault()));
  $('inlineSizeUp')?.addEventListener('click', () => stepSelectionOrLineSize(2));
  $('inlineSizeDown')?.addEventListener('click', () => stepSelectionOrLineSize(-2));
  $('inlineEditorDirection').addEventListener('change', () => { inlineField.dir = $('inlineEditorDirection').value; inlineField.style.direction = inlineField.dir; classicEditor.notifyChange(); });
  $('inlineEditorAlign').addEventListener('change', () => { inlineField.style.textAlign = $('inlineEditorAlign').value; classicEditor.notifyChange(); });
  $('inlineVerticalAlign').addEventListener('change', () => { if (inlineDraft) inlineDraft.verticalAlignTouched = true; syncVerticalAlignButtons(); if (inlineDraft) classicEditor.notifyChange(); });
  document.querySelectorAll('.inline-valign-btn').forEach((btn) => {
    btn.addEventListener('mousedown', (event) => event.preventDefault());
    btn.addEventListener('click', () => setVerticalPlacement(btn.dataset.valign));
  });
  $('inlineEditorColor').addEventListener('input', () => { if (inlineDraft) { inlineDraft.color = $('inlineEditorColor').value; classicEditor.notifyChange(); } });
  $('inlineEditorAutoColor').addEventListener('click', () => { if (inlineDraft) { inlineDraft.color = null; $('inlineEditorColor').value = effectiveInlineColor({ ...inlineDraft.block, color: null }); classicEditor.notifyChange(); } });
  $('inlineEditorSize').addEventListener('input', () => {
    if (!inlineDraft) return;
    inlineDraft.sizeTouched = $('inlineEditorSize').value.trim() !== '';
    inlineDraft.initialAutoSize = !inlineDraft.sizeTouched;
    classicEditor.notifyChange();
  });
  document.querySelectorAll('.editor-zoom-controls button').forEach((btn) => btn.addEventListener('mousedown', (event) => event.preventDefault()));
  const imagePreview = document.querySelector('.editor-preview'); let blankPointer = null;
  imagePreview.addEventListener('pointerdown', (event) => { blankPointer = !event.target.closest('.editor-box') && event.button === 0 ? { x: event.clientX, y: event.clientY } : null; });
  imagePreview.addEventListener('click', (event) => {
    const start = blankPointer; blankPointer = null;
    if (imageOverview) return;
    if (!start || event.target.closest('.editor-box') || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
    if (!closeInlineEditor()) return; clearEditorSelection();
  });
  imagePreview.addEventListener('scroll', positionInlineEditor);
  $('editorImageFullscreen').addEventListener('click', () => (imageOverview ? exitImageOverview() : enterImageOverview()).catch((error) => toast(error.message, true)));
  document.addEventListener('fullscreenchange', () => { if (imageOverview?.native && document.fullscreenElement !== $('editorDialog')) exitImageOverview(true).catch((error) => toast(error.message, true)); });
  $('editorZoomOut').addEventListener('click', () => setEditorZoom(state.editorScale / 1.25)); $('editorZoomIn').addEventListener('click', () => setEditorZoom(state.editorScale * 1.25)); $('editorZoomActual').addEventListener('click', () => setEditorZoom(1)); $('editorZoomFit').addEventListener('click', fitEditor);
  document.querySelector('.editor-preview').addEventListener('wheel', handleEditorWheel, { passive: false });
  $('editorStage').addEventListener('pointerdown', startEditorPan); $('editorStage').addEventListener('pointermove', moveEditorPan); $('editorStage').addEventListener('pointerup', stopEditorPan); $('editorStage').addEventListener('pointercancel', stopEditorPan); $('editorStage').addEventListener('lostpointercapture', stopEditorPan);
  $('previewCopy').addEventListener('click', copyPreview);
  window.addEventListener('resize', () => { if (state.editorId) { if (imageOverview) fitWholeEditorImage(); else fitEditor(); } if (state.cropId) drawCropRect(); scheduleOutlines(); });
  ['cropX', 'cropY', 'cropW', 'cropH'].forEach((id) => $(id).addEventListener('change', readCropInputs)); $('cropRatio').addEventListener('change', changeCropRatio); $('cropStage').addEventListener('pointerdown', cropPointerDown); $('cropStage').addEventListener('pointermove', cropPointerMove); const stopCrop = () => { state.cropPointer = null; }; $('cropStage').addEventListener('pointerup', stopCrop); $('cropStage').addEventListener('pointercancel', stopCrop);
  $('cropReset').addEventListener('click', () => { cropItem().crop = null; state.crop = null; closeDialog('cropDialog'); renderGrid(); scheduleSave(); }); $('cropApply').addEventListener('click', () => { readCropInputs(); cropItem().crop = state.crop; closeDialog('cropDialog'); renderGrid(); scheduleSave(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      lastEscapeKeyAt = performance.now();
      if (event.repeat) { event.preventDefault(); event.stopPropagation(); return; }
      if ($('appModalDialog')?.open) { resolveActiveModal(false); event.preventDefault(); event.stopPropagation(); return; }
      if (classicEditor?.hasOpenModal?.()) { classicEditor.closeModal(); event.preventDefault(); event.stopPropagation(); return; }
      const topStackedId = [...openDialogStack].reverse().find((id) => $(id)?.open);
      if (topStackedId && topStackedId !== 'editorDialog') {
        if (closeTopDialog()) { event.preventDefault(); event.stopPropagation(); }
        return;
      }
      if (imageOverview) { exitImageOverview().catch((error) => toast(error.message, true)); event.preventDefault(); event.stopPropagation(); return; }
      if (inlineDraft && classicEditor.element.classList.contains('classic-fullscreen')) { classicEditor.exitFullscreen(); classicEditor.focus(); event.preventDefault(); event.stopPropagation(); return; }
      if (inlineDraft) { closeInlineEditor(); event.preventDefault(); event.stopPropagation(); return; }
      if (closeTopDialog()) { event.preventDefault(); event.stopPropagation(); }
      else setMenuOpen(false);
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
