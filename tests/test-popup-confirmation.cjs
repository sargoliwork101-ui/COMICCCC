'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
(async () => {
  for (const id of ['startBtn', 'pdfConvertBtn', 'translatePageBtn']) {
    const dom = new JSDOM(fs.readFileSync('extension/src/popup/popup.html', 'utf8'), {url:'https://extension.test',runScripts:'outside-only',pretendToBeVisual:true});
    const w = dom.window, d = w.document;
    let effects = 0;
    w.chrome = {storage:{local:{get:async()=>({})}},runtime:{getURL:p=>p,sendMessage:async()=>{effects++;return {ok:true};}},
      tabs:{query:async()=>{effects++;return [{id:1,url:'https://comic.test'}];},create:async()=>{effects++;},sendMessage:async()=>({translatedCopy:true})},
      scripting:{executeScript:async()=>{effects++;return [{result:[]}];}}};
    w.close = () => {};
    vm.runInContext(fs.readFileSync('extension/src/popup/popup.js','utf8'),dom.getInternalVMContext());
    await tick();
    const tool = d.getElementById(id), modal = d.getElementById('extModal'), cancel = d.getElementById('extModalCancel'), ok = d.getElementById('extModalOk');
    assert.ok(tool.getAttribute('aria-label'));
    assert.ok(d.getElementById(tool.getAttribute('aria-describedby')).matches('[role=tooltip]'));
    tool.focus();tool.click();await tick();
    assert.equal(effects,0,id+' must wait for approval');
    assert.ok(!modal.classList.contains('hidden'));
    assert.ok(d.getElementById('extModalMsg').textContent.includes(tool.getAttribute('aria-label')));
    assert.equal(d.activeElement,cancel,'cancel is the safe default');
    d.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',bubbles:true}));
    assert.equal(d.activeElement,ok);
    d.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true}));
    assert.equal(d.activeElement,cancel);
    tool.click(); // Rapid second click must not install another pending action.
    cancel.click();await tick();assert.equal(effects,0);
    assert.equal(d.activeElement,tool);
    tool.click();d.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await tick();
    assert.equal(effects,0,'Escape cancels');assert.ok(modal.classList.contains('hidden'));
    tool.click();modal.click();await tick();assert.equal(effects,0,'backdrop cancels');
    tool.click();ok.click();await tick();
    assert.ok(effects>0,id+' executes after approval');
    const count=effects;ok.click();await tick();assert.equal(effects,count,'no stale confirmation handlers');
    dom.window.close();
  }
  console.log('PASS: three popup tools wait for approval; cancel/Escape/backdrop/repeated clicks are safe; keyboard focus and labels work');
})().catch(error=>{console.error(error);process.exitCode=1;});
