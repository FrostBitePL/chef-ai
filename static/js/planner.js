async function generatePlan(){
  const days=document.getElementById('planDays').value,prefs=document.getElementById('planPrefs').value;
  document.getElementById('plannerForm').style.display='none';
  const res=document.getElementById('plannerResult');res.style.display='block';res.innerHTML=loadingDots();
  try{
    const r=await fetch(API+'/api/meal-plan',{method:'POST',headers:authHeaders(),body:JSON.stringify({days:+days,preferences:prefs})});
    const d=await r.json();
    if(d.error){res.innerHTML=`<div style="color:var(--danger);padding:20px">${esc(d.error)}</div><button class="action-btn" style="margin:10px" onclick="resetPlanner()">← Wróć</button>`;return}
    renderMealPlan(d.data,res);
  }catch{res.innerHTML='<div style="color:var(--danger);padding:20px">Błąd.</div><button class="action-btn" style="margin:10px" onclick="resetPlanner()">← Wróć</button>'}
}

function renderMealPlan(data,el){
  let h=`<div class="meal-plan-card"><div class="meal-plan-header"><h2>📅 Plan posiłków</h2></div>`;
  if(data.days?.length)data.days.forEach(day=>{h+=`<div class="meal-day"><div class="meal-day-title">${esc(day.day)}</div>`;
    if(day.meals?.length)day.meals.forEach(m=>h+=`<div class="meal-item"><span class="meal-type">${esc(m.meal||'')}</span><span>${esc(m.title||'')}${m.prep_time?` · ${m.prep_time}m`:''}</span></div>`);
    h+='</div>'});
  if(data.shopping_list?.length){h+='<div style="padding:12px 16px;border-top:1px solid var(--border)"><div style="font-weight:600;margin-bottom:8px">🛒 Zakupy</div>';
    data.shopping_list.forEach(s=>h+=`<div class="shop-item" onclick="this.classList.toggle('checked')"><div class="shop-check">✓</div><div class="shop-amount">${esc(s.amount||'')}</div><div class="shop-name">${esc(s.item||'')}</div>${s.section?`<div class="shop-section-tag">${esc(s.section)}</div>`:''}</div>`);h+='</div>'}
  h+='</div><div style="margin-top:10px;display:flex;gap:8px"><button class="action-btn" onclick="resetPlanner()">← Nowy</button><button class="action-btn" onclick="copyPlan()">📋 Kopiuj</button></div>';
  el.innerHTML=h;el._data=data;
}

function resetPlanner(){document.getElementById('plannerForm').style.display='flex';document.getElementById('plannerResult').style.display='none'}
function copyPlan(){const d=document.getElementById('plannerResult')._data;if(!d)return;let t='PLAN POSIŁKÓW\n\n';
if(d.days)d.days.forEach(day=>{t+=day.day+':\n';if(day.meals)day.meals.forEach(m=>t+=`  ${m.meal}: ${m.title}\n`);t+='\n'});
if(d.shopping_list){t+='ZAKUPY:\n';d.shopping_list.forEach(s=>t+=`☐ ${s.amount} ${s.item}\n`)}
navigator.clipboard?.writeText(t)}
