// ═══ Planner State ═══
let _planData=null;      // final plan (after finalize) or null
let _draftData=null;     // draft plan (titles only)
let _draftAccepted={};   // {di_mi: true} — accepted meals
let _draftParams={};     // form params stored for swap calls
let _activeDayIdx=0;
let _showShoppingList=false;
let _planMode='form';    // 'form' | 'draft' | 'loading' | 'final'

// ═══ Stepper limits ═══
const PLAN_LIMITS={planDays:{min:1,max:14,steps:[1,2,3,5,7,10,14]},planPersons:{min:1,max:10,steps:null}};
function planStep(id,dir){
  const el=document.getElementById(id);if(!el) return;
  const cur=+(el.dataset.value)||1;const lim=PLAN_LIMITS[id];let nv;
  if(lim.steps){const idx=lim.steps.indexOf(cur);nv=lim.steps[Math.max(0,Math.min(lim.steps.length-1,idx+dir))];}
  else{nv=Math.max(lim.min,Math.min(lim.max,cur+dir));}
  el.dataset.value=nv;el.textContent=nv;
}

// ═══ Chip toggle ═══
document.addEventListener('click',function(e){
  const chip=e.target.closest('.pf-chip');if(!chip)return;
  const inp=chip.querySelector('input');if(!inp)return;
  if(inp.type==='checkbox'){inp.checked=!inp.checked;chip.classList.toggle('active',inp.checked);}
  else if(inp.type==='radio'){chip.closest('.pf-chips').querySelectorAll('.pf-chip').forEach(c=>c.classList.remove('active'));inp.checked=true;chip.classList.add('active');}
});

// ═══ Collect form ═══
function collectPlanParams(){
  const days=+(document.getElementById('planDays')?.dataset?.value)||7;
  const persons=+(document.getElementById('planPersons')?.dataset?.value)||2;
  const kcal=+(document.getElementById('planKcal')?.value)||0;
  const prefs=(document.getElementById('planPrefs').value||'').trim();
  const meals=[];document.querySelectorAll('#mealTypeChips input[type=checkbox]:checked').forEach(c=>meals.push(c.value));
  const diet=(document.querySelector('input[name=diet]:checked')?.value)||'';
  return {days,persons,kcal:kcal||undefined,meals:meals.length?meals:['obiad','kolacja'],diet:diet||undefined,preferences:prefs||undefined};
}

// ═══ Day name helpers ═══
const DAY_SHORT=['Pon','Wto','Śro','Czw','Pią','Sob','Nie'];
function dayShort(s,i){const l=(s||'').toLowerCase();for(let j=0;j<DAY_SHORT.length;j++){if(l.includes(DAY_SHORT[j].toLowerCase()))return DAY_SHORT[j];}return 'D'+(i+1);}

// ═══ Shopping categories ═══
const SHOP_CATS=[
  {key:'mięso',emoji:'🥩',name:'Mięso'},{key:'ryby',emoji:'🐟',name:'Ryby'},
  {key:'warzywa',emoji:'🥬',name:'Warzywa'},{key:'owoce',emoji:'🍎',name:'Owoce'},
  {key:'nabiał',emoji:'🧀',name:'Nabiał'},{key:'pieczywo',emoji:'🍞',name:'Pieczywo'},
  {key:'zboża',emoji:'🌾',name:'Zboża i makarony'},{key:'tłuszcze',emoji:'🫒',name:'Tłuszcze'},
  {key:'zioła',emoji:'🌿',name:'Zioła'},{key:'przyprawy',emoji:'🧂',name:'Przyprawy'},
  {key:'pantry',emoji:'📦',name:'Spiżarnia'},{key:'inne',emoji:'📦',name:'Inne'}
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
  if(item.section){const sec=item.section.toLowerCase();for(const cat of SHOP_CATS){if(sec.includes(cat.key))return cat.key;}}
  return 'inne';
}

// ═══════════════════════════════════════
//  STEP 1: Generate Draft (titles only)
// ═══════════════════════════════════════
async function generatePlan(){
  const params=collectPlanParams();
  _draftParams=params;
  document.getElementById('plannerForm').style.display='none';
  const res=document.getElementById('plannerResult');
  res.style.display='block';res.innerHTML=loadingDots();
  _planMode='draft';
  try{
    params.lang=currentLang;
    const r=await fetch(API+'/api/plan/draft',{method:'POST',headers:authHeaders(),body:JSON.stringify(params)});
    const d=await r.json();
    if(d.error){res.innerHTML=`<div style="color:var(--danger);padding:20px">${esc(d.error)}</div><button class="mp-action-btn" style="margin:10px" onclick="resetPlanner()">← Formularz</button>`;return;}
    _draftData=d.data||d;
    _draftAccepted={};
    if(!_draftData?.days?.length){res.innerHTML='<div style="color:var(--danger);padding:20px">Plan nie zawiera danych.</div><button class="mp-action-btn" style="margin:10px" onclick="resetPlanner()">← Formularz</button>';return;}
    renderDraftPlan();
  }catch(e){
    console.error('Draft error:',e);
    res.innerHTML='<div style="color:var(--danger);padding:20px">Błąd generowania.</div><button class="mp-action-btn" style="margin:10px" onclick="resetPlanner()">← Formularz</button>';
  }
}

// ═══ Render Draft Plan ═══
function renderDraftPlan(){
  const data=_draftData;if(!data?.days) return;
  _activeDayIdx=0;_showShoppingList=false;
  const el=document.getElementById('plannerResult');
  const totalMeals=data.days.reduce((s,d)=>s+(d.meals?.length||0),0);
  const acceptedCount=Object.keys(_draftAccepted).length;
  let h='';
  // Top bar
  h+=`<div class="mp-topbar">
    <button class="mp-topbar-btn" onclick="resetPlanner()">← Nowy plan</button>
    <span class="mp-topbar-title">Przegląd planu</span>
    <span></span>
  </div>`;
  // Day tabs
  h+='<div class="mp-day-tabs" id="mpDayTabs">';
  data.days.forEach((day,i)=>{
    h+=`<div class="mp-day-tab${i===0?' active':''}" onclick="switchDraftDay(${i})">${dayShort(day.day,i)}<span class="mp-day-tab-num">${i+1}</span></div>`;
  });
  h+='</div>';
  // Day contents
  data.days.forEach((day,di)=>{
    const totalKcal=day.meals?.reduce((s,m)=>s+(+(m.kcal||0)),0)||0;
    h+=`<div class="mp-day-content" id="mpDay${di}" style="${di>0?'display:none':''}">`;
    h+=`<div class="mp-day-header"><div class="mp-day-name">${esc(day.day)}</div>`;
    if(totalKcal) h+=`<div class="mp-day-kcal">Suma: <b>${totalKcal} kcal</b></div>`;
    h+='</div>';
    if(day.meals?.length) day.meals.forEach((m,mi)=>{
      const key=di+'_'+mi;
      const isAccepted=!!_draftAccepted[key];
      const isSwapped=!!m._swapped;
      let cardClass='mp-meal-card draft';
      if(isAccepted) cardClass+=' accepted-card';
      else if(isSwapped) cardClass+=' swapped-card';
      h+=`<div class="${cardClass}" id="draftCard_${key}">
        <div class="mp-meal-label">${esc(m.meal||'')}</div>
        <div class="mp-meal-title">${esc(m.title||'')}</div>
        <div class="mp-meal-meta">
          ${m.prep_time?'<span>🕐 '+m.prep_time+'m</span>':''}
          ${m.kcal?'<span class="mp-kcal">🔥 '+m.kcal+' kcal</span>':''}
        </div>
        <div class="mp-draft-actions">
          <button class="mp-draft-btn" onclick="event.stopPropagation();openSwapDrawer(${di},${mi})">🔄 Zmień</button>
          <button class="mp-draft-btn${isAccepted?' accepted':''}" id="draftOk_${key}" onclick="event.stopPropagation();toggleDraftAccept(${di},${mi})">
            ${isAccepted?'✓ Zaakceptowane':'✓ OK'}
          </button>
        </div>
      </div>`;
    });
    h+='</div>';
  });
  // Acceptance footer
  h+=`<div class="mp-accept-footer" id="mpAcceptFooter">
    <div class="mp-accept-progress-text">Zaakceptowane: <b>${acceptedCount}</b>/<b>${totalMeals}</b> dań</div>
    <div class="mp-accept-bar"><div class="mp-accept-bar-fill" style="width:${totalMeals?Math.round(acceptedCount/totalMeals*100):0}%"></div></div>
    <button class="mp-accept-btn ${acceptedCount>=totalMeals?'ready':'partial'}" onclick="finalizePlan()">
      ${acceptedCount>=totalMeals?'✓ Akceptuj plan i generuj przepisy':'✓ Akceptuj plan ('+(totalMeals-acceptedCount)+' niezmienionych dań zostanie zachowanych)'}
    </button>
  </div>`;
  el.innerHTML=h;
}

function switchDraftDay(idx){
  _activeDayIdx=idx;
  document.querySelectorAll('.mp-day-tab').forEach((t,i)=>t.classList.toggle('active',i===idx));
  _draftData.days.forEach((_,i)=>{const el=document.getElementById('mpDay'+i);if(el)el.style.display=i===idx?'':'none';});
}

function toggleDraftAccept(di,mi){
  const key=di+'_'+mi;
  if(_draftAccepted[key]) delete _draftAccepted[key];
  else _draftAccepted[key]=true;
  renderDraftPlan();
  // Restore active day
  if(_activeDayIdx>0) switchDraftDay(_activeDayIdx);
}

// ═══════════════════════════════════════
//  STEP 2: Swap Drawer
// ═══════════════════════════════════════
let _swapDi=0,_swapMi=0;

function openSwapDrawer(di,mi){
  _swapDi=di;_swapMi=mi;
  const m=_draftData.days[di].meals[mi];
  const day=_draftData.days[di];
  let h=`<div class="swap-header-label">Zmień: ${esc((m.meal||'').toUpperCase())}, ${esc(day.day)}</div>`;
  h+=`<div class="swap-header-current">${esc(m.title||'')}</div>`;
  h+=`<button class="swap-randomize" onclick="loadSwapSuggestions()">🎲 Losuj inne propozycje</button>`;
  h+=`<div class="swap-suggestions-label">Propozycje:</div>`;
  h+=`<div id="swapSuggestionsList"><div class="swap-skeleton"></div><div class="swap-skeleton"></div><div class="swap-skeleton"></div></div>`;
  h+=`<div class="swap-custom-label" style="margin-top:14px">Lub wpisz własne:</div>`;
  h+=`<div class="swap-custom-wrap">
    <input class="swap-custom-input" id="swapCustomInput" placeholder="np. makaron z łososiem..." onkeydown="if(event.key==='Enter')submitCustomSwap()">
    <button class="swap-custom-send" onclick="submitCustomSwap()">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
    </button>
  </div>`;
  document.getElementById('swapDrawerBody').innerHTML=h;
  document.getElementById('swapDrawerBackdrop').classList.add('active');
  document.getElementById('swapDrawer').classList.add('active');
  document.body.style.overflow='hidden';
  loadSwapSuggestions();
}

function closeSwapDrawer(){
  document.getElementById('swapDrawerBackdrop').classList.remove('active');
  document.getElementById('swapDrawer').classList.remove('active');
  document.body.style.overflow='';
}

async function loadSwapSuggestions(){
  const list=document.getElementById('swapSuggestionsList');
  if(!list) return;
  list.innerHTML='<div class="swap-skeleton"></div><div class="swap-skeleton"></div><div class="swap-skeleton"></div>';
  const m=_draftData.days[_swapDi].meals[_swapMi];
  const day=_draftData.days[_swapDi];
  try{
    const r=await fetch(API+'/api/plan/swap',{method:'POST',headers:authHeaders(),body:JSON.stringify({
      day:day.day, meal_type:m.meal, current_name:m.title,
      diet:_draftParams.diet||'', kcal:_draftParams.kcal||0, lang:currentLang
    })});
    const d=await r.json();
    const sug=d.data?.suggestions||d.suggestions||[];
    if(!sug.length){list.innerHTML='<div style="padding:12px;color:var(--text-muted);font-size:13px">Brak propozycji</div>';return;}
    list.innerHTML=sug.map(s=>`<div class="swap-suggestion" onclick="pickSwapSuggestion('${esc(s.title)}',${s.prep_time||30},${s.kcal||0})">
      <div class="swap-suggestion-info">
        <div class="swap-suggestion-title">${esc(s.title)}</div>
        <div class="swap-suggestion-meta">${s.prep_time?'⏱ '+s.prep_time+'m':''}${s.kcal?' · 🔥 '+s.kcal+' kcal':''}</div>
      </div>
      <span class="swap-suggestion-pick">Wybierz</span>
    </div>`).join('');
  }catch(e){
    console.error('Swap error:',e);
    list.innerHTML='<div style="padding:12px;color:var(--danger);font-size:13px">Błąd ładowania</div>';
  }
}

function pickSwapSuggestion(title,prep_time,kcal){
  const m=_draftData.days[_swapDi].meals[_swapMi];
  m.title=title;m.prep_time=prep_time;m.kcal=kcal;m._swapped=true;
  delete _draftAccepted[_swapDi+'_'+_swapMi];
  closeSwapDrawer();
  renderDraftPlan();
  if(_activeDayIdx>0) switchDraftDay(_activeDayIdx);
}

async function submitCustomSwap(){
  const input=document.getElementById('swapCustomInput');
  const val=(input?.value||'').trim();
  if(!val) return;
  const m=_draftData.days[_swapDi].meals[_swapMi];
  const day=_draftData.days[_swapDi];
  input.disabled=true;
  try{
    const r=await fetch(API+'/api/plan/swap-custom',{method:'POST',headers:authHeaders(),body:JSON.stringify({
      day:day.day, meal_type:m.meal, user_input:val,
      diet:_draftParams.diet||'', kcal:_draftParams.kcal||0, lang:currentLang
    })});
    const d=await r.json();
    const dish=d.data||d;
    if(dish.title){
      m.title=dish.title;m.prep_time=dish.prep_time||30;m.kcal=dish.kcal||0;m._swapped=true;
      delete _draftAccepted[_swapDi+'_'+_swapMi];
      closeSwapDrawer();
      renderDraftPlan();
      if(_activeDayIdx>0) switchDraftDay(_activeDayIdx);
    }
  }catch(e){console.error('Custom swap error:',e);}
  finally{if(input) input.disabled=false;}
}

// ═══════════════════════════════════════
//  STEP 3: Finalize (full recipes)
// ═══════════════════════════════════════
async function finalizePlan(){
  if(!_draftData?.days) return;
  _planMode='loading';
  const el=document.getElementById('plannerResult');
  const allDishes=[];
  _draftData.days.forEach(d=>(d.meals||[]).forEach(m=>allDishes.push(m.title)));
  const total=allDishes.length;
  // Show loading
  el.innerHTML=`<div class="plan-loading-overlay" id="planLoadingOverlay">
    <div class="plan-loading-emoji">🍳</div>
    <div class="plan-loading-title">Generuję przepisy...</div>
    <div class="plan-loading-dish" id="planLoadingDish">${esc(allDishes[0]||'')}</div>
    <div class="plan-loading-bar"><div class="plan-loading-bar-fill" id="planLoadingFill" style="width:5%"></div></div>
    <div class="plan-loading-count" id="planLoadingCount">0/${total}</div>
    <div class="plan-loading-sub" id="planLoadingSub"></div>
  </div>`;
  // Animate dish names
  let dishIdx=0;
  const dishInterval=setInterval(()=>{
    dishIdx=(dishIdx+1)%allDishes.length;
    const dishEl=document.getElementById('planLoadingDish');
    if(dishEl) dishEl.textContent=allDishes[dishIdx];
    const fillEl=document.getElementById('planLoadingFill');
    const pct=Math.min(85,5+dishIdx/allDishes.length*80);
    if(fillEl) fillEl.style.width=pct+'%';
    const countEl=document.getElementById('planLoadingCount');
    if(countEl) countEl.textContent=Math.min(dishIdx+1,total)+'/'+total;
  },2500);
  try{
    const r=await fetch(API+'/api/plan/finalize',{method:'POST',headers:authHeaders(),body:JSON.stringify({
      days:_draftData.days, persons:_draftParams.persons||2, lang:currentLang
    })});
    const d=await r.json();
    clearInterval(dishInterval);
    if(d.error){el.innerHTML=`<div style="color:var(--danger);padding:20px">${esc(d.error)}</div><button class="mp-action-btn" style="margin:10px" onclick="backToDraft()">← Wróć do planu</button>`;return;}
    _planData=d.data||d;
    if(!_planData?.days?.length){el.innerHTML='<div style="color:var(--danger);padding:20px">Błąd generowania przepisów.</div><button class="mp-action-btn" style="margin:10px" onclick="backToDraft()">← Wróć do planu</button>';return;}
    _planMode='final';
    renderFinalPlan();
  }catch(e){
    clearInterval(dishInterval);
    console.error('Finalize error:',e);
    el.innerHTML='<div style="color:var(--danger);padding:20px">Błąd generowania.</div><button class="mp-action-btn" style="margin:10px" onclick="backToDraft()">← Wróć do planu</button>';
  }
}

function backToDraft(){
  _planMode='draft';
  renderDraftPlan();
  if(_activeDayIdx>0) switchDraftDay(_activeDayIdx);
}

// ═══════════════════════════════════════
//  STEP 4: Final Plan (full recipes)
// ═══════════════════════════════════════
function renderFinalPlan(){
  const data=_planData;if(!data?.days) return;
  _activeDayIdx=0;_showShoppingList=false;
  const el=document.getElementById('plannerResult');
  let h='';
  // Top bar
  h+=`<div class="mp-topbar">
    <button class="mp-topbar-btn" onclick="resetPlanner()">← Nowy plan</button>
    <span class="mp-topbar-title">Plan posiłków</span>
    <div><button class="mp-edit-plan-btn" onclick="backToDraft()">✏️ Edytuj</button> <button class="mp-topbar-btn" onclick="saveCurrentPlan()">💾 Zapisz</button></div>
  </div>`;
  // Day tabs
  h+='<div class="mp-day-tabs" id="mpDayTabs">';
  data.days.forEach((day,i)=>{
    h+=`<div class="mp-day-tab${i===0?' active':''}" onclick="switchFinalDay(${i})">${dayShort(day.day,i)}<span class="mp-day-tab-num">${i+1}</span></div>`;
  });
  h+=`<div class="mp-day-tab" onclick="toggleShoppingView()" id="mpShopTab">🛒<span class="mp-day-tab-num">Lista</span></div>`;
  h+='</div>';
  // Day contents
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
    if(totalKcal){
      h+=`<div class="mp-day-summary"><div class="mp-day-summary-label">Podsumowanie dnia</div><div class="mp-day-summary-vals"><span class="kcal-val">${totalKcal} kcal</span></div></div>`;
    }
    h+='</div>';
  });
  h+=`<div class="mp-day-content" id="mpShopContent" style="display:none">${renderShoppingList(data.shopping_list||[])}</div>`;
  h+=`<div class="mp-actions">
    <button class="mp-action-btn" onclick="toggleShoppingView()">🛒 Lista zakupów</button>
    <button class="mp-action-btn" onclick="copyPlan()">📋 Kopiuj plan</button>
  </div>`;
  el.innerHTML=h;
}

function switchFinalDay(idx){
  _activeDayIdx=idx;_showShoppingList=false;
  document.querySelectorAll('.mp-day-tab').forEach((t,i)=>t.classList.toggle('active',i===idx));
  document.getElementById('mpShopTab')?.classList.remove('active');
  _planData.days.forEach((_,i)=>{const el=document.getElementById('mpDay'+i);if(el)el.style.display=i===idx?'':'none';});
  const shop=document.getElementById('mpShopContent');if(shop)shop.style.display='none';
}

function toggleShoppingView(){
  _showShoppingList=!_showShoppingList;
  const src=_planData||_draftData;if(!src) return;
  document.querySelectorAll('.mp-day-tab').forEach(t=>t.classList.remove('active'));
  const st=document.getElementById('mpShopTab');if(st)st.classList.toggle('active',_showShoppingList);
  src.days.forEach((_,i)=>{const el=document.getElementById('mpDay'+i);if(el)el.style.display=_showShoppingList?'none':'';});
  if(!_showShoppingList){if(_planMode==='final')switchFinalDay(_activeDayIdx);else switchDraftDay(_activeDayIdx);}
  const shop=document.getElementById('mpShopContent');if(shop)shop.style.display=_showShoppingList?'':'none';
}

// ═══ Shopping list renderer ═══
function renderShoppingList(items){
  if(!items.length) return '<div style="padding:20px;color:var(--text-muted);text-align:center">Brak listy zakupów</div>';
  const grouped={};items.forEach(item=>{const cat=categorizeItem(item);if(!grouped[cat])grouped[cat]=[];grouped[cat].push(item);});
  const src=_planData||_draftData;
  const totalMeals=src?.days?.reduce((s,d)=>s+(d.meals?.length||0),0)||0;
  let h=`<div class="shop-header"><div class="shop-header-title">🛒 Lista zakupów</div><div class="shop-header-sub">${src?.days?.length||0} dni · ${totalMeals} posiłków · ${items.length} pozycji</div></div>`;
  h+='<div class="shop-actions"><button class="shop-exp-btn" onclick="copyShoppingList()">📋 Kopiuj</button></div>';
  SHOP_CATS.forEach(cat=>{
    const ci=grouped[cat.key];if(!ci?.length)return;
    h+=`<div class="shop-cat open"><div class="shop-cat-header" onclick="this.parentElement.classList.toggle('open')"><span class="shop-cat-emoji">${cat.emoji}</span><span class="shop-cat-name">${cat.name}</span><span class="shop-cat-count">${ci.length}</span><svg class="shop-cat-chv" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg></div><div class="shop-cat-items">`;
    ci.forEach(s=>{h+=`<div class="shop-item" onclick="this.classList.toggle('checked')"><div class="shop-check">✓</div><div class="shop-amount">${esc(s.amount||'')}</div><div class="shop-name">${esc(s.item||'')}</div></div>`;});
    h+='</div></div>';
  });
  return h;
}
function copyShoppingList(){
  const src=_planData||_draftData;if(!src?.shopping_list)return;
  let txt='Lista zakupów\n\n';const grouped={};
  src.shopping_list.forEach(item=>{const cat=categorizeItem(item);if(!grouped[cat])grouped[cat]=[];grouped[cat].push(item);});
  SHOP_CATS.forEach(cat=>{if(!grouped[cat.key]?.length)return;txt+=cat.emoji+' '+cat.name.toUpperCase()+':\n';grouped[cat.key].forEach(s=>txt+=`  ☐ ${s.amount||''} ${s.item}\n`);txt+='\n';});
  navigator.clipboard?.writeText(txt);
}

// ═══ Recipe overlay (final view) ═══
function openPlanRecipe(di,mi){
  if(!_planData?.days?.[di]?.meals?.[mi]) return;
  const m=_planData.days[di].meals[mi];const r=m.recipe||m;
  const ings=r.ingredients||m.ingredients||[];const steps=r.steps||m.steps||[];
  let h=`<div style="margin-bottom:16px"><div style="font-size:20px;font-weight:800;color:var(--text);line-height:1.3">${esc(m.title||'')}</div><div style="display:flex;gap:12px;margin-top:8px;font-size:13px;color:var(--text-muted)">${m.prep_time?'<span>🕐 '+m.prep_time+' min</span>':''}${m.kcal?'<span style="color:var(--gold)">🔥 '+m.kcal+' kcal</span>':''}<span style="text-transform:capitalize">${esc(m.meal||'')}</span></div></div>`;
  if(ings.length){
    h+='<div style="margin-bottom:16px"><div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px">Składniki</div>';
    ings.forEach(i=>{h+=typeof i==='string'?`<div class="shop-item"><div class="shop-amount"></div><div class="shop-name">${esc(i)}</div></div>`:`<div class="shop-item"><div class="shop-amount">${esc(i.amount||'')}</div><div class="shop-name">${esc(i.item||i.name||'')}</div></div>`;});
    h+='</div>';
  }
  if(steps.length){
    h+='<div style="margin-bottom:16px"><div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px">Przygotowanie</div>';
    steps.forEach((s,i)=>{const txt=typeof s==='string'?s:(s.instruction||s.text||s.title||'');const num=typeof s==='object'?(s.number||i+1):(i+1);
      h+=`<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--glass-border)"><span style="display:inline-flex;width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,var(--gold),var(--gold-light));color:var(--bg);font-size:11px;font-weight:700;align-items:center;justify-content:center;flex-shrink:0">${num}</span><span style="font-size:13px;color:var(--text-soft);line-height:1.5">${esc(txt)}</span></div>`;
    });
    h+='</div>';
  }
  if(steps.length){h+=`<button class="pf-gen-btn" onclick="closePlanOverlay();openLiveFromPlan(${di},${mi})"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>Zacznij gotować</button>`;}
  document.getElementById('planOverlayBody').innerHTML=h;
  document.getElementById('planOverlayBackdrop').classList.add('active');
  document.getElementById('planOverlay').classList.add('active');
  document.body.style.overflow='hidden';
}
function closePlanOverlay(){document.getElementById('planOverlayBackdrop').classList.remove('active');document.getElementById('planOverlay').classList.remove('active');document.body.style.overflow='';}

// ═══ Live cooking from plan ═══
function openLiveFromPlan(di,mi){
  if(!_planData?.days?.[di]?.meals?.[mi])return;const m=_planData.days[di].meals[mi];const r=m.recipe||m;
  const rawSteps=r.steps||m.steps||[];const rawIngs=r.ingredients||m.ingredients||[];
  const steps=rawSteps.map((s,i)=>{if(typeof s==='string')return{number:i+1,title:'Krok '+(i+1),instruction:s};return{number:s.number||i+1,title:s.title||'Krok '+(s.number||i+1),instruction:s.instruction||s.text||s.title||'',equipment:s.equipment||null,why:s.why||null,tip:s.tip||null,timer_seconds:s.timer_seconds||0};});
  const ingredients=rawIngs.map(i=>{if(typeof i==='string')return{amount:'',item:i};return{amount:i.amount||'',item:i.item||i.name||''};});
  if(!steps.length){alert('Brak kroków');return;}
  liveData={title:m.title||'Przepis',steps,ingredients};liveIndex=0;
  document.getElementById('liveTitle').textContent=liveData.title;
  document.getElementById('liveMode').classList.add('active');document.body.style.overflow='hidden';
  renderLiveStep();if(typeof renderLiveIngredients==='function')renderLiveIngredients();
  if(typeof requestWakeLock==='function')requestWakeLock();if(typeof initSwipe==='function')initSwipe();
}

// ═══ Utilities ═══
function resetPlanner(){
  document.getElementById('plannerForm').style.display='flex';
  document.getElementById('plannerResult').style.display='none';
  document.getElementById('plannerResult').innerHTML='';
  _planData=null;_draftData=null;_draftAccepted={};_planMode='form';
}
function ensurePlannerForm(){
  if(_planMode==='form'){
    document.getElementById('plannerForm').style.display='flex';
    document.getElementById('plannerResult').style.display='none';
    document.getElementById('plannerResult').innerHTML='';
  }
}
function copyPlan(){
  if(!_planData)return;let txt='Plan posiłków\n\n';
  if(_planData.days)_planData.days.forEach(day=>{txt+=day.day+':\n';if(day.meals)day.meals.forEach(m=>{txt+=`  ${m.meal}: ${m.title}`;if(m.prep_time)txt+=` (${m.prep_time}m)`;if(m.kcal)txt+=` [${m.kcal} kcal]`;txt+='\n';const r=m.recipe||m;const ings=r.ingredients||[];if(ings.length){txt+='    Składniki:\n';ings.forEach(i=>{txt+=typeof i==='string'?`      - ${i}\n`:`      - ${i.amount||''} ${i.item||i.name||''}\n`})}const steps=r.steps||[];if(steps.length){txt+='    Przygotowanie:\n';steps.forEach((s,si)=>{txt+=typeof s==='string'?`      ${si+1}. ${s}\n`:`      ${s.number||si+1}. ${s.instruction||s.text||''}\n`})}});txt+='\n';});
  if(_planData.shopping_list){txt+='Lista zakupów:\n';_planData.shopping_list.forEach(s=>txt+=`☐ ${s.amount||''} ${s.item}\n`)}
  navigator.clipboard?.writeText(txt).then(()=>{const btn=document.querySelector('.mp-actions .mp-action-btn:last-child');if(btn){const o=btn.textContent;btn.textContent='✓ Skopiowano';setTimeout(()=>btn.textContent=o,1500)}});
}
async function saveCurrentPlan(){
  if(!_planData){alert('Brak planu');return;}const title=prompt('Nazwa planu:','Plan tygodniowy');if(!title)return;
  const plan_id='plan_'+Date.now().toString(36);
  try{const r=await fetch(API+'/api/planner',{method:'POST',headers:authHeaders(),body:JSON.stringify({plan_id,title,body:_planData})});
    if(!r.ok){const e=await r.json().catch(()=>({}));alert('Błąd: '+(e.error||r.statusText));return;}const d=await r.json();if(d.error){alert('Błąd: '+d.error);return;}
    const btn=document.querySelector('.mp-topbar-btn:last-child');if(btn){const o=btn.textContent;btn.textContent='✓ Zapisano';setTimeout(()=>btn.textContent=o,2000);}renderSavedPlans();
  }catch(e){console.error('Save error:',e);alert('Błąd zapisu');}
}
async function renderSavedPlans(){
  const list=document.getElementById('savedPlansList');if(!list)return;
  try{const r=await fetch(API+'/api/planner',{headers:authHeaders()});if(!r.ok){list.innerHTML='<div style="padding:8px;color:var(--text-faint);font-size:13px">Błąd ładowania</div>';return;}
    const d=await r.json();if(d.error){list.innerHTML=`<div style="padding:8px;color:var(--danger);font-size:13px">${esc(d.error)}</div>`;return;}
    const plans=d.plans||[];if(!plans.length){list.innerHTML='<div style="padding:8px;color:var(--text-faint);font-size:13px">Brak zapisanych planów</div>';return;}
    list.innerHTML=plans.map(p=>`<div class="pf-saved-item"><span class="pf-saved-title" onclick="loadSavedPlan('${esc(p.id)}')">${esc(p.title)}</span><span class="pf-saved-date">${new Date(p.created_at).toLocaleDateString('pl')}</span><button class="pf-saved-del" onclick="deleteSavedPlan('${esc(p.id)}')" title="Usuń">🗑</button></div>`).join('');
  }catch(e){console.error('Saved plans error:',e);list.innerHTML='<div style="padding:8px;color:var(--danger);font-size:13px">Błąd</div>';}
}
async function loadSavedPlan(id){
  const res=document.getElementById('plannerResult');res.style.display='block';document.getElementById('plannerForm').style.display='none';res.innerHTML=loadingDots();
  try{const r=await fetch(`${API}/api/planner/${id}`,{headers:authHeaders()});const d=await r.json();
    if(d.error){res.innerHTML=`<div style="color:var(--danger);padding:20px">${esc(d.error)}</div><button class="mp-action-btn" style="margin:10px" onclick="resetPlanner()">← Formularz</button>`;return;}
    _planData=d.plan;_planMode='final';renderFinalPlan();
  }catch(e){console.error('Load plan error:',e);res.innerHTML='<div style="color:var(--danger);padding:20px">Błąd ładowania</div><button class="mp-action-btn" style="margin:10px" onclick="resetPlanner()">← Formularz</button>';}
}
async function deleteSavedPlan(id){if(!confirm('Usunąć ten plan?'))return;try{await fetch(`${API}/api/planner/${id}`,{method:'DELETE',headers:authHeaders()});renderSavedPlans();}catch{alert('Błąd usuwania')}}
