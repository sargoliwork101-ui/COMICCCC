'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
(async()=>{
 const dom=new JSDOM('<div id="row"><input id="key" type="password"></div>',{runScripts:'outside-only'});
 const w=dom.window, row=w.document.getElementById('row'),key=w.document.getElementById('key');
 w.AbortController=AbortController;
 w.eval(fs.readFileSync('extension/src/ai-settings/avalai-credit.js','utf8'));
 w.AvalaiCredit.mount(row,key);
 const button=row.querySelector('button'),report=row.querySelector('.credit-report');
 const tick=()=>new Promise(r=>setTimeout(r,0));
 let calls=[];
 w.fetch=async(url,opts)=>{calls.push({url,opts});return {ok:true,json:async()=>({remaining_irt:1234,limit:5000,credit_sources:{packages:[{remaining_irt:12,end_date:'2030-01-01T00:00:00Z'}]}})};};
 button.click();await tick();assert.equal(calls.length,0);
 key.value='test-secret';button.click();await tick();
 assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.avalai.ir/user/v1/credit');
 assert.equal(calls[0].opts.headers.Authorization,'Bearer test-secret');
 assert.match(report.textContent,/آخرین بررسی موفق/);assert.match(report.textContent,/بودجهٔ اختصاصی همین کلید نیست/);assert.match(report.textContent,/پایان بسته/);
 assert.ok(!report.textContent.includes('test-secret'));
 key.value='next';key.dispatchEvent(new w.Event('input'));assert.equal(report.textContent,'');
 let resolve;w.fetch=()=>new Promise(r=>{resolve=r;});
 button.click();button.click();assert.equal(button.disabled,true);
 key.value='changed';key.dispatchEvent(new w.Event('input'));
 resolve({ok:true,json:async()=>({remaining_irt:999})});await tick();assert.equal(report.textContent,'');
 for(const status of [401,403,429,500]){
  w.fetch=async()=>({ok:false,status});button.click();await tick();
  assert.match(report.textContent,/خطا/);assert.ok(!report.textContent.includes('آخرین بررسی موفق'));assert.equal(button.disabled,false);
 }
 w.fetch=async()=>({ok:true,json:async()=>({unexpected:'value'})});button.click();await tick();assert.match(report.textContent,/ساختار پاسخ/);
 w.fetch=async()=>{throw new Error('network changed-secret');};button.click();await tick();assert.ok(!report.textContent.includes('changed-secret'));
 dom.window.close();console.log('PASS: AvalAI read-only inquiry endpoint, labels, key edits, stale responses, HTTP errors and secret-safe failures');
})().catch(e=>{console.error(e);process.exitCode=1;});
