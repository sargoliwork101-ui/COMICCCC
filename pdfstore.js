// ---------- ذخیره‌سازی محلی فایل و صفحه‌های PDF واردشده ----------
// حافظهٔ chrome.storage فقط رشته/JSON دارد و blob قبول نمی‌کند؛ برای همین هم فایل خام دریافتی از popup
// (تا تبدیل در تب اختصاصی انجام شود و با بسته‌شدن popup از بین نرود) و هم صفحه‌های رندرشده در IndexedDB
// هم‌ریشهٔ افزونه نگه‌داری می‌شوند. صفحه‌ها با نشانی داخلی pdf-internal:// به job وصل می‌شوند.
(function (root) {
  const DB_NAME = 'wtpdf-local';
  const DB_VERSION = 2;
  const PAGE_STORE = 'pages';     // صفحه‌های رندرشده: { url, blob }
  const IMPORT_STORE = 'imports'; // فایل خام در انتظار تبدیل: { id, name, blob, createdAt }
  const SCHEME = 'pdf-internal://';

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        // نسخهٔ ۱ فقط store صفحه‌ها را داشت
        if (!db.objectStoreNames.contains(PAGE_STORE)) db.createObjectStore(PAGE_STORE, { keyPath: 'url' });
        if (!db.objectStoreNames.contains(IMPORT_STORE)) db.createObjectStore(IMPORT_STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('باز کردن پایگاه داده محلی ناموفق بود'));
    });
    return dbPromise;
  }

  function tx(storeName, mode, fn) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      const store = t.objectStore(storeName);
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

    // ---- صفحه‌های رندرشده ----
    // entries: [{ url, blob }]
    putPages(entries) {
      return tx(PAGE_STORE, 'readwrite', (store, maybe) =>
        Promise.all(entries.map((entry) => maybe(store.put(entry)))));
    },
    async getPage(url) {
      const record = await tx(PAGE_STORE, 'readonly', (store, maybe) => maybe(store.get(url)));
      return record ? record.blob : null;
    },
    deletePages(urls) {
      if (!urls || !urls.length) return Promise.resolve();
      return tx(PAGE_STORE, 'readwrite', (store, maybe) =>
        Promise.all(urls.map((url) => maybe(store.delete(url)))));
    },
    // پاک‌سازی کامل هنگام بسته‌شدن viewer یک کار واردشده
    async deleteJobPages(urls) {
      const internal = (urls || []).filter((u) => PdfStore.isInternalUrl(u));
      if (internal.length) await PdfStore.deletePages(internal);
    },

    // ---- فایل خام در انتظار تبدیل (تحویل از popup به تب اختصاصی) ----
    putImport(id, name, blob) {
      return tx(IMPORT_STORE, 'readwrite', (store, maybe) =>
        maybe(store.put({ id, name: name || 'imported.pdf', blob, createdAt: Date.now() })));
    },
    async getImport(id) {
      const record = await tx(IMPORT_STORE, 'readonly', (store, maybe) => maybe(store.get(id)));
      return record || null;
    },
    deleteImport(id) {
      return tx(IMPORT_STORE, 'readwrite', (store, maybe) => maybe(store.delete(id)));
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = PdfStore;
  else root.PdfStore = PdfStore;
})(typeof window !== 'undefined' ? window : globalThis);
