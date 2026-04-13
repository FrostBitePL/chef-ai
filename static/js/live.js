// ─── Live Cooking Mode ───
let liveData=null,liveIndex=0,liveTimerInterval=null,liveTimerRemaining=0,wakeLock=null;

function openLive(btn){
  const r=getRecipe(btn);
  if(!r?.steps?.length) return;
  liveData=r;
  liveIndex=0;
  document.getElementById('liveTitle').textContent=liveData.title;
  document.getElementById('liveMode').classList.add('active');
  document.body.style.overflow='hidden';
  renderLiveStep();
  renderLiveIngredients();
  requestWakeLock();
  // Swipe gestures
  initSwipe();
}

function renderLiveIngredients(){
  const panel=document.getElementById('liveIngredientsPanel');
  if(!liveData?.ingredients?.length){panel.innerHTML='';return}
  let h='';
  liveData.ingredients.forEach(i=>{
    h+='<div class="live-ing-item"><span class="live-ing-amount">'+esc(i.amount)+'</span><span class="live-ing-name">'+esc(i.item)+'</span></div>';
  });
  panel.innerHTML=h;
}

function toggleLiveIngredients(){
  const panel=document.getElementById('liveIngredientsPanel');
  const toggle=document.querySelector('.live-ingredients-toggle');
  if(panel.style.display==='none'){
    panel.style.display='block';
    toggle.textContent=t('live.ingredients')+' ▲';
  }else{
    panel.style.display='none';
    toggle.textContent=t('live.ingredients')+' ▼';
  }
}

function closeLive(){
  document.getElementById('liveMode').classList.remove('active');
  document.body.style.overflow='';
  stopLiveTimer();
  closeLiveHelp();
  releaseWakeLock();
  liveData=null;
}

function liveNav(dir){
  stopLiveTimer();
  liveIndex+=dir;
  if(liveIndex<0) liveIndex=0;
  if(liveIndex>=liveData.steps.length){closeLive();return}
  renderLiveStep();
}

function renderLiveStep(){
  const s=liveData.steps[liveIndex];
  const total=liveData.steps.length;
  // Progress
  document.getElementById('liveProgressFill').style.width=((liveIndex+1)/total*100)+'%';
  document.getElementById('liveStepCount').textContent=t('live.step')+' '+(liveIndex+1)+'/'+total;
  // Nav buttons
  document.getElementById('livePrev').disabled=liveIndex===0;
  document.getElementById('liveNext').textContent=liveIndex===total-1?t('live.done'):t('live.next');
  // Body
  let h='<div class="live-step-num">'+(liveIndex+1)+'</div>';
  h+='<div class="live-step-title">'+esc(s.title||'')+'</div>';
  h+='<div class="live-step-text">'+esc(s.instruction)+'</div>';
  if(s.equipment) h+='<div class="live-equip">🔥 '+esc(s.equipment)+'</div>';
  if(s.why) h+='<div class="live-why">'+esc(s.why)+'</div>';
  if(s.tip) h+='<div class="live-tip">💡 '+esc(s.tip)+'</div>';
  document.getElementById('liveBody').innerHTML=h;
  // Show timer button if step has timer (don't auto-start)
  if(s.timer_seconds && s.timer_seconds>0){
    const bar=document.getElementById('liveTimerBar');
    bar.style.display='flex';
    bar.classList.remove('done');
    document.getElementById('liveTimerTime').textContent=fmtT(s.timer_seconds);
    document.getElementById('liveTimerLabel').textContent=s.title||t('live.step')+' '+(liveIndex+1);
    // Replace stop button with start button
    const stopBtn=document.querySelector('.live-timer-stop');
    stopBtn.textContent='▶ Start';
    stopBtn.onclick=function(){
      startLiveTimer(s.timer_seconds, s.title||t('live.step')+' '+(liveIndex+1));
      stopBtn.textContent='Stop';
      stopBtn.onclick=function(){stopLiveTimer()};
    };
  } else {
    document.getElementById('liveTimerBar').style.display='none';
  }
}

// ─── Live Timer ───
function startLiveTimer(seconds, label){
  stopLiveTimer();
  liveTimerRemaining=seconds;
  document.getElementById('liveTimerBar').style.display='flex';
  document.getElementById('liveTimerLabel').textContent=label;
  updateLiveTimerDisplay();
  liveTimerInterval=setInterval(()=>{
    liveTimerRemaining--;
    updateLiveTimerDisplay();
    if(liveTimerRemaining<=0){
      clearInterval(liveTimerInterval);
      liveTimerInterval=null;
      document.getElementById('liveTimerTime').textContent=t('live.timer_done');
      document.getElementById('liveTimerBar').classList.add('done');
      if('vibrate' in navigator) navigator.vibrate([300,150,300]);
    }
  },1000);
}

function stopLiveTimer(){
  if(liveTimerInterval){clearInterval(liveTimerInterval);liveTimerInterval=null}
  document.getElementById('liveTimerBar').style.display='none';
  document.getElementById('liveTimerBar').classList.remove('done');
}

function updateLiveTimerDisplay(){
  const m=Math.floor(liveTimerRemaining/60);
  const s=liveTimerRemaining%60;
  document.getElementById('liveTimerTime').textContent=m+':'+String(s).padStart(2,'0');
}

// ─── Wake Lock ───
async function requestWakeLock(){
  try{
    if('wakeLock' in navigator){
      wakeLock=await navigator.wakeLock.request('screen');
    }
  }catch(e){console.log('Wake lock failed:',e)}
}

function releaseWakeLock(){
  if(wakeLock){try{wakeLock.release();wakeLock=null}catch{}}
}

// ─── Swipe Gestures ───
function initSwipe(){
  const el=document.getElementById('liveBody');
  let startX=0,startY=0,tracking=false;
  el.ontouchstart=function(e){
    startX=e.touches[0].clientX;
    startY=e.touches[0].clientY;
    tracking=true;
  };
  el.ontouchmove=function(e){
    if(!tracking) return;
    const dx=e.touches[0].clientX-startX;
    const dy=e.touches[0].clientY-startY;
    // Only horizontal swipes
    if(Math.abs(dx)>Math.abs(dy) && Math.abs(dx)>50){
      tracking=false;
      if(dx<0) liveNav(1);  // swipe left = next
      else liveNav(-1);      // swipe right = prev
    }
  };
  el.ontouchend=function(){tracking=false};
}

// ─── Live Help ───
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
  if(!q || !liveData) return;
  const step=liveData.steps[liveIndex];
  const context=t('live.cooking')+liveData.title+'. '+t('live.step')+' '+(liveIndex+1)+': '+step.title+' — '+step.instruction;
  const fullQ=context+'\n\nMój problem: '+q;
  document.getElementById('liveHelpAnswer').innerHTML=loadingDots();
  document.getElementById('liveHelpField').value='';
  try{
    const r=await fetch(API+'/api/ask',{method:'POST',headers:authHeaders(),
      body:JSON.stringify({question:fullQ})});
    const d=await r.json();
    if(d.data?.content){
      document.getElementById('liveHelpAnswer').innerHTML='<div class="live-help-text">'+esc(d.data.content)+'</div>';
    } else {
      document.getElementById('liveHelpAnswer').innerHTML='<div class="live-help-text">'+esc(JSON.stringify(d.data))+'</div>';
    }
  }catch{
    document.getElementById('liveHelpAnswer').innerHTML='<div style="color:var(--danger)">'+t('error.conn')+'</div>';
  }
}
