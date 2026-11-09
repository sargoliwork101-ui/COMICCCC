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
let renderedOptions = null;
let canvasRenderCount = 0;
let renderedUploads = 0;
let saveGate = null;
const stateSaveRequests = [];
const ocrRequests = [];
let projectGetCount = 0;
const exportRequests = [];
const jobCancelRequests = [];
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
let mockLicensePwd = '';
let mockLicenseState = {
  licensed: true,
  unlocked: true,
  reason: 'ok',
  message: '',
  hardwareId: 'CS4-ABCD-EFGH-2345-6789',
  passwordEnabled: false,
  license: {
    holder: 'کاربر آزمایشی',
    plan: 'lifetime',
    planLabel: 'دائمی (مادام‌العمر)',
    issuedAt: 1793491200,
    expiresAt: null,
    daysTotal: null,
    daysRemaining: null,
    licenseId: 'lic001',
  },
};
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
  if (pathname === '/api/license/status') return jsonResponse(mockLicenseState);
  if (pathname === '/api/license/activate' && options.method === 'POST') {
    const req = JSON.parse(options.body || '{}');
    if (!String(req.license_key || '').startsWith('CLIC1.')) return jsonResponse({ detail: 'کلید لایسنس معتبر نیست.' }, 400);
    if (req.reset_local_password) { mockLicensePwd = ''; mockLicenseState.passwordEnabled = false; }
    mockLicenseState = { ...mockLicenseState, licensed: true, unlocked: true, reason: 'ok', message: '' };
    return jsonResponse(mockLicenseState);
  }
  if (pathname === '/api/license/login' && options.method === 'POST') {
    const req = JSON.parse(options.body || '{}');
    if (mockLicensePwd && req.password !== mockLicensePwd) return jsonResponse({ detail: 'رمز ورود اشتباه است.', code: 'WRONG_PASSWORD' }, 401);
    mockLicenseState = { ...mockLicenseState, unlocked: true, reason: 'ok', message: '' };
    return jsonResponse(mockLicenseState);
  }
  if (pathname === '/api/license/logout' && options.method === 'POST') {
    mockLicenseState = { ...mockLicenseState, unlocked: !mockLicenseState.passwordEnabled, reason: mockLicenseState.passwordEnabled ? 'login_required' : 'ok' };
    return jsonResponse(mockLicenseState);
  }
  if (pathname === '/api/license/password' && options.method === 'PUT') {
    const req = JSON.parse(options.body || '{}');
    if (mockLicensePwd && req.current_password !== mockLicensePwd) return jsonResponse({ detail: 'رمز فعلی نادرست است.' }, 400);
    mockLicensePwd = String(req.new_password || '');
    mockLicenseState = { ...mockLicenseState, passwordEnabled: Boolean(mockLicensePwd), unlocked: true };
    return jsonResponse(mockLicenseState);
  }
  if (pathname === '/api/projects' && (!options.method || options.method === 'GET')) return jsonResponse([summary]);
  if (pathname === '/api/projects' && options.method === 'POST') return jsonResponse(project, 201);
  if (pathname === '/api/jobs/cancel' && options.method === 'POST') {
    jobCancelRequests.push(JSON.parse(options.body || '{}'));
    return jsonResponse({ ok: true, kind: JSON.parse(options.body || '{}').kind || 'all', cancelledCount: 1 });
  }
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
  blockStyle(block) { return { dir: block.dir === 'ltr' ? 'ltr' : 'rtl', align: block.align || 'right', bold: block.bold !== false, italic: !!block.italic, underline: false, size: 12, color: null, firstLineIndent: Number(block.firstLineIndent) || 0, hangingIndent: Number(block.hangingIndent) || 0 }; },
  indentGeometry: realTypeset.indentGeometry,
  hasInlineMarks: realTypeset.hasInlineMarks,
  inlineMarksToHtml: realTypeset.inlineMarksToHtml,
  hasActiveWatermark: realTypeset.hasActiveWatermark,
  drawWatermark: realTypeset.drawWatermark,
  richHtmlWords(html) { return String(html || '').includes('<hr>') ? [{ t: '────────' }] : []; },
  render(bitmap, blocks, opts) {
    canvasRenderCount += 1;
    renderedBlocks = blocks;
    renderedOptions = opts || null;
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
    check('inline editor stays permanently visible and enabled in idle state on openEditor', !$('inlineEditor').classList.contains('hidden') && $('inlineEditor').classList.contains('is-idle') && $('inlineEditorSize').disabled === false);
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

    // v4.29: the "لغو" buttons must really stop the running work (server-side preemption), and every
    // long-running dialog now exposes its own visible cancel button.
    check('export, editor and OCR-quick cancel buttons exist for in-flight work', Boolean($('cancelExportBtn')) && Boolean($('editorCancelJobBtn')) && Boolean($('ocrQuickCancelBtn')));
    check('cancel buttons start hidden and are only shown while their job runs', $('cancelExportBtn').classList.contains('hidden') && $('editorCancelJobBtn').classList.contains('hidden'));
    jobCancelRequests.length = 0;
    let releaseOcr2; ocrGate = new Promise((r) => { releaseOcr2 = r; });
    $('ocrBtn').click();
    $('startOcrBtn').click();
    await new Promise((r) => setTimeout(r, 20));
    $('ocrDialog').querySelector('.dialog-head button').click();
    await new Promise((r) => setTimeout(r, 20));
    check('the stop confirmation focuses the "بله، متوقف شود" button so Enter confirms it', $('appModalDialog').open === true && window.document.activeElement === $('appModalConfirm') && $('appModalConfirm').textContent.includes('متوقف'));
    $('appModalConfirm').click();
    await new Promise((r) => setTimeout(r, 25));
    check('confirming OCR cancel asks the server to stop the running job immediately', jobCancelRequests.some((entry) => entry.kind === 'ocr'));
    releaseOcr2(); ocrGate = null;

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
        mockCatalog = mockCatalog.map((item) => item.id === 'olmocr' ? { ...item, runtimeInstalled: true, modelReady: true, readyLanguages: [body.language || 'eng'], installedVersion: '0.4.29' } : item);
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

  // v3.71 / v4.02 / v4.15: Interactive section-by-section Help Center (#helpDialog, #helpTopBtn, F1, 15 sections, search, examples)
  {
    check('all 15 Help sections include practical examples and untranslated terms', window.ComicHelpGuide.HELP_SECTIONS.length === 15 && window.ComicHelpGuide.HELP_SECTIONS.every((s) => s.example && s.example.title.includes('مثال عملی') && s.example.body.length > 60 && s.features?.length >= 3 && s.steps?.length >= 3));
    $('helpTopBtn').click();
    check('clicking topbar Help button opens #helpDialog with 15 chapter nav items', $('helpDialog').open === true && window.document.querySelectorAll('#helpNavList .help-nav-item').length === 15);
    check('chapter mode renders active chapter with practical example box', window.document.querySelectorAll('#helpContentArea .help-article').length === 1 && $('helpContentArea').textContent.includes('مثال عملی'));
    $('helpViewAllBtn').click();
    check('view-all mode renders all 15 sections simultaneously', window.document.querySelectorAll('#helpContentArea .help-article').length === 15);
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

    // v3.83/v3.84: Categorized icon capsules inside #editorDialog header (with no oversized select control), #inlineEditor zoom/actions/box-ops, sidebar block cards, and #newProjectBtn name prompt
    await vm.runInContext("openEditor('img1')", context);
    check(
      '#editorDialog organizes top header into 2 uniform capsules without .overlay-mode-control select, box-ops into merge/split + 4 layout sub-capsules, and preserves SVG icons across dynamic label updates',
      window.document.querySelectorAll('#editorDialog > .dialog-head .editor-head-group').length === 2 &&
      !window.document.querySelector('#editorDialog > .dialog-head select') &&
      !window.document.querySelector('#editorDialog .overlay-mode-control') &&
      window.document.querySelectorAll('#inlineEditor .inline-box-layout-tools .box-sub-group').length === 4 &&
      window.document.querySelectorAll('#editorDialog svg.btn-ico').length >= 21 &&
      !!$('editorImageFullscreen').querySelector('svg.btn-ico') &&
      !!$('inlinePreview').querySelector('svg.btn-ico') &&
      $('blockList').querySelectorAll('.block-card-actions svg.btn-ico').length >= 3,
    );
    $('editorCancel').click();
    await sleep(20);

    let createdProjectPayload = null;
    const prevFetchForNewProj = window.fetch;
    window.fetch = async (url, opts = {}) => {
      if (String(url).endsWith('/api/projects') && String(opts.method || 'GET').toUpperCase() === 'POST') {
        createdProjectPayload = JSON.parse(opts.body || '{}');
        return {
          ok: true,
          status: 201,
          headers: new Map([['content-type', 'application/json']]),
          text: async () => JSON.stringify({ id: 'proj-v384', name: createdProjectPayload.name || 'پروژهٔ کمیک', images: [], settings: { overlayMode: 'translation' } }),
          json: async () => ({ id: 'proj-v384', name: createdProjectPayload.name || 'پروژهٔ کمیک', images: [], settings: { overlayMode: 'translation' } }),
        };
      }
      return prevFetchForNewProj(url, opts);
    };
    $('newProjectBtn').click();
    await sleep(20);
    check('clicking #newProjectBtn opens #appModalDialog with visible #appModalInput asking for project name', $('appModalDialog').open && !$('appModalInputWrap').classList.contains('hidden'));
    $('appModalCancel').click();
    await sleep(20);
    check('cancelling #newProjectBtn prompt does not create a project', !$('appModalDialog').open && createdProjectPayload === null);
    $('newProjectBtn').click();
    await sleep(20);
    $('appModalInput').value = 'بتمن سال اول';
    $('appModalInput').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(40);
    check('entering a custom project name and pressing Enter creates the new project with that exact name', createdProjectPayload?.name === 'بتمن سال اول' && $('projectName').value === 'بتمن سال اول' && $('exportName').value === 'بتمن سال اول');

    // v3.85: async image decoding, multi-core browser render concurrency, cross-vendor GPU/CPU summary, and adaptive activity polling
    vm.runInContext(`
      state.project.images = [
        { id: 'v385-1', name: 'p1.png', file: 'p1.png', width: 320, height: 200, format: 'PNG', order: 0, selected: true, approved: false, edited: false, blocks: [] },
        { id: 'v385-2', name: 'p2.png', file: 'p2.png', width: 320, height: 200, format: 'PNG', order: 1, selected: true, approved: false, edited: false, blocks: [] },
      ];
      renderGrid();
    `, context);
    const firstGridImg = $('grid').querySelector('img');
    check('grid thumbnail images enable both lazy loading and off-main-thread async decoding', firstGridImg?.loading === 'lazy' && firstGridImg?.decoding === 'async');
    const conc8 = vm.runInContext('browserRenderConcurrency(8)', context);
    check('browserRenderConcurrency bounds parallel canvas renders between 2 and 4 workers', conc8 >= 2 && conc8 <= 4);
    const amdSummary = vm.runInContext(`
      engineHardwareSummary = { hasNvidiaGpu: false, hasGpu: true, gpuBackend: 'directml', gpuName: 'AMD Radeon RX 7800', cpuCores: 12, freeDiskGb: 45 };
      formatHardwareSummary();
    `, context);
    check('formatHardwareSummary reports DirectML GPU acceleration and CPU core count', amdSummary.includes('DirectML') && amdSummary.includes('AMD Radeon RX 7800') && amdSummary.includes('12 هسته'));

    // v3.86: project-name <-> export-name synchronization with user override, RFC 5987 UTF-8 filename decoding, and regular non-bold translation default
    $('projectName').value = 'کمیک بتمن جلد ۲';
    $('projectName').dispatchEvent(new window.Event('input', { bubbles: true }));
    $('projectName').dispatchEvent(new window.Event('change', { bubbles: true }));
    check('renaming project updates #exportName automatically while export filename is not customized', $('exportName').value === 'کمیک بتمن جلد ۲' && vm.runInContext('state.project.settings.output.nameCustomized === false', context));

    $('exportName').value = 'خروجی-دلخواه-کاربر';
    $('exportName').dispatchEvent(new window.Event('input', { bubbles: true }));
    $('exportName').dispatchEvent(new window.Event('change', { bubbles: true }));
    $('projectName').value = 'کمیک بتمن جلد ۳';
    $('projectName').dispatchEvent(new window.Event('input', { bubbles: true }));
    $('projectName').dispatchEvent(new window.Event('change', { bubbles: true }));
    check('editing #exportName marks nameCustomized=true and preserves custom export name across project renames', $('exportName').value === 'خروجی-دلخواه-کاربر' && vm.runInContext('state.project.settings.output.nameCustomized === true', context));

    $('exportName').value = '   ';
    $('exportName').dispatchEvent(new window.Event('change', { bubbles: true }));
    check('clearing #exportName falls back cleanly to current project name and resets nameCustomized=false', $('exportName').value === 'کمیک بتمن جلد ۳' && vm.runInContext('state.project.settings.output.nameCustomized === false', context));

    const decodedPersianName = vm.runInContext(`parseExportFilename("attachment; filename=\\"fallback.pdf\\"; filename*=utf-8''%DA%A9%D9%85%DB%8C%DA%A9%20%DB%B1.pdf", "fallback.pdf")`, context);
    check('parseExportFilename prefers RFC 5987 UTF-8 filename* over ASCII fallback', decodedPersianName === 'کمیک ۱.pdf');

    const nonBoldDefault = vm.runInContext(`
      (() => {
        const b = { id: 99, text: 'Hi', bold: true };
        applyTranslatedBlockDefaults(b, 'سلام');
        return b.bold === false && b.tr === 'سلام' && Typeset.blockStyle(b).bold === false;
      })()
    `, context);
    check('applyTranslatedBlockDefaults sets regular non-bold weight (bold: false) on placed translations', nonBoldDefault === true);

    // v3.87: openEditor rolls back state.editorId / editorSessionSnapshot and closes #editorDialog if image fetch fails
    window.fetch = async (url, init) => {
      if (String(url).includes('/images/')) return { ok: false, status: 500, blob: async () => new Blob([]) };
      return origFetchV381(url, init);
    };
    let openFailed = false;
    try {
      await vm.runInContext("openEditor(state.project.images[0].id)", context);
    } catch {
      openFailed = true;
    }
    check('openEditor cleans up state and closes dialog on image load failure',
      openFailed && !$('editorDialog').open && vm.runInContext('state.editorId === null && editorSessionSnapshot === null', context));
    check('#downloadLink keeps its svg.btn-ico child', !!$('downloadLink').querySelector('svg.btn-ico'));
    window.fetch = origFetchV381;

    // v3.88: imageUrl includes version cache-buster for cropped thumbnails & cropReset/cropApply guard missing cropItem
    const cropCacheCheck = vm.runInContext(`
      (() => {
        const img = state.project.images[0];
        imagePreviewVersions.set(state.project.id + ':' + img.id, 42);
        const croppedUrl = imageUrl(img, false, true);
        const rawUrl = imageUrl(img, false, false);
        state.cropId = 'non-existent-id';
        $('cropReset').click();
        $('cropApply').click();
        return croppedUrl.includes('cropped=true') && croppedUrl.includes('v=42') && !rawUrl.includes('v=');
      })()
    `, context);
    check('cropped imageUrl attaches cache-busting revision while raw content URL stays clean and crop buttons guard missing item', cropCacheCheck === true);

    // v3.89: Heading vs Body role pill toggle in #blockList, proportional heading size, _detectedBold/_detectedItalic preservation, and Typeset.indentGeometry
    const v389Check = vm.runInContext(`
      (() => {
        const hBlk = { id: 10, text: '8.3.5.7.1 Heel Fillet', pageRole: 'heading', lineH: 26, x0: 20, y0: 20, x1: 260, y1: 46, enabled: true };
        const bBlk = { id: 11, text: 'Bold note', pageRole: 'paragraph', lineH: 18, _detectedBold: true, _detectedItalic: true, firstLineIndent: 1.5, enabled: true };
        applyTranslatedBlockDefaults(hBlk, '۸.۳.۵.۷.۱ فیله پاشنه');
        applyTranslatedBlockDefaults(bBlk, 'یادداشت مهم');
        const stFirst = Typeset.blockStyle(bBlk);
        const geomFirst = Typeset.indentGeometry(stFirst, 4, 16);
        const stHang = Typeset.blockStyle({ pageRole: 'list', dir: 'ltr', hangingIndent: 1.5 });
        const geomHang = Typeset.indentGeometry(stHang, 4, 16);

        const img = state.project.images[0];
        state.editorId = img.id;
        img.blocks = [
          { id: 1, text: 'Sample Title', tr: 'عنوان نمونه', pageRole: 'paragraph', lineH: 24, x0: 10, y0: 10, x1: 180, y1: 34, bold: false, italic: true, firstLineIndent: 1.2, enabled: true },
        ];
        buildBlockList();
        const pillBefore = document.querySelector('#blockList .block-role-pill');
        const chipBefore = [...document.querySelectorAll('#blockList .block-style-chip')].map((el) => el.textContent);
        const wasText = pillBefore?.textContent === 'متن' && !pillBefore.classList.contains('is-heading');
        pillBefore?.click();
        const pillAfter = document.querySelector('#blockList .block-role-pill');
        const becameHeading = img.blocks[0].pageRole === 'heading' && img.blocks[0].bold === true && img.blocks[0].size > 12 && pillAfter?.textContent === 'تیتر' && pillAfter.classList.contains('is-heading');
        pillAfter?.click();
        const reverted = img.blocks[0].pageRole === 'paragraph' && img.blocks[0].bold === false && img.blocks[0].size === 12;
        state.editorId = null;

        return hBlk.size === Math.round(26 * 0.78) && hBlk.bold === true
          && bBlk.size === 12 && bBlk.bold === true && bBlk.italic === true
          && geomFirst.textIndentPx === 24 && geomFirst.padLeft === 4
          && geomHang.textIndentPx === -24 && geomHang.padLeft === 28
          && wasText && chipBefore.includes('I') && chipBefore.includes('↳ تورفتگی') && becameHeading && reverted;
      })()
    `, context);
    check('v3.89 role pill toggles تیتر/متن with proportional size, preserves detected bold/italic, and computes shared indent/hanging geometry', v389Check === true);

    const v393UiCheck = vm.runInContext(`
      (() => {
        state.engines = [
          { id: 'rapidocr-v6', name: 'PP-OCRv6 Small', selectable: true, runtimeInstalled: true, languages: ['eng'], readyLanguages: ['eng'], description: 'fast', family: 'Paddle' },
          { id: 'hezar-ocr', name: 'Hezar Persian OCR', selectable: true, isolated: true, runtimeInstalled: true, languages: ['fas'], readyLanguages: ['fas'], description: 'persian', family: 'Hezar' },
          { id: 'easyocr', name: 'EasyOCR', selectable: true, runtimeInstalled: true, languages: ['eng', 'fas', 'kor'], readyLanguages: ['eng', 'fas'], description: 'scene', family: 'CRAFT' },
          { id: 'tesseract', name: 'Tesseract 5 LSTM', selectable: true, runtimeInstalled: true, languages: ['eng', 'fas'], readyLanguages: ['eng', 'fas'], description: 'doc', family: 'Tesseract' },
        ];
        $('ocrPageMode').value = 'comic';
        $('ocrLanguage').value = 'fas';
        $('ocrLanguage').dispatchEvent(new Event('change', { bubbles: true }));
        const tier = (id) => document.querySelector('#ocrEngine option[value="' + id + '"]')?.dataset.suitability;
        const comicOk = tier('hezar-ocr') === 'best' && tier('easyocr') === 'best' && tier('tesseract') === 'weak' && tier('rapidocr-v6') === 'weak' && $('ocrEngine').value === 'hezar-ocr';
        $('ocrPageMode').value = 'document';
        $('ocrPageMode').dispatchEvent(new Event('change', { bubbles: true }));
        const docOk = tier('hezar-ocr') === 'best' && tier('tesseract') === 'best' && tier('easyocr') === 'weak';
        $('modelsLanguage').value = 'fas';
        $('modelsPageMode').value = 'document';
        renderModels();
        const cardTiers = Object.fromEntries([...document.querySelectorAll('#engineCards .engine-card')].map((c) => [c.querySelector('h3')?.textContent, c.dataset.suitability]));
        const modelsOk = cardTiers['Hezar Persian OCR'] === 'best' && cardTiers['Tesseract 5 LSTM'] === 'best' && cardTiers['EasyOCR'] === 'weak' && cardTiers['PP-OCRv6 Small'] === 'weak';
        const targetLangHasFaFirst = $('translationTargetLang')?.options?.[0]?.value === 'fa' && [...$('translationTargetLang').options].some((o) => o.value === 'en');
        $('ocrLanguage').value = 'eng';
        $('ocrPageMode').value = 'comic';
        updateEngineOptions('rapidocr-v6');
        return comicOk && docOk && modelsOk && targetLangHasFaFirst;
      })()
    `, context);
    check('v3.93 Persian OCR language, Hezar engine, 2D (language + pageMode) green/yellow/red suitability, and translation target language menu work in UI', v393UiCheck === true);

    const v394ExecUiCheck = vm.runInContext(`
      (() => {
        renderModels();
        updateEngineOptions('rapidocr-v6');
        const allCardsDescribeLocal = [...document.querySelectorAll('#engineCards .engine-card')].every((c) => {
          const desc = c.querySelector('p')?.textContent || '';
          const noNoisyTitleChip = !c.querySelector('.engine-chip.is-exec-local');
          return c.dataset.executionMode === 'local' && noNoisyTitleChip && desc.includes('روی سیستم') && !desc.includes('💻');
        });
        const cleanDropdownNames = [...$('ocrEngine').options].every((o) => {
          const eng = state.engines.find((e) => e.id === o.value);
          const validIcon = ['✓', '◐', '⬇'].some((ico) => o.textContent === ico + ' ' + (eng ? eng.name : ''));
          return eng && validIcon && !o.textContent.includes('💻') && !o.textContent.includes('عالی');
        });
        const ocrDescOk = $('ocrEngine')?.dataset.executionMode === 'local' && $('ocrEngineStatus')?.textContent.includes('روی سیستم') && !$('ocrEngineStatus')?.textContent.includes('💻');

        showAiProvider('free', false);
        const freeOnlineOk = $('aiExecBadge')?.dataset.execMode === 'online' && $('aiExecBanner')?.dataset.execMode === 'online' && $('aiExecBanner')?.textContent.includes('آنلاین');

        showAiProvider('openai', false);
        $('aiBaseUrl').value = 'https://api.openai.com/v1';
        $('aiBaseUrl').dispatchEvent(new Event('input', { bubbles: true }));
        const remoteOpenaiOnline = $('aiExecBadge')?.dataset.execMode === 'online' && $('aiExecBanner')?.dataset.execMode === 'online';

        $('aiBaseUrl').value = 'http://localhost:11434/v1';
        $('aiBaseUrl').dispatchEvent(new Event('input', { bubbles: true }));
        const localOllamaLocal = $('aiExecBadge')?.dataset.execMode === 'local' && $('aiExecBanner')?.dataset.execMode === 'local' && $('aiExecBanner')?.textContent.includes('روی سیستم');

        state.ai.providers = state.ai.providers || {};
        state.ai.providers.openai = { label: 'OpenAI', model: 'qwen2.5:7b', base_url: 'http://127.0.0.1:11434/v1', profiles: [{ id: 'loc-1', name: 'Ollama', hasApiKey: true }] };
        renderTranslationServiceSelector('openai', '');
        const openaiOpt = [...$('translationPreviewService').options].find((o) => o.value === 'openai');
        const freeOpt = [...$('translationPreviewService').options].find((o) => o.value === 'free');
        const previewSelectOk = openaiOpt?.dataset.executionMode === 'local' && !openaiOpt.textContent.includes('💻') && freeOpt?.dataset.executionMode === 'online';

        showAiProvider('free', false);
        return allCardsDescribeLocal && cleanDropdownNames && ocrDescOk && freeOnlineOk && remoteOpenaiOnline && localOllamaLocal && previewSelectOk;
      })()
    `, context);
    check('v3.94/v3.98 keeps dropdown options name-only (no 💻 or عالی clutter) while describing On-System vs Online execution in descriptions', v394ExecUiCheck === true);

    const v395DownloadSizeUiCheck = await vm.runInContext(`
      (() => {
        const prevEngines = state.engines;
        state.engines = [
          {
            id: 'rapidocr-v6',
            name: 'PP-OCRv6 Small',
            family: 'RapidOCR / ONNX',
            description: 'fast',
            languages: ['eng'],
            selectable: true,
            category: 'standard',
            executionMode: 'local',
            runtimeInstalled: false,
            modelReady: false,
            readyLanguages: [],
            downloadSizeGb: 0.06,
            weightsDownloadGb: 0.015,
            runtimeDownloadGb: 0.070,
            fullDownloadSizeGb: 0.085,
            totalDownloadGb: 0.085,
          },
          {
            id: 'glm-ocr',
            name: 'GLM-OCR',
            family: 'GLM-V / Transformers',
            description: 'vlm',
            languages: ['eng', 'fas'],
            selectable: true,
            isolated: true,
            category: 'advanced',
            executionMode: 'local',
            runtimeInstalled: false,
            modelReady: false,
            readyLanguages: [],
            downloadSizeGb: 2.4,
            weightsDownloadGb: 1.9,
            runtimeDownloadGb: 2.85,
            fullDownloadSizeGb: 4.75,
            totalDownloadGb: 4.75,
          },
          {
            id: 'tesseract',
            name: 'Tesseract',
            family: 'Tesseract OCR',
            description: 'doc',
            languages: ['eng', 'fas'],
            selectable: true,
            category: 'standard',
            executionMode: 'local',
            runtimeInstalled: true,
            modelReady: true,
            readyLanguages: ['eng'],
            downloadSizeGb: 0.09,
            weightsDownloadGb: 0.015,
            runtimeDownloadGb: 0.075,
            perLanguageDownloadGb: 0.015,
            fullDownloadSizeGb: 0.09,
            totalDownloadGb: 0.015,
          },
        ];
        try {
          $('ocrLanguage').value = 'eng';
          updateEngineOptions('glm-ocr');
          const glmOptText = document.querySelector('#ocrEngine option[value="glm-ocr"]')?.textContent || '';
          const statusText = $('ocrEngineStatus')?.textContent || '';
          const quickBtnText = $('ocrQuickPrepareBtn')?.textContent || '';

          renderModels();
          const glmCard = [...document.querySelectorAll('#engineCards .engine-card')].find((el) => el.querySelector('h3')?.textContent === 'GLM-OCR');
          const glmPrepBtn = [...(glmCard?.querySelectorAll('.card-buttons button') || [])].find((b) => b.textContent.includes('آماده‌سازی'));

          // Switch to Persian on installed Tesseract where only fas.traineddata (~15 MB) needs downloading
          $('ocrLanguage').value = 'fas';
          updateEngineOptions('tesseract');
          const tessQuickBtn = $('ocrQuickPrepareBtn')?.textContent || '';

          return (
            glmOptText === '⬇ GLM-OCR' &&
            statusText.includes('کل حجم دانلود خودکار:') &&
            statusText.includes('پیش‌نیازها:') &&
            quickBtnText.includes('نصب و دانلود خودکار همین مدل (کل حجم دانلود:') &&
            Boolean(glmPrepBtn && glmPrepBtn.textContent.includes('کل حجم دانلود:')) &&
            tessQuickBtn.includes('دانلود خودکار فایل زبان (fas) (کل حجم دانلود: ~15 مگابایت)')
          );
        } finally {
          state.engines = prevEngines;
          $('ocrLanguage').value = 'eng';
          updateEngineOptions();
          renderModels();
        }
      })()
    `, context);
    check('v3.95/v3.98 keeps #ocrEngine option strictly name-only while announcing exact total download size in #ocrEngineStatus, #ocrQuickPrepareBtn, and #modelsDialog buttons', v395DownloadSizeUiCheck === true);

    const v396SortingAndFrozenOrderCheck = await vm.runInContext(`
      (() => {
        const rankMap = { best: 0, medium: 1, weak: 2 };
        const isMonotonicGreenToRed = (tiers) => {
          for (let i = 1; i < tiers.length; i += 1) {
            if ((rankMap[tiers[i]] ?? 1) < (rankMap[tiers[i - 1]] ?? 1)) return false;
          }
          return tiers.length > 0;
        };
        const prevEngines = state.engines;
        state.engines = [
          { id: 'tesseract', name: 'Tesseract 5 LSTM', family: 'Tesseract', description: 'doc', languages: ['eng', 'fas'], selectable: true, category: 'standard', executionMode: 'local', runtimeInstalled: true, modelReady: true, readyLanguages: ['eng', 'fas'], downloadSizeGb: 0.09 },
          { id: 'rapidocr-v6', name: 'PP-OCRv6 Small', family: 'PaddleOCR', description: 'fast', languages: ['eng', 'jpn', 'chi_sim'], selectable: true, category: 'standard', executionMode: 'local', runtimeInstalled: true, modelReady: true, readyLanguages: ['eng'], downloadSizeGb: 0.03 },
          { id: 'easyocr', name: 'EasyOCR', family: 'JaidedAI', description: 'comic', languages: ['eng', 'fas', 'kor'], selectable: true, category: 'standard', executionMode: 'local', runtimeInstalled: true, modelReady: true, readyLanguages: ['eng', 'fas'], downloadSizeGb: 0.25 },
          { id: 'got-ocr-2', name: 'GOT-OCR 2.0', family: 'StepFun', description: 'vlm', languages: ['eng', 'chi_sim'], selectable: true, isolated: true, category: 'advanced', executionMode: 'local', runtimeInstalled: false, modelReady: false, readyLanguages: [], downloadSizeGb: 1.5 },
          { id: 'surya', name: 'Surya', family: 'Datalab', description: 'layout', languages: ['eng', 'fas'], selectable: true, isolated: true, category: 'advanced', executionMode: 'local', runtimeInstalled: true, modelReady: true, readyLanguages: ['eng', 'fas'], downloadSizeGb: 1.4 },
          { id: 'hezar-ocr', name: 'Hezar Persian OCR', family: 'Hezar', description: 'fa', languages: ['fas'], selectable: true, isolated: true, category: 'advanced', executionMode: 'local', runtimeInstalled: false, modelReady: false, readyLanguages: [], downloadSizeGb: 0.2 },
          { id: 'mineru-2-5-pro', name: 'MinerU2.5-Pro', family: 'OpenDataLab', description: 'doc', languages: ['eng', 'chi_sim'], selectable: true, isolated: true, category: 'advanced', executionMode: 'local', runtimeInstalled: false, modelReady: false, readyLanguages: [], downloadSizeGb: 3.1 },
        ];
        try {
          // 1) Check #ocrEngine and #modelsDialog sorting across (eng, comic), (eng, document), (fas, comic), (fas, document)
          const combos = [
            ['eng', 'comic'],
            ['eng', 'document'],
            ['fas', 'comic'],
            ['fas', 'document'],
          ];
          for (const [lang, mode] of combos) {
            $('ocrLanguage').value = lang;
            $('ocrPageMode').value = mode;
            $('ocrLanguage').dispatchEvent(new window.Event('change', { bubbles: true }));
            $('ocrPageMode').dispatchEvent(new window.Event('change', { bubbles: true }));
            const optTiers = [...$('ocrEngine').options].map((o) => o.dataset.suitability);
            if (!isMonotonicGreenToRed(optTiers)) return { ok: false, stage: 'ocrEngine:' + lang + ':' + mode, optTiers };

            $('modelsLanguage').value = lang;
            $('modelsPageMode').value = mode;
            $('modelsLanguage').dispatchEvent(new window.Event('change', { bubbles: true }));
            $('modelsPageMode').dispatchEvent(new window.Event('change', { bubbles: true }));
            const groups = [...$('engineCards').querySelectorAll('.model-group')];
            if (groups.length !== 2) return { ok: false, stage: 'groupCount:' + groups.length };
            for (const g of groups) {
              const cardTiers = [...g.querySelectorAll('.engine-card')].map((c) => c.dataset.suitability);
              if (!isMonotonicGreenToRed(cardTiers)) return { ok: false, stage: 'modelsGroup:' + lang + ':' + mode, cardTiers };
            }
          }

          // 2) Verify ZERO periodic re-sorting during background refreshes (e.g. pollActivity / status updates):
          // Mutate an engine's suitabilityMatrix WITHOUT changing language or pageMode and call renderModels() + updateEngineOptions().
          // Order MUST stay 100% frozen until language or pageMode actually changes!
          $('modelsLanguage').value = 'eng';
          $('modelsPageMode').value = 'comic';
          $('modelsLanguage').dispatchEvent(new window.Event('change', { bubbles: true }));
          $('modelsPageMode').dispatchEvent(new window.Event('change', { bubbles: true }));
          $('ocrLanguage').value = 'eng';
          $('ocrPageMode').value = 'comic';
          $('ocrLanguage').dispatchEvent(new window.Event('change', { bubbles: true }));
          $('ocrPageMode').dispatchEvent(new window.Event('change', { bubbles: true }));

          const beforeCardTitles = [...$('engineCards').querySelectorAll('.engine-card h3')].map((h) => h.textContent);
          const beforeOptIds = [...$('ocrEngine').options].map((o) => o.value);

          // Flip tesseract from weak -> best in memory without changing language or pageMode
          const tess = state.engines.find((e) => e.id === 'tesseract');
          tess.suitabilityMatrix = { eng: { comic: 'best', document: 'best' } };
          tess.isLoadedInRam = true;
          renderModels();
          updateEngineOptions();

          const duringPollCardTitles = [...$('engineCards').querySelectorAll('.engine-card h3')].map((h) => h.textContent);
          const duringPollOptIds = [...$('ocrEngine').options].map((o) => o.value);
          const frozenDuringPoll = JSON.stringify(beforeCardTitles) === JSON.stringify(duringPollCardTitles)
            && JSON.stringify(beforeOptIds) === JSON.stringify(duringPollOptIds);

          // Now explicitly change pageMode -> must resort immediately!
          $('modelsPageMode').value = 'document';
          $('modelsPageMode').dispatchEvent(new window.Event('change', { bubbles: true }));
          const afterModeChangeGroups = [...$('engineCards').querySelectorAll('.model-group')];
          const resortedOnModeChange = afterModeChangeGroups.every((g) =>
            isMonotonicGreenToRed([...g.querySelectorAll('.engine-card')].map((c) => c.dataset.suitability))
          );

          return { ok: frozenDuringPoll && resortedOnModeChange, frozenDuringPoll, resortedOnModeChange };
        } finally {
          state.engines = prevEngines;
          $('ocrLanguage').value = 'eng';
          $('ocrPageMode').value = 'comic';
          $('modelsLanguage').value = 'eng';
          $('modelsPageMode').value = 'comic';
          updateEngineOptions('', { resort: true });
          renderModels({ resort: true });
        }
      })()
    `, context);
    check('v3.96 sorts models Green -> Yellow -> Red on language/pageMode change and keeps order 100% frozen during background refreshes', v396SortingAndFrozenOrderCheck?.ok === true);
  }

  // v3.97: Idle activity polling parks completely (activityPollTimer === null when idle) and resumes only while busy
  {
    const idleTimerState = await vm.runInContext(`
      (() => {
        scheduleActivityPoll(false);
        const idleParked = !isActivityHighRate() && activityPollTimer === null;
        setBusy('در حال پردازش آزمایشی…');
        const activeArmed = isActivityHighRate() && activityPollTimer !== null;
        setBusy('');
        const parkedAgain = !isActivityHighRate() && activityPollTimer === null;
        return { idleParked, activeArmed, parkedAgain };
      })()
    `, context);
    check('v3.97 parks /api/activity polling at zero timers while idle and arms polling only while busy', idleTimerState.idleParked && idleTimerState.activeArmed && idleTimerState.parkedAgain);
  }

  // v3.98: Menu shortcut (#deleteModelsMenuBtn) + Installed-Only filter + custom Persian appConfirm + /uninstall API
  {
    const v398MenuUninstallOk = await vm.runInContext(`
      (async () => {
        const prevEngines = state.engines;
        const origFetch = window.fetch;
        let uninstallCalls = [];
        const baseEng = {
          id: 'rapidocr-v6',
          name: 'PP-OCRv6 Small',
          family: 'RapidOCR',
          description: 'base',
          languages: ['eng'],
          selectable: true,
          category: 'standard',
          runtimeInstalled: true,
          modelReady: true,
          readyLanguages: ['eng'],
          canUninstall: false,
          isBuiltinBase: true,
        };
        const suryaInstalled = {
          id: 'surya',
          name: 'Surya',
          family: 'Surya VLM',
          description: 'layout ocr',
          languages: ['eng', 'fas'],
          selectable: true,
          isolated: true,
          category: 'advanced',
          runtimeInstalled: true,
          modelReady: true,
          readyLanguages: ['eng', 'fas'],
          canUninstall: true,
          isBuiltinBase: false,
        };
        state.engines = [baseEng, suryaInstalled];
        const mockJson = (payload) => ({
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => payload,
        });
        window.fetch = async (url, opts = {}) => {
          const parsed = new URL(url, 'http://127.0.0.1:8765');
          if (parsed.pathname === '/api/engines/surya/uninstall' && opts.method === 'POST') {
            uninstallCalls.push(parsed.pathname);
            return mockJson({
              ok: true,
              engineId: 'surya',
              freedMb: 2150,
              engines: [baseEng, { ...suryaInstalled, runtimeInstalled: false, modelReady: false, readyLanguages: [], canUninstall: false }],
              memory: { processRamMb: 120, workerRamMb: 0, totalRamMb: 120, loadedEngines: [], loadedCount: 0 },
              hardware: { hasNvidiaGpu: false, cpuCores: 8, freeDiskGb: 45.2 },
            });
          }
          if (parsed.pathname === '/api/engines/memory') {
            return mockJson({ processRamMb: 120, workerRamMb: 0, totalRamMb: 120, loadedEngines: [], loadedCount: 0 });
          }
          return origFetch(url, opts);
        };
        try {
          setMenuOpen(true);
          const noDuplicateDeleteMenuBtn = !$('deleteModelsMenuBtn');
          $('modelsBtn').click();
          $('modelsInstalledOnly').checked = true;
          $('modelsInstalledOnly').dispatchEvent(new window.Event('change', { bubbles: true }));
          const filteredChecked = Boolean($('modelsInstalledOnly')?.checked);
          const visibleCardsBefore = [...document.querySelectorAll('#engineCards .engine-card h3')].map((h) => h.textContent);
          const delBtn = document.querySelector('#engineCards .engine-card .engine-delete-btn');
          const hasOnlySurya = visibleCardsBefore.length === 1 && visibleCardsBefore[0] === 'Surya' && Boolean(delBtn);

          // Click delete -> custom #appModalDialog opens, confirm deletion
          delBtn.click();
          await Promise.resolve();
          const modalOpen = Boolean($('appModalDialog')?.open) && $('appModalTitle')?.textContent.includes('Surya');
          $('appModalConfirm').click();
          for (let i = 0; i < 8; i += 1) await Promise.resolve();

          const emptyShownAfterDelete = Boolean(document.querySelector('#engineCards .models-empty-installed'));
          const resultHasFreedGb = ($('modelTestResult')?.textContent || '').includes('گیگابایت فضا آزاد شد');
          $('modelsInstalledOnly').checked = false;
          renderModels();
          closeDialog('modelsDialog');
          return noDuplicateDeleteMenuBtn && filteredChecked && hasOnlySurya && modalOpen && uninstallCalls.length === 1 && emptyShownAfterDelete && resultHasFreedGb;
        } finally {
          window.fetch = origFetch;
          state.engines = prevEngines;
          if ($('modelsInstalledOnly')) $('modelsInstalledOnly').checked = false;
          renderModels();
        }
      })()
    `, context);
    check('v3.98 allows opening installed models from the top menu and deleting an installed OCR model via custom Persian appConfirm', v398MenuUninstallOk === true);
  }

  // v3.99: Per-page OCR + immediate per-page text placement + grid <img> reuse + dialog bitmap release
  {
    const v399PerPageCheck = await vm.runInContext(`
      (async () => {
        const origFetch = window.fetch;
        const prevProject = JSON.parse(JSON.stringify(state.project));
        const sequence = [];
        try {
          state.project.images = [
            { id: 'pg-1', name: 'page-1.png', file: 'pg-1.png', width: 200, height: 120, format: 'PNG', bytes: 100, order: 0, selected: true, approved: false, groupId: null, crop: null, edited: false, blocks: [] },
            { id: 'pg-2', name: 'page-2.png', file: 'pg-2.png', width: 200, height: 120, format: 'PNG', bytes: 100, order: 1, selected: true, approved: false, groupId: null, crop: null, edited: false, blocks: [] },
          ];
          renderGrid();
          const img1Before = document.querySelector('#grid .item[data-id="pg-1"] .tw > img');
          const img2Before = document.querySelector('#grid .item[data-id="pg-2"] .tw > img');
          renderGrid();
          const img1Reused = document.querySelector('#grid .item[data-id="pg-1"] .tw > img') === img1Before
            && document.querySelector('#grid .item[data-id="pg-2"] .tw > img') === img2Before;

          window.fetch = async (url, options = {}) => {
            const u = String(url);
            if (u.endsWith('/state') && options.method === 'PUT') {
              return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => state.project, text: async () => JSON.stringify(state.project) };
            }
            if (u.endsWith('/ocr') && options.method === 'POST') {
              const req = JSON.parse(options.body);
              const pid = req.image_ids[0];
              sequence.push('ocr:' + pid + ':keep=' + String(req.keep_engine_loaded));
              const nextProj = JSON.parse(JSON.stringify(state.project));
              const target = nextProj.images.find((im) => im.id === pid);
              if (target) {
                target.ocrCompleted = true;
                target.edited = false;
                target.blocks = [{ id: 1, text: 'PAGE ' + pid, tr: '', enabled: true, bg: 'white', x0: 10, y0: 10, x1: 150, y1: 45, lineH: 24, dir: 'ltr', align: 'center' }];
              }
              return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => nextProj, text: async () => JSON.stringify(nextProj) };
            }
            if (u.endsWith('/pg-1/rendered') || u.endsWith('/pg-2/rendered')) {
              const pid = u.includes('/pg-1/') ? 'pg-1' : 'pg-2';
              sequence.push('placed:' + pid);
              return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: true }), text: async () => '{"ok":true}' };
            }
            if (u.includes('/images/pg-1/content') || u.includes('/images/pg-2/content')) {
              return origFetch('/api/projects/project-ui/images/image-ui/content');
            }
            return origFetch(url, options);
          };

          $('ocrOnlySelected').checked = true;
          await runOcr();

          // Open and close previewDialog -> previewImage src must be cleared immediately
          openPreview(state.project.images[0]);
          const hadPreviewSrc = Boolean($('previewImage').getAttribute('src'));
          closeDialog('previewDialog');
          const clearedPreviewSrc = !$('previewImage').getAttribute('src');

          return {
            img1Reused,
            sequence: sequence.join(' -> '),
            hadPreviewSrc,
            clearedPreviewSrc,
          };
        } finally {
          window.fetch = origFetch;
          adoptProject(prevProject);
        }
      })()
    `, context);
    check(
      'v3.99 processes multi-page OCR strictly page-by-page (placing text & freeing RAM after page 1 before starting page 2), reuses unchanged grid <img> nodes, and clears dialog bitmaps on close',
      v399PerPageCheck.img1Reused === true
        && v399PerPageCheck.sequence === 'ocr:pg-1:keep=true -> placed:pg-1 -> ocr:pg-2:keep=false -> placed:pg-2'
        && v399PerPageCheck.hadPreviewSrc === true
        && v399PerPageCheck.clearedPreviewSrc === true,
      JSON.stringify(v399PerPageCheck),
    );
  }

  // v4.00: Version 4.00 + Optional Custom Storage & Downloads Directory Settings UI (#storageBtn, #modelsStorageBtn, #storageDialog)
  {
    const v400StorageCheck = await vm.runInContext(`
      (async () => {
        const origFetch = window.fetch;
        const prevProject = state.project;
        const verText = document.querySelector('.topbar .ver')?.textContent || '';
        let putPayload = null;
        let pickCalled = false;
        const mockJson = (payload) => ({
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => payload,
        });
        window.fetch = async (url, opts = {}) => {
          const parsed = new URL(url, 'http://127.0.0.1:8765');
          if (parsed.pathname === '/api/storage-settings' && (!opts.method || opts.method === 'GET')) {
            return mockJson({
              mode: 'default',
              activePath: 'C:\\\\Users\\\\User\\\\.comic-ocr-studio',
              defaultPath: 'C:\\\\Users\\\\User\\\\.comic-ocr-studio',
              customPath: '',
              customActive: false,
              fallbackWarning: '',
              appDir: 'D:\\\\ComicApp\\\\python_app',
              usedBytes: 1500 * 1024 * 1024,
              freeDiskGb: 18.5,
            });
          }
          if (parsed.pathname === '/api/storage-settings/pick-folder' && opts.method === 'POST') {
            pickCalled = true;
            return mockJson({ cancelled: false, path: 'D:\\\\ComicOCRData' });
          }
          if (parsed.pathname === '/api/storage-settings' && opts.method === 'PUT') {
            putPayload = JSON.parse(opts.body || '{}');
            return mockJson({
              storage: {
                mode: 'custom',
                activePath: 'D:\\\\ComicOCRData',
                defaultPath: 'C:\\\\Users\\\\User\\\\.comic-ocr-studio',
                customPath: 'D:\\\\ComicOCRData',
                customActive: true,
                fallbackWarning: '',
                appDir: 'D:\\\\ComicApp\\\\python_app',
                usedBytes: 1500 * 1024 * 1024,
                freeDiskGb: 420.0,
                migratedBytes: 1500 * 1024 * 1024,
                freedSourceBytes: 1500 * 1024 * 1024,
              },
              projects: [{ id: 'projd1', name: 'پروژهٔ منتقل‌شده', updatedAt: '2026-11-07T00:00:00Z', images: 0 }],
              activeProject: {
                id: 'projd1',
                name: 'پروژهٔ منتقل‌شده',
                images: [],
                settings: { ocrEngine: 'rapidocr-v6', ocrLanguage: 'eng', ocrPageMode: 'comic', provider: 'free', targetLanguage: 'fa', output: {} },
              },
              engines: state.engines,
              ai: state.ai,
            });
          }
          if (parsed.pathname.startsWith('/api/projects/') && opts.method === 'PUT') {
            return mockJson(state.project);
          }
          if (parsed.pathname === '/api/engines/memory') {
            return mockJson({ processRamMb: 110, workerRamMb: 0, totalRamMb: 110, loadedEngines: [], loadedCount: 0 });
          }
          return origFetch(url, opts);
        };
        try {
          $('storageBtn').click();
          await new Promise((r) => setTimeout(r, 20));
          const openedOk = $('storageDialog').open === true
            && $('storageActivePath').textContent === 'C:\\\\Users\\\\User\\\\.comic-ocr-studio'
            && $('storageAppDir').textContent === 'D:\\\\ComicApp\\\\python_app';

          $('storageBrowseBtn').click();
          await new Promise((r) => setTimeout(r, 20));
          const pickedPath = $('storageCustomPath').value;

          const savePromise = submitStorageSettings(null);
          await new Promise((r) => setTimeout(r, 15));
          const usedAppModal = $('appModalDialog').open === true;
          $('appModalConfirm').click();
          await savePromise;

          return {
            verHas426: verText.includes('۴.۳۰'),
            hasModelsShortcut: Boolean($('modelsStorageBtn')),
            openedOk,
            pickCalled,
            pickedPath,
            usedAppModal,
            putPayload,
            closedAfterSave: $('storageDialog').open === false,
            switchedProjectId: state.project?.id,
            customActiveAfter: state.storage?.customActive === true,
          };
        } finally {
          window.fetch = origFetch;
          if ($('storageDialog')?.open) closeDialog('storageDialog');
          if (prevProject) adoptProject(prevProject);
        }
      })()
    `, context);
    check(
      'v4.00/v4.30 displays version 4.30 and supports optional custom storage/downloads directory picker, appConfirm confirmation, safe migration PUT, and live state reload',
      v400StorageCheck.verHas426 === true
        && v400StorageCheck.hasModelsShortcut === true
        && v400StorageCheck.openedOk === true
        && v400StorageCheck.pickCalled === true
        && v400StorageCheck.pickedPath === 'D:\\ComicOCRData'
        && v400StorageCheck.usedAppModal === true
        && v400StorageCheck.putPayload?.custom_path === 'D:\\ComicOCRData'
        && v400StorageCheck.putPayload?.migrate_existing === true
        && v400StorageCheck.putPayload?.cleanup_source === true
        && v400StorageCheck.closedAfterSave === true
        && v400StorageCheck.switchedProjectId === 'projd1'
        && v400StorageCheck.customActiveAfter === true,
      JSON.stringify(v400StorageCheck),
    );

    // v4.01: Verify #ocrEngine install/readiness icons (✓ ready, ◐ installed runtime missing language, ⬇ uninstalled) + monotonic real progress bars
    const v401UiCheck = await vm.runInContext(`
      (async () => {
        const prevEngines = state.engines;
        try {
          state.engines = [
            {
              id: 'rapidocr-v6',
              name: 'PP-OCRv6 Small',
              family: 'RapidOCR / ONNX',
              selectable: true,
              isolated: false,
              languages: ['eng', 'chi_sim', 'jpn'],
              runtimeInstalled: true,
              modelReady: true,
              readyLanguages: ['eng'],
              totalDownloadGb: 0,
              fullDownloadSizeGb: 0.04,
            },
            {
              id: 'tesseract',
              name: 'Tesseract 5 LSTM',
              family: 'Tesseract',
              selectable: true,
              isolated: false,
              languages: ['eng', 'fas'],
              runtimeInstalled: true,
              modelReady: true,
              readyLanguages: ['eng'],
              totalDownloadGb: 0.015,
              fullDownloadSizeGb: 0.09,
            },
            {
              id: 'glm-ocr',
              name: 'GLM-OCR',
              family: 'VLM',
              selectable: true,
              isolated: true,
              languages: ['eng', 'fas'],
              runtimeInstalled: false,
              modelReady: false,
              readyLanguages: [],
              totalDownloadGb: 4.55,
              fullDownloadSizeGb: 4.55,
            },
          ];

          $('ocrLanguage').value = 'eng';
          updateEngineOptions('rapidocr-v6', { resort: true });
          const optRapidEng = document.querySelector('#ocrEngine option[value="rapidocr-v6"]');
          const optTessEng = document.querySelector('#ocrEngine option[value="tesseract"]');
          const optGlmEng = document.querySelector('#ocrEngine option[value="glm-ocr"]');
          const engIconsOk = optRapidEng?.textContent === '✓ PP-OCRv6 Small' && optRapidEng?.dataset.installState === 'ready'
            && optTessEng?.textContent === '✓ Tesseract 5 LSTM' && optTessEng?.dataset.installState === 'ready'
            && optGlmEng?.textContent === '⬇ GLM-OCR' && optGlmEng?.dataset.installState === 'uninstalled';

          // Switch language to Persian ('fas'): Tesseract has runtimeInstalled=true but 'fas' not in readyLanguages -> ◐
          $('ocrLanguage').value = 'fas';
          updateEngineOptions('tesseract', { resort: true });
          const optTessFas = document.querySelector('#ocrEngine option[value="tesseract"]');
          const optGlmFas = document.querySelector('#ocrEngine option[value="glm-ocr"]');
          const fasIconsOk = optTessFas?.textContent === '◐ Tesseract 5 LSTM' && optTessFas?.dataset.installState === 'partial'
            && optGlmFas?.textContent === '⬇ GLM-OCR' && optGlmFas?.dataset.installState === 'uninstalled';

          // Verify jobProgressTransform prevents backward jumps when export transitions from 45% client render to 10% server build
          jobBusy = true;
          activeProgressId = 'exportProgress';
          jobProgressTransform = { offset: 0.45, scale: 0.53, floor: 0.45 };
          const origFetch = window.fetch;
          let exportWidth = 0;
          try {
            window.fetch = async (url, opts) => {
              if (String(url).startsWith('/api/activity')) {
                const body = {
                  entries: [{ id: 999001, message: 'چیدمان صفحهٔ ۱ از ۱۰ در PDF', kind: 'info', progress: 0.1, time: new Date().toISOString() }],
                  next: 999001,
                };
                return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
              }
              return origFetch(url, opts);
            };
            await pollActivity();
            exportWidth = parseInt($('exportProgress').closest('.bar').getAttribute('aria-valuenow') || '0', 10);
          } finally {
            window.fetch = origFetch;
            jobProgressTransform = null;
            activeProgressId = null;
            jobBusy = false;
            setProgress('exportProgress', 0, false);
            setProgress('jobProgress', 0, false);
            setProgress('dockProgress', 0, false);
          }

          return {
            engIconsOk,
            fasIconsOk,
            exportStayedAbove45: exportWidth === 50,
          };
        } finally {
          state.engines = prevEngines;
          $('ocrLanguage').value = 'eng';
          updateEngineOptions('rapidocr-v6', { resort: true });
        }
      })()
    `, context);
    check(
      'v4.01 renders single install/readiness icon (✓ ready, ◐ missing language file, ⬇ uninstalled) in #ocrEngine and scales multi-phase progress monotonically without backward jumps',
      v401UiCheck.engIconsOk === true && v401UiCheck.fasIconsOk === true && v401UiCheck.exportStayedAbove45 === true,
      JSON.stringify(v401UiCheck),
    );

    // v4.02: Verify unified "مدیریت مدل‌های OCR", "مدیریت ترجمه‌ها", zero duplicate menu items, 14-section Help guide with Storage/RAM chapter, and contextual F1 across dialogs
    const v402Check = await vm.runInContext(`
      (async () => {
        const modelsMenuText = ($('modelsBtn')?.querySelector('span')?.textContent || '').trim();
        const modelsDlgTitle = ($('modelsDialog')?.querySelector('h2')?.textContent || '').trim();
        const noDuplicateMenu = !$('deleteModelsMenuBtn');
        const aiMenuText = ($('aiBtn')?.textContent || '').trim();
        const aiDlgTitle = ($('aiDialog')?.querySelector('h2')?.textContent || '').trim();
        const previewAiShortcut = ($('openAiSettingsFromPreview')?.textContent || '').trim();

        const storageChapter = window.ComicHelpGuide.HELP_SECTIONS.find((s) => s.id === 'storage-memory-network');
        const hasStorageChapter = Boolean(storageChapter)
          && storageChapter.num === '۱۳'
          && storageChapter.features.some((f) => f.includes('python_app') && f.includes('start_windows.bat'));

        // Contextual F1 on #modelsDialog -> 'ocr-models', #aiDialog -> 'ai-translation-settings', #storageDialog -> 'storage-memory-network'
        showDialog('modelsDialog');
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'F1', bubbles: true, cancelable: true }));
        const f1ModelsArticle = document.querySelector('#helpContentArea [data-help-article]')?.dataset.helpArticle;
        closeDialog('helpDialog');
        closeDialog('modelsDialog');

        showDialog('aiDialog');
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'F1', bubbles: true, cancelable: true }));
        const f1AiArticle = document.querySelector('#helpContentArea [data-help-article]')?.dataset.helpArticle;
        closeDialog('helpDialog');
        closeDialog('aiDialog');

        showDialog('storageDialog');
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'F1', bubbles: true, cancelable: true }));
        const f1StorageArticle = document.querySelector('#helpContentArea [data-help-article]')?.dataset.helpArticle;
        closeDialog('helpDialog');
        closeDialog('storageDialog');

        return {
          modelsMenuText,
          modelsDlgTitle,
          noDuplicateMenu,
          aiMenuText,
          aiDlgTitle,
          previewAiShortcut,
          hasStorageChapter,
          f1ModelsArticle,
          f1AiArticle,
          f1StorageArticle,
        };
      })()
    `, context);
    check(
      'v4.02 unifies menu into single مدیریت مدل‌های OCR and مدیریت ترجمه‌ها, expands Help to 14 complete chapters, and supports contextual F1 across dialogs',
      v402Check.modelsMenuText === 'مدیریت مدل‌های OCR'
        && v402Check.modelsDlgTitle === 'مدیریت مدل‌های OCR'
        && v402Check.noDuplicateMenu === true
        && v402Check.aiMenuText === 'مدیریت ترجمه‌ها'
        && v402Check.aiDlgTitle === 'مدیریت ترجمه‌ها'
        && v402Check.previewAiShortcut === 'مدیریت ترجمه‌ها…'
        && v402Check.hasStorageChapter === true
        && v402Check.f1ModelsArticle === 'ocr-models'
        && v402Check.f1AiArticle === 'ai-translation-settings'
        && v402Check.f1StorageArticle === 'storage-memory-network',
      JSON.stringify(v402Check),
    );

    // v4.03: Verify backup awaits in-flight imageRenderTasks, syncs updatedAt from /rendered, uses ?prepare=true streaming link, tolerates corrupt draft, clears link on project switch, and restores safely even on 404 prior project
    const v403BackupCheck = await vm.runInContext(`
      (async () => {
        const origFetch = window.fetch;
        const prevProj = state.project;
        let backupReqBody = null;
        let backupUrlCalled = '';
        let deletedBackupUrl = '';
        let renderFinishedBeforeBackup = false;
        let releaseSlowRender = null;
        const slowRenderGate = new Promise((r) => { releaseSlowRender = r; });
        let restoredRenderedCount = 0;

        try {
          const testProj = {
            id: 'projbkp1',
            name: 'پروژه تست بک‌آپ',
            updatedAt: '2026-11-07T08:00:00Z',
            settings: { overlayMode: 'translation', output: {} },
            images: [
              {
                id: 'imgbkp1',
                name: 'p1.png',
                file: 'imgbkp1.png',
                width: 120,
                height: 80,
                format: 'PNG',
                order: 0,
                selected: true,
                edited: false,
                blocks: [{ id: 1, text: 'HI', tr: 'سلام', richHtml: '', enabled: true, bg: 'white', x0: 5, y0: 5, x1: 80, y1: 35, lineH: 30, dir: 'rtl', align: 'right' }],
              },
            ],
          };
          adoptProject(testProj);

          // One valid draft + one corrupted draft in localStorage
          localStorage.setItem('comic-studio-draft:projbkp1:imgbkp1:1:translation', JSON.stringify({ html: '<p>پیش‌نویس سالم</p>' }));
          localStorage.setItem('comic-studio-draft:projbkp1:imgbkp1:1:ocr', '{corrupt-json');

          window.fetch = async (url, opts = {}) => {
            const u = String(url);
            const method = (opts.method || 'GET').toUpperCase();
            if (u === '/api/activity/clear' || u.startsWith('/api/activity')) {
              return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ entries: [], next: 0 }), json: async () => ({ entries: [], next: 0 }) };
            }
            if (u === '/api/projects') {
              const payload = [{ id: state.project.id, name: state.project.name, updatedAt: state.project.updatedAt, images: 1 }];
              return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(payload), json: async () => payload };
            }
            if (u.includes('/images/imgbkp1/content')) {
              return { ok: true, status: 200, blob: async () => new window.Blob(['png']) };
            }
            if (u.includes('/images/imgbkp1/rendered') && method === 'POST') {
              await slowRenderGate;
              renderFinishedBeforeBackup = true;
              const payload = { ok: true, updatedAt: '2026-11-07T08:01:00Z' };
              return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(payload), json: async () => payload };
            }
            if (u === '/api/projects/projbkp1/state' && method === 'PUT') {
              const body = JSON.parse(opts.body);
              const nextTs = renderFinishedBeforeBackup ? '2026-11-07T08:02:00Z' : '2026-11-07T08:00:30Z';
              const payload = Object.assign({}, body.state, { updatedAt: nextTs });
              return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(payload), json: async () => payload };
            }
            if (u.startsWith('/api/projects/projbkp1/backup') && method === 'POST') {
              backupUrlCalled = u;
              backupReqBody = JSON.parse(opts.body);
              const payload = { token: '0123456789abcdef0123456789abcdef', filename: 'پروژه تست بک‌آپ-backup.zip', size: 4096 };
              return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(payload), json: async () => payload };
            }
            if (u.startsWith('/api/projects/projbkp1/backup/') && method === 'DELETE') {
              deletedBackupUrl = u;
              return { ok: true, status: 204, headers: { get: () => '' }, text: async () => '' };
            }
            if (u === '/api/projects/missing404/state' && method === 'PUT') {
              return { ok: false, status: 404, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ detail: 'پروژه پیدا نشد' }), json: async () => ({ detail: 'پروژه پیدا نشد' }) };
            }
            if (u === '/api/projects/restore' && method === 'POST') {
              const restoredProj = {
                id: 'projrestored9',
                name: 'پروژه بازیابی‌شده',
                updatedAt: '2026-11-07T09:00:00Z',
                settings: { overlayMode: 'translation', output: {} },
                images: [
                  {
                    id: 'imgrest1',
                    name: 'r1.png',
                    file: 'imgrest1.png',
                    width: 120,
                    height: 80,
                    format: 'PNG',
                    order: 0,
                    selected: true,
                    edited: false,
                    blocks: [{ id: 5, text: 'R', tr: 'ترجمه بازیابی', richHtml: '', enabled: true, bg: 'white', x0: 5, y0: 5, x1: 80, y1: 35, lineH: 30, dir: 'rtl', align: 'right' }],
                  },
                ],
              };
              const payload = { project: restoredProj, drafts: [] };
              return { ok: true, status: 201, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(payload), json: async () => payload };
            }
            if (u.includes('/images/imgrest1/content')) {
              return { ok: true, status: 200, blob: async () => new window.Blob(['png']) };
            }
            if (u.includes('/images/imgrest1/rendered') && method === 'POST') {
              restoredRenderedCount += 1;
              const payload = { ok: true, updatedAt: '2026-11-07T09:00:05Z' };
              return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(payload), json: async () => payload };
            }
            return origFetch(url, opts);
          };

          // Start an in-flight background render BEFORE clicking backup
          const bgRender = renderAndUpload(state.project.images[0]);
          const backupTask = backupCurrentProject();
          await new Promise((r) => setTimeout(r, 20));
          const waitedForInFlightRender = backupReqBody === null;
          releaseSlowRender();
          await bgRender;
          await backupTask;

          const linkVisibleDuringProj = !$('backupDownloadLink').classList.contains('hidden');
          const linkHrefDuringProj = $('backupDownloadLink').getAttribute('href');

          // Simulate switching to a missing/deleted project (404 on save) and restoring backup
          adoptProject({ id: 'missing404', name: 'حذف‌شده', updatedAt: 'old', settings: { output: {} }, images: [] });
          await new Promise((r) => setTimeout(r, 10));
          const linkHiddenAfterSwitch = $('backupDownloadLink').classList.contains('hidden');

          const restoreTask = restoreProjectBackup(new window.Blob(['zip']));
          await new Promise((r) => setTimeout(r, 15));
          $('appModalConfirm').click();
          await restoreTask;

          return {
            waitedForInFlightRender,
            renderFinishedBeforeBackup,
            usedPrepareQuery: backupUrlCalled.includes('prepare=true'),
            expectedUpdatedAtSynced: backupReqBody?.expected_updated_at === '2026-11-07T08:02:00Z',
            validDraftCount: backupReqBody?.drafts?.length,
            linkVisibleDuringProj,
            linkPointsToToken: String(linkHrefDuringProj || '').includes('/api/projects/projbkp1/backup/0123456789abcdef0123456789abcdef'),
            linkHiddenAfterSwitch,
            deletedPreparedOnSwitch: deletedBackupUrl.includes('/api/projects/projbkp1/backup/0123456789abcdef0123456789abcdef'),
            restoredProjectId: state.project?.id,
            restoredRenderedCount,
          };
        } finally {
          localStorage.removeItem('comic-studio-draft:projbkp1:imgbkp1:1:translation');
          localStorage.removeItem('comic-studio-draft:projbkp1:imgbkp1:1:ocr');
          window.fetch = origFetch;
          if (prevProj) adoptProject(prevProj);
        }
      })()
    `, context);
    check(
      'v4.03 backup awaits in-flight renders, syncs updatedAt, streams via prepared token, skips corrupt localStorage draft, cleans up link on switch, and restores even if prior project 404s',
      v403BackupCheck.waitedForInFlightRender === true
        && v403BackupCheck.renderFinishedBeforeBackup === true
        && v403BackupCheck.usedPrepareQuery === true
        && v403BackupCheck.expectedUpdatedAtSynced === true
        && v403BackupCheck.validDraftCount === 1
        && v403BackupCheck.linkVisibleDuringProj === true
        && v403BackupCheck.linkPointsToToken === true
        && v403BackupCheck.linkHiddenAfterSwitch === true
        && v403BackupCheck.deletedPreparedOnSwitch === true
        && v403BackupCheck.restoredProjectId === 'projrestored9'
        && v403BackupCheck.restoredRenderedCount === 1,
      JSON.stringify(v403BackupCheck),
    );

    // v4.04: Verify built-in offline local NMT translator UI (download, test, unload, delete via appConfirm, save settings, and single-sentence + page preview)
    const v404LocalNmtCheck = await vm.runInContext(`
      (async () => {
        const origFetch = window.fetch;
        const prevAi = state.ai ? JSON.parse(JSON.stringify(state.ai)) : null;
        let preparedModel = null;
        let testedPayload = null;
        let unloadedCount = 0;
        let deletedModel = null;
        let savedAiPayload = null;
        let singlePreviewReq = null;
        let singleExecReq = null;
        let modelReady = false;

        const buildStatus = () => ({
          runtimeInstalled: modelReady,
          activeModel: 'nllb-600m',
          loadedModel: modelReady ? 'nllb-600m' : null,
          busyModel: null,
          busyStage: '',
          busyProgress: 0,
          models: [
            {
              id: 'nllb-600m',
              label: 'NLLB-200 سبک و سریع (600M · ~630 MB)',
              shortLabel: 'NLLB-200 (600M)',
              description: 'سبک و قابل اجرا روی CPU بدون اینترنت.',
              approxSize: '~630 MB',
              ramHint: '~750 MB',
              ready: modelReady,
              filesPresent: modelReady,
              diskBytes: modelReady ? 655000000 : 0,
              diskSizeLabel: modelReady ? '625 MB' : '',
            },
            {
              id: 'nllb-1.3b',
              label: 'NLLB-200 دقیق‌تر (1.3B · ~1.35 GB)',
              shortLabel: 'NLLB-200 (1.3B)',
              description: 'دقیق‌تر روی CPU.',
              approxSize: '~1.35 GB',
              ramHint: '~1.6 GB',
              ready: false,
              filesPresent: false,
              diskBytes: 0,
              diskSizeLabel: '',
            },
          ],
        });

        try {
          const okJson = (payload) => ({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            text: async () => JSON.stringify(payload),
            json: async () => payload,
          });
          window.fetch = async (url, opts = {}) => {
            const u = String(url);
            const method = (opts.method || 'GET').toUpperCase();
            if (u.endsWith('/api/local-nmt/status')) {
              return okJson(buildStatus());
            }
            if (u.endsWith('/api/local-nmt/prepare') && method === 'POST') {
              const body = JSON.parse(opts.body || '{}');
              preparedModel = body.model;
              modelReady = true;
              return okJson({ ok: true, status: buildStatus() });
            }
            if (u.endsWith('/api/local-nmt/test') && method === 'POST') {
              testedPayload = JSON.parse(opts.body || '{}');
              return okJson({
                ok: true,
                model: testedPayload.model,
                sourceText: testedPayload.sample_text,
                translatedText: 'سلام! یک لحظه صبر کن.',
                message: 'مترجم آفلاین «NLLB-200 (600M)» آماده است ✓ — نمونهٔ ترجمه: «سلام! یک لحظه صبر کن.»',
              });
            }
            if (u.endsWith('/api/local-nmt/unload') && method === 'POST') {
              unloadedCount += 1;
              return okJson({ ok: true, status: { ...buildStatus(), loadedModel: null } });
            }
            if (u.endsWith('/api/local-nmt/delete') && method === 'POST') {
              const body = JSON.parse(opts.body || '{}');
              deletedModel = body.model;
              modelReady = false;
              return okJson({ ok: true, freedBytes: 655000000, status: buildStatus() });
            }
            if (u.endsWith('/api/ai-settings') && method === 'PUT') {
              savedAiPayload = JSON.parse(opts.body || '{}');
              return okJson({ ...state.ai, ...savedAiPayload, local_nmt_status: buildStatus() });
            }
            if (u.endsWith('/api/translate-text/context-preview') && method === 'POST') {
              singlePreviewReq = JSON.parse(opts.body || '{}');
              return okJson({
                provider: 'local',
                providerLabel: 'مترجم آفلاین داخلی — NLLB-200 سبک و سریع (600M · ~630 MB)',
                model: 'nllb-600m',
                base_url: '',
                fallback_url: '',
                previewError: '',
                note: 'ترجمه ۱۰۰٪ آفلاین روی سیستم شما انجام می‌شود.',
                requestCount: 1,
                blockCount: 1,
                requests: [{ index: 1, call: 1, text: singlePreviewReq.text, characters: singlePreviewReq.text.length }],
                signature: 'sig-local-single-1',
              });
            }
            if (u.endsWith('/api/translate-text/context') && method === 'POST') {
              singleExecReq = JSON.parse(opts.body || '{}');
              return okJson({ text: 'سلام دنیا آفلاین!' });
            }
            return origFetch(url, opts);
          };

          await loadAiSettings({ ...state.ai, local_nmt: { model: 'nllb-600m', beam_size: 2, source_limit: 4000, keep_loaded: false }, local_nmt_status: buildStatus() });
          showDialog('aiDialog');
          showAiProvider('local');
          const localFieldsVisible = !$('localNmtFields').classList.contains('hidden')
            && $('freeFields').classList.contains('hidden')
            && $('aiFields').classList.contains('hidden');
          const execIsLocal = $('aiExecBadge').classList.contains('is-local');
          const cardCount = document.querySelectorAll('#localNmtCards .local-nmt-card').length;

          // 1-click download
          await prepareLocalNmtModel('nllb-600m');
          // 1-sentence offline sample test
          $('localNmtTestSample').value = 'Hello! Wait a second.';
          await testLocalNmtSample();
          const testStatusHasFa = $('aiStatus').textContent.includes('سلام');
          // RAM unload
          await unloadLocalNmtRam();
          // Save settings with provider='local'
          await saveAiSettings();

          // Single-sentence / single-block translation via retranslateBlock
          const sampleBlock = state.project.images[0].blocks[0];
          const prevTr = sampleBlock.tr;
          sampleBlock.text = 'Offline single sentence!';
          await retranslateBlock(sampleBlock);
          const previewServiceValue = $('translationPreviewService')?.value;
          const previewSkillHidden = $('translationSkillWrap')?.classList.contains('hidden');
          const previewExecIsLocal = $('translationPreviewExecBadge')?.classList.contains('is-local');
          await confirmTranslationRequestPreview();
          const translatedSingle = sampleBlock.tr;
          sampleBlock.tr = prevTr;

          // Delete model via custom Persian appConfirm (zero native confirm)
          modelReady = true;
          state.ai.local_nmt_status = buildStatus();
          renderLocalNmtPanel();
          const delPromise = deleteLocalNmtModel('nllb-600m', 'NLLB-200 (600M)');
          await new Promise((r) => setTimeout(r, 15));
          const deleteUsedAppModal = $('appModalDialog').open === true;
          $('appModalConfirm').click();
          await delPromise;

          return {
            localFieldsVisible,
            execIsLocal,
            cardCount,
            preparedModel,
            testedModel: testedPayload?.model,
            testStatusHasFa,
            unloadedCount,
            savedProvider: savedAiPayload?.provider,
            savedModel: savedAiPayload?.local_nmt?.model,
            previewServiceValue,
            previewSkillHidden,
            previewExecIsLocal,
            singlePreviewProvider: singlePreviewReq?.provider,
            singleExecProvider: singleExecReq?.provider,
            translatedSingle,
            deleteUsedAppModal,
            deletedModel,
          };
        } finally {
          window.fetch = origFetch;
          if ($('aiDialog')?.open) closeDialog('aiDialog');
          if ($('translationPreviewDialog')?.open) closeDialog('translationPreviewDialog');
          if (prevAi) state.ai = prevAi;
        }
      })()
    `, context);
    check(
      'v4.04 built-in offline local NMT manages download/test/unload/delete via appConfirm and translates single sentences offline',
      v404LocalNmtCheck.localFieldsVisible === true
        && v404LocalNmtCheck.execIsLocal === true
        && v404LocalNmtCheck.cardCount === 2
        && v404LocalNmtCheck.preparedModel === 'nllb-600m'
        && v404LocalNmtCheck.testedModel === 'nllb-600m'
        && v404LocalNmtCheck.testStatusHasFa === true
        && v404LocalNmtCheck.unloadedCount === 1
        && v404LocalNmtCheck.savedProvider === 'local'
        && v404LocalNmtCheck.savedModel === 'nllb-600m'
        && v404LocalNmtCheck.previewServiceValue === 'local'
        && v404LocalNmtCheck.previewSkillHidden === true
        && v404LocalNmtCheck.previewExecIsLocal === true
        && v404LocalNmtCheck.singlePreviewProvider === 'local'
        && v404LocalNmtCheck.singleExecProvider === 'local'
        && v404LocalNmtCheck.translatedSingle === 'سلام دنیا آفلاین!'
        && v404LocalNmtCheck.deleteUsedAppModal === true
        && v404LocalNmtCheck.deletedModel === 'nllb-600m',
      JSON.stringify(v404LocalNmtCheck),
    );

    // v4.05: Verify custom Persian (RTL) & English (LTR) manual text boxes in #editorDialog, empty-source retranslate guard, appConfirm block deletion, Watermark (Text + Transparent Logo) apply/remove, and eraseOriginal=false forwarding
    let drawnWatermarkFillCalls = 0;
    let drawnWatermarkLogoCalls = 0;
    const mockWmCtx = {
      font: '',
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      globalAlpha: 1,
      textAlign: 'center',
      textBaseline: 'middle',
      save() {},
      restore() {},
      translate() {},
      rotate() {},
      beginPath() {},
      roundRect() {},
      fill() {},
      fillRect() {},
      measureText(t) { return { width: String(t || '').length * 8 }; },
      strokeText() {},
      fillText() { drawnWatermarkFillCalls += 1; },
      drawImage() { drawnWatermarkLogoCalls += 1; },
    };
    const wmDrawnCorner = realTypeset.drawWatermark(
      mockWmCtx,
      400,
      600,
      { enabled: true, text: 'ترجمه اختصاصی', logoId: 'lg1', position: 'bottom-left', bgPill: true, outline: true },
      { lg1: { _drawable: { width: 48, height: 48 } } },
    );
    const wmDrawnTile = realTypeset.drawWatermark(
      mockWmCtx,
      400,
      600,
      { enabled: true, text: 'TILE', position: 'tile', tileGapPct: 30 },
      {},
    );
    const previewCallsBeforeManual = translationPreviewCalls.length;
    const v405Check = await vm.runInContext(`
      (async () => {
        const origFetch = window.fetch;
        const prevProject = state.project;
        try {
          window.fetch = async (url, options = {}) => {
            const u = String(url);
            if (u.includes('/content')) return { ok: true, status: 200, blob: async () => new Blob(['img'], { type: 'image/png' }) };
            if (u.endsWith('/rendered') || u.endsWith('/revert')) return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, updatedAt: '2026-11-07T12:00:00Z' }) };
            if (u.endsWith('/state') && options.method === 'PUT') {
              const saved = JSON.parse(options.body).state;
              return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => saved };
            }
            return origFetch(url, options);
          };
          adoptProject({
            id: 'proj-v405',
            name: 'پروژه ۴.۰۵',
            updatedAt: '',
            images: [{ id: 'img-v405', name: 'cover.png', file: 'cover.png', width: 320, height: 200, order: 0, selected: true, groupId: null, crop: null, blocks: [], watermark: null, edited: false }],
            settings: { eraseOriginal: false, output: {} },
          });
          const img = state.project.images[0];

        await openEditor(img.id);
        const emptyHasQuickBtns = document.querySelectorAll('#blockList .block-empty-actions button').length === 2;

        // Add Persian (RTL) & English (LTR) manual text boxes
        $('editorAddFaText').click();
        if (classicEditor) classicEditor.setHTML('<p>سلام کمیک</p>');
        closeInlineEditor();

        $('editorAddEnText').click();
        if (classicEditor) classicEditor.setHTML('<p>BOOM!</p>');
        closeInlineEditor();

        const addedCount = img.blocks.length;
        const faBlock = img.blocks[0];
        const enBlock = img.blocks[1];
        const manualBadgeShown = Boolean(document.querySelector('#blockList .block-manual-chip'));

        // Empty OCR source text on manual block must guard retranslateBlock without hitting preview endpoint
        await retranslateBlock(faBlock);

        // Delete populated English manual block via appConfirm (#appModalDialog)
        selectEditorBlock(enBlock.id, false, false);
        const delTask = deleteEditorBlocks();
        await new Promise((r) => setTimeout(r, 15));
        const deleteUsedModal = $('appModalDialog').open === true;
        $('appModalConfirm').click();
        await delTask;
        const countAfterDelete = img.blocks.length;

        await closeEditor(false);

        // Open Watermark dialog, upload a transparent PNG logo, set text + position, and apply
        await openWatermarkDialog(false);
        const wmDialogOpened = $('watermarkDialog').open === true;
        const fakeLogoFile = new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' });
        fakeLogoFile.name = 'team-logo.png';
        await handleWatermarkLogoUpload(fakeLogoFile);
        const uploadedLogoId = $('wmLogoSelect').value;
        $('wmText').value = 'کانال کمیک‌ستان';
        $('wmPosition').value = 'diagonal';
        $('wmPosition').dispatchEvent(new Event('change'));
        const autoDiagonalAngle = $('wmAngle').value;
        await applyWatermarkFromDialog();

        const hasWmOnPage = Boolean(img.watermark && img.watermark.text === 'کانال کمیک‌ستان' && img.watermark.logoId === uploadedLogoId);
        const cardHasWmBadge = Boolean(document.querySelector('#grid .item .watermark-badge'));

        // Remove watermark via appConfirm
        await openWatermarkDialog(false);
        const rmTask = removeWatermarkFromDialog();
        await new Promise((r) => setTimeout(r, 15));
        const removeUsedModal = $('appModalDialog').open === true;
        $('appModalConfirm').click();
        await rmTask;
        const wmCleared = img.watermark === null;

          return {
            emptyHasQuickBtns,
            addedCount,
            faDir: faBlock?.dir,
            faManual: faBlock?.manual === true,
            enDir: enBlock?.dir,
            enManual: enBlock?.manual === true,
            manualBadgeShown,
            deleteUsedModal,
            countAfterDelete,
            wmDialogOpened,
            uploadedLogoOk: Boolean(uploadedLogoId && state.project.settings.watermarkLogos?.[uploadedLogoId]),
            autoDiagonalAngle,
            hasWmOnPage,
            cardHasWmBadge,
            removeUsedModal,
            wmCleared,
          };
        } finally {
          window.fetch = origFetch;
          if ($('watermarkDialog')?.open) closeDialog('watermarkDialog');
          if ($('editorDialog')?.open) closeDialog('editorDialog');
          if (prevProject) adoptProject(prevProject);
        }
      })()
    `, context);
    check(
      'v4.05 supports custom Persian/English manual text boxes, appConfirm deletion, empty-source guard, Watermark (text + transparent logo), and eraseOriginal=false forwarding',
      wmDrawnCorner === true
        && wmDrawnTile === true
        && drawnWatermarkFillCalls >= 5
        && drawnWatermarkLogoCalls === 1
        && translationPreviewCalls.length === previewCallsBeforeManual
        && renderedOptions?.eraseOriginal === false
        && v405Check.emptyHasQuickBtns === true
        && v405Check.addedCount === 2
        && v405Check.faDir === 'rtl'
        && v405Check.faManual === true
        && v405Check.enDir === 'ltr'
        && v405Check.enManual === true
        && v405Check.manualBadgeShown === true
        && v405Check.deleteUsedModal === true
        && v405Check.countAfterDelete === 1
        && v405Check.wmDialogOpened === true
        && v405Check.uploadedLogoOk === true
        && v405Check.autoDiagonalAngle === '-30'
        && v405Check.hasWmOnPage === true
        && v405Check.cardHasWmBadge === true
        && v405Check.removeUsedModal === true
        && v405Check.wmCleared === true,
      JSON.stringify({ v405Check, renderedOptions, drawnWatermarkFillCalls, drawnWatermarkLogoCalls }),
    );

    // v4.07: Verify full-attribute box copy/paste/duplicate via toolbar icons, on-box ⧉ icon, sidebar button, Ctrl+C / Ctrl+V (EN & FA keyboard layouts + cross-page paste + inline typing guard), Ctrl+Shift+Drag / Click cloning, and Help Guide documentation
    const v407Check = await vm.runInContext(`
      (async () => {
        const prevProject = state.project ? JSON.parse(JSON.stringify(state.project)) : null;
        const origFetch = window.fetch;
        window.fetch = async (url, options = {}) => {
          const u = String(url);
          if (u.includes('/content')) {
            return { ok: true, status: 200, blob: async () => new Blob(['img'], { type: 'image/png' }) };
          }
          if (u.endsWith('/state') && options.method === 'PUT') {
            return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => JSON.parse(options.body).state };
          }
          return {
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({ ok: true, updatedAt: '2026-11-07T14:00:00Z' }),
          };
        };
        try {
          state.copiedEditorBlocks = [];
          state.copiedEditorPasteStep = 0;
          state.copiedEditorSourceImageId = null;
          adoptProject({
            id: 'proj-v407',
            name: 'پروژه ۴.۰۷',
            updatedAt: '2026-11-07T14:00:00Z',
            groups: [],
            settings: {
              ocrEngine: 'rapidocr-v6',
              ocrLanguage: 'eng',
              ocrPageMode: 'comic',
              eraseOriginal: true,
              overlayMode: 'translation',
            },
            images: [
              {
                id: 'img-copy-1',
                name: 'p1.png',
                file: 'p1.png',
                width: 320,
                height: 200,
                selected: true,
                edited: false,
                approved: false,
                blocks: [
                  {
                    id: 1,
                    text: 'BOOM!',
                    tr: 'بوم بزرگ!',
                    richHtml: '<span style="color:#ff2244;font-weight:bold">بوم بزرگ!</span>',
                    conf: 98,
                    enabled: true,
                    bg: 'black',
                    color: '#ff2244',
                    bold: true,
                    italic: true,
                    size: 26,
                    align: 'center',
                    verticalAlign: 'bottom',
                    dir: 'rtl',
                    textMode: 'translation',
                    pageRole: 'heading',
                    lineH: 30,
                    x0: 20, y0: 20, x1: 140, y1: 70,
                    tx0: 20, ty0: 20, tx1: 140, ty1: 70,
                  },
                ],
              },
              {
                id: 'img-copy-2',
                name: 'p2.png',
                file: 'p2.png',
                width: 320,
                height: 200,
                selected: true,
                edited: false,
                approved: false,
                blocks: [],
              },
            ],
          });

          await openEditor('img-copy-1');
          const pasteDisabledInitially = $('editorPasteBlock').disabled === true;
          selectEditorBlock(1, false, false);

          // 1. Typing guard: while inline editor is open, Ctrl+C / Ctrl+V must NOT hijack text editing
          openInlineEditor(state.project.images[0].blocks[0]);
          const keyWhenTyping = new window.KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true, cancelable: true });
          $('inlineEditorField').dispatchEvent(keyWhenTyping);
          const countWhileTyping = state.project.images[0].blocks.length;
          closeInlineEditor();

          // 2. Persian keyboard layout Ctrl+C ('ز' + KeyC) & Ctrl+V ('ر' + KeyV) copies & pastes all attributes
          document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ز', code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true }));
          const pasteEnabledAfterCopy = $('editorPasteBlock').disabled === false;
          document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ر', code: 'KeyV', ctrlKey: true, bubbles: true, cancelable: true }));
          const pastedSamePage = state.project.images[0].blocks[1];
          const samePageAttrsMatch = Boolean(
            pastedSamePage
            && pastedSamePage.id === 2
            && pastedSamePage.tr === 'بوم بزرگ!'
            && pastedSamePage.richHtml.includes('#ff2244')
            && pastedSamePage.bg === 'black'
            && pastedSamePage.color === '#ff2244'
            && pastedSamePage.bold === true
            && pastedSamePage.italic === true
            && pastedSamePage.size === 26
            && pastedSamePage.align === 'center'
            && pastedSamePage.verticalAlign === 'bottom'
            && pastedSamePage.pageRole === 'heading'
            && (pastedSamePage.tx1 - pastedSamePage.tx0) === 120
            && (pastedSamePage.ty1 - pastedSamePage.ty0) === 50
            && pastedSamePage.tx0 === 42
            && pastedSamePage.ty0 === 42
          );

          // 3. On-box mini icon (.box-copy ⧉) duplicates immediately without disturbing original
          const box1CopyIcon = $('editorBoxes').querySelector('.editor-box[data-id="1"] .box-copy');
          box1CopyIcon.click();
          const countAfterOnBoxIcon = state.project.images[0].blocks.length;

          // 4. Ctrl+Shift+Drag pulls out a live copy to exact target spot while keeping original box 1 at (20, 20)
          const box1El = $('editorBoxes').querySelector('.editor-box[data-id="1"]');
          const mkPtr = (type, x, y, opts = {}) => {
            const ev = new window.Event(type, { bubbles: true, cancelable: true });
            Object.defineProperties(ev, {
              clientX: { value: x },
              clientY: { value: y },
              pointerId: { value: 9 },
              button: { value: 0 },
              ctrlKey: { value: Boolean(opts.ctrlKey) },
              shiftKey: { value: Boolean(opts.shiftKey) },
            });
            return ev;
          };
          const scale = state.editorScale || 1;
          box1El.dispatchEvent(mkPtr('pointerdown', 40, 40, { ctrlKey: true, shiftKey: true }));
          window.dispatchEvent(mkPtr('pointermove', 40 + Math.round(90 * scale), 40 + Math.round(60 * scale), { ctrlKey: true, shiftKey: true }));
          window.dispatchEvent(mkPtr('pointerup', 40 + Math.round(90 * scale), 40 + Math.round(60 * scale), { ctrlKey: true, shiftKey: true }));
          const origStillIntact = state.project.images[0].blocks[0].tx0 === 20 && state.project.images[0].blocks[0].ty0 === 20;
          const draggedClone = state.project.images[0].blocks.at(-1);
          const draggedCloneAtTarget = draggedClone.tx0 === 110 && draggedClone.ty0 === 80 && draggedClone.size === 26 && draggedClone.color === '#ff2244';

          // 5. Cross-page paste: open page 2 and click #editorPasteBlock -> lands at exact source coordinates (20, 20)
          await openEditor('img-copy-2');
          $('editorPasteBlock').click();
          const page2Block = state.project.images[1].blocks[0];
          const crossPageExact = Boolean(page2Block && page2Block.tx0 === 20 && page2Block.ty0 === 20 && page2Block.tr === 'بوم بزرگ!' && page2Block.bg === 'black');

          // 6. Help guide documents Ctrl + C, Ctrl + V, and Ctrl + Shift box copying in Chapters 9 & 14
          openHelpDialog('visual-editor');
          const visualHelpText = $('helpContentArea').textContent;
          openHelpDialog('shortcuts');
          const shortcutsHelpText = $('helpContentArea').textContent;
          closeDialog('helpDialog');

          return {
            pasteDisabledInitially,
            countWhileTyping,
            pasteEnabledAfterCopy,
            samePageAttrsMatch,
            countAfterOnBoxIcon,
            origStillIntact,
            draggedCloneAtTarget,
            crossPageExact,
            helpHasCopyDocs: visualHelpText.includes('Ctrl + Shift') && visualHelpText.includes('کپی کادر') && shortcutsHelpText.includes('Ctrl + C') && shortcutsHelpText.includes('Ctrl + Shift'),
          };
        } finally {
          window.fetch = origFetch;
          if ($('helpDialog')?.open) closeDialog('helpDialog');
          if ($('editorDialog')?.open) closeDialog('editorDialog');
          if (prevProject) adoptProject(prevProject);
        }
      })()
    `, context);
    check(
      'v4.07 supports full-attribute box copy/paste/duplicate via toolbar & on-box icons, Ctrl+C/Ctrl+V (EN/FA layouts + cross-page + typing guard), Ctrl+Shift+Drag cloning, and Help documentation',
      v407Check.pasteDisabledInitially === true
        && v407Check.countWhileTyping === 1
        && v407Check.pasteEnabledAfterCopy === true
        && v407Check.samePageAttrsMatch === true
        && v407Check.countAfterOnBoxIcon === 3
        && v407Check.origStillIntact === true
        && v407Check.draggedCloneAtTarget === true
        && v407Check.crossPageExact === true
        && v407Check.helpHasCopyDocs === true,
      JSON.stringify(v407Check),
    );
  }

  // v4.08: Verify API key priority controls (↑ بالاتر, ↓ پایین‌تر, ⇈ اولویت اول, drag-and-drop badge, preserved secrets & limits, #translationPreviewService priority ranks, and Help Guide Chapter 7 & 8 documentation)
  {
    const v408Check = await vm.runInContext(`
      (async () => {
        const prevAi = JSON.parse(JSON.stringify(state.ai || {}));
        try {
          $('aiBtn').click();
          $('aiProvider').value = 'openrouter';
          $('aiProvider').dispatchEvent(new window.Event('change', { bubbles: true }));
          // Step A: Save 2 keys on the server with actual secrets so stored secrets exist on backend
          aiEditorProfiles = [
            { id: 'prio-k1', name: 'کلید اول قدیمی', hasApiKey: false, apiKey: 'sk-saved-k1', timeout_seconds: '30', retry_count: '1', retry_wait_seconds: '10', source_limit: '1100' },
            { id: 'prio-k2', name: 'کلید دوم پشتیبان', hasApiKey: false, apiKey: 'sk-saved-k2', timeout_seconds: '60', retry_count: '2', retry_wait_seconds: '15', source_limit: '2200' },
          ];
          renderAiProfiles();
          await saveAiSettings();

          // Step B: Reopen #aiDialog (password inputs are now empty "", hasApiKey === true) and add a 3rd fresh key
          $('aiBtn').click();
          $('aiProvider').value = 'openrouter';
          $('aiProvider').dispatchEvent(new window.Event('change', { bubbles: true }));
          aiEditorProfiles[0]._lastStatus = 'اتصال برقرار است ✓';
          aiEditorProfiles.push({
            id: 'prio-k3', name: 'کلید سوم پرسرعت', hasApiKey: false, apiKey: 'sk-fresh-k3', timeout_seconds: '90', retry_count: '0', retry_wait_seconds: '20', source_limit: '3300',
          });
          renderAiProfiles();

          let rows = [...document.querySelectorAll('#aiProfiles .ai-profile-row')];
          const initialBadges = rows.map((r) => r.querySelector('.ai-priority-badge')?.textContent || '');
          const initialReadyChips = rows.map((r) => r.querySelector('.ai-key-ready-chip')?.textContent || '');
          const firstRowUpDisabled = rows[0].querySelector('.ai-profile-up')?.disabled === true
            && rows[0].querySelector('.ai-profile-top')?.disabled === true
            && rows[0].querySelector('.ai-profile-down')?.disabled === false;
          const lastRowDownDisabled = rows[2].querySelector('.ai-profile-down')?.disabled === true
            && rows[2].querySelector('.ai-profile-up')?.disabled === false
            && rows[2].querySelector('.ai-profile-top')?.disabled === false;

          // 1. Click "⇈ اولویت اول" on row 3 (prio-k3) -> jumps straight to index 0!
          rows[2].querySelector('.ai-profile-top').click();
          rows = [...document.querySelectorAll('#aiProfiles .ai-profile-row')];
          const orderAfterTop = rows.map((r) => r.dataset.profileId);

          // 2. Click "↓ پایین‌تر" on row 2 (prio-k1) -> swaps with prio-k2 -> [prio-k3, prio-k2, prio-k1]
          rows[1].querySelector('.ai-profile-down').click();
          rows = [...document.querySelectorAll('#aiProfiles .ai-profile-row')];
          const orderAfterDown = rows.map((r) => r.dataset.profileId);
          const preservedStatusMovedToRow3 = rows[2].querySelector('.ai-profile-status')?.textContent === 'اتصال برقرار است ✓';

          // 3. Click "↑ بالاتر" on row 3 (prio-k1) -> moves back to middle -> [prio-k3, prio-k1, prio-k2]
          rows[2].querySelector('.ai-profile-up').click();
          rows = [...document.querySelectorAll('#aiProfiles .ai-profile-row')];
          const orderAfterUp = rows.map((r) => r.dataset.profileId);

          // 4. Test HTML5 drag-and-drop on .ai-priority-badge: drag row 2 (index 2: prio-k2) onto row 1 (index 1: prio-k1) -> [prio-k3, prio-k2, prio-k1]
          rows[2].querySelector('.ai-priority-badge').dispatchEvent(new window.Event('dragstart', { bubbles: true }));
          const dropEv = new window.Event('drop', { bubbles: true, cancelable: true });
          rows[1].dispatchEvent(dropEv);
          rows[2]?.querySelector('.ai-priority-badge')?.dispatchEvent(new window.Event('dragend', { bubbles: true }));
          rows = [...document.querySelectorAll('#aiProfiles .ai-profile-row')];
          const orderAfterDrag = rows.map((r) => r.dataset.profileId);

          // 5. Save AI settings and verify PUT payload order + preserved secrets + #translationPreviewService priority rank labels
          await saveAiSettings();
          const savedProfiles = state.ai?.providers?.openrouter?.profiles || [];
          const savedIds = savedProfiles.map((p) => p.id);
          const allSavedHaveKeys = savedProfiles.length === 3 && savedProfiles.every((p) => p.hasApiKey === true);
          const savedTimeouts = savedProfiles.map((p) => Number(p.timeout_seconds));

          renderTranslationServiceSelector('openrouter', '');
          const previewOptions = [...$('translationPreviewService').options]
            .filter((o) => o.value === 'openrouter' || o.value.startsWith('openrouter::'))
            .map((o) => ({ value: o.value, text: o.textContent }));

          // 6. Verify Help Guide Chapter 7 & Chapter 8 document API key priority clearly
          openHelpDialog('ai-translation-settings');
          const ch7Html = $('helpContentArea')?.textContent || '';
          openHelpDialog('translation-preview-context');
          const ch8Html = $('helpContentArea')?.textContent || '';
          const headingHintOk = ($('aiDialog')?.innerHTML || '').includes('اولویت ۱ ابتدا امتحان می‌شود')
            && ($('aiDialog')?.innerHTML || '').includes('⇈ اولویت اول');
          const helpSynced = ch7Html.includes('⇈ اولویت اول')
            && ch7Html.includes('↑ بالاتر')
            && ch7Html.includes('↓ پایین‌تر')
            && ch8Html.includes('به ترتیب اولویت');

          return {
            initialPrimaryBadgeOk: initialBadges[0].includes('اولویت ۱') && initialBadges[1].includes('اولویت ۲') && initialBadges[2].includes('اولویت ۳'),
            readyChipsOk: initialReadyChips[0].includes('کلید ذخیره‌شده') && initialReadyChips[2].includes('کلید جدید آمادهٔ ذخیره'),
            boundaryBtnsOk: firstRowUpDisabled && lastRowDownDisabled,
            orderAfterTopOk: JSON.stringify(orderAfterTop) === JSON.stringify(['prio-k3', 'prio-k1', 'prio-k2']),
            orderAfterDownOk: JSON.stringify(orderAfterDown) === JSON.stringify(['prio-k3', 'prio-k2', 'prio-k1']),
            preservedStatusMovedToRow3,
            orderAfterUpOk: JSON.stringify(orderAfterUp) === JSON.stringify(['prio-k3', 'prio-k1', 'prio-k2']),
            orderAfterDragOk: JSON.stringify(orderAfterDrag) === JSON.stringify(['prio-k3', 'prio-k2', 'prio-k1']),
            savedOrderOk: JSON.stringify(savedIds) === JSON.stringify(['prio-k3', 'prio-k2', 'prio-k1']),
            allSavedHaveKeys,
            savedTimeoutsOk: JSON.stringify(savedTimeouts) === JSON.stringify([90, 60, 30]),
            previewRanksOk: previewOptions.length === 4
              && previewOptions[0].text.includes('به ترتیب اولویت')
              && previewOptions[1].value === 'openrouter::prio-k3' && previewOptions[1].text.includes('اولویت ۱')
              && previewOptions[2].value === 'openrouter::prio-k2' && previewOptions[2].text.includes('اولویت ۲')
              && previewOptions[3].value === 'openrouter::prio-k1' && previewOptions[3].text.includes('اولویت ۳'),
            headingHintOk,
            helpSynced,
          };
        } finally {
          state.ai = prevAi;
          aiEditorDrafts.clear();
          if ($('helpDialog')?.open) closeDialog('helpDialog');
          if ($('aiDialog')?.open) closeDialog('aiDialog');
        }
      })()
    `, context);
    check(
      'v4.08 supports API key priority ordering via ⇈ اولویت اول / ↑ بالاتر / ↓ پایین‌تر & drag-and-drop while preserving saved secrets, updating #translationPreviewService ranks, and syncing Help Chapters 7 & 8',
      v408Check.initialPrimaryBadgeOk === true
        && v408Check.readyChipsOk === true
        && v408Check.boundaryBtnsOk === true
        && v408Check.orderAfterTopOk === true
        && v408Check.orderAfterDownOk === true
        && v408Check.preservedStatusMovedToRow3 === true
        && v408Check.orderAfterUpOk === true
        && v408Check.orderAfterDragOk === true
        && v408Check.savedOrderOk === true
        && v408Check.allSavedHaveKeys === true
        && v408Check.savedTimeoutsOk === true
        && v408Check.previewRanksOk === true
        && v408Check.headingHintOk === true
        && v408Check.helpSynced === true,
      JSON.stringify(v408Check),
    );
  }

  // v4.09: Verify Help Guide Chapters 3, 4, and 8 document lossless native-resolution PDF import and grouped-page unified translation, and preview displays group page label
  {
    const v409Check = await vm.runInContext(`
      (async () => {
        try {
          openHelpDialog('import-grid-crop');
          const ch3Text = $('helpContentArea')?.textContent || '';
          openHelpDialog('page-groups');
          const ch4Text = $('helpContentArea')?.textContent || '';
          openHelpDialog('translation-preview-context');
          const ch8Text = $('helpContentArea')?.textContent || '';
          closeDialog('helpDialog');

          showTranslationRequestPreview(
            {
              provider: 'openai',
              providerLabel: 'OpenAI',
              model: 'gpt-4o-mini',
              base_url: 'https://api.openai.com/v1',
              rollingMode: true,
              contextMode: true,
              blockCount: 3,
              requestCount: 1,
              skillLimit: 300,
              contextLimit: 300,
              totalLimit: 2000,
              skill: '',
              summary: '',
              systemPrompt: 'Translate line by line.',
              note: 'زبان مقصد: فارسی. صفحات هم‌گروه (1 گروه) به‌عنوان یک صفحهٔ یکپارچه ارسال می‌شوند.',
              requests: [
                {
                  index: 1,
                  imageName: 'گروه 1 (slice-1.png + slice-2.png)',
                  characters: 58,
                  text: 'Wait, look at\\nthat glowing door!',
                },
              ],
            },
            async () => {},
            null,
            null,
          );
          const summaryTitle = document.querySelector('#translationPreviewRequests .payload-request summary')?.textContent || '';
          const noteText = $('translationPreviewNote')?.textContent || '';
          cancelTranslationRequestPreview();

          return {
            ch3HasLosslessPdf: ch3Text.includes('Lossless Native-Resolution PDF Import') && ch3Text.includes('600 DPI'),
            ch4HasGroupTranslate: ch4Text.includes('ارسال یکپارچه به ترجمه به‌عنوان یک صفحهٔ واحد') && ch4Text.includes('گروه ۱'),
            ch8HasGroupTranslate: ch8Text.includes('تجمیع خودکار صفحات هم‌گروه به‌عنوان یک صفحهٔ واحد'),
            previewShowsGroupHeader: summaryTitle.includes('گروه 1 (slice-1.png + slice-2.png)') && noteText.includes('صفحات هم‌گروه'),
          };
        } finally {
          if ($('helpDialog')?.open) closeDialog('helpDialog');
          if ($('translationPreviewDialog')?.open) cancelTranslationRequestPreview();
        }
      })()
    `, context);
    check(
      'v4.09 displays unified group page headers in translation preview and documents lossless PDF import & grouped-page translation in Help Chapters 3, 4, and 8',
      v409Check.ch3HasLosslessPdf === true
        && v409Check.ch4HasGroupTranslate === true
        && v409Check.ch8HasGroupTranslate === true
        && v409Check.previewShowsGroupHeader === true,
    );
  }

  // v4.10: Verify empty-project watermarkBtn guard, unedited watermarked thumbnail URL, and Help Chapters 3 & 13 audit updates
  {
    const v410Check = await vm.runInContext(`
      (() => {
        const savedImages = state.project.images.slice();
        try {
          state.project.images = [];
          updateSummary();
          const disabledWhenEmpty = $('watermarkBtn')?.disabled === true;
          state.project.images = [{
            ...savedImages[0],
            edited: false,
            crop: null,
            watermark: { enabled: true, text: '', logoId: 'logo-1', opacity: 60 },
          }];
          updateSummary();
          renderGrid();
          const enabledWhenPopulated = $('watermarkBtn')?.disabled === false;
          const thumbSrc = document.querySelector('#grid .item .tw > img')?.dataset?.renderedSrc || '';

          openHelpDialog('import-grid-crop');
          const ch3Text = $('helpContentArea')?.textContent || '';
          openHelpDialog('storage-memory-network');
          const ch13Text = $('helpContentArea')?.textContent || '';
          closeDialog('helpDialog');

          return {
            disabledWhenEmpty,
            enabledWhenPopulated,
            thumbUsesCroppedPreview: thumbSrc.includes('cropped=true') && !thumbSrc.includes('edited=true'),
            ch3MentionsCropFilterAndLogoWm: ch3Text.includes('کادرهای متنی بیرون از ناحیهٔ برش') && ch3Text.includes('فقط لوگوی شفاف'),
            ch13MentionsSetupOnlyAndBundled: ch13Text.includes('--setup-only') && ch13Text.includes('bundled_models'),
          };
        } finally {
          state.project.images = savedImages;
          updateSummary();
          renderGrid();
          if ($('helpDialog')?.open) closeDialog('helpDialog');
        }
      })()
    `, context);
    check(
      'v4.10 disables watermarkBtn on empty projects, previews unedited watermarked pages via cropped=true, and syncs Help Chapters 3 & 13',
      v410Check.disabledWhenEmpty === true
        && v410Check.enabledWhenPopulated === true
        && v410Check.thumbUsesCroppedPreview === true
        && v410Check.ch3MentionsCropFilterAndLogoWm === true
        && v410Check.ch13MentionsSetupOnlyAndBundled === true,
    );

    const v411ExportStreamCheck = await vm.runInContext(`
      (async () => {
        const origFetch = window.fetch;
        const prevProject = JSON.parse(JSON.stringify(state.project));
        let prepareHeaderSeen = null;
        let waitedForPendingRender = false;
        let renderFinishedBeforeExport = false;
        let deleteTokenUrl = null;
        let createObjCalls = 0;
        const origCreateObj = window.URL.createObjectURL;
        window.URL.createObjectURL = (...a) => { createObjCalls += 1; return origCreateObj(...a); };
        try {
          let resolvePending;
          const pendingPromise = new Promise((r) => { resolvePending = r; });
          const pKey = state.project.id + ':' + state.project.images[0].id;
          imageRenderTasks.set(pKey, pendingPromise);
          setTimeout(() => {
            waitedForPendingRender = true;
            imageRenderTasks.delete(pKey);
            resolvePending();
          }, 15);

          const makeJson = (obj) => ({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            text: async () => JSON.stringify(obj),
            json: async () => obj,
          });
          const handleSubRoutes = (u, opts) => {
            if (u.endsWith('/state') && opts.method === 'PUT') {
              return makeJson({ updatedAt: '2026-11-07T12:00:00Z' });
            }
            if ((u.endsWith('/rendered') || u.endsWith('/revert')) && opts.method === 'POST') {
              return makeJson({ ok: true, updatedAt: '2026-11-07T12:00:01Z' });
            }
            if (u.includes('/images/') && u.includes('/content')) {
              return { ok: true, status: 200, headers: { get: () => 'image/png' }, blob: async () => new window.Blob() };
            }
            return null;
          };

          window.fetch = async (url, opts = {}) => {
            const u = String(url);
            if (u.endsWith('/export') && opts.method === 'POST') {
              renderFinishedBeforeExport = waitedForPendingRender === true;
              prepareHeaderSeen = opts.headers?.['X-Export-Prepare'] || opts.headers?.['x-export-prepare'] || null;
              return {
                ok: true,
                status: 200,
                headers: { get: (h) => String(h).toLowerCase() === 'content-type' ? 'application/json' : '' },
                json: async () => ({ token: 'a'.repeat(32), filename: 'پروژهٔ کمیک.pdf', size: 2 * 1024 * 1024 }),
              };
            }
            if (u.includes('/export/' + 'a'.repeat(32)) && opts.method === 'DELETE') {
              deleteTokenUrl = u;
              return { ok: true, status: 204, text: async () => '' };
            }
            const sub = handleSubRoutes(u, opts);
            if (sub) return sub;
            return origFetch(url, opts);
          };

          state.project.images[0].selected = true;
          await exportResult('pdf');
          const linkHrefAfterExport = $('downloadLink').getAttribute('href');
          const linkDownloadAfterExport = $('downloadLink').getAttribute('download');
          const statusAfterExport = $('jobStatus').textContent;

          // Switching project clears #downloadLink and discards prepared token on server
          adoptProject({ ...prevProject, id: 'other-proj-v411', name: 'Other' });
          const linkHiddenAfterSwitch = $('downloadLink').classList.contains('hidden');

          // Zero-byte prepared response surfaces exact Persian diagnostic
          adoptProject(prevProject);
          state.project.images[0].selected = true;
          window.fetch = async (url, opts = {}) => {
            const u = String(url);
            if (u.endsWith('/export') && opts.method === 'POST') {
              return {
                ok: true,
                status: 200,
                headers: { get: (h) => String(h).toLowerCase() === 'content-type' ? 'application/json' : '' },
                json: async () => ({ token: 'b'.repeat(32), filename: 'empty.pdf', size: 0 }),
              };
            }
            const sub = handleSubRoutes(u, opts);
            if (sub) return sub;
            return origFetch(url, opts);
          };
          let zeroErr = '';
          try { await exportResult('pdf'); } catch (e) { zeroErr = String(e?.message || e); }

          openHelpDialog('exports-docx-pdf');
          const ch11Text = $('helpContentArea')?.textContent || '';
          closeDialog('helpDialog');

          return {
            prepareHeaderSeen,
            renderFinishedBeforeExport,
            createObjCalls,
            usesDirectStreamUrl: linkHrefAfterExport === '/api/projects/' + prevProject.id + '/export/' + 'a'.repeat(32),
            linkDownloadAfterExport,
            statusHasMb: statusAfterExport.includes('مگابایت'),
            linkHiddenAfterSwitch,
            deletedPreparedToken: Boolean(deleteTokenUrl && deleteTokenUrl.endsWith('/export/' + 'a'.repeat(32))),
            zeroErrHasEmptyMsg: zeroErr.includes('خالی'),
            ch11MentionsStream: ch11Text.includes('مستقیماً روی دیسک استریم'),
          };
        } finally {
          window.URL.createObjectURL = origCreateObj;
          window.fetch = origFetch;
          adoptProject(prevProject);
          if ($('helpDialog')?.open) closeDialog('helpDialog');
        }
      })()
    `, context);
    check(
      'v4.11 streams prepared exports directly without Blob RAM buffering, awaits pending renders, clears stale export links on project switch, and syncs Help Chapter 11',
      v411ExportStreamCheck.prepareHeaderSeen === '1'
        && v411ExportStreamCheck.renderFinishedBeforeExport === true
        && v411ExportStreamCheck.createObjCalls === 0
        && v411ExportStreamCheck.usesDirectStreamUrl === true
        && v411ExportStreamCheck.linkDownloadAfterExport === 'پروژهٔ کمیک.pdf'
        && v411ExportStreamCheck.statusHasMb === true
        && v411ExportStreamCheck.linkHiddenAfterSwitch === true
        && v411ExportStreamCheck.deletedPreparedToken === true
        && v411ExportStreamCheck.zeroErrHasEmptyMsg === true
        && v411ExportStreamCheck.ch11MentionsStream === true,
    );
  }

  // v4.12: Verify full formatting on manually added boxes (even empty & in OCR mode), font family, non-rect shapes, interactive corner rounding, interactive rotation + Shift snap, single-box translation, and grid scroll restoration
  {
    const v412Check = await vm.runInContext(`
      (async () => {
        const origFetch = window.fetch;
        const prevProject = state.project;
        let singlePreviewText = null;
        try {
          window.fetch = async (url, options = {}) => {
            const u = String(url);
            if (u.includes('/content')) return { ok: true, status: 200, blob: async () => new Blob(['img'], { type: 'image/png' }) };
            if (u.endsWith('/rendered') || u.endsWith('/revert')) return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, updatedAt: '2026-11-07T14:00:00Z' }) };
            if (u.endsWith('/state') && options.method === 'PUT') {
              const saved = JSON.parse(options.body).state;
              return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => saved };
            }
            if (u.endsWith('/api/translate-text/context-preview') && options.method === 'POST') {
              const body = JSON.parse(options.body);
              singlePreviewText = body.text;
              return {
                ok: true, status: 200, headers: { get: () => 'application/json' },
                json: async () => ({
                  provider: 'free', providerLabel: 'Google Translate', model: '', base_url: '',
                  blockCount: 1, requestCount: 1, requests: [{ index: 1, characters: body.text.length, text: body.text }],
                  systemPrompt: '', signature: 'sig-v412', note: '', rollingMode: true, contextMode: false, skill: '', summary: '', resume: false, singleContext: true,
                }),
              };
            }
            if (u.endsWith('/api/translate-text/context') && options.method === 'POST') {
              return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ text: 'ترجمهٔ تکی ۴.۱۲', summary: '' }) };
            }
            return origFetch(url, options);
          };

          adoptProject({
            id: 'proj-v412',
            name: 'پروژه ۴.۱۲',
            updatedAt: '',
            images: Array.from({ length: 6 }, (_, idx) => ({
              id: 'img-v412-' + (idx + 1),
              name: 'page-' + (idx + 1) + '.png',
              file: 'page-' + (idx + 1) + '.png',
              width: 320, height: 220, order: idx, selected: true, groupId: null, crop: null,
              blocks: idx === 4 ? [{ id: 1, text: 'SINGLE BOX SOURCE', tr: '', enabled: true, bg: 'white', x0: 20, y0: 20, x1: 220, y1: 70, lineH: 30, dir: 'rtl', align: 'right' }] : [],
              watermark: null, edited: false,
            })),
            settings: { eraseOriginal: true, output: {} },
          });

          // 1. Scroll position preserved across openEditor -> closeEditor, cancelEditor, and Esc
          document.documentElement.scrollTop = 640;
          if ($('mainwrap')) $('mainwrap').scrollTop = 280;
          await openEditor('img-v412-5');

          // 2. Manual Persian box in OCR mode & while STILL EMPTY supports font, size, bold, italic, underline, color, custom bg, shape, cornerRadius, and angle
          setOverlayMode('ocr', false);
          $('editorAddFaText').click();
          const manualFa = state.project.images[4].blocks.at(-1);
          const richEnabledOnManualInOcr = !$('inlineEditor').querySelector('.re-toolbar')?.classList.contains('is-disabled');
          $('inlineFontFamily').value = 'Tahoma';
          $('inlineFontFamily').dispatchEvent(new Event('change', { bubbles: true }));
          $('inlineLineSize').value = '24';
          $('inlineLineSize').dispatchEvent(new Event('input', { bubbles: true }));
          $('inlineSizeUp').click();
          toggleInlineCommand('bold');
          toggleInlineCommand('italic');
          toggleInlineCommand('underline');
          $('inlineEditorColor').value = '#dd2255';
          $('inlineEditorColor').dispatchEvent(new Event('input', { bubbles: true }));
          classicEditor.setHTML('<p>متن دستی فرمت‌شده</p>');
          closeInlineEditor();
          setOverlayMode('translation', false);

          // 3. Idle-selected box formatting (without opening inline editor) + shape, corner-radius drag, and Shift-snapped rotation drag
          selectEditorBlock(manualFa.id, false, false);
          $('editorBoxBg').value = 'custom';
          $('editorBoxBg').dispatchEvent(new Event('change', { bubbles: true }));
          $('editorBoxBgColor').value = '#fff3b0';
          $('editorBoxBgColor').dispatchEvent(new Event('input', { bubbles: true }));

          const mkPtr = (type, x, y, shiftKey = false) => {
            const ev = new window.Event(type, { bubbles: true, cancelable: true });
            Object.defineProperties(ev, { clientX: { value: x }, clientY: { value: y }, pointerId: { value: 7 }, button: { value: 0 }, shiftKey: { value: shiftKey } });
            return ev;
          };
          const manualBoxEl = $('editorBoxes').querySelector('.editor-box[data-id="' + manualFa.id + '"]');
          const seCorner = manualBoxEl.querySelector('[data-radius-corner="se"]');
          const scale = state.editorScale || 1;
          const bRect = boxOf(manualFa);
          seCorner.dispatchEvent(mkPtr('pointerdown', bRect.x1 * scale, bRect.y1 * scale));
          manualBoxEl.dispatchEvent(mkPtr('pointermove', (bRect.x1 - 14) * scale, (bRect.y1 - 14) * scale));
          manualBoxEl.dispatchEvent(mkPtr('pointerup', (bRect.x1 - 14) * scale, (bRect.y1 - 14) * scale));
          const draggedRadiusPct = manualFa.cornerRadius;

          const rotHandle = manualBoxEl.querySelector('[data-rotate-handle]');
          const cx = ((bRect.x0 + bRect.x1) / 2) * scale;
          const cy = ((bRect.y0 + bRect.y1) / 2) * scale;
          rotHandle.dispatchEvent(mkPtr('pointerdown', cx, cy - 40, true));
          manualBoxEl.dispatchEvent(mkPtr('pointermove', cx + 40, cy, true));
          manualBoxEl.dispatchEvent(mkPtr('pointerup', cx + 40, cy, true));
          const snappedAngle90 = manualFa.angle;

          $('editorBoxShape').value = 'cloud';
          $('editorBoxShape').dispatchEvent(new Event('change', { bubbles: true }));
          const chosenShape = manualFa.shape;

          // 4. Single-box translation on English manual box directly from #editorTranslateBlock
          $('editorAddEnText').click();
          const manualEn = state.project.images[4].blocks.at(-1);
          classicEditor.setHTML('<p>WATCH OUT!</p>');
          closeInlineEditor();
          selectEditorBlock(manualEn.id, false, false);
          $('editorTranslateBlock').click();
          await new Promise((r) => setTimeout(r, 25));
          const previewOpened = $('translationPreviewDialog').open === true;
          $('translationPreviewConfirm').click();
          await new Promise((r) => setTimeout(r, 35));
          const translatedSingleTr = manualEn.tr;

          await closeEditor(true);
          const scrollAfterApproveClose = document.documentElement.scrollTop;
          const mainScrollAfterApproveClose = $('mainwrap')?.scrollTop || 0;
          const cardHighlighted = Boolean(document.querySelector('#grid .item[data-id="img-v412-5"].just-edited'));

          // Also verify cancelEditor restores scroll position
          document.documentElement.scrollTop = 510;
          await openEditor('img-v412-5');
          document.documentElement.scrollTop = 0;
          await cancelEditor();
          const scrollAfterCancel = document.documentElement.scrollTop;

          openHelpDialog('import-grid-crop');
          const ch3Text = $('helpContentArea').textContent;
          openHelpDialog('visual-editor');
          const ch9Text = $('helpContentArea').textContent;
          openHelpDialog('shortcuts');
          const ch14Text = $('helpContentArea').textContent;
          closeDialog('helpDialog');

          return {
            richEnabledOnManualInOcr,
            manualFont: manualFa.fontFamily,
            manualSize: manualFa.size,
            manualBold: manualFa.bold,
            manualItalic: manualFa.italic,
            manualUnderline: manualFa.underline,
            manualColor: manualFa.color,
            manualBg: manualFa.bg,
            draggedRadiusOk: draggedRadiusPct > 0 && draggedRadiusPct <= 100,
            snappedAngle90,
            chosenShape,
            previewOpened,
            singlePreviewText,
            translatedSingleTr,
            scrollAfterApproveClose,
            mainScrollAfterApproveClose,
            cardHighlighted,
            scrollAfterCancel,
            helpSynced: ch3Text.includes('اسکرول') && ch9Text.includes('ابر کمیک') && ch9Text.includes('ترجمهٔ کادر') && ch14Text.includes('Shift'),
          };
        } finally {
          window.fetch = origFetch;
          if ($('helpDialog')?.open) closeDialog('helpDialog');
          if ($('translationPreviewDialog')?.open) closeDialog('translationPreviewDialog');
          if ($('editorDialog')?.open) closeDialog('editorDialog');
          if (prevProject) adoptProject(prevProject);
        }
      })()
    `, context);
    check(
      'v4.12 supports manual-box full formatting & fonts, shapes, corner-radius & Shift-rotation handles, single-box translation, and grid scroll restoration',
      v412Check.richEnabledOnManualInOcr === true
        && v412Check.manualFont === 'Tahoma'
        && v412Check.manualSize === 26
        && v412Check.manualBold === false
        && v412Check.manualItalic === true
        && v412Check.manualUnderline === true
        && v412Check.manualColor === '#dd2255'
        && v412Check.manualBg === '#fff3b0'
        && v412Check.draggedRadiusOk === true
        && v412Check.snappedAngle90 === 90
        && v412Check.chosenShape === 'cloud'
        && v412Check.previewOpened === true
        && v412Check.singlePreviewText === 'WATCH OUT!'
        && v412Check.translatedSingleTr === 'ترجمهٔ تکی ۴.۱۲'
        && v412Check.scrollAfterApproveClose === 640
        && v412Check.mainScrollAfterApproveClose === 280
        && v412Check.cardHighlighted === true
        && v412Check.scrollAfterCancel === 510
        && v412Check.helpSynced === true,
    );

    // v4.13: Verify manual EN box promotion in batch runTranslation(), splitSingleEditorBlock full attribute inheritance,
    // mergeSelectedText mismatched-angle reset, uninstallEngine danger modal styling, data-font sanitization, and watermark cleanup
    const v413Check = await vm.runInContext(`
      (async () => {
        const prevProject = state.project ? JSON.parse(JSON.stringify(state.project)) : null;
        const origFetch = window.fetch;
        let batchPreviewOpened = false;
        let batchPreviewText = '';
        try {
          window.fetch = async (url, opts) => {
            const u = String(url);
            if (u.endsWith('/state') && opts?.method === 'PUT') {
              const body = JSON.parse(opts.body);
              body.state.version = (body.state.version || 1) + 1;
              return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body.state };
            }
            if (u.endsWith('/context-preview') && opts?.method === 'POST') {
              return {
                ok: true, status: 200, headers: { get: () => 'application/json' },
                json: async () => ({
                  provider: 'free', providerLabel: 'Google Translate', model: '', base_url: '',
                  blockCount: 1, requestCount: 1, requests: [{ index: 1, characters: 20, text: 'BATCH MANUAL ENGLISH' }],
                  systemPrompt: '', signature: 'sig-v413', note: '', rollingMode: true, contextMode: false, skill: '', summary: '', resume: false,
                }),
              };
            }
            return origFetch(url, opts);
          };

          adoptProject({
            id: 'projv413',
            version: 1,
            name: 'پروژه ۴.۱۳',
            settings: { pageMode: 'comic', overlayTextMode: 'translation', targetLanguage: 'fa' },
            images: [{
              id: 'img413', name: 'page-1.png', file: 'img413.png', format: 'PNG',
              width: 500, height: 700, order: 0, selected: true, ocrCompleted: false,
              blocks: [{
                id: 1, x0: 40, y0: 40, x1: 260, y1: 120,
                text: '', tr: 'BATCH MANUAL ENGLISH', richHtml: '',
                manual: true, manualLang: 'en', dir: 'ltr', align: 'center', size: 24,
                enabled: true, eraseOriginal: false,
              }],
            }],
          });

          const runTrPromise = runTranslation({ provider: 'free', profileId: '' });
          await new Promise((r) => setTimeout(r, 40));
          batchPreviewOpened = $('translationPreviewDialog')?.open === true;
          batchPreviewText = $('translationPreviewRequests')?.textContent || '';
          const promotedText = state.project.images[0].blocks[0].text;
          cancelTranslationRequestPreview();
          await runTrPromise.catch(() => {});

          // Test mergeSelectedText angle normalization & splitSingleEditorBlock full attribute inheritance
          const mergedSample = {
            id: 10, x0: 20, y0: 20, x1: 200, y1: 140,
            text: 'Line A\\nLine B', tr: 'خط اول\\nخط دوم', richHtml: '',
            fontFamily: 'Impact', bold: false, italic: true, underline: true,
            shape: 'cloud', cornerRadius: 35, angle: 25, color: '#112233', bg: '#ddeeff',
            sourceLines: [
              { id: 10, x0: 20, y0: 20, x1: 200, y1: 75, text: 'Line A', tr: '' },
              { id: 11, x0: 20, y0: 85, x1: 200, y1: 140, text: 'Line B', tr: '' },
            ],
          };
          const splitParts = splitSingleEditorBlock(mergedSample, state.project.images[0], { maxId: 20 });

          // Test uninstallEngine danger modal variant & destructive flag
          let dangerModalCheck = false;
          const uninstPromise = uninstallEngine({ id: 'easyocr', name: 'EasyOCR' });
          await new Promise((r) => setTimeout(r, 20));
          dangerModalCheck = $('appModalDialog')?.open === true && $('appModalConfirm')?.classList.contains('danger-solid') === true;
          $('appModalCancel')?.click();
          await uninstPromise;

          // Test data-font sanitization
          const sanHtml = window.ComicSanitize.sanitize('<span data-font="Georgia">متن تست</span>');

          // Test watermark preview cleanup on closeDialog
          let bmpClosed = false;
          wmPreviewBitmap = { close() { bmpClosed = true; } };
          wmPreviewImageId = 'other-img';
          closeDialog('watermarkDialog');

          return {
            batchPreviewOpened,
            batchPreviewHasManual: batchPreviewText.includes('BATCH MANUAL ENGLISH'),
            promotedText,
            splitCount: splitParts?.length || 0,
            splitInheritedOk: Boolean(
              splitParts?.[1]?.fontFamily === 'Impact'
              && splitParts?.[1]?.shape === 'cloud'
              && splitParts?.[1]?.cornerRadius === 35
              && splitParts?.[1]?.angle === 25
              && splitParts?.[1]?.italic === true
              && splitParts?.[1]?.underline === true
            ),
            dangerModalCheck,
            sanHtmlHasGeorgia: sanHtml.includes('font-family:Georgia'),
            bmpClosed,
            wmCleared: wmPreviewBitmap === null,
          };
        } finally {
          window.fetch = origFetch;
          if ($('translationPreviewDialog')?.open) closeDialog('translationPreviewDialog');
          if (prevProject) adoptProject(prevProject);
        }
      })()
    `, context);
    check(
      'v4.13 promotes manual EN boxes in batch runTranslation(), inherits shape/font/angle on Split, styles uninstallEngine modal as danger, sanitizes data-font, and frees watermark preview bitmap',
      v413Check.batchPreviewOpened === true
        && v413Check.batchPreviewHasManual === true
        && v413Check.promotedText === 'BATCH MANUAL ENGLISH'
        && v413Check.splitCount === 2
        && v413Check.splitInheritedOk === true
        && v413Check.dangerModalCheck === true
        && v413Check.sanHtmlHasGeorgia === true
        && v413Check.bmpClosed === true
        && v413Check.wmCleared === true,
      JSON.stringify(v413Check),
    );

    const v414ShapesCheck = await vm.runInContext(`
      (() => {
        const shapeOpts = [...($('editorBoxShape')?.options || [])].map((o) => o.value);
        openHelpDialog('visual-editor');
        const ch9Text = $('helpContentArea')?.textContent || '';
        closeDialog('helpDialog');
        const emptyManualStar = { id: 91, manual: true, enabled: true, tr: '', bg: 'white', shape: 'star' };
        const emptyOcrStar = { id: 92, manual: false, enabled: true, tr: '', bg: 'white', shape: 'star' };
        return {
          shapeOpts,
          hasOverlayForManualStar: hasOverlayText({ blocks: [emptyManualStar] }, 'translation'),
          hasOverlayInNoneMode: hasOverlayText({ blocks: [emptyManualStar] }, 'none'),
          hasOverlayForEmptyOcr: hasOverlayText({ blocks: [emptyOcrStar] }, 'translation'),
          helpHasStarAndThought: ch9Text.includes('ستاره (۵پر)') && ch9Text.includes('ابر فکر') && ch9Text.includes('حباب گفتگو') && ch9Text.includes('ابر کمیک'),
        };
      })()
    `, context);
    check(
      'v4.14 exposes all 14 writing shapes (star, burst, seal, cloud, thought, speech, heart, banner, etc.), renders manual shaped box fill before typing, and documents shapes in Help Chapter 9',
      v414ShapesCheck.shapeOpts.length === 14
        && ['star', 'burst', 'seal', 'cloud', 'thought', 'speech', 'heart', 'banner', 'octagon'].every((k) => v414ShapesCheck.shapeOpts.includes(k))
        && v414ShapesCheck.hasOverlayForManualStar === true
        && v414ShapesCheck.hasOverlayInNoneMode === false
        && v414ShapesCheck.hasOverlayForEmptyOcr === false
        && v414ShapesCheck.helpHasStarAndThought === true,
      JSON.stringify(v414ShapesCheck),
    );
  }

  // v4.15: Offline Hardware-Bound Activation Gate, Local Password Login & Chapter 15 Help
  {
    mockLicenseState = { ...mockLicenseState, licensed: false, unlocked: false, reason: 'unlicensed', message: 'برنامه هنوز فعال نشده است.' };
    await vm.runInContext('refreshAuthGateState()', context);
    check(
      'v4.15 unlicensed state activates auth-locked body class and displays System Code in #authGateOverlay',
      window.document.body.classList.contains('auth-locked')
        && !$('authGateOverlay').classList.contains('hidden')
        && !$('authActivatePane').classList.contains('hidden')
        && $('gateHardwareId').textContent === 'CS4-ABCD-EFGH-2345-6789',
    );
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'F1', bubbles: true, cancelable: true }));
    check(
      'v4.15 pressing F1 on Activation Gate opens Help Chapter 15 (license-login-security)',
      $('helpDialog').open === true && $('helpContentArea').textContent.includes('CLIC1.') && $('helpContentArea').textContent.includes('PBKDF2-SHA256'),
    );
    await vm.runInContext("closeDialog('helpDialog')", context);

    $('gateLicenseKeyInput').value = 'CLIC1.validPayload.validSignature';
    await vm.runInContext('submitGateLicenseActivation()', context);
    check(
      'v4.15 activating valid CLIC1. license unlocks workspace and hides #authGateOverlay',
      !window.document.body.classList.contains('auth-locked') && $('authGateOverlay').classList.contains('hidden'),
    );

    await vm.runInContext('openLicenseDialog()', context);
    check('v4.15 #licenseDialog opens showing holder and plan', $('licenseDialog').open === true && $('licInfoHolder').textContent === 'کاربر آزمایشی');
    $('licNewPwdInput').value = 'Pass#415';
    $('licConfirmPwdInput').value = 'Pass#415';
    await vm.runInContext('saveLocalPasswordFromDialog()', context);
    check('v4.15 setting local password reveals #lockAppMenuBtn', !$('lockAppMenuBtn').classList.contains('hidden'));
    await vm.runInContext("closeDialog('licenseDialog')", context);

    await vm.runInContext('lockWorkspaceNow()', context);
    check(
      'v4.15 locking workspace switches to #authLoginPane',
      window.document.body.classList.contains('auth-locked')
        && !$('authLoginPane').classList.contains('hidden')
        && $('authActivatePane').classList.contains('hidden'),
    );
    $('gateLoginPasswordInput').value = 'WrongPass';
    await vm.runInContext('submitGatePasswordLogin()', context);
    check('v4.15 wrong password keeps workspace locked with Persian error', window.document.body.classList.contains('auth-locked') && !$('gateLoginError').classList.contains('hidden'));
    $('gateLoginPasswordInput').value = 'Pass#415';
    await vm.runInContext('submitGatePasswordLogin()', context);
    check('v4.15 correct local password unlocks workspace', !window.document.body.classList.contains('auth-locked') && $('authGateOverlay').classList.contains('hidden'));

    await vm.runInContext('openLicenseDialog()', context);
    $('licCurrentPwdInput').value = 'Pass#415';
    const rmTask = vm.runInContext('removeLocalPasswordFromDialog()', context);
    await new Promise((r) => setTimeout(r, 15));
    check('v4.15 removing local password uses themed #appModalDialog (zero native confirm)', $('appModalDialog').open === true);
    $('appModalConfirm').click();
    await rmTask;
    await vm.runInContext("closeDialog('licenseDialog')", context);
    check('v4.15 local password removed cleanly', $('lockAppMenuBtn').classList.contains('hidden'));

    // v4.16: 24-Hour Trial Top Banner (09361111111) + Independent 3-Module Licensing Guards
    mockLicenseState = {
      ...mockLicenseState,
      licensed: true,
      unlocked: true,
      isTrial: true,
      trialExpiresAt: Math.floor(Date.now() / 1000) + 23 * 3600,
      trialRemainingSeconds: 23 * 3600,
      supportPhone: '09361111111',
      modules: {
        ocr: { active: true, source: 'trial', plan: 'trial24h', remainingSeconds: 23 * 3600 },
        translation: { active: true, source: 'trial', plan: 'trial24h', remainingSeconds: 23 * 3600 },
        editing: { active: true, source: 'trial', plan: 'trial24h', remainingSeconds: 23 * 3600 },
      },
      license: { holder: 'نسخهٔ آزمایشی ۲۴ ساعته', plan: 'trial24h', planLabel: 'آزمایشی ۲۴ ساعته' },
    };
    await vm.runInContext('refreshAuthGateState()', context);
    check(
      'v4.16 24-hour trial shows #trialNoticeBanner and v4.17 #licenseTopStatusBtn with remaining hours',
      !$('trialNoticeBanner').classList.contains('hidden')
        && $('trialNoticeText').textContent.includes('09361111111')
        && $('trialNoticeText').textContent.includes('۲۴ ساعته')
        && !$('licenseTopStatusBtn').classList.contains('hidden')
        && $('licenseTopStatusText').textContent.includes('آزمایشی')
        && $('licenseTopStatusText').textContent.includes('مانده'),
    );

    mockLicenseState = {
      ...mockLicenseState,
      isTrial: false,
      trialRemainingSeconds: 0,
      vendorContact: {
        supportPhone: '09361111111',
        whatsapp: '09361111111',
        telegram: '@ComicSupportTest',
        domesticMessenger: 'ایتا: @ComicIR',
        supportHours: '۹ الی ۲۲',
        website: 'https://comic.example.ir',
        customNote: 'برای دریافت آنی پیام بدهید.',
      },
      modules: {
        ocr: { active: true, source: 'license', plan: 'lifetime', expiresAt: null },
        translation: { active: false, source: 'unlicensed', plan: 'none', expiresAt: null },
        editing: { active: true, source: 'license', plan: 'subscription', expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400, daysRemaining: 30 },
      },
      license: { holder: 'کاربر ماژولار', plan: 'modular', planLabel: 'ماژولار' },
    };
    await vm.runInContext('refreshAuthGateState()', context);
    check(
      'v4.16/v4.17 paid modular license hides trial banner, shows remaining license time in #licenseTopStatusBtn, and marks unlicensed module buttons with .mod-locked',
      $('trialNoticeBanner').classList.contains('hidden')
        && !$('licenseTopStatusBtn').classList.contains('hidden')
        && $('licenseTopStatusText').textContent.includes('OCR: دائمی')
        && $('licenseTopStatusText').textContent.includes('ویرایش:')
        && !$('ocrBtn').classList.contains('mod-locked')
        && $('translateBtn').classList.contains('mod-locked')
        && !$('watermarkBtn').classList.contains('mod-locked'),
    );
    $('licenseTopStatusBtn').click();
    await new Promise((r) => setTimeout(r, 20));
    const orderMsgSample = await vm.runInContext("buildCustomerOrderRequestText('CS4-ABCD-EFGH-JKLM-NPQR')", context);
    check(
      'v4.17/v4.18 clicking #licenseTopStatusBtn opens #licenseDialog with #licInfoRemaining, vendor channels (Telegram/WhatsApp/Eitaa/Hours/Website), and ready order message',
      $('licenseDialog').open === true
        && $('licSupportPhone').textContent === '09361111111'
        && $('licVendorChannels').textContent.includes('@ComicSupportTest')
        && $('licVendorChannels').textContent.includes('ایتا: @ComicIR')
        && $('licVendorChannels').textContent.includes('۹ الی ۲۲')
        && $('licVendorChannels').textContent.includes('https://comic.example.ir')
        && orderMsgSample.includes('CS4-ABCD-EFGH-JKLM-NPQR')
        && $('licInfoRemaining').textContent.includes('OCR: دائمی')
        && $('licMod_ocr').textContent.includes('دائمی')
        && $('licMod_translation').textContent.includes('غیرفعال')
        && $('licMod_editing').textContent.includes('۳۰'),
    );
    await vm.runInContext("closeDialog('licenseDialog')", context);

    const guardTask = vm.runInContext("ensureModuleLicensed('translation')", context);
    await new Promise((r) => setTimeout(r, 15));
    check(
      'v4.16 clicking unlicensed module opens #appModalDialog mentioning 09361111111 (zero native alert)',
      $('appModalDialog').open === true && $('appModalMessage').textContent.includes('09361111111'),
    );
    $('appModalCancel').click();
    const guardAllowed = await guardTask;
    check('v4.16 ensureModuleLicensed returns false for unlicensed module', guardAllowed === false);

    // v4.20: renderVendorChannelsInto linkifies t.me/... and bare domain safely, and lockWorkspaceNow flushes savePending before logout
    const v420UiCheck = await vm.runInContext(`
      (async () => {
        const tmpBox = document.createElement('div');
        renderVendorChannelsInto(tmpBox, {
          telegram: 't.me/ComicSupportIR',
          website: 'comicstudio.example.ir',
        });
        const links = [...tmpBox.querySelectorAll('a')].map((a) => a.href);

        const order = [];
        const origSave = saveProject;
        const origFetch = window.fetch;
        savePending = true;
        saveProject = async () => { order.push('saveProject'); savePending = false; };
        window.fetch = async (url, opts) => {
          if (String(url).includes('/api/license/logout')) {
            order.push('logout');
            return {
              ok: true,
              status: 200,
              headers: { get: () => 'application/json' },
              json: async () => ({
                licensed: true,
                unlocked: false,
                passwordEnabled: true,
                reason: 'login_required',
                hardwareId: 'CS4-ABCD-EFGH-JKLM-NPQR',
                supportPhone: '09361111111',
                modules: {
                  ocr: { active: true, plan: 'lifetime', label: 'استخراج متن (OCR)' },
                  translation: { active: false, label: 'ترجمه' },
                  editing: { active: true, plan: 'lifetime', label: 'ویرایش' },
                },
              }),
              text: async () => JSON.stringify({
                licensed: true,
                unlocked: false,
                passwordEnabled: true,
                reason: 'login_required',
                hardwareId: 'CS4-ABCD-EFGH-JKLM-NPQR',
                supportPhone: '09361111111',
                modules: {
                  ocr: { active: true, plan: 'lifetime', label: 'استخراج متن (OCR)' },
                  translation: { active: false, label: 'ترجمه' },
                  editing: { active: true, plan: 'lifetime', label: 'ویرایش' },
                },
              }),
            };
          }
          return origFetch(url, opts);
        };
        try {
          await lockWorkspaceNow();
        } finally {
          saveProject = origSave;
          window.fetch = origFetch;
          await applyAuthGateUi({
            licensed: true,
            unlocked: true,
            passwordEnabled: false,
            hardwareId: 'CS4-ABCD-EFGH-JKLM-NPQR',
            supportPhone: '09361111111',
            modules: {
              ocr: { active: true, plan: 'lifetime', label: 'استخراج متن (OCR)' },
              translation: { active: true, plan: 'lifetime', label: 'ترجمه' },
              editing: { active: true, plan: 'lifetime', label: 'ویرایش' },
            },
          });
        }
        return { links, order };
      })()
    `, context);
    check(
      'v4.20 renderVendorChannelsInto linkifies t.me/... & bare domains safely and lockWorkspaceNow flushes saveProject before logout',
      v420UiCheck.links.includes('https://t.me/ComicSupportIR')
        && v420UiCheck.links.includes('https://comicstudio.example.ir/')
        && v420UiCheck.order[0] === 'saveProject'
        && v420UiCheck.order[1] === 'logout',
      JSON.stringify(v420UiCheck),
    );

    // v4.21: Verify #ocrPersianPreprocess auto-enables on Persian ('fas'), switches from unready to ready Persian engine,
    // respects manual user toggle, forwards persian_preprocess in OCR payload, and documents the option in Help guide
    const v421UiCheck = await vm.runInContext(`
      (async () => {
        const prevEngines = state.engines;
        const prevSettings = JSON.parse(JSON.stringify(state.project.settings || {}));
        try {
          state.engines = [
            { id: 'rapidocr-v6', name: 'PP-OCRv6 Small', selectable: true, runtimeInstalled: true, languages: ['eng'], readyLanguages: ['eng'], description: 'fast', family: 'Paddle' },
            { id: 'rapidocr-v5', name: 'PP-OCRv5 Mobile', selectable: true, runtimeInstalled: true, languages: ['eng', 'fas'], readyLanguages: ['eng'], description: 'multi', family: 'Paddle' },
            { id: 'tesseract', name: 'Tesseract 5 LSTM', selectable: true, runtimeInstalled: true, languages: ['eng', 'fas'], readyLanguages: ['eng', 'fas'], description: 'doc', family: 'Tesseract' },
          ];
          delete state.project.settings.persianPreprocessCustomized;
          $('ocrLanguage').value = 'eng';
          updateEngineOptions('rapidocr-v5');
          $('ocrPersianPreprocess').checked = false;

          // Switch language to Persian ('fas'): auto-checks #ocrPersianPreprocess AND switches from unready rapidocr-v5 to ready tesseract!
          $('ocrLanguage').value = 'fas';
          $('ocrLanguage').dispatchEvent(new window.Event('change', { bubbles: true }));
          const autoCheckedOnFas = $('ocrPersianPreprocess').checked === true;
          const switchedToReadyEngine = $('ocrEngine').value === 'tesseract';
          const savedInSettings = state.project.settings.persianPreprocess === true;

          // Switch back to English before manual customization -> auto-unchecks #ocrPersianPreprocess
          $('ocrLanguage').value = 'eng';
          $('ocrLanguage').dispatchEvent(new window.Event('change', { bubbles: true }));
          const autoUncheckedOnEng = $('ocrPersianPreprocess').checked === false;

          // Manually turn OFF #ocrPersianPreprocess on Persian -> manual choice stays respected across language switches
          $('ocrLanguage').value = 'fas';
          $('ocrLanguage').dispatchEvent(new window.Event('change', { bubbles: true }));
          $('ocrPersianPreprocess').checked = false;
          $('ocrPersianPreprocess').dispatchEvent(new window.Event('change', { bubbles: true }));
          $('ocrLanguage').value = 'fas';
          $('ocrLanguage').dispatchEvent(new window.Event('change', { bubbles: true }));
          const manualOverrideRespected = $('ocrPersianPreprocess').checked === false && state.project.settings.persianPreprocessCustomized === true;

          // Help guide documents پیش‌پردازش ویژه فارسی in section ocr-modes
          const helpOcrModes = window.ComicHelpGuide.HELP_SECTIONS.find((s) => s.id === 'ocr-modes');
          const helpHasPersianPreprocess = Boolean(helpOcrModes && helpOcrModes.features.some((f) => f.includes('پیش‌پردازش ویژه فارسی')));

          return {
            autoCheckedOnFas,
            switchedToReadyEngine,
            savedInSettings,
            autoUncheckedOnEng,
            manualOverrideRespected,
            helpHasPersianPreprocess,
          };
        } finally {
          state.engines = prevEngines;
          state.project.settings = prevSettings;
          $('ocrLanguage').value = 'eng';
          $('ocrPersianPreprocess').checked = false;
          updateEngineOptions('rapidocr-v6', { resort: true });
        }
      })()
    `, context);
    check(
      'v4.21 #ocrPersianPreprocess auto-enables on Persian, switches to ready Persian engine, respects manual toggle, and is documented in Help guide',
      v421UiCheck.autoCheckedOnFas === true
        && v421UiCheck.switchedToReadyEngine === true
        && v421UiCheck.savedInSettings === true
        && v421UiCheck.autoUncheckedOnEng === true
        && v421UiCheck.manualOverrideRespected === true
        && v421UiCheck.helpHasPersianPreprocess === true,
      JSON.stringify(v421UiCheck),
    );

    const v422AlwaysEnabledCheck = await vm.runInContext(`
      (async () => {
        const prevImages = JSON.parse(JSON.stringify(state.project.images));
        const prevSettings = JSON.parse(JSON.stringify(state.project.settings || {}));
        const origFetch = window.fetch;
        window.fetch = async (url, opts) => {
          const u = String(url);
          if (u.endsWith('/content')) return { ok: true, status: 200, headers: { get: () => 'image/png' }, blob: async () => new window.Blob() };
          if (u.endsWith('/rendered') || (u.includes('/api/projects/') && opts?.method === 'PUT')) {
            return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => state.project, text: async () => JSON.stringify(state.project) };
          }
          return origFetch(url, opts);
        };
        try {
          const testImgId = prevImages[0]?.id || 'img-1';
          state.project.settings.overlayMode = 'translation';
          state.project.images = [{
            ...(prevImages[0] || {}),
            id: testImgId,
            name: 'v422.png',
            width: 600,
            height: 800,
            selected: true,
            blocks: [
              { id: 1, x0: 20, y0: 20, x1: 220, y1: 60, text: 'LINE ONE', tr: 'خط اول', richHtml: '<div style="color:#112233">خط اول</div>', enabled: true, bg: 'white', dir: 'rtl', align: 'right', bold: true },
              { id: 2, x0: 20, y0: 70, x1: 220, y1: 110, text: 'LINE TWO', tr: 'خط دوم', richHtml: '<div>خط دوم</div>', enabled: true, bg: 'white', dir: 'rtl', align: 'right', bold: true },
            ],
          }];
          await openEditor(testImgId);
          clearEditorSelection();

          const countDisabledControls = () => [...document.querySelectorAll(
            '#inlineEditor button:not(#editorPasteBlock), #inlineEditor select, #inlineEditor input'
          )].filter((el) => el.disabled).length;

          // 1. Zero disabled editing controls even in idle state with 0 selected boxes
          const disabledIdleNoSelection = countDisabledControls();

          // 2. Merge two boxes -> merged box is selected (!inlineDraft). ALL controls enabled and work directly!
          selectAllEditorBlocks();
          mergeSelectedText();
          const disabledAfterMerge = countDisabledControls();
          const mergedBlock = state.project.images[0].blocks[0];
          const cleanMergedHtml = !mergedBlock.richHtml.includes('</div><br><div');

          // Direct toolbar formatting on selected merged box WITHOUT opening inlineDraft first:
          document.querySelector('#inlineEditor .classic-toolbar button[aria-label="پررنگ"]').click();
          document.querySelector('#inlineEditor .classic-toolbar button[aria-label="ایتالیک"]').click();
          document.querySelector('#inlineEditor .classic-toolbar button[aria-label="زیرخط"]').click();
          document.querySelector('#inlineEditor .classic-toolbar button[aria-label="خط‌خورده"]').click();
          document.querySelector('#inlineEditor .classic-toolbar button[aria-label="تراز وسط"]').click();
          const colorInp = document.querySelector('#inlineEditor .classic-toolbar input[type="color"]');
          colorInp.value = '#cc1144';
          colorInp.dispatchEvent(new window.Event('input', { bubbles: true }));
          const directMergedFormattingOk = (
            mergedBlock.bold === false
            && mergedBlock.italic === true
            && mergedBlock.underline === true
            && mergedBlock.strike === true
            && mergedBlock.align === 'center'
            && mergedBlock.color === '#cc1144'
          );

          // 3. Open merged box with clickEvent = null (sidebar / programmatic) and detached range recovery:
          openInlineEditor(mergedBlock, null);
          const seededRangeValid = Boolean(inlineDraft && inlineDraft.range && $('inlineEditorField').contains(inlineDraft.range.startContainer));
          inlineDraft.range = null;
          window.getSelection().removeAllRanges();
          document.querySelector('#inlineEditor .classic-toolbar button[aria-label="تراز چپ"]').click();
          const formatSelect = document.querySelector('#inlineEditor .classic-toolbar select[aria-label="قالب بند"]');
          formatSelect.value = 'h2';
          formatSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
          const headingAppliedOnDetachedRange = $('inlineEditorField').innerHTML.toLowerCase().includes('<h2');
          closeInlineEditor();

          // 4. Duplicate the merged box, then split ONLY the duplicate -> unique IDs & shifted coordinates!
          const dupes = duplicateEditorBlocks([mergedBlock]);
          const copiedMerged = dupes[0];
          const disabledAfterCopy = countDisabledControls();
          selectEditorBlock(copiedMerged.id, false, false);
          document.querySelector('#inlineEditor .classic-toolbar button[aria-label="پررنگ"]').click();
          const copiedFormatWorked = copiedMerged.bold === true;
          splitSelectedText();
          const allBlocksAfterSplit = state.project.images[0].blocks;
          const allIdsUnique = new Set(allBlocksAfterSplit.map((b) => String(b.id))).size === allBlocksAfterSplit.length;
          const splitStayedShifted = allBlocksAfterSplit.length === 3
            && allBlocksAfterSplit[1].x0 === 42
            && allBlocksAfterSplit[1].y0 === 42
            && allBlocksAfterSplit[2].x0 === 42
            && allBlocksAfterSplit[2].y0 === 92;

          // 5. OCR mode rich editing: toolbar NEVER enters plain-mode, plain edit stays _plainText=true, rich edit saves ocrRichHtml
          setOverlayMode('ocr', true);
          const ocrTarget = state.project.images[0].blocks[0];
          openInlineEditor(ocrTarget, null);
          const disabledInOcrMode = countDisabledControls();
          const noPlainModeClass = !$('inlineEditor').classList.contains('plain-mode')
            && !classicEditor.element.classList.contains('classic-plain-mode');
          document.querySelector('#inlineEditor .classic-toolbar button[aria-label="ایتالیک"]').click();
          closeInlineEditor();
          const ocrOverlayRich = overlayBlock(ocrTarget, 'ocr');
          const ocrRichSavedWithoutTouchingTr = Boolean(
            ocrTarget.ocrRichHtml.includes('italic')
            && ocrOverlayRich._plainText === false
            && ocrTarget.tr.includes('خط اول')
          );

          // Switch to Text (HTML) tab -> toolbar controls remain enabled
          openInlineEditor(ocrTarget, null);
          document.querySelectorAll('#inlineEditor .classic-tabs [role="tab"]')[1].click();
          const disabledInTextTab = countDisabledControls();
          closeInlineEditor();
          await closeEditor(false);

          const helpVisual = window.ComicHelpGuide.HELP_SECTIONS.find((s) => s.id === 'visual-editor');
          const helpUpdated = Boolean(helpVisual && helpVisual.features.some((f) => f.includes('همیشه فعال')));

          return {
            disabledIdleNoSelection,
            disabledAfterMerge,
            cleanMergedHtml,
            directMergedFormattingOk,
            seededRangeValid,
            headingAppliedOnDetachedRange,
            disabledAfterCopy,
            copiedFormatWorked,
            allIdsUnique,
            splitStayedShifted,
            disabledInOcrMode,
            noPlainModeClass,
            ocrRichSavedWithoutTouchingTr,
            disabledInTextTab,
            helpUpdated,
          };
        } finally {
          window.fetch = origFetch;
          state.project.images = prevImages;
          state.project.settings = prevSettings;
          setOverlayMode(prevSettings.overlayMode || 'translation', false);
        }
      })()
    `, context);
    check(
      'v4.22 keeps all editing controls permanently enabled across idle, merged, copied, OCR, and Text-tab states with detached-range recovery and unique split IDs on copied merged boxes',
      v422AlwaysEnabledCheck.disabledIdleNoSelection === 0
        && v422AlwaysEnabledCheck.disabledAfterMerge === 0
        && v422AlwaysEnabledCheck.cleanMergedHtml === true
        && v422AlwaysEnabledCheck.directMergedFormattingOk === true
        && v422AlwaysEnabledCheck.seededRangeValid === true
        && v422AlwaysEnabledCheck.headingAppliedOnDetachedRange === true
        && v422AlwaysEnabledCheck.disabledAfterCopy === 0
        && v422AlwaysEnabledCheck.copiedFormatWorked === true
        && v422AlwaysEnabledCheck.allIdsUnique === true
        && v422AlwaysEnabledCheck.splitStayedShifted === true
        && v422AlwaysEnabledCheck.disabledInOcrMode === 0
        && v422AlwaysEnabledCheck.noPlainModeClass === true
        && v422AlwaysEnabledCheck.ocrRichSavedWithoutTouchingTr === true
        && v422AlwaysEnabledCheck.disabledInTextTab === 0
        && v422AlwaysEnabledCheck.helpUpdated === true,
      JSON.stringify(v422AlwaysEnabledCheck),
    );

    const v423PersianAutoUpgradeCheck = vm.runInContext(`
      (() => {
        const prevEngines = state.engines.map((e) => ({ ...e }));
        const prevLang = $('ocrLanguage').value;
        const prevMode = $('ocrPageMode').value;
        try {
          state.engines = [
            { id: 'rapidocr-v5', name: 'PP-OCRv5 Mobile', selectable: true, runtimeInstalled: true, languages: ['eng', 'fas'], readyLanguages: ['eng', 'fas'], description: 'multi', family: 'Paddle' },
            { id: 'easyocr', name: 'EasyOCR', selectable: true, runtimeInstalled: true, languages: ['eng', 'fas'], readyLanguages: ['eng', 'fas'], description: 'comic', family: 'CRAFT' },
            { id: 'tesseract', name: 'Tesseract 5 LSTM', selectable: true, runtimeInstalled: true, languages: ['eng', 'fas'], readyLanguages: ['eng', 'fas'], description: 'doc', family: 'Tesseract' },
          ];
          $('ocrPageMode').value = 'comic';
          $('ocrLanguage').value = 'eng';
          updateEngineOptions('rapidocr-v5', { resort: true });
          // Switch to Persian in comic mode -> must auto-upgrade from medium rapidocr-v5 to best easyocr!
          $('ocrLanguage').value = 'fas';
          $('ocrLanguage').dispatchEvent(new window.Event('change', { bubbles: true }));
          const upgradedComic = $('ocrEngine').value === 'easyocr';
          // Switch pageMode to document while on Persian -> must auto-upgrade from weak easyocr to best tesseract!
          $('ocrPageMode').value = 'document';
          $('ocrPageMode').dispatchEvent(new window.Event('change', { bubbles: true }));
          const upgradedDoc = $('ocrEngine').value === 'tesseract';
          const helpOcrModes = window.ComicHelpGuide.HELP_SECTIONS.find((s) => s.id === 'ocr-modes');
          const helpOcrModels = window.ComicHelpGuide.HELP_SECTIONS.find((s) => s.id === 'ocr-models');
          const helpDocsKafGafAndJoining = Boolean(
            helpOcrModes && helpOcrModes.features.some((f) => f.includes('تفاوت «ک» و «گ»') && f.includes('می‌چسبند'))
            && helpOcrModels && helpOcrModels.features.some((f) => f.includes('tessdata_best'))
          );
          return { upgradedComic, upgradedDoc, helpDocsKafGafAndJoining };
        } finally {
          state.engines = prevEngines;
          $('ocrLanguage').value = prevLang;
          $('ocrPageMode').value = prevMode;
          updateEngineOptions('', { resort: true });
        }
      })()
    `, context);
    check(
      'v4.23 auto-upgrades from medium/weak engines to ready green Persian engines across language and page-mode switches and updates Help guide',
      v423PersianAutoUpgradeCheck.upgradedComic === true
        && v423PersianAutoUpgradeCheck.upgradedDoc === true
        && v423PersianAutoUpgradeCheck.helpDocsKafGafAndJoining === true,
      JSON.stringify(v423PersianAutoUpgradeCheck),
    );

    const v424PersianAdoptAndHelpCheck = await vm.runInContext(`
      (() => {
        const snap = JSON.parse(JSON.stringify(state.project));
        try {
          // 1. Saved Persian project where persianPreprocess defaulted to false (not manually customized) -> auto-enables!
          const faProjAuto = JSON.parse(JSON.stringify(snap));
          faProjAuto.settings = { ...faProjAuto.settings, ocrLanguage: 'fas', persianPreprocess: false };
          delete faProjAuto.settings.persianPreprocessCustomized;
          adoptProject(faProjAuto);
          const autoEnabledOnSavedFa = $('ocrPersianPreprocess').checked === true;

          // 2. Saved Persian project where user explicitly unchecked persianPreprocess (persianPreprocessCustomized: true) -> stays false!
          const faProjManualOff = JSON.parse(JSON.stringify(snap));
          faProjManualOff.settings = { ...faProjManualOff.settings, ocrLanguage: 'fas', persianPreprocess: false, persianPreprocessCustomized: true };
          adoptProject(faProjManualOff);
          const manualOffPreserved = $('ocrPersianPreprocess').checked === false;

          // 3. Help Chapters 5 & 6 document v4.24 SOTA Persian OCR (PSM 13 RAW_LINE, LAB chromatic boxes, deskew, rasm lexicon)
          const helpModes = window.ComicHelpGuide.HELP_SECTIONS.find((s) => s.id === 'ocr-modes');
          const helpModels = window.ComicHelpGuide.HELP_SECTIONS.find((s) => s.id === 'ocr-models');
          const helpHasV424Sota = Boolean(
            helpModes && helpModes.features.some((f) => f.includes('LAB') && f.includes('اسکلت رسم‌الخط'))
            && helpModels && helpModels.features.some((f) => f.includes('PSM 13 RAW_LINE'))
          );
          return { autoEnabledOnSavedFa, manualOffPreserved, helpHasV424Sota };
        } finally {
          adoptProject(snap);
        }
      })()
    `, context);
    check(
      'v4.24 auto-enables #ocrPersianPreprocess on saved Persian projects unless manually customized and updates Help Chapters 5 & 6',
      v424PersianAdoptAndHelpCheck.autoEnabledOnSavedFa === true
        && v424PersianAdoptAndHelpCheck.manualOffPreserved === true
        && v424PersianAdoptAndHelpCheck.helpHasV424Sota === true,
      JSON.stringify(v424PersianAdoptAndHelpCheck),
    );

    // v4.27/v4.29: the in-app Help must document the Persian table reading and the automatic
    // download of the missing Persian language file.
    const v427TableHelpCheck = await vm.runInContext(`
      (() => {
        const helpModes = window.ComicHelpGuide.HELP_SECTIONS.find((s) => s.id === 'ocr-modes');
        const helpHasV427Table = Boolean(
          helpModes
          && helpModes.features.some((f) => f.includes('سلول') && f.includes('جدول'))
          && helpModes.example && helpModes.example.body.includes('جدول')
        );
        const helpHasV428AutoLang = Boolean(
          helpModes
          && helpModes.features.some((f) => f.includes('دانلود خودکار فایل زبان فارسی') && f.includes('fas'))
        );
        const verText = document.querySelector('.brand .ver')?.textContent || '';
        return { helpHasV427Table, helpHasV428AutoLang, verHas428: verText.includes('۴.۳۰') };
      })()
    `, context);
    check(
      'v4.27/v4.29 document the cell-by-cell Persian table reading and the automatic Persian language download in Help chapter 6',
      v427TableHelpCheck.helpHasV427Table === true
        && v427TableHelpCheck.helpHasV428AutoLang === true
        && v427TableHelpCheck.verHas428 === true,
      JSON.stringify(v427TableHelpCheck),
    );
  }

  // v4.29: the user can decide how much of the machine the studio may use (#resourcesBtn / #resourcesDialog).
  {
    const v429ResourcesCheck = await vm.runInContext(`
      (async () => {
        const origFetch = window.fetch;
        let putPayload = null;
        const mockJson = (payload) => ({
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => payload,
        });
        window.fetch = async (url, opts = {}) => {
          const parsed = new URL(url, 'http://127.0.0.1:8765');
          if (parsed.pathname === '/api/resources' && (!opts.method || opts.method === 'GET')) {
            return mockJson({
              mode: 'auto', cpuPercent: 60, ramPercent: 60, cpuCores: 8, ramGb: 16,
              allowedCores: 8, allowedRamMb: 15000, minPercent: 10, maxPercent: 100,
            });
          }
          if (parsed.pathname === '/api/resources' && opts.method === 'PUT') {
            putPayload = JSON.parse(opts.body || '{}');
            return mockJson({
              mode: putPayload.mode, cpuPercent: putPayload.cpuPercent, ramPercent: putPayload.ramPercent,
              cpuCores: 8, ramGb: 16, allowedCores: 2, allowedRamMb: 6000, minPercent: 10, maxPercent: 100,
            });
          }
          return mockJson({});
        };
        $('resourcesBtn').click();
        await new Promise((resolve) => setTimeout(resolve, 80));
        const opened = $('resourcesDialog').open === true;
        const autoChecked = $('resourcesAutoMode').checked === true;
        const cpuInfo = $('resourcesCpuInfo').textContent || '';
        const ramInfo = $('resourcesRamInfo').textContent || '';
        $('resourcesAutoMode').checked = false;
        $('resourcesAutoMode').dispatchEvent(new window.Event('change'));
        $('resourcesCpuPercent').value = '30';
        $('resourcesCpuPercent').dispatchEvent(new window.Event('input'));
        const manualVisible = !$('resourcesManualBox').classList.contains('hidden');
        const cpuLabel = $('resourcesCpuValue').textContent || '';
        $('resourcesSaveBtn').click();
        await new Promise((resolve) => setTimeout(resolve, 80));
        window.fetch = origFetch;
        if ($('resourcesDialog')?.open) closeDialog('resourcesDialog');
        return { opened, autoChecked, cpuInfo, ramInfo, manualVisible, cpuLabel, putPayload };
      })()
    `, context);
    check(
      'v4.29 opens the CPU/RAM budget dialog from #resourcesBtn, shows the machine specs and saves the chosen percentages',
      v429ResourcesCheck.opened === true
        && v429ResourcesCheck.autoChecked === true
        && /هسته/.test(v429ResourcesCheck.cpuInfo)
        && /گیگابایت/.test(v429ResourcesCheck.ramInfo)
        && v429ResourcesCheck.manualVisible === true
        && /۳۰/.test(v429ResourcesCheck.cpuLabel)
        && v429ResourcesCheck.putPayload
        && v429ResourcesCheck.putPayload.mode === 'manual'
        && v429ResourcesCheck.putPayload.cpuPercent === 30
        && v429ResourcesCheck.putPayload.ramPercent === 60,
      JSON.stringify(v429ResourcesCheck),
    );
  }

  // v4.30 - the studio must survive a hiccup while starting and must tell the
  // user when the local app stops answering (instead of a dead workspace).
  const v430BootCheck = await vm.runInContext(`
    (async () => {
      const origFetch = window.fetch;
      const mockJson = (payload) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => payload });
      let licenseCalls = 0;
      window.fetch = async (url, opts = {}) => {
        const parsed = new URL(url, 'http://127.0.0.1:8765');
        if (parsed.pathname === '/api/license/status') {
          licenseCalls += 1;
          if (licenseCalls === 1) throw new TypeError('Failed to fetch');
          return mockJson(${JSON.stringify(mockLicenseState)});
        }
        return origFetch(url, opts);
      };
      state.workspaceBooted = false;
      await bootApp({ retry: true });
      window.fetch = origFetch;
      const alertEl = document.getElementById('serverAlert');
      return { licenseCalls, alertHidden: alertEl.classList.contains('hidden'), booted: state.workspaceBooted };
    })()
  `, context);
  check(
    'v4.30 retries the start-up when the first request fails and boots the workspace anyway',
    v430BootCheck.licenseCalls >= 2 && v430BootCheck.booted === true && v430BootCheck.alertHidden === true,
    JSON.stringify(v430BootCheck),
  );

  const v430AlertCheck = await vm.runInContext(`
    (async () => {
      const origFetch = window.fetch;
      const mockJson = (payload) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => payload });
      window.fetch = async () => { throw new TypeError('Failed to fetch'); };
      showServerUnreachable('simulated outage');
      const alertEl = document.getElementById('serverAlert');
      const visible = !alertEl.classList.contains('hidden');
      const text = document.getElementById('serverAlertText').textContent || '';
      const detail = document.getElementById('serverAlertDetail').textContent || '';
      window.fetch = async (url, opts = {}) => {
        const parsed = new URL(url, 'http://127.0.0.1:8765');
        if (parsed.pathname === '/api/health') return mockJson({ name: 'Comic OCR Studio', version: '4.34' });
        return origFetch(url, opts);
      };
      document.getElementById('serverAlertRetry').click();
      await new Promise((resolve) => setTimeout(resolve, 200));
      window.fetch = origFetch;
      return { visible, text, detail, hiddenAfterRetry: alertEl.classList.contains('hidden') };
      return { visible, text, detail, hiddenAfterRetry: alertEl.classList.contains('hidden') };
    })()
  `, context);
  check(
    'v4.30 shows a Persian recovery banner when the local app stops answering and the retry button clears it',
    v430AlertCheck.visible === true
      && /ارتباط با برنامه/.test(v430AlertCheck.text)
      && v430AlertCheck.detail === 'simulated outage'
      && v430AlertCheck.hiddenAfterRetry === true,
    JSON.stringify(v430AlertCheck),
  );

  const closeBeaconsBefore = beacons.filter((entry) => entry.url === '/api/session/close').length;
  window.dispatchEvent(new window.Event('beforeunload'));
  window.dispatchEvent(new window.Event('pagehide'));
  check('browser close sends exactly one close beacon', beacons.filter((entry) => entry.url === '/api/session/close').length === closeBeaconsBefore + 1);
  check('closing the tab stops its heartbeat timer', await vm.runInContext('sessionTimer === null && sessionCloseSent', context));
  window.close();
  if (failures) process.exitCode = 1;
})().catch((error) => { console.error(error); window.close(); process.exitCode = 1; });
