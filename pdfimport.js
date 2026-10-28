// ---------- واردکردن فایل PDF و تبدیل هر صفحه به تصویر ----------
// جریان کار عمداً دو بخشی است تا با بسته‌شدن popup (که context آن بلافاصله از بین می‌رود) کار تبدیل نیمه‌کاره نماند:
//   ۱) popup فقط فایل را اعتبارسنجی و blob خام را در IndexedDB می‌گذارد و یک تب اختصاصی pdfimport.html باز می‌کند.
//   ۲) تب اختصاصی که پایدار است: صفحه‌ها را با pdf.js روی canvas رندر و JPEG می‌کند، در IndexedDB می‌نشاند
//      و با پیام WTPDF_LOCAL_JOB همان viewer همیشگی را باز می‌کند؛ همهٔ ابزارهای کراپ/ترجمه/گروه/خروجی رویشان کار می‌کند.
(function (root) {
  const TARGET_WIDTH = 1600;   // عرض هدف هر صفحه؛ اسکیل بین ۱ تا ۳ محدود می‌شود
  const MAX_SCALE = 3;
  const JPEG_QUALITY = 0.92;
  const IMPORT_PAGE = 'pdfimport.html';

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

    // بخش ۱: تحویل فایل از popup — فقط ذخیرهٔ blob خام و برگرداندن شناسهٔ کار
    async stashFile(file, hooks = {}) {
      const store = hooks.store || root.PdfStore;
      if (!file) throw new Error('فایلی انتخاب نشده است');
      if (file.type && file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name || '')) {
        throw new Error('لطفاً یک فایل PDF انتخاب کنید');
      }
      const id = store.makeImportId();
      await store.putImport(id, file.name || 'imported.pdf', file);
      return { id, name: file.name || 'imported.pdf' };
    },

    // باز کردن تب اختصاصی تبدیل با شناسهٔ کار در نشانی
    openImportTab({ id, name }, hooks = {}) {
      const openTab = hooks.openTab || ((url) => chrome.tabs.create({ url }));
      const url = `${IMPORT_PAGE}?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name || '')}`;
      return openTab(url);
    },

    // بخش ۲: خط لولهٔ کامل داخل تب اختصاصی — خواندن فایل خام، رندر، ذخیرهٔ صفحه‌ها، باز کردن viewer
    async runImportJob(jobId, hooks = {}) {
      const store = hooks.store || root.PdfStore;
      const sendMessage = hooks.sendMessage || ((msg) => chrome.runtime.sendMessage(msg));
      const onProgress = typeof hooks.onProgress === 'function' ? hooks.onProgress : () => {};

      const record = await store.getImport(jobId);
      if (!record) throw new Error('فایل PDF در حافظهٔ محلی افزونه پیدا نشد؛ دوباره از popup فایل را انتخاب کنید');
      const buffer = await record.blob.arrayBuffer();
      const pages = await PdfImport.renderPdfToBlobs(buffer, {
        lib: hooks.lib, createCanvas: hooks.createCanvas, signal: hooks.signal, onProgress
      });
      if (!pages.length) throw new Error('هیچ صفحه‌ای در این PDF پیدا نشد');

      const entries = pages.map((p, i) => ({ url: store.pageUrl(jobId, i), blob: p.blob }));
      await store.putPages(entries);

      const baseName = (record.name || 'imported.pdf').replace(/\.pdf$/i, '') || 'imported';
      let response;
      try {
        response = await sendMessage({
          type: 'WTPDF_LOCAL_JOB',
          name: baseName + '.pdf',
          source: 'pdf-import',
          urls: entries.map((e) => e.url)
        });
      } catch (e) {
        await store.deletePages(entries.map((en) => en.url));
        throw e;
      }
      if (!response || !response.ok) {
        // فایل خام نگه داشته می‌شود تا دکمهٔ «تلاش دوباره» بدون انتخاب دوبارهٔ فایل کار کند
        await store.deletePages(entries.map((en) => en.url));
        throw new Error((response && response.error) || 'باز کردن پیش‌نمایش ناموفق بود');
      }
      await store.deleteImport(jobId);
      return { pageCount: pages.length, importId: jobId, tabId: response.tabId, urls: entries.map((e) => e.url) };
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = PdfImport;
  else root.PdfImport = PdfImport;

  // ---------- اتصال UI: popup (انتخاب فایل → باز شدن تب اختصاصی) ----------
  if (typeof document !== 'undefined' && document.getElementById && document.getElementById('pdfFile')) {
    document.addEventListener('DOMContentLoaded', () => {
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
          setStatus('در حال آماده‌سازی تب تبدیل...');
          const job = await PdfImport.stashFile(file);
          PdfImport.openImportTab(job);
          setStatus('تب تبدیل فایل باز شد؛ فرایند در آن تب ادامه می‌یابد ✓', 'ok');
          input.value = '';
        } catch (e) {
          setStatus('آماده‌سازی تبدیل PDF ناموفق بود: ' + (e && e.message ? e.message : 'خطای ناشناخته'), 'err');
        } finally {
          input.disabled = false;
        }
      });
    });
  }

  // ---------- اتصال UI: تب اختصاصی pdfimport.html ----------
  if (typeof document !== 'undefined' && document.getElementById && document.getElementById('pdfImportPage')) {
    document.addEventListener('DOMContentLoaded', () => {
      if (root.pdfjsLib && root.pdfjsLib.GlobalWorkerOptions &&
        typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
        root.pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.js');
      }
      const params = new URLSearchParams(location.search);
      const jobId = params.get('id') || '';
      const name = params.get('name') || '';
      const nameEl = document.getElementById('impName');
      const stageEl = document.getElementById('impStage');
      const barEl = document.getElementById('impBar');
      const pctEl = document.getElementById('impPct');
      const errorBox = document.getElementById('impError');
      const errorMsg = document.getElementById('impErrorMsg');
      const retryBtn = document.getElementById('impRetry');
      const closeBtn = document.getElementById('impClose');
      const doneBox = document.getElementById('impDone');
      const workingBox = document.getElementById('impWorking');
      if (nameEl) nameEl.textContent = name;

      const setStage = (text) => { if (stageEl) stageEl.textContent = text; };
      const setProgress = (done, total) => {
        const pct = total ? Math.round((done / total) * 100) : 0;
        if (barEl) barEl.style.width = pct + '%';
        if (pctEl) pctEl.textContent = pct + '%';
        setStage(total ? `در حال تبدیل صفحه ${done} از ${total}...` : 'در حال خواندن فایل PDF...');
      };
      const fail = (e) => {
        if (workingBox) workingBox.classList.add('hidden');
        if (doneBox) doneBox.classList.add('hidden');
        if (errorBox) errorBox.classList.remove('hidden');
        if (errorMsg) errorMsg.textContent = e && e.message ? e.message : 'خطای ناشناخته';
      };

      const run = async () => {
        if (errorBox) errorBox.classList.add('hidden');
        if (doneBox) doneBox.classList.add('hidden');
        if (workingBox) workingBox.classList.remove('hidden');
        if (barEl) barEl.style.width = '0%';
        if (pctEl) pctEl.textContent = '0%';
        try {
          await PdfImport.runImportJob(jobId, { onProgress: setProgress });
          if (workingBox) workingBox.classList.add('hidden');
          if (doneBox) doneBox.classList.remove('hidden');
          // background پس از باز کردن viewer این تب را می‌بندد؛ دکمهٔ بستن هم برای حالت احتیاط است
          setTimeout(() => window.close(), 1500);
        } catch (e) {
          fail(e);
        }
      };
      if (retryBtn) retryBtn.addEventListener('click', run);
      if (closeBtn) closeBtn.addEventListener('click', () => window.close());
      const doneCloseBtn = document.getElementById('impDoneClose');
      if (doneCloseBtn) doneCloseBtn.addEventListener('click', () => window.close());
      run();
    });
  }
})(typeof window !== 'undefined' ? window : globalThis);
