// دریافت لیست تصاویر از صفحه و باز کردن تب ساخت PDF
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'WTPDF_URLS') {
    const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const job = {
      urls: msg.urls,
      name: msg.name,
      tabId: sender.tab ? sender.tab.id : null,
      pageUrl: (sender.tab && sender.tab.url) || msg.pageUrl || '',
      skippedInline: Number(msg.skippedInline) || 0
    };
    chrome.storage.local.set({ ['job_' + jobId]: job }).then(() => {
      chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') + '?job=' + jobId }, (tab) => {
        if (chrome.runtime.lastError || !tab || tab.id == null) {
          const error = chrome.runtime.lastError;
          sendResponse({ ok: false, error: error ? error.message : 'preview tab could not be opened' });
          return;
        }
        // Keep the work tab from being auto-discarded while the user switches to other tabs.
        try {
          chrome.tabs.update(tab.id, { autoDiscardable: false }, () => {
            if (chrome.runtime.lastError) console.warn('Could not disable automatic tab discard:', chrome.runtime.lastError.message);
            sendResponse({ ok: true, tabId: tab.id });
          });
        } catch (error) {
          console.warn('Could not protect the work tab from automatic discard:', error);
          sendResponse({ ok: true, tabId: tab.id });
        }
      });
    }).catch((error) => {
      console.error('ذخیرهٔ فهرست تصاویر ناموفق بود', error);
      sendResponse({ ok: false, error: error && error.message ? error.message : 'storage quota exceeded' });
    });
    return true;
  }
});
