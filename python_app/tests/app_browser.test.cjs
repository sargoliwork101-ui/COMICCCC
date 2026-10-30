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
  const aiRequests = [];
  const aiServer = http.createServer((request, response) => {
    aiRequests.push({ method: request.method, url: request.url, authorization: request.headers.authorization || '' });
    response.setHeader('Content-Type', 'application/json');
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
    await page.click('.ai-profile-test');
    await page.waitForFunction(() => document.getElementById('aiStatus').textContent.includes('local-browser-model'), { timeout: 10000 }).catch(async (error) => {
      console.error('AI dialog diagnostic:', await page.evaluate(() => ({ status: document.getElementById('aiStatus').textContent, provider: document.getElementById('aiProvider').value, model: document.getElementById('aiModel').value, baseUrl: document.getElementById('aiBaseUrl').value, rowStatus: document.querySelector('.ai-profile-status')?.textContent })), aiRequests);
      throw error;
    });
    assert.equal(aiRequests.length, 1, 'the row test must make one model-list request and no generation request');
    assert.deepEqual(aiRequests[0], { method: 'GET', url: '/v1/models', authorization: 'Bearer browser-local-secret' });
    const browserAiSettings = await api(base, '/api/ai-settings');
    assert.equal(browserAiSettings.provider, 'openai');
    assert.equal(browserAiSettings.model, 'local-browser-model');
    assert.equal(browserAiSettings.providers.openai.profiles[0].hasApiKey, true);
    assert.ok(!JSON.stringify(browserAiSettings).includes('browser-local-secret'), 'public settings must not return the browser-entered secret');
    assert.equal(await page.$eval('.ai-profile-key', (input) => input.value), '', 'the saved secret must be cleared from the real password field');
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
    assert.ok(await page.$eval('#translationPreviewRequests', (element) => element.textContent.includes('SOURCE ONE') && element.textContent.includes('␞') && element.textContent.includes('SOURCE TWO')));
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
    await page.waitForSelector('#editorDialog[open] #blockList .block-card[data-id="1"] [contenteditable="true"]');
    await page.evaluate(() => {
      const field = document.querySelector('#blockList .block-card[data-id="1"] [contenteditable="true"]');
      field.focus(); document.execCommand('selectAll'); document.execCommand('insertText', false, 'ویرایش تازه ۳٫۲۱');
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await editorRenderDifference(page), 0, 'typing must refresh the same final renderer without rebuilding the editor field');
    await page.select('#blockList .block-card[data-id="2"] [data-text-mode]', 'ocr');
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

    await page.click('#editorSelectNone');
    const overlapDrag = await page.evaluate(() => {
      const blocks = state.project.images[0].blocks; const source = boxOf(blocks[1]); const target = boxOf(blocks[0]);
      const rect = document.querySelector('#editorBoxes .editor-box[data-id="2"] .box-move').getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, dx: (target.x0 - source.x0) * state.editorScale, dy: (target.y0 - source.y0) * state.editorScale };
    });
    await page.mouse.move(overlapDrag.x, overlapDrag.y); await page.mouse.down();
    await page.mouse.move(overlapDrag.x + overlapDrag.dx, overlapDrag.y + overlapDrag.dy, { steps: 12 }); await page.mouse.up();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => {
      const blocks = state.project.images[0].blocks; const first = boxOf(blocks[0]); const second = boxOf(blocks[1]);
      return Math.abs(first.x0 - second.x0) < 1 && Math.abs(first.y0 - second.y0) < 1;
    }), true, 'the real drag must overlap the first two boxes for the preview regression');
    assert.equal(await editorRenderDifference(page), 0, 'editor canvas must be pixel-identical to the final renderer even with overlapping boxes');
    console.log('PASS: editor canvas matches final rendering with overlapping boxes');
    await page.mouse.move(overlapDrag.x + overlapDrag.dx, overlapDrag.y + overlapDrag.dy); await page.mouse.down();
    await page.mouse.move(overlapDrag.x, overlapDrag.y, { steps: 12 }); await page.mouse.up();
    await page.click('#blockList .block-card[data-id="2"] [data-visibility]');
    assert.equal(await page.evaluate(() => state.project.images[0].blocks.map((block) => block.enabled).join(',')), 'true,false,true');
    await page.click('#blockList .block-card[data-id="2"] [data-visibility]');
    assert.equal(await page.evaluate(() => state.project.images[0].blocks.map((block) => block.enabled).join(',')), 'true,true,true');
    let uploaded = page.waitForResponse((response) => response.url().endsWith('/rendered') && response.request().method() === 'POST');
    await page.click('#editorApply'); await uploaded;
    uploaded = page.waitForResponse((response) => response.url().endsWith('/rendered') && response.request().method() === 'POST');
    await page.click('#editorClose'); await uploaded;
    await page.waitForFunction(() => !document.getElementById('editorDialog').open && !state.editorId);
    assert.equal(await previewDifference(page), 0, 'main preview must contain the latest rich-text edit and mixed language choices');
    assert.equal(await page.evaluate(() => state.project.images[0].blocks[1].textMode), 'ocr');
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
    assert.deepEqual(browserErrors, [], 'the real render/export path must not produce browser errors');
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
