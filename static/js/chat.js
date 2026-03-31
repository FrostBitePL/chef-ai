// ─── Recipe Store (avoids JSON-in-HTML escaping issues) ───
const recipeStore={};
let recipeStoreId=0;
function storeRecipe(r){const id='r'+(recipeStoreId++);recipeStore[id]=r;return id}
function getRecipe(el){const card=el.closest('.recipe-card');return recipeStore[card?.dataset?.rid]}

// ─── Send ───
function sendQ(q){document.getElementById('input').value=q;document.getElementById('sendBtn').disabled=false;send()}

async function send(){
  const inp=document.getElementById('input');
  let q=inp.value.trim();if(!q)return;
  const kcal=getKcal();if(kcal)q+=' '+kcal;
  inp.value='';document.getElementById('sendBtn').disabled=true;inp.style.height='auto';
  document.getElementById('quickTags').style.display='none';
  addMsg('user',q);chatHistory.push({role:'user',content:q});

  // Streaming message bubble
  const streamDiv=document.createElement('div');streamDiv.className='msg';
  const streamText=document.createElement('div');streamText.className='msg-text msg-streaming';
  streamText.textContent='⏳ Generuję...';
  streamDiv.appendChild(streamText);
  document.getElementById('messages').appendChild(streamDiv);scrollBottom();

  try{
    const r=await fetch(API+'/api/ask-stream',{method:'POST',headers:authHeaders(),body:JSON.stringify({question:q,conversation_history:chatHistory.slice(-20)})});
    
    if(!r.ok){
      const d=await r.json();streamDiv.remove();
      if(d.is_limit){showLimitMessage(d.message);return}
      if(d.error){addMsg('t',d.error);return}
      return;
    }

    const reader=r.body.getReader();
    const decoder=new TextDecoder();
    let buffer='',fullText='',finalData=null;

    while(true){
      const{done,value}=await reader.read();
      if(done) break;
      buffer+=decoder.decode(value,{stream:true});
      const lines=buffer.split('\n');
      buffer=lines.pop()||'';
      for(const line of lines){
        if(!line.startsWith('data: ')) continue;
        try{
          const msg=JSON.parse(line.slice(6));
          if(msg.chunk){fullText+=msg.chunk;streamText.textContent=fullText.slice(0,300)+(fullText.length>300?'...':'');scrollBottom()}
          if(msg.done&&msg.data) finalData=msg.data;
          if(msg.error){streamDiv.remove();addMsg('t','Błąd: '+msg.error);return}
        }catch{}
      }
    }

    streamDiv.remove();
    if(finalData){handleResponse(finalData);autoSaveSession()}
    else if(fullText){try{handleResponse(JSON.parse(fullText))}catch{addMsg('t',fullText)};autoSaveSession()}
  }catch{streamDiv.remove();addMsg('t','Błąd połączenia.')}
  scrollBottom();
}

async function surprise(){
  document.getElementById('quickTags').style.display='none';
  addMsg('user','🎲 Zaskoczy mnie!');
  const lid='l'+Date.now(),msgs=document.getElementById('messages'),ld=document.createElement('div');
  ld.id=lid;ld.className='msg';ld.innerHTML=loadingDots();msgs.appendChild(ld);scrollBottom();
  try{
    const r=await fetch(API+'/api/surprise',{method:'POST',headers:authHeaders(),body:JSON.stringify({})});
    const d=await r.json();document.getElementById(lid)?.remove();
    if(d.is_limit){showLimitMessage(d.message);return}
    if(d.error){addMsg('t',d.error);return}
    handleResponse(d.data);
  }catch{document.getElementById(lid)?.remove();addMsg('t','Błąd.')}
  scrollBottom();
}

async function importFromUrl(){
  const url=prompt('Wklej URL przepisu:');
  if(!url||!url.trim()) return;
  document.getElementById('quickTags').style.display='none';
  addMsg('user','🔗 Importuj: '+url.trim());
  const lid='l'+Date.now(),msgs=document.getElementById('messages'),ld=document.createElement('div');
  ld.id=lid;ld.className='msg';ld.innerHTML=loadingDots();msgs.appendChild(ld);scrollBottom();
  try{
    const r=await fetch(API+'/api/import-url',{method:'POST',headers:authHeaders(),body:JSON.stringify({url:url.trim()})});
    const d=await r.json();document.getElementById(lid)?.remove();
    if(d.is_limit){showLimitMessage(d.message);return}
    if(d.error){addMsg('t',d.error);return}
    handleResponse(d.data);
  }catch{document.getElementById(lid)?.remove();addMsg('t','Błąd importu.')}
  scrollBottom();
}

function handleResponse(data){
  if(data.type==='recipe'){renderRecipeCard(data);chatHistory.push({role:'assistant',content:JSON.stringify(data)})}
  else if(data.type==='comparison'){renderComparison(data);chatHistory.push({role:'assistant',content:JSON.stringify(data)})}
  else{addMsg('t',data.content||JSON.stringify(data));chatHistory.push({role:'assistant',content:data.content||''})}
}

async function autoSaveSession(){
  if(chatHistory.length<2)return;
  const title=chatHistory.find(h=>h.role==='user')?.content?.slice(0,60)||'Sesja';
  try{await fetch(API+'/api/history',{method:'POST',headers:authHeaders(),body:JSON.stringify({session:{id:chatSessionId,title,profile:botProfile(),messages:chatHistory.slice(-40)}})})}catch{}
}

// ─── Recipe Card ───
function renderRecipeCard(r){
  const rid=storeRecipe(r);
  const msgs=document.getElementById('messages'),div=document.createElement('div');div.className='msg';
  const fav=favorites.some(f=>f.title===r.title),stars='★'.repeat(r.difficulty||3)+'☆'.repeat(5-(r.difficulty||3));
  let h='<div class="recipe-card" data-rid="'+rid+'">';
  h+='<div class="recipe-header"><h2>'+esc(r.title)+'</h2>';
  if(r.subtitle) h+='<div class="subtitle">'+esc(r.subtitle)+'</div>';
  h+='<div class="recipe-meta">';
  if(r.times) h+='<div class="meta-pill">⏱'+( r.times.total_min||'?')+'m</div>';
  h+='<div class="meta-pill">'+stars+'</div><div class="meta-pill">🍽'+(r.servings||2)+'</div>';
  if(r.kcal_per_serving) h+='<div class="meta-pill" style="color:var(--warning)">🔥'+r.kcal_per_serving+'</div>';
  h+='</div></div>';
  h+='<div class="recipe-actions">';
  h+='<button class="action-btn '+(fav?'saved':'')+'" onclick="toggleFav(this)">'+(fav?'❤️':'🤍')+'</button>';
  h+='<button class="action-btn" onclick="openStepMode(this)">👨‍🍳 Kroki</button>';
  h+='<button class="action-btn live-cook-btn" onclick="openLive(this)">🔴 Gotuj!</button>';
  h+='<button class="action-btn" onclick="copyRecipe(this)">📋</button>';
  h+='<button class="action-btn" onclick="rateRecipe(this)">⭐</button>';
  h+='</div><div>';
  if(r.science) h+=bSec('🧪 Nauka','<div style="font-size:0.82rem;line-height:1.6;color:var(--text-dim)">'+esc(r.science)+'</div>');
  if(r.shopping_list?.length) h+=bSec('🛒 Zakupy',bShop(r.shopping_list),1);
  if(r.ingredients?.length) h+=bSec('⚖️ Składniki',bIng(r.ingredients));
  if(r.substitutes?.length) h+=bSec('🔁 Zamienniki',bSubs(r.substitutes));
  if(r.mise_en_place?.length) h+=bSec('📋 Przygotowanie','<ul style="padding-left:14px;font-size:0.82rem;line-height:1.7;color:var(--text-dim)">'+r.mise_en_place.map(m=>'<li>'+esc(m)+'</li>').join('')+'</ul>');
  if(r.steps?.length) h+=bSec('👨‍🍳 Metoda',bSteps(r.steps),1);
  if(r.warnings?.length) h+=bSec('⚠️',r.warnings.map(w=>'<div style="padding:4px 0;font-size:0.82rem"><span style="color:var(--danger);font-weight:600">'+esc(w.problem)+'</span> → '+esc(w.solution)+'</div>').join(''));
  if(r.upgrade) h+=bSec('💡','<div style="font-size:0.82rem;color:var(--text-dim)">'+esc(r.upgrade)+'</div>');
  h+='</div></div>';
  div.innerHTML=h;msgs.appendChild(div);scrollBottom();
}

function buildRecipeHTML(r){
  const rid=storeRecipe(r);
  const stars='★'.repeat(r.difficulty||3)+'☆'.repeat(5-(r.difficulty||3));
  let h='<div class="recipe-card" data-rid="'+rid+'">';
  h+='<div class="recipe-header"><h2>'+esc(r.title)+'</h2>';
  if(r.subtitle) h+='<div class="subtitle">'+esc(r.subtitle)+'</div>';
  h+='<div class="recipe-meta">';
  if(r.times) h+='<div class="meta-pill">⏱'+(r.times.total_min||'?')+'m</div>';
  h+='<div class="meta-pill">'+stars+'</div><div class="meta-pill">🍽'+(r.servings||2)+'</div>';
  h+='</div></div>';
  h+='<div class="recipe-actions"><button class="action-btn" onclick="toggleFav(this)">🤍</button><button class="action-btn" onclick="openStepMode(this)">👨‍🍳 Kroki</button><button class="action-btn live-cook-btn" onclick="openLive(this)">🔴 Gotuj!</button></div><div>';
  if(r.science) h+=bSec('🧪','<div style="font-size:0.82rem;line-height:1.6;color:var(--text-dim)">'+esc(r.science)+'</div>');
  if(r.shopping_list?.length) h+=bSec('🛒',bShop(r.shopping_list),1);
  if(r.ingredients?.length) h+=bSec('⚖️',bIng(r.ingredients));
  if(r.steps?.length) h+=bSec('👨‍🍳',bSteps(r.steps),1);
  return h+'</div></div>';
}

// Section builders
function bSec(t,c,o){return'<div class="recipe-section"><button class="section-toggle '+(o?'open':'')+'" onclick="this.classList.toggle(\'open\');this.nextElementSibling.classList.toggle(\'open\')">'+t+'<span class="chv">▼</span></button><div class="section-body '+(o?'open':'')+'">'+c+'</div></div>'}
function bShop(it){return it.map(i=>'<div class="shop-item" onclick="this.classList.toggle(\'checked\')"><div class="shop-check">✓</div><div class="shop-amount">'+esc(i.amount)+'</div><div class="shop-name">'+esc(i.item)+'</div>'+(i.section?'<div class="shop-section-tag">'+esc(i.section)+'</div>':'')+'</div>').join('')}
function bIng(it){return it.map(i=>'<div style="display:flex;gap:6px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:0.82rem"><span style="font-weight:600;min-width:50px;color:var(--gold)">'+esc(i.amount)+'</span><span>'+esc(i.item)+(i.note?' <span style="color:var(--text-faint)">· '+esc(i.note)+'</span>':'')+'</span></div>').join('')}
function bSubs(it){return it.map(s=>{let h='<div style="padding:6px 0 6px;border-bottom:1px solid rgba(255,255,255,0.04);font-size:0.82rem">';h+='<div style="font-weight:600;color:var(--gold)">'+esc(s.original)+' → '+esc(s.substitute)+'</div>';if(s.flavor_impact)h+='<div><span style="font-weight:600;color:var(--accent">Smak:</span> '+esc(s.flavor_impact)+'</div>';if(s.texture_impact)h+='<div><span style="font-weight:600;color:var(--accent">Tekstura:</span> '+esc(s.texture_impact)+'</div>';if(s.overall_effect)h+='<div><span style="font-weight:600;color:var(--accent">Ogólny efekt:</span> '+esc(s.overall_effect)+'</div>';if(s.recommendation)h+='<div><span style="font-weight:600;color:var(--accent">Kiedy:</span> '+esc(s.recommendation)+'</div>';return h+'</div>'}).join('')}
function bSteps(st){return st.map(s=>{let h='<div class="step"><span class="step-num">'+s.number+'</span><span class="step-title">'+esc(s.title||'')+'</span><div class="step-text">'+esc(s.instruction)+'</div>';if(s.equipment)h+='<div class="step-equip">🔥 '+esc(s.equipment)+'</div>';if(s.why)h+='<div class="step-why">'+esc(s.why)+'</div>';if(s.tip)h+='<div class="step-tip">💡 '+esc(s.tip)+'</div>';if(s.timer_seconds)h+='<button class="step-timer-btn" onclick="startTimer('+s.timer_seconds+',\''+esc(s.title||'').replace(/'/g,'')+'\',this)">⏱'+fmtT(s.timer_seconds)+'</button>';return h+'</div>'}).join('')}

// ─── Rate recipe ───
function rateRecipe(btn){
  const r=getRecipe(btn);if(!r)return;
  const score=prompt('Ocena 1-5 (5=rewelacja):');
  if(!score||isNaN(score)) return;
  const comment=prompt('Komentarz (opcjonalnie):') || '';
  fetch(API+'/api/profile',{method:'POST',headers:authHeaders(),
    body:JSON.stringify({rating:{title:r.title,score:+score,comment}})});
  btn.textContent='⭐'+score;btn.classList.add('saved');
}

// ─── Step mode ───
function openStepMode(b){const r=getRecipe(b);if(!r?.steps?.length)return;stepModeData=r;stepModeIndex=0;document.getElementById('stepModeTitle').textContent=r.title;rStep();document.getElementById('stepMode').classList.add('active');document.body.style.overflow='hidden'}
function closeStepMode(){document.getElementById('stepMode').classList.remove('active');document.body.style.overflow=''}
function stepNav(d){stepModeIndex+=d;if(stepModeIndex<0)stepModeIndex=0;if(stepModeIndex>=stepModeData.steps.length){closeStepMode();return}rStep()}
function rStep(){const s=stepModeData.steps[stepModeIndex],t=stepModeData.steps.length;document.getElementById('stepFill').style.width=((stepModeIndex+1)/t*100)+'%';document.getElementById('stepPrev').disabled=stepModeIndex===0;document.getElementById('stepNext').textContent=stepModeIndex===t-1?'✓ Gotowe':'Dalej →';let h='<span class="step-num">'+s.number+'</span><div class="step-title">'+esc(s.title||'')+'</div><div class="step-text">'+esc(s.instruction)+'</div>';if(s.equipment)h+='<div class="step-equip" style="margin-top:12px">🔥 '+esc(s.equipment)+'</div>';if(s.why)h+='<div class="step-why" style="margin-top:8px">'+esc(s.why)+'</div>';if(s.tip)h+='<div class="step-tip" style="margin-top:5px">💡 '+esc(s.tip)+'</div>';if(s.timer_seconds)h+='<button class="step-timer-btn" style="margin-top:10px" onclick="startTimer('+s.timer_seconds+',\''+esc(s.title||'').replace(/'/g,'')+'\',this)">⏱'+fmtT(s.timer_seconds)+'</button>';document.getElementById('stepContent').innerHTML=h}

// ─── Timers ───
function startTimer(s,l,b){if(b.classList.contains('running'))return;b.classList.add('running');const id=timerIdCounter++;let rem=s;const ov=document.getElementById('timerOverlay');ov.classList.add('active');const ch=document.createElement('div');ch.className='timer-chip';ch.id='t'+id;ch.innerHTML='<span class="time">'+fmtT(rem)+'</span><span class="label">'+esc(l)+'</span><button class="stop-btn" onclick="stopTimer('+id+')">✕</button>';ov.appendChild(ch);timers[id]=setInterval(()=>{rem--;const t=document.querySelector('#t'+id+' .time');if(t)t.textContent=fmtT(rem);if(rem<=0){clearInterval(timers[id]);const c=document.getElementById('t'+id);if(c){c.classList.add('done');c.querySelector('.time').textContent='✓'}b.classList.remove('running');b.textContent='✓';if('vibrate'in navigator)navigator.vibrate([200,100,200])}},1000)}
function stopTimer(id){clearInterval(timers[id]);document.getElementById('t'+id)?.remove();const o=document.getElementById('timerOverlay');if(!o.children.length)o.classList.remove('active')}

// ─── Comparison Cards ───
function renderComparison(data){
  const msgs=document.getElementById('messages'),div=document.createElement('div');div.className='msg';
  let h='<div class="comparison-card">';
  h+='<div class="comp-header"><h2>🔀 '+esc(data.topic||'Porównanie')+'</h2></div>';
  h+='<div class="comp-grid">';
  (data.variants||[]).forEach((v,i)=>{
    const stars='★'.repeat(v.difficulty||3)+'☆'.repeat(5-(v.difficulty||3));
    h+='<div class="comp-variant">';
    h+='<div class="comp-variant-header"><span class="comp-num">'+(i+1)+'</span><span class="comp-method">'+esc(v.method||'')+'</span></div>';
    h+='<div class="comp-meta">';
    if(v.time_min) h+='<span class="comp-pill">⏱'+v.time_min+'m</span>';
    h+='<span class="comp-pill">'+stars+'</span>';
    h+='</div>';
    if(v.texture) h+='<div class="comp-row"><span class="comp-label">Tekstura</span><span>'+esc(v.texture)+'</span></div>';
    if(v.flavor) h+='<div class="comp-row"><span class="comp-label">Smak</span><span>'+esc(v.flavor)+'</span></div>';
    if(v.best_for) h+='<div class="comp-row"><span class="comp-label">Najlepsze na</span><span>'+esc(v.best_for)+'</span></div>';
    if(v.equipment) h+='<div class="comp-row"><span class="comp-label">Sprzęt</span><span class="comp-equip">'+esc(v.equipment)+'</span></div>';
    if(v.steps_summary) h+='<div class="comp-steps">'+esc(v.steps_summary)+'</div>';
    h+='<div class="comp-pro-con">';
    if(v.pro) h+='<div class="comp-pro">✓ '+esc(v.pro)+'</div>';
    if(v.con) h+='<div class="comp-con">✗ '+esc(v.con)+'</div>';
    h+='</div></div>';
  });
  h+='</div>';
  if(data.verdict) h+='<div class="comp-verdict">🏆 '+esc(data.verdict)+'</div>';
  h+='</div>';
  div.innerHTML=h;msgs.appendChild(div);scrollBottom();
}
