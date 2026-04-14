// ─── Planner State ───
let _planData=null;
let _activeDayIdx=0;
let _showShoppingList=false;

// ─── Stepper limits ───
const PLAN_LIMITS={planDays:{min:1,max:14,steps:[1,2,3,5,7,10,14]},planPersons:{min:1,max:10,steps:null}};

function planStep(id,dir){
  const el=document.getElementById(id);
  if(!el) return;
  const cur=+(el.dataset.value)||1;
  const lim=PLAN_LIMITS[id];
  let nv;
  if(lim.steps){
    const idx=lim.steps.indexOf(cur);
    const ni=Math.max(0,Math.min(lim.steps.length-1,idx+dir));
    nv=lim.steps[ni];
  } else {
    nv=Math.max(lim.min,Math.min(lim.max,cur+dir));
  }
  el.dataset.value=nv;
  el.textContent=nv;
}

// ─── Chip toggle logic ───
document.addEventListener('click',function(e){
  const chip=e.target.closest('.pf-chip');
  if(!chip)return;
  const inp=chip.querySelector('input');
  if(!inp)return;
  if(inp.type==='checkbox'){
    inp.checked=!inp.checked;
    chip.classList.toggle('active',inp.checked);
  } else if(inp.type==='radio'){
    chip.closest('.pf-chips').querySelectorAll('.pf-chip').forEach(c=>c.classList.remove('active'));
    inp.checked=true;
    chip.classList.add('active');
  }
});

// ─── Collect form data ───
function collectPlanParams(){
  const days=+(document.getElementById('planDays')?.dataset?.value)||7;
  const persons=+(document.getElementById('planPersons')?.dataset?.value)||2;
  const kcal=+(document.getElementById('planKcal')?.value)||0;
  const prefs=(document.getElementById('planPrefs').value||'').trim();
  const meals=[];
  document.querySelectorAll('#mealTypeChips input[type=checkbox]:checked').forEach(c=>meals.push(c.value));
  const diet=(document.querySelector('input[name=diet]:checked')?.value)||'';
  return {days,persons,kcal:kcal||undefined,meals:meals.length?meals:['obiad','kolacja'],diet:diet||undefined,preferences:prefs||undefined};
}

// ─── Generate plan ───
async function generatePlan(){
  const params=collectPlanParams();
  document.getElementById('plannerForm').style.display='none';
  const res=document.getElementById('plannerResult');
  res.style.display='block';res.innerHTML=loadingDots();
  try{
    params.lang=currentLang;
    const r=await fetch(API+'/api/meal-plan',{method:'POST',headers:authHeaders(),body:JSON.stringify(params)});
    const d=await r.json();
    if(d.error){res.innerHTML=`<div style="color:var(--danger);padding:20px">${esc(d.error)}</div><button class="mp-action-btn" style="margin:10px" onclick="resetPlanner()">← Formularz</button>`;return}
    _planData=d.data||d;
    renderMealPlan(_planData,res);
  }catch(e){
    console.error('Plan error:',e);
    res.innerHTML='<div style="color:var(--danger);padding:20px">Błąd generowania planu.</div><button class="mp-action-btn" style="margin:10px" onclick="resetPlanner()">← Formularz</button>';
  }
}

// ─── Day name helpers ───
const DAY_SHORT=['Pon','Wto','Śro','Czw','Pią','Sob','Nie'];
function dayShort(dayStr,idx){
  const lower=(dayStr||'').toLowerCase();
  for(let i=0;i<DAY_SHORT.length;i++){
    if(lower.includes(DAY_SHORT[i].toLowerCase())) return DAY_SHORT[i];
  }
  return 'D'+(idx+1);
}

// ─── Shopping categories ───
const SHOP_CATS=[
  {key:'mięso',emoji:'🥩',name:'Mięso'},
  {key:'ryby',emoji:'🐟',name:'Ryby'},
  {key:'warzywa',emoji:'🥬',name:'Warzywa'},
  {key:'owoce',emoji:'🍎',name:'Owoce'},
  {key:'nabiał',emoji:'🧀',name:'Nabiał'},
  {key:'pieczywo',emoji:'🍞',name:'Pieczywo'},
  {key:'zboża',emoji:'🌾',name:'Zboża i makarony'},
  {key:'tłuszcze',emoji:'🫒',name:'Tłuszcze'},
  {key:'zioła',emoji:'🌿',name:'Zioła'},
  {key:'przyprawy',emoji:'🧂',name:'Przyprawy'},
  {key:'pantry',emoji:'📦',name:'Spiżarnia'},
  {key:'inne',emoji:'📦',name:'Inne'}
];

function categorizeItem(item){
  const s=((item.section||'')+' '+(item.item||'')).toLowerCase();
  if(/mięso|kurczak|wołow|wieprzow|indyk|kaczk|drob|mielon/.test(s)) return 'mięso';
  if(/ryb|łosoś|dorsz|tuńczyk|krewet|owoce morza/.test(s)) return 'ryby';
  if(/warzywa|marchew|bataty|pomidor|cebul|czosn|papryk|szpinak|rukol|sałat|burak|ogór|seler|dyni|brokuł|kalafior|cukini/.test(s)) return 'warzywa';
  if(/owoce|jabłk|banan|cytryn|limon|pomarańcz|jagod|maliny/.test(s)) return 'owoce';
  if(/nabiał|mleko|śmietan|ser |mascarpone|jogurt|jaj|masło/.test(s)) return 'nabiał';
  if(/piecz|chle|bułk/.test(s)) return 'pieczywo';
  if(/makaron|ryż|kasza|mąka|płatki|zboż/.test(s)) return 'zboża';
  if(/oliwa|olej|tłuszcz|smalec/.test(s)) return 'tłuszcze';
  if(/zioła|bazylia|koper|pietruszk|tymian|rozmary|oregano|kolend/.test(s)) return 'zioła';
  if(/przypraw|sól|pieprz|papryka|kurkum|curry|chili|kminek|cynamon/.test(s)) return 'przyprawy';
  if(/pantry|sos|ocet|musztard|ketchup|miód|cukier|konserw/.test(s)) return 'pantry';
  if(item.section){
    const sec=item.section.toLowerCase();
    for(const cat of SHOP_CATS){if(sec.includes(cat.key)) return cat.key;}
  }
  return 'inne';
}

// ─── Render plan (main) ───
function renderMealPlan(data,el){
  if(!data || !data.days || !data.days.length){
    el.innerHTML='<div style="color:var(--danger);padding:20px">Plan nie zawiera danych. Spróbuj ponownie.</div><button class="mp-action-btn" style="margin:10px" onclick="resetPlanner()">← Formularz</button>';
    return;
  }
  _planData=data;_activeDayIdx=0;_showShoppingList=false;
  let h='';
  // Top bar
  h+=`<div class="mp-topbar">
    <button class="mp-topbar-btn" onclick="resetPlanner()">← Nowy plan</button>
    <span class="mp-topbar-title">Plan posiłków</span>
    <button class="mp-topbar-btn" onclick="saveCurrentPlan()">💾 Zapisz</button>
  </div>`;
  // Day tabs
  h+='<div class="mp-day-tabs" id="mpDayTabs">';
  data.days.forEach((day,i)=>{
    h+=`<div class="mp-day-tab${i===0?' active':''}" onclick="switchPlanDay(${i})">
      ${dayShort(day.day,i)}<span class="mp-day-tab-num">${i+1}</span>
    </div>`;
  });
  h+=`<div class="mp-day-tab" onclick="toggleShoppingView()" id="mpShopTab">🛒<span class="mp-day-tab-num">Lista</span></div>`;
  h+='</div>';
  // Day contents (hidden by default, shown via switchPlanDay)
  data.days.forEach((day,di)=>{
    const totalKcal=day.meals?.reduce((s,m)=>s+(+(m.kcal||0)),0)||0;
    h+=`<div class="mp-day-content" id="mpDay${di}" style="${di>0?'display:none':''}">`;
    h+=`<div class="mp-day-header"><div class="mp-day-name">${esc(day.day)}</div>`;
    if(totalKcal) h+=`<div class="mp-day-kcal">Suma: <b>${totalKcal} kcal</b></div>`;
    h+='</div>';
    if(day.meals?.length) day.meals.forEach((m,mi)=>{
      h+=`<div class="mp-meal-card" onclick="openPlanRecipe(${di},${mi})">
        <div class="mp-meal-label">${esc(m.meal||'')}</div>
        <div class="mp-meal-title">${esc(m.title||'')}</div>
        <div class="mp-meal-meta">
          ${m.prep_time?'<span>🕐 '+m.prep_time+'m</span>':''}
          ${m.kcal?'<span class="mp-kcal">🔥 '+m.kcal+' kcal</span>':''}
        </div>
        <span class="mp-meal-open">Otwórz →</span>
      </div>`;
    });
    // Day summary
    if(totalKcal){
      h+=`<div class="mp-day-summary">
        <div class="mp-day-summary-label">Podsumowanie dnia</div>
        <div class="mp-day-summary-vals"><span class="kcal-val">${totalKcal} kcal</span></div>
      </div>`;
    }
    h+='</div>';
  });
  // Shopping list (hidden)
  h+=`<div class="mp-day-content" id="mpShopContent" style="display:none">${renderShoppingList(data.shopping_list||[])}</div>`;
  // Bottom actions
  h+=`<div class="mp-actions">
    <button class="mp-action-btn" onclick="toggleShoppingView()">🛒 Lista zakupów</button>
    <button class="mp-action-btn" onclick="copyPlan()">📋 Kopiuj plan</button>
  </div>`;
  el.innerHTML=h;
}

// ─── Switch day tab ───
function switchPlanDay(idx){
  if(!_planData) return;
  _activeDayIdx=idx;_showShoppingList=false;
  // Tabs
  document.querySelectorAll('.mp-day-tab').forEach((t,i)=>t.classList.toggle('active',i===idx));
  document.getElementById('mpShopTab')?.classList.remove('active');
  // Content
  _planData.days.forEach((_,i)=>{
    const el=document.getElementById('mpDay'+i);
    if(el) el.style.display=i===idx?'':'none';
  });
  const shop=document.getElementById('mpShopContent');
  if(shop) shop.style.display='none';
}

function toggleShoppingView(){
  _showShoppingList=!_showShoppingList;
  document.querySelectorAll('.mp-day-tab').forEach(t=>t.classList.remove('active'));
  const shopTab=document.getElementById('mpShopTab');
  if(shopTab) shopTab.classList.toggle('active',_showShoppingList);
  if(_planData) _planData.days.forEach((_,i)=>{
    const el=document.getElementById('mpDay'+i);
    if(el) el.style.display=_showShoppingList?'none':'';
  });
  // Show only active day when toggling back
  if(!_showShoppingList) switchPlanDay(_activeDayIdx);
  const shop=document.getElementById('mpShopContent');
  if(shop) shop.style.display=_showShoppingList?'':'none';
}

// ─── Render shopping list with categories ───
function renderShoppingList(items){
  if(!items.length) return '<div style="padding:20px;color:var(--text-muted);text-align:center">Brak listy zakupów</div>';
  // Group by category
  const grouped={};
  items.forEach(item=>{
    const cat=categorizeItem(item);
    if(!grouped[cat]) grouped[cat]=[];
    grouped[cat].push(item);
  });
  const totalItems=items.length;
  const totalMeals=_planData?.days?.reduce((s,d)=>s+(d.meals?.length||0),0)||0;
  let h=`<div class="shop-header">
    <div class="shop-header-title">🛒 Lista zakupów</div>
    <div class="shop-header-sub">${_planData?.days?.length||0} dni · ${totalMeals} posiłków · ${totalItems} pozycji</div>
  </div>`;
  h+='<div class="shop-actions">';
  h+='<button class="shop-exp-btn" onclick="copyShoppingList()">📋 Kopiuj</button>';
  h+='</div>';
  SHOP_CATS.forEach(cat=>{
    const catItems=grouped[cat.key];
    if(!catItems?.length) return;
    h+=`<div class="shop-cat open" id="shopCat_${cat.key}">
      <div class="shop-cat-header" onclick="this.parentElement.classList.toggle('open')">
        <span class="shop-cat-emoji">${cat.emoji}</span>
        <span class="shop-cat-name">${cat.name}</span>
        <span class="shop-cat-count">${catItems.length}</span>
        <svg class="shop-cat-chv" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
      </div>
      <div class="shop-cat-items">`;
    catItems.forEach(s=>{
      h+=`<div class="shop-item" onclick="this.classList.toggle('checked')">
        <div class="shop-check">✓</div>
        <div class="shop-amount">${esc(s.amount||'')}</div>
        <div class="shop-name">${esc(s.item||'')}</div>
      </div>`;
    });
    h+='</div></div>';
  });
  return h;
}

function copyShoppingList(){
  if(!_planData?.shopping_list) return;
  let txt='Lista zakupów\n\n';
  const grouped={};
  _planData.shopping_list.forEach(item=>{
    const cat=categorizeItem(item);
    if(!grouped[cat]) grouped[cat]=[];
    grouped[cat].push(item);
  });
  SHOP_CATS.forEach(cat=>{
    if(!grouped[cat.key]?.length) return;
    txt+=cat.emoji+' '+cat.name.toUpperCase()+':\n';
    grouped[cat.key].forEach(s=>txt+=`  ☐ ${s.amount||''} ${s.item}\n`);
    txt+='\n';
  });
  navigator.clipboard?.writeText(txt);
}

// ─── Recipe overlay ───
function openPlanRecipe(di,mi){
  if(!_planData?.days?.[di]?.meals?.[mi]) return;
  const m=_planData.days[di].meals[mi];
  const r=m.recipe||m;
  const ings=r.ingredients||m.ingredients||[];
  const steps=r.steps||m.steps||[];

  let h=`<div style="margin-bottom:16px">
    <div style="font-size:20px;font-weight:800;color:var(--text);line-height:1.3">${esc(m.title||'')}</div>
    <div style="display:flex;gap:12px;margin-top:8px;font-size:13px;color:var(--text-muted)">
      ${m.prep_time?'<span>🕐 '+m.prep_time+' min</span>':''}
      ${m.kcal?'<span style="color:var(--gold)">🔥 '+m.kcal+' kcal</span>':''}
      <span style="text-transform:capitalize">${esc(m.meal||'')}</span>
    </div>
  </div>`;

  if(ings.length){
    h+='<div style="margin-bottom:16px"><div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px">Składniki</div>';
    ings.forEach(i=>{
      if(typeof i==='string'){
        h+=`<div class="shop-item"><div class="shop-amount"></div><div class="shop-name">${esc(i)}</div></div>`;
      } else {
        h+=`<div class="shop-item"><div class="shop-amount">${esc(i.amount||'')}</div><div class="shop-name">${esc(i.item||i.name||'')}</div></div>`;
      }
    });
    h+='</div>';
  }

  if(steps.length){
    h+='<div style="margin-bottom:16px"><div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px">Przygotowanie</div>';
    steps.forEach((s,i)=>{
      const txt=typeof s==='string'?s:(s.instruction||s.text||s.title||'');
      const num=typeof s==='object'?(s.number||i+1):(i+1);
      h+=`<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--glass-border)">
        <span style="display:inline-flex;width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,var(--gold),var(--gold-light));color:var(--bg);font-size:11px;font-weight:700;align-items:center;justify-content:center;flex-shrink:0">${num}</span>
        <span style="font-size:13px;color:var(--text-soft);line-height:1.5">${esc(txt)}</span>
      </div>`;
    });
    h+='</div>';
  }

  // Start cooking button
  if(steps.length){
    h+=`<button class="pf-gen-btn" onclick="closePlanOverlay();openLiveFromPlan(${di},${mi})">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
      Zacznij gotować
    </button>`;
  }

  document.getElementById('planOverlayBody').innerHTML=h;
  document.getElementById('planOverlayBackdrop').classList.add('active');
  document.getElementById('planOverlay').classList.add('active');
  document.body.style.overflow='hidden';
}

function closePlanOverlay(){
  document.getElementById('planOverlayBackdrop').classList.remove('active');
  document.getElementById('planOverlay').classList.remove('active');
  document.body.style.overflow='';
}

// ─── Open Live Cooking from planner ───
function openLiveFromPlan(di,mi){
  if(!_planData?.days?.[di]?.meals?.[mi]) return;
  const m=_planData.days[di].meals[mi];
  const r=m.recipe||m;
  const rawSteps=r.steps||m.steps||[];
  const rawIngs=r.ingredients||m.ingredients||[];
  const steps=rawSteps.map((s,i)=>{
    if(typeof s==='string') return {number:i+1,title:'Krok '+(i+1),instruction:s};
    return {
      number:s.number||i+1,
      title:s.title||'Krok '+(s.number||i+1),
      instruction:s.instruction||s.text||s.title||'',
      equipment:s.equipment||null,
      why:s.why||null,
      tip:s.tip||null,
      timer_seconds:s.timer_seconds||0
    };
  });
  const ingredients=rawIngs.map(i=>{
    if(typeof i==='string') return {amount:'',item:i};
    return {amount:i.amount||'',item:i.item||i.name||''};
  });
  if(!steps.length){alert('Brak kroków');return}
  liveData={title:m.title||'Przepis',steps,ingredients};
  liveIndex=0;
  document.getElementById('liveTitle').textContent=liveData.title;
  document.getElementById('liveMode').classList.add('active');
  document.body.style.overflow='hidden';
  renderLiveStep();
  if(typeof renderLiveIngredients==='function') renderLiveIngredients();
  if(typeof requestWakeLock==='function') requestWakeLock();
  if(typeof initSwipe==='function') initSwipe();
}

// ─── Reset ───
function resetPlanner(){
  document.getElementById('plannerForm').style.display='flex';
  document.getElementById('plannerResult').style.display='none';
  document.getElementById('plannerResult').innerHTML='';
  _planData=null;
}

// ─── Ensure form visible on tab switch ───
function ensurePlannerForm(){
  if(!_planData){
    document.getElementById('plannerForm').style.display='flex';
    document.getElementById('plannerResult').style.display='none';
    document.getElementById('plannerResult').innerHTML='';
  }
}

// ─── Copy plan ───
function copyPlan(){
  if(!_planData)return;
  let txt='Plan posiłków\n\n';
  if(_planData.days) _planData.days.forEach(day=>{
    txt+=day.day+':\n';
    if(day.meals) day.meals.forEach(m=>{
      txt+=`  ${m.meal}: ${m.title}`;
      if(m.prep_time) txt+=` (${m.prep_time}m)`;
      if(m.kcal) txt+=` [${m.kcal} kcal]`;
      txt+='\n';
      const r=m.recipe||m;
      const ings=r.ingredients||[];
      if(ings.length){txt+='    Składniki:\n';ings.forEach(i=>{txt+=typeof i==='string'?`      - ${i}\n`:`      - ${i.amount||''} ${i.item||i.name||''}\n`})}
      const steps=r.steps||[];
      if(steps.length){txt+='    Przygotowanie:\n';steps.forEach((s,si)=>{txt+=typeof s==='string'?`      ${si+1}. ${s}\n`:`      ${s.number||si+1}. ${s.instruction||s.text||''}\n`})}
    });
    txt+='\n';
  });
  if(_planData.shopping_list){txt+='Lista zakupów:\n';_planData.shopping_list.forEach(s=>txt+=`☐ ${s.amount||''} ${s.item}\n`)}
  navigator.clipboard?.writeText(txt).then(()=>{
    const btn=document.querySelector('.mp-actions .mp-action-btn:last-child');
    if(btn){const o=btn.textContent;btn.textContent='✓ Skopiowano';setTimeout(()=>btn.textContent=o,1500)}
  });
}

// ─── Save plan ───
async function saveCurrentPlan(){
  if(!_planData){alert('Brak planu');return}
  const title=prompt('Nazwa planu:','Plan tygodniowy');
  if(!title) return;
  const plan_id='plan_'+Date.now().toString(36);
  try{
    const r=await fetch(API+'/api/planner',{method:'POST',headers:authHeaders(),body:JSON.stringify({plan_id,title,body:_planData})});
    if(!r.ok){const e=await r.json().catch(()=>({}));alert('Błąd: '+(e.error||r.statusText));return}
    const d=await r.json();
    if(d.error){alert('Błąd: '+d.error);return}
    const btn=document.querySelector('.mp-topbar-btn:last-child');
    if(btn){const o=btn.textContent;btn.textContent='✓ Zapisano';setTimeout(()=>btn.textContent=o,2000)}
    renderSavedPlans();
  }catch(e){
    console.error('Save error:',e);
    alert('Błąd zapisu');
  }
}

// ─── Saved plans list ───
async function renderSavedPlans(){
  const list=document.getElementById('savedPlansList');
  if(!list) return;
  try{
    const r=await fetch(API+'/api/planner',{headers:authHeaders()});
    if(!r.ok){list.innerHTML='<div style="padding:8px;color:var(--text-faint);font-size:13px">Błąd ładowania</div>';return}
    const d=await r.json();
    if(d.error){list.innerHTML=`<div style="padding:8px;color:var(--danger);font-size:13px">${esc(d.error)}</div>`;return}
    const plans=d.plans||[];
    if(!plans.length){list.innerHTML='<div style="padding:8px;color:var(--text-faint);font-size:13px">Brak zapisanych planów</div>';return}
    list.innerHTML=plans.map(p=>`<div class="pf-saved-item"><span class="pf-saved-title" onclick="loadSavedPlan('${esc(p.id)}')">${esc(p.title)}</span><span class="pf-saved-date">${new Date(p.created_at).toLocaleDateString('pl')}</span><button class="pf-saved-del" onclick="deleteSavedPlan('${esc(p.id)}')" title="Usuń">🗑</button></div>`).join('');
  }catch(e){
    console.error('Saved plans error:',e);
    list.innerHTML='<div style="padding:8px;color:var(--danger);font-size:13px">Błąd</div>';
  }
}

// ─── Load saved plan ───
async function loadSavedPlan(id){
  const res=document.getElementById('plannerResult');
  res.style.display='block';
  document.getElementById('plannerForm').style.display='none';
  res.innerHTML=loadingDots();
  try{
    const r=await fetch(`${API}/api/planner/${id}`,{headers:authHeaders()});
    const d=await r.json();
    if(d.error){res.innerHTML=`<div style="color:var(--danger);padding:20px">${esc(d.error)}</div><button class="mp-action-btn" style="margin:10px" onclick="resetPlanner()">← Formularz</button>`;return}
    _planData=d.plan;
    renderMealPlan(d.plan,res);
  }catch(e){
    console.error('Load plan error:',e);
    res.innerHTML='<div style="color:var(--danger);padding:20px">Błąd ładowania</div><button class="mp-action-btn" style="margin:10px" onclick="resetPlanner()">← Formularz</button>';
  }
}

// ─── Delete saved plan ───
async function deleteSavedPlan(id){
  if(!confirm('Usunąć ten plan?')) return;
  try{
    await fetch(`${API}/api/planner/${id}`,{method:'DELETE',headers:authHeaders()});
    renderSavedPlans();
  }catch{alert('Błąd usuwania')}
}
