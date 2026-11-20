'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '../extension');

(async () => {
  for (const page of ['popup/popup.html', 'viewer/viewer.html', 'ai-settings/settings.html', 'pdf-import/pdf-import.html']) {
    const html = fs.readFileSync(path.join(root, 'src', page), 'utf8');
    const dom = new JSDOM(html, {url:'https://extension.test/src/' + page, runScripts:'outside-only'});
    const { window } = dom;
    const writes = [];
    let change;
    window.chrome = {storage:{local:{get:async()=>({hasaya_ui_theme:'light'}),set:async v=>writes.push(v)},onChanged:{addListener:fn=>{change=fn;}}}};
    vm.runInContext(fs.readFileSync(path.join(root, 'src/shared/studio-ui.js'), 'utf8'), dom.getInternalVMContext());
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(window.document.documentElement.dataset.theme,'light');
    const toggle = window.document.getElementById('studioThemeToggle');
    assert.ok(toggle.getAttribute('aria-label').includes('تیره'));
    toggle.click();
    assert.equal(window.document.documentElement.dataset.theme,'dark');
    assert.equal(writes.at(-1).hasaya_ui_theme,'dark');
    change({hasaya_ui_theme:{newValue:'light'}},'local');
    assert.equal(window.document.documentElement.dataset.theme,'light');
    assert.ok(window.document.querySelector('link[href="../shared/studio-ui.css"]'));
    dom.window.close();
  }
  const popup = new JSDOM(fs.readFileSync(path.join(root, 'src/popup/popup.html'),'utf8')).window.document;
  assert.equal(popup.querySelectorAll('.studio-section[aria-labelledby]').length,2);
  assert.ok(popup.querySelector('#translatePageBtn svg'));
  assert.equal(popup.querySelector('#pdfName').value, 'HASAYA STUDIO');
  assert.ok(!popup.body.textContent.includes('کیفیت اصلی و حریم خصوصی OCR'));
  assert.ok(fs.readFileSync(path.join(root, 'src/popup/popup.js'), 'utf8').includes("document.getElementById('pdfName').value.trim() || 'HASAYA STUDIO'"));
  const viewer = new JSDOM(fs.readFileSync(path.join(root,'src/viewer/viewer.html'),'utf8')).window.document;
  assert.equal(viewer.querySelectorAll('.toolbar-actions .studio-action-group[role=group]').length,3);
  assert.ok(viewer.querySelector('#btnGroupPage svg'));
  assert.ok(popup.querySelector('#pdfConvertBtn svg'));
  assert.ok(viewer.querySelector('.toolbar-actions #btnImportPdf svg'));
  for (const id of ['modePdf','modeImg','btnRetry','edClose','cropApply','extModalOk']) assert.ok(viewer.querySelector('#'+id+' svg'),id);
  assert.notEqual(viewer.querySelector('#btnAll svg').innerHTML,viewer.querySelector('#btnNone svg').innerHTML);
  const css = fs.readFileSync(path.join(root,'src/shared/studio-ui.css'),'utf8');
  assert.ok(css.includes('--bg:#0b0d12') && css.includes('--bg:#f3f4f8'));
  assert.ok(css.includes('prefers-reduced-transparency') && css.includes('focus-visible'));
  // Same packaged font as Studio, not just the same family label.
  assert.ok(fs.readFileSync(path.join(root,'assets/fonts/Vazirmatn.woff2')).equals(
    fs.readFileSync(path.join(__dirname,'../python_app/comic_studio/static/assets/Vazirmatn.woff2'))));

  // Verify OCR's execution boundary and packaged worker/model URLs without
  // calling a translation API or substituting a fake network response for OCR.
  const calls = [];
  const context = vm.createContext({chrome:{runtime:{getURL:value=>'chrome-extension://test/'+value}},
    Tesseract:{createWorker:async(...args)=>{calls.push(args);return {setParameters:async()=>{}};}}});
  vm.runInContext(fs.readFileSync(path.join(root,'src/core/ocr.js'),'utf8'),context);
  await context.OcrTools.createOcrWorker('eng');
  const config = calls[0][2];
  for (const key of ['workerPath','corePath','langPath']) assert.ok(config[key].startsWith('chrome-extension://test/vendor/ocr/'));
  assert.ok(fs.existsSync(path.join(root,'vendor/ocr/lang/eng.traineddata.gz')));
  console.log('PASS: extension theme, grouped tools, line icons, packaged Studio font, and local OCR configuration');
})().catch(error=>{console.error(error);process.exitCode=1;});
