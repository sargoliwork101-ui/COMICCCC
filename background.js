// دریافت لیست تصاویر از صفحه و باز کردن تب ساخت PDF
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'WTPDF_URLS') {
    const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const job = {
      urls: msg.urls,
      name: msg.name,
      tabId: sender.tab ? sender.tab.id : null,
      pageUrl: (sender.tab && sender.tab.url) || msg.pageUrl || ''
    };
    chrome.storage.local.set({ ['job_' + jobId]: job }).then(() => {
      chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') + '?job=' + jobId });
      sendResponse({ ok: true });
    });
    return true;
  }
});
