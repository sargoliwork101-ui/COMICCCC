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
  return page.evaluate(() => {
    const item = state.project.images[0];
    const expected = Typeset.render(state.editorBitmap, overlayBlocks(item));
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
    const pixels = canvas.getContext('2d').getImageData(165, 75, 145, 45).data;
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
  const aiServer = http.createServer((request, response) => {
    aiRequests.push({ method: request.method, url: request.url, authorization: request.headers.authorization || '' });
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => {
        const data = JSON.parse(body); const text = data.messages.find(message => message.role === 'user').content;
        aiSystems.push(data.messages.find(message => message.role === 'system').content);
        aiGenerations.push(text);
        const reply = translation => JSON.stringify({choices:[{message:{content:JSON.stringify({translation,summary:'جان دوست مری است'})}}]});
        if (text.includes('HEADER SAME') && dedupFailuresRemaining > 0) { dedupFailuresRemaining -= 1; response.statusCode = 503; response.end(JSON.stringify({error:{message:'temporary failure'}})); }
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
  const server = spawn(python, ['-m', 'comic_studio', '--host', '127.0.0.1', '--port', String(port), '--no-browser'], {
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
    page.on('pageerror', (error) => browserErrors.push(String(error)));
    page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });

    await page.goto(base, { waitUntil: 'networkidle0' }); await page.waitForSelector('#grid .item img');
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
    await page.select('#aiProvider', 'free'); await page.click('#saveAiBtn');
    await page.waitForFunction(() => state.ai.provider === 'free'); await page.keyboard.press('Escape');
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
      if (url.pathname === `/api/projects/${projectId}/translate`) {
        translationRequests.push(JSON.parse(request.postData() || '{}'));
        request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(translated) }).catch(() => {});
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
    assert.equal(await page.$eval('#inlineEditor', el => el.classList.contains('hidden')), true, 'toolbar is hidden before selecting a box');
    // The focused box opens an isolated draft directly above it; no mutation until explicit Apply.
    await page.evaluate(() => { window.__inlineOriginal = JSON.parse(JSON.stringify(state.project.images[0].blocks[0])); window.__beforeInlineCanvas = document.getElementById('editorCanvas').toDataURL(); });
    await page.click('#editorBoxes .editor-box[data-id="1"] .editor-box-text', { offset: { x: 75, y: 30 } });
    await page.waitForSelector('#inlineEditor:not(.hidden)');
    const inPlace = await page.evaluate(() => {
      const box = document.querySelector('#editorBoxes .editor-box[data-id="1"]'); const field = document.getElementById('inlineEditorField'); const a = box.getBoundingClientRect(); const b = field.getBoundingClientRect(); const bar = document.getElementById('inlineEditor').getBoundingClientRect();
      return { attached: field.parentElement === box, aligned: Math.abs(a.left-b.left) < 3 && Math.abs(a.top-b.top) < 3 && Math.abs(a.width-b.width) <= 5 && Math.abs(a.height-b.height) <= 5, above: bar.bottom <= a.top + 2, single: document.querySelectorAll('#editorBoxes [contenteditable="true"]').length === 1 };
    });
    assert.deepEqual(inPlace, {attached:true, aligned:true, above:true, single:true}, 'the actual clicked box must be the sole editor, with tools immediately above it');
    assert.equal(await page.$$eval('#inlineEditor [data-line-align], #inlineEditor #inlineLineDirection, #inlineEditor #inlineLineColor', els => els.length), 0, 'duplicate line controls are removed');
    const originalViewport = page.viewport();
    await page.setViewport({ width: 600, height: 700, deviceScaleFactor: 1 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => { const b=document.querySelector('#editorBoxes .editor-box[data-id="1"]');const f=document.getElementById('inlineEditorField');const bar=document.getElementById('inlineEditor');return f.parentElement===b && bar.getBoundingClientRect().bottom <= b.getBoundingClientRect().top+2; }), true, 'on a narrow viewport tools remain above the same editable box');
    await page.setViewport(originalViewport);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const blank = await page.evaluate(() => { const r=document.getElementById('editorBoxes').getBoundingClientRect(); return {x:r.left+160*state.editorScale,y:r.top+60*state.editorScale}; });
    await page.mouse.click(blank.x, blank.y);
    assert.equal(await page.$eval('#inlineEditor', el => el.classList.contains('hidden')), true, 'clicking blank image hides the contextual tools');
    await page.evaluate(() => openInlineEditor(state.project.images[0].blocks[0]));
    await page.waitForSelector('#inlineEditor:not(.hidden)');
    const popupPosition = await page.evaluate(() => {
      const view = document.querySelector('.editor-view').getBoundingClientRect(); const panel = document.getElementById('inlineEditor').getBoundingClientRect();
      return panel.left >= view.left - 1 && panel.right <= view.right + 1 && panel.top >= view.top - 1 && panel.bottom <= view.bottom + 1;
    });
    assert.equal(popupPosition, true, 'the floating editor must stay within the visible preview');
    await page.focus('#inlineEditorField');
    await page.evaluate(() => document.execCommand('selectAll'));
    await page.keyboard.type('new inline text');
    assert.equal(await page.$eval('#inlineVerticalAlign', el => el.value), 'middle', 'legacy blocks retain the previous centred default');
    await page.select('#inlineVerticalAlign', 'bottom');
    const bottomPadding = await page.$eval('#inlineEditorField', el => parseFloat(el.style.paddingTop));
    await page.select('#inlineVerticalAlign', 'top');
    const topPadding = await page.$eval('#inlineEditorField', el => parseFloat(el.style.paddingTop));
    assert.equal(topPadding, 3, 'editable text starts at the top');
    assert.ok(bottomPadding > topPadding, 'the editable text moves when bottom is selected');
    await page.evaluate(() => {
      const field = document.getElementById('inlineEditorField'); const range = document.createRange();
      range.setStart(field.firstChild, 0); range.setEnd(field.firstChild, 3);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); field.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.click('#inlineEditor .classic-toolbar button[aria-label="پررنگ"]');
    await page.select('#inlineEditorAlign', 'justify');
    await page.$eval('#inlineEditorSize', (field) => { field.value = '24'; field.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await page.evaluate(() => state.project.images[0].blocks[0].tr === window.__inlineOriginal.tr && document.getElementById('editorCanvas').toDataURL() === window.__beforeInlineCanvas), true, 'draft text must not change the project or final preview before Apply');
    await page.click('#inlineEditorApply');
    assert.equal(await page.$eval('#inlineEditor', (panel) => panel.classList.contains('hidden')), true);
    assert.equal(await page.$$eval('#editorBoxes [contenteditable="true"], #editorBoxes [contenteditable="plaintext-only"]', els => els.length), 0, 'Apply removes the editable surface from the image box');
    assert.equal(await page.evaluate(() => {
      const block = state.project.images[0].blocks[0];
      return block.tr === 'new inline text' && /font-weight:\s*normal/i.test(block.richHtml) && block.align === 'justify' && block.verticalAlign === 'top' && block.size === 24 && document.querySelectorAll('#blockList .block-card[data-id="1"] .block-readonly')[1].textContent.includes(block.tr);
    }), true, 'Apply must update only the selected block and synchronize its sidebar');
    assert.equal(await editorRenderDifference(page), 0, 'Apply must show the final output renderer immediately in the same editor');
    assert.notEqual(await page.$eval('#editorCanvas', (canvas) => canvas.toDataURL()), await page.evaluate(() => window.__beforeInlineCanvas));
    await page.evaluate(() => saveProject());
    assert.equal(await page.evaluate(async () => (await (await fetch(`/api/projects/${state.project.id}`)).json()).images[0].blocks[0].tr), 'new inline text', 'applied edits must be saved');
    assert.equal(await page.evaluate(async () => (await (await fetch(`/api/projects/${state.project.id}`)).json()).images[0].blocks[0].verticalAlign), 'top', 'vertical placement must persist with the project');
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
    page.once('dialog', dialog => dialog.dismiss()); await page.mouse.click(blankAfterPan.x, blankAfterPan.y);
    assert.equal(await page.$eval('#inlineEditorField', field => field.textContent), 'discard this draft', 'declining discard on blank image preserves the draft');
    assert.equal(await page.$eval('#inlineEditor', el => el.classList.contains('hidden')), false);
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.evaluate(() => openInlineEditor(state.project.images[0].blocks[1]));
    assert.equal(await page.$eval('#inlineEditorField', (field) => field.textContent), 'discard this draft', 'declining the switch must retain the current draft');
    assert.ok((await page.$eval('#inlineEditorTitle', (title) => title.textContent)).includes('1'));
    page.once('dialog', (dialog) => dialog.accept());
    await page.click('#inlineEditorCancel');
    assert.equal(await page.evaluate(() => state.project.images[0].blocks[0].tr), 'new inline text', 'Cancel must not store draft text');
    await page.select('#blockList .block-card[data-id="1"] [data-text-mode]', 'ocr');
    await page.click('#editorBoxes .editor-box[data-id="1"] .editor-box-text', { offset: { x: 75, y: 30 } });
    assert.equal(await page.$eval('#inlineVerticalAlign', el => el.value), 'bottom', 'OCR uses the same placement control');
    await page.select('#inlineVerticalAlign', 'top');
    await page.focus('#inlineEditorField'); await page.evaluate(() => document.execCommand('selectAll')); await page.keyboard.type('corrected source');
    await page.click('#inlineEditorApply');
    assert.equal(await page.evaluate(() => {
      const block = state.project.images[0].blocks[0];
      return block.text === 'corrected source' && block.tr === 'new inline text' && block.align === 'justify' && block.verticalAlign === 'top';
    }), true, 'source editing must preserve translation and its existing alignment');
    await page.evaluate(() => { state.project.images[0].blocks[0] = window.__inlineOriginal; buildBlockList(); drawEditor(); const preview = document.querySelector('.editor-preview'); preview.scrollTop = 0; preview.scrollLeft = 0; });
    console.log('PASS: clicking a box opens a draft editor; Apply renders and saves while Cancel preserves the previous text');

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
    await page.click('#inlineEditor .classic-toolbar button[aria-label="نمایش ابزارهای پیشرفته"]');
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

    // Classic source/visual synchronization, sanitization, dialogs and draft recovery.
    await page.evaluate(() => openInlineEditor(state.project.images[0].blocks[0]));
    await page.click('#inlineEditor .classic-tabs button:nth-child(2)');
    assert.equal(await page.$eval('#editorBoxes .editor-box.editing .classic-source', el => el.parentElement === document.querySelector('#editorBoxes .editor-box[data-id="1"]')), true, 'Text mode also uses the clicked box');
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
    await page.click('#inlineEditor .classic-toolbar button[aria-label="نمایش ابزارهای پیشرفته"]');
    assert.equal(await page.$eval('#inlineEditor .classic-row:nth-child(2)', el => el.hidden), false);
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
    assert.equal(await page.evaluate(() => document.getElementById('inlineEditorField').parentElement === document.querySelector('#editorBoxes .editor-box[data-id="1"]') && !document.getElementById('inlineEditor').classList.contains('hidden')), true, 'Escape exits fullscreen back into the same box');
    await page.select('#inlineVerticalAlign', 'bottom');
    await page.$eval('#inlineEditorSize', el => {el.value='33';el.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForFunction(() => Object.keys(localStorage).some(key => key.startsWith('comic-studio-draft:') && JSON.parse(localStorage.getItem(key)).meta?.size === '33'), {timeout:6000});
    await page.$eval('#inlineEditorSize', el => {el.value='44';});
    await page.select('#inlineVerticalAlign', 'top');
    page.once('dialog', dialog => dialog.accept());
    assert.equal(await page.evaluate(() => { const b=inlineDraft.block; return classicEditor.setContext(`comic-studio-draft:${encodeURIComponent(state.project.id)}:${encodeURIComponent(editorItem().id)}:${encodeURIComponent(b.id)}:translation`, b.richHtml || plainToHtml(b.tr || ''), inlineBlockSnapshot(b)); }), true);
    assert.equal(await page.$$eval('#inlineEditorField table td', els => els.length), 4, 'autosaved HTML recovers in the correct context');
    assert.equal(await page.$eval('#inlineEditorSize', el => el.value), '33', 'autosave restores output settings as well as text');
    assert.equal(await page.$eval('#inlineVerticalAlign', el => el.value), 'bottom', 'autosave restores vertical alignment');
    page.once('dialog', dialog => dialog.accept());
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
    await page.$eval('#inlineEditorSize', el => { el.value='30'; });
    assert.equal(await page.$eval('#inlineEditorField', el => getComputedStyle(el).fontSize), beforeSize);
    await page.click('#inlineEditorApply');
    assert.notEqual(await page.$eval('#editorCanvas', el => el.toDataURL()), small, 'output size must affect image pixels');
    assert.equal(await editorRenderDifference(page), 0);
    await page.evaluate(() => { const block = state.project.images[0].blocks[0]; block.align='right'; block.size=null; drawEditor(); });
    console.log('PASS: one editor retains caret; typography affects output rather than editor size');

    // The exact preview uses the same renderer as Apply, without storing a draft.
    await page.evaluate(() => openInlineEditor(state.project.images[0].blocks[0]));
    await page.focus('#inlineEditorField'); await page.evaluate(() => document.execCommand('selectAll')); await page.keyboard.type('preview without saving');
    await page.select('#inlineVerticalAlign', 'bottom');
    const originalDraftBlock = await page.evaluate(() => JSON.stringify(inlineDraft.block));
    await page.click('#inlinePreview');
    const draftPixels = await page.$eval('#editorCanvas', el => el.toDataURL());
    assert.equal(await page.evaluate(() => JSON.stringify(inlineDraft.block)), originalDraftBlock, 'preview must not mutate the project');
    assert.equal(await page.$eval('#inlinePreview', el => el.getAttribute('aria-pressed')), 'true');
    assert.equal(await page.$eval('#inlineEditorField', el => getComputedStyle(el).opacity), '0');
    await page.click('#inlineEditorApply');
    assert.equal(await page.$eval('#editorCanvas', el => el.toDataURL()), draftPixels, 'draft preview must be pixel-identical to applied output');
    assert.equal(await editorRenderDifference(page), 0);
    await page.evaluate(() => openInlineEditor(state.project.images[0].blocks[0]));
    await page.focus('#inlineEditorField'); await page.evaluate(() => document.execCommand('selectAll')); await page.keyboard.type('cancel this preview');
    await page.click('#inlinePreview'); await page.click('#inlinePreview');
    assert.equal(await page.$eval('#inlineEditorField', el => el.innerText), 'cancel this preview');
    await page.click('#inlinePreview'); page.once('dialog', dialog => dialog.accept()); await page.click('#inlineEditorCancel');
    assert.equal(await page.evaluate(() => state.project.images[0].blocks[0].tr), 'preview without saving');
    assert.equal(await editorRenderDifference(page), 0, 'cancel must restore the committed canvas');
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
    await page.click('#inlineEditorApply'); assert.equal(await page.$eval('#editorCanvas', el => el.toDataURL()), htmlPreview, 'HTML source preview equals applied pixels');
    await page.evaluate(() => openInlineEditor(state.project.images[0].blocks[0]));
    await page.focus('#inlineEditorField'); await page.evaluate(() => document.execCommand('selectAll')); await page.keyboard.type('conflicting draft');
    await page.click('#inlinePreview');
    await page.evaluate(() => {inlineDraft.block.tr = 'external change';});
    await page.click('#inlineEditorApply');
    assert.equal(await page.evaluate(() => inlineDraft.block.tr), 'external change', 'preview must not bypass conflict detection');
    assert.equal(await page.$eval('#inlinePreview', el => el.getAttribute('aria-pressed')), 'true');
    page.once('dialog', dialog => dialog.accept()); await page.click('#inlineEditorCancel');
    assert.equal(await editorRenderDifference(page), 0);
    console.log('PASS: exact translation and OCR draft previews equal applied pixels; toggling and cancel preserve drafts');

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
    page.once('dialog', dialog => dialog.accept()); await page.click('#inlineEditorCancel');
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

    await page.evaluate(() => openInlineEditor(state.project.images[0].blocks[0]));
    await page.focus('#inlineEditorField'); await page.evaluate(() => document.execCommand('selectAll')); await page.keyboard.type('ویرایش تازه ۳٫۲۱');
    await page.select('#inlineVerticalAlign', 'top'); await page.click('#inlineEditorApply');
    await page.select('#blockList .block-card[data-id="2"] [data-text-mode]', 'ocr');
    await page.evaluate(() => openInlineEditor(state.project.images[0].blocks[1]));
    await page.select('#inlineVerticalAlign', 'bottom'); await page.click('#inlineEditorApply');
    assert.equal(await page.evaluate(() => state.project.images[0].blocks[0].verticalAlign === 'top' && state.project.images[0].blocks[1].verticalAlign === 'bottom'), true);
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
    const latestEdit = Buffer.from(await (await fetch(`${base}/api/projects/${projectId}/images/${imageId}/content?edited=true`)).arrayBuffer());
    const editedPath = path.join(temporary, 'latest-edited.png'); fs.writeFileSync(editedPath, latestEdit);
    const text = fs.readFileSync(files.txt, 'utf8');
    assert.ok(text.includes('ویرایش تازه ۳٫۲۱') && text.includes('SOURCE TWO') && text.includes('ترجمهٔ دوم') && text.includes('SOURCE THREE') && text.includes('ترجمهٔ سوم'));
    execFileSync(python, ['-c', `
import io, sys, zipfile
import pymupdf
from PIL import Image, ImageChops
zip_path, pdf_path, edited_path = sys.argv[1:]
with Image.open(edited_path) as opened: expected = opened.convert('RGBA')
with zipfile.ZipFile(zip_path) as archive:
    with Image.open(io.BytesIO(archive.read(archive.namelist()[0]))) as opened:
        assert ImageChops.difference(opened.convert('RGBA'), expected).getbbox() is None
with pymupdf.open(pdf_path) as document:
    info = document.extract_image(document[0].get_images(full=True)[0][0])
    with Image.open(io.BytesIO(info['image'])) as opened:
        assert ImageChops.difference(opened.convert('RGBA'), expected).getbbox() is None
`, files.zip, files.pdf, editedPath]);
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

    // Real browser and Python server: three selected pages, one AI request at a
    // time, and a failure on page two must retain page one without sending page three.
    let pageProject = await api(base, '/api/projects', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:'Page by page AI'}) });
    const threePages = new FormData();
    for (let n=1; n<=3; n++) threePages.append('files', new Blob([fs.readFileSync(source)], {type:'image/png'}), `batch-${n}.png`);
    pageProject = await api(base, `/api/projects/${pageProject.id}/files`, {method:'POST',body:threePages});
    for (const [index, image] of pageProject.images.entries()) image.blocks = [{id:1,text:`BROWSER PAGE ${['ONE','TWO','THREE'][index]}`,tr:'old',richHtml:'',enabled:true,bg:'white',x0:5,y0:5,x1:200,y1:45,lineH:40,dir:'rtl',align:'right'}];
    pageProject.images[0].blocks[0].text += ' ' + 'a'.repeat(130);
    pageProject.images[0].blocks.push({...pageProject.images[0].blocks[0], id:2, text:'BROWSER EXTRA ' + 'b'.repeat(130), y0:70, y1:110});
    await api(base, `/api/projects/${pageProject.id}/state`, {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:pageProject})});
    await api(base, '/api/ai-settings', {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'openai',base_url:aiBase,model:'local-browser-model'})});
    await page.evaluate(async id => { await loadAiSettings(); await refreshProjectList(); const select=document.getElementById('projectSelect'); select.value=id; select.dispatchEvent(new Event('change',{bubbles:true})); }, pageProject.id);
    await page.waitForFunction(id => state.project.id === id, {}, pageProject.id);
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
    await page.evaluate(() => [...document.querySelectorAll('#blockList .block-card button')].find(el => el.textContent === 'ترجمهٔ دوباره').click());
    await page.waitForSelector('#translationPreviewDialog[open]');
    assert.equal(await page.$eval('#translationSkill', el=>el.value), 'لحن داستان رسمی و نام‌ها ثابت باشد');
    await page.$eval('#translationSkill', el=>{el.value='لحن صمیمی در بازترجمه';el.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.click('#translationPreviewConfirm');
    await page.waitForFunction(()=>document.getElementById('translationPreviewSystem').textContent.includes('لحن صمیمی در بازترجمه'));
    const singleSystem = await page.$eval('#translationPreviewSystem', el=>el.textContent);
    const beforeSingle = aiGenerations.length;
    await page.click('#translationPreviewConfirm'); await page.waitForFunction(()=>!document.getElementById('translationPreviewDialog').open);
    const singleStart = Date.now(); while (aiGenerations.length === beforeSingle && Date.now() - singleStart < 5000) await sleep(30);
    assert.equal(aiGenerations.length, beforeSingle + 1); assert.equal(aiSystems.at(-1), singleSystem);
    await page.waitForFunction(()=>!document.querySelector('#translationPreviewConfirm').disabled);
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
    assert.equal(await page.$eval('#translationContext', el => el.value), 'جان دوست مری است');
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
    await page.evaluate(() => {
      const item=state.project.images[0], block=item.blocks[0];
      const key=`comic-studio-draft:${encodeURIComponent(state.project.id)}:${encodeURIComponent(item.id)}:${encodeURIComponent(block.id)}:translation`;
      localStorage.setItem(key, JSON.stringify({html:'<p>portable draft</p>',base:inlineBlockSnapshot(block),time:'test',meta:null}));
    });
    await page.click('#menuBtn'); const backupDownload = nextDownload(cdp, downloads); await page.click('#backupProjectBtn');
    const backupPath = await backupDownload; assert.ok(backupPath.endsWith('.zip') && fs.statSync(backupPath).size > 0);
    await page.waitForFunction(() => !document.getElementById('backupDownloadLink').classList.contains('hidden'));
    assert.equal(await page.$eval('#backupDownloadLink', el => el.download.endsWith('-backup.zip')), true);
    page.once('dialog', dialog => dialog.accept());
    await page.$eval('#restoreProjectInput', el => el.value = '');
    const fileInput = await page.$('#restoreProjectInput'); await fileInput.uploadFile(backupPath);
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
    assert.ok(browserErrors.every(error => error.includes('ترجمه') || error.includes('سرویس') || error.includes('502')), `unexpected AI failure errors: ${browserErrors.join(' | ')}`);
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
