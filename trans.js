// ---------- ترجمهٔ متن تصاویر + ویرایشگر ترجمه + خروجی متنی ----------
// این فایل بعد از viewer.js بارگذاری می‌شود و از متغیرهای آن (items، building، ...) استفاده می‌کند.
const TR = { worker: null, lang: null, cancel: false };

function openTrDialog() {
  if (!$('ocrEnabled').checked) return;
  $('trDialog').classList.remove('hidden');
}
function closeTrDialog() { $('trDialog').classList.add('hidden'); }

async function ensureFont() {
  try { await document.fonts.load('700 24px Vazirmatn', 'ابپتثجچ'); } catch { /* ادامه */ }
}

// تصویر ترجمه‌شده را از روی بلوک‌ها (دوباره) می‌سازد
async function renderEdited(it) {
  const active = it.ocr && it.ocr.blocks.some((b) => b.enabled && b.tr && b.tr.trim());
  if (!active) { it.edited = null; return; }
  if (!canConvert(it.w, it.h)) throw new Error('ابعاد تصویر برای ترجمه بیش از حد بزرگ است');
  await ensureFont();
  const bmp = await createImageBitmap(it.blob, { imageOrientation: 'none' });
  const w = bmp.width, h = bmp.height;
  let cv;
  try { cv = Typeset.render(bmp, it.ocr.blocks); } finally { bmp.close(); }
  const blob = await canvasToBlob(cv, 'image/png');
  cv.width = cv.height = 0;
  const u8 = new Uint8Array(await blob.arrayBuffer());
  it.edited = { i: it.i, blob, info: sniff(u8), w, h };
}

async function runTranslate() {
  if (building || loading || !$('ocrEnabled').checked) return;
  const lang = $('trLang').value;
  const L = OcrTools.LANGS[lang];
  const list = items.filter((it) => it.state === 'ok' && (!$('trOnlySel').checked || it.selected));
  closeTrDialog();
  if (!list.length) {
    setStatus('تصویری برای ترجمه پیدا نشد؛ ابتدا چند تصویر بارگذاری‌شده را انتخاب کنید.');
    return;
  }

  building = true; TR.cancel = false; jobCancelRequested = false;
  setJobHint(true);
  refreshSummary();
  const result = $('result');
  result.classList.remove('hidden', 'done');
  $('downloadBtn').classList.add('hidden');
  $('btnStopTr').classList.remove('hidden');
  $('failed').innerText = '';
  $('sPages').innerText = '0';
  $('sSize').innerText = '0';
  $('lblPages').innerText = 'متن ترجمه‌شده';
  $('progressBar').style.width = '0';
  window.scrollTo({ top: 0, behavior: 'smooth' });

  let totalBlocks = 0, doneImgs = 0, trFail = 0, noText = 0, rawTotal = 0, keptTotal = 0;
  const passes = $('trPrecise').checked ? ['gray', 'bubbles', 'wmask'] : ['gray', 'bubbles'];
  const errs = [];
  try {
    setStatus('در حال بارگذاری موتور تشخیص متن... (بار اول کمی طول می‌کشد)');
    if (!TR.worker || TR.lang !== lang) {
      if (TR.worker) { try { await TR.worker.terminate(); } catch {} TR.worker = null; }
      TR.worker = await OcrTools.createOcrWorker(lang);
      TR.lang = lang;
    }

    for (let k = 0; k < list.length; k++) {
      if (TR.cancel) break;
      const it = list[k];
      const base = k / list.length, span = 1 / list.length;
      const prog = (f) => { $('progressBar').style.width = Math.round((base + span * f) * 100) + '%'; };
      prog(0);
      setStatus(`در حال خواندن متن تصویر ${k + 1} از ${list.length}...`);
      try {
        const bmp = await createImageBitmap(it.blob, { imageOrientation: 'none' });
        let lines;
        const stats = { raw: 0, kept: 0 };
        try {
          lines = await OcrTools.ocrBitmap(bmp, TR.worker, { cjk: L.cjk, lang, passes, stats, onSlice: (f) => prog(f * 0.6) });
        } finally { bmp.close(); }
        if (!$('ocrEnabled').checked) {
          it.ocr = null; it.edited = null;
          refreshCard(it); drawThumb(it);
          break;
        }
        rawTotal += stats.raw; keptTotal += stats.kept;

        const blocks = OcrTools.groupLines(lines, L.cjk);
        const eraseOriginal = $('trErase').checked;
        blocks.forEach((block) => { block.bg = eraseOriginal ? 'auto' : 'none'; });
        it.ocr = { lang, blocks };
        if (!blocks.length) { noText++; it.edited = null; }
        else {
          setStatus(`در حال ترجمهٔ ${blocks.length} متن در تصویر ${k + 1} از ${list.length}...`);
          let next = 0, n = 0;
          await Promise.all(Array.from({ length: Math.min(3, blocks.length) }, async () => {
            while (next < blocks.length && !TR.cancel) {
              const b = blocks[next++];
              const r = await TranslateTools.translate(b.text, L.sl);
              b.tr = r.text;
              if (!r.ok) trFail++;
              n++;
              prog(0.6 + 0.35 * (n / blocks.length));
            }
          }));
          if (!$('ocrEnabled').checked) {
            it.ocr = null; it.edited = null;
            refreshCard(it); drawThumb(it);
            break;
          }
          await renderEdited(it);
          if (!$('ocrEnabled').checked) {
            it.ocr = null; it.edited = null;
            refreshCard(it); drawThumb(it);
            break;
          }
          totalBlocks += blocks.length;
          doneImgs++;
          $('sPages').innerText = totalBlocks;
        }
      } catch (e) {
        console.warn(e);
        errs.push(`تصویر ${it.i + 1}: ${e && e.message ? e.message : e}`);
      }
      refreshCard(it);
      drawThumb(it);
    }

    result.classList.add('done');
    $('progressBar').style.width = '100%';
    if (errs.length && !doneImgs) {
      setStatus('ترجمه انجام نشد. اگر خطا مربوط به موتور OCR است، اکستنشن را Reload کنید.');
    } else if (!totalBlocks && !TR.cancel) {
      setStatus(`متنی پیدا نشد. موتور OCR کار کرد (${rawTotal} خط خام، ${keptTotal} خط معتبر) ولی متن قابل‌قبولی نبود. ` +
        `مطمئن شوید زبان درست انتخاب شده (الان: ${L.name}) و گزینهٔ «دقت بالاتر» روشن است.`);
    } else if (totalBlocks && trFail >= totalBlocks) {
      setStatus('متن‌ها خوانده شد ولی ترجمه انجام نشد؛ اتصال اینترنت را بررسی کنید. (متن اصلی در ویرایشگر موجود است)');
    } else {
      setStatus(`${TR.cancel ? 'متوقف شد. ' : ''}${totalBlocks} متن در ${doneImgs} تصویر ترجمه شد` +
        (noText ? ` (${noText} تصویر بدون متن)` : '') +
        (trFail ? ` — ترجمهٔ ${trFail} متن ناموفق بود` : '') +
        '. روی دکمهٔ ✎ هر تصویر بزنید تا ترجمه‌ها را ویرایش کنید.');
    }
    if (errs.length) $('failed').innerText = errs.slice(0, 5).join('\n');
  } catch (e) {
    console.error(e);
    setStatus('خطا در راه‌اندازی تشخیص متن: ' + (e && e.message ? e.message : e));
  } finally {
    building = false;
    setJobHint(false);
    setTaskTitle();
    $('btnStopTr').classList.add('hidden');
    refreshSummary();
  }
}

// ---------- ویرایشگر ----------
let EDI = null, edUrl = null, edTimer = null, edDirty = false, edBusy = false, edPending = false;

function setEdImage() {
  const blob = EDI.edited ? EDI.edited.blob : EDI.blob;
  if (edUrl) URL.revokeObjectURL(edUrl);
  edUrl = URL.createObjectURL(blob);
  $('edImg').src = edUrl;
}

function setActiveBlock(id, scroll) {
  document.querySelectorAll('.blk').forEach((r) => r.classList.toggle('active', +r.dataset.id === id));
  document.querySelectorAll('.ed-box').forEach((r) => r.classList.toggle('active', +r.dataset.id === id));
  if (scroll) {
    const row = document.querySelector(`.blk[data-id="${id}"]`);
    if (row) { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); const ta = row.querySelector('textarea'); if (ta) ta.focus(); }
  }
}

function scheduleApply() {
  edDirty = true;
  clearTimeout(edTimer);
  edTimer = setTimeout(applyEditor, 900);
}

async function applyEditor() {
  if (!EDI) return;
  if (edBusy) { edPending = true; return; }
  edBusy = true; edDirty = false;
  clearTimeout(edTimer);
  try {
    await renderEdited(EDI);
    setEdImage();
    refreshCard(EDI);
    drawThumb(EDI);
  } catch (e) {
    console.warn(e);
    alert('خطا در ساخت تصویر: ' + (e && e.message ? e.message : e));
  } finally {
    edBusy = false;
    if (edPending) { edPending = false; applyEditor(); }
  }
}

function buildEditor() {
  const it = EDI, bl = it.ocr.blocks;
  const list = $('edList'), boxes = $('edBoxes');
  list.innerHTML = ''; boxes.innerHTML = '';
  if (!bl.length) { list.innerHTML = '<div class="ed-empty">در این تصویر متنی پیدا نشد.</div>'; return; }

  bl.forEach((b) => {
    const box = document.createElement('div');
    box.className = 'ed-box' + (b.enabled ? '' : ' off');
    box.dataset.id = b.id;
    box.style.cssText = `left:${(b.x0 / it.w) * 100}%;top:${(b.y0 / it.h) * 100}%;width:${((b.x1 - b.x0) / it.w) * 100}%;height:${((b.y1 - b.y0) / it.h) * 100}%`;
    box.innerHTML = `<span>${b.id}</span>`;
    box.onclick = () => setActiveBlock(b.id, true);
    boxes.appendChild(box);

    const row = document.createElement('div');
    row.className = 'blk' + (b.enabled ? '' : ' off');
    row.dataset.id = b.id;
    row.innerHTML = `<div class="blk-top"><span class="blk-n">${b.id}</span>
      <label><input type="checkbox" ${b.enabled ? 'checked' : ''}> جایگزین شود</label>
      <select class="sel blk-bg"><option value="auto">پس‌زمینه: خودکار</option><option value="white">پس‌زمینه: سفید</option>
      <option value="black">پس‌زمینه: مشکی</option><option value="none">بدون پاک‌کردن (متن با حاشیه)</option></select></div>
      <div class="blk-orig"></div><textarea rows="2" placeholder="ترجمهٔ فارسی..."></textarea>`;
    row.querySelector('.blk-orig').textContent = b.text;
    const ta = row.querySelector('textarea'); ta.value = b.tr || '';
    const sel = row.querySelector('select'); sel.value = b.bg;
    const chk = row.querySelector('input');
    ta.oninput = () => { b.tr = ta.value; scheduleApply(); };
    ta.onfocus = () => setActiveBlock(b.id, false);
    sel.onchange = () => { b.bg = sel.value; scheduleApply(); };
    chk.onchange = () => { b.enabled = chk.checked; row.classList.toggle('off', !b.enabled); box.classList.toggle('off', !b.enabled); scheduleApply(); };
    list.appendChild(row);
  });
}

function openEditor(it) {
  if (!it || !it.ocr) return;
  EDI = it; edDirty = false;
  $('edTitle').innerText = `ویرایش ترجمه — تصویر ${it.i + 1} (${it.ocr.blocks.length} متن)`;
  buildEditor();
  setEdImage();
  $('editor').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

async function closeEditor() {
  if (!EDI) return;
  clearTimeout(edTimer);
  if (edDirty) await applyEditor();
  $('editor').classList.add('hidden');
  document.body.style.overflow = '';
  if (edUrl) { URL.revokeObjectURL(edUrl); edUrl = null; }
  $('edImg').removeAttribute('src');
  EDI = null;
  refreshAll();
}

// ---------- خروجی متنی قابل ویرایش ----------
function exportText() {
  const done = items.filter((it) => it.ocr && it.ocr.blocks.length);
  if (!done.length) { alert('هنوز متنی استخراج نشده است. ابتدا «ترجمهٔ متن تصاویر» را اجرا کنید.'); return; }
  const pad = Math.max(3, String(items.length).length);
  let out = '';
  done.forEach((it) => {
    out += `===== تصویر ${String(it.i + 1).padStart(pad, '0')} =====\n\n`;
    it.ocr.blocks.forEach((b) => {
      out += `[${b.id}] ${b.text}\n    ← ${b.tr && b.tr.trim() ? b.tr.trim() : '(بدون ترجمه)'}\n\n`;
    });
  });
  const blob = new Blob(['\ufeff' + out], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = ($('pdfName').value.trim() || 'comic').replace(/\.pdf$/i, '') + '-text.txt';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------- اتصال رویدادها ----------
$('ocrEnabled').addEventListener('change', async () => {
  if (!$('ocrEnabled').checked) {
    TR.cancel = true;
    // خاموش‌کردن سراسری OCR، ترجمه‌های موقت را کنار می‌گذارد و تصویر اصلی را برمی‌گرداند.
    items.forEach((it) => { it.ocr = null; it.edited = null; });
    refreshAll();
    items.filter((it) => it.state === 'ok').forEach((it) => drawThumb(it));
    if (TR.worker) {
      try { await TR.worker.terminate(); } catch {}
      TR.worker = null;
      TR.lang = null;
    }
  }
  refreshSummary();
});
$('btnTranslate').onclick = openTrDialog;
$('trClose').onclick = closeTrDialog;
$('trStart').onclick = runTranslate;
$('trDialog').addEventListener('click', (e) => { if (e.target.id === 'trDialog') closeTrDialog(); });
$('btnStopTr').onclick = () => { TR.cancel = true; };
$('edApply').onclick = applyEditor;
$('edClose').onclick = closeEditor;
$('edRevert').onclick = async () => {
  if (!EDI) return;
  EDI.ocr.blocks.forEach((b) => { b.enabled = false; });
  buildEditor();
  await applyEditor();
};
$('btnTxt').onclick = exportText;
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('editor').classList.contains('hidden')) closeEditor();
  else if (!$('trDialog').classList.contains('hidden')) closeTrDialog();
});
window.addEventListener('pagehide', () => { if (TR.worker) { try { TR.worker.terminate(); } catch {} } });
