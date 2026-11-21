'use strict';
// Review-only prototype checks; no production extension code is loaded.
const assert = require('node:assert/strict');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
(async () => {
  const module = await import('@sparticuz/chromium');
  const chromium = module.default;
  const location = path.resolve(path.dirname(require.resolve('@sparticuz/chromium')), '..');
  await module.inflate(path.join(location, 'bin/al2023.tar.br'));
  module.setupLambdaEnvironment('/tmp/al2023/lib');
  const args = chromium.args.filter(arg => arg !== '--single-process' && !arg.startsWith('--headless'));
  const browser = await puppeteer.launch({args, executablePath:await chromium.executablePath(), headless:true});
  try {
    const page = await browser.newPage();
    const external = [];
    const errors = [];
    page.on('request', r => { if (/^https?:/.test(r.url())) external.push(r.url()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewport({width:1280,height:950});
    await page.goto('file://' + path.join(__dirname, 'index.html'));
    await page.evaluate(() => document.fonts.ready);
    const visible = selector => page.$eval(selector, el => el.getBoundingClientRect().height > 0);
    for (const light of [false, true]) {
      await page.reload();
      await page.evaluate(v => document.getElementById('popup').classList.toggle('light', v), light);
      await page.click('[data-screen="home"]');
      assert.equal(await visible('#collectView'), false);
      assert.equal(await visible('#deepRow'), false);
      assert.equal(await visible('.modes'), false);
      assert.ok(await page.$eval('#popup', el => el.getBoundingClientRect().height < 600));
      for (const action of ['تبدیل PDF به تصویر', 'ترجمهٔ همین صفحه']) {
        await page.click('#homeView [data-action="' + action + '"]');
        assert.equal(await visible('#overlay'), true);
        assert.equal(await visible('#collectView'), false);
        assert.equal(await visible('#summaryBox'), false);
        assert.ok((await page.$eval('#dialogMessage', el => el.textContent)).includes(action));
        await page.keyboard.press('Escape');
        assert.equal(await visible('#overlay'), false);
      }
      await page.click('#openCollection');
      assert.equal(await visible('#collectView'), true);
      assert.equal(await page.$eval('#reviewCollection', el => el.disabled), true);
      for (const mode of ['scroll','auto','manual']) {
        await page.click('[data-mode="' + mode + '"]');
        assert.equal(await visible('#deepRow'), mode === 'scroll');
        assert.equal(await visible('#limitRow'), mode !== 'scroll');
        assert.equal(await visible('#advanced'), mode !== 'scroll');
        await page.click('#reviewCollection');
        assert.equal(await visible('#overlay'), true);
        const summary = await page.$eval('#summaryBox', el => el.textContent);
        assert.equal(summary.includes('جستجوی عمیق'), mode === 'scroll');
        assert.equal(summary.includes('حداکثر صفحات'), mode !== 'scroll');
        assert.equal(await page.$eval('#cancel', el => document.activeElement === el), true);
        await page.click('#cancel');
        assert.equal(await visible('#collectView'), true);
      }
      // A saved scroll-only switch must never leak into a paged confirmation.
      await page.click('[data-mode="scroll"]');
      await page.click('#deepSwitch');
      await page.click('[data-mode="auto"]');
      await page.click('#reviewCollection');
      assert.ok(!(await page.$eval('#summaryBox', el => el.textContent)).includes('جستجوی عمیق'));
      await page.click('#confirm');
      assert.equal(await visible('#viewerView'), true);
      for (const screen of ['home','viewer','pdf','settings']) {
        await page.click('[data-screen="' + screen + '"]');
        const palette = await page.$eval('#popup', el => getComputedStyle(el).getPropertyValue('--accent').trim());
        assert.equal(palette, light ? '#15817b' : '#6bd7ce');
        if (screen !== 'home') assert.equal(await visible('#deepRow'), false);
      }
      await page.click('[data-screen="pdf"]');
      assert.equal(await page.$eval('#convertDemoPdf', el => el.disabled), true);
      await page.click('#selectDemoPdf');
      assert.equal(await page.$eval('#convertDemoPdf', el => el.disabled), false);
      // Return the sample to its initial state for the other theme.
      await page.evaluate(() => { document.getElementById('convertDemoPdf').disabled = true; });
    }
    await page.setViewport({width:390,height:844});
    for (const screen of ['home','viewer','pdf','settings']) {
      await page.click('[data-screen="' + screen + '"]');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), screen);
    }
    await page.click('[data-screen="home"]');
    await page.click('#openCollection');
    await page.click('[data-mode="scroll"]');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    console.log('PASS: Focus v2 home/contextual workflow, all modes, confirmation/cancel, shared palettes on four screens, mobile layout and no external requests');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
