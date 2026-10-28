// ---------- ذخیره‌سازی محلی صفحات PDF واردشده ----------
// حافظهٔ chrome.storage فقط رشته/JSON دارد و blob قبول نمی‌کند؛ برای همین صفحه‌های رندرشده در IndexedDB
// (هم‌ریشه با popup و viewer) نگه داشته می‌شوند و با نشانی‌های داخلی pdf-internal:// به هم وصل می‌شوند.
(function (root) {
  const DB_NAME = 'wtpdf-local';
  const DB_VERSION = 1;
  const STORE = 'pages';
  const SCHEME = 'pdf-internal://';

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'url' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('باز کردن پایگاه داده محلی ناموفق بود'));
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let result;
      const maybe = (req) => new Promise((res, rej) => {
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      t.oncomplete = () => resolve(result);
      t.onabort = () => reject(t.error || new Error('تراکنش پایگاه داده لغو شد'));
      t.onerror = () => reject(t.error);
      Promise.resolve(fn(store, maybe)).then((r) => { result = r; }).catch(reject);
    }));
  }

  const PdfStore = {
    scheme: SCHEME,
    isInternalUrl(url) {
      return typeof url === 'string' && url.startsWith(SCHEME);
    },
    makeImportId() {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    },
    pageUrl(importId, index) {
      return `${SCHEME}${encodeURIComponent(importId)}/${index}`;
    },
    // entries: [{ url, blob }]
    putPages(entries) {
      return tx('readwrite', (store, maybe) =>
        Promise.all(entries.map((entry) => maybe(store.put(entry)))));
    },
    async getPage(url) {
      const record = await tx('readonly', (store, maybe) => maybe(store.get(url)));
      return record ? record.blob : null;
    },
    deletePages(urls) {
      if (!urls || !urls.length) return Promise.resolve();
      return tx('readwrite', (store, maybe) =>
        Promise.all(urls.map((url) => maybe(store.delete(url)))));
    },
    // پاک‌سازی کامل هنگام بسته‌شدن viewer یک کار واردشده
    async deleteJobPages(urls) {
      const internal = (urls || []).filter((u) => PdfStore.isInternalUrl(u));
      if (internal.length) await PdfStore.deletePages(internal);
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = PdfStore;
  else root.PdfStore = PdfStore;
})(typeof window !== 'undefined' ? window : globalThis);
