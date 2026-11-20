(() => {
  'use strict';
  const settings=document.getElementById('outputSettings');
  const dialog=document.getElementById('outputDialog');
  const kind=document.getElementById('outputKind');
  const start=document.getElementById('startOutputDialog');
  const sync=()=>{
    kind.value=settings.dataset.mode;
    const action=document.getElementById(kind.value==='img'?'saveImgBtn':'buildBtn');
    start.disabled=action.disabled;
  };
  settings.addEventListener('toggle',()=>{
    if(settings.open){sync();if(!dialog.open)dialog.showModal();}
    else if(dialog.open)dialog.close();
  });
  dialog.addEventListener('close',()=>{settings.open=false;settings.querySelector('summary').focus();});
  window.addEventListener('keydown',e=>{
    if(dialog.open&&e.key==='Escape'){
      e.preventDefault();e.stopImmediatePropagation();settings.open=false;dialog.close();
    }
  },true);
  kind.onchange=()=>{window.setMode(kind.value);sync();};
  document.getElementById('closeOutputSettings').addEventListener('click',()=>{dialog.close();settings.open=false;});
  const observer=new MutationObserver(sync);
  for(const id of ['buildBtn','saveImgBtn'])observer.observe(document.getElementById(id),{attributes:true,attributeFilter:['disabled']});
  start.onclick=()=>{
    const action=document.getElementById(kind.value==='img'?'saveImgBtn':'buildBtn');
    if(action.disabled)return;
    dialog.close();settings.open=false;action.click();
  };
})();
