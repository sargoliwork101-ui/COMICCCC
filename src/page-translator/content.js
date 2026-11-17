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
          activeVersion: 0
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
      [data-wtpdf-page-translation-ui="panel"] [data-role="paragraph"] input{grid-row:1 / span 2;align-self:start;margin-top:4px;accent-color:#a5b4fc;}
      [data-wtpdf-page-translation-ui="panel"] [data-role="snippet"]{max-height:4.8em;overflow:auto;color:#e2e8f0;overflow-wrap:anywhere;}
      [data-wtpdf-page-translation-ui="panel"] [data-role="variant-row"]{display:flex;align-items:center;gap:7px;color:#cbd5e1;font-size:11px;}
      [data-wtpdf-page-translation-ui="panel"] [data-role="variant"]{max-width:210px;padding:5px 7px;}
      [data-wtpdf-page-translation-ui="panel"] [data-role="panel-controls"]{display:flex;flex-wrap:wrap;gap:7px;}
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
    const original = document.createElement('button');
    original.type = 'button'; original.dataset.action = 'original'; original.textContent = 'متن اصلی';
    const translated = document.createElement('button');
    translated.type = 'button'; translated.dataset.action = 'translated'; translated.textContent = 'ترجمه‌ها';
    const restore = document.createElement('button');
    restore.type = 'button'; restore.dataset.action = 'restore'; restore.textContent = 'بازگردانی صفحه';
    toolbar.append(status, select, original, translated, restore);
    document.documentElement.append(style, toolbar);
    return { style, toolbar, status, panel: null };
  }

  function versionTextMap(records, values, translatedIds) {
    return tools.showVersion(records, values, translatedIds);
  }

  function refreshVersionSelects(state) {
    if (!state.ui.panel) return;
    state.groups.forEach((group) => {
      const select = state.ui.panel.querySelector(`[data-version-for="${group.id}"]`);
      if (select) select.value = String(group.activeVersion);
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

  function openPanel(state, initial = false) {
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
    const list = document.createElement('div');
    list.dataset.role = 'panel-list';
    state.groups.forEach((group) => {
      const row = document.createElement('label');
      row.dataset.role = 'paragraph';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.dataset.groupSelect = group.id;
      checkbox.checked = initial ? true : state.selectedGroups.has(group.id);
      const snippet = document.createElement('span');
      snippet.dataset.role = 'snippet'; snippet.textContent = group.sourceText || '(متن خالی)';
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
      row.append(checkbox, snippet, variantRow);
      list.appendChild(row);
    });
    const panelStatus = document.createElement('p');
    panelStatus.dataset.role = 'panel-status'; panelStatus.setAttribute('role', 'status'); panelStatus.setAttribute('aria-live', 'polite');
    panelStatus.textContent = initial
      ? 'ابتدا همه انتخاب شده‌اند؛ هر پاراگرافی را نمی‌خواهید از انتخاب خارج کنید.'
      : 'نسخهٔ هر پاراگراف را جداگانه عوض کنید یا برای ترجمهٔ مجدد، بندهای دلخواه را انتخاب کنید.';
    const translate = document.createElement('button');
    translate.type = 'button'; translate.dataset.action = 'translate-selected'; translate.textContent = 'ترجمهٔ انتخاب‌شده‌ها';
    translate.addEventListener('click', () => translateSelected(state, panel));
    all.addEventListener('click', () => list.querySelectorAll('[data-group-select]').forEach((input) => { input.checked = true; }));
    none.addEventListener('click', () => list.querySelectorAll('[data-group-select]').forEach((input) => { input.checked = false; }));
    panel.append(head, controls, list, panelStatus, translate);
    document.documentElement.appendChild(panel);
    state.ui.panel = panel;
  }

  async function translateSelected(state, panel) {
    if (state.running) return;
    const selected = [...panel.querySelectorAll('[data-group-select]:checked')]
      .map((checkbox) => state.groups.find((group) => group.id === checkbox.dataset.groupSelect)).filter(Boolean);
    const panelStatus = panel.querySelector('[data-role="panel-status"]');
    if (!selected.length) {
      panelStatus.textContent = 'برای ادامه، دست‌کم یک پاراگراف را انتخاب کنید.';
      return;
    }
    const selectedIds = new Set(selected.map((group) => group.id));
    const entries = selected.flatMap((group) => tools.createEntries(group.records));
    const batches = tools.splitBatches(entries);
    const button = panel.querySelector('[data-action="translate-selected"]');
    state.running = true;
    button.disabled = true;
    panel.querySelectorAll('button, input, select').forEach((control) => { control.disabled = true; });
    panelStatus.textContent = `در حال ترجمهٔ ${selected.length} پاراگراف...`;
    state.ui.status.textContent = `در حال ترجمهٔ ${selected.length} پاراگراف...`;
    sendProgress(state.jobId, 'working', { total: batches.length, textNodes: entries.length });
    try {
      const translations = new Map();
      for (let index = 0; index < batches.length; index++) {
        panelStatus.textContent = `در حال ترجمه... بستهٔ ${index + 1} از ${batches.length}`;
        const response = await chrome.runtime.sendMessage({
          type: 'WTPDF_TRANSLATE_PAGE_BATCH', entries: batches[index]
        });
        if (!response || !response.ok) throw new Error(response && response.error || 'سرویس ترجمه پاسخ نداد.');
        (response.translations || []).forEach((row) => {
          if (row && typeof row.id === 'string' && typeof row.text === 'string') translations.set(row.id, row.text);
        });
        sendProgress(state.jobId, 'working', { completed: index + 1, total: batches.length, textNodes: entries.length });
      }
      let updatedParagraphs = 0, translatedRecords = 0;
      selected.forEach((group) => {
        const groupTranslations = new Map();
        group.records.forEach((record) => (record.parts || []).forEach((part) => {
          if (translations.has(part.id)) groupTranslations.set(part.id, translations.get(part.id));
        }));
        tools.applyTranslations(group.records, groupTranslations);
        const translatedIds = new Set(group.records.filter((record) => record.hasTranslation).map((record) => record.id));
        if (!translatedIds.size) return;
        const values = new Map(group.records.map((record) => [record.id, record.translated]));
        group.versions.push({ label: `ترجمهٔ ${group.versions.length}`, values, translatedIds });
        group.activeVersion = group.versions.length - 1;
        versionTextMap(group.records, values, translatedIds);
        translatedRecords += translatedIds.size;
        updatedParagraphs++;
      });
      if (!translatedRecords) throw new Error('از موتور انتخاب‌شده ترجمه‌ای دریافت نشد؛ متن‌های قبلی حفظ شدند.');
      state.selectedGroups = selectedIds;
      state.initialSelection = false;
      closePanel(state);
      openPanel(state, false);
      state.ui.panel.querySelector('[data-role="panel-status"]').textContent =
        `ترجمهٔ تازه برای ${updatedParagraphs} پاراگراف ذخیره شد؛ از فهرست نسخهٔ هرکدام را انتخاب کنید.`;
      state.ui.status.textContent = `${updatedParagraphs} پاراگراف ترجمه شد؛ نسخه‌ها قابل انتخاب‌اند.`;
      sendProgress(state.jobId, 'done', { completed: batches.length, total: batches.length, textNodes: translatedRecords });
    } catch (error) {
      const message = error && error.message ? error.message : 'ترجمه ناموفق بود.';
      panelStatus.textContent = message;
      state.ui.status.textContent = message;
      sendProgress(state.jobId, 'error', { textNodes: entries.length });
    } finally {
      state.running = false;
      if (state.ui.panel) state.ui.panel.querySelectorAll('button, input, select').forEach((control) => { control.disabled = false; });
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
    tools.restoreOriginal(state.records);
    state.records = []; state.groups = []; state.running = false;
    closePanel(state);
    state.ui.toolbar.remove(); state.ui.style.remove();
    window.__wtpdfPageTranslation = null;
  }

  function initializePage(jobId) {
    const current = window.__wtpdfPageTranslation;
    if (current && current.records && current.records.length) {
      openPanel(current, false);
      return { ok: true, alreadyReady: true, textNodes: current.records.length, paragraphs: current.groups.length };
    }
    const records = tools.collectTextNodes(document.body, document);
    const groups = buildGroups(records);
    if (!groups.length) return { ok: false, error: 'متن قابل‌انتخابی در این صفحه پیدا نشد.' };
    const state = {
      running: false, records, groups, jobId: String(jobId || ''),
      selectedGroups: new Set(), initialSelection: true, ui: null
    };
    window.__wtpdfPageTranslation = state;
    state.ui = makeToolbar(state);
    state.ui.toolbar.querySelector('[data-action="select"]').addEventListener('click', () => openPanel(state, false));
    state.ui.toolbar.querySelector('[data-action="original"]').addEventListener('click', () => showAllOriginal(state));
    state.ui.toolbar.querySelector('[data-action="translated"]').addEventListener('click', () => showLatestTranslations(state));
    state.ui.toolbar.querySelector('[data-action="restore"]').addEventListener('click', () => restorePage(state));
    openPanel(state, true);
    return { ok: true, readyForSelection: true, textNodes: records.length, paragraphs: groups.length };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return undefined;
    if (message.type === 'WTPDF_PAGE_TRANSLATE_START') {
      sendResponse(initializePage(String(message.jobId || '')));
      return false;
    }
    if (message.type === 'WTPDF_PAGE_TRANSLATE_OPEN_SELECTION') {
      const state = window.__wtpdfPageTranslation;
      if (!state || !state.records || !state.records.length) {
        sendResponse({ ok: false, translatedCopy: false });
        return false;
      }
      openPanel(state, false);
      sendResponse({ ok: true, translatedCopy: true });
      return false;
    }
    return undefined;
  });
})();
