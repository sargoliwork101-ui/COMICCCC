/* global Typeset, createImageBitmap, FileReader */
'use strict';

const $ = (id) => document.getElementById(id);
const state = { project: null, engines: [], ai: null, dragId: null, editorId: null, editorBitmap: null, editorScale: 1, cropId: null, crop: null, cropPointer: null, modelBusy: null };
let saveTimer = null;
let toastTimer = null;

function toast(message, error = false) {
  const el = $('toast');
  el.textContent = String(message || '');
  el.style.borderColor = error ? 'var(--danger)' : 'var(--line)';
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), error ? 7000 : 3000);
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('json') ? await response.json() : null;
  if (!response.ok) {
    const error = new Error(payload && (payload.detail || payload.message) || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function jsonOptions(method, value) {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) };
}

function showDialog(id) { $(id).showModal(); }
function closeDialog(id) { $(id).close(); }
function sortedImages() { return (state.project?.images || []).sort((a, b) => (a.order || 0) - (b.order || 0)); }
function selectedImages() { return sortedImages().filter((item) => item.selected); }
function imageUrl(item, edited = false) { return `/api/projects/${state.project.id}/images/${item.id}/content${edited ? '?edited=true' : ''}`; }
function escapeHtml(value) { const el = document.createElement('div'); el.textContent = String(value ?? ''); return el.innerHTML; }
function plainToHtml(value) { return escapeHtml(value).replace(/\n/g, '<br>'); }
function safeName(value) { return String(value || 'comic-translated').replace(/[<>:"/\\|?*]/g, '-'); }

function sanitizeHtml(html) {
  const root = document.createElement('div');
  root.innerHTML = html || '';
  const allowed = new Set(['DIV', 'P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'SPAN', 'UL', 'OL', 'LI']);
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.nodeValue);
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName;
    const children = [...node.childNodes].map(walk).join('');
    if (tag === 'BR') return '<br>';
    if (!allowed.has(tag)) return children;
    let style = '';
    if (tag === 'SPAN') {
      const size = parseFloat(node.style.fontSize);
      if (Number.isFinite(size)) style += `font-size:${Math.max(8, Math.min(160, size))}px;`;
      if (/^#[0-9a-f]{6}$/i.test(node.style.color)) style += `color:${node.style.color};`;
      if (node.style.fontWeight) style += `font-weight:${node.style.fontWeight === 'bold' ? 'bold' : 'normal'};`;
      if (node.style.fontStyle) style += `font-style:${node.style.fontStyle === 'italic' ? 'italic' : 'normal'};`;
      if (node.style.textDecorationLine) style += `text-decoration:${node.style.textDecorationLine.includes('underline') ? 'underline' : 'none'};`;
    }
    const tagName = tag.toLowerCase();
    return `<${tagName}${style ? ` style="${style}"` : ''}>${children}</${tagName}>`;
  };
  return [...root.childNodes].map(walk).join('');
}

function setBusy(message) {
  $('jobStatus').textContent = message || '';
  document.querySelectorAll('.main-actions button, .main-actions .file-button').forEach((el) => { el.disabled = !!message; });
}

async function runJob(message, task) {
  setBusy(message);
  try { return await task(); }
  catch (error) { console.error(error); toast(error.message || error, true); throw error; }
  finally { setBusy(''); }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  $('saveState').textContent = 'در حال ذخیره…';
  saveTimer = setTimeout(() => saveProject().catch((error) => toast(error.message, true)), 350);
}

async function saveProject() {
  clearTimeout(saveTimer);
  if (!state.project) return;
  state.project.images.forEach((item, index) => { item.order = index; });
  const result = await api(`/api/projects/${state.project.id}/state`, jsonOptions('PUT', { state: state.project }));
  state.project = result;
  $('saveState').textContent = 'ذخیره شد';
  refreshProjectList();
}

function adoptProject(project) {
  state.project = project;
  state.project.images = (project.images || []).sort((a, b) => (a.order || 0) - (b.order || 0));
  $('projectName').value = project.name || 'پروژهٔ کمیک';
  const settings = project.settings || {};
  $('ocrEngine').value = settings.ocrEngine || 'rapidocr-v6';
  $('ocrLanguage').value = settings.ocrLanguage || 'eng';
  $('ocrContrast').checked = settings.contrast !== false;
  $('ocrPrecise').checked = settings.precise !== false;
  $('ocrErase').checked = settings.eraseOriginal !== false;
  const output = settings.output || {};
  $('exportName').value = output.name || 'comic-translated';
  $('exportSeamless').checked = !!output.seamless;
  $('exportUniform').checked = !!output.uniformSize;
  $('exportTwo').checked = !!output.twoPerPage;
  $('exportFormat').value = output.imageFormat || 'orig';
  $('exportFolder').value = output.folderName || '';
  renderAll();
}

function renderAll() {
  renderGrid();
  updateEngineOptions();
}

function updateSummary() {
  const total = state.project?.images.length || 0;
  const selected = selectedImages().length;
  $('selectionSummary').textContent = total ? `${selected} از ${total} تصویر انتخاب شده است` : 'هنوز فایلی وارد نشده است';
  $('emptyState').classList.toggle('hidden', total > 0);
  $('ocrBtn').disabled = !total;
  $('translateBtn').disabled = !total;
  $('exportBtn').disabled = !total;
}

function makeButton(label, handler, className = '') {
  const button = document.createElement('button');
  button.type = 'button'; button.textContent = label; button.className = className;
  button.addEventListener('click', (event) => { event.stopPropagation(); handler(event); });
  return button;
}

function renderGrid() {
  const grid = $('grid');
  grid.textContent = '';
  sortedImages().forEach((item, index) => {
    const card = document.createElement('article');
    card.className = `image-card${item.selected ? ' selected' : ''}`;
    card.dataset.id = item.id;
    card.draggable = true;
    const image = document.createElement('img');
    image.className = 'card-image'; image.src = imageUrl(item, !!item.edited); image.alt = item.name; image.loading = 'lazy';
    image.addEventListener('click', () => { $('previewImage').src = imageUrl(item, !!item.edited); showDialog('previewDialog'); });
    const top = document.createElement('div'); top.className = 'card-top';
    const select = document.createElement('input'); select.type = 'checkbox'; select.className = 'card-select'; select.checked = !!item.selected;
    select.setAttribute('aria-label', `انتخاب ${item.name}`);
    select.addEventListener('change', () => { item.selected = select.checked; card.classList.toggle('selected', item.selected); updateSummary(); scheduleSave(); });
    top.appendChild(select);
    if (item.groupId) { const badge = document.createElement('span'); badge.className = 'group-badge'; badge.textContent = item.groupId; top.appendChild(badge); }
    const info = document.createElement('div'); info.className = 'card-info';
    const name = document.createElement('div'); name.className = 'card-name'; name.textContent = item.name; name.title = item.name;
    const meta = document.createElement('div'); meta.className = 'card-meta';
    meta.textContent = `${item.width}×${item.height} · ${item.blocks?.length || 0} متن${item.crop ? ' · برش فعال' : ''}${item.edited ? ' · ویرایش‌شده' : ''}`;
    const order = document.createElement('div'); order.className = 'card-order';
    order.append('ترتیب:');
    const orderInput = document.createElement('input'); orderInput.type = 'number'; orderInput.min = '1'; orderInput.value = String(index + 1);
    orderInput.addEventListener('change', () => {
      const target = Math.max(0, Math.min(state.project.images.length - 1, Number(orderInput.value) - 1));
      state.project.images.splice(index, 1); state.project.images.splice(target, 0, item); renderGrid(); scheduleSave();
    });
    order.appendChild(orderInput);
    const buttons = document.createElement('div'); buttons.className = 'card-buttons';
    buttons.append(
      makeButton('ویرایش', () => openEditor(item.id)),
      makeButton('برش', () => openCrop(item.id)),
      makeButton('↑', () => moveImage(index, index - 1)),
      makeButton('↓', () => moveImage(index, index + 1)),
    );
    info.append(name, meta, order, buttons); card.append(image, top, info); grid.appendChild(card);
    card.addEventListener('dragstart', () => { state.dragId = item.id; card.classList.add('dragging'); });
    card.addEventListener('dragend', () => { state.dragId = null; document.querySelectorAll('.image-card').forEach((el) => el.classList.remove('dragging', 'drag-before')); });
    card.addEventListener('dragover', (event) => { event.preventDefault(); if (state.dragId !== item.id) card.classList.add('drag-before'); });
    card.addEventListener('dragleave', () => card.classList.remove('drag-before'));
    card.addEventListener('drop', (event) => {
      event.preventDefault(); card.classList.remove('drag-before');
      const from = state.project.images.findIndex((entry) => entry.id === state.dragId);
      const to = state.project.images.findIndex((entry) => entry.id === item.id);
      if (from < 0 || to < 0 || from === to) return;
      const [moved] = state.project.images.splice(from, 1); state.project.images.splice(to, 0, moved);
      renderGrid(); scheduleSave();
    });
  });
  updateSummary();
}

function moveImage(from, to) {
  if (to < 0 || to >= state.project.images.length) return;
  const [item] = state.project.images.splice(from, 1); state.project.images.splice(to, 0, item);
  renderGrid(); scheduleSave();
}

async function refreshProjectList() {
  const projects = await api('/api/projects');
  const select = $('projectSelect');
  const current = state.project?.id;
  select.textContent = '';
  projects.forEach((project) => {
    const option = document.createElement('option'); option.value = project.id;
    option.textContent = `${project.name} (${project.images})`; option.selected = project.id === current;
    select.appendChild(option);
  });
}

async function loadProject(id) {
  const project = await api(`/api/projects/${id}`);
  adoptProject(project); await refreshProjectList();
}

function collectOutputSettings() {
  if (!state.project) return;
  state.project.settings = state.project.settings || {};
  state.project.settings.output = {
    name: $('exportName').value, seamless: $('exportSeamless').checked,
    uniformSize: $('exportUniform').checked, twoPerPage: $('exportTwo').checked,
    imageFormat: $('exportFormat').value, folderName: $('exportFolder').value,
  };
}

function collectOcrSettings() {
  state.project.settings = state.project.settings || {};
  Object.assign(state.project.settings, {
    ocrEngine: $('ocrEngine').value, ocrLanguage: $('ocrLanguage').value,
    contrast: $('ocrContrast').checked, precise: $('ocrPrecise').checked, eraseOriginal: $('ocrErase').checked,
  });
}

function updateEngineOptions() {
  const select = $('ocrEngine');
  const previous = select.value || state.project?.settings?.ocrEngine || 'rapidocr-v6';
  select.textContent = '';
  state.engines.forEach((engine) => {
    const option = document.createElement('option'); option.value = engine.id;
    option.textContent = `${engine.name}${engine.runtimeInstalled ? '' : ' (نیازمند نصب)'}`;
    select.appendChild(option);
  });
  select.value = state.engines.some((engine) => engine.id === previous) ? previous : 'rapidocr-v6';
  updateOcrEngineStatus();
}

function updateOcrEngineStatus() {
  const engine = state.engines.find((entry) => entry.id === $('ocrEngine').value);
  if (!engine) return;
  $('ocrEngineStatus').textContent = engine.runtimeInstalled
    ? `${engine.description} وضعیت: آمادهٔ اجرا روی همین کامپیوتر.`
    : 'ابزار اجرای این مدل نصب نشده است؛ از پنجرهٔ «مدل‌ها و آزمایش» دکمهٔ آماده‌سازی را بزنید تا نصب شود.';
  [...$('ocrLanguage').options].forEach((option) => { option.disabled = !engine.languages.includes(option.value); });
  if (!engine.languages.includes($('ocrLanguage').value)) $('ocrLanguage').value = engine.languages[0];
}

async function importFiles(files) {
  if (!files.length) return;
  await runJob('در حال خواندن فایل‌ها…', async () => {
    await saveProject();
    const form = new FormData(); [...files].forEach((file) => form.append('files', file));
    const result = await api(`/api/projects/${state.project.id}/files`, { method: 'POST', body: form });
    adoptProject(result); toast(`${files.length} فایل وارد شد`);
  });
}

async function runOcr() {
  collectOcrSettings(); await saveProject();
  const ids = $('ocrOnlySelected').checked ? selectedImages().map((item) => item.id) : sortedImages().map((item) => item.id);
  await runJob('OCR محلی در حال اجراست…', async () => {
    const result = await api(`/api/projects/${state.project.id}/ocr`, jsonOptions('POST', {
      image_ids: ids, engine: $('ocrEngine').value, language: $('ocrLanguage').value,
      contrast: $('ocrContrast').checked, precise: $('ocrPrecise').checked,
      min_confidence: Number($('ocrConfidence').value) || 0.35,
    }));
    adoptProject(result); closeDialog('ocrDialog');
    const count = result.images.reduce((sum, item) => sum + (item.blocks?.length || 0), 0);
    toast(`${count} خط متن تشخیص داده شد`);
  });
}

async function runTranslation() {
  const ids = selectedImages().map((item) => item.id);
  if (!ids.length) { toast('حداقل یک تصویر را انتخاب کنید', true); return; }
  await runJob('در حال ترجمهٔ متن‌ها…', async () => {
    await saveProject();
    const result = await api(`/api/projects/${state.project.id}/translate`, jsonOptions('POST', {
      image_ids: ids, provider: state.ai?.provider || 'free', source_language: $('ocrLanguage').value,
    }));
    adoptProject(result);
    await renderAllTranslated();
    toast('ترجمه و پیش‌نمایش تصاویر آماده شد');
  });
}

async function ensureFont() {
  if (document.fonts?.load) {
    try { await document.fonts.load('700 24px Vazirmatn', 'ابپتثجچ'); } catch { /* fallback font remains usable */ }
  }
}

async function renderAndUpload(item) {
  await ensureFont();
  const response = await fetch(imageUrl(item));
  if (!response.ok) throw new Error('تصویر اصلی باز نشد');
  const bitmap = await createImageBitmap(await response.blob());
  let canvas;
  try { canvas = Typeset.render(bitmap, item.blocks || []); } finally { bitmap.close(); }
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  await api(`/api/projects/${state.project.id}/images/${item.id}/rendered`, {
    method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob,
  });
  canvas.width = canvas.height = 0;
  const current = state.project.images.find((entry) => entry.id === item.id);
  if (current) current.edited = true;
}

async function renderAllTranslated() {
  for (const item of sortedImages()) {
    if ((item.blocks || []).some((block) => block.enabled && block.tr && block.tr.trim())) await renderAndUpload(item);
  }
  renderGrid();
}

function renderModels() {
  const container = $('engineCards'); container.textContent = '';
  const language = $('testLanguage').value;
  state.engines.forEach((engine) => {
    const card = document.createElement('section'); card.className = 'engine-card';
    const title = document.createElement('h3'); title.textContent = engine.name;
    const family = document.createElement('div'); family.className = 'hint'; family.textContent = engine.family;
    const description = document.createElement('p'); description.textContent = engine.description;
    const status = document.createElement('div'); status.className = 'engine-status';
    const supported = engine.languages.includes(language);
    const ready = supported && (engine.readyLanguages || []).includes(language);
    status.textContent = state.modelBusy === engine.id ? 'در حال نصب بسته و دانلود مدل؛ لطفاً صبر کنید…'
      : !supported ? 'این موتور زبان انتخاب‌شده را پشتیبانی نمی‌کند.'
      : !engine.runtimeInstalled ? 'بسته نصب نیست؛ دکمهٔ آماده‌سازی آن را نصب می‌کند.'
      : ready ? 'مدل زبان انتخاب‌شده آماده و آفلاین است.'
      : 'مدل زبان انتخاب‌شده هنوز آماده نیست؛ دکمهٔ آماده‌سازی را بزنید.';
    const buttons = document.createElement('div'); buttons.className = 'card-buttons';
    const prepare = makeButton('آماده‌سازی / دانلود مدل', () => downloadEngine(engine));
    const test = makeButton('آزمایش روی تصویر', () => testEngine(engine.id));
    prepare.disabled = !!state.modelBusy || !supported;
    test.disabled = !!state.modelBusy || !supported;
    buttons.append(prepare, test);
    card.append(title, family, description, status, buttons); container.appendChild(card);
  });
}

async function downloadEngine(engine) {
  if (state.modelBusy) return;
  const language = $('testLanguage').value;
  if (!engine.languages.includes(language)) { toast('این موتور زبان انتخاب‌شده را پشتیبانی نمی‌کند', true); return; }
  state.modelBusy = engine.id;
  $('modelTestResult').textContent = `آماده‌سازی ${engine.name} برای ${language} آغاز شد. اگر بسته نصب نباشد، ابتدا نصب می‌شود؛ سپس فقط مدل همین زبان دانلود می‌شود.`;
  renderModels();
  try {
    const result = await api(`/api/engines/${engine.id}/download`, jsonOptions('POST', { language }));
    state.engines = result.engines;
    $('modelTestResult').textContent = `مدل ${engine.name} برای ${language} آماده است. اکنون می‌توانید آزمایش روی تصویر را اجرا کنید.`;
    updateEngineOptions();
    toast('مدل آماده است');
  } catch (error) {
    $('modelTestResult').textContent = `آماده‌سازی ناموفق بود:\n${error.message}\n\nاتصال اینترنت و دسترسی به میزبان مدل را بررسی کنید و دوباره تلاش کنید.`;
    toast(error.message, true);
  } finally {
    state.modelBusy = null;
    renderModels();
  }
}

async function testEngine(engineId) {
  if (state.modelBusy) return;
  const item = selectedImages()[0] || sortedImages()[0];
  if (!item) { toast('ابتدا یک تصویر وارد کنید', true); return; }
  $('modelTestResult').textContent = 'در حال اجرای آزمایش محلی…';
  try {
    const result = await api(`/api/engines/${engineId}/test`, jsonOptions('POST', {
      project_id: state.project.id, image_id: item.id, language: $('testLanguage').value,
    }));
    $('modelTestResult').textContent = result.blocks.length
      ? result.blocks.map((block) => `${' '.repeat(block.sourceIndent || 0)}${block.text}  (${block.conf}%)`).join('\n')
      : 'متنی تشخیص داده نشد.';
  } catch (error) { $('modelTestResult').textContent = error.message; }
}

async function loadAiSettings() {
  state.ai = await api('/api/ai-settings');
  $('aiProvider').value = state.ai.provider || 'free';
  $('aiBaseUrl').value = state.ai.base_url || 'https://api.avalai.ir/v1';
  $('aiModel').value = state.ai.model || 'gpt-6-luna';
  $('aiKey').placeholder = state.ai.hasApiKey ? 'کلید ذخیره شده؛ برای تغییر، کلید تازه بدهید' : 'کلید API';
  updateAiFields();
}

function updateAiFields() { $('aiFields').classList.toggle('hidden', $('aiProvider').value !== 'openai'); }

async function saveAiSettings() {
  state.ai = await api('/api/ai-settings', jsonOptions('PUT', {
    provider: $('aiProvider').value, base_url: $('aiBaseUrl').value,
    model: $('aiModel').value, api_key: $('aiKey').value || null,
  }));
  $('aiKey').value = ''; await loadAiSettings(); toast('تنظیمات ترجمه ذخیره شد');
}

function updateExportFields() {
  const kind = $('exportKind').value;
  $('pdfExportFields').classList.toggle('hidden', kind !== 'pdf');
  $('imageExportFields').classList.toggle('hidden', kind !== 'images');
}

async function exportResult() {
  if (!selectedImages().length) throw new Error('حداقل یک تصویر را برای خروجی انتخاب کنید');
  collectOutputSettings(); await saveProject();
  const kind = $('exportKind').value;
  if (kind !== 'txt') {
    for (const item of selectedImages()) {
      if (!item.edited && (item.blocks || []).some((block) => block.enabled && block.tr?.trim())) await renderAndUpload(item);
    }
  }
  const response = await fetch(`/api/projects/${state.project.id}/export`, jsonOptions('POST', {
    kind, image_ids: selectedImages().map((item) => item.id), name: safeName($('exportName').value),
    seamless: $('exportSeamless').checked, uniform_size: $('exportUniform').checked,
    two_per_page: $('exportTwo').checked, image_format: $('exportFormat').value,
    folder_name: $('exportFolder').value,
  }));
  if (!response.ok) { const payload = await response.json(); throw new Error(payload.detail || 'خروجی ساخته نشد'); }
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') || '';
  const match = disposition.match(/filename\*?=(?:UTF-8''|\")?([^\";]+)/i);
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob);
  link.download = match ? decodeURIComponent(match[1]) : `${safeName($('exportName').value)}.${kind === 'images' ? 'zip' : kind}`;
  document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 5000);
  closeDialog('exportDialog'); toast('خروجی آماده شد');
}

// ---------- Rich translation editor ----------
async function openEditor(imageId) {
  await ensureFont();
  state.editorId = imageId;
  const item = state.project.images.find((entry) => entry.id === imageId);
  $('editorTitle').textContent = `ویرایش — ${item.name}`;
  showDialog('editorDialog');
  const response = await fetch(imageUrl(item));
  state.editorBitmap?.close?.();
  state.editorBitmap = await createImageBitmap(await response.blob());
  $('editorCanvas').width = state.editorBitmap.width; $('editorCanvas').height = state.editorBitmap.height;
  buildBlockList(); fitEditor(); await drawEditor();
}

function editorItem() { return state.project?.images.find((item) => item.id === state.editorId); }
function boxOf(block) {
  return {
    x0: Number.isFinite(block.tx0) ? block.tx0 : block.x0,
    y0: Number.isFinite(block.ty0) ? block.ty0 : block.y0,
    x1: Number.isFinite(block.tx1) ? block.tx1 : block.x1,
    y1: Number.isFinite(block.ty1) ? block.ty1 : block.y1,
  };
}

function fitEditor() {
  const item = editorItem(); if (!item) return;
  const available = Math.max(250, document.querySelector('.editor-preview').clientWidth - 35);
  state.editorScale = Math.min(1, available / item.width);
  const w = item.width * state.editorScale, h = item.height * state.editorScale;
  $('editorStage').style.width = `${w}px`; $('editorStage').style.height = `${h}px`;
  $('editorCanvas').style.width = `${w}px`; $('editorCanvas').style.height = `${h}px`;
  renderEditorBoxes();
}

async function drawEditor() {
  const item = editorItem(); if (!item || !state.editorBitmap) return;
  const rendered = Typeset.render(state.editorBitmap, item.blocks || []);
  const canvas = $('editorCanvas'), ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(rendered, 0, 0);
  rendered.width = rendered.height = 0; renderEditorBoxes();
}

function renderEditorBoxes() {
  const item = editorItem(), layer = $('editorBoxes'); if (!item) return;
  layer.textContent = '';
  (item.blocks || []).forEach((block) => {
    if (!block.enabled || !block.tr?.trim()) return;
    const box = boxOf(block), scale = state.editorScale;
    const el = document.createElement('div'); el.className = 'editor-box'; el.dataset.id = block.id;
    el.style.left = `${box.x0 * scale}px`; el.style.top = `${box.y0 * scale}px`;
    el.style.width = `${(box.x1 - box.x0) * scale}px`; el.style.height = `${(box.y1 - box.y0) * scale}px`;
    const move = document.createElement('span'); move.className = 'box-move'; move.textContent = `متن ${block.id}`; move.dataset.move = '1'; el.appendChild(move);
    ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach((dir) => {
      const handle = document.createElement('i'); handle.className = `resize-handle ${dir}`; handle.dataset.dir = dir; el.appendChild(handle);
    });
    el.addEventListener('pointerdown', (event) => startBoxDrag(event, block, el));
    layer.appendChild(el);
  });
}

function startBoxDrag(event, block, el) {
  const handle = event.target.closest('[data-dir], [data-move]'); if (!handle) return;
  event.preventDefault(); event.stopPropagation();
  const direction = handle.dataset.dir || 'move', start = boxOf(block);
  const origin = { x: event.clientX, y: event.clientY };
  el.setPointerCapture(event.pointerId);
  const move = (ev) => {
    const dx = (ev.clientX - origin.x) / state.editorScale, dy = (ev.clientY - origin.y) / state.editorScale;
    const item = editorItem(); let { x0, y0, x1, y1 } = start;
    if (direction === 'move') { x0 += dx; x1 += dx; y0 += dy; y1 += dy; }
    else {
      if (direction.includes('w')) x0 += dx; if (direction.includes('e')) x1 += dx;
      if (direction.includes('n')) y0 += dy; if (direction.includes('s')) y1 += dy;
    }
    if (x1 - x0 < 20 || y1 - y0 < 16) return;
    block.tx0 = Math.max(0, Math.min(item.width, x0)); block.tx1 = Math.max(0, Math.min(item.width, x1));
    block.ty0 = Math.max(0, Math.min(item.height, y0)); block.ty1 = Math.max(0, Math.min(item.height, y1));
    const scale = state.editorScale;
    el.style.left = `${block.tx0 * scale}px`; el.style.top = `${block.ty0 * scale}px`;
    el.style.width = `${(block.tx1 - block.tx0) * scale}px`; el.style.height = `${(block.ty1 - block.ty0) * scale}px`;
  };
  const stop = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', stop); el.removeEventListener('pointercancel', stop); drawEditor(); scheduleSave(); };
  el.addEventListener('pointermove', move); el.addEventListener('pointerup', stop); el.addEventListener('pointercancel', stop);
}

function buildBlockList() {
  const item = editorItem(), list = $('blockList'); list.textContent = '';
  if (!item.blocks?.length) { list.textContent = 'ابتدا OCR را روی این تصویر اجرا کنید.'; return; }
  item.blocks.forEach((block) => {
    const card = document.createElement('section'); card.className = `block-card${block.enabled ? '' : ' disabled'}`; card.dataset.id = block.id;
    const head = document.createElement('div'); head.className = 'block-head';
    const enabledLabel = document.createElement('label'); const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = !!block.enabled;
    enabledLabel.append(enabled, document.createTextNode(` متن ${block.id} · اطمینان ${Math.round(block.conf || 0)}٪`)); head.appendChild(enabledLabel);
    const bg = document.createElement('select');
    [['auto', 'پس‌زمینه خودکار'], ['white', 'سفید'], ['black', 'مشکی'], ['none', 'بدون پاک‌کردن']].forEach(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; bg.appendChild(option); });
    bg.value = block.bg || 'auto'; head.appendChild(bg);
    const source = document.createElement('textarea'); source.value = block.text || ''; source.dir = 'auto'; source.setAttribute('aria-label', 'متن OCR');
    const translation = document.createElement('div'); translation.contentEditable = 'true'; translation.dir = block.dir || 'rtl'; translation.innerHTML = block.richHtml || plainToHtml(block.tr || '');
    const tools = document.createElement('div'); tools.className = 'block-tools';
    const commandButton = (label, command) => makeButton(label, () => { translation.focus(); document.execCommand(command); translation.dispatchEvent(new Event('input')); });
    tools.append(commandButton('B', 'bold'), commandButton('I', 'italic'), commandButton('U', 'underline'));
    const align = document.createElement('select'); [['right', 'راست'], ['center', 'وسط'], ['left', 'چپ']].forEach(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; align.appendChild(option); }); align.value = block.align || 'right'; tools.appendChild(align);
    const direction = makeButton('RTL/LTR', () => { block.dir = block.dir === 'ltr' ? 'rtl' : 'ltr'; translation.dir = block.dir; drawEditor(); scheduleSave(); }); tools.appendChild(direction);
    const size = document.createElement('input'); size.type = 'number'; size.min = '8'; size.max = '160'; size.placeholder = 'اندازه'; size.value = block.size || ''; tools.appendChild(size);
    const color = document.createElement('input'); color.type = 'color'; color.value = block.color || '#111111'; tools.appendChild(color);
    const actions = document.createElement('div'); actions.className = 'block-tools';
    actions.append(
      makeButton('کپی متن اصلی', async () => {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(source.value);
        else { source.focus(); source.select(); document.execCommand('copy'); }
        toast('کپی شد');
      }),
      makeButton('ترجمهٔ دوباره', async () => {
        const result = await api('/api/translate-text', jsonOptions('POST', { text: source.value, source_language: $('ocrLanguage').value, provider: state.ai?.provider || 'free' }));
        block.text = source.value; block.tr = result.text; block.richHtml = plainToHtml(result.text); translation.innerHTML = block.richHtml; drawEditor(); scheduleSave();
      }),
      makeButton('پاک‌کردن ترجمه', () => { block.tr = ''; block.richHtml = ''; translation.innerHTML = ''; drawEditor(); scheduleSave(); }),
    );
    enabled.addEventListener('change', () => { block.enabled = enabled.checked; card.classList.toggle('disabled', !block.enabled); drawEditor(); scheduleSave(); });
    bg.addEventListener('change', () => { block.bg = bg.value; drawEditor(); scheduleSave(); });
    source.addEventListener('input', () => { block.text = source.value; scheduleSave(); });
    translation.addEventListener('input', () => { block.tr = translation.innerText; block.richHtml = sanitizeHtml(translation.innerHTML); scheduleEditorDraw(); scheduleSave(); });
    translation.addEventListener('paste', (event) => { event.preventDefault(); document.execCommand('insertText', false, event.clipboardData.getData('text/plain')); });
    align.addEventListener('change', () => { block.align = align.value; drawEditor(); scheduleSave(); });
    size.addEventListener('change', () => { const value = Number(size.value); block.size = value >= 8 ? Math.min(160, value) : null; drawEditor(); scheduleSave(); });
    color.addEventListener('input', () => { block.color = color.value; drawEditor(); scheduleSave(); });
    card.append(head, source, translation, tools, actions); list.appendChild(card);
  });
}

let editorDrawTimer = null;
function scheduleEditorDraw() { clearTimeout(editorDrawTimer); editorDrawTimer = setTimeout(() => drawEditor(), 120); }
async function applyEditor() {
  const item = editorItem(); if (!item) return;
  await saveProject();
  await drawEditor(); await renderAndUpload(item); renderGrid(); scheduleSave();
}
async function closeEditor() { await applyEditor(); closeDialog('editorDialog'); state.editorBitmap?.close?.(); state.editorBitmap = null; state.editorId = null; }

// ---------- Crop editor ----------
function openCrop(imageId) {
  state.cropId = imageId;
  const item = state.project.images.find((entry) => entry.id === imageId);
  state.crop = item.crop ? { ...item.crop } : null;
  $('cropImage').src = imageUrl(item, !!item.edited);
  $('cropImage').onload = () => { normalizeCropInputs(); drawCropRect(); };
  showDialog('cropDialog');
}

function cropItem() { return state.project.images.find((item) => item.id === state.cropId); }
function normalizeCropInputs() {
  const item = cropItem(); if (!item) return;
  const crop = state.crop || { x: 0, y: 0, w: item.width, h: item.height };
  $('cropX').value = Math.round(crop.x); $('cropY').value = Math.round(crop.y);
  $('cropW').value = Math.round(crop.w); $('cropH').value = Math.round(crop.h);
}
function readCropInputs() {
  const item = cropItem();
  const x = Math.max(0, Math.min(item.width - 1, Number($('cropX').value) || 0));
  const y = Math.max(0, Math.min(item.height - 1, Number($('cropY').value) || 0));
  state.crop = {
    x, y,
    w: Math.max(1, Math.min(item.width - x, Number($('cropW').value) || 1)),
    h: Math.max(1, Math.min(item.height - y, Number($('cropH').value) || 1)),
  };
  drawCropRect();
}
function drawCropRect() {
  const item = cropItem(), rect = $('cropRect'); if (!item || !state.crop || !$('cropImage').clientWidth) { rect.style.display = 'none'; return; }
  const sx = $('cropImage').clientWidth / item.width, sy = $('cropImage').clientHeight / item.height;
  rect.style.display = 'block'; rect.style.left = `${state.crop.x * sx}px`; rect.style.top = `${state.crop.y * sy}px`;
  rect.style.width = `${state.crop.w * sx}px`; rect.style.height = `${state.crop.h * sy}px`;
}

function bindEvents() {
  $('newProjectBtn').addEventListener('click', async () => { if (!confirm('پروژهٔ جدید ساخته شود؟ پروژهٔ فعلی ذخیره می‌ماند.')) return; await saveProject(); adoptProject(await api('/api/projects', jsonOptions('POST', { name: 'پروژهٔ کمیک' }))); await refreshProjectList(); });
  $('projectSelect').addEventListener('change', () => loadProject($('projectSelect').value).catch((error) => toast(error.message, true)));
  $('projectName').addEventListener('change', () => { state.project.name = $('projectName').value; scheduleSave(); });
  $('fileInput').addEventListener('change', () => importFiles($('fileInput').files).catch(() => {}).finally(() => { $('fileInput').value = ''; }));
  $('selectAllBtn').addEventListener('click', () => { state.project.images.forEach((item) => { item.selected = true; }); renderGrid(); scheduleSave(); });
  $('selectNoneBtn').addEventListener('click', () => { state.project.images.forEach((item) => { item.selected = false; }); renderGrid(); scheduleSave(); });
  $('invertBtn').addEventListener('click', () => { state.project.images.forEach((item) => { item.selected = !item.selected; }); renderGrid(); scheduleSave(); });
  $('groupBtn').addEventListener('click', () => { const id = `گروه ${new Set(state.project.images.map((item) => item.groupId).filter(Boolean)).size + 1}`; selectedImages().forEach((item) => { item.groupId = id; }); renderGrid(); scheduleSave(); });
  $('ungroupBtn').addEventListener('click', () => { selectedImages().forEach((item) => { item.groupId = null; }); renderGrid(); scheduleSave(); });
  $('duplicateBtn').addEventListener('click', async () => { const ids = selectedImages().map((item) => item.id); if (!ids.length) return; adoptProject(await api(`/api/projects/${state.project.id}/duplicate`, jsonOptions('POST', ids))); });
  $('deleteBtn').addEventListener('click', async () => { const ids = selectedImages().map((item) => item.id); if (!ids.length || !confirm(`${ids.length} تصویر از پروژه حذف شود؟`)) return; adoptProject(await api(`/api/projects/${state.project.id}/delete`, jsonOptions('POST', ids))); });
  $('ocrBtn').addEventListener('click', () => { updateEngineOptions(); showDialog('ocrDialog'); });
  $('ocrEngine').addEventListener('change', updateOcrEngineStatus);
  $('startOcrBtn').addEventListener('click', () => runOcr().catch(() => {}));
  $('translateBtn').addEventListener('click', () => runTranslation().catch(() => {}));
  $('modelsBtn').addEventListener('click', () => { renderModels(); showDialog('modelsDialog'); });
  $('testLanguage').addEventListener('change', renderModels);
  $('aiBtn').addEventListener('click', () => { loadAiSettings().then(() => showDialog('aiDialog')).catch((error) => toast(error.message, true)); });
  $('aiProvider').addEventListener('change', updateAiFields);
  $('saveAiBtn').addEventListener('click', () => saveAiSettings().catch((error) => toast(error.message, true)));
  $('testAiBtn').addEventListener('click', async () => { try { await saveAiSettings(); const result = await api('/api/ai-settings/test', { method: 'POST' }); $('aiStatus').textContent = result.message; } catch (error) { $('aiStatus').textContent = error.message; } });
  $('exportBtn').addEventListener('click', () => { updateExportFields(); showDialog('exportDialog'); });
  $('exportKind').addEventListener('change', updateExportFields);
  $('startExportBtn').addEventListener('click', () => runJob('در حال ساخت خروجی…', exportResult).catch(() => {}));
  $('editorApply').addEventListener('click', () => applyEditor().catch((error) => toast(error.message, true)));
  $('editorClose').addEventListener('click', () => closeEditor().catch((error) => toast(error.message, true)));
  window.addEventListener('resize', () => { if (state.editorId) fitEditor(); if (state.cropId) drawCropRect(); });
  ['cropX', 'cropY', 'cropW', 'cropH'].forEach((id) => $(id).addEventListener('change', readCropInputs));
  $('cropReset').addEventListener('click', () => { cropItem().crop = null; state.crop = null; closeDialog('cropDialog'); renderGrid(); scheduleSave(); });
  $('cropApply').addEventListener('click', () => { readCropInputs(); cropItem().crop = state.crop; closeDialog('cropDialog'); renderGrid(); scheduleSave(); });
  $('cropStage').addEventListener('pointerdown', (event) => {
    const item = cropItem(); if (!item) return;
    const bounds = $('cropImage').getBoundingClientRect();
    state.cropPointer = { x: event.clientX, y: event.clientY, bounds };
    $('cropStage').setPointerCapture(event.pointerId);
  });
  $('cropStage').addEventListener('pointermove', (event) => {
    if (!state.cropPointer) return;
    const item = cropItem(), start = state.cropPointer, bounds = start.bounds;
    const sx = item.width / bounds.width, sy = item.height / bounds.height;
    const x0 = Math.max(bounds.left, Math.min(bounds.right, start.x)), y0 = Math.max(bounds.top, Math.min(bounds.bottom, start.y));
    const x1 = Math.max(bounds.left, Math.min(bounds.right, event.clientX)), y1 = Math.max(bounds.top, Math.min(bounds.bottom, event.clientY));
    state.crop = { x: (Math.min(x0, x1) - bounds.left) * sx, y: (Math.min(y0, y1) - bounds.top) * sy, w: Math.abs(x1 - x0) * sx, h: Math.abs(y1 - y0) * sy };
    normalizeCropInputs(); drawCropRect();
  });
  const stopCrop = () => { state.cropPointer = null; };
  $('cropStage').addEventListener('pointerup', stopCrop); $('cropStage').addEventListener('pointercancel', stopCrop);
}

async function init() {
  bindEvents();
  try {
    const [projects, engines, ai] = await Promise.all([api('/api/projects'), api('/api/engines'), api('/api/ai-settings')]);
    state.engines = engines; state.ai = ai;
    const project = projects.length ? await api(`/api/projects/${projects[0].id}`) : await api('/api/projects', jsonOptions('POST', { name: 'پروژهٔ کمیک' }));
    adoptProject(project); await refreshProjectList(); await loadAiSettings();
  } catch (error) { toast(`راه‌اندازی ناموفق: ${error.message}`, true); }
}

init();
