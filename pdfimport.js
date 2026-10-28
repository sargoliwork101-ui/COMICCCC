// ---------- واردکردن فایل PDF و تبدیل هر صفحه به تصویر ----------
// صفحه‌ها با pdf.js روی canvas رندر و به JPEG تبدیل می‌شوند، blobها در IndexedDB (PdfStore) می‌نشینند
// و viewer از همان مسیر معمولی کارت‌ها را بارگیری می‌کند؛ همهٔ ابزارهای کراپ/ترجمه/گروه/خروجی در دسترس‌اند.
(function (root) {
  const TARGET_WIDTH = 1600;   // عرض هدف هر صفحه؛ اسکیل بین ۱ تا ۳ محدود می‌شود
  const MAX_SCALE = 3;
  const JPEG_QUALITY = 0.92;

  const canvasToBlob = (canvas, type, quality) => new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('تبدیل صفحه به تصویر ناموفق بود'))), type, quality);
  });

  const PdfImport = {
    // buffer: ArrayBuffer فایل PDF؛ خروجی: [{ blob, width, height }] به ترتیب صفحه‌ها
    async renderPdfToBlobs(buffer, hooks = {}) {
      const lib = hooks.lib || root.pdfjsLib;
      const createCanvas = hooks.createCanvas || (() => document.createElement('canvas'));
      const onProgress = typeof hooks.onProgress === 'function' ? hooks.onProgress : () => {};
      if (!lib) throw new Error('موتور خواندن PDF بارگذاری نشده است');

      const task = lib.getDocument({ data: buffer });
      const doc = await task.promise;
      const pages = [];
      try {
        for (let n = 1; n <= doc.numPages; n++) {
          if (hooks.signal && hooks.signal.aborted) throw new DOMException('aborted', 'AbortError');
          const page = await doc.getPage(n);
          const baseViewport = page.getViewport({ scale: 1 });
          const scale = Math.min(MAX_SCALE, Math.max(1, TARGET_WIDTH / baseViewport.width));
          const viewport = page.getViewport({ scale });
          const canvas = createCanvas();
          canvas.width = Math.max(1, Math.floor(viewport.width));
          canvas.height = Math.max(1, Math.floor(viewport.height));
          const ctx = canvas.getContext('2d');
          // پس‌زمینهٔ سفید تا صفحه‌های شفاف PDF خروجی سیاه نگیرند
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport }).promise;
          const blob = await canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY);
          pages.push({ blob, width: canvas.width, height: canvas.height });
          page.cleanup();
          onProgress(n, doc.numPages);
        }
      } finally {
        try { doc.destroy(); } catch { /* رهایی منابع */ }
      }
      return pages;
    },

    // جریان کامل: فایل انتخاب‌شده → رندر → ذخیره در IDB → ساخت job از طریق background
    async importFile(file, hooks = {}) {
      const store = hooks.store || root.PdfStore;
      const sendMessage = hooks.sendMessage || ((msg) => chrome.runtime.sendMessage(msg));
      const onProgress = typeof hooks.onProgress === 'function' ? hooks.onProgress : () => {};
      if (!file) throw new Error('فایلی انتخاب نشده است');
      if (file.type && file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
        throw new Error('لطفاً یک فایل PDF انتخاب کنید');
      }
      const buffer = await file.arrayBuffer();
      const pages = await PdfImport.renderPdfToBlobs(buffer, {
        lib: hooks.lib, createCanvas: hooks.createCanvas, signal: hooks.signal, onProgress
      });
      if (!pages.length) throw new Error('هیچ صفحه‌ای در این PDF پیدا نشد');

      const importId = store.makeImportId();
      const entries = pages.map((p, i) => ({ url: store.pageUrl(importId, i), blob: p.blob }));
      await store.putPages(entries);

      const baseName = file.name.replace(/\.pdf$/i, '') || 'imported';
      const response = await sendMessage({
        type: 'WTPDF_LOCAL_JOB',
        name: baseName + '.pdf',
        source: 'pdf-import',
        urls: entries.map((e) => e.url)
      });
      if (!response || !response.ok) {
        await store.deletePages(entries.map((e) => e.url));
        throw new Error((response && response.error) || 'باز کردن پیش‌نمایش ناموفق بود');
      }
      return { pageCount: pages.length, importId, tabId: response.tabId };
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = PdfImport;
  else root.PdfImport = PdfImport;

  // اتصال UI فقط داخل popup
  if (typeof document !== 'undefined' && document.getElementById && document.getElementById('pdfFile')) {
    document.addEventListener('DOMContentLoaded', () => {
      if (typeof root.pdfjsLib !== 'undefined' && root.pdfjsLib.GlobalWorkerOptions &&
        typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
        root.pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.js');
      }
      const input = document.getElementById('pdfFile');
      const statusEl = document.getElementById('pdfImportStatus');
      const setStatus = (text, kind) => {
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.classList.remove('hidden', 'ok', 'err');
        if (kind) statusEl.classList.add(kind);
      };
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        input.disabled = true;
        try {
          setStatus('در حال تبدیل صفحه‌های PDF به تصویر...');
          await PdfImport.importFile(file, {
            onProgress: (done, total) => setStatus(`در حال تبدیل صفحه‌های PDF... ${done} از ${total}`)
          });
          setStatus('تبدیل کامل شد؛ پیش‌نمایش باز می‌شود ✓', 'ok');
          input.value = '';
        } catch (e) {
          setStatus('تبدیل PDF ناموفق بود: ' + (e && e.message ? e.message : 'خطای ناشناخته'), 'err');
        } finally {
          input.disabled = false;
        }
      });
    });
  }
})(typeof window !== 'undefined' ? window : globalThis);
