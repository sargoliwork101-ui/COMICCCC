'use strict';
// Real Chromium regression: native lazy loading must not retain every visited
// full-resolution page. Does not mock image decoding or the production grid.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const puppeteer = require('puppeteer-core');
const pythonApp = path.resolve(__dirname, '..');
const python = process.env.COMIC_STUDIO_PYTHON || path.join(pythonApp, '.venv', 'bin', 'python');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hasaya-grid-memory-'));
  let server, browser;
  try {
    const socket = net.createServer();
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    const bootstrap = `
from pathlib import Path
from comic_studio import _public_key, license_guard
seed, pub = license_guard.ed25519_generate_keypair()
_public_key.PUBLIC_VERIFY_KEY_HEX = pub.hex()
license_guard._LICENSE_DIR_OVERRIDE = Path(${JSON.stringify(path.join(temporary, 'license'))})
license_guard._SECONDARY_ANCHOR_OVERRIDE = Path(${JSON.stringify(path.join(temporary, 'anchor'))})
license_guard.SECURITY_GATE.activate_token(license_guard.issue_license_token(
    private_seed_hex=seed.hex(), hardware_id=license_guard.compute_hardware_id(),
    holder='Browser memory regression', plan='lifetime'))
import uvicorn
from comic_studio.main import create_app
uvicorn.run(create_app(), host='127.0.0.1', port=${port}, log_level='error')
`;
    server = spawn(python, ['-c', bootstrap], { cwd: pythonApp,
      env: { ...process.env, COMIC_STUDIO_DATA: path.join(temporary, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    server.stderr.on('data', chunk => { log = (log + chunk).slice(-4000); });
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (server.exitCode !== null) throw new Error(`Server stopped: ${log}`);
      try { if ((await fetch(base + '/api/health')).ok) { ready = true; break; } } catch { /* starting */ }
      await sleep(100);
    }
    assert.ok(ready, log);
    const api = async (route, options) => {
      const response = await fetch(base + route, options);
      assert.ok(response.ok, await response.clone().text());
      return response.json();
    };
    const source = path.join(temporary, 'page.png');
    execFileSync(python, ['-c', `from PIL import Image, ImageDraw; im=Image.new('RGB',(1600,2200),'white'); ImageDraw.Draw(im).text((100,100),'Full-resolution memory regression',fill='black'); im.save(${JSON.stringify(source)}); im.close()`]);
    let project = await api('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '36 full-resolution pages' }) });
    const form = new FormData();
    for (let i = 0; i < 36; i++) form.append('files', new Blob([fs.readFileSync(source)], { type: 'image/png' }), `page-${i}.png`);
    project = await api(`/api/projects/${project.id}/files`, { method: 'POST', body: form });
    assert.equal(project.images.length, 36);
    const chromiumModule = await import('@sparticuz/chromium');
    const chromium = chromiumModule.default;
    const chromiumRoot = path.resolve(path.dirname(require.resolve('@sparticuz/chromium')), '..');
    await chromiumModule.inflate(path.join(chromiumRoot, 'bin', 'al2023.tar.br'));
    chromiumModule.setupLambdaEnvironment('/tmp/al2023/lib');
    const args = chromium.args.filter(arg => arg !== '--single-process' && !arg.startsWith('--headless') && !arg.startsWith('--use-gl') && !arg.startsWith('--use-angle') && arg !== '--enable-unsafe-swiftshader' && arg !== '--in-process-gpu');
    args.push('--disable-gpu');
    browser = await puppeteer.launch({ args, executablePath: await chromium.executablePath(), headless: 'new', defaultViewport: { width: 1280, height: 800 } });
    const page = await browser.newPage();
    await page.goto(base, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.querySelectorAll('#grid .tw > img').length === 36);
    // Visit every card, allowing actual decode to finish, not just network load.
    for (let index = 0; index < 36; index++) {
      await page.evaluate(i => document.querySelectorAll('#grid .tw > img')[i].scrollIntoView({ block: 'center' }), index);
      await page.waitForFunction(i => {
        const image = document.querySelectorAll('#grid .tw > img')[i];
        return image.hasAttribute('src') && image.complete && image.naturalWidth === 1600;
      }, {}, index);
    }
    await sleep(500);
    const metrics = await page.evaluate(() => {
      const images = [...document.querySelectorAll('#grid .tw > img')];
      return {
        pagesVisited: images.length,
        attachedFullResolutionImages: images.filter(image => image.hasAttribute('src')).length,
        estimatedAttachedDecodedMiB: images.filter(image => image.hasAttribute('src')).reduce((n, image) => n + image.naturalWidth * image.naturalHeight * 4, 0) / 2 ** 20,
        firstPageReleased: !images[0].hasAttribute('src'),
      };
    });
    console.log('MEMORY GRID:', JSON.stringify(metrics));
    if (process.env.COMIC_STUDIO_MEMORY_REPORT) fs.writeFileSync(process.env.COMIC_STUDIO_MEMORY_REPORT, JSON.stringify(metrics, null, 2));
    assert.ok(metrics.firstPageReleased, 'previously visited pages must detach their pixel source offscreen');
    assert.ok(metrics.attachedFullResolutionImages < 18, 'retained image sources must be viewport-bounded, not page-count-bounded');
    await page.evaluate(() => document.querySelector('#grid .tw > img').scrollIntoView({ block: 'center' }));
    await page.waitForFunction(() => {
      const first = document.querySelector('#grid .tw > img');
      return first.complete && first.naturalWidth === 1600 && first.naturalHeight === 2200;
    });
    const selected = await page.evaluate(() => state.project.images[0].selected);
    await page.click('#grid .tw > img');
    assert.notEqual(await page.evaluate(() => state.project.images[0].selected), selected, 'unloading/reloading must preserve click-to-select');
    console.log('PASS: 36-page real grid releases offscreen sources, reloads full-resolution originals, and preserves selection');
  } finally {
    if (browser) await browser.close();
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await Promise.race([new Promise(resolve => server.once('exit', resolve)), sleep(4000)]);
      if (server.exitCode === null) server.kill('SIGKILL');
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
