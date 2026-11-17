const pageParams = new URLSearchParams(location.search);
const sourceTabId = Number(pageParams.get('tabId'));
const expectedHost = pageParams.get('host') || '';
const sourceHostElement = document.getElementById('sourceHost');
const consentElement = document.getElementById('translationConsent');
const startElement = document.getElementById('startTranslationBtn');
const statusElement = document.getElementById('pageStatus');
let cloneTabId = null;
let activeJobId = '';

sourceHostElement.textContent = expectedHost || 'نشانی در دسترس نیست';
const setStatus = (message, kind = '') => {
  statusElement.textContent = message;
  statusElement.className = kind;
};
consentElement.addEventListener('change', () => {
  startElement.disabled = !consentElement.checked;
});

function waitForTabComplete(tab) {
  if (tab && tab.status === 'complete') return Promise.resolve(tab);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('بارگذاری کپی صفحه بیش از حد طول کشید.'));
    }, 60000);
    const onUpdated = (tabId, changeInfo, updatedTab) => {
      if (tabId !== (tab && tab.id)) return;
      if (changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(updatedTab || tab);
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

function onTranslationProgress(message, sender) {
  if (!message || message.type !== 'WTPDF_PAGE_TRANSLATE_PROGRESS' ||
      message.jobId !== activeJobId || (sender && sender.tab && sender.tab.id !== cloneTabId)) return;
  if (message.state === 'working') {
    setStatus(`در حال ترجمهٔ متن صفحه... بستهٔ ${message.completed || 0} از ${message.total || 0}`);
  } else if (message.state === 'done') {
    setStatus('ترجمهٔ صفحه آماده شد؛ کپی ترجمه‌شده در زبانهٔ تازه باز است.', 'ok');
  } else if (message.state === 'error') {
    setStatus('ترجمه در زبانهٔ تازه کامل نشد؛ پیام خطا را همان‌جا ببینید.', 'error');
  }
}
chrome.runtime.onMessage.addListener(onTranslationProgress);

startElement.addEventListener('click', async () => {
  if (startElement.disabled || !consentElement.checked) return;
  if (!Number.isSafeInteger(sourceTabId) || sourceTabId < 0) {
    setStatus('زبانهٔ اصلی پیدا نشد؛ این صفحه را از دکمهٔ افزونه باز کنید.', 'error');
    return;
  }
  startElement.disabled = true;
  setStatus('در حال بررسی صفحهٔ اصلی...');
  try {
    const sourceTab = await chrome.tabs.get(sourceTabId);
    const sourceUrl = new URL(sourceTab.url || '');
    const storePage = sourceUrl.hostname === 'chromewebstore.google.com' ||
      (sourceUrl.hostname === 'chrome.google.com' && sourceUrl.pathname.startsWith('/webstore'));
    if (!['http:', 'https:'].includes(sourceUrl.protocol) || storePage) {
      throw new Error('ترجمه فقط روی صفحه‌های وب معمولی انجام می‌شود؛ صفحه‌های داخلی مرورگر و فروشگاه افزونه پشتیبانی نمی‌شوند.');
    }
    sourceHostElement.textContent = sourceUrl.hostname;
    setStatus('در حال ساخت کپی از صفحه...');
    const duplicate = await chrome.tabs.duplicate(sourceTabId);
    if (!duplicate || !Number.isSafeInteger(duplicate.id)) throw new Error('کپی صفحه در زبانهٔ تازه باز نشد.');
    cloneTabId = duplicate.id;
    await waitForTabComplete(duplicate);
    await chrome.scripting.executeScript({
      target: { tabId: cloneTabId },
      files: ['src/core/page-translation.js', 'src/page-translator/content.js']
    });
    activeJobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    setStatus('کپی باز شد؛ متن صفحه در حال ترجمه است...');
    const result = await chrome.tabs.sendMessage(cloneTabId, {
      type: 'WTPDF_PAGE_TRANSLATE_START', jobId: activeJobId
    });
    if (!result || !result.ok) throw new Error(result && result.error || 'ترجمهٔ صفحه کامل نشد.');
    setStatus(`ترجمهٔ صفحه آماده شد؛ ${result.textNodes} بخش متن بررسی شد. کپی ترجمه‌شده در زبانهٔ تازه باز است.`, 'ok');
    try { await chrome.tabs.update(cloneTabId, { active: true }); } catch { /* کپی قبلاً فعال است */ }
  } catch (error) {
    setStatus(error && error.message ? error.message : String(error), 'error');
    startElement.disabled = !consentElement.checked;
  }
});
