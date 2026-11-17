// Injected only into the duplicate tab: translate visible text nodes while leaving page markup in place.
(function () {
  if (window.__wtpdfPageTranslation && window.__wtpdfPageTranslation.running) return;
  const tools = window.PageTranslationTools;
  if (!tools) return;

  const JOB_PREFIX = 'WTPDF_PAGE_TRANSLATE_';
  const sendProgress = (jobId, state, details = {}) => {
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

  function makeToolbar() {
    const style = document.createElement('style');
    style.dataset.wtpdfPageTranslationUi = 'style';
    style.textContent = `
      [data-wtpdf-page-translation-ui="toolbar"]{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;
        display:flex;align-items:center;gap:10px;max-width:calc(100vw - 24px);padding:9px 13px;border-radius:12px;
        background:#18212f;color:#fff;border:1px solid #64748b;box-shadow:0 8px 32px #0007;
        font:600 13px/1.5 system-ui,sans-serif;direction:rtl;}
      [data-wtpdf-page-translation-ui="toolbar"] [data-role="status"]{max-width:min(42vw,520px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      [data-wtpdf-page-translation-ui="toolbar"] button{font:600 12px/1.4 system-ui,sans-serif;border:1px solid #94a3b8;border-radius:8px;
        background:#273449;color:#fff;padding:6px 9px;cursor:pointer;white-space:nowrap;}
      [data-wtpdf-page-translation-ui="toolbar"] button:hover{background:#35445e;}
      [data-wtpdf-page-translation-ui="toolbar"] button:focus-visible{outline:2px solid #a5b4fc;outline-offset:2px;}
      @media(max-width:720px){[data-wtpdf-page-translation-ui="toolbar"]{flex-wrap:wrap;justify-content:center;top:6px;}
        [data-wtpdf-page-translation-ui="toolbar"] [data-role="status"]{max-width:90vw;}}
    `;
    const toolbar = document.createElement('div');
    toolbar.dataset.wtpdfPageTranslationUi = 'toolbar';
    toolbar.setAttribute('role', 'region');
    toolbar.setAttribute('aria-label', 'کنترل ترجمهٔ صفحه');
    const status = document.createElement('span');
    status.dataset.role = 'status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = 'در حال آماده‌سازی ترجمه...';
    const original = document.createElement('button');
    original.type = 'button'; original.dataset.action = 'original'; original.textContent = 'متن اصلی';
    const translated = document.createElement('button');
    translated.type = 'button'; translated.dataset.action = 'translated'; translated.textContent = 'ترجمه';
    const restore = document.createElement('button');
    restore.type = 'button'; restore.dataset.action = 'restore'; restore.textContent = 'بازگردانی صفحه';
    toolbar.append(status, original, translated, restore);
    document.documentElement.append(style, toolbar);
    return { style, toolbar, status };
  }

  async function translatePage(jobId) {
    if (window.__wtpdfPageTranslation && window.__wtpdfPageTranslation.records) {
      return { ok: true, restored: true, textNodes: window.__wtpdfPageTranslation.records.length };
    }
    const state = { running: true, records: [] };
    window.__wtpdfPageTranslation = state;
    const ui = makeToolbar();
    const setStatus = (message) => { ui.status.textContent = message; };
    const restore = () => {
      tools.restoreOriginal(state.records);
      state.records = [];
      state.running = false;
      ui.toolbar.remove(); ui.style.remove();
      window.__wtpdfPageTranslation = null;
    };
    ui.toolbar.querySelector('[data-action="original"]').addEventListener('click', () => tools.showOriginal(state.records));
    ui.toolbar.querySelector('[data-action="translated"]').addEventListener('click', () => tools.showTranslations(state.records));
    ui.toolbar.querySelector('[data-action="restore"]').addEventListener('click', restore);

    try {
      state.records = tools.collectTextNodes(document.body, document);
      const entries = tools.createEntries(state.records);
      if (!entries.length) throw new Error('متن قابل‌ترجمه‌ای در این صفحه پیدا نشد.');
      const batches = tools.splitBatches(entries);
      const translations = new Map();
      sendProgress(jobId, 'working', { total: batches.length, textNodes: state.records.length });
      for (let index = 0; index < batches.length; index++) {
        setStatus(`در حال ترجمهٔ صفحه... بستهٔ ${index + 1} از ${batches.length}`);
        const response = await chrome.runtime.sendMessage({
          type: 'WTPDF_TRANSLATE_PAGE_BATCH', entries: batches[index]
        });
        if (!response || !response.ok) throw new Error(response && response.error || 'سرویس ترجمه پاسخ نداد.');
        (response.translations || []).forEach((row) => {
          if (row && typeof row.id === 'string' && typeof row.text === 'string') translations.set(row.id, row.text);
        });
        sendProgress(jobId, 'working', {
          completed: index + 1, total: batches.length, textNodes: state.records.length
        });
      }
      tools.applyTranslations(state.records, translations);
      const translatedParts = translations.size;
      if (!translatedParts) throw new Error('ترجمه‌ای از سرویس دریافت نشد؛ متن اصلی دست‌نخورده ماند.');
      const failedParts = entries.length - translatedParts;
      setStatus(failedParts
        ? `ترجمه تمام شد؛ ${failedParts} بخش بدون ترجمه ماند.`
        : `ترجمه تمام شد؛ ${state.records.length} بخش متن ترجمه شد.`);
      state.running = false;
      sendProgress(jobId, 'done', { completed: batches.length, total: batches.length, textNodes: state.records.length });
      return { ok: true, textNodes: state.records.length, translatedParts, failedParts };
    } catch (error) {
      state.running = false;
      setStatus(error && error.message ? error.message : 'ترجمه ناموفق بود.');
      sendProgress(jobId, 'error', { textNodes: state.records.length });
      return { ok: false, error: error && error.message ? error.message : String(error) };
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== 'WTPDF_PAGE_TRANSLATE_START') return undefined;
    translatePage(String(message.jobId || ''))
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error && error.message ? error.message : String(error) }));
    return true;
  });
})();
