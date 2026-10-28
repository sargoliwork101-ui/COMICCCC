// Shared IndexedDB bridge between the preview tab and the dedicated PDF converter tab.
(function (root) {
  'use strict';

  const DB_NAME = 'pic-to-pdf-imports';
  const DB_VERSION = 1;
  let dbPromise = null;

  function openDatabase() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'token' });
        if (!db.objectStoreNames.contains('pages')) {
          const pages = db.createObjectStore('pages', { keyPath: 'id' });
          pages.createIndex('token', 'token', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB باز نشد'));
      request.onblocked = () => reject(new Error('پایگاه دادهٔ تبدیل PDF در برگهٔ دیگری مشغول است'));
    }).catch((error) => {
      dbPromise = null;
      throw error;
    });
    return dbPromise;
  }

  function storeRequest(storeName, mode, run) {
    return openDatabase().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let result;
      try { result = run(store); }
      catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
      tx.onerror = () => reject(tx.error || new Error('ذخیره‌سازی فایل PDF ناموفق بود'));
      tx.onabort = () => reject(tx.error || new Error('ذخیره‌سازی PDF لغو شد'));
    }));
  }

  const api = {
    putPage(page) {
      return storeRequest('pages', 'readwrite', (store) => store.put({
        ...page,
        id: `${page.token}:${page.pageNumber}`
      }));
    },
    putSession(session) {
      return storeRequest('sessions', 'readwrite', (store) => store.put(session));
    },
    getSession(token) {
      return storeRequest('sessions', 'readonly', (store) => store.get(token));
    },
    getPages(token) {
      return openDatabase().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction('pages', 'readonly');
        const request = tx.objectStore('pages').index('token').getAll(token);
        request.onsuccess = () => resolve((request.result || []).sort((a, b) => a.pageNumber - b.pageNumber));
        request.onerror = () => reject(request.error || new Error('تصویرهای تبدیل‌شده خوانده نشدند'));
        tx.onerror = () => reject(tx.error || new Error('خواندن تصویرهای PDF ناموفق بود'));
      }));
    },
    deleteSession(token) {
      return openDatabase().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(['sessions', 'pages'], 'readwrite');
        tx.objectStore('sessions').delete(token);
        const cursorRequest = tx.objectStore('pages').index('token').openCursor(token);
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (cursor) { cursor.delete(); cursor.continue(); }
        };
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('پاک‌سازی داده‌های PDF ناموفق بود'));
        tx.onabort = () => reject(tx.error || new Error('پاک‌سازی داده‌های PDF لغو شد'));
      }));
    }
  };

  root.PDFImportStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
