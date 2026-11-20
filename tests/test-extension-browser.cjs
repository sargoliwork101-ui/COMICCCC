'use strict';
// Linux Chromium validation of the packaged UI and real, locally hosted OCR.
// App business scripts are removed only from the UI preview response, not from
// the extension source. Functional click/workflow tests remain in npm test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
const root = path.resolve(__dirname,'../extension');
(async()=>{
  let browser;
  const requests = [];
  const server = http.createServer((req,res)=>{
    requests.push(req.url);
    const url = new URL(req.url,'http://localhost');
    if(url.pathname==='/ocr-probe'){
      res.setHeader('Content-Type','text/html');
      return res.end('<!doctype html><script src="/vendor/tesseract.min.js"></script><script src="/src/core/ocr.js"></script>');
    }
    const file = path.resolve(root,'.'+decodeURIComponent(url.pathname));
    if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}
    const types={'.html':'text/html','.css':'text/css','.js':'text/javascript','.woff2':'font/woff2','.gz':'application/octet-stream','.png':'image/png'};
    res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');
    let data=fs.readFileSync(file);
    if(file.endsWith('.html'))data=data.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
    res.end(data);
  });
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base='http://127.0.0.1:'+server.address().port;
    const module=await import('@sparticuz/chromium');const chromium=module.default;
    const location=path.resolve(path.dirname(require.resolve('@sparticuz/chromium')),'..');
    await module.inflate(path.join(location,'bin/al2023.tar.br'));module.setupLambdaEnvironment('/tmp/al2023/lib');
    const args=chromium.args.filter(arg=>arg!=='--single-process'&&!arg.startsWith('--headless')&&!arg.startsWith('--use-gl')&&!arg.startsWith('--use-angle')&&arg!=='--enable-unsafe-swiftshader'&&arg!=='--in-process-gpu');
    args.push('--disable-gpu');
    browser=await puppeteer.launch({args,executablePath:await chromium.executablePath(),headless:'new'});
    const page=await browser.newPage();
    for(const route of ['popup/popup.html','viewer/viewer.html','ai-settings/settings.html','pdf-import/pdf-import.html']){
      await page.setViewport({width:route.startsWith('popup')?400:1280,height:900});
      await page.goto(base+'/src/'+route,{waitUntil:'networkidle0'});
      await page.addScriptTag({url:base+'/src/shared/studio-ui.js'});
      await page.evaluate(()=>document.fonts.ready);
      const result=await page.evaluate(()=>{
        const dark=getComputedStyle(document.body).color;
        const font=document.fonts.check('13px Vazirmatn');
        document.getElementById('studioThemeToggle').click();
        const light=getComputedStyle(document.body).color;
        return {font,different:dark!==light,overflow:document.documentElement.scrollWidth>innerWidth};
      });
      assert.ok(result.font&&result.different&&!result.overflow,route+JSON.stringify(result));
      if(route.startsWith('viewer')){
        for(const theme of ['dark','light']){
          await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
          const layout=await page.evaluate(()=>{
            const groups=[...document.querySelectorAll('.toolbar-actions .studio-action-group')];
            const rects=groups.map(el=>el.getBoundingClientRect());
            const first=groups[0], label=first.querySelector('.studio-group-label'), button=first.querySelector('button');
            return {tops:rects.map(r=>r.top),heights:rects.map(r=>r.height),
              inline:Math.abs(label.getBoundingClientRect().top-button.getBoundingClientRect().top)<10,
              menu:document.querySelector('#groupMenu').getBoundingClientRect().width,
              toolbar:document.querySelector('.toolbar').getBoundingClientRect().width,
              panel:getComputedStyle(document.querySelector('.toolbar')).backgroundColor,
              danger:getComputedStyle(document.querySelector('#btnDeleteSel')).color};
          });
          assert.ok(Math.max(...layout.tops)-Math.min(...layout.tops)<2,JSON.stringify(layout));
          assert.ok(layout.heights.every(h=>h<50)&&layout.inline,JSON.stringify(layout));
          assert.ok(layout.menu<layout.toolbar/2,JSON.stringify(layout));
          assert.equal(layout.danger,'rgb(251, 113, 133)');
          assert.ok(layout.panel.includes(theme==='dark'?'0.0745098 0.0862745 0.117647':'1 1 1'),JSON.stringify(layout));
        }
        for(const width of [768,390]){
          await page.setViewport({width,height:900});
          assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'viewer toolbar overflow at '+width);
        }
      }

    }
    const external=[];
    page.on('request',request=>{if(/^https?:/.test(request.url())&&!request.url().startsWith(base+'/'))external.push(request.url());});
    await page.goto(base+'/ocr-probe');
    const text=await page.evaluate(async(origin)=>{
      window.chrome={runtime:{getURL:value=>origin+'/'+value}};
      const canvas=document.createElement('canvas');canvas.width=900;canvas.height=200;
      const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,900,200);ctx.fillStyle='black';ctx.font='60px Arial';ctx.fillText('HELLO LOCAL OCR',30,110);
      const worker=await window.OcrTools.createOcrWorker('eng');
      try{return (await worker.recognize(canvas)).data.text;}finally{await worker.terminate();}
    },base);
    assert.ok(/HELLO LOCAL OCR/.test(text),text);
    assert.ok(requests.some(url=>url.includes('/vendor/ocr/lang/eng.traineddata.gz')));
    assert.ok(requests.some(url=>url.includes('/vendor/ocr/core/')));
    assert.deepEqual(external,[],'OCR must not request a third-party website');
    console.log('PASS: real Chromium renders all four extension pages with local font/light-dark theme; real Tesseract reads pixels using only packaged local resources');
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
