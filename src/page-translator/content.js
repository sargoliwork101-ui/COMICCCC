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
          versionBadge: null,
          records: [],
          versions: [],
          activeVersion: 0,
          nextVersionNumber: 0,
          status: 'pending',
          lastAttempt: new Map(),
          lastAttemptSources: new Map(),
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

  const PAGE_FREE_ENGINE_OPTIONS = [
    ['auto', 'Google؛ اگر نشد MyMemory'], ['google', 'فقط Google Translate'], ['mymemory', 'فقط MyMemory']
  ];
  const AI_PROVIDER_LABELS = {
    gemini: 'Google Gemini', openai: 'OpenAI', openrouter: 'OpenRouter', avalai: 'AvalAI'
  };
  function buildPageEngineOptions(availableAiEngines) {
    const options = PAGE_FREE_ENGINE_OPTIONS.map(([value, label]) => ({ value, label }));
    const seen = new Set();
    (Array.isArray(availableAiEngines) ? availableAiEngines : []).forEach((item) => {
      const provider = String(item && item.provider || '').toLowerCase();
      const model = String(item && item.model || '').trim();
      if (!Object.hasOwn(AI_PROVIDER_LABELS, provider) || !model || seen.has(provider)) return;
      seen.add(provider);
      options.push({ value: `ai:${provider}`, label: `${AI_PROVIDER_LABELS[provider]} · ${model} (تنظیم‌شده)` });
    });
    return options;
  }

  function makeToolbar(state) {
    const style = document.createElement('style');
    style.dataset.wtpdfPageTranslationUi = 'style';
    style.textContent = `
      [data-wtpdf-page-translation-ui="toolbar"]{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;
        width:min(1000px,calc(100vw - 24px));display:grid;gap:10px;padding:12px 14px;border-radius:16px;
        background:linear-gradient(135deg,#18212f 0%,#202d40 100%);color:#f8fafc;border:1px solid #64748b;box-shadow:0 10px 34px #0008;
        font:500 13px/1.5 system-ui,sans-serif;direction:rtl;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-role="heading"]{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-role="heading"] strong{font-size:15px;white-space:nowrap;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-role="hint"]{color:#cbd5e1;font-size:12px;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-role="workflow"]{display:grid;grid-template-columns:minmax(230px,1.2fr) minmax(170px,.8fr) minmax(170px,.8fr);gap:8px;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-role="workflow"] section,
      [data-wtpdf-page-translation-ui="toolbar"] [data-role="review"]{min-width:0;padding:8px 10px;border:1px solid #475569;border-radius:11px;background:#172033;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-role="step-label"]{display:block;margin-bottom:5px;color:#cbd5e1;font-size:11px;font-weight:700;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-role="workflow"] select{width:100%;min-width:0;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-role="workflow"] button{width:100%;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-role="status"]{min-width:0;padding:8px 10px;border-radius:9px;background:#263449;color:#e2e8f0;font-size:12px;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-role="status"][data-kind="error"]{background:#4a1d2b;color:#fecdd3;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-role="status"][data-kind="success"]{background:#123c32;color:#bbf7d0;}
      [data-wtpdf-page-translation-ui="toolbar"] button,[data-wtpdf-page-translation-ui="toolbar"] select{font:600 12px/1.4 system-ui,sans-serif;
        border:1px solid #64748b;border-radius:8px;background:#273449;color:#fff;padding:7px 9px;cursor:pointer;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-action="translate-selected"]{background:#4f46e5;border-color:#818cf8;}
      [data-wtpdf-page-translation-ui="toolbar"] button:hover{background:#35445e;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-action="translate-selected"]:hover{background:#4338ca;}
      [data-wtpdf-page-translation-ui="toolbar"] button:focus-visible,[data-wtpdf-page-translation-ui="toolbar"] select:focus-visible{outline:2px solid #a5b4fc;outline-offset:2px;}
      [data-wtpdf-page-translation-ui="toolbar"] button:disabled,[data-wtpdf-page-translation-ui="toolbar"] select:disabled{opacity:.55;cursor:not-allowed;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-role="review"]{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-role="review-title"]{margin-inline-end:auto;color:#cbd5e1;font-size:11px;font-weight:700;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-action="retry-failed"]{border-color:#a16207;color:#fde68a;}
      .wtpdf-page-translation-version-badge{display:block!important;width:max-content!important;max-width:100%!important;margin:0 0 5px auto!important;
        padding:3px 9px!important;border:1px solid #6b7280!important;border-radius:9px!important;background:#172033!important;color:#f8fafc!important;
        font:600 11px/1.55 system-ui,sans-serif!important;direction:rtl!important;opacity:.97!important;overflow-wrap:anywhere!important;}
      .wtpdf-page-translation-pickable{outline:2px dashed #fbbf24!important;outline-offset:3px;cursor:pointer!important;}
      .wtpdf-page-translation-pickable:hover{background-color:#fbbf2430!important;}
      .wtpdf-page-translation-picked{outline:3px solid #22c55e!important;outline-offset:3px;background-color:#22c55e24!important;}
      [data-wtpdf-translation-status="translated"]:not(.wtpdf-page-translation-picked){outline:2px solid #22c55e!important;outline-offset:3px;}
      [data-wtpdf-translation-status="partial"]:not(.wtpdf-page-translation-picked){outline:2px solid #fbbf24!important;outline-offset:3px;}
      [data-wtpdf-translation-status="failed"]:not(.wtpdf-page-translation-picked){outline:2px solid #f87171!important;outline-offset:3px;}
      [data-wtpdf-translation-status="translating"]:not(.wtpdf-page-translation-picked){outline:2px solid #93c5fd!important;outline-offset:3px;}
      @media(max-width:760px){[data-wtpdf-page-translation-ui="toolbar"]{top:6px;width:calc(100vw - 12px);gap:7px;padding:9px;}
        [data-wtpdf-page-translation-ui="toolbar"] [data-role="heading"]{align-items:flex-start;flex-direction:column;gap:2px;}
        [data-wtpdf-page-translation-ui="toolbar"] [data-role="workflow"]{grid-template-columns:1fr;}
        [data-wtpdf-page-translation-ui="toolbar"] [data-role="review"]{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));}
        [data-wtpdf-page-translation-ui="toolbar"] [data-role="review-title"]{grid-column:1/-1;}
        [data-wtpdf-page-translation-ui="toolbar"] [data-role="status"]{font-size:11px;}}
    `;
    const toolbar = document.createElement('div');
    toolbar.dataset.wtpdfPageTranslationUi = 'toolbar';
    toolbar.setAttribute('role', 'region');
    toolbar.setAttribute('aria-label', 'انتخاب، ترجمه و بازبینی متن صفحه');
    const heading = document.createElement('div');
    heading.dataset.role = 'heading';
    const title = document.createElement('strong');
    title.textContent = 'ترجمهٔ صفحه';
    const hint = document.createElement('span');
    hint.dataset.role = 'hint';
    hint.textContent = 'متن دلخواه را روی صفحه انتخاب کنید؛ بعد موتور را برگزینید و ترجمه را شروع کنید.';
    heading.append(title, hint);

    const workflow = document.createElement('div');
    workflow.dataset.role = 'workflow';
    const engineSection = document.createElement('section');
    engineSection.dataset.role = 'engine-section';
    const engineLabel = document.createElement('label');
    engineLabel.dataset.role = 'step-label'; engineLabel.textContent = '۱ · موتور ترجمه';
    const engineSelect = document.createElement('select');
    engineSelect.dataset.role = 'translation-engine';
    engineSelect.setAttribute('aria-label', 'انتخاب موتور ترجمه');
    engineSection.append(engineLabel, engineSelect);

    const selectionSection = document.createElement('section');
    selectionSection.dataset.role = 'selection-section';
    const selectionLabel = document.createElement('span');
    selectionLabel.dataset.role = 'step-label'; selectionLabel.textContent = '۲ · متن دلخواه';
    const pickToggle = document.createElement('button');
    pickToggle.type = 'button'; pickToggle.dataset.action = 'pick-toggle';
    selectionSection.append(selectionLabel, pickToggle);

    const translateSection = document.createElement('section');
    translateSection.dataset.role = 'translate-section';
    const translateLabel = document.createElement('span');
    translateLabel.dataset.role = 'step-label'; translateLabel.textContent = '۳ · دریافت ترجمه';
    const translate = document.createElement('button');
    translate.type = 'button'; translate.dataset.action = 'translate-selected'; translate.textContent = 'ترجمهٔ انتخاب‌ها';
    translateSection.append(translateLabel, translate);
    workflow.append(engineSection, selectionSection, translateSection);

    const review = document.createElement('div');
    review.dataset.role = 'review';
    const reviewTitle = document.createElement('span');
    reviewTitle.dataset.role = 'review-title'; reviewTitle.textContent = 'بازبینی و نسخه‌ها';
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
    review.append(reviewTitle, retry, versionPrev, versionNext, original, translated);

    const status = document.createElement('div');
    status.dataset.role = 'status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    status.textContent = `برای شروع روی متن پاراگراف‌های دلخواه کلیک کنید؛ ${toPersianNumber(state.groups.length)} پاراگراف شناسایی شد.`;
    toolbar.append(heading, workflow, review, status);
    document.documentElement.append(style, toolbar);
    state.engineOptions.forEach(({ value, label }) => {
      const option = document.createElement('option');
      option.value = value; option.textContent = label;
      engineSelect.appendChild(option);
    });
    engineSelect.value = state.translationEngine;
    return { style, toolbar, heading, hint, workflow, engineSelect, pickToggle, translate, retry,
      versionPrev, versionNext, original, translated, status };
  }

  function versionTextMap(records, values, translatedIds) {
    return tools.showVersion(records, values, translatedIds);
  }

  function updateVersionBadge(group) {
    if (!group.versionBadge || !group.versionBadge.isConnected) {
      const badge = document.createElement('span');
      badge.className = 'wtpdf-page-translation-version-badge';
      badge.dataset.wtpdfPageTranslationUi = 'version-badge';
      badge.setAttribute('aria-live', 'polite');
      group.versionBadge = badge;
      group.block.insertBefore(badge, group.block.firstChild);
    }
    const saved = Math.max(0, group.versions.length - 1);
    const version = group.versions[group.activeVersion] || group.versions[0];
    const source = version && version.sourceLabel ? ` · ترجمه با ${version.sourceLabel}` : '';
    group.versionBadge.textContent = `${toPersianNumber(saved)} ترجمهٔ ذخیره‌شده${source}`;
    group.versionBadge.setAttribute('aria-label', `${toPersianNumber(saved)} ترجمهٔ ذخیره‌شده برای ${group.label}${source}`);
    group.versionBadge.title = `برای این پاراگراف ${toPersianNumber(saved)} ترجمه ذخیره شده است؛ حداکثر ${toPersianNumber(MAX_TRANSLATION_VERSIONS)} نسخه نگه‌داری می‌شود.${source}`;
  }

  function updateEngineOptions(state, availableAiEngines) {
    const current = state.translationEngine || 'auto';
    state.availableAiEngines = Array.isArray(availableAiEngines) ? availableAiEngines : [];
    state.engineOptions = buildPageEngineOptions(state.availableAiEngines);
    state.engineLabels = Object.fromEntries(state.engineOptions.map(({ value, label }) => [value, label]));
    state.translationEngine = Object.hasOwn(state.engineLabels, current) ? current : 'auto';
    if (!state.ui || !state.ui.engineSelect) return;
    state.ui.engineSelect.replaceChildren(...state.engineOptions.map(({ value, label }) => {
      const option = document.createElement('option');
      option.value = value; option.textContent = label;
      return option;
    }));
    state.ui.engineSelect.value = state.translationEngine;
  }

  function refreshGroupStatuses(state) {
    state.groups.forEach((group) => {
      group.block.dataset.wtpdfTranslationStatus = group.status;
      updateVersionBadge(group);
    });
  }

  function refreshToolbarControls(state) {
    if (!state.ui) return;
    const selected = state.groups.filter((group) => state.selectedGroups.has(group.id));
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
    state.ui.pickToggle.disabled = state.running;
  }

  function setTranslationEngine(state, engine) {
    state.translationEngine = Object.hasOwn(state.engineLabels, engine) ? engine : 'auto';
    if (state.ui && state.ui.engineSelect) state.ui.engineSelect.value = state.translationEngine;
  }

  function setGroupVersion(group, versionIndex) {
    const index = Math.max(0, Math.min(group.versions.length - 1, Number(versionIndex) || 0));
    const version = group.versions[index];
    group.activeVersion = index;
    versionTextMap(group.records, version.values, version.translatedIds);
    updateVersionBadge(group);
  }

  function syncPageSelection(state) {
    state.groups.forEach((group) => {
      group.block.classList.toggle('wtpdf-page-translation-pickable', state.pickMode || group.originalPickable);
      group.block.classList.toggle('wtpdf-page-translation-picked', state.selectedGroups.has(group.id) || group.originalPicked);
    });
  }

  function updatePickStatus(state) {
    state.ui.status.dataset.kind = 'prompt';
    state.ui.status.textContent = state.pickMode
      ? state.selectedGroups.size
        ? `${toPersianNumber(state.selectedGroups.size)} پاراگراف انتخاب شده؛ برای ادامه «پایان انتخاب» را بزنید.`
        : 'برای شروع، روی متن پاراگراف‌های دلخواه کلیک کنید؛ با «پایان انتخاب» آمادهٔ ترجمه شوید.'
      : state.selectedGroups.size
        ? `${toPersianNumber(state.selectedGroups.size)} پاراگراف آماده است؛ موتور را بررسی و «ترجمهٔ انتخاب‌ها» را بزنید.`
        : 'انتخابی ندارید؛ «انتخاب روی صفحه» را بزنید و متن دلخواه را مشخص کنید.';
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
        group.lastAttemptSources = new Map();
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
    const engineLabel = state.engineLabels[state.translationEngine] || 'موتور ترجمه';
    state.ui.status.dataset.kind = 'prompt';
    state.ui.status.title = '';
    state.ui.status.textContent = retryOnly
      ? `در حال تلاش دوباره با ${engineLabel} برای ${toPersianNumber(selected.length)} پاراگراف...`
      : `در حال ترجمه با ${engineLabel}؛ ${toPersianNumber(selected.length)} پاراگراف انتخاب شده...`;
    sendProgress(state.jobId, 'working', { total: batches.length, textNodes: entries.length });
    try {
      const translations = new Map();
      const translationSources = new Map();
      const batchErrors = [];
      const providerResults = new Set();
      for (let index = 0; index < batches.length; index++) {
        state.ui.status.textContent = `در حال ترجمه با ${engineLabel}... بستهٔ ${index + 1} از ${batches.length}`;
        try {
          const response = await chrome.runtime.sendMessage({
            type: 'WTPDF_TRANSLATE_PAGE_BATCH', entries: batches[index], engine: state.translationEngine
          });
          if (!response || !response.ok) throw new Error(response && response.error || 'سرویس ترجمه پاسخ نداد.');
          const source = {
            provider: String(response.provider || engineLabel),
            model: String(response.model || '').trim()
          };
          providerResults.add(source.model ? `${source.provider} · ${source.model}` : source.provider);
          const expectedIds = new Set(batches[index].map((entry) => entry.id));
          let received = 0;
          (Array.isArray(response.translations) ? response.translations : []).forEach((row) => {
            if (row && expectedIds.has(row.id) && typeof row.text === 'string' && row.text.trim()) {
              translations.set(row.id, row.text.trim());
              translationSources.set(row.id, source);
              received++;
            }
          });
          if (!received) throw new Error(response.error || `${engineLabel} پاسخ ترجمهٔ قابل‌استفاده‌ای برنگرداند.`);
          if (received < expectedIds.size) {
            batchErrors.push(`${engineLabel}: ${toPersianNumber(expectedIds.size - received)} متن از این بسته در پاسخ نبود.`);
          }
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
            group.lastAttemptSources.set(id, translationSources.get(id) || { provider: engineLabel, model: '' });
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
        const sourceLabels = [...new Set(expectedParts.filter((part) => group.lastAttempt.has(part.id)).map((part) => {
          const source = group.lastAttemptSources.get(part.id);
          return source ? (source.model ? `${source.provider} · مدل ${source.model}` : source.provider) : '';
        }).filter(Boolean))];
        group.nextVersionNumber++;
        const version = {
          label: group.status === 'partial' ? `ترجمهٔ ${group.nextVersionNumber} (ناقص)` : `ترجمهٔ ${group.nextVersionNumber}`,
          values, translatedIds, sourceLabel: sourceLabels.join(' / ')
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
      const summary = `${toPersianNumber(completedParagraphs)} کامل، ${toPersianNumber(partialParagraphs)} ناقص، ${toPersianNumber(failedParagraphs)} ناموفق`;
      const actualEngine = [...providerResults].join(' / ') || engineLabel;
      state.ui.status.dataset.kind = failedParagraphs || partialParagraphs ? 'error' : 'success';
      state.ui.status.textContent = `${actualEngine}: ${summary}. ترجمه‌های موفق و نسخه‌های قبلی حفظ شدند.`;
      sendProgress(state.jobId, failedParagraphs || partialParagraphs ? 'error' : 'done', {
        completed: batches.length, total: batches.length, textNodes: entries.length
      });
      if (batchErrors.length) {
        const detail = batchErrors.slice(0, 3).join(' · ').slice(0, 420);
        state.ui.status.title = detail;
        state.ui.status.textContent += ` جزئیات: ${detail}`;
      }
      if (!updatedParagraphs) state.ui.status.textContent += ' هیچ ترجمه‌ای دریافت نشد؛ پیام بالا را بررسی کنید و دوباره تلاش کنید یا موتور دیگری برگزینید.';
    } catch (error) {
      const message = error && error.message ? error.message : 'ترجمه ناموفق بود.';
      selected.forEach((group) => { if (group.status === 'translating') group.status = 'failed'; });
      refreshGroupStatuses(state);
      state.ui.status.dataset.kind = 'error';
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

  function initializePage(jobId, engine = 'auto', availableAiEngines = []) {
    const current = window.__wtpdfPageTranslation;
    if (current && current.records && current.records.length) {
      updateEngineOptions(current, availableAiEngines);
      setTranslationEngine(current, engine);
      enterPagePickMode(current);
      return { ok: true, readyForSelection: true, alreadyReady: true, textNodes: current.records.length, paragraphs: current.groups.length };
    }
    const records = tools.collectTextNodes(document.body, document);
    const groups = buildGroups(records);
    if (!groups.length) return { ok: false, error: 'متن قابل‌انتخابی در این صفحه پیدا نشد.' };
    groups.forEach(updateVersionBadge);
    const state = {
      running: false, records, groups, groupByBlock: new Map(groups.map((group) => [group.block, group])),
      jobId: String(jobId || ''), selectedGroups: new Set(), translationEngine: 'auto',
      pickMode: false, pickClickHandler: null, pickKeyHandler: null, ui: null,
      engineOptions: [], engineLabels: {}, availableAiEngines: []
    };
    updateEngineOptions(state, availableAiEngines);
    setTranslationEngine(state, engine);
    window.__wtpdfPageTranslation = state;
    state.ui = makeToolbar(state);
    state.ui.engineSelect.addEventListener('change', () => {
      if (Object.hasOwn(state.engineLabels, state.ui.engineSelect.value)) state.translationEngine = state.ui.engineSelect.value;
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
    enterPagePickMode(state);
    return { ok: true, readyForSelection: true, textNodes: records.length, paragraphs: groups.length };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return undefined;
    if (message.type === 'WTPDF_PAGE_TRANSLATE_START') {
      sendResponse(initializePage(String(message.jobId || ''), message.engine || 'auto', message.availableAiEngines || []));
      return false;
    }
    if (message.type === 'WTPDF_PAGE_TRANSLATE_OPEN_SELECTION') {
      const state = window.__wtpdfPageTranslation;
      if (!state || !state.records || !state.records.length) {
        sendResponse({ ok: false, translatedCopy: false });
        return false;
      }
      if (Array.isArray(message.availableAiEngines)) updateEngineOptions(state, message.availableAiEngines);
      setTranslationEngine(state, message.engine || state.translationEngine);
      enterPagePickMode(state);
      sendResponse({ ok: true, translatedCopy: true });
      return false;
    }
    return undefined;
  });
})();
