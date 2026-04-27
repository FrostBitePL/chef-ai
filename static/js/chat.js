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
  const kcalVal=getKcalValue(),servingsVal=getServingsValue();
  inp.value='';document.getElementById('sendBtn').disabled=true;inp.style.height='auto';
  document.getElementById('quickTags').style.display='none';
  const kcalLabel=kcalVal?(' ('+kcalVal+' kcal/porcję, '+servingsVal+(servingsVal===1?' porcja)':' porcje)')):'';
  addMsg('user',q+kcalLabel);chatHistory.push({role:'user',content:q+kcalLabel});

  // ── STEP 1: proposals ──
  const loadDiv=document.createElement('div');loadDiv.className='msg';
  const previewEl=document.createElement('div');
  previewEl.className='stream-preview';
  previewEl.innerHTML=loadingDots();
  loadDiv.appendChild(previewEl);
  document.getElementById('messages').appendChild(loadDiv);scrollBottom();

  let proposalResult=null;
  try{
    const pr=await fetch(API+'/api/proposals',{method:'POST',headers:authHeaders(),
      body:JSON.stringify({question:q,filters:getActiveFilters?.(),pantry:getActivePantry?.(),kcal_target:kcalVal||undefined,servings:kcalVal?servingsVal:undefined,lang:currentLang})});
    const pd=await pr.json();
    console.log('[proposals] status:',pr.status,'response:',pd);
    if(pr.ok && pd.success) proposalResult=pd.data;
    else console.warn('[proposals] failed:',pd);
  }catch(e){console.error('[proposals] fetch error:',e);}

  console.log('[proposals] result:',proposalResult);

  // If specific dish or proposals failed → go straight to recipe
  if(!proposalResult||proposalResult.is_specific){
    const dish=proposalResult?.dish||q;
    console.log('[proposals] going direct to recipe for:',dish);
    await streamRecipe(dish,loadDiv,previewEl);
    return;
  }

  // ── STEP 2: show proposals ──
  loadDiv.remove();
  renderProposals(q,proposalResult.proposals);
  scrollBottom();
}

async function streamRecipe(q,loadDiv,previewEl){
  if(!loadDiv){
    loadDiv=document.createElement('div');loadDiv.className='msg';
    previewEl=document.createElement('div');previewEl.className='stream-preview';
    previewEl.innerHTML=loadingDots();
    loadDiv.appendChild(previewEl);
    document.getElementById('messages').appendChild(loadDiv);scrollBottom();
  }else{
    previewEl.innerHTML=loadingDots();
  }

  try{
    const kcalTarget=getKcalValue(),srvTarget=getServingsValue();
    const r=await fetch(API+'/api/ask-stream',{method:'POST',headers:authHeaders(),
      body:JSON.stringify({question:q,conversation_history:chatHistory.slice(-20),
        filters:getActiveFilters?.(),pantry:getActivePantry?.(),kcal_target:kcalTarget||undefined,servings:kcalTarget?srvTarget:undefined,lang:currentLang})});

    if(!r.ok){
      const d=await r.json();loadDiv.remove();
      if(d.is_limit){showLimitMessage(d.message);return}
      if(d.error){addMsg('t',d.error);return}
      return;
    }

    const reader=r.body.getReader();
    const decoder=new TextDecoder();
    let buffer='',fullText='',finalData=null,firstChunk=true;

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
          if(msg.chunk){
            fullText+=msg.chunk;
            if(firstChunk){previewEl.innerHTML='';firstChunk=false}
            const preview=fullText.replace(/[{}\[\]"]/g,' ').replace(/\s+/g,' ').slice(-300);
            previewEl.textContent=preview;
            scrollBottom();
          }
          if(msg.done&&msg.data) finalData=msg.data;
          if(msg.error){loadDiv.remove();addMsg('t',t('error')+': '+msg.error);return}
        }catch{}
      }
    }

    loadDiv.remove();
    if(finalData){handleResponse(finalData);autoSaveSession()}
    else if(fullText){
      try{
        let t2=fullText.trim();
        if(t2.startsWith('```')){t2=t2.split('\n').slice(1).join('\n').split('```')[0].trim()}
        handleResponse(JSON.parse(t2));
      }catch{addMsg('t',fullText)}
      autoSaveSession();
    }
  }catch{loadDiv.remove();addMsg('t',t('error.conn'))}
  scrollBottom();
}

function renderProposals(originalQuery,proposals){
  const msgs=document.getElementById('messages');
  const div=document.createElement('div');div.className='msg proposals-wrap';
  const stars=n=>'★'.repeat(n)+'☆'.repeat(5-n);
  let h='<div class="proposals-header">'+t('proposals.header')+'</div>';
  h+='<div class="proposals-grid">';
  (proposals||[]).forEach(p=>{
    h+=`<div class="proposal-card" onclick="chooseProposal(this,'${esc(p.title).replace(/'/g,"\\'")}')">
      <div class="prop-title">${esc(p.title)}</div>
      <div class="prop-sub">${esc(p.subtitle)}</div>
      <div class="prop-meta">
        ${p.time_min?`<span>⏱ ${p.time_min}min</span>`:''}
        ${p.difficulty?`<span>${stars(p.difficulty)}</span>`:''}
        ${p.cuisine?`<span>🌍 ${esc(p.cuisine)}</span>`:''}
      </div>
      ${p.wow?`<div class="prop-wow">✨ ${esc(p.wow)}</div>`:''}
    </div>`;
  });
  h+='</div>';
  h+=`<div class="proposals-actions">
    <button class="prop-more-btn" onclick="loadMoreProposals(this,'${esc(originalQuery).replace(/'/g,"\\'")}')">` + t('proposals.more') + `</button>
    <button class="prop-skip-btn" onclick="skipProposals(this,'${esc(originalQuery).replace(/'/g,"\\'")}')">` + t('proposals.skip') + `</button>
  </div>`;
  div.innerHTML=h;
  msgs.appendChild(div);
}

async function chooseProposal(card,title){
  // Mark selected
  card.classList.add('selected');
  card.closest('.proposals-wrap').querySelectorAll('.proposal-card').forEach(c=>{
    if(c!==card)c.style.opacity='0.4';
  });
  card.closest('.proposals-wrap').querySelectorAll('.proposals-actions').forEach(a=>a.remove());
  chatHistory.push({role:'user',content:title});
  await streamRecipe(title,null,null);
}

async function loadMoreProposals(btn,originalQuery){
  const wrap=btn.closest('.proposals-wrap');
  wrap.querySelector('.proposals-actions').innerHTML=loadingDots();
  try{
    const pr=await fetch(API+'/api/proposals',{method:'POST',headers:authHeaders(),
      body:JSON.stringify({question:originalQuery+' (inne propozycje niż poprzednie)',
        filters:getActiveFilters?.(),pantry:getActivePantry?.(),lang:currentLang})});
    const pd=await pr.json();
    wrap.remove();
    if(pd.success&&pd.data?.proposals) renderProposals(originalQuery,pd.data.proposals);
  }catch{
    if(wrap)wrap.querySelector('.proposals-actions').innerHTML=
      `<button class="prop-more-btn" onclick="loadMoreProposals(this,'${esc(originalQuery).replace(/'/g,"\\'")}')">` + t('proposals.retry') + `</button>`;
  }
  scrollBottom();
}

async function skipProposals(btn,originalQuery){
  btn.closest('.proposals-wrap').remove();
  await streamRecipe(originalQuery,null,null);
}

async function surprise(){
  document.getElementById('quickTags').style.display='none';
  const kcal=getKcalValue(),srv=getServingsValue();
  const kcalInfo=kcal?' ('+kcal+' kcal/porcję, '+srv+(srv===1?' porcja)':' porcje)'):'';
  addMsg('user',t('chat.surprise')+kcalInfo);
  const lid='l'+Date.now(),msgs=document.getElementById('messages'),ld=document.createElement('div');
  ld.id=lid;ld.className='msg';ld.innerHTML=loadingDots();msgs.appendChild(ld);scrollBottom();
  try{
    const r=await fetch(API+'/api/surprise',{method:'POST',headers:authHeaders(),body:JSON.stringify({kcal_target:kcal||undefined,servings:kcal?srv:undefined,lang:currentLang})});
    const d=await r.json();document.getElementById(lid)?.remove();
    if(d.is_limit){showLimitMessage(d.message);return}
    if(d.error){addMsg('t',d.error);return}
    handleResponse(d.data);
  }catch{document.getElementById(lid)?.remove();addMsg('t',t('error.generic'))}
  scrollBottom();
}

async function importFromUrl(){
  const url=prompt(t('chat.import_prompt'));
  if(!url||!url.trim()) return;
  document.getElementById('quickTags').style.display='none';
  const kcal=getKcalValue(),srv=getServingsValue();
  const kcalInfo=kcal?' ('+kcal+' kcal/porcję, '+srv+(srv===1?' porcja)':' porcje)'):'';
  addMsg('user',t('chat.import_label')+url.trim()+kcalInfo);
  const lid='l'+Date.now(),msgs=document.getElementById('messages'),ld=document.createElement('div');
  ld.id=lid;ld.className='msg';ld.innerHTML=loadingDots();msgs.appendChild(ld);scrollBottom();
  try{
    const r=await fetch(API+'/api/import-url',{method:'POST',headers:authHeaders(),body:JSON.stringify({url:url.trim(),kcal_target:kcal||undefined,servings:kcal?srv:undefined,lang:currentLang})});
    const d=await r.json();document.getElementById(lid)?.remove();
    if(d.is_limit){showLimitMessage(d.message);return}
    if(d.error){addMsg('t',d.error);return}
    handleResponse(d.data);
  }catch{document.getElementById(lid)?.remove();addMsg('t',t('error.import'))}
  scrollBottom();
}

function handleResponse(data){
  if(!data.type && data.title && data.steps) data.type='recipe';
  if(data.type==='recipe'){renderRecipeCard(data);chatHistory.push({role:'assistant',content:'[Przepis: '+data.title+']'})}
  else if(data.type==='comparison'){renderComparison(data);chatHistory.push({role:'assistant',content:'[Porównanie: '+data.topic+']'})}
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
  const fav=favorites.some(f=>f.title===r.title);
  const stars='★'.repeat(r.difficulty||3)+'☆'.repeat(5-(r.difficulty||3));
  const svgHeart=`<svg viewBox="0 0 24 24" width="18" height="18"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
  const svgPlay=`<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
  const svgChev=`<svg class="section-chv" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>`;

  // Title split
  const titleParts=esc(r.title).split(' — ');
  let titleH='<h2>'+titleParts[0]+'</h2>';
  if(titleParts[1]) titleH+='<span class="recipe-title-sub">'+titleParts[1]+'</span>';

  // Macro bar
  let macroH='';
  if(r.nutrition?.kcal){
    macroH=`<div class="nutrition-bar">
      <div class="nutr-col"><div class="nutr-val gold">${r.nutrition.kcal}</div><div class="nutr-label">kcal</div></div>
      ${r.nutrition.protein_g?`<div class="nutr-col"><div class="nutr-val">${r.nutrition.protein_g}g</div><div class="nutr-label">${t('nutr.protein')}</div></div>`:''}
      ${r.nutrition.fat_g?`<div class="nutr-col"><div class="nutr-val">${r.nutrition.fat_g}g</div><div class="nutr-label">${t('nutr.fat')}</div></div>`:''}
      ${r.nutrition.carbs_g?`<div class="nutr-col"><div class="nutr-val">${r.nutrition.carbs_g}g</div><div class="nutr-label">${t('nutr.carbs')}</div></div>`:''}
    </div>`;
  }

  let h=`<div class="recipe-card" data-rid="${rid}">`;
  // Hero
  h+=`<div class="recipe-header">
    ${titleH}
    ${r.subtitle?`<div class="subtitle">${esc(r.subtitle)}</div>`:''}
    <div class="recipe-meta">
      ${r.times?`<div class="meta-pill">⏱ ${r.times.total_min||'?'}m</div>`:''}
      <div class="meta-pill">${stars}</div>
      <div class="meta-pill">🍽 ${r.servings||2}</div>
    </div>
    ${macroH}
  </div>`;

  // Primary actions
  h+=`<div class="recipe-actions">
    <button class="action-save${fav?' saved':''}" onclick="toggleFav(this)" title="${fav?t('recipe.saved'):t('recipe.save')}">${svgHeart}</button>
    <button class="action-cook" onclick="openLive(this)">${svgPlay} ${t('recipe.cook')}</button>
    <button class="action-more" onclick="this.nextElementSibling.classList.toggle('open')" title="Więcej">···</button>
  </div>
  <div class="action-extras">
    <button class="action-btn" onclick="openStepMode(this)">👨‍🍳 ${t('recipe.steps')}</button>
    <button class="action-btn" onclick="copyRecipe(this)">📋 ${t('recipe.copy')}</button>
    <button class="action-btn" onclick="shareRecipe(this)">🔗 ${t('recipe.share')}</button>
    <button class="action-btn" onclick="showCost(this)">💰 ${t('recipe.cost')}</button>
    <button class="action-btn" onclick="rateRecipe(this)">⭐ ${t('recipe.rate')}</button>
    <button class="action-btn" onclick="showPairing(this)">🍷 ${t('recipe.pairing')}</button>
    <button class="action-btn" onclick="openNotes(this)">📝 ${t('recipe.notes')}</button>
  </div>`;

  // Stepper
  h+=`<div class="scaling-row">
    <span class="scaling-label">${t('recipe.servings')}</span>
    <div class="stepper">
      <button class="stepper-btn" onclick="scaleRecipe(this,-1)">−</button>
      <div class="stepper-val">${r.servings||2}</div>
      <button class="stepper-btn" onclick="scaleRecipe(this,+1)">+</button>
    </div>
  </div>`;

  // Accordion sections
  h+='<div class="recipe-sections-card">';
  if(r.ingredients?.length) h+=bSec2(t('section.ingredients'),bIng2(r.ingredients),r.ingredients.length,true);
  if(r.shopping_list?.length) h+=bSec2(t('section.shopping'),bShopExport(rid)+bShop(r.shopping_list),r.shopping_list.length,false);
  if(r.steps?.length) h+=bSec2(t('section.method'),bSteps2(r.steps,r.title),r.steps.length,true);
  if(r.substitutes?.length) h+=bSec2(t('section.substitutes'),bSubs(r.substitutes),r.substitutes.length,false);
  if(r.mise_en_place?.length) h+=bSec2(t('section.mise'),'<ul style="padding-left:14px;font-size:13px;line-height:1.7;color:var(--text-soft)">'+r.mise_en_place.map(m=>'<li style="padding:4px 0">'+esc(m)+'</li>').join('')+'</ul>',r.mise_en_place.length,false);
  if(r.warnings?.length) h+=bSec2(t('section.warnings'),bWarnings(r.warnings),r.warnings.length,false);
  if(r.upgrade) h+=bSec2(t('section.tips'),`<div class="pro-tip-card">💡 ${esc(r.upgrade)}</div>`,null,false);
  if(r.science) h+=bSec2(t('section.science'),`<div style="font-size:13px;line-height:1.6;color:var(--text-soft)">${esc(r.science)}</div>`,null,false);
  h+='</div>';

  h+='<div class="content-spacer"></div>';
  h+='</div>';
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
  h+='<div class="recipe-actions"><button class="action-btn" onclick="toggleFav(this)">'+t('recipe.save')+'</button><button class="action-btn" onclick="openStepMode(this)">'+t('recipe.steps')+'</button><button class="action-btn live-cook-btn" onclick="openLive(this)">'+t('recipe.cook')+'</button></div><div>';
  if(r.science) h+=bSec(t('section.science'),'<div style="font-size:0.82rem;line-height:1.6;color:var(--text-dim)">'+esc(r.science)+'</div>');
  if(r.shopping_list?.length) h+=bSec(t('section.shopping'),bShop(r.shopping_list),1);
  if(r.ingredients?.length) h+=bSec(t('section.ingredients'),bIng(r.ingredients));
  if(r.steps?.length) h+=bSec(t('section.method'),bSteps(r.steps),1);
  return h+'</div></div>';
}

// ─── Shopping list export bar ───
function bShopExport(rid){
  return `<div class="shop-export-bar">
    <button class="shop-exp-btn" onclick="exportShoppingList('${rid}','copy')" title="${t('shop.copy_tooltip')}">${t('shop.copy')}</button>
    <button class="shop-exp-btn" onclick="exportShoppingList('${rid}','share')" title="${t('shop.share_tooltip')}">${t('shop.share')}</button>
    <button class="shop-exp-btn" onclick="exportShoppingList('${rid}','print')" title="${t('shop.print_tooltip')}">${t('shop.print')}</button>
  </div>`;
}

// ─── Section builders ───
const svgChevFn=()=>`<svg class="section-chv" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

// Legacy bSec (kept for training/planner/favorites reuse)
function bSec(title,c,o){return'<div class="recipe-section"><button class="section-toggle '+(o?'open':'')+'" onclick="this.classList.toggle(\'open\');this.nextElementSibling.classList.toggle(\'open\')">'+title+svgChevFn()+'</button><div class="section-body '+(o?'open':'')+'"><div class="section-body-inner">'+c+'</div></div></div>'}

// New accordion for recipe cards
function bSec2(title,c,count,defaultOpen){
  const o=defaultOpen?'open':'';
  const badge=count?`<span class="section-count">${count}</span>`:'';
  return `<div class="recipe-section">
    <button class="section-toggle ${o}" onclick="toggleSection(this)">
      <div class="section-toggle-left">${title}${badge}</div>
      ${svgChevFn()}
    </button>
    <div class="section-body ${o}"><div class="section-body-inner">${c}</div></div>
  </div>`;
}

function toggleSection(btn){
  btn.classList.toggle('open');
  btn.nextElementSibling.classList.toggle('open');
}

// Shopping list
function bShop(it){return it.map(i=>'<div class="shop-item" onclick="this.classList.toggle(\'checked\')"><div class="shop-check">✓</div><div class="shop-amount">'+esc(i.amount)+'</div><div class="shop-name">'+esc(i.item)+'</div>'+(i.section?'<div class="shop-section-tag">'+esc(i.section)+'</div>':'')+'</div>').join('')}

// Legacy ingredient rows (used in buildRecipeHTML)
function bIng(it){return it.map(i=>'<div class="ing-row"><span class="ing-amount">'+esc(i.amount)+'</span><span class="ing-name">'+esc(i.item)+(i.note?'<span class="ing-note"> · '+esc(i.note)+'</span>':'')+'</span></div>').join('')}

// New ingredient rows with emoji guess
function bIng2(it){
  const emojiMap={kurczak:'🍗',wołowina:'🥩',wieprzowina:'🥩',ryba:'🐟',łosoś:'🐟',jajko:'🥚',jaja:'🥚',cebula:'🧅',czosnek:'🧄',pomidor:'🍅',papryka:'🫑',marchew:'🥕',ziemniak:'🥔',makaron:'🍝',ryż:'🍚',masło:'🧈',oliwa:'🫒',olej:'🫒',śmietana:'🥛',mleko:'🥛',mąka:'🌾',cukier:'🍬',sól:'🧂',pieprz:'🌶️',cytryna:'🍋',por:'🥬',szpinak:'🥬',brokuł:'🥦'};
  return it.map(i=>{
    const key=Object.keys(emojiMap).find(k=>i.item?.toLowerCase().includes(k));
    const emoji=key?emojiMap[key]:'🔸';
    return `<div class="ing-row"><span class="ing-emoji">${emoji}</span><span class="ing-amount">${esc(i.amount)}</span><span class="ing-name">${esc(i.item)}${i.note?`<span class="ing-note"> · ${esc(i.note)}</span>`:''}</span></div>`;
  }).join('');
}

// Substitutes
function bSubs(it){return it.map(s=>{let h='<div style="padding:6px 0 6px;border-bottom:1px solid var(--border);font-size:13px">';h+='<div style="font-weight:600;color:var(--gold)">'+esc(s.original)+' → '+esc(s.substitute)+'</div>';if(s.flavor_impact)h+='<div style="font-size:12px;color:var(--text-soft);margin-top:2px"><span style="font-weight:600">'+t('sub.flavor')+'</span> '+esc(s.flavor_impact)+'</div>';if(s.overall_effect)h+='<div style="font-size:12px;color:var(--text-soft)"><span style="font-weight:600">'+t('sub.overall')+'</span> '+esc(s.overall_effect)+'</div>';return h+'</div>'}).join('')}

// Warnings
function bWarnings(it){return it.map(w=>`<div class="warning-card"><div class="warning-problem">${esc(w.problem)}</div><div class="warning-solution">→ ${esc(w.solution)}</div></div>`).join('')}

// New steps with progress dots, expand/collapse, science toggle
function bSteps2(st,recipeTitle){
  const dots=st.map((_,i)=>`<div class="prog-dot" data-idx="${i}"></div>`).join('');
  const stepsH=st.map((s,i)=>{
    const hasScience=s.why||s.tip;
    return `<div class="step${i===0?' active':''}" onclick="activateStep(this,${i})">
      <div class="step-header">
        <div class="step-num">${s.number}</div>
        <div class="step-title">${esc(s.title||'')}</div>
      </div>
      <div class="step-body">
        <div class="step-text">${esc(s.instruction)}</div>
        ${s.equipment?`<div class="step-equip">🔥 ${esc(s.equipment)}</div>`:''}
        ${hasScience?`<button class="step-science-toggle" onclick="event.stopPropagation();this.nextElementSibling.classList.toggle('open');this.querySelector('.stgl').textContent=this.nextElementSibling.classList.contains('open')?'▲':'▼'">Nauka + wskazówka <span class="stgl">▼</span></button>
        <div class="step-science-body">
          ${s.why?`<div class="step-why">${esc(s.why)}</div>`:''}
          ${s.tip?`<div class="step-tip">💡 ${esc(s.tip)}</div>`:''}
        </div>`:''}
        <div class="step-actions">
          ${s.timer_seconds?`<button class="step-timer-btn" onclick="event.stopPropagation();startTimer(${s.timer_seconds},'${esc(s.title||'').replace(/'/g,'')}',this)">⏱ ${fmtT(s.timer_seconds)}</button>`:''}
          <button class="step-fix-btn" onclick="event.stopPropagation();fixStep(${s.number},'${esc(s.title||'').replace(/'/g,'')}','${esc(recipeTitle||'').replace(/'/g,'')}')" title="Pomoc z krokiem">SOS</button>
        </div>
      </div>
    </div>`;
  }).join('');
  return `<div class="steps-progress">${dots}</div>${stepsH}`;
}

function activateStep(el,idx){
  const container=el.closest('.section-body-inner');
  container.querySelectorAll('.step').forEach((s,i)=>{
    s.classList.toggle('active',i===idx);
  });
  // Update progress dots
  const dots=el.closest('.section-body-inner').querySelectorAll('.prog-dot');
  dots.forEach((d,i)=>{
    d.classList.remove('active','done');
    if(i<idx) d.classList.add('done');
    else if(i===idx) d.classList.add('active');
  });
}

// Legacy bSteps (used in step mode / buildRecipeHTML)
function bSteps(st,recipeTitle){return st.map(s=>{let h='<div class="step"><div class="step-header"><span class="step-num">'+s.number+'</span><span class="step-title">'+esc(s.title||'')+'</span></div><div class="step-body" style="display:block"><div class="step-text">'+esc(s.instruction)+'</div>';if(s.equipment)h+='<div class="step-equip">🔥 '+esc(s.equipment)+'</div>';if(s.why)h+='<div class="step-why">'+esc(s.why)+'</div>';if(s.tip)h+='<div class="step-tip">💡 '+esc(s.tip)+'</div>';const actions=[];if(s.timer_seconds)actions.push('<button class="step-timer-btn" onclick="startTimer('+s.timer_seconds+',\''+esc(s.title||'').replace(/'/g,'')+'\',this)">⏱'+fmtT(s.timer_seconds)+'</button>');actions.push('<button class="step-fix-btn" onclick="fixStep('+s.number+',\''+esc(s.title||'').replace(/'/g,'')+'\',\''+esc(recipeTitle||'').replace(/'/g,'')+'\')">SOS</button>');if(actions.length)h+='<div class="step-actions">'+actions.join('')+'</div>';return h+'</div></div>'}).join('')}

// ─── Rate recipe ───
function rateRecipe(btn){
  const r=getRecipe(btn);if(!r)return;
  const score=prompt(t('rate.prompt'));
  const comment=prompt(t('rate.comment')) || '';
  fetch(API+'/api/profile',{method:'POST',headers:authHeaders(),
    body:JSON.stringify({rating:{title:r.title,score:+score,comment}})});
  btn.textContent='⭐'+score;btn.classList.add('saved');
}

// ─── Step mode ───
function openStepMode(b){const r=getRecipe(b);if(!r?.steps?.length)return;stepModeData=r;stepModeIndex=0;document.getElementById('stepModeTitle').textContent=r.title;rStep();document.getElementById('stepMode').classList.add('active');document.body.style.overflow='hidden'}
function closeStepMode(){document.getElementById('stepMode').classList.remove('active');document.body.style.overflow=''}
function stepNav(d){stepModeIndex+=d;if(stepModeIndex<0)stepModeIndex=0;if(stepModeIndex>=stepModeData.steps.length){closeStepMode();return}rStep()}
function rStep(){const s=stepModeData.steps[stepModeIndex],tot=stepModeData.steps.length;document.getElementById('stepFill').style.width=((stepModeIndex+1)/tot*100)+'%';document.getElementById('stepPrev').disabled=stepModeIndex===0;document.getElementById('stepNext').textContent=stepModeIndex===tot-1?t('step.done'):t('step.next');let h='<span class="step-num">'+s.number+'</span><div class="step-title">'+esc(s.title||'')+'</div><div class="step-text">'+esc(s.instruction)+'</div>';if(s.equipment)h+='<div class="step-equip" style="margin-top:12px">🔥 '+esc(s.equipment)+'</div>';if(s.why)h+='<div class="step-why" style="margin-top:8px">'+esc(s.why)+'</div>';if(s.tip)h+='<div class="step-tip" style="margin-top:5px">💡 '+esc(s.tip)+'</div>';if(s.timer_seconds)h+='<button class="step-timer-btn" style="margin-top:10px" onclick="startTimer('+s.timer_seconds+',\''+esc(s.title||'').replace(/'/g,'')+'\',this)">⏱'+fmtT(s.timer_seconds)+'</button>';document.getElementById('stepContent').innerHTML=h}

// ─── Timers ───
function startTimer(s,l,b){
  if(b.classList.contains('running'))return;
  b.classList.add('running');
  const id=timerIdCounter++;let rem=s;
  const ov=document.getElementById('timerOverlay');ov.classList.add('active');
  const ch=document.createElement('div');ch.className='timer-chip';ch.id='t'+id;
  ch.innerHTML='<span class="time">'+fmtT(rem)+'</span><span class="label">'+esc(l)+'</span><button class="stop-btn" onclick="stopTimer('+id+')">✕</button>';
  ov.appendChild(ch);
  // Request notification permission on first timer
  if(Notification.permission==='default') Notification.requestPermission();
  timers[id]=setInterval(()=>{
    rem--;
    const tEl=document.querySelector('#t'+id+' .time');
    if(tEl)tEl.textContent=fmtT(rem);
    if(rem<=0){
      clearInterval(timers[id]);
      const c=document.getElementById('t'+id);
      if(c){c.classList.add('done');c.querySelector('.time').textContent='✓'}
      b.classList.remove('running');b.textContent='✓';
      if('vibrate'in navigator)navigator.vibrate([200,100,200]);
      // Push notification via SW
      if(navigator.serviceWorker?.controller){
        navigator.serviceWorker.controller.postMessage({type:'TIMER_DONE',label:l||t('timer.ready')});
      } else if(Notification.permission==='granted'){
        new Notification(t('timer.done_title'),{body:l||t('timer.done_body')});
      }
    }
  },1000);
}
function stopTimer(id){clearInterval(timers[id]);document.getElementById('t'+id)?.remove();const o=document.getElementById('timerOverlay');if(!o.children.length)o.classList.remove('active')}

// ─── Comparison Cards ───
function renderComparison(data){
  const msgs=document.getElementById('messages'),div=document.createElement('div');div.className='msg';
  let h='<div class="comparison-card">';
  h+='<div class="comp-header"><h2>🔀 '+esc(data.topic||t('comp.title'))+'</h2></div>';
  h+='<div class="comp-grid">';
  (data.variants||[]).forEach((v,i)=>{
    const stars='★'.repeat(v.difficulty||3)+'☆'.repeat(5-(v.difficulty||3));
    h+='<div class="comp-variant">';
    h+='<div class="comp-variant-header"><span class="comp-num">'+(i+1)+'</span><span class="comp-method">'+esc(v.method||'')+'</span></div>';
    h+='<div class="comp-meta">';
    if(v.time_min) h+='<span class="comp-pill">⏱'+v.time_min+'m</span>';
    h+='<span class="comp-pill">'+stars+'</span>';
    h+='</div>';
    if(v.texture) h+='<div class="comp-row"><span class="comp-label">'+t('comp.texture')+'</span><span>'+esc(v.texture)+'</span></div>';
    if(v.flavor) h+='<div class="comp-row"><span class="comp-label">'+t('comp.flavor')+'</span><span>'+esc(v.flavor)+'</span></div>';
    if(v.best_for) h+='<div class="comp-row"><span class="comp-label">'+t('comp.best_for')+'</span><span>'+esc(v.best_for)+'</span></div>';
    if(v.equipment) h+='<div class="comp-row"><span class="comp-label">'+t('comp.equipment')+'</span><span class="comp-equip">'+esc(v.equipment)+'</span></div>';
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
