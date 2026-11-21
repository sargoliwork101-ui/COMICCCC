(() => {
  'use strict';
  const chapters = [...document.querySelectorAll('section[id]')];
  chapters.forEach((chapter,i)=>{
    const badge=document.createElement('span');badge.className='help-badge';
    badge.textContent=`فصل ${(i+1).toLocaleString('fa')}`;chapter.prepend(badge);
  });
  const links = [...document.querySelectorAll('nav a')];
  const search = document.getElementById('helpSearch');
  const content = document.querySelector('.help-content');
  let active = Math.max(0, chapters.findIndex(c => '#'+c.id === location.hash));
  let all = false;
  const normalize = s => s.replace(/ي/g,'ی').replace(/ك/g,'ک').toLowerCase().trim();
  links.forEach((link,i) => {
    const number = document.createElement('span'); number.textContent = (i+1).toLocaleString('fa');
    link.prepend(number);
    link.addEventListener('click', () => { all=false; search.value=''; active=i; render(); });
  });
  function render() {
    const query = normalize(search.value);
    let matches = 0;
    chapters.forEach((chapter,i) => {
      const match = !query || normalize(chapter.textContent).includes(query);
      chapter.hidden = query ? !match : (!all && i!==active);
      links[i].hidden = !match;
      links[i].setAttribute('aria-current', i===active && !all && !query ? 'page' : 'false');
      if (match) matches++;
    });
    document.getElementById('helpEmpty').hidden = matches!==0;
    document.getElementById('helpPrev').disabled = active===0 || !!query || all;
    document.getElementById('helpNext').disabled = active===chapters.length-1 || !!query || all;
    document.getElementById('helpPosition').textContent = query ? `${matches.toLocaleString('fa')} بخش پیدا شد` : all ? 'همهٔ بخش‌ها' : `بخش ${(active+1).toLocaleString('fa')} از ${chapters.length.toLocaleString('fa')}`;
    content.scrollTop=0;
  }
  const move = delta => {active+=delta; location.hash=chapters[active].id; render();content.focus();};
  document.getElementById('helpPrev').onclick=()=>move(-1);
  document.getElementById('helpNext').onclick=()=>move(1);
  document.getElementById('showAll').onclick=()=>{all=true;search.value='';render();};
  search.addEventListener('input',render);
  window.addEventListener('hashchange',()=>{
    const i=chapters.findIndex(c=>'#'+c.id===location.hash);
    if(i>=0){active=i;all=false;search.value='';render();}
  });
  render();
})();
