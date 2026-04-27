// ─── Live Cooking Mode (v2 — JSX spec) ───
let liveData=null,liveSteps=[],liveIndex=0,wakeLock=null;
// Timer state
let lvTimerInitial=0,lvTimerRemaining=0,lvTimerRunning=false,lvTimerInterval=null;

// ─── Build "Przygotowanie" step 0 from ingredients ───
function buildPrepStep(r){
  const ings=r.ingredients||[];
  const mise=r.mise_en_place||[];
  let body='Przed gotowaniem przygotuj wszystkie składniki. Odmierz, pokrój i ustaw w zasięgu ręki — gotowanie pójdzie sprawnie.';
  const ingList=ings.map(i=>'• '+i.amount+' '+i.item+(i.note?' ('+i.note+')':'')).join('\n');
  const miseList=mise.length?'\n\nMise en place:\n'+mise.map(m=>'• '+m).join('\n'):'';
  return {
    number:0,title:'Przygotowanie',
    instruction:body+(ingList?'\n\nSkładniki:\n'+ingList:'')+miseList,
    equipment:null,timer_seconds:null,
    tip:'Przygotowane składniki = spokojne gotowanie bez błędów.',
    why:'Mise en place eliminuje pośpiech i błędy podczas gotowania.',
    stepIngredients:ings,
    isPrep:true
  };
}

function openLive(btn){
  const r=getRecipe(btn);
  if(!r?.steps?.length) return;
  liveData=r;
  // Prepend prep step
  liveSteps=[buildPrepStep(r),...r.steps];
  liveIndex=0;
  document.getElementById('liveTitle').textContent=r.title;
  document.getElementById('liveMode').classList.add('active');
  document.body.style.overflow='hidden';
  renderLiveSegments();
  renderLiveStep();
  requestWakeLock();
  initSwipe();
}

// ─── Render top progress segments ───
function renderLiveSegments(){
  const total=liveSteps.length;
  const seg=document.getElementById('liveSegments');
  if(!seg) return;
  seg.innerHTML=Array.from({length:total},(_,i)=>`<div class="lv-seg" id="lvseg-${i}"></div>`).join('');
}

function updateLiveSegments(){
  liveSteps.forEach((_,i)=>{
    const el=document.getElementById('lvseg-'+i);
    if(!el) return;
    el.classList.remove('done','active');
    if(i<liveIndex) el.classList.add('done');
    else if(i===liveIndex) el.classList.add('active');
  });
}

// ─── Close ───
function closeLive(){
  lvStopTimer();
  closeLiveHelp();
  releaseWakeLock();
  document.getElementById('liveMode').classList.remove('active');
  document.body.style.overflow='';
  liveData=null; liveSteps=[]; liveIndex=0;
}

// ─── Navigation ───
function liveNav(dir){
  lvStopTimer();
  liveIndex+=dir;
  if(liveIndex<0) liveIndex=0;
  if(liveIndex>=liveSteps.length){closeLive();return}
  renderLiveStep();
}

// ─── Render current step ───
function renderLiveStep(){
  const s=liveSteps[liveIndex];
  const total=liveSteps.length;
  const isLast=liveIndex===total-1;
  const isFirst=liveIndex===0;

  // Header
  document.getElementById('liveStepCount').textContent=
    (s.isPrep?'Przygotowanie':'Krok '+s.number)+' z '+(total-1);

  // Segments
  updateLiveSegments();

  // Nav buttons
  const prev=document.getElementById('livePrev');
  const next=document.getElementById('liveNext');
  prev.disabled=isFirst;
  prev.style.opacity=isFirst?'0.35':'1';

  // Next button — last step = Gotowe! (emerald), else gold
  next.className=isLast?'lv-next-btn done':'lv-next-btn';
  next.innerHTML=isLast
    ?`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg> Gotowe!`
    :`Dalej <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>`;

  // Per-step ingredients (from recipe steps, not prep)
  const stepIngs=s.stepIngredients||(s.isPrep?[]:[]);
  const hasIngs=stepIngs.length>0;

  // Science/tip toggle id
  const sciId='lvSci'+liveIndex;

  // Build body HTML
  let h='';

  // Step number badge + title
  h+=`<div class="lv-step-badge${s.isPrep?' prep':''}">${s.isPrep?'🍳':s.number}</div>`;
  h+=`<h1 class="lv-step-title">${esc(s.title||'')}</h1>`;

  // Instruction
  h+=`<p class="lv-step-body">${esc(s.instruction).replace(/\n/g,'<br>')}</p>`;

  // Equipment
  if(s.equipment){
    h+=`<div class="lv-equip">🔥 ${esc(s.equipment)}</div>`;
  }

  // Per-step ingredients chips (toggle)
  if(hasIngs){
    h+=`<button class="lv-toggle-btn" onclick="lvToggleIngs(this)">🧂 Składniki do tego kroku
      <svg class="lv-chv" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="2,4 6,8 10,4"/></svg>
    </button>
    <div class="lv-ing-chips" style="display:none">
      ${stepIngs.map(i=>`<span class="lv-chip">${esc(i.amount)} ${esc(i.item)}</span>`).join('')}
    </div>`;
  }

  // Science + tip (toggle)
  if(s.why||s.tip){
    h+=`<button class="lv-toggle-btn" onclick="lvToggleSci(this)">💡 Nauka + wskazówka
      <svg class="lv-chv" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="2,4 6,8 10,4"/></svg>
    </button>
    <div class="lv-sci-body" style="display:none">
      ${s.why?`<div class="lv-why">${esc(s.why)}</div>`:''}
      ${s.tip?`<div class="lv-tip">💡 ${esc(s.tip)}</div>`:''}
    </div>`;
  }

  // Timer
  if(s.timer_seconds&&s.timer_seconds>0){
    h+=renderLiveTimer(s.timer_seconds);
  }

  // Bottom spacer
  h+='<div style="height:120px"></div>';

  document.getElementById('liveBody').innerHTML=h;
  document.getElementById('liveBody').scrollTop=0;
}

// ─── Toggle helpers ───
function lvToggleIngs(btn){
  const panel=btn.nextElementSibling;
  const open=panel.style.display!=='none';
  panel.style.display=open?'none':'flex';
  btn.querySelector('.lv-chv').style.transform=open?'':'rotate(180deg)';
}
function lvToggleSci(btn){
  const panel=btn.nextElementSibling;
  const open=panel.style.display!=='none';
  panel.style.display=open?'none':'block';
  btn.querySelector('.lv-chv').style.transform=open?'':'rotate(180deg)';
}

// ─── Timer (circular SVG) ───
function renderLiveTimer(seconds){
  const fmt=lvFmt(seconds);
  return `<div class="lv-timer-wrap">
    <button class="lv-timer-start" onclick="lvStartTimer(${seconds},this)">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="var(--bg)" style="margin-bottom:6px"><polygon points="6,3 20,12 6,21"/></svg>
      <span style="font-size:13px;font-weight:700;color:var(--bg);letter-spacing:0.02em">START</span>
      <span style="font-size:22px;font-weight:800;color:var(--bg);font-variant-numeric:tabular-nums;margin-top:2px">${fmt}</span>
    </button>
    <div class="lv-timer-circle" style="display:none">
      <svg class="lv-timer-svg" viewBox="0 0 200 200" width="200" height="200" style="transform:rotate(-90deg)">
        <circle cx="100" cy="100" r="88" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="6"/>
        <circle class="lv-timer-arc" cx="100" cy="100" r="88" fill="none"
          stroke="var(--gold)" stroke-width="6" stroke-linecap="round"
          stroke-dasharray="553" stroke-dashoffset="0"
          style="transition:stroke-dashoffset 1s linear,stroke 0.3s"/>
      </svg>
      <div class="lv-timer-center">
        <span class="lv-timer-time">${fmt}</span>
        <div class="lv-timer-btns">
          <button class="lv-timer-toggle" onclick="lvToggleTimer(this)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
          </button>
          <button class="lv-timer-reset" onclick="lvResetTimer()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
          </button>
        </div>
      </div>
    </div>
  </div>`;
}

function lvStartTimer(seconds, startBtn){
  lvStopTimer();
  lvTimerInitial=seconds;
  lvTimerRemaining=seconds;
  lvTimerRunning=true;

  const wrap=startBtn.closest('.lv-timer-wrap');
  startBtn.style.display='none';
  const circle=wrap.querySelector('.lv-timer-circle');
  circle.style.display='flex';

  lvTimerInterval=setInterval(()=>{
    lvTimerRemaining--;
    lvUpdateTimer(wrap);
    if(lvTimerRemaining<=0){
      lvStopTimer();
      lvTimerDone(wrap);
    }
  },1000);
}

function lvToggleTimer(btn){
  lvTimerRunning=!lvTimerRunning;
  if(lvTimerRunning){
    const wrap=btn.closest('.lv-timer-wrap');
    lvTimerInterval=setInterval(()=>{
      lvTimerRemaining--;
      lvUpdateTimer(wrap);
      if(lvTimerRemaining<=0){lvStopTimer();lvTimerDone(wrap)}
    },1000);
    btn.innerHTML='<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
  } else {
    clearInterval(lvTimerInterval);lvTimerInterval=null;
    btn.innerHTML='<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 20,12 6,21"/></svg>';
  }
}

function lvResetTimer(){
  lvStopTimer();
  // Re-render the step to get a fresh start button
  renderLiveStep();
}

function lvStopTimer(){
  if(lvTimerInterval){clearInterval(lvTimerInterval);lvTimerInterval=null}
  lvTimerRunning=false;
}

function lvUpdateTimer(wrap){
  const circ=2*Math.PI*88; // r=88
  const progress=(lvTimerInitial-lvTimerRemaining)/lvTimerInitial;
  const arc=wrap.querySelector('.lv-timer-arc');
  if(arc) arc.style.strokeDashoffset=(circ*progress).toFixed(2);
  const timeEl=wrap.querySelector('.lv-timer-time');
  if(timeEl) timeEl.textContent=lvFmt(lvTimerRemaining);
}

function lvTimerDone(wrap){
  const arc=wrap.querySelector('.lv-timer-arc');
  if(arc){arc.style.stroke='var(--emerald)';arc.style.strokeDashoffset='0'}
  const timeEl=wrap.querySelector('.lv-timer-time');
  if(timeEl) timeEl.textContent='✓';
  const btns=wrap.querySelector('.lv-timer-btns');
  if(btns) btns.style.display='none';
  if('vibrate' in navigator) navigator.vibrate([300,150,300]);
}

function lvFmt(s){
  const h=Math.floor(s/3600);
  const m=Math.floor((s%3600)/60);
  const sec=s%60;
  if(h>0) return h+':'+String(m).padStart(2,'0')+':'+String(sec).padStart(2,'0');
  return String(m).padStart(2,'0')+':'+String(sec).padStart(2,'0');
}

// ─── Wake Lock ───
async function requestWakeLock(){
  try{if('wakeLock' in navigator) wakeLock=await navigator.wakeLock.request('screen')}
  catch(e){console.log('Wake lock:',e)}
}
function releaseWakeLock(){
  if(wakeLock){try{wakeLock.release()}catch{}; wakeLock=null}
}

// ─── Swipe ───
function initSwipe(){
  const el=document.getElementById('liveBody');
  let startX=0,startY=0,tracking=false;
  el.ontouchstart=e=>{startX=e.touches[0].clientX;startY=e.touches[0].clientY;tracking=true};
  el.ontouchmove=e=>{
    if(!tracking) return;
    const dx=e.touches[0].clientX-startX,dy=e.touches[0].clientY-startY;
    if(Math.abs(dx)>Math.abs(dy)&&Math.abs(dx)>50){
      tracking=false;
      dx<0?liveNav(1):liveNav(-1);
    }
  };
  el.ontouchend=()=>tracking=false;
}

// ─── Help ───
function openLiveHelp(){
  document.getElementById('liveHelpPanel').style.display='flex';
  document.getElementById('liveHelpAnswer').innerHTML='';
  document.getElementById('liveHelpField').value='';
  document.getElementById('liveHelpField').focus();
}
function closeLiveHelp(){
  document.getElementById('liveHelpPanel').style.display='none';
}
async function askLiveHelp(){
  const q=document.getElementById('liveHelpField').value.trim();
  if(!q||!liveData) return;
  const s=liveSteps[liveIndex];
  const context='Gotuję: '+liveData.title+'. Krok '+(liveIndex)+': '+s.title+' — '+s.instruction;
  document.getElementById('liveHelpAnswer').innerHTML=loadingDots();
  document.getElementById('liveHelpField').value='';
  try{
    const r=await fetch(API+'/api/ask',{method:'POST',headers:authHeaders(),
      body:JSON.stringify({question:context+'\n\nMój problem: '+q,lang:currentLang})});
    const d=await r.json();
    document.getElementById('liveHelpAnswer').innerHTML=
      '<div class="live-help-text">'+(d.data?.content?esc(d.data.content):esc(JSON.stringify(d.data)))+'</div>';
  }catch{
    document.getElementById('liveHelpAnswer').innerHTML='<div style="color:var(--danger)">Błąd połączenia</div>';
  }
}
