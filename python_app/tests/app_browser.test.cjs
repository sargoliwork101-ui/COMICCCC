const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const puppeteer = require('puppeteer-core');

const pythonApp = path.resolve(__dirname, '..');
const repository = path.resolve(pythonApp, '..');
const python = process.env.COMIC_STUDIO_PYTHON
  || (fs.existsSync(path.join(pythonApp, '.venv', 'bin', 'python')) ? path.join(pythonApp, '.venv', 'bin', 'python') : 'python3');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(base, child) {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    if (child.exitCode !== null) throw new Error(`Test server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch { /* startup is still in progress */ }
    await sleep(100);
  }
  throw new Error('Test server did not become ready');
}

async function api(base, route, options = {}) {
  const response = await fetch(`${base}${route}`, options);
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${route}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function previewDifference(page) {
  return page.evaluate(async () => {
    const item = state.project.images[0];
    const original = await createImageBitmap(await (await fetch(imageUrl(item, false))).blob());
    const expected = Typeset.render(original, overlayBlocks(item));
    original.close();
    const image = document.querySelector('#grid .item img');
    await image.decode();
    const actual = document.createElement('canvas');
    actual.width = image.naturalWidth; actual.height = image.naturalHeight;
    const context = actual.getContext('2d'); context.drawImage(image, 0, 0);
    if (actual.width !== expected.width || actual.height !== expected.height) return -1;
    const a = context.getImageData(0, 0, actual.width, actual.height).data;
    const e = expected.getContext('2d').getImageData(0, 0, expected.width, expected.height).data;
    let different = 0;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== e[i]) different += 1;
    return different;
  });
}

async function overlapPixelEvidence(page) {
  return page.evaluate(() => {
    const source = document.createElement('canvas'); source.width = 320; source.height = 160;
    const sourceContext = source.getContext('2d'); sourceContext.fillStyle = '#ffffff'; sourceContext.fillRect(0, 0, 320, 160);
    const earlier = { id: 'red', tr: 'AAAA', enabled: true, bg: 'white', color: '#ff0000', size: 52, lineH: 60, dir: 'ltr', align: 'center', x0: 20, y0: 15, x1: 220, y1: 85 };
    const later = { id: 'green', tr: 'B', enabled: true, bg: 'black', color: '#00ff00', size: 44, lineH: 60, dir: 'ltr', align: 'left', x0: 150, y0: 50, x1: 300, y1: 135 };
    const rendered = Typeset.render(source, [earlier, later]);
    const countPixels = (canvas) => {
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let redInsideLaterBackground = 0; let greenText = 0;
      for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) {
        const offset = (y * canvas.width + x) * 4; const [r, g, b] = pixels.subarray(offset, offset + 3);
        if (x >= 150 && x < 220 && y >= 50 && y < 85 && r > 180 && g < 100 && b < 100) redInsideLaterBackground += 1;
        if (r < 100 && g > 180 && b < 100) greenText += 1;
      }
      return { redInsideLaterBackground, greenText };
    };
    const actual = countPixels(rendered);
    const coveredControl = document.createElement('canvas'); coveredControl.width = rendered.width; coveredControl.height = rendered.height;
    const controlContext = coveredControl.getContext('2d'); controlContext.drawImage(rendered, 0, 0);
    controlContext.fillStyle = '#000000'; controlContext.fillRect(later.x0, later.y0, later.x1 - later.x0, later.y1 - later.y0);
    const covered = countPixels(coveredControl);
    return { ...actual, redAfterIntentionalCover: covered.redInsideLaterBackground };
  });
}

async function editorRenderDifference(page) {
  return page.evaluate(async () => {
    if (typeof editorCanvasFrame !== 'undefined' && editorCanvasFrame) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const item = state.project.images[0];
    const draft = inlineDraft ? draftBlockForPreview() : null;
    const blocks = item.blocks.map(block => overlayBlock(draft && block === inlineDraft.block ? draft : block));
    const expected = Typeset.render(state.editorBitmap, blocks);
    const actual = document.getElementById('editorCanvas');
    if (actual.width !== expected.width || actual.height !== expected.height) return -1;
    const a = actual.getContext('2d').getImageData(0, 0, actual.width, actual.height).data;
    const e = expected.getContext('2d').getImageData(0, 0, expected.width, expected.height).data;
    let different = 0;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== e[i]) different += 1;
    return different;
  });
}

async function secondSourceDarkPixels(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('editorCanvas');
    const pixels = canvas.getContext('2d').getImageData(170, 82, 70, 15).data;
    let dark = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] < 80 && pixels[index + 1] < 80 && pixels[index + 2] < 80) dark += 1;
    }
    return dark;
  });
}

function nextDownload(cdp, directory) {
  return new Promise((resolve, reject) => {
    let filename = null;
    const timer = setTimeout(() => { cleanup(); reject(new Error('Browser download did not complete')); }, 30000);
    const begin = (event) => { filename = event.suggestedFilename; };
    const progress = (event) => {
      if (event.state === 'canceled') { cleanup(); reject(new Error(`Browser canceled ${filename || 'the download'}`)); }
      if (event.state === 'completed') { cleanup(); resolve(path.join(directory, filename)); }
    };
    const cleanup = () => {
      clearTimeout(timer); cdp.off('Browser.downloadWillBegin', begin); cdp.off('Browser.downloadProgress', progress);
    };
    cdp.on('Browser.downloadWillBegin', begin); cdp.on('Browser.downloadProgress', progress);
  });
}

(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-studio-browser-'));
  const downloads = path.join(temporary, 'downloads'); fs.mkdirSync(downloads);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const aiRequests = []; const aiGenerations = []; const aiSystems = []; let dedupFailuresRemaining = 0;
  const freeGenerations = []; let freeFailure = true;
  const ocrCalls = []; let ocrFailure = true; let ocrEmpty = false;
  const aiServer = http.createServer((request, response) => {
    aiRequests.push({ method: request.method, url: request.url, authorization: request.headers.authorization || '' });
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST' && request.url === '/ocr/recognize') {
      let body=''; request.on('data',chunk=>body+=chunk); request.on('end',()=>{
        ocrCalls.push(JSON.parse(body));
        if (ocrFailure) { ocrFailure=false; response.statusCode=503; response.end(JSON.stringify({error:'ocr simulated failure'})); return; }
        response.end(JSON.stringify({ok:true, empty:ocrEmpty}));
      }); return;
    }
    if (request.method === 'POST' && request.url === '/free/translate') {
      let body=''; request.on('data',chunk=>body+=chunk); request.on('end',()=>{
        const data=JSON.parse(body); freeGenerations.push(data.text);
        if (data.text === 'SECOND PAGE' && freeFailure) { freeFailure=false; response.statusCode=503; response.end(JSON.stringify({error:'free simulated outage'})); return; }
        response.end(JSON.stringify({translation:data.text.split('\n').map(()=> 'ترجمه').join('\n')}));
      }); return;
    }
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => {
        const data = JSON.parse(body); const text = data.messages.find(message => message.role === 'user').content;
        aiSystems.push(data.messages.find(message => message.role === 'system').content);
        aiGenerations.push(text);
        const reply = translation => JSON.stringify({choices:[{message:{content:JSON.stringify({translation,summary:'جان دوست مری است'})}}]});
        if (text.includes('FENCED PAGE')) response.end(JSON.stringify({choices:[{message:{content:'Here is the result:\n```json\n'+JSON.stringify({translation:'صفحه حصار',summary:'خلاصه'})+'\n```'}}]}));
        else if (text.includes('BROKEN RESPONSE')) response.end(JSON.stringify({choices:[{message:{content:JSON.stringify({translation:'خصوصی پاسخ'})}}]}));
        else if (text.includes('HEADER SAME') && dedupFailuresRemaining > 0) { dedupFailuresRemaining -= 1; response.statusCode = 503; response.end(JSON.stringify({error:{message:'temporary failure'}})); }
        else if (text.includes('HEADER SAME')) { response.end(reply('عنوان مشترک\nمحتوای اول')); }
        else if (text.includes('DEDUP SECOND')) { response.end(reply('محتوای دوم')); }
        else if (text.includes('BROWSER PAGE TWO')) { response.statusCode = 503; response.end(JSON.stringify({ error: { message: 'test failure browser-local-secret', code: 'real-code' } })); }
        else setTimeout(() => response.end(reply('ترجمه صفحه یک')), 450);
      });
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/models' && request.headers.authorization === 'Bearer browser-local-secret') {
      response.end(JSON.stringify({ data: [{ id: 'local-browser-model' }] }));
      return;
    }
    response.statusCode = 401; response.end(JSON.stringify({ error: 'unexpected test request' }));
  });
  await new Promise((resolve, reject) => aiServer.listen(0, '127.0.0.1', resolve).once('error', reject));
  const aiBase = `http://127.0.0.1:${aiServer.address().port}/v1`;
  // Test-only stub: browser exercises real Python planning/checkpoints while
  // no external free translation service is contacted.
  const bootstrap = `
import httpx
from comic_studio.translation import TranslationService, TranslationError
def free_stub(self, request, text, sources, language, policy):
    request.user_message(text)
    r = httpx.post('${aiBase.replace('/v1','')}/free/translate', json={'text': text}, timeout=10)
    if r.status_code != 200: raise TranslationError(r.json().get('error', 'mock free failure'))
    return r.json()['translation']
TranslationService.translate_free_batch = free_stub
import comic_studio.main as studio_main
def ocr_stub(engine, image, language, contrast, precise, confidence):
    r = httpx.post('${aiBase.replace('/v1','')}/ocr/recognize', json={'language':language}, timeout=10)
    if r.status_code != 200: raise RuntimeError(r.json()['error'])
    if r.json()['empty']: return []
    return [{'id':1,'text':'NEWLY READ OCR','tr':'','richHtml':'','enabled':True,'x0':5,'y0':5,'x1':180,'y1':45,'lineH':40,'conf':90}]
studio_main.recognize_image = ocr_stub
from comic_studio.__main__ import main
main()
`;
  const server = spawn(python, ['-c', bootstrap, '--host', '127.0.0.1', '--port', String(port), '--no-browser'], {
    cwd: pythonApp,
    env: { ...process.env, COMIC_STUDIO_DATA: path.join(temporary, 'data') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (chunk) => { serverLog += chunk; });
  server.stderr.on('data', (chunk) => { serverLog += chunk; });
  let browser;
  try {
    await waitForServer(base, server);
    const source = path.join(temporary, 'source.png');
    execFileSync(python, ['-c', [
      'from PIL import Image, ImageDraw',
      `im=Image.new('RGB',(320,200),'white'); d=ImageDraw.Draw(im); d.text((12,15),'SOURCE ONE',fill='black'); d.text((175,85),'SOURCE TWO',fill='black'); im.save(${JSON.stringify(source)})`,
    ].join('; ')]);
    let project = await api(base, '/api/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Real browser export regression' }),
    });
    const form = new FormData(); form.append('files', new Blob([fs.readFileSync(source)], { type: 'image/png' }), 'page.png');
    project = await api(base, `/api/projects/${project.id}/files`, { method: 'POST', body: form });
    const projectId = project.id; const imageId = project.images[0].id;
    project.settings.overlayMode = 'translation';
    project.images[0].blocks = [
      { id: 1, text: 'SOURCE ONE', tr: 'ترجمهٔ اول', richHtml: '', enabled: true, bg: 'white', x0: 5, y0: 5, x1: 155, y1: 45, lineH: 40, dir: 'rtl', align: 'right' },
      { id: 2, text: 'SOURCE TWO', tr: 'ترجمهٔ دوم', richHtml: '', enabled: true, bg: 'white', x0: 165, y0: 75, x1: 310, y1: 120, lineH: 40, dir: 'rtl', align: 'right' },
      { id: 3, text: 'SOURCE THREE', tr: 'ترجمهٔ سوم', richHtml: '', enabled: true, bg: 'white', x0: 10, y0: 140, x1: 150, y1: 185, lineH: 40, dir: 'rtl', align: 'right' },
    ];
    await api(base, `/api/projects/${projectId}/state`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: project }),
    });

    const chromiumModule = await import('@sparticuz/chromium');
    const chromium = chromiumModule.default;
    const chromiumRoot = path.resolve(path.dirname(require.resolve('@sparticuz/chromium')), '..');
    await chromiumModule.inflate(path.join(chromiumRoot, 'bin', 'al2023.tar.br'));
    chromiumModule.setupLambdaEnvironment('/tmp/al2023/lib');
    browser = await puppeteer.launch({
      args: chromium.args, executablePath: await chromium.executablePath(), headless: true,
      defaultViewport: { width: 1440, height: 1000 },
    });
    const page = await browser.newPage(); await page.setCacheEnabled(false);
    const browserErrors = [];
    const nativeBrowserDialogs = [];
    page.on('dialog', (dialog) => { nativeBrowserDialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
    page.on('pageerror', (error) => browserErrors.push(String(error)));
    page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });

    await page.goto(base, { waitUntil: 'networkidle0' }); await page.waitForSelector('#grid .item img');
    const progressVisual = await page.evaluate(() => {
      setProgress('jobProgress', null, true);
      const bar = document.getElementById('jobProgress').closest('.bar');
      const active = { animation: getComputedStyle(document.getElementById('jobProgress')).animationName, height: getComputedStyle(bar).height, indeterminate: bar.classList.contains('indeterminate') };
      setProgress('jobProgress', 0.5, true);
      const determinate = { width: document.getElementById('jobProgress').style.width, value: bar.getAttribute('aria-valuenow'), indeterminate: bar.classList.contains('indeterminate') };
      setProgress('jobProgress', 0, false);
      return { active, determinate };
    });
    assert.deepEqual(progressVisual.active, { animation: 'progress-sweep', height: '8px', indeterminate: true });
    assert.deepEqual(progressVisual.determinate, { width: '50%', value: '50', indeterminate: false });
    console.log('PASS: progress bars visibly animate while unknown and show the exact reported percentage');
    await page.waitForFunction(() => state.project.images[0].edited === true, { timeout: 5000 });
    assert.equal(await previewDifference(page), 0, 'reopening saved translations must render them on the main page');
    console.log('PASS: real browser renders saved translations when a project opens');
    const overlapPixels = await overlapPixelEvidence(page);
    assert.ok(overlapPixels.redInsideLaterBackground > 20, `earlier red text must remain visible inside the later background; got ${JSON.stringify(overlapPixels)}`);
    assert.ok(overlapPixels.greenText > 10, 'the later block text must also be visibly painted');
    assert.equal(overlapPixels.redAfterIntentionalCover, 0, 'the control must prove that this pixel assertion detects a later erasure');
    console.log(`PASS: real pixels preserve earlier text inside a later background (${overlapPixels.redInsideLaterBackground} red pixels; covered control 0)`);

    await page.click('#menuBtn'); await page.click('#aiBtn');
    await page.waitForSelector('#aiDialog[open] #aiProvider');
    await page.select('#aiProvider', 'openai');
    for (const [selector, value] of [['#aiBaseUrl', aiBase], ['#aiModel', 'local-browser-model']]) {
      await page.click(selector); await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control'); await page.type(selector, value);
    }
    await page.type('.ai-profile-key', 'browser-local-secret');
    await page.$eval('.ai-profile-timeout_seconds', el => { el.value = '120'; el.dispatchEvent(new Event('input', {bubbles:true})); });
    await page.$eval('.ai-profile-retry_wait_seconds', el => { el.value = '0'; el.dispatchEvent(new Event('input', {bubbles:true})); });
    assert.equal(await page.$eval('.ai-profile-source_limit', el => el.value), '1000');
    assert.equal(await page.$eval('#aiContextPercent', el => el.value), '15'); assert.equal(await page.$eval('#aiSkillPercent', el => el.value), '15');
    await page.$eval('#aiContextPercent', el => { el.value = '20'; }); await page.$eval('#aiSkillPercent', el => { el.value = '10'; });
    await page.$eval('.ai-profile-source_limit', el => { el.value = '650'; el.dispatchEvent(new Event('input', {bubbles:true})); });
    await page.$eval('.ai-profile-retry_count', el => { el.value = '1'; el.dispatchEvent(new Event('input', {bubbles:true})); });
    await page.click('.ai-profile-test');
    await page.waitForFunction(() => document.getElementById('aiStatus').textContent.includes('local-browser-model'), { timeout: 10000 }).catch(async (error) => {
      console.error('AI dialog diagnostic:', await page.evaluate(() => ({ status: document.getElementById('aiStatus').textContent, provider: document.getElementById('aiProvider').value, model: document.getElementById('aiModel').value, baseUrl: document.getElementById('aiBaseUrl').value, rowStatus: document.querySelector('.ai-profile-status')?.textContent })), aiRequests);
      throw error;
    });
    assert.equal(aiRequests.length, 1, 'the row test must make one model-list request and no generation request');
    assert.deepEqual(aiRequests[0], { method: 'GET', url: '/v1/models', authorization: 'Bearer browser-local-secret' });
    const browserAiSettings = await api(base, '/api/ai-settings');
    assert.equal(browserAiSettings.context_percent, 20); assert.equal(browserAiSettings.skill_percent, 10);
    assert.equal(browserAiSettings.provider, 'openai');
    assert.equal(browserAiSettings.model, 'local-browser-model');
    assert.equal(browserAiSettings.providers.openai.profiles[0].hasApiKey, true);
    assert.equal(browserAiSettings.providers.openai.profiles[0].timeout_seconds, 120);
    assert.equal(browserAiSettings.providers.openai.profiles[0].retry_count, 1);
    assert.equal(browserAiSettings.providers.openai.profiles[0].retry_wait_seconds, 0);
    assert.equal(browserAiSettings.providers.openai.profiles[0].source_limit, 650);
    assert.ok(!JSON.stringify(browserAiSettings).includes('browser-local-secret'), 'public settings must not return the browser-entered secret');
    assert.equal(await page.$eval('.ai-profile-key', (input) => input.value), '', 'the saved secret must be cleared from the real password field');
    await page.$eval('#aiContextPercent', el => { el.value = '15'; }); await page.$eval('#aiSkillPercent', el => { el.value = '15'; });
    await page.select('#aiProvider', 'free');
    assert.equal(await page.$eval('#free-google-source_limit', el => el.value), '1000');
    assert.equal(await page.$eval('#free-mymemory-source_limit', el => el.value), '500');
    for (const [selector,value] of [['#free-google-timeout_seconds','75'],['#free-google-retry_count','2'],['#free-google-retry_wait_seconds','0'],['#free-mymemory-timeout_seconds','65'],['#free-mymemory-retry_count','1'],['#free-mymemory-retry_wait_seconds','0']]) await page.$eval(selector, (el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));}, value);
    await page.$eval('#free-google-timeout_seconds',el=>{el.value='4'; el.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.click('#saveAiBtn');
    await page.waitForFunction(()=>document.getElementById('aiStatus').textContent.includes('زمان انتظار'));
    assert.equal(await page.$eval('#aiDialog', el => el.open), true, 'invalid settings keep the dialog open');
    await page.$eval('#free-google-timeout_seconds',el=>{el.value='75'; el.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.click('#saveAiBtn');
    await page.waitForFunction(() => state.ai.provider === 'free'); assert.equal(await page.$eval('#aiDialog', el => el.open), false, 'successful settings save closes the dialog'); await page.keyboard.press('Escape');
    console.log('PASS: real AI dialog tests the selected model through Python without exposing its API key');

    project = await api(base, `/api/projects/${projectId}`);
    await api(base, `/api/projects/${projectId}/images/${imageId}/revert`, { method: 'POST' });
    project.settings.overlayMode = 'none'; project.images[0].edited = false;
    project.images[0].blocks.forEach((block) => { delete block.textMode; });
    project.images[0].blocks[0].tr = 'OLD TRANSLATION'; project.images[0].blocks[0].richHtml = '';
    await api(base, `/api/projects/${projectId}/state`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: project }),
    });
    const translated = JSON.parse(JSON.stringify(project));
    translated.settings.overlayMode = 'ocr'; translated.images[0].blocks[0].tr = 'NEW TRANSLATION ۳٫۲۱';

    await page.setRequestInterception(true);
    let held = null; let second = null; let renderRequests = 0; let secondDone;
    const translationRequests = [];
    const secondUpload = new Promise((resolve) => { secondDone = resolve; });
    const onRequest = (request) => {
      const url = new URL(request.url());
      if (url.pathname === `/api/projects/${projectId}/context-start`) {
        translationRequests.push(JSON.parse(request.postData() || '{}'));
        request.respond({ status:200, contentType:'application/json', body:JSON.stringify({project,runId:'browser-mock',completed:0}) }).catch(()=>{});
        return;
      }
      if (url.pathname === `/api/projects/${projectId}/context-step`) {
        request.respond({ status:200, contentType:'application/json', body:JSON.stringify({project:translated,done:true,completed:1,affectedImageIds:[imageId]}) }).catch(()=>{});
        return;
      }
      if (url.pathname.endsWith('/rendered')) {
        renderRequests += 1;
        if (renderRequests === 1) { held = request; return; }
        if (!second) second = request;
      }
      request.continue().catch(() => {});
    };
    const onResponse = (response) => { if (second && response.request() === second) secondDone(); };
    page.on('request', onRequest); page.on('response', onResponse);
    await page.reload({ waitUntil: 'networkidle0' }); await page.waitForSelector('#grid .item');
    await page.click('#exportBtn'); await page.select('#exportOverlayMode', 'ocr');
    const heldStarted = Date.now(); while (!held && Date.now() - heldStarted < 5000) await sleep(50);
    assert.ok(held, 'the older preview request must be pending for the ordering regression');
    await page.keyboard.press('Escape'); await page.click('#translateBtn');
    await page.waitForSelector('#translationPreviewDialog[open]');
    assert.equal(translationRequests.length, 0, 'opening the exact payload preview must not send a translation');
    assert.ok(await page.$eval('#translationPreviewRequests', (element) => element.textContent.includes('SOURCE ONE') && element.textContent.includes('SOURCE TWO') && !element.textContent.includes('␞')));
    assert.equal(await page.$eval('#translationPreviewRequests pre', (element) => element.textContent), 'SOURCE ONE\nSOURCE TWO\nSOURCE THREE', 'the real preview must use ordinary line-based payloads');
    assert.ok(await page.$eval('#translationPreviewDestination', (element) => element.textContent.includes('Google Translate') && element.textContent.includes('MyMemory')));
    await page.click('#translationPreviewCancel');
    assert.equal(translationRequests.length, 0, 'cancelling the real browser preview must not send a translation');
    await page.click('#translateBtn'); await page.waitForSelector('#translationPreviewDialog[open]');
    await page.click('#translationPreviewConfirm');
    await Promise.race([secondUpload, sleep(1200)]);
    await held.continue();
    await page.waitForFunction(() => !document.getElementById('translationDialog').open, { timeout: 15000 });
    await page.evaluate(() => overlayPreviewTask); await sleep(300);
    assert.ok(renderRequests >= 2, 'the race must include both the old and new real canvas uploads');
    assert.equal(translationRequests.length, 1, 'only explicit confirmation may execute the previewed translation');
    assert.match(translationRequests[0].confirmation || '', /^[a-f0-9]{64}$/, 'execution must carry the exact preview signature');
    assert.equal(await previewDifference(page), 0, 'an older delayed upload must not replace the latest translation');
    page.off('request', onRequest); page.off('response', onResponse); await page.setRequestInterception(false);
    console.log('PASS: delayed older preview cannot overwrite the latest translated render');

    await page.click('#grid .item .act button:nth-child(2)');
    await page.waitForSelector('#editorDialog[open] #blockList .block-card[data-id="1"]');
    assert.deepEqual(await page.$eval('#inlineEditor', el => ({ hidden: el.classList.contains('hidden'), idle: el.classList.contains('is-idle') })), { hidden: false, idle: true }, 'toolbar stays permanently docked in idle state before selecting a box');
    const previewTopIdle = await page.$eval('.editor-preview', el => el.getBoundingClientRect().top);
    // Clicking a text edits the real output box directly; formatting controls stay permanently in the top dock without vertical shift.
    await page.evaluate(() => { window.__inlineOriginal = JSON.parse(JSON.stringify(state.project.images[0].blocks[0])); window.__beforeInlineCanvas = document.getElementById('editorCanvas').toDataURL(); });
    await page.click('#editorBoxes .editor-box[data-id="1"] .editor-box-text', { offset: { x: 75, y: 30 } });
    await page.waitForSelector('#inlineEditor:not(.is-idle)');
    assert.ok(Math.abs((await page.$eval('.editor-preview', el => el.getBoundingClientRect().top)) - previewTopIdle) <= 2, 'activating a box must not shift the image preview vertically');
    const initialSettings = await page.evaluate(() => { const block=state.project.images[0].blocks[0];return {size:document.getElementById('inlineEditorSize').value,expectedSize:String(effectiveInlineSize(block)),color:document.getElementById('inlineEditorColor').value,expectedColor:effectiveInlineColor(block)}; });
    assert.equal(initialSettings.size, initialSettings.expectedSize, 'entering direct edit initializes size to the exact rendered font size');
    assert.equal(initialSettings.color, initialSettings.expectedColor, 'entering direct edit initializes the picker to the visible rendered text color');
    const inPlace = await page.evaluate(() => {
      const box = document.querySelector('#editorBoxes .editor-box[data-id="1"]'); const field = document.getElementById('inlineEditorField'); const a = box.getBoundingClientRect(); const b = field.getBoundingClientRect(); const bar = document.getElementById('inlineEditor').getBoundingClientRect(); const title = document.querySelector('#editorDialog>.dialog-head').getBoundingClientRect(); const body = document.querySelector('#editorDialog>.editor-body').getBoundingClientRect();
      return { direct: field.parentElement === box, transparentCaretLayer: getComputedStyle(field).color === 'rgba(0, 0, 0, 0)' && getComputedStyle(field).caretColor !== 'rgba(0, 0, 0, 0)', docked: bar.top >= title.bottom - 2 && bar.bottom <= body.top + 2, above: bar.bottom <= a.top + 2, oneEditingSurface: document.querySelectorAll('#editorBoxes [contenteditable="true"]').length === 1 };
    });
    assert.deepEqual(inPlace, {direct:true, transparentCaretLayer:true, docked:true, above:true, oneEditingSurface:true}, 'the only editing surface is attached to the exact image box while the canvas provides the live rendered text');
    assert.equal(await page.$$eval('#inlineEditor [data-line-align], #inlineEditor #inlineLineDirection, #inlineEditor #inlineLineColor', els => els.length), 0, 'duplicate line controls are removed');
    const originalViewport = page.viewport();
    await page.setViewport({ width: 600, height: 700, deviceScaleFactor: 1 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => { const f=document.getElementById('inlineEditorField');const bar=document.getElementById('inlineEditor').getBoundingClientRect();const head=document.querySelector('#editorDialog>.dialog-head').getBoundingClientRect();const body=document.querySelector('#editorDialog>.editor-body').getBoundingClientRect();return f.parentElement===f.closest('.editor-box') && bar.top>=head.bottom-2 && bar.bottom<=body.top+2; }), true, 'on a narrow viewport the text editing surface remains inside its output box');
    await page.setViewport(originalViewport);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const blank = await page.evaluate(() => { const r=document.getElementById('editorBoxes').getBoundingClientRect(); return {x:r.left+160*state.editorScale,y:r.top+60*state.editorScale}; });
    await page.mouse.click(blank.x, blank.y);
    assert.deepEqual(await page.$eval('#inlineEditor', el => ({ hidden: el.classList.contains('hidden'), idle: el.classList.contains('is-idle') })), { hidden: false, idle: true }, 'clicking blank image finishes box editing while keeping the top toolbar open');
    await page.evaluate(() => openInlineEditor(state.project.images[0].blocks[0]));
    await page.waitForSelector('#inlineEditor:not(.is-idle)');
    const popupPosition = await page.evaluate(() => {
      const head = document.querySelector('#editorDialog>.dialog-head').getBoundingClientRect(); const panel = document.getElementById('inlineEditor').getBoundingClientRect(); const body = document.querySelector('#editorDialog>.editor-body').getBoundingClientRect();
      return panel.top >= head.bottom - 1 && panel.bottom <= body.top + 1;
    });
    assert.equal(popupPosition, true, 'the editing toolbar remains docked between the filename and image, outside the preview canvas');
    await page.focus('#inlineEditorField');
    await page.evaluate(() => document.execCommand('selectAll'));
    await page.keyboard.type('new inline text');
    assert.equal(await page.$eval('#inlineVerticalAlign', el => el.value), 'middle', 'legacy blocks retain the previous centred default');
    await page.select('#inlineVerticalAlign', 'bottom');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await editorRenderDifference(page), 0, 'the live canvas applies the selected bottom placement exactly');
    await page.select('#inlineVerticalAlign', 'top');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await editorRenderDifference(page), 0, 'the live canvas applies the selected top placement exactly');
    await page.evaluate(() => {
      const field = document.getElementById('inlineEditorField'); const range = document.createRange();
      range.setStart(field.firstChild, 0); range.setEnd(field.firstChild, 3);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); field.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.click('#inlineEditor .classic-toolbar button[aria-label="پررنگ"]');
    await page.select('#inlineEditorAlign', 'justify');
    await page.$eval('#inlineEditorSize', (field) => { field.value = '24'; field.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.$eval('#inlineEditorColor', (field) => { field.value = '#ff0000'; field.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await page.evaluate(() => state.project.images[0].blocks[0].tr === 'new inline text' && state.project.images[0].blocks[0].verticalAlign === 'top' && state.project.images[0].blocks[0].align === 'justify' && state.project.images[0].blocks[0].size === 24 && state.project.images[0].blocks[0].color === '#ff0000'), true, 'text and settings are auto-applied to the project while typing, without a registration action');
    assert.notEqual(await page.$eval('#editorCanvas', canvas => canvas.toDataURL()), await page.evaluate(() => window.__beforeInlineCanvas), 'the image canvas must update to show the live draft');
    assert.equal(await editorRenderDifference(page), 0, 'while editing, the canvas must exactly match the final renderer for the live draft');
    assert.equal(await page.$eval('#inlineEditorField', field => getComputedStyle(field).color === 'rgba(0, 0, 0, 0)' && getComputedStyle(field).caretColor !== 'rgba(0, 0, 0, 0)'), true, 'the caret remains visible while the exact rendered text is shown underneath');
    await page.click('#inlineEditorApply');
    assert.deepEqual(await page.$eval('#inlineEditor', (panel) => ({ hidden: panel.classList.contains('hidden'), idle: panel.classList.contains('is-idle') })), { hidden: false, idle: true });
    assert.ok(Math.abs((await page.$eval('.editor-preview', el => el.getBoundingClientRect().top)) - previewTopIdle) <= 2, 'finishing box edit must keep the canvas vertically stable');
    assert.equal(await page.$$eval('#editorBoxes [contenteditable="true"], #editorBoxes [contenteditable="plaintext-only"]', els => els.length), 0, 'Apply removes the editable surface from the image box');
    const appliedInline = await page.evaluate(() => {
      const block = state.project.images[0].blocks[0];
      return {tr:block.tr,richHtml:block.richHtml,align:block.align,verticalAlign:block.verticalAlign,size:block.size,color:block.color,sidebar:document.querySelectorAll('#blockList .block-card[data-id="1"] .block-readonly')[1]?.textContent};
    });
    assert.ok(appliedInline.tr === 'new inline text' && /font-weight:\s*normal/i.test(appliedInline.richHtml) && appliedInline.align === 'justify' && appliedInline.verticalAlign === 'top' && appliedInline.size === 24 && appliedInline.color === '#ff0000' && appliedInline.sidebar.includes(appliedInline.tr), `Apply must update only the selected block and synchronize its sidebar: ${JSON.stringify(appliedInline)}`);
    assert.equal(await editorRenderDifference(page), 0, 'Apply must show the final output renderer immediately in the same editor');
    assert.notEqual(await page.$eval('#editorCanvas', (canvas) => canvas.toDataURL()), await page.evaluate(() => window.__beforeInlineCanvas));
    await page.waitForFunction(async () => { const response = await fetch(`/api/projects/${state.project.id}`); if (!response.ok) return false; const project = await response.json(); return project.images[0].blocks[0].tr === 'new inline text'; }, { timeout: 8000, polling: 100 });
    assert.equal(await page.evaluate(async () => (await (await fetch(`/api/projects/${state.project.id}`)).json()).images[0].blocks[0].tr), 'new inline text', 'auto-applied edits must be saved without an explicit Apply action');
    assert.equal(await page.evaluate(async () => (await (await fetch(`/api/projects/${state.project.id}`)).json()).images[0].blocks[0].verticalAlign), 'top', 'vertical placement must persist with the project');
    await page.click('#editorBoxes .editor-box[data-id="1"] .editor-box-text'); await page.waitForSelector('#inlineEditor:not(.hidden)');
    assert.equal(await page.evaluate(() => JSON.stringify({size:document.getElementById('inlineEditorSize').value,color:document.getElementById('inlineEditorColor').value,align:document.getElementById('inlineEditorAlign').value,vertical:document.getElementById('inlineVerticalAlign').value})), JSON.stringify({size:'24',color:'#ff0000',align:'justify',vertical:'top'}), 'reopening the same box restores the latest saved formatting settings');
    await page.click('#inlineEditorApply');
    await page.click('#editorBoxes .editor-box[data-id="2"] .editor-box-text');
    await page.waitForSelector('#inlineEditor:not(.hidden)');
    assert.equal(await page.evaluate(() => String(inlineDraft.block.id)), '2', 'clicking a different on-image text opens that exact text in the docked editor');
    await page.click('#inlineEditorApply');
    await page.click('#blockList .block-card[data-id="1"] .block-source-edit');
    await page.waitForSelector('#inlineEditor:not(.hidden)');
    assert.equal(await page.evaluate(() => { const block=state.project.images[0].blocks[0];return document.getElementById('inlineEditorField').textContent === block.text && document.getElementById('inlineEditorTitle').textContent.includes('متن اصلی'); }), true, 'clicking English source text opens the same docked editor in OCR mode');
    await page.click('#inlineEditorApply');
    await page.evaluate(() => setBlockTextMode(state.project.images[0].blocks[0], 'translation'));
    const topCanvas = await page.$eval('#editorCanvas', el => el.toDataURL());
    await page.evaluate(() => openInlineEditor(state.project.images[0].blocks[0]));
    await page.select('#inlineVerticalAlign', 'bottom'); await page.click('#inlineEditorApply');
    assert.equal(await page.evaluate(() => state.project.images[0].blocks[0].verticalAlign), 'bottom');
    assert.notEqual(await page.$eval('#editorCanvas', el => el.toDataURL()), topCanvas, 'top and bottom must change output pixels');
    assert.equal(await editorRenderDifference(page), 0, 'preview and final image use the same vertical positioning');
    await page.click('#editorBoxes .editor-box[data-id="1"] .editor-box-text', { offset: { x: 75, y: 30 } });
    await page.waitForSelector('#inlineEditor:not(.hidden)');
    await page.focus('#inlineEditorField'); await page.evaluate(() => document.execCommand('selectAll')); await page.keyboard.type('discard this draft');
    const blankWhileDirty = await page.evaluate(() => { const r=document.getElementById('editorBoxes').getBoundingClientRect(); return {x:r.left+160*state.editorScale,y:r.top+60*state.editorScale}; });
    await page.mouse.move(blankWhileDirty.x, blankWhileDirty.y); await page.mouse.down();
    await page.mouse.move(blankWhileDirty.x + 12, blankWhileDirty.y + 12, { steps: 3 }); await page.mouse.up();
    assert.equal(await page.$eval('#inlineEditor', el => el.classList.contains('hidden')), false, 'panning must not dismiss the toolbar');
    const blankAfterPan = await page.evaluate(() => { const r=document.getElementById('editorBoxes').getBoundingClientRect(); return {x:r.left+160*state.editorScale,y:r.top+60*state.editorScale}; });
    await page.mouse.click(blankAfterPan.x, blankAfterPan.y);
    assert.deepEqual(await page.$eval('#inlineEditor', el => ({ hidden: el.classList.contains('hidden'), idle: el.classList.contains('is-idle') })), { hidden: false, idle: true }, 'clicking blank image finishes box editing while keeping the toolbar docked');
    assert.equal(await page.evaluate(() => state.project.images[0].blocks[0].tr), 'discard this draft', 'leaving the box preserves the live edit');
    await page.evaluate(() => openInlineEditor(state.project.images[0].blocks[1]));
    assert.equal(await page.evaluate(() => String(inlineDraft.block.id)), '2', 'switching boxes activates the newly selected image text without a discard prompt');
    await page.click('#inlineEditorApply');
    assert.equal(await page.evaluate(() => state.project.images[0].blocks[0].tr), 'discard this draft', 'closing the tools does not roll back an auto-saved edit');
    await page.select('#blockList .block-card[data-id="1"] [data-text-mode]', 'ocr');
    await page.click('#editorBoxes .editor-box[data-id="1"] .editor-box-text', { offset: { x: 75, y: 30 } });
    assert.equal(await page.$eval('#inlineVerticalAlign', el => el.value), 'bottom', 'OCR uses the same placement control');
    await page.select('#inlineVerticalAlign', 'top');
    await page.focus('#inlineEditorField'); await page.evaluate(() => document.execCommand('selectAll')); await page.keyboard.type('corrected source');
    await page.click('#inlineEditorApply');
    assert.equal(await page.evaluate(() => {
      const block = state.project.images[0].blocks[0];
      return block.text === 'corrected source' && block.tr === 'discard this draft' && block.align === 'justify' && block.verticalAlign === 'top';
    }), true, 'source editing must preserve translation and its existing alignment');
    await page.evaluate(() => { state.project.images[0].blocks[0] = window.__inlineOriginal; buildBlockList(); drawEditor(); const preview = document.querySelector('.editor-preview'); preview.scrollTop = 0; preview.scrollLeft = 0; });
    console.log('PASS: text is edited in place, auto-saved while typing, and retained when leaving the box');

    await page.click('#editorBoxes .editor-box[data-id="1"] .editor-box-text', { offset: { x: 75, y: 30 } });
    await page.waitForSelector('#inlineEditor:not(.hidden)');
    await page.focus('#inlineEditorField');
    await page.evaluate(() => { const field = document.getElementById('inlineEditorField'); field.innerHTML = 'first<br><b>second</b><br>third'; field.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.evaluate(() => {
      const field = document.getElementById('inlineEditorField'); const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
      let node; while ((node = walker.nextNode()) && !node.nodeValue.includes('second')) {}
      const range = document.createRange(); range.setStart(node, 2); range.collapse(true);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      field.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.click('#inlineEditor .classic-toolbar button[aria-label="تراز وسط"]');
    assert.ok((await page.$eval('#inlineEditorField', (field) => field.innerHTML)).includes('text-align: center'));
    await page.click('#inlineEditor .classic-toolbar button[aria-label="واگرد"]');
    assert.ok(!(await page.$eval('#inlineEditorField', (field) => field.innerHTML)).includes('text-align: center'), 'undo must revert an individual line style');
    await page.click('#inlineEditor .classic-toolbar button[aria-label="ازنو"]');
    assert.ok((await page.$eval('#inlineEditorField', (field) => field.innerHTML)).includes('text-align: center'), 'redo must restore the line style');
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
    assert.ok(!(await page.$eval('#inlineEditorField', (field) => field.innerHTML)).includes('text-align: center'), 'Ctrl+Z must undo the line style');
    await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('z'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
    assert.ok((await page.$eval('#inlineEditorField', (field) => field.innerHTML)).includes('text-align: center'), 'Ctrl+Shift+Z must redo the line style');
    await page.$eval('#inlineLineSize', (field) => { field.value = '20'; field.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.equal(await page.$('#inlineEditor .classic-toolbar button[aria-label="نمایش ابزارهای پیشرفته"]'), null, 'more-tools toggle is removed so all tools stay visible');
    await page.click('#inlineEditor .classic-toolbar button[aria-label="چپ‌به‌راست"]');
    await page.$eval('#inlineEditor .classic-color', (field) => { field.value = '#ff0000'; field.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('#inlineEditorApply');
    const lineResult = await page.evaluate(async () => {
      const block = state.project.images[0].blocks[0]; const root = document.createElement('div'); root.innerHTML = block.richHtml;
      const lines = Typeset.richHtmlWords(block.richHtml).filter((word) => word.t);
      await saveProject(); const saved = (await (await fetch(`/api/projects/${state.project.id}`)).json()).images[0].blocks[0];
      return { text: block.tr, lines, savedHtml: saved.richHtml, html: block.richHtml, side: document.querySelectorAll('#blockList .block-card[data-id="1"] .block-readonly')[1].textContent };
    });
    assert.equal(lineResult.text, 'first\nsecond\nthird');
    assert.equal(lineResult.savedHtml, lineResult.html, 'line styles must survive project persistence');
    assert.deepEqual(lineResult.lines.map((word) => word.t), ['first', 'second', 'third']);
    assert.equal(lineResult.lines[1].lineAlign, 'center'); assert.equal(lineResult.lines[1].lineDir, 'ltr');
    assert.equal(lineResult.lines[1].size, 20); assert.ok(lineResult.lines[1].color, 'the selected line keeps its colour');
    assert.equal(lineResult.lines[0].lineAlign, undefined); assert.equal(lineResult.lines[2].lineAlign, undefined);
    assert.equal(await editorRenderDifference(page), 0, 'per-line changes must appear in the output renderer');
    await page.evaluate(() => { state.project.images[0].blocks[0] = window.__inlineOriginal; buildBlockList(); drawEditor(); const preview = document.querySelector('.editor-preview'); preview.scrollTop = 0; preview.scrollLeft = 0; });
    console.log('PASS: per-line formatting stays isolated, reaches the output, and persists');

    // Word-level formatting with REAL mouse drag & double-click over rendered canvas ink in a tall zoomed bubble.
    const canvasWordInk = await page.evaluate(() => {
      window.__savedBeforeWordTest = JSON.parse(JSON.stringify(state.project.images[0].blocks[0]));
      const b = { ...JSON.parse(JSON.stringify(window.__savedBeforeWordTest)), x0: 8, y0: 5, x1: 156, y1: 125, lineH: 22, bg: 'white', dir: 'rtl', align: 'center', verticalAlign: 'middle', size: null, color: null, tr: 'سلام رفیق چطوری', richHtml: '' };
      state.project.images[0].blocks[0] = b;
      setEditorZoom(0.75);
      buildBlockList(); drawEditor();
      const probeBlock = { ...JSON.parse(JSON.stringify(b)), richHtml: 'سلام <span style="color:#ff00aa;">رفیق</span> چطوری' };
      const probe = Typeset.render(state.editorBitmap, [probeBlock]);
      const data = probe.getContext('2d').getImageData(0, 0, probe.width, probe.height).data;
      let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
      for (let y = b.y0; y < b.y1; y += 1) {
        for (let x = b.x0; x < b.x1; x += 1) {
          const i = (y * probe.width + x) * 4;
          if (data[i] > 200 && data[i + 1] < 50 && data[i + 2] > 120) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      const cvRect = document.getElementById('editorCanvas').getBoundingClientRect();
      const s = state.editorScale;
      return {
        x0: cvRect.left + minX * s, x1: cvRect.left + (maxX + 1) * s,
        y0: cvRect.top + minY * s, y1: cvRect.top + (maxY + 1) * s,
        cy: cvRect.top + ((minY + maxY) / 2) * s,
      };
    });
    // First-drag directly on the CLOSED speech bubble over the exact visible canvas ink of «رفیق».
    await page.mouse.move(canvasWordInk.x1 + 1, canvasWordInk.cy);
    await page.mouse.down();
    await page.mouse.move(canvasWordInk.x0 - 1, canvasWordInk.cy, { steps: 6 });
    await page.mouse.up();
    const mouseDragCheck = await page.evaluate(() => {
      const sel = window.getSelection();
      const rect = sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
      return {
        selected: sel.toString().trim(),
        badge: document.getElementById('inlineTargetBadge').textContent,
        rect: rect ? { x0: rect.left, x1: rect.right, cy: (rect.top + rect.bottom) / 2 } : null,
      };
    });
    assert.equal(mouseDragCheck.selected, 'رفیق', `real mouse drag over canvas ink must select exact word: ${JSON.stringify(mouseDragCheck)}`);
    assert.ok(mouseDragCheck.badge.includes('رفیق'), 'target badge shows the mouse-selected word');
    assert.ok(Math.abs(mouseDragCheck.rect.cy - canvasWordInk.cy) < 8 && Math.abs(mouseDragCheck.rect.x0 - canvasWordInk.x0) < 8, `selection highlight must overlap visible canvas ink, not top of bubble: ${JSON.stringify({ mouseDragCheck, canvasWordInk })}`);
    // Real keyboard typing into #inlineLineSize must NOT steal focus or overwrite selected text.
    await page.click('#inlineLineSize', { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.keyboard.type('30');
    await page.click('#inlineSizeUp');
    await page.$eval('#inlineEditor .classic-color', el => { el.value = '#00aa55'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('#inlineEditor .classic-toolbar button[aria-label="زیرخط"]');
    await page.click('#inlineEditor .classic-toolbar button[aria-label="پررنگ"]');
    const singleWordCheck = await page.evaluate(() => {
      const words = Typeset.richHtmlWords(state.project.images[0].blocks[0].richHtml).filter(w => w.t);
      return words.map(w => ({ t: w.t, size: w.size || null, color: w.color || null, underline: !!w.underline, bold: w.bold }));
    });
    assert.equal(singleWordCheck.length, 3, `typing size must never overwrite the word: ${JSON.stringify(singleWordCheck)}`);
    assert.deepEqual({ size: singleWordCheck[0].size, color: singleWordCheck[0].color, underline: singleWordCheck[0].underline }, { size: null, color: null, underline: false }, 'first word on the same line stays untouched');
    assert.equal(singleWordCheck[1].t, 'رفیق');
    assert.equal(singleWordCheck[1].size, 32, 'only the selected word gets size 30 + A+ (32) in logical unzoomed px');
    assert.ok(singleWordCheck[1].color && singleWordCheck[1].underline && singleWordCheck[1].bold === false, 'only the selected word gets color, underline, and toggled bold');
    assert.deepEqual({ size: singleWordCheck[2].size, color: singleWordCheck[2].color, underline: singleWordCheck[2].underline }, { size: null, color: null, underline: false }, 'third word on the same line stays untouched');
    assert.equal(await editorRenderDifference(page), 0, 'single-word formatting matches live canvas output');
    await page.click('#inlineEditorApply');
    // Double-clicking a word on a closed speech bubble also selects that exact word immediately.
    const resizedInk = await page.evaluate(() => {
      const b = state.project.images[0].blocks[0];
      const rendered = Typeset.render(state.editorBitmap, [b]);
      const data = rendered.getContext('2d').getImageData(0, 0, rendered.width, rendered.height).data;
      let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
      for (let y = b.y0; y < b.y1; y += 1) {
        for (let x = b.x0; x < b.x1; x += 1) {
          const i = (y * rendered.width + x) * 4;
          if (data[i] < 40 && data[i + 1] > 120 && data[i + 2] > 50) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      const cvRect = document.getElementById('editorCanvas').getBoundingClientRect();
      const s = state.editorScale;
      return { cx: cvRect.left + ((minX + maxX) / 2) * s, cy: cvRect.top + ((minY + maxY) / 2) * s };
    });
    await page.mouse.click(resizedInk.cx, resizedInk.cy, { clickCount: 1 });
    await page.mouse.click(resizedInk.cx, resizedInk.cy, { clickCount: 2 });
    assert.equal(await page.evaluate(() => window.getSelection().toString().trim()), 'رفیق', 'double-clicking a word on a closed speech bubble selects that word');
    await page.click('#inlineLineReset');
    const afterWordReset = await page.evaluate(() => Typeset.richHtmlWords(state.project.images[0].blocks[0].richHtml).filter(w => w.t));
    assert.equal(afterWordReset[1].size || null, null, 'clearing style on a selected word resets only that word');
    await page.click('#inlineEditorApply');
    await page.evaluate(() => { state.project.images[0].blocks[0] = JSON.parse(JSON.stringify(window.__savedBeforeWordTest)); fitEditor(); buildBlockList(); drawEditor(); });
    console.log('PASS: real mouse drag & double-click over canvas ink select and style only the exact word');

    // v3.59 regressions: zoom docked inside #inlineEditor, all tools shown directly, and clicking size-8 boxes never jumps to 20.
    const toolbarLayoutCheck = await page.evaluate(() => {
      const dock = document.getElementById('inlineEditor');
      const zoom = dock.querySelector('.editor-zoom-controls');
      const dockRect = dock.getBoundingClientRect();
      const zoomRect = zoom?.getBoundingClientRect();
      const tools = [...dock.querySelectorAll('.classic-toolbar button, .classic-toolbar select, .classic-toolbar input')];
      return {
        zoomInDock: !!zoom && dock.contains(document.getElementById('editorZoomIn')) && dock.contains(document.getElementById('editorImageFullscreen')),
        zoomEnabledIdle: !document.getElementById('editorZoomIn').disabled && getComputedStyle(zoom).opacity === '1',
        zoomInsideBounds: !!zoomRect && zoomRect.top >= dockRect.top - 1 && zoomRect.bottom <= dockRect.bottom + 1 && zoomRect.left >= dockRect.left - 1 && zoomRect.right <= dockRect.right + 1,
        noMoreToggle: !dock.querySelector('button[aria-label="نمایش ابزارهای پیشرفته"]'),
        allToolsVisible: tools.length >= 22 && tools.every((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0),
      };
    });
    assert.deepEqual(toolbarLayoutCheck, {
      zoomInDock: true, zoomEnabledIdle: true, zoomInsideBounds: true, noMoreToggle: true, allToolsVisible: true,
    }, `zoom and all tools must sit cleanly inside #inlineEditor: ${JSON.stringify(toolbarLayoutCheck)}`);

    await page.evaluate(() => {
      window.__savedBeforeSize8Test = JSON.parse(JSON.stringify(state.project.images[0].blocks));
      const base0 = JSON.parse(JSON.stringify(window.__savedBeforeSize8Test[0]));
      const base1 = JSON.parse(JSON.stringify(window.__savedBeforeSize8Test[1]));
      const base2 = JSON.parse(JSON.stringify(window.__savedBeforeSize8Test[2]));
      // Box 1: normal box where user types 20 into #inlineLineSize (leaving #inlineLineSize focused)
      const box20 = { ...base0, id: 1, x0: 5, y0: 5, x1: 155, y1: 45, lineH: 30, size: null, bg: 'white', tr: 'کادر اول', richHtml: '' };
      // Box 2: auto-fit box that fits at 8px (tight bubble) AND missing lineH legacy box (height 18 -> 18*1.1 = 20 if buggy!)
      const boxNoLineH8 = { ...base1, id: 2, x0: 165, y0: 75, x1: 305, y1: 93, size: null, bg: 'white', tr: 'متن آزمایشی با اندازه هشت', richHtml: '' };
      delete boxNoLineH8.lineH;
      // Box 3: box whose text was explicitly styled to 8px via #inlineLineSize while block.size remained null
      const boxRich8 = { ...base2, id: 3, x0: 10, y0: 140, x1: 150, y1: 185, lineH: 18, size: null, bg: 'white', tr: 'متن هشت پیکسلی', richHtml: '<div style="font-size:8px;">متن هشت پیکسلی</div>' };
      state.project.images[0].blocks = [box20, boxNoLineH8, boxRich8];
      fitEditor(); buildBlockList(); drawEditor();
    });
    // Type 20 into #inlineLineSize on Box 1 and leave #inlineLineSize focused, then click Box 2 (font 8) directly!
    await page.click('#editorBoxes .editor-box[data-id="1"] .editor-box-text');
    await page.click('#inlineLineSize', { clickCount: 3 });
    await page.keyboard.type('20');
    const beforeClickBox2Canvas = await page.evaluate(() => {
      // Snapshot Box 2 region on canvas before clicking Box 2
      const cv = document.getElementById('editorCanvas');
      const sub = document.createElement('canvas'); sub.width = 145; sub.height = 24;
      sub.getContext('2d').drawImage(cv, 163, 73, 145, 24, 0, 0, 145, 24);
      return sub.toDataURL();
    });
    await page.click('#editorBoxes .editor-box[data-id="2"] .editor-box-text');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const box2AfterClick = await page.evaluate(() => {
      const cv = document.getElementById('editorCanvas');
      const sub = document.createElement('canvas'); sub.width = 145; sub.height = 24;
      sub.getContext('2d').drawImage(cv, 163, 73, 145, 24, 0, 0, 145, 24);
      return {
        subUrl: sub.toDataURL(),
        shownSize: document.getElementById('inlineEditorSize').value,
        lineSize: document.getElementById('inlineLineSize').value,
        draftSize: draftBlockForPreview().size,
      };
    });
    assert.equal(box2AfterClick.shownSize, '8', `clicking a size-8 box must show 8, never 20: ${JSON.stringify(box2AfterClick)}`);
    assert.equal(box2AfterClick.lineSize, '', 'stale #inlineLineSize value 20 from previous box must never carry over');
    assert.equal(box2AfterClick.draftSize, null, 'clicking an auto-fit box must keep block.size null instead of locking a fixed size');
    assert.equal(box2AfterClick.subUrl, beforeClickBox2Canvas, 'clicking Box 2 must not alter a single rendered canvas pixel of Box 2');

    // Now click Box 3 (<div style="font-size:8px"> with lineH=18 -> maxSize=20) and verify it also stays at 8, never 20!
    const beforeClickBox3Canvas = await page.evaluate(() => {
      const cv = document.getElementById('editorCanvas');
      const sub = document.createElement('canvas'); sub.width = 145; sub.height = 50;
      sub.getContext('2d').drawImage(cv, 8, 138, 145, 50, 0, 0, 145, 50);
      return sub.toDataURL();
    });
    await page.click('#editorBoxes .editor-box[data-id="3"] .editor-box-text');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const box3AfterClick = await page.evaluate(() => {
      const cv = document.getElementById('editorCanvas');
      const sub = document.createElement('canvas'); sub.width = 145; sub.height = 50;
      sub.getContext('2d').drawImage(cv, 8, 138, 145, 50, 0, 0, 145, 50);
      return {
        subUrl: sub.toDataURL(),
        shownSize: document.getElementById('inlineEditorSize').value,
        draftSize: draftBlockForPreview().size,
      };
    });
    assert.equal(box3AfterClick.shownSize, '8', `clicking an 8px rich-HTML box must show 8, not 20: ${JSON.stringify(box3AfterClick)}`);
    assert.equal(box3AfterClick.draftSize, null, 'auto-sized rich-HTML box keeps size null on click');
    assert.equal(box3AfterClick.subUrl, beforeClickBox3Canvas, 'clicking Box 3 must keep its exact rendered 8px canvas text');
    await page.click('#inlineEditorApply');
    await page.evaluate(() => {
      state.project.images[0].blocks = JSON.parse(JSON.stringify(window.__savedBeforeSize8Test));
      fitEditor(); buildBlockList(); drawEditor();
    });
    console.log('PASS: zoom docked cleanly, all tools visible directly, and clicking size-8 boxes keeps font at 8 without jumping to 20');

    // v3.60 regressions: (1) background matches moved box only, (2) wheel scrolls & Ctrl+wheel zooms, (3) Excel-style top/middle/bottom placement.
    {
      await page.evaluate(() => {
        window.__savedBeforeV360Test = JSON.parse(JSON.stringify(state.project.images[0].blocks));
        const tall = {
          ...JSON.parse(JSON.stringify(window.__savedBeforeV360Test[0])),
          id: 1, x0: 12, y0: 15, x1: 110, y1: 35,
          tx0: 180, ty0: 20, tx1: 305, ty1: 170,
          lineH: 16, size: 14, bg: 'white', color: '#0000aa',
          tr: 'خط اول', richHtml: '', verticalAlign: 'middle', align: 'right', dir: 'rtl',
        };
        state.project.images[0].blocks = [tall];
        setEditorZoom(5);
        const preview = document.querySelector('.editor-preview');
        preview.scrollTop = 0; preview.scrollLeft = 0;
        buildBlockList(); drawEditor();
      });
      // (1) Old OCR region (12,15..110,35) has 'SOURCE ONE' in black on original bitmap — must NOT be erased when box moved to tx0=180!
      const oldAreaDark = await page.evaluate(() => {
        const d = document.getElementById('editorCanvas').getContext('2d').getImageData(10, 12, 95, 22).data;
        let dark = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] < 80 && d[i + 1] < 80 && d[i + 2] < 80) dark += 1;
        return dark;
      });
      assert.ok(oldAreaDark > 50, `moving a box must not erase the old OCR region (${oldAreaDark} dark pixels)`);

      // (2) Mouse wheel alone scrolls vertically without changing zoom; Ctrl + wheel zooms!
      const previewCenter = await page.evaluate(() => {
        const r = document.querySelector('.editor-preview').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, scale: state.editorScale };
      });
      await page.mouse.move(previewCenter.x, previewCenter.y);
      await page.mouse.wheel({ deltaY: 90 });
      await sleep(30);
      const afterPlainWheel = await page.evaluate(() => ({
        scrollTop: document.querySelector('.editor-preview').scrollTop,
        scale: state.editorScale,
      }));
      assert.equal(afterPlainWheel.scale, previewCenter.scale, 'plain mouse wheel must not change zoom');
      assert.ok(afterPlainWheel.scrollTop > 0, `plain mouse wheel must scroll the page vertically (scrollTop=${afterPlainWheel.scrollTop})`);
      await page.keyboard.down('Control');
      await page.mouse.wheel({ deltaY: 100 });
      await sleep(30);
      const afterCtrlWheelOut = await page.evaluate(() => state.editorScale);
      assert.ok(afterCtrlWheelOut < previewCenter.scale, `Ctrl + mouse wheel down must zoom out (${previewCenter.scale} -> ${afterCtrlWheelOut})`);
      await page.mouse.wheel({ deltaY: -100 });
      await page.keyboard.up('Control');
      await sleep(30);
      const afterCtrlWheelIn = await page.evaluate(() => state.editorScale);
      assert.ok(afterCtrlWheelIn > afterCtrlWheelOut, `Ctrl + mouse wheel up must zoom in (${afterCtrlWheelOut} -> ${afterCtrlWheelIn})`);

      // (3) Excel-style Top / Middle / Bottom placement inside the tall box (ty0=20..ty1=170)
      await page.evaluate(() => { fitEditor(); document.querySelector('.editor-preview').scrollTop = 0; openInlineEditor(state.project.images[0].blocks[0]); });
      const measureBlueMinMaxY = () => page.evaluate(async () => {
        if (editorCanvasFrame) await new Promise((r) => requestAnimationFrame(r));
        const d = document.getElementById('editorCanvas').getContext('2d').getImageData(180, 20, 125, 150).data;
        let minY = 999, maxY = -1;
        for (let y = 0; y < 150; y += 1) {
          for (let x = 0; x < 125; x += 1) {
            const idx = (y * 125 + x) * 4;
            if (d[idx] < 50 && d[idx + 1] < 50 && d[idx + 2] > 120) {
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        return { minY, maxY, pressedTop: document.getElementById('inlineValignTop').getAttribute('aria-pressed'), pressedMid: document.getElementById('inlineValignMiddle').getAttribute('aria-pressed'), pressedBot: document.getElementById('inlineValignBottom').getAttribute('aria-pressed') };
      });
      const midBand = await measureBlueMinMaxY();
      assert.equal(midBand.pressedMid, 'true');
      await page.click('#inlineValignTop');
      const topBand1 = await measureBlueMinMaxY();
      assert.equal(topBand1.pressedTop, 'true');
      assert.ok(topBand1.minY < 25 && topBand1.minY < midBand.minY - 35, `Top placement must start near top of box: top=${JSON.stringify(topBand1)} mid=${JSON.stringify(midBand)}`);
      // Pressing Enter and typing line 2 while in Top mode must keep line 1 anchored at the top and fill downward!
      await page.focus('#inlineEditorField');
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('خط دوم');
      const topBand2 = await measureBlueMinMaxY();
      assert.ok(Math.abs(topBand2.minY - topBand1.minY) <= 2 && topBand2.maxY > topBand1.maxY + 12, `Top placement must keep line 1 at top and fill downward: ${JSON.stringify({ topBand1, topBand2 })}`);
      await page.click('#inlineValignBottom');
      const botBand = await measureBlueMinMaxY();
      assert.equal(botBand.pressedBot, 'true');
      assert.ok(botBand.maxY > 125 && botBand.minY > topBand2.minY + 60, `Bottom placement must anchor lines to bottom of box: ${JSON.stringify(botBand)}`);

      await page.click('#inlineEditorApply');
      await page.evaluate(() => {
        state.project.images[0].blocks = JSON.parse(JSON.stringify(window.__savedBeforeV360Test));
        fitEditor(); buildBlockList(); drawEditor();
      });
      console.log('PASS: box background follows moved box only, wheel scrolls while Ctrl+wheel zooms, and Excel-style top/middle/bottom placement works');
    }

    // v3.61: unified non-duplicated toolbar with divided box-layout row + root-cause selection parity
    // on zoomed-out font-12 top-aligned Line 1 AND overflowing middle-aligned multi-line bubbles.
    {
      await page.evaluate(() => { window.__savedV361Blocks = JSON.parse(JSON.stringify(state.project.images[0].blocks)); });
      const layoutInfo = await page.evaluate(() => {
        const inline = document.getElementById('inlineEditor');
        const wb = inline.querySelector('.inline-editor-workbench');
        const div = inline.querySelector('.inline-section-divider');
        const boxTools = inline.querySelector('.inline-box-layout-tools');
        const ir = inline.getBoundingClientRect();
        const wr = wb.getBoundingClientRect();
        const dr = div.getBoundingClientRect();
        const br = boxTools.getBoundingClientRect();
        return {
          inInline: inline.contains(div) && inline.contains(boxTools) && !!boxTools.querySelector('#editorSameSize') && !!boxTools.querySelector('#editorAlignTop'),
          ordered: wr.bottom <= dr.top + 3 && dr.bottom <= br.top + 3 && br.bottom <= ir.bottom + 2,
          dividerHeight: dr.height,
          idleBoxToolsOpacity: getComputedStyle(boxTools).opacity,
          sideMultiCount: document.querySelectorAll('.editor-side .editor-multi-tools').length,
          dupSettingsCount: document.querySelectorAll('.inline-box-settings, #inlineBoxPopover').length,
          resetCount: document.querySelectorAll('#inlineLineReset').length,
          dupEditBtnCount: [...document.querySelectorAll('#blockList button')].filter((b) => b.textContent.trim() === 'ویرایش همین متن').length,
        };
      });
      assert.equal(layoutInfo.inInline, true, `box layout tools must be inside #inlineEditor: ${JSON.stringify(layoutInfo)}`);
      assert.equal(layoutInfo.ordered, true, `divider must separate text workbench above and box tools below: ${JSON.stringify(layoutInfo)}`);
      assert.ok(layoutInfo.dividerHeight >= 1, 'divider must be visible');
      assert.equal(layoutInfo.idleBoxToolsOpacity, '1', 'box-alignment tools stay crisp while text editor is idle');
      assert.equal(layoutInfo.sideMultiCount, 0, 'duplicate box-layout bar in sidebar must be removed');
      assert.equal(layoutInfo.dupSettingsCount, 0, 'duplicate box settings popover must be removed');
      assert.equal(layoutInfo.resetCount, 1, 'there must be only one clear-format button');
      assert.equal(layoutInfo.dupEditBtnCount, 0, 'duplicate sidebar edit button must be removed');

      // Clicking translation line in sidebar opens on-image editor without shifting viewport height between OCR and Translation modes.
      const previewHeightBefore = await page.$eval('.editor-preview', (el) => el.getBoundingClientRect().height);
      await page.click('#blockList .block-card[data-id="1"] .block-tr-edit');
      const previewHeightTr = await page.$eval('.editor-preview', (el) => el.getBoundingClientRect().height);
      await page.click('#inlineEditorApply');
      await page.click('#blockList .block-card[data-id="1"] .block-source-edit');
      const previewHeightOcr = await page.$eval('.editor-preview', (el) => el.getBoundingClientRect().height);
      await page.click('#inlineEditorApply');
      assert.ok(Math.abs(previewHeightBefore - previewHeightTr) <= 1 && Math.abs(previewHeightTr - previewHeightOcr) <= 1,
        `dock height must stay constant across idle/translation/OCR modes: ${JSON.stringify({ previewHeightBefore, previewHeightTr, previewHeightOcr })}`);

      // Helper: find exact Canvas pixel bounds of a specific word in block[0] by rendering ONLY that word in #0055ff on an offscreen canvas using Typeset.render!
      const dragSelectWordOnCanvas = async (blockSetup, targetWord) => {
        const coords = await page.evaluate(({ setup, word }) => {
          state.project.images[0].blocks[0] = Object.assign(JSON.parse(JSON.stringify(window.__savedV361Blocks[0])), setup);
          if (setup._zoom) setEditorZoom(setup._zoom); else fitEditor();
          buildBlockList(); drawEditor();
          const b = state.project.images[0].blocks[0];
          const escaped = b.tr.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const markedHtml = escaped.replace(word, `<span style="color:#0055ff">${word}</span>`).replace(/\n/g, '<br>');
          const off = Typeset.render(state.editorBitmap, [overlayBlock({ ...b, bg: 'white', color: '#111111', richHtml: markedHtml })]);
          const octx = off.getContext('2d');
          const box = clampedBoxOf(b);
          const x0 = Math.floor(box.x0), y0 = Math.floor(box.y0), w = Math.ceil(box.x1 - box.x0), h = Math.ceil(box.y1 - box.y0);
          const data = octx.getImageData(x0, y0, w, h).data;
          let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
          for (let y = 0; y < h; y += 1) {
            for (let x = 0; x < w; x += 1) {
              const idx = (y * w + x) * 4;
              if (data[idx + 2] > 170 && data[idx] < 90) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
              }
            }
          }
          const cRect = document.getElementById('editorCanvas').getBoundingClientRect();
          const scale = state.editorScale || 1;
          return {
            inkLeft: cRect.left + (x0 + minX) * scale,
            inkRight: cRect.left + (x0 + maxX + 1) * scale,
            inkTop: cRect.top + (y0 + minY) * scale,
            inkBottom: cRect.top + (y0 + maxY + 1) * scale,
          };
        }, { setup: blockSetup, word: targetWord });
        const midY = (coords.inkTop + coords.inkBottom) / 2;
        // Drag RTL from right edge of word ink to left edge of word ink!
        await page.mouse.move(coords.inkRight + 1, midY);
        await page.mouse.down();
        await page.mouse.move(coords.inkLeft - 1, midY, { steps: 6 });
        await page.mouse.up();
        return page.evaluate((ink) => {
          const sel = getSelection();
          const rr = sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
          const field = document.getElementById('inlineEditorField');
          return {
            selected: (sel?.toString() || '').trim(),
            scrollTop: field.scrollTop,
            dyTop: rr ? Math.abs(rr.top - ink.inkTop) : 999,
            dxRight: rr ? Math.abs(rr.right - ink.inkRight) : 999,
            ink,
            rangeRect: rr ? { left: rr.left, right: rr.right, top: rr.top, bottom: rr.bottom } : null,
          };
        }, coords);
      };

      // Case A: Post-translation default (size 12, justify, verticalAlign 'top') zoomed out to 0.45x — selecting a word on Line 1 right under the top edge!
      const selTop = await dragSelectWordOnCanvas({
        tx0: 15, ty0: 25, tx1: 235, ty1: 145, bg: 'white', color: '#111111',
        tr: 'امروز صبح زود به مدرسه رفتیم و کتاب داستان جدیدی خواندیم که بسیار جذاب بود.',
        richHtml: '', textMode: 'translation', align: 'justify', dir: 'rtl', size: 12, verticalAlign: 'top', _zoom: 0.45,
      }, 'مدرسه');
      assert.equal(selTop.selected, 'مدرسه', `Zoomed-out top-aligned font-12 Line-1 drag must select exact Canvas word: ${JSON.stringify(selTop)}`);
      assert.equal(selTop.scrollTop, 0);
      await page.click('#inlineEditorApply');

      // Case B: Overflowing middle-aligned multi-line box (content taller than 58px box at fractional 0.75x zoom)!
      const selOverflow = await dragSelectWordOnCanvas({
        tx0: 15, ty0: 40, tx1: 235, ty1: 98, bg: 'white', color: '#111111',
        tr: 'وقتی باران پاییزی شروع شد همه به سمت خانه دویدیم تا خیس نشویم و چای داغ بنوشیم و استراحت کنیم.',
        richHtml: '', textMode: 'translation', align: 'justify', dir: 'rtl', size: 14, verticalAlign: 'middle', _zoom: 0.75,
      }, 'پاییزی');
      assert.equal(selOverflow.selected, 'پاییزی', `Overflowing middle-aligned box drag must select exact Canvas word without vertical shift: ${JSON.stringify(selOverflow)}`);
      assert.equal(selOverflow.scrollTop, 0);
      await page.click('#inlineEditorApply');

      await page.evaluate(() => {
        state.project.images[0].blocks = JSON.parse(JSON.stringify(window.__savedV361Blocks));
        fitEditor(); buildBlockList(); drawEditor();
      });
      console.log('PASS: v3.61 root-cause selection alignment (zoomed-out font-12 top Line 1 + overflowing middle box) and unified divided toolbar');

      // v3.63: Separated Merge/Split toolbar, post-translation Merge & Split, and pixel/character caret alignment across zooms, inline markers, multi-spaces, and mixed Bidi.
      const v363Toolbar = await page.evaluate(() => {
        const alignRect = document.querySelector('.inline-box-layout-tools').getBoundingClientRect();
        const msRect = document.getElementById('inlineMergeSplitTools').getBoundingClientRect();
        return {
          sameRow: Math.abs(alignRect.top - msRect.top) < 6,
          gapPx: Math.round(Math.max(alignRect.left - msRect.right, msRect.left - alignRect.right)),
          insideAlignGroup: Boolean(document.querySelector('.inline-box-layout-tools #editorMergeText')),
          sidebarDuplicates: document.querySelectorAll('.editor-side .editor-multi-tools').length,
        };
      });
      assert.equal(v363Toolbar.sameRow, true, `Merge/Split and Align groups must sit on one row: ${JSON.stringify(v363Toolbar)}`);
      assert.ok(v363Toolbar.gapPx >= 6, `Merge/Split must be visually separated from Align tools: ${JSON.stringify(v363Toolbar)}`);
      assert.equal(v363Toolbar.insideAlignGroup, false);
      assert.equal(v363Toolbar.sidebarDuplicates, 0);

      await page.evaluate(() => {
        state.project.images[0].blocks = [
          {
            id: 1, x0: 12, y0: 15, x1: 135, y1: 120,
            polygon: [[12, 15], [135, 15], [135, 120], [12, 120]],
            text: 'NARROW BUBBLE',
            tr: 'ما باید همین الان از این ساختمان خارج بشویم وگرنه دیر می‌شود',
            richHtml: '', enabled: true, lineH: 22, bg: 'white', color: '#111111',
            dir: 'rtl', align: 'justify', size: 12, verticalAlign: 'top',
          },
          {
            id: 2, x0: 145, y0: 15, x1: 315, y1: 90,
            polygon: [[145, 15], [315, 15], [315, 90], [145, 90]],
            text: 'BIDI AND MARKS',
            tr: 'سلام World 2026 خوبی',
            richHtml: '', enabled: true, lineH: 22, bg: 'white', color: '#111111',
            dir: 'rtl', align: 'right', size: 12, verticalAlign: 'top',
          },
          {
            id: 3, x0: 12, y0: 130, x1: 165, y1: 162,
            polygon: [[12, 130], [165, 130], [165, 162], [12, 162]],
            text: 'MERGE A', tr: 'پارهٔ نخست', richHtml: '', enabled: true, lineH: 20, bg: 'white',
            dir: 'rtl', align: 'justify', size: 12, verticalAlign: 'top',
          },
          {
            id: 4, x0: 12, y0: 165, x1: 165, y1: 196,
            polygon: [[12, 165], [165, 165], [165, 196], [12, 196]],
            text: 'MERGE B', tr: 'پارهٔ دوم', richHtml: '', enabled: true, lineH: 20, bg: 'white',
            dir: 'rtl', align: 'justify', size: 12, verticalAlign: 'top',
          },
        ];
        buildBlockList(); drawEditor();
      });

      const v363CaretAudit = await page.evaluate(() => {
        function audit(id, zoom) {
          setEditorZoom(zoom);
          const blk = editorItem().blocks.find((b) => b.id === id);
          openInlineEditor(blk);
          const field = document.getElementById('inlineEditorField');
          const canvas = document.getElementById('editorCanvas');
          const cRect = canvas.getBoundingClientRect();
          const scale = state.editorScale || 1;
          const bx0 = blk.x0, by0 = blk.y0, bw = blk.x1 - blk.x0, bh = blk.y1 - blk.y0;
          const img = canvas.getContext('2d').getImageData(bx0, by0, bw, bh).data;
          const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
          const chars = [];
          let tn;
          while ((tn = walker.nextNode())) {
            const val = tn.nodeValue || '';
            for (let i = 0; i < val.length; i++) {
              if (val[i] === '\n' || val[i] === '\u200c') continue;
              const r = document.createRange();
              r.setStart(tn, i); r.setEnd(tn, i + 1);
              const rr = r.getBoundingClientRect();
              if (rr.width > 0 && rr.height > 0) {
                const expEnd = (i + 1 < val.length && val[i + 1] === '\u200c') ? i + 2 : i + 1;
                chars.push({
                  ch: val[i], node: tn, idx: i, expEnd,
                  x0: (rr.left - cRect.left) / scale, x1: (rr.right - cRect.left) / scale,
                  y0: (rr.top - cRect.top) / scale, y1: (rr.bottom - cRect.top) / scale,
                  rrLeft: rr.left, rrRight: rr.right, rrTop: rr.top, rrBottom: rr.bottom,
                });
              }
            }
          }
          const lines = [];
          for (const dc of chars) {
            if (!dc.ch.trim()) continue;
            let ln = lines.find((l) => dc.y0 < l.y1 - 2 && dc.y1 > l.y0 + 2);
            if (!ln) { ln = { y0: dc.y0, y1: dc.y1, x0: dc.x0, x1: dc.x1 }; lines.push(ln); }
            ln.x0 = Math.min(ln.x0, dc.x0); ln.x1 = Math.max(ln.x1, dc.x1);
            ln.y0 = Math.min(ln.y0, dc.y0); ln.y1 = Math.max(ln.y1, dc.y1);
          }
          const maxLineDiff = Math.max(...lines.map((ln) => {
            const sy0 = Math.max(0, Math.floor(ln.y0 - by0)), sy1 = Math.min(bh - 1, Math.ceil(ln.y1 - by0));
            let inkMin = Infinity, inkMax = -Infinity;
            for (let y = sy0; y <= sy1; y++) {
              for (let x = 0; x < bw; x++) {
                const p = (y * bw + x) * 4;
                if (img[p] < 210) { inkMin = Math.min(inkMin, bx0 + x); inkMax = Math.max(inkMax, bx0 + x + 1); }
              }
            }
            return Math.max(Math.abs(ln.x0 - inkMin), Math.abs(ln.x1 - inkMax));
          }));
          let exact = 0, total = 0;
          for (const dc of chars) {
            if (!dc.ch.trim()) continue;
            const isRtl = /[\u0590-\u08ff]/.test(dc.ch) && !/[\u0660-\u0669\u06f0-\u06f9]/.test(dc.ch);
            const w = dc.rrRight - dc.rrLeft, midY = (dc.rrTop + dc.rrBottom) / 2;
            const ps = inlineCaretPoint(field, isRtl ? dc.rrRight - w * 0.2 : dc.rrLeft + w * 0.2, midY);
            const pe = inlineCaretPoint(field, isRtl ? dc.rrLeft + w * 0.2 : dc.rrRight - w * 0.2, midY);
            total += 2;
            if (ps && ps.node === dc.node && ps.offset === dc.idx) exact += 1;
            if (pe && pe.node === dc.node && pe.offset === dc.expEnd) exact += 1;
          }
          const lz = field.dataset.layoutZoom;
          closeInlineEditor();
          return { lz, exact, total, maxLineDiff: Math.round(maxLineDiff * 10) / 10 };
        }
        return { b1_065: audit(1, 0.65), b1_100: audit(1, 1.0), b1_140: audit(1, 1.4), b2_bidi: audit(2, 1.0) };
      });
      for (const [k, res] of Object.entries(v363CaretAudit)) {
        assert.equal(res.lz, '1', `${k} must use layoutZoom=1`);
        assert.equal(res.exact, res.total, `${k} must achieve 100% character-edge caret accuracy: ${JSON.stringify(res)}`);
        assert.ok(res.maxLineDiff <= 2.2, `${k} DOM vs Canvas ink horizontal alignment must stay within glyph sidebearing: ${JSON.stringify(res)}`);
      }

      // Real Ctrl+Click while inline editor is open -> Merge -> Split restore!
      const [b3Pt, b4Pt] = await page.evaluate(() => {
        setEditorZoom(1.0);
        return [3, 4].map((id) => {
          const r = document.querySelector(`#editorBoxes .editor-box[data-id="${id}"] .editor-box-text`).getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
      });
      await page.mouse.click(b3Pt.x, b3Pt.y);
      await page.keyboard.down('Control');
      await page.mouse.click(b4Pt.x, b4Pt.y);
      await page.keyboard.up('Control');
      await page.click('#editorMergeText');
      const v363Merged = await page.evaluate(() => ({
        len: state.project.images[0].blocks.length,
        tr: state.project.images[0].blocks.find((b) => b.id === 3)?.tr,
      }));
      assert.equal(v363Merged.len, 3);
      assert.equal(v363Merged.tr, 'پارهٔ نخست\nپارهٔ دوم');
      await page.click('#editorSplitText');
      const v363Restored = await page.evaluate(() => ({
        len: state.project.images[0].blocks.length,
        b4: state.project.images[0].blocks.find((b) => b.id === 4)?.tr,
      }));
      assert.equal(v363Restored.len, 4);
      assert.equal(v363Restored.b4, 'پارهٔ دوم');

      const v366Audit = await page.evaluate(() => {
        closeInlineEditor();
        setEditorZoom(1);
        const canvas = document.getElementById('editorCanvas');
        const origFillText = CanvasRenderingContext2D.prototype.fillText;
        let painted = [];
        CanvasRenderingContext2D.prototype.fillText = function patchedFillText(text, x, y, ...rest) {
          const w = this.measureText(text).width;
          painted.push({ text, x0: +(x - 10).toFixed(3), x1: +(x - 10 + w).toFixed(3), y: +(y - 5).toFixed(3) });
          return origFillText.call(this, text, x, y, ...rest);
        };
        try {
          let maxWordEdgeErr = 0;
          let pixelDiffEditVsClosed = 0;
          const testCases = [
            { bw: 95, bh: 195, tr: 'چی می‌گی؟! من اصلاً خبر نداشتم که اون اینجاست...' },
            { bw: 105, bh: 195, tr: 'صبر کن! الان باید سریع از اینجا بریم بیرون وگرنه گیر می‌افتیم.' },
            { bw: 135, bh: 195, tr: 'این مسیر رفت‌وآمد یا شب-روز خیلی طولانی است و باید ادامه بدهیم!' },
            { bw: 185, bh: 195, tr: 'گفتم Hello! World بریم و OK! تمام شد (100%) واقعاً؟!' },
          ];
          editorItem().blocks = [{
            id: 999, x0: 10, y0: 5, x1: 105, y1: 200,
            text: 'TEST', tr: '', richHtml: '', enabled: true, lineH: 22, bg: 'white',
            color: '#111111', dir: 'rtl', align: 'justify', size: 12, verticalAlign: 'top',
          }];
          const b = editorItem().blocks[0];
          for (const tc of testCases) {
            closeInlineEditor();
            b.x0 = 10; b.y0 = 5; b.x1 = 10 + tc.bw; b.y1 = 5 + tc.bh;
            b.tr = tc.tr; b.richHtml = ''; b.align = 'justify'; b.size = 12; b.verticalAlign = 'top';
            buildBlockList(); drawEditor();
            openInlineEditor(b);
            painted = [];
            drawEditorCanvas();
            const field = document.getElementById('inlineEditorField');
            const cRect = canvas.getBoundingClientRect();
            const tn = field.firstChild;
            const re = /\S+/g;
            let m;
            while ((m = re.exec(tn.nodeValue))) {
              const rr = document.createRange();
              rr.setStart(tn, m.index); rr.setEnd(tn, m.index + m[0].length);
              const rects = rr.getClientRects();
              if (rects.length === 1) {
                const rb = rects[0];
                const dx0 = rb.left - cRect.left - b.x0;
                const dx1 = rb.right - cRect.left - b.x0;
                const hit = painted.find((c) => c.text === m[0] && Math.abs(c.x0 - dx0) < 1.5);
                if (!hit) throw new Error(`missing painted word ${m[0]} at bw=${tc.bw}`);
                maxWordEdgeErr = Math.max(maxWordEdgeErr, Math.abs(hit.x0 - dx0), Math.abs(hit.x1 - dx1));
              }
            }
            const ctx = canvas.getContext('2d');
            const duringData = ctx.getImageData(10, 5, tc.bw, tc.bh).data;
            closeInlineEditor();
            const closedData = ctx.getImageData(10, 5, tc.bw, tc.bh).data;
            for (let i = 0; i < duringData.length; i += 1) {
              if (duringData[i] !== closedData[i]) { pixelDiffEditVsClosed += 1; break; }
            }
          }
          closeInlineEditor();
          b.x0 = 10; b.y0 = 0; b.x1 = 290; b.y1 = 200;
          b.tr = Array.from({ length: 10 }, (_, i) => `خط شمارهٔ ${i + 1} از پاراگراف ده‌خطی`).join('\n');
          b.richHtml = ''; b.align = 'justify'; b.size = 10; b.verticalAlign = 'top';
          buildBlockList(); drawEditor();
          openInlineEditor(b);
          const f10 = document.getElementById('inlineEditorField');
          const padLeft10 = f10.style.paddingLeft;
          const topStyle10 = f10.style.top;
          f10.innerHTML = 'سلام دنیا<div><br></div>';
          refreshInlineTypography();
          const div2 = f10.querySelector('div');
          const r2 = div2.getBoundingClientRect();
          const caretHit = resolveVisualInlineCaret(f10, r2.right - 15, (r2.top + r2.bottom) / 2);
          closeInlineEditor();
          return {
            maxWordEdgeErr: +maxWordEdgeErr.toFixed(4),
            pixelDiffEditVsClosed,
            padLeft10,
            topStyle10,
            inset500: Typeset.boxInset(500),
            emptyEnterLineStaysLower: caretHit?.node === div2 && caretHit?.offset === 0,
          };
        } finally {
          CanvasRenderingContext2D.prototype.fillText = origFillText;
          closeInlineEditor();
        }
      });
      assert.ok(v366Audit.maxWordEdgeErr < 0.5, `expected <0.5px word-edge alignment across all lines, got ${v366Audit.maxWordEdgeErr}px`);
      assert.equal(v366Audit.pixelDiffEditVsClosed, 0, 'canvas pixels during editing and after closing editor must be 100% identical (zero jump)');
      assert.equal(v366Audit.padLeft10, '4px', 'wide/10-line box horizontal inset must be capped at 4px');
      assert.equal(v366Audit.topStyle10, '2px', 'tall/10-line box vertical inset must be capped at 4px (-2px border + 4px = 2px)');
      assert.equal(v366Audit.inset500, 4, '500px tall 10-line box caps inset at 4px');
      assert.equal(v366Audit.emptyEnterLineStaysLower, true, 'clicking empty new line after Enter must keep caret on lower line');
      console.log('PASS: v3.66 unified single-engine layout, 0px exit jump, 4px inset cap on 10-line boxes, and empty-Enter-line caret accuracy');

      await page.evaluate(() => {
        state.project.images[0].blocks = JSON.parse(JSON.stringify(window.__savedV361Blocks));
        fitEditor(); buildBlockList(); drawEditor();
      });
      console.log('PASS: v3.63 separated Merge/Split tools, post-translation Merge & Split, and 100% pixel/caret alignment across zooms & Bidi');
    }

    // Classic source/visual synchronization, sanitization, dialogs and draft recovery.
    await page.evaluate(() => openInlineEditor(state.project.images[0].blocks[0]));
    await page.click('#inlineEditor .classic-tabs button:nth-child(2)');
    assert.equal(await page.$eval('#editorBoxes .editor-box.editing .classic-source', el => el.closest('.editor-box') === document.querySelector('#editorBoxes .editor-box.editing')), true, 'advanced HTML source uses the same selected image box, never a separate editor field');
    await page.$eval('#editorBoxes .editor-box.editing .classic-source', el => { el.value='<h2>Hello</h2><p>linked text<script>alert(1)</script><a href="javascript:alert(2)" onclick="alert(3)">unsafe</a></p>'; el.dispatchEvent(new Event('input',{bubbles:true})); });
    const safe = await page.evaluate(() => classicEditor.getHTML());
    assert.ok(safe.includes('<h2>Hello</h2>') && safe.includes('unsafe') && !/script|javascript|onclick/.test(safe));
    await page.click('#inlineEditor .classic-tabs button:nth-child(1)');
    assert.ok((await page.$eval('#inlineEditorField', el => el.innerHTML)).includes('<h2>Hello</h2>'));
    await page.evaluate(() => { const f=document.getElementById('inlineEditorField'); const node=f.querySelector('p').firstChild; const r=document.createRange();r.setStart(node,0);r.setEnd(node,6);const sel=getSelection();sel.removeAllRanges();sel.addRange(r);f.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); });
    await page.click('#inlineEditor .classic-toolbar button[aria-label="درج پیوند (Ctrl+K)"]');
    await page.$eval('.classic-modal input[type=url]', el => {el.value='https://example.com/path';});
    await page.$eval('.classic-modal input[type=checkbox]', el => {el.checked=true;});
    await page.evaluate(() => document.querySelector('.classic-modal .classic-primary').click());
    assert.equal(await page.$eval('#inlineEditorField a', el => el.href === 'https://example.com/path' && el.target === '_blank' && el.rel.includes('noopener')), true);
    assert.equal(await page.$('#inlineEditor .classic-toolbar button[aria-label="نمایش ابزارهای پیشرفته"]'), null, 'no hidden second row toggle exists');
    assert.equal(await page.$eval('#inlineEditor .classic-toolbar button[aria-label="درج جدول"]', el => el.getBoundingClientRect().width > 0 && !el.closest('[hidden]')), true, 'advanced tools are directly visible at all times');
    await page.evaluate(() => { const f=document.getElementById('inlineEditorField');const r=document.createRange();r.selectNodeContents(f);r.collapse(false);const sel=getSelection();sel.removeAllRanges();sel.addRange(r);f.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); document.querySelector('#inlineEditor .classic-toolbar button[aria-label="درج جدول"]').click(); });
    await page.evaluate(() => document.querySelector('.classic-modal .classic-primary').click());
    assert.equal(await page.$$eval('#inlineEditorField table td', els => els.length), 4);
    await page.evaluate(() => { const f=document.getElementById('inlineEditorField');const r=document.createRange();r.selectNodeContents(f);r.collapse(false);const sel=getSelection();sel.removeAllRanges();sel.addRange(r);f.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); document.querySelector('#inlineEditor .classic-toolbar button[aria-label="درج تصویر"]').click(); });
    await (await page.$('.classic-modal input[type=file]')).uploadFile(source);
    await page.$eval('.classic-modal input:not([type])', el => {el.value='نمونه';});
    await page.evaluate(() => document.querySelector('.classic-modal .classic-primary').click());
    await page.waitForFunction(() => !!document.querySelector('#inlineEditorField img'));
    assert.ok((await page.$eval('#inlineEditorField img', el => el.getAttribute('src'))).startsWith('data:image/png;base64,'));
    await page.evaluate(() => {const f=document.getElementById('inlineEditorField');const r=document.createRange();r.selectNodeContents(f);r.collapse(false);const sel=getSelection();sel.removeAllRanges();sel.addRange(r);f.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));const data=new DataTransfer();data.setData('text/html','<p style="color:red" onclick="alert(1)">pasted <b>bold</b><script>BAD</script></p>');data.setData('text/plain','pasted bold');f.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));});
    assert.ok((await page.$eval('#inlineEditorField', el => el.innerHTML)).includes('pasted'));
    assert.ok(!/onclick|BAD|<script/i.test(await page.$eval('#inlineEditorField', el => el.innerHTML)));
    await page.evaluate(() => { document.querySelector('#inlineEditor .classic-toolbar button[aria-label="چسباندن به‌صورت متن ساده"]').click(); const f=document.getElementById('inlineEditorField');const p=document.createElement('p');p.textContent='plain: ';f.appendChild(p);const r=document.createRange();r.selectNodeContents(p);r.collapse(false);const sel=getSelection();sel.removeAllRanges();sel.addRange(r);f.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));const data=new DataTransfer();data.setData('text/html','<b>PLAINONLY</b>');data.setData('text/plain','PLAINONLY');f.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data})); });
    assert.ok((await page.$eval('#inlineEditorField', el => el.textContent)).includes('PLAINONLY'));
    assert.equal(await page.$eval('#inlineEditorField', el => [...el.querySelectorAll('b,strong')].some(x => x.textContent.includes('PLAINONLY'))), false);
    await page.evaluate(() => document.querySelector('#inlineEditor .classic-toolbar button[aria-label="تمام‌صفحه"]').click());
    assert.equal(await page.evaluate(() => !!document.getElementById('inlineEditorField').closest('.classic-fullscreen')), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.getElementById('inlineEditorField').parentElement === document.querySelector('#editorBoxes .editor-box.editing') && !document.getElementById('inlineEditor').classList.contains('hidden')), true, 'Escape exits fullscreen back to direct editing in the same image box');
    await page.select('#inlineVerticalAlign', 'bottom');
    await page.$eval('#inlineEditorSize', el => {el.value='33';el.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForFunction(() => Object.keys(localStorage).some(key => key.startsWith('comic-studio-draft:') && JSON.parse(localStorage.getItem(key)).meta?.size === '33'), {timeout:6000});
    await page.$eval('#inlineEditorSize', el => {el.value='44';});
    await page.select('#inlineVerticalAlign', 'top');
    await page.evaluate(() => {
      const b = inlineDraft.block;
      window.__draftRecoverTask = classicEditor.setContext(`comic-studio-draft:${encodeURIComponent(state.project.id)}:${encodeURIComponent(editorItem().id)}:${encodeURIComponent(b.id)}:translation`, b.richHtml || plainToHtml(b.tr || ''), inlineBlockSnapshot(b));
    });
    await page.waitForSelector('#appModalDialog[open]');
    assert.ok((await page.$eval('#appModalMessage', el => el.textContent)).includes('پیش‌نویس'));
    await page.click('#appModalConfirm');
    assert.equal(await page.evaluate(() => window.__draftRecoverTask), true);
    assert.equal(await page.$$eval('#inlineEditorField table td', els => els.length), 4, 'autosaved HTML recovers in the correct context');
    assert.equal(await page.$eval('#inlineEditorSize', el => el.value), '33', 'autosave restores output settings as well as text');
    assert.equal(await page.$eval('#inlineVerticalAlign', el => el.value), 'bottom', 'autosave restores vertical alignment');
    await page.click('#inlineEditorApply');
    const classicResult = await page.evaluate(() => {const b=state.project.images[0].blocks[0];return {html:b.richHtml,words:Typeset.richHtmlWords(b.richHtml).map(w=>w.t).join(' ')};});
    assert.ok(classicResult.html.includes('<table>') && classicResult.html.includes('target="_blank"'));
    assert.ok(classicResult.words.includes('|') && classicResult.words.includes('[نمونه]'), 'table and image must have visible textual approximations');
    await page.evaluate(() => { state.project.images[0].blocks[0] = window.__inlineOriginal; buildBlockList(); drawEditor(); });
    console.log('PASS: classic Visual/Text, safe HTML, link dialog, table and local draft recovery');

    // There is exactly one writable field; redraw and zoom keep its caret stable.
    assert.equal(await page.$$eval('#blockList textarea, #blockList [contenteditable="true"], #editorBoxes [contenteditable="true"]', (els) => els.length), 0);
    await page.evaluate(() => openInlineEditor(state.project.images[0].blocks[0]));
    await page.focus('#inlineEditorField'); await page.evaluate(() => document.execCommand('selectAll')); await page.keyboard.type('alpha beta');
    await page.evaluate(() => {
      const field = document.getElementById('inlineEditorField'); const range = document.createRange(); range.setStart(field.firstChild, 5); range.collapse(true);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); field.dispatchEvent(new MouseEvent('mouseup', {bubbles:true}));
      window.__originalOverlay = field; setEditorZoom(state.editorScale * 1.1); drawEditor(); drawEditor();
    });
    assert.equal(await page.evaluate(() => document.getElementById('inlineEditorField') === window.__originalOverlay && document.activeElement === window.__originalOverlay && getSelection().anchorOffset === 5), true);
    await page.keyboard.type('X');
    assert.equal(await page.$eval('#inlineEditorField', el => el.textContent), 'alphaX beta');
    const beforeSize = await page.$eval('#inlineEditorField', el => getComputedStyle(el).fontSize);
    await page.select('#inlineEditorAlign', 'justify');
    await page.$eval('#inlineEditorSize', el => { el.value='12'; }); await page.click('#inlineEditorApply');
    const small = await page.$eval('#editorCanvas', el => el.toDataURL());
    await page.evaluate(() => openInlineEditor(state.project.images[0].blocks[0]));
    await page.$eval('#inlineEditorSize', el => { el.value='30'; el.dispatchEvent(new Event('input', {bubbles:true})); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => { const el=document.getElementById('inlineEditorField'); const cs=getComputedStyle(el); const m=new DOMMatrix(cs.transform==='none'?undefined:cs.transform); return (parseFloat(cs.fontSize)*(m.a||1)).toFixed(3); }), await page.evaluate(() => { const draft=overlayBlock(draftBlockForPreview());const box=clampedBoxOf(draft);return (overlaySize(draft,box.x1-box.x0,box.y1-box.y0)*(state.editorScale||1)).toFixed(3); }), 'the transparent caret layer tracks final output typography and zoom exactly');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await editorRenderDifference(page), 0, 'the canvas tracks the chosen output size exactly while the dock remains readable');
    await page.click('#inlineEditorApply');
    assert.notEqual(await page.$eval('#editorCanvas', el => el.toDataURL()), small, 'output size must affect image pixels');
    assert.equal(await editorRenderDifference(page), 0);
    await page.evaluate(() => { const block = state.project.images[0].blocks[0]; block.align='right'; block.size=null; drawEditor(); });
    console.log('PASS: the in-place caret layer tracks output typography and zoom');

    // The text remains live on the image through preview, leaving and editing HTML source.
    await page.evaluate(() => openInlineEditor(state.project.images[0].blocks[0]));
    await page.focus('#inlineEditorField'); await page.evaluate(() => document.execCommand('selectAll')); await page.keyboard.type('preview without saving');
    await page.select('#inlineVerticalAlign', 'bottom');
    assert.equal(await page.evaluate(() => state.project.images[0].blocks[0].tr === 'preview without saving' && state.project.images[0].blocks[0].verticalAlign === 'bottom'), true, 'typing and format changes auto-apply immediately');
    await page.click('#inlinePreview');
    const livePixels = await page.$eval('#editorCanvas', el => el.toDataURL());
    assert.equal(await page.$eval('#inlinePreview', el => el.getAttribute('aria-pressed')), 'true');
    assert.equal(await page.$eval('#inlineEditor .classic-editor', el => getComputedStyle(el).opacity), '0');
    await page.click('#inlineEditorApply');
    assert.equal(await page.$eval('#editorCanvas', el => el.toDataURL()), livePixels, 'closing the toolbar leaves the already-live output unchanged');
    assert.equal(await editorRenderDifference(page), 0);
    await page.evaluate(() => openInlineEditor(state.project.images[0].blocks[0]));
    await page.focus('#inlineEditorField'); await page.evaluate(() => document.execCommand('selectAll')); await page.keyboard.type('cancel this preview');
    await page.click('#inlinePreview'); await page.click('#inlinePreview');
    assert.equal(await page.$eval('#inlineEditorField', el => el.innerText), 'cancel this preview');
    await page.click('#inlinePreview'); await page.click('#inlineEditorApply');
    assert.equal(await page.evaluate(() => state.project.images[0].blocks[0].tr), 'cancel this preview', 'closing the editor never rolls back text that is already auto-saved');
    assert.equal(await editorRenderDifference(page), 0);
    await page.select('#blockList .block-card[data-id="1"] [data-text-mode]', 'ocr');
    await page.evaluate(() => openInlineEditor(state.project.images[0].blocks[0]));
    await page.focus('#inlineEditorField'); await page.evaluate(() => document.execCommand('selectAll')); await page.keyboard.type('OCR preview');
    await page.click('#inlinePreview'); const ocrPreview = await page.$eval('#editorCanvas', el => el.toDataURL());
    await page.click('#inlineEditorApply'); assert.equal(await page.$eval('#editorCanvas', el => el.toDataURL()), ocrPreview);
    await page.select('#blockList .block-card[data-id="1"] [data-text-mode]', 'translation');
    await page.evaluate(() => openInlineEditor(state.project.images[0].blocks[0]));
    await page.click('#inlineEditor .classic-tabs button:nth-child(2)');
    await page.$eval('.classic-source', el => {el.value='<p><b>HTML draft</b></p><p>second line</p>';el.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.click('#inlinePreview'); const htmlPreview = await page.$eval('#editorCanvas', el => el.toDataURL());
    await page.click('#inlineEditorApply'); assert.equal(await page.$eval('#editorCanvas', el => el.toDataURL()), htmlPreview, 'HTML source and the exact image output stay in sync');
    await page.evaluate(() => openInlineEditor(state.project.images[0].blocks[0]));
    await page.evaluate(() => { window.__beforeConflict = JSON.parse(JSON.stringify(inlineDraft.block)); });
    await page.focus('#inlineEditorField'); await page.evaluate(() => document.execCommand('selectAll')); await page.keyboard.type('conflicting draft');
    await page.evaluate(() => {inlineDraft.block.tr = 'external change';});
    await page.click('#inlineEditorApply');
    assert.equal(await page.evaluate(() => inlineDraft.block.tr), 'external change', 'concurrent edits are not overwritten');
    await page.evaluate(() => Object.assign(inlineDraft.block, window.__beforeConflict));
    await page.click('#inlineEditorCancel');
    await page.evaluate(() => {
      Object.assign(state.project.images[0].blocks[0], window.__beforeConflict);
      buildBlockList(); drawEditor();
      openInlineEditor(state.project.images[0].blocks[0]);
    });
    await page.waitForSelector('#appModalDialog[open]');
    const conflictRecoveryPrompt = await page.$eval('#appModalMessage', (el) => el.textContent);
    await page.click('#appModalCancel');
    await page.waitForFunction(() => !document.getElementById('appModalDialog').open);
    const clearedOnDecline = await page.evaluate(() => {
      const hasDraft = Object.keys(localStorage).some((key) => key.startsWith('comic-studio-draft:'));
      closeInlineEditor();
      return !hasDraft;
    });
    assert.ok(conflictRecoveryPrompt.includes('پیش‌نویس'), 'forced conflict close keeps local draft for recovery');
    assert.equal(clearedOnDecline, true, 'declined recovery draft is cleaned up immediately');
    assert.equal(await editorRenderDifference(page), 0);
    console.log('PASS: text, OCR and HTML changes stay live and auto-saved; concurrent edits are protected');

    // A denied native fullscreen still fits even a very tall image and preserves
    // the editable draft, selected box and previous zoom on exit.
    await page.evaluate(() => {
      const item = editorItem(); window.__overviewHeight = item.height; item.height = 50000;
      window.__requestFullscreen = document.getElementById('editorDialog').requestFullscreen;
      document.getElementById('editorDialog').requestFullscreen = () => Promise.reject(new Error('permission denied'));
      setEditorZoom(0.75); openInlineEditor(item.blocks[0]);
    });
    await page.focus('#inlineEditorField'); await page.evaluate(() => document.execCommand('selectAll')); await page.keyboard.type('overview draft');
    const overviewBefore = await page.evaluate(() => ({scale:state.editorScale,id:state.activeBlockId,block:JSON.stringify(inlineDraft.block)}));
    await page.evaluate(() => document.getElementById('editorImageFullscreen').click());
    await page.waitForFunction(() => document.getElementById('editorDialog').classList.contains('image-fullscreen'));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const overview = await page.evaluate(() => {const p=document.querySelector('.editor-preview'), stage=document.getElementById('editorStage'); return {scale:state.editorScale,w:stage.getBoundingClientRect().width,h:stage.getBoundingClientRect().height,pw:p.clientWidth,ph:p.clientHeight,draft:imageOverview.draft.tr,block:JSON.stringify(inlineDraft.block)};});
    assert.ok(overview.scale < 0.1 && overview.w <= overview.pw && overview.h <= overview.ph, JSON.stringify(overview));
    assert.equal(overview.draft, 'overview draft'); assert.equal(overview.block, overviewBefore.block);
    await page.mouse.click(3, 3);
    assert.equal(await page.$eval('#inlineEditorField', el => el.textContent), 'overview draft', 'clicking the overview must not discard the hidden draft');
    await page.click('#editorZoomIn');
    assert.ok(await page.evaluate(() => state.editorScale > imageOverview.fitScale), 'manual zoom remains available');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('editorDialog').classList.contains('image-fullscreen'));
    assert.equal(await page.evaluate(() => state.editorScale), overviewBefore.scale);
    assert.equal(await page.evaluate(() => state.activeBlockId), overviewBefore.id);
    assert.equal(await page.$eval('#inlineEditorField', el => el.innerText), 'overview draft');
    await page.click('#inlineEditorApply');
    await page.evaluate(() => {editorItem().height = window.__overviewHeight; document.getElementById('editorDialog').requestFullscreen = window.__requestFullscreen; fitEditor(); drawEditor();});
    await page.evaluate(() => setEditorZoom(0.73));
    await page.click('#editorImageFullscreen');
    await page.waitForFunction(() => document.getElementById('editorDialog').classList.contains('image-fullscreen'));
    if (await page.evaluate(() => document.fullscreenElement === document.getElementById('editorDialog'))) {
      await page.evaluate(() => document.exitFullscreen());
      await page.waitForFunction(() => !document.getElementById('editorDialog').classList.contains('image-fullscreen'));
    } else { await page.click('#editorImageFullscreen'); }
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => imageOverview === null), true, 'native fullscreen exit must restore normal editor');
    assert.equal(await page.evaluate(() => state.editorScale), 0.73, 'native fullscreen exit restores previous zoom');
    console.log('PASS: fullscreen fallback fits tall images and restores zoom, selection and unsaved draft');

    await page.evaluate(() => { if (inlineDraft) { inlineDraft.snapshot = inlineBlockSnapshot(inlineDraft.block); closeInlineEditor(); } });
    await page.evaluate(() => openInlineEditor(state.project.images[0].blocks[0]));
    await page.focus('#inlineEditorField'); await page.evaluate(() => document.execCommand('selectAll')); await page.keyboard.type('ویرایش تازه ۳٫۲۱');
    await page.select('#inlineVerticalAlign', 'top'); await page.click('#inlineEditorApply');
    assert.equal(await page.evaluate(() => inlineDraft === null), true, 'finishing direct editing closes the active box');
    await page.select('#blockList .block-card[data-id="2"] [data-text-mode]', 'ocr');
    await page.evaluate(() => openInlineEditor(state.project.images[0].blocks[1]));
    assert.equal(await page.evaluate(() => inlineDraft?.block.id), 2, 'opening another block switches the direct editing surface');
    await page.select('#inlineVerticalAlign', 'bottom'); await page.click('#inlineEditorApply');
    assert.equal(await page.evaluate(() => state.project.images[0].blocks[0].verticalAlign === 'top' && state.project.images[0].blocks[1].verticalAlign === 'bottom'), true, JSON.stringify(await page.evaluate(() => state.project.images[0].blocks.map(block => ({id:block.id, verticalAlign:block.verticalAlign})))));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await editorRenderDifference(page), 0, 'changing one line language must immediately refresh the real editor canvas');
    await page.click('#editorSelectAll'); await page.click('#editorSelectNone');
    await page.click('#editorBoxes .editor-box[data-id="2"] .box-move');
    await page.keyboard.down('Control');
    await page.click('#editorBoxes .editor-box[data-id="1"] .box-move');
    await page.click('#editorBoxes .editor-box[data-id="3"] .box-move');
    await page.keyboard.up('Control');
    assert.equal(await page.evaluate(() => state.selectedBlockIds.join(',')), '2,1,3', 'real pointer order must make block 2 the reference');
    await page.click('#editorSameSize'); await page.click('#editorAlignLeft');
    assert.equal(await page.evaluate(() => {
      const blocks = state.project.images[0].blocks; const boxes = blocks.map((block) => boxOf(block));
      return state.selectedBlockIds.length === 3 && boxes.every((box) => box.x0 === boxes[0].x0 && box.x1 - box.x0 === 145 && box.y1 - box.y0 === 45) && blocks.map((block) => block.x0).join(',') === '5,165,10';
    }), true, 'real controls must match all three boxes to the first selection, align them, and preserve OCR coordinates');

    await page.$eval('#editorSelectNone', (button) => button.click());
    assert.deepEqual(await page.evaluate(() => state.selectedBlockIds), [], 'the drag setup must clear the previous multi-selection');
    const overlapDrag = await page.evaluate(() => {
      const blocks = state.project.images[0].blocks; const source = boxOf(blocks[1]); const target = boxOf(blocks[0]);
      const rect = document.querySelector('#editorBoxes .editor-box[data-id="2"] .box-move').getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, dx: (target.x0 - source.x0) * state.editorScale, dy: (target.y0 - source.y0) * state.editorScale };
    });
    await page.mouse.move(overlapDrag.x, overlapDrag.y); await page.mouse.down();
    await page.mouse.move(overlapDrag.x + overlapDrag.dx, overlapDrag.y + overlapDrag.dy, { steps: 12 }); await page.mouse.up();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const overlapAfterDrag = await page.evaluate(() => {
      const blocks = state.project.images[0].blocks; const first = boxOf(blocks[0]); const second = boxOf(blocks[1]);
      return { first, second, scale: state.editorScale, selected: state.selectedBlockIds, overlaps: Math.abs(first.x0 - second.x0) < 1 && Math.abs(first.y0 - second.y0) < 1 };
    });
    assert.equal(overlapAfterDrag.overlaps, true, `the real drag must overlap the first two boxes: ${JSON.stringify(overlapAfterDrag)}`);
    assert.equal(await editorRenderDifference(page), 0, 'editor canvas must be pixel-identical to the final renderer even with overlapping boxes');
    console.log('PASS: editor canvas matches final rendering with overlapping boxes');
    await page.mouse.move(overlapDrag.x + overlapDrag.dx, overlapDrag.y + overlapDrag.dy); await page.mouse.down();
    await page.mouse.move(overlapDrag.x, overlapDrag.y, { steps: 12 }); await page.mouse.up();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const unmovedOriginalSourceDarkPixels = await secondSourceDarkPixels(page);
    assert.ok(unmovedOriginalSourceDarkPixels > 50, `while block 2 is moved to tx0=5, original area (165,75) must stay unerased (${unmovedOriginalSourceDarkPixels} dark pixels)`);
    await page.evaluate(async () => {
      const b2 = state.project.images[0].blocks[1];
      b2.tx0 = 165; b2.ty0 = 75; b2.tx1 = 310; b2.ty1 = 145;
      drawEditor();
      if (editorCanvasFrame) await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    const coveredSourceDarkPixels = await secondSourceDarkPixels(page);
    await sleep(400);
    await page.$eval('#editorBoxes .editor-box[data-id="2"] .box-visibility', (eye) => eye.scrollIntoView({ block: 'center', inline: 'center' }));
    await sleep(50);
    await page.click('#editorBoxes .editor-box[data-id="2"] .box-visibility');
    assert.equal(await page.evaluate(() => state.project.images[0].blocks.map((block) => block.enabled).join(',')), 'true,false,true', 'the real eye click must toggle only its own block');
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const revealedSourceDarkPixels = await secondSourceDarkPixels(page);
    assert.ok(revealedSourceDarkPixels > coveredSourceDarkPixels + 10, `the eye must restore original source pixels, not just remove the DOM box (${coveredSourceDarkPixels} -> ${revealedSourceDarkPixels})`);
    assert.equal(await editorRenderDifference(page), 0, 'the editor canvas must rerender after the eye hides a line');
    console.log(`PASS: eye restores original source pixels beneath a hidden translation (${coveredSourceDarkPixels} -> ${revealedSourceDarkPixels} dark pixels)`);
    await page.click('#blockList .block-card[data-id="2"] [data-visibility]');
    assert.equal(await page.evaluate(() => state.project.images[0].blocks.map((block) => block.enabled).join(',')), 'true,true,true');
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await editorRenderDifference(page), 0, 'the editor canvas must rerender when the sidebar shows the line again');
    let uploaded = page.waitForResponse((response) => response.url().endsWith('/rendered') && response.request().method() === 'POST');
    await page.click('#editorApply'); await uploaded;
    uploaded = page.waitForResponse((response) => response.url().endsWith('/rendered') && response.request().method() === 'POST');
    await page.click('#editorClose'); await uploaded;
    await page.waitForFunction(() => !document.getElementById('editorDialog').open && !state.editorId);
    assert.equal(await previewDifference(page), 0, 'main preview must contain the latest rich-text edit and mixed language choices');
    assert.equal(await page.evaluate(() => state.project.images[0].blocks[1].textMode), 'ocr');
    assert.equal(await page.evaluate(() => state.project.images[0].blocks[0].verticalAlign === 'top' && state.project.images[0].blocks[1].verticalAlign === 'bottom'), true, 'mixed vertical positions survive preview and export setup');
    console.log('PASS: real editor events preserve latest edits, same-size multi-alignment, mixed languages, and visibility');

    await page.reload({ waitUntil: 'networkidle0' }); await page.waitForSelector('#grid .item img');
    await page.waitForFunction(() => state.project.images[0].edited === true, { timeout: 5000 });
    assert.equal(await previewDifference(page), 0, 'saved edits must survive reload in the visible preview');

    const files = {};
    for (const [button, key, extension] of [['#exportImagesBtn', 'zip', '.zip'], ['#exportPdfBtn', 'pdf', '.pdf'], ['#exportTxtBtn', 'txt', '.txt']]) {
      const downloaded = nextDownload(cdp, downloads); await page.click(button); files[key] = await downloaded;
      assert.ok(files[key].endsWith(extension) && fs.statSync(files[key]).size > 0, `${key.toUpperCase()} must be a real nonempty download`);
      await page.waitForFunction(() => {
        const link = document.getElementById('downloadLink');
        return link && !link.classList.contains('hidden') && link.href.startsWith('blob:') && link.download;
      });
    }
    // Word export asks first whether to place Translated or English/OCR text on the bubbles:
    await page.click('#exportDocxBtn');
    await page.waitForSelector('#docxExportDialog[open]');
    const docxTrDownload = nextDownload(cdp, downloads);
    await page.click('#docxChoiceTranslation');
    files.docx = await docxTrDownload;
    assert.ok(files.docx.endsWith('.docx') && fs.statSync(files.docx).size > 0, 'DOCX (translation) must be a real nonempty download');
    await page.waitForFunction(() => !document.getElementById('docxExportDialog').open);

    await page.click('#exportDocxBtn');
    await page.waitForSelector('#docxExportDialog[open]');
    const docxOcrDownload = nextDownload(cdp, downloads);
    await page.click('#docxChoiceOcr');
    files.docxOcr = await docxOcrDownload;
    assert.ok(files.docxOcr.endsWith('.docx') && fs.statSync(files.docxOcr).size > 0, 'DOCX (OCR) must be a real nonempty download');
    await page.waitForFunction(() => !document.getElementById('docxExportDialog').open);

    const latestEdit = Buffer.from(await (await fetch(`${base}/api/projects/${projectId}/images/${imageId}/content?edited=true`)).arrayBuffer());
    const editedPath = path.join(temporary, 'latest-edited.png'); fs.writeFileSync(editedPath, latestEdit);
    const text = fs.readFileSync(files.txt, 'utf8');
    assert.ok(text.includes('ویرایش تازه ۳٫۲۱') && text.includes('SOURCE TWO') && text.includes('ترجمهٔ دوم') && text.includes('SOURCE THREE') && text.includes('ترجمهٔ سوم'));
    execFileSync(python, ['-c', `
import io, sys, xml.etree.ElementTree as ET, zipfile
import pymupdf
from PIL import Image, ImageChops
zip_path, pdf_path, docx_path, docx_ocr_path, edited_path = sys.argv[1:]
with Image.open(edited_path) as opened: expected = opened.convert('RGBA')
with zipfile.ZipFile(zip_path) as archive:
    with Image.open(io.BytesIO(archive.read(archive.namelist()[0]))) as opened:
        assert ImageChops.difference(opened.convert('RGBA'), expected).getbbox() is None
with pymupdf.open(pdf_path) as document:
    info = document.extract_image(document[0].get_images(full=True)[0][0])
    with Image.open(io.BytesIO(info['image'])) as opened:
        assert ImageChops.difference(opened.convert('RGBA'), expected).getbbox() is None
with zipfile.ZipFile(docx_path) as archive:
    assert 'word/media/page_001.png' in archive.namelist()
    root = ET.fromstring(archive.read('word/document.xml'))
    docx_text = ''.join(el.text or '' for el in root.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t'))
    assert 'ویرایش تازه ۳٫۲۱' in docx_text and 'ترجمهٔ سوم' in docx_text and 'SOURCE THREE' not in docx_text
with zipfile.ZipFile(docx_ocr_path) as archive:
    assert 'word/media/page_001.png' in archive.namelist()
    root_ocr = ET.fromstring(archive.read('word/document.xml'))
    ocr_text = ''.join(el.text or '' for el in root_ocr.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t'))
    assert 'SOURCE TWO' in ocr_text and 'SOURCE THREE' in ocr_text and 'ترجمهٔ سوم' not in ocr_text
`, files.zip, files.pdf, files.docx, files.docxOcr, editedPath]);
    const other = await api(base, '/api/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Project switch test' }),
    });
    await page.evaluate(async (id) => {
      await refreshProjectList();
      document.querySelector('#grid .tick').click(); // a debounced change immediately followed by a switch
      const select = document.getElementById('projectSelect');
      select.value = id; select.dispatchEvent(new Event('change', { bubbles: true }));
    }, other.id);
    await page.waitForFunction((id) => state.project.id === id, {}, other.id);
    const original = await api(base, `/api/projects/${projectId}`);
    assert.equal(original.images[0].selected, false, 'switching projects must save the pending selection in the original project');
    await page.evaluate((id) => {
      const select = document.getElementById('projectSelect');
      select.value = id; select.dispatchEvent(new Event('change', { bubbles: true }));
    }, projectId);
    await page.waitForFunction((id) => state.project.id === id, {}, projectId);
    assert.equal(await page.evaluate(() => state.project.images[0].selected), false);
    console.log('PASS: switching projects preserves a pending selection and restores it on return');

    let paragraph = await api(base, '/api/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Paragraph grouping test' }),
    });
    const paragraphForm = new FormData(); paragraphForm.append('files', new Blob([fs.readFileSync(source)], { type: 'image/png' }), 'paragraph.png');
    paragraph = await api(base, `/api/projects/${paragraph.id}/files`, { method: 'POST', body: paragraphForm });
    paragraph.settings.overlayMode = 'ocr';
    paragraph.images[0].blocks = [
      { id: 10, text: 'WHY ARE YOU', tr: '', richHtml: '', enabled: true, bg: 'white', x0: 10, y0: 10, x1: 160, y1: 35, lineH: 25, dir: 'rtl', align: 'right' },
      { id: 11, text: 'RUNNING AROUND', tr: '', richHtml: '', enabled: true, bg: 'white', x0: 10, y0: 40, x1: 160, y1: 65, lineH: 25, dir: 'rtl', align: 'right' },
    ];
    await api(base, `/api/projects/${paragraph.id}/state`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: paragraph }),
    });
    await page.evaluate(async (id) => {
      await refreshProjectList();
      const select = document.getElementById('projectSelect'); select.value = id;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }, paragraph.id);
    await page.waitForFunction((id) => state.project.id === id && state.project.images[0]?.edited, {}, paragraph.id);
    await page.click('#grid .item .act button:nth-child(2)');
    await page.waitForSelector('#editorDialog[open] #blockList .block-card');
    await page.click('#editorSelectAll'); await page.click('#editorMergeText');
    assert.equal(await page.evaluate(() => state.project.images[0].blocks[0].text), 'WHY ARE YOU RUNNING AROUND');
    assert.equal(await page.$$eval('#blockList .block-card', (cards) => cards.length), 1);
    await page.click('#editorClose'); await page.waitForFunction(() => !state.editorId);
    const paragraphSaved = await api(base, `/api/projects/${paragraph.id}`);
    assert.equal(paragraphSaved.images[0].blocks[0].sourceLines.length, 2);
    const paragraphPreview = await api(base, `/api/projects/${paragraph.id}/translation-preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_ids: [paragraph.images[0].id], provider: 'free' }),
    });
    assert.equal(paragraphPreview.blockCount, 1);
    assert.equal(paragraphPreview.requests[0].text, 'WHY ARE YOU RUNNING AROUND');
    await page.click('#grid .item .act button:nth-child(2)');
    await page.waitForSelector('#editorDialog[open] #blockList .block-card');
    await page.click('#editorSelectAll'); await page.click('#editorSplitText');
    assert.equal(await page.$$eval('#blockList .block-card', (cards) => cards.length), 2);
    await page.click('#editorClose'); await page.waitForFunction(() => !state.editorId);
    assert.equal((await api(base, `/api/projects/${paragraph.id}`)).images[0].blocks.length, 2);
    console.log('PASS: manual paragraph merge, translation preview, saved source lines and split work in Chromium');
    assert.deepEqual(browserErrors, [], 'the real render/export path must not produce browser errors');

    // Exercise the free planner and saved checkpoint through the real browser
    // and Python routes, with a local deterministic translation stub.
    const freeCfg = await api(base,'/api/ai-settings');
    assert.equal(freeCfg.free_services.google.timeout_seconds,75); assert.equal(freeCfg.free_services.google.retry_count,2);
    assert.equal(freeCfg.free_services.mymemory.timeout_seconds,65); assert.equal(freeCfg.free_services.mymemory.retry_count,1);
    let freeProject = await api(base,'/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Free packing and resume'})});
    const freePages=new FormData(); for(let i=0;i<2;i++) freePages.append('files',new Blob([fs.readFileSync(source)],{type:'image/png'}),`free-${i}.png`);
    freeProject=await api(base,`/api/projects/${freeProject.id}/files`,{method:'POST',body:freePages});
    const makeBlock=(id,text)=>({id,text,tr:'old',richHtml:'',enabled:true,bg:'white',x0:5,y0:5,x1:200,y1:45,lineH:40,dir:'rtl',align:'right'});
    freeProject.images[0].blocks=['A'.repeat(300),'ABCD','B'.repeat(100),'C'.repeat(120)].map((text,i)=>makeBlock(i+1,text));
    freeProject.images[1].blocks=[makeBlock(1,'SECOND PAGE')];
    await api(base,`/api/projects/${freeProject.id}/state`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:freeProject})});
    await page.evaluate(async id=>{await refreshProjectList();const el=document.getElementById('projectSelect');el.value=id;el.dispatchEvent(new Event('change',{bubbles:true}));},freeProject.id);
    await page.waitForFunction(id=>state.project.id===id,{},freeProject.id);
    await page.click('#translateBtn'); await page.waitForSelector('#translationPreviewDialog[open]');
    const firstFree=await page.$eval('#translationPreviewRequests pre',el=>el.textContent);
    assert.ok(firstFree.includes('ABCD') && firstFree.length>4 && !firstFree.includes('SECOND PAGE'));
    assert.equal(await page.$eval('#translationSkillWrap',el=>el.classList.contains('hidden')),true);
    await page.click('#translationPreviewConfirm');
    await page.waitForFunction(()=>!translationRunning && document.getElementById('translationStatus').textContent.includes('متوقف شد'),{timeout:15000});
    assert.deepEqual(freeGenerations.map(q=>q.includes('SECOND PAGE')?'SECOND PAGE':q),[firstFree,'C'.repeat(120),'SECOND PAGE']);
    let freeSaved=await api(base,`/api/projects/${freeProject.id}`);
    assert.equal(freeSaved.images[0].blocks[1].tr,'ترجمه'); assert.equal(freeSaved.images[1].blocks[0].tr,'old');
    assert.equal(freeSaved.images[0].blocks[1].align,'justify'); assert.equal(freeSaved.images[0].blocks[1].size,12); assert.equal(freeSaved.images[0].blocks[1].verticalAlign,'top');
    await page.click('#retryTranslation'); await page.waitForFunction(()=>!translationRunning && !document.getElementById('translationDialog').open,{timeout:15000});
    assert.equal(freeGenerations.length,4); assert.equal(freeGenerations[3],'SECOND PAGE');
    freeSaved=await api(base,`/api/projects/${freeProject.id}`); assert.equal(freeSaved.images[1].blocks[0].tr,'ترجمه');
    assert.equal(freeSaved.images[1].blocks[0].align,'justify'); assert.equal(freeSaved.images[1].blocks[0].size,12); assert.equal(freeSaved.images[1].blocks[0].verticalAlign,'top');
    console.log('PASS: free settings, four-character packing, page boundaries, saved progress and retry in Chromium with a local stub');

    // A mixed selection reads only the page without OCR, preserves existing
    // translated blocks, reports OCR failures and resumes at the preview.
    let autoProject=await api(base,'/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'OCR before translation'})});
    const autoFiles=new FormData(); for(let i=0;i<2;i++) autoFiles.append('files',new Blob([fs.readFileSync(source)],{type:'image/png'}),`auto-${i}.png`);
    autoProject=await api(base,`/api/projects/${autoProject.id}/files`,{method:'POST',body:autoFiles});
    autoProject.images[0].blocks=[makeBlock(1,'EXISTING OCR')]; autoProject.images[0].blocks[0].tr='existing translation';
    autoProject.images[1].blocks=[];
    await api(base,`/api/projects/${autoProject.id}/state`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:autoProject})});
    await page.evaluate(async id=>{await refreshProjectList();const el=document.getElementById('projectSelect');el.value=id;el.dispatchEvent(new Event('change',{bubbles:true}));},autoProject.id);
    await page.waitForFunction(id=>state.project.id===id,{},autoProject.id);
    const callsBeforeAuto=freeGenerations.length;
    await page.click('#translateBtn'); await page.waitForSelector('#ocrDialog[open]');
    assert.ok(await page.$eval('#ocrTranslationNotice',el=>el.textContent.includes('1 تصویر')));
    assert.equal(await page.$eval('#ocrOnlySelected',el=>el.disabled),true);
    assert.equal(await page.$eval('#translationPreviewDialog',el=>el.open),false);
    assert.equal(freeGenerations.length,callsBeforeAuto);
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('#ocrDialog',el=>el.open),false); assert.equal(ocrCalls.length,0);
    await page.click('#translateBtn'); await page.waitForSelector('#ocrDialog[open]');
    await page.click('#startOcrBtn');
    await page.waitForFunction(()=>document.getElementById('ocrStatus').textContent.includes('ocr simulated failure'),{timeout:15000});
    assert.equal(await page.$eval('#ocrDialog',el=>el.open),true);
    assert.ok(await page.$eval('#ocrStatus',el=>el.textContent.includes('HTTP 500') && el.textContent.includes('/ocr') && el.textContent.includes('RuntimeError')));
    assert.equal(await page.$eval('#copyOcrError',el=>el.classList.contains('hidden')),false);
    assert.equal(freeGenerations.length,callsBeforeAuto);
    await page.click('#startOcrBtn'); await page.waitForSelector('#translationPreviewDialog[open]',{timeout:15000});
    assert.equal(ocrCalls.length,2); assert.equal(await page.$eval('#ocrDialog',el=>el.open),false);
    const ocrSaved=await api(base,`/api/projects/${autoProject.id}`);
    assert.equal(ocrSaved.images[0].blocks[0].tr,'existing translation');
    assert.equal(ocrSaved.images[1].blocks[0].text,'NEWLY READ OCR'); assert.equal(ocrSaved.images[1].ocrCompleted,true);
    assert.ok(await page.$eval('#translationPreviewRequests',el=>el.textContent.includes('EXISTING OCR')));
    await page.click('#translationPreviewConfirm'); await page.waitForFunction(()=>!translationRunning && !document.getElementById('translationDialog').open,{timeout:15000});
    assert.deepEqual(freeGenerations.slice(callsBeforeAuto),['EXISTING OCR','NEWLY READ OCR']);
    await page.click('#translateBtn'); await page.waitForSelector('#translationPreviewDialog[open]');
    assert.equal(ocrCalls.length,2,'already read pages skip OCR'); await page.click('#translationPreviewCancel');
    console.log('PASS: OCR before translation reads only missing pages, preserves existing text and reports errors');

    ocrEmpty=true;
    let emptyProject=await api(base,'/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'No OCR text'})});
    const emptyFile=new FormData(); emptyFile.append('files',new Blob([fs.readFileSync(source)],{type:'image/png'}),'empty.png');
    emptyProject=await api(base,`/api/projects/${emptyProject.id}/files`,{method:'POST',body:emptyFile});
    await page.evaluate(async id=>{await refreshProjectList();const el=document.getElementById('projectSelect');el.value=id;el.dispatchEvent(new Event('change',{bubbles:true}));},emptyProject.id);
    await page.waitForFunction(id=>state.project.id===id,{},emptyProject.id);
    const beforeEmpty=freeGenerations.length;
    await page.click('#translateBtn'); await page.waitForSelector('#ocrDialog[open]'); await page.click('#startOcrBtn');
    await page.waitForSelector('#translationDialog[open]',{timeout:15000});
    assert.ok(await page.$eval('#translationStatus',el=>el.textContent.includes('هیچ کادر فعال') && el.textContent.includes('OCR')));
    assert.equal(freeGenerations.length,beforeEmpty); await page.keyboard.press('Escape');
    await page.click('#translateBtn'); await page.waitForSelector('#translationDialog[open]');
    assert.equal(ocrCalls.length,3,'empty OCR is not retried automatically');
    assert.equal(await page.$eval('#ocrDialog',el=>el.open),false); await page.keyboard.press('Escape');
    ocrEmpty=false;
    console.log('PASS: empty OCR stops without sending and does not loop');

    let badProject=await api(base,'/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Translation diagnostic'})});
    const badFile=new FormData(); badFile.append('files',new Blob([fs.readFileSync(source)],{type:'image/png'}),'bad.png');
    badProject=await api(base,`/api/projects/${badProject.id}/files`,{method:'POST',body:badFile});
    badProject.images[0].blocks=[makeBlock(1,'X'.repeat(501))];
    await api(base,`/api/projects/${badProject.id}/state`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:badProject})});
    await page.evaluate(async id=>{await refreshProjectList();const el=document.getElementById('projectSelect');el.value=id;el.dispatchEvent(new Event('change',{bubbles:true}));},badProject.id);
    await page.waitForFunction(id=>state.project.id===id,{},badProject.id);
    await page.click('#translateBtn'); await page.waitForSelector('#translationDialog[open]');
    const preparationError=await page.$eval('#translationStatus',el=>el.textContent);
    assert.ok(preparationError.includes('context-preview') && preparationError.includes('HTTP 502') && preparationError.includes('ارسال نشد'));
    assert.equal(await page.$eval('#copyTranslationError',el=>el.classList.contains('hidden')),false);
    await page.keyboard.press('Escape');
    console.log('PASS: preflight translation errors show a persistent, copyable stage and HTTP diagnostic');



    // Recover malformed paid output locally, both for a project and one block.
    let recoveryProject = await api(base, '/api/projects', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Response recovery'})});
    const recoveryFiles=new FormData(); for(let i=0;i<2;i++) recoveryFiles.append('files',new Blob([fs.readFileSync(source)],{type:'image/png'}),`recovery-${i}.png`);
    recoveryProject=await api(base,`/api/projects/${recoveryProject.id}/files`,{method:'POST',body:recoveryFiles});
    recoveryProject.images[0].blocks=[makeBlock(1,'FENCED PAGE')]; recoveryProject.images[1].blocks=[makeBlock(1,'BROKEN RESPONSE')];
    await api(base,`/api/projects/${recoveryProject.id}/state`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:recoveryProject})});
    await api(base,'/api/ai-settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'openai',base_url:aiBase,model:'local-browser-model'})});
    await page.evaluate(async id=>{await loadAiSettings();await refreshProjectList();const el=document.getElementById('projectSelect');el.value=id;el.dispatchEvent(new Event('change',{bubbles:true}));},recoveryProject.id);
    await page.waitForFunction(id=>state.project.id===id,{},recoveryProject.id);
    await page.click('#translateBtn'); await page.waitForSelector('#translationPreviewDialog[open]'); await page.click('#translationPreviewConfirm');
    await page.waitForFunction(()=>!translationRunning && !document.getElementById('responseRepair').classList.contains('hidden'),{timeout:15000});
    assert.equal(aiGenerations.length,3,'the malformed response retries according to the configured policy');
    assert.ok((await page.$eval('#responseRepairText',el=>el.value)).includes('خصوصی پاسخ'));
    assert.ok(!(await page.$eval('#translationStatus',el=>el.textContent)).includes('خصوصی پاسخ'));
    assert.equal((await api(base,`/api/projects/${recoveryProject.id}`)).images[0].blocks[0].tr,'صفحه حصار');
    await page.$eval('#responseRepairText',el=>{el.closest('details').open=true;el.value='{}';}); await page.click('#applyResponseRepair');
    await page.waitForFunction(()=>document.getElementById('responseRepairStatus').textContent.includes('معتبر'));
    assert.equal(aiGenerations.length,3);
    await page.$eval('#repairTranslation',el=>{el.value='اصلاح شد';}); await page.$eval('#repairSummary',el=>{el.value='خلاصه';});
    await page.click('#applyResponseFields'); await page.waitForFunction(()=>!translationRunning && !document.getElementById('translationDialog').open,{timeout:15000});
    assert.equal(aiGenerations.length,3); assert.equal((await api(base,`/api/projects/${recoveryProject.id}`)).images[1].blocks[0].tr,'اصلاح شد');
    await page.waitForFunction(() => !translationDecisionBusy);
    // Single-block editing exercises the separate continuation path.
    await page.click('#grid .item:nth-child(2) .act button:nth-child(2)'); await page.waitForSelector('#editorDialog[open] #blockList .block-card');
    await page.waitForFunction(() => state.editorId === state.project.images[1].id && document.getElementById('blockList').textContent.includes('BROKEN RESPONSE'));
    await page.evaluate(()=>[...document.querySelectorAll('#blockList .block-card button')].find(el=>el.textContent==='ترجمهٔ دوباره').click());
    await page.waitForSelector('#translationPreviewDialog[open]');
    assert.ok(await page.$eval('#translationPreviewRequests', el => el.textContent.includes('BROKEN RESPONSE')), 'unexpected preview: ' + await page.$eval('#translationPreviewRequests', el => el.textContent));
    await page.click('#translationPreviewConfirm');
    await page.waitForFunction(()=>document.getElementById('translationDialog').open && !document.getElementById('responseRepair').classList.contains('hidden'),{timeout:15000});
    assert.equal(aiGenerations.length,5);
    await page.$eval('#repairTranslation',el=>{el.value='تکی اصلاح شد';}); await page.$eval('#repairSummary',el=>{el.value='خلاصه';});
    await page.click('#applyResponseFields'); await page.waitForFunction(()=>!document.getElementById('translationDialog').open,{timeout:15000});
    assert.equal(aiGenerations.length,5); assert.equal(await page.evaluate(()=>state.project.images[1].blocks[0].tr),'تکی اصلاح شد');
    await page.click('#editorClose'); await page.waitForFunction(()=>!state.editorId);
    console.log('PASS: fenced AI output and manually repaired project/single responses require no extra AI request');
    aiGenerations.length=0; aiSystems.length=0;

    // Real browser and Python server: three selected pages, one AI request at a
    // time, and a failure on page two must retain page one without sending page three.
    let pageProject = await api(base, '/api/projects', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:'Page by page AI'}) });
    const threePages = new FormData();
    for (let n=1; n<=3; n++) threePages.append('files', new Blob([fs.readFileSync(source)], {type:'image/png'}), `batch-${n}.png`);
    pageProject = await api(base, `/api/projects/${pageProject.id}/files`, {method:'POST',body:threePages});
    for (const [index, image] of pageProject.images.entries()) image.blocks = [{id:1,text:`BROWSER PAGE ${['ONE','TWO','THREE'][index]}`,tr:'old',richHtml:'',enabled:true,bg:'white',x0:5,y0:5,x1:200,y1:45,lineH:40,dir:'rtl',align:'right'}];
    pageProject.images[0].blocks[0].text += ' ' + 'a'.repeat(100);
    pageProject.images[0].blocks.push({...pageProject.images[0].blocks[0], id:2, text:'BROWSER EXTRA ' + 'b'.repeat(100), y0:70, y1:110});
    await api(base, `/api/projects/${pageProject.id}/state`, {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:pageProject})});
    await api(base, '/api/ai-settings', {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'openai',base_url:aiBase,model:'local-browser-model'})});
    await page.evaluate(async id => { await loadAiSettings(); await refreshProjectList(); const select=document.getElementById('projectSelect'); select.value=id; select.dispatchEvent(new Event('change',{bubbles:true})); }, pageProject.id);
    await page.waitForFunction(id => state.project.id === id, {}, pageProject.id);
    await page.evaluate(() => waitForProjectLoads());
    await page.click('#translateBtn'); await page.waitForSelector('#translationPreviewDialog[open]');
    const pagePayloads = await page.$$eval('#translationPreviewRequests pre', entries => entries.map(entry => entry.textContent));
    assert.ok(await page.$eval('#translationPreviewNote', el => el.textContent.includes('650') && el.textContent.includes('خلاصه')));
    assert.equal(pagePayloads.length,1); assert.ok(pagePayloads[0].includes('PAGE ONE') && !pagePayloads[0].includes('BROWSER EXTRA')); // future payloads depend on the generated summary
    assert.ok(await page.$eval('#translationSkill', el => el.value.includes('روان')));
    const defaultSkill = await page.$eval('#translationSkill', el=>el.value);
    await page.$eval('#translationSkill', el => { el.value = 'temporary'; el.dispatchEvent(new Event('input', {bubbles:true})); });
    await page.click('#translationSkillReset'); assert.equal(await page.$eval('#translationSkill', el=>el.value), defaultSkill);
    await page.$eval('#translationSkill', el => { el.value = 'لحن داستان رسمی و نام‌ها ثابت باشد'; el.dispatchEvent(new Event('input', {bubbles:true})); });
    assert.ok(await page.$eval('#translationPreviewConfirm', el => el.textContent.includes('به‌روزرسانی')));
    await page.click('#translationPreviewConfirm');
    await page.waitForFunction(() => document.getElementById('translationPreviewSystem').textContent.includes('لحن داستان رسمی') && !document.getElementById('translationPreviewConfirm').disabled);
    assert.ok(await page.$eval('#translationPreviewDialog', el=>el.open)); assert.equal(aiGenerations.length, 0, 'editing the skill only refreshes locally');
    const approvedSystem = await page.$eval('#translationPreviewSystem', el=>el.textContent);
    await page.click('#translationPreviewConfirm');
    const aiStart = Date.now(); while (!aiGenerations.length && Date.now() - aiStart < 5000) await sleep(20);
    assert.equal(aiGenerations.length, 1); await sleep(150); assert.equal(aiGenerations.length, 1, 'page two must wait for page one response');
    await page.waitForFunction(() => !translationRunning && document.getElementById('translationStatus').textContent.includes('متوقف شد'), {timeout:15000});
    assert.equal(aiGenerations.length, 4); assert.ok(aiSystems.every(system => system === approvedSystem)); assert.ok(aiGenerations[0].includes('BROWSER PAGE ONE') && aiGenerations[1].includes('BROWSER EXTRA') && aiGenerations[2].includes('BROWSER PAGE TWO') && aiGenerations[3].includes('BROWSER PAGE TWO')); assert.ok(aiGenerations.every((text, i) => [...text].length + [...aiSystems[i]].length <= 650)); assert.ok(!aiGenerations[0].includes('Context:') && aiGenerations[1].includes('جان دوست مری است'));
    const storedPages = await api(base, `/api/projects/${pageProject.id}`);
    assert.deepEqual(storedPages.images.map(image => image.blocks[0].tr), ['ترجمه صفحه یک','old','old']);
    assert.ok(await page.$eval('#translationStatus', el => el.textContent.includes('2 درخواست ذخیره شد')));
    const realError = await page.$eval('#translationStatus', el => el.textContent);
    assert.ok(realError.includes('HTTP 503') && realError.includes('test failure') && realError.includes('real-code'));
    assert.ok(!realError.includes('browser-local-secret'), 'the actual provider diagnostic must redact stored keys');
    assert.ok(await page.$eval('#copyTranslationError', el => !el.classList.contains('hidden')));
    assert.ok(await page.$eval('#retryTranslation', el => !el.classList.contains('hidden')));
    await sleep(250); assert.equal(aiGenerations.length, 4, 'no more attempts before the user chooses');
    await page.click('#retryTranslation');
    await page.waitForFunction(() => !translationRunning && document.getElementById('translationStatus').textContent.includes('متوقف شد'), {timeout:15000});
    assert.equal(aiGenerations.length, 6); assert.ok(aiSystems.every(system => system === approvedSystem));
    assert.ok(aiGenerations.slice(4).every(text => text.includes('BROWSER PAGE TWO')));
    const latestError = await page.$eval('#translationStatus', el => el.textContent);
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{writeText:async () => {throw new Error('clipboard denied');}} }); });
    await page.click('#copyTranslationError'); await page.waitForFunction(() => document.getElementById('toast').textContent.includes('clipboard denied'));
    assert.equal(await page.$eval('#translationDialog', el => el.open), true, 'a denied copy must keep the error available');
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{writeText:async text => {window.copiedTranslationError = text;}} }); });
    await page.click('#copyTranslationError'); await page.waitForFunction(() => !!window.copiedTranslationError);
    assert.equal(await page.evaluate(() => window.copiedTranslationError), latestError);
    assert.equal(await page.$eval('#translationDialog', el => el.open), false);
    assert.equal(await page.evaluate(() => state.project.images[0].blocks[0].tr), 'ترجمه صفحه یک');
    console.log('PASS: real AI sends pages sequentially, applies per-key retry, reports safe details, and retains completed pages');
    await page.click('#translateBtn'); await page.waitForSelector('#translationPreviewDialog[open]');
    assert.equal(await page.$eval('#translationSkill', el=>el.value), 'لحن داستان رسمی و نام‌ها ثابت باشد');
    await page.click('#translationPreviewCancel');
    await page.click('#grid .item .act button:nth-child(2)'); await page.waitForSelector('#editorDialog[open] #blockList .block-card');
    await page.waitForFunction(() => document.getElementById('blockList').textContent.includes('BROWSER PAGE ONE'));
    await page.evaluate(() => [...document.querySelectorAll('#blockList .block-card button')].find(el => el.textContent === 'ترجمهٔ دوباره').click());
    await page.waitForSelector('#translationPreviewDialog[open]');
    assert.equal(await page.$eval('#translationSkill', el=>el.value), 'لحن داستان رسمی و نام‌ها ثابت باشد');
    await page.$eval('#translationSkill', el=>{el.value='لحن صمیمی در بازترجمه';el.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.click('#translationPreviewConfirm');
    await page.waitForFunction(()=>document.getElementById('translationPreviewSystem').textContent.includes('لحن صمیمی در بازترجمه') && !document.getElementById('translationPreviewConfirm').disabled);
    const singleSystem = await page.$eval('#translationPreviewSystem', el=>el.textContent);
    const beforeSingle = aiGenerations.length;
    await page.click('#translationPreviewConfirm'); await page.waitForFunction(()=>!document.getElementById('translationPreviewDialog').open);
    const singleStart = Date.now(); while (aiGenerations.length === beforeSingle && Date.now() - singleStart < 5000) await sleep(30);
    assert.equal(aiGenerations.length, beforeSingle + 1); assert.equal(aiSystems.at(-1), singleSystem);
    await page.evaluate(async () => { await translationPreviewTask; });
    await page.click('#editorClose'); await page.waitForFunction(()=>!state.editorId);
    console.log('PASS: editable skill is confirmed and sent on every AI call, persists per project, and applies to a single-box retry');

    await page.keyboard.press('Escape');
    aiGenerations.length = 0; dedupFailuresRemaining = 2;
    let dedupProject = await api(base, '/api/projects', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:'Repeated titles'})});
    const dedupForm = new FormData();
    for (let n=1; n<=2; n++) dedupForm.append('files', new Blob([fs.readFileSync(source)], {type:'image/png'}), `repeat-${n}.png`);
    dedupProject = await api(base, `/api/projects/${dedupProject.id}/files`, {method:'POST',body:dedupForm});
    for (const [index, image] of dedupProject.images.entries()) image.blocks = [
      {id:1,text:'HEADER SAME',tr:'old',enabled:true,bg:'white',x0:5,y0:5,x1:200,y1:45,lineH:40,dir:'rtl',align:'right'},
      {id:2,text:index ? 'DEDUP SECOND' : 'DEDUP FIRST',tr:'old',enabled:true,bg:'white',x0:5,y0:70,x1:200,y1:110,lineH:40,dir:'rtl',align:'right'},
    ];
    await api(base, `/api/projects/${dedupProject.id}/state`, {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:dedupProject})});
    await page.evaluate(async id => { await refreshProjectList(); const select=document.getElementById('projectSelect'); select.value=id; select.dispatchEvent(new Event('change',{bubbles:true})); }, dedupProject.id);
    await page.waitForFunction(id => state.project.id === id && state.project.images.length === 2 && state.project.images.every(image => image.edited), {}, dedupProject.id);
    await page.click('#translateBtn'); await page.waitForSelector('#translationPreviewDialog[open]');
    assert.equal(await page.$eval('#translationSkill', el=>el.value), defaultSkill, 'a different project starts with its own skill');
    const dedupPayloads = await page.$$eval('#translationPreviewRequests pre', entries => entries.map(el=>el.textContent));
    assert.equal(dedupPayloads.length, 1);
    assert.equal(dedupPayloads.filter(text=>text.includes('HEADER SAME')).length, 1);
    assert.ok(await page.$eval('#translationPreviewNote', el=>el.textContent.includes('1 کادر تکراری')));
    await page.click('#translationPreviewConfirm');
    await page.waitForFunction(() => !translationRunning && document.getElementById('translationStatus').textContent.includes('متوقف شد'), {timeout:15000});
    assert.equal(aiGenerations.length, 2);
    assert.ok(await page.$eval('#retryTranslation', el => !el.classList.contains('hidden')));
    await page.click('#retryTranslation');
    try { await page.waitForFunction(() => !translationRunning && !document.getElementById('translationDialog').open, {timeout:15000}); }
    catch (error) { console.error('Dedup translation status:', await page.$eval('#translationDialog', el => el.textContent), 'requests:', aiGenerations); throw error; }
    const dedupStored = await api(base, `/api/projects/${dedupProject.id}`);
    assert.deepEqual(dedupStored.images.map(image=>image.blocks[0].tr), ['عنوان مشترک', 'عنوان مشترک']);
    assert.equal(aiGenerations.length, 4);
    assert.ok(dedupStored.images.every(image=>image.edited));
    // The generated summary is editable in the next preview, and changing it
    // refreshes locally without sending another AI request.
    const beforeSummaryPreview = aiGenerations.length;
    await page.click('#translateBtn'); await page.waitForSelector('#translationPreviewDialog[open]');
    assert.equal(await page.$eval('#translationContext', el => el.value), '', 'a new translation starts with an empty summary');
    await page.$eval('#translationContext', el => { el.value = 'جان و مری'; el.dispatchEvent(new Event('input', {bubbles:true})); });
    await page.click('#translationPreviewConfirm');
    await page.waitForFunction(() => document.getElementById('translationPreviewRequests').textContent.includes('جان و مری') && !document.getElementById('translationPreviewConfirm').disabled);
    assert.equal(aiGenerations.length, beforeSummaryPreview, 'refreshing the preview must not send');
    await page.click('#translationPreviewCancel');
    console.log('PASS: generated summary can be reviewed and edited before sending');
    await page.click('#menuBtn'); await page.click('#aiBtn'); await page.waitForSelector('#aiDialog[open]');
    await page.$eval('#aiReuseRepeated', el=>{el.checked=false; el.dispatchEvent(new Event('change',{bubbles:true}));});
    await page.click('#saveAiBtn'); await page.waitForFunction(()=>state.ai.reuse_repeated===false); await page.keyboard.press('Escape');
    await page.click('#translateBtn'); await page.waitForSelector('#translationPreviewDialog[open]');
    const independentStart = aiGenerations.length;
    await page.click('#translationPreviewConfirm');
    await page.waitForFunction(() => !translationRunning && !document.getElementById('translationDialog').open, {timeout:15000});
    assert.equal(aiGenerations.slice(independentStart).filter(text=>text.includes('HEADER SAME')).length, 2);
    console.log('PASS: repeated title is sent once and applied to both pages; opt-out sends it per page');

    // A skill saved by an earlier version must never be silently truncated.
    await page.evaluate(() => localStorage.setItem(`comic-studio-ai-skill:${state.project.id}`, 'x'.repeat(120)));
    const beforeOverlong = aiGenerations.length;
    await page.click('#translateBtn'); await page.waitForSelector('#translationPreviewDialog[open]');
    assert.equal(await page.$eval('#translationSkill', el => el.value.length), 120);
    assert.equal(await page.$eval('#translationSkillCounter', el => el.classList.contains('over-budget')), true);
    assert.equal(await page.$eval('#translationSkill', el => el.classList.contains('budget-over-limit')), true);
    await page.$eval('#translationContext', el => {el.value='x'.repeat(98); el.dispatchEvent(new Event('input',{bubbles:true}));});
    assert.equal(await page.$eval('#translationContextCounter', el => el.classList.contains('over-budget')), true);
    assert.equal(await page.$eval('#translationContext', el => el.classList.contains('budget-over-limit')), true);
    await page.$eval('#translationContext', el => {el.value=''; el.dispatchEvent(new Event('input',{bubbles:true}));});
    assert.equal(await page.$eval('#translationPreviewConfirm', el => el.disabled), true);
    assert.ok(await page.$eval('#translationSkillStatus', el => el.textContent.includes('بیش از سقف')));
    await page.click('#translationSkill'); await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
    await page.type('#translationSkill', 'x'.repeat(100));
    assert.equal(await page.$eval('#translationSkill', el => [...el.value].length), 97, 'typing cannot exceed fifteen percent of the 650-character cap');
    await page.click('#translationPreviewConfirm');
    await page.waitForFunction(() => document.getElementById('translationPreviewSystem').textContent.includes('x'.repeat(97)) && !document.getElementById('translationPreviewConfirm').disabled);
    assert.equal(aiGenerations.length, beforeOverlong);
    await page.click('#translationPreviewCancel');
    await page.evaluate(value => localStorage.setItem(`comic-studio-ai-skill:${state.project.id}`, value), defaultSkill);
    console.log('PASS: overlong saved skill is shown as an error and new typing obeys its percentage cap');

    // A cancelled refresh may fail after a different preview has opened.
    await page.evaluate(() => {
      window.rejectOldPreview = null;
      const preview = {provider:'openai', skill:'old', defaultSkill:'old', blockCount:1, requestCount:1, requests:[{index:1,text:'old',characters:3}], systemPrompt:'old'};
      showTranslationRequestPreview(preview, () => {}, () => new Promise((resolve, reject) => { window.rejectOldPreview = reject; }));
    });
    await page.$eval('#translationSkill', el => {el.value='changed'; el.dispatchEvent(new Event('input', {bubbles:true}));});
    await page.click('#translationPreviewConfirm');
    await page.waitForFunction(() => typeof window.rejectOldPreview === 'function');
    await page.click('#translationPreviewCancel');
    await page.evaluate(() => {
      const preview = {provider:'openai', skill:'new', defaultSkill:'new', blockCount:1, requestCount:1, requests:[{index:1,text:'new',characters:3}], systemPrompt:'new'};
      showTranslationRequestPreview(preview, () => {}, async () => preview);
      window.rejectOldPreview(new Error('old preview failed'));
    });
    await sleep(50);
    assert.equal(await page.$eval('#translationSkill', el => el.value), 'new');
    assert.equal(await page.$eval('#translationSkill', el => el.disabled), false);
    assert.equal(await page.$eval('#translationSkillStatus', el => el.textContent), '');
    assert.equal(await page.$eval('#translationPreviewConfirm', el => el.disabled), false);
    await page.click('#translationPreviewCancel');
    console.log('PASS: cancelled preview errors cannot contaminate a newer preview');

    let backupProject = await api(base, '/api/projects', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:'Portable project'})});
    const backupForm = new FormData(); backupForm.append('files', new Blob([fs.readFileSync(source)], {type:'image/png'}), 'portable.png');
    backupProject = await api(base, `/api/projects/${backupProject.id}/files`, {method:'POST',body:backupForm});
    backupProject.images[0].blocks = [{id:42,text:'Original OCR',tr:'ترجمهٔ قابل انتقال',richHtml:'<b>ترجمهٔ قابل انتقال</b>',enabled:true,bg:'white',x0:5,y0:5,x1:155,y1:45,lineH:40,dir:'rtl',align:'right'}];
    await api(base, `/api/projects/${backupProject.id}/state`, {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:backupProject})});
    await page.evaluate(async id => {await refreshProjectList(); const select=document.getElementById('projectSelect'); select.value=id; select.dispatchEvent(new Event('change',{bubbles:true}));}, backupProject.id);
    await page.waitForFunction(id => state.project.id === id, {}, backupProject.id);
    await page.evaluate(() => waitForProjectLoads());
    await page.evaluate(() => {
      const item=state.project.images[0], block=item.blocks[0];
      const key=`comic-studio-draft:${encodeURIComponent(state.project.id)}:${encodeURIComponent(item.id)}:${encodeURIComponent(block.id)}:translation`;
      localStorage.setItem(key, JSON.stringify({html:'<p>portable draft</p>',base:inlineBlockSnapshot(block),time:'test',meta:null}));
    });
    await page.click('#menuBtn'); const backupDownload = nextDownload(cdp, downloads); await page.click('#backupProjectBtn');
    const backupPath = await backupDownload; assert.ok(backupPath.endsWith('.zip') && fs.statSync(backupPath).size > 0);
    await page.waitForFunction(() => !document.getElementById('backupDownloadLink').classList.contains('hidden'));
    assert.equal(await page.$eval('#backupDownloadLink', el => el.download.endsWith('-backup.zip')), true);
    await page.$eval('#restoreProjectInput', el => el.value = '');
    const fileInput = await page.$('#restoreProjectInput'); await fileInput.uploadFile(backupPath);
    await page.waitForSelector('#appModalDialog[open]');
    assert.ok((await page.$eval('#appModalMessage', el => el.textContent)).includes('بازیابی شود'));
    await page.click('#appModalConfirm');
    await page.waitForFunction(id => state.project.id !== id && state.project.name === 'Portable project', {timeout:15000}, backupProject.id);
    const restoredId = await page.evaluate(() => state.project.id);
    assert.notEqual(restoredId, backupProject.id);
    assert.equal(await page.evaluate(() => state.project.images[0].blocks[0].tr), 'ترجمهٔ قابل انتقال');
    assert.equal(await page.evaluate(() => {
      const item=state.project.images[0]; const key=`comic-studio-draft:${encodeURIComponent(state.project.id)}:${encodeURIComponent(item.id)}:42:translation`;
      return JSON.parse(localStorage.getItem(key)).html;
    }), '<p>portable draft</p>');
    assert.equal((await api(base, `/api/projects/${backupProject.id}`)).images[0].blocks[0].tr, 'ترجمهٔ قابل انتقال');
    execFileSync(python, ['-c', `
import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    assert 'project.json' in archive.namelist() and 'browser-drafts.json' in archive.namelist()
    assert not any(b'browser-local-secret' in archive.read(name) for name in archive.namelist())
`, backupPath]);
    console.log('PASS: browser downloads and restores a new project ZIP with image, text and local draft without API keys');

    // v3.64: Hamburger menu outside-click dismissal + closing OCR & Translation dialogs via × and Escape while running.
    await page.evaluate(() => setMenuOpen(false));
    await page.click('#menuBtn');
    assert.equal(await page.$eval('#menu', (el) => el.classList.contains('hidden')), false);
    await page.click('#projectName');
    assert.equal(await page.$eval('#menu', (el) => el.classList.contains('hidden')), false, 'clicking inside #menu must keep it open');
    await page.click('#mainwrap');
    assert.equal(await page.$eval('#menu', (el) => el.classList.contains('hidden')), true, 'clicking outside #menu must close it immediately');

    await page.evaluate(async () => {
      state.ai.provider = 'free';
      state.project.images[0].selected = true;
      renderAll();
      await saveProject();
      window.__origFetchV364 = window.fetch;
      window.fetch = (url, opts = {}) => {
        const u = String(url);
        if (u.endsWith('/ocr') || u.endsWith('/context-step') || u.endsWith('/translate-text/context') || u.endsWith('/translate-text') || u.endsWith('/export')) {
          return new Promise((_resolve, reject) => {
            if (opts.signal?.aborted) { const e = new DOMException('Aborted', 'AbortError'); reject(e); return; }
            opts.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
          });
        }
        return window.__origFetchV364(url, opts);
      };
    });
    // 1. OCR × and Escape while running ask Persian confirmation in themed #appModalDialog first
    await page.click('#ocrBtn');
    await page.waitForSelector('#ocrDialog[open]');
    await page.click('#startOcrBtn');
    await page.waitForFunction(() => ocrRunning === true);
    await page.click('#ocrDialog .dialog-head button.icon');
    await page.waitForSelector('#appModalDialog[open]');
    const darkModalTheme = await page.evaluate(() => {
      const dlg = document.getElementById('appModalDialog');
      const cs = getComputedStyle(dlg);
      const surface = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim();
      const probe = document.createElement('div'); probe.style.backgroundColor = surface; document.body.appendChild(probe);
      const expectedBg = getComputedStyle(probe).backgroundColor; probe.remove();
      return {
        bg: cs.backgroundColor, expectedBg, dir: cs.direction,
        msg: document.getElementById('appModalMessage').textContent,
        confirmText: document.getElementById('appModalConfirm').textContent,
        cancelText: document.getElementById('appModalCancel').textContent,
      };
    });
    assert.equal(darkModalTheme.bg, darkModalTheme.expectedBg, 'appModalDialog uses Studio dark --surface color');
    assert.equal(darkModalTheme.dir, 'rtl', 'appModalDialog renders in RTL');
    assert.ok(darkModalTheme.msg.includes('آیا مطمئن هستید'), 'cancel modal asks Persian confirmation');
    assert.ok(darkModalTheme.confirmText.includes('بله') && darkModalTheme.cancelText.includes('خیر'), 'cancel modal buttons are in Persian');

    // Switch temporarily to light theme and verify modal follows light theme palette automatically
    const lightModalTheme = await page.evaluate(() => {
      document.body.classList.add('light');
      const dlg = document.getElementById('appModalDialog');
      const bg = getComputedStyle(dlg).backgroundColor;
      const probe = document.createElement('div'); probe.style.backgroundColor = 'var(--surface)'; document.body.appendChild(probe);
      const expectedBg = getComputedStyle(probe).backgroundColor; probe.remove();
      document.body.classList.remove('light');
      return { bg, expectedBg };
    });
    assert.equal(lightModalTheme.bg, lightModalTheme.expectedBg, 'appModalDialog uses Studio light --surface color in light mode');
    assert.notEqual(lightModalTheme.bg, darkModalTheme.bg, 'light and dark modal palettes match their respective themes');

    // Declining keeps OCR running and ocrDialog open
    await page.click('#appModalCancel');
    await page.waitForFunction(() => !document.getElementById('appModalDialog').open);
    assert.equal(await page.evaluate(() => document.getElementById('ocrDialog').open && ocrRunning === true && jobBusy === true), true, 'declining cancel keeps OCR running');

    // Pressing Escape during OCR opens confirmation modal; pressing Escape again dismisses only confirmation modal
    await page.keyboard.press('Escape');
    await page.waitForSelector('#appModalDialog[open]');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('appModalDialog').open);
    assert.equal(await page.evaluate(() => document.getElementById('ocrDialog').open && ocrRunning === true && jobBusy === true), true, 'Escape on confirmation modal keeps OCR running');

    // Confirming cancel aborts OCR and closes ocrDialog
    await page.click('#ocrDialog .dialog-head button.icon');
    await page.waitForSelector('#appModalDialog[open]');
    await page.click('#appModalConfirm');
    await page.waitForFunction(() => !document.getElementById('appModalDialog').open && !document.getElementById('ocrDialog').open && ocrRunning === false && jobBusy === false);

    // 2. Translation ×, cancel button, and dock cancel button ask confirmation first
    await page.click('#translateBtn');
    await page.waitForSelector('#translationPreviewDialog[open]');
    await page.click('#translationPreviewConfirm');
    await page.waitForFunction(() => document.getElementById('translationDialog').open && translationRunning === true);
    await page.click('#translationDialog .dialog-head button.icon');
    await page.waitForSelector('#appModalDialog[open]');
    await page.click('#appModalCancel');
    await page.waitForFunction(() => !document.getElementById('appModalDialog').open && document.getElementById('translationDialog').open && translationRunning === true);
    await page.click('#cancelTranslationBtn');
    await page.waitForSelector('#appModalDialog[open]');
    await page.click('#appModalConfirm');
    await page.waitForFunction(() => !document.getElementById('appModalDialog').open && !document.getElementById('translationDialog').open && translationRunning === false && jobBusy === false);

    // 2b. Dock-level job (#exportPdfBtn with no dialog open): #dockCancelJobBtn asks confirmation first
    await page.click('#exportPdfBtn');
    await page.waitForFunction(() => exportRunning === true && jobBusy === true && !document.getElementById('dockProgressWrap').classList.contains('hidden'));
    await page.click('#dockCancelJobBtn');
    await page.waitForSelector('#appModalDialog[open]');
    await page.click('#appModalCancel');
    await page.waitForFunction(() => !document.getElementById('appModalDialog').open && exportRunning === true && jobBusy === true);
    await page.click('#dockCancelJobBtn');
    await page.waitForSelector('#appModalDialog[open]');
    await page.click('#appModalConfirm');
    await page.waitForFunction(() => !document.getElementById('appModalDialog').open && exportRunning === false && jobBusy === false);

    // 3. Stacked translationDialog over editorDialog: Escape asks confirmation, decline keeps both open, confirm closes only translationDialog
    await page.evaluate(() => openEditor(state.project.images[0].id));
    await page.waitForSelector('#editorDialog[open]');
    await page.evaluate(() => retranslateBlock(state.project.images[0].blocks[0]));
    await page.waitForSelector('#translationPreviewDialog[open]');
    await page.click('#translationPreviewConfirm');
    await page.waitForFunction(() => document.getElementById('translationDialog').open && translationRunning === true);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#appModalDialog[open]');
    await page.click('#appModalCancel');
    await page.waitForFunction(() => !document.getElementById('appModalDialog').open && document.getElementById('translationDialog').open && document.getElementById('editorDialog').open && translationRunning === true);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#appModalDialog[open]');
    await page.click('#appModalConfirm');
    await page.waitForFunction(() => !document.getElementById('appModalDialog').open && !document.getElementById('translationDialog').open && document.getElementById('editorDialog').open && translationRunning === false && jobBusy === false);
    await page.evaluate(() => closeEditor());

    await page.evaluate(() => { window.fetch = window.__origFetchV364; delete window.__origFetchV364; });
    assert.deepEqual(nativeBrowserDialogs, [], `expected zero native browser confirm/alert popups, got: ${nativeBrowserDialogs.join(' | ')}`);
    console.log('PASS: v3.65 hamburger outside-click, Persian cancel-job confirmation modal, dark/light theme parity, and zero native dialogs');

    assert.ok(browserErrors.every(error => error.includes('ترجمه') || error.includes('سرویس') || error.includes('502') || error.includes('free simulated outage') || error.includes('ocr simulated failure') || error.includes('500') || error.includes('422')), `unexpected AI failure errors: ${browserErrors.join(' | ')}`);
    console.log('PASS: downloaded ZIP and PDF pixels match the latest edit; TXT contains current text');
    console.log('PASS: every export leaves a persistent browser-download link');
  } catch (error) {
    if (serverLog) console.error(serverLog.slice(-5000));
    throw error;
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) server.kill('SIGTERM');
    await new Promise((resolve) => aiServer.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
