/* exported openEditor */ // viewer.js این تابع سراسری را برای بازکردن ادیتور صدا می‌زند.
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

  let totalBlocks = 0, translatedBlocks = 0, reviewBlocks = 0, doneImgs = 0, trFail = 0, noText = 0, rawTotal = 0, keptTotal = 0;
  const ocrProfile = $('trOcrProfile').value;
  const enhanceContrast = $('trContrast').checked;
  const precise = $('trPrecise').checked;
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
          lines = await OcrTools.ocrWithProfiles(bmp, TR.worker, {
            cjk: L.cjk, lang, profile: ocrProfile, enhanceContrast, precise, stats,
            onSlice: (f) => prog(f * 0.6),
            onProfile: (profile, index, count) => setStatus(`روش OCR ${index + 1} از ${count}: ${profile.name} — تصویر ${k + 1} از ${list.length}...`)
          });
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
          const minTranslateConfidence = 55;
          const translatable = blocks.filter((block) => Number.isFinite(block.conf) && block.conf >= minTranslateConfidence);
          const reviewCount = blocks.length - translatable.length;
          totalBlocks += blocks.length;
          translatedBlocks += translatable.length;
          reviewBlocks += reviewCount;
          if (reviewCount) {
            setStatus(`${reviewCount} متن با اطمینان OCR پایین برای جلوگیری از ترجمهٔ بی‌معنی فعلاً رد شد؛ تصویر ${k + 1} از ${list.length}. در ویرایشگر متن OCR را اصلاح و «ترجمهٔ دوباره» را بزنید.`);
          }
          if (translatable.length) {
            setStatus(`در حال ترجمهٔ ${translatable.length} متن مطمئن در تصویر ${k + 1} از ${list.length}...`);
            let next = 0, n = 0;
            await Promise.all(Array.from({ length: Math.min(3, translatable.length) }, async () => {
              while (next < translatable.length && !TR.cancel) {
                const b = translatable[next++];
                const r = await TranslateTools.translate(b.text, L.sl);
                b.tr = r.text;
                if (!r.ok) trFail++;
                n++;
                prog(0.6 + 0.35 * (n / translatable.length));
              }
            }));
          }
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
          doneImgs++;
          $('sPages').innerText = translatedBlocks;
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
    } else if (translatedBlocks && trFail >= translatedBlocks) {
      setStatus('متن‌های مطمئن خوانده شد ولی ترجمه انجام نشد؛ اتصال اینترنت را بررسی کنید. متن‌های OCR با اطمینان پایین در ویرایشگر برای اصلاح باقی مانده‌اند.');
    } else if (!translatedBlocks && reviewBlocks) {
      setStatus(`${reviewBlocks} متن شناسایی شد ولی اطمینان OCR کافی نبود؛ برای جلوگیری از ترجمهٔ چرت، ترجمهٔ خودکار انجام نشد. روی ✎ تصویر بزنید، متن OCR را اصلاح کنید و «ترجمهٔ دوباره» را بزنید.`);
    } else {
      setStatus(`${TR.cancel ? 'متوقف شد. ' : ''}${translatedBlocks} متن مطمئن در ${doneImgs} تصویر ترجمه شد` +
        (reviewBlocks ? ` — ${reviewBlocks} متن با اطمینان OCR پایین برای اصلاح دستی کنار گذاشته شد` : '') +
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

// کپی متن ساده در کلیپ‌بورد؛ در نبود Clipboard API (مجوز/پروتکل) از روش قدیمی textarea استفاده می‌کند
async function copyPlainText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}
async function retranslateBlock(item, block, originalField, editor, overlay, button) {
  const source = String(originalField.value || '');
  block.text = source;
  if (!source.trim()) { button.title = 'ابتدا متن OCR را اصلاح کنید'; return; }
  const lang = OcrTools.LANGS[item.ocr.lang] || OcrTools.LANGS.eng;
  const oldLabel = button.textContent;
  button.disabled = true; button.textContent = 'در حال ترجمه…';
  try {
    const result = await TranslateTools.translate(source.trim(), lang.sl);
    if (!result.ok || !result.text) throw new Error('ترجمه انجام نشد؛ اتصال اینترنت را بررسی کنید.');
    block.tr = result.text;
    block.richHtml = safeEditorHtml(escapeEditorText(result.text).replace(/\n/g, '<br>'));
    if (EDI === item) {
      editor.innerHTML = block.richHtml;
      overlay.innerHTML = block.richHtml;
      updatePreviewScale();
      edDirty = true;
      await applyEditor();
    } else {
      await renderEdited(item);
      refreshCard(item); drawThumb(item);
    }
    button.textContent = 'ترجمه شد ✓';
    button.title = `ترجمه از ${lang.name} به فارسی انجام شد`;
  } catch (error) {
    button.textContent = 'ترجمه ناموفق';
    button.title = error && error.message ? error.message : String(error);
  } finally {
    button.disabled = false;
    setTimeout(() => {
      if (!button.isConnected) return;
      button.textContent = oldLabel;
      button.title = 'ترجمهٔ دوبارهٔ متن اصلاح‌شده به فارسی';
    }, 1800);
  }
}

// ---------- ویرایشگر متن غنی ----------
let EDI = null, edUrl = null, edTimer = null, edDirty = false, edBusy = false, edPending = false;
let activeRichEditor = null, richSelectionRange = null;
const EDITOR_APPLY_DELAY = 900;
let edFieldFocused = false;
const editorFieldEl = (el) => el && el.closest && el.closest('#editor') &&
  (el.isContentEditable || el.getAttribute('contenteditable') === 'true' || ['INPUT', 'SELECT'].includes(el.tagName)) ? el : null;
function isEditorInputFocused() { return edFieldFocused; }

function escapeEditorText(value) {
  return String(value || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function legacyMarksToHtml(value) {
  if (!value || typeof Typeset === 'undefined' || !Typeset.hasInlineMarks(value)) return escapeEditorText(value).replace(/\n/g, '<br>');
  return Typeset.tokenizeInline(value).map((run) => {
    let text = escapeEditorText(run.t).replace(/\n/g, '<br>');
    if (run.bold) text = `<strong>${text}</strong>`;
    if (run.italic) text = `<em>${text}</em>`;
    if (run.underline) text = `<u>${text}</u>`;
    const styles = [];
    if (run.size) styles.push(`font-size:${Math.max(8, Math.min(160, run.size))}px`);
    if (run.color) styles.push(`color:${run.color}`);
    if (styles.length) text = `<span style="${styles.join(';')}">${text}</span>`;
    return text;
  }).join('');
}
function safeEditorHtml(html) {
  const root = document.createElement('div');
  root.innerHTML = html || '';
  const walk = (node, isRoot = false) => {
    if (node.nodeType === 3) return escapeEditorText(node.nodeValue);
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    if (tag === 'br') { return '<br>'; }
    let inner = [...node.childNodes].map((child) => walk(child)).join('');
    if (tag === 'div' || tag === 'p') { return inner + (isRoot ? '' : '<br>'); }
    if (tag === 'ul' || tag === 'ol') {
      return [...node.children].map((li, i) =>
        `${tag === 'ul' ? '•' : `${i + 1}.`} ${[...li.childNodes].map((child) => walk(child)).join('')}<br>`).join('');
    }
    if (tag === 'li') return inner;
    if (['b', 'strong'].includes(tag)) return `<strong>${inner}</strong>`;
    if (['i', 'em'].includes(tag)) return `<em>${inner}</em>`;
    if (tag === 'u') return `<u>${inner}</u>`;
    if (tag === 's' || tag === 'strike' || tag === 'del') return `<s>${inner}</s>`;
    if (tag === 'span') {
      const styles = [];
      const size = Number.parseFloat(node.style.fontSize);
      if (Number.isFinite(size)) styles.push(`font-size:${Math.max(8, Math.min(160, size))}px`);
      const weight = node.style.fontWeight;
      if (weight === 'bold' || Number(weight) >= 600) styles.push('font-weight:700');
      else if (weight === 'normal' || weight === '400') styles.push('font-weight:400');
      if (node.style.fontStyle === 'italic') styles.push('font-style:italic');
      else if (node.style.fontStyle === 'normal') styles.push('font-style:normal');
      const decoration = node.style.textDecorationLine || node.style.textDecoration;
      if (decoration && decoration.includes('underline')) styles.push('text-decoration:underline');
      if (decoration && decoration.includes('line-through')) styles.push('text-decoration:line-through');
      const color = node.style.color;
      if (/^#[\da-f]{3,8}$/i.test(color) || /^rgba?\([\d\s,.%]+\)$/i.test(color)) styles.push(`color:${color}`);
      return styles.length ? `<span style="${styles.join(';')}">${inner}</span>` : inner;
    }
    return inner;
  };
  return [...root.childNodes].map((node) => walk(node)).join('');
}
function plainTextFromHtml(html) {
  const root = document.createElement('div'); root.innerHTML = html || '';
  const walk = (node) => {
    if (node.nodeType === 3) return node.nodeValue;
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    if (tag === 'br') return '\n';
    const text = [...node.childNodes].map(walk).join('');
    return ['div', 'p', 'li'].includes(tag) ? text + '\n' : text;
  };
  return [...root.childNodes].map(walk).join('').replace(/\n+$/g, '');
}
function normalizeLegacyBlock(block) {
  if (!block.richHtml && block.tr && typeof Typeset !== 'undefined' && Typeset.hasInlineMarks(block.tr)) {
    block.richHtml = legacyMarksToHtml(block.tr);
    block.tr = Typeset.stripInlineMarkers(block.tr);
  }
  block.richHtml = safeEditorHtml(block.richHtml || escapeEditorText(block.tr || '').replace(/\n/g, '<br>'));
  block.tr = plainTextFromHtml(block.richHtml);
}
function setActiveBlock(id, scroll) {
  document.querySelectorAll('.blk').forEach((r) => r.classList.toggle('active', String(r.dataset.id) === String(id)));
  document.querySelectorAll('.ed-box').forEach((r) => r.classList.toggle('active', String(r.dataset.id) === String(id)));
  if (scroll) {
    const row = document.querySelector(`.blk[data-id="${id}"]`);
    if (row) { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); const field = row.querySelector('.blk-editor'); if (field) field.focus(); }
  }
}
function scheduleApply() {
  edDirty = true; clearTimeout(edTimer);
  edTimer = setTimeout(() => {
    if (isEditorInputFocused()) { scheduleApply(); return; }
    applyEditor();
  }, EDITOR_APPLY_DELAY);
}
function flushEditorOnBlur() { if (edDirty) applyEditor(); }
function updateRichBlock(blockId, source) {
  if (!EDI) return;
  const block = EDI.ocr.blocks.find((b) => String(b.id) === String(blockId));
  if (!block) return;
  block.richHtml = safeEditorHtml(source.innerHTML);
  block.tr = plainTextFromHtml(block.richHtml);
  document.querySelectorAll(`.blk-editor[data-id="${blockId}"], .ed-box-text[data-id="${blockId}"]`).forEach((field) => {
    if (field !== source) field.innerHTML = block.richHtml || '';
  });
  updatePreviewScale();
  scheduleApply();
}
function runRichCommand(command, value) {
  if (!activeRichEditor) return;
  activeRichEditor.focus();
  document.execCommand(command, false, value || null);
  updateRichBlock(activeRichEditor.dataset.id, activeRichEditor);
  syncRichToolbarState();
}
function applyRichStyle(property, value) {
  const editor = activeRichEditor;
  const selection = window.getSelection();
  let range = selection && selection.rangeCount && editor && editor.contains(selection.anchorNode)
    ? selection.getRangeAt(0).cloneRange() : null;
  if (!range && richSelectionRange && editor && editor.contains(richSelectionRange.startContainer)) range = richSelectionRange.cloneRange();
  if (!editor || !range || range.collapsed) return false;
  const span = document.createElement('span');
  if (property === 'fontSize') span.style.fontSize = `${Math.max(8, Math.min(160, Number(value) || 16))}px`;
  else if (property === 'color' && (/^#[\da-f]{3,8}$/i.test(value) || /^rgba?\([\d\s,.%]+\)$/i.test(value))) span.style.color = value;
  else return false;
  try {
    span.appendChild(range.extractContents()); range.insertNode(span);
    selection.removeAllRanges(); const next = document.createRange(); next.selectNodeContents(span); selection.addRange(next);
    richSelectionRange = next.cloneRange();
  } catch { return false; }
  updateRichBlock(editor.dataset.id, editor);
  return true;
}
function hasRichSelection(editor) {
  const selection = window.getSelection();
  const current = selection && selection.rangeCount && editor && editor.contains(selection.anchorNode)
    ? selection.getRangeAt(0) : null;
  const range = current || (richSelectionRange && editor && editor.contains(richSelectionRange.startContainer) ? richSelectionRange : null);
  return !!(range && !range.collapsed);
}
function insertPlainPaste(event, editor) {
  event.preventDefault();
  const text = event.clipboardData ? event.clipboardData.getData('text/plain') : '';
  editor.focus();
  document.execCommand('insertText', false, text);
  updateRichBlock(editor.dataset.id, editor);
}
function selectRichEditor(editor) {
  activeRichEditor = editor;
  setActiveBlock(editor.dataset.id, false);
}
function syncRichToolbarState() {
  if (!activeRichEditor || typeof document.queryCommandState !== 'function') return;
  const row = document.querySelector(`.blk[data-id="${activeRichEditor.dataset.id}"]`);
  if (!row) return;
  [['bold', '.blk-bold'], ['italic', '.blk-italic'], ['underline', '.blk-under'], ['strikeThrough', '.blk-strike']].forEach(([command, selector]) => {
    let active = false;
    try { active = document.queryCommandState(command); } catch { active = false; }
    const button = row.querySelector(selector);
    if (button) { button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }
  });
}
function previewTextSize(block, boxWidth, boxHeight) {
  const style = Typeset.blockStyle(block);
  if (style.size) return style.size;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return Math.max(10, Math.round((block.lineH || 16) * 1.1));
  const maxSize = Math.max(12, Math.min(64, Math.round((block.lineH || 16) * 1.1)));
  const fontPrefix = `${style.italic ? 'italic ' : ''}${style.bold ? '700' : '400'} `;
  const rich = !!block.richHtml || Typeset.hasInlineMarks(block.tr || '');
  if (rich) {
    const words = block.richHtml ? Typeset.richHtmlWords(block.richHtml) : Typeset.inlineWords(block.tr || '');
    return Typeset.fitInline(ctx, words, boxWidth * 0.96, boxHeight * 0.96, maxSize, 8, style).size;
  }
  return Typeset.fit(ctx, (block.tr || '').trim(), boxWidth * 0.96, boxHeight * 0.96, maxSize, 8, fontPrefix).size;
}
function syncBlockTextStyles(block, editor, overlay) {
  const baseSize = block.size || Math.max(10, Math.round((block.lineH || 16) * 1.1));
  [editor, overlay].forEach((field) => {
    field.setAttribute('dir', block.dir);
    field.style.textAlign = block.align;
    field.style.fontWeight = block.bold ? '700' : '400';
    field.style.fontStyle = block.italic ? 'italic' : 'normal';
    field.style.textDecoration = block.underline ? 'underline' : 'none';
    field.style.color = block.color || (field.classList.contains('ed-box-text') ? '#fff' : 'var(--text)');
    field.style.fontSize = `${baseSize}px`;
  });
  overlay.dataset.baseSize = String(baseSize);
  updatePreviewScale();
}
function updatePreviewScale() {
  if (!EDI) return;
  const stage = document.querySelector('.ed-stage');
  if (!stage || !EDI.w) return;
  const stageWidth = stage.getBoundingClientRect().width;
  if (!stageWidth) return;
  const scale = stageWidth / EDI.w;
  stage.querySelectorAll('.ed-box-text').forEach((field) => {
    const block = EDI.ocr.blocks.find((item) => String(item.id) === String(field.dataset.id));
    if (!block) return;
    const x0 = Number.isFinite(block.tx0) ? block.tx0 : block.x0;
    const y0 = Number.isFinite(block.ty0) ? block.ty0 : block.y0;
    const x1 = Number.isFinite(block.tx1) ? block.tx1 : block.x1;
    const y1 = Number.isFinite(block.ty1) ? block.ty1 : block.y1;
    field.style.transform = `scale(${scale})`;
    field.style.left = '2%'; field.style.top = '2%';
    field.style.right = 'auto'; field.style.bottom = 'auto';
    field.style.width = `${96 / scale}%`;
    field.style.height = `${96 / scale}%`;
    // Match Typeset.render's auto-fit and 2% inner margin before scaling logical image pixels down.
    field.style.fontSize = `${previewTextSize(block, x1 - x0, y1 - y0)}px`;
  });
}

async function applyEditor() {
  if (!EDI) return;
  if (edBusy) { edPending = true; return; }
  // آیتم را در همان ابتدا تثبیت کن؛ اگر حین رندر ناهمگام، ویرایشگر بسته یا به تصویر دیگری منتقل شد،
  // فراخوانی‌های بعدی به EDI تهی‌شده دست نزنند و رندر آیتم قبلی سالم کامل شود
  const item = EDI;
  edBusy = true; edDirty = false;
  clearTimeout(edTimer);
  try {
    await renderEdited(item);
    // پیش‌نمایش ویرایشگر با لایهٔ زندهٔ متن به‌روز می‌شود؛ تصویر اصلی زیر آن ثابت می‌ماند.
    refreshCard(item);
    drawThumb(item);
  } catch (e) {
    console.warn(e);
    alert('خطا در ساخت تصویر: ' + (e && e.message ? e.message : e));
  } finally {
    edBusy = false;
    if (edPending) { edPending = false; applyEditor(); }
  }
}

function buildEditor() {
  const it = EDI, blocks = it.ocr.blocks;
  const list = $('edList'), boxes = $('edBoxes');
  list.innerHTML = ''; boxes.innerHTML = '';
  activeRichEditor = null; edFieldFocused = false;
  if (!blocks.length) { list.innerHTML = '<div class="ed-empty">در این تصویر متنی پیدا نشد.</div>'; return; }

  const makeToolbar = (block) => `<div class="blk-format" role="toolbar" aria-label="قالب‌بندی متن">
    <div class="dir-group" title="جهت متن"><button type="button" class="fmt-btn blk-dir-rtl" title="راست‌به‌چپ">RTL</button><button type="button" class="fmt-btn blk-dir-ltr" title="چپ‌به‌راست">LTR</button></div>
    <select class="sel blk-align" title="تراز متن"><option value="right">راست‌چین</option><option value="center">وسط‌چین</option><option value="left">چپ‌چین</option></select>
    <button type="button" class="fmt-btn blk-bold" data-command="bold" title="پررنگ"><b>B</b></button>
    <button type="button" class="fmt-btn blk-italic" data-command="italic" title="کج"><i>I</i></button>
    <button type="button" class="fmt-btn blk-under" data-command="underline" title="زیرخط"><u>U</u></button>
    <button type="button" class="fmt-btn blk-strike" data-command="strikeThrough" title="خط‌خورده">S̶</button>
    <button type="button" class="fmt-btn blk-bullet" data-command="insertUnorderedList" title="فهرست نشانه‌دار">•≡</button>
    <button type="button" class="fmt-btn blk-numbered" data-command="insertOrderedList" title="فهرست شماره‌دار">1≡</button>
    <label class="size-field">اندازه <input type="number" class="blk-size" min="8" max="160" step="1" placeholder="خودکار" aria-label="اندازهٔ قلم"></label>
    <label class="color-field">رنگ <input type="color" class="blk-color" value="#0b0b0b" aria-label="رنگ قلم"></label>
    <button type="button" class="fmt-btn blk-undo" data-command="undo" title="واگرد">↶</button>
    <button type="button" class="fmt-btn blk-redo" data-command="redo" title="ازنو">↷</button>
    <button type="button" class="fmt-btn blk-clear" data-command="removeFormat" title="پاک‌کردن قالب‌بندی">Tx</button>
  </div>`;

  blocks.forEach((b) => {
    b.dir = b.dir === 'ltr' ? 'ltr' : 'rtl';
    b.align = ['center', 'left'].includes(b.align) ? b.align : 'right';
    b.bold = b.bold !== false; b.italic = !!b.italic; b.underline = !!b.underline;
    b.size = Number.isFinite(+b.size) && +b.size > 0 ? +b.size : null;
    b.color = /^#[\da-f]{6}$/i.test(b.color) ? b.color : null;
    normalizeLegacyBlock(b);

    const box = document.createElement('div');
    box.className = `ed-box${b.enabled ? '' : ' off'}`; box.dataset.id = b.id;
    boxes.appendChild(box);
    const overlay = document.createElement('div');
    overlay.className = 'ed-box-text'; overlay.dataset.id = b.id;
    overlay.contentEditable = 'true'; overlay.setAttribute('contenteditable', 'true'); overlay.setAttribute('role', 'textbox'); overlay.setAttribute('aria-label', `ویرایش مستقیم ترجمه ${b.id}`);
    overlay.setAttribute('dir', b.dir); overlay.spellcheck = true; overlay.innerHTML = b.richHtml || '';
    overlay.dataset.baseSize = String(b.size || Math.max(10, Math.round((b.lineH || 16) * 1.1)));
    box.appendChild(overlay);
    const moveHandle = document.createElement('button');
    moveHandle.type = 'button'; moveHandle.className = 'ed-move'; moveHandle.textContent = '⠿';
    moveHandle.setAttribute('aria-label', `جابجایی کادر متن ${b.id}`); moveHandle.title = 'برای جابجایی کادر بکشید';
    box.appendChild(moveHandle);
    ['n','ne','e','se','s','sw','w','nw'].forEach((dir) => {
      const handle = document.createElement('button'); handle.type = 'button'; handle.className = `ed-resize ed-resize-${dir}`;
      handle.dataset.dir = dir; handle.setAttribute('aria-label', `تغییر اندازهٔ کادر ${dir}`); box.appendChild(handle);
    });
    const setGeometry = () => {
      const x0 = Number.isFinite(b.tx0) ? b.tx0 : b.x0, y0 = Number.isFinite(b.ty0) ? b.ty0 : b.y0;
      const x1 = Number.isFinite(b.tx1) ? b.tx1 : b.x1, y1 = Number.isFinite(b.ty1) ? b.ty1 : b.y1;
      box.style.left = `${x0 / it.w * 100}%`; box.style.top = `${y0 / it.h * 100}%`;
      box.style.width = `${(x1 - x0) / it.w * 100}%`; box.style.height = `${(y1 - y0) / it.h * 100}%`;
      updatePreviewScale();
    };
    setGeometry();
    box.classList.toggle('off', !b.enabled);
    box.classList.toggle('active', false);
    const startBoxMove = (event, handle) => {
      event.preventDefault(); event.stopPropagation();
      selectRichEditor(overlay);
      const stageRect = document.querySelector('.ed-stage').getBoundingClientRect();
      if (!stageRect.width || !stageRect.height) return;
      const sx = it.w / stageRect.width, sy = it.h / stageRect.height;
      const x0 = Number.isFinite(b.tx0) ? b.tx0 : b.x0, y0 = Number.isFinite(b.ty0) ? b.ty0 : b.y0;
      const x1 = Number.isFinite(b.tx1) ? b.tx1 : b.x1, y1 = Number.isFinite(b.ty1) ? b.ty1 : b.y1;
      const origin = { x: event.clientX, y: event.clientY, x0, y0, x1, y1 };
      handle.setPointerCapture(event.pointerId);
      const move = (ev) => {
        const width = origin.x1 - origin.x0, height = origin.y1 - origin.y0;
        const nextX0 = Math.max(0, Math.min(it.w - width, origin.x0 + (ev.clientX - origin.x) * sx));
        const nextY0 = Math.max(0, Math.min(it.h - height, origin.y0 + (ev.clientY - origin.y) * sy));
        b.tx0 = nextX0; b.tx1 = nextX0 + width;
        b.ty0 = nextY0; b.ty1 = nextY0 + height;
        setGeometry(); scheduleApply();
      };
      const stop = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', stop);
        handle.removeEventListener('pointercancel', stop);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', stop);
      handle.addEventListener('pointercancel', stop);
    };
    moveHandle.addEventListener('pointerdown', (event) => startBoxMove(event, moveHandle));
    box.addEventListener('pointerdown', (event) => {
      if (event.target === box) startBoxMove(event, box);
    });
    overlay.addEventListener('focus', () => { selectRichEditor(overlay); edFieldFocused = true; });
    overlay.addEventListener('input', () => updateRichBlock(b.id, overlay));
    overlay.addEventListener('paste', (event) => insertPlainPaste(event, overlay));
    overlay.addEventListener('focusout', (event) => {
      if (editorFieldEl(event.relatedTarget)) return;
      edFieldFocused = false; flushEditorOnBlur();
    });
    box.querySelectorAll('.ed-resize').forEach((handle) => handle.addEventListener('pointerdown', (event) => {
      event.preventDefault(); event.stopPropagation();
      const stageRect = document.querySelector('.ed-stage').getBoundingClientRect();
      const sx = it.w / stageRect.width, sy = it.h / stageRect.height;
      const dir = handle.dataset.dir;
      let x0 = Number.isFinite(b.tx0) ? b.tx0 : b.x0, y0 = Number.isFinite(b.ty0) ? b.ty0 : b.y0;
      let x1 = Number.isFinite(b.tx1) ? b.tx1 : b.x1, y1 = Number.isFinite(b.ty1) ? b.ty1 : b.y1;
      const origin = { x: event.clientX, y: event.clientY, x0, y0, x1, y1 };
      handle.setPointerCapture(event.pointerId);
      const move = (ev) => {
        const dx = (ev.clientX - origin.x) * sx, dy = (ev.clientY - origin.y) * sy;
        const minW = Math.min(20, it.w), minH = Math.min(16, it.h);
        x0 = origin.x0; y0 = origin.y0; x1 = origin.x1; y1 = origin.y1;
        if (dir.includes('w')) x0 = Math.max(0, Math.min(origin.x1 - minW, origin.x0 + dx));
        if (dir.includes('e')) x1 = Math.min(it.w, Math.max(origin.x0 + minW, origin.x1 + dx));
        if (dir.includes('n')) y0 = Math.max(0, Math.min(origin.y1 - minH, origin.y0 + dy));
        if (dir.includes('s')) y1 = Math.min(it.h, Math.max(origin.y0 + minH, origin.y1 + dy));
        b.tx0 = x0; b.ty0 = y0; b.tx1 = x1; b.ty1 = y1;
        setGeometry(); scheduleApply();
      };
      const stop = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', stop); handle.removeEventListener('pointercancel', stop); };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', stop); handle.addEventListener('pointercancel', stop);
    }));

    const row = document.createElement('div'); row.className = `blk${b.enabled ? '' : ' off'}`; row.dataset.id = b.id;
    row.innerHTML = `<div class="blk-top"><span class="blk-n">${b.id}</span>
      <label><input type="checkbox" ${b.enabled ? 'checked' : ''}> جایگزین شود</label>
      <select class="sel blk-bg"><option value="auto">پس‌زمینه: خودکار</option><option value="white">پس‌زمینه: سفید</option>
      <option value="black">پس‌زمینه: مشکی</option><option value="none">بدون پاک‌کردن</option></select>
      <button type="button" class="fmt-btn blk-copy-orig" title="کپی متن OCR">کپی متن اصلی</button></div>
      ${makeToolbar(b)}
      <div class="blk-orig"><label class="blk-orig-label">متن OCR (قابل اصلاح)</label>
        <textarea class="blk-orig-text" rows="2" aria-label="اصلاح متن تشخیص‌داده‌شده"></textarea>
        <div class="blk-actions">
          <button type="button" class="fmt-btn blk-retranslate" title="ترجمهٔ دوبارهٔ متن اصلاح‌شده به فارسی">ترجمهٔ دوباره</button>
          <button type="button" class="fmt-btn blk-clear-translation" title="پاک‌کردن فقط ترجمهٔ این متن؛ متن OCR و بقیهٔ ترجمه‌ها باقی می‌مانند">پاک‌کردن ترجمه</button>
        </div>
      </div>
      <div class="blk-editor" data-id="${escapeEditorText(b.id)}" contenteditable="true" role="textbox" aria-label="ترجمهٔ قابل ویرایش" spellcheck="true"></div>
      <div class="blk-help">متن را همین‌جا اصلاح کنید؛ برای ویرایش روی تصویر، دستگیرهٔ بالای کادر را بکشید تا جابه‌جا شود و دستگیره‌های دور کادر را برای تغییر اندازه بکشید.</div>`;
    const originalField = row.querySelector('.blk-orig-text');
    originalField.dir = 'auto';
    originalField.value = b.text || '';
    originalField.addEventListener('input', () => { b.text = originalField.value; });
    const editor = row.querySelector('.blk-editor'); editor.setAttribute('dir', b.dir); editor.innerHTML = b.richHtml || '';
    syncBlockTextStyles(b, editor, overlay);
    row.querySelector('.blk-bg').value = b.bg || 'auto';
    row.querySelector('.blk-editor').addEventListener('focus', () => { selectRichEditor(editor); edFieldFocused = true; });
    editor.addEventListener('input', () => updateRichBlock(b.id, editor));
    editor.addEventListener('paste', (event) => insertPlainPaste(event, editor));
    editor.addEventListener('focusout', (event) => {
      if (editorFieldEl(event.relatedTarget)) return;
      edFieldFocused = false; flushEditorOnBlur();
    });
    row.querySelector('.blk-top input').addEventListener('change', (event) => {
      b.enabled = event.target.checked; row.classList.toggle('off', !b.enabled); box.classList.toggle('off', !b.enabled); scheduleApply();
    });
    row.querySelector('.blk-bg').addEventListener('change', (event) => { b.bg = event.target.value; scheduleApply(); });
    row.querySelector('.blk-copy-orig').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const ok = await copyPlainText(b.text || '');
      button.classList.toggle('copied', ok);
      button.title = ok ? 'کپی شد ✓' : 'کپی ناموفق بود';
      setTimeout(() => { button.classList.remove('copied'); button.title = 'کپی متن OCR'; }, 1400);
    });
    row.querySelector('.blk-retranslate').addEventListener('click', (event) =>
      retranslateBlock(it, b, originalField, editor, overlay, event.currentTarget));
    row.querySelector('.blk-clear-translation').addEventListener('click', (event) => {
      b.tr = '';
      b.richHtml = '';
      editor.innerHTML = '';
      overlay.innerHTML = '';
      updatePreviewScale();
      scheduleApply();
      const button = event.currentTarget;
      button.textContent = 'پاک شد ✓';
      button.disabled = true;
      setTimeout(() => {
        if (!button.isConnected) return;
        button.textContent = 'پاک‌کردن ترجمه';
        button.disabled = false;
      }, 1400);
    });
    row.querySelectorAll('.blk-format button').forEach((button) => {
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => {
        if (button.classList.contains('blk-dir-rtl') || button.classList.contains('blk-dir-ltr')) {
          b.dir = button.classList.contains('blk-dir-rtl') ? 'rtl' : 'ltr';
          syncBlockTextStyles(b, editor, overlay); scheduleApply(); return;
        }
        const command = button.dataset.command;
        if (command) runRichCommand(command);
      });
    });
    row.querySelector('.blk-align').value = b.align;
    row.querySelector('.blk-align').addEventListener('change', (event) => { b.align = event.target.value; syncBlockTextStyles(b, editor, overlay); scheduleApply(); });
    row.querySelector('.blk-size').value = b.size || '';
    row.querySelector('.blk-size').addEventListener('change', (event) => {
      const size = Number(event.target.value);
      const selection = activeRichEditor && String(activeRichEditor.dataset.id) === String(b.id) && hasRichSelection(activeRichEditor);
      if (selection && applyRichStyle('fontSize', size)) return;
      b.size = size >= 8 ? Math.min(160, size) : null;
      syncBlockTextStyles(b, editor, overlay);
      scheduleApply();
    });
    row.querySelector('.blk-color').addEventListener('input', (event) => {
      const selection = activeRichEditor && String(activeRichEditor.dataset.id) === String(b.id) && hasRichSelection(activeRichEditor);
      if (selection && applyRichStyle('color', event.target.value)) return;
      b.color = event.target.value; syncBlockTextStyles(b, editor, overlay); scheduleApply();
    });
    list.appendChild(row);
  });
  updatePreviewScale();
  if (!window.__editorResizeBound) {
    window.addEventListener('resize', updatePreviewScale); window.__editorResizeBound = true;
  }
}

function setEdImage(item = EDI) {
  if (!item) return;
  // نمایش تصویر اصلی زیر لایهٔ قابل‌ویرایش؛ نمایش خروجیِ ازقبل‌رندرشده متن را دوبار نشان می‌داد.
  const blob = item.blob;
  if (edUrl) URL.revokeObjectURL(edUrl);
  edUrl = URL.createObjectURL(blob);
  $('edImg').onload = updatePreviewScale;
  $('edImg').src = edUrl;
}

function openEditor(it) {
  if (!it || !it.ocr) return;
  EDI = it; edDirty = false;
  $('edTitle').innerText = `ویرایش ترجمه — تصویر ${it.i + 1} (${it.ocr.blocks.length} متن)`;
  buildEditor();
  setEdImage();
  $('editor').classList.remove('hidden');
  requestAnimationFrame(updatePreviewScale);
  document.body.style.overflow = 'hidden';
}

async function closeEditor() {
  if (!EDI) return;
  clearTimeout(edTimer);
  edFieldFocused = false;
  if (edDirty) await applyEditor();
  $('editor').classList.add('hidden');
  document.body.style.overflow = '';
  if (edUrl) { URL.revokeObjectURL(edUrl); edUrl = null; }
  $('edImg').onload = null;
  $('edImg').removeAttribute('src');
  activeRichEditor = null;
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
      // خروجی متنی ساده مارکرهای استایل درون‌متنی را ندارد
      const tr = b.tr && b.tr.trim()
        ? (typeof Typeset !== 'undefined' ? Typeset.stripInlineMarkers(b.tr) : b.tr).trim()
        : '';
      out += `[${b.id}] ${b.text}\n    ← ${tr || '(بدون ترجمه)'}\n\n`;
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
document.addEventListener('selectionchange', () => {
  const selection = window.getSelection();
  if (activeRichEditor && selection && selection.rangeCount && activeRichEditor.contains(selection.anchorNode)) {
    richSelectionRange = selection.getRangeAt(0).cloneRange();
    syncRichToolbarState();
  }
});
// فوکوس در هر دو سطح (ویرایشگر کناری و کادر روی تصویر) حفظ می‌شود؛ رندر فقط پس از خروج از فیلد انجام می‌گیرد.
$('editor').addEventListener('focusin', (e) => {
  if (editorFieldEl(e.target)) edFieldFocused = true;
});
$('editor').addEventListener('focusout', (e) => {
  if (!editorFieldEl(e.target)) return;
  if (editorFieldEl(e.relatedTarget)) return;
  edFieldFocused = false;
  flushEditorOnBlur();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('editor').classList.contains('hidden')) closeEditor();
  else if (!$('trDialog').classList.contains('hidden')) closeTrDialog();
});
window.addEventListener('pagehide', () => { if (TR.worker) { try { TR.worker.terminate(); } catch {} } });
