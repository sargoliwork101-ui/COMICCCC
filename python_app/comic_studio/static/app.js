/* global Typeset, createImageBitmap, StudioGroups, ClipboardItem */
'use strict';

const $ = (id) => document.getElementById(id);
const G = window.StudioGroups;
const GROUP_COLORS = ['#34d399', '#60a5fa', '#f472b6', '#fbbf24', '#a78bfa', '#2dd4bf', '#fb923c', '#e879f9'];
const state = {
  project: null, engines: [], ai: null, storage: null, resources: null, licenseStatus: null, workspaceBooted: false, activityFeedStarted: false,
  editorId: null, editorBitmap: null, editorScale: 1, editorFitScale: 1, editorPan: null, activeBlockId: null, selectedBlockIds: [],
  copiedEditorBlocks: [], copiedEditorPasteStep: 0, copiedEditorSourceImageId: null,
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
let jobProgressTransform = null;
let sessionTimer = null;
let sessionCloseSent = false;
let heartbeatInFlight = false;
let sessionVisibilityBound = false;
let localActivityId = 0;
let editorCloseTask = null;
let editorSessionSnapshot = null;
let editorReturnScroll = null;
let justEditedHighlightTimer = null;
let savePending = false;
let editorCanvasFrame = 0;
let editorLoadSeq = 0;
let overlayMeasureCtx = null;
let sampleScratchCanvas = null;
let inlineDraft = null;
let inlineEditSession = null;
let classicEditor = null;
let helpController = null;
let imageOverview = null;
let jobBusy = false;
let storageSwitchBusy = false;
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
let translationPreviewSwitchTarget = null;
let translationPreviewData = null;
let preferredTranslationTarget = null;
let lastSyncedAiProvider = null;
let translationPreviewTask = Promise.resolve();
let overlayPreviewTask = Promise.resolve();
let downloadUrl = null;
let activeExportPrepared = null;
let backupDownloadUrl = null;
let activeBackupPrepared = null;
let previewRevision = 0;
const imageRenderTasks = new Map();
const imagePreviewVersions = new Map();

function clearExportDownloadLink() {
  if (downloadUrl) {
    URL.revokeObjectURL(downloadUrl);
    downloadUrl = null;
  }
  if (activeExportPrepared) {
    const { projectId, token } = activeExportPrepared;
    activeExportPrepared = null;
    fetch(`/api/projects/${encodeURIComponent(projectId)}/export/${encodeURIComponent(token)}`, { method: 'DELETE' }).catch(() => {});
  }
  const link = $('downloadLink');
  if (link) {
    link.href = '#';
    link.classList.add('hidden');
  }
}

function clearBackupDownloadLink() {
  if (backupDownloadUrl) {
    URL.revokeObjectURL(backupDownloadUrl);
    backupDownloadUrl = null;
  }
  if (activeBackupPrepared) {
    const { projectId, token } = activeBackupPrepared;
    activeBackupPrepared = null;
    fetch(`/api/projects/${encodeURIComponent(projectId)}/backup/${encodeURIComponent(token)}`, { method: 'DELETE' }).catch(() => {});
  }
  const link = $('backupDownloadLink');
  if (link) {
    link.href = '#';
    link.classList.add('hidden');
  }
}

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
  if (id === 'modelsActiveProgress' && $('modelsActiveProgressPercent')) {
    $('modelsActiveProgressPercent').textContent = determinate ? `${percentage}%` : (active ? '…' : '0%');
  }
  if (id === 'ocrQuickProgress' && $('ocrQuickProgressPercent')) {
    $('ocrQuickProgressPercent').textContent = determinate ? `${percentage}%` : (active ? '…' : '0%');
  }
  if (id === 'engineNoticeProgress' && $('engineNoticeProgressPercent')) {
    $('engineNoticeProgressPercent').textContent = determinate ? `${percentage}%` : (active ? '…' : '0%');
  }
}
let modelFromOcrDialog = false;
let modelCurrentProgress = null;
let modelCurrentLabel = '';
let engineMutationSeq = 0;

function syncModelProgressUi(progress = modelCurrentProgress, active = Boolean(state.modelBusy), labelText = modelCurrentLabel) {
  modelCurrentProgress = progress;
  if (labelText !== undefined && labelText !== null) modelCurrentLabel = String(labelText);
  const determinate = typeof progress === 'number' && Number.isFinite(progress);
  const pctStr = determinate ? `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%` : (active ? '…' : '0%');

  setProgress('modelProgress', progress, active);
  if ($('modelsActiveProgressWrap')) {
    $('modelsActiveProgressWrap').classList.toggle('hidden', !active);
    if (modelCurrentLabel && $('modelsActiveProgressLabel')) $('modelsActiveProgressLabel').textContent = modelCurrentLabel;
    setProgress('modelsActiveProgress', progress, active);
  }
  if ($('ocrQuickProgressWrap')) {
    const showQuick = active && modelFromOcrDialog;
    $('ocrQuickProgressWrap').classList.toggle('hidden', !showQuick);
    if (showQuick && modelCurrentLabel && $('ocrQuickProgressLabel')) $('ocrQuickProgressLabel').textContent = modelCurrentLabel;
    setProgress('ocrQuickProgress', showQuick ? progress : 0, showQuick);
  }
  if ($('engineNoticeProgressWrap')) {
    const showNoticeProg = active && $('engineUpdateNotice') && !$('engineUpdateNotice').classList.contains('hidden');
    $('engineNoticeProgressWrap').classList.toggle('hidden', !showNoticeProg);
    if (showNoticeProg && modelCurrentLabel && $('engineNoticeProgressLabel')) $('engineNoticeProgressLabel').textContent = modelCurrentLabel;
    setProgress('engineNoticeProgress', showNoticeProg ? progress : 0, showNoticeProg);
  }
  if (modelFromOcrDialog) {
    setProgress('ocrProgress', progress, active);
  }
  if (!jobBusy && $('dockProgressWrap')) {
    $('dockProgressWrap').classList.toggle('hidden', !active);
    if ($('dockProgressStatus')) $('dockProgressStatus').textContent = active ? (modelCurrentLabel || 'در حال آماده‌سازی مدل…') : 'آماده';
    setProgress('dockProgress', active ? progress : 0, active);
    setProgress('jobProgress', active ? progress : (progress === 1 ? 1 : 0), active);
    if ($('jobStatus') && active && modelCurrentLabel) $('jobStatus').textContent = modelCurrentLabel;
  }
  document.querySelectorAll('#engineCards .engine-card-progress').forEach((wrap) => {
    const fill = wrap.querySelector('.engine-card-progress-fill');
    const bar = wrap.querySelector('.bar');
    const pct = wrap.querySelector('.engine-card-progress-pct');
    const txt = wrap.querySelector('.engine-card-progress-text');
    const widthPct = determinate ? Math.round(Math.max(0, Math.min(1, progress)) * 100) : (active ? 30 : 0);
    if (fill) fill.style.width = `${widthPct}%`;
    if (bar) {
      bar.classList.toggle('indeterminate', active && !determinate);
      if (determinate) bar.setAttribute('aria-valuenow', String(widthPct));
      else bar.removeAttribute('aria-valuenow');
    }
    if (pct) pct.textContent = pctStr;
    if (txt && modelCurrentLabel) txt.textContent = modelCurrentLabel;
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
    const entries = payload.entries || [];
    const latest = entries.at(-1);
    const latestWithProgress = [...entries].reverse().find((e) => typeof e?.progress === 'number' && Number.isFinite(e.progress));
    if (jobBusy && latest) {
      $('jobStatus').textContent = latest.message;
      if ($('dockProgressStatus')) $('dockProgressStatus').textContent = latest.message;
      if (translationRunning) $('translationStatus').textContent = latest.message;
    }
    if (state.modelBusy && latest?.message) {
      if ($('modelTestResult')) $('modelTestResult').textContent = latest.message;
      if (modelFromOcrDialog && $('ocrStatus')) $('ocrStatus').textContent = latest.message;
      syncModelProgressUi(modelCurrentProgress, true, latest.message);
    }
    if (storageSwitchBusy && latest?.message && $('storageStatus')) {
      $('storageStatus').textContent = latest.message;
    }
    if (latestWithProgress) {
      const rawProg = Math.max(0, Math.min(1, latestWithProgress.progress));
      let jobProg = rawProg;
      if (jobProgressTransform) {
        const scaled = jobProgressTransform.offset + rawProg * jobProgressTransform.scale;
        jobProg = Math.max(jobProgressTransform.floor || 0, Math.min(1, scaled));
        jobProgressTransform.floor = Math.max(jobProgressTransform.floor || 0, jobProg);
      }
      if (jobBusy) {
        setProgress('jobProgress', jobProg, true);
        setProgress('dockProgress', jobProg, true);
        if ($('editorDialog')?.open) setProgress('editorProgress', jobProg, true);
      }
      if (activeProgressId) setProgress(activeProgressId, jobProg, true);
      if (translationRunning) setProgress('translationProgress', jobProg, true);
      if (storageSwitchBusy) setProgress('storageProgress', rawProg, true);
      if (state.modelBusy) {
        const monotonic = typeof modelCurrentProgress === 'number' ? Math.max(modelCurrentProgress, rawProg) : rawProg;
        syncModelProgressUi(monotonic, true, latest?.message || latestWithProgress.message || modelCurrentLabel);
      }
    }
    if (payload.entries?.length) renderActivity();
  } catch { /* the server may be shutting down; do not create a toast loop */ }
  finally { activityPollInFlight = false; }
}
function isActivityHighRate() {
  return Boolean(jobBusy || state.modelBusy || translationRunning || exportRunning || checkingEngineUpdates || storageSwitchBusy);
}
function scheduleActivityPoll(immediate = false) {
  if (sessionCloseSent) return;
  if (activityPollTimer) { clearTimeout(activityPollTimer); activityPollTimer = null; }
  if (document.hidden || !isActivityHighRate()) return;
  const delay = immediate ? 0 : (state.modelBusy ? 350 : 650);
  activityPollTimer = setTimeout(async () => {
    activityPollTimer = null;
    await pollActivity();
    scheduleActivityPoll(false);
  }, delay);
  activityPollTimer.unref?.();
}
function startActivityFeed() {
  pollActivity().finally(() => scheduleActivityPoll(false));
  $('activityDetails')?.addEventListener('toggle', (ev) => {
    if (ev.target?.open && !sessionCloseSent) pollActivity().catch(() => {});
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && isActivityHighRate()) scheduleActivityPoll(true);
    else if (activityPollTimer && (document.hidden || !isActivityHighRate())) {
      clearTimeout(activityPollTimer);
      activityPollTimer = null;
    }
  });
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
    sessionTimer = setInterval(heartbeat, 45000);
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
  stopTrialCountdown();
  if (sessionTimer) { clearInterval(sessionTimer); sessionTimer = null; }
  if (activityPollTimer) { clearTimeout(activityPollTimer); activityPollTimer = null; }
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
  try { el.hidePopover?.(); el.showPopover?.(); } catch { /* non-popover fallback */ }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => {
      if (!el.classList.contains('show')) {
        try { el.hidePopover?.(); } catch { /* ignore */ }
      }
    }, 220);
  }, error ? 7000 : 3400);
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
    if (response.status === 499 || payload?.cancelled === true) {
      const abortErr = new Error(detail || 'عملیات توسط کاربر لغو شد.');
      abortErr.name = 'AbortError'; abortErr.cancelled = true; abortErr.status = 499;
      throw abortErr;
    }
    const error = new Error(`${method} ${path} — HTTP ${response.status}: ${detail}`);
    error.status = response.status; error.detailText = detail; error.code = payload?.code; error.errorId = payload?.error_id;
    if ((response.status === 402 || (response.status === 401 && payload?.code === 'LOGIN_REQUIRED')) && !path.startsWith('/api/license/')) {
      refreshAuthGateState().catch(() => {});
    }
    if (payload?.kind === 'invalid_context_response') { error.responseText = payload.response_text; error.recoveryToken = payload.recovery_token; error.responseTruncated = payload.response_truncated; }
    if (payload?.kind === 'pending_result') { error.pendingId = payload.pending_id; error.pendingKind = payload.pending_kind; }
    if (payload?.kind === 'unstored_result') error.unstoredResult = `${payload.translation || ''}\nخلاصه: ${payload.summary || ''}`;
    if (payload?.kind === 'hardware_warning') { error.hardwareWarning = true; error.warnings = payload.warnings || []; error.hardwareCheck = payload.hardwareCheck || null; }
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
  const inputVal = $('appModalInput')?.value ?? '';
  if ($('appModalInputWrap')) $('appModalInputWrap').classList.add('hidden');
  closeDialog('appModalDialog');
  try { current.returnFocus?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
  if (current.promptMode) {
    if (!result) current.resolve(null);
    else current.resolve(inputVal.trim() || current.fallbackValue || '');
  } else {
    current.resolve(Boolean(result));
  }
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
    focusConfirm = false,
    cancelJobKind = null,
    promptMode = false,
    inputLabel = 'نام پروژه',
    placeholder = '',
    defaultValue = '',
    fallbackValue = '',
  } = options;
  if (cancelJobKind && pendingCancelModals.has(cancelJobKind)) return pendingCancelModals.get(cancelJobKind);
  const dlg = $('appModalDialog');
  if (!dlg) return Promise.resolve(promptMode ? (defaultValue || fallbackValue || null) : !alertOnly);
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
    const inputWrap = $('appModalInputWrap');
    const inputEl = $('appModalInput');
    if (inputWrap && inputEl) {
      inputWrap.classList.toggle('hidden', !promptMode);
      if ($('appModalInputLabel')) $('appModalInputLabel').textContent = inputLabel;
      inputEl.placeholder = placeholder;
      inputEl.value = promptMode ? defaultValue : '';
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
    activeModalState = { resolve, returnFocus, cancelJobKind, alertOnly, promptMode, fallbackValue, promise: queued };
    showDialog('appModalDialog');
    queueMicrotask(() => {
      if (promptMode && inputEl) {
        try { inputEl.focus({ preventScroll: true }); inputEl.select(); } catch { /* ignore */ }
        return;
      }
      const preferCancel = destructive && !alertOnly && !focusConfirm;
      const target = (preferCancel ? cancelBtn : confirmBtn) || confirmBtn;
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
    focusConfirm: !!options.focusConfirm,
    alertOnly: false,
    cancelJobKind: options.cancelJobKind || null,
  });
}
function appPrompt(message, options = {}) {
  return showAppModal({
    title: options.title || 'ورود نام',
    message,
    hint: options.hint || '',
    confirmText: options.confirmText || 'ثبت',
    cancelText: options.cancelText || 'انصراف',
    variant: options.variant || 'confirm',
    destructive: false,
    alertOnly: false,
    promptMode: true,
    inputLabel: options.inputLabel || 'نام',
    placeholder: options.placeholder || '',
    defaultValue: options.defaultValue ?? '',
    fallbackValue: options.fallbackValue ?? '',
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
window.appPrompt = appPrompt;
window.appAlert = appAlert;
window.alert = (msg) => { appAlert(String(msg ?? ''), { title: 'اعلان برنامه', variant: 'warning' }); };

function notifyServerJobCancel(kind = 'all') {
  try {
    if (typeof fetch === 'function') {
      Promise.resolve(
        fetch('/api/jobs/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind }),
        }),
      ).catch(() => {});
    }
  } catch { /* ignore */ }
}

function abortRunningOcr() {
  if (!ocrRunning) return;
  ocrCancelledByUser = true;
  clearPendingTranslationOcr();
  notifyServerJobCancel('ocr');
  try { ocrAbortController?.abort(); } catch { /* ignore */ }
}
function abortRunningTranslation() {
  if (!translationRunning && !translationDecisionBusy) return;
  translationCancelledByUser = true;
  notifyServerJobCancel('translation');
  try { translationAbortController?.abort(); } catch { /* ignore */ }
}
function abortRunningExport() {
  if (!exportRunning) return;
  exportCancelledByUser = true;
  notifyServerJobCancel('export');
  try { exportAbortController?.abort(); } catch { /* ignore */ }
}
function abortRunningModelJob() {
  if (!state.modelBusy) return;
  const busyId = state.modelBusy;
  modelCancelledByUser = true;
  try {
    if (typeof fetch === 'function') {
      Promise.resolve(fetch(`/api/engines/${encodeURIComponent(busyId)}/cancel`, { method: 'POST' })).catch(() => {});
    }
  } catch { /* ignore */ }
  notifyServerJobCancel('model');
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
function releaseImgElement(img) {
  if (!img) return;
  img.onload = null;
  img.onclick = null;
  if (img.dataset) delete img.dataset.renderedSrc;
  img.removeAttribute('src');
  img.src = '';
}
function releaseWatermarkPreviewResources() {
  if (wmPreviewBitmap && wmPreviewBitmap !== state.editorBitmap) {
    try { wmPreviewBitmap.close?.(); } catch { /* ignore */ }
  }
  wmPreviewBitmap = null;
  wmPreviewImageId = null;
  const cv = $('wmPreviewCanvas');
  if (cv) { cv.width = 0; cv.height = 0; }
}
function closeDialog(id) {
  const idx = openDialogStack.indexOf(id);
  if (idx >= 0) openDialogStack.splice(idx, 1);
  if ($(id)?.open) $(id).close();
  if (id === 'previewDialog') {
    releaseImgElement($('previewImage'));
    state.previewId = null;
  } else if (id === 'cropDialog') {
    releaseImgElement($('cropImage'));
  } else if (id === 'watermarkDialog') {
    releaseWatermarkPreviewResources();
  }
}
function openHelpDialog(sectionId = null) {
  if (!helpController && window.ComicHelpGuide?.createHelpController) {
    helpController = window.ComicHelpGuide.createHelpController();
  }
  if (sectionId && helpController?.selectSection) {
    helpController.selectSection(sectionId);
  }
  showDialog('helpDialog');
}
async function requestCancelOcrDialog() {
  if ((!ocrRunning || ocrClosingNormally) && state.modelBusy && modelFromOcrDialog) {
    const cancelledModel = await requestCancelModelJob({ closeModelsDialog: false });
    if (!cancelledModel) return false;
    closeDialog('ocrDialog');
    return true;
  }
  if (!ocrRunning || ocrClosingNormally) { closeDialog('ocrDialog'); return true; }
  const ok = await appConfirm('عملیات خواندن متن (OCR) در حال اجراست. آیا مطمئن هستید که می‌خواهید این کار را متوقف و لغو کنید؟', {
    title: 'توقف عملیات در حال اجرا',
    confirmText: 'بله، متوقف شود',
    cancelText: 'خیر، ادامه دهد',
    variant: 'warning',
    destructive: true,
    focusConfirm: true,
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
    focusConfirm: true,
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
    focusConfirm: true,
    cancelJobKind: 'export',
  });
  if (!ok) return false;
  if (exportRunning) abortRunningExport();
  if (dialogId) closeDialog(dialogId);
  return true;
}
async function requestCancelModelJob(options = {}) {
  const shouldCloseModels = options.closeModelsDialog !== false;
  if (!state.modelBusy) { if (shouldCloseModels) closeDialog('modelsDialog'); return true; }
  const ok = await appConfirm('عملیات آماده‌سازی یا آزمایش مدل OCR در حال اجراست. آیا مطمئن هستید که می‌خواهید این کار را متوقف و لغو کنید؟', {
    title: 'توقف عملیات مدل OCR',
    confirmText: 'بله، متوقف شود',
    cancelText: 'خیر، ادامه دهد',
    variant: 'warning',
    destructive: true,
    focusConfirm: true,
    cancelJobKind: 'model',
  });
  if (!ok) return false;
  if (state.modelBusy) abortRunningModelJob();
  if (shouldCloseModels && $('modelsDialog')?.open) closeDialog('modelsDialog');
  return true;
}
async function requestCancelAiDialog() {
  if (!localNmtBusyModel && !localNmtTestAbortController) { closeDialog('aiDialog'); return true; }
  const ok = await appConfirm('دانلود یا آزمایش مترجم آفلاین در حال اجراست. آیا مطمئن هستید که می‌خواهید این کار را متوقف و لغو کنید؟', {
    title: 'توقف عملیات مترجم آفلاین',
    confirmText: 'بله، متوقف شود',
    cancelText: 'خیر، ادامه دهد',
    variant: 'warning',
    destructive: true,
    focusConfirm: true,
    cancelJobKind: 'local-nmt',
  });
  if (!ok) return false;
  await cancelLocalNmtPrepare();
  if (localNmtTestAbortController) {
    try { localNmtTestAbortController.abort(); } catch { /* ignore */ }
  }
  closeDialog('aiDialog');
  return true;
}
async function requestCancelActiveJob() {
  if (ocrRunning) return requestCancelOcrDialog();
  if (translationRunning || translationDecisionBusy) return requestCancelTranslationDialog();
  if (exportRunning) {
    const activeExportDlg = $('pptxExportDialog')?.open ? 'pptxExportDialog' : ($('docxExportDialog')?.open ? 'docxExportDialog' : ($('exportDialog')?.open ? 'exportDialog' : null));
    return requestCancelExport(activeExportDlg);
  }
  if (state.modelBusy) return requestCancelModelJob({ closeModelsDialog: Boolean($('modelsDialog')?.open) });
  if (localNmtBusyModel || localNmtTestAbortController) return requestCancelAiDialog();
  if (!jobBusy) return false;
  const ok = await appConfirm('عملیات در حال اجراست. آیا مطمئن هستید که می‌خواهید این کار را متوقف و لغو کنید؟', {
    title: 'توقف عملیات در حال اجرا',
    confirmText: 'بله، متوقف شود',
    cancelText: 'خیر، ادامه دهد',
    variant: 'warning',
    destructive: true,
    focusConfirm: true,
    cancelJobKind: 'job',
  });
  if (!ok) return false;
  notifyServerJobCancel('all');
  try { currentJobAbortController?.abort(); } catch { /* ignore */ }
  return true;
}
function closeTopDialog() {
  if ($('appModalDialog')?.open) { resolveActiveModal(false); return true; }
  const stackedId = [...openDialogStack].reverse().find((id) => $(id)?.open);
  const dialog = stackedId ? $(stackedId) : [...document.querySelectorAll('dialog[open]')].at(-1);
  if (!dialog) {
    if (jobBusy || state.modelBusy || localNmtBusyModel) { requestCancelActiveJob().catch(() => {}); return true; }
    return false;
  }
  if (dialog.id === 'editorDialog') closeEditor().catch((error) => toast(error.message, true));
  else if (dialog.id === 'ocrDialog') requestCancelOcrDialog().catch(() => {});
  else if (dialog.id === 'translationDialog') requestCancelTranslationDialog().catch(() => {});
  else if (dialog.id === 'exportDialog') requestCancelExport('exportDialog').catch(() => {});
  else if (dialog.id === 'docxExportDialog') requestCancelExport('docxExportDialog').catch(() => {});
  else if (dialog.id === 'pptxExportDialog') requestCancelExport('pptxExportDialog').catch(() => {});
  else if (dialog.id === 'modelsDialog') requestCancelModelJob().catch(() => {});
  else if (dialog.id === 'aiDialog') requestCancelAiDialog().catch(() => {});
  else if (dialog.id === 'translationPreviewDialog') cancelTranslationRequestPreview();
  else closeDialog(dialog.id);
  return true;
}
function sortedImages() { return G.byOrder(state.project?.images || []); }
function selectedImages() { return sortedImages().filter((item) => item.selected); }
function imageUrl(item, edited = false, cropped = false) {
  const query = new URLSearchParams();
  if (edited) query.set('edited', 'true');
  if (cropped) query.set('cropped', 'true');
  if (edited || cropped) {
    const version = imagePreviewVersions.get(`${state.project?.id}:${item.id}`);
    if (version) query.set('v', String(version));
  }
  return `/api/projects/${state.project.id}/images/${item.id}/content${query.toString() ? `?${query}` : ''}`;
}
function escapeHtml(value) { const el = document.createElement('div'); el.textContent = String(value ?? ''); return el.innerHTML; }
function plainToHtml(value) { return escapeHtml(value).replace(/\n/g, '<br>'); }
function safeName(value, fallback = 'comic-translated') {
  const raw = String(value || '').trim();
  return (raw || fallback).replace(/[<>:\"/\\|?*]/g, '-');
}
function parseExportFilename(disposition, fallback) {
  const header = String(disposition || '');
  const starMatch = header.match(/filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;\r\n]+)/);
  if (starMatch?.[1]) {
    const raw = starMatch[1].trim().replace(/^"(.*)"$/, '$1');
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  const plainMatch = header.match(/filename\s*=\s*(?:"([^"]+)"|([^;\r\n]+))/i);
  const plain = (plainMatch?.[1] || plainMatch?.[2] || '').trim();
  if (plain) {
    try { return decodeURIComponent(plain); } catch { return plain; }
  }
  return fallback;
}
function sanitizeHtml(html) { return window.ComicSanitize.sanitize(html); }

function setBusy(message) {
  const wasBusy = jobBusy;
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
    $('editorCancelJobBtn')?.classList.toggle('hidden', !showEditorBar);
    setProgress('editorProgress', null, showEditorBar);
  }
  if (translationRunning) {
    $('translationStatus').textContent = message || 'آماده';
    setProgress('translationProgress', null, !!message);
  }
  if (wasBusy && !jobBusy) pollActivity().catch(() => {});
  scheduleActivityPoll(!!message);
  document.querySelectorAll('.main-actions button, .main-actions .file-button, #dock button:not(#dockCancelJobBtn), #backupProjectBtn, #restoreProjectBtn, #restoreProjectInput, #newProjectBtn, #deleteProjectBtn, #projectSelect, #projectName').forEach((el) => { el.disabled = !!message; });
}
async function runJob(message, task, progressId = null) {
  await clearActivity(false);
  const jobController = new AbortController();
  currentJobAbortController = jobController;
  jobProgressTransform = { offset: 0, scale: 1, floor: 0 };
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
    jobProgressTransform = null;
    dismissJobCancelModal('job');
    if (progressId) setProgress(progressId, completed ? 1 : 0, false);
    setProgress('dockProgress', completed ? 1 : 0, false);
    if ($('editorDialog')?.open) setProgress('editorProgress', completed ? 1 : 0, false);
    activeProgressId = null; setBusy('');
    setProgress('jobProgress', completed ? 1 : 0, false);
  }
}
function scheduleSave() {
  clearTimeout(saveTimer); savePending = true;
  if (editorSessionSnapshot && state.editorId === editorSessionSnapshot.imageId) editorSessionSnapshot.autoSaved = true;
  ++saveRevision; $('saveState').textContent = 'در حال ذخیره…';
  saveTimer = setTimeout(() => saveProject().catch((error) => toast(error.message, true)), 350);
}
async function saveProject() {
  clearTimeout(saveTimer); savePending = false;
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
function adoptProject(project, options = {}) {
  const prevProjectId = state.project?.id || null;
  if (prevProjectId && prevProjectId !== project?.id) {
    clearBackupDownloadLink();
    clearExportDownloadLink();
  }
  state.project = project;
  state.project.images = project.images || [];
  G.normalizeLayout(state.project.images);
  state.groupEditId = null; state.groupSnapshot = null;
  const projName = String(project.name || '').trim() || 'پروژهٔ کمیک';
  $('projectName').value = projName;
  const settings = project.settings || {};
  const pageMode = settings.ocrPageMode === 'document' ? 'document' : 'comic';
  if ($('ocrPageMode')) $('ocrPageMode').value = pageMode;
  if ($('modelsPageMode')) $('modelsPageMode').value = pageMode;
  const ocrLang = settings.ocrLanguage || 'eng';
  $('ocrLanguage').value = ocrLang;
  if ($('modelsLanguage')) $('modelsLanguage').value = ocrLang;
  if ($('testLanguage')) $('testLanguage').value = ocrLang;
  const targetLang = normalizeTargetLanguage(settings.targetLanguage || state.ai?.target_language || 'fa');
  if ($('translationTargetLang')) $('translationTargetLang').value = targetLang;
  if (state.engines.length) {
    updateEngineOptions(settings.ocrEngine || 'rapidocr-v6');
  } else {
    $('ocrEngine').value = settings.ocrEngine || 'rapidocr-v6';
  }
  $('ocrContrast').checked = settings.contrast !== false;
  $('ocrPrecise').checked = settings.precise !== false;
  if ($('ocrPersianPreprocess')) {
    $('ocrPersianPreprocess').checked = settings.persianPreprocessCustomized === true
      ? Boolean(settings.persianPreprocess)
      : (ocrLang === 'fas' ? true : Boolean(settings.persianPreprocess));
  }
  $('ocrGroupLines').checked = settings.groupOcrLines !== false;
  $('ocrErase').checked = settings.eraseOriginal !== false;
  const output = settings.output || {};
  const rawOutName = String(output.name || '').trim();
  const hasCustomizedFlag = typeof output.nameCustomized === 'boolean';
  const isCustomExportName = hasCustomizedFlag
    ? Boolean(output.nameCustomized && rawOutName && rawOutName !== projName)
    : Boolean(rawOutName && rawOutName !== 'comic-translated' && rawOutName !== projName);
  const effectiveOutName = isCustomExportName ? rawOutName : projName;
  output.nameCustomized = isCustomExportName;
  output.name = effectiveOutName;
  settings.output = output;
  project.settings = settings;
  $('exportName').value = effectiveOutName;
  $('exportSeamless').checked = !!output.seamless;
  $('exportUniform').checked = !!output.uniformSize;
  $('exportTwo').checked = !!output.twoPerPage;
  $('exportFormat').value = output.imageFormat || 'orig';
  $('exportFolder').value = output.folderName || '';
  if ($('exportDocxLayout')) $('exportDocxLayout').value = output.docxLayout === 'flowing' ? 'flowing' : 'visual';
  if ($('exportPptxLayout')) $('exportPptxLayout').value = output.pptxLayout === 'flowing' ? 'flowing' : 'visual';
  setOverlayMode(settings.overlayMode || 'translation', false);
  if (options.skipGrid) updateEngineOptions();
  else renderAll();
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
  if (block.manual && !String(block.text || '').trim() && (String(block.tr || '').trim() || String(block.richHtml || '').trim())) return 'translation';
  return mode === 'ocr' ? 'ocr' : 'translation';
}
function blockOverlayMode(block, mode = currentOverlayMode()) {
  return mode === 'none' ? 'none' : blockTextMode(block, mode);
}
function overlayBlock(block, mode = currentOverlayMode()) {
  const effectiveMode = blockOverlayMode(block, mode);
  if (effectiveMode === 'none') return { ...block, tr: '', richHtml: '', manual: false };
  if (effectiveMode !== 'ocr') return block;
  if (block.manual && !String(block.text || '').trim() && (String(block.tr || '').trim() || String(block.richHtml || '').trim())) return block;
  const ocrRtl = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/.test(block.text || '') && !/[A-Za-z]{3,}/.test(block.text || '');
  const resolvedDir = (block.ocrDir === 'rtl' || block.ocrDir === 'ltr') ? block.ocrDir : (ocrRtl ? 'rtl' : 'ltr');
  const ocrRich = String(block.ocrRichHtml || '').trim();
  return {
    ...block,
    tr: block.text || '',
    richHtml: ocrRich,
    dir: resolvedDir,
    align: ['left', 'right', 'center', 'justify'].includes(block.align) ? block.align : (resolvedDir === 'rtl' ? 'right' : 'left'),
    _plainText: !ocrRich,
  };
}
function overlayBlocks(item, mode = currentOverlayMode()) { return (item.blocks || []).map((block) => overlayBlock(block, mode)); }
function hasRenderableText(block) { return !!block.tr?.trim() || !!(!block._plainText && block.richHtml && Typeset.richHtmlWords(block.richHtml).some((word) => String(word.t || '').trim())); }
function hasRenderableShapeFill(block) {
  if (!block || !block.manual) return false;
  const bg = String(block.bg || '');
  if (!bg || bg === 'none') return false;
  return normalizeShapeKey(block.shape) !== 'rect' || normalizeRadiusPct(block.cornerRadius) > 0;
}
function hasActiveWatermark(wm) {
  if (!wm || typeof wm !== 'object' || wm.enabled === false) return false;
  if (typeof Typeset?.hasActiveWatermark === 'function') return Typeset.hasActiveWatermark(wm);
  return Boolean(String(wm.text || '').trim() || wm.logoId || wm.logoDataUrl);
}
function hasOverlayText(item, mode = currentOverlayMode()) {
  return overlayBlocks(item, mode).some((block) => block.enabled && (hasRenderableText(block) || hasRenderableShapeFill(block))) || hasActiveWatermark(item?.watermark);
}
function renderAll() { renderGrid(); updateEngineOptions(); }
function makeSummaryPill(text, extraClass = '') {
  const pill = document.createElement('span');
  pill.className = `summary-pill${extraClass ? ` ${extraClass}` : ''}`;
  const dot = document.createElement('span');
  dot.className = 'summary-pill-dot';
  dot.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.textContent = text;
  pill.append(dot, label);
  return pill;
}
function updateSummary() {
  const images = state.project?.images || [];
  const total = images.length;
  const selected = selectedImages().length;
  const approved = images.filter((item) => item.approved).length;
  const groups = G.info(images).length;
  const summaryEl = $('selectionSummary');
  if (summaryEl) {
    summaryEl.textContent = '';
    if (!total) {
      const empty = document.createElement('span');
      empty.className = 'summary-empty';
      empty.textContent = 'هنوز فایلی وارد نشده است';
      summaryEl.appendChild(empty);
    } else {
      summaryEl.append(
        makeSummaryPill(`${selected} از ${total} انتخاب شده`, 'pill-select'),
        makeSummaryPill(`${approved} از ${total} تأیید شده`, `pill-approve${approved ? ' has-approved' : ''}`),
        makeSummaryPill(`${groups} گروه`, `pill-group${groups ? ' has-groups' : ''}`),
      );
    }
  }
  $('emptyState').classList.toggle('hidden', total > 0);
  $('ocrBtn').disabled = !total; $('translateBtn').disabled = !total;
  $('exportBtn').disabled = !total;
  ['selectAllBtn', 'selectNoneBtn', 'invertBtn', 'groupBtn', 'ungroupBtn', 'watermarkBtn', 'duplicateBtn', 'deleteBtn',
    'approveSelectedBtn', 'unapproveSelectedBtn', 'selectApprovedBtn', 'selectUnapprovedBtn'].forEach((id) => {
    const btn = $(id);
    if (btn) btn.disabled = !total;
  });
}
function toggleImageApproved(imageId, nextValue = null) {
  const item = state.project?.images.find((entry) => entry.id === imageId);
  if (!item) return;
  item.approved = nextValue === null ? !item.approved : !!nextValue;
  if (state.editorId === item.id) syncEditorApprovalHeader(item);
  renderGrid();
  scheduleSave();
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

function getWindowScrollPosition() {
  const docEl = document.documentElement;
  const body = document.body;
  return {
    x: Number(window.scrollX) || Number(window.pageXOffset) || Number(docEl?.scrollLeft) || Number(body?.scrollLeft) || 0,
    y: Number(window.scrollY) || Number(window.pageYOffset) || Number(docEl?.scrollTop) || Number(body?.scrollTop) || 0,
  };
}
function applyWindowScrollPosition(x, y) {
  const tx = Math.max(0, Math.round(Number(x) || 0));
  const ty = Math.max(0, Math.round(Number(y) || 0));
  if (document.documentElement) {
    document.documentElement.scrollTop = ty;
    document.documentElement.scrollLeft = tx;
  }
  const isDefaultJsdomScroll = /jsdom/i.test(window.navigator?.userAgent || '')
    && typeof window.scrollTo === 'function'
    && String(window.scrollTo).includes('notImplemented');
  if (!isDefaultJsdomScroll && typeof window.scrollTo === 'function') {
    try {
      window.scrollTo({ left: tx, top: ty, behavior: 'instant' });
    } catch {
      try { window.scrollTo(tx, ty); } catch { /* non-scrolling env */ }
    }
  }
}
function findGridCardById(imageId) {
  const grid = $('grid');
  if (!grid || imageId == null) return null;
  const key = String(imageId);
  return [...grid.querySelectorAll('.item')].find((c) => c.dataset?.id === key) || null;
}
function captureEditorReturnScroll(imageId) {
  const pos = getWindowScrollPosition();
  const mainWrap = $('mainwrap');
  const card = findGridCardById(imageId);
  const rect = card?.getBoundingClientRect?.();
  return {
    projectId: state.project?.id || null,
    imageId: String(imageId),
    scrollX: pos.x,
    scrollY: pos.y,
    mainScrollTop: Number(mainWrap?.scrollTop || 0) || 0,
    mainScrollLeft: Number(mainWrap?.scrollLeft || 0) || 0,
    cardTop: rect && Number.isFinite(rect.top) ? rect.top : null,
    cardHeight: rect && Number.isFinite(rect.height) ? rect.height : 0,
  };
}
function restoreEditorReturnScroll(saved) {
  if (!saved || (saved.projectId && state.project?.id && saved.projectId !== state.project.id)) return;
  const applyOnce = () => {
    const mainWrap = $('mainwrap');
    if (mainWrap) {
      if (saved.mainScrollTop > 0 || mainWrap.scrollTop !== saved.mainScrollTop) mainWrap.scrollTop = saved.mainScrollTop;
      if (saved.mainScrollLeft > 0 || mainWrap.scrollLeft !== saved.mainScrollLeft) mainWrap.scrollLeft = saved.mainScrollLeft;
    }
    applyWindowScrollPosition(saved.scrollX, saved.scrollY);
    const card = findGridCardById(saved.imageId);
    if (!card) return;
    if (saved.cardTop !== null && saved.cardHeight > 0) {
      const nowRect = card.getBoundingClientRect?.();
      if (nowRect && nowRect.height > 0) {
        const drift = nowRect.top - saved.cardTop;
        if (Math.abs(drift) > 2) {
          applyWindowScrollPosition(saved.scrollX, Math.max(0, saved.scrollY + drift));
        }
      }
    }
    const editBtn = card.querySelector('.act button:nth-child(2)') || card.querySelector('.act button');
    if (editBtn?.focus) {
      try { editBtn.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
    clearTimeout(justEditedHighlightTimer);
    document.querySelectorAll('#grid .item.just-edited').forEach((el) => el.classList.remove('just-edited'));
    card.classList.add('just-edited');
    justEditedHighlightTimer = setTimeout(() => { card.classList.remove('just-edited'); }, 1800);
  };
  applyOnce();
  requestAnimationFrame(() => {
    if ($('editorDialog')?.open) return;
    const mainWrap = $('mainwrap');
    if (mainWrap && saved.mainScrollTop > 0 && mainWrap.scrollTop !== saved.mainScrollTop) mainWrap.scrollTop = saved.mainScrollTop;
    const cur = getWindowScrollPosition();
    if (Math.abs(cur.y - saved.scrollY) > 2 || Math.abs(cur.x - saved.scrollX) > 2) {
      applyWindowScrollPosition(saved.scrollX, saved.scrollY);
    }
  });
}

// ---------- Grid, group manager, and drag/drop ----------
function renderGrid() {
  const grid = $('grid'); if (!state.project) return;
  const savedWinScroll = getWindowScrollPosition();
  const mainWrap = $('mainwrap');
  const savedMainTop = Number(mainWrap?.scrollTop || 0) || 0;
  const savedMainLeft = Number(mainWrap?.scrollLeft || 0) || 0;
  G.normalizeLayout(state.project.images);
  const prevImages = new Map();
  grid.querySelectorAll('.item').forEach((oldCard) => {
    const oldImg = oldCard.querySelector('.tw > img');
    if (oldCard.dataset?.id && oldImg) prevImages.set(oldCard.dataset.id, oldImg);
  });
  const frag = document.createDocumentFragment();
  const infos = G.info(state.project.images); const byId = new Map(infos.map((info) => [info.key, info]));
  sortedImages().forEach((item, index) => {
    const info = G.validId(item.groupId) ? byId.get(G.idKey(item.groupId)) : null;
    const card = document.createElement('article');
    card.className = `item${item.selected ? ' selected' : ''}${item.approved ? ' approved' : ''}${info ? ' in-group' : ''}${item.crop ? ' cropped' : ''}${state.groupEditId && info && G.idKey(state.groupEditId) === info.key ? ' group-focus' : ''}`;
    card.dataset.id = item.id; card.draggable = true;
    if (info) card.style.setProperty('--group-color', groupColor(info.id));
    const frameShell = document.createElement('div'); frameShell.className = 'tw-shell';
    const frame = document.createElement('div'); frame.className = 'tw';
    const nextSrc = imageUrl(item, !!item.edited, Boolean(item.crop || (!item.edited && hasActiveWatermark(item.watermark))));
    const reusable = prevImages.get(item.id);
    let image;
    if (reusable && reusable.dataset?.renderedSrc === nextSrc) {
      prevImages.delete(item.id);
      image = reusable;
      image.alt = item.name;
    } else {
      if (reusable) {
        prevImages.delete(item.id);
        releaseImgElement(reusable);
      }
      image = document.createElement('img');
      image.loading = 'lazy';
      image.decoding = 'async';
      image.alt = item.name;
      image.draggable = false;
      image.dataset.renderedSrc = nextSrc;
      image.src = nextSrc;
    }
    image.onload = scheduleOutlines;
    image.onclick = (event) => {
      event.stopPropagation();
      const live = state.project?.images.find((entry) => entry.id === item.id) || item;
      setSelected(live, !live.selected, event);
    };
    frame.appendChild(image);
    frameShell.appendChild(frame);
    if (item.approved) {
      const stamp = document.createElement('div');
      stamp.className = 'approval-stamp';
      stamp.setAttribute('aria-label', 'تأیید نهایی شده');
      const stampCheck = document.createElement('span'); stampCheck.className = 'approval-stamp-check'; stampCheck.textContent = '✓';
      const stampText = document.createElement('span'); stampText.className = 'approval-stamp-text'; stampText.textContent = 'تأیید شد';
      stamp.append(stampCheck, stampText);
      frameShell.appendChild(stamp);
    }
    if (hasActiveWatermark(item.watermark)) {
      const wmBadge = document.createElement('div');
      wmBadge.className = 'watermark-badge';
      wmBadge.textContent = 'واترمارک';
      wmBadge.title = 'دارای واترمارک فعال روی این صفحه';
      frameShell.appendChild(wmBadge);
    }
    const tick = document.createElement('input'); tick.type = 'checkbox'; tick.className = 'tick'; tick.checked = !!item.selected; tick.setAttribute('aria-label', `انتخاب ${item.name}`);
    tick.addEventListener('click', (event) => {
      // The browser has already applied the new checkbox value; consume this one click without cancelling it.
      event.stopPropagation(); setSelected(item, tick.checked, event);
    });
    const act = document.createElement('div'); act.className = 'act';
    const approveBtn = makeButton('✓', () => toggleImageApproved(item.id), `bt approve-mark${item.approved ? ' is-approved' : ''}`);
    approveBtn.title = item.approved ? 'برداشتن مهر تأیید نهایی این صفحه' : 'زدن مهر تأیید نهایی (آمادهٔ خروجی)';
    approveBtn.setAttribute('aria-label', approveBtn.title);
    approveBtn.setAttribute('aria-pressed', String(!!item.approved));
    act.append(
      makeButton('👁', () => openPreview(item), 'bt'),
      makeButton('✎', () => openEditor(item.id), 'bt'),
      makeButton('✂', () => openCrop(item.id), 'bt crop-mark'),
      makeButton('⧉', () => duplicateImages([item.id]), 'bt'),
      makeButton('🗑', () => deleteImages([item.id]), 'bt danger'),
      approveBtn,
    );
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
    meta.textContent = `${item.width}×${item.height} · ${item.blocks?.length || 0} متن${item.crop ? ' · برش' : ''}${hasActiveWatermark(item.watermark) ? ' · واترمارک' : ''}${item.edited ? ' · ویرایش' : ''}${item.approved ? ' · تأیید ✓' : ''}`;
    card.append(frameShell, tick, act, name, meta);
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
    frag.appendChild(card);
  });
  grid.replaceChildren(frag);
  prevImages.forEach((staleImg) => releaseImgElement(staleImg));
  prevImages.clear();
  renderGroupPanel(); updateSummary(); scheduleOutlines();
  if (mainWrap) {
    if (savedMainTop > 0 && mainWrap.scrollTop !== savedMainTop) mainWrap.scrollTop = savedMainTop;
    if (savedMainLeft > 0 && mainWrap.scrollLeft !== savedMainLeft) mainWrap.scrollLeft = savedMainLeft;
  }
  const afterScroll = getWindowScrollPosition();
  if ((savedWinScroll.y > 0 || savedWinScroll.x > 0) && (afterScroll.y !== savedWinScroll.y || afterScroll.x !== savedWinScroll.x)) {
    applyWindowScrollPosition(savedWinScroll.x, savedWinScroll.y);
  }
}
function moveImageBy(imageId, delta) { G.moveUnit(state.project.images, imageId, delta); renderGrid(); scheduleSave(); }
async function duplicateImages(ids) { if (!ids.length) return; if (!isModuleLicensed('editing')) { await ensureModuleLicensed('editing'); return; } await saveProject(); adoptProject(await api(`/api/projects/${state.project.id}/duplicate`, jsonOptions('POST', ids))); }
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
  const deletingProjectId = state.project?.id;
  await saveProject();
  if (deletingProjectId) ids.forEach((imgId) => renderedPageSignatures.delete(`${deletingProjectId}:${imgId}`));
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
async function refreshProjectList(prefetched = null) {
  const projects = Array.isArray(prefetched) ? prefetched : await api('/api/projects');
  const select = $('projectSelect'); const current = state.project?.id; select.textContent = '';
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
    adoptProject(project);
    await refreshProjectList();
    const mismatchedIds = sortedImages().filter((item) => hasOverlayText(item) !== !!item.edited).map((item) => item.id);
    if (mismatchedIds.length) await renderImagesText(mismatchedIds);
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
async function waitForPendingRenders(projectId = null) {
  await waitForProjectLoads();
  if (editorCloseTask) await editorCloseTask.catch(() => {});
  await overlayPreviewTask.catch(() => {});
  const prefix = projectId ? `${projectId}:` : '';
  while (true) {
    const pending = [...imageRenderTasks.entries()]
      .filter(([key]) => !prefix || key.startsWith(prefix))
      .map(([, task]) => task);
    if (!pending.length) break;
    await Promise.allSettled(pending);
  }
}
function collectOutputSettings() {
  if (!state.project) return; state.project.settings = state.project.settings || {};
  const projName = String(state.project.name || '').trim() || 'پروژهٔ کمیک';
  const rawExport = $('exportName').value.trim();
  const nameCustomized = Boolean(rawExport && rawExport !== projName);
  const effectiveName = rawExport || projName;
  state.project.settings.output = { name: effectiveName, nameCustomized, seamless: $('exportSeamless').checked, uniformSize: $('exportUniform').checked, twoPerPage: $('exportTwo').checked, imageFormat: $('exportFormat').value, folderName: $('exportFolder').value, docxLayout: $('exportDocxLayout')?.value || 'visual', pptxLayout: $('exportPptxLayout')?.value || 'visual' };
}
function collectOcrSettings() {
  if (!state.project) return;
  state.project.settings = state.project.settings || {};
  Object.assign(state.project.settings, {
    ocrEngine: $('ocrEngine').value,
    ocrLanguage: $('ocrLanguage').value,
    ocrPageMode: normalizePageMode($('ocrPageMode')?.value),
    contrast: $('ocrContrast').checked,
    precise: $('ocrPrecise').checked,
    persianPreprocess: Boolean($('ocrPersianPreprocess')?.checked),
    persianPreprocessCustomized: Boolean(state.project.settings.persianPreprocessCustomized),
    groupOcrLines: $('ocrGroupLines').checked,
    eraseOriginal: $('ocrErase').checked,
  });
}
const OCR_LANGUAGE_LABELS = {
  eng: 'English',
  fas: 'فارسی',
  kor: '한국어',
  jpn: '日本語',
  chi_sim: '中文',
};
const TARGET_LANGUAGE_META = {
  fa: { label: 'فارسی (Persian)', dir: 'rtl', align: 'right' },
  en: { label: 'انگلیسی (English)', dir: 'ltr', align: 'left' },
  ar: { label: 'عربی (Arabic)', dir: 'rtl', align: 'right' },
  tr: { label: 'ترکی استانبولی (Turkish)', dir: 'ltr', align: 'left' },
  de: { label: 'آلمانی (German)', dir: 'ltr', align: 'left' },
  fr: { label: 'فرانسوی (French)', dir: 'ltr', align: 'left' },
  ru: { label: 'روسی (Russian)', dir: 'ltr', align: 'left' },
  es: { label: 'اسپانیایی (Spanish)', dir: 'ltr', align: 'left' },
  ja: { label: 'ژاپنی (Japanese)', dir: 'ltr', align: 'left' },
  ko: { label: 'کره‌ای (Korean)', dir: 'ltr', align: 'left' },
  'zh-CN': { label: 'چینی (Chinese)', dir: 'ltr', align: 'left' },
};
function normalizeTargetLanguage(value) {
  const raw = String(value || '').trim();
  if (raw && Object.prototype.hasOwnProperty.call(TARGET_LANGUAGE_META, raw)) return raw;
  const lower = raw.toLowerCase();
  if (lower === 'fas' || lower === 'per') return 'fa';
  if (lower === 'eng') return 'en';
  if (lower === 'zh' || lower === 'zh-cn' || lower === 'chi_sim') return 'zh-CN';
  const match = Object.keys(TARGET_LANGUAGE_META).find((key) => key.toLowerCase() === lower);
  return match || 'fa';
}
function activeTargetLanguage() {
  return normalizeTargetLanguage(
    $('translationTargetLang')?.value
    || state.project?.settings?.targetLanguage
    || state.ai?.target_language
    || 'fa',
  );
}
function targetLanguageDir(lang) {
  const code = normalizeTargetLanguage(lang);
  return TARGET_LANGUAGE_META[code]?.dir || 'rtl';
}
const DEFAULT_ENGINE_SUITABILITY = {
  'rapidocr-v6': {
    comic: { tier: 'best', reason: 'تشخیص سریع و دقیق حباب‌های گفتگوی کمیک و مانگا روی هر سیستمی (بدون نیاز به GPU).' },
    document: { tier: 'medium', reason: 'خط‌خوانی سریع روی CPU؛ برای چیدمان پیچیدهٔ کتاب و مقاله موتورهای سبز (مثل Surya، PaddleOCR-VL یا Tesseract) دقیق‌ترند.' },
    auto: { tier: 'best', reason: 'سریع‌ترین انتخاب متعادل برای صفحات ترکیبی کمیک و متن روزمره روی همهٔ سیستم‌ها.' },
  },
  'rapidocr-v5': {
    comic: { tier: 'best', reason: 'عالی برای کمیک، مانگا و به‌ویژه مانهوای کره‌ای با سرعت بالا روی هر سیستمی.' },
    document: { tier: 'medium', reason: 'سبک و چندزبانه (شامل کره‌ای و فارسی)، اما روی فونت‌های ریز و متراکم کتاب متوسط است.' },
    auto: { tier: 'medium', reason: 'گزینهٔ سبک چندزبانه؛ در انگلیسی دقت PP-OCRv6 و مدل‌های چیدمان بالاتر است.' },
  },
  easyocr: {
    comic: { tier: 'best', reason: 'تشخیص بسیار خوب حروف و حباب‌های منحنی یا پراکندهٔ کمیک در زبان‌های مختلف (شامل فارسی).' },
    document: { tier: 'weak', reason: 'فاقد تحلیل ساختار پاراگراف و ستون؛ در صفحات پُرمتن کتاب کند است و فاصلهٔ کلمات ریز را گاهی اشتباه می‌گیرد.' },
    auto: { tier: 'medium', reason: 'مناسب حباب‌های کمیک است اما برای صفحات متراکم کتاب و مقاله توصیه نمی‌شود.' },
  },
  tesseract: {
    comic: { tier: 'weak', reason: 'طراحی‌شده برای اسناد مسطح؛ روی فونت‌های فانتزی کمیک، حباب‌های منحنی و پس‌زمینهٔ نقاشی عملکرد ضعیفی دارد.' },
    document: { tier: 'best', reason: 'عملکرد عالی، سریع و کم‌مصرف برای کتاب، مقاله و جزوه‌های چاپی یا اسکن‌شدهٔ تمیز با صفحه‌بندی خودکار ستون‌ها.' },
    auto: { tier: 'medium', reason: 'عالی برای صفحات کتاب و مقاله، ولی اگر صفحه کمیک باشد روی حباب‌ها ضعیف عمل می‌کند.' },
  },
  'hezar-ocr': {
    comic: { tier: 'weak', reason: 'مدل بومی تخصصی زبان فارسی است؛ زبان را روی «فارسی» قرار دهید تا در حالت عالی (سبز) اجرا شود.' },
    document: { tier: 'weak', reason: 'مدل بومی تخصصی زبان فارسی است؛ زبان را روی «فارسی» قرار دهید تا با بالاترین دقت اجرا شود.' },
    auto: { tier: 'weak', reason: 'مخصوص متون فارسی (CRAFT + CRNN-fa-v2).' },
  },
  'paddleocr-vl-1-6': {
    comic: { tier: 'medium', reason: 'دقت خواندن متن بالاست اما بیشتر برای چیدمان اسناد ساخته شده و از موتورهای کمیک سنگین‌تر است.' },
    document: { tier: 'best', reason: 'فوق‌العاده برای کتاب، مقالات چندستونی، تیترها و جداول با تشخیص هوشمند ساختار صفحه.' },
    auto: { tier: 'best', reason: 'تشخیص هوشمند چیدمان برای پروژه‌های ترکیبی، کتاب‌های مصور و مقالات.' },
  },
  surya: {
    comic: { tier: 'medium', reason: 'حباب‌های ساده را می‌خواند اما برای فونت‌های دفرمه و جلوه‌های صوتی کمیک بهینه نشده است.' },
    document: { tier: 'best', reason: 'یکی از بهترین موتورها برای کتاب، مقالهٔ علمی، جزوه و تشخیص دقیق ترتیب سطرها و ستون‌ها.' },
    auto: { tier: 'best', reason: 'عملکرد قوی و چندزبانه روی صفحات کتاب، جزوه و کتاب‌های مصور.' },
  },
  'mineru-2-5-pro': {
    comic: { tier: 'weak', reason: 'مخصوص مقالات و اسناد علمی است؛ پنل‌های نقاشی کمیک را به‌عنوان تصویر غیرمتنی رد یا ناقص بخش‌بندی می‌کند.' },
    document: { tier: 'best', reason: 'تخصصی‌ترین موتور برای کتاب‌های درسی، مقالات دانشگاهی چندستونی، جداول و جزوه‌های پیچیده.' },
    auto: { tier: 'weak', reason: 'تک‌منظوره برای کتاب و مقاله است و روی کمیک ضعیف عمل می‌کند؛ برای کتاب، نوع صفحه را روی «کتاب و مقاله» بگذارید.' },
  },
  'got-ocr-2': {
    comic: { tier: 'best', reason: 'مدل بینایی دقیق برای خواندن فونت‌های خاص داخل حباب‌های برش‌خوردهٔ کمیک و مانگا.' },
    document: { tier: 'medium', reason: 'متن پاراگراف‌ها را خوب می‌خواند اما تحلیل مستقیم ستون‌بندی کل صفحه را ندارد و کندتر از Surya است.' },
    auto: { tier: 'medium', reason: 'دقت خوب روی برش‌های متنی کمیک و پاراگراف‌های کوتاه، با سرعت متوسط روی CPU.' },
  },
  'glm-ocr': {
    comic: { tier: 'best', reason: 'مدل بینایی‌ـ‌زبان قدرتمند در خواندن دیالوگ‌های کمیک، مانگا و فونت‌های دشوار.' },
    document: { tier: 'medium', reason: 'کیفیت خوانش خوب روی بلوک‌های متن، ولی در صفحات خیلی پُرمتن کندتر از موتورهای تخصصی چیدمان سند است.' },
    auto: { tier: 'best', reason: 'انعطاف‌پذیری بالا هم روی حباب‌های کمیک و هم روی پاراگراف‌های کتاب.' },
  },
  'dots-ocr': {
    comic: { tier: 'medium', reason: 'قادر به خواندن کادرهاست اما نیازمند GPU قوی است و تمرکز اصلی آن روی اسناد است.' },
    document: { tier: 'best', reason: 'عالی برای تشخیص هم‌زمان مختصات کادرها، ستون‌ها و متن در کتاب و مقاله (نیازمند NVIDIA GPU ≥ 8GB).' },
    auto: { tier: 'medium', reason: 'دقیق ولی سنگین (نیازمند کارت گرافیک NVIDIA)؛ بیشتر مناسب اسناد و کتاب است.' },
  },
  'deepseek-ocr-2': {
    comic: { tier: 'medium', reason: 'متن را دقیق می‌خواند ولی برای صفحات کمیک بسیار سنگین است (نیازمند GPU ≥ 12GB).' },
    document: { tier: 'best', reason: 'دقت بسیار بالا در مکان‌یابی و استخراج متون متراکم کتاب، مقاله و جداول (روی NVIDIA GPU ≥ 12GB).' },
    auto: { tier: 'medium', reason: 'مدل سنگین مخصوص سیستم‌های دارای GPU قوی؛ در اسناد و کتاب درخشان‌تر از کمیک است.' },
  },
  olmocr: {
    comic: { tier: 'weak', reason: 'صرفاً روی مقالات و کتاب‌های PDF آموزش دیده و برای حباب‌های کمیک و مانگا نامناسب و بسیار سنگین است.' },
    document: { tier: 'best', reason: 'فوق‌العاده برای کتاب‌های اسکن‌شدهٔ قدیمی، مقالات علمی و متون دشوار چاپی (نیازمند NVIDIA GPU ≥ 16GB).' },
    auto: { tier: 'weak', reason: 'مدل ۷ میلیارد پارامتری مخصوص کتاب و اسناد روی GPU سنگین؛ برای حالت عمومی یا کمیک مناسب نیست.' },
  },
  'hunyuan-ocr': {
    comic: { tier: 'medium', reason: 'تشخیص متن قوی دارد اما به دلیل نیاز به ۲۴ گیگابایت VRAM برای کمیک بیش‌ازحد سنگین است.' },
    document: { tier: 'medium', reason: 'خوانش دقیق متن‌های چندزبانه، اما نیازمند کارت گرافیک حرفه‌ای ۲۴ گیگابایتی و کندتر از مدل‌های تخصصی سند است.' },
    auto: { tier: 'weak', reason: 'صرفاً مناسب ایستگاه‌های کاری دارای GPU حرفه‌ای (24GB VRAM) در موارد خاص.' },
  },
};
const DEFAULT_LANGUAGE_SUITABILITY_OVERRIDES = {
  fas: {
    'hezar-ocr': {
      comic: { tier: 'best', reason: 'مدل بومی آموزش‌دیده روی فونت‌های فارسی؛ عالی و سبک برای حباب‌های کمیک و متون فارسی روی CPU و GPU.' },
      document: { tier: 'best', reason: 'تشخیص بسیار دقیق حروف و کلمات چاپی فارسی (فونت‌های وزیر، نازنین، میترا، یکان و کتاب) با مصرف کم حافظه.' },
      auto: { tier: 'best', reason: 'بهترین انتخاب تخصصی و سبک برای صفحات فارسی (هم کمیک و هم کتاب و جزوه).' },
    },
    'rapidocr-v6': {
      comic: { tier: 'weak', reason: 'این مدل از الفبای فارسی پشتیبانی نمی‌کند (فقط انگلیسی، چینی و ژاپنی).' },
      document: { tier: 'weak', reason: 'این مدل از الفبای فارسی پشتیبانی نمی‌کند (فقط انگلیسی، چینی و ژاپنی).' },
      auto: { tier: 'weak', reason: 'عدم پشتیبانی از زبان فارسی.' },
    },
    'rapidocr-v5': {
      comic: { tier: 'medium', reason: 'حروف فارسی را سریع می‌خواند ولی مدل عربی‌ـ‌فارسی آن روی فونت کمیک دقت متوسط دارد؛ Hezar و EasyOCR دقیق‌ترند.' },
      document: { tier: 'medium', reason: 'سبک و سریع برای متون سادهٔ فارسی، اما در کتاب‌های متراکم فارسی دقت Hezar، Tesseract و Surya بالاتر است.' },
      auto: { tier: 'medium', reason: 'گزینهٔ سبک کمکی برای فارسی روی سیستم‌های ضعیف.' },
    },
    easyocr: {
      comic: { tier: 'best', reason: 'پشتیبانی بومی هم‌زمان از فارسی و انگلیسی؛ بسیار مناسب دیالوگ‌های کمیک فارسی.' },
      document: { tier: 'weak', reason: 'در صفحات پُرمتن کتاب فارسی کند است و ستون‌بندی ندارد.' },
      auto: { tier: 'medium', reason: 'عالی برای حباب‌های کمیک فارسی، اما برای کتاب و مقالهٔ فارسی مناسب نیست.' },
    },
    tesseract: {
      comic: { tier: 'weak', reason: 'روی حباب‌های منحنی و فونت‌های فانتزی کمیک فارسی ضعیف عمل می‌کند.' },
      document: { tier: 'best', reason: 'فایل رسمی fas.traineddata روی کتاب‌ها، مقالات و جزوه‌های چاپی فارسی بسیار سریع و دقیق است.' },
      auto: { tier: 'medium', reason: 'فوق‌العاده برای کتاب و مقالهٔ فارسی، ولی روی کمیک فارسی ضعیف است.' },
    },
    surya: {
      comic: { tier: 'medium', reason: 'خط فارسی را می‌شناسد اما برای فونت‌های فانتزی حباب کمیک ساخته نشده است.' },
      document: { tier: 'best', reason: 'پشتیبانی رسمی از فارسی و چیدمان راست‌به‌چپ (RTL)؛ عالی برای مقالات چندستونی و کتاب فارسی.' },
      auto: { tier: 'best', reason: 'تشخیص قدرتمند خط فارسی و ترتیب ستون‌های راست‌به‌چپ در کتاب و اسناد.' },
    },
    'paddleocr-vl-1-6': {
      comic: { tier: 'medium', reason: 'پشتیبانی رسمی از فارسی، اما سنگین‌تر از Hezar و EasyOCR برای کمیک است.' },
      document: { tier: 'best', reason: 'تشخیص دقیق چیدمان صفحه، تیترها و پاراگراف‌های فارسی در کتاب و مقاله.' },
      auto: { tier: 'best', reason: 'مدل چندزبانهٔ قوی برای استخراج ساختاریافتهٔ کتاب و مقالهٔ فارسی.' },
    },
    'mineru-2-5-pro': {
      comic: { tier: 'weak', reason: 'از خط فارسی و صفحات کمیک پشتیبانی نمی‌کند.' },
      document: { tier: 'weak', reason: 'موتور پیش‌فرض MinerU از خط فارسی پشتیبانی مستقیم ندارد؛ از Hezar، Tesseract یا Surya استفاده کنید.' },
      auto: { tier: 'weak', reason: 'عدم پشتیبانی مستقیم از خط فارسی.' },
    },
    'got-ocr-2': {
      comic: { tier: 'weak', reason: 'فقط روی انگلیسی و چینی آموزش دیده و قادر به خواندن خط فارسی نیست.' },
      document: { tier: 'weak', reason: 'فقط روی انگلیسی و چینی آموزش دیده و قادر به خواندن خط فارسی نیست.' },
      auto: { tier: 'weak', reason: 'عدم پشتیبانی از الفبای فارسی.' },
    },
    'glm-ocr': {
      comic: { tier: 'medium', reason: 'فارسی را تا حدی می‌خواند اما روی فونت کمیک فارسی به دقت Hezar و EasyOCR نمی‌رسد.' },
      document: { tier: 'medium', reason: 'خوانش متوسط متن فارسی؛ Hezar، Surya و Tesseract روی کتاب فارسی دقیق‌ترند.' },
      auto: { tier: 'medium', reason: 'عملکرد متوسط روی متن فارسی.' },
    },
    'dots-ocr': {
      comic: { tier: 'medium', reason: 'از فارسی پشتیبانی می‌کند اما نیازمند GPU قوی است و تمرکز آن روی اسناد است.' },
      document: { tier: 'best', reason: 'مدل ۱۰۰ زبانه با تشخیص هم‌زمان کادر و متن فارسی در کتاب و مقاله (نیازمند NVIDIA GPU ≥ 8GB).' },
      auto: { tier: 'medium', reason: 'دقیق برای اسناد فارسی روی کارت گرافیک NVIDIA.' },
    },
    'deepseek-ocr-2': {
      comic: { tier: 'weak', reason: 'بسیار سنگین و غیربهینه برای کمیک فارسی.' },
      document: { tier: 'medium', reason: 'از فارسی پشتیبانی می‌کند اما بیشترین دقت آن روی انگلیسی و چینی است و به GPU قوی نیاز دارد.' },
      auto: { tier: 'weak', reason: 'برای متن فارسی گزینه‌های سبک‌تر و دقیق‌تری مثل Hezar و Surya وجود دارد.' },
    },
    olmocr: {
      comic: { tier: 'weak', reason: 'مخصوص مقالات PDF است و برای کمیک فارسی کاربردی ندارد.' },
      document: { tier: 'medium', reason: 'متن چاپی فارسی را می‌خواند ولی عمدتاً روی انگلیسی تنظیم شده و نیازمند GPU ≥ 16GB است.' },
      auto: { tier: 'weak', reason: 'سنگین؛ برای فارسی اولویت با Hezar و Surya است.' },
    },
  },
  kor: {
    'rapidocr-v6': {
      comic: { tier: 'weak', reason: 'مدل PP-OCRv6 Small از زبان کره‌ای پشتیبانی نمی‌کند.' },
      document: { tier: 'weak', reason: 'مدل PP-OCRv6 Small از زبان کره‌ای پشتیبانی نمی‌کند.' },
      auto: { tier: 'weak', reason: 'عدم پشتیبانی از زبان کره‌ای.' },
    },
    'rapidocr-v5': {
      comic: { tier: 'best', reason: 'دارای مدل اختصاصی کره‌ای؛ سریع‌ترین و دقیق‌ترین موتور سبک برای مانهوا و وبتون کره‌ای.' },
      document: { tier: 'best', reason: 'تشخیص دقیق و سبک خط هانگول کره‌ای روی CPU و GPU.' },
      auto: { tier: 'best', reason: 'بهترین انتخاب سبک برای صفحات کره‌ای.' },
    },
    tesseract: {
      comic: { tier: 'weak', reason: 'روی فونت‌های مانهوای کره‌ای ضعیف است.' },
      document: { tier: 'medium', reason: 'در فاصله‌گذاری هجاهای کره‌ای ضعیف‌تر از Surya، PaddleOCR-VL و PP-OCRv5 است.' },
      auto: { tier: 'weak', reason: 'برای کره‌ای PP-OCRv5، EasyOCR و Surya دقیق‌ترند.' },
    },
    'got-ocr-2': {
      comic: { tier: 'weak', reason: 'فقط روی انگلیسی و چینی آموزش دیده است.' },
      document: { tier: 'weak', reason: 'فقط روی انگلیسی و چینی آموزش دیده است.' },
      auto: { tier: 'weak', reason: 'فاقد آموزش کافی روی خط کره‌ای.' },
    },
  },
  jpn: {
    'rapidocr-v5': {
      comic: { tier: 'medium', reason: 'در نسخهٔ v5 از مدل مشترک چینی استفاده می‌شود؛ برای ژاپنی PP-OCRv6 یا EasyOCR دقیق‌ترند.' },
      document: { tier: 'medium', reason: 'برای کتاب ژاپنی Surya، PaddleOCR-VL یا PP-OCRv6 دقیق‌ترند.' },
      auto: { tier: 'medium', reason: 'عملکرد متوسط در ژاپنی.' },
    },
    tesseract: {
      comic: { tier: 'weak', reason: 'روی مانگای ژاپنی و متن عمودی ضعیف است.' },
      document: { tier: 'medium', reason: 'در متون عمودی و فوریگانا ضعیف‌تر از PaddleOCR-VL و Surya است.' },
      auto: { tier: 'weak', reason: 'برای ژاپنی PP-OCRv6 و PaddleOCR-VL توصیه می‌شوند.' },
    },
    'got-ocr-2': {
      comic: { tier: 'weak', reason: 'عمدتاً روی انگلیسی و چینی آموزش دیده است.' },
      document: { tier: 'weak', reason: 'برای کتاب‌های ژاپنی دقت کافی روی کانا ندارد.' },
      auto: { tier: 'weak', reason: 'برای ژاپنی مناسب نیست.' },
    },
  },
  chi_sim: {
    tesseract: {
      comic: { tier: 'weak', reason: 'روی مانهوای چینی ضعیف است.' },
      document: { tier: 'medium', reason: 'ضعیف‌تر از موتورهای بومی چینی (PP-OCRv6، PaddleOCR-VL و MinerU).' },
      auto: { tier: 'weak', reason: 'برای چینی موتورهای خانوادهٔ PP-OCR و GOT-OCR بسیار دقیق‌ترند.' },
    },
    'got-ocr-2': {
      comic: { tier: 'best', reason: 'آموزش‌دیده تخصصی روی چینی و انگلیسی؛ عالی برای مانهوا و کمیک چینی.' },
      document: { tier: 'best', reason: 'تشخیص بسیار دقیق نویسه‌های چاپی چینی در پاراگراف‌ها.' },
      auto: { tier: 'best', reason: 'عملکرد عالی روی هر دو حالت کمیک و کتاب به زبان چینی.' },
    },
    'glm-ocr': {
      comic: { tier: 'best', reason: 'مدل بومی چینی‌ـ‌انگلیسی با دقت عالی روی دیالوگ‌های مانهوا.' },
      document: { tier: 'best', reason: 'عملکرد بسیار دقیق در خواندن متون چاپی چینی.' },
      auto: { tier: 'best', reason: 'انتخاب درجهٔ یک برای صفحات چینی.' },
    },
    'rapidocr-v5': {
      comic: { tier: 'best', reason: 'بسیار سریع و دقیق برای مانهوا و کمیک چینی.' },
      document: { tier: 'best', reason: 'مدل پایهٔ چینی PP-OCRv5 با دقت بالا روی اسناد چینی.' },
      auto: { tier: 'best', reason: 'عملکرد عالی و سبک برای متون چینی.' },
    },
  },
};
const SUITABILITY_META = {
  best: { icon: '🟢', short: 'عالی', badge: 'بهترین عملکرد', cardBadge: 'عملکرد عالی' },
  medium: { icon: '🟡', short: 'متوسط', badge: 'عملکرد متوسط', cardBadge: 'عملکرد متوسط' },
  weak: { icon: '🔴', short: 'ضعیف', badge: 'عملکرد ضعیف', cardBadge: 'عملکرد ضعیف' },
};
const PAGE_MODE_LABELS = {
  comic: 'کمیک و مانگا',
  document: 'کتاب، مقاله و جزوه',
};
function isLocalEndpointUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
    const host = (parsed.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
    if (!host) return false;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' || host.endsWith('.local') || host.endsWith('.localhost')) return true;
    if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    const m172 = host.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
    if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;
    return false;
  } catch {
    return false;
  }
}
function resolveEngineExecMeta(engine) {
  if (engine?.executionMode === 'online') {
    return {
      mode: 'online',
      short: 'آنلاین',
      chip: 'سرویس آنلاین (اینترنتی)',
      headerBadge: 'سرویس آنلاین (اینترنتی)',
      statusPrefix: 'محل اجرا: آنلاین (نیازمند اینترنت)',
      descriptionNote: 'نیازمند اتصال اینترنت',
    };
  }
  return {
    mode: 'local',
    short: 'آفلاین',
    chip: 'اجرای آفلاین روی سیستم',
    headerBadge: 'اجرای آفلاین روی سیستم شما',
    statusPrefix: 'اجرای آفلاین روی سیستم شما',
    descriptionNote: 'اجرا روی سیستم شما به‌صورت آفلاین',
  };
}
function isDirectMtProvider(provider) {
  return provider === 'free' || provider === 'local';
}
function resolveTranslationExecMeta(provider, baseUrl = '') {
  const normProvider = String(provider || 'free').trim() || 'free';
  if (normProvider === 'local') {
    return {
      mode: 'local',
      short: 'آفلاین داخلی',
      badge: 'اجرا روی سیستم شما (آفلاین — بدون اینترنت)',
      banner: 'محل اجرا: ۱۰۰٪ روی سیستم شما (آفلاین و رایگان) — پس از یک‌بار دانلود اولیه، ترجمهٔ یک جمله، یک کادر یا صفحه‌های کامل بدون نیاز به اینترنت و بدون نیاز به کارت گرافیک روی پردازنده (CPU) انجام می‌شود.',
    };
  }
  const effectiveLocal = normProvider !== 'free' && normProvider !== 'gemini' && isLocalEndpointUrl(baseUrl);
  if (effectiveLocal) {
    return {
      mode: 'local',
      short: 'لوکال / آفلاین',
      badge: 'اجرا روی سیستم شما (لوکال / آفلاین)',
      banner: 'محل اجرا: روی سیستم شما (آفلاین / لوکال) — متصل به سرور محلی (مانند Ollama یا LM Studio) بدون ارسال متن به اینترنت.',
    };
  }
  if (normProvider === 'free') {
    return {
      mode: 'online',
      short: 'آنلاین',
      badge: 'سرویس آنلاین (اینترنتی)',
      banner: 'محل اجرا: آنلاین (اینترنتی) — نیازمند اتصال اینترنت؛ ترجمه روی سرویس‌های آنلاین Google Translate / MyMemory انجام می‌شود و چیزی روی سیستم شما نصب نمی‌کند.',
    };
  }
  if (normProvider === 'openai') {
    return {
      mode: 'online',
      short: 'آنلاین',
      badge: 'سرویس آنلاین (اینترنتی)',
      banner: 'محل اجرا: آنلاین (ابری / اینترنتی) — نیازمند اینترنت و کلید API؛ اگر نشانی یک سرور محلی (مثل http://localhost:11434/v1 برای Ollama یا LM Studio) بدهید، به اجرای روی سیستم (آفلاین) تبدیل می‌شود.',
    };
  }
  return {
    mode: 'online',
    short: 'آنلاین',
    badge: 'سرویس آنلاین (اینترنتی)',
    banner: 'محل اجرا: آنلاین (ابری / اینترنتی) — نیازمند اینترنت و کلید API؛ مدل روی سرور آنلاین اجرا می‌شود و فشار پردازشی روی سیستم شما ندارد.',
  };
}
function applyExecBadgeElement(el, mode, text) {
  if (!el) return;
  el.textContent = text;
  el.dataset.execMode = mode;
  el.classList.toggle('is-local', mode === 'local');
  el.classList.toggle('is-online', mode !== 'local');
}
function normalizePageMode(pageMode) {
  return pageMode === 'document' ? 'document' : 'comic';
}
function engineSuitability(engine, pageMode = 'comic', language = 'eng') {
  const mode = normalizePageMode(pageMode);
  const normLang = OCR_LANGUAGE_LABELS[language] ? language : 'eng';
  const byLangEntry = engine?.suitabilityByLanguage?.[normLang]?.[mode]
    || DEFAULT_LANGUAGE_SUITABILITY_OVERRIDES[normLang]?.[engine?.id]?.[mode];
  let entry = byLangEntry;
  if (!entry) {
    const langs = Array.isArray(engine?.languages) ? engine.languages : [];
    if (langs.length && !langs.includes(normLang)) {
      entry = { tier: 'weak', reason: `این مدل از زبان «${OCR_LANGUAGE_LABELS[normLang] || normLang}» پشتیبانی نمی‌کند.` };
    } else {
      entry = engine?.suitability?.[mode] || DEFAULT_ENGINE_SUITABILITY[engine?.id]?.[mode] || { tier: 'medium', reason: '' };
    }
  }
  const tier = ['best', 'medium', 'weak'].includes(entry.tier) ? entry.tier : 'medium';
  return { tier, reason: entry.reason || '', ...SUITABILITY_META[tier] };
}
function pickBestEngineForLanguage(language, pageMode = 'comic', preferredEngine = '') {
  const selectable = state.engines.filter((engine) => engine.selectable !== false);
  const current = selectable.find((engine) => engine.id === preferredEngine);
  if (current && (current.languages || []).includes(language)) return current.id;
  const supporting = selectable.filter((engine) => (engine.languages || []).includes(language));
  if (!supporting.length) return selectable[0]?.id || 'rapidocr-v6';
  const tierScore = { best: 3, medium: 2, weak: 1 };
  const ranked = [...supporting].sort((a, b) => {
    const aReady = Boolean(a.runtimeInstalled && (a.readyLanguages || []).includes(language)) ? 1 : 0;
    const bReady = Boolean(b.runtimeInstalled && (b.readyLanguages || []).includes(language)) ? 1 : 0;
    if (bReady !== aReady) return bReady - aReady;
    const aTier = tierScore[engineSuitability(a, pageMode, language).tier] || 0;
    const bTier = tierScore[engineSuitability(b, pageMode, language).tier] || 0;
    if (bTier !== aTier) return bTier - aTier;
    const aCpu = a.requiresNvidiaGpu ? 0 : 1;
    const bCpu = b.requiresNvidiaGpu ? 0 : 1;
    return bCpu - aCpu;
  });
  return ranked[0].id;
}
function formatSizeGbFa(sizeGb) {
  const val = Number(sizeGb);
  if (!Number.isFinite(val) || val <= 0.001) return '';
  if (val < 1) {
    const mb = Math.max(5, Math.round((val * 1024) / 5) * 5);
    return `~${mb} مگابایت`;
  }
  const rounded = Number(val.toFixed(val < 2 ? 2 : 1));
  return `~${rounded} گیگابایت`;
}
function engineDownloadSummary(engine, lang = '') {
  if (!engine) return { activeGb: 0, fullGb: 0, totalLabel: '', fullLabel: '', detailLabel: '' };
  const nominalGb = Number(engine.downloadSizeGb ?? 0);
  const fullGb = Number(engine.fullDownloadSizeGb ?? engine.totalDownloadGb ?? nominalGb ?? 0);
  const runtimeGb = Number(engine.runtimeDownloadGb ?? 0);
  const weightsGb = Number(engine.weightsDownloadGb ?? nominalGb ?? 0);
  const perLangGb = Number(engine.perLanguageDownloadGb ?? 0);
  const langReady = lang
    ? Boolean(engine.runtimeInstalled && (engine.readyLanguages || []).includes(lang))
    : Boolean(engine.runtimeInstalled && engine.modelReady);
  let activeGb = fullGb;
  if (engine.runtimeInstalled && !langReady) {
    activeGb = (engine.modelReady && perLangGb > 0) ? perLangGb : (weightsGb || fullGb);
  }
  const totalLabel = formatSizeGbFa(activeGb) || formatSizeGbFa(fullGb);
  const fullLabel = formatSizeGbFa(fullGb) || totalLabel;
  let detailLabel = totalLabel;
  if (!engine.runtimeInstalled && runtimeGb > 0 && weightsGb > 0) {
    detailLabel = `${totalLabel} (پیش‌نیازها: ${formatSizeGbFa(runtimeGb)} + فایل‌های مدل: ${formatSizeGbFa(weightsGb)})`;
  } else if (engine.runtimeInstalled && !langReady && totalLabel) {
    detailLabel = `${totalLabel} (فقط فایل مدل/زبان؛ پیش‌نیازها قبلاً نصب شده)`;
  }
  return { activeGb, fullGb, totalLabel, fullLabel, detailLabel };
}
const SUITABILITY_SORT_RANK = { best: 0, medium: 1, weak: 2 };
const ocrEngineSortCache = { key: '', ids: [] };
const modelsGroupSortCache = { key: '', standardIds: [], advancedIds: [], flatIds: [] };

function sortEnginesBySuitability(engines, pageMode, language) {
  return engines
    .map((engine, index) => ({
      engine,
      index,
      rank: SUITABILITY_SORT_RANK[engineSuitability(engine, pageMode, language).tier] ?? 1,
    }))
    .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
    .map((entry) => entry.engine);
}

function applyCachedEngineOrder(engines, cachedIds) {
  if (!Array.isArray(cachedIds) || !cachedIds.length) return [...engines];
  const byId = new Map(engines.map((engine) => [engine.id, engine]));
  const seen = new Set();
  const ordered = [];
  cachedIds.forEach((id) => {
    const found = byId.get(id);
    if (found && !seen.has(id)) {
      seen.add(id);
      ordered.push(found);
    }
  });
  engines.forEach((engine) => {
    if (!seen.has(engine.id)) ordered.push(engine);
  });
  return ordered;
}

function engineInstallState(engine, language) {
  if (!engine?.runtimeInstalled) {
    return { state: 'uninstalled', icon: '⬇' };
  }
  const readyLangs = Array.isArray(engine.readyLanguages) ? engine.readyLanguages : [];
  if (language && readyLangs.includes(language)) {
    return { state: 'ready', icon: '✓' };
  }
  return { state: 'partial', icon: '◐' };
}

function formatOcrEngineOptionLabel(engine, language) {
  const inst = engineInstallState(engine, language);
  return `${inst.icon} ${engine.name}`;
}

function updateEngineOptions(preferredEngine = '', options = {}) {
  const select = $('ocrEngine'); if (!select) return;
  const pageMode = normalizePageMode($('ocrPageMode')?.value || state.project?.settings?.ocrPageMode);
  const language = $('ocrLanguage')?.value || state.project?.settings?.ocrLanguage || 'eng';
  const previous = (typeof preferredEngine === 'string' && preferredEngine) || select.value || state.project?.settings?.ocrEngine || 'rapidocr-v6';
  const selectable = state.engines.filter((engine) => engine.selectable !== false);
  const idSetSig = selectable.map((engine) => engine.id).slice().sort().join('|');
  const sortKey = `${language}::${pageMode}::${idSetSig}`;
  const shouldResort = Boolean(options?.resort) || ocrEngineSortCache.key !== sortKey;
  let orderedEngines;
  if (shouldResort) {
    orderedEngines = sortEnginesBySuitability(selectable, pageMode, language);
    ocrEngineSortCache.key = sortKey;
    ocrEngineSortCache.ids = orderedEngines.map((engine) => engine.id);
  } else {
    orderedEngines = applyCachedEngineOrder(selectable, ocrEngineSortCache.ids);
  }
  select.textContent = '';
  orderedEngines.forEach((engine) => {
    const suit = engineSuitability(engine, pageMode, language);
    const execMeta = resolveEngineExecMeta(engine);
    const inst = engineInstallState(engine, language);
    const option = document.createElement('option');
    option.value = engine.id;
    option.className = `ocr-opt-${suit.tier}`;
    option.dataset.suitability = suit.tier;
    option.dataset.executionMode = execMeta.mode;
    option.dataset.installState = inst.state;
    option.textContent = `${inst.icon} ${engine.name}`;
    select.appendChild(option);
  });
  const chosenId = pickBestEngineForLanguage(language, pageMode, previous);
  select.value = state.engines.some((engine) => engine.id === chosenId) ? chosenId : 'rapidocr-v6';
  updateOcrEngineStatus();
  syncEngineUpdateUi();
}
function updateOcrEngineStatus() {
  const select = $('ocrEngine');
  const engine = state.engines.find((entry) => entry.id === select?.value); if (!engine) return;
  const pageMode = normalizePageMode($('ocrPageMode')?.value || state.project?.settings?.ocrPageMode);
  [...($('ocrLanguage')?.options || [])].forEach((option) => { option.disabled = false; });
  if (!engine.languages.includes($('ocrLanguage').value)) {
    const keepSelectedId = select.value;
    $('ocrLanguage').value = engine.languages[0] || 'eng';
    if ($('modelsLanguage')) $('modelsLanguage').value = $('ocrLanguage').value;
    if ($('testLanguage')) $('testLanguage').value = $('ocrLanguage').value;
    const curLang = $('ocrLanguage').value;
    const selectable = state.engines.filter((e) => e.selectable !== false);
    const idSetSig = selectable.map((e) => e.id).slice().sort().join('|');
    const resorted = sortEnginesBySuitability(selectable, pageMode, curLang);
    ocrEngineSortCache.key = `${curLang}::${pageMode}::${idSetSig}`;
    ocrEngineSortCache.ids = resorted.map((e) => e.id);
    const optByValue = new Map([...select.options].map((o) => [o.value, o]));
    resorted.forEach((eng) => {
      const opt = optByValue.get(eng.id);
      if (!opt) return;
      const suit = engineSuitability(eng, pageMode, curLang);
      const engExec = resolveEngineExecMeta(eng);
      const inst = engineInstallState(eng, curLang);
      opt.className = `ocr-opt-${suit.tier}`;
      opt.dataset.suitability = suit.tier;
      opt.dataset.executionMode = engExec.mode;
      opt.dataset.installState = inst.state;
      opt.textContent = `${inst.icon} ${eng.name}`;
      select.appendChild(opt);
    });
    select.value = keepSelectedId;
  }
  const lang = $('ocrLanguage').value;
  const activeSuit = engineSuitability(engine, pageMode, lang);
  const activeExec = resolveEngineExecMeta(engine);
  const dl = engineDownloadSummary(engine, lang);
  applyExecBadgeElement($('ocrExecBadge'), activeExec.mode, activeExec.headerBadge);
  select.dataset.suitability = activeSuit.tier;
  select.dataset.executionMode = activeExec.mode;
  const langLabel = OCR_LANGUAGE_LABELS[lang] || lang;
  const langReady = Boolean(engine.runtimeInstalled && (engine.readyLanguages || []).includes(lang));
  const versionLabel = engine.installedVersion ? ` (نسخهٔ ${engine.installedVersion})` : '';
  const suitPrefix = `${activeExec.statusPrefix} · ${activeSuit.reason ? `${activeSuit.icon} عملکرد در «${langLabel} + ${PAGE_MODE_LABELS[pageMode] || pageMode}»: ${activeSuit.reason} · ` : ''}`;
  const sizeSentence = dl.detailLabel ? ` کل حجم دانلود خودکار: ${dl.detailLabel}.` : '';
  let statusText = engine.runtimeInstalled
    ? (langReady
      ? `${suitPrefix}وضعیت: آمادهٔ اجرا روی همین کامپیوتر${versionLabel}.`
      : `${suitPrefix}ابزار اجرا نصب است، اما فایل زبان انتخاب‌شده (${langLabel}) هنوز دانلود نشده است.${sizeSentence}`)
    : `${suitPrefix}این مدل هنوز روی سیستم شما نصب نشده است؛ با زدن دکمهٔ زیر، نصب و دانلود آن کاملاً خودکار انجام می‌شود.${sizeSentence}`;
  if (engine.updateAvailable) {
    statusText += ` · ${engine.updateSummary || 'نسخهٔ جدید برای این مدل منتشر شده است.'}`;
  }
  $('ocrEngineStatus').textContent = statusText;
  const quickWrap = $('ocrEngineQuickActions');
  const quickPrep = $('ocrQuickPrepareBtn');
  const quickUpd = $('ocrQuickUpdateBtn');
  if (quickWrap && quickPrep && quickUpd) {
    const needPrep = !langReady;
    const hasUpd = Boolean(engine.updateAvailable);
    const btnSizeSuffix = dl.totalLabel ? ` (کل حجم دانلود: ${dl.totalLabel})` : '';
    quickPrep.textContent = engine.runtimeInstalled
      ? `دانلود خودکار فایل زبان (${lang})${btnSizeSuffix}`
      : `نصب و دانلود خودکار همین مدل${btnSizeSuffix}`;
    quickPrep.disabled = Boolean(state.modelBusy || ocrRunning);
    quickUpd.textContent = engine.latestVersion ? `به‌روزرسانی به نسخهٔ ${engine.latestVersion}` : 'به‌روزرسانی به نسخهٔ جدید';
    quickUpd.disabled = Boolean(state.modelBusy || ocrRunning);
    quickPrep.classList.toggle('hidden', !needPrep);
    quickUpd.classList.toggle('hidden', !hasUpd);
    quickWrap.classList.toggle('hidden', !needPrep && !hasUpd);
  }
}
function projectBrowserDrafts(project) {
  const prefix = `comic-studio-draft:${encodeURIComponent(project.id)}:`;
  const valid = new Set(project.images.flatMap((image) => (image.blocks || []).filter((block) => block.id !== undefined).map((block) => `${image.id}\0${String(block.id)}`)));
  const drafts = [];
  let keys = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
  } catch {
    return drafts;
  }
  for (const key of keys) {
    const parts = key.slice(prefix.length).split(':');
    if (parts.length !== 3) continue;
    let imageId;
    let blockId;
    try {
      [imageId, blockId] = parts.slice(0, 2).map(decodeURIComponent);
    } catch {
      continue;
    }
    const mode = parts[2];
    if (!valid.has(`${imageId}\0${blockId}`) || !['ocr', 'translation'].includes(mode)) continue;
    try {
      const value = JSON.parse(localStorage.getItem(key));
      if (value && typeof value.html === 'string') {
        drafts.push({ imageId, blockId, mode, value });
      }
    } catch {
      /* ignore unreadable/corrupted stale draft entry */
    }
  }
  return drafts;
}
async function backupCurrentProject() {
  if (!state.project) return;
  await runJob('در حال ساخت بک‌آپ پروژه…', async (signal) => {
    const checkNotCancelled = () => {
      if (signal?.aborted) {
        throw Object.assign(new Error('عملیات به درخواست شما لغو شد.'), { name: 'AbortError', cancelled: true });
      }
    };
    await waitForPendingRenders(state.project?.id);
    checkNotCancelled();
    const project = state.project;
    if (!project) return;
    const mismatchedIds = sortedImages().filter((item) => hasOverlayText(item) !== !!item.edited).map((item) => item.id);
    if (mismatchedIds.length) {
      await renderImagesText(mismatchedIds, null, checkNotCancelled);
    }
    let revision;
    do {
      await waitForPendingRenders(project.id);
      checkNotCancelled();
      const saving = saveProject();
      revision = saveRevision;
      await saving;
    } while (
      state.project === project &&
      (revision !== saveRevision || [...imageRenderTasks.keys()].some((k) => k.startsWith(`${project.id}:`)))
    );
    if (state.project !== project) throw new Error('پروژه تغییر کرد؛ دوباره بک‌آپ بگیرید.');
    const drafts = projectBrowserDrafts(project);
    const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/backup?prepare=true`, {
      ...jsonOptions('POST', { drafts, expected_updated_at: project.updatedAt }),
      signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.detail || `ساخت بک‌آپ ممکن نشد (HTTP ${response.status})`);
    }
    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
    const fallbackName = `${safeName(project.name) || 'comic-studio'}-backup.zip`;
    const link = $('backupDownloadLink');
    if (contentType.includes('application/json')) {
      const payload = await response.json();
      if (!payload?.token) throw new Error('فایل بک‌آپ آماده نشد.');
      if (state.project !== project || revision !== saveRevision) {
        fetch(`/api/projects/${encodeURIComponent(project.id)}/backup/${encodeURIComponent(payload.token)}`, { method: 'DELETE' }).catch(() => {});
        throw new Error('پروژه هنگام ساخت بک‌آپ تغییر کرد؛ برای ثبت آخرین تغییرها دوباره بک‌آپ بگیرید.');
      }
      clearBackupDownloadLink();
      activeBackupPrepared = { projectId: project.id, token: payload.token };
      link.href = `/api/projects/${encodeURIComponent(project.id)}/backup/${encodeURIComponent(payload.token)}`;
      link.download = payload.filename || fallbackName;
    } else {
      const blob = await response.blob();
      if (!blob.size) throw new Error('فایل بک‌آپ خالی است');
      if (state.project !== project || revision !== saveRevision) {
        throw new Error('پروژه هنگام ساخت بک‌آپ تغییر کرد؛ برای ثبت آخرین تغییرها دوباره بک‌آپ بگیرید.');
      }
      clearBackupDownloadLink();
      backupDownloadUrl = URL.createObjectURL(blob);
      link.href = backupDownloadUrl;
      link.download = fallbackName;
    }
    link.textContent = 'دانلود دوبارهٔ بک‌آپ';
    link.classList.remove('hidden');
    link.click();
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
    await waitForPendingRenders(state.project?.id);
    const saveExistingSafely = () => saveProject().catch((err) => {
      if (err?.status !== 404) throw err;
    });
    await saveExistingSafely();
    const previous = state.project;
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
      const saving = saveExistingSafely();
      const revision = saveRevision;
      await saving;
      if (state.project === previous && revision === saveRevision) { adoptProject(result.project); opened = true; break; }
    }
    await refreshProjectList();
    if (opened) {
      const checkCancel = () => {
        if (signal?.aborted) {
          const err = new Error('بازیابی بک‌آپ لغو شد.');
          err.name = 'AbortError'; err.cancelled = true;
          throw err;
        }
      };
      const mismatchedIds = sortedImages().filter((item) => hasOverlayText(item) !== !!item.edited).map((item) => item.id);
      if (mismatchedIds.length) await renderImagesText(mismatchedIds, null, checkCancel);
    }
    setMenuOpen(false);
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
  if (!isModuleLicensed('ocr')) { await ensureModuleLicensed('ocr'); return; }
  const pending = pendingTranslationAfterOcr;
  const controller = new AbortController();
  ocrAbortController = controller; ocrCancelledByUser = false; ocrClosingNormally = false;
  ocrRunning = true; setProgress('ocrProgress', null, true); $('startOcrBtn').disabled = true; $('cancelOcrBtn')?.classList.remove('hidden');
  $('ocrStatus').textContent = ''; $('copyOcrError').classList.add('hidden');
  let ocrSucceeded = false;
  let usedKeepEngineLoaded = false;
  let completedOcrPages = 0;
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
      const basePayload = {
        engine: $('ocrEngine').value,
        language: $('ocrLanguage').value,
        page_mode: normalizePageMode($('ocrPageMode')?.value),
        contrast: $('ocrContrast').checked,
        precise: $('ocrPrecise').checked,
        persian_preprocess: Boolean($('ocrPersianPreprocess')?.checked),
        group_lines: $('ocrGroupLines').checked,
        min_confidence: confidence === '' ? .35 : Number(confidence),
      };
      const checkOcrNotCancelled = () => {
        if (ocrCancelledByUser || controller.signal.aborted) {
          const e = new Error('لغو شد'); e.cancelled = true; throw e;
        }
      };
      const verifyPendingOcrState = () => {
        if (pending && (state.project?.id !== pending.projectId || JSON.stringify(selectedImages().map(item => item.id)) !== JSON.stringify(pending.imageIds))) {
          throw new Error('OCR در سرور ذخیره شد، اما پروژه یا انتخاب تغییر کرد؛ ترجمه ادامه نیافت. برای دیدن نتیجه پروژه را دوباره باز کنید.');
        }
      };
      const applyActiveJobProgress = (p) => {
        const clamped = Math.max(0, Math.min(1, p));
        if (jobProgressTransform) {
          jobProgressTransform.floor = Math.max(jobProgressTransform.floor || 0, clamped);
        }
        const effective = jobProgressTransform ? Math.max(jobProgressTransform.floor, clamped) : clamped;
        setProgress('ocrProgress', effective, true);
        setProgress('jobProgress', effective, true);
        setProgress('dockProgress', effective, true);
        if ($('editorDialog')?.open) setProgress('editorProgress', effective, true);
      };
      const totalPages = ids.length;
      for (let idx = 0; idx < totalPages; idx += 1) {
        checkOcrNotCancelled();
        const pageId = ids[idx];
        const isLastPage = idx + 1 >= totalPages;
        if (!isLastPage) usedKeepEngineLoaded = true;
        if (idx > 0) applyActiveJobProgress(idx / totalPages);
        const result = await api(`/api/projects/${state.project.id}/ocr`, {
          ...jsonOptions('POST', {
            ...basePayload,
            image_ids: [pageId],
            keep_engine_loaded: !isLastPage,
            batch_index: idx + 1,
            batch_total: totalPages,
          }),
          signal: controller.signal,
        });
        if (isLastPage) usedKeepEngineLoaded = false;
        checkOcrNotCancelled();
        verifyPendingOcrState();
        adoptProject(result, { skipGrid: true });
        setOverlayMode('ocr', false);
        applyActiveJobProgress((idx + 0.80) / totalPages);
        await renderImagesText(
          [pageId],
          (done, tot) => applyActiveJobProgress((idx + 0.80 + 0.20 * (done / Math.max(1, tot))) / totalPages),
          checkOcrNotCancelled,
        );
        completedOcrPages += 1;
        applyActiveJobProgress(completedOcrPages / totalPages);
      }
    }, 'ocrProgress');
    ocrSucceeded = true; ocrClosingNormally = true;
    clearPendingTranslationOcr(); closeDialog('ocrDialog');
    toast('متن OCR روی تصویر آمد؛ برای بررسی و ویرایش، دکمهٔ ✎ را بزنید');
    if (pending) await runTranslation();
  } catch (error) {
    if (state.project) renderGrid();
    if (ocrCancelledByUser || error?.cancelled || error?.name === 'AbortError') {
      clearPendingTranslationOcr();
      toast(completedOcrPages ? `پنجرهٔ OCR بسته شد؛ ${completedOcrPages} صفحهٔ تکمیل‌شده حفظ شد و ادامه متوقف گردید` : 'پنجرهٔ OCR بسته شد و عملیات متوقف گردید');
      return;
    }
    reportOcrError(error); if (error.pendingId) openPendingResults(error.pendingId); throw error;
  } finally {
    if (!ocrSucceeded) setProgress('ocrProgress', 0, false);
    if (ocrAbortController === controller) ocrAbortController = null;
    ocrClosingNormally = false; ocrRunning = false; $('startOcrBtn').disabled = false; $('cancelOcrBtn')?.classList.add('hidden');
    dismissJobCancelModal('ocr');
    if (usedKeepEngineLoaded) {
      usedKeepEngineLoaded = false;
      api('/api/engines/unload', { method: 'POST' })
        .then(() => refreshEngineMemory().catch(() => {}))
        .catch(() => {});
    } else {
      refreshEngineMemory().catch(() => {});
    }
  }
}

function savedTranslationSkill(projectId) {
  try { return localStorage.getItem(`comic-studio-ai-skill:${projectId}`); } catch { return null; }
}
function rememberTranslationSkill(projectId, preview) {
  if (isDirectMtProvider(preview.provider)) return;
  try { localStorage.setItem(`comic-studio-ai-skill:${projectId}`, preview.skill ?? ''); } catch { /* the next preview can still use the default */ }
}
function saveDraftTranslationSkill(projectId) {
  if (!projectId || !$('translationSkillWrap') || $('translationSkillWrap').classList.contains('hidden')) return;
  try { localStorage.setItem(`comic-studio-ai-skill:${projectId}`, $('translationSkill').value); } catch { /* ignore */ }
}
function parseTranslationTarget(raw) {
  const value = String(raw || '').trim();
  if (!value || value === 'free') return { provider: 'free', profileId: '', value: 'free' };
  if (value === 'local') return { provider: 'local', profileId: '', value: 'local' };
  const sep = value.indexOf('::');
  const provider = sep >= 0 ? value.slice(0, sep) : value;
  const profileId = sep >= 0 ? value.slice(sep + 2) : '';
  if (!AI_PROVIDER_IDS.includes(provider)) return { provider: 'free', profileId: '', value: 'free' };
  return { provider, profileId, value: profileId ? `${provider}::${profileId}` : provider };
}
function resolvePreferredTranslationTarget(overrideTarget = null) {
  const currentAiProvider = state.ai?.provider || 'free';
  if (lastSyncedAiProvider !== currentAiProvider) {
    lastSyncedAiProvider = currentAiProvider;
    preferredTranslationTarget = currentAiProvider;
  }
  if (overrideTarget) {
    const parsedOverride = parseTranslationTarget(overrideTarget);
    preferredTranslationTarget = parsedOverride.value;
    return parsedOverride;
  }
  const candidate = parseTranslationTarget(preferredTranslationTarget || currentAiProvider);
  if (isDirectMtProvider(candidate.provider)) return candidate;
  const profiles = state.ai?.providers?.[candidate.provider]?.profiles || [];
  if (candidate.profileId) {
    if (profiles.some((p) => p.hasApiKey && String(p.id) === candidate.profileId)) return candidate;
    if (profiles.some((p) => p.hasApiKey)) {
      const fallbackProvider = { provider: candidate.provider, profileId: '', value: candidate.provider };
      preferredTranslationTarget = fallbackProvider.value;
      return fallbackProvider;
    }
    preferredTranslationTarget = 'free';
    return { provider: 'free', profileId: '', value: 'free' };
  }
  return candidate;
}
function renderTranslationServiceSelector(activeProvider, activeProfileId = '') {
  const select = $('translationPreviewService');
  if (!select) return;
  const activeValue = activeProvider && !isDirectMtProvider(activeProvider) && activeProfileId
    ? `${activeProvider}::${activeProfileId}`
    : (activeProvider || 'free');
  select.textContent = '';
  const addOpt = (value, label, execMode = 'online') => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.dataset.executionMode = execMode;
    textLabel: {
      opt.textContent = label;
    }
    select.appendChild(opt);
  };
  addOpt('free', 'سرویس رایگان — Google Translate + MyMemory', 'online');
  const localCfgModel = state.ai?.local_nmt?.model || 'nllb-600m';
  const localModels = state.ai?.local_nmt_status?.models || [];
  const activeLocalMeta = localModels.find((m) => m.id === localCfgModel);
  const localShort = activeLocalMeta?.shortLabel || (localCfgModel === 'nllb-1.3b' ? 'NLLB-200 (1.3B)' : 'NLLB-200 (600M)');
  const localReadySuffix = activeLocalMeta?.ready ? '✓ آماده بدون اینترنت' : (localModels.length ? '⬇ نیازمند دانلود اولیه' : 'آفلاین بدون اینترنت');
  addOpt('local', `مترجم آفلاین داخلی — ${localShort} (${localReadySuffix})`, 'local');
  AI_PROVIDER_IDS.forEach((providerId) => {
    const info = aiInfo(providerId);
    const label = info.label || AI_FALLBACKS[providerId]?.label || providerId;
    const model = info.model || info.defaultModel || '';
    const execMeta = resolveTranslationExecMeta(providerId, info.base_url || '');
    const activeProfiles = (info.profiles || []).filter((p) => p.hasApiKey);
    if (activeProfiles.length === 1) {
      const pName = activeProfiles[0].name?.trim() || 'API 1';
      addOpt(providerId, `${label}${model ? ` — مدل: ${model}` : ''} (${pName})`, execMeta.mode);
    } else if (activeProfiles.length >= 2) {
      addOpt(providerId, `${label}${model ? ` — مدل: ${model}` : ''} (همهٔ ${activeProfiles.length} کلید فعال به ترتیب اولویت)`, execMeta.mode);
      activeProfiles.forEach((p, idx) => {
        const pName = p.name?.trim() || `API ${idx + 1}`;
        const faRank = (idx + 1).toLocaleString('fa-IR');
        addOpt(`${providerId}::${p.id}`, `${label}${model ? ` — مدل: ${model}` : ''} · اولویت ${faRank}: «${pName}»`, execMeta.mode);
      });
    } else if (activeProvider === providerId) {
      addOpt(providerId, `${label}${model ? ` — مدل: ${model}` : ''} (بدون کلید API ذخیره‌شده)`, execMeta.mode);
    }
  });
  if (![...select.options].some((opt) => opt.value === activeValue)) {
    addOpt(activeValue, activeValue);
  }
  select.value = activeValue;
}
async function switchTranslationPreviewService(nextTargetValue) {
  const switcher = translationPreviewSwitchTarget;
  const select = $('translationPreviewService');
  if (!switcher || !select) return;
  const parsed = parseTranslationTarget(nextTargetValue);
  preferredTranslationTarget = parsed.value;
  if (state.project?.id) saveDraftTranslationSkill(state.project.id);
  select.disabled = true;
  $('translationPreviewConfirm').disabled = true;
  $('translationPreviewError').classList.add('hidden');
  $('copyTranslationPreviewError').classList.add('hidden');
  setProgress('previewPrepProgress', null, true);
  try {
    await switcher(parsed.value);
  } catch (error) {
    if (error?.cancelled || error?.name === 'AbortError') return;
    setProgress('previewPrepProgress', 0, false);
    if ($('translationPreviewDialog').open) {
      const errMsg = error.message || String(error);
      $('translationPreviewError').textContent = `${errMsg} هیچ متنی ارسال نشده است؛ می‌توانید سرویس دیگری انتخاب کنید یا تنظیمات را تغییر دهید.`;
      $('translationPreviewError').classList.remove('hidden');
      $('copyTranslationPreviewError').classList.remove('hidden');
      $('openAiLimitFromPreview')?.classList.toggle('hidden', parsed.provider === 'free');
      translationPreviewData = {
        ...(translationPreviewData || {}),
        provider: parsed.provider,
        profileId: parsed.profileId,
        contextMode: !isDirectMtProvider(parsed.provider),
        requests: [],
        previewError: errMsg,
      };
      renderTranslationServiceSelector(parsed.provider, parsed.profileId);
      updateTranslationSkillStatus();
      toast(errMsg, true);
    }
  } finally {
    if (select) select.disabled = false;
  }
}
async function switchTranslationTargetLanguage(nextLang) {
  const switcher = translationPreviewSwitchTarget;
  const langSelect = $('translationTargetLang');
  const normLang = normalizeTargetLanguage(nextLang);
  if (langSelect) langSelect.value = normLang;
  if (state.project) {
    state.project.settings = state.project.settings || {};
    state.project.settings.targetLanguage = normLang;
    scheduleSave();
  }
  if ($('aiTargetLanguage')) $('aiTargetLanguage').value = normLang;
  if (!switcher || !$('translationPreviewDialog')?.open) return;
  if (state.project?.id) saveDraftTranslationSkill(state.project.id);
  if (langSelect) langSelect.disabled = true;
  if ($('translationPreviewService')) $('translationPreviewService').disabled = true;
  $('translationPreviewConfirm').disabled = true;
  $('translationPreviewError').classList.add('hidden');
  $('copyTranslationPreviewError').classList.add('hidden');
  setProgress('previewPrepProgress', null, true);
  try {
    await switcher($('translationPreviewService')?.value || null);
  } catch (error) {
    if (error?.cancelled || error?.name === 'AbortError') return;
    setProgress('previewPrepProgress', 0, false);
    if ($('translationPreviewDialog').open) {
      const errMsg = error.message || String(error);
      $('translationPreviewError').textContent = `${errMsg} هیچ متنی ارسال نشده است؛ می‌توانید زبان مقصد یا سرویس دیگری انتخاب کنید.`;
      $('translationPreviewError').classList.remove('hidden');
      $('copyTranslationPreviewError').classList.remove('hidden');
      toast(errMsg, true);
    }
  } finally {
    if (langSelect) langSelect.disabled = false;
    if ($('translationPreviewService')) $('translationPreviewService').disabled = false;
  }
}
function openAiSettingsFromPreviewDialog() {
  const activeProv = translationPreviewData?.provider;
  if (state.project?.id) saveDraftTranslationSkill(state.project.id);
  cancelTranslationRequestPreview();
  loadAiSettings().then(() => {
    if (activeProv && (activeProv === 'local' || AI_PROVIDER_IDS.includes(activeProv))) showAiProvider(activeProv, false);
    showDialog('aiDialog');
  }).catch((error) => toast(error.message, true));
}
function formatStorageBytesFa(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return 'کمتر از ۱ مگابایت';
  if (n < 1024 * 1024) return 'کمتر از ۱ مگابایت';
  if (n < 1024 ** 3) return `${Math.max(1, Math.round(n / (1024 * 1024)))} مگابایت`;
  return `${(n / (1024 ** 3)).toFixed(2)} گیگابایت`;
}
function syncStorageCheckboxState() {
  const mig = $('storageMigrateExisting');
  const clean = $('storageCleanupOld');
  const wrap = $('storageCleanupOldWrap');
  if (!mig || !clean) return;
  clean.disabled = !mig.checked || storageSwitchBusy;
  if (wrap) wrap.style.opacity = mig.checked ? '1' : '0.55';
}
function renderStorageSettings(info) {
  if (!info) return;
  state.storage = info;
  if ($('storageModeBadge')) {
    $('storageModeBadge').textContent = info.customActive ? 'مسیر سفارشی فعال' : 'اختیاری · پیش‌فرض خودکار';
  }
  if ($('storageActivePath')) $('storageActivePath').textContent = info.activePath || '—';
  if ($('storageAppDir')) $('storageAppDir').textContent = info.appDir || '—';
  if ($('storageDiskStats')) {
    const usedLabel = formatStorageBytesFa(info.usedBytes || 0);
    const freeLabel = typeof info.freeDiskGb === 'number' ? `${info.freeDiskGb} گیگابایت` : 'نامشخص';
    $('storageDiskStats').textContent = `حجم مصرفی فعلی: ${usedLabel} · فضای آزاد درایو فعلی: ${freeLabel}`;
  }
  if ($('storageCustomPath')) $('storageCustomPath').value = info.customPath || '';
  if ($('storageWarningBanner')) {
    const warn = String(info.fallbackWarning || '').trim();
    $('storageWarningBanner').textContent = warn;
    $('storageWarningBanner').classList.toggle('hidden', !warn);
  }
  if ($('storageResetDefaultBtn')) {
    $('storageResetDefaultBtn').classList.toggle('hidden', !info.customPath);
  }
  syncStorageCheckboxState();
}
function formatResourcePercent(value) {
  return `${Number(value || 0).toLocaleString('fa-IR')}٪`;
}
function formatResourceRam(mb) {
  const amount = Number(mb || 0);
  if (amount >= 1024) return `${(amount / 1024).toLocaleString('fa-IR', { maximumFractionDigits: 1 })} گیگابایت`;
  return `${amount.toLocaleString('fa-IR')} مگابایت`;
}
function renderResourceBudget(summary) {
  if (!summary) return;
  const manual = summary.mode === 'manual';
  if ($('resourcesAutoMode')) $('resourcesAutoMode').checked = !manual;
  if ($('resourcesCpuPercent')) $('resourcesCpuPercent').value = String(summary.cpuPercent ?? 60);
  if ($('resourcesRamPercent')) $('resourcesRamPercent').value = String(summary.ramPercent ?? 60);
  if ($('resourcesModeBadge')) {
    $('resourcesModeBadge').textContent = manual ? 'دستی' : 'خودکار';
    $('resourcesModeBadge').classList.toggle('is-local', !manual);
  }
  if ($('resourcesCpuInfo')) $('resourcesCpuInfo').textContent = `${Number(summary.cpuCores || 0).toLocaleString('fa-IR')} هسته`;
  if ($('resourcesRamInfo')) $('resourcesRamInfo').textContent = summary.ramGb
    ? `${Number(summary.ramGb).toLocaleString('fa-IR', { maximumFractionDigits: 1 })} گیگابایت`
    : 'نامشخص';
  if ($('resourcesEffectiveInfo')) {
    $('resourcesEffectiveInfo').textContent = manual
      ? `${Number(summary.allowedCores || 0).toLocaleString('fa-IR')} هسته از ${Number(summary.cpuCores || 0).toLocaleString('fa-IR')} · ${formatResourceRam(summary.allowedRamMb)} حافظه`
      : 'خودکار (برنامه خودش متناسب با سیستم تصمیم می‌گیرد)';
  }
  syncResourceSliderLabels();
  $('resourcesManualBox')?.classList.toggle('hidden', !manual);
  [$('resourcesCpuPercent'), $('resourcesRamPercent')].forEach((el) => { if (el) el.disabled = !manual; });
}
function syncResourceSliderLabels() {
  if ($('resourcesCpuValue')) $('resourcesCpuValue').textContent = formatResourcePercent($('resourcesCpuPercent')?.value ?? 60);
  if ($('resourcesRamValue')) $('resourcesRamValue').textContent = formatResourcePercent($('resourcesRamPercent')?.value ?? 60);
}
async function openResourcesDialog() {
  if (!$('resourcesDialog')) return;
  if ($('resourcesStatus')) $('resourcesStatus').textContent = '';
  try {
    const summary = await api('/api/resources');
    state.resources = summary;
    renderResourceBudget(summary);
  } catch (error) {
    if ($('resourcesStatus')) $('resourcesStatus').textContent = error?.detailText || error?.message || String(error);
  }
  showDialog('resourcesDialog');
  setMenuOpen(false);
}
async function submitResourceBudget() {
  const auto = Boolean($('resourcesAutoMode')?.checked);
  const cpuPercent = Number($('resourcesCpuPercent')?.value ?? 60);
  const ramPercent = Number($('resourcesRamPercent')?.value ?? 60);
  const btn = $('resourcesSaveBtn');
  if (btn) btn.disabled = true;
  try {
    const summary = await api('/api/resources', jsonOptions('PUT', {
      mode: auto ? 'auto' : 'manual',
      cpuPercent: Math.min(100, Math.max(10, Math.round(cpuPercent))),
      ramPercent: Math.min(100, Math.max(10, Math.round(ramPercent))),
    }));
    state.resources = summary;
    renderResourceBudget(summary);
    if ($('resourcesStatus')) $('resourcesStatus').textContent = 'تنظیم منابع ذخیره شد و از همین حالا اعمال می‌شود.';
    toast(auto ? 'منابع سیستم به حالت خودکار برگشت' : 'سهمیهٔ رم و پردازنده ذخیره شد');
  } catch (error) {
    const msg = error?.detailText || error?.message || String(error);
    if ($('resourcesStatus')) $('resourcesStatus').textContent = msg;
    toast(msg, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}
async function openStorageDialog() {
  if (!$('storageDialog')) return;
  setProgress('storageProgress', 0, false);
  if ($('storageStatus')) $('storageStatus').textContent = '';
  const info = await api('/api/storage-settings');
  renderStorageSettings(info);
  showDialog('storageDialog');
  setMenuOpen(false);
}
async function browseStorageFolder() {
  if (storageSwitchBusy) return;
  const btn = $('storageBrowseBtn');
  if (btn) btn.disabled = true;
  try {
    const currentInput = $('storageCustomPath')?.value?.trim() || state.storage?.activePath || '';
    const res = await api('/api/storage-settings/pick-folder', jsonOptions('POST', { initial_dir: currentInput }));
    if (res && !res.cancelled && res.path) {
      if ($('storageCustomPath')) $('storageCustomPath').value = res.path;
      if ($('storageStatus')) $('storageStatus').textContent = 'پوشه انتخاب شد؛ برای ثبت نهایی روی «ذخیره و اعمال مسیر» کلیک کنید.';
    }
  } catch (error) {
    const msg = error?.message || String(error);
    if ($('storageStatus')) $('storageStatus').textContent = msg;
    toast(msg, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}
function setStorageControlsDisabled(disabled) {
  ['storageCustomPath', 'storageBrowseBtn', 'storageMigrateExisting', 'storageSaveBtn', 'storageResetDefaultBtn'].forEach((id) => {
    if ($(id)) $(id).disabled = disabled;
  });
  syncStorageCheckboxState();
}
async function submitStorageSettings(overrideCustomPath = null) {
  if (storageSwitchBusy) return;
  if (jobBusy || ocrRunning || translationRunning || exportRunning || state.modelBusy) {
    toast('در حال حاضر عملیات دیگری فعال است؛ پس از پایان آن مسیر ذخیره‌سازی را تغییر دهید.', true);
    return;
  }
  const nextPath = String(overrideCustomPath !== null ? overrideCustomPath : ($('storageCustomPath')?.value || '')).trim();
  const migrateExisting = Boolean($('storageMigrateExisting')?.checked);
  const cleanupSource = migrateExisting && Boolean($('storageCleanupOld')?.checked);
  const currentCustom = String(state.storage?.customPath || '').trim();
  if (nextPath === currentCustom && !(nextPath === '' && state.storage?.customActive)) {
    if (!nextPath) {
      toast('برنامه هم‌اکنون روی مسیر پیش‌فرض قرار دارد.');
      closeDialog('storageDialog');
      return;
    }
  }

  const targetDisplay = nextPath || state.storage?.defaultPath || 'مسیر پیش‌فرض';
  const modeExplain = migrateExisting
    ? (cleanupSource
      ? 'فایل‌ها، پروژه‌ها و مدل‌های فعلی به‌صورت امن کپی و تأیید سلامت می‌شوند و سپس فضای مسیر قبلی آزاد خواهد شد.'
      : 'یک کپی کامل از فایل‌ها، پروژه‌ها و مدل‌های فعلی به مسیر جدید منتقل می‌شود و فایل‌های مسیر قبلی نیز حفظ می‌شوند.')
    : 'فایل‌های قبلی جابه‌جا نمی‌شوند و فقط از این لحظه به بعد دانلودها و پروژه‌های جدید در مسیر انتخابی ذخیره می‌شوند.';

  const confirmed = await appConfirm(
    nextPath
      ? `آیا می‌خواهید مسیر ذخیره‌سازی و دانلودها روی پوشهٔ زیر تنظیم شود؟\n${targetDisplay}`
      : `آیا می‌خواهید به مسیر پیش‌فرض برنامه برگردید؟\n${targetDisplay}`,
    {
      title: nextPath ? 'تأیید تغییر مسیر ذخیره‌سازی' : 'بازگشت به مسیر پیش‌فرض',
      hint: modeExplain,
      confirmText: 'بله، اعمال شود',
      cancelText: 'انصراف',
      variant: 'confirm',
    },
  );
  if (!confirmed) return;

  storageSwitchBusy = true;
  setStorageControlsDisabled(true);
  setProgress('storageProgress', migrateExisting ? 0 : null, true);
  scheduleActivityPoll(true);
  if ($('storageStatus')) {
    $('storageStatus').textContent = migrateExisting
      ? 'در حال انتقال امن فایل‌ها و فعال‌سازی مسیر جدید… لطفاً تا پایان عملیات صبر کنید.'
      : 'در حال بررسی و فعال‌سازی مسیر جدید…';
  }
  try {
    if (state.project) await saveProject();
    const result = await api('/api/storage-settings', jsonOptions('PUT', {
      custom_path: nextPath,
      migrate_existing: migrateExisting,
      cleanup_source: cleanupSource,
    }));
    if (result?.storage) renderStorageSettings(result.storage);
    renderedPageSignatures.clear();
    imagePreviewVersions.clear();
    if (Array.isArray(result?.engines)) state.engines = result.engines;
    if (result?.ai) state.ai = result.ai;
    if (result?.activeProject) adoptProject(result.activeProject);
    if (Array.isArray(result?.projects)) await refreshProjectList(result.projects);
    if (state.ai) await loadAiSettings(state.ai);
    updateEngineOptions();
    syncEngineUpdateUi();
    if ($('modelsDialog')?.open) renderModels();
    refreshEngineMemory().catch(() => {});
    setProgress('storageProgress', 1, false);
    const freedBytes = Number(result?.storage?.freedSourceBytes || 0);
    const freedMsg = freedBytes >= 1024 * 1024 ? ` (${formatStorageBytesFa(freedBytes)} از مسیر قبلی آزاد شد)` : '';
    toast(`مسیر ذخیره‌سازی با موفقیت اعمال شد${freedMsg}`);
    closeDialog('storageDialog');
  } catch (error) {
    setProgress('storageProgress', 0, false);
    const msg = error?.message || String(error);
    if ($('storageStatus')) $('storageStatus').textContent = msg;
    toast(msg, true);
  } finally {
    storageSwitchBusy = false;
    scheduleActivityPoll(false);
    setStorageControlsDisabled(false);
  }
}
async function copyFieldText(inputEl, fieldLabel) {
  if (!inputEl) return;
  const hasSelection = typeof inputEl.selectionStart === 'number' && typeof inputEl.selectionEnd === 'number' && inputEl.selectionStart !== inputEl.selectionEnd;
  const text = hasSelection ? inputEl.value.slice(inputEl.selectionStart, inputEl.selectionEnd) : inputEl.value;
  if (!text) {
    toast(`${fieldLabel} خالی است.`, true);
    return;
  }
  await copyBlockText(text);
  inputEl.focus();
}
async function pasteIntoField(inputEl) {
  if (!inputEl || inputEl.disabled) return;
  if (!navigator.clipboard?.readText) {
    inputEl.focus();
    toast('مرورگر اجازهٔ خواندن مستقیم کلیپ‌بورد را نداد؛ کادر فعال شد، با Ctrl+V یا کلیک‌راست و Paste بچسبانید.', true);
    return;
  }
  let clip = '';
  try {
    clip = await navigator.clipboard.readText();
  } catch {
    inputEl.focus();
    toast('دسترسی مستقیم به کلیپ‌بورد مسدود است؛ کادر فعال شد، با Ctrl+V یا کلیک‌راست و Paste بچسبانید.', true);
    return;
  }
  const start = typeof inputEl.selectionStart === 'number' ? inputEl.selectionStart : inputEl.value.length;
  const end = typeof inputEl.selectionEnd === 'number' ? inputEl.selectionEnd : inputEl.value.length;
  inputEl.value = inputEl.value.slice(0, start) + clip + inputEl.value.slice(end);
  const cursor = start + clip.length;
  inputEl.focus();
  try { inputEl.setSelectionRange(cursor, cursor); } catch { /* ignore */ }
  inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  toast('متن از کلیپ‌بورد پیست شد');
}
function clearFieldText(inputEl) {
  if (!inputEl || inputEl.disabled) return;
  inputEl.value = '';
  inputEl.focus();
  inputEl.dispatchEvent(new Event('input', { bubbles: true }));
}
function updateTranslationSkillStatus() {
  const preview = translationPreviewData;
  const skill = $('translationSkill').value.trim();
  const context = $('translationContext').value.trim();
  const skillCount = Array.from(skill).length;
  const contextCount = Array.from(context).length;
  const skillTooLong = !!(preview?.contextMode && skillCount > preview.skillLimit);
  const contextTooLong = !!(preview?.contextMode && contextCount > preview.contextLimit);
  const overBudget = skillTooLong || contextTooLong;
  const updateBudgetCounter = (inputId, counterId, count, limit, visible) => {
    const input = $(inputId); const counter = $(counterId);
    input.classList.toggle('budget-over-limit', !!visible && count > limit);
    counter.classList.toggle('over-budget', !!visible && count > limit);
    counter.classList.toggle('hidden', !visible);
    counter.textContent = visible ? `${count} / ${limit} نویسه` : '';
  };
  updateBudgetCounter('translationSkill', 'translationSkillCounter', skillCount, preview?.skillLimit ?? 0, !!preview?.contextMode);
  updateBudgetCounter('translationContext', 'translationContextCounter', contextCount, preview?.contextLimit ?? 0, !!preview?.contextMode);
  const changed = preview && ((!isDirectMtProvider(preview.provider) && (skill !== (preview.skill ?? '') || (preview.contextMode && context !== (preview.summary ?? '')))) || (preview.rollingMode && $('translationContextResume').checked !== !!preview.resume));
  const message = skillTooLong ? `متن راهنمای ترجمه (${skillCount} نویسه) بیش از سقف مجاز ${preview.skillLimit} نویسه است؛ پیش از ارسال کوتاه کنید یا سقف نویسه را افزایش دهید.` :
    contextTooLong ? `خلاصه (${contextCount} نویسه) بیش از سقف مجاز ${preview.contextLimit} نویسه است؛ پیش از ارسال کوتاه کنید یا سقف نویسه را افزایش دهید.` :
    changed ? 'اطلاعات تغییر کرد؛ ابتدا پیش‌نمایش تازه را بازبینی کنید.' : '';
  $('translationSkillStatus').textContent = message;
  const openLimitBtn = $('openAiLimitFromPreview');
  if (openLimitBtn) {
    openLimitBtn.classList.toggle('hidden', !((preview?.previewError || overBudget) && preview?.provider !== 'free'));
    openLimitBtn.textContent = preview?.provider === 'local' ? 'دانلود و مدیریت مترجم آفلاین…' : 'تغییر سقف نویسه در تنظیمات AI';
  }
  $('translationPreviewConfirm').textContent = overBudget ? 'تأیید و ارسال برای ترجمه' : (changed ? 'به‌روزرسانی پیش‌نمایش' : 'تأیید و ارسال برای ترجمه');
  $('translationPreviewConfirm').classList.toggle('over-budget-blocked', overBudget && !preview?.previewError);
  $('translationPreviewConfirm').setAttribute('aria-disabled', overBudget ? 'true' : 'false');
  $('translationPreviewConfirm').disabled = !preview || Boolean(preview.previewError) || (!overBudget && (changed ? !translationPreviewRefresh : !preview.requests?.length));
}
function showTranslationRequestPreview(preview, action, refresh = null, switchTarget = null) {
  translationPreviewAction = action; translationPreviewRefresh = refresh; translationPreviewSwitchTarget = switchTarget || translationPreviewSwitchTarget; translationPreviewData = preview;
  renderTranslationServiceSelector(preview.provider, preview.profileId || '');
  const previewExecMeta = resolveTranslationExecMeta(preview.provider, preview.base_url || aiInfo(preview.provider)?.base_url || '');
  applyExecBadgeElement($('translationPreviewExecBadge'), previewExecMeta.mode, previewExecMeta.badge);
  if ($('translationPreviewService')) $('translationPreviewService').disabled = false;
  if ($('translationTargetLang')) {
    $('translationTargetLang').disabled = false;
    $('translationTargetLang').value = normalizeTargetLanguage(preview.targetLanguage || activeTargetLanguage());
  }
  $('translationSkillWrap').classList.toggle('hidden', isDirectMtProvider(preview.provider));
  $('translationContextWrap').classList.toggle('hidden', !preview.rollingMode);
  $('translationContextHead')?.classList.toggle('hidden', !preview.contextMode);
  $('translationContextClipActions')?.classList.toggle('hidden', !preview.contextMode);
  $('translationContextLabel').classList.toggle('hidden', !preview.contextMode); $('translationContext').classList.toggle('hidden', !preview.contextMode); $('translationContextHelp').classList.toggle('hidden', !preview.contextMode);
  $('translationContext').value = preview.displaySummary ?? preview.summary ?? '';
  $('translationContext').maxLength = 100000;
  $('translationContextResume').checked = !!preview.resume; $('translationContextResume').parentElement.classList.toggle('hidden', !!preview.singleContext);
  $('translationContextHelp').textContent = preview.contextMode ? `سهم خلاصه ${preview.contextPercent ?? 15}٪ (حداکثر ${preview.contextLimit} نویسه) · سهم اسکیل ${preview.skillPercent ?? 15}٪ (حداکثر ${preview.skillLimit} نویسه) از سقف کل ${preview.totalLimit} نویسه؛ سهم استفاده‌نشده به متن می‌رسد.` : '';
  $('translationSkill').maxLength = 100000;
  $('translationSkill').disabled = false; $('translationSkillReset').disabled = false; $('translationContext').disabled = false; $('translationContextResume').disabled = false;
  $('translationSkill').value = preview.displaySkill ?? preview.skill ?? '';
  $('translationPreviewSummary').textContent = preview.rollingMode ? `${preview.blockCount} متن · پیش‌نمایش درخواست اول${preview.contextMode ? ' (تعداد درخواست‌های بعدی وابسته به خلاصه است)' : ''}` : `${preview.blockCount} متن · ${preview.requestCount} درخواست پایه برای بررسی (بدون تکرار)`;
  const destination = [preview.providerLabel, preview.model && `مدل: ${preview.model}`, preview.base_url && `نشانی: ${preview.base_url}`, preview.fallback_url && `فقط هنگام خطا: ${preview.fallback_url}`].filter(Boolean).join(' · ');
  $('translationPreviewDestination').textContent = destination;
  $('translationPreviewNote').textContent = preview.note || ''; $('translationPreviewError').textContent = preview.previewError ? `${preview.previewError} هیچ متنی ارسال نشده است؛ سقف کل یا متن/راهنما را اصلاح و پیش‌نمایش را تازه کنید.` : ''; $('translationPreviewError').classList.toggle('hidden', !preview.previewError); $('copyTranslationPreviewError').classList.toggle('hidden', !preview.previewError);
  updateTranslationSkillStatus();
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
function cancelTranslationRequestPreview() { translationPreviewAction = null; translationPreviewRefresh = null; translationPreviewSwitchTarget = null; translationPreviewData = null; closeDialog('translationPreviewDialog'); }
function clearResponseRepair() {
  translationRepairAction = null; $('responseRepair').classList.add('hidden'); $('responseRepairText').value = ''; $('repairTranslation').value = ''; $('repairSummary').value = ''; $('responseRepairStatus').textContent = '';
}
function offerResponseRepair(error, action) {
  if (!error.recoveryToken || typeof error.responseText !== 'string') return;
  $('responseRepairText').value = error.responseText;
  let prefillTranslation = '';
  let prefillSummary = '';
  try {
    const cleaned = error.responseText.replace(/<(?:think|thinking)\b[^>]*>[\s\S]*?<\/(?:think|thinking)\s*>/gi, '').trim();
    const fenceMatch = cleaned.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(fenceMatch ? fenceMatch[0] : cleaned);
    const rawTr = parsed.translation ?? parsed.Translation ?? parsed.translations ?? parsed.translated_text;
    const rawSum = parsed.summary ?? parsed.Summary ?? parsed.story_summary ?? parsed.context;
    if (typeof rawTr === 'string') prefillTranslation = rawTr;
    else if (Array.isArray(rawTr) && rawTr.every((x) => typeof x === 'string')) prefillTranslation = rawTr.join('\n');
    if (typeof rawSum === 'string') prefillSummary = rawSum;
  } catch { /* raw text remains editable in responseRepairText */ }
  $('repairTranslation').value = prefillTranslation;
  $('repairSummary').value = prefillSummary;
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
  const action = translationPreviewAction; const preview = translationPreviewData; const refresh = translationPreviewRefresh; const switchTarget = translationPreviewSwitchTarget;
  if (!action || !preview) return;
  const skillText = $('translationSkill').value.trim();
  const contextText = $('translationContext').value.trim();
  const skillCount = Array.from(skillText).length;
  const contextCount = Array.from(contextText).length;
  const skillTooLong = !!(preview.contextMode && skillCount > preview.skillLimit);
  const contextTooLong = !!(preview.contextMode && contextCount > preview.contextLimit);
  if (skillTooLong || contextTooLong) {
    const lines = [];
    if (skillTooLong) {
      lines.push(`متن «راهنمای ترجمهٔ AI برای این نوبت» ${skillCount} نویسه است که ${skillCount - preview.skillLimit} نویسه از سقف مجاز (${preview.skillLimit} نویسه) بیشتر است.`);
    }
    if (contextTooLong) {
      lines.push(`متن «خلاصهٔ زمینه / داستان» ${contextCount} نویسه است که ${contextCount - preview.contextLimit} نویسه از سقف مجاز (${preview.contextLimit} نویسه) بیشتر است.`);
    }
    const targetInput = skillTooLong ? $('translationSkill') : $('translationContext');
    await appAlert(
      `${lines.join('\n')}\nتا زمانی که تعداد نویسه‌ها بیش از سقف مجاز است، متن برای ترجمه ارسال نمی‌شود.`,
      {
        title: 'تعداد نویسه‌ها بیش از سقف مجاز است',
        confirmText: 'متوجه شدم',
        variant: 'warning',
        hint: 'لطفاً متن داخل کادر را کوتاه کنید یا با دکمهٔ «تغییر سقف نویسه در تنظیمات AI» سهم اسکیل / سقف کل نویسه‌ها را افزایش دهید.',
      },
    );
    targetInput?.focus();
    return;
  }
  $('translationPreviewConfirm').disabled = true;
  const changed = (!isDirectMtProvider(preview.provider) && (skillText !== (preview.skill ?? '') || (preview.contextMode && contextText !== (preview.summary ?? '')))) || (preview.rollingMode && $('translationContextResume').checked !== !!preview.resume);
  if (changed) {
    $('translationSkill').disabled = true; $('translationSkillReset').disabled = true; $('translationContext').disabled = true; $('translationContextResume').disabled = true;
    setProgress('previewPrepProgress', null, true);
    try {
      if (!refresh) throw new Error('به‌روزرسانی پیش‌نمایش ممکن نیست؛ دوباره ترجمه را شروع کنید.');
      const updated = await refresh(skillText, contextText, $('translationContextResume').checked);
      // Cancel/close during the local preview request must not reopen it or send.
      if ($('translationPreviewDialog').open && translationPreviewAction === action) showTranslationRequestPreview(updated, action, refresh, switchTarget);
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
  translationPreviewAction = null; translationPreviewRefresh = null; translationPreviewSwitchTarget = null; translationPreviewData = null;
  closeDialog('translationPreviewDialog');
  try { translationPreviewTask = action(preview); await translationPreviewTask; }
  catch (error) {
    if (error?.cancelled || error?.name === 'AbortError' || translationCancelledByUser) return;
    if (!$('translationDialog').open) showSingleTranslationError(error, repair => action(preview, repair));
    toast(error.message || 'ترجمه ناموفق بود', true);
  }
  finally { $('translationPreviewConfirm').disabled = false; }
}
async function runTranslation(targetOverride = null) {
  if (translationRunning) return;
  if (!isModuleLicensed('translation')) { await ensureModuleLicensed('translation'); return; }
  try {
    // Loading a project also uploads previews; do not race those writes against
    // the translation's optimistic version check or snapshot the old selection.
    await waitForProjectLoads();
    const selected = selectedImages(); const ids = selected.map((item) => item.id);
    if (!ids.length) throw new Error('حداقل یک تصویر را انتخاب کنید.');
    const missing = selected.filter(item => !item.ocrCompleted && !(item.blocks || []).length);
    if (missing.length) {
      if (!isModuleLicensed('ocr')) { await ensureModuleLicensed('ocr'); return; }
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
    selected.forEach((item) => {
      (item.blocks || []).forEach((block) => {
        if (block.enabled === false) return;
        const canPromoteManualSource = Boolean(block.manual && (block.manualLang === 'en' || block.dir === 'ltr'));
        if (canPromoteManualSource && !String(block.text || '').trim() && String(block.tr || '').trim()) {
          block.text = String(block.tr || '').trim();
        }
      });
    });
    if (!selected.some(item => (item.blocks || []).some(block => block.enabled !== false && String(block.text || '').trim()))) {
      throw new Error('هیچ کادر فعال دارای متن در تصاویر انتخاب‌شده نیست. اگر OCR متنی پیدا نکرده، تنظیمات یا تصویر را بررسی و OCR را دوباره اجرا کنید.');
    }
    await saveProject();
    const target = resolvePreferredTranslationTarget(targetOverride);
    const provider = target.provider; const profileId = target.profileId; const projectId = state.project.id;
    const targetLanguage = activeTargetLanguage();
    state.project.settings = state.project.settings || {};
    state.project.settings.targetLanguage = targetLanguage;
    const request = {
      image_ids: ids,
      provider,
      ...(profileId ? { profile_id: profileId } : {}),
      source_language: $('ocrLanguage').value,
      target_language: targetLanguage,
      reuse_repeated: state.ai?.reuse_repeated !== false,
    };
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
    const switchTarget = (nextVal) => runTranslation(nextVal);
    if (isDirectMtProvider(provider)) {
      const previous = previousRun;
      const resume = !!(previous && previous.jobs?.some(job => job.remaining) && previous.provider === provider && (previous.targetLanguage || 'fa') === targetLanguage && JSON.stringify(previous.imageIds) === JSON.stringify(ids));
      const refresh = async (_skill, _summary, nextResume) => { await confirmRestart(nextResume); return api(`/api/projects/${projectId}/context-preview`, jsonOptions('POST', { ...request, skill: '', summary: '', resume: nextResume })); };
      let preview;
      try { preview = await refresh('', '', resume); }
      catch (error) {
        if (!resume || error.status !== 409) throw error;
        preview = await refresh('', '', false);
        preview.note += ' نوبت ناتمام با تنظیمات فعلی سازگار نیست؛ تأیید نوبت تازه‌ای شروع می‌کند.';
      }
      if (!preview.requests?.length && !preview.previewError) throw new Error('هیچ درخواست ترجمه‌ای ساخته نشد؛ کادرهای فعال و انتخاب تصاویر را بررسی کنید.');
      const emptyPages = selected.filter(item => !(item.blocks || []).some(block => block.enabled !== false && String(block.text || '').trim()));
      if (emptyPages.length) preview.note += ` ${emptyPages.length} تصویر بدون متن فعال از ترجمه کنار گذاشته می‌شوند.`;
      showTranslationRequestPreview(preview, accepted => performContextTranslation(request, accepted), refresh, switchTarget);
      return;
    }
    const allActiveProfiles = state.ai?.providers?.[provider]?.profiles?.filter(p => p.hasApiKey) || [];
    const profiles = profileId ? allActiveProfiles.filter(p => String(p.id) === profileId) : allActiveProfiles;
    const limit = profiles.length ? Math.min(...profiles.map(p => p.source_limit ?? 1000)) : 1000;
    const skillLimit = Math.floor(limit * (state.ai?.skill_percent ?? 15) / 100);
    const contextLimit = Math.floor(limit * (state.ai?.context_percent ?? 15) / 100);
    const oldSkill = savedTranslationSkill(projectId);
    const defaultTargetLabel = TARGET_LANGUAGE_META[targetLanguage]?.label || targetLanguage;
    const fallbackSkill = targetLanguage === 'fa'
      ? 'ترجمه را روان و متناسب با لحن کمیک یا کتاب بنویس؛ نام‌ها، اصطلاحات، اعداد و آواها را حفظ کن.'
      : `ترجمه را روان، طبیعی و متناسب با لحن کمیک یا کتاب به زبان ${defaultTargetLabel} بنویس؛ نام‌ها، اصطلاحات، اعداد و آواها را حفظ کن.`;
    const skill = oldSkill ?? fallbackSkill;
    const previous = previousRun;
    const resume = !!(previous && previous.jobs?.some(job => job.remaining) && previous.provider === provider && (previous.profileId || '') === profileId && (previous.targetLanguage || 'fa') === targetLanguage && JSON.stringify(previous.imageIds) === JSON.stringify(ids));
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
    showTranslationRequestPreview(preview, accepted => { rememberTranslationSkill(projectId, accepted); return performContextTranslation(request, accepted); }, refresh, switchTarget);
  } catch (error) {
    if (error?.cancelled || error?.name === 'AbortError') return;
    if (targetOverride && $('translationPreviewDialog').open) throw error;
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
    const jobTitle = request.provider === 'local'
      ? 'در حال ترجمهٔ آفلاین روی سیستم شما…'
      : (request.provider === 'free' ? 'در حال ترجمهٔ رایگان…' : 'در حال ترجمه با حافظهٔ داستان…');
    await runJob(jobTitle, async () => {
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
        phase = 'translation';
        $('translationStatus').textContent = request.provider === 'local'
          ? `در حال ترجمهٔ آفلاین بخش ${run.completed + 1} روی سیستم شما…`
          : (request.provider === 'free' ? `در حال ترجمهٔ درخواست ${run.completed + 1}…` : `در حال ترجمهٔ درخواست ${run.completed + 1} با خلاصهٔ قبلی…`);
        const result = await api(`/api/projects/${projectId}/context-step`, {
          ...jsonOptions('POST', {run_id: run.id, completed: run.completed, skill: preview.skill, ...(correction || {})}),
          signal: controller.signal,
        });
        checkNotCancelled();
        if (correction) { correction = null; clearResponseRepair(); }
        const hasAffected = Boolean(result.affectedImageIds?.length);
        adoptProject(result.project, { skipGrid: hasAffected });
        run.completed = result.completed ?? run.completed;
        phase = 'preview'; setOverlayMode('translation', false);
        if (hasAffected) {
          try { await renderImagesText(result.affectedImageIds, null, checkNotCancelled); }
          catch (error) {
            if (error?.cancelled || error?.name === 'AbortError' || translationCancelledByUser) throw error;
            renderGrid();
            toast(`ترجمه ذخیره شد، اما همگام‌سازی پیش‌نمایش ناموفق بود: ${error.message || error}`, true);
          }
        }
        if (result.done) break;
      }
      phase = 'save'; setOverlayMode('translation', false);
    }, 'translationProgress');
    translationClosingNormally = true;
    closeDialog('translationDialog'); toast(isDirectMtProvider(request.provider) ? 'ترجمه ذخیره شد' : 'ترجمه و خلاصه ذخیره شد');
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
let fontLoadedOnce = false;
const renderedPageSignatures = new Map();
const watermarkLogoCache = new Map();
function projectWatermarkLogos() {
  const logos = state.project?.settings?.watermarkLogos;
  return logos && typeof logos === 'object' ? logos : {};
}
function decodeDataUrlDrawable(dataUrl) {
  return new Promise((resolve) => {
    const raw = String(dataUrl || '').trim();
    if (!raw || !raw.startsWith('data:image/')) { resolve(null); return; }
    if (typeof Image === 'function') {
      const img = new Image();
      let settled = false;
      const done = (val) => { if (!settled) { settled = true; clearTimeout(timer); resolve(val); } };
      const timer = setTimeout(() => done(null), 1500);
      img.onload = () => done(img);
      img.onerror = () => done(null);
      img.src = raw;
      if (img.complete && img.naturalWidth > 0) done(img);
      return;
    }
    resolve(null);
  });
}
async function ensureWatermarkLogoDrawable(logoId, dataUrl) {
  const key = `${logoId || 'inline'}:${String(dataUrl || '').length}:${String(dataUrl || '').slice(-32)}`;
  if (watermarkLogoCache.has(key)) return watermarkLogoCache.get(key);
  const drawable = await decodeDataUrlDrawable(dataUrl);
  if (drawable) watermarkLogoCache.set(key, drawable);
  return drawable;
}
async function ensureWatermarkLogosReady(wm) {
  if (!hasActiveWatermark(wm)) return;
  const logoId = String(wm.logoId || '').trim();
  const logos = projectWatermarkLogos();
  if (logoId && logos[logoId]?.dataUrl) {
    const drawable = await ensureWatermarkLogoDrawable(logoId, logos[logoId].dataUrl);
    if (drawable) logos[logoId]._drawable = drawable;
  } else if (wm.logoDataUrl) {
    const drawable = await ensureWatermarkLogoDrawable('inline', wm.logoDataUrl);
    if (drawable) wm._logoDrawable = drawable;
  }
}
function buildTypesetRenderOptions(item) {
  const wm = hasActiveWatermark(item?.watermark) ? item.watermark : null;
  return {
    eraseOriginal: state.project?.settings?.eraseOriginal !== false,
    watermark: wm,
    watermarkLogos: projectWatermarkLogos(),
  };
}
function watermarkSignaturePart(wm) {
  if (!hasActiveWatermark(wm)) return null;
  const logoId = String(wm.logoId || '').trim();
  const logoEntry = logoId ? projectWatermarkLogos()[logoId] : null;
  const logoLen = logoEntry?.dataUrl ? logoEntry.dataUrl.length : (wm.logoDataUrl ? String(wm.logoDataUrl).length : 0);
  return [wm.text || '', wm.position || 'bottom-left', wm.sizePct ?? 3.5, wm.opacity ?? 55, wm.angle ?? '', wm.marginPct ?? 2.5, wm.tileGapPct ?? 22, wm.color || '#ffffff', wm.bold !== false, wm.outline !== false, wm.outlineColor || '#000000', !!wm.bgPill, wm.bgColor || '#000000', logoId, wm.logoScalePct ?? 9, logoLen];
}
function pageRenderSignature(item, mode = currentOverlayMode(), blocksOverride = null) {
  const blocks = blocksOverride || overlayBlocks(item, mode);
  const erase = state.project?.settings?.eraseOriginal !== false;
  return JSON.stringify([mode, erase, blocks, watermarkSignaturePart(item?.watermark)]);
}
function isPageRenderCurrent(item, mode = currentOverlayMode()) {
  if (!state.project?.id || !item) return false;
  const key = `${state.project.id}:${item.id}`;
  const blocks = overlayBlocks(item, mode);
  const active = blocks.some((block) => block.enabled && (hasRenderableText(block) || hasRenderableShapeFill(block))) || hasActiveWatermark(item?.watermark);
  return Boolean(item.edited) === active && renderedPageSignatures.get(key) === pageRenderSignature(item, mode, blocks);
}
async function ensureFont() {
  if (fontLoadedOnce || !document.fonts?.load) return;
  try {
    await Promise.all([document.fonts.load('700 24px Vazirmatn', 'ابپتثجچ'), document.fonts.load('400 16px Vazirmatn', 'ابپتثجچ')]);
    fontLoadedOnce = true;
  } catch { /* fallback */ }
}
async function decodeProjectImageBitmap(rawBlob, item) {
  let bitmap = await createImageBitmap(rawBlob);
  if (
    bitmap &&
    bitmap.width &&
    bitmap.height &&
    item?.width &&
    item?.height &&
    (bitmap.width !== item.width || bitmap.height !== item.height)
  ) {
    try {
      const unoriented = await createImageBitmap(rawBlob, { imageOrientation: 'none' });
      if (unoriented && unoriented.width === item.width && unoriented.height === item.height) {
        bitmap.close?.();
        bitmap = unoriented;
      } else {
        unoriented?.close?.();
      }
    } catch { /* fallback if imageOrientation option is unsupported */ }
  }
  return bitmap;
}
async function renderAndUploadNow(item, projectId, mode, { skipUnchanged = false } = {}) {
  const key = `${projectId}:${item.id}`;
  const blocks = overlayBlocks(item, mode);
  const active = blocks.some((block) => block.enabled && (hasRenderableText(block) || hasRenderableShapeFill(block))) || hasActiveWatermark(item?.watermark);
  const signature = pageRenderSignature(item, mode, blocks);
  if (skipUnchanged && Boolean(item.edited) === active && renderedPageSignatures.get(key) === signature) {
    return;
  }
  if (!active) {
    const reverted = await api(`/api/projects/${projectId}/images/${item.id}/revert`, { method: 'POST' });
    imagePreviewVersions.set(key, ++previewRevision);
    renderedPageSignatures.set(key, signature);
    const current = state.project?.id === projectId ? state.project.images.find((entry) => entry.id === item.id) : null;
    if (current) current.edited = false;
    if (state.project?.id === projectId && reverted?.updatedAt) state.project.updatedAt = reverted.updatedAt;
    return;
  }
  await ensureFont();
  await ensureWatermarkLogosReady(item?.watermark);
  const response = await fetch(`/api/projects/${projectId}/images/${item.id}/content`);
  if (!response.ok) throw new Error('تصویر اصلی باز نشد');
  let rawBlob = await response.blob();
  let bitmap = null;
  try {
    bitmap = await decodeProjectImageBitmap(rawBlob, item);
  } finally {
    rawBlob = null;
  }
  let canvas = null;
  let pngBlob = null;
  try {
    try {
      canvas = Typeset.render(bitmap, blocks, buildTypesetRenderOptions(item));
    } finally {
      bitmap?.close?.();
      bitmap = null;
      Typeset.releaseCaches?.();
    }
    pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  } finally {
    if (canvas) {
      try { canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height); } catch { /* ignore */ }
      canvas.width = canvas.height = 0;
      canvas = null;
    }
  }
  if (!pngBlob) throw new Error(`ساخت PNG برای «${item.name}» ممکن نشد؛ تصویر خیلی بزرگ یا حافظهٔ مرورگر کم است`);
  let uploaded = null;
  try {
    uploaded = await api(`/api/projects/${projectId}/images/${item.id}/rendered`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: pngBlob });
  } finally {
    pngBlob = null;
  }
  imagePreviewVersions.set(key, ++previewRevision);
  renderedPageSignatures.set(key, signature);
  const current = state.project?.id === projectId ? state.project.images.find((entry) => entry.id === item.id) : null;
  if (current) current.edited = true;
  if (state.project?.id === projectId && uploaded?.updatedAt) state.project.updatedAt = uploaded.updatedAt;
}
function renderAndUpload(item, options = {}) {
  const projectId = state.project?.id;
  if (!projectId) return Promise.resolve();
  const key = `${projectId}:${item.id}`;
  const mode = currentOverlayMode();
  const previous = imageRenderTasks.get(key) || Promise.resolve();
  // A slow older canvas/upload must finish before the newer request for this same image.
  // Other images remain independent, and a failed earlier render does not block later attempts.
  const task = previous.catch(() => {}).then(() => renderAndUploadNow(item, projectId, mode, options));
  imageRenderTasks.set(key, task);
  task.finally(() => { if (imageRenderTasks.get(key) === task) imageRenderTasks.delete(key); }).catch(() => {});
  return task;
}
function browserRenderConcurrency(totalCount = 1) {
  const hw = Number(globalThis.navigator?.hardwareConcurrency) || 4;
  // Cap concurrent full-resolution browser canvases to 2 so multi-page runs release each page's
  // bitmap/canvas memory before allocating more, preventing browser RAM spikes on large pages.
  const slots = Math.max(2, Math.min(2, Math.floor(hw / 2)));
  return Math.max(1, Math.min(totalCount, slots));
}
async function renderImagesText(ids = null, onStep = null, checkCancel = null, options = {}) {
  const wanted = ids ? new Set(ids) : null;
  const targets = sortedImages().filter((item) => (!wanted || wanted.has(item.id)) && (hasOverlayText(item) || item.edited));
  if (!targets.length) { renderGrid(); return; }
  const concurrency = browserRenderConcurrency(targets.length);
  let nextIdx = 0;
  let completed = 0;
  const runWorker = async () => {
    while (nextIdx < targets.length) {
      if (checkCancel) checkCancel();
      const currentIdx = nextIdx;
      nextIdx += 1;
      await renderAndUpload(targets[currentIdx], options);
      completed += 1;
      if (onStep) onStep(completed, targets.length);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
  renderGrid();
}
function updateExportFields() {
  const kind = $('exportKind').value;
  $('pdfExportFields').classList.toggle('hidden', kind !== 'pdf');
  $('imageExportFields').classList.toggle('hidden', kind !== 'images');
  $('docxExportFields')?.classList.toggle('hidden', kind !== 'docx');
  $('pptxExportFields')?.classList.toggle('hidden', kind !== 'pptx');
  $('exportOverlayModeWrap')?.classList.toggle('hidden', kind === 'txt' || kind === 'docx' || kind === 'pptx');
}
async function exportResult(kind = null, modeOverride = null, layoutOverride = null, externalSignal = null) {
  if (kind) { $('exportKind').value = kind; updateExportFields(); }
  if (!selectedImages().length) throw new Error('حداقل یک تصویر را برای خروجی انتخاب کنید');
  const controller = new AbortController();
  exportAbortController = controller; exportCancelledByUser = false; exportRunning = true;
  const onExternalAbort = () => { exportCancelledByUser = true; controller.abort(); };
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const checkNotCancelled = () => {
    if (exportCancelledByUser || controller.signal.aborted || externalSignal?.aborted) {
      const err = new Error('ساخت خروجی لغو شد.'); err.name = 'AbortError'; err.cancelled = true; throw err;
    }
  };
  $('cancelExportBtn')?.classList.remove('hidden');
  if ($('startExportBtn')) $('startExportBtn').disabled = true;
  if ($('docxExportCancel')) { $('docxExportCancel').textContent = 'لغو عملیات'; $('docxExportCancel').classList.add('danger'); }
  if ($('pptxExportCancel')) { $('pptxExportCancel').textContent = 'لغو عملیات'; $('pptxExportCancel').classList.add('danger'); }
  try {
    await overlayPreviewTask;
    await waitForPendingRenders(state.project?.id);
    checkNotCancelled();
    const project = state.project;
    if (!project) throw new Error('پروژه‌ای برای خروجی فعال نیست');
    const exportKind = $('exportKind').value;
    if (layoutOverride) {
      if (exportKind === 'pptx' && $('exportPptxLayout')) $('exportPptxLayout').value = layoutOverride;
      else if ($('exportDocxLayout')) $('exportDocxLayout').value = layoutOverride;
    }
    collectOutputSettings(); await saveProject();
    const docxMode = modeOverride || $('exportDocxMode')?.value || 'translation';
    const docxLayout = layoutOverride || $('exportDocxLayout')?.value || 'visual';
    const pptxMode = modeOverride || $('exportPptxMode')?.value || 'translation';
    const pptxLayout = layoutOverride || $('exportPptxLayout')?.value || 'visual';
    if (exportKind !== 'txt' && exportKind !== 'docx' && exportKind !== 'pptx') {
      const targets = selectedImages().filter((item) => hasOverlayText(item) || item.edited);
      const staleTargets = targets.filter((item) => !isPageRenderCurrent(item));
      if (staleTargets.length) {
        const renderShare = 0.45;
        await renderImagesText(
          staleTargets.map((item) => item.id),
          (done, total) => {
            const p = (done / Math.max(1, total)) * renderShare;
            if (jobProgressTransform) jobProgressTransform.floor = Math.max(jobProgressTransform.floor || 0, p);
            if (activeProgressId) setProgress(activeProgressId, p, true);
            setProgress('jobProgress', p, true); setProgress('dockProgress', p, true);
          },
          checkNotCancelled,
          { skipUnchanged: true },
        );
        if (jobProgressTransform) {
          jobProgressTransform.offset = renderShare;
          jobProgressTransform.scale = 1 - renderShare - 0.02;
          jobProgressTransform.floor = renderShare;
        }
      } else {
        if (targets.length) {
          await renderImagesText(targets.map((item) => item.id), null, checkNotCancelled, { skipUnchanged: true });
        } else {
          renderGrid();
        }
        if (jobProgressTransform) {
          jobProgressTransform.offset = 0;
          jobProgressTransform.scale = 0.98;
          jobProgressTransform.floor = 0;
        }
      }
      await waitForPendingRenders(project.id);
    } else if (jobProgressTransform) {
      jobProgressTransform.offset = 0;
      jobProgressTransform.scale = 0.98;
      jobProgressTransform.floor = 0;
    }
    checkNotCancelled();
    const baseExportName = safeName($('exportName').value, safeName(project.name || '', 'comic-translated'));
    const activeDocMode = exportKind === 'pptx' ? pptxMode : docxMode;
    const layoutExportName = exportKind === 'docx' && docxLayout === 'flowing' && !/-book$/i.test(baseExportName)
      ? `${baseExportName}-book`
      : exportKind === 'pptx' && pptxLayout === 'flowing' && !/-slides$/i.test(baseExportName)
        ? `${baseExportName}-slides`
        : baseExportName;
    const finalExportName = (exportKind === 'docx' || exportKind === 'pptx') && activeDocMode === 'ocr' && !/-(?:en|ocr)$/i.test(layoutExportName)
      ? `${layoutExportName}-en`
      : layoutExportName;
    const reqOpts = jsonOptions('POST', {
      kind: exportKind,
      image_ids: selectedImages().map((item) => item.id),
      name: finalExportName,
      seamless: $('exportSeamless').checked,
      uniform_size: $('exportUniform').checked,
      two_per_page: $('exportTwo').checked,
      image_format: $('exportFormat').value,
      folder_name: $('exportFolder').value,
      docx_mode: docxMode,
      docx_layout: docxLayout,
      pptx_mode: pptxMode,
      pptx_layout: pptxLayout,
    });
    reqOpts.headers = { ...reqOpts.headers, 'X-Export-Prepare': '1' };
    let response;
    try {
      response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/export`, {
        ...reqOpts,
        signal: controller.signal,
      });
    } catch (cause) {
      if (cause?.name === 'AbortError' || controller.signal.aborted) checkNotCancelled();
      throw cause;
    }
    if (!response.ok) { const payload = await response.json().catch(() => null); throw new Error(payload?.detail || `خروجی ساخته نشد (HTTP ${response.status})`); }
    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
    const fallbackFilename = `${finalExportName}.${exportKind === 'images' ? 'zip' : exportKind}`;
    const link = $('downloadLink');
    let finalBytes = 0;
    if (contentType.includes('application/json')) {
      const payload = await response.json();
      checkNotCancelled();
      finalBytes = Number(payload?.size) || 0;
      if (!payload?.token || finalBytes <= 0) {
        throw new Error('سرور فایل خروجی خالی فرستاد؛ گزارش کارها را بررسی و دوباره تلاش کنید');
      }
      clearExportDownloadLink();
      activeExportPrepared = { projectId: project.id, token: payload.token };
      link.href = `/api/projects/${encodeURIComponent(project.id)}/export/${encodeURIComponent(payload.token)}`;
      link.download = payload.filename || fallbackFilename;
    } else {
      const blob = await response.blob();
      checkNotCancelled();
      if (!blob.size) throw new Error('سرور فایل خروجی خالی فرستاد؛ گزارش کارها را بررسی و دوباره تلاش کنید');
      finalBytes = blob.size;
      const disposition = response.headers?.get?.('content-disposition') || '';
      clearExportDownloadLink();
      downloadUrl = URL.createObjectURL(blob);
      link.href = downloadUrl;
      link.download = parseExportFilename(disposition, fallbackFilename);
    }
    if (activeProgressId) setProgress(activeProgressId, 1, false);
    const linkLabel = link.querySelector('span');
    if (linkLabel) linkLabel.textContent = `دانلود ${link.download}`;
    else link.textContent = `دانلود ${link.download}`;
    link.classList.remove('hidden'); link.click();
    const sizeText = finalBytes >= 1024 * 1024
      ? `${(finalBytes / (1024 * 1024)).toFixed(1)} مگابایت`
      : `${Math.max(1, Math.round(finalBytes / 1024))} کیلوبایت`;
    closeDialog('exportDialog'); closeDialog('docxExportDialog'); closeDialog('pptxExportDialog'); $('jobStatus').textContent = `خروجی ${exportKind.toUpperCase()} آماده شد · ${sizeText}`; toast('خروجی آماده شد؛ اگر دانلود خودکار نشد، پیوند «دانلود» را بزنید');
  } catch (error) {
    if (exportCancelledByUser || error?.cancelled || error?.name === 'AbortError') {
      toast('ساخت خروجی به درخواست شما متوقف شد');
      throw error;
    }
    throw error;
  } finally {
    if (externalSignal) externalSignal.removeEventListener?.('abort', onExternalAbort);
    if (exportAbortController === controller) exportAbortController = null;
    exportRunning = false;
    $('cancelExportBtn')?.classList.add('hidden');
    if ($('startExportBtn')) $('startExportBtn').disabled = false;
    if ($('docxExportCancel')) { $('docxExportCancel').textContent = 'انصراف'; $('docxExportCancel').classList.remove('danger'); }
    if ($('pptxExportCancel')) { $('pptxExportCancel').textContent = 'انصراف'; $('pptxExportCancel').classList.remove('danger'); }
    dismissJobCancelModal('export');
  }
}
function openDocxExportPrompt() {
  if (!selectedImages().length) { toast('حداقل یک تصویر را برای خروجی انتخاب کنید', true); return; }
  setProgress('docxProgress', 0, false);
  showDialog('docxExportDialog');
}
async function runDocxChoiceExport(mode, layout = 'visual') {
  const buttons = ['docxChoiceTranslation', 'docxChoiceOcr', 'docxChoiceFlowingTranslation', 'docxChoiceFlowingOcr'].map((id) => $(id)).filter(Boolean);
  buttons.forEach((btn) => { btn.disabled = true; });
  if ($('exportDocxMode')) $('exportDocxMode').value = mode;
  if ($('exportDocxLayout')) $('exportDocxLayout').value = layout;
  const layoutText = layout === 'flowing' ? 'متن پیوستهٔ کتابی' : 'تصویری';
  const modeText = mode === 'ocr' ? 'متن اصلی / OCR' : 'متن ترجمه‌شده';
  const label = `در حال ساخت فایل Word (${layoutText} — ${modeText})…`;
  try { await runJob(label, (signal) => exportResult('docx', mode, layout, signal), 'docxProgress'); }
  finally { buttons.forEach((btn) => { btn.disabled = false; }); }
}
function openPptxExportPrompt() {
  if (!selectedImages().length) { toast('حداقل یک تصویر را برای خروجی انتخاب کنید', true); return; }
  setProgress('pptxProgress', 0, false);
  showDialog('pptxExportDialog');
}
async function runPptxChoiceExport(mode, layout = 'visual') {
  const buttons = ['pptxChoiceTranslation', 'pptxChoiceOcr', 'pptxChoiceFlowingTranslation', 'pptxChoiceFlowingOcr'].map((id) => $(id)).filter(Boolean);
  buttons.forEach((btn) => { btn.disabled = true; });
  if ($('exportPptxMode')) $('exportPptxMode').value = mode;
  if ($('exportPptxLayout')) $('exportPptxLayout').value = layout;
  const layoutText = layout === 'flowing' ? 'اسلاید ارائه' : 'اسلاید تصویری';
  const modeText = mode === 'ocr' ? 'متن اصلی / OCR' : 'متن ترجمه‌شده';
  const label = `در حال ساخت فایل PowerPoint (${layoutText} — ${modeText})…`;
  try { await runJob(label, (signal) => exportResult('pptx', mode, layout, signal), 'pptxProgress'); }
  finally { buttons.forEach((btn) => { btn.disabled = false; }); }
}

// ---------- Models and AI (explicit downloads remain user initiated) ----------
let engineUpdateNoticeDismissed = false;
let engineHardwareSummary = null;
let engineMemorySummary = null;
let checkingEngineUpdates = false;
let freeingModelsRam = false;
let startupUpdateChecked = false;

function outdatedEngines() {
  return (state.engines || []).filter((engine) => engine.updateAvailable === true);
}

function formatHardwareSummary() {
  const hw = engineHardwareSummary || state.engines.find((entry) => entry.hardwareCheck)?.hardwareCheck;
  if (!hw) return 'وضعیت سخت‌افزار سیستم به همراه هر مدل بررسی می‌شود.';
  const gpuLabel = hw.gpuName || hw.gpuNames?.[0] || '';
  const diskGb = hw.freeDiskGb ?? hw.diskFreeGb ?? 0;
  const cores = Number(hw.cpuCores || 0);
  let gpuPart;
  if (hw.hasNvidiaGpu) {
    gpuPart = `کارت گرافیک NVIDIA${gpuLabel ? ` (${gpuLabel})` : ''}${hw.vramGb ? ` · حافظهٔ گرافیکی: ${hw.vramGb} گیگابایت` : ''} (شتاب‌دهی خودکار GPU فعال)`;
  } else if (hw.hasGpu) {
    const backendLabel = hw.gpuBackend === 'mps' ? 'Apple Metal' : hw.gpuBackend === 'directml' ? 'DirectML' : 'GPU';
    gpuPart = `شتاب‌دهی گرافیکی ${backendLabel}${gpuLabel ? ` (${gpuLabel})` : ''} فعال · بدون کارت گرافیک مجزای NVIDIA`;
  } else {
    gpuPart = 'بدون کارت گرافیک مجزای NVIDIA (اجرا روی پردازندهٔ چند‌هسته‌ای CPU)';
  }
  const cpuPart = cores > 0 ? ` · پردازنده: ${cores} هسته` : '';
  const diskPart = diskGb ? ` · فضای خالی دیسک: ${diskGb} گیگابایت` : '';
  return `وضعیت سیستم شما: ${gpuPart}${cpuPart}${diskPart}`;
}

function formatRamSummary() {
  if (!engineMemorySummary || typeof engineMemorySummary.totalRamMb !== 'number') {
    const loadedFromEngines = (state.engines || []).filter((item) => item.isLoadedInRam).length;
    return `مدیریت خودکار رم فعال · مدل مقیم در رم: ${loadedFromEngines}`;
  }
  const totalMb = Math.round(engineMemorySummary.totalRamMb);
  const loadedCount = Number(engineMemorySummary.loadedCount || 0);
  const loadedNames = Array.isArray(engineMemorySummary.loadedEngines) && engineMemorySummary.loadedEngines.length
    ? ` (${engineMemorySummary.loadedEngines.map((item) => item.name).join('، ')})`
    : '';
  return `رم مصرفی برنامه: ${totalMb} مگابایت · مدل مقیم در رم: ${loadedCount}${loadedNames}`;
}

async function refreshEngineMemory() {
  try {
    const mem = await api('/api/engines/memory');
    if (mem && typeof mem === 'object') {
      engineMemorySummary = mem;
      syncEngineUpdateUi();
    }
  } catch {}
}

async function freeModelsRam() {
  if (freeingModelsRam || state.modelBusy || ocrRunning) return;
  freeingModelsRam = true;
  syncEngineUpdateUi();
  try {
    const res = await api('/api/engines/unload', jsonOptions('POST', {}));
    if (Array.isArray(res?.engines)) state.engines = res.engines;
    if (res?.memory) engineMemorySummary = res.memory;
    renderModels();
    const totalMb = Math.round(res?.memory?.totalRamMb ?? 0);
    const freedMb = Math.round(res?.memory?.freedRamMb ?? 0);
    const msg = freedMb > 0
      ? `حافظهٔ رم مدل‌ها آزاد شد (${freedMb} مگابایت آزاد شد · مصرف فعلی: ${totalMb} مگابایت).`
      : `حافظهٔ رم بهینه شد؛ هیچ مدلی در رم باقی نمانده است (مصرف فعلی: ${totalMb} مگابایت).`;
    if ($('modelTestResult')) $('modelTestResult').textContent = msg;
    toast('حافظهٔ رم مدل‌های OCR آزاد شد');
  } catch (error) {
    toast(error.message, true);
  } finally {
    freeingModelsRam = false;
    syncEngineUpdateUi();
  }
}

function syncEngineUpdateUi() {
  const updates = outdatedEngines();
  const hwEl = $('modelsHardwareSummary');
  if (hwEl) hwEl.textContent = formatHardwareSummary();
  const ramEl = $('modelsRamStatus');
  if (ramEl) ramEl.textContent = formatRamSummary();
  const freeRamBtn = $('freeModelsRamBtn');
  if (freeRamBtn) freeRamBtn.disabled = Boolean(freeingModelsRam || state.modelBusy || ocrRunning);
  const badge = $('modelsBtnBadge');
  if (badge) {
    badge.textContent = updates.length ? `${updates.length} جدید` : '';
    badge.classList.toggle('hidden', updates.length === 0);
  }
  const updateAllBtn = $('updateAllModelsBtn');
  if (updateAllBtn) {
    updateAllBtn.textContent = updates.length > 1 ? `به‌روزرسانی همه (${updates.length} مدل)` : 'به‌روزرسانی مدل به نسخهٔ جدید';
    updateAllBtn.disabled = Boolean(state.modelBusy);
    updateAllBtn.classList.toggle('hidden', updates.length === 0);
  }
  const checkBtn = $('checkModelUpdatesBtn');
  if (checkBtn) checkBtn.disabled = Boolean(state.modelBusy || checkingEngineUpdates);
  const dialogBanner = $('modelsUpdateBanner');
  if (dialogBanner) {
    if (updates.length) {
      dialogBanner.textContent = updates.map((engine) => `• ${engine.updateSummary || `نسخهٔ جدید برای «${engine.name}» در دسترس است.`}`).join('\n');
      dialogBanner.classList.remove('hidden');
    } else {
      dialogBanner.textContent = '';
      dialogBanner.classList.add('hidden');
    }
  }
  const topNotice = $('engineUpdateNotice');
  const topText = $('engineUpdateNoticeText');
  const topBtn = $('engineUpdateNowBtn');
  if (topNotice && topText) {
    if (updates.length && !engineUpdateNoticeDismissed) {
      topText.textContent = updates.length === 1
        ? (updates[0].updateSummary || `نسخهٔ جدید مدل OCR «${updates[0].name}» آمادهٔ دریافت است.`)
        : `نسخهٔ جدید برای ${updates.length} مدل نصب‌شدهٔ OCR (${updates.map((item) => item.name).join('، ')}) منتشر شده است و با یک کلیک قابل دریافت است.`;
      if (topBtn) {
        topBtn.textContent = updates.length > 1 ? `به‌روزرسانی همه (${updates.length})` : 'به‌روزرسانی خودکار';
        topBtn.disabled = Boolean(state.modelBusy);
      }
      topNotice.classList.remove('hidden');
    } else {
      topNotice.classList.add('hidden');
    }
  }
}

async function confirmHardwareIfNeeded(engine, hwOverride = null, language = '') {
  const hw = hwOverride || engine.hardwareCheck;
  if (!hw || hw.compatible !== false) return { ok: true, force: false };
  const dl = engineDownloadSummary(engine, language);
  const sizeNotice = dl.detailLabel ? `\n\n📦 کل حجم دانلود خودکار روی این سیستم: ${dl.detailLabel}` : '';
  const warnings = Array.isArray(hw.warnings) && hw.warnings.length
    ? hw.warnings.join('\n\n')
    : `مدل «${engine.name}» به سخت‌افزار قوی‌تری نسبت به سیستم فعلی نیاز دارد.`;
  const confirmed = await appConfirm(
    `${warnings}${sizeNotice}\n\nآیا با وجود این محدودیت سخت‌افزاری، باز هم مایل به ادامهٔ نصب و دانلود خودکار این مدل هستید؟`,
    {
      title: `هشدار پیش‌نیاز سخت‌افزاری — ${engine.name}`,
      hint: 'پیشنهاد می‌شود روی سیستم‌های بدون کارت گرافیک NVIDIA از موتورهای سریع (PP-OCR، EasyOCR، Tesseract) یا مدل‌های سازگار با CPU استفاده کنید.',
      confirmText: 'بله، با همین سیستم نصب شود',
      cancelText: 'انصراف',
      variant: 'warning',
    },
  );
  return { ok: Boolean(confirmed), force: true };
}

function canUninstallEngine(engine) {
  if (!engine || engine.selectable === false) return false;
  if (typeof engine.canUninstall === 'boolean') return engine.canUninstall;
  if (engine.isBuiltinBase || engine.id === 'rapidocr-v6') return false;
  return Boolean(engine.modelReady || engine.runtimeInstalled);
}

function renderModels(options = {}) {
  const container = $('engineCards'); if (!container) return;
  const dialogEl = $('modelsDialog');
  const prevContainerScroll = container.scrollTop;
  const prevDialogScroll = dialogEl ? dialogEl.scrollTop : 0;
  container.textContent = '';
  const installedOnly = Boolean($('modelsInstalledOnly')?.checked);
  const language = $('modelsLanguage')?.value || $('testLanguage')?.value || $('ocrLanguage')?.value || 'eng';
  if ($('modelsLanguage') && $('modelsLanguage').value !== language) $('modelsLanguage').value = language;
  if ($('testLanguage') && $('testLanguage').value !== language) $('testLanguage').value = language;
  const langLabel = OCR_LANGUAGE_LABELS[language] || language;
  const modelsMode = normalizePageMode($('modelsPageMode')?.value || $('ocrPageMode')?.value);
  const selectable = state.engines.filter((engine) => engine.selectable !== false);
  const idSetSig = selectable.map((engine) => engine.id).slice().sort().join('|');
  const sortKey = `${language}::${modelsMode}::${idSetSig}`;
  const shouldResort = Boolean(options?.resort) || modelsGroupSortCache.key !== sortKey;
  const rawStandard = selectable.filter((engine) => engine.category !== 'advanced');
  const rawAdvanced = selectable.filter((engine) => engine.category === 'advanced');
  let standardEngines;
  let advancedEngines;
  let orderedSelectable;
  if (shouldResort) {
    standardEngines = sortEnginesBySuitability(rawStandard, modelsMode, language);
    advancedEngines = sortEnginesBySuitability(rawAdvanced, modelsMode, language);
    orderedSelectable = sortEnginesBySuitability(selectable, modelsMode, language);
    modelsGroupSortCache.key = sortKey;
    modelsGroupSortCache.standardIds = standardEngines.map((engine) => engine.id);
    modelsGroupSortCache.advancedIds = advancedEngines.map((engine) => engine.id);
    modelsGroupSortCache.flatIds = orderedSelectable.map((engine) => engine.id);
  } else {
    standardEngines = applyCachedEngineOrder(rawStandard, modelsGroupSortCache.standardIds);
    advancedEngines = applyCachedEngineOrder(rawAdvanced, modelsGroupSortCache.advancedIds);
    orderedSelectable = applyCachedEngineOrder(selectable, modelsGroupSortCache.flatIds);
  }
  if (installedOnly) {
    standardEngines = standardEngines.filter(canUninstallEngine);
    advancedEngines = advancedEngines.filter(canUninstallEngine);
    orderedSelectable = orderedSelectable.filter(canUninstallEngine);
  }
  const addGroup = (title, engines, external = false) => {
    if (!engines.length) return;
    const group = document.createElement('section'); group.className = 'model-group';
    const heading = document.createElement('h3'); heading.className = 'model-group-title'; heading.textContent = title; group.appendChild(heading);
    const cards = document.createElement('div'); cards.className = 'model-group-grid'; group.appendChild(cards); container.appendChild(group);
    engines.forEach((engine) => {
      const suit = engineSuitability(engine, modelsMode, language);
      const execMeta = resolveEngineExecMeta(engine);
      const isBusyThis = state.modelBusy === engine.id;
      const card = document.createElement('section'); card.className = `engine-card${external ? ' external-engine' : ''}${isBusyThis ? ' is-busy-card' : ''}`;
      card.dataset.executionMode = execMeta.mode;
      card.dataset.engineId = engine.id;
      if (!external) card.dataset.suitability = suit.tier;
      const head = document.createElement('div'); head.className = 'engine-card-head';
      const titleEl = document.createElement('h3'); titleEl.textContent = engine.name;
      const badges = document.createElement('div'); badges.className = 'engine-badges';
      if (!external) {
        const suitChip = document.createElement('span');
        suitChip.className = `engine-chip is-suit-${suit.tier}`;
        suitChip.textContent = `${suit.cardBadge} (${langLabel} · ${PAGE_MODE_LABELS[modelsMode] || modelsMode})`;
        badges.appendChild(suitChip);
      }
      const supported = (engine.languages || []).includes(language);
      const effectivePrepareLang = supported ? language : (engine.languages?.[0] || 'eng');
      const ready = supported
        ? Boolean(engine.runtimeInstalled && (engine.readyLanguages || []).includes(language))
        : Boolean(engine.runtimeInstalled && (engine.readyLanguages || []).includes(effectivePrepareLang));
      const dl = engineDownloadSummary(engine, effectivePrepareLang);
      if (ready && supported) {
        const chip = document.createElement('span'); chip.className = 'engine-chip is-ready'; chip.textContent = 'آمادهٔ استفاده'; badges.appendChild(chip);
      }
      if (engine.installedVersion) {
        const chip = document.createElement('span'); chip.className = 'engine-chip'; chip.dir = 'ltr'; chip.textContent = `v${engine.installedVersion}`; badges.appendChild(chip);
      }
      if (engine.updateAvailable) {
        const chip = document.createElement('span'); chip.className = 'engine-chip is-update';
        chip.textContent = engine.latestVersion ? `نسخهٔ جدید: ${engine.latestVersion}` : 'نسخهٔ جدید موجود است';
        badges.appendChild(chip);
      }
      if (engine.requiresNvidiaGpu) {
        const chip = document.createElement('span'); chip.className = 'engine-chip is-gpu';
        chip.textContent = engine.minVramGb ? `NVIDIA ≥ ${engine.minVramGb}GB` : 'نیازمند NVIDIA GPU';
        badges.appendChild(chip);
      } else if (engine.isolated) {
        const chip = document.createElement('span'); chip.className = 'engine-chip'; chip.textContent = 'محیط ایزولهٔ خودکار'; badges.appendChild(chip);
      }
      head.append(titleEl, badges);
      const family = document.createElement('div'); family.className = 'hint';
      family.textContent = dl.fullLabel
        ? `${engine.family} · کل حجم دانلود کامل روی این سیستم: ${dl.fullLabel}`
        : engine.family;
      const description = document.createElement('p');
      description.textContent = external
        ? engine.description
        : `${engine.description} (${execMeta.descriptionNote || 'اجرا روی سیستم شما به‌صورت آفلاین'})`;
      const suitReason = !external && suit.reason ? (() => { const el = document.createElement('div'); el.className = 'engine-suit-reason'; el.textContent = `عملکرد در «${langLabel} + ${PAGE_MODE_LABELS[modelsMode] || modelsMode}»: ${suit.reason}`; return el; })() : null;
      const status = document.createElement('div'); status.className = 'engine-status';
      if (suitReason) card.append(head, family, description, suitReason, status);
      else card.append(head, family, description, status);
      if (external) {
        status.textContent = 'اجرای جداگانه · آداپتور مستقیم OCR کمیک ندارد';
        const requirements = document.createElement('div'); requirements.className = 'engine-limit'; requirements.textContent = engine.requirements || '';
        const limitations = document.createElement('div'); limitations.textContent = engine.limitations || '';
        const buttons = document.createElement('div'); buttons.className = 'card-buttons';
        const guide = document.createElement('a'); guide.className = 'bt'; guide.href = engine.repository; guide.target = '_blank'; guide.rel = 'noopener noreferrer'; guide.textContent = 'دانلود / راهنمای رسمی';
        buttons.appendChild(guide); card.append(requirements, limitations, buttons);
      } else {
        const isBuiltinBase = Boolean(engine.isBuiltinBase || engine.id === 'rapidocr-v6');
        status.textContent = state.modelBusy === engine.id
          ? `در حال انجام عملیات روی مدل${dl.totalLabel ? ` (کل حجم: ${dl.totalLabel})` : ''}؛ لطفاً صبر کنید…`
          : !supported
            ? `این موتور زبان «${langLabel}» را پشتیبانی نمی‌کند (زبان‌های مورد پشتیبانی: ${(engine.languages || []).map((l) => OCR_LANGUAGE_LABELS[l] || l).join('، ')}).${!ready && dl.detailLabel ? ` کل حجم دانلود خودکار: ${dl.detailLabel}.` : ''}`
            : !engine.runtimeInstalled
              ? `آمادهٔ نصب خودکار با یک کلیک · کل حجم دانلود خودکار: ${dl.detailLabel || 'محاسبهٔ خودکار'}.`
              : ready
                ? (isBuiltinBase ? 'موتور پایهٔ پیش‌فرض برنامه — آماده و آفلاین.' : 'مدل زبان انتخاب‌شده آماده و آفلاین است.')
                : `ابزار اجرا نصب است؛ برای دریافت خودکار فایل زبان انتخاب‌شده دکمهٔ زیر را بزنید (کل حجم دانلود: ${dl.detailLabel}).`;
        if (engine.updateAvailable && engine.updateSummary) {
          const updateMsg = document.createElement('div'); updateMsg.className = 'engine-update-msg';
          updateMsg.textContent = engine.updateSummary;
          card.appendChild(updateMsg);
        }
        if (engine.hardwareCheck && engine.hardwareCheck.compatible === false && Array.isArray(engine.hardwareCheck.warnings) && engine.hardwareCheck.warnings.length) {
          const hwWarn = document.createElement('div'); hwWarn.className = 'engine-hw-warn';
          hwWarn.textContent = engine.hardwareCheck.warnings[0];
          card.appendChild(hwWarn);
        }
        if (engine.requirements) { const requirements = document.createElement('div'); requirements.className = 'engine-limit'; requirements.textContent = engine.requirements; card.appendChild(requirements); }
        if (isBusyThis) {
          const progWrap = document.createElement('div');
          progWrap.className = 'engine-card-progress';
          const progHead = document.createElement('div');
          progHead.className = 'engine-card-progress-head';
          const progTxt = document.createElement('span');
          progTxt.className = 'engine-card-progress-text';
          progTxt.textContent = modelCurrentLabel || `در حال آماده‌سازی ${engine.name}…`;
          const progPct = document.createElement('span');
          progPct.className = 'engine-card-progress-pct';
          const isDet = typeof modelCurrentProgress === 'number' && Number.isFinite(modelCurrentProgress);
          const pctNum = isDet ? Math.round(Math.max(0, Math.min(1, modelCurrentProgress)) * 100) : 30;
          progPct.textContent = isDet ? `${pctNum}%` : '…';
          progHead.append(progTxt, progPct);
          const bar = document.createElement('div');
          bar.className = `bar${isDet ? '' : ' indeterminate'}`;
          bar.setAttribute('role', 'progressbar');
          bar.setAttribute('aria-label', `پیشرفت ${engine.name}`);
          bar.setAttribute('aria-valuemin', '0');
          bar.setAttribute('aria-valuemax', '100');
          if (isDet) bar.setAttribute('aria-valuenow', String(pctNum));
          const fill = document.createElement('div');
          fill.className = 'fill engine-card-progress-fill';
          fill.style.width = `${pctNum}%`;
          bar.appendChild(fill);
          progWrap.append(progHead, bar);
          card.appendChild(progWrap);
        }
        const buttons = document.createElement('div'); buttons.className = 'card-buttons';
        const canPrepare = supported || Boolean(engine.isolated && engine.languages?.length);
        const prepSizeSuffix = dl.totalLabel ? ` (کل حجم دانلود: ${dl.totalLabel})` : '';
        const prepareLabel = ready
          ? `بررسی / آماده‌سازی مجدد${dl.fullLabel ? ` (${dl.fullLabel})` : ''}`
          : `آماده‌سازی / دانلود خودکار${prepSizeSuffix}`;
        const prepare = makeButton(prepareLabel, () => {
          if (!supported && engine.languages?.length) {
            const firstLang = engine.languages[0];
            if ($('modelsLanguage')) $('modelsLanguage').value = firstLang;
            if ($('testLanguage')) $('testLanguage').value = firstLang;
          }
          downloadEngine(engine, { languageOverride: effectivePrepareLang }).catch(() => {});
        });
        prepare.classList.toggle('primary', !ready && !engine.updateAvailable && canPrepare);
        prepare.disabled = Boolean(state.modelBusy || !canPrepare);
        buttons.appendChild(prepare);
        if (engine.updateAvailable || engine.runtimeInstalled) {
          const updateBtn = makeButton(engine.updateAvailable ? 'به‌روزرسانی به نسخهٔ جدید' : 'به‌روزرسانی مدل', () => updateEngine(engine));
          if (engine.updateAvailable) updateBtn.classList.add('primary');
          updateBtn.disabled = Boolean(state.modelBusy);
          buttons.appendChild(updateBtn);
        }
        const test = makeButton('آزمایش روی تصویر', () => testEngine(engine.id));
        test.disabled = Boolean(state.modelBusy || !supported);
        buttons.appendChild(test);
        if (isBusyThis) {
          const cancelCardBtn = makeButton('لغو عملیات', () => requestCancelModelJob({ closeModelsDialog: false }).catch(() => {}));
          cancelCardBtn.classList.add('danger', 'engine-cancel-btn');
          buttons.appendChild(cancelCardBtn);
        }
        if (canUninstallEngine(engine)) {
          const deleteBtn = makeButton('حذف مدل', () => uninstallEngine(engine).catch(() => {}));
          deleteBtn.classList.add('danger', 'engine-delete-btn');
          deleteBtn.disabled = Boolean(state.modelBusy);
          buttons.appendChild(deleteBtn);
        }
        if (engine.repository) { const guide = document.createElement('a'); guide.className = 'bt'; guide.href = engine.repository; guide.target = '_blank'; guide.rel = 'noopener noreferrer'; guide.textContent = 'راهنمای رسمی'; buttons.appendChild(guide); }
        card.appendChild(buttons);
      }
      cards.appendChild(card);
    });
  };
  if (installedOnly && !orderedSelectable.length) {
    const emptyBox = document.createElement('div');
    emptyBox.className = 'models-empty-installed';
    const emptyMsg = document.createElement('p');
    emptyMsg.textContent = 'در حال حاضر هیچ مدل اضافه‌ای روی دیسک نصب نشده است (فقط موتور پایهٔ سبک برنامه فعال است).';
    const showAllBtn = makeButton('نمایش همهٔ ۱۴ مدل', () => {
      if ($('modelsInstalledOnly')) $('modelsInstalledOnly').checked = false;
      renderModels();
    });
    emptyBox.append(emptyMsg, showAllBtn);
    container.appendChild(emptyBox);
  } else if (rawAdvanced.length) {
    addGroup('موتورهای سریع و سبک کمیک — نصب خودکار و مناسب همهٔ سیستم‌ها', standardEngines);
    addGroup('مدل‌های هوش مصنوعی پیشرفته — نصب خودکار در محیط ایزوله', advancedEngines);
  } else {
    addGroup('قابل اجرا در برنامه — خروجی موقعیت‌دار', orderedSelectable);
  }
  if (!installedOnly) {
    addGroup('دانلود و راه‌اندازی جداگانه — فعلاً خارج از OCR داخلی', state.engines.filter((engine) => engine.selectable === false), true);
  }
  if (!shouldResort) {
    container.scrollTop = prevContainerScroll;
    if (dialogEl) dialogEl.scrollTop = prevDialogScroll;
  }
  syncEngineUpdateUi();
}
async function downloadEngine(engine, options = {}) {
  if (state.modelBusy) return false;
  const rawLang = options.languageOverride || $('modelsLanguage')?.value || $('testLanguage')?.value || $('ocrLanguage')?.value || 'eng';
  const language = (engine.languages || []).includes(rawLang)
    ? rawLang
    : (engine.isolated && engine.languages?.length ? engine.languages[0] : rawLang);
  if (!engine.languages.includes(language)) { toast('این موتور زبان انتخاب‌شده را پشتیبانی نمی‌کند', true); return false; }
  if (language !== rawLang) {
    if ($('modelsLanguage')) $('modelsLanguage').value = language;
    if ($('testLanguage')) $('testLanguage').value = language;
  }
  const precheck = await confirmHardwareIfNeeded(engine, null, language);
  if (!precheck.ok) return false;
  ++engineMutationSeq;
  modelFromOcrDialog = Boolean(options.fromOcrDialog);
  const controller = new AbortController();
  modelAbortController = controller; modelCancelledByUser = false;
  state.modelBusy = engine.id;
  const dl = engineDownloadSummary(engine, language);
  const dlTag = dl.totalLabel ? ` — کل حجم دانلود: ${dl.totalLabel}` : '';
  const startMsg = `در حال دانلود و آماده‌سازی خودکار ${engine.name} (${language})${dlTag}…`;
  syncModelProgressUi(null, true, startMsg);
  if ($('modelTestResult')) $('modelTestResult').textContent = startMsg;
  if (options.fromOcrDialog && $('ocrStatus')) $('ocrStatus').textContent = startMsg;
  appendLocalActivity(`آماده‌سازی خودکار ${engine.name} برای ${language} آغاز شد${dlTag}`);
  renderModels(); updateOcrEngineStatus();
  syncModelProgressUi(null, true, startMsg);
  scheduleActivityPoll(false);
  const performRequest = (forceFlag) => api(`/api/engines/${engine.id}/download`, {
    ...jsonOptions('POST', forceFlag ? { language, force: true } : { language }),
    signal: controller.signal,
  });
  let succeeded = false;
  try {
    let result;
    try {
      result = await performRequest(precheck.force);
    } catch (firstErr) {
      if (firstErr?.hardwareWarning) {
        syncModelProgressUi(0, false, '');
        const retryConfirm = await confirmHardwareIfNeeded(engine, firstErr.hardwareCheck, language);
        if (!retryConfirm.ok) {
          if ($('modelTestResult')) $('modelTestResult').textContent = 'نصب مدل به دلیل پیش‌نیاز سخت‌افزاری لغو شد.';
          if (options.fromOcrDialog && $('ocrStatus')) $('ocrStatus').textContent = 'نصب مدل به درخواست شما لغو شد.';
          return false;
        }
        syncModelProgressUi(null, true, startMsg);
        result = await performRequest(true);
      } else {
        throw firstErr;
      }
    }
    ++engineMutationSeq;
    state.engines = result.engines;
    if (result?.memory) engineMemorySummary = result.memory;
    succeeded = true;
    syncModelProgressUi(1, false, `مدل ${engine.name} آماده شد.`);
    const doneMsg = `مدل ${engine.name} برای زبان ${language} به‌طور کامل نصب و آماده شد.`;
    if ($('modelTestResult')) $('modelTestResult').textContent = doneMsg;
    if (options.fromOcrDialog && $('ocrStatus')) $('ocrStatus').textContent = doneMsg;
    if ($('jobStatus') && !jobBusy) $('jobStatus').textContent = doneMsg;
    appendLocalActivity(`مدل ${engine.name} آماده شد`, 'success');
    updateEngineOptions();
    toast(`مدل ${engine.name} آمادهٔ استفاده است`);
    return true;
  } catch (error) {
    syncModelProgressUi(0, false, '');
    if (modelCancelledByUser || error?.cancelled || error?.name === 'AbortError') {
      const cancelMsg = 'عملیات آماده‌سازی مدل به درخواست شما لغو شد.';
      if ($('modelTestResult')) $('modelTestResult').textContent = cancelMsg;
      if (options.fromOcrDialog && $('ocrStatus')) $('ocrStatus').textContent = cancelMsg;
      appendLocalActivity('آماده‌سازی مدل لغو شد', 'warning');
      toast('آماده‌سازی مدل متوقف شد');
    } else {
      const failMsg = `آماده‌سازی ناموفق بود:\n${error.message}\n\nاتصال اینترنت و فضای دیسک را بررسی کنید.`;
      if ($('modelTestResult')) $('modelTestResult').textContent = failMsg;
      if (options.fromOcrDialog && $('ocrStatus')) $('ocrStatus').textContent = failMsg;
      appendLocalActivity(`آماده‌سازی ناموفق بود: ${error.message}`, 'error');
      toast(error.message, true);
    }
    return false;
  } finally {
    if (modelAbortController === controller) modelAbortController = null;
    state.modelBusy = null;
    pollActivity().catch(() => {});
    scheduleActivityPoll(false);
    syncModelProgressUi(succeeded ? 1 : 0, false, '');
    modelFromOcrDialog = false;
    modelCurrentProgress = null;
    modelCurrentLabel = '';
    dismissJobCancelModal('model');
    renderModels();
    updateOcrEngineStatus();
  }
}
async function updateEngine(engine, options = {}) {
  if (state.modelBusy) return false;
  const targetLang = options.languageOverride || (engine.languages?.includes($('testLanguage')?.value) ? $('testLanguage').value : (engine.languages?.[0] || 'eng'));
  ++engineMutationSeq;
  modelFromOcrDialog = Boolean(options.fromOcrDialog);
  const controller = new AbortController();
  modelAbortController = controller; modelCancelledByUser = false;
  state.modelBusy = engine.id;
  const batchPrefix = options.batchIndex && options.batchTotal > 1 ? `(${options.batchIndex}/${options.batchTotal}) ` : '';
  const startMsg = `${batchPrefix}در حال دریافت و نصب نسخهٔ جدید ${engine.name}…`;
  syncModelProgressUi(null, true, startMsg);
  if ($('modelTestResult')) $('modelTestResult').textContent = startMsg;
  if (options.fromOcrDialog && $('ocrStatus')) $('ocrStatus').textContent = startMsg;
  appendLocalActivity(`به‌روزرسانی ${engine.name} آغاز شد`);
  renderModels(); updateOcrEngineStatus();
  syncModelProgressUi(null, true, startMsg);
  scheduleActivityPoll(false);
  let succeeded = false;
  try {
    const result = await api(`/api/engines/${engine.id}/update`, {
      ...jsonOptions('POST', { language: targetLang }),
      signal: controller.signal,
    });
    ++engineMutationSeq;
    state.engines = result.engines;
    if (result?.memory) engineMemorySummary = result.memory;
    succeeded = true;
    syncModelProgressUi(1, false, `مدل ${engine.name} به‌روزرسانی شد.`);
    const updatedEntry = state.engines.find((entry) => entry.id === engine.id);
    const verLabel = updatedEntry?.installedVersion ? ` (نسخهٔ ${updatedEntry.installedVersion})` : '';
    const doneMsg = `مدل ${engine.name}${verLabel} با موفقیت به آخرین نسخه به‌روزرسانی شد.`;
    if ($('modelTestResult')) $('modelTestResult').textContent = doneMsg;
    if (options.fromOcrDialog && $('ocrStatus')) $('ocrStatus').textContent = doneMsg;
    if ($('jobStatus') && !jobBusy) $('jobStatus').textContent = doneMsg;
    appendLocalActivity(doneMsg, 'success');
    updateEngineOptions();
    if (!options.batchSilentToast) toast(`مدل ${engine.name} به‌روزرسانی شد`);
    return true;
  } catch (error) {
    syncModelProgressUi(0, false, '');
    if (modelCancelledByUser || error?.cancelled || error?.name === 'AbortError') {
      const cancelMsg = 'به‌روزرسانی مدل به درخواست شما لغو شد.';
      if ($('modelTestResult')) $('modelTestResult').textContent = cancelMsg;
      appendLocalActivity(cancelMsg, 'warning');
      toast('به‌روزرسانی مدل متوقف شد');
    } else {
      const failMsg = `به‌روزرسانی ${engine.name} ناموفق بود:\n${error.message}`;
      if ($('modelTestResult')) $('modelTestResult').textContent = failMsg;
      if (options.fromOcrDialog && $('ocrStatus')) $('ocrStatus').textContent = failMsg;
      appendLocalActivity(`به‌روزرسانی ${engine.name} ناموفق بود: ${error.message}`, 'error');
      toast(error.message, true);
    }
    return false;
  } finally {
    if (modelAbortController === controller) modelAbortController = null;
    state.modelBusy = null;
    pollActivity().catch(() => {});
    scheduleActivityPoll(false);
    syncModelProgressUi(succeeded ? 1 : 0, false, '');
    modelFromOcrDialog = false;
    modelCurrentProgress = null;
    modelCurrentLabel = '';
    dismissJobCancelModal('model');
    renderModels();
    updateOcrEngineStatus();
  }
}
async function uninstallEngine(engine) {
  if (state.modelBusy || !engine) return false;
  const confirmed = await appConfirm(
    `آیا از حذف کامل مدل «${engine.name}» از روی سیستم مطمئن هستید؟\n\nتمام فایل‌های وزن، بسته‌های کمکی و محیط اجرای این مدل از دیسک پاک می‌شوند تا فضای سیستم شما آزاد شود.`,
    {
      title: `حذف کامل مدل — ${engine.name}`,
      hint: 'هر زمان دوباره به این مدل نیاز داشتید، می‌توانید آن را با یک کلیک دانلود و نصب کنید.',
      confirmText: 'حذف کامل مدل',
      cancelText: 'انصراف',
      variant: 'danger',
      destructive: true,
    },
  );
  if (!confirmed) return false;
  ++engineMutationSeq;
  state.modelBusy = engine.id;
  const startMsg = `در حال آزادسازی رم و حذف کامل فایل‌های مدل ${engine.name} از روی دیسک…`;
  syncModelProgressUi(null, true, startMsg);
  if ($('modelTestResult')) $('modelTestResult').textContent = startMsg;
  appendLocalActivity(`حذف مدل ${engine.name} آغاز شد`);
  renderModels();
  updateOcrEngineStatus();
  scheduleActivityPoll(false);
  let succeeded = false;
  try {
    const result = await api(`/api/engines/${encodeURIComponent(engine.id)}/uninstall`, jsonOptions('POST', {}));
    ++engineMutationSeq;
    if (Array.isArray(result?.engines)) state.engines = result.engines;
    if (result?.memory) engineMemorySummary = result.memory;
    if (result?.hardware) engineHardwareSummary = result.hardware;
    succeeded = true;
    const freedMb = Number(result?.freedMb || 0);
    const freedText = freedMb >= 1024
      ? ` (${(freedMb / 1024).toFixed(2)} گیگابایت فضا آزاد شد)`
      : freedMb >= 1
        ? ` (${Math.round(freedMb)} مگابایت فضا آزاد شد)`
        : '';
    const doneMsg = `مدل «${engine.name}» به‌طور کامل از روی سیستم حذف شد${freedText}.`;
    if ($('modelTestResult')) $('modelTestResult').textContent = doneMsg;
    if ($('jobStatus') && !jobBusy) $('jobStatus').textContent = doneMsg;
    appendLocalActivity(doneMsg, 'success');
    updateEngineOptions();
    toast(`مدل ${engine.name} حذف شد${freedText}`);
    return true;
  } catch (error) {
    const failMsg = `حذف مدل ناموفق بود:\n${error.message}`;
    if ($('modelTestResult')) $('modelTestResult').textContent = failMsg;
    appendLocalActivity(`حذف مدل ناموفق بود: ${error.message}`, 'error');
    toast(error.message, true);
    return false;
  } finally {
    state.modelBusy = null;
    pollActivity().catch(() => {});
    scheduleActivityPoll(false);
    syncModelProgressUi(succeeded ? 1 : 0, false, '');
    modelCurrentProgress = null;
    modelCurrentLabel = '';
    renderModels();
    updateOcrEngineStatus();
    syncEngineUpdateUi();
  }
}
async function updateAllEngines() {
  if (state.modelBusy) return;
  const targets = outdatedEngines();
  if (!targets.length) { toast('همهٔ مدل‌های نصب‌شده به‌روز هستند'); return; }
  let succeeded = 0;
  for (let i = 0; i < targets.length; i += 1) {
    const engine = targets[i];
    const ok = await updateEngine(engine, {
      batchSilentToast: targets.length > 1,
      batchIndex: i + 1,
      batchTotal: targets.length,
    });
    if (!ok) break;
    succeeded += 1;
  }
  if (targets.length > 1 && succeeded === targets.length) {
    toast(`همهٔ ${succeeded} مدل OCR با موفقیت به‌روزرسانی شدند`);
  }
}
async function checkEngineUpdates({ force = false, silent = false } = {}) {
  if (checkingEngineUpdates || state.modelBusy) return;
  const seqAtStart = engineMutationSeq;
  checkingEngineUpdates = true;
  syncEngineUpdateUi();
  if (!silent) {
    syncModelProgressUi(null, true, 'در حال بررسی انتشار نسخهٔ جدید برای مدل‌های نصب‌شده…');
    if ($('modelTestResult')) $('modelTestResult').textContent = 'در حال بررسی انتشار نسخهٔ جدید برای مدل‌های نصب‌شده…';
  }
  try {
    const report = await api('/api/engines/check-updates', jsonOptions('POST', { force }));
    // Ignore stale check-updates responses if a model download/update started or finished meanwhile.
    if (seqAtStart !== engineMutationSeq || state.modelBusy) return;
    if (Array.isArray(report?.engines)) state.engines = report.engines;
    if (report?.hardware) engineHardwareSummary = report.hardware;
    if (report?.memory) engineMemorySummary = report.memory;
    const updates = outdatedEngines();
    if (updates.length && force) engineUpdateNoticeDismissed = false;
    updateEngineOptions();
    renderModels();
    if (!silent) {
      syncModelProgressUi(1, false, '');
      const summary = updates.length
        ? `نسخهٔ جدید برای ${updates.length} مدل در دسترس است:\n${updates.map((item) => `• ${item.updateSummary || item.name}`).join('\n')}`
        : 'بررسی انجام شد؛ همهٔ مدل‌های نصب‌شدهٔ شما آخرین نسخه هستند.';
      if ($('modelTestResult')) $('modelTestResult').textContent = summary;
      toast(updates.length ? `نسخهٔ جدید برای ${updates.length} مدل OCR پیدا شد` : 'همهٔ مدل‌های نصب‌شده به‌روز هستند');
    }
  } catch (error) {
    if (!silent && seqAtStart === engineMutationSeq) {
      syncModelProgressUi(0, false, '');
      if ($('modelTestResult')) $('modelTestResult').textContent = `بررسی نسخهٔ جدید ممکن نشد:\n${error.message}`;
      toast(error.message, true);
    }
  } finally {
    checkingEngineUpdates = false;
    if (!state.modelBusy && !silent) syncModelProgressUi(modelCurrentProgress === 1 ? 1 : 0, false, '');
    syncEngineUpdateUi();
  }
}
async function testEngine(engineId) {
  if (state.modelBusy) return; const item = selectedImages()[0] || sortedImages()[0]; if (!item) { toast('ابتدا یک تصویر وارد کنید', true); return; }
  const controller = new AbortController();
  modelAbortController = controller; modelCancelledByUser = false;
  state.modelBusy = engineId; scheduleActivityPoll(true); setProgress('modelProgress', null, true); renderModels(); $('modelTestResult').textContent = 'در حال اجرای آزمایش محلی…'; appendLocalActivity(`آزمایش موتور ${engineId} آغاز شد`);
  try {
    const testLang = $('testLanguage').value;
    const testPersianPrep = testLang === 'fas'
      ? ($('ocrLanguage')?.value === 'fas' && $('ocrPersianPreprocess') ? Boolean($('ocrPersianPreprocess').checked) : true)
      : Boolean($('ocrPersianPreprocess')?.checked && $('ocrLanguage')?.value === testLang);
    const result = await api(`/api/engines/${engineId}/test`, { ...jsonOptions('POST', { project_id: state.project.id, image_id: item.id, language: testLang, page_mode: normalizePageMode($('modelsPageMode')?.value || $('ocrPageMode')?.value), persian_preprocess: testPersianPrep }), signal: controller.signal });
    if (result?.memory) engineMemorySummary = result.memory;
    setProgress('modelProgress', 1, false);
    $('modelTestResult').textContent = result.blocks.length ? result.blocks.map((block) => {
      const pad = ' '.repeat(Math.max(0, Math.min(24, Number(block.sourceIndent) || 0)));
      const firstExtra = Number(block.firstLineIndent) >= 0.75 ? '  ' : '';
      const hangExtra = Number(block.hangingIndent) >= 0.75 ? '  ' : '';
      const roleTag = block.pageRole === 'heading' ? '[تیتر] ' : '';
      const styleTag = [block.bold ? 'B' : '', block.italic ? 'I' : ''].filter(Boolean).join('+');
      const suffix = `  (${block.conf}%${styleTag ? ` · ${styleTag}` : ''})`;
      const lines = String(block.text || '').split(/\r?\n/);
      return lines.map((ln, idx) => (idx === 0 ? `${pad}${firstExtra}${roleTag}${ln}` : `${pad}${hangExtra}${ln}`)).join('\n') + suffix;
    }).join('\n') : 'متنی تشخیص داده نشد.';
    appendLocalActivity('آزمایش موتور تمام شد', 'success');
  }
  catch (error) {
    setProgress('modelProgress', 0, false);
    if (modelCancelledByUser || error?.cancelled || error?.name === 'AbortError') {
      $('modelTestResult').textContent = 'آزمایش موتور به درخواست شما لغو شد.';
      appendLocalActivity('آزمایش موتور لغو شد', 'warning');
    } else {
      $('modelTestResult').textContent = error.message; appendLocalActivity(`آزمایش موتور ناموفق بود: ${error.message}`, 'error');
    }
  }
  finally {
    if (modelAbortController === controller) modelAbortController = null;
    state.modelBusy = null;
    pollActivity().catch(() => {});
    scheduleActivityPoll(false);
    dismissJobCancelModal('model');
    renderModels();
  }
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
function syncAiExecUi() {
  const baseUrlVal = isDirectMtProvider(aiEditorProvider) ? '' : ($('aiBaseUrl')?.value ?? '');
  const meta = resolveTranslationExecMeta(aiEditorProvider, baseUrlVal);
  applyExecBadgeElement($('aiExecBadge'), meta.mode, meta.badge);
  const banner = $('aiExecBanner');
  if (banner) {
    banner.textContent = meta.banner;
    banner.dataset.execMode = meta.mode;
    banner.classList.toggle('is-local', meta.mode === 'local');
    banner.classList.toggle('is-online', meta.mode !== 'local');
  }
}
function updateAiProviderUi() {
  const info = aiInfo();
  $('aiKeyHelp').href = info.keyUrl;
  $('aiKeyHelp').textContent = info.keyLabel;
  $('aiBaseUrlField').classList.toggle('hidden', aiEditorProvider === 'gemini');
  $('aiModel').placeholder = info.defaultModel || info.model || '';
  syncAiExecUi();
}
let aiDragProfileIndex = -1;
function moveAiProfile(fromIndex, toIndex, focusSelector = '') {
  if (
    fromIndex < 0 ||
    fromIndex >= aiEditorProfiles.length ||
    toIndex < 0 ||
    toIndex >= aiEditorProfiles.length ||
    fromIndex === toIndex
  ) {
    return false;
  }
  const [moved] = aiEditorProfiles.splice(fromIndex, 1);
  aiEditorProfiles.splice(toIndex, 0, moved);
  renderAiProfiles();
  if ($('aiStatus')) {
    $('aiStatus').textContent = 'اولویت کلیدهای API تغییر کرد؛ برای ثبت نهایی روی «ذخیره» بزنید.';
  }
  if (focusSelector) {
    const container = $('aiProfiles');
    const movedRow = [...(container?.querySelectorAll('.ai-profile-row') || [])].find((item) => item.dataset.profileId === moved.id);
    const targetBtn = movedRow?.querySelector(focusSelector);
    if (targetBtn && !targetBtn.disabled) targetBtn.focus?.();
  }
  return true;
}
function renderAiProfiles() {
  const container = $('aiProfiles');
  container.textContent = '';
  const total = aiEditorProfiles.length;
  aiEditorProfiles.forEach((profile, index) => {
    const row = document.createElement('div');
    row.className = 'ai-profile-row';
    row.dataset.profileId = profile.id;
    row.dataset.priorityRank = String(index + 1);

    const orderBar = document.createElement('div');
    orderBar.className = 'ai-profile-order';
    const orderMeta = document.createElement('div');
    orderMeta.className = 'ai-profile-order-meta';
    const faRank = (index + 1).toLocaleString('fa-IR');
    const faFallback = index.toLocaleString('fa-IR');
    const priorityBadge = document.createElement('span');
    priorityBadge.className = `ai-priority-badge${index === 0 ? ' is-primary' : ''}`;
    const rankLabel = index === 0 ? 'اولویت ۱ (کلید اصلی)' : `اولویت ${faRank} (جایگزین ${faFallback})`;
    priorityBadge.textContent = total > 1 ? `⠿ ${rankLabel}` : rankLabel;
    priorityBadge.title = index === 0
      ? 'این کلید به‌عنوان اولویت اول برای ترجمه امتحان می‌شود'
      : `در صورت خطا یا اتمام سهمیهٔ کلیدهای قبلی، این کلید در اولویت ${faRank} امتحان می‌شود`;
    if (total > 1) {
      priorityBadge.draggable = true;
      priorityBadge.addEventListener('dragstart', (e) => {
        aiDragProfileIndex = index;
        row.classList.add('is-dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', profile.id); } catch (_) {}
        }
      });
      priorityBadge.addEventListener('dragend', () => {
        aiDragProfileIndex = -1;
        container.querySelectorAll('.ai-profile-row').forEach((item) => {
          item.classList.remove('is-dragging', 'is-drop-target');
        });
      });
      row.addEventListener('dragover', (e) => {
        if (aiDragProfileIndex < 0 || aiDragProfileIndex === index) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        row.classList.add('is-drop-target');
      });
      row.addEventListener('dragleave', (e) => {
        if (!row.contains(e.relatedTarget)) row.classList.remove('is-drop-target');
      });
      row.addEventListener('drop', (e) => {
        if (aiDragProfileIndex < 0) return;
        e.preventDefault();
        const fromIdx = aiDragProfileIndex;
        aiDragProfileIndex = -1;
        row.classList.remove('is-drop-target');
        moveAiProfile(fromIdx, index);
      });
    }

    const readyChip = document.createElement('span');
    const syncReadyChip = () => {
      const hasTyped = Boolean(profile.apiKey && profile.apiKey.trim());
      const isReady = hasTyped || profile.hasApiKey === true;
      readyChip.className = `ai-key-ready-chip${isReady ? ' is-ready' : ''}`;
      readyChip.textContent = hasTyped
        ? 'کلید جدید آمادهٔ ذخیره'
        : (profile.hasApiKey ? 'کلید ذخیره‌شده ✓' : 'کلید وارد نشده');
    };
    syncReadyChip();
    orderMeta.append(priorityBadge, readyChip);

    const orderActions = document.createElement('div');
    orderActions.className = 'ai-profile-order-actions';
    const moveTopBtn = document.createElement('button');
    moveTopBtn.type = 'button';
    moveTopBtn.className = 'bt ai-profile-top';
    moveTopBtn.textContent = '⇈ اولویت اول';
    moveTopBtn.title = 'قرار دادن مستقیم این کلید در اولویت ۱ (کلید اصلی)';
    moveTopBtn.setAttribute('aria-label', `انتقال API ${index + 1} به اولویت اول`);
    moveTopBtn.disabled = index === 0;
    moveTopBtn.addEventListener('click', () => {
      moveAiProfile(index, 0, '.ai-profile-down');
    });

    const moveUpBtn = document.createElement('button');
    moveUpBtn.type = 'button';
    moveUpBtn.className = 'bt ai-profile-up';
    moveUpBtn.textContent = '↑ بالاتر';
    moveUpBtn.title = 'افزایش اولویت استفاده از این کلید';
    moveUpBtn.setAttribute('aria-label', `افزایش اولویت API ${index + 1}`);
    moveUpBtn.disabled = index === 0;
    moveUpBtn.addEventListener('click', () => {
      moveAiProfile(index, index - 1, index - 1 === 0 ? '.ai-profile-down' : '.ai-profile-up');
    });

    const moveDownBtn = document.createElement('button');
    moveDownBtn.type = 'button';
    moveDownBtn.className = 'bt ai-profile-down';
    moveDownBtn.textContent = '↓ پایین‌تر';
    moveDownBtn.title = 'کاهش اولویت استفاده از این کلید';
    moveDownBtn.setAttribute('aria-label', `کاهش اولویت API ${index + 1}`);
    moveDownBtn.disabled = index >= total - 1;
    moveDownBtn.addEventListener('click', () => {
      moveAiProfile(index, index + 1, index + 1 >= total - 1 ? '.ai-profile-up' : '.ai-profile-down');
    });

    orderActions.append(moveTopBtn, moveUpBtn, moveDownBtn);
    orderBar.append(orderMeta, orderActions);

    const name = document.createElement('input');
    name.type = 'text'; name.className = 'ai-profile-name'; name.value = profile.name;
    name.placeholder = `API ${index + 1}`; name.setAttribute('aria-label', `نام دلخواه API ${index + 1}`);
    name.addEventListener('input', () => { profile.name = name.value; });
    const key = document.createElement('input');
    key.type = 'password'; key.className = 'ai-profile-key'; key.dir = 'ltr';
    key.autocomplete = 'off'; key.spellcheck = false; key.value = profile.apiKey;
    key.placeholder = profile.hasApiKey ? 'کلید ذخیره شده؛ برای تغییر، کلید تازه بدهید' : 'کلید API';
    key.setAttribute('aria-label', `کلید API ${index + 1}`);
    key.addEventListener('input', () => { profile.apiKey = key.value; syncReadyChip(); $('aiStatus').textContent = ''; });
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
    status.textContent = profile._lastStatus || '';
    test.addEventListener('click', async () => {
      const provider = aiEditorProvider;
      const profileId = profile.id;
      const model = $('aiModel').value.trim();
      const baseUrl = $('aiBaseUrl').value.trim();
      if (!profile.apiKey.trim() && !profile.hasApiKey) {
        profile._lastStatus = 'ابتدا کلید API را وارد کنید.';
        status.textContent = profile._lastStatus; key.focus(); return;
      }
      test.disabled = true; test.textContent = '…'; status.textContent = 'در حال بررسی…'; $('copyAiError').classList.add('hidden'); setProgress('aiProgress', null, true);
      try {
        await saveAiSettings({ quiet: true });
        setProgress('aiProgress', 0.5, true);
        const result = await api('/api/ai-settings/test', jsonOptions('POST', {
          provider, profile_id: profileId, model, base_url: baseUrl,
        }));
        setProgress('aiProgress', 1, false);
        $('aiStatus').textContent = result.message;
        const currentObj = aiEditorProfiles.find((item) => item.id === profileId);
        if (currentObj) currentObj._lastStatus = 'اتصال برقرار است ✓';
        const currentRow = [...container.querySelectorAll('.ai-profile-row')].find((item) => item.dataset.profileId === profileId);
        if (currentRow) currentRow.querySelector('.ai-profile-status').textContent = 'اتصال برقرار است ✓';
      } catch (error) {
        setProgress('aiProgress', 0, false);
        $('aiStatus').textContent = error.message; $('copyAiError').classList.remove('hidden');
        const currentObj = aiEditorProfiles.find((item) => item.id === profileId);
        if (currentObj) currentObj._lastStatus = error.message;
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
    row.append(orderBar, name, key, test, remove, options, status); container.appendChild(row);
  });
}
const LOCAL_NMT_FALLBACK_MODELS = [
  {
    id: 'nllb-600m',
    label: 'NLLB-200 سبک و سریع (600M · ~630 MB)',
    shortLabel: 'NLLB-200 (600M)',
    description: 'پیشنهادی برای همهٔ لپ‌تاپ‌ها و سیستم‌های معمولی روی پردازنده (CPU) بدون نیاز به کارت گرافیک؛ سریع و مناسب ترجمهٔ تک‌جمله و صفحه‌های کامل.',
    approxSize: '~630 MB',
    ramHint: '~750 MB',
    ready: false,
    filesPresent: false,
    diskBytes: 0,
    diskSizeLabel: '',
  },
  {
    id: 'nllb-1.3b',
    label: 'NLLB-200 دقیق‌تر (1.3B · ~1.35 GB)',
    shortLabel: 'NLLB-200 (1.3B)',
    description: 'جمله‌بندی دقیق‌تر برای جملات طولانی‌تر؛ قابل اجرا روی پردازنده (CPU) با حدود ۱.۶ گیگابایت رم آزاد در زمان ترجمه.',
    approxSize: '~1.35 GB',
    ramHint: '~1.6 GB',
    ready: false,
    filesPresent: false,
    diskBytes: 0,
    diskSizeLabel: '',
  },
];
let localNmtBusyModel = null;
let localNmtAbortController = null;
let localNmtPollTimer = null;

function currentLocalNmtStatus() {
  const st = state.ai?.local_nmt_status;
  const selectedModel = $('localNmtModelSelect')?.value || state.ai?.local_nmt?.model || 'nllb-600m';
  const rawModels = Array.isArray(st?.models) && st.models.length ? st.models : LOCAL_NMT_FALLBACK_MODELS;
  return {
    runtimeInstalled: !!st?.runtimeInstalled,
    loadedModel: st?.loadedModel || null,
    busyModel: localNmtBusyModel || st?.busyModel || null,
    busyStage: st?.busyStage || '',
    busyProgress: Number(st?.busyProgress || 0),
    models: rawModels.map((m) => ({
      ...m,
      selected: m.id === selectedModel,
      loaded: m.id === (st?.loadedModel || null),
    })),
  };
}

function updateLocalNmtProgressUi(visible, label = '', progress = 0) {
  const wrap = $('localNmtProgressWrap');
  if (!wrap) return;
  wrap.classList.toggle('hidden', !visible);
  if (!visible) {
    setProgress('localNmtProgressFill', 0, false);
    if ($('localNmtProgressPercent')) $('localNmtProgressPercent').textContent = '0%';
    return;
  }
  const clamped = Math.max(0, Math.min(1, Number(progress) || 0));
  if ($('localNmtProgressLabel') && label) $('localNmtProgressLabel').textContent = label;
  if ($('localNmtProgressPercent')) $('localNmtProgressPercent').textContent = `${Math.round(clamped * 100)}%`;
  setProgress('localNmtProgressFill', clamped > 0 ? clamped : null, clamped <= 0);
}

function renderLocalNmtPanel() {
  const cardsEl = $('localNmtCards');
  if (!cardsEl) return;
  const info = currentLocalNmtStatus();
  const busy = Boolean(info.busyModel);
  if ($('localNmtUnloadBtn')) {
    $('localNmtUnloadBtn').disabled = busy;
    $('localNmtUnloadBtn').textContent = info.loadedModel ? 'آزادسازی فوری از رم (در رم فعال)' : 'آزادسازی فوری از رم';
  }
  if ($('localNmtTestBtn')) $('localNmtTestBtn').disabled = busy;
  cardsEl.textContent = '';
  info.models.forEach((model) => {
    const card = document.createElement('div');
    card.className = `local-nmt-card${model.selected ? ' is-selected' : ''}`;
    card.dataset.modelId = model.id;

    const head = document.createElement('div');
    head.className = 'local-nmt-card-head';
    const title = document.createElement('strong');
    title.className = 'local-nmt-card-title';
    title.textContent = model.label;
    const badge = document.createElement('span');
    badge.className = `exec-badge ${model.ready ? 'is-local' : 'is-online'}`;
    badge.textContent = model.ready
      ? (model.loaded ? '✓ آماده · فعال در رم' : '✓ نصب‌شده (آمادهٔ کار آفلاین)')
      : `⬇ نصب‌نشده (${model.approxSize})`;
    head.append(title, badge);

    const desc = document.createElement('p');
    desc.className = 'local-nmt-card-desc';
    desc.textContent = model.description;

    const meta = document.createElement('div');
    meta.className = 'local-nmt-card-meta';
    meta.textContent = [
      `حجم دانلود: ${model.approxSize}`,
      model.ramHint ? `رم مصرفی حین کار: ${model.ramHint}` : '',
      model.diskSizeLabel ? `حجم فعلی روی دیسک: ${model.diskSizeLabel}` : '',
    ].filter(Boolean).join(' · ');

    const actions = document.createElement('div');
    actions.className = 'local-nmt-card-actions';

    if (!model.ready) {
      const dlBtn = document.createElement('button');
      dlBtn.type = 'button';
      dlBtn.className = 'bt primary local-nmt-download-btn';
      dlBtn.disabled = busy;
      dlBtn.textContent = info.busyModel === model.id ? 'در حال دانلود…' : 'دانلود و نصب خودکار';
      dlBtn.addEventListener('click', () => { prepareLocalNmtModel(model.id).catch(() => {}); });
      actions.appendChild(dlBtn);
    } else {
      const pickBtn = document.createElement('button');
      pickBtn.type = 'button';
      pickBtn.className = `bt ${model.selected ? 'primary' : ''} local-nmt-select-btn`.trim();
      pickBtn.disabled = busy || model.selected;
      pickBtn.textContent = model.selected ? '✓ مدل آفلاین فعال' : 'انتخاب این مدل';
      pickBtn.addEventListener('click', () => {
        if ($('localNmtModelSelect')) $('localNmtModelSelect').value = model.id;
        renderLocalNmtPanel();
      });
      actions.appendChild(pickBtn);
    }

    if (model.filesPresent || model.diskBytes > 0) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'bt danger local-nmt-delete-btn';
      delBtn.disabled = busy;
      delBtn.textContent = 'حذف مدل از دیسک';
      delBtn.addEventListener('click', () => { deleteLocalNmtModel(model.id, model.shortLabel || model.label).catch(() => {}); });
      actions.appendChild(delBtn);
    }

    card.append(head, desc, meta, actions);
    cardsEl.appendChild(card);
  });
}

async function refreshLocalNmtStatusSilently() {
  try {
    const status = await api('/api/local-nmt/status');
    if (state.ai && status && typeof status === 'object') {
      state.ai.local_nmt_status = status;
    }
    renderLocalNmtPanel();
    return status;
  } catch {
    return null;
  }
}

async function prepareLocalNmtModel(modelId) {
  if (localNmtBusyModel) return;
  localNmtBusyModel = modelId;
  if ($('localNmtModelSelect')) $('localNmtModelSelect').value = modelId;
  $('aiStatus').textContent = 'آماده‌سازی و دانلود مدل آفلاین آغاز شد…';
  $('copyAiError').classList.add('hidden');
  updateLocalNmtProgressUi(true, 'در حال بررسی پیش‌نیازها و اتصال…', 0.02);
  renderLocalNmtPanel();

  const controller = new AbortController();
  localNmtAbortController = controller;
  localNmtPollTimer = setInterval(() => {
    refreshLocalNmtStatusSilently().then((st) => {
      if (st && st.busyModel) {
        updateLocalNmtProgressUi(true, st.busyStage || 'در حال دانلود مدل آفلاین…', st.busyProgress || 0.05);
      }
    }).catch(() => {});
    pollActivity().catch(() => {});
  }, 400);

  try {
    const res = await api('/api/local-nmt/prepare', {
      ...jsonOptions('POST', { model: modelId }),
      signal: controller.signal,
    });
    if (state.ai && res?.status) state.ai.local_nmt_status = res.status;
    updateLocalNmtProgressUi(true, 'مدل آفلاین آماده شد ✓', 1);
    $('aiStatus').textContent = 'مدل مترجم آفلاین با موفقیت دانلود و آماده شد؛ از این پس ۱۰۰٪ بدون اینترنت کار می‌کند.';
    toast('مدل مترجم آفلاین آمادهٔ استفاده است');
  } catch (error) {
    const cancelled = error?.name === 'AbortError' || String(error?.message || '').includes('لغو');
    $('aiStatus').textContent = cancelled
      ? 'دانلود مترجم آفلاین به درخواست شما لغو شد.'
      : (error.message || String(error));
    if (!cancelled) {
      $('copyAiError').classList.remove('hidden');
      toast(error.message || 'دانلود مدل آفلاین ناموفق بود', true);
    }
  } finally {
    if (localNmtPollTimer) { clearInterval(localNmtPollTimer); localNmtPollTimer = null; }
    if (localNmtAbortController === controller) localNmtAbortController = null;
    localNmtBusyModel = null;
    dismissJobCancelModal('local-nmt');
    updateLocalNmtProgressUi(false);
    await refreshLocalNmtStatusSilently();
    pollActivity().catch(() => {});
  }
}

let localNmtTestAbortController = null;

async function cancelLocalNmtPrepare() {
  if (localNmtAbortController) {
    try { localNmtAbortController.abort(); } catch { /* ignore */ }
  }
  notifyServerJobCancel('model');
  try { await api('/api/local-nmt/cancel', jsonOptions('POST', {})); } catch { /* ignore */ }
}

async function deleteLocalNmtModel(modelId, label) {
  const ok = await appConfirm(`آیا مطمئن هستید که می‌خواهید فایل‌های مدل آفلاین «${label}» به‌طور کامل از روی دیسک پاک شوند؟`, {
    title: 'حذف مدل مترجم آفلاین از دیسک',
    confirmText: 'بله، حذف شود',
    cancelText: 'انصراف',
    variant: 'danger',
    destructive: true,
  });
  if (!ok) return;
  $('aiStatus').textContent = 'در حال آزادسازی از رم و حذف فایل‌های مدل از دیسک…';
  try {
    const res = await api('/api/local-nmt/delete', jsonOptions('POST', { model: modelId }));
    if (state.ai && res?.status) state.ai.local_nmt_status = res.status;
    renderLocalNmtPanel();
    const freedText = res?.freedBytes ? ` (${formatStorageBytesFa(res.freedBytes)} آزاد شد)` : '';
    $('aiStatus').textContent = `مدل «${label}» از دیسک حذف شد${freedText}.`;
    toast(`مدل آفلاین حذف شد${freedText}`);
  } catch (error) {
    $('aiStatus').textContent = error.message || String(error);
    $('copyAiError').classList.remove('hidden');
    toast(error.message || 'حذف مدل ناموفق بود', true);
  }
}

async function unloadLocalNmtRam() {
  try {
    const res = await api('/api/local-nmt/unload', jsonOptions('POST', {}));
    if (state.ai && res?.status) state.ai.local_nmt_status = res.status;
    renderLocalNmtPanel();
    $('aiStatus').textContent = 'مدل مترجم آفلاین از حافظهٔ رم آزاد شد.';
    toast('حافظهٔ رم مترجم آفلاین آزاد شد');
  } catch (error) {
    toast(error.message || 'آزادسازی رم ناموفق بود', true);
  }
}

async function testLocalNmtSample() {
  const modelId = $('localNmtModelSelect')?.value || state.ai?.local_nmt?.model || 'nllb-600m';
  const sampleText = ($('localNmtTestSample')?.value || '').trim();
  const targetLang = normalizeTargetLanguage($('aiTargetLanguage')?.value || activeTargetLanguage());
  const sourceLang = $('ocrLanguage')?.value || 'eng';
  const beamSize = Math.max(1, Math.min(4, Number($('localNmtBeamSize')?.value) || 2));
  const keepLoaded = Boolean($('localNmtKeepLoaded')?.checked);
  const btn = $('localNmtTestBtn');
  if (btn) btn.disabled = true;
  $('copyAiError').classList.add('hidden');
  $('aiStatus').textContent = 'در حال ترجمهٔ آفلاین جملهٔ نمونه روی پردازندهٔ سیستم…';
  setProgress('aiProgress', null, true);
  const testCtrl = new AbortController();
  localNmtTestAbortController = testCtrl;
  try {
    const res = await api('/api/local-nmt/test', {
      ...jsonOptions('POST', {
        model: modelId,
        source_language: sourceLang,
        target_language: targetLang,
        sample_text: sampleText,
        beam_size: beamSize,
        keep_loaded: keepLoaded,
      }),
      signal: testCtrl.signal,
    });
    setProgress('aiProgress', 1, false);
    $('aiStatus').textContent = res.message || `نمونهٔ ترجمه: ${res.translatedText}`;
    await refreshLocalNmtStatusSilently();
  } catch (error) {
    setProgress('aiProgress', 0, false);
    if (error?.cancelled || error?.name === 'AbortError' || testCtrl.signal.aborted) {
      $('aiStatus').textContent = 'تست ترجمهٔ آفلاین لغو شد.';
      return;
    }
    $('aiStatus').textContent = error.message || String(error);
    $('copyAiError').classList.remove('hidden');
    toast(error.message || 'تست ترجمهٔ آفلاین ناموفق بود', true);
  } finally {
    if (localNmtTestAbortController === testCtrl) localNmtTestAbortController = null;
    dismissJobCancelModal('local-nmt');
    if (btn) btn.disabled = Boolean(localNmtBusyModel);
  }
}

function showAiProvider(provider, capture = true) {
  if (capture && provider !== aiEditorProvider) captureAiProvider();
  aiEditorProvider = (provider === 'local' || AI_PROVIDER_IDS.includes(provider)) ? provider : 'free';
  $('aiProvider').value = aiEditorProvider;
  $('aiFields').classList.toggle('hidden', isDirectMtProvider(aiEditorProvider));
  $('freeFields').classList.toggle('hidden', aiEditorProvider !== 'free');
  $('localNmtFields')?.classList.toggle('hidden', aiEditorProvider !== 'local');
  if (aiEditorProvider === 'free') { syncAiExecUi(); $('aiStatus').textContent = ''; $('copyAiError').classList.add('hidden'); return; }
  if (aiEditorProvider === 'local') {
    syncAiExecUi();
    $('aiStatus').textContent = '';
    $('copyAiError').classList.add('hidden');
    renderLocalNmtPanel();
    refreshLocalNmtStatusSilently().catch(() => {});
    return;
  }
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
function localNmtSettingsPayload() {
  const model = $('localNmtModelSelect')?.value || state.ai?.local_nmt?.model || 'nllb-600m';
  const rawBeam = ($('localNmtBeamSize')?.value ?? '2').trim();
  const rawLimit = ($('localNmtSourceLimit')?.value ?? '4000').trim();
  const beam = Number(rawBeam);
  const limit = Number(rawLimit);
  if (!/^\d+$/.test(rawBeam) || !Number.isSafeInteger(beam) || beam < 1 || beam > 4) {
    throw new Error('دقت جست‌وجوی مترجم آفلاین (Beam) باید عدد صحیح بین ۱ تا ۴ باشد.');
  }
  if (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 200 || limit > 20000) {
    throw new Error('سقف نویسهٔ مترجم آفلاین باید عدد صحیح بین ۲۰۰ تا ۲۰۰۰۰ باشد.');
  }
  return {
    model,
    beam_size: beam,
    source_limit: limit,
    keep_loaded: Boolean($('localNmtKeepLoaded')?.checked),
  };
}
async function loadAiSettings(prefetched = null) {
  state.ai = (prefetched && typeof prefetched === 'object') ? prefetched : await api('/api/ai-settings');
  aiEditorDrafts.clear();
  renderFreeServices();
  const localCfg = state.ai.local_nmt || {};
  if ($('localNmtModelSelect')) $('localNmtModelSelect').value = localCfg.model || 'nllb-600m';
  if ($('localNmtBeamSize')) $('localNmtBeamSize').value = localCfg.beam_size ?? 2;
  if ($('localNmtSourceLimit')) $('localNmtSourceLimit').value = localCfg.source_limit ?? 4000;
  if ($('localNmtKeepLoaded')) $('localNmtKeepLoaded').checked = Boolean(localCfg.keep_loaded);
  renderLocalNmtPanel();
  $('aiReuseRepeated').checked = state.ai.reuse_repeated !== false;
  $('aiContextPercent').value = state.ai.context_percent ?? 15;
  $('aiSkillPercent').value = state.ai.skill_percent ?? 15;
  const defaultTargetLang = normalizeTargetLanguage(state.ai.target_language || 'fa');
  if ($('aiTargetLanguage')) $('aiTargetLanguage').value = defaultTargetLang;
  if ($('translationTargetLang') && !state.project?.settings?.targetLanguage) {
    $('translationTargetLang').value = defaultTargetLang;
  }
  showAiProvider(state.ai.provider || 'free', false);
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
  return {
    provider: aiEditorProvider,
    target_language: normalizeTargetLanguage($('aiTargetLanguage')?.value || state.ai?.target_language || 'fa'),
    free_services: freeSettingsPayload(),
    local_nmt: localNmtSettingsPayload(),
    reuse_repeated: $('aiReuseRepeated').checked,
    context_percent: contextPercent,
    skill_percent: skillPercent,
    model: active?.model || null,
    base_url: active?.base_url || null,
    providers,
  };
}
async function saveAiSettings(options = {}) {
  state.ai = await api('/api/ai-settings', jsonOptions('PUT', aiSettingsPayload()));
  lastSyncedAiProvider = state.ai.provider || 'free';
  preferredTranslationTarget = lastSyncedAiProvider;
  const savedTargetLang = normalizeTargetLanguage(state.ai.target_language || 'fa');
  if ($('aiTargetLanguage')) $('aiTargetLanguage').value = savedTargetLang;
  if ($('translationTargetLang')) $('translationTargetLang').value = savedTargetLang;
  if (state.project) {
    state.project.settings = state.project.settings || {};
    state.project.settings.targetLanguage = savedTargetLang;
    scheduleSave();
  }
  aiEditorDrafts.clear(); $('aiReuseRepeated').checked = state.ai.reuse_repeated !== false; showAiProvider(state.ai.provider || 'free', false);
  if (!options.quiet) toast('تنظیمات ترجمه ذخیره شد');
  return state.ai;
}

// ---------- Full-page translation editor ----------
function editorItem() { return state.project?.images.find((item) => item.id === state.editorId); }
function syncEditorApprovalHeader(item = editorItem()) {
  if (!item) return;
  $('editorTitle').textContent = `ویرایش — ${item.name}${item.approved ? ' (✓ تأییدشده)' : ''}`;
  $('editorUnapproveBtn')?.classList.toggle('hidden', !item.approved);
}
function readProjectImageDrafts(projectId, imageId) {
  const entries = [];
  if (!projectId || !imageId || typeof localStorage === 'undefined') return entries;
  const prefix = `comic-studio-draft:${encodeURIComponent(projectId)}:${encodeURIComponent(imageId)}:`;
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key && key.startsWith(prefix)) entries.push([key, localStorage.getItem(key)]);
  }
  return entries;
}
function restoreProjectImageDrafts(projectId, imageId, entries) {
  if (!projectId || !imageId || typeof localStorage === 'undefined') return;
  const prefix = `comic-studio-draft:${encodeURIComponent(projectId)}:${encodeURIComponent(imageId)}:`;
  const toRemove = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key && key.startsWith(prefix)) toRemove.push(key);
  }
  toRemove.forEach((key) => localStorage.removeItem(key));
  (entries || []).forEach(([key, value]) => {
    if (value !== null && value !== undefined) localStorage.setItem(key, value);
  });
}
function discardInlineEditorForCancel() {
  if (!inlineDraft) return;
  if (document.activeElement === $('inlineLineSize')) $('inlineLineSize').blur();
  classicEditor.clearDraft();
  classicEditor.closeModal?.({ restoreFocus: false });
  classicEditor.exitFullscreen();
  classicEditor.detachField();
  const box = [...document.querySelectorAll('#editorBoxes .editor-box')].find((el) => el.dataset.id === String(inlineDraft.block.id));
  box?.classList.remove('editing', 'show-output');
  inlineDraft = null; inlineEditSession = null;
  updateInlineSelectionHighlight();
  syncInlineDockIdleState();
  document.querySelector('.editor-preview').style.paddingTop = '';
}
function boxOf(block) { return { x0: Number.isFinite(block.tx0) ? block.tx0 : block.x0, y0: Number.isFinite(block.ty0) ? block.ty0 : block.y0, x1: Number.isFinite(block.tx1) ? block.tx1 : block.x1, y1: Number.isFinite(block.ty1) ? block.ty1 : block.y1 }; }
async function openEditor(imageId) {
  if (!isModuleLicensed('editing')) { await ensureModuleLicensed('editing'); return; }
  const loadSeq = ++editorLoadSeq;
  await ensureFont();
  if (loadSeq !== editorLoadSeq) return;
  const item = state.project?.images.find((entry) => entry.id === imageId);
  if (!item) return;
  if (inlineDraft) closeInlineEditor(true); else syncInlineDockIdleState();
  if (!$('editorDialog')?.open) {
    editorReturnScroll = captureEditorReturnScroll(imageId);
  } else if (editorReturnScroll) {
    editorReturnScroll.imageId = String(imageId);
  }
  state.editorId = imageId; state.activeBlockId = null; state.selectedBlockIds = []; state.editorPan = null;
  editorSessionSnapshot = {
    projectId: state.project.id,
    imageId: item.id,
    blocksJson: JSON.stringify(item.blocks || []),
    watermarkJson: JSON.stringify(item.watermark || null),
    approved: !!item.approved,
    edited: !!item.edited,
    overlayMode: currentOverlayMode(),
    draftEntries: readProjectImageDrafts(state.project.id, item.id),
    serverPreviewTouched: false,
    autoSaved: false,
  };
  await ensureWatermarkLogosReady(item.watermark);
  if (loadSeq !== editorLoadSeq) return;
  $('editorStage').classList.remove('panning'); syncEditorApprovalHeader(item); syncEditorClipboardButtons(); $('blockList').textContent = ''; showDialog('editorDialog');
  let bitmap;
  try {
    const response = await fetch(imageUrl(item));
    if (response.ok === false) throw new Error('تصویر اصلی باز نشد');
    bitmap = await decodeProjectImageBitmap(await response.blob(), item);
  } catch (error) {
    if (loadSeq === editorLoadSeq && state.editorId === imageId) {
      state.editorId = null;
      editorSessionSnapshot = null;
      closeDialog('editorDialog');
    }
    throw error;
  }
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
function setButtonLabel(el, text) {
  if (!el) return;
  const label = el.querySelector('.btn-label');
  if (label) label.textContent = text;
  else el.textContent = text;
}
async function enterImageOverview() {
  if (imageOverview || !editorItem()) return;
  const preview = document.querySelector('.editor-preview'); const dialog = $('editorDialog');
  // Capture the draft before its field is hidden; the project itself remains untouched.
  imageOverview = { scale: state.editorScale, fitScaleBefore: state.editorFitScale,
    left: preview.scrollLeft, top: preview.scrollTop, draft: inlineDraft ? draftBlockForPreview() : null, native: false };
  dialog.classList.add('image-fullscreen'); setButtonLabel($('editorImageFullscreen'), 'خروج از تمام‌صفحه');
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
  setButtonLabel($('editorImageFullscreen'), 'تمام‌صفحه تصویر'); $('editorImageFullscreen').setAttribute('aria-pressed', 'false');
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
  const rendered = Typeset.render(state.editorBitmap, blocks, buildTypesetRenderOptions(item)); const canvas = $('editorCanvas'); const ctx = canvas.getContext('2d');
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
const EDITOR_FONT_OPTIONS = Object.freeze([
  ['vazirmatn', 'Vazirmatn'],
  ['tahoma', 'Tahoma'],
  ['segoe ui', 'Segoe UI'],
  ['arial', 'Arial'],
  ['times new roman', 'Times New Roman'],
  ['impact', 'Impact'],
  ['comic sans ms', 'Comic Sans MS'],
  ['courier new', 'Courier New'],
]);
function canonicalFontOption(raw) {
  const clean = String(raw || '').split(',')[0].trim().replace(/^['"]+|['"]+$/g, '').replace(/\s+/g, ' ').toLowerCase();
  const hit = EDITOR_FONT_OPTIONS.find(([key]) => key === clean);
  return hit ? hit[1] : 'Vazirmatn';
}
function resolveBlockFontStack(fontFamily) {
  if (typeof Typeset?.resolveFontStack === 'function') return Typeset.resolveFontStack(fontFamily);
  const opt = canonicalFontOption(fontFamily);
  if (opt === 'Vazirmatn') return 'Vazirmatn, Tahoma, sans-serif';
  return `${/\s/.test(opt) ? `"${opt}"` : opt}, Vazirmatn, Tahoma, sans-serif`;
}
const EDITOR_BOX_SHAPES_FALLBACK = [
  'rect', 'ellipse', 'pill', 'cloud', 'thought', 'speech',
  'star', 'burst', 'seal', 'diamond', 'hexagon', 'octagon', 'heart', 'banner',
];
function normalizeShapeKey(shape) {
  if (typeof Typeset?.normalizeBoxShape === 'function') return Typeset.normalizeBoxShape(shape);
  const s = String(shape || '').trim().toLowerCase();
  return EDITOR_BOX_SHAPES_FALLBACK.includes(s) ? s : 'rect';
}
function normalizeRadiusPct(value) {
  if (typeof Typeset?.normalizeCornerRadius === 'function') return Typeset.normalizeCornerRadius(value);
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.max(0, Math.min(100, Math.round(n))) : 0;
}
function normalizeAngleDeg(value) {
  if (typeof Typeset?.normalizeBoxAngle === 'function') return Typeset.normalizeBoxAngle(value);
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) < 0.05) return 0;
  let wrapped = ((n + 180) % 360 + 360) % 360 - 180;
  if (wrapped === -180 && n > 0) wrapped = 180;
  return Math.round(wrapped * 10) / 10;
}
function boxShapeInsets(bw, bh, block) {
  const sh = normalizeShapeKey(block?.shape);
  const cr = normalizeRadiusPct(block?.cornerRadius);
  if (typeof Typeset?.shapeInsets === 'function') return Typeset.shapeInsets(bw, bh, sh, cr);
  const baseX = Typeset?.boxInset ? Typeset.boxInset(bw) : Math.min(4, Math.max(0, bw * 0.02));
  const baseY = Typeset?.boxInset ? Typeset.boxInset(bh) : Math.min(4, Math.max(0, bh * 0.02));
  return { padX: baseX, padY: baseY, padTop: baseY, padBottom: baseY };
}
function shapeSvgPathForBox(w, h, shape, cornerRadius) {
  if (typeof Typeset?.shapeSvgPath === 'function') return Typeset.shapeSvgPath(w, h, shape, cornerRadius);
  const bw = Math.max(1, Number(w) || 1), bh = Math.max(1, Number(h) || 1);
  const sh = normalizeShapeKey(shape);
  if (sh === 'ellipse') return `M ${bw / 2} 0 A ${bw / 2} ${bh / 2} 0 1 1 ${bw / 2} ${bh} A ${bw / 2} ${bh / 2} 0 1 1 ${bw / 2} 0 Z`;
  if (sh === 'diamond') return `M ${bw / 2} 0 L ${bw} ${bh / 2} L ${bw / 2} ${bh} L 0 ${bh / 2} Z`;
  if (sh === 'hexagon') { const dx = bw * 0.18; return `M ${dx} 0 L ${bw - dx} 0 L ${bw} ${bh / 2} L ${bw - dx} ${bh} L ${dx} ${bh} L 0 ${bh / 2} Z`; }
  return `M 0 0 H ${bw} V ${bh} H 0 Z`;
}
function styleRichElement(element, block, scale = 1, preview = false) {
  const box = clampedBoxOf(block); const style = Typeset.blockStyle(block);
  element.dir = style.dir; element.style.direction = style.dir; element.style.textAlign = style.align;
  element.style.justifyContent = style.verticalAlign === 'top' ? 'flex-start' : style.verticalAlign === 'bottom' ? 'flex-end' : 'center';
  // The sidebar is an editing surface, not the output: output size and colour affect only the image.
  element.style.fontFamily = resolveBlockFontStack(block.fontFamily);
  element.style.fontSize = preview ? `${overlaySize(block, box.x1 - box.x0, box.y1 - box.y0) * scale}px` : '';
  element.style.fontWeight = style.bold ? '700' : '400'; element.style.fontStyle = style.italic ? 'italic' : 'normal';
  element.style.color = preview ? (style.color || (block.bg === 'white' ? '#0b0b0b' : '#fff')) : '';
  element.style.caretColor = preview ? (style.color || (block.bg === 'white' ? '#0b0b0b' : '#fff')) : '';
  element.style.textDecoration = [style.underline ? 'underline' : '', style.strike ? 'line-through' : ''].filter(Boolean).join(' ');
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
  field.style.fontFamily = resolveBlockFontStack(draft.fontFamily);
  field.style.fontSize = `${baseSize}px`;
  field.style.lineHeight = '1.55'; field.style.fontWeight = style.bold ? '700' : '400';
  field.style.fontStyle = style.italic ? 'italic' : 'normal';
  field.style.textDecoration = [style.underline ? 'underline' : '', style.strike ? 'line-through' : ''].filter(Boolean).join(' ');
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
  const shapePad = boxShapeInsets(bw, bh, draft);
  const insetX = shapePad.padX * layoutZoom;
  const ind = Typeset.indentGeometry ? Typeset.indentGeometry(style, insetX, baseSize * layoutZoom) : { textIndentPx: 0, padLeft: insetX, padRight: insetX };
  field.style.right = 'auto'; field.style.bottom = 'auto';
  field.style.width = `${bw * layoutZoom}px`;
  field.style.paddingLeft = `${ind.padLeft}px`; field.style.paddingRight = `${ind.padRight}px`;
  field.style.textIndent = `${ind.textIndentPx}px`;
  field.style.paddingTop = '0px'; field.style.paddingBottom = '0px';
  field.style.minHeight = '0px'; field.style.height = 'auto';
  field.style.transformOrigin = '0 0';
  field.style.transform = `scale(${scale / layoutZoom})`;
  const rawScrollH = field.scrollHeight;
  const contentH = (rawScrollH > 0 ? rawScrollH : baseSize * layoutZoom * 1.55) / layoutZoom;
  const padTop = Number.isFinite(shapePad.padTop) ? shapePad.padTop : shapePad.padY;
  const padBottom = Number.isFinite(shapePad.padBottom) ? shapePad.padBottom : shapePad.padY;
  const topUnscaled = style.verticalAlign === 'top'
    ? padTop
    : style.verticalAlign === 'bottom'
      ? bh - padBottom - contentH
      : padTop + (bh - padTop - padBottom - contentH) / 2;
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
const editorPageHistory = new Map();
function recordEditorPageHistory() {
  const item = editorItem();
  if (!item) return;
  const key = String(item.id);
  let stateEntry = editorPageHistory.get(key);
  if (!stateEntry) {
    stateEntry = { stack: [], index: -1 };
    editorPageHistory.set(key, stateEntry);
  }
  const snap = JSON.stringify({ blocks: item.blocks || [], selected: state.selectedBlockIds || [], active: state.activeBlockId || null });
  if (stateEntry.index >= 0 && stateEntry.stack[stateEntry.index] === snap) return;
  stateEntry.stack.splice(stateEntry.index + 1);
  stateEntry.stack.push(snap);
  if (stateEntry.stack.length > 40) stateEntry.stack.shift();
  stateEntry.index = stateEntry.stack.length - 1;
}
function pushPostActionEditorPageHistory() {
  recordEditorPageHistory();
}
function restoreEditorPageHistory(step) {
  const item = editorItem();
  if (!item) return;
  const key = String(item.id);
  const stateEntry = editorPageHistory.get(key);
  if (!stateEntry || !stateEntry.stack.length) return;
  const currentSnap = JSON.stringify({ blocks: item.blocks || [], selected: state.selectedBlockIds || [], active: state.activeBlockId || null });
  if (stateEntry.stack[stateEntry.index] !== currentSnap) {
    stateEntry.stack.splice(stateEntry.index + 1);
    stateEntry.stack.push(currentSnap);
    stateEntry.index = stateEntry.stack.length - 1;
  }
  const nextIndex = stateEntry.index + step;
  if (nextIndex < 0 || nextIndex >= stateEntry.stack.length) return;
  stateEntry.index = nextIndex;
  try {
    const parsed = JSON.parse(stateEntry.stack[nextIndex]);
    item.blocks = parsed.blocks || [];
    state.selectedBlockIds = parsed.selected || [];
    state.activeBlockId = parsed.active || null;
    syncEditorShapeControls();
    syncVerticalAlignButtons();
    buildBlockList();
    drawEditor();
    scheduleSave();
  } catch {}
}
function resolveToolbarTargetBlocks({ autoSelectFirst = true } = {}) {
  if (inlineDraft?.block) return [inlineDraft.block];
  const selected = selectedEditorBlocks();
  if (selected.length) return selected;
  if (!autoSelectFirst) return [];
  const item = editorItem();
  const blocks = item?.blocks || [];
  if (!blocks.length) return [];
  const activeMatch = state.activeBlockId != null
    ? blocks.find((b) => String(b.id) === String(state.activeBlockId) && b.enabled !== false)
    : null;
  const chosen = activeMatch || blocks.find((b) => b.enabled !== false) || blocks[0];
  if (!chosen) return [];
  selectEditorBlock(chosen.id, true);
  return [chosen];
}
function ensureInlineTargetSession() {
  if (inlineDraft) return true;
  const targets = resolveToolbarTargetBlocks({ autoSelectFirst: true });
  if (!targets.length) {
    toast('ابتدا یک کادر متنی در صفحه ایجاد یا انتخاب کنید.', true);
    return false;
  }
  openInlineEditor(targets[0]);
  return Boolean(inlineDraft);
}
function syncVerticalAlignButtons() {
  const dock = $('inlineEditor');
  const buttons = document.querySelectorAll('.inline-valign-btn');
  if (!buttons.length) return;
  const selected = selectedEditorBlocks();
  const multiSelected = selected.length > 1 || (selected.length === 1 && (!inlineDraft || selected[0] !== inlineDraft.block));
  let activeValue = null;
  const hasContext = selected.length > 0 || !!inlineDraft;
  if (inlineDraft && !multiSelected) {
    activeValue = ['top', 'bottom'].includes($('inlineVerticalAlign')?.value) ? $('inlineVerticalAlign').value : 'middle';
    dock?.classList.remove('has-selection');
  } else {
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
    btn.disabled = false;
    btn.setAttribute('aria-pressed', String(hasContext && btn.dataset.valign === activeValue));
  });
}
function setVerticalPlacement(value) {
  if (!['top', 'middle', 'bottom'].includes(value)) return;
  const selected = inlineDraft ? selectedEditorBlocks() : resolveToolbarTargetBlocks({ autoSelectFirst: true });
  if (!inlineDraft && selected.length) recordEditorPageHistory();
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
  pushPostActionEditorPageHistory();
}
function syncEditorShapeControls() {
  const selected = selectedEditorBlocks();
  const target = inlineDraft?.block || selected[0] || null;
  const hasTarget = Boolean(target);
  ['editorBoxShape', 'editorBoxRadius', 'editorBoxAngle', 'editorRotateReset', 'editorBoxBg', 'editorBoxBgColor', 'editorTranslateBlock'].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = false;
  });
  const fontSel = $('inlineFontFamily');
  const sizeInp = $('inlineLineSize');
  const sizeUp = $('inlineSizeUp');
  const sizeDown = $('inlineSizeDown');
  if (!inlineDraft) {
    if (fontSel) {
      fontSel.disabled = false;
      fontSel.value = hasTarget ? canonicalFontOption(target.fontFamily) : 'Vazirmatn';
    }
    if (sizeInp) {
      sizeInp.disabled = false;
      if (document.activeElement !== sizeInp) {
        sizeInp.value = hasTarget && Number(target.size) > 0 ? String(Math.round(Number(target.size))) : '';
      }
    }
    if (sizeUp) sizeUp.disabled = false;
    if (sizeDown) sizeDown.disabled = false;
  }
  if (!hasTarget) {
    if ($('editorBoxShape')) $('editorBoxShape').value = 'rect';
    if ($('editorBoxRadius') && document.activeElement !== $('editorBoxRadius')) $('editorBoxRadius').value = '0';
    if ($('editorBoxAngle') && document.activeElement !== $('editorBoxAngle')) $('editorBoxAngle').value = '0';
    if ($('editorBoxBg')) $('editorBoxBg').value = 'auto';
    $('editorBoxBgColor')?.classList.add('hidden');
    $('editorBoxRadiusWrap')?.classList.remove('hidden');
    return;
  }
  const shape = normalizeShapeKey(target.shape);
  const radius = normalizeRadiusPct(target.cornerRadius);
  const angle = normalizeAngleDeg(target.angle);
  const bgRaw = String(target.bg || 'auto');
  const isCustomBg = /^#[0-9a-fA-F]{6}$/.test(bgRaw);
  if ($('editorBoxShape')) $('editorBoxShape').value = shape;
  if ($('editorBoxRadiusWrap')) $('editorBoxRadiusWrap').classList.toggle('hidden', shape !== 'rect');
  if ($('editorBoxRadius') && document.activeElement !== $('editorBoxRadius')) $('editorBoxRadius').value = String(radius);
  if ($('editorBoxAngle') && document.activeElement !== $('editorBoxAngle')) $('editorBoxAngle').value = String(angle);
  if ($('editorBoxBg')) $('editorBoxBg').value = isCustomBg ? 'custom' : (['auto', 'white', 'black', 'none'].includes(bgRaw) ? bgRaw : 'auto');
  const bgColorEl = $('editorBoxBgColor');
  if (bgColorEl) {
    bgColorEl.classList.toggle('hidden', !isCustomBg);
    if (isCustomBg) bgColorEl.value = bgRaw.toLowerCase();
  }
}
function setInlineDockDisabled() {
  // Editing capabilities remain enabled at all times across idle, selected, merged, copied, and OCR/translation states.
  ['inlinePreview', 'inlineEditorApply', 'inlineVerticalAlign', 'inlineFontFamily', 'inlineLineSize', 'inlineSizeUp', 'inlineSizeDown', 'inlineLineReset',
    'inlineEditorDirection', 'inlineEditorAlign', 'inlineEditorSize', 'inlineEditorFont', 'inlineEditorColor', 'inlineEditorAutoColor']
    .forEach((id) => { const el = $(id); if (el) el.disabled = false; });
  document.querySelectorAll('#inlineEditor .classic-toolbar button, #inlineEditor .classic-toolbar select, #inlineEditor .classic-toolbar input, #inlineEditor .classic-tabs button')
    .forEach((el) => { el.disabled = false; });
  syncVerticalAlignButtons();
  syncEditorShapeControls();
}
function syncInlineDockIdleState() {
  const dock = $('inlineEditor');
  if (!dock) return;
  classicEditor?.setPlainMode(false);
  classicEditor?.resetToolbar?.();
  dock.classList.remove('hidden', 'show-output', 'plain-mode');
  dock.classList.add('is-idle');
  $('editorBoxes')?.classList.remove('preview-hide-boxes');
  dock.querySelector('.inline-box-settings')?.removeAttribute('open');
  $('inlineEditorTitle').textContent = 'ویرایشگر متن آماده است · برای ویرایش، روی هر کادر متن در تصویر کلیک کنید';
  const badge = $('inlineTargetBadge');
  if (badge) { badge.textContent = ''; badge.classList.add('hidden'); badge.classList.remove('is-word'); }
  if ($('inlineLineSize')) $('inlineLineSize').value = '';
  if ($('inlineFontFamily')) $('inlineFontFamily').value = 'Vazirmatn';
  setButtonLabel($('inlinePreview'), 'پیش‌نمایش دقیق');
  $('inlinePreview').setAttribute('aria-pressed', 'false');
  $('inlineEditorCancel').classList.add('hidden');
  $('inlineLineTools').classList.remove('hidden');
  setInlineDockDisabled(false);
}
function setInlineOutputPreview(enabled) {
  if (!inlineDraft) {
    const layer = $('editorBoxes');
    const next = enabled !== undefined ? !!enabled : !layer?.classList.contains('preview-hide-boxes');
    layer?.classList.toggle('preview-hide-boxes', next);
    $('inlineEditor')?.classList.toggle('show-output', next);
    const button = $('inlinePreview');
    button?.setAttribute('aria-pressed', String(next));
    setButtonLabel(button, next ? 'ادامهٔ ویرایش' : 'پیش‌نمایش دقیق');
    drawEditorCanvas();
    return;
  }
  $('editorBoxes')?.classList.remove('preview-hide-boxes');
  inlineDraft.showOutput = !!enabled;
  $('inlineEditor').classList.toggle('show-output', inlineDraft.showOutput);
  const activeBox = [...document.querySelectorAll('#editorBoxes .editor-box')].find((el) => el.dataset.id === String(inlineDraft.block.id));
  activeBox?.classList.toggle('show-output', inlineDraft.showOutput);
  const button = $('inlinePreview'); button.setAttribute('aria-pressed', String(inlineDraft.showOutput));
  setButtonLabel(button, inlineDraft.showOutput ? 'ادامهٔ ویرایش' : 'پیش‌نمایش دقیق');
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
  return JSON.stringify([
    block.text || '', block.tr || '', block.richHtml || '', block.ocrRichHtml || '',
    block.dir || '', block.ocrDir || '', block.align || '',
    block.size ?? null, block.color || null, block.verticalAlign || '',
    block.fontFamily || '', block.bold !== false, !!block.italic, !!block.underline, !!block.strike,
  ]);
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
  return !!(inlineDraft && range && !range.collapsed && field.contains(range.startContainer) && field.contains(range.endContainer) && String(range.toString() || '').trim());
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
  const fontSelect = $('inlineFontFamily');
  const typingSize = document.activeElement === sizeInput;
  updateInlineSelectionHighlight();
  if (!inlineDraft) {
    if (badge) {
      badge.textContent = '';
      badge.classList.add('hidden');
      badge.classList.remove('is-word');
    }
    return;
  }
  const field = $('inlineEditorField');
  const fieldIsEmpty = !String(field?.textContent || '').trim() && !field?.querySelector?.('div,p');
  if (hasInlineWordSelection()) {
    const raw = inlineDraft.range.toString().trim().replace(/\s+/g, ' ');
    const snippet = Array.from(raw).length > 18 ? `${Array.from(raw).slice(0, 18).join('')}…` : raw;
    if (badge) { badge.textContent = `بخش انتخابی: «${snippet}»`; badge.classList.remove('hidden'); badge.classList.add('is-word'); }
    const span = inlineSelectionSpan(inlineDraft.range) || (inlineDraft.range.startContainer.nodeType === Node.ELEMENT_NODE ? inlineDraft.range.startContainer : inlineDraft.range.startContainer.parentElement);
    const sizeVal = inlineInheritedLogicalSize(span);
    if (!typingSize && sizeInput) sizeInput.value = sizeVal != null ? String(sizeVal) : '';
    if (fontSelect) {
      const spanFont = inlineInheritedStyle(span, 'fontFamily');
      fontSelect.value = canonicalFontOption(spanFont || $('inlineEditorFont')?.value || inlineDraft.block?.fontFamily);
    }
    const hex = normalizeHexColor(inlineInheritedStyle(span, 'color'));
    if (hex && classicEditor?.colorInput) classicEditor.colorInput.value = hex;
    return;
  }
  if (fieldIsEmpty) {
    if (badge) { badge.textContent = 'هدف: کل کادر'; badge.classList.remove('hidden', 'is-word'); }
    if (!typingSize && sizeInput) {
      sizeInput.value = inlineDraft.initialAutoSize && !inlineDraft.sizeTouched ? '' : $('inlineEditorSize').value;
    }
    if (fontSelect) fontSelect.value = canonicalFontOption($('inlineEditorFont')?.value || inlineDraft.block?.fontFamily);
    const boxHex = inlineDraft.color || effectiveInlineColor(inlineDraft.block);
    if (boxHex && classicEditor?.colorInput) classicEditor.colorInput.value = boxHex;
    return;
  }
  if (badge) { badge.textContent = 'هدف: خط فعلی'; badge.classList.remove('hidden', 'is-word'); }
  const line = inlineParagraphFrom(inlineDraft.range?.startContainer);
  const lineSize = logicalFontSizeOf(line);
  if (!typingSize && sizeInput) sizeInput.value = lineSize != null ? String(Math.round(lineSize)) : (inlineDraft.sizeTouched ? $('inlineEditorSize').value : '');
  if (fontSelect) {
    const lineFont = line?.style?.fontFamily || '';
    fontSelect.value = canonicalFontOption(lineFont || $('inlineEditorFont')?.value || inlineDraft.block?.fontFamily);
  }
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
function seedDefaultInlineCaret(field, atEnd = true) {
  if (!field || typeof document.createRange !== 'function') return null;
  const range = document.createRange();
  let targetNode = field;
  let targetOffset = atEnd ? field.childNodes.length : 0;
  if (typeof document.createTreeWalker === 'function') {
    const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
    let firstText = null;
    let lastText = null;
    let tn;
    while ((tn = walker.nextNode())) {
      if (!firstText) firstText = tn;
      lastText = tn;
    }
    const chosenText = atEnd ? lastText : firstText;
    if (chosenText) {
      targetNode = chosenText;
      targetOffset = atEnd ? (chosenText.nodeValue || '').length : 0;
    } else {
      const blocks = [...field.querySelectorAll('div,p,li,h1,h2,h3,h4,h5,h6,pre,blockquote')];
      const chosenBlock = atEnd ? blocks.at(-1) : blocks[0];
      if (chosenBlock) {
        targetNode = chosenBlock;
        targetOffset = atEnd ? chosenBlock.childNodes.length : 0;
      }
    }
  }
  try {
    range.setStart(targetNode, targetOffset);
    range.collapse(true);
  } catch {
    range.selectNodeContents(field);
    range.collapse(!atEnd);
  }
  const selection = window.getSelection?.();
  if (selection && document.activeElement === field) {
    try { selection.removeAllRanges(); selection.addRange(range); } catch {}
  }
  if (inlineDraft) {
    inlineDraft.range = range.cloneRange();
    classicEditor?.syncRange?.(inlineDraft.range);
  }
  return range;
}
function ensureValidInlineRange() {
  if (!inlineDraft) return null;
  const field = $('inlineEditorField');
  if (!field) return null;
  if (inlineDraft.range && field.contains(inlineDraft.range.startContainer) && field.contains(inlineDraft.range.endContainer)) {
    return inlineDraft.range;
  }
  const selection = window.getSelection?.();
  if (selection?.rangeCount && field.contains(selection.anchorNode) && field.contains(selection.focusNode)) {
    inlineDraft.range = selection.getRangeAt(0).cloneRange();
    classicEditor?.syncRange?.(inlineDraft.range);
    return inlineDraft.range;
  }
  return seedDefaultInlineCaret(field, true);
}
function wrapInlineRunInDiv(field, anchorNode, anchorOffset = 0) {
  if (!field) return null;
  const isBlockTag = (node) => node?.nodeType === Node.ELEMENT_NODE
    && ['DIV', 'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'TABLE'].includes(node.tagName);
  let topChild = null;
  if (!anchorNode || anchorNode === field) {
    const children = [...field.childNodes];
    if (!children.length) {
      const emptyDiv = document.createElement('div');
      emptyDiv.appendChild(document.createElement('br'));
      field.appendChild(emptyDiv);
      return emptyDiv;
    }
    const clampedIdx = Math.max(0, Math.min(children.length - 1, anchorOffset >= children.length ? children.length - 1 : anchorOffset));
    topChild = children[clampedIdx];
  } else {
    let cur = anchorNode;
    while (cur && cur.parentNode && cur.parentNode !== field) cur = cur.parentNode;
    if (cur && cur.parentNode === field) topChild = cur;
  }
  if (!topChild) {
    const fallbackDiv = document.createElement('div');
    while (field.firstChild) fallbackDiv.appendChild(field.firstChild);
    if (!fallbackDiv.childNodes.length) fallbackDiv.appendChild(document.createElement('br'));
    field.appendChild(fallbackDiv);
    return fallbackDiv;
  }
  if (isBlockTag(topChild)) {
    return inlineParagraphFrom(anchorNode) || topChild;
  }
  if (topChild.nodeName === 'BR') {
    const prev = topChild.previousSibling;
    if (prev && !isBlockTag(prev) && prev.nodeName !== 'BR') {
      topChild = prev;
    } else {
      const brDiv = document.createElement('div');
      brDiv.appendChild(document.createElement('br'));
      field.replaceChild(brDiv, topChild);
      return brDiv;
    }
  }
  let runStart = topChild;
  while (runStart.previousSibling && !isBlockTag(runStart.previousSibling) && runStart.previousSibling.nodeName !== 'BR') {
    runStart = runStart.previousSibling;
  }
  const runNodes = [];
  let cursorNode = runStart;
  while (cursorNode && !isBlockTag(cursorNode) && cursorNode.nodeName !== 'BR') {
    runNodes.push(cursorNode);
    cursorNode = cursorNode.nextSibling;
  }
  const trailingBr = cursorNode?.nodeName === 'BR' ? cursorNode : null;
  const leadingBr = runStart.previousSibling?.nodeName === 'BR' && isBlockTag(runStart.previousSibling.previousSibling)
    ? runStart.previousSibling
    : null;
  const wrapper = document.createElement('div');
  field.insertBefore(wrapper, runStart);
  runNodes.forEach((n) => wrapper.appendChild(n));
  if (trailingBr) trailingBr.remove();
  if (leadingBr) leadingBr.remove();
  if (!wrapper.childNodes.length) wrapper.appendChild(document.createElement('br'));
  return wrapper;
}
function ensureInlineParagraph(options = {}) {
  const { restoreFocus = true } = options;
  const field = $('inlineEditorField');
  const range = ensureValidInlineRange();
  if (!inlineDraft || !range || !field.contains(range.startContainer)) {
    toast('ابتدا داخل خط موردنظر کلیک کنید.', true); return null;
  }
  let existing = inlineParagraphFrom(range.startContainer);
  if (existing && !restoreFocus) return existing;
  const activeControl = !restoreFocus && document.activeElement && document.activeElement !== field
    ? { el: document.activeElement, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd }
    : null;
  field.focus({ preventScroll: true }); const selection = window.getSelection(); const cursor = range.cloneRange(); cursor.collapse(true);
  selection.removeAllRanges(); selection.addRange(cursor);
  let line = inlineParagraphFrom(selection.anchorNode);
  if (!line) {
    // Browser paragraph boundaries include existing BRs, so only the chosen logical line is wrapped.
    inlineDraft.muteHistory = true;
    try { document.execCommand('formatBlock', false, 'div'); } catch {} finally { inlineDraft.muteHistory = false; }
    line = inlineParagraphFrom(selection.anchorNode);
    // Chromium leaves the BR immediately before its new DIV, which otherwise
    // turns one legacy line break into two in innerText and saved translations.
    if (line?.previousSibling?.nodeName === 'BR') line.previousSibling.remove();
  }
  if (!line) {
    line = wrapInlineRunInDiv(field, cursor.startContainer, cursor.startOffset);
    if (line) {
      const nextCursor = document.createRange();
      nextCursor.selectNodeContents(line);
      nextCursor.collapse(false);
      selection.removeAllRanges();
      selection.addRange(nextCursor);
    }
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
function cleanBlockRichOverrides(block, { stripBold = false, stripItalic = false, stripUnderline = false, stripStrike = false, stripColor = false, stripAlign = false, stripDir = false, stripSize = false, stripFont = false } = {}) {
  ['richHtml', 'ocrRichHtml'].forEach((prop) => {
    const raw = String(block[prop] || '').trim();
    if (!raw) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = sanitizeHtml(raw);
    if (stripBold) [...tmp.querySelectorAll('b,strong')].reverse().forEach((el) => el.replaceWith(...el.childNodes));
    if (stripItalic) [...tmp.querySelectorAll('i,em')].reverse().forEach((el) => el.replaceWith(...el.childNodes));
    if (stripUnderline) [...tmp.querySelectorAll('u')].reverse().forEach((el) => el.replaceWith(...el.childNodes));
    if (stripStrike) [...tmp.querySelectorAll('s,strike,del')].reverse().forEach((el) => el.replaceWith(...el.childNodes));
    tmp.querySelectorAll('*').forEach((el) => {
      if (stripBold && el.style?.fontWeight) el.style.fontWeight = '';
      if (stripItalic && el.style?.fontStyle) el.style.fontStyle = '';
      if ((stripUnderline || stripStrike) && (el.style?.textDecoration || el.style?.textDecorationLine)) {
        const parts = new Set((el.style.textDecoration || el.style.textDecorationLine || '').split(/\s+/).filter((x) => x === 'underline' || x === 'line-through'));
        if (stripUnderline) parts.delete('underline');
        if (stripStrike) parts.delete('line-through');
        el.style.textDecoration = [...parts].join(' ');
      }
      if (stripColor && el.style?.color) el.style.color = '';
      if (stripAlign && el.style?.textAlign) el.style.textAlign = '';
      if (stripDir) { if (el.style?.direction) el.style.direction = ''; el.removeAttribute('dir'); }
      if (stripSize) { applyLogicalFontSize(el, ''); }
      if (stripFont && el.style?.fontFamily) el.style.fontFamily = '';
      if (el.getAttribute('style') != null && !el.getAttribute('style').trim()) el.removeAttribute('style');
    });
    [...tmp.querySelectorAll('span')].reverse().forEach((sp) => {
      if (!sp.attributes.length) sp.replaceWith(...sp.childNodes);
    });
    const plainSource = prop === 'ocrRichHtml' ? String(block.text || '') : String(block.tr || '');
    const cleaned = sanitizeHtml(tmp.innerHTML);
    block[prop] = hasMeaningfulRichHtml(cleaned, plainSource) ? cleaned : '';
  });
}
function hasMeaningfulRichHtml(htmlVal) {
  const s = String(htmlVal || '').trim();
  if (!s) return false;
  if (/(?: |&nbsp;|\u00a0){2,}/.test(s)) return true;
  if (/<(b|strong|i|em|u|s|strike|del|h[1-6]|ul|ol|li|blockquote|pre|table|tr|td|th|a|hr|img|span)\b/i.test(s)) return true;
  if (/\s(style|dir)=/i.test(s)) return true;
  return false;
}
function setInlineLineStyle(property, value, options = {}) {
  if (!inlineDraft) {
    const targets = resolveToolbarTargetBlocks({ autoSelectFirst: true });
    if (!targets.length) return;
    recordEditorPageHistory();
    targets.forEach((b) => {
      if (property === 'textAlign') {
        b.align = value;
        cleanBlockRichOverrides(b, { stripAlign: true });
      } else if (property === 'direction') {
        if (blockOverlayMode(b) === 'ocr') b.ocrDir = value;
        else b.dir = value;
        if (!b.align || b.align === (value === 'rtl' ? 'left' : 'right')) b.align = value === 'rtl' ? 'right' : 'left';
        cleanBlockRichOverrides(b, { stripDir: true });
      } else if (property === 'color') {
        b.color = value;
        cleanBlockRichOverrides(b, { stripColor: true });
      } else if (property === 'fontSize') {
        const parsed = Number.parseFloat(value || '');
        b.size = value && Number.isFinite(parsed) && parsed >= 8 ? Math.max(8, Math.min(160, Math.round(parsed))) : null;
        cleanBlockRichOverrides(b, { stripSize: true });
      }
    });
    if (property === 'textAlign' && $('inlineEditorAlign')) $('inlineEditorAlign').value = value;
    if (property === 'direction' && $('inlineEditorDirection')) $('inlineEditorDirection').value = value;
    if (property === 'color' && $('inlineEditorColor')) $('inlineEditorColor').value = value;
    syncEditorShapeControls();
    buildBlockList();
    drawEditor();
    scheduleSave();
    pushPostActionEditorPageHistory();
    return;
  }
  const field = $('inlineEditorField');
  const fullBoxSelected = hasInlineWordSelection()
    && inlineDraft.range.toString().trim() === field.textContent.trim()
    && field.textContent.trim().length > 0;
  if (inlineDraft && (fullBoxSelected || (!field.textContent && !field.querySelector('div,p')))) {
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
function isInlineFieldEmpty() {
  const field = $('inlineEditorField');
  return !String(field?.textContent || '').trim() && !field?.querySelector?.('div,p');
}
function setSelectionOrBlockFont(fontValue, options = {}) {
  const chosen = canonicalFontOption(fontValue);
  const storedValue = chosen === 'Vazirmatn' ? '' : chosen;
  if (!inlineDraft) {
    const selected = resolveToolbarTargetBlocks({ autoSelectFirst: true });
    if (!selected.length) return;
    recordEditorPageHistory();
    selected.forEach((b) => {
      b.fontFamily = storedValue || null;
      cleanBlockRichOverrides(b, { stripFont: true });
    });
    syncEditorShapeControls();
    buildBlockList();
    drawEditor();
    scheduleSave();
    pushPostActionEditorPageHistory();
    return;
  }
  if (hasInlineWordSelection()) {
    const field = $('inlineEditorField');
    const selTxt = (window.getSelection?.()?.toString?.() || inlineDraft?.range?.toString?.() || '').replace(/\s+/g, ' ').trim();
    const allTxt = (field?.textContent || '').replace(/\s+/g, ' ').trim();
    if (selTxt && selTxt === allTxt) {
      if ($('inlineEditorFont')) $('inlineEditorFont').value = storedValue;
      inlineDraft.fontFamily = storedValue || null;
    }
    applyInlineWordStyle({ fontFamily: storedValue ? (/\s/.test(chosen) ? `'${chosen}'` : chosen) : '' }, options);
    return;
  }
  if ($('inlineEditorFont')) $('inlineEditorFont').value = storedValue;
  inlineDraft.fontFamily = storedValue || null;
  if (!isInlineFieldEmpty()) {
    const field = $('inlineEditorField');
    field?.querySelectorAll?.('[style]').forEach((el) => { if (el.style?.fontFamily) el.style.fontFamily = ''; });
  }
  recordInlineHistory();
  syncInlineLineControls();
  refreshInlineTypography();
  classicEditor.notifyChange();
}
function setSelectionOrLineSize(value, options = {}) {
  if (!inlineDraft) {
    const selected = resolveToolbarTargetBlocks({ autoSelectFirst: true });
    if (!selected.length) return;
    recordEditorPageHistory();
    const parsed = Number.parseFloat(value || '');
    const nextSize = value && Number.isFinite(parsed) && parsed >= 8 ? Math.max(8, Math.min(160, Math.round(parsed))) : null;
    selected.forEach((b) => {
      b.size = nextSize;
      cleanBlockRichOverrides(b, { stripSize: true });
    });
    syncEditorShapeControls();
    buildBlockList();
    drawEditor();
    scheduleSave();
    pushPostActionEditorPageHistory();
    return;
  }
  if (isInlineFieldEmpty()) {
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
  if (!inlineDraft) {
    const selected = resolveToolbarTargetBlocks({ autoSelectFirst: true });
    if (!selected.length) return;
    const base = Number($('inlineLineSize')?.value) || effectiveInlineSize(selected[0]);
    const next = Math.max(8, Math.min(160, Math.round(base + delta)));
    if ($('inlineLineSize')) $('inlineLineSize').value = String(next);
    setSelectionOrLineSize(`${next}px`);
    return;
  }
  if (isInlineFieldEmpty()) {
    const cur = Number($('inlineEditorSize').value) || effectiveInlineSize(inlineDraft.block);
    const next = Math.max(8, Math.min(160, Math.round(cur + delta)));
    $('inlineLineSize').value = String(next);
    setSelectionOrLineSize(`${next}px`);
    return;
  }
  ensureValidInlineRange();
  const currentInput = Number($('inlineLineSize').value);
  const inherited = inlineInheritedLogicalSize(inlineSelectionSpan(inlineDraft.range) || inlineDraft.range?.startContainer);
  const base = Number.isFinite(currentInput) && currentInput >= 8 ? currentInput : (inherited ?? effectiveInlineSize(inlineDraft.block));
  const next = Math.max(8, Math.min(160, Math.round(base + delta)));
  $('inlineLineSize').value = String(next);
  setSelectionOrLineSize(`${next}px`);
}
function toggleInlineCommand(cmd) {
  if (!inlineDraft) {
    const targets = resolveToolbarTargetBlocks({ autoSelectFirst: true });
    if (!targets.length) return;
    recordEditorPageHistory();
    const firstStyle = Typeset.blockStyle(overlayBlock(targets[0]));
    if (cmd === 'bold') {
      const next = !(firstStyle.bold !== false);
      targets.forEach((b) => { b.bold = next; cleanBlockRichOverrides(b, { stripBold: true }); });
    } else if (cmd === 'italic') {
      const next = !firstStyle.italic;
      targets.forEach((b) => { b.italic = next; cleanBlockRichOverrides(b, { stripItalic: true }); });
    } else if (cmd === 'underline') {
      const next = !firstStyle.underline;
      targets.forEach((b) => { b.underline = next; cleanBlockRichOverrides(b, { stripUnderline: true }); });
    } else if (cmd === 'strikeThrough') {
      const next = !firstStyle.strike;
      targets.forEach((b) => { b.strike = next; cleanBlockRichOverrides(b, { stripStrike: true }); });
    }
    buildBlockList();
    drawEditor();
    scheduleSave();
    pushPostActionEditorPageHistory();
    return;
  }
  ensureValidInlineRange();
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
  if (isInlineFieldEmpty()) {
    if (cmd === 'bold') inlineDraft.bold = !inlineDraft.bold;
    else if (cmd === 'italic') inlineDraft.italic = !inlineDraft.italic;
    else if (cmd === 'underline') inlineDraft.underline = !inlineDraft.underline;
    else if (cmd === 'strikeThrough') inlineDraft.strike = !inlineDraft.strike;
    syncInlineLineControls(); refreshInlineTypography(); classicEditor.notifyChange();
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
function formatInlineBlockTag(tagName) {
  const cleanTag = String(tagName || 'p').toLowerCase();
  if (!['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre'].includes(cleanTag)) return false;
  if (!inlineDraft && !ensureInlineTargetSession()) return true;
  ensureValidInlineRange();
  const line = ensureInlineParagraph();
  if (!line) return true;
  if (line.tagName.toLowerCase() !== cleanTag) {
    const replacement = document.createElement(cleanTag);
    [...line.attributes].forEach((attr) => replacement.setAttribute(attr.name, attr.value));
    while (line.firstChild) replacement.appendChild(line.firstChild);
    line.replaceWith(replacement);
    const nextRange = document.createRange();
    nextRange.selectNodeContents(replacement);
    nextRange.collapse(false);
    const sel = window.getSelection?.();
    if (sel) { sel.removeAllRanges(); sel.addRange(nextRange); }
  }
  rememberInlineRange(); recordInlineHistory(); syncInlineLineControls(); refreshInlineTypography(); classicEditor.notifyChange();
  return true;
}
function resetInlineLineStyle() {
  if (!inlineDraft) {
    const targets = resolveToolbarTargetBlocks({ autoSelectFirst: true });
    if (!targets.length) return;
    recordEditorPageHistory();
    targets.forEach((b) => {
      b.richHtml = '';
      b.ocrRichHtml = '';
      b.size = null;
      b.color = null;
      b.fontFamily = null;
      b.italic = false;
      b.underline = false;
      b.strike = false;
    });
    syncEditorShapeControls();
    buildBlockList();
    drawEditor();
    scheduleSave();
    pushPostActionEditorPageHistory();
    return;
  }
  ensureValidInlineRange();
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
  if (isInlineFieldEmpty()) {
    inlineDraft.color = null;
    inlineDraft.fontFamily = null;
    inlineDraft.italic = false;
    inlineDraft.underline = false;
    inlineDraft.strike = false;
    inlineDraft.sizeTouched = false;
    inlineDraft.initialAutoSize = true;
    if ($('inlineEditorFont')) $('inlineEditorFont').value = '';
    $('inlineEditorSize').value = String(effectiveInlineSize({ ...inlineDraft.block, size: null }));
    $('inlineEditorColor').value = effectiveInlineColor({ ...inlineDraft.block, color: null });
    syncInlineLineControls(); refreshInlineTypography(); classicEditor.notifyChange();
    return;
  }
  const line = ensureInlineParagraph(); if (!line) return;
  delete line.dataset.logicalSize;
  ['textAlign', 'direction', 'fontSize', 'fontFamily', 'color', 'fontWeight', 'fontStyle', 'textDecoration'].forEach((key) => { line.style[key] = ''; });
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
  if (!event || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return false;
  const pt = inlineCaretPoint(field, event.clientX, event.clientY);
  if (!pt) return false;
  const range = document.createRange(); range.setStart(pt.node, pt.offset); range.collapse(true);
  const selection = window.getSelection?.();
  if (selection) { selection.removeAllRanges(); selection.addRange(range); }
  return true;
}
function openInlineEditor(block, clickEvent = null) {
  if (!block || !editorItem()) return;
  if (inlineDraft?.block === block && inlineDraft.mode === blockOverlayMode(block)) {
    classicEditor.focus();
    ensureValidInlineRange();
    return;
  }
  if (document.activeElement === $('inlineLineSize')) $('inlineLineSize').blur();
  if (!closeInlineEditor()) return;
  const mode = blockOverlayMode(block);
  if (mode === 'none') return;
  $('editorBoxes')?.classList.remove('preview-hide-boxes');
  selectEditorBlock(block.id, true);
  const box = [...document.querySelectorAll('#editorBoxes .editor-box')].find((entry) => entry.dataset.id === String(block.id));
  if (!box) { toast('ابتدا نمایش این کادر را فعال کنید.', true); return; }

  const field = $('inlineEditorField');
  const displayOut = overlayBlock(block);
  const direction = mode === 'ocr'
    ? ((block.ocrDir === 'rtl' || block.ocrDir === 'ltr') ? block.ocrDir : (displayOut.dir || 'ltr'))
    : (block.dir === 'ltr' ? 'ltr' : 'rtl');
  const hasMarks = mode !== 'ocr' && !block.richHtml && !!Typeset.hasInlineMarks?.(block.tr || '') && typeof Typeset.inlineMarksToHtml === 'function';
  const originalHtml = mode === 'ocr'
    ? (block.ocrRichHtml ? sanitizeHtml(block.ocrRichHtml) : plainToHtml(block.text || ''))
    : (block.richHtml || (hasMarks ? sanitizeHtml(Typeset.inlineMarksToHtml(block.tr || '')) : plainToHtml(block.tr || '')));
  const draftKey = `comic-studio-draft:${encodeURIComponent(state.project.id)}:${encodeURIComponent(editorItem().id)}:${encodeURIComponent(block.id)}:${mode}`;
  setInlineDockDisabled(false);
  classicEditor.setPlainMode(false);
  field.removeAttribute('style'); field.dir = direction; field.style.direction = direction;
  $('inlineEditorTitle').textContent = `کادر ${block.id} · ویرایش مستقیم ${mode === 'ocr' ? 'متن اصلی' : 'ترجمه'} · ذخیرهٔ خودکار`;
  $('inlineEditorCancel').classList.add('hidden');
  $('inlineLineTools').classList.remove('hidden');
  if ($('inlineLineSize')) $('inlineLineSize').value = '';
  ['inlineLineSize', 'inlineSizeUp', 'inlineSizeDown', 'inlineLineReset', 'inlineEditorDirection'].forEach((id) => { const el = $(id); if (el) el.disabled = false; });
  $('inlineEditorDirection').value = direction;
  $('inlineEditorAlign').value = mode === 'ocr' ? displayOut.align : (block.align || 'right');
  const verticalAlignTouched = ['top', 'middle', 'bottom'].includes(block.verticalAlign);
  $('inlineVerticalAlign').value = ['top', 'bottom'].includes(block.verticalAlign) ? block.verticalAlign : 'middle';
  const initialAutoSize = !(Number.isFinite(+block.size) && +block.size > 0);
  const initialSizeValue = String(effectiveInlineSize(block));
  $('inlineEditorSize').value = initialSizeValue;
  if ($('inlineEditorFont')) $('inlineEditorFont').value = block.fontFamily ? canonicalFontOption(block.fontFamily) : '';
  if ($('inlineFontFamily')) {
    $('inlineFontFamily').disabled = false;
    $('inlineFontFamily').value = canonicalFontOption(block.fontFamily);
  }
  $('inlineEditorColor').value = effectiveInlineColor(block);

  inlineDraft = { block, mode, snapshot: inlineBlockSnapshot(block), html: originalHtml,
    dir: $('inlineEditorDirection').value, align: $('inlineEditorAlign').value,
    verticalAlign: $('inlineVerticalAlign').value, verticalAlignTouched, size: initialSizeValue,
    initialAutoSize, initialSizeValue, sizeTouched: false,
    fontFamily: block.fontFamily || null,
    bold: block.bold !== false, italic: !!block.italic, underline: !!block.underline, strike: !!block.strike,
    color: block.color || null, originalColor: block.color || null,
    range: null, history: [], historyIndex: -1, muteHistory: false, conflictReported: false };
  const draftRestore = classicEditor.setContext(draftKey, originalHtml, inlineDraft.snapshot);
  if (draftRestore && typeof draftRestore.then === 'function') {
    draftRestore.then((restored) => {
      if (inlineDraft?.block !== block) return;
      if (restored) { ensureValidInlineRange(); recordInlineHistory(); syncInlineLineControls(); }
      classicEditor.focus();
    }).catch(() => {});
  }
  syncEditingBoxColors(box, block);
  box.classList.add('editing'); classicEditor.attachField(box);

  inlineEditSession = window.createInlineEditSession({
    block, mode, snapshot: inlineBlockSnapshot, getBaseline: () => inlineDraft?.snapshot,
    read: () => {
      const textVal = classicEditor.getText();
      const htmlVal = classicEditor.getHTML();
      const normNbsp = (s) => String(s || '').replace(/&nbsp;|\u00a0/g, ' ');
      const hasMultiSpace = /(?: |&nbsp;|\u00a0){2,}/.test(htmlVal);
      const plainEquiv = mode !== 'ocr' && !block.richHtml && !hasMarks && !hasMultiSpace && normNbsp(htmlVal) === normNbsp(sanitizeHtml(plainToHtml(textVal)));
      const ocrMeaningful = mode === 'ocr' && hasMeaningfulRichHtml(htmlVal);
      const rawSize = $('inlineEditorSize').value.trim();
      const keepAuto = !!(inlineDraft?.initialAutoSize && !inlineDraft?.sizeTouched && rawSize === inlineDraft?.initialSizeValue);
      const keepLegacyVertical = !inlineDraft?.verticalAlignTouched && !['top', 'middle', 'bottom'].includes(block.verticalAlign);
      const rawFont = ($('inlineEditorFont')?.value || '').trim();
      const storedFont = rawFont && rawFont !== 'Vazirmatn' ? rawFont : null;
      const curDir = $('inlineEditorDirection').value;
      return {
        text: textVal,
        richHtml: mode === 'ocr' ? (block.richHtml || '') : (plainEquiv ? '' : htmlVal),
        ocrRichHtml: mode === 'ocr' ? (ocrMeaningful ? htmlVal : '') : undefined,
        dir: mode === 'ocr' ? (block.dir || 'rtl') : curDir,
        ocrDir: mode === 'ocr' ? curDir : undefined,
        align: $('inlineEditorAlign').value,
        verticalAlign: keepLegacyVertical ? undefined : $('inlineVerticalAlign').value,
        size: keepAuto ? null : (rawSize ? Number(rawSize) : null), color: inlineDraft?.color ?? null,
        fontFamily: storedFont,
        bold: inlineDraft ? inlineDraft.bold : block.bold !== false,
        italic: inlineDraft ? inlineDraft.italic : !!block.italic,
        underline: inlineDraft ? inlineDraft.underline : !!block.underline,
        strike: inlineDraft ? !!inlineDraft.strike : !!block.strike,
      };
    },
    onCommit: (savedBlock, revision) => {
      inlineDraft.snapshot = revision;
      inlineDraft.html = mode === 'ocr'
        ? (savedBlock.ocrRichHtml || plainToHtml(savedBlock.text || ''))
        : (savedBlock.richHtml || plainToHtml(savedBlock.tr || ''));
      inlineDraft.dir = $('inlineEditorDirection').value; inlineDraft.align = $('inlineEditorAlign').value;
      inlineDraft.verticalAlign = $('inlineVerticalAlign').value;
      inlineDraft.initialAutoSize = !(Number.isFinite(+savedBlock.size) && +savedBlock.size > 0);
      if (inlineDraft.initialAutoSize && !inlineDraft.sizeTouched && document.activeElement !== $('inlineEditorSize')) {
        const nextShown = String(effectiveInlineSize(savedBlock));
        $('inlineEditorSize').value = nextShown;
        inlineDraft.initialSizeValue = nextShown;
      }
      inlineDraft.size = $('inlineEditorSize').value;
      inlineDraft.fontFamily = savedBlock.fontFamily || null;
      inlineDraft.bold = savedBlock.bold !== false;
      inlineDraft.italic = !!savedBlock.italic;
      inlineDraft.underline = !!savedBlock.underline;
      inlineDraft.strike = !!savedBlock.strike;
      inlineDraft.originalColor = inlineDraft.color = savedBlock.color || null; inlineDraft.conflictReported = false;
      $('inlineEditorCancel').classList.add('hidden');
      buildBlockList(); scheduleEditorCanvasDraw(); scheduleSave();
    },
    onConflict: () => {
      if (!inlineDraft.conflictReported) toast('این کادر هم‌زمان در جای دیگری تغییر کرده؛ نسخهٔ پروژه حفظ شد.', true);
      inlineDraft.conflictReported = true; $('inlineEditorCancel').classList.remove('hidden');
    },
  });
  $('inlineEditor').classList.remove('hidden', 'is-idle', 'plain-mode');
  syncVerticalAlignButtons();
  positionInlineEditor(); classicEditor.focus();
  const placed = placeInlineCaret(field, clickEvent);
  rememberInlineRange();
  if (!placed || !inlineDraft.range || !field.contains(inlineDraft.range.startContainer)) {
    seedDefaultInlineCaret(field, true);
  }
  recordInlineHistory(); syncInlineLineControls();
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
  syncEditorClipboardButtons();
  syncVerticalAlignButtons();
  syncEditorShapeControls();
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
function mergeRichHtmlChunks(chunks) {
  const valid = chunks.map((c) => String(c || '').trim()).filter(Boolean);
  if (!valid.length) return '';
  const hasBlock = valid.some((c) => /<(div|p|h[1-6]|blockquote|pre|ul|ol|table|hr)\b/i.test(c));
  if (!hasBlock) return sanitizeHtml(valid.join('<br>'));
  const normalized = valid.map((c) => (
    /^\s*<(div|p|h[1-6]|blockquote|pre|ul|ol|table|hr)\b/i.test(c) ? c : `<div>${c}</div>`
  ));
  return sanitizeHtml(normalized.join(''));
}
function mergeSelectedText() {
  if (inlineDraft && !closeInlineEditor()) return;
  const item = editorItem(); const blocks = selectedEditorBlocks();
  if (!item || blocks.length < 2) { toast('برای ادغام، حداقل دو کادر را انتخاب کنید (با Ctrl+کلیک روی کادرها)', true); return; }
  recordEditorPageHistory();
  const ordered = [...blocks].sort((a, b) => boxOf(a).y0 - boxOf(b).y0 || boxOf(a).x0 - boxOf(b).x0);
  const rawX0 = Math.min(...ordered.map((b) => Number.isFinite(b.x0) ? b.x0 : boxOf(b).x0));
  const rawY0 = Math.min(...ordered.map((b) => Number.isFinite(b.y0) ? b.y0 : boxOf(b).y0));
  const rawX1 = Math.max(...ordered.map((b) => Number.isFinite(b.x1) ? b.x1 : boxOf(b).x1));
  const rawY1 = Math.max(...ordered.map((b) => Number.isFinite(b.y1) ? b.y1 : boxOf(b).y1));
  const snapshots = JSON.parse(JSON.stringify(ordered));
  const hasTr = snapshots.some((b) => String(b.tr || '').trim() || String(b.richHtml || '').trim());
  const mergedTr = hasTr ? snapshots.map((b) => String(b.tr || '').trim()).filter(Boolean).join('\n') : '';
  const mergedRichHtml = hasTr && snapshots.some((b) => String(b.richHtml || '').trim())
    ? mergeRichHtmlChunks(snapshots.filter((b) => String(b.tr || '').trim() || String(b.richHtml || '').trim())
      .map((b) => String(b.richHtml || '').trim() || plainToHtml(String(b.tr || '').trim())))
    : '';
  const mergedOcrRichHtml = snapshots.some((b) => String(b.ocrRichHtml || '').trim())
    ? mergeRichHtmlChunks(snapshots.filter((b) => String(b.text || '').trim() || String(b.ocrRichHtml || '').trim())
      .map((b) => String(b.ocrRichHtml || '').trim() || plainToHtml(String(b.text || '').trim())))
    : '';
  const merged = {
    ...snapshots[0],
    enabled: true,
    manual: snapshots.every((b) => Boolean(b.manual)),
    text: joinedOcrText(snapshots),
    tr: mergedTr,
    richHtml: mergedRichHtml,
    ocrRichHtml: mergedOcrRichHtml,
    x0: rawX0, y0: rawY0, x1: rawX1, y1: rawY1,
    polygon: [[rawX0, rawY0], [rawX1, rawY0], [rawX1, rawY1], [rawX0, rawY1]],
    sourceLines: snapshots,
  };
  if (hasTr && snapshots.some((b) => b.textMode !== 'ocr') && merged.textMode === 'ocr') {
    delete merged.textMode;
  }
  const normAngles = snapshots.map((b) => normalizeAngleDeg(b.angle));
  if (normAngles.some((ang) => ang !== normAngles[0])) merged.angle = 0;
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
  pushPostActionEditorPageHistory();
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
    clone.ocrRichHtml = '';
    clone.x0 = b.x0; clone.y0 = sy0; clone.x1 = b.x1; clone.y1 = sy1;
    clone.polygon = [[b.x0, sy0], [b.x1, sy0], [b.x1, sy1], [b.x0, sy1]];
    clone.lineH = Math.max(14, Math.min(block.lineH || 24, Math.round((sy1 - sy0) * 0.8)));
    delete clone.tx0; delete clone.ty0; delete clone.tx1; delete clone.ty1; delete clone.sourceLines;
    return clone;
  });
}
function ensureUniqueSplitIds(entries, block, item, nextIdRef) {
  if (!Array.isArray(entries)) return entries;
  const usedIds = new Set((item?.blocks || []).filter((b) => b !== block).map((b) => String(b.id)));
  entries.forEach((entry, idx) => {
    entry.enabled = entry.enabled !== false;
    const curKey = entry.id != null ? String(entry.id) : '';
    if (!curKey || usedIds.has(curKey)) {
      if (idx === 0 && block?.id != null && !usedIds.has(String(block.id))) {
        entry.id = block.id;
      } else {
        entry.id = ++nextIdRef.maxId;
      }
    }
    usedIds.add(String(entry.id));
  });
  return entries;
}
function splitSingleEditorBlock(block, item, nextIdRef) {
  const hasSource = Array.isArray(block.sourceLines) && block.sourceLines.length >= 2;
  const hasTr = Boolean(String(block.tr || '').trim() || String(block.richHtml || '').trim());
  const trLines = nonEmptyLines(block.tr);
  const ocrLines = nonEmptyLines(block.text);
  const inheritedKeys = ['dir', 'ocrDir', 'align', 'size', 'verticalAlign', 'color', 'bg', 'fontFamily', 'bold', 'italic', 'underline', 'strike', 'shape', 'cornerRadius', 'angle'];
  if (!hasTr) {
    if (hasSource && String(block.text || '') === joinedOcrText(block.sourceLines)) {
      const originals = JSON.parse(JSON.stringify(block.sourceLines));
      originals.forEach((entry) => {
        inheritedKeys.forEach((k) => { if (entry[k] === undefined && block[k] !== undefined) entry[k] = block[k]; });
      });
      return ensureUniqueSplitIds(originals, block, item, nextIdRef);
    }
    if (hasSource && ocrLines.length === block.sourceLines.length) {
      const originals = JSON.parse(JSON.stringify(block.sourceLines));
      originals.forEach((entry, idx) => {
        inheritedKeys.forEach((k) => { if (entry[k] === undefined && block[k] !== undefined) entry[k] = block[k]; });
        entry.text = ocrLines[idx]; entry.tr = ''; entry.richHtml = ''; entry.ocrRichHtml = '';
      });
      return ensureUniqueSplitIds(originals, block, item, nextIdRef);
    }
    if (ocrLines.length >= 2) return ensureUniqueSplitIds(buildProportionalSplitBlocks(block, item, ocrLines, [], nextIdRef), block, item, nextIdRef);
    return null;
  }
  if (hasSource && trLines.length === block.sourceLines.length) {
    const originals = JSON.parse(JSON.stringify(block.sourceLines));
    originals.forEach((entry, idx) => {
      inheritedKeys.forEach((k) => { if (entry[k] === undefined && block[k] !== undefined) entry[k] = block[k]; });
      const prevTr = String(entry.tr || '').trim();
      entry.tr = trLines[idx];
      if (prevTr !== trLines[idx]) entry.richHtml = '';
      if (ocrLines.length === originals.length) entry.text = ocrLines[idx];
    });
    return ensureUniqueSplitIds(originals, block, item, nextIdRef);
  }
  if (hasSource && trLines.length === 1 && block.sourceLines.every((s) => String(s.tr || '').trim())
    && trLines[0] === block.sourceLines.map((s) => String(s.tr || '').trim()).join(' ')) {
    return ensureUniqueSplitIds(JSON.parse(JSON.stringify(block.sourceLines)), block, item, nextIdRef);
  }
  if (trLines.length >= 2) return ensureUniqueSplitIds(buildProportionalSplitBlocks(block, item, ocrLines, trLines, nextIdRef), block, item, nextIdRef);
  return null;
}
function splitSelectedText() {
  if (inlineDraft && !closeInlineEditor()) return;
  const item = editorItem(); const blocks = selectedEditorBlocks();
  if (!item || !blocks.length) { toast('ابتدا کادر موردنظر برای جداکردن را انتخاب کنید', true); return; }
  recordEditorPageHistory();
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
  pushPostActionEditorPageHistory();
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
function syncEditorBoxVisualGeometry(el, block, box, scale) {
  const wPx = Math.max(1, (box.x1 - box.x0) * scale);
  const hPx = Math.max(1, (box.y1 - box.y0) * scale);
  const shape = normalizeShapeKey(block?.shape);
  const radiusPct = normalizeRadiusPct(block?.cornerRadius);
  const angle = normalizeAngleDeg(block?.angle);
  el.style.left = `${box.x0 * scale}px`;
  el.style.top = `${box.y0 * scale}px`;
  el.style.width = `${wPx}px`;
  el.style.height = `${hPx}px`;
  el.dataset.shape = shape;
  el.dataset.boxAngle = String(angle);
  el.dataset.boxRadius = String(radiusPct);
  const item = editorItem();
  el.classList.toggle('compact-box', wPx < 155);
  el.classList.toggle('edge-right', Boolean(item && ((item.width - box.x1) * scale) < 24));
  el.style.transformOrigin = '50% 50%';
  el.style.transform = angle ? `rotate(${angle}deg)` : '';
  const halfShort = Math.min(wPx, hPx) / 2;
  if (shape === 'pill') {
    el.style.borderRadius = `${halfShort.toFixed(1)}px`;
  } else if (shape === 'ellipse') {
    el.style.borderRadius = '50%';
  } else if (shape === 'rect' && radiusPct > 0) {
    el.style.borderRadius = `${((radiusPct / 100) * halfShort).toFixed(1)}px`;
  } else {
    el.style.borderRadius = '';
  }
  const svg = el.querySelector('.box-shape-svg');
  if (svg && shape !== 'rect') {
    svg.setAttribute('viewBox', `0 0 ${Math.max(1, Math.round(wPx))} ${Math.max(1, Math.round(hPx))}`);
    const pathEl = svg.querySelector('path');
    if (pathEl) pathEl.setAttribute('d', shapeSvgPathForBox(Math.max(1, Math.round(wPx)), Math.max(1, Math.round(hPx)), shape, radiusPct));
  }
  const tooSmallForCornerHandles = wPx < 24 || hPx < 22 || shape !== 'rect';
  const maxInset = Math.max(6, halfShort - 2);
  const insetPx = Math.min(maxInset, Math.max(6, (radiusPct / 100) * halfShort));
  el.querySelectorAll('.corner-radius-handle').forEach((handle) => {
    if (tooSmallForCornerHandles) {
      handle.style.visibility = 'hidden';
      return;
    }
    handle.style.visibility = '';
    const corner = handle.dataset.radiusCorner || '';
    const off = `${Math.max(2, Math.round(insetPx - 4))}px`;
    handle.style.top = corner.startsWith('n') ? off : '';
    handle.style.bottom = corner.startsWith('s') ? off : '';
    handle.style.left = corner.endsWith('w') ? off : '';
    handle.style.right = corner.endsWith('e') ? off : '';
  });
}
function syncEditingBoxColors(boxEl, block) {
  if (!boxEl || !block) return;
  const background = String(block.bg || 'auto');
  if (background === 'white') {
    boxEl.style.setProperty('--editing-bg', '#fff');
    boxEl.style.setProperty('--editing-fg', '#202020');
  } else if (background === 'black') {
    boxEl.style.setProperty('--editing-bg', '#101010');
    boxEl.style.setProperty('--editing-fg', '#fff');
  } else if (/^#[0-9a-fA-F]{6}$/.test(background)) {
    const rv = parseInt(background.slice(1, 3), 16);
    const gv = parseInt(background.slice(3, 5), 16);
    const bv = parseInt(background.slice(5, 7), 16);
    const bright = (rv * 299 + gv * 587 + bv * 114) / 1000 > 150;
    boxEl.style.setProperty('--editing-bg', background);
    boxEl.style.setProperty('--editing-fg', bright ? '#202020' : '#fff');
  } else {
    boxEl.style.setProperty('--editing-bg', 'var(--surface)');
    boxEl.style.setProperty('--editing-fg', 'var(--text)');
  }
}
function applyBoxShapeSettings(patch) {
  const targets = selectedEditorBlocks();
  const singleTarget = inlineDraft?.block ? [inlineDraft.block] : [];
  const blocks = targets.length ? targets : (singleTarget.length ? singleTarget : resolveToolbarTargetBlocks({ autoSelectFirst: true }));
  if (!blocks.length) {
    toast('ابتدا یک کادر را روی تصویر انتخاب کنید.', true);
    return;
  }
  if (!inlineDraft) recordEditorPageHistory();
  blocks.forEach((b) => {
    if ('shape' in patch) {
      b.shape = normalizeShapeKey(patch.shape);
      if (b.manual && (!b.bg || b.bg === 'none') && b.shape !== 'rect') b.bg = 'white';
    }
    if ('cornerRadius' in patch) {
      b.cornerRadius = normalizeRadiusPct(patch.cornerRadius);
      if (b.manual && (!b.bg || b.bg === 'none') && b.cornerRadius > 0) b.bg = 'white';
    }
    if ('angle' in patch) b.angle = normalizeAngleDeg(patch.angle);
    if ('bg' in patch) b.bg = patch.bg;
  });
  buildBlockList();
  drawEditor();
  if (inlineDraft && blocks.includes(inlineDraft.block)) {
    const activeEditingBox = document.querySelector('#editorBoxes .editor-box.editing');
    syncEditingBoxColors(activeEditingBox, inlineDraft.block);
    refreshInlineTypography();
  }
  syncEditorShapeControls();
  scheduleSave();
  if (!inlineDraft) pushPostActionEditorPageHistory();
}
function translateSelectedEditorBlock() {
  const item = editorItem();
  const target = inlineDraft?.block || (item ? resolveToolbarTargetBlocks(item)[0] : null) || null;
  if (!target) {
    toast('ابتدا کادر موردنظر را روی تصویر انتخاب کنید تا برای ترجمه ارسال شود.', true);
    return;
  }
  retranslateBlock(target).catch((err) => toast(err?.message || String(err), true));
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
      const move = document.createElement('button'); move.type = 'button'; move.className = 'box-move'; move.textContent = `⠿ متن ${block.id}`; move.dataset.move = '1'; move.title = 'برای جابه‌جایی کادر بکشید (با نگه داشتن Ctrl+Shift از کادر کپی بگیرید)'; move.setAttribute('aria-label', `جابه‌جایی کادر متن ${block.id}`);
      const visibility = document.createElement('button'); visibility.type = 'button'; visibility.className = 'box-visibility'; visibility.textContent = '👁'; visibility.title = 'پنهان‌کردن فقط همین خط روی تصویر'; visibility.setAttribute('aria-label', `پنهان‌کردن متن ${block.id} روی تصویر`); visibility.addEventListener('pointerdown', (event) => event.stopPropagation()); visibility.addEventListener('click', (event) => { event.stopPropagation(); setBlockVisibility(el._block, false); });
      const language = document.createElement('button'); language.type = 'button'; language.className = 'box-language'; language.setAttribute('aria-label', `تغییر زبان متن ${block.id} روی تصویر`); language.addEventListener('pointerdown', (event) => event.stopPropagation()); language.addEventListener('click', (event) => { event.stopPropagation(); setBlockTextMode(el._block, el.dataset.mode === 'ocr' ? 'translation' : 'ocr'); });
      const copyBtn = document.createElement('button'); copyBtn.type = 'button'; copyBtn.className = 'box-copy'; copyBtn.textContent = '⧉'; copyBtn.title = 'کپی و تکثیر فوری همین کادر با تمام ویژگی‌ها (یا نگه داشتن Ctrl+Shift و کشیدن/کلیک)'; copyBtn.setAttribute('aria-label', `کپی و تکثیر کادر متن ${block.id}`); copyBtn.addEventListener('pointerdown', (event) => event.stopPropagation()); copyBtn.addEventListener('click', (event) => { event.stopPropagation(); duplicateEditorBlocks([el._block]); });
      const translateBtn = document.createElement('button'); translateBtn.type = 'button'; translateBtn.className = 'box-translate'; translateBtn.textContent = '🌐'; translateBtn.title = 'ارسال همین کادر برای ترجمهٔ تکی'; translateBtn.setAttribute('aria-label', `ترجمهٔ تکی کادر متن ${block.id}`); translateBtn.addEventListener('pointerdown', (event) => event.stopPropagation()); translateBtn.addEventListener('click', (event) => { event.stopPropagation(); retranslateBlock(el._block); });
      const rotateHandle = document.createElement('i'); rotateHandle.className = 'rotate-handle'; rotateHandle.dataset.rotateHandle = '1'; rotateHandle.textContent = '↻'; rotateHandle.title = 'برای چرخاندن کادر بکشید (Shift = مضرب ۱۵ درجه · دابل‌کلیک = بازنشانی به ۰ درجه)'; rotateHandle.setAttribute('aria-label', `چرخاندن کادر متن ${block.id}`);
      rotateHandle.addEventListener('dblclick', (event) => { event.preventDefault(); event.stopPropagation(); if (el._block) { el._block.angle = 0; buildBlockList(); drawEditor(); syncEditorShapeControls(); scheduleSave(); } });
      const shapeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      shapeSvg.setAttribute('class', 'box-shape-svg');
      shapeSvg.setAttribute('preserveAspectRatio', 'none');
      shapeSvg.setAttribute('aria-hidden', 'true');
      shapeSvg.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'path'));
      el.append(move, visibility, language, copyBtn, translateBtn, rotateHandle, shapeSvg);
      ['nw', 'ne', 'se', 'sw'].forEach((corner) => {
        const crHandle = document.createElement('i');
        crHandle.className = `corner-radius-handle ${corner}`;
        crHandle.dataset.radiusCorner = corner;
        crHandle.title = 'برای گرد کردن گوشه‌های مستطیل بکشید (دابل‌کلیک برای تیز کردن گوشه‌ها)';
        crHandle.addEventListener('dblclick', (event) => {
          event.preventDefault(); event.stopPropagation();
          if (el._block) { el._block.cornerRadius = 0; buildBlockList(); drawEditor(); syncEditorShapeControls(); scheduleSave(); }
        });
        el.appendChild(crHandle);
      });
      ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach((dir) => { const handle = document.createElement('i'); handle.className = `resize-handle ${dir}`; handle.dataset.dir = dir; el.appendChild(handle); });
      el.addEventListener('pointerdown', (event) => {
        const activeBlock = el._block;
        const isCtrlOrMeta = event.ctrlKey || event.metaKey;
        const isCloneGesture = isCtrlOrMeta && event.shiftKey && event.button === 0 && !event.target.closest('.box-visibility,.box-language,.box-copy,.box-translate,[data-dir],[data-rotate-handle],[data-radius-corner]');
        if (isCloneGesture) {
          if (inlineDraft && !closeInlineEditor()) return;
          if (!editorSelectedKeys().includes(String(activeBlock.id))) {
            selectEditorBlock(activeBlock.id, true, false);
          }
          startBoxCloneGesture(event, activeBlock);
          return;
        }
        const additive = isCtrlOrMeta; const dragTarget = event.target.closest('[data-move],[data-dir],[data-rotate-handle],[data-radius-corner]') || event.target === el;
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
    syncEditorBoxVisualGeometry(el, block, box, scale);
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
  const rotateTarget = event.target.closest('[data-rotate-handle]');
  const radiusTarget = event.target.closest('[data-radius-corner]');
  const resize = event.target.closest('[data-dir]');
  const moveHandle = event.target.closest('[data-move]');
  // Text remains editable: dragging starts on the visible handle or the box border, not inside the text itself.
  if (!rotateTarget && !radiusTarget && !resize && !moveHandle && event.target !== el) return;
  const item = editorItem(); if (!item) return;
  event.preventDefault(); event.stopPropagation();
  const mode = rotateTarget ? 'rotate' : radiusTarget ? 'corner-radius' : (resize?.dataset.dir || 'move');
  const cornerKey = radiusTarget?.dataset.radiusCorner || '';
  const start = boxOf(block);
  const origin = { x: event.clientX, y: event.clientY };
  const scale = state.editorScale || 1;
  const stageRect = $('editorStage')?.getBoundingClientRect?.() || { left: 0, top: 0 };
  const centerImgX = (start.x0 + start.x1) / 2;
  const centerImgY = (start.y0 + start.y1) / 2;
  const centerClientX = stageRect.left + centerImgX * scale;
  const centerClientY = stageRect.top + centerImgY * scale;
  const initialAngle = normalizeAngleDeg(block.angle);
  const initialRadius = normalizeRadiusPct(block.cornerRadius);
  const startPointerRad = Math.atan2(origin.y - centerClientY, origin.x - centerClientX);
  const selected = selectedEditorBlocks();
  const movingBlocks = mode === 'move' && selected.includes(block) ? selected : [block];
  const movingStarts = movingBlocks.map((movingBlock) => ({ block: movingBlock, start: boxOf(movingBlock) }));
  let changed = false; let finished = false;
  el.setPointerCapture(event.pointerId); el.classList.add('dragging');
  if (radiusTarget) radiusTarget.classList.add('dragging');
  const move = (ev) => {
    if (mode === 'rotate') {
      const curPointerRad = Math.atan2(ev.clientY - centerClientY, ev.clientX - centerClientX);
      let deltaDeg = ((curPointerRad - startPointerRad) * 180) / Math.PI;
      while (deltaDeg > 180) deltaDeg -= 360;
      while (deltaDeg < -180) deltaDeg += 360;
      let rawDeg = initialAngle + deltaDeg;
      while (rawDeg > 180) rawDeg -= 360;
      while (rawDeg < -180) rawDeg += 360;
      const snapped = ev.shiftKey ? Math.round(rawDeg / 15) * 15 : rawDeg;
      block.angle = normalizeAngleDeg(snapped);
      syncEditorBoxVisualGeometry(el, block, boxOf(block), scale);
      syncEditorShapeControls();
      if (inlineDraft?.block === block) positionInlineEditor();
      scheduleEditorCanvasDraw();
      changed = true;
      return;
    }
    if (mode === 'corner-radius') {
      const bw = Math.max(2, start.x1 - start.x0);
      const bh = Math.max(2, start.y1 - start.y0);
      const halfShort = Math.max(1, Math.min(bw, bh) / 2);
      const relScreenX = (ev.clientX - centerClientX) / scale;
      const relScreenY = (ev.clientY - centerClientY) / scale;
      const rad = -(initialAngle * Math.PI) / 180;
      const localX = (relScreenX * Math.cos(rad) - relScreenY * Math.sin(rad)) + bw / 2;
      const localY = (relScreenX * Math.sin(rad) + relScreenY * Math.cos(rad)) + bh / 2;
      const distX = cornerKey.endsWith('e') ? (bw - localX) : localX;
      const distY = cornerKey.startsWith('s') ? (bh - localY) : localY;
      const inward = Math.max(0, Math.min(halfShort, (Math.max(0, distX) + Math.max(0, distY)) / 2));
      const pct = normalizeRadiusPct((inward / halfShort) * 100);
      block.shape = 'rect';
      block.cornerRadius = pct;
      if (block.manual && (!block.bg || block.bg === 'none') && pct > 0) block.bg = 'white';
      syncEditorBoxVisualGeometry(el, block, boxOf(block), scale);
      syncEditorShapeControls();
      if (inlineDraft?.block === block) positionInlineEditor();
      scheduleEditorCanvasDraw();
      changed = true;
      return;
    }
    const rawDx = (ev.clientX - origin.x) / scale; const rawDy = (ev.clientY - origin.y) / scale;
    if (mode === 'move') {
      const minDx = Math.max(...movingStarts.map((entry) => -entry.start.x0));
      const maxDx = Math.min(...movingStarts.map((entry) => item.width - entry.start.x1));
      const minDy = Math.max(...movingStarts.map((entry) => -entry.start.y0));
      const maxDy = Math.min(...movingStarts.map((entry) => item.height - entry.start.y1));
      const groupDx = Math.max(minDx, Math.min(maxDx, rawDx)); const groupDy = Math.max(minDy, Math.min(maxDy, rawDy));
      movingStarts.forEach((entry) => {
        const moving = entry.block; const initial = entry.start; const width = initial.x1 - initial.x0; const height = initial.y1 - initial.y0;
        moving.tx0 = initial.x0 + groupDx; moving.tx1 = moving.tx0 + width; moving.ty0 = initial.y0 + groupDy; moving.ty1 = moving.ty0 + height;
        const boxEl = moving === block ? el : [...document.querySelectorAll('#editorBoxes .editor-box')].find((candidate) => candidate.dataset.id === String(moving.id));
        if (boxEl) { boxEl.style.left = `${moving.tx0 * scale}px`; boxEl.style.top = `${moving.ty0 * scale}px`; }
      });
    } else {
      const rad = -(initialAngle * Math.PI) / 180;
      const dx = initialAngle ? (rawDx * Math.cos(rad) - rawDy * Math.sin(rad)) : rawDx;
      const dy = initialAngle ? (rawDx * Math.sin(rad) + rawDy * Math.cos(rad)) : rawDy;
      let { x0, y0, x1, y1 } = start; const minW = Math.min(20, item.width); const minH = Math.min(16, item.height);
      if (mode.includes('w')) x0 = Math.max(0, Math.min(start.x1 - minW, start.x0 + dx));
      if (mode.includes('e')) x1 = Math.min(item.width, Math.max(start.x0 + minW, start.x1 + dx));
      if (mode.includes('n')) y0 = Math.max(0, Math.min(start.y1 - minH, start.y0 + dy));
      if (mode.includes('s')) y1 = Math.min(item.height, Math.max(start.y0 + minH, start.y1 + dy));
      block.tx0 = x0; block.tx1 = x1; block.ty0 = y0; block.ty1 = y1;
    }
    syncEditorBoxVisualGeometry(el, block, boxOf(block), scale);
    if (inlineDraft?.block === block) positionInlineEditor();
    scheduleEditorCanvasDraw(); changed = true;
  };
  const stop = () => {
    if (finished) return; finished = true;
    el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', stop); el.removeEventListener('pointercancel', stop); el.removeEventListener('lostpointercapture', stop);
    el.classList.remove('dragging');
    if (radiusTarget) radiusTarget.classList.remove('dragging');
    if (el.hasPointerCapture?.(event.pointerId)) el.releasePointerCapture(event.pointerId);
    if (changed) {
      if (initialRadius !== normalizeRadiusPct(block.cornerRadius) || initialAngle !== normalizeAngleDeg(block.angle)) buildBlockList();
      if (inlineDraft?.block === block) refreshInlineTypography();
      drawEditor();
      scheduleSave();
    }
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
function applyTranslatedBlockDefaults(block, text, targetLang = null) {
  block.tr = text;
  block.richHtml = '';
  const resolvedDir = targetLang ? targetLanguageDir(targetLang) : (block.dir === 'ltr' ? 'ltr' : 'rtl');
  block.dir = resolvedDir;
  if (block.textMode === 'ocr') block.textMode = 'translation';
  if (block.manual) {
    if (!['left', 'center', 'right', 'justify'].includes(block.align)) block.align = 'center';
    return;
  }
  if (block.pageRole === 'heading') {
    const rawLh = Number(block.lineH) || Math.max(16, (Number(block.y1) || 0) - (Number(block.y0) || 0)) || 22;
    block.align = resolvedDir === 'ltr' ? 'left' : 'right';
    block.size = Math.max(14, Math.min(36, Math.round(rawLh * 0.78)));
    block.verticalAlign = 'middle';
    block.bold = true;
  } else {
    block.align = 'justify';
    block.size = 12;
    block.verticalAlign = 'top';
    block.bold = !!block._detectedBold;
  }
  if (block._detectedItalic) block.italic = true;
}
async function retranslateBlock(block, targetOverride = null) {
  if (!block) return;
  if (!isModuleLicensed('translation')) { await ensureModuleLicensed('translation'); return; }
  if (inlineDraft?.block === block && !closeInlineEditor()) return;
  let text = String(block.text || '').trim();
  const canUseManualTypedSource = Boolean(block.manual && (block.manualLang === 'en' || block.dir === 'ltr'));
  if (!text && canUseManualTypedSource && String(block.tr || '').trim()) {
    text = String(block.tr || '').trim();
    block.text = text;
    scheduleSave();
  }
  if (!text) {
    toast('این کادر متن اصلی (OCR) برای ترجمه ندارد.', true);
    return;
  }
  const snapshot = inlineBlockSnapshot(block);
  const target = resolvePreferredTranslationTarget(targetOverride);
  const provider = target.provider; const profileId = target.profileId; const sourceLanguage = $('ocrLanguage').value;
  const targetLanguage = activeTargetLanguage();
  try {
    const projectId = state.project.id;
    const request = { text, source_lines: block.sourceLines || null, source_language: sourceLanguage, target_language: targetLanguage, provider, ...(profileId ? { profile_id: profileId } : {}) };
    const switchTarget = (nextVal) => retranslateBlock(block, nextVal);
    if (isDirectMtProvider(provider)) {
      const refresh = () => api('/api/translate-text/context-preview', jsonOptions('POST', { ...request, skill: '', summary: '' }));
      const preview = await refresh();
      showTranslationRequestPreview(preview, async accepted => {
        if (inlineDraft?.block === block || inlineBlockSnapshot(block) !== snapshot) { toast('این کادر تغییر کرده است؛ ترجمهٔ قبلی حفظ شد. دوباره تلاش کنید.', true); return; }
        const result = await runSingleBlockTranslation((signal) => api('/api/translate-text/context', { ...jsonOptions('POST', { ...request, skill:'', summary:'', confirmation: accepted.signature }), signal }));
        if (!result || result.cancelled) return;
        if (inlineDraft?.block === block || inlineBlockSnapshot(block) !== snapshot) { toast('در حین ترجمه کادر تغییر کرد؛ نتیجه جایگزین نشد.', true); return; }
        applyTranslatedBlockDefaults(block, result.text, targetLanguage); buildBlockList(); drawEditor(); scheduleSave();
      }, refresh, switchTarget);
      return;
    }
    const allActiveProfiles = state.ai?.providers?.[provider]?.profiles?.filter(p => p.hasApiKey) || [];
    const profiles = profileId ? allActiveProfiles.filter(p => String(p.id) === profileId) : allActiveProfiles;
    const limit = profiles.length ? Math.min(...profiles.map(p => p.source_limit ?? 1000)) : 1000;
    const skillLimit = Math.floor(limit * (state.ai?.skill_percent ?? 15) / 100);
    const contextLimit = Math.floor(limit * (state.ai?.context_percent ?? 15) / 100);
    const defaultTargetLabel = TARGET_LANGUAGE_META[targetLanguage]?.label || targetLanguage;
    const fallbackSkill = targetLanguage === 'fa'
      ? 'ترجمه را روان و متناسب با لحن کمیک یا کتاب بنویس؛ نام‌ها، اصطلاحات، اعداد و آواها را حفظ کن.'
      : `ترجمه را روان، طبیعی و متناسب با لحن کمیک یا کتاب به زبان ${defaultTargetLabel} بنویس؛ نام‌ها، اصطلاحات، اعداد و آواها را حفظ کن.`;
    const skill = savedTranslationSkill(projectId) ?? fallbackSkill;
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
      applyTranslatedBlockDefaults(block, result.text, targetLanguage); buildBlockList(); drawEditor(); scheduleSave();
    }, refresh, switchTarget);
  } catch (error) {
    if (targetOverride && $('translationPreviewDialog').open) throw error;
    toast(`ساخت پیش‌نمایش ترجمه ممکن نبود: ${error.message || error}`, true);
  }
}
async function copyBlockText(text) {
  if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
  else { const temp = document.createElement('textarea'); temp.value = text; temp.style.position = 'fixed'; temp.style.opacity = '0'; document.body.appendChild(temp); try { temp.select(); if (!document.execCommand('copy')) throw new Error('مرورگر اجازهٔ کپی نداد'); } finally { temp.remove(); } }
  toast('کپی شد');
}
function makeBlockToolButton(svgInner, label, handler, extraClass = '') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `bt${extraClass ? ` ${extraClass}` : ''}`;
  btn.innerHTML = `<svg class="btn-ico" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svgInner}</svg><span>${escapeHtml(label)}</span>`;
  btn.addEventListener('click', handler);
  return btn;
}
function nextEditorBlockId(item) {
  let maxId = 0;
  (item?.blocks || []).forEach((b) => {
    const n = Number.parseInt(b?.id, 10);
    if (Number.isFinite(n) && n > maxId) maxId = n;
  });
  return maxId + 1;
}
function syncEditorClipboardButtons() {
  const hasSelection = selectedEditorBlocks().length > 0;
  const clipCount = Array.isArray(state.copiedEditorBlocks) ? state.copiedEditorBlocks.length : 0;
  $('editorCopyBlock')?.classList.toggle('is-ready', hasSelection);
  $('editorDuplicateBlock')?.classList.toggle('is-ready', hasSelection);
  const pasteBtn = $('editorPasteBlock');
  if (pasteBtn) {
    pasteBtn.disabled = clipCount === 0;
    pasteBtn.classList.toggle('is-ready', clipCount > 0);
    pasteBtn.title = clipCount > 0
      ? `چسباندن ${clipCount.toLocaleString('fa-IR')} کادر کپی‌شده با تمام ویژگی‌ها روی این صفحه (Ctrl+V)`
      : 'ابتدا یک یا چند کادر را کپی کنید (Ctrl+C)';
  }
}
function cloneBlockForClipboard(block) {
  const raw = JSON.parse(JSON.stringify(block));
  const box = boxOf(block);
  const w = Math.max(16, (Number(box.x1) || 0) - (Number(box.x0) || 0));
  const h = Math.max(16, (Number(box.y1) || 0) - (Number(box.y0) || 0));
  delete raw.id;
  delete raw.polygon;
  delete raw.mergedFrom;
  raw._clipBox = { x0: Number(box.x0) || 0, y0: Number(box.y0) || 0, w, h };
  return raw;
}
function translateSourceLinesGeometry(sourceLines, deltaX, deltaY, { markManual = true } = {}) {
  if (!Array.isArray(sourceLines)) return;
  sourceLines.forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    delete entry.id;
    if (markManual) entry.manual = true;
    entry.enabled = true;
    ['x0', 'x1', 'tx0', 'tx1'].forEach((k) => { if (Number.isFinite(entry[k])) entry[k] = Math.round(entry[k] + deltaX); });
    ['y0', 'y1', 'ty0', 'ty1'].forEach((k) => { if (Number.isFinite(entry[k])) entry[k] = Math.round(entry[k] + deltaY); });
    if (Array.isArray(entry.polygon)) {
      entry.polygon = entry.polygon.map((pt) => (Array.isArray(pt) && pt.length >= 2
        ? [Math.round((Number(pt[0]) || 0) + deltaX), Math.round((Number(pt[1]) || 0) + deltaY)]
        : pt));
    }
  });
}
function instantiateClonedBlocksOnItem(item, templates, { dx = 0, dy = 0, clampGroup = true } = {}) {
  if (!item || !Array.isArray(templates) || !templates.length) return [];
  if (currentOverlayMode() === 'none') setOverlayMode('translation', false);
  if (editorItem() === item) recordEditorPageHistory();
  item.blocks = Array.isArray(item.blocks) ? item.blocks : [];
  const pageW = Math.max(20, Number(item.width) || 800);
  const pageH = Math.max(20, Number(item.height) || 1000);
  const sized = templates.map((tpl) => {
    const cb = tpl._clipBox || { x0: Number(tpl.tx0 ?? tpl.x0) || 0, y0: Number(tpl.ty0 ?? tpl.y0) || 0, w: 120, h: 48 };
    const w = Math.max(Math.min(16, pageW), Math.min(pageW, Math.round(cb.w)));
    const h = Math.max(Math.min(16, pageH), Math.min(pageH, Math.round(cb.h)));
    const baseX0 = Math.max(0, Math.min(pageW - w, Math.round(cb.x0)));
    const baseY0 = Math.max(0, Math.min(pageH - h, Math.round(cb.y0)));
    return { tpl, cb, baseX0, baseY0, w, h };
  });
  let effDx = dx;
  let effDy = dy;
  if (clampGroup) {
    const minAllowedDx = Math.max(...sized.map((s) => -s.baseX0));
    const maxAllowedDx = Math.min(...sized.map((s) => pageW - (s.baseX0 + s.w)));
    const minAllowedDy = Math.max(...sized.map((s) => -s.baseY0));
    const maxAllowedDy = Math.min(...sized.map((s) => pageH - (s.baseY0 + s.h)));
    effDx = Math.max(minAllowedDx, Math.min(maxAllowedDx, dx));
    effDy = Math.max(minAllowedDy, Math.min(maxAllowedDy, dy));
  }
  const created = sized.map(({ tpl, cb, baseX0, baseY0, w, h }) => {
    const copy = JSON.parse(JSON.stringify(tpl));
    delete copy._clipBox;
    delete copy.polygon;
    delete copy.mergedFrom;
    const x0 = Math.max(0, Math.min(pageW - w, Math.round(baseX0 + effDx)));
    const y0 = Math.max(0, Math.min(pageH - h, Math.round(baseY0 + effDy)));
    if (Array.isArray(copy.sourceLines) && copy.sourceLines.length) {
      translateSourceLinesGeometry(copy.sourceLines, x0 - (Number(cb.x0) || 0), y0 - (Number(cb.y0) || 0), { markManual: true });
    }
    copy.id = nextEditorBlockId(item);
    copy.manual = true;
    copy.manualLang = copy.manualLang || (copy.dir === 'ltr' ? 'en' : 'fa');
    copy.enabled = true;
    copy.x0 = x0;
    copy.y0 = y0;
    copy.x1 = x0 + w;
    copy.y1 = y0 + h;
    copy.tx0 = x0;
    copy.ty0 = y0;
    copy.tx1 = x0 + w;
    copy.ty1 = y0 + h;
    item.blocks.push(copy);
    return copy;
  });
  state.selectedBlockIds = created.map((b) => String(b.id));
  state.activeBlockId = String(created.at(-1).id);
  buildBlockList();
  drawEditor();
  scheduleSave();
  if (editorItem() === item) pushPostActionEditorPageHistory();
  return created;
}
function copyEditorBlocks(targetBlocks = null, { silent = false } = {}) {
  const item = editorItem();
  if (!item) return false;
  const activeBeforeClose = inlineDraft?.block || null;
  if (inlineDraft && !closeInlineEditor()) return false;
  let blocks = Array.isArray(targetBlocks) && targetBlocks.length ? targetBlocks : resolveToolbarTargetBlocks(item);
  if (!blocks.length && activeBeforeClose && item.blocks?.includes(activeBeforeClose)) blocks = [activeBeforeClose];
  if (!blocks.length) {
    if (!silent) toast('ابتدا یک یا چند کادر را برای کپی انتخاب کنید.', true);
    return false;
  }
  state.copiedEditorBlocks = blocks.map(cloneBlockForClipboard);
  state.copiedEditorPasteStep = 0;
  state.copiedEditorSourceImageId = item.id;
  syncEditorClipboardButtons();
  if (!silent) {
    toast(blocks.length === 1
      ? 'کادر با تمام ویژگی‌ها کپی شد (با Ctrl+V یا دکمهٔ «چسباندن» قرار دهید)'
      : `${blocks.length.toLocaleString('fa-IR')} کادر با تمام ویژگی‌ها کپی شد (Ctrl+V برای چسباندن)`);
  }
  return true;
}
function pasteCopiedEditorBlocks() {
  const item = editorItem();
  if (!item) return [];
  if (!Array.isArray(state.copiedEditorBlocks) || !state.copiedEditorBlocks.length) {
    toast('هنوز کادری کپی نشده است؛ ابتدا یک کادر را انتخاب و کپی (Ctrl+C) کنید.', true);
    return [];
  }
  if (inlineDraft && !closeInlineEditor()) return [];
  const samePage = state.copiedEditorSourceImageId === item.id;
  if (samePage) {
    state.copiedEditorPasteStep = (state.copiedEditorPasteStep % 8) + 1;
  } else {
    // First paste onto another page keeps exact coordinates; subsequent pastes on that page step +22px.
    state.copiedEditorSourceImageId = item.id;
    state.copiedEditorPasteStep = 0;
  }
  const offset = state.copiedEditorPasteStep * 22;
  const created = instantiateClonedBlocksOnItem(item, state.copiedEditorBlocks, { dx: offset, dy: offset });
  if (created.length) {
    toast(created.length === 1 ? 'کادر با تمام ویژگی‌ها چسبانده شد' : `${created.length.toLocaleString('fa-IR')} کادر چسبانده شد`);
  }
  return created;
}
function duplicateEditorBlocks(targetBlocks = null) {
  const item = editorItem();
  if (!item) return [];
  const activeBeforeClose = inlineDraft?.block || null;
  if (inlineDraft && !closeInlineEditor()) return [];
  let blocks = Array.isArray(targetBlocks) && targetBlocks.length ? targetBlocks : resolveToolbarTargetBlocks(item);
  if (!blocks.length && activeBeforeClose && item.blocks?.includes(activeBeforeClose)) blocks = [activeBeforeClose];
  if (!blocks.length) {
    toast('ابتدا یک یا چند کادر را برای تکثیر انتخاب کنید.', true);
    return [];
  }
  copyEditorBlocks(blocks, { silent: true });
  state.copiedEditorPasteStep = 1;
  const created = instantiateClonedBlocksOnItem(item, state.copiedEditorBlocks, { dx: 22, dy: 22 });
  if (created.length) {
    toast(created.length === 1 ? 'یک نسخهٔ کپی از کادر ساخته شد' : `کپی ${created.length.toLocaleString('fa-IR')} کادر ساخته شد`);
  }
  return created;
}
function startBoxCloneGesture(event, activeBlock) {
  const item = editorItem();
  if (!item) return;
  event.preventDefault();
  event.stopPropagation();
  const currentSelected = selectedEditorBlocks();
  const sourceBlocks = currentSelected.includes(activeBlock) ? currentSelected : [activeBlock];
  const templates = sourceBlocks.map(cloneBlockForClipboard);
  const origin = { x: event.clientX, y: event.clientY };
  const scale = state.editorScale || 1;
  let clonedEntries = null;
  let finished = false;

  const onMove = (ev) => {
    const dist = Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y);
    if (!clonedEntries) {
      if (dist < 3) return;
      state.copiedEditorBlocks = templates;
      state.copiedEditorPasteStep = 0;
      state.copiedEditorSourceImageId = item.id;
      syncEditorClipboardButtons();
      const created = instantiateClonedBlocksOnItem(item, templates, { dx: 0, dy: 0 });
      if (!created.length) return;
      clonedEntries = created.map((blk) => ({ block: blk, start: boxOf(blk) }));
    }
    const dx = (ev.clientX - origin.x) / scale;
    const dy = (ev.clientY - origin.y) / scale;
    const minDx = Math.max(...clonedEntries.map((entry) => -entry.start.x0));
    const maxDx = Math.min(...clonedEntries.map((entry) => item.width - entry.start.x1));
    const minDy = Math.max(...clonedEntries.map((entry) => -entry.start.y0));
    const maxDy = Math.min(...clonedEntries.map((entry) => item.height - entry.start.y1));
    const groupDx = Math.max(minDx, Math.min(maxDx, dx));
    const groupDy = Math.max(minDy, Math.min(maxDy, dy));
    clonedEntries.forEach((entry) => {
      const moving = entry.block;
      const initial = entry.start;
      const width = initial.x1 - initial.x0;
      const height = initial.y1 - initial.y0;
      const nx0 = Math.round(initial.x0 + groupDx);
      const ny0 = Math.round(initial.y0 + groupDy);
      const stepDx = nx0 - (Number(moving.x0) || 0);
      const stepDy = ny0 - (Number(moving.y0) || 0);
      if ((stepDx || stepDy) && Array.isArray(moving.sourceLines) && moving.sourceLines.length) {
        translateSourceLinesGeometry(moving.sourceLines, stepDx, stepDy, { markManual: true });
      }
      moving.x0 = nx0; moving.x1 = nx0 + width; moving.y0 = ny0; moving.y1 = ny0 + height;
      moving.tx0 = nx0; moving.tx1 = nx0 + width; moving.ty0 = ny0; moving.ty1 = ny0 + height;
      const boxEl = [...document.querySelectorAll('#editorBoxes .editor-box')].find((candidate) => candidate.dataset.id === String(moving.id));
      if (boxEl) {
        boxEl.classList.add('dragging');
        boxEl.style.left = `${nx0 * scale}px`;
        boxEl.style.top = `${ny0 * scale}px`;
      }
    });
    scheduleEditorCanvasDraw();
  };

  const onStop = () => {
    if (finished) return;
    finished = true;
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onStop, true);
    window.removeEventListener('pointercancel', onStop, true);
    document.querySelectorAll('#editorBoxes .editor-box.dragging').forEach((el) => el.classList.remove('dragging'));
    if (!clonedEntries) {
      duplicateEditorBlocks(sourceBlocks);
    } else {
      buildBlockList();
      drawEditor();
      scheduleSave();
      toast(clonedEntries.length === 1 ? 'کپی کادر با تمام ویژگی‌ها در محل جدید قرار گرفت' : `کپی ${clonedEntries.length.toLocaleString('fa-IR')} کادر در محل جدید قرار گرفت`);
    }
  };

  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onStop, true);
  window.addEventListener('pointercancel', onStop, true);
}
function addManualEditorBlock(lang = 'fa') {
  const item = editorItem();
  if (!item) return null;
  if (inlineDraft && !closeInlineEditor()) return null;
  if (currentOverlayMode() === 'none') setOverlayMode('translation', false);
  item.blocks = Array.isArray(item.blocks) ? item.blocks : [];
  const scale = state.editorScale || 1;
  const preview = document.querySelector('.editor-preview');
  const viewW = preview?.clientWidth || 0;
  const viewH = preview?.clientHeight || 0;
  const centerX = viewW > 40 ? ((preview.scrollLeft || 0) + viewW / 2) / scale : item.width / 2;
  const centerY = viewH > 40 ? ((preview.scrollTop || 0) + viewH / 2) / scale : item.height / 2;
  const w = Math.max(Math.min(90, item.width), Math.min(420, Math.round(item.width * 0.28)));
  const h = Math.max(Math.min(44, item.height), Math.min(170, Math.round(item.height * 0.09)));
  let x0 = Math.round(Math.max(0, Math.min(item.width - w, centerX - w / 2)));
  let y0 = Math.round(Math.max(0, Math.min(item.height - h, centerY - h / 2)));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const colliding = item.blocks.some((b) => {
      const bx = boxOf(b);
      return Math.abs(bx.x0 - x0) < 12 && Math.abs(bx.y0 - y0) < 12;
    });
    if (!colliding) break;
    x0 = Math.max(0, Math.min(item.width - w, x0 + 18));
    y0 = Math.max(0, Math.min(item.height - h, y0 + 18));
  }
  const isEn = lang === 'en';
  const newBlock = {
    id: nextEditorBlockId(item),
    manual: true,
    manualLang: isEn ? 'en' : 'fa',
    text: '',
    tr: '',
    richHtml: '',
    conf: 100,
    enabled: true,
    bg: 'none',
    textMode: 'translation',
    dir: isEn ? 'ltr' : 'rtl',
    align: 'center',
    verticalAlign: 'middle',
    bold: true,
    italic: false,
    size: null,
    color: null,
    pageRole: 'paragraph',
    lineH: Math.max(18, Math.min(38, Math.round(h * 0.42))),
    x0, y0, x1: x0 + w, y1: y0 + h,
    tx0: x0, ty0: y0, tx1: x0 + w, ty1: y0 + h,
  };
  item.blocks.push(newBlock);
  state.activeBlockId = String(newBlock.id);
  state.selectedBlockIds = [String(newBlock.id)];
  buildBlockList();
  drawEditor();
  scheduleSave();
  openInlineEditor(newBlock);
  return newBlock;
}
async function deleteEditorBlocks(targetBlocks = null) {
  const item = editorItem();
  if (!item) return false;
  const blocksToRemove = Array.isArray(targetBlocks) && targetBlocks.length
    ? targetBlocks
    : (selectedEditorBlocks().length ? selectedEditorBlocks() : resolveToolbarTargetBlocks(item));
  if (!blocksToRemove.length) {
    toast('ابتدا یک یا چند کادر را برای حذف انتخاب کنید.', true);
    return false;
  }
  if (inlineDraft && blocksToRemove.includes(inlineDraft.block) && !closeInlineEditor()) return false;
  const hasAnyContent = blocksToRemove.some((b) => String(b.tr || '').trim() || String(b.text || '').trim() || String(b.richHtml || '').trim() || String(b.ocrRichHtml || '').trim());
  if (hasAnyContent) {
    const label = blocksToRemove.length === 1 ? `کادر شمارهٔ ${blocksToRemove[0].id}` : `${blocksToRemove.length} کادر انتخاب‌شده`;
    const ok = await appConfirm(`آیا مطمئن هستید که می‌خواهید ${label} را به‌طور کامل از این صفحه حذف کنید؟`, {
      title: 'حذف کادر متن',
      confirmText: 'بله، حذف شود',
      cancelText: 'انصراف',
      variant: 'danger',
      destructive: true,
    });
    if (!ok) return false;
  }
  const removeSet = new Set(blocksToRemove);
  item.blocks = (item.blocks || []).filter((b) => !removeSet.has(b));
  const remainingIds = new Set(item.blocks.map((b) => String(b.id)));
  state.selectedBlockIds = (state.selectedBlockIds || []).filter((id) => remainingIds.has(String(id)));
  if (!remainingIds.has(String(state.activeBlockId))) state.activeBlockId = state.selectedBlockIds.at(-1) || null;
  buildBlockList();
  drawEditor();
  scheduleSave();
  toast(blocksToRemove.length === 1 ? 'کادر حذف شد' : `${blocksToRemove.length} کادر حذف شد`);
  return true;
}
function buildBlockList() {
  const item = editorItem(); const list = $('blockList'); list.textContent = ''; const selected = new Set(editorSelectedKeys());
  if (!item?.blocks?.length) {
    const emptyWrap = document.createElement('div');
    emptyWrap.className = 'block-empty-state';
    const msg = document.createElement('div');
    msg.textContent = 'ابتدا OCR را روی این تصویر اجرا کنید یا همین حالا با دکمه‌های زیر کادر متن دلخواه (فارسی یا انگلیسی) روی صفحه بگذارید:';
    const actionsRow = document.createElement('div');
    actionsRow.className = 'block-empty-actions';
    actionsRow.append(
      makeButton('+ متن فارسی', () => addManualEditorBlock('fa'), 'bt primary'),
      makeButton('+ متن انگلیسی', () => addManualEditorBlock('en'), 'bt'),
    );
    emptyWrap.append(msg, actionsRow);
    list.appendChild(emptyWrap);
    updateEditorSelection();
    return;
  }
  item.blocks.forEach((block) => {
    const card = document.createElement('section'); card.className = `block-card${block.enabled ? '' : ' disabled'}${selected.has(String(block.id)) ? ' selected' : ''}${String(state.activeBlockId) === String(block.id) ? ' active' : ''}`; card.dataset.id = block.id; card.addEventListener('pointerdown', (event) => { const additive = event.ctrlKey || event.metaKey; if (additive && inlineDraft && !closeInlineEditor()) return; selectEditorBlock(block.id, false, additive); });
    const head = document.createElement('div'); head.className = 'block-head'; const enabledLabel = document.createElement('label'); const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = !!block.enabled; enabled.dataset.visibility = 'sidebar'; enabled.setAttribute('aria-label', `نمایش متن ${block.id} روی تصویر`); enabledLabel.append(enabled, document.createTextNode(block.manual ? ` نمایش متن ${block.id} روی تصویر · کادر دستی` : ` نمایش متن ${block.id} روی تصویر · اطمینان ${Math.round(block.conf || 0)}٪`)); head.appendChild(enabledLabel);
    const isHeading = block.pageRole === 'heading';
    const roleBtn = document.createElement('button');
    roleBtn.type = 'button';
    roleBtn.className = `block-role-pill${isHeading ? ' is-heading' : ''}`;
    roleBtn.dataset.roleToggle = String(block.id);
    roleBtn.textContent = isHeading ? 'تیتر' : 'متن';
    roleBtn.setAttribute('aria-pressed', isHeading ? 'true' : 'false');
    roleBtn.setAttribute('aria-label', `تغییر نقش کادر ${block.id} بین تیتر و متن معمولی`);
    roleBtn.title = isHeading
      ? 'این کادر «تیتر» است؛ برای تبدیل به «متن معمولی» کلیک کنید'
      : 'این کادر «متن معمولی» است؛ برای تبدیل به «تیتر» (بولد و درشت‌تر) کلیک کنید';
    roleBtn.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    roleBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (inlineDraft?.block === block && !closeInlineEditor()) return;
      const nextHeading = block.pageRole !== 'heading';
      block.pageRole = nextHeading ? 'heading' : 'paragraph';
      if (nextHeading) {
        const rawLh = Number(block.lineH) || Math.max(16, (Number(block.y1) || 0) - (Number(block.y0) || 0)) || 22;
        block.bold = true;
        block.size = Math.max(14, Math.min(36, Math.round(rawLh * 0.78)));
        block.align = block.dir === 'ltr' ? 'left' : 'right';
        block.verticalAlign = 'middle';
      } else {
        block.bold = !!block._detectedBold;
        block.size = block.tr ? 12 : null;
        block.align = block.tr ? 'justify' : 'right';
        block.verticalAlign = 'top';
      }
      buildBlockList();
      drawEditor();
      scheduleSave();
    });
    head.appendChild(roleBtn);
    const bg = document.createElement('select'); [['auto', 'پس‌زمینه خودکار'], ['white', 'سفید'], ['black', 'مشکی'], ['none', 'بدون پاک‌کردن']].forEach(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; bg.appendChild(option); });
    if (/^#[0-9a-fA-F]{6}$/.test(String(block.bg || ''))) {
      const customOpt = document.createElement('option');
      customOpt.value = String(block.bg);
      customOpt.textContent = `رنگ ${String(block.bg).toUpperCase()}`;
      bg.appendChild(customOpt);
    }
    bg.value = block.bg || 'auto'; head.appendChild(bg);
    const languageRow = document.createElement('div'); languageRow.className = 'block-tools block-language-tools';
    const languageLabel = document.createElement('label'); languageLabel.className = 'block-language-label'; languageLabel.appendChild(document.createTextNode('نمایش همین متن:'));
    const language = document.createElement('select'); language.dataset.textMode = 'sidebar'; language.setAttribute('aria-label', `زبان نمایش متن ${block.id} روی تصویر`); [['translation', 'فارسی / ترجمه'], ['ocr', 'انگلیسی / OCR']].forEach(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; language.appendChild(option); }); language.value = blockTextMode(block); languageLabel.appendChild(language); languageRow.appendChild(languageLabel);
    const metaBadges = [];
    if (block.manual) metaBadges.push(['دستی', 'کادر اضافه‌شدهٔ دستی — در اجرای مجدد OCR حفظ می‌شود', 'block-manual-chip']);
    if (block.fontFamily && canonicalFontOption(block.fontFamily) !== 'Vazirmatn') metaBadges.push([canonicalFontOption(block.fontFamily), `فونت انتخابی کادر: ${canonicalFontOption(block.fontFamily)}`]);
    const shKey = normalizeShapeKey(block.shape);
    const shapeNames = { ellipse: 'بیضی', pill: 'کپسولی', diamond: 'لوزی', hexagon: 'شش‌ضلعی', cloud: 'ابر کمیک' };
    if (shKey !== 'rect' && shapeNames[shKey]) metaBadges.push([shapeNames[shKey], `شکل کادر: ${shapeNames[shKey]}`]);
    else if (shKey === 'rect' && normalizeRadiusPct(block.cornerRadius) > 0) metaBadges.push([`گوشه ${normalizeRadiusPct(block.cornerRadius)}٪`, 'گوشه‌های گرد مستطیل']);
    if (normalizeAngleDeg(block.angle) !== 0) metaBadges.push([`↻ ${normalizeAngleDeg(block.angle)}°`, `زاویهٔ چرخش کادر: ${normalizeAngleDeg(block.angle)} درجه`]);
    if (block.bold) metaBadges.push(['B', 'تشخیص/قالب پررنگ (Bold)']);
    if (block.italic) metaBadges.push(['I', 'تشخیص/قالب کج (Italic)']);
    if ((Number(block.firstLineIndent) || 0) >= 0.5 || (!isHeading && (Number(block.sourceIndent) || 0) >= 2)) metaBadges.push(['↳ تورفتگی', 'دارای تورفتگی نسبت به حاشیهٔ ستون']);
    if ((Number(block.hangingIndent) || 0) >= 0.5 || (Number(block.blockOutdent) || 0) >= 0.5) metaBadges.push(['↰ بیرون‌زدگی', 'دارای بیرون‌زدگی خط اول / حاشیه']);
    metaBadges.forEach(([txt, tip, extraCls]) => {
      const chip = document.createElement('span');
      chip.className = `block-style-chip${extraCls ? ` ${extraCls}` : ''}`;
      chip.textContent = txt;
      chip.title = tip;
      languageRow.appendChild(chip);
    });
    const source = document.createElement('p'); source.className = 'block-readonly block-source-edit'; source.dir = 'auto'; source.textContent = `متن اصلی: ${block.text || '—'}`; source.tabIndex = 0; source.setAttribute('role', 'button'); source.setAttribute('aria-label', `ویرایش متن انگلیسی/OCR کادر ${block.id}`); source.title = 'برای ویرایش متن اصلی کلیک کنید';
    if (block.bold) source.style.fontWeight = '700';
    if (block.italic) source.style.fontStyle = 'italic';
    if (!isHeading && (Number(block.sourceIndent) || 0) > 0) source.style.paddingInlineStart = `${Math.min(36, Math.round((Number(block.sourceIndent) || 0) * 3.5))}px`;
    source.addEventListener('click', () => editOcrText(block));
    source.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); editOcrText(block); } });
    const translation = document.createElement('p'); translation.className = 'block-readonly block-tr-edit'; translation.dir = 'auto'; translation.textContent = `ترجمه: ${block.tr || '—'}`; translation.tabIndex = 0; translation.setAttribute('role', 'button'); translation.setAttribute('aria-label', `ویرایش ترجمهٔ کادر ${block.id} روی تصویر`); translation.title = 'برای ویرایش ترجمه روی تصویر کلیک کنید';
    if (block.bold) translation.style.fontWeight = '700';
    if (block.italic) translation.style.fontStyle = 'italic';
    const openBlockTranslation = () => { if (!block.enabled || blockOverlayMode(block) === 'none') { toast('ابتدا نمایش متن روی تصویر را فعال کنید.', true); return; } if (blockTextMode(block) === 'ocr') setBlockTextMode(block, 'translation'); openInlineEditor(block); };
    translation.addEventListener('click', openBlockTranslation);
    translation.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openBlockTranslation(); } });
    const actions = document.createElement('div'); actions.className = 'block-tools block-card-actions';
    const trBtnLabel = String(block.tr || '').trim() && String(block.text || '').trim() ? 'ترجمهٔ دوباره' : 'ترجمهٔ این کادر';
    actions.append(
      makeBlockToolButton('<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a2 2 0 0 1 2-2h11"/><path d="M14.5 11.5v6"/><path d="M11.5 14.5h6"/>', 'تکثیر کادر', () => duplicateEditorBlocks([block]), 'block-duplicate-btn'),
      makeBlockToolButton('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', 'کپی متن اصلی', () => copyBlockText(block.text || '').catch((e) => toast(e.message, true))),
      makeBlockToolButton('<path d="M21 12a9 9 0 0 0-15.5-6.36L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 15.5 6.36L21 16"/><path d="M16 16h5v5"/>', trBtnLabel, () => retranslateBlock(block), 'block-retranslate-btn'),
      makeBlockToolButton('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>', 'پاک‌کردن ترجمه', async () => {
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
      }, 'block-clear-btn'),
      makeBlockToolButton('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', 'حذف کادر', () => {
        deleteEditorBlocks([block]).catch((e) => toast(e.message, true));
      }, 'block-clear-btn block-delete-btn'),
    );
    enabled.addEventListener('change', () => setBlockVisibility(block, enabled.checked)); language.addEventListener('change', () => setBlockTextMode(block, language.value)); bg.addEventListener('change', () => { block.bg = bg.value; drawEditor(); scheduleSave(); });
    card.append(head, languageRow, source, translation, actions); list.appendChild(card);
  });
  updateEditorSelection();
}
async function applyEditor() {
  const item = editorItem(); if (!item) return !inlineDraft; if (!applyInlineEditor()) return false;
  if (editorSessionSnapshot && editorSessionSnapshot.imageId === item.id) editorSessionSnapshot.serverPreviewTouched = true;
  $('editorProgressWrap')?.classList.remove('hidden'); setProgress('editorProgress', 0.25, true);
  try { await overlayPreviewTask; setProgress('editorProgress', 0.55, true); await saveProject(); await renderAndUpload(item); renderGrid(); setProgress('editorProgress', 1, false); return true; }
  finally { $('editorProgressWrap')?.classList.add('hidden'); }
}
async function closeEditor(markApproved = false) {
  if (imageOverview) await exitImageOverview();
  if (editorCloseTask) return editorCloseTask;
  editorCloseTask = (async () => {
    const item = editorItem();
    if (item ? !applyInlineEditor() : !!inlineDraft) return;
    const returnScroll = editorReturnScroll ? { ...editorReturnScroll } : (item ? captureEditorReturnScroll(item.id) : null);
    editorLoadSeq += 1;
    if (item) {
      if (markApproved === true) item.approved = true;
      await overlayPreviewTask;
      await saveProject();
      await renderAndUpload(item);
    }
    editorSessionSnapshot = null;
    editorReturnScroll = null;
    if (editorCanvasFrame) { cancelAnimationFrame(editorCanvasFrame); editorCanvasFrame = 0; }
    closeDialog('editorDialog'); state.editorBitmap?.close?.(); state.editorBitmap = null; $('editorCanvas').width = $('editorCanvas').height = 0; state.editorId = null; state.editorPan = null; state.activeBlockId = null; state.selectedBlockIds = [];
    if (item) renderGrid();
    restoreEditorReturnScroll(returnScroll);
    if (item && markApproved === true) toast('تغییرات ذخیره شد و مهر تأیید نهایی روی صفحه ثبت گردید');
  })();
  try { await editorCloseTask; } finally { editorCloseTask = null; }
}
async function cancelEditor() {
  if (imageOverview) await exitImageOverview();
  if (editorCloseTask) return editorCloseTask;
  editorCloseTask = (async () => {
    const item = editorItem();
    const snap = editorSessionSnapshot;
    const returnScroll = editorReturnScroll ? { ...editorReturnScroll } : (item ? captureEditorReturnScroll(item.id) : null);
    const hadInlineDraft = !!inlineDraft;
    const hadPendingSave = savePending;
    discardInlineEditorForCancel();
    clearTimeout(saveTimer); savePending = false;
    editorLoadSeq += 1;
    let shouldRenderGrid = false;
    if (item && snap && state.project?.id === snap.projectId && item.id === snap.imageId) {
      const changedBlocks = JSON.stringify(item.blocks || []) !== snap.blocksJson;
      const changedWatermark = JSON.stringify(item.watermark || null) !== snap.watermarkJson;
      const changedApproved = !!item.approved !== snap.approved;
      const changedMode = currentOverlayMode() !== snap.overlayMode;
      item.blocks = JSON.parse(snap.blocksJson);
      item.watermark = JSON.parse(snap.watermarkJson || 'null');
      item.approved = snap.approved;
      restoreProjectImageDrafts(snap.projectId, snap.imageId, snap.draftEntries);
      if (changedMode) {
        state.project.settings = state.project.settings || {};
        state.project.settings.overlayMode = snap.overlayMode;
        $('overlayMode').value = snap.overlayMode;
        $('exportOverlayMode').value = snap.overlayMode;
      }
      if (changedBlocks || changedWatermark || changedApproved || changedMode || hadInlineDraft || hadPendingSave || snap.autoSaved || snap.serverPreviewTouched) {
        await overlayPreviewTask;
        await saveProject();
        if (changedMode) await renderImagesText();
        else await renderAndUpload(item);
      }
      shouldRenderGrid = true;
    }
    editorSessionSnapshot = null;
    editorReturnScroll = null;
    if (editorCanvasFrame) { cancelAnimationFrame(editorCanvasFrame); editorCanvasFrame = 0; }
    closeDialog('editorDialog'); state.editorBitmap?.close?.(); state.editorBitmap = null; $('editorCanvas').width = $('editorCanvas').height = 0; state.editorId = null; state.editorPan = null; state.activeBlockId = null; state.selectedBlockIds = [];
    if (shouldRenderGrid) renderGrid();
    restoreEditorReturnScroll(returnScroll);
    toast('ویرایش این صفحه بدون ذخیرهٔ تغییرات بسته شد');
  })();
  try { await editorCloseTask; } finally { editorCloseTask = null; }
}
async function revertEditor() {
  const item = editorItem(); if (!item || !closeInlineEditor()) return;
  if (editorSessionSnapshot && editorSessionSnapshot.imageId === item.id) editorSessionSnapshot.serverPreviewTouched = true;
  item.blocks.forEach((block) => { block.enabled = false; }); await saveProject(); await renderAndUpload(item); drawEditor(); buildBlockList(); renderGrid(); toast('تصویر اصلی بازیابی شد؛ متن‌ها برای استفادهٔ بعدی باقی ماندند');
}

// ---------- Crop with aspect ratio, moving, and eight handles ----------
function cropItem() { return state.project?.images.find((item) => item.id === state.cropId); }
function openCrop(imageId) {
  if (!isModuleLicensed('editing')) { ensureModuleLicensed('editing').catch(() => {}); return; }
  const item = state.project?.images.find((entry) => entry.id === imageId);
  if (!item) return;
  state.cropId = imageId;
  state.crop = item.crop ? { ...item.crop } : null;
  $('cropRatio').value = String(item.crop?.ratio || 0);
  const img = $('cropImage');
  img.onload = () => { normalizeCropInputs(); drawCropRect(); };
  img.src = imageUrl(item, !!item.edited);
  showDialog('cropDialog');
  if (img.complete && img.naturalWidth) { normalizeCropInputs(); drawCropRect(); }
}
function normalizeCropInputs() { const item = cropItem(); if (!item) return; const crop = state.crop || { x: 0, y: 0, w: item.width, h: item.height }; $('cropX').value = Math.round(crop.x); $('cropY').value = Math.round(crop.y); $('cropW').value = Math.round(crop.w); $('cropH').value = Math.round(crop.h); }
function readCropInputs(event) { const item = cropItem(); if (!item) return; const x = Math.max(0, Math.min(item.width - 1, Number($('cropX').value) || 0)); const y = Math.max(0, Math.min(item.height - 1, Number($('cropY').value) || 0)); let w = Math.max(1, Math.min(item.width - x, Number($('cropW').value) || 1)); let h = Math.max(1, Math.min(item.height - y, Number($('cropH').value) || 1)); const ratio = Number($('cropRatio').value); if (ratio > 0) { if (event?.target?.id === 'cropH') { w = Math.min(item.width - x, h * ratio); h = w / ratio; } else { h = Math.min(item.height - y, w / ratio); w = h * ratio; } } state.crop = { x, y, w, h, ratio: ratio || 0 }; drawCropRect(); }
function drawCropRect() { const item = cropItem(); const rect = $('cropRect'); if (!item || !state.crop || !$('cropImage').clientWidth) { rect.style.display = 'none'; return; } const sx = $('cropImage').clientWidth / item.width; const sy = $('cropImage').clientHeight / item.height; rect.style.display = 'block'; rect.style.left = `${state.crop.x * sx}px`; rect.style.top = `${state.crop.y * sy}px`; rect.style.width = `${state.crop.w * sx}px`; rect.style.height = `${state.crop.h * sy}px`; }
function changeCropRatio() { const item = cropItem(); const ratio = Number($('cropRatio').value); if (!item || !ratio) { if (state.crop) state.crop.ratio = 0; return; } const old = state.crop || { x: 0, y: 0, w: item.width, h: item.height }; const cx = old.x + old.w / 2; const cy = old.y + old.h / 2; let w = Math.min(item.width, old.w); let h = w / ratio; if (h > item.height) { h = item.height; w = h * ratio; } state.crop = { x: Math.max(0, Math.min(item.width - w, cx - w / 2)), y: Math.max(0, Math.min(item.height - h, cy - h / 2)), w, h, ratio }; normalizeCropInputs(); drawCropRect(); }
function cropPointerDown(event) {
  const item = cropItem(); if (!item) return; const bounds = $('cropImage').getBoundingClientRect(); if (bounds.width <= 0 || bounds.height <= 0) return; const handle = event.target.closest('#cropRect i'); const inside = event.target.closest('#cropRect');
  let mode = 'draw'; let dir = ''; if (handle) { mode = 'resize'; dir = handle.dataset.dir; } else if (inside && state.crop) mode = 'move';
  state.cropPointer = { mode, dir, x: event.clientX, y: event.clientY, bounds, original: state.crop ? { ...state.crop } : null }; $('cropStage').setPointerCapture(event.pointerId); event.preventDefault();
}
function cropPointerMove(event) {
  const start = state.cropPointer; const item = cropItem(); if (!start || !item) return; const b = start.bounds; if (b.width <= 0 || b.height <= 0) return; const sx = item.width / b.width; const sy = item.height / b.height; const dx = (event.clientX - start.x) * sx; const dy = (event.clientY - start.y) * sy; const ratio = Number($('cropRatio').value) || 0;
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

// ---------- Watermark (Text + Transparent Logo) ----------
let wmPreviewBitmap = null;
let wmPreviewImageId = null;
let wmAngleTouched = false;

function defaultWatermarkConfig() {
  return {
    enabled: true,
    text: '',
    logoId: '',
    logoScalePct: 9,
    position: 'bottom-left',
    sizePct: 3.5,
    opacity: 55,
    angle: 0,
    marginPct: 2.5,
    tileGapPct: 22,
    color: '#ffffff',
    bold: true,
    outline: true,
    outlineColor: '#000000',
    bgPill: false,
    bgColor: '#000000',
  };
}

function watermarkTargetPages(scope = null) {
  const images = sortedImages();
  const chosen = scope || $('wmTargetScope')?.value || 'selected';
  if (chosen === 'editor') {
    const ed = editorItem();
    return ed ? [ed] : [];
  }
  if (chosen === 'all') return images;
  const sel = selectedImages();
  return sel.length ? sel : images;
}

function populateWatermarkLogoSelect(selectedId = '') {
  const sel = $('wmLogoSelect');
  if (!sel) return;
  const logos = projectWatermarkLogos();
  sel.textContent = '';
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = 'بدون لوگو (فقط متن)';
  sel.appendChild(noneOpt);
  Object.values(logos).forEach((entry) => {
    if (!entry || !entry.id) return;
    const opt = document.createElement('option');
    opt.value = entry.id;
    opt.textContent = entry.name || entry.id;
    sel.appendChild(opt);
  });
  sel.value = selectedId && logos[selectedId] ? selectedId : '';
  if ($('wmLogoDeleteBtn')) $('wmLogoDeleteBtn').disabled = !sel.value;
}

function readWatermarkDialogForm() {
  return {
    enabled: true,
    text: String($('wmText')?.value || ''),
    logoId: String($('wmLogoSelect')?.value || ''),
    logoScalePct: Number($('wmLogoScale')?.value) || 9,
    position: String($('wmPosition')?.value || 'bottom-left'),
    sizePct: Number($('wmSize')?.value) || 3.5,
    opacity: Number($('wmOpacity')?.value) || 55,
    angle: Number($('wmAngle')?.value) || 0,
    marginPct: Number($('wmMargin')?.value) || 2.5,
    tileGapPct: Number($('wmTileGap')?.value) || 22,
    color: String($('wmColor')?.value || '#ffffff'),
    bold: Boolean($('wmBold')?.checked),
    outline: Boolean($('wmOutline')?.checked),
    outlineColor: String($('wmOutlineColor')?.value || '#000000'),
    bgPill: Boolean($('wmBgPill')?.checked),
    bgColor: String($('wmBgColor')?.value || '#000000'),
  };
}

function syncWatermarkRangeOutputs() {
  if ($('wmLogoScaleOut') && $('wmLogoScale')) $('wmLogoScaleOut').textContent = `${$('wmLogoScale').value}%`;
  if ($('wmSizeOut') && $('wmSize')) $('wmSizeOut').textContent = `${$('wmSize').value}%`;
  if ($('wmOpacityOut') && $('wmOpacity')) $('wmOpacityOut').textContent = `${$('wmOpacity').value}%`;
  if ($('wmAngleOut') && $('wmAngle')) $('wmAngleOut').textContent = `${$('wmAngle').value}°`;
  if ($('wmMarginOut') && $('wmMargin')) $('wmMarginOut').textContent = `${$('wmMargin').value}%`;
  if ($('wmTileGapOut') && $('wmTileGap')) $('wmTileGapOut').textContent = `${$('wmTileGap').value}%`;
  const pos = $('wmPosition')?.value || 'bottom-left';
  $('wmMarginWrap')?.classList.toggle('hidden', pos === 'center' || pos === 'diagonal' || pos === 'tile');
  $('wmTileGapWrap')?.classList.toggle('hidden', pos !== 'tile');
  if ($('wmLogoDeleteBtn') && $('wmLogoSelect')) $('wmLogoDeleteBtn').disabled = !$('wmLogoSelect').value;
}

function fillWatermarkDialogForm(wm) {
  const cfg = { ...defaultWatermarkConfig(), ...(wm && typeof wm === 'object' ? wm : {}) };
  if ($('wmText')) $('wmText').value = cfg.text || '';
  populateWatermarkLogoSelect(cfg.logoId || '');
  if ($('wmLogoScale')) $('wmLogoScale').value = String(cfg.logoScalePct ?? 9);
  if ($('wmPosition')) $('wmPosition').value = cfg.position || 'bottom-left';
  if ($('wmSize')) $('wmSize').value = String(cfg.sizePct ?? 3.5);
  if ($('wmOpacity')) $('wmOpacity').value = String(cfg.opacity ?? 55);
  const effectiveAngle = cfg.angle !== undefined && cfg.angle !== null && cfg.angle !== ''
    ? Number(cfg.angle)
    : ((cfg.position === 'diagonal' || cfg.position === 'tile') ? -30 : 0);
  if ($('wmAngle')) $('wmAngle').value = String(Number.isFinite(effectiveAngle) ? effectiveAngle : 0);
  if ($('wmMargin')) $('wmMargin').value = String(cfg.marginPct ?? 2.5);
  if ($('wmTileGap')) $('wmTileGap').value = String(cfg.tileGapPct ?? 22);
  if ($('wmColor')) $('wmColor').value = /^#[0-9a-fA-F]{6}$/.test(String(cfg.color || '')) ? cfg.color : '#ffffff';
  if ($('wmBold')) $('wmBold').checked = cfg.bold !== false;
  if ($('wmOutline')) $('wmOutline').checked = cfg.outline !== false;
  if ($('wmOutlineColor')) $('wmOutlineColor').value = /^#[0-9a-fA-F]{6}$/.test(String(cfg.outlineColor || '')) ? cfg.outlineColor : '#000000';
  if ($('wmBgPill')) $('wmBgPill').checked = Boolean(cfg.bgPill);
  if ($('wmBgColor')) $('wmBgColor').value = /^#[0-9a-fA-F]{6}$/.test(String(cfg.bgColor || '')) ? cfg.bgColor : '#000000';
  wmAngleTouched = Boolean(cfg.angle && Number(cfg.angle) !== 0 && Number(cfg.angle) !== -30);
  syncWatermarkRangeOutputs();
}

async function loadWatermarkPreviewBitmap(sampleItem) {
  if (!sampleItem) return null;
  if (state.editorId === sampleItem.id && state.editorBitmap) return state.editorBitmap;
  if (wmPreviewBitmap && wmPreviewImageId === sampleItem.id) return wmPreviewBitmap;
  try {
    const res = await fetch(imageUrl(sampleItem, false));
    if (!res.ok) return null;
    const bmp = await decodeProjectImageBitmap(await res.blob(), sampleItem);
    if (wmPreviewBitmap && wmPreviewBitmap !== state.editorBitmap) wmPreviewBitmap.close?.();
    wmPreviewBitmap = bmp;
    wmPreviewImageId = sampleItem.id;
    return bmp;
  } catch {
    return null;
  }
}

async function drawWatermarkDialogPreview() {
  const cv = $('wmPreviewCanvas');
  if (!cv) return;
  const targets = watermarkTargetPages();
  const sample = targets[0] || sortedImages()[0] || null;
  if ($('wmPreviewCaption')) {
    $('wmPreviewCaption').textContent = sample
      ? `پیش‌نمایش زنده روی «${sample.name}» (${targets.length.toLocaleString('fa-IR')} صفحهٔ هدف)`
      : 'پیش‌نمایش زنده';
  }
  const wm = readWatermarkDialogForm();
  await ensureWatermarkLogosReady(wm);
  const bmp = await loadWatermarkPreviewBitmap(sample);
  const srcW = bmp?.width || sample?.width || 600;
  const srcH = bmp?.height || sample?.height || 840;
  const maxSide = 520;
  const ratio = Math.min(1, maxSide / Math.max(srcW, srcH, 1));
  const W = Math.max(180, Math.round(srcW * ratio));
  const H = Math.max(180, Math.round(srcH * ratio));
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  ctx.clearRect?.(0, 0, W, H);
  if (bmp) {
    ctx.drawImage?.(bmp, 0, 0, W, H);
  } else if (typeof ctx.fillRect === 'function') {
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(0, 0, W, H);
  }
  if (hasActiveWatermark(wm) && typeof Typeset?.drawWatermark === 'function') {
    Typeset.drawWatermark(ctx, W, H, wm, projectWatermarkLogos());
  }
}

function readBlobAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (typeof FileReader === 'function') {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('خواندن فایل لوگو ناموفق بود'));
      reader.readAsDataURL(file);
      return;
    }
    if (typeof file.arrayBuffer === 'function') {
      file.arrayBuffer().then((buf) => {
        const bytes = new Uint8Array(buf);
        let bin = '';
        bytes.forEach((b) => { bin += String.fromCharCode(b); });
        resolve(`data:${file.type || 'image/png'};base64,${btoa(bin)}`);
      }, reject);
      return;
    }
    reject(new Error('خواندن فایل لوگو پشتیبانی نمی‌شود'));
  });
}

async function handleWatermarkLogoUpload(file) {
  if (!file || !state.project) return;
  if (file.size > 6 * 1024 * 1024) {
    toast('حجم فایل لوگو نباید بیشتر از ۶ مگابایت باشد.', true);
    return;
  }
  const dataUrl = await readBlobAsDataUrl(file);
  if (!dataUrl.startsWith('data:image/')) {
    toast('فقط فایل‌های تصویری (PNG، WebP، SVG، JPG) برای لوگو مجاز هستند.', true);
    return;
  }
  state.project.settings = state.project.settings || {};
  state.project.settings.watermarkLogos = projectWatermarkLogos();
  const logoId = `logo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const cleanLabel = String(file.name || 'logo.png').replace(/\.[^.]+$/, '').slice(0, 48) || 'لوگو';
  state.project.settings.watermarkLogos[logoId] = {
    id: logoId,
    name: cleanLabel,
    dataUrl,
  };
  await ensureWatermarkLogoDrawable(logoId, dataUrl);
  populateWatermarkLogoSelect(logoId);
  scheduleSave();
  await drawWatermarkDialogPreview();
  toast(`لوگوی «${cleanLabel}» اضافه و انتخاب شد`);
}

async function deleteSelectedWatermarkLogo() {
  const logoId = String($('wmLogoSelect')?.value || '').trim();
  if (!logoId || !state.project) return;
  const logos = projectWatermarkLogos();
  const entry = logos[logoId];
  if (!entry) return;
  const usedCount = (state.project.images || []).filter((img) => img.watermark?.logoId === logoId).length;
  const msg = usedCount
    ? `لوگوی «${entry.name}» روی ${usedCount.toLocaleString('fa-IR')} صفحه استفاده شده است. آیا از فهرست لوگوها و آن صفحات حذف شود؟`
    : `آیا لوگوی «${entry.name}» از فهرست لوگوهای پروژه حذف شود؟`;
  const ok = await appConfirm(msg, {
    title: 'حذف لوگوی واترمارک',
    confirmText: 'بله، حذف شود',
    cancelText: 'انصراف',
    variant: 'danger',
    destructive: true,
  });
  if (!ok) return;
  delete logos[logoId];
  for (const [cacheKey, drawable] of [...watermarkLogoCache.entries()]) {
    if (cacheKey === logoId || cacheKey.startsWith(`${logoId}:`)) {
      try { drawable?.close?.(); } catch { /* ignore */ }
      watermarkLogoCache.delete(cacheKey);
    }
  }
  const affectedIds = [];
  (state.project.images || []).forEach((img) => {
    if (img.watermark?.logoId === logoId) {
      img.watermark.logoId = '';
      if (!hasActiveWatermark(img.watermark)) img.watermark = null;
      affectedIds.push(img.id);
    }
  });
  populateWatermarkLogoSelect('');
  await saveProject();
  if (affectedIds.length) await renderImagesText(affectedIds);
  if (state.editorId) drawEditorCanvas();
  await drawWatermarkDialogPreview();
  toast('لوگو حذف شد');
}

async function openWatermarkDialog(fromEditor = false) {
  if (!isModuleLicensed('editing')) { await ensureModuleLicensed('editing'); return; }
  if (!state.project?.images?.length) {
    toast('ابتدا حداقل یک صفحه یا فایل به پروژه وارد کنید.', true);
    return;
  }
  await ensureFont();
  const scopeSelect = $('wmTargetScope');
  const totalCount = state.project.images.length;
  const selCount = selectedImages().length;
  const inEditor = Boolean(fromEditor && editorItem());
  if (scopeSelect) {
    scopeSelect.textContent = '';
    if (inEditor) {
      const optEd = document.createElement('option');
      optEd.value = 'editor';
      optEd.textContent = `فقط همین صفحهٔ در حال ویرایش (${editorItem().name})`;
      scopeSelect.appendChild(optEd);
    }
    if (selCount > 0) {
      const optSel = document.createElement('option');
      optSel.value = 'selected';
      optSel.textContent = `صفحات انتخاب‌شده (${selCount.toLocaleString('fa-IR')} از ${totalCount.toLocaleString('fa-IR')} صفحه)`;
      scopeSelect.appendChild(optSel);
    }
    const optAll = document.createElement('option');
    optAll.value = 'all';
    optAll.textContent = `همهٔ صفحات پروژه (${totalCount.toLocaleString('fa-IR')} صفحه)`;
    scopeSelect.appendChild(optAll);
    scopeSelect.value = inEditor ? 'editor' : (selCount > 0 ? 'selected' : 'all');
  }
  const initialSource = (inEditor && editorItem()?.watermark)
    || selectedImages().find((img) => hasActiveWatermark(img.watermark))?.watermark
    || state.project.images.find((img) => hasActiveWatermark(img.watermark))?.watermark
    || state.project.settings?.watermarkPreset
    || defaultWatermarkConfig();
  fillWatermarkDialogForm(initialSource);
  showDialog('watermarkDialog');
  await drawWatermarkDialogPreview();
}

async function applyWatermarkFromDialog() {
  if (!state.project) return;
  const wm = readWatermarkDialogForm();
  if (!hasActiveWatermark(wm)) {
    toast('لطفاً متن واترمارک را بنویسید یا یک لوگو انتخاب کنید (برای پاک‌کردن، دکمهٔ «حذف واترمارک» را بزنید).', true);
    return;
  }
  const scope = $('wmTargetScope')?.value || 'selected';
  const targets = watermarkTargetPages(scope);
  if (!targets.length) {
    toast('صفحه‌ای برای اعمال واترمارک انتخاب نشده است.', true);
    return;
  }
  await ensureWatermarkLogosReady(wm);
  state.project.settings = state.project.settings || {};
  state.project.settings.watermarkPreset = { ...wm };
  targets.forEach((img) => {
    img.watermark = { ...wm, enabled: true };
  });
  closeDialog('watermarkDialog');
  if (scope === 'editor' && editorItem() && targets.length === 1 && targets[0].id === state.editorId) {
    drawEditorCanvas();
    scheduleSave();
    toast('واترمارک روی این صفحه قرار گرفت');
    return;
  }
  if (state.editorId && targets.some((t) => t.id === state.editorId)) {
    drawEditorCanvas();
  }
  await runJob(`در حال اعمال واترمارک روی ${targets.length.toLocaleString('fa-IR')} صفحه…`, async (signal) => {
    const checkCancel = () => {
      if (signal?.aborted) {
        const err = new Error('اعمال واترمارک لغو شد.');
        err.name = 'AbortError'; err.cancelled = true;
        throw err;
      }
    };
    await saveProject();
    await renderImagesText(targets.map((t) => t.id), null, checkCancel);
  }, 'jobProgress');
  renderGrid();
  toast(`واترمارک روی ${targets.length.toLocaleString('fa-IR')} صفحه اعمال شد`);
}

async function removeWatermarkFromDialog() {
  if (!state.project) return;
  const scope = $('wmTargetScope')?.value || 'selected';
  const targets = watermarkTargetPages(scope);
  const activeTargets = targets.filter((img) => hasActiveWatermark(img.watermark));
  if (!activeTargets.length) {
    closeDialog('watermarkDialog');
    toast('صفحات انتخابی واترمارک فعالی ندارند');
    return;
  }
  const ok = await appConfirm(`آیا واترمارک از ${activeTargets.length.toLocaleString('fa-IR')} صفحه حذف شود؟`, {
    title: 'حذف واترمارک',
    confirmText: 'بله، حذف شود',
    cancelText: 'انصراف',
    variant: 'danger',
    destructive: true,
  });
  if (!ok) return;
  activeTargets.forEach((img) => { img.watermark = null; });
  closeDialog('watermarkDialog');
  if (scope === 'editor' && editorItem() && activeTargets.length === 1 && activeTargets[0].id === state.editorId) {
    drawEditorCanvas();
    scheduleSave();
    toast('واترمارک این صفحه حذف شد');
    return;
  }
  if (state.editorId && activeTargets.some((t) => t.id === state.editorId)) {
    drawEditorCanvas();
  }
  await runJob(`در حال حذف واترمارک از ${activeTargets.length.toLocaleString('fa-IR')} صفحه…`, async (signal) => {
    const checkCancel = () => {
      if (signal?.aborted) {
        const err = new Error('حذف واترمارک لغو شد.');
        err.name = 'AbortError'; err.cancelled = true;
        throw err;
      }
    };
    await saveProject();
    await renderImagesText(activeTargets.map((t) => t.id), null, checkCancel);
  }, 'jobProgress');
  renderGrid();
  toast(`واترمارک از ${activeTargets.length.toLocaleString('fa-IR')} صفحه حذف شد`);
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
        else if (dlg.id === 'pptxExportDialog') requestCancelExport('pptxExportDialog').catch(() => {});
        else if (dlg.id === 'modelsDialog') requestCancelModelJob().catch(() => {});
        else if (dlg.id === 'aiDialog') requestCancelAiDialog().catch(() => {});
        else if (dlg.id === 'translationPreviewDialog') cancelTranslationRequestPreview();
        else closeDialog(dlg.id);
      });
    });
  });
  $('appModalConfirm')?.addEventListener('click', () => resolveActiveModal(true));
  $('appModalCancel')?.addEventListener('click', () => resolveActiveModal(false));
  $('appModalClose')?.addEventListener('click', () => resolveActiveModal(false));
  $('appModalInput')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && activeModalState?.promptMode) {
      event.preventDefault();
      resolveActiveModal(true);
    }
  });
  $('appModalDialog')?.addEventListener('cancel', (event) => { event.preventDefault(); resolveActiveModal(false); });
  $('appModalDialog')?.addEventListener('close', () => { if (activeModalState && !$('appModalDialog')?.open) resolveActiveModal(false); });
  $('dockCancelJobBtn')?.addEventListener('click', () => requestCancelActiveJob().catch(() => {}));
  $('editorCancelJobBtn')?.addEventListener('click', () => requestCancelActiveJob().catch(() => {}));
  $('ocrQuickCancelBtn')?.addEventListener('click', () => requestCancelModelJob({ closeModelsDialog: false }).catch(() => {}));
  $('cancelExportBtn')?.addEventListener('click', () => requestCancelExport('exportDialog').catch(() => {}));
  $('themeBtn').addEventListener('click', () => { document.body.classList.toggle('light'); localStorage.setItem('comic-studio-theme', document.body.classList.contains('light') ? 'light' : 'dark'); });
  $('backupProjectBtn').addEventListener('click', () => backupCurrentProject().catch(() => {}));
  $('restoreProjectBtn').addEventListener('click', () => $('restoreProjectInput').click());
  $('restoreProjectInput').addEventListener('change', () => restoreProjectBackup($('restoreProjectInput').files?.[0]).catch(() => {}).finally(() => { $('restoreProjectInput').value = ''; }));
  $('newProjectBtn').addEventListener('click', async () => {
    const projectName = await appPrompt('نام پروژهٔ جدید را وارد کنید (پروژهٔ فعلی شما ذخیره و محفوظ می‌ماند):', {
      title: 'ساخت پروژهٔ جدید',
      inputLabel: 'نام پروژهٔ جدید',
      placeholder: 'مثلاً: جلد اول تن‌تن یا فصل ۳ کتاب زیست',
      defaultValue: '',
      fallbackValue: 'پروژهٔ کمیک',
      confirmText: 'ساخت پروژه',
      cancelText: 'انصراف',
      variant: 'confirm',
    });
    if (projectName === null) return;
    await saveProject(); await clearActivity(false);
    adoptProject(await api('/api/projects', jsonOptions('POST', { name: projectName })));
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
  $('projectName').addEventListener('input', () => {
    if (!state.project) return;
    const nextProjName = $('projectName').value.trim();
    const out = state.project.settings?.output;
    if ((!out || !out.nameCustomized) && nextProjName) $('exportName').value = nextProjName;
  });
  $('projectName').addEventListener('change', () => {
    if (!state.project) return;
    const nextName = $('projectName').value.trim() || state.project.name || 'پروژهٔ کمیک';
    $('projectName').value = nextName;
    state.project.name = nextName;
    state.project.settings = state.project.settings || {};
    const out = state.project.settings.output || {};
    if (!out.nameCustomized) {
      $('exportName').value = nextName;
      out.name = nextName;
      out.nameCustomized = false;
      state.project.settings.output = out;
    }
    scheduleSave();
    refreshProjectList().catch(() => {});
  });
  $('exportName').addEventListener('input', () => {
    if (!state.project) return;
    state.project.settings = state.project.settings || {};
    const projName = String(state.project.name || '').trim() || 'پروژهٔ کمیک';
    const trimmed = $('exportName').value.trim();
    state.project.settings.output = {
      ...(state.project.settings.output || {}),
      name: trimmed || projName,
      nameCustomized: Boolean(trimmed && trimmed !== projName),
    };
    scheduleSave();
  });
  $('exportName').addEventListener('change', () => {
    if (!state.project) return;
    const projName = String(state.project.name || '').trim() || 'پروژهٔ کمیک';
    if (!$('exportName').value.trim()) $('exportName').value = projName;
    collectOutputSettings();
    scheduleSave();
  });
  $('fileInput').addEventListener('change', () => importFiles($('fileInput').files).catch(() => {}).finally(() => { $('fileInput').value = ''; }));
  $('selectAllBtn').addEventListener('click', () => { state.project.images.forEach((item) => { item.selected = true; }); renderGrid(); scheduleSave(); });
  $('selectNoneBtn').addEventListener('click', () => { state.project.images.forEach((item) => { item.selected = false; }); renderGrid(); scheduleSave(); });
  $('invertBtn').addEventListener('click', () => { state.project.images.forEach((item) => { item.selected = !item.selected; }); renderGrid(); scheduleSave(); });
  $('groupBtn').addEventListener('click', () => { if (state.groupEditId) return finishGroupEdit(false); const ids = selectedImages().map((item) => item.id); if (ids.length < 2) { toast('برای گروه‌سازی حداقل دو تصویر انتخاب کنید', true); return; } const id = G.create(state.project.images, ids); renderGrid(); scheduleSave(); toast(`گروه ${id} ساخته یا ادغام شد`); });
  $('ungroupBtn').addEventListener('click', () => { const ids = selectedImages().map((item) => item.id); G.ungroup(state.project.images, ids); renderGrid(); scheduleSave(); });
  $('cancelGroupEdit').addEventListener('click', () => finishGroupEdit(true));
  $('duplicateBtn').addEventListener('click', () => duplicateImages(selectedImages().map((item) => item.id)).catch((error) => toast(error.message, true)));
  $('deleteBtn').addEventListener('click', () => deleteImages(selectedImages().map((item) => item.id)).catch((error) => toast(error.message, true)));
  $('approveSelectedBtn')?.addEventListener('click', () => {
    const items = selectedImages();
    if (!items.length) { toast('ابتدا حداقل یک صفحه را انتخاب کنید', true); return; }
    items.forEach((item) => { item.approved = true; });
    renderGrid(); scheduleSave();
    toast(`مهر تأیید روی ${items.length} صفحه ثبت شد`);
  });
  $('unapproveSelectedBtn')?.addEventListener('click', () => {
    const items = selectedImages();
    if (!items.length) { toast('ابتدا حداقل یک صفحه را انتخاب کنید', true); return; }
    items.forEach((item) => { item.approved = false; });
    renderGrid(); scheduleSave();
    toast(`مهر تأیید از ${items.length} صفحه برداشته شد`);
  });
  $('selectApprovedBtn')?.addEventListener('click', () => {
    const images = state.project?.images || [];
    const approvedCount = images.filter((item) => item.approved).length;
    if (!approvedCount) { toast('هنوز هیچ صفحه‌ای تأیید نهایی نشده است', true); return; }
    images.forEach((item) => { item.selected = !!item.approved; });
    renderGrid(); scheduleSave();
    toast(`${approvedCount} صفحهٔ تأییدشده انتخاب شد (آمادهٔ خروجی گرفتن)`);
  });
  $('selectUnapprovedBtn')?.addEventListener('click', () => {
    const images = state.project?.images || [];
    const unapprovedCount = images.filter((item) => !item.approved).length;
    if (!unapprovedCount) { toast('همهٔ صفحات پروژه تأیید نهایی شده‌اند'); return; }
    images.forEach((item) => { item.selected = !item.approved; });
    renderGrid(); scheduleSave();
    toast(`${unapprovedCount} صفحهٔ تأییدنشده انتخاب شد`);
  });
  $('dragGuideBtn')?.addEventListener('click', (event) => {
    event.stopPropagation();
    const wrap = $('dragGuideBtn').closest('.drag-guide-wrap');
    if (!wrap) return;
    const nextOpen = !wrap.classList.contains('is-open');
    wrap.classList.toggle('is-open', nextOpen);
    $('dragGuideBtn').setAttribute('aria-expanded', String(nextOpen));
  });
  document.addEventListener('click', (event) => {
    const wrap = $('dragGuideBtn')?.closest('.drag-guide-wrap');
    if (wrap?.classList.contains('is-open') && !wrap.contains(event.target)) {
      wrap.classList.remove('is-open');
      $('dragGuideBtn')?.setAttribute('aria-expanded', 'false');
    }
  });
  $('ocrBtn').addEventListener('click', () => {
    if (!isModuleLicensed('ocr')) { ensureModuleLicensed('ocr').catch(() => {}); return; }
    clearPendingTranslationOcr(); $('ocrStatus').textContent = ''; $('copyOcrError').classList.add('hidden'); updateEngineOptions(); showDialog('ocrDialog');
  });
  $('ocrEngine').addEventListener('change', () => { collectOcrSettings(); updateOcrEngineStatus(); scheduleSave(); });
  $('ocrPersianPreprocess')?.addEventListener('change', () => {
    if (state.project) {
      state.project.settings = state.project.settings || {};
      state.project.settings.persianPreprocessCustomized = true;
    }
    collectOcrSettings();
    scheduleSave();
  });
  $('ocrLanguage').addEventListener('change', () => {
    const nextLang = $('ocrLanguage').value;
    if ($('modelsLanguage')) $('modelsLanguage').value = nextLang;
    if ($('testLanguage')) $('testLanguage').value = nextLang;
    if ($('ocrPersianPreprocess') && state.project?.settings?.persianPreprocessCustomized !== true) {
      $('ocrPersianPreprocess').checked = nextLang === 'fas';
    }
    const pageMode = normalizePageMode($('ocrPageMode')?.value || state.project?.settings?.ocrPageMode);
    const prevId = $('ocrEngine').value;
    const prevEng = state.engines.find((entry) => entry.id === prevId);
    const prevSupports = Boolean(prevEng && (prevEng.languages || []).includes(nextLang));
    const prevReady = Boolean(prevSupports && prevEng.runtimeInstalled && (prevEng.readyLanguages || []).includes(nextLang));
    const prevTier = prevEng ? engineSuitability(prevEng, pageMode, nextLang).tier : 'weak';
    const anyReadyForLang = state.engines.some(
      (entry) => entry.selectable !== false && entry.runtimeInstalled && (entry.readyLanguages || []).includes(nextLang),
    );
    const anyBestReadyForLang = state.engines.some(
      (entry) => entry.selectable !== false
        && entry.runtimeInstalled
        && (entry.readyLanguages || []).includes(nextLang)
        && engineSuitability(entry, pageMode, nextLang).tier === 'best',
    );
    const shouldAutoUpgrade = !prevSupports
      || (!prevReady && anyReadyForLang)
      || (prevTier !== 'best' && anyBestReadyForLang);
    const targetEngine = shouldAutoUpgrade
      ? pickBestEngineForLanguage(nextLang, pageMode, '')
      : prevId;
    updateEngineOptions(targetEngine, { resort: true });
    collectOcrSettings();
    scheduleSave();
    if ($('modelsDialog')?.open) renderModels({ resort: true });
  });
  $('ocrPageMode')?.addEventListener('change', () => {
    const lang = $('ocrLanguage')?.value || state.project?.settings?.ocrLanguage || 'eng';
    const nextMode = normalizePageMode($('ocrPageMode')?.value);
    const curId = $('ocrEngine')?.value || '';
    const curEng = state.engines.find((entry) => entry.id === curId);
    const curTier = curEng ? engineSuitability(curEng, nextMode, lang).tier : 'weak';
    const hasBestReady = state.engines.some(
      (entry) => entry.selectable !== false
        && entry.runtimeInstalled
        && (entry.readyLanguages || []).includes(lang)
        && engineSuitability(entry, nextMode, lang).tier === 'best',
    );
    const nextTarget = (curTier !== 'best' && hasBestReady)
      ? pickBestEngineForLanguage(lang, nextMode, '')
      : '';
    if ($('modelsPageMode')) $('modelsPageMode').value = $('ocrPageMode').value;
    updateEngineOptions(nextTarget, { resort: true });
    collectOcrSettings();
    scheduleSave();
    if ($('modelsDialog')?.open) renderModels({ resort: true });
  });
  $('ocrQuickPrepareBtn')?.addEventListener('click', () => {
    const engine = state.engines.find((entry) => entry.id === $('ocrEngine').value);
    if (engine) downloadEngine(engine, { languageOverride: $('ocrLanguage').value, fromOcrDialog: true }).catch(() => {});
  });
  $('ocrQuickUpdateBtn')?.addEventListener('click', () => {
    const engine = state.engines.find((entry) => entry.id === $('ocrEngine').value);
    if (engine) updateEngine(engine, { languageOverride: $('ocrLanguage').value, fromOcrDialog: true }).catch(() => {});
  });
  $('startOcrBtn').addEventListener('click', () => runOcr().catch(() => {})); $('cancelOcrBtn')?.addEventListener('click', () => requestCancelOcrDialog().catch(() => {})); $('cancelTranslationBtn')?.addEventListener('click', () => requestCancelTranslationDialog().catch(() => {})); $('translateBtn').addEventListener('click', () => runTranslation().catch(() => {}));
  $('ocrDialog').addEventListener('cancel', (event) => {
    if ((ocrRunning && !ocrClosingNormally) || (state.modelBusy && modelFromOcrDialog)) { event.preventDefault(); requestCancelOcrDialog().catch(() => {}); }
  });
  $('ocrDialog').addEventListener('close', () => {
    if (ocrRunning && !ocrClosingNormally) abortRunningOcr();
    if (!$('ocrDialog').open) clearPendingTranslationOcr();
  });
  $('copyOcrError').addEventListener('click', () => copyBlockText($('ocrStatus').textContent).catch(error => toast(`کپی ممکن نبود: ${error.message || error}`, true)));
  $('copyTranslationPreviewError').addEventListener('click', () => copyBlockText($('translationPreviewError').textContent).catch(error => toast(`کپی ممکن نبود: ${error.message || error}`, true)));
  $('openAiLimitFromPreview')?.addEventListener('click', openAiSettingsFromPreviewDialog);
  $('openAiSettingsFromPreview')?.addEventListener('click', openAiSettingsFromPreviewDialog);
  $('translationPreviewService')?.addEventListener('change', (event) => {
    switchTranslationPreviewService(event.target.value).catch(() => {});
  });
  $('translationTargetLang')?.addEventListener('change', (event) => {
    switchTranslationTargetLanguage(event.target.value).catch(() => {});
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
  $('pptxExportDialog')?.addEventListener('cancel', (event) => {
    if (exportRunning) { event.preventDefault(); requestCancelExport('pptxExportDialog').catch(() => {}); }
  });
  $('modelsDialog')?.addEventListener('cancel', (event) => {
    if (state.modelBusy) { event.preventDefault(); requestCancelModelJob().catch(() => {}); }
  });
  $('aiDialog')?.addEventListener('cancel', (event) => {
    if (localNmtBusyModel || localNmtTestAbortController) { event.preventDefault(); requestCancelAiDialog().catch(() => {}); }
  });
  $('copyAiError').addEventListener('click', () => copyBlockText($('aiStatus').textContent).catch((error) => toast(error.message, true)));
  $('copyTranslationSkill')?.addEventListener('click', () => copyFieldText($('translationSkill'), 'راهنمای ترجمه').catch((error) => toast(error.message || String(error), true)));
  $('pasteTranslationSkill')?.addEventListener('click', () => pasteIntoField($('translationSkill')).catch((error) => toast(error.message || String(error), true)));
  $('clearTranslationSkill')?.addEventListener('click', () => clearFieldText($('translationSkill')));
  $('copyTranslationContext')?.addEventListener('click', () => copyFieldText($('translationContext'), 'خلاصهٔ زمینه').catch((error) => toast(error.message || String(error), true)));
  $('pasteTranslationContext')?.addEventListener('click', () => pasteIntoField($('translationContext')).catch((error) => toast(error.message || String(error), true)));
  $('clearTranslationContext')?.addEventListener('click', () => clearFieldText($('translationContext')));
  $('translationSkill').addEventListener('input', updateTranslationSkillStatus); $('translationContext').addEventListener('input', updateTranslationSkillStatus); $('translationContextResume').addEventListener('change', updateTranslationSkillStatus);
  $('translationSkillReset').addEventListener('click', () => { $('translationSkill').value = translationPreviewData?.defaultSkill ?? ''; updateTranslationSkillStatus(); });
  $('translationPreviewConfirm').addEventListener('click', () => confirmTranslationRequestPreview().catch(() => {})); $('translationPreviewCancel').addEventListener('click', cancelTranslationRequestPreview); $('translationPreviewDialog').addEventListener('close', () => { if (!$('translationPreviewDialog').open) { translationPreviewAction = null; translationPreviewRefresh = null; translationPreviewSwitchTarget = null; translationPreviewData = null; } });
  $('modelsBtn').addEventListener('click', () => {
    setMenuOpen(false);
    if (!isModuleLicensed('ocr')) { ensureModuleLicensed('ocr').catch(() => {}); return; }
    if ($('modelsInstalledOnly')) $('modelsInstalledOnly').checked = false;
    if ($('modelsPageMode') && $('ocrPageMode')) $('modelsPageMode').value = $('ocrPageMode').value;
    if ($('modelsLanguage') && $('ocrLanguage')) $('modelsLanguage').value = $('ocrLanguage').value;
    if ($('testLanguage') && $('ocrLanguage')) $('testLanguage').value = $('ocrLanguage').value;
    renderModels();
    showDialog('modelsDialog');
    refreshEngineMemory().catch(() => {});
  });
  $('modelsInstalledOnly')?.addEventListener('change', () => renderModels());
  $('modelsLanguage')?.addEventListener('change', () => {
    if ($('testLanguage')) $('testLanguage').value = $('modelsLanguage').value;
    renderModels({ resort: true });
  });
  $('testLanguage').addEventListener('change', () => {
    if ($('modelsLanguage')) $('modelsLanguage').value = $('testLanguage').value;
    renderModels({ resort: true });
  });
  $('modelsPageMode')?.addEventListener('change', () => renderModels({ resort: true }));
  $('freeModelsRamBtn')?.addEventListener('click', () => freeModelsRam().catch(() => {}));
  $('modelsStorageBtn')?.addEventListener('click', () => openStorageDialog().catch((error) => toast(error.message || String(error), true)));
  $('storageBtn')?.addEventListener('click', () => openStorageDialog().catch((error) => toast(error.message || String(error), true)));
  $('storageBrowseBtn')?.addEventListener('click', () => browseStorageFolder().catch(() => {}));
  $('storageMigrateExisting')?.addEventListener('change', syncStorageCheckboxState);
  $('storageSaveBtn')?.addEventListener('click', () => submitStorageSettings(null).catch(() => {}));
  $('storageResetDefaultBtn')?.addEventListener('click', () => submitStorageSettings('').catch(() => {}));
  $('storageDialog')?.addEventListener('cancel', (event) => {
    if (storageSwitchBusy) event.preventDefault();
  });
  $('resourcesBtn')?.addEventListener('click', () => openResourcesDialog().catch((error) => toast(error.message || String(error), true)));
  $('resourcesSaveBtn')?.addEventListener('click', () => submitResourceBudget().catch(() => {}));
  $('resourcesAutoMode')?.addEventListener('change', () => {
    const manual = !$('resourcesAutoMode')?.checked;
    $('resourcesManualBox')?.classList.toggle('hidden', !manual);
    [$('resourcesCpuPercent'), $('resourcesRamPercent')].forEach((el) => { if (el) el.disabled = !manual; });
    if ($('resourcesModeBadge')) {
      $('resourcesModeBadge').textContent = manual ? 'دستی' : 'خودکار';
      $('resourcesModeBadge').classList.toggle('is-local', !manual);
    }
  });
  $('resourcesCpuPercent')?.addEventListener('input', syncResourceSliderLabels);
  $('resourcesRamPercent')?.addEventListener('input', syncResourceSliderLabels);
  $('checkModelUpdatesBtn')?.addEventListener('click', () => checkEngineUpdates({ force: true, silent: false }).catch(() => {}));
  $('updateAllModelsBtn')?.addEventListener('click', () => updateAllEngines().catch(() => {}));
  $('modelsActiveCancelBtn')?.addEventListener('click', () => requestCancelModelJob().catch(() => {}));
  $('engineUpdateNowBtn')?.addEventListener('click', () => {
    if (!isModuleLicensed('ocr')) { ensureModuleLicensed('ocr').catch(() => {}); return; }
    if (!$('modelsDialog').open) { renderModels(); showDialog('modelsDialog'); }
    updateAllEngines().catch(() => {});
  });
  $('engineUpdateOpenModelsBtn')?.addEventListener('click', () => {
    if (!isModuleLicensed('ocr')) { ensureModuleLicensed('ocr').catch(() => {}); return; }
    renderModels();
    showDialog('modelsDialog');
    refreshEngineMemory().catch(() => {});
  });
  $('engineUpdateDismissBtn')?.addEventListener('click', () => { engineUpdateNoticeDismissed = true; syncEngineUpdateUi(); });
  if (!helpController && window.ComicHelpGuide?.createHelpController) {
    helpController = window.ComicHelpGuide.createHelpController();
  }
  $('helpTopBtn')?.addEventListener('click', () => openHelpDialog(document.body.classList.contains('auth-locked') ? 'license-login-security' : null));
  $('licenseTopStatusBtn')?.addEventListener('click', () => { openLicenseDialog().catch((error) => toast(error.detailText || error.message, true)); });
  $('licenseBtn')?.addEventListener('click', () => { setMenuOpen(false); openLicenseDialog().catch((error) => toast(error.detailText || error.message, true)); });
  $('trialBannerOpenLicBtn')?.addEventListener('click', () => { openLicenseDialog({ focusRenew: true }).catch((error) => toast(error.detailText || error.message, true)); });
  $('lockAppMenuBtn')?.addEventListener('click', () => { setMenuOpen(false); lockWorkspaceNow().catch((error) => toast(error.detailText || error.message, true)); });
  $('lockNowInsideDialogBtn')?.addEventListener('click', () => { closeDialog('licenseDialog'); lockWorkspaceNow().catch((error) => toast(error.detailText || error.message, true)); });
  $('licenseDialogDoneBtn')?.addEventListener('click', () => closeDialog('licenseDialog'));
  $('copyGateHwidBtn')?.addEventListener('click', () => copyTextWithToast($('gateHardwareId')?.textContent || '', 'کد سیستم در کلیپ‌بورد کپی شد'));
  $('copyDialogHwidBtn')?.addEventListener('click', () => copyTextWithToast($('licInfoHwid')?.textContent || '', 'کد سیستم در کلیپ‌بورد کپی شد'));
  $('copyGateOrderMsgBtn')?.addEventListener('click', () => copyTextWithToast(buildCustomerOrderRequestText($('gateHardwareId')?.textContent || ''), 'متن آمادهٔ سفارش لایسنس کپی شد؛ آن را برای فروشنده ارسال کنید'));
  $('copyDialogOrderMsgBtn')?.addEventListener('click', () => copyTextWithToast(buildCustomerOrderRequestText($('licInfoHwid')?.textContent || ''), 'متن آمادهٔ سفارش لایسنس کپی شد؛ آن را برای فروشنده ارسال کنید'));
  $('pasteGateLicenseBtn')?.addEventListener('click', async () => {
    try {
      const clip = await navigator.clipboard?.readText?.();
      if (clip && $('gateLicenseKeyInput')) {
        $('gateLicenseKeyInput').value = clip.trim();
        toast('کلید لایسنس چسبانده شد');
      } else {
        toast('کلیپ‌بورد خالی است یا مرورگر اجازهٔ خواندن مستقیم نداد (با Ctrl+V بچسبانید)', true);
      }
    } catch {
      toast('با کلیدهای Ctrl+V کلید لایسنس را در کادر بچسبانید', true);
    }
  });
  $('activateGateLicenseBtn')?.addEventListener('click', () => submitGateLicenseActivation().catch(() => {}));
  $('switchToActivatePaneBtn')?.addEventListener('click', () => {
    if (state.licenseStatus) applyAuthGateUi(state.licenseStatus, { forceActivatePane: true });
  });
  $('backToLoginPaneBtn')?.addEventListener('click', () => {
    if (state.licenseStatus) applyAuthGateUi(state.licenseStatus, { forceActivatePane: false });
  });
  $('toggleGatePwdVisBtn')?.addEventListener('click', () => {
    const inp = $('gateLoginPasswordInput');
    if (!inp) return;
    const isPwd = inp.type === 'password';
    inp.type = isPwd ? 'text' : 'password';
    if ($('toggleGatePwdVisBtn')) $('toggleGatePwdVisBtn').textContent = isPwd ? 'پنهان' : 'نمایش';
  });
  $('gateLoginSubmitBtn')?.addEventListener('click', () => submitGatePasswordLogin().catch(() => {}));
  $('gateLoginPasswordInput')?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); submitGatePasswordLogin().catch(() => {}); }
  });
  $('saveLocalPwdBtn')?.addEventListener('click', () => saveLocalPasswordFromDialog().catch(() => {}));
  $('removeLocalPwdBtn')?.addEventListener('click', () => removeLocalPasswordFromDialog().catch(() => {}));
  $('dialogActivateNewBtn')?.addEventListener('click', () => activateNewLicenseFromDialog().catch(() => {}));
  $('editorOpenFullHelpBtn')?.addEventListener('click', () => openHelpDialog('visual-editor'));
  $('helpDialogClose')?.addEventListener('click', (event) => { event.preventDefault(); closeDialog('helpDialog'); });
  $('aiBtn').addEventListener('click', () => {
    setMenuOpen(false);
    if (!isModuleLicensed('translation')) { ensureModuleLicensed('translation').catch(() => {}); return; }
    setProgress('aiProgress', 0, false);
    loadAiSettings().then(() => { showDialog('aiDialog'); }).catch((error) => toast(error.message, true));
  }); $('aiProvider').addEventListener('change', () => showAiProvider($('aiProvider').value)); $('aiBaseUrl')?.addEventListener('input', syncAiExecUi); $('localNmtModelSelect')?.addEventListener('change', () => renderLocalNmtPanel()); $('localNmtCancelBtn')?.addEventListener('click', () => cancelLocalNmtPrepare().catch(() => {})); $('localNmtUnloadBtn')?.addEventListener('click', () => unloadLocalNmtRam().catch(() => {})); $('localNmtTestBtn')?.addEventListener('click', () => testLocalNmtSample().catch(() => {})); $('aiAddProfile').addEventListener('click', () => { aiEditorProfiles.push(makeAiProfile()); renderAiProfiles(); }); $('saveAiBtn').addEventListener('click', async () => { $('saveAiBtn').disabled = true; setProgress('aiProgress', null, true); try { await saveAiSettings(); setProgress('aiProgress', 1, false); closeDialog('aiDialog'); } catch (error) { setProgress('aiProgress', 0, false); $('aiStatus').textContent = error.message; $('copyAiError').classList.remove('hidden'); toast(error.message, true); } finally { $('saveAiBtn').disabled = false; } });
  $('exportBtn').addEventListener('click', () => { updateExportFields(); showDialog('exportDialog'); }); $('exportKind').addEventListener('change', updateExportFields); $('overlayMode').addEventListener('change', () => setOverlayMode($('overlayMode').value)); $('exportOverlayMode').addEventListener('change', () => setOverlayMode($('exportOverlayMode').value)); $('startExportBtn').addEventListener('click', () => runJob('در حال ساخت خروجی…', (signal) => exportResult(null, null, null, signal), 'exportProgress').catch(() => {})); $('exportPdfBtn').addEventListener('click', () => runJob('در حال ساخت PDF…', (signal) => exportResult('pdf', null, null, signal), 'exportProgress').catch(() => {})); $('exportImagesBtn').addEventListener('click', () => runJob('در حال ساخت ZIP…', (signal) => exportResult('images', null, null, signal), 'exportProgress').catch(() => {})); $('exportTxtBtn').addEventListener('click', () => runJob('در حال ساخت TXT…', (signal) => exportResult('txt', null, null, signal), 'exportProgress').catch(() => {})); $('exportDocxBtn')?.addEventListener('click', () => openDocxExportPrompt()); $('docxChoiceTranslation')?.addEventListener('click', () => runDocxChoiceExport('translation', 'visual').catch(() => {})); $('docxChoiceOcr')?.addEventListener('click', () => runDocxChoiceExport('ocr', 'visual').catch(() => {})); $('docxChoiceFlowingTranslation')?.addEventListener('click', () => runDocxChoiceExport('translation', 'flowing').catch(() => {})); $('docxChoiceFlowingOcr')?.addEventListener('click', () => runDocxChoiceExport('ocr', 'flowing').catch(() => {})); $('docxExportCancel')?.addEventListener('click', () => requestCancelExport('docxExportDialog').catch(() => {})); $('exportPptxBtn')?.addEventListener('click', () => openPptxExportPrompt()); $('pptxChoiceTranslation')?.addEventListener('click', () => runPptxChoiceExport('translation', 'visual').catch(() => {})); $('pptxChoiceOcr')?.addEventListener('click', () => runPptxChoiceExport('ocr', 'visual').catch(() => {})); $('pptxChoiceFlowingTranslation')?.addEventListener('click', () => runPptxChoiceExport('translation', 'flowing').catch(() => {})); $('pptxChoiceFlowingOcr')?.addEventListener('click', () => runPptxChoiceExport('ocr', 'flowing').catch(() => {})); $('pptxExportCancel')?.addEventListener('click', () => requestCancelExport('pptxExportDialog').catch(() => {}));
  $('editorSelectAll').addEventListener('click', selectAllEditorBlocks); $('editorSelectNone').addEventListener('click', clearEditorSelection);
  $('editorMergeText').addEventListener('click', mergeSelectedText); $('editorSplitText').addEventListener('click', splitSelectedText);
  $('editorSameSize').addEventListener('click', sameSizeSelectedBoxes);
  [['editorAlignLeft', 'left'], ['editorAlignCenter', 'center'], ['editorAlignRight', 'right'], ['editorAlignTop', 'top'], ['editorAlignMiddle', 'middle'], ['editorAlignBottom', 'bottom']].forEach(([id, direction]) => $(id).addEventListener('click', () => alignSelectedBoxes(direction)));
  $('editorApply').addEventListener('click', () => applyEditor().catch((error) => toast(error.message, true)));
  $('editorClose').addEventListener('click', () => closeEditor(false).catch((error) => toast(error.message, true)));
  $('editorApproveClose')?.addEventListener('click', () => closeEditor(true).catch((error) => toast(error.message, true)));
  $('editorCancel')?.addEventListener('click', () => cancelEditor().catch((error) => toast(error.message, true)));
  $('editorUnapproveBtn')?.addEventListener('click', () => {
    const item = editorItem();
    if (!item) return;
    item.approved = false;
    syncEditorApprovalHeader(item);
    renderGrid();
    scheduleSave();
    toast('مهر تأیید این صفحه برداشته شد');
  });
  $('editorRevert').addEventListener('click', () => revertEditor().catch((error) => toast(error.message, true)));
  $('editorDialog').addEventListener('cancel', (event) => { event.preventDefault(); if (classicEditor?.hasOpenModal?.()) classicEditor.closeModal(); else if (imageOverview) exitImageOverview().catch((error) => toast(error.message, true)); else if (inlineDraft) closeInlineEditor(); else closeEditor(false).catch((error) => toast(error.message, true)); });
  $('inlineEditorApply').addEventListener('click', applyInlineEditor);
  $('inlinePreview').addEventListener('mousedown', (event) => event.preventDefault());
  $('inlinePreview').addEventListener('click', () => setInlineOutputPreview(inlineDraft ? !inlineDraft.showOutput : undefined));
  $('inlineEditorCancel').addEventListener('click', () => closeInlineEditor(true));
  classicEditor = window.createEditor('#inlineEditorField', {
    clearFormatId: 'inlineLineReset',
    onEnsureTarget: () => ensureInlineTargetSession(),
    formatBlock: (tag) => formatInlineBlockTag(tag),
    confirmDraft: (message) => appConfirm(message, {
      title: 'بازیابی پیش‌نویس ذخیره‌شده',
      confirmText: 'بله، بازیابی شود',
      cancelText: 'خیر، حذف پیش‌نویس',
      variant: 'warning',
    }),
    serializeHTML: serializeInlineFieldHtml,
    undo: () => { if (inlineDraft) restoreInlineHistory(-1); else restoreEditorPageHistory(-1); },
    redo: () => { if (inlineDraft) restoreInlineHistory(1); else restoreEditorPageHistory(1); },
    inlineCommand: (cmd) => toggleInlineCommand(cmd),
    clearFormat: () => resetInlineLineStyle(),
    align: (value) => setInlineLineStyle('textAlign', value),
    direction: (value) => setInlineLineStyle('direction', value),
    color: (value) => {
      if (!inlineDraft) { setInlineLineStyle('color', value, { restoreFocus: false }); return true; }
      ensureValidInlineRange();
      if (hasInlineWordSelection()) return applyInlineWordStyle({ color: value }, { restoreFocus: false });
      if (isInlineFieldEmpty()) {
        inlineDraft.color = value;
        if ($('inlineEditorColor')) $('inlineEditorColor').value = value;
        syncInlineLineControls(); refreshInlineTypography(); classicEditor.notifyChange();
        return true;
      }
      if (inlineDraft.range?.collapsed) { setInlineLineStyle('color', value, { restoreFocus: false }); return true; }
      return false;
    },
    onFullscreen: (enabled) => {
      if (!inlineDraft) return;
      const box = [...document.querySelectorAll('#editorBoxes .editor-box')].find((el) => el.dataset.id === String(inlineDraft.block.id));
      if (enabled) { classicEditor.field.style.padding = ''; classicEditor.detachField(); refreshInlineTypography(); }
      else if (box) { classicEditor.attachField(box); refreshInlineTypography(); }
    },
    onChange: () => { if (inlineDraft) { rememberInlineRange(); recordInlineHistory(); syncInlineLineControls(); refreshInlineTypography(); autoApplyInlineDraft(); updateEditorSelection(); } },
    getDraftMetadata: () => inlineDraft ? {
      dir: $('inlineEditorDirection').value,
      align: $('inlineEditorAlign').value,
      verticalAlign: $('inlineVerticalAlign').value,
      size: (inlineDraft.initialAutoSize && !inlineDraft.sizeTouched && $('inlineEditorSize').value.trim() === inlineDraft.initialSizeValue) ? '' : $('inlineEditorSize').value,
      color: inlineDraft.color,
      fontFamily: ($('inlineEditorFont')?.value || '').trim() || inlineDraft.fontFamily || '',
      bold: inlineDraft.bold,
      italic: inlineDraft.italic,
      underline: inlineDraft.underline,
      strike: !!inlineDraft.strike,
    } : null,
    onRestore: (meta) => {
      if (!inlineDraft || !meta) return;
      if (['rtl', 'ltr'].includes(meta.dir)) $('inlineEditorDirection').value = meta.dir;
      if (['right','left','center','justify'].includes(meta.align)) $('inlineEditorAlign').value = meta.align;
      if (['top','middle','bottom'].includes(meta.verticalAlign)) { inlineDraft.verticalAlignTouched = true; $('inlineVerticalAlign').value = meta.verticalAlign; }
      if (meta.size === '') { inlineDraft.sizeTouched = false; inlineDraft.initialAutoSize = true; const shown = String(effectiveInlineSize(inlineDraft.block)); $('inlineEditorSize').value = shown; inlineDraft.initialSizeValue = shown; }
      else if (+meta.size >= 8 && +meta.size <= 160) { inlineDraft.sizeTouched = true; inlineDraft.initialAutoSize = false; $('inlineEditorSize').value = meta.size; }
      if (meta.color === null || /^#[0-9a-f]{6}$/i.test(meta.color || '')) { inlineDraft.color = meta.color; $('inlineEditorColor').value = meta.color || effectiveInlineColor(inlineDraft.block); }
      if (typeof meta.fontFamily === 'string') {
        const canon = meta.fontFamily ? canonicalFontOption(meta.fontFamily) : '';
        const stored = canon && canon !== 'Vazirmatn' ? canon : '';
        inlineDraft.fontFamily = stored || null;
        if ($('inlineEditorFont')) $('inlineEditorFont').value = stored;
        if ($('inlineFontFamily')) $('inlineFontFamily').value = canon || 'Vazirmatn';
      }
      if (typeof meta.bold === 'boolean') inlineDraft.bold = meta.bold;
      if (typeof meta.italic === 'boolean') inlineDraft.italic = meta.italic;
      if (typeof meta.underline === 'boolean') inlineDraft.underline = meta.underline;
      if (typeof meta.strike === 'boolean') inlineDraft.strike = meta.strike;
      $('inlineEditorField').dir = $('inlineEditorDirection').value;
      $('inlineEditorField').style.textAlign = $('inlineEditorAlign').value;
      syncVerticalAlignButtons();
      refreshInlineTypography();
    },
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
    if ((inlineDraft?.showOutput || $('editorBoxes')?.classList.contains('preview-hide-boxes'))
      && !event.target.closest('#inlinePreview, #inlineEditorApply, #inlineEditorCancel, .editor-zoom-controls')) {
      setInlineOutputPreview(false);
    }
    const boxDetails = $('inlineEditor').querySelector('.inline-box-settings');
    if (boxDetails?.open && !event.target.closest('.inline-box-settings')) boxDetails.removeAttribute('open');
  }, true);
  $('inlineEditor').addEventListener('click', () => requestAnimationFrame(positionInlineEditor));
  $('inlineEditor').querySelector('details')?.addEventListener('toggle', () => requestAnimationFrame(positionInlineEditor));
  syncInlineDockIdleState();
  $('inlineFontFamily')?.addEventListener('change', () => {
    setSelectionOrBlockFont($('inlineFontFamily').value, { restoreFocus: false });
  });
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
  $('inlineEditorDirection').addEventListener('change', () => {
    if (!inlineDraft) { setInlineLineStyle('direction', $('inlineEditorDirection').value); return; }
    inlineField.dir = $('inlineEditorDirection').value; inlineField.style.direction = inlineField.dir; classicEditor.notifyChange();
  });
  $('inlineEditorAlign').addEventListener('change', () => {
    if (!inlineDraft) { setInlineLineStyle('textAlign', $('inlineEditorAlign').value); return; }
    inlineField.style.textAlign = $('inlineEditorAlign').value; classicEditor.notifyChange();
  });
  $('inlineVerticalAlign').addEventListener('change', () => {
    if (!inlineDraft) { setVerticalPlacement($('inlineVerticalAlign').value); return; }
    inlineDraft.verticalAlignTouched = true; syncVerticalAlignButtons(); classicEditor.notifyChange();
  });
  document.querySelectorAll('.inline-valign-btn').forEach((btn) => {
    btn.addEventListener('mousedown', (event) => event.preventDefault());
    btn.addEventListener('click', () => setVerticalPlacement(btn.dataset.valign));
  });
  $('inlineEditorColor').addEventListener('input', () => {
    if (!inlineDraft) { setInlineLineStyle('color', $('inlineEditorColor').value); return; }
    inlineDraft.color = $('inlineEditorColor').value; classicEditor.notifyChange();
  });
  $('inlineEditorAutoColor').addEventListener('click', () => {
    if (!inlineDraft) {
      const targets = resolveToolbarTargetBlocks({ autoSelectFirst: true });
      if (!targets.length) return;
      recordEditorPageHistory();
      targets.forEach((b) => { b.color = null; cleanBlockRichOverrides(b, { stripColor: true }); });
      $('inlineEditorColor').value = effectiveInlineColor({ ...targets[0], color: null });
      buildBlockList(); drawEditor(); scheduleSave();
      pushPostActionEditorPageHistory();
      return;
    }
    inlineDraft.color = null; $('inlineEditorColor').value = effectiveInlineColor({ ...inlineDraft.block, color: null }); classicEditor.notifyChange();
  });
  $('inlineEditorSize').addEventListener('input', () => {
    if (!inlineDraft) {
      const raw = $('inlineEditorSize').value.trim();
      setSelectionOrLineSize(raw ? `${raw}px` : '', { restoreFocus: false });
      return;
    }
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
  $('cropReset').addEventListener('click', () => {
    const item = cropItem();
    if (!item) { closeDialog('cropDialog'); return; }
    item.crop = null;
    state.crop = null;
    const projectId = state.project?.id;
    closeDialog('cropDialog');
    renderGrid();
    saveProject().then(() => {
      if (projectId && state.project?.id === projectId) {
        imagePreviewVersions.set(`${projectId}:${item.id}`, ++previewRevision);
        renderGrid();
      }
    }).catch((error) => toast(error.message, true));
  });
  $('cropApply').addEventListener('click', () => {
    const item = cropItem();
    if (!item) { closeDialog('cropDialog'); return; }
    readCropInputs();
    item.crop = state.crop;
    const projectId = state.project?.id;
    closeDialog('cropDialog');
    renderGrid();
    saveProject().then(() => {
      if (projectId && state.project?.id === projectId) {
        imagePreviewVersions.set(`${projectId}:${item.id}`, ++previewRevision);
        renderGrid();
      }
    }).catch((error) => toast(error.message, true));
  });
  $('ocrErase')?.addEventListener('change', () => {
    if (!state.project) return;
    state.project.settings = state.project.settings || {};
    state.project.settings.eraseOriginal = $('ocrErase').checked;
    if (state.editorId) { drawEditorCanvas(); scheduleSave(); }
    else queueOverlayPreviewRefresh();
  });
  $('watermarkBtn')?.addEventListener('click', () => openWatermarkDialog(false).catch((e) => toast(e.message, true)));
  $('editorWatermarkBtn')?.addEventListener('click', () => openWatermarkDialog(true).catch((e) => toast(e.message, true)));
  $('editorAddFaText')?.addEventListener('click', () => addManualEditorBlock('fa'));
  $('editorAddEnText')?.addEventListener('click', () => addManualEditorBlock('en'));
  $('editorTranslateBlock')?.addEventListener('click', () => translateSelectedEditorBlock());
  $('editorCopyBlock')?.addEventListener('click', () => copyEditorBlocks());
  $('editorPasteBlock')?.addEventListener('click', () => pasteCopiedEditorBlocks());
  $('editorDuplicateBlock')?.addEventListener('click', () => duplicateEditorBlocks());
  $('editorDeleteBlock')?.addEventListener('click', () => { deleteEditorBlocks().catch((e) => toast(e.message, true)); });
  $('editorBoxShape')?.addEventListener('change', () => {
    applyBoxShapeSettings({ shape: $('editorBoxShape').value });
  });
  $('editorBoxRadius')?.addEventListener('input', () => {
    const raw = $('editorBoxRadius').value.trim();
    if (raw === '') return;
    applyBoxShapeSettings({ cornerRadius: normalizeRadiusPct(raw) });
  });
  $('editorBoxRadius')?.addEventListener('change', () => {
    applyBoxShapeSettings({ cornerRadius: normalizeRadiusPct($('editorBoxRadius').value) });
  });
  $('editorBoxAngle')?.addEventListener('input', () => {
    const raw = $('editorBoxAngle').value.trim();
    if (raw === '' || raw === '-') return;
    const n = Number(raw);
    if (Number.isFinite(n)) applyBoxShapeSettings({ angle: normalizeAngleDeg(n) });
  });
  $('editorBoxAngle')?.addEventListener('change', () => {
    applyBoxShapeSettings({ angle: normalizeAngleDeg($('editorBoxAngle').value) });
  });
  $('editorRotateReset')?.addEventListener('click', () => {
    applyBoxShapeSettings({ angle: 0 });
  });
  $('editorBoxBg')?.addEventListener('change', () => {
    const val = $('editorBoxBg').value;
    if (val === 'custom') {
      const hex = ($('editorBoxBgColor')?.value || '#ffffff').toLowerCase();
      $('editorBoxBgColor')?.classList.remove('hidden');
      applyBoxShapeSettings({ bg: hex });
      return;
    }
    $('editorBoxBgColor')?.classList.add('hidden');
    applyBoxShapeSettings({ bg: val });
  });
  $('editorBoxBgColor')?.addEventListener('input', () => {
    const hex = ($('editorBoxBgColor')?.value || '#ffffff').toLowerCase();
    if ($('editorBoxBg')) $('editorBoxBg').value = 'custom';
    applyBoxShapeSettings({ bg: hex });
  });
  $('wmCancelBtn')?.addEventListener('click', () => closeDialog('watermarkDialog'));
  $('watermarkDialog')?.addEventListener('close', () => releaseWatermarkPreviewResources());
  $('wmApplyBtn')?.addEventListener('click', () => { applyWatermarkFromDialog().catch((e) => toast(e.message, true)); });
  $('wmRemoveBtn')?.addEventListener('click', () => { removeWatermarkFromDialog().catch((e) => toast(e.message, true)); });
  $('wmLogoInput')?.addEventListener('change', (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (file) handleWatermarkLogoUpload(file).catch((e) => toast(e.message, true));
  });
  $('wmLogoDeleteBtn')?.addEventListener('click', () => { deleteSelectedWatermarkLogo().catch((e) => toast(e.message, true)); });
  $('wmPosition')?.addEventListener('change', () => {
    const pos = $('wmPosition').value;
    if (!wmAngleTouched && $('wmAngle')) {
      $('wmAngle').value = (pos === 'diagonal' || pos === 'tile') ? '-30' : '0';
    }
    syncWatermarkRangeOutputs();
    drawWatermarkDialogPreview().catch(() => {});
  });
  $('wmAngle')?.addEventListener('input', () => {
    wmAngleTouched = true;
    syncWatermarkRangeOutputs();
    drawWatermarkDialogPreview().catch(() => {});
  });
  ['wmTargetScope', 'wmText', 'wmLogoSelect', 'wmLogoScale', 'wmSize', 'wmOpacity', 'wmMargin', 'wmTileGap', 'wmColor', 'wmBold', 'wmOutline', 'wmOutlineColor', 'wmBgPill', 'wmBgColor'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    const evtName = el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input';
    el.addEventListener(evtName, () => {
      syncWatermarkRangeOutputs();
      drawWatermarkDialogPreview().catch(() => {});
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'F1') {
      event.preventDefault();
      event.stopPropagation();
      if ($('helpDialog')?.open) {
        closeDialog('helpDialog');
        return;
      }
      const topDlg = [...openDialogStack].reverse().find((id) => $(id)?.open);
      const sectionByDialog = {
        licenseDialog: 'license-login-security',
        storageDialog: 'storage-memory-network',
        modelsDialog: 'ocr-models',
        ocrDialog: 'ocr-modes',
        aiDialog: 'ai-translation-settings',
        translationPreviewDialog: 'translation-preview-context',
        translationDialog: 'translation-preview-context',
        exportDialog: 'exports-docx-pdf',
        docxExportDialog: 'exports-docx-pdf',
        pptxExportDialog: 'exports-docx-pdf',
        cropDialog: 'import-grid-crop',
        watermarkDialog: 'import-grid-crop',
        pendingDialog: 'conflicts-cancel-errors',
        editorDialog: 'visual-editor',
      };
      const defaultHelpSec = document.body.classList.contains('auth-locked') ? 'license-login-security' : null;
      openHelpDialog((topDlg && sectionByDialog[topDlg]) || ($('editorDialog')?.open ? 'visual-editor' : defaultHelpSec));
      return;
    }
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
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && state.editorId && $('editorDialog')?.open) {
      const rawKey = (event.key || '').toLowerCase();
      const isSaveKey = event.code === 'KeyS' || rawKey === 's';
      if (isSaveKey) { event.preventDefault(); applyEditor().catch((error) => toast(error.message, true)); return; }
      const isCopyKey = event.code === 'KeyC' || rawKey === 'c';
      const isPasteKey = event.code === 'KeyV' || rawKey === 'v';
      if (isCopyKey || isPasteKey) {
        const topDlg = [...openDialogStack].reverse().find((id) => $(id)?.open);
        const editorIsTop = (!topDlg || topDlg === 'editorDialog') && !$('appModalDialog')?.open && !classicEditor?.hasOpenModal?.();
        const targetEl = event.target && typeof event.target.closest === 'function' ? event.target : null;
        const inEditable = Boolean(inlineDraft) || Boolean(targetEl?.closest('input, textarea, select, [contenteditable="true"]'));
        const hasDomTextSelection = Boolean(window.getSelection?.()?.toString?.()?.trim());
        if (editorIsTop && !inEditable && !(isCopyKey && hasDomTextSelection)) {
          if (isCopyKey && selectedEditorBlocks().length) {
            event.preventDefault();
            copyEditorBlocks();
            return;
          }
          if (isPasteKey && state.copiedEditorBlocks?.length) {
            event.preventDefault();
            pasteCopiedEditorBlocks();
            return;
          }
        }
      }
    }
    if (event.key === 'Enter' && state.cropId && $('cropDialog').open && !event.target.matches('input,select')) { event.preventDefault(); $('cropApply').click(); }
  });
  syncAiExecUi();
  if (localStorage.getItem('comic-studio-theme') === 'light') document.body.classList.add('light');
}
async function copyTextWithToast(rawText, okMsg) {
  const text = String(rawText || '').trim();
  if (!text) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      toast(okMsg);
      return;
    }
  } catch { /* fallback below */ }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', 'readonly');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try { document.execCommand('copy'); toast(okMsg); }
  catch { toast('کپی خودکار ممکن نشد؛ کد را انتخاب و با Ctrl+C کپی کنید', true); }
  finally { area.remove(); }
}

const DEFAULT_SUPPORT_PHONE = '09361111111';
const MODULE_TITLES_FA = {
  ocr: 'استخراج متن (OCR آفلاین)',
  translation: 'ترجمه',
  editing: 'ویرایش (ویرایشگر، برش و واترمارک)',
};
let trialCountdownTimer = null;

function isModuleLicensed(moduleId) {
  const st = state.licenseStatus;
  if (!st) return true;
  if (!st.licensed) return false;
  if (!st.modules || typeof st.modules !== 'object' || !(moduleId in st.modules)) return true;
  return Boolean(st.modules[moduleId]?.active);
}

async function ensureModuleLicensed(moduleId) {
  if (isModuleLicensed(moduleId)) return true;
  const phone = state.licenseStatus?.supportPhone || DEFAULT_SUPPORT_PHONE;
  const modTitle = MODULE_TITLES_FA[moduleId] || moduleId;
  const openLic = await appConfirm(
    `لایسنس بخش «${modTitle}» روی سیستم شما فعال نیست یا مهلت آن پایان یافته است.\n\nبرای تهیه یا تمدید لایسنس این بخش، با شمارهٔ ${phone} تماس بگیرید و سپس کلید دریافتی را ثبت کنید.`,
    {
      title: `نیاز به لایسنس بخش «${modTitle}»`,
      confirmText: 'ثبت کلید لایسنس',
      cancelText: 'بستن',
      variant: 'warning',
    },
  );
  if (openLic) {
    await openLicenseDialog({ focusRenew: true });
  }
  return false;
}

function formatDurationDetailedFa(seconds) {
  const sec = Math.max(0, Number(seconds) || 0);
  if (sec <= 0) return '۰ دقیقه';
  const totalMins = Math.max(1, Math.ceil(sec / 60));
  const days = Math.floor(totalMins / 1440);
  const hrs = Math.floor((totalMins % 1440) / 60);
  const mins = totalMins % 60;
  if (days > 0) {
    return hrs > 0
      ? `${days.toLocaleString('fa-IR')} روز و ${hrs.toLocaleString('fa-IR')} ساعت`
      : `${days.toLocaleString('fa-IR')} روز`;
  }
  if (hrs > 0 && mins > 0) return `${hrs.toLocaleString('fa-IR')} ساعت و ${mins.toLocaleString('fa-IR')} دقیقه`;
  if (hrs > 0) return `${hrs.toLocaleString('fa-IR')} ساعت`;
  return `${mins.toLocaleString('fa-IR')} دقیقه`;
}

function formatTrialRemainingText(seconds) {
  return formatDurationDetailedFa(seconds);
}

function liveRemainingSecondsFor(entry) {
  if (!entry) return null;
  if (entry.expiresAt != null && Number(entry.expiresAt) > 0) {
    return Math.max(0, Math.ceil(Number(entry.expiresAt) - Date.now() / 1000));
  }
  if (typeof entry.remainingSeconds === 'number') {
    return Math.max(0, Math.floor(entry.remainingSeconds));
  }
  if (typeof entry.daysRemaining === 'number') {
    return Math.max(0, Math.floor(entry.daysRemaining * 86400));
  }
  return null;
}

function computeTopbarLicenseSummary(status) {
  if (!status || !status.licensed || !status.unlocked) {
    return { visible: false, text: '', warn: false, detail: '—' };
  }
  if (status.isTrial) {
    const expSec = Number(status.trialExpiresAt || status.license?.expiresAt || 0);
    const rem = expSec > 0
      ? Math.max(0, Math.ceil(expSec - Date.now() / 1000))
      : Number(status.trialRemainingSeconds || 0);
    const dur = formatDurationDetailedFa(rem);
    return {
      visible: true,
      text: `آزمایشی: ${dur} مانده`,
      warn: true,
      detail: `${dur} باقی‌مانده (نسخهٔ آزمایشی ۲۴ ساعته)`,
      expiredNow: expSec > 0 && rem <= 0,
    };
  }
  const mods = status.modules && typeof status.modules === 'object' ? status.modules : null;
  const shortNames = { ocr: 'OCR', translation: 'ترجمه', editing: 'ویرایش' };
  if (mods) {
    const activeIds = ['ocr', 'translation', 'editing'].filter((m) => mods[m]?.active);
    if (!activeIds.length) return { visible: false, text: '', warn: false, detail: 'پایان‌یافته' };
    const remList = activeIds.map((m) => ({ id: m, mod: mods[m], rem: liveRemainingSecondsFor(mods[m]) }));
    const expiredNow = remList.some((x) => x.mod.expiresAt != null && x.rem !== null && x.rem <= 0);
    const timed = remList.filter((x) => x.mod.expiresAt != null && x.rem !== null);
    if (!timed.length) {
      const label = activeIds.length === 3
        ? 'اعتبار لایسنس: دائمی ✓'
        : `لایسنس دائمی: ${activeIds.map((m) => shortNames[m]).join(' + ')}`;
      return {
        visible: true,
        text: label,
        warn: false,
        detail: activeIds.length === 3 ? 'دائمی (مادام‌العمر — هر ۳ بخش)' : `دائمی (${activeIds.map((m) => shortNames[m]).join('، ')})`,
        expiredNow,
      };
    }
    const minRem = Math.min(...timed.map((x) => x.rem));
    const uniqueExps = new Set(remList.map((x) => (x.mod.expiresAt == null ? 'life' : String(x.mod.expiresAt))));
    const warn = minRem < 3 * 86400;
    if (activeIds.length === 3 && uniqueExps.size === 1) {
      const dur = formatDurationDetailedFa(minRem);
      return {
        visible: true,
        text: `اعتبار لایسنس: ${dur} مانده`,
        warn,
        detail: `${dur} باقی‌مانده (هر ۳ بخش)`,
        expiredNow,
      };
    }
    const parts = remList.map((x) => (
      x.mod.expiresAt == null
        ? `${shortNames[x.id]}: دائمی`
        : `${shortNames[x.id]}: ${formatDurationDetailedFa(x.rem)}`
    ));
    return {
      visible: true,
      text: `اعتبار: ${parts.join(' · ')}`,
      warn,
      detail: parts.map((p) => `${p} باقی‌مانده`.replace('دائمی باقی‌مانده', 'دائمی')).join(' | '),
      expiredNow,
    };
  }
  // Fallback when `status.modules` is omitted (e.g. legacy mock status)
  const lic = status.license;
  if (!lic || lic.plan === 'lifetime' || lic.expiresAt == null) {
    return { visible: true, text: 'اعتبار لایسنس: دائمی ✓', warn: false, detail: 'دائمی (مادام‌العمر)' };
  }
  const rem = liveRemainingSecondsFor(lic) ?? 0;
  const dur = formatDurationDetailedFa(rem);
  return {
    visible: true,
    text: `اعتبار لایسنس: ${dur} مانده`,
    warn: rem < 3 * 86400,
    detail: `${dur} باقی‌مانده`,
    expiredNow: lic.expiresAt != null && rem <= 0,
  };
}

function stopTrialCountdown() {
  if (trialCountdownTimer !== null) {
    clearInterval(trialCountdownTimer);
    trialCountdownTimer = null;
  }
}

function buildCustomerOrderRequestText(explicitHwid = '') {
  const hwid = String(explicitHwid || state.licenseStatus?.hardwareId || $('gateHardwareId')?.textContent || $('licInfoHwid')?.textContent || '').trim();
  return [
    'سلام و وقت بخیر',
    'درخواست تهیه / تمدید لایسنس نرم‌افزار Comic OCR Studio را دارم.',
    `🖥 کد شناسایی سیستم من: ${hwid}`,
    'لطفاً شرایط دریافت لایسنس را ارسال فرمایید.',
  ].join('\n');
}

function renderVendorChannelsInto(container, vc) {
  if (!container) return;
  container.textContent = '';
  const info = vc && typeof vc === 'object' ? vc : {};
  const addChip = (label, val, isLtr = true, href = '') => {
    const clean = String(val || '').trim();
    if (!clean) return;
    const el = document.createElement(href ? 'a' : 'span');
    el.className = 'vendor-channel-chip';
    if (href) {
      el.href = href;
      el.target = '_blank';
      el.rel = 'noopener noreferrer';
    }
    const lbl = document.createElement('span');
    lbl.textContent = `${label}:`;
    const bdi = document.createElement('bdi');
    if (isLtr) bdi.dir = 'ltr';
    bdi.textContent = clean;
    el.append(lbl, bdi);
    container.appendChild(el);
  };

  if (info.whatsapp) addChip('💬 واتساپ / پیامک', info.whatsapp, true);
  if (info.telegram) {
    const tgRaw = String(info.telegram).trim();
    let tgHref = '';
    if (/^https?:\/\//i.test(tgRaw)) tgHref = tgRaw;
    else if (tgRaw.startsWith('@') && tgRaw.length > 1) tgHref = `https://t.me/${tgRaw.slice(1)}`;
    else if (/^(t\.me|telegram\.me)\/[A-Za-z0-9_+/.-]+$/i.test(tgRaw)) tgHref = `https://${tgRaw}`;
    addChip('✈️ تلگرام', tgRaw, true, tgHref);
  }
  if (info.domesticMessenger) addChip('📱 پیام‌رسان داخلی', info.domesticMessenger, false);
  if (info.supportHours) addChip('🕒 پاسخ‌گویی', info.supportHours, false);
  if (info.website) {
    const webRaw = String(info.website).trim();
    let webHref = '';
    if (/^https?:\/\//i.test(webRaw)) webHref = webRaw;
    else if (/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(\/[^\s]*)?$/.test(webRaw)) webHref = `https://${webRaw}`;
    addChip('🌐 وب‌سایت', webRaw, true, webHref);
  }
  if (info.customNote) {
    const note = document.createElement('div');
    note.className = 'vendor-channel-note';
    note.textContent = String(info.customNote).trim();
    container.appendChild(note);
  }
  container.classList.toggle('hidden', container.childNodes.length === 0);
}

function syncTrialBannerAndModulesUi(status) {
  const vc = status?.vendorContact && typeof status.vendorContact === 'object' ? status.vendorContact : {};
  const phone = vc.supportPhone || status?.supportPhone || DEFAULT_SUPPORT_PHONE;
  if ($('gateSupportPhone')) $('gateSupportPhone').textContent = phone;
  if ($('licSupportPhone')) $('licSupportPhone').textContent = phone;
  if ($('trialNoticePhone')) $('trialNoticePhone').textContent = `📞 ${phone}`;
  renderVendorChannelsInto($('gateVendorChannels'), vc);
  renderVendorChannelsInto($('licVendorChannels'), vc);

  const banner = $('trialNoticeBanner');
  const showBanner = Boolean(status?.licensed && status?.unlocked && status?.isTrial);
  banner?.classList.toggle('hidden', !showBanner);
  stopTrialCountdown();

  const refreshLiveCountdowns = () => {
    const topInfo = computeTopbarLicenseSummary(status);
    if (topInfo.expiredNow) {
      stopTrialCountdown();
      refreshAuthGateState().catch(() => {});
      return;
    }
    const topBtn = $('licenseTopStatusBtn');
    if (topBtn) {
      topBtn.classList.toggle('hidden', !topInfo.visible);
      topBtn.classList.toggle('is-warn', Boolean(topInfo.warn));
      topBtn.title = topInfo.visible ? `${topInfo.detail} — برای مشاهدهٔ جزئیات کلیک کنید` : '';
    }
    if ($('licenseTopStatusText') && topInfo.visible) {
      $('licenseTopStatusText').textContent = topInfo.text;
    }
    if ($('licInfoRemaining')) {
      $('licInfoRemaining').textContent = topInfo.detail || '—';
      $('licInfoRemaining').classList.toggle('is-warn', Boolean(topInfo.warn));
    }
    if (showBanner && banner) {
      const expSec = Number(status.trialExpiresAt || 0);
      const rem = expSec > 0
        ? Math.max(0, Math.ceil(expSec - Date.now() / 1000))
        : Number(status.trialRemainingSeconds || 0);
      const remText = formatTrialRemainingText(rem);
      if ($('trialNoticeBadge')) $('trialNoticeBadge').textContent = `نسخهٔ آزمایشی ۲۴ ساعته (${remText} باقی‌مانده)`;
      if ($('trialNoticeText')) {
        $('trialNoticeText').textContent = `شما در حال استفاده از نسخهٔ آزمایشی ۲۴ ساعته هستید (${remText} باقی‌مانده) — برای ادامهٔ استفاده از برنامه باید لایسنس تهیه کنید و با شمارهٔ ${phone} تماس بگیرید.`;
      }
    }
    if ($('licenseDialog')?.open) {
      renderLicenseModulePills(status);
    }
  };

  refreshLiveCountdowns();
  const hasAnyTimed = Boolean(
    status?.licensed && status?.unlocked && (
      status.isTrial
      || status.license?.expiresAt != null
      || (status.modules && Object.values(status.modules).some((m) => m?.active && m?.expiresAt != null))
    )
  );
  if (hasAnyTimed) {
    trialCountdownTimer = setInterval(refreshLiveCountdowns, 30000);
    if (typeof trialCountdownTimer?.unref === 'function') trialCountdownTimer.unref();
  }

  const ocrOk = isModuleLicensed('ocr');
  const trOk = isModuleLicensed('translation');
  const edOk = isModuleLicensed('editing');
  $('ocrBtn')?.classList.toggle('mod-locked', !ocrOk);
  $('modelsBtn')?.classList.toggle('mod-locked', !ocrOk);
  $('translateBtn')?.classList.toggle('mod-locked', !trOk);
  $('aiBtn')?.classList.toggle('mod-locked', !trOk);
  $('watermarkBtn')?.classList.toggle('mod-locked', !edOk);
  $('duplicateBtn')?.classList.toggle('mod-locked', !edOk);
}

function formatLicensePlanDetail(lic) {
  if (!lic) return '—';
  if (lic.plan === 'trial24h') return lic.planLabel || 'نسخهٔ آزمایشی ۲۴ ساعته';
  if (lic.plan === 'lifetime' || lic.expiresAt == null) return lic.planLabel || 'دائمی (مادام‌العمر)';
  const liveSec = liveRemainingSecondsFor(lic);
  const rem = liveSec !== null
    ? `${formatDurationDetailedFa(liveSec)} باقی‌مانده`
    : (typeof lic.daysRemaining === 'number' ? `${lic.daysRemaining.toLocaleString('fa-IR')} روز باقی‌مانده` : '');
  let expDate = '';
  try {
    expDate = new Date(Number(lic.expiresAt) * 1000).toLocaleDateString('fa-IR');
  } catch { expDate = ''; }
  const tail = [rem, expDate ? `تا ${expDate}` : ''].filter(Boolean).join(' · ');
  return tail ? `${lic.planLabel || 'مدت‌دار'} (${tail})` : (lic.planLabel || 'مدت‌دار');
}

function formatModuleBadgeText(modInfo) {
  if (!modInfo || !modInfo.active) {
    return modInfo?.source === 'expired' ? 'پایان اعتبار (نیازمند تمدید)' : 'غیرفعال';
  }
  if (modInfo.source === 'trial' || modInfo.plan === 'trial24h') {
    const rem = liveRemainingSecondsFor(modInfo) ?? 0;
    return `آزمایشی ۲۴ ساعته (${formatDurationDetailedFa(rem)} مانده)`;
  }
  if (modInfo.plan === 'lifetime' || modInfo.expiresAt == null) {
    return 'فعال ✓ (دائمی)';
  }
  const rem = liveRemainingSecondsFor(modInfo);
  const dur = rem !== null
    ? `${formatDurationDetailedFa(rem)} باقی‌مانده`
    : (typeof modInfo.daysRemaining === 'number' ? `${modInfo.daysRemaining.toLocaleString('fa-IR')} روز باقی‌مانده` : (modInfo.planLabel || 'مدت‌دار'));
  let expDate = '';
  if (modInfo.expiresAt != null) {
    try { expDate = new Date(Number(modInfo.expiresAt) * 1000).toLocaleDateString('fa-IR'); } catch { expDate = ''; }
  }
  return expDate ? `فعال ✓ (${dur} · تا ${expDate})` : `فعال ✓ (${dur})`;
}

function renderLicenseModulePills(status) {
  if (!status) return;
  const mods = status.modules || null;
  for (const modId of ['ocr', 'translation', 'editing']) {
    const pill = $(`licMod_${modId}`);
    if (!pill) continue;
    const modEntry = mods && typeof mods === 'object' && (modId in mods)
      ? mods[modId]
      : (status.licensed ? { active: true, plan: status.license?.plan || 'lifetime', expiresAt: status.license?.expiresAt, daysRemaining: status.license?.daysRemaining } : { active: false });
    pill.textContent = formatModuleBadgeText(modEntry);
    pill.classList.toggle('is-active', Boolean(modEntry?.active && modEntry?.source !== 'trial' && modEntry?.plan !== 'trial24h'));
    pill.classList.toggle('is-trial', Boolean(modEntry?.active && (modEntry?.source === 'trial' || modEntry?.plan === 'trial24h')));
    pill.classList.toggle('is-off', !modEntry?.active);
  }
}

function applyAuthGateUi(status, { forceActivatePane = false } = {}) {
  if (!status || typeof status !== 'object') return;
  state.licenseStatus = status;
  const hwid = status.hardwareId || '';
  if ($('gateHardwareId') && hwid) $('gateHardwareId').textContent = hwid;
  if ($('licInfoHwid') && hwid) $('licInfoHwid').textContent = hwid;
  $('lockAppMenuBtn')?.classList.toggle('hidden', !(status.licensed && status.passwordEnabled));
  syncTrialBannerAndModulesUi(status);

  if (status.licensed && status.unlocked) {
    document.body.classList.remove('auth-locked');
    $('authGateOverlay')?.classList.add('hidden');
    if ($('gateActivateError')) $('gateActivateError').classList.add('hidden');
    if ($('gateLoginError')) $('gateLoginError').classList.add('hidden');
    return;
  }

  setMenuOpen(false);
  [...openDialogStack].reverse().forEach((dlgId) => {
    if (dlgId !== 'helpDialog' && dlgId !== 'appModalDialog' && $(dlgId)?.open) closeDialog(dlgId);
  });
  document.body.classList.add('auth-locked');
  $('authGateOverlay')?.classList.remove('hidden');

  const showLogin = Boolean(status.licensed && !status.unlocked && !forceActivatePane);
  $('authActivatePane')?.classList.toggle('hidden', showLogin);
  $('authLoginPane')?.classList.toggle('hidden', !showLogin);
  $('backToLoginPaneBtn')?.classList.toggle('hidden', !(status.licensed && !status.unlocked && forceActivatePane));
  $('gateResetPwdWrap')?.classList.toggle('hidden', !status.passwordEnabled);

  const badge = $('authGateBadge');
  if (badge) {
    badge.textContent = showLogin
      ? 'قفل‌شده با رمز شخصی'
      : (status.reason === 'trial_expired'
        ? 'پایان مهلت آزمایشی ۲۴ ساعته'
        : status.reason === 'license_expired'
          ? 'پایان اعتبار لایسنس'
          : status.reason === 'clock_tampered'
            ? 'خطای تاریخ و ساعت سیستم'
            : 'نیازمند فعال‌سازی لایسنس');
    badge.classList.toggle('is-ok', showLogin);
  }
  if ($('authGateMessage')) {
    const phone = status.supportPhone || DEFAULT_SUPPORT_PHONE;
    const msg = forceActivatePane && status.licensed
      ? 'در این بخش می‌توانید کد سیستم خود را مشاهده کنید، کلید تمدید وارد کنید یا در صورت فراموشی رمز ورود، با کلید لایسنس اصلی رمز را بازنشانی نمایید.'
      : (status.message || `برنامه هنوز روی این سیستم فعال نشده است. برای دریافت لایسنس با شمارهٔ ${phone} تماس بگیرید.`);
    $('authGateMessage').textContent = msg;
    $('authGateMessage').classList.toggle('is-warn', status.reason === 'trial_expired' || status.reason === 'license_expired' || status.reason === 'clock_tampered');
  }
  if (showLogin) {
    const holder = status.license?.holder || 'کاربر رسمی';
    const planDesc = formatLicensePlanDetail(status.license);
    if ($('gateHolderSummary')) {
      $('gateHolderSummary').textContent = `لایسنس فعال به نام «${holder}» · اعتبار: ${planDesc}`;
    }
    setTimeout(() => { try { $('gateLoginPasswordInput')?.focus({ preventScroll: true }); } catch { /* ignore */ } }, 40);
  }
}

async function refreshAuthGateState() {
  const status = await api('/api/license/status');
  applyAuthGateUi(status);
  return status;
}

async function bootUnlockedWorkspace() {
  if (!state.activityFeedStarted) {
    state.activityFeedStarted = true;
    startActivityFeed();
  }
  if (state.workspaceBooted) {
    const projects = await api('/api/projects');
    if (!state.project && projects.length) {
      const p = await api(`/api/projects/${projects[0].id}`);
      adoptProject(p);
    }
    await refreshProjectList(projects.length ? projects : null);
    return;
  }
  const enginesTask = api('/api/engines');
  const aiTask = api('/api/ai-settings');
  enginesTask.catch(() => {});
  aiTask.catch(() => {});
  const projects = await api('/api/projects');
  const project = projects.length ? await api(`/api/projects/${projects[0].id}`) : await api('/api/projects', jsonOptions('POST', { name: 'پروژهٔ کمیک' }));
  adoptProject(project);
  const [engines, ai] = await Promise.all([enginesTask, aiTask]);
  state.engines = engines; state.ai = ai;
  state.workspaceBooted = true;
  updateEngineOptions(state.project?.settings?.ocrEngine || 'rapidocr-v6');
  await refreshProjectList(projects.length ? projects : null);
  await loadAiSettings(ai);
  const unrenderedIds = sortedImages().filter((item) => hasOverlayText(item) && !item.edited).map((item) => item.id);
  if (unrenderedIds.length) {
    const startupRenderTask = renderImagesText(unrenderedIds);
    projectLoadTasks.add(startupRenderTask);
    startupRenderTask.finally(() => projectLoadTasks.delete(startupRenderTask)).catch(() => {});
    startupRenderTask.catch(() => {});
  }
  syncEngineUpdateUi();
  const shouldCheckUpdates = !startupUpdateChecked && isModuleLicensed('ocr') && state.engines.some((entry) => entry.runtimeInstalled);
  if (shouldCheckUpdates) {
    startupUpdateChecked = true;
    setTimeout(() => { checkEngineUpdates({ force: false, silent: true }).catch(() => {}); }, 800);
  } else {
    setTimeout(() => { refreshEngineMemory().catch(() => {}); }, 500);
  }
}

async function submitGateLicenseActivation() {
  const rawKey = ($('gateLicenseKeyInput')?.value || '').trim();
  const errEl = $('gateActivateError');
  if (errEl) errEl.classList.add('hidden');
  if (!rawKey) {
    if (errEl) { errEl.textContent = 'لطفاً ابتدا کلید لایسنس (شروع با CLIC1.) را در کادر بالا وارد کنید.'; errEl.classList.remove('hidden'); }
    return;
  }
  const btn = $('activateGateLicenseBtn');
  if (btn) btn.disabled = true;
  try {
    const resetPwd = Boolean($('gateResetLocalPwd')?.checked);
    const status = await api('/api/license/activate', jsonOptions('POST', { license_key: rawKey, reset_local_password: resetPwd }));
    if ($('gateLicenseKeyInput')) $('gateLicenseKeyInput').value = '';
    if ($('gateResetLocalPwd')) $('gateResetLocalPwd').checked = false;
    applyAuthGateUi(status);
    if (status.licensed && status.unlocked) {
      await bootUnlockedWorkspace();
      toast('لایسنس با موفقیت فعال شد؛ خوش آمدید!');
    }
  } catch (error) {
    if (errEl) { errEl.textContent = error.detailText || error.message; errEl.classList.remove('hidden'); }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function submitGatePasswordLogin() {
  const pwd = $('gateLoginPasswordInput')?.value || '';
  const errEl = $('gateLoginError');
  if (errEl) errEl.classList.add('hidden');
  if (!pwd) {
    if (errEl) { errEl.textContent = 'لطفاً رمز ورود خود را وارد کنید.'; errEl.classList.remove('hidden'); }
    return;
  }
  const btn = $('gateLoginSubmitBtn');
  if (btn) btn.disabled = true;
  try {
    const status = await api('/api/license/login', jsonOptions('POST', { password: pwd }));
    if ($('gateLoginPasswordInput')) $('gateLoginPasswordInput').value = '';
    applyAuthGateUi(status);
    if (status.licensed && status.unlocked) {
      await bootUnlockedWorkspace();
      toast('خوش آمدید');
    }
  } catch (error) {
    if (errEl) { errEl.textContent = error.detailText || error.message; errEl.classList.remove('hidden'); }
  } finally {
    if (btn) btn.disabled = false;
  }
}

function populateLicenseDialog(status) {
  if (!status) return;
  if ($('licInfoStatus')) {
    $('licInfoStatus').textContent = status.isTrial
      ? 'نسخهٔ آزمایشی ۲۴ ساعته'
      : (status.licensed ? 'فعال ✓' : 'غیرفعال');
  }
  if ($('licInfoHolder')) $('licInfoHolder').textContent = status.license?.holder || '—';
  const topInfo = computeTopbarLicenseSummary(status);
  if ($('licInfoRemaining')) {
    $('licInfoRemaining').textContent = topInfo.detail || '—';
    $('licInfoRemaining').classList.toggle('is-warn', Boolean(topInfo.warn));
  }
  if ($('licInfoPlan')) $('licInfoPlan').textContent = formatLicensePlanDetail(status.license);
  if ($('licInfoHwid')) $('licInfoHwid').textContent = status.hardwareId || '';
  const vc = status.vendorContact && typeof status.vendorContact === 'object' ? status.vendorContact : {};
  if ($('licSupportPhone')) $('licSupportPhone').textContent = vc.supportPhone || status.supportPhone || DEFAULT_SUPPORT_PHONE;
  renderVendorChannelsInto($('licVendorChannels'), vc);

  renderLicenseModulePills(status);

  const anyInactive = Boolean(status.isTrial || !isModuleLicensed('ocr') || !isModuleLicensed('translation') || !isModuleLicensed('editing'));
  if ($('licRenewDetails') && anyInactive) $('licRenewDetails').open = true;

  const pwdOn = Boolean(status.passwordEnabled);
  if ($('licPwdStateBadge')) {
    $('licPwdStateBadge').textContent = pwdOn ? 'فعال (محافظت با رمز)' : 'غیرفعال (ورود مستقیم)';
    $('licPwdStateBadge').classList.toggle('is-active', pwdOn);
  }
  $('licCurrentPwdWrap')?.classList.toggle('hidden', !pwdOn);
  $('removeLocalPwdBtn')?.classList.toggle('hidden', !pwdOn);
  $('lockNowInsideDialogBtn')?.classList.toggle('hidden', !pwdOn);
  if ($('licCurrentPwdInput')) $('licCurrentPwdInput').value = '';
  if ($('licNewPwdInput')) $('licNewPwdInput').value = '';
  if ($('licConfirmPwdInput')) $('licConfirmPwdInput').value = '';
  if ($('licPwdFeedback')) $('licPwdFeedback').classList.add('hidden');
}

async function openLicenseDialog({ focusRenew = false } = {}) {
  const status = await refreshAuthGateState();
  if (!status.licensed || !status.unlocked) return;
  populateLicenseDialog(status);
  if (focusRenew && $('licRenewDetails')) $('licRenewDetails').open = true;
  showDialog('licenseDialog');
  if (focusRenew) {
    setTimeout(() => { try { $('dialogNewLicenseInput')?.focus({ preventScroll: true }); } catch { /* ignore */ } }, 40);
  }
}

async function saveLocalPasswordFromDialog() {
  const cur = $('licCurrentPwdInput')?.value || '';
  const next = $('licNewPwdInput')?.value || '';
  const confirm = $('licConfirmPwdInput')?.value || '';
  const fb = $('licPwdFeedback');
  const showFb = (msg, isErr) => {
    if (!fb) return;
    fb.textContent = msg;
    fb.style.color = isErr ? 'var(--danger)' : '#34d399';
    fb.classList.remove('hidden');
  };
  if (next.length < 4) { showFb('رمز ورود جدید باید حداقل ۴ کاراکتر باشد.', true); return; }
  if (next !== confirm) { showFb('رمز جدید و تکرار آن یکسان نیستند.', true); return; }
  try {
    const status = await api('/api/license/password', jsonOptions('PUT', { current_password: cur, new_password: next }));
    applyAuthGateUi(status);
    populateLicenseDialog(status);
    showFb('رمز ورود شخصی با موفقیت ذخیره و فعال شد.', false);
    toast('رمز ورود محلی فعال شد');
  } catch (error) {
    showFb(error.detailText || error.message, true);
  }
}

async function removeLocalPasswordFromDialog() {
  const cur = $('licCurrentPwdInput')?.value || '';
  const fb = $('licPwdFeedback');
  if (!cur) {
    if (fb) { fb.textContent = 'برای حذف رمز ورود، ابتدا رمز فعلی را در کادر «رمز ورود فعلی» بنویسید.'; fb.style.color = 'var(--danger)'; fb.classList.remove('hidden'); }
    return;
  }
  const ok = await appConfirm('آیا رمز ورود محلی حذف شود تا برنامه بدون پرسیدن رمز باز شود؟', {
    title: 'حذف رمز ورود محلی',
    confirmText: 'بله، حذف شود',
    cancelText: 'انصراف',
    variant: 'danger',
    destructive: true,
  });
  if (!ok) return;
  try {
    const status = await api('/api/license/password', jsonOptions('PUT', { current_password: cur, new_password: '' }));
    applyAuthGateUi(status);
    populateLicenseDialog(status);
    toast('رمز ورود محلی حذف شد');
  } catch (error) {
    if (fb) { fb.textContent = error.detailText || error.message; fb.style.color = 'var(--danger)'; fb.classList.remove('hidden'); }
  }
}

async function activateNewLicenseFromDialog() {
  const rawKey = ($('dialogNewLicenseInput')?.value || '').trim();
  if (!rawKey) { toast('ابتدا کلید لایسنس جدید را وارد کنید', true); return; }
  try {
    const status = await api('/api/license/activate', jsonOptions('POST', { license_key: rawKey, reset_local_password: false }));
    if ($('dialogNewLicenseInput')) $('dialogNewLicenseInput').value = '';
    applyAuthGateUi(status);
    populateLicenseDialog(status);
    toast(`کلید لایسنس جدید با موفقیت ثبت شد (${status.license?.planLabel || ''})`);
  } catch (error) {
    toast(error.detailText || error.message, true);
  }
}

async function lockWorkspaceNow() {
  if (savePending) {
    try { await saveProject(); } catch { /* ignore */ }
  }
  const status = await api('/api/license/logout', { method: 'POST' });
  applyAuthGateUi(status);
  toast('برنامه قفل شد');
}

async function init() {
  bindEvents(); startSession();
  try {
    const authStatus = await refreshAuthGateState();
    if (!authStatus?.licensed || !authStatus?.unlocked) return;
    await bootUnlockedWorkspace();
  } catch (error) { toast(`راه‌اندازی ناموفق: ${error.detailText || error.message}`, true); }
}
init();
