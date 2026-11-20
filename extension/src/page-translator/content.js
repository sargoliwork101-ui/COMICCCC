// Injected only into the duplicate tab: select paragraph blocks, translate chosen blocks and retain every result.
(function () {
  if (window.__wtpdfPageTranslation && window.__wtpdfPageTranslation.running) return;
  const tools = window.PageTranslationTools;
  if (!tools) return;

  // Keep the injected dock on the same local theme without changing site styles.
  if (!window.__wtpdfFocusThemeListener && chrome.storage?.onChanged) {
    window.__wtpdfFocusThemeListener = (changes, area) => {
      const theme = changes.hasaya_ui_theme?.newValue;
      const dock = window.__wtpdfPageTranslation?.ui?.toolbar;
      if (area === 'local' && dock && ['light', 'dark'].includes(theme)) dock.dataset.focusTheme = theme;
    };
    chrome.storage.onChanged.addListener(window.__wtpdfFocusThemeListener);
  }

  const JOB_PREFIX = 'WTPDF_PAGE_TRANSLATE_';
  const MAX_TRANSLATION_VERSIONS = 6; // آخرین ترجمه + پنج ترجمهٔ قبلی برای هر پاراگراف
  const toPersianNumber = (value) => String(value).replace(/\d/gu, (digit) => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)]);
  const ICONS = {
    select: '<circle cx="12" cy="12" r="7"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/>',
    done: '<path d="m5 12 4 4L19 6"/>',
    translate: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
    retry: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.6 9A7 7 0 0 1 18 6.5L20 12M4 12l2 5.5A7 7 0 0 0 18.4 15"/>',
    previous: '<path d="m15 18-6-6 6-6"/>',
    next: '<path d="m9 18 6-6-6-6"/>',
    original: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.5"/>',
    latest: '<path d="M4 5h16M4 10h12M4 15h9M4 20h6"/><path d="m17 14 3 3-3 3"/>',
    collapse: '<path d="m6 15 6-6 6 6"/><path d="M12 9v12M4 3h16"/>',
    expand: '<path d="m6 9 6 6 6-6"/><path d="M12 15V3M4 21h16"/>'
  };
  function setIconButton(button, label, icon) {
    button.setAttribute('aria-label', label);
    button.title = label;
    button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>`;
  }
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
          versionControls: null,
          versionPrev: null,
          versionNext: null,
          records: [],
          versions: [],
          activeVersion: 0,
          nextVersionNumber: 0,
          status: 'pending',
          lastAttempt: new Map(),
          lastAttemptSources: new Map(),
          lastEngine: null,
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
    ['google', 'فقط Google Translate'], ['mymemory', 'فقط MyMemory']
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
    const fontUrl = chrome.runtime.getURL?.('assets/fonts/Vazirmatn.woff2');
    style.textContent = `
      ${fontUrl ? `@font-face{font-family:HasayaDockVazirmatn;src:url(${JSON.stringify(fontUrl)}) format('woff2');font-weight:100 900;font-display:swap;}` : ''}
      [data-wtpdf-page-translation-ui="toolbar"]{position:fixed!important;top:auto!important;bottom:calc(12px + env(safe-area-inset-bottom,0px))!important;
        left:50%!important;right:auto!important;transform:translateX(-50%)!important;z-index:2147483647!important;
        width:fit-content!important;max-width:min(820px,calc(100vw - 24px))!important;max-height:min(42vh,260px);display:grid;
        grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"workflow review" "status status";align-items:center;gap:7px;
        padding:8px 10px;border-radius:14px;background:linear-gradient(135deg,#101a20 0%,#15242c 100%);
        color:#e1eef2;border:1px solid #29404a;box-shadow:0 8px 28px #0008;backdrop-filter:blur(12px);
        font:500 12px/1.4 HasayaDockVazirmatn,Vazirmatn,Tahoma,sans-serif;direction:rtl;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-role="heading"]{display:none;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-role="workflow"]{grid-area:workflow;display:flex;align-items:center;gap:6px;min-width:0;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-role="workflow"] section{position:relative;min-width:0;padding:0;border:0;background:transparent;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-role="engine-section"]{flex:1 1 190px;max-width:260px;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-role="step-label"],
      [data-wtpdf-page-translation-ui="toolbar"] [data-role="review-title"]{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
        clip:rect(0,0,0,0);white-space:nowrap;border:0;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-role="workflow"] select{width:100%;min-width:0;height:36px;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-role="status"]{grid-area:status;min-width:0;max-height:68px;overflow:auto;
        padding:5px 8px;border-radius:8px;background:#1c303a;color:#e1eef2;font-size:11px;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-role="status"][data-kind="error"]{background:#4a1d2b;color:#fecdd3;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-role="status"][data-kind="success"]{background:#123c32;color:#bbf7d0;}
      [data-wtpdf-page-translation-ui="toolbar"] button,[data-wtpdf-page-translation-ui="toolbar"] select{font:600 12px/1.4 HasayaDockVazirmatn,Vazirmatn,Tahoma,sans-serif;
        border:1px solid #29404a;border-radius:9px;background:#15242c;color:#fff;padding:5px 7px;cursor:pointer;}
      [data-wtpdf-page-translation-ui="toolbar"] .icon-button{display:inline-flex;align-items:center;justify-content:center;flex:0 0 36px;
        width:36px;height:36px;padding:0;color:#e1eef2;}
      [data-wtpdf-page-translation-ui="toolbar"] .icon-button svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.8;
        stroke-linecap:round;stroke-linejoin:round;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-action="translate-selected"]{background:#218b88;border-color:#6bd7ce;color:#fff;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-action="pick-toggle"][data-active="true"]{background:#14532d;border-color:#4ade80;color:#bbf7d0;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-action="retry-failed"]{border-color:#a16207;color:#fde68a;}
      [data-wtpdf-page-translation-ui="toolbar"] button:hover{background:#29404a;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-action="translate-selected"]:hover{background:#167f79;}
      [data-wtpdf-page-translation-ui="toolbar"] button:focus-visible,[data-wtpdf-page-translation-ui="toolbar"] select:focus-visible{outline:2px solid #6bd7ce;outline-offset:2px;}
      [data-wtpdf-page-translation-ui="toolbar"] button:disabled,[data-wtpdf-page-translation-ui="toolbar"] select:disabled{opacity:.55;cursor:not-allowed;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-role="review"]{grid-area:review;display:flex;align-items:center;gap:4px;flex-wrap:nowrap;min-width:0;padding:0;border:0;background:transparent;}
      [data-wtpdf-page-translation-ui="toolbar"][data-collapsed="true"]{width:auto!important;max-width:calc(100vw - 16px);grid-template-columns:auto;grid-template-areas:"review";padding:5px;}
      [data-wtpdf-page-translation-ui="toolbar"][data-collapsed="true"] [data-role="workflow"],
      [data-wtpdf-page-translation-ui="toolbar"][data-collapsed="true"] [data-role="status"],
      [data-wtpdf-page-translation-ui="toolbar"][data-collapsed="true"] [data-role="review"] button:not([data-action="dock-toggle"]){display:none;}
      [data-wtpdf-page-translation-ui="toolbar"][data-collapsed="true"] [data-role="review"]{justify-content:center;}
      .wtpdf-page-translation-has-version-controls{position:relative!important;}
      .wtpdf-page-translation-version-controls{display:inline-flex!important;align-items:center!important;gap:3px!important;
        position:absolute!important;top:0!important;right:0!important;z-index:5!important;direction:ltr!important;
        padding:2px!important;border:1px solid #29404a!important;border-radius:8px!important;background:#101a20ee!important;
        box-shadow:0 2px 8px #0006!important;opacity:0!important;pointer-events:none!important;transition:opacity .15s ease!important;}
      .wtpdf-page-translation-has-version-controls:hover > .wtpdf-page-translation-version-controls,
      .wtpdf-page-translation-has-version-controls:focus-within > .wtpdf-page-translation-version-controls{opacity:1!important;pointer-events:auto!important;}
      .wtpdf-page-translation-version-badge{display:inline-block!important;margin:0!important;padding:4px 10px!important;
        border:1px solid #29404a!important;border-radius:8px!important;background:#1c303a!important;color:#e1eef2!important;
        font:600 clamp(11px,1.05vw,14px)/1.5 HasayaDockVazirmatn,Vazirmatn,Tahoma,sans-serif!important;direction:rtl!important;white-space:nowrap!important;}
      .wtpdf-page-translation-version-controls button{display:inline-flex!important;align-items:center!important;justify-content:center!important;
        flex:0 0 20px!important;width:20px!important;height:20px!important;padding:0!important;border:1px solid #29404a!important;border-radius:5px!important;
        background:#15242c!important;color:#fff!important;font:700 12px/1 HasayaDockVazirmatn,Vazirmatn,Tahoma,sans-serif!important;cursor:pointer!important;}
      .wtpdf-page-translation-version-controls button:disabled{opacity:.45!important;cursor:not-allowed!important;}
      .wtpdf-page-translation-pickable{outline:2px dashed #fbbf24!important;outline-offset:3px;cursor:pointer!important;}
      .wtpdf-page-translation-pickable:hover{background-color:#fbbf2430!important;}
      .wtpdf-page-translation-picked{outline:3px solid #22c55e!important;outline-offset:3px;background-color:#22c55e24!important;}
      [data-wtpdf-translation-status="translated"]:not(.wtpdf-page-translation-picked){outline:2px solid #22c55e!important;outline-offset:3px;}
      [data-wtpdf-translation-status="partial"]:not(.wtpdf-page-translation-picked){outline:2px solid #fbbf24!important;outline-offset:3px;}
      [data-wtpdf-translation-status="failed"]:not(.wtpdf-page-translation-picked){outline:2px solid #f87171!important;outline-offset:3px;}
      [data-wtpdf-translation-status="translating"]:not(.wtpdf-page-translation-picked){outline:2px solid #93c5fd!important;outline-offset:3px;}
      [data-wtpdf-page-translation-ui="toolbar"][data-focus-theme="light"]{background:#d8e3e2;color:#203c41;border-color:#cee0e0;}
      [data-wtpdf-page-translation-ui="toolbar"][data-focus-theme="light"] :is(button,select){background:#e4eceb;color:#203c41;border-color:#b8d1d2;}
      [data-wtpdf-page-translation-ui="toolbar"][data-focus-theme="light"] [data-action="translate-selected"]{background:#167f79;color:#fff;border-color:#15817b;}
      [data-wtpdf-page-translation-ui="toolbar"][data-focus-theme="light"] [data-role="status"]:not([data-kind="error"]):not([data-kind="success"]){background:#ccdcd9;color:#203c41;}
      @media(max-width:640px){[data-wtpdf-page-translation-ui="toolbar"]{bottom:calc(8px + env(safe-area-inset-bottom,0px))!important;
        width:calc(100vw - 16px)!important;grid-template-columns:minmax(0,1fr);grid-template-areas:"workflow" "review" "status";gap:5px;padding:7px;}
        [data-wtpdf-page-translation-ui="toolbar"] [data-role="workflow"]{width:100%;gap:5px;}
        [data-wtpdf-page-translation-ui="toolbar"] [data-role="engine-section"]{flex:1 1 110px;max-width:none;}
        [data-wtpdf-page-translation-ui="toolbar"] [data-role="review"]{justify-content:center;}
        [data-wtpdf-page-translation-ui="toolbar"] [data-role="status"]{max-height:54px;font-size:10px;}
        .wtpdf-page-translation-version-badge{font-size:10px!important;padding:2px 7px!important;max-width:170px!important;overflow:hidden!important;text-overflow:ellipsis!important;}}
      @media(max-width:360px){[data-wtpdf-page-translation-ui="toolbar"] .icon-button{flex-basis:32px;width:32px;height:34px;}
        [data-wtpdf-page-translation-ui="toolbar"] [data-role="workflow"]{gap:4px;}}
    `;
    const toolbar = document.createElement('div');
    toolbar.dataset.wtpdfPageTranslationUi = 'toolbar';
    toolbar.dataset.focusTheme = window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    try {
      Promise.resolve(chrome.storage?.local?.get(['hasaya_ui_theme'])).then(saved => {
        if (['light', 'dark'].includes(saved?.hasaya_ui_theme)) toolbar.dataset.focusTheme = saved.hasaya_ui_theme;
      }).catch(() => {});
    } catch { /* local theme is optional; OCR/document data is not read */ }

    toolbar.setAttribute('role', 'region');
    toolbar.setAttribute('aria-label', 'انتخاب، ترجمه و بازبینی متن صفحه');
    const heading = document.createElement('div');
    heading.dataset.role = 'heading';
    const title = document.createElement('strong');
    title.textContent = 'ترجمهٔ صفحه';
    const hint = document.createElement('span');
    hint.dataset.role = 'hint';
    hint.textContent = 'روی متن دلخواه کلیک کنید تا انتخاب شود، بعد موتور را برگزینید و ترجمه را شروع کنید.';
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
    pickToggle.type = 'button'; pickToggle.className = 'icon-button'; pickToggle.dataset.action = 'pick-toggle';
    pickToggle.dataset.active = 'true';
    setIconButton(pickToggle, 'پایان انتخاب', ICONS.done);
    selectionSection.append(selectionLabel, pickToggle);

    const translateSection = document.createElement('section');
    translateSection.dataset.role = 'translate-section';
    const translateLabel = document.createElement('span');
    translateLabel.dataset.role = 'step-label'; translateLabel.textContent = '۳ · دریافت ترجمه';
    const translate = document.createElement('button');
    translate.type = 'button'; translate.className = 'icon-button'; translate.dataset.action = 'translate-selected';
    setIconButton(translate, 'ترجمهٔ انتخاب‌ها', ICONS.translate);
    translateSection.append(translateLabel, translate);
    workflow.append(engineSection, selectionSection, translateSection);

    const review = document.createElement('div');
    review.dataset.role = 'review';
    const reviewTitle = document.createElement('span');
    reviewTitle.dataset.role = 'review-title'; reviewTitle.textContent = 'بازبینی و نسخه‌ها';
    const retry = document.createElement('button');
    retry.type = 'button'; retry.className = 'icon-button'; retry.dataset.action = 'retry-failed';
    setIconButton(retry, 'تلاش دوباره برای بخش‌های ناموفق', ICONS.retry);
    const original = document.createElement('button');
    original.type = 'button'; original.className = 'icon-button'; original.dataset.action = 'original';
    setIconButton(original, 'نمایش متن اصلی', ICONS.original);
    const translated = document.createElement('button');
    translated.type = 'button'; translated.className = 'icon-button'; translated.dataset.action = 'translated';
    setIconButton(translated, 'نمایش آخرین ترجمه', ICONS.latest);
    const dockToggle = document.createElement('button');
    dockToggle.type = 'button'; dockToggle.className = 'icon-button'; dockToggle.dataset.action = 'dock-toggle';
    dockToggle.setAttribute('aria-expanded', 'true');
    setIconButton(dockToggle, 'جمع‌کردن نوار ابزار', ICONS.collapse);
    review.append(reviewTitle, retry, original, translated, dockToggle);

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
      original, translated, dockToggle, status };
  }

  function versionTextMap(records, values, translatedIds) {
    return tools.showVersion(records, values, translatedIds);
  }

  function updateVersionBadge(group) {
    if (group.versions.length <= 1) {
      // بدون ترجمهٔ ذخیره‌شده، کادر نسخه‌ها روی این پاراگراف نمایش داده نمی‌شود
      if (group.versionControls && group.versionControls.isConnected) {
        group.versionControls.remove();
      }
      group.versionControls = null;
      group.versionPrev = null;
      group.versionBadge = null;
      group.versionNext = null;
      group.block.classList.remove('wtpdf-page-translation-has-version-controls');
      return;
    }
    if (!group.versionControls || !group.versionControls.isConnected) {
      group.block.classList.add('wtpdf-page-translation-has-version-controls');
      const controls = document.createElement('span');
      controls.className = 'wtpdf-page-translation-version-controls';
      controls.dataset.wtpdfPageTranslationUi = 'version-controls';
      controls.setAttribute('role', 'group');
      controls.setAttribute('aria-label', `نسخه‌های ترجمهٔ ${group.label}`);
      const previous = document.createElement('button');
      previous.type = 'button';
      previous.textContent = '<';
      previous.setAttribute('aria-label', `نمایش ترجمهٔ قبلی برای ${group.label}`);
      previous.title = `ترجمهٔ قبلی · ${group.label}`;
      previous.addEventListener('click', () => stepGroupVersion(group, -1));
      const badge = document.createElement('span');
      badge.className = 'wtpdf-page-translation-version-badge';
      badge.dataset.wtpdfPageTranslationUi = 'version-badge';
      badge.setAttribute('aria-live', 'polite');
      const next = document.createElement('button');
      next.type = 'button';
      next.textContent = '>';
      next.setAttribute('aria-label', `نمایش ترجمهٔ بعدی برای ${group.label}`);
      next.title = `ترجمهٔ بعدی · ${group.label}`;
      next.addEventListener('click', () => stepGroupVersion(group, 1));
      controls.append(previous, badge, next);
      group.block.insertBefore(controls, group.block.firstChild);
      group.versionControls = controls;
      group.versionPrev = previous;
      group.versionBadge = badge;
      group.versionNext = next;
    }
    const saved = Math.max(0, group.versions.length - 1);
    const version = group.versions[group.activeVersion] || group.versions[0];
    const source = version && version.sourceLabel ? ` · ترجمه با ${version.sourceLabel}` : '';
    group.versionBadge.textContent = `${toPersianNumber(saved)} ترجمهٔ ذخیره‌شده${source}`;
    group.versionBadge.setAttribute('aria-label', `${toPersianNumber(saved)} ترجمهٔ ذخیره‌شده برای ${group.label}${source}`);
    group.versionBadge.title = `برای این پاراگراف ${toPersianNumber(saved)} ترجمه ذخیره شده است؛ حداکثر ${toPersianNumber(MAX_TRANSLATION_VERSIONS)} نسخه نگه‌داری می‌شود.${source}`;
    group.versionPrev.disabled = group.activeVersion <= 0;
    group.versionNext.disabled = group.activeVersion >= group.versions.length - 1;
  }

  function updateEngineOptions(state, availableAiEngines) {
    const current = state.translationEngine || 'google';
    state.availableAiEngines = Array.isArray(availableAiEngines) ? availableAiEngines : [];
    state.engineOptions = buildPageEngineOptions(state.availableAiEngines);
    state.engineLabels = Object.fromEntries(state.engineOptions.map(({ value, label }) => [value, label]));
    state.translationEngine = Object.hasOwn(state.engineLabels, current) ? current : 'google';
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
    state.ui.pickToggle.dataset.active = state.pickMode ? 'true' : 'false';
    setIconButton(state.ui.pickToggle, state.pickMode ? 'پایان انتخاب' : 'انتخاب متن روی صفحه',
      state.pickMode ? ICONS.done : ICONS.select);
    state.ui.translate.disabled = state.running || state.pickMode || selected.length === 0;
    state.ui.retry.disabled = state.running || state.pickMode || !canRetry;
    state.ui.engineSelect.disabled = state.running;
    state.ui.original.disabled = state.running || state.pickMode;
    state.ui.translated.disabled = state.running || state.pickMode;
    state.ui.pickToggle.disabled = state.running;
  }

  function setTranslationEngine(state, engine) {
    state.translationEngine = Object.hasOwn(state.engineLabels, engine) ? engine : 'google';
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

  function stepGroupVersion(group, amount) {
    if (!group || !group.versions.length) return;
    setGroupVersion(group, group.activeVersion + amount);
  }

  // خطاهای فنی مرورگر را به پیام فارسی و قابل‌فهم تبدیل می‌کند تا کاربر بداند چه کند.
  function friendlyPageError(message) {
    const text = String(message || '');
    if (/Extension context invalidated/i.test(text)) {
      return 'افزونه تازه‌بارگذاری شده است؛ صفحه را تازه‌سازی کنید و دوباره تلاش کنید.';
    }
    if (/Could not establish connection|message port closed|Receiving end does not exist/i.test(text)) {
      return 'ارتباط با افزونه برقرار نشد؛ صفحه را تازه‌سازی کنید و دوباره تلاش کنید.';
    }
    return text;
  }

  async function translateSelected(state, retryOnly = false) {
    if (state.running || state.pickMode) return;
    const picked = state.groups.filter((group) => state.selectedGroups.has(group.id));
    // پاراگرافی که با همین موتور کامل ترجمه شده، دوباره به سرویس فرستاده نمی‌شود
    // (ترجمهٔ تکراری با همان موتور نتیجهٔ یکسان می‌دهد و هزینهٔ API دارد).
    // با موتور متفاوت، ترجمهٔ دوباره مجاز است تا نسخهٔ جدید برای مقایسه ساخته شود.
    const selected = picked.filter((group) => retryOnly
      ? (group.failedPartIds && group.failedPartIds.size)
      : !(group.status === 'translated' && group.lastEngine === state.translationEngine));
    if (!selected.length) {
      if (!retryOnly && picked.length && picked.every((group) => group.status === 'translated' && group.lastEngine === state.translationEngine)) {
        state.ui.status.textContent = 'این پاراگراف‌ها با همین موتور قبلاً ترجمه شده‌اند و دوباره ارسال نمی‌شوند؛ برای نسخهٔ جدید، موتور دیگری برگزینید.';
      } else {
        state.ui.status.textContent = retryOnly
          ? 'در پاراگراف‌های انتخاب‌شده بخش ناموفقی برای تلاش دوباره نیست.'
          : 'برای ترجمه، روی پاراگراف‌های دلخواه کلیک کنید و انتخاب را پایان دهید.';
      }
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
      state.ui.status.textContent = 'بخش جدیدی برای ارسال پیدا نشد؛ ترجمه‌های قبلی سر جایشان هستند.';
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
          batchErrors.push(friendlyPageError(error && error.message ? error.message : 'خطای ارتباط با سرویس ترجمه'));
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
          group.lastEngine = state.translationEngine;
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

  function initializePage(jobId, engine = 'google', availableAiEngines = []) {
    const current = window.__wtpdfPageTranslation;
    if (current && current.records && current.records.length) {
      updateEngineOptions(current, availableAiEngines);
      setTranslationEngine(current, engine);
      enterPagePickMode(current);
      return { ok: true, readyForSelection: true, alreadyReady: true, textNodes: current.records.length, paragraphs: current.groups.length };
    }
    const records = tools.collectTextNodes(document.body, document);
    const groups = buildGroups(records);
    if (!groups.length) return { ok: false, error: 'در این صفحه متن قابل انتخابی پیدا نشد.' };
    groups.forEach(updateVersionBadge);
    const state = {
      running: false, records, groups, groupByBlock: new Map(groups.map((group) => [group.block, group])),
      jobId: String(jobId || ''), selectedGroups: new Set(), translationEngine: 'google',
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
    state.ui.original.addEventListener('click', () => showAllOriginal(state));
    state.ui.translated.addEventListener('click', () => showLatestTranslations(state));
    state.ui.dockToggle.addEventListener('click', () => {
      const collapsed = state.ui.toolbar.dataset.collapsed !== 'true';
      state.ui.toolbar.dataset.collapsed = collapsed ? 'true' : 'false';
      state.ui.dockToggle.setAttribute('aria-expanded', String(!collapsed));
      setIconButton(state.ui.dockToggle, collapsed ? 'بازکردن نوار ابزار' : 'جمع‌کردن نوار ابزار',
        collapsed ? ICONS.expand : ICONS.collapse);
    });
    enterPagePickMode(state);
    return { ok: true, readyForSelection: true, textNodes: records.length, paragraphs: groups.length };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return undefined;
    if (message.type === 'WTPDF_PAGE_TRANSLATE_START') {
      sendResponse(initializePage(String(message.jobId || ''), message.engine || 'google', message.availableAiEngines || []));
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
