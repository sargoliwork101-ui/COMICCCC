// Injected only into the duplicate tab: select paragraph blocks, translate chosen blocks and retain every result.
(function () {
  if (window.__wtpdfPageTranslation && window.__wtpdfPageTranslation.running) return;
  const tools = window.PageTranslationTools;
  if (!tools) return;

  const JOB_PREFIX = 'WTPDF_PAGE_TRANSLATE_';
  const MAX_TRANSLATION_VERSIONS = 6; // آخرین ترجمه + پنج ترجمهٔ قبلی برای هر پاراگراف
  const toPersianNumber = (value) => String(value).replace(/\d/gu, (digit) => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)]);
  const sendProgress = (jobId, state, details = {}) => {
    if (!jobId) return;
    try {
      const pending = chrome.runtime.sendMessage({
        type: `${JOB_PREFIX}PROGRESS`, jobId, state,
        completed: Number(details.completed) || 0,
        total: Number(details.total) || 0,
        textNodes: Number(details.textNodes) || 0
      });
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch { /* the translated tab may close while a job is running */ }
  };

  function buildGroups(records) {
    const byBlock = new Map();
    (Array.isArray(records) ? records : []).forEach((record) => {
      const block = record.block || record.node.parentElement || document.body;
      let group = byBlock.get(block);
      if (!group) {
        group = {
          id: `group-${byBlock.size + 1}`,
          label: `پاراگراف ${byBlock.size + 1}`,
          block,
          originalPickable: block.classList.contains('wtpdf-page-translation-pickable'),
          originalPicked: block.classList.contains('wtpdf-page-translation-picked'),
          originalStatus: block.getAttribute('data-wtpdf-translation-status'),
          records: [],
          versions: [],
          activeVersion: 0,
          nextVersionNumber: 0,
          status: 'pending',
          lastAttempt: new Map(),
          failedPartIds: new Set()
        };
        byBlock.set(block, group);
      }
      group.records.push(record);
    });
    return [...byBlock.values()].map((group) => {
      const values = new Map(group.records.map((record) => [record.id, record.original]));
      group.sourceText = group.records.map((record) => record.original).join('').replace(/\s+/gu, ' ').trim();
      group.versions.push({ label: 'متن اصلی', values, translatedIds: new Set() });
      return group;
    });
  }

  function makeToolbar(state) {
    const style = document.createElement('style');
    style.dataset.wtpdfPageTranslationUi = 'style';
    style.textContent = `
      [data-wtpdf-page-translation-ui="toolbar"]{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;
        display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:7px;max-width:calc(100vw - 24px);padding:9px 12px;
        border-radius:12px;background:#18212f;color:#fff;border:1px solid #64748b;box-shadow:0 8px 32px #0007;
        font:600 13px/1.5 system-ui,sans-serif;direction:rtl;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-role="status"]{max-width:min(30vw,360px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-role="version-count"]{white-space:nowrap;color:#a7f3d0;font-size:12px;}
      [data-wtpdf-page-translation-ui="toolbar"] button,[data-wtpdf-page-translation-ui="toolbar"] select{font:600 12px/1.4 system-ui,sans-serif;
        border:1px solid #94a3b8;border-radius:8px;background:#273449;color:#fff;padding:7px 9px;cursor:pointer;}
      [data-wtpdf-page-translation-ui="toolbar"] select{max-width:210px;}
      [data-wtpdf-page-translation-ui="toolbar"] button:hover{background:#35445e;}
      [data-wtpdf-page-translation-ui="toolbar"] button:focus-visible,[data-wtpdf-page-translation-ui="toolbar"] select:focus-visible{outline:2px solid #a5b4fc;outline-offset:2px;}
      [data-wtpdf-page-translation-ui="toolbar"] button:disabled,[data-wtpdf-page-translation-ui="toolbar"] select:disabled{opacity:.55;cursor:not-allowed;}
      .wtpdf-page-translation-pickable{outline:2px dashed #fbbf24!important;outline-offset:3px;cursor:pointer!important;}
      .wtpdf-page-translation-pickable:hover{background-color:#fbbf2430!important;}
      .wtpdf-page-translation-picked{outline:3px solid #22c55e!important;outline-offset:3px;background-color:#22c55e24!important;}
      [data-wtpdf-translation-status="translated"]:not(.wtpdf-page-translation-picked){outline:2px solid #22c55e!important;outline-offset:3px;}
      [data-wtpdf-translation-status="partial"]:not(.wtpdf-page-translation-picked){outline:2px solid #fbbf24!important;outline-offset:3px;}
      [data-wtpdf-translation-status="failed"]:not(.wtpdf-page-translation-picked){outline:2px solid #f87171!important;outline-offset:3px;}
      [data-wtpdf-translation-status="translating"]:not(.wtpdf-page-translation-picked){outline:2px solid #93c5fd!important;outline-offset:3px;}
      @media(max-width:720px){[data-wtpdf-page-translation-ui="toolbar"]{top:6px;max-width:calc(100vw - 12px);gap:5px;padding:7px;}
        [data-wtpdf-page-translation-ui="toolbar"] [data-role="status"]{max-width:92vw;flex-basis:100%;text-align:center;}}
    `;
    const toolbar = document.createElement('div');
    toolbar.dataset.wtpdfPageTranslationUi = 'toolbar';
    toolbar.setAttribute('role', 'region');
    toolbar.setAttribute('aria-label', 'انتخاب و ترجمهٔ متن صفحه');
    const status = document.createElement('span');
    status.dataset.role = 'status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    status.textContent = `برای شروع روی پاراگراف‌های دلخواه کلیک کنید · ${state.groups.length} پاراگراف شناسایی شد.`;
    const versionCount = document.createElement('span');
    versionCount.dataset.role = 'version-count';
    versionCount.setAttribute('aria-live', 'polite');
    const engineSelect = document.createElement('select');
    engineSelect.dataset.role = 'translation-engine';
    engineSelect.setAttribute('aria-label', 'انتخاب موتور ترجمه');
    PAGE_ENGINE_OPTIONS.forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value; option.textContent = label;
      engineSelect.appendChild(option);
    });
    engineSelect.value = state.translationEngine;
    const pickToggle = document.createElement('button');
    pickToggle.type = 'button'; pickToggle.dataset.action = 'pick-toggle';
    const translate = document.createElement('button');
    translate.type = 'button'; translate.dataset.action = 'translate-selected'; translate.textContent = 'ترجمهٔ انتخاب‌ها';
    const retry = document.createElement('button');
    retry.type = 'button'; retry.dataset.action = 'retry-failed'; retry.textContent = 'تلاش دوباره';
    retry.title = 'فقط بخش‌های ناموفقِ پاراگراف‌های انتخاب‌شده را دوباره می‌فرستد.';
    const versionPrev = document.createElement('button');
    versionPrev.type = 'button'; versionPrev.dataset.action = 'version-prev'; versionPrev.textContent = 'نسخهٔ قبلی';
    const versionNext = document.createElement('button');
    versionNext.type = 'button'; versionNext.dataset.action = 'version-next'; versionNext.textContent = 'نسخهٔ بعدی';
    const original = document.createElement('button');
    original.type = 'button'; original.dataset.action = 'original'; original.textContent = 'متن اصلی';
    const translated = document.createElement('button');
    translated.type = 'button'; translated.dataset.action = 'translated'; translated.textContent = 'آخرین ترجمه';
    const restore = document.createElement('button');
    restore.type = 'button'; restore.dataset.action = 'restore'; restore.textContent = 'بازگردانی';
    restore.title = 'فقط کپی را به متن و جهت اولیه برمی‌گرداند و نوار ترجمه را می‌بندد؛ صفحهٔ اصلی تغییر نمی‌کند. برای دیدن متن اصلی بدون بستن نوار، «متن اصلی» را بزنید.';
    toolbar.append(status, versionCount, engineSelect, pickToggle, translate, retry, versionPrev, versionNext, original, translated, restore);
    document.documentElement.append(style, toolbar);
    return { style, toolbar, status, versionCount, engineSelect, pickToggle, translate, retry, versionPrev, versionNext, original, translated, restore };
  }

  function versionTextMap(records, values, translatedIds) {
    return tools.showVersion(records, values, translatedIds);
  }

  const PAGE_ENGINE_OPTIONS = [
    ['auto', 'Google؛ در صورت خطا MyMemory'], ['google', 'فقط Google Translate'], ['mymemory', 'فقط MyMemory'],
    ['ai:gemini', 'Google Gemini (مدل تنظیم‌شده)'], ['ai:openai', 'OpenAI (مدل تنظیم‌شده)'],
    ['ai:openrouter', 'OpenRouter (مدل تنظیم‌شده)'], ['ai:avalai', 'AvalAI (مدل تنظیم‌شده)']
  ];
  const PAGE_ENGINE_LABELS = Object.fromEntries(PAGE_ENGINE_OPTIONS);

  function refreshGroupStatuses(state) {
    state.groups.forEach((group) => {
      group.block.dataset.wtpdfTranslationStatus = group.status;
    });
  }

  function refreshToolbarControls(state) {
    if (!state.ui) return;
    const selected = state.groups.filter((group) => state.selectedGroups.has(group.id));
    const countGroups = selected.length ? selected : state.groups;
    const savedVersions = countGroups.reduce((total, group) => total + Math.max(0, group.versions.length - 1), 0);
    const countLabel = selected.length === 1
      ? `برای این پاراگراف: ${toPersianNumber(savedVersions)} ترجمه`
      : selected.length > 1
        ? `مجموع ${toPersianNumber(savedVersions)} ترجمه در ${toPersianNumber(selected.length)} پاراگراف انتخاب‌شده`
        : `در کل صفحه: ${toPersianNumber(savedVersions)} ترجمهٔ نگه‌داشته‌شده`;
    state.ui.versionCount.textContent = countLabel;
    state.ui.versionCount.title = countGroups.length
      ? `${countGroups.map((group) => `${group.label}: ${toPersianNumber(Math.max(0, group.versions.length - 1))}`).join(' · ')}؛ برای هر پاراگراف حداکثر ${toPersianNumber(MAX_TRANSLATION_VERSIONS)} ترجمه نگه‌داری می‌شود.`
      : `برای هر پاراگراف حداکثر ${toPersianNumber(MAX_TRANSLATION_VERSIONS)} ترجمه نگه‌داری می‌شود.`;
    const canRetry = selected.some((group) => group.failedPartIds && group.failedPartIds.size);
    const canStepBack = selected.some((group) => group.activeVersion > 0);
    const canStepForward = selected.some((group) => group.activeVersion < group.versions.length - 1);
    state.ui.pickToggle.textContent = state.pickMode ? 'پایان انتخاب' : 'انتخاب روی صفحه';
    state.ui.translate.disabled = state.running || state.pickMode || selected.length === 0;
    state.ui.retry.disabled = state.running || state.pickMode || !canRetry;
    state.ui.engineSelect.disabled = state.running;
    state.ui.versionPrev.disabled = state.running || state.pickMode || !canStepBack;
    state.ui.versionNext.disabled = state.running || state.pickMode || !canStepForward;
    state.ui.original.disabled = state.running || state.pickMode;
    state.ui.translated.disabled = state.running || state.pickMode;
    state.ui.restore.disabled = state.running;
    state.ui.pickToggle.disabled = state.running;
  }

  function setTranslationEngine(state, engine) {
    state.translationEngine = PAGE_ENGINE_LABELS[engine] ? engine : 'auto';
    if (state.ui && state.ui.engineSelect) state.ui.engineSelect.value = state.translationEngine;
  }

  function setGroupVersion(group, versionIndex) {
    const index = Math.max(0, Math.min(group.versions.length - 1, Number(versionIndex) || 0));
    const version = group.versions[index];
    group.activeVersion = index;
    versionTextMap(group.records, version.values, version.translatedIds);
  }

  function syncPageSelection(state) {
    state.groups.forEach((group) => {
      group.block.classList.toggle('wtpdf-page-translation-pickable', state.pickMode || group.originalPickable);
      group.block.classList.toggle('wtpdf-page-translation-picked', state.selectedGroups.has(group.id) || group.originalPicked);
    });
  }

  function updatePickStatus(state) {
    state.ui.status.textContent = state.pickMode
      ? `روی پاراگراف‌ها کلیک کنید تا انتخاب شوند یا از انتخاب خارج شوند · ${state.selectedGroups.size} انتخاب‌شده · پایان با Escape`
      : `${state.selectedGroups.size} پاراگراف انتخاب شده؛ برای تغییر روی صفحه «انتخاب روی صفحه» را بزنید.`;
    refreshToolbarControls(state);
  }

  function exitPagePickMode(state) {
    if (!state.pickMode) return;
    state.pickMode = false;
    document.removeEventListener('click', state.pickClickHandler, true);
    document.removeEventListener('keydown', state.pickKeyHandler, true);
    syncPageSelection(state);
    updatePickStatus(state);
  }

  function enterPagePickMode(state) {
    if (state.pickMode || state.running) return;
    state.pickMode = true;
    syncPageSelection(state);
    const updateCount = () => updatePickStatus(state);
    state.pickClickHandler = (event) => {
      const target = event.target && (event.target.nodeType === 1 ? event.target : event.target.parentElement);
      if (!target || target.closest('[data-wtpdf-page-translation-ui]')) return;
      let element = target;
      let group = null;
      while (element && !group) {
        group = state.groupByBlock.get(element) || null;
        element = element.parentElement;
      }
      if (!group) return;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      if (state.selectedGroups.has(group.id)) state.selectedGroups.delete(group.id);
      else state.selectedGroups.add(group.id);
      syncPageSelection(state);
      updateCount();
    };
    state.pickKeyHandler = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      exitPagePickMode(state);
    };
    document.addEventListener('click', state.pickClickHandler, true);
    document.addEventListener('keydown', state.pickKeyHandler, true);
    updateCount();
  }

  function stepSelectedVersions(state, amount) {
    state.groups.filter((group) => state.selectedGroups.has(group.id)).forEach((group) => {
      setGroupVersion(group, group.activeVersion + amount);
    });
    state.ui.status.textContent = amount < 0
      ? 'نسخهٔ قبلی برای پاراگراف‌های انتخاب‌شده نمایش داده شد.'
      : 'نسخهٔ بعدی برای پاراگراف‌های انتخاب‌شده نمایش داده شد.';
    refreshToolbarControls(state);
  }

  async function translateSelected(state, retryOnly = false) {
    if (state.running || state.pickMode) return;
    const selected = state.groups.filter((group) => state.selectedGroups.has(group.id) &&
      (!retryOnly || (group.failedPartIds && group.failedPartIds.size)));
    if (!selected.length) {
      state.ui.status.textContent = retryOnly
        ? 'در پاراگراف‌های انتخاب‌شده بخش ناموفقی برای تلاش دوباره نیست.'
        : 'برای ترجمه، روی پاراگراف‌های دلخواه کلیک کنید و انتخاب را پایان دهید.';
      return;
    }
    const selectedIds = new Set(selected.map((group) => group.id));
    const entries = selected.flatMap((group) => {
      const allEntries = tools.createEntries(group.records);
      if (!retryOnly) {
        group.lastAttempt = new Map();
        group.failedPartIds = new Set();
      }
      group.status = 'translating';
      return retryOnly ? allEntries.filter((entry) => group.failedPartIds.has(entry.id)) : allEntries;
    });
    const batches = tools.splitBatches(entries);
    if (!entries.length) {
      selected.forEach((group) => { group.status = 'failed'; });
      refreshGroupStatuses(state);
      state.ui.status.textContent = 'بخش تازه‌ای برای ارسال پیدا نشد؛ ترجمه‌های قبلی حفظ شده‌اند.';
      refreshToolbarControls(state);
      return;
    }
    state.running = true;
    refreshGroupStatuses(state);
    refreshToolbarControls(state);
    const engineLabel = PAGE_ENGINE_LABELS[state.translationEngine];
    state.ui.status.textContent = retryOnly
      ? `در حال تلاش دوباره با ${engineLabel} برای ${selected.length} پاراگراف...`
      : `در حال ترجمه با ${engineLabel}؛ ${selected.length} پاراگراف انتخاب شده...`;
    sendProgress(state.jobId, 'working', { total: batches.length, textNodes: entries.length });
    try {
      const translations = new Map();
      const batchErrors = [];
      const providerResults = new Set();
      for (let index = 0; index < batches.length; index++) {
        state.ui.status.textContent = `در حال ترجمه با ${engineLabel}... بستهٔ ${index + 1} از ${batches.length}`;
        try {
          const response = await chrome.runtime.sendMessage({
            type: 'WTPDF_TRANSLATE_PAGE_BATCH', entries: batches[index], engine: state.translationEngine
          });
          if (!response || !response.ok) throw new Error(response && response.error || 'سرویس ترجمه پاسخ نداد.');
          if (response.provider) providerResults.add(response.provider);
          (response.translations || []).forEach((row) => {
            if (row && typeof row.id === 'string' && typeof row.text === 'string' && row.text.trim()) {
              translations.set(row.id, row.text);
            }
          });
        } catch (error) {
          batchErrors.push(error && error.message ? error.message : 'خطای ارتباط با سرویس ترجمه');
        }
        sendProgress(state.jobId, 'working', { completed: index + 1, total: batches.length, textNodes: entries.length });
      }
      let updatedParagraphs = 0, completedParagraphs = 0, partialParagraphs = 0, failedParagraphs = 0;
      selected.forEach((group) => {
        translations.forEach((text, id) => {
          if (group.records.some((record) => (record.parts || []).some((part) => part.id === id))) {
            group.lastAttempt.set(id, text);
          }
        });
        const expectedParts = group.records.flatMap((record) => record.parts || []);
        const translatedParts = expectedParts.filter((part) => group.lastAttempt.has(part.id) &&
          String(group.lastAttempt.get(part.id)).trim()).length;
        group.failedPartIds = new Set(expectedParts.filter((part) => !group.lastAttempt.has(part.id)).map((part) => part.id));
        if (translatedParts === expectedParts.length && expectedParts.length) {
          group.status = 'translated'; completedParagraphs++;
        } else if (translatedParts) {
          group.status = 'partial'; partialParagraphs++;
        } else {
          group.status = 'failed'; failedParagraphs++;
        }
        if (!translatedParts) return;

        tools.applyTranslations(group.records, group.lastAttempt);
        const translatedIds = new Set(group.records.filter((record) => record.hasTranslation).map((record) => record.id));
        const values = new Map(group.records.map((record) => [record.id, record.translated]));
        group.nextVersionNumber++;
        const version = {
          label: group.status === 'partial' ? `ترجمهٔ ${group.nextVersionNumber} (ناقص)` : `ترجمهٔ ${group.nextVersionNumber}`,
          values, translatedIds
        };
        group.versions.push(version);
        const excessVersions = group.versions.length - 1 - MAX_TRANSLATION_VERSIONS;
        if (excessVersions > 0) group.versions.splice(1, excessVersions);
        group.activeVersion = group.versions.length - 1;
        versionTextMap(group.records, values, translatedIds);
        updatedParagraphs++;
      });
      state.selectedGroups = selectedIds;
      state.initialSelection = false;
      refreshGroupStatuses(state);
      const summary = `${completedParagraphs} کامل، ${partialParagraphs} ناقص، ${failedParagraphs} ناموفق`;
      const actualEngine = [...providerResults].join(' / ') || engineLabel;
      state.ui.status.textContent = `${actualEngine} · ${summary}. ترجمه‌های موفق و نسخه‌های قبلی حفظ شدند.`;
      sendProgress(state.jobId, failedParagraphs || partialParagraphs ? 'error' : 'done', {
        completed: batches.length, total: batches.length, textNodes: entries.length
      });
      if (batchErrors.length) state.ui.status.title = batchErrors.join('\n');
      if (!updatedParagraphs) state.ui.status.textContent += ' دوباره تلاش کنید یا موتور دیگری برگزینید.';
    } catch (error) {
      const message = error && error.message ? error.message : 'ترجمه ناموفق بود.';
      selected.forEach((group) => { if (group.status === 'translating') group.status = 'failed'; });
      refreshGroupStatuses(state);
      state.ui.status.textContent = `${message} ترجمه‌های قبلی حفظ شدند؛ می‌توانید دوباره تلاش کنید.`;
      sendProgress(state.jobId, 'error', { textNodes: entries.length });
    } finally {
      state.running = false;
      refreshToolbarControls(state);
    }
  }

  function showAllOriginal(state) {
    state.groups.forEach((group) => setGroupVersion(group, 0));
    state.ui.status.textContent = 'متن اصلی همهٔ پاراگراف‌ها نمایش داده می‌شود.';
    refreshToolbarControls(state);
  }

  function showLatestTranslations(state) {
    state.groups.forEach((group) => setGroupVersion(group, group.versions.length - 1));
    state.ui.status.textContent = 'آخرین ترجمهٔ هر پاراگراف نمایش داده می‌شود.';
    refreshToolbarControls(state);
  }

  function restorePage(state) {
    if (state.pickMode) exitPagePickMode(state);
    tools.restoreOriginal(state.records);
    state.groups.forEach((group) => {
      group.block.classList.toggle('wtpdf-page-translation-pickable', group.originalPickable);
      group.block.classList.toggle('wtpdf-page-translation-picked', group.originalPicked);
      if (group.originalStatus == null) delete group.block.dataset.wtpdfTranslationStatus;
      else group.block.setAttribute('data-wtpdf-translation-status', group.originalStatus);
    });
    state.records = []; state.groups = []; state.running = false;
    state.ui.toolbar.remove(); state.ui.style.remove();
    window.__wtpdfPageTranslation = null;
  }

  function initializePage(jobId, engine = 'auto') {
    const current = window.__wtpdfPageTranslation;
    if (current && current.records && current.records.length) {
      setTranslationEngine(current, engine);
      enterPagePickMode(current);
      return { ok: true, readyForSelection: true, alreadyReady: true, textNodes: current.records.length, paragraphs: current.groups.length };
    }
    const records = tools.collectTextNodes(document.body, document);
    const groups = buildGroups(records);
    if (!groups.length) return { ok: false, error: 'متن قابل‌انتخابی در این صفحه پیدا نشد.' };
    const state = {
      running: false, records, groups, groupByBlock: new Map(groups.map((group) => [group.block, group])),
      jobId: String(jobId || ''), selectedGroups: new Set(),
      translationEngine: PAGE_ENGINE_LABELS[engine] ? engine : 'auto',
      pickMode: false, pickClickHandler: null, pickKeyHandler: null, ui: null
    };
    window.__wtpdfPageTranslation = state;
    state.ui = makeToolbar(state);
    state.ui.engineSelect.addEventListener('change', () => {
      if (PAGE_ENGINE_LABELS[state.ui.engineSelect.value]) state.translationEngine = state.ui.engineSelect.value;
    });
    state.ui.pickToggle.addEventListener('click', () => {
      if (state.pickMode) exitPagePickMode(state);
      else enterPagePickMode(state);
    });
    state.ui.translate.addEventListener('click', () => translateSelected(state));
    state.ui.retry.addEventListener('click', () => translateSelected(state, true));
    state.ui.versionPrev.addEventListener('click', () => stepSelectedVersions(state, -1));
    state.ui.versionNext.addEventListener('click', () => stepSelectedVersions(state, 1));
    state.ui.original.addEventListener('click', () => showAllOriginal(state));
    state.ui.translated.addEventListener('click', () => showLatestTranslations(state));
    state.ui.restore.addEventListener('click', () => restorePage(state));
    enterPagePickMode(state);
    return { ok: true, readyForSelection: true, textNodes: records.length, paragraphs: groups.length };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return undefined;
    if (message.type === 'WTPDF_PAGE_TRANSLATE_START') {
      sendResponse(initializePage(String(message.jobId || ''), message.engine || 'auto'));
      return false;
    }
    if (message.type === 'WTPDF_PAGE_TRANSLATE_OPEN_SELECTION') {
      const state = window.__wtpdfPageTranslation;
      if (!state || !state.records || !state.records.length) {
        sendResponse({ ok: false, translatedCopy: false });
        return false;
      }
      setTranslationEngine(state, message.engine || state.translationEngine);
      enterPagePickMode(state);
      sendResponse({ ok: true, translatedCopy: true });
      return false;
    }
    return undefined;
  });
})();
