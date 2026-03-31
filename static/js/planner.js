// ─── Planner State ───
let _planData=null;
let _mealIdx=0;

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
  const days=+(document.getElementById('planDays').value)||7;
  const persons=+(document.getElementById('planPersons').value)||2;
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
    const r=await fetch(API+'/api/meal-plan',{method:'POST',headers:authHeaders(),body:JSON.stringify(params)});
    const d=await r.json();
    if(d.error){res.innerHTML=`<div style="color:var(--danger);padding:20px">${esc(d.error)}</div><button class="action-btn" style="margin:10px" onclick="resetPlanner()">← Wróć</button>`;return}
    _planData=d.data;
    renderMealPlan(_planData,res);
  }catch(e){
    console.error('Plan error:',e);
    res.innerHTML='<div style="color:var(--danger);padding:20px">Błąd generowania planu.</div><button class="action-btn" style="margin:10px" onclick="resetPlanner()">← Wróć</button>';
  }
}

// ─── Render plan ───
function renderMealPlan(data,el){
  _planData=data;_mealIdx=0;
  let h=`<div class="meal-plan-card"><div class="meal-plan-header"><h2>📅 Plan posiłków</h2><div class="recipe-actions"><button class="action-btn" onclick="saveCurrentPlan()">💾 Zapisz</button><button class="action-btn" onclick="resetPlanner()">← Nowy</button><button class="action-btn" onclick="copyPlan()">📋 Kopiuj</button></div></div>`;
  if(data.days?.length) data.days.forEach((day,di)=>{
    h+=`<div class="meal-day"><div class="meal-day-title">${esc(day.day)}</div>`;
    if(day.meals?.length) day.meals.forEach((m,mi)=>{
      const uid='rd_'+di+'_'+mi;
      const hasRecipe=m.ingredients?.length || m.steps?.length || m.recipe;
      h+=`<div class="meal-item" style="flex-wrap:wrap"><span class="meal-type">${esc(m.meal||'')}</span><span style="flex:1">${esc(m.title||'')}${m.prep_time?' · '+m.prep_time+'m':''}${m.kcal?' · <span style="color:var(--warning)">'+m.kcal+' kcal</span>':''}</span>`;
      if(hasRecipe) h+=`<button class="action-btn" style="margin-left:auto" onclick="toggleRecipeDetail('${uid}')">👁 Przepis</button>`;
      h+=buildRecipeDetail(m,uid);
      h+='</div>';
    });
    h+='</div>';
  });
  if(data.shopping_list?.length){
    h+='<div style="padding:12px 16px;border-top:1px solid var(--border)"><div style="font-weight:600;margin-bottom:8px">🛒 Lista zakupów</div>';
    data.shopping_list.forEach(s=>{
      h+=`<div class="shop-item" onclick="this.classList.toggle('checked')"><div class="shop-check">✓</div><div class="shop-amount">${esc(s.amount||'')}</div><div class="shop-name">${esc(s.item||'')}</div>`;
      if(s.section) h+=`<div class="shop-section-tag">${esc(s.section)}</div>`;
      if(s.sources) h+=`<div style="font-size:0.65rem;color:var(--text-dim);margin-left:auto">→ ${esc(Array.isArray(s.sources)?s.sources.join(', '):s.sources)}</div>`;
      h+='</div>';
    });
    h+='</div>';
  }
  h+='</div>';
  el.innerHTML=h;
}

// ─── Inline recipe detail ───
function buildRecipeDetail(m,uid){
  const r=m.recipe||m;
  const ings=r.ingredients||m.ingredients||[];
  const steps=r.steps||m.steps||[];
  if(!ings.length&&!steps.length) return '';
  let h=`<div class="plan-recipe-detail" id="${uid}">`;
  if(ings.length){
    h+='<h4>Składniki</h4>';
    ings.forEach(i=>{
      if(typeof i==='string'){h+=`<div class="plan-recipe-ing"><span>${esc(i)}</span></div>`}
      else{h+=`<div class="plan-recipe-ing"><span class="amt">${esc(i.amount||'')}</span><span>${esc(i.item||i.name||'')}</span></div>`}
    });
  }
  if(steps.length){
    h+='<h4 style="margin-top:8px">Przygotowanie</h4>';
    steps.forEach((s,i)=>{
      if(typeof s==='string'){h+=`<div class="plan-recipe-step"><span class="snum">${i+1}</span>${esc(s)}</div>`}
      else{h+=`<div class="plan-recipe-step"><span class="snum">${s.number||i+1}</span>${esc(s.instruction||s.text||s.title||'')}</div>`}
    });
  }
  if(steps.length){
    const coords=uid.replace('rd_','').split('_');
    h+=`<button class="action-btn live-cook-btn" style="margin-top:10px" onclick="openLiveFromPlan(${coords[0]},${coords[1]})">🔴 Gotujemy!</button>`;
  }
  h+='</div>';
  return h;
}

function toggleRecipeDetail(uid){
  const el=document.getElementById(uid);
  if(el) el.classList.toggle('open');
}

// ─── Open Live Cooking from planner ───
function openLiveFromPlan(di,mi){
  if(!_planData?.days?.[di]?.meals?.[mi]) return;
  const m=_planData.days[di].meals[mi];
  const r=m.recipe||m;
  const rawSteps=r.steps||m.steps||[];
  const rawIngs=r.ingredients||m.ingredients||[];
  // Normalize steps to Live mode format
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
  // Normalize ingredients
  const ingredients=rawIngs.map(i=>{
    if(typeof i==='string') return {amount:'',item:i};
    return {amount:i.amount||'',item:i.item||i.name||''};
  });
  if(!steps.length){alert('Brak kroków do gotowania.');return}
  // Set liveData directly and open Live mode
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
  _planData=null;
}

// ─── Copy ───
function copyPlan(){
  if(!_planData)return;
  let t='PLAN POSIŁKÓW\n\n';
  if(_planData.days) _planData.days.forEach(day=>{
    t+=day.day+':\n';
    if(day.meals) day.meals.forEach(m=>{
      t+=`  ${m.meal}: ${m.title}`;
      if(m.prep_time) t+=` (${m.prep_time}m)`;
      if(m.kcal) t+=` [${m.kcal} kcal]`;
      t+='\n';
      const r=m.recipe||m;
      const ings=r.ingredients||[];
      if(ings.length){t+='    Składniki:\n';ings.forEach(i=>{t+=typeof i==='string'?`      - ${i}\n`:`      - ${i.amount||''} ${i.item||i.name||''}\n`})}
      const steps=r.steps||[];
      if(steps.length){t+='    Kroki:\n';steps.forEach((s,si)=>{t+=typeof s==='string'?`      ${si+1}. ${s}\n`:`      ${s.number||si+1}. ${s.instruction||s.text||''}\n`})}
    });
    t+='\n';
  });
  if(_planData.shopping_list){t+='ZAKUPY:\n';_planData.shopping_list.forEach(s=>t+=`☐ ${s.amount||''} ${s.item}\n`)}
  navigator.clipboard?.writeText(t).then(()=>{
    const btn=document.querySelector('.meal-plan-header .action-btn:last-child');
    if(btn){const o=btn.textContent;btn.textContent='✓ Skopiowano';setTimeout(()=>btn.textContent=o,1500)}
  });
}

// ─── Save plan ───
async function saveCurrentPlan(){
  if(!_planData){alert('Brak planu do zapisania.');return}
  const title=prompt('Nadaj nazwę planowi:','Plan posiłków');
  if(!title) return;
  const plan_id='plan_'+Date.now().toString(36);
  try{
    const r=await fetch(API+'/api/planner',{method:'POST',headers:authHeaders(),body:JSON.stringify({plan_id,title,body:_planData})});
    if(!r.ok){const e=await r.json().catch(()=>({}));alert('Błąd zapisu: '+(e.error||r.statusText));return}
    const d=await r.json();
    if(d.error){alert('Błąd zapisu: '+d.error);return}
    const btn=document.querySelector('.meal-plan-header .action-btn');
    if(btn){btn.textContent='✓ Zapisano';btn.classList.add('saved');setTimeout(()=>{btn.textContent='💾 Zapisz';btn.classList.remove('saved')},2000)}
    renderSavedPlans();
  }catch(e){
    console.error('Save error:',e);
    alert('Błąd zapisu planu. Sprawdź konsolę.');
  }
}

// ─── Saved plans list ───
async function renderSavedPlans(){
  const list=document.getElementById('savedPlansList');
  if(!list) return;
  try{
    const r=await fetch(API+'/api/planner',{headers:authHeaders()});
    if(!r.ok){list.innerHTML='<div style="padding:8px;color:var(--text-faint);font-size:0.8rem">Nie udało się wczytać planów.</div>';return}
    const d=await r.json();
    if(d.error){list.innerHTML=`<div style="padding:8px;color:var(--danger);font-size:0.8rem">${esc(d.error)}</div>`;return}
    const plans=d.plans||[];
    if(!plans.length){list.innerHTML='<div style="padding:8px;color:var(--text-faint);font-size:0.8rem">Brak zapisanych planów.</div>';return}
    list.innerHTML=plans.map(p=>`<div class="pf-saved-item"><span class="pf-saved-title" onclick="loadSavedPlan('${esc(p.id)}')">${esc(p.title)}</span><span class="pf-saved-date">${new Date(p.created_at).toLocaleDateString()}</span><button class="pf-saved-del" onclick="deleteSavedPlan('${esc(p.id)}')">✕</button></div>`).join('');
  }catch(e){
    console.error('Saved plans error:',e);
    list.innerHTML='<div style="padding:8px;color:var(--danger);font-size:0.8rem">Błąd.</div>';
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
    if(d.error){res.innerHTML=`<div style="color:var(--danger);padding:20px">${esc(d.error)}</div><button class="action-btn" style="margin:10px" onclick="resetPlanner()">← Wróć</button>`;return}
    _planData=d.plan;
    renderMealPlan(d.plan,res);
  }catch(e){
    console.error('Load plan error:',e);
    res.innerHTML='<div style="color:var(--danger);padding:20px">Błąd wczytywania.</div><button class="action-btn" style="margin:10px" onclick="resetPlanner()">← Wróć</button>';
  }
}

// ─── Delete saved plan ───
async function deleteSavedPlan(id){
  if(!confirm('Usunąć ten plan?')) return;
  try{
    await fetch(`${API}/api/planner/${id}`,{method:'DELETE',headers:authHeaders()});
    renderSavedPlans();
  }catch{alert('Błąd usuwania.')}
}
