// Injected only into the duplicate tab: select paragraph blocks, translate chosen blocks and retain every result.
(function () {
  if (window.__wtpdfPageTranslation && window.__wtpdfPageTranslation.running) return;
  const tools = window.PageTranslationTools;
  if (!tools) return;

  const JOB_PREFIX = 'WTPDF_PAGE_TRANSLATE_';
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
          records: [],
          versions: [],
          activeVersion: 0,
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
        display:flex;align-items:center;gap:8px;max-width:calc(100vw - 24px);padding:9px 13px;border-radius:12px;
        background:#18212f;color:#fff;border:1px solid #64748b;box-shadow:0 8px 32px #0007;
        font:600 13px/1.5 system-ui,sans-serif;direction:rtl;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-role="status"]{max-width:min(34vw,420px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      [data-wtpdf-page-translation-ui="toolbar"] button,[data-wtpdf-page-translation-ui="panel"] button,
      [data-wtpdf-page-translation-ui="panel"] select{font:600 12px/1.4 system-ui,sans-serif;border:1px solid #94a3b8;border-radius:8px;
        background:#273449;color:#fff;padding:7px 9px;cursor:pointer;}
      [data-wtpdf-page-translation-ui="toolbar"] button:hover,[data-wtpdf-page-translation-ui="panel"] button:hover{background:#35445e;}
      [data-wtpdf-page-translation-ui="toolbar"] button:focus-visible,[data-wtpdf-page-translation-ui="panel"] button:focus-visible,
      [data-wtpdf-page-translation-ui="panel"] input:focus-visible,[data-wtpdf-page-translation-ui="panel"] select:focus-visible{outline:2px solid #a5b4fc;outline-offset:2px;}
      [data-wtpdf-page-translation-ui="panel"]{position:fixed;top:68px;right:12px;z-index:2147483646;width:min(440px,calc(100vw - 24px));
        max-height:calc(100vh - 82px);display:flex;flex-direction:column;gap:10px;overflow:hidden;padding:14px;border-radius:14px;
        background:#18212f;color:#fff;border:1px solid #64748b;box-shadow:0 10px 36px #0008;font:13px/1.6 system-ui,sans-serif;direction:rtl;}
      [data-wtpdf-page-translation-ui="panel"] [data-role="panel-head"]{display:flex;align-items:center;justify-content:space-between;gap:8px;}
      [data-wtpdf-page-translation-ui="panel"] [data-role="panel-list"]{display:flex;flex-direction:column;gap:8px;overflow:auto;min-height:70px;padding:2px;}
      [data-wtpdf-page-translation-ui="panel"] [data-role="paragraph"]{display:grid;grid-template-columns:auto 1fr;gap:5px 8px;padding:9px;border:1px solid #46566d;border-radius:10px;background:#202c3d;}
      [data-wtpdf-page-translation-ui="panel"] [data-role="paragraph"] input{grid-row:1 / span 3;align-self:start;margin-top:4px;accent-color:#a5b4fc;}
      [data-wtpdf-page-translation-ui="panel"] [data-role="snippet"]{max-height:4.8em;overflow:auto;color:#e2e8f0;overflow-wrap:anywhere;}
      [data-wtpdf-page-translation-ui="panel"] [data-role="paragraph-status"]{font-size:11px;color:#cbd5e1;}
      .wtpdf-page-translation-pickable{outline:2px dashed #fbbf24!important;outline-offset:3px;cursor:pointer!important;}
      .wtpdf-page-translation-pickable:hover{background-color:#fbbf2430!important;}
      .wtpdf-page-translation-picked{outline:3px solid #22c55e!important;outline-offset:3px;background-color:#22c55e24!important;}
      [data-wtpdf-page-translation-ui="panel"] [data-state="translated"]{color:#86efac;}
      [data-wtpdf-page-translation-ui="panel"] [data-state="partial"],[data-wtpdf-page-translation-ui="panel"] [data-state="failed"]{color:#fca5a5;}
      [data-wtpdf-page-translation-ui="panel"] [data-state="translating"]{color:#fde68a;}
      [data-wtpdf-page-translation-ui="panel"] [data-role="variant-row"]{display:flex;align-items:center;gap:7px;color:#cbd5e1;font-size:11px;}
      [data-wtpdf-page-translation-ui="panel"] [data-role="variant"]{max-width:210px;padding:5px 7px;}
      [data-wtpdf-page-translation-ui="panel"] [data-role="panel-controls"]{display:flex;flex-wrap:wrap;gap:7px;}
      [data-wtpdf-page-translation-ui="panel"] [data-role="engine-row"]{display:flex;align-items:center;gap:8px;color:#e2e8f0;font-size:12px;}
      [data-wtpdf-page-translation-ui="panel"] [data-role="translation-engine"]{flex:1;min-width:0;}
      [data-wtpdf-page-translation-ui="panel"] [data-role="panel-status"]{min-height:1.4em;margin:0;color:#cbd5e1;font-size:12px;}
      [data-wtpdf-page-translation-ui="panel"] button:disabled{opacity:.55;cursor:wait;}
      @media(max-width:720px){[data-wtpdf-page-translation-ui="toolbar"]{flex-wrap:wrap;justify-content:center;top:6px;}
        [data-wtpdf-page-translation-ui="toolbar"] [data-role="status"]{max-width:90vw;}
        [data-wtpdf-page-translation-ui="panel"]{top:96px;right:8px;width:calc(100vw - 16px);max-height:calc(100vh - 108px);}}
    `;
    const toolbar = document.createElement('div');
    toolbar.dataset.wtpdfPageTranslationUi = 'toolbar';
    toolbar.setAttribute('role', 'region');
    toolbar.setAttribute('aria-label', 'کنترل ترجمهٔ صفحه');
    const status = document.createElement('span');
    status.dataset.role = 'status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    status.textContent = `متن صفحه آماده است؛ ${state.groups.length} پاراگراف شناسایی شد.`;
    const select = document.createElement('button');
    select.type = 'button'; select.dataset.action = 'select'; select.textContent = 'انتخاب و ترجمه';
    const finishPick = document.createElement('button');
    finishPick.type = 'button'; finishPick.dataset.action = 'finish-pick'; finishPick.textContent = 'پایان انتخاب';
    finishPick.hidden = true;
    const original = document.createElement('button');
    original.type = 'button'; original.dataset.action = 'original'; original.textContent = 'متن اصلی';
    const translated = document.createElement('button');
    translated.type = 'button'; translated.dataset.action = 'translated'; translated.textContent = 'ترجمه‌ها';
    const restore = document.createElement('button');
    restore.type = 'button'; restore.dataset.action = 'restore'; restore.textContent = 'بازگردانی صفحه';
    toolbar.append(status, select, finishPick, original, translated, restore);
    document.documentElement.append(style, toolbar);
    return { style, toolbar, status, panel: null, finishPick };
  }

  function versionTextMap(records, values, translatedIds) {
    return tools.showVersion(records, values, translatedIds);
  }

  const STATUS_LABELS = {
    pending: 'هنوز ترجمه نشده', translating: 'در حال ترجمه',
    translated: 'ترجمه شد', partial: 'ناقص؛ بخشی ترجمه نشد', failed: 'ناموفق؛ ترجمه‌ای دریافت نشد'
  };
  const PAGE_ENGINE_OPTIONS = [
    ['auto', 'Google؛ در صورت خطا MyMemory'], ['google', 'فقط Google Translate'], ['mymemory', 'فقط MyMemory'],
    ['ai:gemini', 'Google Gemini (مدل تنظیم‌شده)'], ['ai:openai', 'OpenAI (مدل تنظیم‌شده)'],
    ['ai:openrouter', 'OpenRouter (مدل تنظیم‌شده)'], ['ai:avalai', 'AvalAI (مدل تنظیم‌شده)']
  ];
  const PAGE_ENGINE_LABELS = Object.fromEntries(PAGE_ENGINE_OPTIONS);

  function refreshGroupStatuses(state) {
    if (!state.ui.panel) return;
    state.groups.forEach((group) => {
      const badge = state.ui.panel.querySelector(`[data-status-for="${group.id}"]`);
      if (badge) {
        badge.dataset.state = group.status;
        badge.textContent = STATUS_LABELS[group.status] || STATUS_LABELS.pending;
      }
    });
    const retry = state.ui.panel.querySelector('[data-action="retry-failed"]');
    if (retry) retry.disabled = !state.groups.some((group) => group.status === 'partial' || group.status === 'failed');
  }

  function refreshVersionSelects(state) {
    if (!state.ui.panel) return;
    state.groups.forEach((group) => {
      const select = state.ui.panel.querySelector(`[data-version-for="${group.id}"]`);
      if (!select) return;
      select.replaceChildren();
      group.versions.forEach((version, index) => {
        const option = document.createElement('option');
        option.value = String(index); option.textContent = version.label;
        select.appendChild(option);
      });
      select.value = String(group.activeVersion);
      select.disabled = group.versions.length < 2;
    });
  }

  function setGroupVersion(group, versionIndex) {
    const index = Math.max(0, Math.min(group.versions.length - 1, Number(versionIndex) || 0));
    const version = group.versions[index];
    group.activeVersion = index;
    versionTextMap(group.records, version.values, version.translatedIds);
  }

  function closePanel(state) {
    if (state.ui.panel) state.ui.panel.remove();
    state.ui.panel = null;
  }

  function setTranslationEngine(state, engine) {
    state.translationEngine = PAGE_ENGINE_LABELS[engine] ? engine : 'auto';
    const select = state.ui.panel && state.ui.panel.querySelector('[data-role="translation-engine"]');
    if (select) select.value = state.translationEngine;
  }

  function savePanelSelection(state, panel = state.ui.panel) {
    if (!panel) return;
    state.selectedGroups = new Set([...panel.querySelectorAll('[data-group-select]:checked')]
      .map((input) => input.dataset.groupSelect));
  }

  function syncPageSelection(state) {
    state.groups.forEach((group) => {
      group.block.classList.add('wtpdf-page-translation-pickable');
      group.block.classList.toggle('wtpdf-page-translation-picked', state.selectedGroups.has(group.id));
    });
  }

  function exitPagePickMode(state) {
    if (!state.pickMode) return;
    state.pickMode = false;
    document.removeEventListener('click', state.pickClickHandler, true);
    document.removeEventListener('keydown', state.pickKeyHandler, true);
    state.groups.forEach((group) => {
      const snapshot = group.pickClassSnapshot || {};
      group.block.classList.toggle('wtpdf-page-translation-pickable', snapshot.pickable === true);
      group.block.classList.toggle('wtpdf-page-translation-picked', snapshot.picked === true);
      delete group.pickClassSnapshot;
    });
    state.ui.finishPick.hidden = true;
    state.ui.toolbar.querySelectorAll('[data-action="original"], [data-action="translated"]').forEach((button) => { button.disabled = false; });
    if (state.ui.panel) state.ui.panel.hidden = false;
    state.ui.status.textContent = `پاراگراف‌های انتخاب‌شده: ${state.selectedGroups.size}`;
    if (state.ui.panel) {
      const status = state.ui.panel.querySelector('[data-role="panel-status"]');
      status.textContent = `${state.selectedGroups.size} پاراگراف انتخاب شده؛ تیک‌ها را بررسی و ترجمه را شروع کنید.`;
    } else openPanel(state, false);
  }

  function enterPagePickMode(state) {
    if (state.pickMode) return;
    savePanelSelection(state);
    state.pickMode = true;
    state.groups.forEach((group) => {
      group.pickClassSnapshot = {
        pickable: group.block.classList.contains('wtpdf-page-translation-pickable'),
        picked: group.block.classList.contains('wtpdf-page-translation-picked')
      };
    });
    syncPageSelection(state);
    if (state.ui.panel) state.ui.panel.hidden = true;
    state.ui.finishPick.hidden = false;
    state.ui.toolbar.querySelectorAll('[data-action="original"], [data-action="translated"]').forEach((button) => { button.disabled = true; });
    const updateCount = () => {
      state.ui.status.textContent = `روی پاراگراف کلیک کنید تا انتخاب شود یا از انتخاب خارج شود · ${state.selectedGroups.size} انتخاب‌شده · پایان با Escape`;
    };
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
      group.block.classList.toggle('wtpdf-page-translation-picked', state.selectedGroups.has(group.id));
      if (state.ui.panel) {
        const checkbox = state.ui.panel.querySelector(`[data-group-select="${group.id}"]`);
        if (checkbox) checkbox.checked = state.selectedGroups.has(group.id);
      }
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

  function openPanel(state, initial = false) {
    if (state.pickMode) {
      exitPagePickMode(state);
      return;
    }
    if (state.ui.panel && state.ui.panel.isConnected) {
      state.ui.panel.hidden = false;
      return;
    }
    const panel = document.createElement('section');
    panel.dataset.wtpdfPageTranslationUi = 'panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'انتخاب پاراگراف برای ترجمه');
    const head = document.createElement('div');
    head.dataset.role = 'panel-head';
    const title = document.createElement('strong');
    title.textContent = 'پاراگراف‌هایی را که می‌خواهید ترجمه کنید انتخاب کنید';
    const close = document.createElement('button');
    close.type = 'button'; close.textContent = 'بستن'; close.dataset.action = 'close-panel';
    close.addEventListener('click', () => closePanel(state));
    head.append(title, close);
    const controls = document.createElement('div');
    controls.dataset.role = 'panel-controls';
    const all = document.createElement('button');
    all.type = 'button'; all.textContent = 'انتخاب همه'; all.dataset.action = 'select-all';
    const none = document.createElement('button');
    none.type = 'button'; none.textContent = 'پاک‌کردن انتخاب'; none.dataset.action = 'select-none';
    controls.append(all, none);
    const engineRow = document.createElement('label');
    engineRow.dataset.role = 'engine-row';
    const engineLabel = document.createElement('span'); engineLabel.textContent = 'موتور این ترجمه:';
    const engineSelect = document.createElement('select');
    engineSelect.dataset.role = 'translation-engine';
    engineSelect.setAttribute('aria-label', 'انتخاب موتور ترجمه برای این صفحه');
    PAGE_ENGINE_OPTIONS.forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value; option.textContent = label;
      engineSelect.appendChild(option);
    });
    engineSelect.value = state.translationEngine;
    engineSelect.addEventListener('change', () => {
      state.translationEngine = engineSelect.value;
      panelStatus.textContent = `موتور این ترجمه: ${PAGE_ENGINE_LABELS[state.translationEngine]}.`;
    });
    engineRow.append(engineLabel, engineSelect);
    const list = document.createElement('div');
    list.dataset.role = 'panel-list';
    state.groups.forEach((group) => {
      const row = document.createElement('label');
      row.dataset.role = 'paragraph';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.dataset.groupSelect = group.id;
      checkbox.checked = state.selectedGroups.has(group.id);
      checkbox.addEventListener('change', () => savePanelSelection(state, panel));
      const snippet = document.createElement('span');
      snippet.dataset.role = 'snippet'; snippet.textContent = group.sourceText || '(متن خالی)';
      const paragraphStatus = document.createElement('span');
      paragraphStatus.dataset.role = 'paragraph-status'; paragraphStatus.dataset.statusFor = group.id;
      paragraphStatus.dataset.state = group.status;
      paragraphStatus.textContent = STATUS_LABELS[group.status] || STATUS_LABELS.pending;
      const variantRow = document.createElement('span');
      variantRow.dataset.role = 'variant-row';
      const variantLabel = document.createElement('span'); variantLabel.textContent = 'نمایش:';
      const variantSelect = document.createElement('select');
      variantSelect.dataset.role = 'variant'; variantSelect.dataset.versionFor = group.id;
      variantSelect.setAttribute('aria-label', `انتخاب نسخهٔ ${group.label}`);
      group.versions.forEach((version, index) => {
        const option = document.createElement('option');
        option.value = String(index); option.textContent = version.label;
        variantSelect.appendChild(option);
      });
      variantSelect.value = String(group.activeVersion);
      variantSelect.disabled = group.versions.length < 2;
      variantSelect.addEventListener('change', () => setGroupVersion(group, variantSelect.value));
      variantRow.append(variantLabel, variantSelect);
      row.append(checkbox, snippet, paragraphStatus, variantRow);
      list.appendChild(row);
    });
    const panelStatus = document.createElement('p');
    panelStatus.dataset.role = 'panel-status'; panelStatus.setAttribute('role', 'status'); panelStatus.setAttribute('aria-live', 'polite');
    panelStatus.textContent = initial
      ? 'برای انتخاب آسان‌تر، «انتخاب روی صفحه» را بزنید و روی پاراگراف‌های دلخواه کلیک کنید؛ یا از فهرست زیر تیک بزنید.'
      : 'نسخهٔ هر پاراگراف را جداگانه عوض کنید یا برای ترجمهٔ مجدد، بندهای دلخواه را انتخاب کنید.';
    const pickOnPage = document.createElement('button');
    pickOnPage.type = 'button'; pickOnPage.dataset.action = 'pick-on-page'; pickOnPage.textContent = 'انتخاب روی صفحه';
    pickOnPage.addEventListener('click', () => enterPagePickMode(state));
    const translate = document.createElement('button');
    translate.type = 'button'; translate.dataset.action = 'translate-selected'; translate.textContent = 'ترجمهٔ انتخاب‌شده‌ها';
    translate.addEventListener('click', () => translateSelected(state, panel));
    const retry = document.createElement('button');
    retry.type = 'button'; retry.dataset.action = 'retry-failed'; retry.textContent = 'تلاش دوباره برای ناقص/ناموفق‌ها';
    retry.title = 'فقط بخش‌هایی را می‌فرستد که در تلاش قبلی ترجمه نشدند.';
    retry.addEventListener('click', () => translateSelected(state, panel, true));
    all.addEventListener('click', () => {
      list.querySelectorAll('[data-group-select]').forEach((input) => { input.checked = true; });
      savePanelSelection(state, panel);
      if (state.pickMode) syncPageSelection(state);
    });
    none.addEventListener('click', () => {
      list.querySelectorAll('[data-group-select]').forEach((input) => { input.checked = false; });
      savePanelSelection(state, panel);
      if (state.pickMode) syncPageSelection(state);
    });
    panel.append(head, controls, engineRow, list, panelStatus, pickOnPage, translate, retry);
    document.documentElement.appendChild(panel);
    state.ui.panel = panel;
    refreshGroupStatuses(state);
  }

  async function translateSelected(state, panel, retryOnly = false) {
    if (state.running) return;
    let selected;
    if (retryOnly) {
      selected = state.groups.filter((group) => group.status === 'partial' || group.status === 'failed');
      panel.querySelectorAll('[data-group-select]').forEach((input) => {
        input.checked = selected.some((group) => group.id === input.dataset.groupSelect);
      });
    } else {
      selected = [...panel.querySelectorAll('[data-group-select]:checked')]
        .map((checkbox) => state.groups.find((group) => group.id === checkbox.dataset.groupSelect)).filter(Boolean);
    }
    const panelStatus = panel.querySelector('[data-role="panel-status"]');
    if (!selected.length) {
      panelStatus.textContent = retryOnly
        ? 'پاراگراف ناقص یا ناموفقی برای تلاش دوباره وجود ندارد.'
        : 'برای ادامه، دست‌کم یک پاراگراف را انتخاب کنید.';
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
      panelStatus.textContent = 'بخش تازه‌ای برای ارسال پیدا نشد؛ ترجمه‌های قبلی حفظ شده‌اند.';
      return;
    }
    const button = panel.querySelector('[data-action="translate-selected"]');
    state.running = true;
    button.disabled = true;
    panel.querySelectorAll('button, input, select').forEach((control) => { control.disabled = true; });
    refreshGroupStatuses(state);
    const engineLabel = PAGE_ENGINE_LABELS[state.translationEngine];
    panelStatus.textContent = retryOnly
      ? `در حال تلاش دوباره با ${engineLabel} برای بخش‌های ناقص/ناموفقِ ${selected.length} پاراگراف...`
      : `در حال ترجمه با ${engineLabel}؛ ${selected.length} پاراگراف انتخاب شده...`;
    state.ui.status.textContent = panelStatus.textContent;
    sendProgress(state.jobId, 'working', { total: batches.length, textNodes: entries.length });
    try {
      const translations = new Map();
      const batchErrors = [];
      const providerResults = new Set();
      for (let index = 0; index < batches.length; index++) {
        panelStatus.textContent = `در حال ترجمه... بستهٔ ${index + 1} از ${batches.length}`;
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
        const version = {
          label: group.status === 'partial' ? `ترجمهٔ ${group.versions.length} (ناقص)` : `ترجمهٔ ${group.versions.length}`,
          values, translatedIds
        };
        group.versions.push(version);
        group.activeVersion = group.versions.length - 1;
        versionTextMap(group.records, values, translatedIds);
        updatedParagraphs++;
      });
      state.selectedGroups = selectedIds;
      state.initialSelection = false;
      refreshVersionSelects(state);
      refreshGroupStatuses(state);
      const summary = `${completedParagraphs} کامل، ${partialParagraphs} ناقص، ${failedParagraphs} ناموفق`;
      const actualEngine = [...providerResults].join(' / ') || engineLabel;
      panelStatus.textContent = updatedParagraphs
        ? `موتور: ${actualEngine}. نتیجه: ${summary}. ترجمه‌های موفق و نسخه‌های قبلی حفظ شدند؛ می‌توانید فقط موارد ناقص/ناموفق را دوباره بفرستید.`
        : `موتور: ${actualEngine}. نتیجه: ${summary}. ترجمه‌های قبلی دست‌نخورده ماندند؛ می‌توانید دوباره تلاش کنید.`;
      state.ui.status.textContent = `${actualEngine} · ${summary}؛ وضعیت هر پاراگراف در فهرست مشخص است.`;
      sendProgress(state.jobId, failedParagraphs || partialParagraphs ? 'error' : 'done', {
        completed: batches.length, total: batches.length, textNodes: entries.length
      });
      if (batchErrors.length) panelStatus.title = batchErrors.join('\n');
    } catch (error) {
      const message = error && error.message ? error.message : 'ترجمه ناموفق بود.';
      selected.forEach((group) => { if (group.status === 'translating') group.status = 'failed'; });
      refreshGroupStatuses(state);
      panelStatus.textContent = `${message} ترجمه‌های قبلی حفظ شدند؛ می‌توانید موارد ناموفق را دوباره تلاش کنید.`;
      state.ui.status.textContent = 'ترجمه کامل نشد؛ نسخه‌های قبلی حفظ شدند.';
      sendProgress(state.jobId, 'error', { textNodes: entries.length });
    } finally {
      state.running = false;
      if (state.ui.panel) {
        state.ui.panel.querySelectorAll('button, input, select').forEach((control) => { control.disabled = false; });
        refreshGroupStatuses(state);
      }
    }
  }

  function showAllOriginal(state) {
    state.groups.forEach((group) => setGroupVersion(group, 0));
    refreshVersionSelects(state);
    state.ui.status.textContent = 'متن اصلی همهٔ پاراگراف‌ها نمایش داده می‌شود.';
  }

  function showLatestTranslations(state) {
    state.groups.forEach((group) => setGroupVersion(group, group.versions.length - 1));
    refreshVersionSelects(state);
    state.ui.status.textContent = 'آخرین ترجمهٔ هر پاراگراف نمایش داده می‌شود.';
  }

  function restorePage(state) {
    if (state.pickMode) exitPagePickMode(state);
    tools.restoreOriginal(state.records);
    state.records = []; state.groups = []; state.running = false;
    closePanel(state);
    state.ui.toolbar.remove(); state.ui.style.remove();
    window.__wtpdfPageTranslation = null;
  }

  function initializePage(jobId, engine = 'auto') {
    const current = window.__wtpdfPageTranslation;
    if (current && current.records && current.records.length) {
      setTranslationEngine(current, engine);
      openPanel(current, false);
      return { ok: true, alreadyReady: true, textNodes: current.records.length, paragraphs: current.groups.length };
    }
    const records = tools.collectTextNodes(document.body, document);
    const groups = buildGroups(records);
    if (!groups.length) return { ok: false, error: 'متن قابل‌انتخابی در این صفحه پیدا نشد.' };
    const state = {
      running: false, records, groups, groupByBlock: new Map(groups.map((group) => [group.block, group])),
      jobId: String(jobId || ''), selectedGroups: new Set(), initialSelection: true,
      translationEngine: PAGE_ENGINE_LABELS[engine] ? engine : 'auto',
      pickMode: false, pickClickHandler: null, pickKeyHandler: null, ui: null
    };
    window.__wtpdfPageTranslation = state;
    state.ui = makeToolbar(state);
    state.ui.toolbar.querySelector('[data-action="select"]').addEventListener('click', () => {
      if (state.pickMode) exitPagePickMode(state);
      else openPanel(state, false);
    });
    state.ui.finishPick.addEventListener('click', () => exitPagePickMode(state));
    state.ui.toolbar.querySelector('[data-action="original"]').addEventListener('click', () => showAllOriginal(state));
    state.ui.toolbar.querySelector('[data-action="translated"]').addEventListener('click', () => showLatestTranslations(state));
    state.ui.toolbar.querySelector('[data-action="restore"]').addEventListener('click', () => restorePage(state));
    openPanel(state, true);
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
      openPanel(state, false);
      sendResponse({ ok: true, translatedCopy: true });
      return false;
    }
    return undefined;
  });
})();
