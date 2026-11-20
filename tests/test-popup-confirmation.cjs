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
    assert.ok(d.getElementById('collectionView').classList.contains('hidden'));
    assert.ok(!d.querySelector('.brand p'), 'obsolete subtitle removed');
    const activate = () => {
      tool.click();
      if (id === 'startBtn') {
        assert.equal(effects,0,'opening collection settings must not query/inject');
        assert.ok(modal.classList.contains('hidden'),'start opens settings, not confirmation');
        d.querySelector('[data-mode=scroll]').click();
        d.getElementById('collectionReview').focus();
        d.getElementById('collectionReview').click();
      }
    };
    if (id === 'startBtn') {
      tool.click();
      assert.ok(d.getElementById('collectionReview').disabled);
      assert.ok(d.getElementById('collectionOptions').classList.contains('hidden'));
      d.querySelector('[data-mode=scroll]').click();
      d.getElementById('deepSearch').checked = true;
      d.getElementById('collectionReview').click();
      assert.ok(d.getElementById('extModalMsg').textContent.includes('جستجوی عمیق: روشن'));
      cancel.click();await tick();
      for (const mode of ['auto','manual']) {
        d.querySelector('[data-mode='+mode+']').click();
        d.getElementById('pageLimit').value = '12';
        assert.ok(!d.getElementById('scrollModeFields').classList.contains('hidden'));
        assert.ok(!d.getElementById('pagedModeFields').classList.contains('hidden'));
        d.getElementById('collectionReview').click();
        assert.ok(d.getElementById('extModalMsg').textContent.includes('جستجوی عمیق: روشن'));
        assert.ok(d.getElementById('extModalMsg').textContent.includes('حداکثر صفحات: 12'));
        cancel.click();await tick();
      }
      d.getElementById('collectionBack').click();
      assert.ok(d.getElementById('collectionView').classList.contains('hidden'));
      assert.ok(!d.getElementById('homeView').classList.contains('hidden'));
      assert.equal(effects,0,'all method settings and cancellations must have zero execution side effects');
    }
    tool.focus();activate();await tick();
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
    assert.equal(d.activeElement,id === 'startBtn' ? d.getElementById('collectionReview') : tool);
    activate();d.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await tick();
    assert.equal(effects,0,'Escape cancels');assert.ok(modal.classList.contains('hidden'));
    activate();modal.click();await tick();assert.equal(effects,0,'backdrop cancels');
    activate();ok.click();await tick();
    assert.ok(effects>0,id+' executes after approval');
    const count=effects;ok.click();await tick();assert.equal(effects,count,'no stale confirmation handlers');
    dom.window.close();
  }
  // Verify that the popup forwards the common option to the real injected function.
  for (const mode of ['scroll','auto','manual']) {
    for (const deep of [false,true]) {
      const dom = new JSDOM(fs.readFileSync('extension/src/popup/popup.html','utf8'), {url:'https://extension.test',runScripts:'outside-only'});
      const w=dom.window,d=w.document,calls=[];
      w.close=()=>{};
      w.chrome={storage:{local:{get:async()=>({})}},tabs:{query:async()=>[{id:1}]},scripting:{executeScript:async opts=>{
        calls.push(opts);
        return opts.func.name==='probeBookFrame' ? [{frameId:0,result:{isReader:false}}] : [{result:{count:1}}];
      }}};
      vm.runInContext(fs.readFileSync('extension/src/popup/popup.js','utf8'),dom.getInternalVMContext());
      d.getElementById('startBtn').click();
      d.querySelector('[data-mode='+mode+']').click();
      d.documentElement.dataset.theme='light';
      d.getElementById('deepSearch').checked=deep;
      d.getElementById('collectionReview').click();
      assert.equal(calls.length,0);
      assert.ok(d.getElementById('extModalMsg').textContent.includes('جستجوی عمیق: '+(deep?'روشن':'خاموش')));
      d.getElementById('extModalOk').click();await tick();
      const injected=calls.find(call=>call.func.name==='scrapeAndSend');
      assert.ok(injected,mode);
      assert.equal(injected.args[1],mode);
      assert.equal(injected.args[2].deepSearch,deep,mode+' forwards deep search');
      assert.equal(injected.args[2].uiTheme,'light',mode+' forwards the current Focus theme');
      dom.window.close();
    }
  }
  console.log('PASS: three popup tools wait for approval; cancel/Escape/backdrop/repeated clicks are safe; keyboard focus and labels work');
})().catch(error=>{console.error(error);process.exitCode=1;});
