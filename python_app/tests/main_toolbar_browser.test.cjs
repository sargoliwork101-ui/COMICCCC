'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
(async () => {
  const root = path.resolve(__dirname, '../comic_studio/static');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const topbar = html.match(/<header class="topbar">[\s\S]*?<\/header>/)[0];
  const toolbar = html.match(/<section class="panel main-toolbar-panel">[\s\S]*?<\/section>/)[0];
  const dock = html.match(/<footer id="dock">[\s\S]*?<\/footer>/)[0];
  const initializer = app.match(/function initStickyMainToolbar\([^]*?\n}/)[0];
  const module = await import('@sparticuz/chromium');
  const chromium = module.default;
  const location = path.resolve(path.dirname(require.resolve('@sparticuz/chromium')), '..');
  await module.inflate(path.join(location, 'bin/al2023.tar.br'));
  module.setupLambdaEnvironment('/tmp/al2023/lib');
  const args = chromium.args.filter(arg => arg !== '--single-process' && !arg.startsWith('--headless') && !arg.startsWith('--use-gl') && !arg.startsWith('--use-angle') && arg !== '--enable-unsafe-swiftshader' && arg !== '--in-process-gpu');
  const browser = await puppeteer.launch({args: [...args, '--disable-gpu'], executablePath: await chromium.executablePath(), headless: 'new'});

  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html dir="rtl"><head><style>' + css + '</style></head><body>' + topbar
      + '<main id="mainwrap">' + toolbar + '<div class="grid" style="height:6000px">pages</div></main>' + dock + '</body></html>');
    await page.evaluate(code => { window.eval(code); initStickyMainToolbar(); }, initializer);
    for (const width of [1440, 1024, 768, 420, 320]) {
      await page.setViewport({ width, height: 1000 });
      for (const theme of ['', 'light']) {
        await page.evaluate(theme => { document.body.className = theme; window.scrollTo(0, 0); }, theme);
        await page.waitForFunction(() => Math.abs(parseFloat(document.documentElement.style.getPropertyValue('--studio-topbar-height')) - document.querySelector('.topbar').getBoundingClientRect().height) < 1);
        for (const y of [600, 2600, 5000]) {
          await page.evaluate(y => window.scrollTo(0, y), y);
          await new Promise(resolve => setTimeout(resolve, 220));
          await page.waitForFunction(() => Math.abs(parseFloat(document.documentElement.style.getPropertyValue('--studio-topbar-height')) - document.querySelector('.topbar').getBoundingClientRect().height) < 1);
          const result = await page.evaluate(() => {
            const panel = document.querySelector('.main-toolbar-panel');
            const r = panel.getBoundingClientRect();
            const header = document.querySelector('.topbar').getBoundingClientRect();
            const dock = document.getElementById('dock').getBoundingClientRect();
            return { top: r.top, headerBottom: header.bottom, bottom: r.bottom, dockTop: dock.top,
              horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
              buttons: [...panel.querySelectorAll('button')].map(b => {
                const br = b.getBoundingClientRect();
                const hit = document.elementFromPoint(br.x + br.width / 2, br.y + br.height / 2);
                return { id: b.id, inside: br.top >= header.bottom - 1 && br.bottom <= dock.top + 1, hit: hit === b || b.contains(hit) };
              }) };
          });
          assert.ok(Math.abs(result.top - result.headerBottom) <= 1, JSON.stringify({ width, y, result }));
          assert.ok(!result.horizontalOverflow && result.bottom <= result.dockTop, JSON.stringify({ width, y, result }));
          assert.ok(result.buttons.every(b => b.inside && b.hit), JSON.stringify({ width, y, result }));
        }
      }
    }
    // ResizeObserver must react without a viewport resize (e.g. license badge/font changes).
    await page.evaluate(() => { document.querySelector('.topbar').style.paddingBottom = '65px'; });
    await page.waitForFunction(() => Math.abs(parseFloat(document.documentElement.style.getPropertyValue('--studio-topbar-height')) - document.querySelector('.topbar').getBoundingClientRect().height) < 1);
    console.log('PASS: all toolbar buttons stay below header and above dock, visible and hit-testable while scrolling at 320–1440px in both themes; dynamic header height tracked');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
