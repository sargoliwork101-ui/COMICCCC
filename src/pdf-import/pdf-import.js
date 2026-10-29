'use strict';

const params = new URLSearchParams(location.search);
const token = params.get('token') || '';
const returnTabId = Number.parseInt(params.get('returnTab'), 10);
const $ = (id) => document.getElementById(id);
let conversionStarted = false;

function setStatus(text, kind = '') {
  const status = $('statusText');
  status.textContent = text;
  status.className = `import-status${kind ? ` ${kind}` : ''}`;
}
function setProgress(current, total, label) {
  $('progressArea').classList.remove('hidden');
  $('progressLabel').textContent = label;
  $('progressCount').textContent = total ? `${current} / ${total}` : '';
  $('progressBar').style.width = total ? `${Math.round((current / total) * 100)}%` : '0%';
}
function blobFromCanvas(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('ساخت تصویر این صفحه ناموفق بود')), 'image/png');
  });
}
function safeMessage(error) {
  return error && error.message ? error.message : String(error || 'خطای ناشناخته');
}
function viewportForPdfPage(page) {
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(
    2,
    16000 / baseViewport.width,
    16000 / baseViewport.height,
    Math.sqrt(48000000 / (baseViewport.width * baseViewport.height))
  );
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('ابعاد این صفحهٔ PDF قابل‌پردازش نیست');
  // کفِ مصنوعی برای scale می‌توانست سقف ابعاد و حافظه را در صفحه‌های بسیار بزرگ باطل کند.
  return page.getViewport({ scale });
}
async function notifyPreview(session) {
  await PDFImportStore.putSession(session);
  if (!chrome.runtime || !chrome.runtime.sendMessage) return;
  chrome.runtime.sendMessage({ type: 'PIC_TO_PDF_IMPORT_COMPLETE', token }, () => {
    // اگر تب پیش‌نمایش بسته شده باشد، خطای lastError نباید پیام موفقیت تبدیل را خراب کند.
    void chrome.runtime.lastError;
    if (session.status === 'complete' && Number.isInteger(returnTabId) && chrome.tabs && chrome.tabs.update) {
      chrome.tabs.update(returnTabId, { active: true }, () => { void chrome.runtime.lastError; });
    }
  });
}

async function convertPdf(file) {
  if (!file || conversionStarted) return;
  if (!token) {
    setStatus('نشانی این برگه ناقص است؛ برگردید به پیش‌نمایش و دوباره تبدیل PDF را بزنید.', 'error');
    return;
  }
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    setStatus('فایل انتخاب‌شده PDF نیست.', 'error');
    return;
  }

  conversionStarted = true;
  $('choosePdf').disabled = true;
  $('selectedFile').textContent = file.name;
  $('selectedFile').classList.remove('hidden');
  $('retryButton').classList.add('hidden');
  setStatus('در حال آماده‌سازی فایل PDF...');
  setProgress(0, 0, 'در حال بازکردن PDF');

  let pdf = null;
  let convertedPages = 0;
  let error = null;
  try {
    await PDFImportStore.deleteSession(token);
    await PDFImportStore.putSession({ token, status: 'converting', fileName: file.name, count: 0 });
    // PDF.js legacy build پشتیبانی گسترده‌تری در نسخه‌های مختلف Chrome دارد.
    const pdfjs = await import(chrome.runtime.getURL('vendor/pdfjs/pdf.min.mjs'));
    pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs');
    const data = new Uint8Array(await file.arrayBuffer());
    pdf = await pdfjs.getDocument({
      data,
      isEvalSupported: false,
      useWorkerFetch: false,
      cMapUrl: chrome.runtime.getURL('vendor/pdfjs/cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: chrome.runtime.getURL('vendor/pdfjs/standard_fonts/')
    }).promise;

    setProgress(0, pdf.numPages, 'در حال تبدیل صفحه‌ها');
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const viewport = viewportForPdfPage(page);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      try {
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('مرورگر نتوانست بوم تصویر بسازد');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        const renderTask = page.render({ canvasContext: context, viewport });
        await renderTask.promise;
        const blob = await blobFromCanvas(canvas);
        await PDFImportStore.putPage({
          token, pageNumber, blob, width: canvas.width, height: canvas.height, fileName: file.name
        });
      } finally {
        canvas.width = canvas.height = 0;
        page.cleanup();
      }
      convertedPages++;
      setProgress(pageNumber, pdf.numPages, 'در حال تبدیل صفحه‌ها');
      setStatus(`صفحهٔ ${pageNumber} از ${pdf.numPages} تبدیل شد.`);
    }

    const session = {
      token,
      status: 'complete',
      fileName: file.name,
      count: convertedPages,
      finishedAt: Date.now()
    };
    await notifyPreview(session);
    $('progressBar').style.width = '100%';
    setStatus(`${convertedPages} صفحه تبدیل شد و به فهرست تصاویر در برگهٔ پیش‌نمایش فرستاده شد.`, 'success');
    $('retryButton').classList.remove('hidden');
  } catch (caught) {
    error = caught;
    console.error('PDF conversion failed', caught);
    const session = {
      token,
      status: 'failed',
      fileName: file.name,
      count: convertedPages,
      error: safeMessage(caught),
      finishedAt: Date.now()
    };
    try { await notifyPreview(session); } catch (notifyError) { console.warn('Could not notify preview tab', notifyError); }
    setStatus(`تبدیل ناموفق بود: ${safeMessage(error)}`, 'error');
    $('retryButton').classList.remove('hidden');
  } finally {
    if (pdf) { try { await pdf.destroy(); } catch {} }
    conversionStarted = false;
    $('choosePdf').disabled = false;
  }
}

if (!token) setStatus('نشانی این برگه ناقص است؛ برگردید به پیش‌نمایش و دوباره تبدیل PDF را بزنید.', 'error');
$('choosePdf').addEventListener('click', () => $('pdfFile').click());
$('retryButton').addEventListener('click', () => {
  $('pdfFile').value = '';
  $('selectedFile').classList.add('hidden');
  $('progressArea').classList.add('hidden');
  $('retryButton').classList.add('hidden');
  setStatus('فایل PDF بعدی را انتخاب کنید.');
});
$('pdfFile').addEventListener('change', () => {
  const file = $('pdfFile').files && $('pdfFile').files[0];
  $('pdfFile').value = '';
  if (file) convertPdf(file);
});
