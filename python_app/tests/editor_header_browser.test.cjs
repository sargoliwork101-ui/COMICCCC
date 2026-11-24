'use strict';
// Real Chromium layout regression using the shipped editor markup/CSS and title updater.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
(async () => {
  const root = path.resolve(__dirname, '../comic_studio/static');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const header = html.match(/<dialog id="editorDialog"[\s\S]*?(?=\s*<div id="editorProgressWrap")/)[0];
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const updater = app.match(/function syncEditorApprovalHeader\([^]*?\n}/)[0];
  const module = await import('@sparticuz/chromium');
  const chromium = module.default;
  const location = path.resolve(path.dirname(require.resolve('@sparticuz/chromium')), '..');
  await module.inflate(path.join(location, 'bin/al2023.tar.br'));
  module.setupLambdaEnvironment('/tmp/al2023/lib');
  const args = chromium.args.filter(arg => arg !== '--single-process' && !arg.startsWith('--headless') && !arg.startsWith('--use-gl') && !arg.startsWith('--use-angle') && arg !== '--enable-unsafe-swiftshader' && arg !== '--in-process-gpu');
  const browser = await puppeteer.launch({args: [...args, '--disable-gpu'], executablePath: await chromium.executablePath(), headless: 'new'});
  try {
    const page = await browser.newPage();
    await page.setContent('<html dir="rtl"><head><style>' + css + '</style></head><body>' + header + '</dialog></body></html>');
    await page.evaluate(code => {
      window.$ = id => document.getElementById(id);
      window.eval(code);
      document.getElementById('editorDialog').showModal();
    }, updater);
    for (const width of [1568, 1024, 800, 420, 320]) {
      await page.setViewport({width, height: 900});
      for (const theme of ['', 'light']) {
        for (const name of ['کتاب کوتاه', 'Switch-mode power supplies SPICE simulations (Christophe P. Basso) ' .repeat(12), 'کتاب_' + 'A'.repeat(1000)]) {
          const result = await page.evaluate(({name, theme}) => {
            document.body.className = theme;
            syncEditorApprovalHeader({name, approved: true});
            const title = $('editorTitle');
            const head = title.parentElement;
            const hr = head.getBoundingClientRect();
            const tr = title.getBoundingClientRect();
            const actions = head.querySelector('.editor-head-actions').getBoundingClientRect();
            const visibleButtons = [...head.querySelectorAll('button')].filter(b => getComputedStyle(b).display !== 'none');
            return {
              tooltip: title.title, text: title.textContent,
              overflow: head.scrollWidth > head.clientWidth + 1,
              overlap: tr.left < actions.right - 1 && tr.right > actions.left + 1 && tr.top < actions.bottom - 1 && tr.bottom > actions.top + 1,
              buttonsContained: visibleButtons.every(b => { const r = b.getBoundingClientRect(); return r.left >= hr.left - 1 && r.right <= hr.right + 1 && r.top >= hr.top - 1 && r.bottom <= hr.bottom + 1; }),
              titleWidth: tr.width
            };
          }, {name, theme});
          assert.equal(result.tooltip, result.text);
          assert.ok(result.text.includes(name));
          assert.ok(!result.overflow && !result.overlap && result.buttonsContained, JSON.stringify({width, theme, result}));
          assert.ok(result.titleWidth > 0, JSON.stringify({width, theme, result}));
        }
      }
    }
    console.log('PASS: editor header, long/mixed/unbroken names, full title tooltip, no action overlap/overflow at 320–1568px in both themes');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
