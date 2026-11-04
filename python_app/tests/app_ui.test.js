const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..', 'comic_studio', 'static');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: 'http://127.0.0.1:8765/', pretendToBeVisual: true, runScripts: 'dangerously' });
const { window } = dom;
const context = dom.getInternalVMContext();
const project = {
  id: 'project-ui', name: 'آزمایش', updatedAt: '', images: [{
    id: 'image-ui', name: 'page.png', file: 'page.png', width: 320, height: 200,
    order: 0, selected: true, groupId: null, crop: null, blocks: [], edited: false,
  }], settings: { output: {} },
};
const summary = { id: project.id, name: project.name, updatedAt: '', images: 1 };
const engine = { id: 'rapidocr-v6', name: 'RapidOCR', selectable: true, runtimeInstalled: true, languages: ['eng'], readyLanguages: ['eng'], description: '', family: '' };
const overlayProject = (text, translation) => ({
  ...project, settings: { output: {} }, images: [{ ...project.images[0], selected: true, edited: false, blocks: [{
    id: 1, text, tr: translation, richHtml: translation ? `<b>${translation}</b>` : '', enabled: true,
    bg: 'white', x0: 5, y0: 5, x1: 150, y1: 45, lineH: 40, dir: 'rtl', align: 'right',
  }] }],
});
const beacons = [];
const scrollIntoViewCalls = [];
let activityClears = 0;
let revertCalls = 0;
let translationGate = null;
let previewFailure = null;
let ocrGate = null;
let imageGate = null;
let aiSaveFailure = false;
let activityFeed = { entries: [], next: 0 };
let renderedBlocks = null;
let canvasRenderCount = 0;
let renderedUploads = 0;
let saveGate = null;
const stateSaveRequests = [];
const ocrRequests = [];
let projectGetCount = 0;
const exportRequests = [];
const aiSaveRequests = [];
const aiTestRequests = [];
const translationPreviewCalls = [];
const translationCalls = [];
const singleTranslationCalls = [];
const aiProviderDefaults = {
  gemini: ['gemini-2.5-flash', 'https://generativelanguage.googleapis.com/v1beta'],
  openai: ['gpt-4o-mini', 'https://api.openai.com/v1'],
  openrouter: ['openai/gpt-4o-mini', 'https://openrouter.ai/api/v1'],
  avalai: ['gpt-6-luna', 'https://api.avalai.ir/v1'],
};
let aiSettings = {
  provider: 'free', base_url: '', model: '', hasApiKey: false,
  providers: Object.fromEntries(Object.entries(aiProviderDefaults).map(([id, [model, baseUrl]]) => [id, {
    model, defaultModel: model, base_url: baseUrl, keyUrl: 'https://example.invalid/key', keyLabel: `کلید ${id}`, profiles: [],
  }])),
};
const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => 'application/json' },
  json: async () => payload,
});
const makeTranslationPreview = (body, single = false) => {
  const provider = body.provider || 'free';
  const liveProject = vm.runInContext('state.project', context);
  const ids = single ? [] : (body.image_ids || liveProject.images.map((image) => image.id));
  const texts = single ? [body.text] : liveProject.images.filter((image) => ids.includes(image.id)).flatMap((image) => image.blocks).filter((block) => block.enabled !== false && String(block.text || '').trim()).map((block) => block.text.trim());
  const collective = texts.join('\n');
  const requests = provider === 'free' && collective.length <= 500 ? [collective] : provider === 'free' ? texts : [`Source language: English\n\n${collective}`];
  return {
    provider, providerLabel: provider === 'free' ? 'Google Translate (fallback: MyMemory)' : 'Selected AI', model: provider === 'free' ? '' : 'Mock model', base_url: provider === 'free' ? '' : 'https://ai.test/v1',
    blockCount: texts.length, requestCount: requests.length,
    requests: requests.map((text, index) => ({ index: index + 1, characters: text.length, text })),
    systemPrompt: provider === 'free' ? '' : 'entire input', signature: 'ui-confirmation-signature',
    note: 'فقط بعد از تأیید شما ارسال می‌شود.', rollingMode: true, contextMode: false, skill:'', summary:'', resume:!!body.resume, singleContext:single,
  };
};
window.fetch = async (url, options = {}) => {
  const parsed = new URL(url, 'http://127.0.0.1:8765');
  const pathname = parsed.pathname;
  if (pathname === '/api/projects' && (!options.method || options.method === 'GET')) return jsonResponse([summary]);
  if (pathname === '/api/projects' && options.method === 'POST') return jsonResponse(project, 201);
  if (pathname === `/api/projects/${project.id}`) { projectGetCount += 1; return jsonResponse(project); }
  if (pathname === '/api/engines') return jsonResponse([engine]);
  if (pathname === '/api/ai-settings/test' && options.method === 'POST') {
    const request = JSON.parse(options.body); aiTestRequests.push(request);
    return jsonResponse({ ok: true, model: request.model, message: `اتصال برقرار است؛ مدل ${request.model} در دسترس است.` });
  }
  if (pathname === '/api/ai-settings' && options.method === 'PUT') {
    const request = JSON.parse(options.body); aiSaveRequests.push(request);
    if (aiSaveFailure) return jsonResponse({detail:'settings simulated failure'},503);
    const providers = {};
    Object.entries(aiProviderDefaults).forEach(([id, [defaultModel, defaultBase]]) => {
      const previous = aiSettings.providers[id] || {};
      const incoming = request.providers?.[id] || {};
      const oldProfiles = previous.profiles || [];
      providers[id] = {
        ...previous, model: incoming.model || previous.model || defaultModel,
        base_url: incoming.base_url || previous.base_url || defaultBase, response_mode: incoming.response_mode || previous.response_mode || 'auto',
        profiles: (incoming.profiles || oldProfiles).map((profile) => ({
          id: profile.id, name: profile.name || '', timeout_seconds: profile.timeout_seconds ?? 90, retry_count: profile.retry_count ?? 0, retry_wait_seconds: profile.retry_wait_seconds ?? 20, source_limit: profile.source_limit ?? 1000,
          hasApiKey: !!profile.api_key || oldProfiles.some((old) => old.id === profile.id && old.hasApiKey),
        })),
      };
    });
    const active = providers[request.provider];
    aiSettings = { provider: request.provider, reuse_repeated: request.reuse_repeated, free_services: request.free_services, providers, model: active?.model || '', base_url: active?.base_url || '', hasApiKey: !!active?.profiles.some((profile) => profile.hasApiKey) };
    return jsonResponse(aiSettings);
  }
  if (pathname === '/api/ai-settings') return jsonResponse(aiSettings);
  if (pathname === '/api/activity') return jsonResponse(activityFeed);
  if (pathname === '/api/activity/clear' && options.method === 'POST') { activityClears += 1; return jsonResponse({ ok: true, next: 0 }); }
  if (pathname === '/api/session/heartbeat') return jsonResponse({ ok: true, active: 1 });
  if (pathname === `/api/projects/${project.id}/state`) {
    const saved = JSON.parse(options.body).state;
    stateSaveRequests.push(saved);
    if (saveGate) await saveGate;
    return jsonResponse(saved);
  }
  const waitAbortable = (gate, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) { const e = new Error('Aborted'); e.name = 'AbortError'; reject(e); return; }
    const onAbort = () => { const e = new Error('Aborted'); e.name = 'AbortError'; reject(e); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    Promise.resolve(gate).then((v) => { signal?.removeEventListener?.('abort', onAbort); resolve(v); }, reject);
  });
  if (pathname === `/api/projects/${project.id}/ocr`) { ocrRequests.push(JSON.parse(options.body)); if (ocrGate) await waitAbortable(ocrGate, options.signal); return jsonResponse(overlayProject('NEW OCR', '')); }
  if (pathname === `/api/projects/${project.id}/context-preview`) {
    const request = JSON.parse(options.body); translationPreviewCalls.push(request);
    if (previewFailure === 'network') throw new TypeError('simulated connection failure');
    if (previewFailure === 'server') return jsonResponse({detail:'simulated preview outage'},503);
    if (previewFailure === 'validation') return jsonResponse({detail:[{loc:['body','response'],msg:'too long',input:'private-response-data'}]},422);
    return jsonResponse(makeTranslationPreview(request));
  }
  if (pathname === `/api/projects/${project.id}/context-start`) {
    translationCalls.push(JSON.parse(options.body));
    return jsonResponse({project: vm.runInContext('state.project', context), runId:'mock-run', completed:0});
  }
  if (pathname === `/api/projects/${project.id}/context-step`) {
    if (translationGate) await waitAbortable(translationGate, options.signal);
    return jsonResponse({project:overlayProject('NEW OCR', 'ترجمهٔ تازه'), done:true, completed:1, affectedImageIds:[project.images[0].id]});
  }
  if (pathname === '/api/translate-text/context-preview') {
    const request = JSON.parse(options.body); translationPreviewCalls.push(request);
    return jsonResponse(makeTranslationPreview(request, true));
  }
  if (pathname === '/api/translate-text/context') {
    singleTranslationCalls.push(JSON.parse(options.body));
    return jsonResponse({text:'ترجمهٔ تکی تازه'});
  }
  if (pathname === `/api/projects/${project.id}/translation-preview`) {
    const request = JSON.parse(options.body); translationPreviewCalls.push(request);
    return jsonResponse(makeTranslationPreview(request));
  }
  if (pathname === `/api/projects/${project.id}/translate`) {
    translationCalls.push(JSON.parse(options.body));
    if (translationGate) await translationGate;
    return jsonResponse(overlayProject('NEW OCR', 'ترجمهٔ تازه'));
  }
  if (pathname === '/api/translate-text/preview') {
    const request = JSON.parse(options.body); translationPreviewCalls.push(request);
    return jsonResponse(makeTranslationPreview(request, true));
  }
  if (pathname === '/api/translate-text') {
    singleTranslationCalls.push(JSON.parse(options.body));
    return jsonResponse({ text: 'ترجمهٔ تکی تازه' });
  }
  if (pathname === `/api/projects/${project.id}/images/${project.images[0].id}/rendered`) { renderedUploads += 1; return jsonResponse({ ok: true }); }
  if (pathname === `/api/projects/${project.id}/images/${project.images[0].id}/revert`) { revertCalls += 1; return jsonResponse({ ok: true }); }
  if (pathname === `/api/projects/${project.id}/export` && options.method === 'POST') {
    const req = JSON.parse(options.body);
    exportRequests.push(req);
    const ext = req.kind === 'images' ? 'zip' : req.kind;
    const fname = req.kind === 'images' ? 'mixed.zip' : `${req.name || 'mixed'}.${ext}`;
    return { ok: true, status: 200, headers: { get: () => `attachment; filename="${fname}"` }, blob: async () => new window.Blob([ext]) };
  }
  if (pathname === `/api/projects/${project.id}/images/${project.images[0].id}/content`) { if (imageGate) await imageGate; return { ok: true, blob: async () => new window.Blob() }; }
  throw new Error(`Unmocked request: ${options.method || 'GET'} ${url}`);
};
window.navigator.sendBeacon = (url, body) => { beacons.push({ url, body }); return true; };
window.confirm = () => true;
window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
window.cancelAnimationFrame = (id) => clearTimeout(id);
window.HTMLElement.prototype.scrollIntoView = function (options) { scrollIntoViewCalls.push({ element: this, options }); };
window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
window.HTMLDialogElement.prototype.close = function () { this.open = false; };
window.document.execCommand = () => true;
window.URL.createObjectURL = () => 'blob:ui-test';
window.URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function () {};
window.createImageBitmap = async () => ({ width: 320, height: 200, close() {} });
window.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, drawImage() {} });
window.HTMLElement.prototype.setPointerCapture = function (pointerId) { this._capturedPointerId = pointerId; };
window.HTMLElement.prototype.hasPointerCapture = function (pointerId) { return this._capturedPointerId === pointerId; };
window.HTMLElement.prototype.releasePointerCapture = function (pointerId) { if (this._capturedPointerId === pointerId) delete this._capturedPointerId; };
const realTypeset = require(path.join(root, 'typeset.js'));
window.Typeset = {
  blockStyle(block) { return { dir: block.dir === 'ltr' ? 'ltr' : 'rtl', align: block.align || 'right', bold: true, italic: false, underline: false, size: 12, color: null }; },
  hasInlineMarks: realTypeset.hasInlineMarks,
  inlineMarksToHtml: realTypeset.inlineMarksToHtml,
  richHtmlWords(html) { return String(html || '').includes('<hr>') ? [{ t: '────────' }] : []; },
  render(bitmap, blocks) {
    canvasRenderCount += 1;
    renderedBlocks = blocks;
    return { width: 320, height: 200, toBlob(callback) { callback(new window.Blob(['png'], { type: 'image/png' })); } };
  },
};

for (const file of ['groups.js', 'rich-sanitize.js', 'rich-editor.js', 'inline-edit-session.js', 'help-guide.js', 'app.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
function check(name, condition) {
  if (condition) console.log(`PASS: ${name}`);
  else { failures += 1; console.error(`FAIL: ${name}`); }
}

(async () => {
  await sleep(60);
  const $ = (id) => window.document.getElementById(id);
  check('one image card is rendered', window.document.querySelectorAll('#grid .item').length === 1);
  check('job, OCR, translation, model and export progress bars exist with accessible progress roles', ['jobProgress', 'ocrProgress', 'translationProgress', 'modelProgress', 'exportProgress'].every((id) => $(id) && $(id).closest('[role="progressbar"]')));
  check('image starts selected', $('grid').querySelector('.item').classList.contains('selected'));

  $('grid').querySelector('img').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('clicking the image deselects the card', !$('grid').querySelector('.item').classList.contains('selected'));
  check('selection summary follows image clicks', $('selectionSummary').textContent.includes('0 از 1'));

  $('grid').querySelector('img').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('clicking the image again selects the card', $('grid').querySelector('.item').classList.contains('selected'));

  $('grid').querySelector('.act button').click();
  check('eye button still opens preview instead of changing selection', $('previewDialog').open && $('grid').querySelector('.item').classList.contains('selected'));
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  check('Escape closes the preview dialog', !$('previewDialog').open);

  $('grid').querySelector('.tick').click();
  check('one checkbox click deselects the image', !$('grid').querySelector('.item').classList.contains('selected'));
  $('grid').querySelector('.tick').click();
  check('one checkbox click selects the image again', $('grid').querySelector('.item').classList.contains('selected'));

  for (let round = 0; round < 6; round += 1) {
    await vm.runInContext('saveProject()', context);
    const before = vm.runInContext('state.project.images[0].selected', context);
    $('grid').querySelector('.tick').click();
    const after = vm.runInContext('state.project.images[0].selected', context);
    check(`checkbox stays one-click after save ${round + 1}`, after === !before && $('grid').querySelector('.tick').checked === after && $('grid').querySelector('.item').classList.contains('selected') === after);
  }
  for (let round = 0; round < 2; round += 1) {
    await vm.runInContext('saveProject()', context);
    const before = vm.runInContext('state.project.images[0].selected', context);
    $('grid').querySelector('img').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    check(`image stays one-click after save ${round + 1}`, vm.runInContext('state.project.images[0].selected', context) === !before);
  }

  let releaseSave;
  saveGate = new Promise((resolve) => { releaseSave = resolve; });
  const beforeConcurrentSaves = stateSaveRequests.length;
  vm.runInContext("state.project.name = 'old save'", context);
  const firstSave = vm.runInContext('saveProject()', context);
  await sleep(0);
  vm.runInContext("state.project.name = 'new save'", context);
  const secondSave = vm.runInContext('saveProject()', context);
  await sleep(0);
  check('newer save waits for an earlier in-flight save', stateSaveRequests.length === beforeConcurrentSaves + 1 && stateSaveRequests.at(-1).name === 'old save');
  saveGate = null; releaseSave();
  await Promise.all([firstSave, secondSave]);
  check('save queue sends the newer snapshot last', stateSaveRequests.at(-1).name === 'new save');

  saveGate = new Promise((resolve) => { releaseSave = resolve; });
  vm.runInContext("state.project.name = 'pending edit'; scheduleSave()", context);
  const getsBeforeSwitch = projectGetCount;
  const switchProject = vm.runInContext("loadProject('project-ui')", context);
  await sleep(0);
  check('opening a project waits for pending edits to be saved', projectGetCount === getsBeforeSwitch && stateSaveRequests.at(-1).name === 'pending edit');
  vm.runInContext("state.project.name = 'edit during switch'; scheduleSave()", context);
  saveGate = null; releaseSave();
  await switchProject;
  check('edits made while switching are also saved before the project changes', stateSaveRequests.at(-1).name === 'edit during switch');
  check('project loads only after pending saves finish', projectGetCount >= getsBeforeSwitch + 1);

  $('modelsBtn').click();
  check('models dialog opens', $('modelsDialog').open);
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  check('Escape closes the models dialog', !$('modelsDialog').open);
  for (const id of ['ocrDialog', 'translationDialog', 'aiDialog', 'exportDialog', 'cropDialog']) {
    vm.runInContext(`showDialog('${id}')`, context);
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    check(`Escape closes ${id}`, !$(id).open);
  }
  vm.runInContext("showDialog('editorDialog')", context);
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(0);
  check('Escape closes the editor dialog', !$('editorDialog').open);

  $('aiBtn').click(); await sleep(20);
  check('AI dialog offers free, Gemini, OpenAI, OpenRouter, and AvalAI', $('aiDialog').open && ['free', 'gemini', 'openai', 'openrouter', 'avalai'].every((id) => $('aiProvider').querySelector(`option[value="${id}"]`)));
  $('aiProvider').value = 'openrouter'; $('aiProvider').dispatchEvent(new window.Event('change', { bubbles: true }));
  check('provider selection loads its own endpoint and exact default model', $('aiBaseUrl').value === 'https://openrouter.ai/api/v1' && $('aiModel').value === 'openai/gpt-4o-mini' && !$('aiFields').classList.contains('hidden'));
  $('aiResponseMode').value = 'json';
  check('an AI provider starts with one editable API row', $('aiProfiles').querySelectorAll('.ai-profile-row').length === 1);
  let rows = $('aiProfiles').querySelectorAll('.ai-profile-row');
  rows[0].querySelector('.ai-profile-name').value = 'کلید اول OpenRouter';
  rows[0].querySelector('.ai-profile-name').dispatchEvent(new window.Event('input', { bubbles: true }));
  rows[0].querySelector('.ai-profile-key').value = 'openrouter-first-secret';
  rows[0].querySelector('.ai-profile-key').dispatchEvent(new window.Event('input', { bubbles: true }));
  $('aiAddProfile').click();
  rows = $('aiProfiles').querySelectorAll('.ai-profile-row');
  rows[1].querySelector('.ai-profile-name').value = 'کلید دوم OpenRouter';
  rows[1].querySelector('.ai-profile-name').dispatchEvent(new window.Event('input', { bubbles: true }));
  rows[1].querySelector('.ai-profile-key').value = 'openrouter-second-secret';
  rows[1].querySelector('.ai-profile-key').dispatchEvent(new window.Event('input', { bubbles: true }));
  check('each API starts with 90 second timeout and no retry', rows[0].querySelector('.ai-profile-timeout_seconds').value === '90' && rows[0].querySelector('.ai-profile-retry_count').value === '0' && rows[0].querySelector('.ai-profile-retry_wait_seconds').value === '20' && rows[0].querySelector('.ai-profile-source_limit').value === '1000');
  rows[0].querySelector('.ai-profile-timeout_seconds').value = '120'; rows[0].querySelector('.ai-profile-timeout_seconds').dispatchEvent(new window.Event('input', { bubbles: true }));
  rows[0].querySelector('.ai-profile-retry_count').value = '2'; rows[0].querySelector('.ai-profile-retry_count').dispatchEvent(new window.Event('input', { bubbles: true }));
  rows[0].querySelector('.ai-profile-retry_wait_seconds').value = '11'; rows[0].querySelector('.ai-profile-retry_wait_seconds').dispatchEvent(new window.Event('input', { bubbles: true }));
  rows[1].querySelector('.ai-profile-retry_wait_seconds').value = '27'; rows[1].querySelector('.ai-profile-retry_wait_seconds').dispatchEvent(new window.Event('input', { bubbles: true }));
  rows[0].querySelector('.ai-profile-source_limit').value = '750'; rows[0].querySelector('.ai-profile-source_limit').dispatchEvent(new window.Event('input', { bubbles: true }));
  rows[1].querySelector('.ai-profile-source_limit').value = '2500'; rows[1].querySelector('.ai-profile-source_limit').dispatchEvent(new window.Event('input', { bubbles: true }));
  rows[1].querySelector('.ai-profile-timeout_seconds').value = '45'; rows[1].querySelector('.ai-profile-timeout_seconds').dispatchEvent(new window.Event('input', { bubbles: true }));
  rows[1].querySelector('.ai-profile-retry_count').value = '1'; rows[1].querySelector('.ai-profile-retry_count').dispatchEvent(new window.Event('input', { bubbles: true }));
  $('aiModel').value = 'anthropic/claude-ui-test';
  rows[0].querySelector('.ai-profile-test').click(); await sleep(30);
  const savedAi = aiSaveRequests.at(-1);
  check('per-provider response mode is saved', savedAi.providers.openrouter.response_mode === 'json');
  check('row test first saves both named keys with the selected provider and model', savedAi.provider === 'openrouter' && savedAi.model === 'anthropic/claude-ui-test' && savedAi.providers.openrouter.profiles.length === 2 && savedAi.providers.openrouter.profiles[0].api_key === 'openrouter-first-secret' && savedAi.providers.openrouter.profiles[1].api_key === 'openrouter-second-secret');
  check('per-key timeout and retries are saved independently', savedAi.providers.openrouter.profiles[0].timeout_seconds === 120 && savedAi.providers.openrouter.profiles[0].retry_count === 2 && savedAi.providers.openrouter.profiles[1].timeout_seconds === 45 && savedAi.providers.openrouter.profiles[1].retry_count === 1 && savedAi.providers.openrouter.profiles[0].retry_wait_seconds === 11 && savedAi.providers.openrouter.profiles[1].retry_wait_seconds === 27 && savedAi.providers.openrouter.profiles[0].source_limit === 750 && savedAi.providers.openrouter.profiles[1].source_limit === 2500);
  check('row test uses the stored selected profile without resending its secret', aiTestRequests.length === 1 && aiTestRequests[0].profile_id === savedAi.providers.openrouter.profiles[0].id && aiTestRequests[0].model === 'anthropic/claude-ui-test' && !('api_key' in aiTestRequests[0]));
  check('successful row test is visible and keeps settings open', $('aiDialog').open && $('aiStatus').textContent.includes('اتصال برقرار است') && $('aiProfiles').querySelector('.ai-profile-status').textContent.includes('✓'));
  check('saved secrets are cleared from password fields and absent from the DOM', [...$('aiProfiles').querySelectorAll('.ai-profile-key')].every((input) => input.value === '' && input.placeholder.includes('ذخیره شده')) && !$('aiDialog').innerHTML.includes('openrouter-first-secret'));
  $('aiProvider').value = 'gemini'; $('aiProvider').dispatchEvent(new window.Event('change', { bubbles: true }));
  check('switching providers does not reuse OpenRouter model or keys', $('aiModel').value === 'gemini-2.5-flash' && $('aiProfiles').querySelectorAll('.ai-profile-row').length === 1 && $('aiProfiles').querySelector('.ai-profile-key').value === '' && !$('aiProfiles').querySelector('.ai-profile-key').placeholder.includes('ذخیره شده') && $('aiBaseUrlField').classList.contains('hidden'));
  $('aiProvider').value = 'openrouter'; $('aiProvider').dispatchEvent(new window.Event('change', { bubbles: true }));
  check('switching back restores the saved response mode', $('aiResponseMode').value === 'json');
  check('switching back restores each saved API policy', $('aiProfiles').querySelector('.ai-profile-timeout_seconds').value === '120' && $('aiProfiles').querySelector('.ai-profile-retry_count').value === '2');
  check('switching back restores only OpenRouter settings and named profiles', $('aiModel').value === 'anthropic/claude-ui-test' && $('aiProfiles').querySelectorAll('.ai-profile-row').length === 2 && $('aiProfiles').querySelector('.ai-profile-name').value === 'کلید اول OpenRouter');
  check('repeated text reuse is enabled by default', $('aiReuseRepeated').checked);
  $('aiReuseRepeated').checked = false; $('saveAiBtn').click(); await sleep(20);
  check('repeated text reuse can be disabled and saved', aiSaveRequests.at(-1).reuse_repeated === false && !$('aiReuseRepeated').checked);
  check('successful settings save closes the dialog', !$('aiDialog').open);
  $('aiBtn').click(); await sleep(20); aiSaveFailure = true; $('saveAiBtn').click(); await sleep(20);
  check('settings server failure keeps the dialog open and offers a copyable HTTP error', $('aiDialog').open && $('aiStatus').textContent.includes('HTTP 503') && !$('copyAiError').classList.contains('hidden') && !$('saveAiBtn').disabled);
  aiSaveFailure = false;
  const beforeInvalidSave = aiSaveRequests.length;
  const timeoutInput = $('aiProfiles').querySelector('.ai-profile-timeout_seconds'); timeoutInput.value = '4'; timeoutInput.dispatchEvent(new window.Event('input', {bubbles:true}));
  $('saveAiBtn').click(); await sleep(10);
  check('invalid timeout is rejected before saving', aiSaveRequests.length === beforeInvalidSave && $('aiStatus').textContent.includes('زمان انتظار'));
  timeoutInput.value = '120'; timeoutInput.dispatchEvent(new window.Event('input', {bubbles:true}));
  const limitInput = $('aiProfiles').querySelector('.ai-profile-source_limit'); limitInput.value = '0'; limitInput.dispatchEvent(new window.Event('input', {bubbles:true}));
  $('saveAiBtn').click(); await sleep(10);
  check('invalid OCR character limit is rejected before saving', aiSaveRequests.length === beforeInvalidSave && $('aiStatus').textContent.includes('سقف نویسه'));
  limitInput.value = '750'; limitInput.dispatchEvent(new window.Event('input', {bubbles:true}));
  $('aiProfiles').querySelectorAll('.ai-profile-remove')[1].click();
  check('removing a profile updates the actual rows', $('aiProfiles').querySelectorAll('.ai-profile-row').length === 1);
  $('saveAiBtn').click(); await sleep(20);
  check('saving after removal persists only the remaining profile', aiSaveRequests.at(-1).providers.openrouter.profiles.length === 1);
  $('aiProvider').value = 'free'; $('aiProvider').dispatchEvent(new window.Event('change', { bubbles: true }));
  check('free mode hides all AI request controls', $('aiFields').classList.contains('hidden'));
  $('saveAiBtn').click(); await sleep(20);
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  const unselectedRules = css.match(/\.item:not\(\.selected\) \.tw\{[^}]*\}/g) || [];
  check('unselected thumbnails are visibly gray without a bright override', unselectedRules.some((rule) => rule.includes('grayscale(')) && unselectedRules.every((rule) => !rule.includes('filter:none')));
  check('model cards are in one vertical column', /\.model-group-grid\{[^}]*grid-template-columns:minmax\(0,1fr\)/.test(css));
  check('dialog headers remain sticky', /\.dlg>\.dialog-head\{[^}]*position:sticky/.test(css));
  check('success activity keeps readable message text', /\.activity-line\.success\{color:var\(--text\)\}/.test(css));
  check('multiline OCR activity preserves line breaks', /\.activity-message\{[^}]*white-space:pre-wrap/.test(css));
  check('existing projects default to translation overlays', $('overlayMode').value === 'translation' && $('exportOverlayMode').value === 'translation');

  vm.runInContext(`state.project.images[0].blocks = [{ id: 1, text: 'HELLO WORLD', tr: 'سلام دنیا', richHtml: '<b>سلام دنیا</b>', enabled: true, bg: 'white', x0: 5, y0: 5, x1: 150, y1: 45, lineH: 40, dir: 'rtl', align: 'right' }, { id: 2, text: 'SECOND OCR', tr: 'متن دوم', richHtml: '', enabled: true, bg: 'white', x0: 180, y0: 80, x1: 300, y1: 120, lineH: 40, dir: 'ltr', align: 'left' }]`, context);
  vm.runInContext("setOverlayMode('ocr', false)", context);
  check('OCR mode is synchronized between editor and export', $('overlayMode').value === 'ocr' && $('exportOverlayMode').value === 'ocr');
  await vm.runInContext('renderAndUpload(state.project.images[0])', context);
  check('OCR preview renders the recognized source text', renderedBlocks[0].tr === 'HELLO WORLD' && renderedBlocks[0]._plainText === true && renderedBlocks[0].richHtml === '');
  check('OCR mode respects explicit justified alignment', vm.runInContext("overlayBlock({ text: 'one two', align: 'justify' }, 'ocr').align === 'justify'", context));
  check('OCR preview does not overwrite the saved translation', vm.runInContext("state.project.images[0].blocks[0].tr === 'سلام دنیا'", context));
  vm.runInContext("setOverlayMode('translation', false)", context);
  await vm.runInContext('renderAndUpload(state.project.images[0])', context);
  check('translation mode restores translated preview text and formatting', renderedBlocks[0].tr === 'سلام دنیا' && renderedBlocks[0].richHtml === '<b>سلام دنیا</b>' && !renderedBlocks[0]._plainText);
  check('both overlay modes upload a rendered image', renderedUploads === 2);
  vm.runInContext("setOverlayMode('none', false)", context);
  const revertsBeforeNone = revertCalls;
  await vm.runInContext('renderAndUpload(state.project.images[0])', context);
  check('none mode is synchronized and restores the original image', $('overlayMode').value === 'none' && $('exportOverlayMode').value === 'none' && revertCalls === revertsBeforeNone + 1 && vm.runInContext('state.project.images[0].edited', context) === false);
  check('none mode preserves saved OCR and translation text', vm.runInContext("state.project.images[0].blocks[0].text === 'HELLO WORLD' && state.project.images[0].blocks[0].tr === 'سلام دنیا'", context));
  vm.runInContext("state.editorId = 'image-ui'; state.editorScale = 1; buildBlockList(); renderEditorBoxes()", context);
  const sanitizedStyle = vm.runInContext(`sanitizeHtml('<span style="font-weight:700;color:rgb(12, 34, 56);text-decoration:underline line-through">text</span>')`, context);
  check('saved rich formatting preserves numeric bold, RGB color and decorations safely', sanitizedStyle.includes('font-weight:bold') && sanitizedStyle.includes('color:#0c2238') && sanitizedStyle.includes('underline') && sanitizedStyle.includes('line-through'));
  check('none mode hides image text boxes but keeps sidebar editors', $('editorBoxes').children.length === 0 && $('blockList').querySelectorAll('.block-card').length === 2);
  vm.runInContext("setOverlayMode('ocr', false); buildBlockList(); renderEditorBoxes()", context);
  const ocrOverlay = $('editorBoxes').querySelector('.editor-box-text');
  check('editor shows recognized OCR text directly on the image', ocrOverlay?.textContent === 'HELLO WORLD' && ocrOverlay?.dir === 'ltr');
  scrollIntoViewCalls.length = 0;
  const secondOcrOverlay = $('editorBoxes').querySelectorAll('.editor-box-text')[1];
  secondOcrOverlay.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  const ocrCard = $('blockList').querySelector('.block-card[data-id="2"]');
  check('clicking OCR overlay selects its sidebar editor without moving the page', ocrCard.classList.contains('active') && secondOcrOverlay.parentElement.classList.contains('active') && !ocrOverlay.parentElement.classList.contains('active') && scrollIntoViewCalls.length === 0);
  check('OCR overlay is a click target, not a second editor', ocrOverlay.contentEditable === 'false' && !$('blockList').querySelector('textarea,[contenteditable="true"]'));
  vm.runInContext('openInlineEditor(state.project.images[0].blocks[0])', context);
  $('inlineVerticalAlign').value = 'top'; $('inlineVerticalAlign').dispatchEvent(new window.Event('change', { bubbles: true }));
  check('vertical placement is auto-applied without a separate registration action', vm.runInContext("state.project.images[0].blocks[0].verticalAlign === 'top'", context));
  vm.runInContext("state.project.images[0].blocks[0].verticalAlign = 'bottom'", context);
  check('a concurrent vertical placement edit is not overwritten', vm.runInContext('applyInlineEditor()', context) === false && $('inlineEditorField').isConnected);
  $('inlineVerticalAlign').value = 'bottom';
  vm.runInContext("inlineDraft.snapshot = inlineBlockSnapshot(inlineDraft.block); inlineDraft.verticalAlign = 'bottom'", context);
  const editorField = $('inlineEditorField'); editorField.textContent = 'CORRECTED OCR'; editorField.dispatchEvent(new window.Event('input', { bubbles: true }));
  check('the same on-image editor auto-applies OCR without changing translation', vm.runInContext("state.project.images[0].blocks[0].text === 'CORRECTED OCR' && state.project.images[0].blocks[0].tr === 'سلام دنیا'", context));
  vm.runInContext('closeInlineEditor(); clearTimeout(saveTimer); saveTimer = null', context);
  check('OCR display is synchronized with the read-only source card', $('blockList').querySelector('.block-readonly').textContent.includes('CORRECTED OCR'));
  vm.runInContext("setOverlayMode('translation', false); renderEditorBoxes()", context);
  check('editor selector restores the translated overlay', $('editorBoxes').querySelector('.editor-box-text')?.textContent === 'سلام دنیا');
  vm.runInContext('selectEditorBlock(1, false)', context);
  scrollIntoViewCalls.length = 0;
  $('editorBoxes').querySelectorAll('.editor-box-text')[1].dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  check('clicking translated overlay selects the same sidebar card without moving the page', $('blockList').querySelector('.block-card[data-id="2"]').classList.contains('active') && $('blockList').querySelectorAll('.block-card.active').length === 1 && scrollIntoViewCalls.length === 0);
  const scrollCount = scrollIntoViewCalls.length;
  $('editorBoxes').querySelectorAll('.editor-box-text')[1].dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  check('clicking the active editor again does not repeatedly scroll the sidebar', scrollIntoViewCalls.length === scrollCount);
  const editorBox = $('editorBoxes').querySelector('.editor-box');
  const moveHandle = editorBox.querySelector('[data-move]');
  check('editor box has a visible button for dragging', moveHandle?.tagName === 'BUTTON' && moveHandle.title.includes('جابه‌جایی'));
  const pointer = (type, x, y, ctrlKey = false) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y }, pointerId: { value: 1 }, button: { value: 0 }, ctrlKey: { value: ctrlKey } });
    return event;
  };
  const geometry = () => vm.runInContext(`(() => { const b = state.project.images[0].blocks[0]; return { x0: b.tx0, y0: b.ty0, width: b.tx1 - b.tx0, height: b.ty1 - b.ty0 }; })()`, context);
  moveHandle.dispatchEvent(pointer('pointerdown', 100, 100));
  editorBox.dispatchEvent(pointer('pointermove', 120, 130));
  editorBox.dispatchEvent(pointer('pointerup', 120, 130));
  const afterHandle = geometry();
  check('dragging the visible handle moves without resizing', afterHandle.x0 === 25 && afterHandle.y0 === 35 && afterHandle.width === 145 && afterHandle.height === 40);
  editorBox.dispatchEvent(pointer('pointerdown', 25, 35));
  editorBox.dispatchEvent(pointer('pointermove', 35, 30));
  editorBox.dispatchEvent(pointer('pointerup', 35, 30));
  const afterBorder = geometry();
  check('dragging the box border also moves the whole box', afterBorder.x0 === 35 && afterBorder.y0 === 30 && afterBorder.width === 145 && afterBorder.height === 40);
  moveHandle.dispatchEvent(pointer('pointerdown', 100, 100));
  editorBox.dispatchEvent(pointer('pointermove', -900, -900));
  editorBox.dispatchEvent(pointer('pointerup', -900, -900));
  const atBounds = geometry();
  check('dragging beyond page bounds preserves box dimensions', atBounds.x0 === 0 && atBounds.y0 === 0 && atBounds.width === 145 && atBounds.height === 40);
  const beforeTextPointer = geometry();
  const translatedText = editorBox.querySelector('.editor-box-text');
  translatedText.dispatchEvent(pointer('pointerdown', 10, 10));
  editorBox.dispatchEvent(pointer('pointermove', 40, 40));
  editorBox.dispatchEvent(pointer('pointerup', 40, 40));
  const afterTextPointer = geometry();
  check('text editing pointer input does not accidentally move the box', JSON.stringify(afterTextPointer) === JSON.stringify(beforeTextPointer));
  const resizeHandle = editorBox.querySelector('[data-dir="se"]');
  resizeHandle.dispatchEvent(pointer('pointerdown', 145, 40));
  editorBox.dispatchEvent(pointer('pointermove', 165, 55));
  editorBox.dispatchEvent(pointer('pointerup', 165, 55));
  const afterResize = geometry();
  check('resize handles still work after adding box dragging', afterResize.x0 === 0 && afterResize.y0 === 0 && afterResize.width === 165 && afterResize.height === 55);
  const allGeometry = () => vm.runInContext(`state.project.images[0].blocks.map((block) => { const box = boxOf(block); return { id: block.id, x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1, width: box.x1 - box.x0, height: box.y1 - box.y0, sourceX0: block.x0 }; })`, context);
  $('editorSelectAll').click();
  check('select-all selects every text box and sidebar card', $('editorBoxes').querySelectorAll('.editor-box.selected').length === 2 && $('blockList').querySelectorAll('.block-card.selected').length === 2 && $('editorSelectionStatus').textContent.includes('۲'));
  let alignedBefore = allGeometry();
  const left = Math.min(...alignedBefore.map((box) => box.x0));
  $('editorAlignLeft').click();
  let aligned = allGeometry();
  check('multi-align left preserves sizes and OCR erasure coordinates', aligned.every((box) => box.x0 === left) && aligned.every((box, index) => box.width === alignedBefore[index].width && box.sourceX0 === alignedBefore[index].sourceX0));
  alignedBefore = allGeometry(); const right = Math.max(...alignedBefore.map((box) => box.x1));
  $('editorAlignRight').click(); aligned = allGeometry();
  check('multi-align right aligns every right edge', aligned.every((box) => box.x1 === right));
  alignedBefore = allGeometry(); const center = (Math.min(...alignedBefore.map((box) => box.x0)) + Math.max(...alignedBefore.map((box) => box.x1))) / 2;
  $('editorAlignCenter').click(); aligned = allGeometry();
  check('multi-align horizontal center aligns every center', aligned.every((box) => (box.x0 + box.x1) / 2 === center));
  alignedBefore = allGeometry(); const top = Math.min(...alignedBefore.map((box) => box.y0));
  $('editorAlignTop').click(); aligned = allGeometry();
  check('multi-align top aligns every top edge', aligned.every((box) => box.y0 === top));
  alignedBefore = allGeometry(); const middle = (Math.min(...alignedBefore.map((box) => box.y0)) + Math.max(...alignedBefore.map((box) => box.y1))) / 2;
  $('editorAlignMiddle').click(); aligned = allGeometry();
  check('multi-align vertical middle aligns every middle', aligned.every((box) => (box.y0 + box.y1) / 2 === middle));
  alignedBefore = allGeometry(); const bottom = Math.max(...alignedBefore.map((box) => box.y1));
  $('editorAlignBottom').click(); aligned = allGeometry();
  check('multi-align bottom aligns every bottom edge', aligned.every((box) => box.y1 === bottom));
  alignedBefore = allGeometry();
  const groupMoveHandle = $('editorBoxes').querySelector('.editor-box[data-id="1"] [data-move]');
  groupMoveHandle.dispatchEvent(pointer('pointerdown', 100, 100));
  let groupBox = $('editorBoxes').querySelector('.editor-box[data-id="1"]');
  groupBox.dispatchEvent(pointer('pointermove', 130, 125));
  groupBox.dispatchEvent(pointer('pointerup', 130, 125));
  aligned = allGeometry();
  check('dragging one selected handle moves all selected boxes by the same delta', aligned.every((box, index) => box.x0 === alignedBefore[index].x0 + 30 && box.y0 === alignedBefore[index].y0 + 25));
  const secondMultiText = $('editorBoxes').querySelector('.editor-box[data-id="2"] .editor-box-text');
  secondMultiText.dispatchEvent(pointer('pointerdown', 10, 10, true));
  check('ctrl-click toggles one text out of the multi-selection', $('editorBoxes').querySelectorAll('.editor-box.selected').length === 1);
  $('editorSelectNone').click();
  $('editorBoxes').querySelector('.editor-box[data-id="2"] .editor-box-text').dispatchEvent(pointer('pointerdown', 10, 10));
  $('editorBoxes').querySelector('.editor-box[data-id="1"] .editor-box-text').dispatchEvent(pointer('pointerdown', 10, 10, true));
  check('first-clicked box remains the same-size reference regardless of block order', vm.runInContext("state.selectedBlockIds.join(',')", context) === '2,1' && $('editorSelectionStatus').textContent.includes('مرجع'));
  alignedBefore = allGeometry();
  const sizeReference = alignedBefore.find((box) => box.id === 2); const sizeTargetBefore = alignedBefore.find((box) => box.id === 1);
  $('editorSameSize').click(); aligned = allGeometry();
  const sizeTarget = aligned.find((box) => box.id === 1); const unchangedReference = aligned.find((box) => box.id === 2);
  check('same-size copies reference dimensions and preserves target center and OCR coordinates', sizeTarget.width === sizeReference.width && sizeTarget.height === sizeReference.height && unchangedReference.x0 === sizeReference.x0 && unchangedReference.y0 === sizeReference.y0 && (sizeTarget.x0 + sizeTarget.x1) / 2 === (sizeTargetBefore.x0 + sizeTargetBefore.x1) / 2 && (sizeTarget.y0 + sizeTarget.y1) / 2 === (sizeTargetBefore.y0 + sizeTargetBefore.y1) / 2 && sizeTarget.sourceX0 === sizeTargetBefore.sourceX0);
  vm.runInContext("Object.assign(state.project.images[0].blocks[0], { tx0: 0, ty0: 0, tx1: 10, ty1: 10 })", context);
  $('editorSameSize').click(); aligned = allGeometry();
  const clampedTarget = aligned.find((box) => box.id === 1); const clampReference = aligned.find((box) => box.id === 2);
  check('same-size clamps an edge target inside the image without moving the reference', clampedTarget.x0 === 0 && clampedTarget.y0 === 0 && clampedTarget.x1 <= 320 && clampedTarget.y1 <= 200 && clampedTarget.width === clampReference.width && clampedTarget.height === clampReference.height && clampReference.x0 === sizeReference.x0 && clampReference.y0 === sizeReference.y0);
  const editorPreview = window.document.querySelector('.editor-preview');
  Object.defineProperties(editorPreview, { clientWidth: { value: 400, configurable: true }, clientHeight: { value: 300, configurable: true } });
  const beforeZoom = JSON.stringify(geometry());
  check('zoom controls live cleanly inside the docked inline editor toolbar', window.document.querySelector('#inlineEditor .editor-zoom-controls')?.contains($('editorZoomIn')) && window.document.querySelector('#inlineEditor .editor-zoom-controls')?.contains($('editorImageFullscreen')) && !$('editorZoomIn').disabled);
  $('editorZoomIn').click();
  check('zoom control scales image and overlays without changing saved geometry', vm.runInContext('state.editorScale', context) === 1.25 && $('editorStage').style.width === '400px' && $('editorZoomLabel').textContent === '125٪' && JSON.stringify(geometry()) === beforeZoom);
  const beforeWheelZoom = vm.runInContext('state.editorScale', context);
  const wheelPlain = new window.WheelEvent('wheel', { deltaY: -100, ctrlKey: false, bubbles: true, cancelable: true, clientX: 50, clientY: 50 });
  editorPreview.dispatchEvent(wheelPlain);
  check('mouse wheel alone scrolls naturally without zooming', vm.runInContext('state.editorScale', context) === beforeWheelZoom && !wheelPlain.defaultPrevented);
  const wheelCtrl = new window.WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true, clientX: 50, clientY: 50 });
  editorPreview.dispatchEvent(wheelCtrl);
  check('Ctrl + mouse wheel zooms the editing image', vm.runInContext('state.editorScale', context) > beforeWheelZoom && wheelCtrl.defaultPrevented);
  $('editorSelectAll').click();
  $('inlineValignTop').click();
  check('Excel-style vertical placement buttons apply top/middle/bottom to selected boxes', vm.runInContext("state.project.images[0].blocks.every((b) => b.verticalAlign === 'top')", context) && $('inlineValignTop').getAttribute('aria-pressed') === 'true');
  $('inlineValignMiddle').click();
  check('Excel-style middle button restores middle placement', vm.runInContext("state.project.images[0].blocks.every((b) => b.verticalAlign === 'middle')", context) && $('inlineValignMiddle').getAttribute('aria-pressed') === 'true');
  $('editorSelectNone').click();
  editorPreview.scrollLeft = 10; editorPreview.scrollTop = 20;
  $('editorStage').dispatchEvent(pointer('pointerdown', 100, 100));
  $('editorStage').dispatchEvent(pointer('pointermove', 70, 60));
  $('editorStage').dispatchEvent(pointer('pointerup', 70, 60));
  check('dragging empty canvas pans the zoomed image', editorPreview.scrollLeft === 40 && editorPreview.scrollTop === 60 && vm.runInContext('state.editorPan', context) === null);

  check('each line has its own on-image and sidebar language controls', $('editorBoxes').querySelectorAll('.box-language').length === 2 && $('blockList').querySelectorAll('[data-text-mode]').length === 2);
  const languageSelectors = $('blockList').querySelectorAll('[data-text-mode]');
  vm.runInContext('state.editorBitmap = {width: 320, height: 200, close() {}}', context);
  await sleep(20);
  const backgroundSelector = $('blockList').querySelector('.block-card .block-head select');
  const rendersBeforeBackground = canvasRenderCount;
  backgroundSelector.value = 'black';
  backgroundSelector.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('changing a background redraws the editor canvas immediately', canvasRenderCount > rendersBeforeBackground && renderedBlocks[0].bg === 'black');
  backgroundSelector.value = 'white';
  backgroundSelector.dispatchEvent(new window.Event('change', { bubbles: true }));
  const rendersBeforeLanguage = canvasRenderCount;
  languageSelectors[0].value = 'ocr';
  languageSelectors[0].dispatchEvent(new window.Event('change', { bubbles: true }));
  check('sidebar language selector changes only its own line to English', $('editorBoxes').querySelector('.editor-box[data-id="1"] .editor-box-text')?.textContent === 'CORRECTED OCR' && $('editorBoxes').querySelector('.editor-box[data-id="2"] .editor-box-text')?.textContent === 'متن دوم' && vm.runInContext("state.project.images[0].blocks[0].textMode === 'ocr' && !state.project.images[0].blocks[1].textMode", context));
  check('changing one line language preserves both eye choices and the global mode', vm.runInContext("state.project.images[0].blocks.every((block) => block.enabled) && state.project.settings.overlayMode === 'translation'", context));
  await sleep(20);
  check('changing one line language redraws the editor canvas immediately', canvasRenderCount > rendersBeforeLanguage && renderedBlocks[0].tr === 'CORRECTED OCR' && renderedBlocks[0]._plainText === true);
  await vm.runInContext('renderAndUpload(state.project.images[0])', context);
  check('mixed English and Persian choices reach the preview and export renderer', renderedBlocks[0].tr === 'CORRECTED OCR' && renderedBlocks[0]._plainText === true && renderedBlocks[1].tr === 'متن دوم' && !renderedBlocks[1]._plainText);
  await vm.runInContext("exportResult('images')", context);
  check('actual ZIP export preserves the same mixed per-line languages', exportRequests.at(-1)?.kind === 'images' && renderedBlocks[0].tr === 'CORRECTED OCR' && renderedBlocks[0]._plainText === true && renderedBlocks[1].tr === 'متن دوم' && !renderedBlocks[1]._plainText);
  check('successful export leaves a persistent manual download link', !$('downloadLink').classList.contains('hidden') && $('downloadLink').href === 'blob:ui-test' && $('downloadLink').download === 'mixed.zip');
  $('editorBoxes').querySelector('.editor-box[data-id="1"] .box-language').click();
  check('on-image language button switches only that text back to Persian', $('editorBoxes').querySelector('.editor-box[data-id="1"] .editor-box-text')?.textContent === 'سلام دنیا' && $('editorBoxes').querySelector('.editor-box[data-id="2"] .editor-box-text')?.textContent === 'متن دوم' && languageSelectors[0].value === 'translation');
  $('overlayMode').value = 'ocr';
  $('overlayMode').dispatchEvent(new window.Event('change', { bubbles: true }));
  vm.runInContext('renderEditorBoxes()', context);
  check('a per-line Persian choice survives the global OCR default', $('editorBoxes').querySelector('.editor-box[data-id="1"] .editor-box-text')?.textContent === 'سلام دنیا' && $('editorBoxes').querySelector('.editor-box[data-id="2"] .editor-box-text')?.textContent === 'SECOND OCR');
  $('overlayMode').value = 'translation';
  $('overlayMode').dispatchEvent(new window.Event('change', { bubbles: true }));
  vm.runInContext('renderEditorBoxes()', context);

  check('each line has its own on-image and sidebar visibility controls', $('editorBoxes').querySelectorAll('.box-visibility').length === 2 && $('blockList').querySelectorAll('[data-visibility]').length === 2 && $('blockList').textContent.includes('نمایش متن 1 روی تصویر'));
  vm.runInContext("selectEditorBlock(2, false)", context);
  $('editorBoxes').querySelector('.editor-box[data-id="1"] .box-visibility').dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  $('editorBoxes').querySelector('.editor-box[data-id="1"] .box-language').dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  check('eye and language pointerdown do not change the selection', vm.runInContext("state.selectedBlockIds.join(',') === '2'", context));
  const lineToggles = $('blockList').querySelectorAll('[data-visibility]');
  await sleep(20);
  const rendersBeforeVisibility = canvasRenderCount;
  lineToggles[1].click();
  check('hiding one line leaves the other line visible', $('editorBoxes').children.length === 1 && $('editorBoxes').querySelector('.editor-box').dataset.id === '1' && vm.runInContext("state.project.images[0].blocks.map((block) => block.enabled).join(',')", context) === 'true,false');
  await sleep(20);
  check('hiding one line redraws the editor canvas immediately', canvasRenderCount > rendersBeforeVisibility && renderedBlocks[0].enabled === true && renderedBlocks[1].enabled === false);
  $('editorBoxes').querySelector('.editor-box[data-id="1"] .box-visibility').click();
  check('the on-image eye hides only its line without deleting text or changing global mode', $('editorBoxes').children.length === 0 && vm.runInContext("state.project.images[0].blocks[0].tr === 'سلام دنیا' && state.project.images[0].blocks[1].tr === 'متن دوم' && state.project.settings.overlayMode === 'translation'", context));
  lineToggles[1].click();
  check('sidebar can reshow one hidden line independently', $('editorBoxes').children.length === 1 && $('editorBoxes').querySelector('.editor-box').dataset.id === '2' && vm.runInContext("state.project.images[0].blocks.map((block) => block.enabled).join(',')", context) === 'false,true');
  await vm.runInContext('renderAndUpload(state.project.images[0])', context);
  check('rendering preserves independent per-line visibility choices', renderedBlocks.length === 2 && renderedBlocks[0].enabled === false && renderedBlocks[1].enabled === true);
  lineToggles[0].click();
  vm.runInContext(`window._beforeInline = JSON.parse(JSON.stringify(state.project.images[0].blocks[0]));
    Object.assign(state.project.images[0].blocks[0], {tr: '', richHtml: '', textMode: 'translation', enabled: true}); renderEditorBoxes()`, context);
  const emptyInlineBox = $('editorBoxes').querySelector('.editor-box[data-id="1"]');
  check('an empty translation still exposes a clickable box', !!emptyInlineBox && emptyInlineBox.classList.contains('empty'));
  emptyInlineBox.querySelector('.editor-box-text').click();
  check('clicking an empty box opens the contextual editor', !$('inlineEditor').classList.contains('hidden'));
  $('inlineEditorField').textContent = 'draft';
  vm.runInContext("state.project.images[0].blocks[0].tr = 'external edit'", context);
  $('inlineEditorApply').click();
  check('a stale inline draft does not overwrite another edit and remains available to copy', vm.runInContext("state.project.images[0].blocks[0].tr === 'external edit'", context) && !$('inlineEditor').classList.contains('hidden') && $('inlineEditorField').textContent === 'draft');
  vm.runInContext('closeInlineEditor(true); state.project.images[0].blocks[0] = window._beforeInline; buildBlockList(); drawEditor()', context);
  vm.runInContext(`window._priorBlocks = JSON.parse(JSON.stringify(state.project.images[0].blocks));
    state.project.images[0].blocks = [
      {id: 10, text: 'WHY ARE YOU', tr: '', richHtml: '', enabled: true, bg: 'white', x0: 10, y0: 10, x1: 140, y1: 30, lineH: 20},
      {id: 11, text: 'RUNNING AROUND', tr: '', richHtml: '', enabled: true, bg: 'white', x0: 10, y0: 35, x1: 150, y1: 55, lineH: 20}
    ]; state.selectedBlockIds = []; buildBlockList(); drawEditor();`, context);
  $('editorSelectAll').click(); $('editorMergeText').click();
  check('manual merge creates one editable OCR paragraph and retains both original lines', vm.runInContext("state.project.images[0].blocks.length === 1 && state.project.images[0].blocks[0].text === 'WHY ARE YOU RUNNING AROUND' && state.project.images[0].blocks[0].sourceLines.length === 2", context));
  $('editorSplitText').click();
  check('manual split restores original lines and their geometry', vm.runInContext("state.project.images[0].blocks.length === 2 && state.project.images[0].blocks[1].id === 11 && state.project.images[0].blocks[1].y0 === 35", context));
  $('editorMergeText').click();
  vm.runInContext("state.project.images[0].blocks[0].text = 'WHY ARE YOU  RUNNING AROUND';", context);
  $('editorSplitText').click();
  check('splitting never discards whitespace edits in merged OCR text', vm.runInContext("state.project.images[0].blocks.length === 1 && state.project.images[0].blocks[0].text === 'WHY ARE YOU  RUNNING AROUND'", context));
  vm.runInContext("state.project.images[0].blocks[0].text = 'WHY ARE YOU RUNNING AROUND'; state.project.images[0].blocks[0].tr = 'ترجمه';", context);
  $('editorSplitText').click();
  check('splitting never discards a translation', vm.runInContext("state.project.images[0].blocks.length === 1 && state.project.images[0].blocks[0].tr === 'ترجمه'", context));
  vm.runInContext("state.project.images[0].blocks = window._priorBlocks; state.selectedBlockIds = []; buildBlockList(); drawEditor(); state.editorId = null; appendLocalActivity('OLD JOB')", context);
  const clearsBeforeOcr = activityClears;
  $('ocrConfidence').value = '0';
  await vm.runInContext('runOcr()', context);
  check('OCR accepts zero confidence without substituting the default', ocrRequests.at(-1).min_confidence === 0);
  check('automatic paragraph grouping is requested by default', ocrRequests.at(-1).group_lines === true);
  $('ocrGroupLines').checked = false;
  vm.runInContext('collectOcrSettings()', context);
  check('automatic paragraph grouping can be disabled without altering existing blocks', vm.runInContext('state.project.settings.groupOcrLines === false && state.project.images[0].blocks.length === 1', context));
  $('ocrGroupLines').checked = true; vm.runInContext('collectOcrSettings()', context);
  check('starting a new job clears the previous job log', activityClears === clearsBeforeOcr + 1 && !$('activityLog').textContent.includes('OLD JOB') && $('activityLog').textContent.includes('OCR محلی'));
  check('finishing OCR automatically selects OCR display mode', $('overlayMode').value === 'ocr' && $('exportOverlayMode').value === 'ocr');
  check('finishing OCR places the new recognized text on the image', renderedBlocks[0].tr === 'NEW OCR' && renderedBlocks[0]._plainText === true);
  await vm.runInContext('runTranslation()', context);
  check('translation first shows every exact outgoing request without sending', $('translationPreviewDialog').open && translationCalls.length === 0 && $('translationPreviewRequests').textContent.includes('NEW OCR') && $('translationPreviewDestination').textContent.includes('Google Translate'));
  check('free translation hides AI-only guidance', $('translationSkillWrap').classList.contains('hidden'));
  $('translationPreviewCancel').click();
  check('cancelling translation preview sends nothing', !$('translationPreviewDialog').open && translationCalls.length === 0);
  let releaseTranslation;
  translationGate = new Promise((resolve) => { releaseTranslation = resolve; });
  await vm.runInContext('runTranslation()', context);
  check('a fresh translation preview is required after cancellation', $('translationPreviewDialog').open && translationPreviewCalls.length === 2 && translationCalls.length === 0);
  $('translationPreviewConfirm').click();
  await sleep(20);
  check('translation shows a live indeterminate progress bar while its first request is pending', $('translationDialog').open && $('translationStatus').textContent.includes('ترجمه') && $('translationActivityLog').textContent.includes('ترجمه') && $('translationProgress').closest('.bar').classList.contains('indeterminate') && $('translationProgress').style.width === '30%');
  activityFeed = { entries: [{ id: 500, message: 'ترجمهٔ مشترک تصویر 1 از 2 در حال انجام است', kind: 'info', progress: 0.5, time: new Date().toISOString() }], next: 500 };
  await vm.runInContext('pollActivity()', context);
  check('server progress replaces the animation with the correct percentage', $('translationStatus').textContent.includes('تصویر 1 از 2') && $('translationProgress').style.width === '50%' && $('translationProgress').closest('.bar').getAttribute('aria-valuenow') === '50' && !$('translationProgress').closest('.bar').classList.contains('indeterminate') && $('translationActivityLog').textContent.includes('تصویر 1 از 2'));
  activityFeed = { entries: [], next: 500 };
  translationGate = null; releaseTranslation();
  await vm.runInContext('translationPreviewTask', context);
  check('confirmed execution carries the exact preview signature', translationCalls.length === 1 && translationCalls[0].confirmation === 'ui-confirmation-signature');
  check('translation progress dialog closes after success', !$('translationDialog').open);
  check('finishing translation automatically selects translation display mode', $('overlayMode').value === 'translation' && $('exportOverlayMode').value === 'translation');
  check('finishing translation places translated text on the image', renderedBlocks[0].tr === 'ترجمهٔ تازه' && !renderedBlocks[0]._plainText);
  await vm.runInContext('openEditor(state.project.images[0].id)', context);
  const retranslateButton = [...$('blockList').querySelectorAll('button')].find((button) => button.textContent === 'ترجمهٔ دوباره');
  retranslateButton.click(); await sleep(20);
  check('per-block retranslation also previews before any direct send', $('translationPreviewDialog').open && $('translationPreviewRequests').textContent.includes('NEW OCR') && singleTranslationCalls.length === 0);
  $('translationPreviewConfirm').click();
  await vm.runInContext('translationPreviewTask', context);
  check('per-block confirmation sends the same previewed text and signature', singleTranslationCalls.length === 1 && singleTranslationCalls[0].text === 'NEW OCR' && singleTranslationCalls[0].confirmation === 'ui-confirmation-signature');
  check('confirmed per-block translation appears on its read-only card', $('blockList').querySelector('.block-card').textContent.includes('ترجمهٔ تکی تازه'));
  check('confirmed per-block translation defaults to justify, font 12 and top placement', vm.runInContext("state.project.images[0].blocks[0].align === 'justify' && state.project.images[0].blocks[0].size === 12 && state.project.images[0].blocks[0].verticalAlign === 'top'", context));
  await vm.runInContext('closeEditor()', context);
  let releaseImage; imageGate = new Promise(resolve => { releaseImage = resolve; });
  const delayedEditor = vm.runInContext('openEditor(state.project.images[0].id)', context); await sleep(10);
  check('old editor cards are cleared while the next image loads', $('editorDialog').open && $('blockList').querySelectorAll('.block-card').length === 0);
  imageGate = null; releaseImage(); await delayedEditor; await vm.runInContext('closeEditor()', context);

  const sendsBeforePreparationFailure = translationCalls.length;
  previewFailure = 'network'; await vm.runInContext('runTranslation()', context);
  check('network preparation error remains copyable with stage and endpoint', $('translationDialog').open && $('translationStatus').textContent.includes('TypeError') && $('translationStatus').textContent.includes('context-preview') && !$('copyTranslationError').classList.contains('hidden') && translationCalls.length === sendsBeforePreparationFailure);
  vm.runInContext("closeDialog('translationDialog')", context);
  previewFailure = 'validation'; await vm.runInContext('runTranslation()', context);
  check('validation diagnostics omit private input values', $('translationStatus').textContent.includes('too long') && !$('translationStatus').textContent.includes('private-response-data'));
  vm.runInContext("closeDialog('translationDialog')", context); previewFailure = null;
  vm.runInContext("state.ai.provider = 'openrouter'", context);
  await vm.runInContext('runTranslation()', context);
  previewFailure = 'server';
  $('translationSkill').value = 'new guidance'; $('translationSkill').dispatchEvent(new window.Event('input', {bubbles:true}));
  $('translationPreviewConfirm').click(); await sleep(20);
  check('preview refresh errors remain visible and copyable with HTTP details', $('translationPreviewDialog').open && $('translationPreviewError').textContent.includes('HTTP 503') && $('translationPreviewError').textContent.includes('simulated preview outage') && !$('copyTranslationPreviewError').classList.contains('hidden') && $('translationPreviewConfirm').textContent.includes('به‌روزرسانی') && translationCalls.length === sendsBeforePreparationFailure);
  $('translationPreviewCancel').click(); previewFailure = null; vm.runInContext("state.ai.provider = 'free'", context);

  vm.runInContext("window._projectBeforeOcrRace = JSON.parse(JSON.stringify(state.project)); state.project.images[0].blocks = []; delete state.project.images[0].ocrCompleted", context);
  await vm.runInContext('runTranslation()', context);
  let releaseOcr; ocrGate = new Promise(resolve => { releaseOcr = resolve; });
  const raceOcr = vm.runInContext('runOcr().catch(() => {})', context);
  await sleep(20); vm.runInContext('state.project.images[0].selected = false', context);
  ocrGate = null; releaseOcr(); await raceOcr;
  check('changed selection after OCR response cannot start translation or replace the current project', $('ocrDialog').open && $('ocrStatus').textContent.includes('OCR در سرور ذخیره شد') && !$('translationPreviewDialog').open && translationCalls.length === sendsBeforePreparationFailure && vm.runInContext('state.project.images[0].selected === false && state.project.images[0].blocks.length === 0', context));
  vm.runInContext("closeDialog('ocrDialog'); clearPendingTranslationOcr(); state.project = window._projectBeforeOcrRace; renderAll()", context);

  const revertsBeforeSelector = revertCalls;
  $('exportOverlayMode').value = 'none';
  $('exportOverlayMode').dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(500);
  check('the real export selector immediately restores original thumbnails in no-text mode', revertCalls === revertsBeforeSelector + 1 && vm.runInContext('state.project.images[0].edited', context) === false && !$('grid').querySelector('img').src.includes('edited=true'));
  check('the real no-text selector keeps saved OCR and translation', vm.runInContext("state.project.images[0].blocks[0].text === 'NEW OCR' && state.project.images[0].blocks[0].tr === 'ترجمهٔ تکی تازه'", context));
  $('overlayMode').value = 'ocr';
  $('overlayMode').dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(500);
  check('the real editor selector rebuilds OCR previews when no editor is open', renderedBlocks[0].tr === 'NEW OCR' && renderedBlocks[0]._plainText === true && vm.runInContext('state.project.images[0].edited', context) === true);

  vm.runInContext("appendLocalActivity('در حال دانلود آزمایشی')", context);
  check('live activity is visible on the page', $('activityLog').textContent.includes('در حال دانلود آزمایشی'));
  check('live activity is mirrored in model dialog', $('modelActivityLog').textContent.includes('در حال دانلود آزمایشی'));
  const clearsBeforeButton = activityClears;
  $('clearActivityBtn').click();
  await sleep(0);
  check('clear button empties every activity view and the server feed', activityClears === clearsBeforeButton + 1 && [...window.document.querySelectorAll('.activity-log')].every((log) => log.textContent === ''));
  vm.runInContext("appendLocalActivity('NEW JOB')", context);
  check('new activity remains after a manual clear', [...window.document.querySelectorAll('.activity-log')].every((log) => log.textContent.includes('NEW JOB') && !log.textContent.includes('در حال دانلود آزمایشی')));

  const oldFetch = window.fetch; let pendingChoices = null;
  const pendingId = '12345678901234567890123456789012';
  window.fetch = async (url, options = {}) => {
    if (String(url).includes('/pending/')) {
      if (options.method === 'POST') { pendingChoices = JSON.parse(options.body).choices; return jsonResponse({project: JSON.parse(JSON.stringify(vm.runInContext('state.project', context))), kind:'translation', done:true, affectedImageIds:[]}); }
      return jsonResponse({id:pendingId, kind:'translation', revision:'rev', canApply:true, rows:[{key:'image-ui:1', name:'page', conflict:true, current:'edited', original:'old', result:'<img src=x onerror=bad()>', source:'source'}], summary:'summary'});
    }
    return oldFetch(url, options);
  };
  await vm.runInContext(`openPendingResults('${pendingId}')`, context);
  check('pending conflict shows previous, current and generated text safely', $('pendingDialog').open && $('pendingDetail').textContent.includes('edited') && $('pendingDetail').textContent.includes('old') && $('pendingDetail').textContent.includes('<img') && !$('pendingDetail').querySelector('img'));
  $('pendingDetail').querySelector('select').value = 'apply';
  await vm.runInContext('applyPendingResult()', context);
  check('pending conflict submits explicit selection and closes after success', pendingChoices['image-ui:1'] === 'apply' && !$('pendingDialog').open);
  window.fetch = oldFetch;

  {
    const uploadsBefore = renderedUploads;
    const revertsBefore = revertCalls;
    vm.runInContext("state.project.settings.overlayMode = 'translation'; state.project.images[0].blocks = [{ id: 1, text: 'src', tr: '', richHtml: '<hr>', enabled: true, bg: 'white', x0: 5, y0: 5, x1: 150, y1: 45, lineH: 40, dir: 'rtl', align: 'right' }];", context);
    await vm.runInContext('renderAndUpload(state.project.images[0])', context);
    check('rich-HTML-only block (<hr>) uploads rendered image instead of reverting', renderedUploads === uploadsBefore + 1 && revertCalls === revertsBefore);
  }
  {
    let staleClosed = 0;
    const origCreateBitmap = window.createImageBitmap;
    let releaseSlow; const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
    const prevFetch = window.fetch;
    let gatedFirst = false;
    window.fetch = async (url, options = {}) => {
      if (!gatedFirst && String(url).includes('/content')) {
        gatedFirst = true;
        await slowGate;
        return { ok: true, blob: async () => ({ __staleOpen: true }) };
      }
      return prevFetch(url, options);
    };
    window.createImageBitmap = async (blob) => ({
      width: 320, height: 200,
      close() { if (blob && blob.__staleOpen) staleClosed += 1; },
    });
    const pendingOpen = vm.runInContext('openEditor(state.project.images[0].id)', context);
    await sleep(10);
    await vm.runInContext('closeEditor()', context);
    releaseSlow();
    await pendingOpen;
    window.fetch = prevFetch;
    window.createImageBitmap = origCreateBitmap;
    check('closing editor before image finishes loading discards and closes stale bitmap', staleClosed === 1 && vm.runInContext('state.editorBitmap === null && state.editorId === null', context));
  }
  {
    vm.runInContext('state.project.images[0].selected = true', context);
    const uploadsBefore = renderedUploads;
    $('exportName').value = 'word-check';
    $('exportDocxBtn').click();
    check('clicking Word export opens pre-export language choice dialog before generating docx', $('docxExportDialog').open === true && exportRequests.at(-1)?.kind !== 'docx');
    $('docxChoiceTranslation').click();
    await sleep(35);
    check('choosing Translated in Word prompt sends docx_mode=translation and docx_layout=visual without unnecessary image re-renders', exportRequests.at(-1)?.kind === 'docx' && exportRequests.at(-1)?.docx_mode === 'translation' && exportRequests.at(-1)?.docx_layout === 'visual' && renderedUploads === uploadsBefore && $('downloadLink').download === 'word-check.docx' && $('docxExportDialog').open === false);
    $('exportDocxBtn').click();
    $('docxChoiceOcr').click();
    await sleep(35);
    check('choosing English/OCR in Word prompt sends docx_mode=ocr and docx_layout=visual', exportRequests.at(-1)?.kind === 'docx' && exportRequests.at(-1)?.docx_mode === 'ocr' && exportRequests.at(-1)?.docx_layout === 'visual');
    $('exportDocxBtn').click();
    $('docxChoiceFlowingTranslation').click();
    await sleep(35);
    check('choosing Flowing Book Translation in Word prompt sends docx_mode=translation and docx_layout=flowing', exportRequests.at(-1)?.kind === 'docx' && exportRequests.at(-1)?.docx_mode === 'translation' && exportRequests.at(-1)?.docx_layout === 'flowing');
    $('exportDocxBtn').click();
    $('docxChoiceFlowingOcr').click();
    await sleep(35);
    check('choosing Flowing Book OCR in Word prompt sends docx_mode=ocr and docx_layout=flowing', exportRequests.at(-1)?.kind === 'docx' && exportRequests.at(-1)?.docx_mode === 'ocr' && exportRequests.at(-1)?.docx_layout === 'flowing');

    const pptxUploadsBefore = renderedUploads;
    $('exportName').value = 'slides-check';
    $('exportPptxBtn').click();
    check('clicking PowerPoint export opens pre-export choice dialog before generating pptx', $('pptxExportDialog').open === true && exportRequests.at(-1)?.kind !== 'pptx');
    $('pptxChoiceTranslation').click();
    await sleep(35);
    check('choosing Visual Translated in PowerPoint prompt sends kind=pptx, pptx_mode=translation, pptx_layout=visual without unnecessary image re-renders', exportRequests.at(-1)?.kind === 'pptx' && exportRequests.at(-1)?.pptx_mode === 'translation' && exportRequests.at(-1)?.pptx_layout === 'visual' && renderedUploads === pptxUploadsBefore && $('downloadLink').download === 'slides-check.pptx' && $('pptxExportDialog').open === false);
    $('exportPptxBtn').click();
    $('pptxChoiceOcr').click();
    await sleep(35);
    check('choosing Visual OCR in PowerPoint prompt sends pptx_mode=ocr and appends -en suffix', exportRequests.at(-1)?.kind === 'pptx' && exportRequests.at(-1)?.pptx_mode === 'ocr' && exportRequests.at(-1)?.pptx_layout === 'visual' && exportRequests.at(-1)?.name === 'slides-check-en');
    $('exportPptxBtn').click();
    $('pptxChoiceFlowingTranslation').click();
    await sleep(35);
    check('choosing Presentation Slides Translated sends pptx_mode=translation, pptx_layout=flowing, and -slides suffix', exportRequests.at(-1)?.kind === 'pptx' && exportRequests.at(-1)?.pptx_mode === 'translation' && exportRequests.at(-1)?.pptx_layout === 'flowing' && exportRequests.at(-1)?.name === 'slides-check-slides');
    $('exportPptxBtn').click();
    $('pptxChoiceFlowingOcr').click();
    await sleep(35);
    check('choosing Presentation Slides OCR sends pptx_mode=ocr, pptx_layout=flowing, and -slides-en suffix', exportRequests.at(-1)?.kind === 'pptx' && exportRequests.at(-1)?.pptx_mode === 'ocr' && exportRequests.at(-1)?.pptx_layout === 'flowing' && exportRequests.at(-1)?.name === 'slides-check-slides-en');

    $('ocrPageMode').value = 'document';
    vm.runInContext('collectOcrSettings()', context);
    check('ocrPageMode selector offers explicit comic/document only (no auto) and persists in project settings', JSON.stringify([...$('ocrPageMode').options].map((o) => o.value)) === JSON.stringify(['comic', 'document']) && JSON.stringify([...$('modelsPageMode').options].map((o) => o.value)) === JSON.stringify(['comic', 'document']) && $('ocrConfidence').defaultValue === '0.35' && vm.runInContext("state.project.settings.ocrPageMode === 'document'", context));
    $('ocrPageMode').value = 'comic';
    vm.runInContext('collectOcrSettings()', context);
    check('dock, Word, PowerPoint, preview, AI and editor progress bars all carry accessible progressbar roles and percentage labels', ['dockProgress', 'docxProgress', 'pptxProgress', 'previewPrepProgress', 'aiProgress', 'editorProgress'].every((id) => $(id) && $(id).closest('[role="progressbar"]')) && !!$('dockProgressPercent'));
    await vm.runInContext(`(async () => {
      state.ai = { ...state.ai, provider: 'openai', providers: { ...state.ai.providers, openai: { ...state.ai.providers.openai, profiles: [{ id: 'p1', name: 'k', hasApiKey: true, source_limit: 200 }] } } };
    })()`, context);
    const origFetchForPreviewErr = window.fetch;
    window.fetch = async (url, opts) => {
      if (String(url).endsWith('/context-preview')) {
        return jsonResponse({ provider: 'openai', providerLabel: 'OpenAI', model: 'gpt-4o-mini', base_url: 'https://api.openai.com/v1', rollingMode: true, contextMode: true, totalLimit: 200, contextLimit: 30, skillLimit: 30, blockCount: 1, requestCount: 0, requests: [], previewError: 'متن کامل کادر در سقف ۲۰۰ نویسه جا نمی‌شود.', skill: '', summary: '', signature: 'sig' });
      }
      return origFetchForPreviewErr(url, opts);
    };
    await vm.runInContext('runTranslation()', context);
    window.fetch = origFetchForPreviewErr;
    await vm.runInContext(`(async () => { state.ai.provider = 'free'; })()`, context);
    check('AI previewError opens translationPreviewDialog with clear error and AI settings shortcut instead of throwing empty-requests failure', $('translationPreviewDialog').open === true && !$('translationDialog').open && !$('translationPreviewError').classList.contains('hidden') && !$('openAiLimitFromPreview').classList.contains('hidden') && $('translationPreviewConfirm').disabled === true);
    $('translationPreviewCancel').click();
    await vm.runInContext('openEditor(state.project.images[0].id)', context);
    check('inline editor stays permanently visible in idle state on openEditor', !$('inlineEditor').classList.contains('hidden') && $('inlineEditor').classList.contains('is-idle') && $('inlineEditorSize').disabled === true);
    check('box alignment and same-size controls live inside inlineEditor below a divider with zero duplicate controls', !!$('inlineEditor').querySelector('.inline-section-divider') && !!$('inlineEditor').querySelector('.inline-box-layout-tools #editorSameSize') && !!$('inlineEditor').querySelector('.inline-box-layout-tools #editorAlignLeft') && !window.document.querySelector('.editor-side .editor-multi-tools') && !window.document.querySelector('.inline-box-settings') && window.document.querySelectorAll('#inlineLineReset').length === 1 && ![...$('blockList').querySelectorAll('button')].some((b) => b.textContent === 'ویرایش همین متن'));
    $('blockList').querySelector('.block-tr-edit').click();
    check('clicking sidebar translation line opens on-image inline editor directly', !$('inlineEditor').classList.contains('is-idle') && !!$('editorBoxes').querySelector('.editor-box.editing'));
    $('inlineEditorApply').click();
    $('editorBoxes').querySelector('.editor-box-text').click();
    check('selecting a box activates the docked inline editor in place', !$('inlineEditor').classList.contains('hidden') && !$('inlineEditor').classList.contains('is-idle') && $('inlineEditorSize').disabled === false);
    $('inlineEditorApply').click();
    check('finishing box edit keeps the inline editor docked in idle state instead of hiding it', !$('inlineEditor').classList.contains('hidden') && $('inlineEditor').classList.contains('is-idle') && !$('editorBoxes').querySelector('.editor-box.editing'));
    check('merge and split tools live in their own separated group outside align/layout tools', !!$('inlineEditor').querySelector('.inline-box-ops-row > #inlineMergeSplitTools #editorMergeText') && !!$('inlineEditor').querySelector('.inline-box-ops-row > #inlineMergeSplitTools #editorSplitText') && !$('inlineEditor').querySelector('.inline-box-layout-tools #editorMergeText') && !$('inlineEditor').querySelector('.inline-box-layout-tools #editorSplitText'));
    await vm.runInContext(`(async () => {
      window.__savedUiBlocksV363 = JSON.parse(JSON.stringify(state.project.images[0].blocks));
      state.project.settings.overlayMode = 'translation';
      state.project.images[0].blocks = [
        { id: 101, x0: 20, y0: 20, x1: 180, y1: 60, polygon: [[20,20],[180,20],[180,60],[20,60]], text: 'PART ONE', tr: '*سرفه* بخش اول', richHtml: '', enabled: true, lineH: 22, bg: 'white', dir: 'rtl', align: 'justify', size: 12, verticalAlign: 'top' },
        { id: 102, x0: 20, y0: 66, x1: 180, y1: 106, polygon: [[20,66],[180,66],[180,106],[20,106]], text: 'PART TWO', tr: 'بخش دوم', richHtml: '', enabled: true, lineH: 22, bg: 'white', dir: 'rtl', align: 'justify', size: 12, verticalAlign: 'top' },
      ];
      buildBlockList(); drawEditor();
      openInlineEditor(state.project.images[0].blocks[0]);
    })()`, context);
    check('inline editor uses layoutZoom=1, pre-line whitespace, and converts plain inline markers to HTML', $('inlineEditorField').dataset.layoutZoom === '1' && $('inlineEditorField').style.whiteSpace === 'pre-line' && $('inlineEditorField').innerHTML.includes('<i>سرفه</i>'));
    const box102Text = $('editorBoxes').querySelector('.editor-box[data-id="102"] .editor-box-text');
    box102Text.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, ctrlKey: true }));
    check('Ctrl+Click while inline editor is open closes draft and selects both boxes with merge ready', $('inlineEditor').classList.contains('is-idle') && $('editorMergeText').classList.contains('is-ready') && $('editorBoxes').querySelectorAll('.editor-box.selected').length === 2);
    $('editorMergeText').click();
    check('post-translation merge combines translated boxes without losing translations and marks split ready', await vm.runInContext(`state.project.images[0].blocks.length === 1 && state.project.images[0].blocks[0].tr.includes('بخش اول') && state.project.images[0].blocks[0].tr.includes('بخش دوم')`, context) && $('editorSplitText').classList.contains('is-ready'));
    $('editorSplitText').click();
    check('post-translation split restores merged boxes and their translations', await vm.runInContext(`state.project.images[0].blocks.length === 2 && state.project.images[0].blocks[0].id === 101 && state.project.images[0].blocks[1].id === 102 && state.project.images[0].blocks[1].tr === 'بخش دوم'`, context));
    await vm.runInContext(`(async () => {
      selectEditorBlock(102, false, false);
      state.project.images[0].blocks[1].tr = 'نیمه اول\\nنیمه دوم';
      updateEditorSelection();
    })()`, context);
    check('multiline single translated box marks split ready and splits proportionally into two boxes', $('editorSplitText').classList.contains('is-ready') && ($('editorSplitText').click(), true) && await vm.runInContext(`state.project.images[0].blocks.length === 3 && state.project.images[0].blocks[1].tr === 'نیمه اول' && state.project.images[0].blocks[2].tr === 'نیمه دوم' && state.project.images[0].blocks[2].y0 >= state.project.images[0].blocks[1].y1 - 1`, context));
    await vm.runInContext(`(async () => {
      state.project.images[0].blocks = window.__savedUiBlocksV363;
      buildBlockList(); drawEditor();
    })()`, context);
    await vm.runInContext('closeEditor()', context);

    // v3.64 + v3.65: Hamburger menu closes on any outside click; cancelling a running job asks Persian confirmation in themed #appModalDialog first.
    $('menu').classList.add('hidden');
    $('menuBtn').click();
    check('hamburger menu opens on button click with aria-expanded=true', !$('menu').classList.contains('hidden') && $('menuBtn').getAttribute('aria-expanded') === 'true');
    $('projectName').click();
    check('clicking inside hamburger menu keeps it open', !$('menu').classList.contains('hidden'));
    $('mainwrap').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    check('clicking anywhere outside hamburger menu closes it without clicking menuBtn again', $('menu').classList.contains('hidden') && $('menuBtn').getAttribute('aria-expanded') === 'false');

    await vm.runInContext(`(async () => {
      state.project.images[0].selected = true;
      state.project.images[0].blocks = [{ id: 1, text: 'HELLO WORLD', tr: '', richHtml: '', enabled: true, x0: 10, y0: 10, x1: 120, y1: 50, lineH: 24 }];
      renderAll();
    })()`, context);

    let releaseOcr1; ocrGate = new Promise((r) => { releaseOcr1 = r; });
    $('ocrBtn').click();
    $('startOcrBtn').click();
    await new Promise((r) => setTimeout(r, 20));
    check('in-flight OCR keeps × close button and dock cancel button enabled', $('ocrDialog').open === true && vm.runInContext('ocrRunning === true', context) && $('ocrDialog').querySelector('.dialog-head button').disabled === false && $('dockCancelJobBtn').disabled === false);
    $('ocrDialog').querySelector('.dialog-head button').click();
    await new Promise((r) => setTimeout(r, 20));
    check('clicking × during OCR opens Persian confirmation modal while keeping OCR running', $('appModalDialog').open === true && $('ocrDialog').open === true && vm.runInContext('ocrRunning === true && jobBusy === true', context) && $('appModalMessage').textContent.includes('آیا مطمئن هستید') && $('appModalConfirm').textContent.includes('بله') && $('appModalCancel').textContent.includes('خیر'));
    $('appModalCancel').click();
    await new Promise((r) => setTimeout(r, 20));
    check('declining cancel confirmation keeps OCR running and ocrDialog open', $('appModalDialog').open === false && $('ocrDialog').open === true && vm.runInContext('ocrRunning === true && jobBusy === true', context));
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 20));
    check('pressing Escape during OCR opens confirmation modal instead of immediately killing OCR', $('appModalDialog').open === true && $('ocrDialog').open === true && vm.runInContext('ocrRunning === true', context));
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 20));
    check('pressing Escape on confirmation modal dismisses only confirmation modal and keeps OCR running', $('appModalDialog').open === false && $('ocrDialog').open === true && vm.runInContext('ocrRunning === true && jobBusy === true', context));
    $('ocrDialog').querySelector('.dialog-head button').click();
    await new Promise((r) => setTimeout(r, 20));
    $('appModalConfirm').click();
    await new Promise((r) => setTimeout(r, 25));
    check('confirming cancel stops OCR, closes ocrDialog, and resets busy state', $('appModalDialog').open === false && $('ocrDialog').open === false && vm.runInContext('ocrRunning === false && jobBusy === false', context) && $('ocrBtn').disabled === false);
    releaseOcr1(); ocrGate = null;

    let releaseTr1; translationGate = new Promise((r) => { releaseTr1 = r; });
    await vm.runInContext('runTranslation()', context);
    $('translationPreviewConfirm').click();
    await new Promise((r) => setTimeout(r, 25));
    check('in-flight translation keeps × close button enabled', $('translationDialog').open === true && vm.runInContext('translationRunning === true', context) && $('translationDialog').querySelector('.dialog-head button').disabled === false);
    $('translationDialog').querySelector('.dialog-head button').click();
    await new Promise((r) => setTimeout(r, 20));
    check('clicking × during translation asks Persian confirmation before stopping', $('appModalDialog').open === true && $('translationDialog').open === true && vm.runInContext('translationRunning === true', context) && $('appModalMessage').textContent.includes('آیا مطمئن هستید'));
    $('appModalCancel').click();
    await new Promise((r) => setTimeout(r, 20));
    check('declining translation cancel keeps translation running', $('appModalDialog').open === false && $('translationDialog').open === true && vm.runInContext('translationRunning === true && jobBusy === true', context));
    $('dockCancelJobBtn').click();
    await new Promise((r) => setTimeout(r, 20));
    check('dock cancel button opens Persian confirmation modal for active job', $('appModalDialog').open === true && $('translationDialog').open === true && $('appModalDialog').dataset.variant === 'warning');
    $('appModalConfirm').click();
    await new Promise((r) => setTimeout(r, 25));
    check('confirming translation cancel closes translationDialog without reopening and resets busy state', $('appModalDialog').open === false && $('translationDialog').open === false && vm.runInContext('translationRunning === false && jobBusy === false', context) && $('translateBtn').disabled === false);
    releaseTr1(); translationGate = null;

    // Alert & delete confirmation use themed #appModalDialog with Persian text (no native confirm/alert).
    let nativeConfirmCalled = 0;
    window.confirm = () => { nativeConfirmCalled += 1; return true; };
    const alertTask = vm.runInContext(`window.alert('NetworkError when attempting to fetch resource')`, context);
    await new Promise((r) => setTimeout(r, 20));
    check('window.alert opens themed Persian appModalDialog without cancel button', $('appModalDialog').open === true && $('appModalCancel').classList.contains('hidden') && $('appModalMessage').textContent.includes('خطای شبکه هنگام ارتباط با سرور') && $('appModalConfirm').textContent === 'متوجه شدم');
    $('appModalConfirm').click();
    await alertTask;
    $('deleteBtn').click();
    await new Promise((r) => setTimeout(r, 20));
    check('deleting images opens destructive Persian appModalDialog instead of native confirm', nativeConfirmCalled === 0 && $('appModalDialog').open === true && $('appModalDialog').dataset.variant === 'danger' && $('appModalConfirm').classList.contains('danger-solid') && $('appModalMessage').textContent.includes('تصویر انتخاب‌شده'));
    $('appModalCancel').click();
    await new Promise((r) => setTimeout(r, 20));
    check('cancelling delete confirmation keeps project image intact', $('appModalDialog').open === false && vm.runInContext('state.project.images.length === 1', context));

    // v3.69: 1-click auto-download with hardware preflight warning modal + update notification banner & 1-click update
    const engineDownloadCalls = [];
    const engineUpdateCalls = [];
    let checkUpdatesCalls = 0;
    let mockCatalog = [
      {
        id: 'rapidocr-v6', name: 'PP-OCRv6 Small', family: 'RapidOCR / ONNX',
        description: 'مدل سریع کمیک', languages: ['eng', 'jpn', 'chi_sim'],
        selectable: true, action: 'download', isolated: false, category: 'standard',
        downloadSizeGb: 0.06, requiresNvidiaGpu: false, minVramGb: 0,
        runtimeInstalled: true, modelReady: true, readyLanguages: ['eng'],
        installedVersion: '3.9.0', latestVersion: '3.10.0', updateAvailable: true,
        updateSummary: 'نسخهٔ جدید 3.10.0 برای مدل «PP-OCRv6 Small» آمادهٔ نصب است (نسخهٔ فعلی: 3.9.0)',
        hardwareCheck: { compatible: true, warnings: [], hasNvidiaGpu: false, gpuName: '', vramGb: 0, freeDiskGb: 80 },
      },
      {
        id: 'olmocr', name: 'olmOCR', family: 'AllenAI / 7B VLM OCR',
        description: 'مدل سنگین ۷ میلیارد پارامتری', languages: ['eng', 'kor', 'jpn', 'chi_sim'],
        selectable: true, action: 'download', isolated: true, category: 'advanced',
        downloadSizeGb: 15, requiresNvidiaGpu: true, minVramGb: 16,
        runtimeInstalled: false, modelReady: false, readyLanguages: [],
        installedVersion: null, latestVersion: null, updateAvailable: false, updateSummary: '',
        hardwareCheck: {
          compatible: false,
          warnings: ['این مدل برای اجرا به کارت گرافیک NVIDIA با حداقل 16 گیگابایت حافظهٔ گرافیکی نیاز دارد، اما کارت گرافیک NVIDIA روی این سیستم شناسایی نشد.'],
          hasNvidiaGpu: false, gpuName: '', vramGb: 0, freeDiskGb: 80,
        },
      },
    ];
    const origFetchV369 = window.fetch;
    window.fetch = async (url, options = {}) => {
      const parsed = new URL(url, 'http://127.0.0.1:8765');
      if (parsed.pathname === '/api/engines' && (!options.method || options.method === 'GET')) {
        return jsonResponse(mockCatalog);
      }
      if (parsed.pathname === '/api/engines/check-updates' && options.method === 'POST') {
        checkUpdatesCalls += 1;
        return jsonResponse({
          checked: true, online: true,
          updatesCount: mockCatalog.filter((e) => e.updateAvailable).length,
          updatableIds: mockCatalog.filter((e) => e.updateAvailable).map((e) => e.id),
          engines: mockCatalog,
          hardware: { hasNvidiaGpu: false, gpuName: '', vramGb: 0, freeDiskGb: 80 },
        });
      }
      if (parsed.pathname === '/api/engines/olmocr/download' && options.method === 'POST') {
        const body = JSON.parse(options.body || '{}');
        engineDownloadCalls.push(body);
        if (!body.force) {
          return jsonResponse({ kind: 'hardware_warning', detail: 'NVIDIA GPU required', warnings: mockCatalog[1].hardwareCheck.warnings, hardwareCheck: mockCatalog[1].hardwareCheck }, 409);
        }
        mockCatalog = mockCatalog.map((item) => item.id === 'olmocr' ? { ...item, runtimeInstalled: true, modelReady: true, readyLanguages: [body.language || 'eng'], installedVersion: '0.4.27' } : item);
        return jsonResponse({ ok: true, language: body.language || 'eng', engines: mockCatalog });
      }
      if (parsed.pathname === '/api/engines/rapidocr-v6/update' && options.method === 'POST') {
        const body = JSON.parse(options.body || '{}');
        engineUpdateCalls.push(body);
        mockCatalog = mockCatalog.map((item) => item.id === 'rapidocr-v6' ? { ...item, installedVersion: '3.10.0', updateAvailable: false, updateSummary: '' } : item);
        return jsonResponse({ ok: true, language: body.language || 'eng', engines: mockCatalog });
      }
      return origFetchV369(url, options);
    };

    await vm.runInContext(`checkEngineUpdates({ force: true, silent: false })`, context);
    check('checkEngineUpdates populates top Persian update banner and menu badge', checkUpdatesCalls === 1 && !$('engineUpdateNotice').classList.contains('hidden') && $('engineUpdateNoticeText').textContent.includes('PP-OCRv6 Small') && !$('modelsBtnBadge').classList.contains('hidden'));

    $('modelsBtn').click();
    await new Promise((r) => setTimeout(r, 20));
    check('modelsDialog shows hardware summary, update banner, and both standard + isolated model groups', $('modelsDialog').open === true && $('modelsHardwareSummary').textContent.includes('بدون کارت گرافیک مجزای NVIDIA') && !$('modelsUpdateBanner').classList.contains('hidden') && !$('updateAllModelsBtn').classList.contains('hidden') && $('engineCards').querySelectorAll('.model-group').length === 2);

    // Click prepare on heavy GPU model olmOCR -> Persian hardware warning modal opens BEFORE downloading
    const olmCard = [...$('engineCards').querySelectorAll('.engine-card')].find((el) => el.querySelector('h3')?.textContent === 'olmOCR');
    const olmPrepareBtn = [...olmCard.querySelectorAll('.card-buttons button')].find((b) => b.textContent.includes('آماده‌سازی'));
    olmPrepareBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    check('clicking prepare on heavy GPU model opens Persian hardware warning modal before downloading', $('appModalDialog').open === true && $('appModalDialog').dataset.variant === 'warning' && $('appModalMessage').textContent.includes('NVIDIA') && engineDownloadCalls.length === 0);
    $('appModalCancel').click();
    await new Promise((r) => setTimeout(r, 20));
    check('declining hardware warning cancels download cleanly without sending network download request', $('appModalDialog').open === false && engineDownloadCalls.length === 0);

    // Confirming hardware warning sends force=true and prepares olmOCR
    olmPrepareBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    $('appModalConfirm').click();
    await new Promise((r) => setTimeout(r, 30));
    check('confirming hardware warning sends force=true and marks isolated engine ready', engineDownloadCalls.length === 1 && engineDownloadCalls[0].force === true && vm.runInContext(`state.engines.find(e => e.id === 'olmocr').runtimeInstalled === true`, context));

    // Clicking 1-click update updates rapidocr-v6 and hides update banner + badge
    $('updateAllModelsBtn').click();
    await new Promise((r) => setTimeout(r, 30));
    check('1-click update upgrades outdated engine and clears top update banner and badge', engineUpdateCalls.length === 1 && $('engineUpdateNotice').classList.contains('hidden') && $('modelsBtnBadge').classList.contains('hidden') && $('modelsUpdateBanner').classList.contains('hidden') && vm.runInContext(`state.engines.find(e => e.id === 'rapidocr-v6').installedVersion === '3.10.0'`, context));
    vm.runInContext(`closeDialog('modelsDialog')`, context);
    window.fetch = origFetchV369;
  }

  // v3.71: Interactive section-by-section Help Center (#helpDialog, #helpTopBtn, #helpMenuBtn, F1, search, examples)
  {
    check('all 13 Help sections include practical examples and untranslated terms', window.ComicHelpGuide.HELP_SECTIONS.length === 13 && window.ComicHelpGuide.HELP_SECTIONS.every((s) => s.example && s.example.title.includes('مثال عملی') && s.example.body.length > 60 && s.features?.length >= 3 && s.steps?.length >= 3));
    $('helpTopBtn').click();
    check('clicking topbar Help button opens #helpDialog with 13 chapter nav items', $('helpDialog').open === true && window.document.querySelectorAll('#helpNavList .help-nav-item').length === 13);
    check('chapter mode renders active chapter with practical example box', window.document.querySelectorAll('#helpContentArea .help-article').length === 1 && $('helpContentArea').textContent.includes('مثال عملی'));
    $('helpViewAllBtn').click();
    check('view-all mode renders all 13 sections simultaneously', window.document.querySelectorAll('#helpContentArea .help-article').length === 13);
    $('helpSearchInput').value = 'Flowing Book';
    $('helpSearchInput').dispatchEvent(new window.Event('input', { bubbles: true }));
    check('searching untranslated term Flowing Book filters matching Help section', window.document.querySelectorAll('#helpContentArea .help-article').length >= 1 && $('helpContentArea').textContent.includes('Flowing Book Layout'));
    $('helpSearchClear').click();
    $('helpViewChapterBtn').click();
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    check('Escape closes #helpDialog cleanly', $('helpDialog').open === false);
    check('hamburger menu excludes Help button and backup hint while Help Chapter 2 documents backup details', !$('helpMenuBtn') && !window.document.querySelector('#menu .hint') && window.ComicHelpGuide.HELP_SECTIONS[1].features.some((f) => f.includes('بک‌آپ شامل تصاویر، متن‌ها، پیش‌نمایش‌ها')));
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'F1', bubbles: true, cancelable: true }));
    check('pressing F1 opens #helpDialog from anywhere', $('helpDialog').open === true);
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'F1', bubbles: true, cancelable: true }));
    check('pressing F1 while #helpDialog is open toggles it closed', $('helpDialog').open === false);
  }

  // v3.72 / v3.77: Compact #ocrDialog (no #ocrSuitabilityPanel box; full 13-model matrix in Help) + subtle #ocrEngine & #modelsDialog suitability indicators
  {
    const prevEnginesV372 = vm.runInContext('state.engines', context);
    vm.runInContext(`state.engines = [
      { id: 'rapidocr-v6', name: 'PP-OCRv6 Small', selectable: true, runtimeInstalled: true, languages: ['eng'], readyLanguages: ['eng'], description: 'fast', family: 'Paddle' },
      { id: 'easyocr', name: 'EasyOCR', selectable: true, runtimeInstalled: true, languages: ['eng', 'kor'], readyLanguages: ['eng'], description: 'scene', family: 'CRAFT' },
      { id: 'surya', name: 'Surya', selectable: true, isolated: true, runtimeInstalled: false, languages: ['eng', 'jpn'], readyLanguages: [], description: 'layout', family: 'Datalab' },
      { id: 'tesseract', name: 'Tesseract 5 LSTM', selectable: true, runtimeInstalled: true, languages: ['eng'], readyLanguages: ['eng'], description: 'doc', family: 'Tesseract' },
      { id: 'mineru-2-5-pro', name: 'MinerU2.5-Pro', selectable: true, isolated: true, runtimeInstalled: false, languages: ['eng'], readyLanguages: [], description: 'pdf/book', family: 'OpenDataLab' }
    ];`, context);
    $('ocrBtn').click();
    check('v3.77 removes #ocrSuitabilityPanel, #ocrEngineTierGrid, and #ocrEngineFitBanner from #ocrDialog and keeps full 13-model guide in Help', !$('ocrSuitabilityPanel') && !$('ocrEngineTierGrid') && !$('ocrEngineFitBanner') && window.ComicHelpGuide.HELP_SECTIONS.find((c) => c.id === 'ocr-modes').features.some((f) => f.includes('PP-OCRv6 Small') && f.includes('MinerU2.5-Pro') && f.includes('HunyuanOCR')));
    $('ocrPageMode').value = 'comic';
    $('ocrPageMode').dispatchEvent(new window.Event('change', { bubbles: true }));
    const optTier = (id) => window.document.querySelector(`#ocrEngine option[value="${id}"]`)?.dataset.suitability;
    check('comic mode marks #ocrEngine options PP-OCRv6 & EasyOCR green, Surya yellow/medium, Tesseract & MinerU red/weak', optTier('rapidocr-v6') === 'best' && optTier('easyocr') === 'best' && optTier('surya') === 'medium' && optTier('tesseract') === 'weak' && optTier('mineru-2-5-pro') === 'weak');

    // Selecting Tesseract in comic mode updates #ocrEngine select suitability indicator to weak
    $('ocrEngine').value = 'tesseract';
    $('ocrEngine').dispatchEvent(new window.Event('change', { bubbles: true }));
    check('selecting Tesseract in comic mode sets #ocrEngine suitability indicator to weak (red)', $('ocrEngine').value === 'tesseract' && $('ocrEngine').dataset.suitability === 'weak');

    // Switch page mode to document -> Tesseract, Surya, MinerU flip to green (best), PP-OCRv6 to yellow (medium), EasyOCR to red (weak)!
    $('ocrPageMode').value = 'document';
    $('ocrPageMode').dispatchEvent(new window.Event('change', { bubbles: true }));
    check('switching #ocrPageMode to document dynamically flips Tesseract, Surya & MinerU options to green, PP-OCRv6 to medium, and EasyOCR to red', optTier('tesseract') === 'best' && optTier('surya') === 'best' && optTier('mineru-2-5-pro') === 'best' && optTier('rapidocr-v6') === 'medium' && optTier('easyocr') === 'weak' && $('ocrEngine').dataset.suitability === 'best');
    vm.runInContext(`closeDialog('ocrDialog')`, context);

    // Open #modelsDialog -> syncs #modelsPageMode to document and highlights engine cards
    $('modelsBtn').click();
    const cardTier = (name) => [...window.document.querySelectorAll('#engineCards .engine-card')].find((el) => el.querySelector('h3')?.textContent === name)?.dataset.suitability;
    check('modelsDialog syncs #modelsPageMode with #ocrPageMode (document) and highlights engine cards', $('modelsPageMode').value === 'document' && cardTier('Tesseract 5 LSTM') === 'best' && cardTier('Surya') === 'best' && cardTier('PP-OCRv6 Small') === 'medium' && cardTier('EasyOCR') === 'weak');
    $('modelsPageMode').value = 'document';
    const origFetchTestEng = window.fetch;
    let capturedTestBody = null;
    window.fetch = async (url, opts) => {
      if (String(url).endsWith('/api/engines/tesseract/test')) {
        capturedTestBody = JSON.parse(opts.body);
        return jsonResponse({ blocks: [{ text: 'Article Paragraph', conf: 92, sourceIndent: 0 }] });
      }
      return origFetchTestEng(url, opts);
    };
    await vm.runInContext(`testEngine('tesseract')`, context);
    window.fetch = origFetchTestEng;
    check('testing an engine inside modelsDialog sends current page_mode (document) to /api/engines/<id>/test', capturedTestBody?.page_mode === 'document' && $('modelTestResult').textContent.includes('Article Paragraph'));

    $('modelsPageMode').value = 'comic';
    $('modelsPageMode').dispatchEvent(new window.Event('change', { bubbles: true }));
    check('switching #modelsPageMode inside modelsDialog re-colors engine cards live', cardTier('PP-OCRv6 Small') === 'best' && cardTier('EasyOCR') === 'best' && cardTier('Surya') === 'medium' && cardTier('Tesseract 5 LSTM') === 'weak' && cardTier('MinerU2.5-Pro') === 'weak');
    vm.runInContext(`adoptProject({ ...state.project, settings: { ...state.project.settings, ocrPageMode: 'auto' } })`, context);
    check('legacy projects saved with ocrPageMode=auto normalize cleanly to comic without empty select values', $('ocrPageMode').value === 'comic' && $('modelsPageMode').value === 'comic');
    vm.runInContext(`closeDialog('modelsDialog')`, context);
    $('ocrPageMode').value = 'comic';
    $('ocrPageMode').dispatchEvent(new window.Event('change', { bubbles: true }));
    vm.runInContext('state.engines = prevEngines;', Object.assign(context, { prevEngines: prevEnginesV372 }));
    vm.runInContext('updateEngineOptions("rapidocr-v6")', context);
  }

  // v3.73: Live OCR model download/update progress bars + stale check-updates race guard
  {
    const origFetchV373 = window.fetch;
    const prevEnginesV373 = vm.runInContext('state.engines', context);
    let resolveUpdateReq;
    let resolveStaleCheck;
    let nextActivityEntries = [];
    let activitySeq = 9000;

    vm.runInContext(`state.engines = [
      { id: 'rapidocr-v6', name: 'PP-OCRv6 Small', selectable: true, runtimeInstalled: true, languages: ['eng'], readyLanguages: ['eng'], installedVersion: '3.8.0', latestVersion: '3.10.0', updateAvailable: true, updateSummary: 'نسخهٔ ۳.۱۰ آماده است', description: 'fast', family: 'Paddle' },
      { id: 'surya', name: 'Surya', selectable: true, isolated: true, runtimeInstalled: false, languages: ['eng'], readyLanguages: [], description: 'layout', family: 'Datalab' }
    ]; engineUpdateNoticeDismissed = false; syncEngineUpdateUi(); renderModels(); updateEngineOptions('rapidocr-v6');`, context);

    window.fetch = async (url, options = {}) => {
      const parsed = new URL(url, 'http://127.0.0.1:8765');
      if (parsed.pathname === '/api/activity') {
        const entries = nextActivityEntries;
        nextActivityEntries = [];
        return jsonResponse({ entries, next: ++activitySeq });
      }
      if (parsed.pathname === '/api/engines/check-updates' && options.method === 'POST') {
        return new Promise((resolve) => { resolveStaleCheck = resolve; });
      }
      if (parsed.pathname === '/api/engines/rapidocr-v6/update' && options.method === 'POST') {
        return new Promise((resolve) => { resolveUpdateReq = resolve; });
      }
      return origFetchV373(url, options);
    };

    // Start an in-flight silent checkEngineUpdates BEFORE updating
    const staleCheckPromise = vm.runInContext(`checkEngineUpdates({ force: false, silent: true })`, context);
    await new Promise((r) => setTimeout(r, 15));

    // Open modelsDialog and start updating PP-OCRv6 Small
    $('modelsBtn').click();
    const rapidCard = () => [...window.document.querySelectorAll('#engineCards .engine-card')].find((el) => el.querySelector('h3')?.textContent === 'PP-OCRv6 Small');
    const updBtn = [...rapidCard().querySelectorAll('.card-buttons button')].find((b) => b.textContent.includes('به‌روزرسانی'));
    updBtn.click();
    await new Promise((r) => setTimeout(r, 20));

    check('starting model update shows sticky #modelsActiveProgressWrap, per-card .engine-card-progress, #engineNoticeProgressWrap, and #dockProgressWrap', !$('modelsActiveProgressWrap').classList.contains('hidden') && Boolean(rapidCard().querySelector('.engine-card-progress')) && !$('engineNoticeProgressWrap').classList.contains('hidden') && !$('dockProgressWrap').classList.contains('hidden'));

    // Feed live 62% progress FOLLOWED BY a progress:null heartbeat in the SAME /api/activity batch -> must still apply 62%!
    nextActivityEntries = [
      { id: ++activitySeq, message: 'در حال نصب بستهٔ rapidocr (۶۲٪)…', kind: 'info', progress: 0.62, time: new Date().toISOString() },
      { id: ++activitySeq, message: 'آماده‌سازی همچنان در حال انجام است · 15 ثانیه', kind: 'info', progress: null, time: new Date().toISOString() },
    ];
    await vm.runInContext(`pollActivity()`, context);
    check('live activity progress updates sticky bar, per-card bar, notice bar, and dock bar to 62% even when followed by a null-progress heartbeat', $('modelsActiveProgressPercent').textContent === '62%' && $('modelsActiveProgress').style.width === '62%' && rapidCard().querySelector('.engine-card-progress-pct')?.textContent === '62%' && $('engineNoticeProgressPercent').textContent === '62%' && $('dockProgressPercent').textContent === '62%');

    // Finish update request -> updateAvailable becomes false and progress bars hide cleanly
    resolveUpdateReq(jsonResponse({
      ok: true,
      language: 'eng',
      engines: [
        { id: 'rapidocr-v6', name: 'PP-OCRv6 Small', selectable: true, runtimeInstalled: true, languages: ['eng'], readyLanguages: ['eng'], installedVersion: '3.10.0', latestVersion: '3.10.0', updateAvailable: false, updateSummary: '', description: 'fast', family: 'Paddle' },
        { id: 'surya', name: 'Surya', selectable: true, isolated: true, runtimeInstalled: false, languages: ['eng'], readyLanguages: [], description: 'layout', family: 'Datalab' },
      ],
    }));
    await new Promise((r) => setTimeout(r, 25));
    check('finishing update hides active progress bars and clears update banner', $('modelsActiveProgressWrap').classList.contains('hidden') && !rapidCard().querySelector('.engine-card-progress') && $('engineUpdateNotice').classList.contains('hidden'));

    // Now resolve the earlier stale check-updates response carrying outdated updateAvailable: true -> must be ignored!
    resolveStaleCheck(jsonResponse({
      checkedAt: Date.now() / 1000,
      updatesAvailable: 1,
      engines: [
        { id: 'rapidocr-v6', name: 'PP-OCRv6 Small', selectable: true, runtimeInstalled: true, languages: ['eng'], readyLanguages: ['eng'], installedVersion: '3.8.0', latestVersion: '3.10.0', updateAvailable: true, updateSummary: 'کهنه', description: 'fast', family: 'Paddle' },
      ],
    }));
    await staleCheckPromise;
    await new Promise((r) => setTimeout(r, 15));
    check('stale in-flight check-updates response cannot resurrect updateAvailable after updateEngine succeeds', vm.runInContext(`state.engines.find(e => e.id === 'rapidocr-v6').updateAvailable === false`, context) && $('engineUpdateNotice').classList.contains('hidden') && $('modelsBtnBadge').classList.contains('hidden'));

    vm.runInContext(`closeDialog('modelsDialog')`, context);
    window.fetch = origFetchV373;
    vm.runInContext('state.engines = prevEngines;', Object.assign(context, { prevEngines: prevEnginesV373 }));
    vm.runInContext('syncEngineUpdateUi(); updateEngineOptions("rapidocr-v6");', context);
  }

  // v3.75: Opening #modelsDialog does NOT auto-check updates (only manual #checkModelUpdatesBtn does), and #freeModelsRamBtn frees RAM
  {
    const origFetchV375 = window.fetch;
    let manualCheckCount = 0;
    let unloadCalls = 0;
    window.fetch = async (url, options = {}) => {
      const parsed = new URL(url, 'http://127.0.0.1');
      if (parsed.pathname === '/api/engines/check-updates' && options.method === 'POST') {
        manualCheckCount += 1;
        return jsonResponse({ checkedAt: Date.now() / 1000, updatesCount: 0, engines: vm.runInContext('state.engines', context), memory: { totalRamMb: 118, loadedCount: 0, loadedEngines: [] } });
      }
      if (parsed.pathname === '/api/engines/memory') {
        return jsonResponse({ totalRamMb: 132, loadedCount: 0, loadedEngines: [] });
      }
      if (parsed.pathname === '/api/engines/unload' && options.method === 'POST') {
        unloadCalls += 1;
        return jsonResponse({ ok: true, memory: { totalRamMb: 109, freedRamMb: 23, loadedCount: 0, loadedEngines: [] }, engines: vm.runInContext('state.engines', context) });
      }
      return origFetchV375(url, options);
    };

    $('modelsBtn').click();
    await new Promise((r) => setTimeout(r, 25));
    check('opening #modelsDialog does NOT trigger automatic check-updates request and shows live RAM badge', manualCheckCount === 0 && $('modelsRamStatus').textContent.includes('۱۳۲') === false && $('modelsRamStatus').textContent.includes('132'));

    $('freeModelsRamBtn').click();
    await new Promise((r) => setTimeout(r, 25));
    check('clicking #freeModelsRamBtn calls POST /api/engines/unload and updates RAM status to 109 MB', unloadCalls === 1 && $('modelsRamStatus').textContent.includes('109') && $('modelTestResult').textContent.includes('آزاد شد'));

    $('checkModelUpdatesBtn').click();
    await new Promise((r) => setTimeout(r, 25));
    check('clicking #checkModelUpdatesBtn explicitly runs manual update check', manualCheckCount === 1);

    vm.runInContext(`closeDialog('modelsDialog')`, context);
    window.fetch = origFetchV375;
  }

  // v3.80: Configured translation service selector + Copy/Paste/Clear + over-budget click warning
  {
    const origFetchV380 = window.fetch;
    window.fetch = async (url, options = {}) => {
      const parsed = new URL(url, 'http://127.0.0.1');
      if (parsed.pathname.endsWith('/context-preview') && options.method === 'POST') {
        const reqBody = JSON.parse(options.body);
        translationPreviewCalls.push(reqBody);
        const isFree = reqBody.provider === 'free';
        const lim = reqBody.profile_id === 'or-2' ? 2000 : 1000;
        return jsonResponse({
          provider: reqBody.provider,
          profileId: reqBody.profile_id || '',
          providerLabel: isFree ? 'Google Translate؛ در صورت خطا MyMemory' : 'OpenRouter (کلید دوم)',
          model: isFree ? '' : 'openai/gpt-4o-mini',
          base_url: isFree ? '' : 'https://openrouter.ai/api/v1',
          rollingMode: true,
          contextMode: !isFree,
          totalLimit: lim,
          contextLimit: isFree ? 0 : Math.floor(lim * 0.15),
          skillLimit: isFree ? 0 : Math.floor(lim * 0.15),
          contextPercent: isFree ? 0 : 15,
          skillPercent: isFree ? 0 : 15,
          blockCount: 1,
          requestCount: 1,
          requests: [{ index: 1, characters: 11, text: 'SAMPLE LINE' }],
          systemPrompt: isFree ? '' : 'Translate to Persian',
          skill: reqBody.skill || '',
          defaultSkill: 'راهنمای پیش‌فرض',
          summary: reqBody.summary || '',
          signature: 'sig-v380',
        });
      }
      return origFetchV380(url, options);
    };
    await vm.runInContext(`(async () => {
      state.ai = {
        provider: 'free',
        reuse_repeated: true,
        context_percent: 15,
        skill_percent: 15,
        free_services: {
          google: { timeout_seconds: 90, retry_count: 0, retry_wait_seconds: 20, source_limit: 1000 },
          mymemory: { timeout_seconds: 90, retry_count: 0, retry_wait_seconds: 20, source_limit: 500 },
        },
        providers: {
          gemini: { label: 'Google Gemini', model: 'gemini-2.5-flash', base_url: 'https://generativelanguage.googleapis.com/v1beta', profiles: [{ id: 'gem-1', name: 'کلید اصلی', hasApiKey: true, source_limit: 1200 }] },
          openai: { label: 'OpenAI', model: 'gpt-4o-mini', base_url: 'https://api.openai.com/v1', profiles: [{ id: 'oa-1', name: 'خالی', hasApiKey: false, source_limit: 1000 }] },
          openrouter: { label: 'OpenRouter', model: 'openai/gpt-4o-mini', base_url: 'https://openrouter.ai/api/v1', profiles: [{ id: 'or-1', name: 'کلید اول', hasApiKey: true, source_limit: 1000 }, { id: 'or-2', name: 'کلید دوم', hasApiKey: true, source_limit: 2000 }] },
          avalai: { label: 'AvalAI', model: 'gpt-6-luna', base_url: 'https://api.avalai.ir/v1', profiles: [] },
        },
      };
      lastSyncedAiProvider = null;
      preferredTranslationTarget = null;
      state.project.images[0].selected = true;
      state.project.images[0].blocks = [{ id: 1, text: 'SAMPLE LINE', tr: '', enabled: true, x0: 0, y0: 0, x1: 80, y1: 30 }];
    })()`, context);
    await vm.runInContext('runTranslation()', context);
    const serviceOpts = [...$('translationPreviewService').options].map((o) => o.value);
    check(
      'translation preview service selector lists free + configured AI providers/profiles and hides unconfigured providers',
      serviceOpts.includes('free') &&
      serviceOpts.includes('gemini') &&
      serviceOpts.includes('openrouter') &&
      serviceOpts.includes('openrouter::or-1') &&
      serviceOpts.includes('openrouter::or-2') &&
      !serviceOpts.includes('openai') &&
      !serviceOpts.includes('avalai'),
    );

    // Switch live to openrouter::or-2 right inside #translationPreviewDialog
    $('translationPreviewService').value = 'openrouter::or-2';
    $('translationPreviewService').dispatchEvent(new window.Event('change', { bubbles: true }));
    await sleep(30);
    check(
      'switching #translationPreviewService updates preview to chosen configured AI profile and reveals #translationSkillWrap',
      translationPreviewCalls.at(-1).provider === 'openrouter' &&
      translationPreviewCalls.at(-1).profile_id === 'or-2' &&
      !$('translationSkillWrap').classList.contains('hidden'),
    );

    // Clipboard Copy / Paste / Clear buttons & full paste over limit without truncation
    let clipBuffer = 'پرامپت آزمایشی طولانی برای تست سقف نویسه '.repeat(10);
    Object.defineProperty(window.navigator, 'clipboard', {
      value: {
        writeText: async (txt) => { clipBuffer = txt; },
        readText: async () => clipBuffer,
      },
      configurable: true,
    });
    $('clearTranslationSkill').click();
    check('clearTranslationSkill empties #translationSkill', $('translationSkill').value === '');
    $('pasteTranslationSkill').click();
    await sleep(20);
    check(
      'pasteTranslationSkill pastes full over-limit text without truncating and flags over-budget state',
      $('translationSkill').value === clipBuffer &&
      $('translationSkill').classList.contains('budget-over-limit') &&
      $('translationPreviewConfirm').disabled === false &&
      $('translationPreviewConfirm').classList.contains('over-budget-blocked'),
    );

    const callsBeforeBlockedConfirm = translationCalls.length;
    $('translationPreviewConfirm').click();
    await sleep(25);
    check(
      'clicking #translationPreviewConfirm while over character limit blocks translation and shows Persian warning modal',
      $('appModalDialog').open === true &&
      $('appModalMessage').textContent.includes('بیش از سقف مجاز') &&
      translationCalls.length === callsBeforeBlockedConfirm &&
      $('translationPreviewDialog').open === true,
    );
    $('appModalConfirm').click();
    await sleep(20);

    $('translationSkill').value = 'راهنمای کوتاه';
    $('translationSkill').dispatchEvent(new window.Event('input', { bubbles: true }));
    $('copyTranslationSkill').click();
    await sleep(20);
    check('copyTranslationSkill copies current #translationSkill text to clipboard', clipBuffer === 'راهنمای کوتاه');
    $('translationPreviewCancel').click();
    window.fetch = origFetchV380;
  }

  // v3.81: App-only center approval stamp, selection filters, #editorApproveClose, and #editorCancel (exit without saving)
  {
    const origFetchV381 = window.fetch;
    window.fetch = async (url, options = {}) => {
      const parsed = new URL(url, 'http://127.0.0.1');
      if (/\/api\/projects\/[^/]+\/images\/[^/]+\/content$/.test(parsed.pathname)) {
        return { ok: true, blob: async () => new window.Blob() };
      }
      if (/\/api\/projects\/[^/]+\/images\/[^/]+\/(rendered|revert)$/.test(parsed.pathname)) {
        return jsonResponse({ ok: true });
      }
      return origFetchV381(url, options);
    };
    vm.runInContext(`
      state.project.images = [
        { id: 'img1', name: 'page-1.png', file: 'img1.png', width: 200, height: 300, order: 0, selected: true, approved: false, edited: false, blocks: [{ id: 1, text: 'HELLO', tr: 'سلام اصلی', x0: 10, y0: 10, x1: 120, y1: 60, enabled: true, bg: 'white' }] },
        { id: 'img2', name: 'page-2.png', file: 'img2.png', width: 200, height: 300, order: 1, selected: true, approved: false, edited: false, blocks: [{ id: 1, text: 'WORLD', tr: 'جهان', x0: 10, y0: 10, x1: 120, y1: 60, enabled: true, bg: 'white' }] }
      ];
      renderGrid();
    `, context);
    check('unapproved cards start without .approval-stamp and summary shows 0 از 2 تأیید شده', $('grid').querySelectorAll('.approval-stamp').length === 0 && $('selectionSummary').textContent.includes('0 از 2 تأیید شده'));

    // Per-card approve button toggles center stamp without outer green card border
    const card1ApproveBtn = $('grid').querySelector('.item[data-id="img1"] .act .approve-mark');
    card1ApproveBtn.click();
    await sleep(20);
    check(
      'clicking per-card ✓ button renders .approval-stamp inside .tw-shell and updates summary to 1 از 2 تأیید شده',
      !!$('grid').querySelector('.item[data-id="img1"] .tw-shell .approval-stamp') &&
      $('grid').querySelector('.item[data-id="img1"] .approval-stamp').textContent.includes('تأیید شد') &&
      $('selectionSummary').textContent.includes('1 از 2 تأیید شده'),
    );

    // Select only approved / only unapproved
    $('selectApprovedBtn').click();
    check('selectApprovedBtn selects only approved pages', vm.runInContext('state.project.images[0].selected === true && state.project.images[1].selected === false', context));
    $('selectUnapprovedBtn').click();
    check('selectUnapprovedBtn selects only unapproved pages', vm.runInContext('state.project.images[0].selected === false && state.project.images[1].selected === true', context));

    // Editor #editorApproveClose saves edits + sets approved=true + closes editor
    await vm.runInContext("openEditor('img2')", context);
    vm.runInContext("state.project.images[1].blocks[0].tr = 'جهان ویرایش‌شده'; scheduleSave();", context);
    $('editorApproveClose').click();
    await sleep(30);
    check(
      '#editorApproveClose saves changes, marks page approved, and closes #editorDialog',
      !$('editorDialog').open &&
      vm.runInContext("state.project.images[1].approved === true && state.project.images[1].blocks[0].tr === 'جهان ویرایش‌شده'", context) &&
      $('grid').querySelectorAll('.approval-stamp').length === 2,
    );

    // Editor #editorCancel discards edits made during session (even after scheduleSave/auto-save!) and restores previous state
    await vm.runInContext("openEditor('img1')", context);
    check('opening an approved page shows #editorUnapproveBtn and approved badge in #editorTitle', !$('editorUnapproveBtn').classList.contains('hidden') && $('editorTitle').textContent.includes('تأییدشده'));
    vm.runInContext("state.project.images[0].blocks[0].tr = 'تغییر اشتباهی که نباید بماند'; state.project.images[0].blocks[0].tx0 = 77; state.project.images[0].approved = false; scheduleSave();", context);
    await sleep(20);
    $('editorCancel').click();
    await sleep(30);
    check(
      '#editorCancel discards session text/geometry/approval edits and restores exact pre-open snapshot',
      !$('editorDialog').open &&
      vm.runInContext("state.project.images[0].blocks[0].tr === 'سلام اصلی' && state.project.images[0].blocks[0].tx0 === undefined && state.project.images[0].approved === true", context),
    );

    // v3.82: Categorized icon-capsule groups, status pills, iconized dock, and toggleable drag guide popover
    check(
      'main toolbar renders 4 categorized .action-group capsules with SVG icons and 3 summary pills',
      window.document.querySelectorAll('.selection-actions .action-group').length === 4 &&
      window.document.querySelectorAll('.selection-actions .action-group svg.btn-ico').length >= 11 &&
      $('selectionSummary').querySelectorAll('.summary-pill').length === 3 &&
      window.document.querySelectorAll('#dock svg.btn-ico').length >= 6,
    );
    $('dragGuideBtn').click();
    check('clicking #dragGuideBtn opens .drag-guide-wrap popover with aria-expanded=true', $('dragGuideBtn').closest('.drag-guide-wrap').classList.contains('is-open') && $('dragGuideBtn').getAttribute('aria-expanded') === 'true');
    window.document.body.click();
    check('clicking outside closes .drag-guide-wrap popover cleanly', !$('dragGuideBtn').closest('.drag-guide-wrap').classList.contains('is-open') && $('dragGuideBtn').getAttribute('aria-expanded') === 'false');

    // v3.83: Categorized icon capsules inside #editorDialog header, #inlineEditor zoom/actions/box-ops, and sidebar block cards
    await vm.runInContext("openEditor('img1')", context);
    check(
      '#editorDialog organizes top header into 2 capsules, box-ops into merge/split + 4 layout sub-capsules, and preserves SVG icons across dynamic label updates',
      window.document.querySelectorAll('#editorDialog > .dialog-head .editor-head-group').length === 2 &&
      window.document.querySelectorAll('#inlineEditor .inline-box-layout-tools .box-sub-group').length === 4 &&
      window.document.querySelectorAll('#editorDialog svg.btn-ico').length >= 22 &&
      !!$('editorImageFullscreen').querySelector('svg.btn-ico') &&
      !!$('inlinePreview').querySelector('svg.btn-ico') &&
      $('blockList').querySelectorAll('.block-card-actions svg.btn-ico').length >= 3,
    );
    $('editorCancel').click();
    await sleep(20);
    window.fetch = origFetchV381;
  }

  const closeBeaconsBefore = beacons.filter((entry) => entry.url === '/api/session/close').length;
  window.dispatchEvent(new window.Event('beforeunload'));
  window.dispatchEvent(new window.Event('pagehide'));
  check('browser close sends exactly one close beacon', beacons.filter((entry) => entry.url === '/api/session/close').length === closeBeaconsBefore + 1);
  check('closing the tab stops its heartbeat timer', await vm.runInContext('sessionTimer === null && sessionCloseSent', context));
  window.close();
  if (failures) process.exitCode = 1;
})().catch((error) => { console.error(error); window.close(); process.exitCode = 1; });
