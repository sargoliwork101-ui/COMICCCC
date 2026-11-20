'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const base=path.resolve(__dirname,'../extension/src');
const help=new JSDOM(fs.readFileSync(path.join(base,'help/help.html'),'utf8')).window.document;
for(const id of ['collect','organize','output','ocr','web','pdf','privacy','troubleshoot'])assert.ok(help.getElementById(id),id);
assert.match(help.body.textContent,/دکمهٔ مستقلی برای فقط OCR وجود ندارد/);
assert.match(help.body.textContent,/فقط متن برای ترجمه/);
for(const file of ['viewer/viewer.html','popup/popup.html','ai-settings/settings.html','pdf-import/pdf-import.html','help/help.html']){
 const doc=new JSDOM(fs.readFileSync(path.join(base,file),'utf8')).window.document;
 const links=[...doc.querySelectorAll(file==='help/help.html'?'nav a':'a[href*="help.html"]')];
 assert.ok(links.length || fs.readFileSync(path.join(base,'shared/studio-ui.js'),'utf8').includes('studio-guide-link'),file);
 for(const a of links){
  const [rel,hash]=a.getAttribute('href').split('#');
  assert.ok(fs.existsSync(path.resolve(base,path.dirname(file),rel)),file+': '+rel);
  if(hash)assert.ok(help.getElementById(hash),hash);
 }
}
const viewer=new JSDOM(fs.readFileSync(path.join(base,'viewer/viewer.html'),'utf8')).window.document;
for(const id of ['saveProfileBtn','restoreProfileBtn','deleteProfileBtn','ocrEnabled','trContrast','btnTranslate','btnTxt','btnRetry'])assert.equal(viewer.querySelectorAll('#'+id).length,1,id+' preserved exactly once');
assert.match(viewer.querySelector('.top-menu-section').textContent,/ذخیره و بازیابی چیدمان/);
assert.ok(viewer.querySelector('.top-menu-ocr #btnTranslate'));
assert.ok(viewer.querySelector('.profile-actions #saveProfileBtn svg'));
assert.ok(viewer.querySelector('.profile-actions #restoreProfileBtn svg'));
console.log('PASS: extension guide sections/anchors are valid; menu keeps OCR, translation and profile actions');

assert.equal(viewer.querySelectorAll('.top-menu-panel .context-guide-link').length,1);
assert.equal(viewer.querySelector('.context-guide-link').getAttribute('href'),'../help/help.html#organize');
assert.equal(viewer.querySelector('.context-guide-link').textContent,'');
assert.equal(viewer.querySelector('.menu-guide-link'),null);

for(const file of ['viewer/viewer.html','popup/popup.html','ai-settings/settings.html','pdf-import/pdf-import.html']){
 const doc=new JSDOM(fs.readFileSync(path.join(base,file),'utf8')).window.document;
 for(const link of doc.querySelectorAll('a[href*="help.html"]')){
  assert.equal(link.textContent.trim(),'','no textual help control: '+file);
  assert.ok(link.querySelector('svg') && link.getAttribute('aria-label'));
 }
}
