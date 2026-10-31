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
  if (pathname === `/api/projects/${project.id}/ocr`) { ocrRequests.push(JSON.parse(options.body)); if (ocrGate) await ocrGate; return jsonResponse(overlayProject('NEW OCR', '')); }
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
    if (translationGate) await translationGate;
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
    exportRequests.push(JSON.parse(options.body));
    return { ok: true, status: 200, headers: { get: () => 'attachment; filename="mixed.zip"' }, blob: async () => new window.Blob(['zip']) };
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
window.Typeset = {
  blockStyle(block) { return { dir: block.dir === 'ltr' ? 'ltr' : 'rtl', align: block.align || 'right', bold: true, italic: false, underline: false, size: 12, color: null }; },
  hasInlineMarks() { return false; },
  richHtmlWords() { return []; },
  render(bitmap, blocks) {
    canvasRenderCount += 1;
    renderedBlocks = blocks;
    return { width: 320, height: 200, toBlob(callback) { callback(new window.Blob(['png'], { type: 'image/png' })); } };
  },
};

for (const file of ['groups.js', 'rich-sanitize.js', 'rich-editor.js', 'app.js']) {
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
  window.confirm = () => false;
  check('vertical-only draft is protected when declining discard', vm.runInContext('closeInlineEditor()', context) === false && !$('inlineEditor').classList.contains('hidden'));
  window.confirm = () => true; $('inlineVerticalAlign').value = 'middle';
  vm.runInContext("state.project.images[0].blocks[0].verticalAlign = 'bottom'", context);
  check('a concurrent vertical placement edit is not overwritten', vm.runInContext('applyInlineEditor()', context) === false && $('inlineEditorField').isConnected);
  vm.runInContext('delete state.project.images[0].blocks[0].verticalAlign', context);
  const editorField = $('inlineEditorField'); editorField.textContent = 'CORRECTED OCR'; editorField.dispatchEvent(new window.Event('input', { bubbles: true }));
  vm.runInContext('applyInlineEditor()', context);
  check('the single popup updates OCR without changing translation', vm.runInContext("state.project.images[0].blocks[0].text === 'CORRECTED OCR' && state.project.images[0].blocks[0].tr === 'سلام دنیا'", context));
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
  check('zoom controls float directly over the translation editing image', window.document.querySelector('.editor-view > .editor-zoom-floating')?.contains($('editorZoomIn')) && /\.editor-zoom-floating\{[^}]*position:absolute/.test(css));
  $('editorZoomIn').click();
  check('zoom control scales image and overlays without changing saved geometry', vm.runInContext('state.editorScale', context) === 1.25 && $('editorStage').style.width === '400px' && $('editorZoomLabel').textContent === '125٪' && JSON.stringify(geometry()) === beforeZoom);
  const beforeWheelZoom = vm.runInContext('state.editorScale', context);
  const wheel = new window.WheelEvent('wheel', { deltaY: -100, ctrlKey: false, bubbles: true, cancelable: true, clientX: 50, clientY: 50 });
  editorPreview.dispatchEvent(wheel);
  check('mouse wheel zooms the translation editing image without a modifier', vm.runInContext('state.editorScale', context) > beforeWheelZoom && wheel.defaultPrevented);
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
  check('translation shows a live progress dialog and activity while pending', $('translationDialog').open && $('translationStatus').textContent.includes('ترجمه') && $('translationActivityLog').textContent.includes('ترجمه') && $('translationProgress').style.width !== '0%');
  activityFeed = { entries: [{ id: 500, message: 'ترجمهٔ مشترک تصویر 1 از 2 در حال انجام است', kind: 'info', progress: 0.5, time: new Date().toISOString() }], next: 500 };
  await vm.runInContext('pollActivity()', context);
  check('server translation progress updates the visible dialog percentage', $('translationStatus').textContent.includes('تصویر 1 از 2') && $('translationProgress').style.width === '50%' && $('translationActivityLog').textContent.includes('تصویر 1 از 2'));
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

  window.dispatchEvent(new window.Event('pagehide'));
  check('closing a tab sends a close beacon', beacons.some((entry) => entry.url === '/api/session/close'));
  window.close();
  if (failures) process.exitCode = 1;
})().catch((error) => { console.error(error); window.close(); process.exitCode = 1; });
