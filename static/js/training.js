// ─── Progress ───
async function loadProgress(){
  try{const r=await fetch(API+'/api/progress',{headers:authHeaders()});progress=await r.json();if(!progress.modules)progress.modules={}}catch{progress={modules:{}}}
  renderSkillTree();updateProgressSummary();
}
async function savePhaseProgress(mid,phase,done){try{await fetch(API+'/api/progress',{method:'POST',headers:authHeaders(),body:JSON.stringify({module_id:mid,phase,completed:done})});await loadProgress()}catch{}}
async function toggleModuleCompleted(mid,ev){if(ev)ev.stopPropagation();const cur=progress.modules[mid]?.completed||false;try{await fetch(API+'/api/progress',{method:'POST',headers:authHeaders(),body:JSON.stringify({module_id:mid,completed:!cur})});await loadProgress()}catch{}}

function updateProgressSummary(){
  const total=MODULES.length;
  const done=MODULES.filter(m=>progress.modules[m.id]?.completed).length;
  const pct=total?Math.round(done/total*100):0;
  document.getElementById('progressText').textContent=`${done}/${total} (${pct}%)`;
  document.getElementById('progressBarFill').style.width=pct+'%';
}

// ─── Visual Skill Tree ───
function renderSkillTree(){
  const el=document.getElementById('skillTree');
  if(!CATEGORIES.length){el.innerHTML='<div style="padding:20px;color:var(--text-faint)">Ładuję...</div>';return}

  let h='<div class="tree-container">';

  // Filter controls
  h+=`<div class="tree-filter">
    <button class="tree-filter-btn active" onclick="filterTree('all',this)">Wszystkie</button>
    <button class="tree-filter-btn" onclick="filterTree('todo',this)">Do zrobienia</button>
    <button class="tree-filter-btn" onclick="filterTree('progress',this)">W trakcie</button>
    <button class="tree-filter-btn" onclick="filterTree('done',this)">Zaliczone</button>
  </div>`;

  // Render each category as a branch
  CATEGORIES.forEach(cat=>{
    const catMods=MODULES.filter(m=>m.category===cat.id);
    const catDone=catMods.filter(m=>progress.modules[m.id]?.completed).length;
    const catTotal=catMods.length;
    const catPct=catTotal?Math.round(catDone/catTotal*100):0;
    const catClass=catDone===catTotal?'cat-done':catDone>0?'cat-progress':'';

    h+=`<div class="tree-branch ${catClass}" data-cat="${cat.id}">`;
    h+=`<div class="branch-header" onclick="toggleBranch(this)">
      <div class="branch-icon">${cat.icon}</div>
      <div class="branch-info">
        <div class="branch-name">${cat.name}</div>
        <div class="branch-bar"><div class="branch-bar-fill" style="width:${catPct}%;background:${cat.color}"></div></div>
        <div class="branch-stats">${catDone}/${catTotal}</div>
      </div>
      <div class="branch-chevron">▼</div>
    </div>`;

    h+=`<div class="branch-modules">`;
    // Render 3 levels connected
    h+=`<div class="level-path">`;
    catMods.forEach((mod,i)=>{
      const p=progress.modules[mod.id]||{};
      const done=p.completed;
      const inProg=p.theory||p.exercise||p.feedback;
      const cls=done?'node-done':inProg?'node-progress':'node-todo';
      const lvlName=LEVEL_NAMES[mod.level]||mod.level;
      const lvlIcon=mod.level==='basic'?'🟢':mod.level==='intermediate'?'🟡':'🔴';

      const connColor=done?cat.color:'var(--border)';
      const connHTML=i>0?'<div class="connector-line" style="background:'+connColor+'"></div>':'';
      const circleContent=done?'✓':lvlIcon;
      const checkHTML=done?'':'<div class="node-check" onclick="event.stopPropagation();toggleModuleCompleted(\''+mod.id+'\',event)">☐</div>';

      h+='<div class="skill-node '+cls+'" onclick="openModule(\''+mod.id+'\')" style="--node-color:'+cat.color+'">'
        +'<div class="node-connector">'+connHTML+'</div>'
        +'<div class="node-circle">'+circleContent+'</div>'
        +'<div class="node-info">'
        +'<div class="node-level">'+lvlName+'</div>'
        +'<div class="node-dots">'
        +'<span class="ndot '+(p.theory?'on':'')+'">T</span>'
        +'<span class="ndot '+(p.exercise?'on':'')+'">Ć</span>'
        +'<span class="ndot '+(p.feedback?'on':'')+'">F</span>'
        +'</div></div>'
        +checkHTML
        +'</div>';
    });
    h+=`</div></div></div>`;
  });

  h+='</div>';
  el.innerHTML=h;
}

function toggleBranch(header){
  const branch=header.parentElement;
  branch.classList.toggle('expanded');
}

function filterTree(filter,btn){
  document.querySelectorAll('.tree-filter-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.tree-branch').forEach(branch=>{
    const cat=branch.dataset.cat;
    const catMods=MODULES.filter(m=>m.category===cat);
    const catDone=catMods.filter(m=>progress.modules[m.id]?.completed).length;
    const catTotal=catMods.length;
    if(filter==='all') branch.style.display='';
    else if(filter==='done') branch.style.display=catDone===catTotal?'':'none';
    else if(filter==='progress') branch.style.display=(catDone>0&&catDone<catTotal)?'':'none';
    else if(filter==='todo') branch.style.display=catDone===0?'':'none';
  });
}

// ─── Training session ───
function openModule(id){
  currentModule=MODULES.find(m=>m.id===id);
  if(!currentModule)return;
  trainingHistory=[];currentPhase='theory';
  document.getElementById('skillTree').style.display='none';
  document.getElementById('trainingSession').classList.add('active');
  const cat=CATEGORIES.find(c=>c.id===currentModule.category);
  const lvlName=LEVEL_NAMES[currentModule.level]||'';
  document.getElementById('tTitle').textContent=(cat?cat.icon+' ':'')+currentModule.title;
  document.getElementById('tSub').textContent=lvlName;
  updatePhaseTabs();loadPhase('theory');
}
function backToModules(){document.getElementById('trainingSession').classList.remove('active');document.getElementById('skillTree').style.display='block';loadProgress()}
function updatePhaseTabs(){['phaseTheory','phaseExercise','phaseFeedback'].forEach(id=>{const p=id.replace('phase','').toLowerCase();document.getElementById(id).className='phase-tab'+(p===currentPhase?' active':'')});document.getElementById('feedbackInput').style.display=currentPhase==='feedback'?'block':'none'}

async function loadPhase(phase){
  currentPhase=phase;updatePhaseTabs();const tc=document.getElementById('trainingContent');tc.innerHTML=loadingDots();
  if(phase==='feedback'){tc.innerHTML='<div style="text-align:center;padding:30px;color:var(--text-dim)"><div style="font-size:1.8rem;margin-bottom:10px">💬</div>Opisz jak ci poszło ćwiczenie.</div>';return}
  try{
    const r=await fetch(API+'/api/train',{method:'POST',headers:authHeaders(),body:JSON.stringify({module:currentModule.id,phase,conversation_history:trainingHistory})});
    const d=await r.json();if(d.error){tc.innerHTML=`<div style="color:var(--danger);padding:16px">${esc(d.error)}</div>`;return}
    const data=d.data;trainingHistory.push({role:'assistant',content:JSON.stringify(data)});
    if(data.type==='training_theory'){renderTheory(data,tc);savePhaseProgress(currentModule.id,'theory',true)}
    else if(data.type==='recipe'){renderTrainingRecipe(data,tc);savePhaseProgress(currentModule.id,'exercise',true)}
    else tc.innerHTML=`<div class="msg-text" style="margin:0">${esc(data.content||'')}</div>`;
  }catch{tc.innerHTML='<div style="color:var(--danger);padding:16px">Błąd.</div>'}
}

function renderTheory(data,el){
  let h=`<div class="theory-card"><div class="t-header"><h3>${esc(data.title||currentModule.title)}</h3></div><div class="t-body">${esc(data.content||'')}`;
  if(data.key_points?.length){h+='<div style="margin-top:14px;font-weight:600;font-size:0.85rem;margin-bottom:6px">Kluczowe:</div>';data.key_points.forEach(p=>h+=`<div class="key-point">✓ ${esc(p)}</div>`)}
  if(data.exercise_prompt)h+=`<div class="exercise-prompt"><strong>Ćwiczenie:</strong> ${esc(data.exercise_prompt)}</div>`;
  h+='</div></div><div style="margin-top:10px;text-align:center"><button class="action-btn" style="margin:0 auto;padding:9px 18px" onclick="loadPhase(\'exercise\')">👨‍🍳 Ćwiczenie →</button></div>';
  el.innerHTML=h;
}
function renderTrainingRecipe(data,el){
  el.innerHTML=buildRecipeHTML(data)+'<div style="margin-top:10px;text-align:center"><button class="action-btn" style="margin:0 auto;padding:9px 18px" onclick="loadPhase(\'feedback\')">💬 Feedback →</button></div>';
}
function renderFeedback(data,el){
  let h=`<div class="feedback-card"><h3>💬 Analiza</h3><div class="feedback-analysis">${esc(data.analysis||'')}</div>`;
  if(data.tips?.length){h+='<div style="font-weight:600;margin-bottom:4px">Wskazówki:</div>';data.tips.forEach(t=>h+=`<div class="feedback-tip">💡 ${esc(t)}</div>`)}
  if(data.next_steps)h+=`<div class="feedback-next">🎯 ${esc(data.next_steps)}</div>`;
  el.innerHTML=h+'</div>';
}
async function sendFeedback(){
  const q=document.getElementById('feedbackField').value.trim();if(!q)return;
  document.getElementById('feedbackField').value='';trainingHistory.push({role:'user',content:q});
  const tc=document.getElementById('trainingContent');tc.innerHTML=loadingDots();
  try{
    const r=await fetch(API+'/api/train',{method:'POST',headers:authHeaders(),body:JSON.stringify({module:currentModule.id,phase:'feedback',question:q,conversation_history:trainingHistory})});
    const d=await r.json();if(d.error){tc.innerHTML=`<div style="color:var(--danger)">${d.error}</div>`;return}
    trainingHistory.push({role:'assistant',content:JSON.stringify(d.data)});
    if(d.data.type==='training_feedback'){renderFeedback(d.data,tc);savePhaseProgress(currentModule.id,'feedback',true)}
    else tc.innerHTML=`<div class="msg-text" style="margin:0">${esc(d.data.content||'')}</div>`;
  }catch{tc.innerHTML='<div style="color:var(--danger)">Błąd.</div>'}
}
