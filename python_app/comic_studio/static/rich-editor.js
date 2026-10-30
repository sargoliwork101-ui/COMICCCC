/* Standalone, build-free classic rich-text editor. Requires rich-sanitize.js. */
(function (root) {
  'use strict';
  const { sanitize, safeURL } = root.ComicSanitize;
  const icons = {
    bold:'M7 4h5a4 4 0 0 1 0 8H7z M7 12h6a4 4 0 0 1 0 8H7z', italic:'M11 4h7M6 20h7M14 4 9 20', strikeThrough:'M18 7c-1-4-9-4-10 0-1 4 9 3 9 8s-9 5-10 1M4 12h16', underline:'M6 4v7a6 6 0 0 0 12 0V4M4 20h16',
    insertUnorderedList:'M4 6h.1M4 12h.1M4 18h.1M8 6h12M8 12h12M8 18h12', insertOrderedList:'M4 5v4M3 5l1-1M3 12h2l-2 3h2M3 18h2l-1 2h1M8 6h12M8 13h12M8 19h12', blockquote:'M9 7H5v5h4v-1c0 4-1 5-4 6M19 7h-4v5h4v-1c0 4-1 5-4 6',
    justifyLeft:'M4 5h16M4 9h10M4 13h16M4 17h10', justifyCenter:'M4 5h16M7 9h10M4 13h16M7 17h10', justifyRight:'M4 5h16M10 9h10M4 13h16M10 17h10', justifyFull:'M4 5h16M4 9h16M4 13h16M4 17h16',
    link:'M10 13a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-2 2M14 11a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l2-2', unlink:'M10 13a4 4 0 0 0 6 0M14 11a4 4 0 0 0-6 0M4 4l16 16', more:'M4 6h16M4 10h16M4 15h16M4 19h16M12 12v1', undo:'M9 7 4 12l5 5M4 12h10a5 5 0 0 1 5 5', redo:'M15 7l5 5-5 5M20 12H10a5 5 0 0 0-5 5', toggle:'M4 6h16M4 11h16M4 16h7M16 15l2 2 2-2',
    removeFormat:'M5 5h14M12 5 8 19M5 19h7M16 15l5 5M21 15l-5 5', indent:'M4 5h16M4 19h16M11 9h9M11 15h9M4 9l4 3-4 3', outdent:'M4 5h16M4 19h16M11 9h9M11 15h9M8 9l-4 3 4 3', horizontal:'M4 12h16', image:'M4 5h16v14H4zM6 16l4-4 3 3 2-2 3 3M15 8h.1', table:'M4 4h16v16H4zM4 9h16M4 15h16M10 4v16M15 4v16', rtl:'M20 5h-6a5 5 0 0 0 0 10h2M16 5v15M12 5v15M4 17h6M4 17l3-3M4 17l3 3', ltr:'M4 5h6a5 5 0 0 1 0 10H8M8 5v15M12 5v15M20 17h-6M20 17l-3-3M20 17l-3 3', fullscreen:'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5', plain:'M5 5h14M12 5v14M8 19h8', color:'M5 18l6-14h2l6 14M8 13h8M4 21h16', format:'M4 7h16M4 12h16M4 17h16'
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="${icons[name] || icons.format}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  function createEditor(selector, options = {}) {
    const found = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!found) throw new Error('Editor target not found');
    const field = found.getAttribute('contenteditable') != null ? found : document.createElement('div');
    const shell = document.createElement('section'); shell.className = 'classic-editor'; shell.setAttribute('aria-label', 'ویرایشگر متن غنی');
    if (field === found) { found.parentNode.insertBefore(shell, field); shell.appendChild(field); } else { found.appendChild(shell); shell.appendChild(field); }
    field.classList.add('classic-content'); field.contentEditable = 'true'; field.setAttribute('role', 'textbox'); field.setAttribute('aria-multiline', 'true'); field.setAttribute('aria-label', 'متن ویرایشگر');
    const tabs = document.createElement('div'); tabs.className = 'classic-tabs'; tabs.setAttribute('role', 'tablist');
    const visualTab = document.createElement('button'); visualTab.type = 'button'; visualTab.textContent = 'Visual'; visualTab.setAttribute('role', 'tab');
    const textTab = document.createElement('button'); textTab.type = 'button'; textTab.textContent = 'Text'; textTab.setAttribute('role', 'tab'); tabs.append(visualTab, textTab);
    const toolbar = document.createElement('div'); toolbar.className = 'classic-toolbar'; toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', 'ابزار قالب‌بندی');
    const row1 = document.createElement('div'); row1.className = 'classic-row'; const row2 = document.createElement('div'); row2.className = 'classic-row'; row2.hidden = true; toolbar.append(row1, row2);
    const source = document.createElement('textarea'); source.className = 'classic-source'; source.setAttribute('aria-label', 'کد HTML'); source.hidden = true;
    const status = document.createElement('div'); status.className = 'classic-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    shell.prepend(tabs, toolbar); shell.append(source, status);
    let mode = 'visual', savedRange = null, plainPaste = false, plainMode = false, currentKey = options.autosaveKey || '', base = '', dirty = false, timer = null;
    const listeners = new Set(); if (typeof options.onChange === 'function') listeners.add(options.onChange);
    function remember() { const sel = window.getSelection(); if (sel?.rangeCount && field.contains(sel.anchorNode) && field.contains(sel.focusNode)) savedRange = sel.getRangeAt(0).cloneRange(); }
    function restore() { field.focus(); if (savedRange && field.contains(savedRange.startContainer) && field.contains(savedRange.endContainer)) { const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(savedRange); } }
    function html() { return sanitize(mode === 'text' ? source.value : field.innerHTML); }
    function text() {
      const hidden = field.hidden; if (hidden) { field.innerHTML = html(); field.hidden = false; }
      const value = (field.innerText ?? field.textContent ?? '').replace(/\u00a0/g, ' '); if (hidden) field.hidden = true; return value;
    }
    let savedAt = '';
    function updateStatus(message = '') { const value = text(); const words = value.trim() ? value.trim().split(/\s+/u).length : 0; status.textContent = `${words.toLocaleString('fa-IR')} واژه · ${Array.from(value).length.toLocaleString('fa-IR')} نویسه · ${savedAt ? `ذخیرهٔ پیش‌نویس: ${savedAt}` : 'پیش‌نویس هنوز ذخیره نشده'}${message ? ` · ${message}` : ''}`; }
    function changed() { dirty = true; if (mode === 'text') { field.innerHTML = html(); } updateStatus(); const value = html(); listeners.forEach((fn) => fn(value)); }
    function setMode(next) {
      if (next === mode) return;
      if (next === 'text') { remember(); source.value = sanitize(field.innerHTML); field.hidden = true; source.hidden = false; mode = 'text'; source.focus(); }
      else { field.innerHTML = sanitize(source.value); source.hidden = true; field.hidden = false; mode = 'visual'; field.dispatchEvent(new Event('input', { bubbles: true })); field.focus(); }
      visualTab.setAttribute('aria-selected', String(mode === 'visual')); textTab.setAttribute('aria-selected', String(mode === 'text'));
      toolbar.querySelectorAll('button,select,input').forEach((control) => { control.disabled = mode === 'text' && !control.dataset.allowText; }); updateStatus();
    }
    visualTab.addEventListener('click', () => setMode('visual')); textTab.addEventListener('click', () => setMode('text')); visualTab.setAttribute('aria-selected', 'true'); textTab.setAttribute('aria-selected', 'false');
    function exec(command, value = null) { if (mode !== 'visual') return; restore(); document.execCommand('styleWithCSS', false, true); document.execCommand(command, false, value); remember(); changed(); }
    function button(row, key, title, fn) { const b = document.createElement('button'); b.type = 'button'; b.className = 'classic-button'; b.title = title; b.setAttribute('aria-label', title); b.innerHTML = icon(key); b.addEventListener('mousedown', (e) => e.preventDefault()); b.addEventListener('click', fn); row.appendChild(b); return b; }
    const format = document.createElement('select'); format.setAttribute('aria-label', 'قالب بند');
    [['p','Paragraph'],['h1','Heading 1'],['h2','Heading 2'],['h3','Heading 3'],['h4','Heading 4'],['h5','Heading 5'],['h6','Heading 6'],['pre','Preformatted']].forEach(([v,t]) => { const o = document.createElement('option'); o.value=v; o.textContent=t; format.appendChild(o); });
    format.addEventListener('change', () => exec('formatBlock', `<${format.value}>`)); row1.appendChild(format);
    [['bold','پررنگ'],['italic','ایتالیک'],['strikeThrough','خط‌خورده'],['insertUnorderedList','فهرست نقطه‌ای'],['insertOrderedList','فهرست شماره‌دار']].forEach(([cmd,label]) => button(row1,cmd,label,()=>exec(cmd)));
    button(row1,'blockquote','نقل‌قول',()=>exec('formatBlock','<blockquote>'));
    [['justifyLeft','تراز چپ','left'],['justifyCenter','تراز وسط','center'],['justifyRight','تراز راست','right']].forEach(([cmd,label,value])=>button(row1,cmd,label,()=>options.align ? options.align(value) : exec(cmd)));
    let modal = null;
    function closeModal() { if (modal) { modal.remove(); modal = null; restore(); } }
    function dialog(title, build) {
      if (modal) closeModal(); remember(); modal = document.createElement('div'); modal.className = 'classic-modal'; modal.setAttribute('role','dialog'); modal.setAttribute('aria-modal','true'); modal.setAttribute('aria-label',title);
      const box = document.createElement('div'); box.className = 'classic-modal-box'; const heading = document.createElement('strong'); heading.textContent = title; box.appendChild(heading);
      const err = document.createElement('div'); err.className = 'classic-modal-error'; err.setAttribute('role','alert');
      const footer = document.createElement('div'); footer.className = 'classic-modal-actions'; const cancel = document.createElement('button'); cancel.type='button'; cancel.textContent='لغو'; cancel.addEventListener('click',closeModal);
      const apply = document.createElement('button'); apply.type='button'; apply.textContent='درج'; apply.className='classic-primary'; footer.append(cancel,apply); build(box,apply,err); box.append(err,footer); modal.appendChild(box); shell.appendChild(modal);
      modal.addEventListener('keydown',(e)=>{ if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeModal();} }); box.querySelector('input')?.focus();
    }
    function insertHTML(value) { exec('insertHTML', sanitize(value)); }
    function linkDialog() { dialog('درج پیوند', (box,apply,error) => { const label=document.createElement('label'); label.textContent='نشانی URL'; const input=document.createElement('input'); input.type='url'; input.placeholder='https://example.com'; label.append(input); const line=document.createElement('label'); line.className='classic-check'; const check=document.createElement('input'); check.type='checkbox'; line.append(check,document.createTextNode('باز شدن در تب جدید')); box.append(label,line); apply.addEventListener('click',()=>{ const url=safeURL(input.value); if(!url){error.textContent='نشانی معتبر وارد کنید.';return;} const blank=check.checked; closeModal(); restore(); const sel=window.getSelection(); if (!sel || sel.isCollapsed) insertHTML(`<a href="${url.replace(/&/g,'&amp;').replace(/"/g,'&quot;')}"${blank?' target="_blank"':''}>${url.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</a>`); else { document.execCommand('createLink',false,url); const node=window.getSelection()?.anchorNode; const a=(node?.nodeType===1?node:node?.parentElement)?.closest('a'); if(a&&field.contains(a)){ if(blank){a.target='_blank';a.rel='noopener noreferrer';} else {a.removeAttribute('target');a.removeAttribute('rel');} } remember(); changed(); } }); }); }
    button(row1,'link','درج پیوند (Ctrl+K)',linkDialog); button(row1,'unlink','حذف پیوند',()=>exec('unlink'));
    button(row1,'more','درج Read More',()=>insertHTML('<hr data-readmore="true">'));
    const undo = () => options.undo ? options.undo() : exec('undo'); const redo = () => options.redo ? options.redo() : exec('redo');
    button(row1,'undo','واگرد',undo); button(row1,'redo','ازنو',redo);
    const toggle=button(row1,'toggle','نمایش ابزارهای پیشرفته',()=>{row2.hidden=!row2.hidden;toggle.setAttribute('aria-expanded',String(!row2.hidden));}); toggle.setAttribute('aria-expanded','false'); toggle.dataset.allowText='1';
    button(row2,'underline','زیرخط',()=>exec('underline')); button(row2,'justifyFull','جاستیفای',()=>options.align ? options.align('justify') : exec('justifyFull'));
    const color=document.createElement('input'); color.type='color';color.value='#000000';color.className='classic-color';color.setAttribute('aria-label','رنگ متن');color.title='رنگ متن'; color.addEventListener('input',()=>{if (!options.color || !options.color(color.value)) exec('foreColor',color.value);});row2.appendChild(color);
    button(row2,'removeFormat','پاک کردن قالب‌بندی',()=>exec('removeFormat')); button(row2,'outdent','کاهش تورفتگی',()=>exec('outdent')); button(row2,'indent','افزایش تورفتگی',()=>exec('indent')); button(row2,'horizontal','خط افقی',()=>insertHTML('<hr>'));
    function imageDialog(){dialog('درج تصویر', (box,apply,error)=>{const label=document.createElement('label');label.textContent='نشانی تصویر';const url=document.createElement('input');url.type='url';url.placeholder='https://example.com/image.png';label.appendChild(url);const fileLabel=document.createElement('label');fileLabel.textContent='یا انتخاب فایل تصویر (حداکثر ۲ مگابایت)';const file=document.createElement('input');file.type='file';file.accept='image/png,image/jpeg,image/gif,image/webp';fileLabel.append(file);const altLabel=document.createElement('label');altLabel.textContent='متن جایگزین';const alt=document.createElement('input');altLabel.append(alt);box.append(label,fileLabel,altLabel);apply.addEventListener('click',async()=>{let src='';if(file.files?.length){const f=file.files[0];if(!['image/png','image/jpeg','image/gif','image/webp'].includes(f.type)||f.size>2*1024*1024){error.textContent='فایل باید PNG، JPEG، GIF یا WebP و حداکثر ۲ مگابایت باشد.';return;}const opened=modal;try{src=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(f);});}catch{error.textContent='خواندن فایل تصویر ممکن نبود.';return;}if(modal!==opened)return;}else src=safeURL(url.value,true);if(!src){error.textContent='نشانی یا فایل تصویر معتبر انتخاب کنید.';return;}const image=document.createElement('img');image.src=src;image.alt=alt.value;closeModal();insertHTML(image.outerHTML);});});}
    button(row2,'image','درج تصویر',imageDialog);
    function tableDialog(){dialog('درج جدول',(box,apply,error)=>{const rowLabel=document.createElement('label');rowLabel.textContent='تعداد ردیف (۱ تا ۸)';const rows=document.createElement('input');rows.type='number';rows.min='1';rows.max='8';rows.value='2';rowLabel.append(rows);const colLabel=document.createElement('label');colLabel.textContent='تعداد ستون (۱ تا ۸)';const cols=document.createElement('input');cols.type='number';cols.min='1';cols.max='8';cols.value='2';colLabel.append(cols);box.append(rowLabel,colLabel);apply.addEventListener('click',()=>{const r=+rows.value,c=+cols.value;if(!Number.isInteger(r)||!Number.isInteger(c)||r<1||r>8||c<1||c>8){error.textContent='تعداد سطر و ستون باید بین ۱ تا ۸ باشد.';return;}const table='<table><tbody>'+Array.from({length:r},()=>'<tr>'+Array.from({length:c},()=>'<td>متن</td>').join('')+'</tr>').join('')+'</tbody></table><p><br></p>';closeModal();insertHTML(table);});});}
    button(row2,'table','درج جدول',tableDialog);
    function direction(dir){restore();document.execCommand('formatBlock',false,'div');const node=window.getSelection()?.anchorNode;let element=node?.nodeType===1?node:node?.parentElement;while(element&&element!==field&&!['DIV','P','LI','H1','H2','H3','H4','H5','H6','PRE','BLOCKQUOTE'].includes(element.tagName))element=element.parentElement;if(element&&element!==field)element.style.direction=dir;else field.style.direction=dir;remember();field.dispatchEvent(new Event('input',{bubbles:true}));changed();}
    button(row2,'rtl','راست‌به‌چپ',()=>options.direction ? options.direction('rtl') : direction('rtl'));button(row2,'ltr','چپ‌به‌راست',()=>options.direction ? options.direction('ltr') : direction('ltr'));
    const full=button(row2,'fullscreen','تمام‌صفحه',()=>{shell.classList.toggle('classic-fullscreen'); const enabled=shell.classList.contains('classic-fullscreen'); options.onFullscreen?.(enabled); full.setAttribute('aria-pressed',String(enabled));});full.setAttribute('aria-pressed','false');full.dataset.allowText='1';
    const plain=button(row2,'plain','چسباندن به‌صورت متن ساده',()=>{plainPaste=!plainPaste;plain.setAttribute('aria-pressed',String(plainPaste));});plain.setAttribute('aria-pressed','false');
    ['focus','keyup','mouseup'].forEach((name)=>field.addEventListener(name,remember));
    field.addEventListener('input',()=>{remember();changed();}); source.addEventListener('input',changed);
    field.addEventListener('paste',(e)=>{e.preventDefault();const data=e.clipboardData; const rich=data?.getData('text/html'); if(!plainMode&&!plainPaste&&rich) insertHTML(rich); else exec('insertText',data?.getData('text/plain')||'');});
    field.addEventListener('keydown',(e)=>{if(!(e.ctrlKey||e.metaKey))return;const key=e.key.toLowerCase();if(plainMode && ['b','i','u','k'].includes(key)){e.preventDefault();return;}if(key==='k'){e.preventDefault();e.stopPropagation();linkDialog();}else if(['b','i','u'].includes(key)){e.preventDefault();e.stopPropagation();exec({b:'bold',i:'italic',u:'underline'}[key]);}else if(key==='z'||key==='y'){e.preventDefault();e.stopPropagation();(key==='y'||e.shiftKey?redo:undo)();}});
    function saveDraft(){if(!currentKey||!dirty)return;try{const at=new Date();localStorage.setItem(currentKey,JSON.stringify({html:html(),base,time:at.toISOString(),meta:options.getDraftMetadata?.() ?? null}));savedAt=at.toLocaleTimeString('fa-IR');dirty=false;updateStatus();}catch{updateStatus('ذخیرهٔ محلی در دسترس نیست');}}
    timer = setInterval(saveDraft, Math.max(1000, options.autosaveInterval || 3000));
    const api = {
      getHTML: html, getText: text, focus(){(mode==='visual'?field:source).focus();},
      setHTML(value){field.innerHTML=sanitize(value);source.value=field.innerHTML;savedRange=null;changed();},
      onChange(fn){listeners.add(fn);return()=>listeners.delete(fn);},
      setContext(key,value,revision=''){ row2.hidden=true;toggle.setAttribute('aria-expanded','false');currentKey=key||'';base=revision; savedAt=''; dirty=false; savedRange=null; mode='visual';source.hidden=true;field.hidden=false;field.innerHTML=sanitize(value);source.value=field.innerHTML;visualTab.setAttribute('aria-selected','true');textTab.setAttribute('aria-selected','false');toolbar.querySelectorAll('button,select,input').forEach((el)=>{el.disabled=false;});let recovered=false;try{const saved=JSON.parse(localStorage.getItem(currentKey)||'null');if(typeof saved?.html === 'string' && (saved.html!==field.innerHTML || JSON.stringify(saved.meta ?? null)!==JSON.stringify(options.getDraftMetadata?.() ?? null)) && confirm(saved.base===base ? 'پیش‌نویس ذخیره‌شده‌ای پیدا شد. بازیابی شود؟' : 'این پیش‌نویس متعلق به نسخهٔ قدیمی‌تری از کادر است. بازیابی آن متن فعلی را در ویرایشگر جایگزین می‌کند. بازیابی شود؟')){field.innerHTML=sanitize(saved.html);source.value=field.innerHTML;options.onRestore?.(saved.meta);dirty=true;recovered=true;}}catch{}updateStatus();return recovered;},
      saveDraft, clearDraft(){try{if(currentKey)localStorage.removeItem(currentKey);}catch{}dirty=false;},
      setPlainMode(enabled){ plainMode=!!enabled; toolbar.hidden=plainMode; tabs.hidden=plainMode; if(enabled&&mode==='text')setMode('visual'); field.contentEditable=enabled?'plaintext-only':'true'; },
      notifyChange(){ remember(); changed(); },
      attachField(container){ container.append(field, source); },
      detachField(){ shell.insertBefore(field, status); shell.insertBefore(source, status); },
      exitFullscreen(){ if(shell.classList.contains('classic-fullscreen')) {shell.classList.remove('classic-fullscreen'); full.setAttribute('aria-pressed','false'); options.onFullscreen?.(false);} },
      destroy(){clearInterval(timer);shell.remove();}, element: shell, field,
    };
    if (options.autosaveKey) api.setContext(options.autosaveKey, options.initialHTML ?? field.innerHTML, options.revision || '');
    updateStatus(); return api;
  }
  root.createEditor = createEditor;
  root.ComicRichEditor = { createEditor };
})(window);
