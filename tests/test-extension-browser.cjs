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
    if(url.pathname==='/collector-probe'){
      res.setHeader('Content-Type','text/html');
      return res.end('<!doctype html><html><body style="background:rgb(250,240,230)"><p>Original site content</p></body></html>');
    }
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
    for(const route of ['popup/popup.html','viewer/viewer.html','ai-settings/settings.html','pdf-import/pdf-import.html','help/help.html']){
      await page.setViewport({width:route.startsWith('popup')?420:1280,height:900});
      await page.goto(base+'/src/'+route,{waitUntil:'networkidle0'});
      await page.addScriptTag({url:base+'/src/shared/studio-ui.js'});
      await page.evaluate(()=>document.fonts.ready);
      const result=await page.evaluate(()=>{
        document.documentElement.dataset.theme='dark';
        const dark=getComputedStyle(document.body).color;
        const font=document.fonts.check('13px Vazirmatn');
        document.getElementById('studioThemeToggle').click();
        const light=getComputedStyle(document.body).color;
        return {font,different:dark!==light,overflow:document.documentElement.scrollWidth>innerWidth,accent:getComputedStyle(document.documentElement).getPropertyValue('--a1').trim()};
      });
      assert.ok(result.font&&result.different&&!result.overflow,route+JSON.stringify(result));
      assert.equal(result.accent,'#15817b','shared light Focus palette: '+route);
      if(route.startsWith('help')){
        await page.addScriptTag({url:base+'/src/help/help.js'});
        for(const width of [1280,420]){
          await page.setViewport({width,height:900});
          const sizes=await page.evaluate(()=>{
            const input=document.getElementById('helpSearch').getBoundingClientRect();
            const button=document.getElementById('showAll').getBoundingClientRect();
            return {input:input.width,button:button.width,height:input.height,overflow:document.documentElement.scrollWidth>innerWidth};
          });
          assert.ok(sizes.input>sizes.button*2 && sizes.button<140 && sizes.height>=36 && !sizes.overflow,JSON.stringify(sizes));
        }
        await page.setViewport({width:1280,height:900});
        assert.equal(await page.$$eval('section:not([hidden])',els=>els.length),1);
        await page.click('#helpNext');
        assert.equal(await page.$eval('nav a[aria-current=page]',el=>el.hash),'#organize');
        await page.type('#helpSearch','عبارتناموجود۱۲۳');
        assert.equal(await page.$eval('#helpEmpty',el=>el.hidden),false);
        await page.click('#showAll');
        assert.equal(await page.$$eval('section:not([hidden])',els=>els.length),8);
      } else {
        assert.ok(await page.$('.studio-guide-link[aria-label="راهنمای افزونه"]'));
      }
      if(route.startsWith('viewer')){
        await page.evaluate(()=>{document.getElementById('topMenu').open=true;});
        const menu=await page.evaluate(()=>{
          const a=document.getElementById('saveProfileBtn').getBoundingClientRect();
          const b=document.getElementById('restoreProfileBtn').getBoundingClientRect();
          const panel=document.querySelector('.top-menu-panel');
          return {equal:Math.abs(a.width-b.width)<1,aligned:Math.abs(a.top-b.top)<1,
            solid:getComputedStyle(panel).backdropFilter==='none',
            overflow:panel.scrollWidth>panel.clientWidth};
        });
        assert.ok(menu.equal&&menu.aligned&&menu.solid&&!menu.overflow,JSON.stringify(menu));
        await page.evaluate(()=>{document.getElementById('topMenu').open=false;});
        await page.addScriptTag({url:base+'/src/viewer/output-dialog.js'});
        for(const width of [1280,420]){
          await page.setViewport({width,height:900});
          await page.evaluate(()=>{document.getElementById('outputSettings').open=true;});
          await page.waitForSelector('#outputDialog[open]');
          const output=await page.$eval('#outputDialog',el=>{
            const r=el.getBoundingClientRect();
            const checks=[...el.querySelectorAll('#pdfOpts .check')].map(c=>c.getBoundingClientRect().top);
            return {center:Math.abs(r.left+r.width/2-innerWidth/2)<2,inside:r.left>=0&&r.right<=innerWidth,rows:checks[1]>checks[0]&&checks[2]>checks[1]};
          });
          assert.ok(output.center&&output.inside&&output.rows,JSON.stringify(output));
          await page.keyboard.press('Escape');
          await page.waitForFunction(()=>!document.getElementById('outputDialog').open);
          assert.equal(await page.$eval('#outputSettings',el=>el.open),false);
        }
        await page.addScriptTag({url:base+'/src/viewer/result-dialog.js'});
        assert.ok(await page.$('.context-guide-link[href="../help/help.html#organize"] svg'));
        assert.equal(await page.$('.menu-guide-link'),null);
        for(const width of [1280,420]){
          await page.setViewport({width,height:900});
          await page.evaluate(()=>{
            document.getElementById('result').classList.remove('hidden');
            window.openResultDialog();
            document.getElementById('downloadBtn').classList.remove('hidden');
            document.getElementById('statusText').textContent='آماده شد! فایل PDF با ۶ صفحه ساخته شد.';
            document.getElementById('dlLabel').textContent='دانلود PDF (0.1 مگابایت)';
          });
          const resultLayout=await page.evaluate(()=>{
            const stats=document.querySelector('#result .stats').getBoundingClientRect();
            const button=document.getElementById('downloadBtn').getBoundingClientRect();
            return {sameRow:Math.abs((stats.top+stats.bottom)/2-(button.top+button.bottom)/2)<2,
              below:button.top>=stats.bottom,button:button.width,overflow:document.documentElement.scrollWidth>innerWidth};
          });
          assert.ok(!resultLayout.overflow&&resultLayout.button<300,JSON.stringify(resultLayout));
          assert.ok(width>600?resultLayout.sameRow:resultLayout.below,JSON.stringify(resultLayout));
        }
        await page.click('#closeResultDialog');
        assert.equal(await page.$eval('#resultDialog',el=>el.open),false);
        await page.click('#reopenResultDialog');
        assert.equal(await page.$eval('#resultDialog',el=>el.open),true);
        await page.keyboard.press('Escape');
        assert.equal(await page.$eval('#resultDialog',el=>el.open),false);
        await page.evaluate(()=>{document.getElementById('result').classList.add('hidden');});
        await page.setViewport({width:1280,height:900});

      }
      if(route.startsWith('popup')||route.startsWith('viewer')){
        for(const theme of ['light','dark']){
          const modal=await page.evaluate(theme=>{
            document.documentElement.dataset.theme=theme;
            const root=document.getElementById('extModal');root.classList.remove('hidden');
            const bg=getComputedStyle(root.querySelector('.ext-modal-card')).backgroundColor;
            root.classList.add('hidden');return bg;
          },theme);
          assert.equal(modal,theme==='light'?'rgb(228, 236, 235)':'rgb(21, 36, 44)','Focus confirmation surface');
        }
      }

      if(route.startsWith('popup')){
        const tools=await page.evaluate(()=>[...document.querySelectorAll('.popup-tool-row button')].map(el=>{
          const r=el.getBoundingClientRect();return {top:r.top,width:r.width,height:r.height};
        }));
        assert.equal(tools.length,3);assert.ok(tools.every(r=>r.top===tools[0].top&&Math.abs(r.width-tools[0].width)<1&&r.height===44));
        const size=await page.evaluate(()=>{
          const row=document.querySelector('.popup-tool-row').getBoundingClientRect();
          return {row:row.width,gap:parseFloat(getComputedStyle(document.querySelector('.popup-tool-row')).columnGap),height:document.body.getBoundingClientRect().height};
        });
        assert.ok(Math.abs(tools.reduce((n,r)=>n+r.width,0)+2*size.gap-size.row)<1,'tools fill three equal columns');
        assert.ok(size.height<=600,'default popup must fit Chrome 600px cap: '+JSON.stringify(size));
        await page.setViewport({width:420,height:Math.ceil(size.height)});
        assert.ok(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight),'default popup must not scroll at content height');
        for(const id of ['startBtn','pdfConvertBtn','translatePageBtn']){
          await page.hover('#'+id);
          const tooltip=await page.$eval('#'+id+' [role=tooltip]',el=>{
            const r=el.getBoundingClientRect();return {visible:getComputedStyle(el).visibility==='visible',fits:r.left>=0&&r.right<=innerWidth};
          });
          assert.ok(tooltip.visible&&tooltip.fits,JSON.stringify(tooltip));
        }
      }
      if(route.startsWith('popup')){
        await page.setViewport({width:420,height:600});
        await page.evaluate(()=>{
          window.chrome={storage:{local:{get:async()=>({})}},runtime:{getURL:v=>v}};
        });
        await page.addScriptTag({url:base+'/src/popup/popup.js'});
        await page.click('#pdfConvertBtn');
        const confirmHeight=await page.$eval('body',el=>el.getBoundingClientRect().height);
        assert.ok(confirmHeight>=360&&confirmHeight<=600,'small home expands for confirmation');
        await page.setViewport({width:420,height:Math.ceil(confirmHeight)});
        assert.ok(await page.$eval('#extModalOk',el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}),'confirmation must fit compact popup');
        await page.keyboard.press('Escape');
        await page.setViewport({width:420,height:600});
        await page.click('#startBtn');
        assert.ok(await page.$eval('#collectionReview',el=>el.disabled));
        for(const mode of ['scroll','auto','manual']){
          await page.click('[data-mode="'+mode+'"]');
          const layout=await page.evaluate(()=>({height:document.body.getBoundingClientRect().height,overflow:document.documentElement.scrollWidth>innerWidth,deep:document.getElementById('scrollModeFields').getBoundingClientRect().height>0}));
          assert.equal(layout.deep,true);assert.ok(layout.height<=600&&!layout.overflow,JSON.stringify(layout));
          await page.click('#collectionReview');
          assert.ok(await page.$eval('#extModal',el=>!el.classList.contains('hidden')));
          await page.keyboard.press('Escape');
        }
        await page.click('#collectionBack');
        assert.ok(await page.$eval('#collectionView',el=>el.getBoundingClientRect().height===0));
      }
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
          assert.ok(layout.panel.includes(theme==='dark'?'0.082353 0.141176 0.172549':'0.894118 0.92549 0.921569'),JSON.stringify(layout));
          const header=await page.evaluate(()=>{
            const controls=['.topbar-side #studioThemeToggle','.topbar-side .top-menu>summary'];
            return controls.map(selector=>{
              const el=document.querySelector(selector),r=el.getBoundingClientRect(),icon=el.querySelector('svg').getBoundingClientRect();
              return {width:r.width,height:r.height,center:r.top+r.height/2,iconWidth:icon.width,iconHeight:icon.height};
            });
          });
          assert.deepEqual(header[0],header[1],'header menu/theme targets and glyphs must match');
          assert.equal(header[0].width,36);
          assert.equal(header[0].iconWidth,18);

        }
        for(const width of [768,390]){
          await page.setViewport({width,height:900});
          assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'viewer toolbar overflow at '+width);
        }
      }

    }
    // Exercise the actual on-site UI rather than only extension-owned HTML pages.
    const popupSource=fs.readFileSync(path.join(root,'src/popup/popup.js'),'utf8');
    const collectorSource=popupSource.slice(popupSource.indexOf('async function scrapeAndSend'));
    for(const theme of ['dark','light']){
      for(const mode of ['scroll','auto','manual']){
        await page.setViewport({width:1280,height:900});
        await page.goto(base+'/collector-probe');
        await page.evaluate(origin=>{
          window.chrome={runtime:{getURL:v=>origin+'/'+v,sendMessage:async()=>({ok:true})}};
          window.__wtpdfTimings={scrollMax:1,scrollSleep:1,manualRescan:20};
        },base);
        await page.addScriptTag({content:collectorSource});
        await page.evaluate(({mode,theme})=>{
          window.collectorRun=scrapeAndSend('probe.pdf',mode,{uiTheme:theme});
        },{mode,theme});
        await page.waitForSelector('.wtpdf-root');
        await page.evaluate(()=>document.fonts.ready);
        const appearance=await page.evaluate(()=>{
          const root=document.querySelector('.wtpdf-root');
          const card=root.querySelector('.wtpdf-card,.wtpdf-manual-card');
          return {theme:root.dataset.wtpdfTheme,background:getComputedStyle(card).backgroundColor,
            text:getComputedStyle(root.querySelector('.wtpdf-msg')).color,
            spinner:root.querySelector('.wtpdf-spinner')?getComputedStyle(root.querySelector('.wtpdf-spinner')).borderTopColor:null,
            body:getComputedStyle(document.body).backgroundColor,
            font:document.fonts.check('13px HasayaCollectionVazirmatn')};
        });
        assert.equal(appearance.theme,theme);
        assert.equal(appearance.background,theme==='light'?'rgb(228, 236, 235)':'rgb(21, 36, 44)');
        assert.equal(appearance.text,theme==='light'?'rgb(32, 60, 65)':'rgb(225, 238, 242)');
        if(mode!=='manual')assert.equal(appearance.spinner,theme==='light'?'rgb(21, 129, 123)':'rgb(107, 215, 206)');
        assert.equal(appearance.body,'rgb(250, 240, 230)','site theme must remain untouched');
        assert.ok(appearance.font);
        await page.keyboard.press('Escape');
        await page.evaluate(()=>window.collectorRun);
        assert.equal(await page.$('.wtpdf-root'),null,'on-site UI must be removed after cancel');
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
    console.log('PASS: real Chromium renders five pages including the guide, organized menu, confirmations and all three injected collection UIs in Focus light/dark; real local Tesseract reads pixels');
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
