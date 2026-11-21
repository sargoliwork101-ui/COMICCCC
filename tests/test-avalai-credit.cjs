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
 // Supply real Response.text semantics to the existing JSON fixtures.
 let fetchImpl;
 Object.defineProperty(w,'fetch',{get:()=>async(...args)=>{
   const res=await fetchImpl(...args);
   if(!res.text)res.text=async()=>res.json?JSON.stringify(await res.json()):'';
   return res;
 },set:fn=>{fetchImpl=fn;}});
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

 const usage=row.querySelector('.usage-check'), id=row.querySelector('.credit-key-id');
 calls=[]; key.value='secret-abcd';
 w.fetch=async(url,opts)=>{calls.push({url,opts});return {ok:true,json:async()=>({
   period:{start:'2026-11-18T00:00:00Z',end:'2026-11-19T00:00:00Z'},
   totals:{transactions:3,cost:{unit:'0.0000066'}},
   by_api_key:[{api_key_id:'123',api_key_suffix:'...abcd',transactions:2,tokens:30},
               {api_key_id:'456',api_key_suffix:'...abcd',transactions:1,tokens:10}]
 })};};
 usage.click();await tick();
 assert.equal(calls[0].url,'https://api.avalai.ir/user/v1/transactions/summary?group_by=api_key&hours_ago=24');
 assert.equal(calls[0].opts.method,'GET');assert.equal(calls[0].opts.headers.Authorization,'Bearer secret-abcd');
 assert.match(report.textContent,/تطبیق احتمالی/);assert.match(report.textContent,/اثبات هویت کلید نیست/);
 assert.match(report.textContent,/۲ دقیقه/);assert.ok(!report.textContent.includes('secret-abcd'));
 assert.ok(report.textContent.includes('۰٫۰۰۰۰۰۶۶'));
 id.value='123';usage.click();await tick();
 assert.ok(calls.at(-1).url.endsWith('&api_key_id=123'));assert.match(report.textContent,/با فیلتر شما متفاوت/);
 const count=calls.length;id.value='secret';usage.click();await tick();assert.equal(calls.length,count);
 id.value='';w.fetch=async()=>({ok:true,json:async()=>({totals:{transactions:0},by_api_key:null})});
 usage.click();await tick();assert.match(report.textContent,/گروه کلیدی در این بازه برنگشت/);
 let finish;w.fetch=()=>new Promise(r=>{finish=r;});usage.click();
 id.value='9';id.dispatchEvent(new w.Event('input'));finish({ok:true,json:async()=>({totals:{},by_api_key:[]})});
 await tick();assert.equal(report.textContent,'');assert.equal(usage.disabled,false);
 w.fetch=async()=>({ok:true,json:async()=>({wrong:1})});usage.click();await tick();assert.match(report.textContent,/ساختار پاسخ مصرف/);

 const raw=row.querySelector('.credit-raw');
 w.fetch=async()=>({ok:false,status:401,text:async()=>'{"error":"secret-abcd","detail":"provider-error"}'});
 button.click();await tick();assert.match(raw.textContent,/HTTP 401/);assert.match(raw.textContent,/provider-error/);
 assert.ok(!raw.textContent.includes('secret-abcd'));assert.match(raw.textContent,/API KEY HIDDEN/);
 w.fetch=async()=>({ok:true,status:200,text:async()=>'<img src=x onerror=alert(1)>not-json'});
 usage.click();await tick();assert.match(raw.textContent,/not-json/);assert.equal(raw.querySelector('img'),null);
 key.dispatchEvent(new w.Event('input'));assert.equal(raw.textContent,'');
 w.fetch=async()=>({ok:true,status:200,text:async()=>'{"unexpected":42}'});
 button.click();await tick();assert.match(raw.textContent,/unexpected/);assert.match(report.textContent,/ساختار پاسخ/);
 dom.window.close();console.log('PASS: AvalAI read-only inquiry endpoint, labels, key edits, stale responses, HTTP errors and secret-safe failures');
})().catch(e=>{console.error(e);process.exitCode=1;});
