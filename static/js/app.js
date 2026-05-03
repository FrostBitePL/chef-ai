// ─── State ───
const API='';
let chatHistory=[],favorites=[];
let timers={},timerIdCounter=0,stepModeData=null,stepModeIndex=0;
let currentModule=null,currentPhase='theory',trainingHistory=[],progress={modules:{}};
let chatSessionId=null;
let _appReady=false;
let MODULES=[],CATEGORIES=[],LEVELS=[],LEVEL_NAMES={};

// ─── Supabase Auth ───
let sbClient=null;
let authToken=null;
let currentUser=null; // supabase user object
let userProfile=null; // profile from our DB

const QTAGS={
  lukasz:[{e:"🍗",l:"Kurczak",q:"Pyszny kurczak"},{e:"🍝",l:"Pasta",q:"Makaron Atlas 150"},{e:"🥩",l:"Sous-vide",q:"Stek sous-vide"},{e:"🧊",l:"Lodówka",q:"Mam kurczaka, masło, czosnek i cytrynę. Co zrobić?"},{e:"⚡",l:"Szybkie",q:"Szybki obiad 30 min"},{e:"🔀",l:"Porównaj",q:"Porównaj 3 sposoby na pierś z kurczaka: patelnia, piekarnik, sous-vide"},{e:"🍰",l:"Deser",q:"Pyszny deser"}],
  guest:[{e:"🍗",l:"Kurczak",q:"Pyszny kurczak"},{e:"🍝",l:"Makaron",q:"Prosty makaron"},{e:"🥩",l:"Stek",q:"Idealny stek"},{e:"🌍",l:"Azja",q:"Danie azjatyckie"},{e:"🔀",l:"Porównaj",q:"Porównaj 3 sposoby na stek: patelnia, grill, sous-vide"},{e:"🍰",l:"Deser",q:"Prosty deser"}]
};

// ─── API Helper ───
function authHeaders(){
  const h={'Content-Type':'application/json'};
  if(authToken) h['Authorization']='Bearer '+authToken;
  return h;
}
function apiBody(extra){return JSON.stringify(extra||{})}
function botProfile(){return userProfile?.bot_profile||'guest'}

// ─── Init ───
document.addEventListener('DOMContentLoaded',async()=>{
  await initSupabase();
  await loadModulesFromServer();
  const inp=document.getElementById('input'),sb=document.getElementById('sendBtn');
  inp.addEventListener('input',()=>{sb.disabled=!inp.value.trim();inp.style.height='auto';inp.style.height=Math.min(Math.max(inp.scrollHeight,36),90)+'px'});
  inp.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});
  document.getElementById('feedbackField')?.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendFeedback()}});
  
  // Home input Enter handler
  const homeInp=document.getElementById('homeInput');
  if(homeInp) homeInp.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();searchFromHome()}});
});

// ─── Supabase Init ───
async function initSupabase(){
  try{
    const r=await fetch(API+'/api/config');
    const cfg=await r.json();
    if(!cfg.supabase_url||!cfg.supabase_anon_key){showAuthScreen(t('auth.supabase_err'));return}
    sbClient=window.supabase.createClient(cfg.supabase_url,cfg.supabase_anon_key);
    // Check existing session
    const{data:{session}}=await sbClient.auth.getSession();
    if(session){
      authToken=session.access_token;
      currentUser=session.user;
      await onLogin();
    } else {
      showAuthScreen();
    }
    // Listen for auth changes
    sbClient.auth.onAuthStateChange(async(event,session)=>{
      if(event==='SIGNED_OUT'){
        authToken=null;currentUser=null;userProfile=null;_appReady=false;
        showAuthScreen();
      } else if(session){
        authToken=session.access_token;
        currentUser=session.user;
        // Only run full login once — token refreshes just update the token silently
        if(!_appReady) await onLogin();
      }
    });
  }catch(e){console.error('Supabase init error:',e);showAuthScreen(t('auth.error_conn'))}
}

async function onLogin(){
  hideAuthScreen();
  // Load profile
  try{
    const r=await fetch(API+'/api/profile',{headers:authHeaders()});
    userProfile=await r.json();
  }catch{userProfile={}}

  // Language priority: 1) Supabase profile (if user explicitly chose), 2) Polish default
  // For now we only support Polish users — other languages may exist via localStorage
  // from prior testing, but we ignore that and force Polish for new accounts.
  const profileLang = userProfile?.lang;
  if (profileLang && SUPPORTED_LANGS.includes(profileLang)) {
    setLang(profileLang, false); // user has explicit preference on profile — respect it
  } else {
    // No lang on profile = new user → force Polish (override any stale localStorage)
    // saveToProfile=true so future sessions on any device will pick this up
    setLang('pl', true);
  }

  // Check if new user (no equipment = needs onboarding)
  const eq=userProfile?.equipment||[];
  const hasEquipment=Array.isArray(eq)?eq.length>0:(typeof eq==='string'&&eq!=='[]'&&eq!=='');
  if(!hasEquipment){
    showOnboarding();
    return;
  }

  enterApp();
}

function enterApp(){
  if(_appReady) return; // prevent re-enter on token refresh
  _appReady=true;
  document.getElementById('onboardingOverlay').style.display='none';
  document.getElementById('appMain').style.display='flex';
  loadSubStatus().then(()=>renderUserInfo());
  renderQuickTags();
  updateGreeting();
  loadRecentRecipes();
  addWelcome();
  checkServer();
  initScrollHide();
  applyI18n();
  const _lt=document.getElementById('langToggle');if(_lt)_lt.textContent=currentLang.toUpperCase();
  checkSharedRecipe();
  newSession();
  loadProgress();
  // Check for payment return
  const params=new URLSearchParams(window.location.search);
  if(params.get('payment')==='success'){
    setTimeout(()=>{addMsg('t',t('user.pro_welcome'));loadSubStatus().then(()=>renderUserInfo())},500);
    window.history.replaceState({},'','/');
  }
}

// ─── Shared recipe from URL (?share=TOKEN) ───
async function checkSharedRecipe(){
  const params=new URLSearchParams(window.location.search);
  const token=params.get('share');
  if(!token) return;
  window.history.replaceState({},'','/');
  try{
    const r=await fetch(API+'/api/share/'+token);
    const d=await r.json();
    if(d.success&&d.recipe){
      addMsg('t',t('share.shared_recipe'));
      handleResponse(d.recipe);
    } else {
      addMsg('t',t('share.expired'));
    }
  }catch{addMsg('t',t('share.load_err'));}
}

// ─── Auth Screen ───
function showAuthScreen(error){
  document.getElementById('authOverlay').style.display='flex';
  document.getElementById('appMain').style.display='none';
  if(error) document.getElementById('authError').textContent=error;
}

function hideAuthScreen(){
  document.getElementById('authOverlay').style.display='none';
  document.getElementById('appMain').style.display='flex';
  document.getElementById('authError').textContent='';
}

function toggleAuthMode(){
  const f=document.getElementById('authForm');
  const isLogin=f.dataset.mode==='login';
  f.dataset.mode=isLogin?'signup':'login';
  document.getElementById('authTitle').textContent=isLogin?t('auth.title_signup'):t('auth.title_login');
  document.getElementById('authSubmitBtn').textContent=isLogin?t('auth.signup_btn'):t('auth.login_btn');
  document.getElementById('authToggle').innerHTML=isLogin?t('auth.has_account')+' <a href="#" onclick="toggleAuthMode();return false">'+t('auth.login_btn')+'</a>':t('auth.no_account')+' <a href="#" onclick="toggleAuthMode();return false">'+t('auth.signup_btn')+'</a>';
  document.getElementById('authNameRow').style.display=isLogin?'block':'none';
  document.getElementById('authError').textContent='';
}

async function submitAuth(e){
  e.preventDefault();
  const mode=document.getElementById('authForm').dataset.mode||'login';
  const email=document.getElementById('authEmail').value.trim();
  const pass=document.getElementById('authPass').value;
  const errEl=document.getElementById('authError');
  errEl.textContent='';
  if(!email||!pass){errEl.textContent=t('auth.error_fill');return}
  if(pass.length<6){errEl.textContent=t('auth.error_pass');return}
  try{
    if(mode==='signup'){
      const name=document.getElementById('authName')?.value?.trim()||'';
      const{data,error}=await sbClient.auth.signUp({email,password:pass,options:{data:{name}}});
      if(error){errEl.textContent=error.message;return}
      if(data.user){
        // Force-anchor Polish on the new profile + save name (only PL is supported for now)
        setTimeout(async()=>{
          try{await fetch(API+'/api/profile',{method:'POST',headers:authHeaders(),body:JSON.stringify({name:name||'',lang:'pl'})})}catch{}
        },1000);
      }
    } else {
      const{data,error}=await sbClient.auth.signInWithPassword({email,password:pass});
      if(error){errEl.textContent=error.message;return}
    }
  }catch(e){errEl.textContent=t('auth.error_prefix')+': '+e.message}
}

async function logout(){
  if(sbClient){await sbClient.auth.signOut()}
  authToken=null;currentUser=null;userProfile=null;
  chatHistory=[];
  document.getElementById('messages').innerHTML='';
  showAuthScreen();
}

async function socialLogin(provider){
  if(!sbClient) return;
  try{
    const{data,error}=await sbClient.auth.signInWithOAuth({
      provider,
      options:{redirectTo:window.location.origin}
    });
    if(error) document.getElementById('authError').textContent=error.message;
  }catch(e){document.getElementById('authError').textContent=t('auth.error_prefix')+': '+e.message}
}

// ─── User Info ───
let subStatus={is_pro:false,status:'free',recipes_today:0,recipes_limit:5};

// Unified PRO/admin check across all sources of truth
function isPro(){
  if(subStatus?.is_pro) return true;
  const role=(userProfile?.role||'').toLowerCase();
  if(role==='pro'||role==='admin'||role==='premium') return true;
  const status=(userProfile?.subscription_status||subStatus?.status||'').toLowerCase();
  if(status==='pro'||status==='active'||status==='premium'||status==='trial') return true;
  return false;
}
window.isPro=isPro;

function renderUserInfo(){
  const name=userProfile?.name||currentUser?.email?.split('@')[0]||'User';
  const initials=name.slice(0,2).toUpperCase();
  // New avatar header
  const av=document.getElementById('userAvatar');
  if(av) av.textContent=initials;
  const ddName=document.getElementById('ddName');
  if(ddName) ddName.textContent=name;
  const ddEmail=document.getElementById('ddEmail');
  if(ddEmail) ddEmail.textContent=currentUser?.email||'';
  const role=(userProfile?.role||'').toLowerCase();
  const badge=document.getElementById('subBadge');
  if(badge){
    if(role==='tester'){badge.textContent='TESTER';badge.classList.add('is-pro');badge.classList.add('is-tester');}
    else if(role==='admin'){badge.textContent='ADMIN';badge.classList.add('is-pro');badge.classList.remove('is-tester');}
    else{badge.textContent=subStatus.is_pro?'PRO':'FREE';badge.classList.toggle('is-pro',subStatus.is_pro);badge.classList.remove('is-tester');}
  }
  // Update lang label
  const ddLang=document.getElementById('ddLang');
  if(ddLang) ddLang.textContent='🌐 Język ('+((window.currentLang||'pl').toUpperCase())+')';
  // Tester/admin: show dedicated KS tab
  const isTesterOrAdmin=(role==='tester'||role==='admin');
  const ksTab=document.getElementById('tab-ks');
  if(ksTab) ksTab.style.display=isTesterOrAdmin?'':'none';
  if(isTesterOrAdmin){
    const ksInp=document.getElementById('ksInput');
    if(ksInp && !ksInp._bound){
      ksInp._bound=true;
      ksInp.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();runKsSearch();}});
    }
  }
  // Legacy userInfo hidden via CSS
}

async function runKsSearch(){
  const inp=document.getElementById('ksInput');
  const out=document.getElementById('ksResults');
  const btn=document.getElementById('ksSearchBtn');
  if(!inp||!out) return;
  const q=(inp.value||'').trim();
  if(!q){inp.focus();return;}
  out.innerHTML='<div class="ks-empty">🔎 Szukam „'+esc(q)+'" na kwestiasmaku.com…</div>';
  if(btn){btn.disabled=true;}
  try{
    const r=await fetch(API+'/api/tester/kwestiasmaku/search',{method:'POST',headers:authHeaders(),body:JSON.stringify({query:q,limit:10})});
    const d=await r.json();
    if(!r.ok){out.innerHTML='<div class="ks-empty ks-err">Błąd: '+esc(d.error||'nie udało się wyszukać')+'</div>';return;}
    const results=d.results||[];
    if(!results.length){out.innerHTML='<div class="ks-empty">Brak wyników dla „'+esc(q)+'".</div>';return;}
    out.innerHTML='<div class="ks-count">Znaleziono '+results.length+' wyników dla „'+esc(q)+'"</div>'+
      '<div class="ks-list">'+
      results.map(x=>'<button class="ks-item" type="button" data-url="'+esc(x.url)+'" data-title="'+esc(x.title)+'" onclick="importKsRecipe(this.dataset.url,this.dataset.title)"><span class="ks-item-title">'+esc(x.title)+'</span><span class="ks-item-host">Otwórz w Chef AI →</span></button>').join('')+
      '</div>';
  }catch(e){
    out.innerHTML='<div class="ks-empty ks-err">Błąd połączenia: '+esc(e.message)+'</div>';
  }finally{
    if(btn) btn.disabled=false;
  }
}
window.runKsSearch=runKsSearch;

async function importKsRecipe(url, title){
  if(!url) return;
  // Switch to chat so renderRecipeCard / handleResponse have a visible target
  showView('chat');
  const msgs=document.getElementById('messages');
  if(msgs){
    const qt=document.getElementById('quickTags'); if(qt) qt.style.display='none';
    const userLine=document.createElement('div');userLine.className='msg';
    userLine.innerHTML='<div class="msg-user">🧪 Importuję z Kwestii Smaku: '+esc(title||url)+'</div>';
    msgs.appendChild(userLine);
  }
  const lid='l'+Date.now();
  const ld=document.createElement('div');ld.id=lid;ld.className='msg';
  ld.innerHTML='<div class="msg-text">Wczytuję przepis…</div>';
  msgs?.appendChild(ld);msgs&&(msgs.scrollTop=msgs.scrollHeight);
  try{
    const r=await fetch(API+'/api/import-url',{method:'POST',headers:authHeaders(),body:JSON.stringify({url:url,lang:(window.currentLang||'pl')})});
    const d=await r.json();
    document.getElementById(lid)?.remove();
    if(d.is_limit){ if(typeof showLimitMessage==='function') showLimitMessage(d.message); else addMsg('t',d.message||'Limit osiągnięty'); return; }
    if(d.error){ addMsg('t','Błąd importu: '+d.error); return; }
    if(typeof handleResponse==='function'){ handleResponse(d.data||d); }
    else{ addMsg('t','Zaimportowano, ale brak renderera.'); }
  }catch(e){
    document.getElementById(lid)?.remove();
    addMsg('t','Błąd importu: '+e.message);
  }
}
window.importKsRecipe=importKsRecipe;

function toggleAvatarDropdown(){
  const dd=document.getElementById('avatarDropdown');
  if(!dd)return;
  dd.classList.toggle('open');
  if(dd.classList.contains('open')){
    const close=e=>{if(!dd.contains(e.target)&&e.target.id!=='userAvatar'){dd.classList.remove('open');document.removeEventListener('click',close)}};
    setTimeout(()=>document.addEventListener('click',close),10);
  }
}

// ─── Scroll-hide input bar ───
function initScrollHide(){
  const messages=document.getElementById('messages');
  const inputArea=document.querySelector('#view-chat .input-area');
  if(!messages||!inputArea)return;
  let lastY=0,ticking=false;
  messages.addEventListener('scroll',()=>{
    if(ticking)return;
    ticking=true;
    requestAnimationFrame(()=>{
      const y=messages.scrollTop;
      const atBottom=messages.scrollHeight-y-messages.clientHeight<80;
      if(atBottom||y<lastY){inputArea.classList.remove('hidden')}
      else if(y>lastY+10){inputArea.classList.add('hidden')}
      lastY=y;ticking=false;
    });
  });
}

async function loadSubStatus(){
  try{
    const r=await fetch(API+'/api/stripe/status',{headers:authHeaders()});
    subStatus=await r.json();
  }catch{subStatus={is_pro:false,status:'free',recipes_today:0,recipes_limit:5}}
}

async function openUpgrade(){
  if(subStatus.is_pro){
    // Open customer portal
    try{
      const r=await fetch(API+'/api/stripe/portal',{method:'POST',headers:authHeaders()});
      const d=await r.json();
      if(d.url) window.location.href=d.url;
    }catch{}
    return;
  }
  // Show upgrade modal
  const el=document.getElementById('messages');
  let h='<div class="upgrade-card">';
  h+='<div class="upgrade-header"><h2>'+t('upgrade.title')+'</h2><p>'+t('upgrade.subtitle')+'</p></div>';
  h+='<div class="upgrade-body">';
  h+='<div class="upgrade-price"><span class="upgrade-amount">'+t('upgrade.price')+'</span><span class="upgrade-period">'+t('upgrade.period')+'</span></div>';
  h+='<div class="upgrade-features">';
  h+='<div class="upgrade-feat">'+t('upgrade.feat1')+'</div>';
  h+='<div class="upgrade-feat">'+t('upgrade.feat2')+'</div>';
  h+='<div class="upgrade-feat">'+t('upgrade.feat3')+'</div>';
  h+='<div class="upgrade-feat">'+t('upgrade.feat4')+'</div>';
  h+='<div class="upgrade-feat">'+t('upgrade.feat5')+'</div>';
  h+='<div class="upgrade-feat">'+t('upgrade.feat6')+'</div>';
  h+='</div>';
  h+='<button class="auth-submit" onclick="startCheckout()" id="checkoutBtn">'+t('upgrade.cta')+'</button>';
  h+='<div class="upgrade-note">'+t('upgrade.cancel_note')+'</div>';
  h+='</div></div>';
  const div=document.createElement('div');div.className='msg';div.innerHTML=h;
  el.appendChild(div);scrollBottom();
}

async function startCheckout(){
  const btn=document.getElementById('checkoutBtn');
  if(btn){btn.disabled=true;btn.textContent=t('upgrade.redirecting')}
  try{
    const r=await fetch(API+'/api/stripe/checkout',{method:'POST',headers:authHeaders()});
    const d=await r.json();
    if(d.url) window.location.href=d.url;
    else if(btn){btn.disabled=false;btn.textContent=t('upgrade.cta')}
  }catch{if(btn){btn.disabled=false;btn.textContent=t('upgrade.cta')}}
}

function showLimitMessage(msg){
  const el=document.getElementById('messages');
  let h='<div class="limit-card">';
  h+='<div class="limit-icon">🔒</div>';
  h+='<div class="limit-text">'+esc(msg)+'</div>';
  h+='<button class="auth-submit" onclick="openUpgrade()" style="margin-top:12px">'+t('user.go_pro')+'</button>';
  h+='</div>';
  const div=document.createElement('div');div.className='msg';div.innerHTML=h;
  el.appendChild(div);scrollBottom();
}

function renderQuickTags(){
  const bp=botProfile();
  document.getElementById('quickTags').innerHTML=(QTAGS[bp]||QTAGS.guest).map(tg=>'<button class="quick-tag" onclick="sendQ(\''+tg.q.replace(/'/g,"\\'")+'\')">'+tg.e+' '+tg.l+'</button>').join('');
}

function addWelcome(){
  const name=userProfile?.name||currentUser?.email?.split('@')[0]||'';
  const raw=t('welcome');
  const hi=t('welcome.hi');
  const msg=raw.replace(hi+'!',hi+(name?' '+name:'')+'!');
  const d=document.createElement('div');d.className='msg';d.innerHTML='<div class="msg-text">'+esc(msg)+'</div>';
  document.getElementById('messages').appendChild(d);
}

function newSession(){chatSessionId='s'+Date.now()+Math.random().toString(36).slice(2,6)}

// ─── Navigation ───
function showView(n){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('view-'+n).classList.add('active');
  const tabId=n==='favorites'?'tab-fav':'tab-'+n;
  const tabEl=document.getElementById(tabId);
  if(tabEl) tabEl.classList.add('active');
  if(n==='training'){document.getElementById('skillTree').style.display='block';document.getElementById('trainingSession').classList.remove('active');loadProgress()}
  if(n==='favorites') renderFavorites();
  if(n==='history') loadHistory();
  if(n==='profile') loadProfileView();
  if(n==='planner'){if(typeof ensurePlannerForm==='function') ensurePlannerForm(); renderSavedPlans();}
  if(n==='chat'){
    initMessagesScrollTracking();
    // Reset scroll-up state when entering chat; jump to bottom
    _userScrolledUp=false;
    hideNewMessagePill();
    const m=document.getElementById('messages');
    if(m) requestAnimationFrame(()=>{m.scrollTop=m.scrollHeight});
  }
}

async function loadModulesFromServer(){
  try{const r=await fetch(API+'/api/modules');const d=await r.json();MODULES=d.modules||[];CATEGORIES=d.categories||[];LEVELS=d.levels||[];LEVEL_NAMES=d.level_names||{}}catch{}
}

async function checkServer(){const s=document.getElementById('status');s.className='status-bar show waking';s.textContent=t('status.connecting');try{const r=await fetch(API+'/api/health');s.className='status-bar show online';s.textContent=t('status.connected');setTimeout(()=>s.classList.remove('show'),1500)}catch{s.className='status-bar show offline';s.textContent=t('status.offline')}}

function toggleKcal(){const r=document.getElementById('kcalRow'),b=document.getElementById('kcalToggle'),v=r.style.display!=='none';r.style.display=v?'none':'flex';b.classList.toggle('active',!v);if(!v)updateKcalSummary()}
function clearKcal(){document.getElementById('kcalInput').value='';document.getElementById('kcalServings').value='1';document.getElementById('kcalSummary').textContent='';document.getElementById('kcalRow').style.display='none';document.getElementById('kcalToggle').classList.remove('active')}
function getKcalValue(){const v=document.getElementById('kcalInput')?.value?.trim();return(!v||isNaN(v)||+v<50)?0:parseInt(v,10)}
function getServingsValue(){return parseInt(document.getElementById('kcalServings')?.value||'1',10)||1}
function updateKcalSummary(){const k=getKcalValue(),s=getServingsValue(),el=document.getElementById('kcalSummary');if(k>0){el.textContent='= '+(k*s)+' '+t('kcal.total')}else{el.textContent=''}}

function esc(s){if(!s)return'';const d=document.createElement('div');d.textContent=s;return d.innerHTML}
// Smart scroll: only auto-scroll if user is near bottom; otherwise show "new" pill
let _userScrolledUp=false;
let _lastNewMsgId=0;
function isNearBottom(m,threshold=120){return (m.scrollHeight-m.scrollTop-m.clientHeight)<threshold}
function scrollBottom(force){
  const m=document.getElementById('messages');
  if(!m) return;
  if(force||!_userScrolledUp){
    setTimeout(()=>{m.scrollTo({top:m.scrollHeight,behavior:'smooth'})},40);
  } else {
    showNewMessagePill();
  }
}
function showNewMessagePill(){
  let pill=document.getElementById('newMsgPill');
  if(!pill){
    pill=document.createElement('button');
    pill.id='newMsgPill';
    pill.className='new-msg-pill';
    pill.innerHTML='↓ Nowa wiadomość';
    pill.onclick=()=>{
      const m=document.getElementById('messages');
      m.scrollTo({top:m.scrollHeight,behavior:'smooth'});
      pill.remove();
    };
    const chatView=document.getElementById('view-chat');
    if(chatView) chatView.appendChild(pill);
  }
  pill.classList.add('visible');
}
function hideNewMessagePill(){
  const pill=document.getElementById('newMsgPill');
  if(pill) pill.remove();
}
// Track manual scroll
function initMessagesScrollTracking(){
  const m=document.getElementById('messages');
  if(!m||m.dataset.tracked) return;
  m.dataset.tracked='1';
  m.addEventListener('scroll',()=>{
    _userScrolledUp=!isNearBottom(m,120);
    if(!_userScrolledUp) hideNewMessagePill();
  },{passive:true});
}
function fmtT(s){if(s<0)s=0;return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}
function addMsg(role,text){
  const d=document.createElement('div');d.className='msg';
  if(role==='user')d.innerHTML='<div class="msg-user">'+esc(text)+'</div>';
  else{d.innerHTML='<div class="msg-text">'+esc(text)+'</div>'}
  document.getElementById('messages').appendChild(d);
  // Always force scroll on user-initiated message; smart scroll for assistant
  if(role==='user'){_userScrolledUp=false;hideNewMessagePill();scrollBottom(true)}
  else scrollBottom();
}
function loadingDots(){return'<div class="loading-dots"><span></span><span></span><span></span></div>'}

// ─── Onboarding ───
let obStep=0;
// Standard kitchen equipment — pre-selected by default (most kitchens have these)
const OB_STANDARD_EQUIPMENT=['Piekarnik','Płyta indukcyjna/gazowa','Patelnia nieprzywierająca','Garnek','Nóż szefa kuchni','Waga kuchenna'];
// Advanced equipment — opt-in, user can toggle individually
const OB_ADVANCED_EQUIPMENT=['Patelnia żeliwna','Patelnia stalowa','Termoobieg','Termometr sondowy','Sous-vide cyrkulator','Robot kuchenny','Blender','Mikser planetarny','Maszynka do makaronu','Maszynka do mielenia','Vacuum sealer','Syfon iSi (N2O)','Pirometr','Wok'];
// Diet presets — translate to bans
const OB_DIET_BANS={
  none:[],
  vegetarian:['Mięso','Wołowina','Wieprzowina','Kurczak','Drób','Indyk','Ryby','Owoce morza','Krewetki','Tuńczyk','Łosoś'],
  vegan:['Mięso','Wołowina','Wieprzowina','Kurczak','Drób','Indyk','Ryby','Owoce morza','Krewetki','Tuńczyk','Łosoś','Mleko','Śmietana','Masło','Ser','Jogurt','Jajka','Miód']
};
let obData={name:'',level:'mid',equipment:[],bans:[],diet:'none',dietOther:''};

function showOnboarding(){
  document.getElementById('appMain').style.display='none';
  document.getElementById('onboardingOverlay').style.display='flex';
  obStep=0;
  obData.name=userProfile?.name||currentUser?.user_metadata?.full_name||currentUser?.email?.split('@')[0]||'';
  // Pre-select standard equipment by default (everyone has these)
  obData.equipment=[...OB_STANDARD_EQUIPMENT];
  obData.bans=[];
  obData.diet='none';
  obData.dietOther='';
  renderObStep();
}

function renderObStep(){
  const el=document.getElementById('obContent');
  const dots='<div class="ob-dots">'+[0,1,2].map(i=>'<span class="ob-dot'+(i===obStep?' active':'')+'"></span>').join('')+'</div>';
  
  if(obStep===0){
    el.innerHTML=dots+'<h2 class="ob-title">'+t('ob.hello')+'</h2>'
      +'<p class="ob-sub">'+t('ob.name_q')+'</p>'
      +'<input type="text" class="auth-input" id="obName" value="'+esc(obData.name)+'" placeholder="'+t('ob.name_placeholder')+'" autofocus>'
      +'<p class="ob-sub" style="margin-top:20px">'+t('ob.level_q')+'</p>'
      +'<div class="ob-levels">'
      +'<button class="ob-level'+(obData.level==='beginner'?' active':'')+'" onclick="obData.level=\'beginner\';renderObStep()"><span class="ob-level-icon">🥚</span><span class="ob-level-name">'+t('ob.beginner')+'</span><span class="ob-level-desc">'+t('ob.beginner_desc')+'</span></button>'
      +'<button class="ob-level'+(obData.level==='mid'?' active':'')+'" onclick="obData.level=\'mid\';renderObStep()"><span class="ob-level-icon">🍳</span><span class="ob-level-name">'+t('ob.mid')+'</span><span class="ob-level-desc">'+t('ob.mid_desc')+'</span></button>'
      +'<button class="ob-level'+(obData.level==='pro'?' active':'')+'" onclick="obData.level=\'pro\';renderObStep()"><span class="ob-level-icon">👨‍🍳</span><span class="ob-level-name">'+t('ob.pro')+'</span><span class="ob-level-desc">'+t('ob.pro_desc')+'</span></button>'
      +'</div>'
      +'<button class="auth-submit" onclick="obNext()" style="margin-top:20px">'+t('ob.next')+'</button>';
  }
  else if(obStep===1){
    // STEP 1: Equipment - standard pre-selected, advanced opt-in
    const stdHtml=OB_STANDARD_EQUIPMENT.map(item=>{
      const checked=obData.equipment.includes(item);
      return '<label class="ob-check'+(checked?' active':'')+'"><input type="checkbox" '+(checked?'checked':'')+' onchange="toggleObEquip(\''+esc(item).replace(/'/g,"\\'")+'\')"><span>'+esc(item)+'</span></label>';
    }).join('');
    const advExpanded=!!obData.advancedExpanded;
    const advHtml=advExpanded?OB_ADVANCED_EQUIPMENT.map(item=>{
      const checked=obData.equipment.includes(item);
      return '<label class="ob-check'+(checked?' active':'')+'"><input type="checkbox" '+(checked?'checked':'')+' onchange="toggleObEquip(\''+esc(item).replace(/'/g,"\\'")+'\')"><span>'+esc(item)+'</span></label>';
    }).join(''):'';
    // Custom equipment chips (anything user added that's not in standard/advanced lists)
    const customItems=obData.equipment.filter(e=>!OB_STANDARD_EQUIPMENT.includes(e)&&!OB_ADVANCED_EQUIPMENT.includes(e));
    const customHtml=customItems.length?'<div class="ob-tags" style="margin-top:10px">'+customItems.map((e)=>'<span class="ob-tag" onclick="removeObEquip(\''+esc(e).replace(/'/g,"\\'")+'\')">'+esc(e)+' ✕</span>').join('')+'</div>':'';
    el.innerHTML=dots+'<h2 class="ob-title">'+t('ob.equip_title')+'</h2>'
      +'<p class="ob-sub">'+t('ob.equip_sub_v2')+'</p>'
      +'<div class="ob-checkbox-list">'+stdHtml+'</div>'
      +'<button class="ob-toggle-adv" onclick="obData.advancedExpanded=!obData.advancedExpanded;renderObStep()">'+(advExpanded?'▾ ':'▸ ')+t('ob.equip_advanced_toggle')+'</button>'
      +(advExpanded?'<div class="ob-checkbox-list ob-advanced-list">'+advHtml+'</div>':'')
      +customHtml
      +'<div class="ob-add-row" style="margin-top:12px"><input type="text" class="auth-input" id="obNewEquip" placeholder="'+t('ob.equip_add')+'" style="margin:0;flex:1"><button class="ob-add-btn" onclick="obAddEquip()">+</button></div>'
      +'<div class="ob-nav"><button class="ob-back" onclick="obStep=0;renderObStep()">'+t('ob.back')+'</button><button class="auth-submit" onclick="obNext()" style="flex:1">'+t('ob.next')+'</button></div>';
  }
  else if(obStep===2){
    // STEP 2: Diet preset + custom dislikes
    const dietOpts=[
      {key:'none',icon:'🍽️',label:t('ob.diet_none')},
      {key:'vegetarian',icon:'🥗',label:t('ob.diet_vegetarian')},
      {key:'vegan',icon:'🌱',label:t('ob.diet_vegan')},
      {key:'other',icon:'✏️',label:t('ob.diet_other')}
    ];
    const dietHtml=dietOpts.map(o=>'<button class="ob-diet'+(obData.diet===o.key?' active':'')+'" onclick="selectDiet(\''+o.key+'\')"><span class="ob-diet-icon">'+o.icon+'</span><span class="ob-diet-label">'+o.label+'</span></button>').join('');
    const otherInput=obData.diet==='other'?'<input type="text" class="auth-input" id="obDietOther" value="'+esc(obData.dietOther)+'" placeholder="'+t('ob.diet_other_placeholder')+'" style="margin-top:10px" oninput="obData.dietOther=this.value">':'';
    el.innerHTML=dots+'<h2 class="ob-title">'+t('ob.bans_title_v2')+'</h2>'
      +'<p class="ob-sub">'+t('ob.diet_q')+'</p>'
      +'<div class="ob-diet-grid">'+dietHtml+'</div>'
      +otherInput
      +'<p class="ob-sub" style="margin-top:20px">'+t('ob.dislikes_q')+'</p>'
      +'<p class="ob-sub-small">'+t('ob.dislikes_hint')+'</p>'
      +'<div class="ob-tags" id="obBanTags"></div>'
      +'<div class="ob-add-row"><input type="text" class="auth-input" id="obNewBan" placeholder="'+t('ob.ban_add_v2')+'" style="margin:0;flex:1" onkeydown="if(event.key===\'Enter\'){event.preventDefault();obAddBan()}"><button class="ob-add-btn" onclick="obAddBan()">+</button></div>'
      +'<div class="ob-nav"><button class="ob-back" onclick="obStep=1;renderObStep()">'+t('ob.back')+'</button><button class="auth-submit ob-finish" onclick="finishOnboarding()" style="flex:1">'+t('ob.finish')+'</button></div>';
    renderObBanTags();
  }
}

function toggleObEquip(item){
  const i=obData.equipment.indexOf(item);
  if(i>=0) obData.equipment.splice(i,1);
  else obData.equipment.push(item);
  renderObStep();
}

function removeObEquip(item){
  const i=obData.equipment.indexOf(item);
  if(i>=0){obData.equipment.splice(i,1);renderObStep()}
}

function obAddEquip(){
  const inp=document.getElementById('obNewEquip');
  const v=inp?.value?.trim();
  if(v&&!obData.equipment.includes(v)){obData.equipment.push(v);inp.value='';renderObStep()}
}

function selectDiet(key){
  obData.diet=key;
  if(key==='other') obData.dietOther='';
  renderObStep();
}

function renderObBanTags(){
  const el=document.getElementById('obBanTags');
  if(!el) return;
  el.innerHTML=obData.bans.map((b,i)=>'<span class="ob-tag ob-tag-ban" onclick="obData.bans.splice('+i+',1);renderObBanTags()">'+esc(b)+' ✕</span>').join('');
}

function obAddBan(){
  const inp=document.getElementById('obNewBan');
  const v=inp?.value?.trim();
  if(v&&!obData.bans.includes(v)){obData.bans.push(v);inp.value='';renderObBanTags()}
}

function obNext(){
  if(obStep===0){
    const name=document.getElementById('obName')?.value?.trim();
    if(name) obData.name=name;
  }
  obStep++;
  renderObStep();
}

async function finishOnboarding(){
  const btn=document.querySelector('.ob-finish');
  if(btn){btn.disabled=true;btn.textContent=t('ob.saving')}
  
  // Combine diet-derived bans with user's custom dislikes (deduplicated)
  const dietBans=OB_DIET_BANS[obData.diet]||[];
  const allBans=[...new Set([...dietBans,...obData.bans])];
  // Map diet preset to backend dietary_preferences format
  const dietaryPrefs=[];
  if(obData.diet==='vegetarian') dietaryPrefs.push('wegetariańskie');
  else if(obData.diet==='vegan') dietaryPrefs.push('wegańskie');
  else if(obData.diet==='other' && obData.dietOther.trim()){
    // Try to map common keywords; otherwise add as-is so it lands in profile
    const o=obData.dietOther.toLowerCase();
    if(o.includes('bezglut')||o.includes('gluten')) dietaryPrefs.push('bezglutenowe');
    if(o.includes('keto')) dietaryPrefs.push('keto');
    if(o.includes('low-carb')||o.includes('niskowęg')) dietaryPrefs.push('low-carb');
    if(o.includes('pescet')) dietaryPrefs.push('pescetariańskie');
    if(!dietaryPrefs.length) dietaryPrefs.push(obData.dietOther.trim());
  }
  const profile={
    name:obData.name,
    equipment:obData.equipment,
    banned_ingredients:allBans,
    dietary_preferences:dietaryPrefs,
    bot_profile:obData.level==='pro'?'lukasz':'guest',
    lang:'pl'
  };
  
  try{
    await fetch(API+'/api/profile',{method:'POST',headers:authHeaders(),body:JSON.stringify(profile)});
    userProfile={...userProfile,...profile};
  }catch{}
  
  document.getElementById('onboardingOverlay').style.display='none';
  enterApp();
  
  // Auto-send first suggestion
  setTimeout(()=>{
    const q=obData.level==='beginner'?t('ob.suggest_beginner'):
            obData.level==='mid'?t('ob.suggest_mid'):
            t('ob.suggest_pro');
    sendQ(q);
  },500);
}
// Add this to app.js at the end of the file

async function openStripeCheckout() {
    try {
        const response = await fetch('/api/create-checkout-session', {
            method: 'POST',
            headers: authHeaders(),
        });
        
        if (!response.ok) {
            console.error('Checkout error:', response.status);
            return;
        }
        
        const data = await response.json();
        
        if (data.error) {
            alert(t('error')+': ' + data.error);
            return;
        }
        
        // Redirect to Stripe Checkout
        if (data.sessionId) {
            // Load Stripe.js if not already loaded
            if (typeof Stripe === 'undefined') {
                const script = document.createElement('script');
                script.src = 'https://js.stripe.com/v3/';
                script.onload = () => {
                    const stripe = Stripe('pk_test_51TEt6G91D0CH9ZxXPuj22BXterECRejNIuyQrxoQVmze7CQgMlhtBwHuJtAjhXEI7wYEkwyESBLvPGbNJbiVbDK700LqSyhM3H');
                    stripe.redirectToCheckout({ sessionId: data.sessionId });
                };
                document.head.appendChild(script);
            } else {
                const stripe = Stripe('pk_test_51TEt6G91D0CH9ZxXPuj22BXterECRejNIuyQrxoQVmze7CQgMlhtBwHuJtAjhXEI7wYEkwyESBLvPGbNJbiVbDK700LqSyhM3H');
                stripe.redirectToCheckout({ sessionId: data.sessionId });
            }
        }
    } catch (error) {
        console.error('Checkout error:', error);
        alert(t('error.checkout')+': ' + error.message);
    }
}

// Hook this to the PRO badge/button click
document.addEventListener('DOMContentLoaded', () => {
    const proBtn = document.getElementById('proBadge');
    if (proBtn) {
        proBtn.addEventListener('click', openStripeCheckout);
    }
});

// ─── HOME SCREEN FUNCTIONS ───

function updateGreeting() {
    const hour = new Date().getHours();
    const name = userProfile?.name || currentUser?.user_metadata?.name || 'Użytkowniku';
    let greeting;
    
    if (hour < 6) greeting = 'Późna kolacja?';
    else if (hour < 12) greeting = 'Dzień dobry';
    else if (hour < 18) greeting = 'Cześć';
    else greeting = 'Dobry wieczór';
    
    const greetingEl = document.getElementById('greetingText');
    const nameEl = document.getElementById('greetingName');
    if (greetingEl && nameEl) {
        greetingEl.innerHTML = `${greeting} <span class="greeting-name" id="greetingName">${name}</span> 👋`;
    }
}

function openFlow(flowType) {
    console.log('Opening flow:', flowType);
    
    // Check if PRO feature for FREE user
    if (flowType === 'guests' && !isPro()) {
        showProModal();
        return;
    }
    
    switch(flowType) {
        case 'ingredients':
            openFlowPicker('ingredients');
            break;
        case 'quick':
            showView('flow-quick');
            initQuickFlow();
            break;
        case 'discover':
            openFlowPicker('discover');
            break;
        case 'classic':
            showView('flow-classic');
            loadClassicChips();
            break;
        case 'healthy':
            openFlowPicker('healthy');
            break;
        case 'guests':
            openFlowPicker('guests');
            break;
    }
}

// ─── Flow Picker (ingredients / discover / healthy / guests) ───
const FLOW_CONFIG = {
    ingredients: {
        title: '🥬 Z tego co mam',
        subtitle: 'Wpisz składniki, które masz w lodówce/szafce',
        inputType: 'text',
        placeholder: 'np. kurczak, masło, czosnek, cytryna',
        buildQuery: v => `Mam w domu: ${v}. Zaproponuj przepis wykorzystujący te składniki.`
    },
    discover: {
        title: '✨ Coś nowego',
        subtitle: 'Wybierz kuchnię świata lub styl',
        inputType: 'chips',
        options: [
            {e:'🍜', l:'Azjatycka', v:'azjatyckiej'},
            {e:'🌮', l:'Meksykańska', v:'meksykańskiej'},
            {e:'🍝', l:'Włoska', v:'włoskiej'},
            {e:'🥘', l:'Indyjska', v:'indyjskiej'},
            {e:'🥙', l:'Bliskowschodnia', v:'bliskowschodniej'},
            {e:'🍱', l:'Japońska', v:'japońskiej'},
            {e:'🌶️', l:'Tajska', v:'tajskiej'},
            {e:'🥐', l:'Francuska', v:'francuskiej'}
        ],
        buildQuery: v => `Zaproponuj ciekawe, nietypowe danie z kuchni ${v} którego jeszcze nie próbowałem.`
    },
    healthy: {
        title: '🥗 Zdrowe',
        subtitle: 'Wybierz swój cel żywieniowy',
        inputType: 'chips',
        options: [
            {e:'💪', l:'Wysokobiałkowe', v:'wysokobiałkowe, min. 30g białka na porcję'},
            {e:'🥦', l:'Wege/warzywne', v:'wegetariańskie, bogate w warzywa'},
            {e:'🔥', l:'Niskokaloryczne', v:'niskokaloryczne (do 400 kcal na porcję)'},
            {e:'🥑', l:'Keto', v:'keto, niskowęglowodanowe'},
            {e:'🌾', l:'Bezglutenowe', v:'bezglutenowe'},
            {e:'⚖️', l:'Zbilansowane', v:'zbilansowane pod makroskładniki'},
            {e:'🫀', l:'Serce/DASH', v:'dieta DASH, niska zawartość sodu'},
            {e:'🧘', l:'Lekkostrawne', v:'lekkostrawne, łagodne dla żołądka'}
        ],
        buildQuery: v => `Zaproponuj zdrowe danie: ${v}.`
    },
    guests: {
        title: '🍽️ Dla gości',
        subtitle: 'Na ile osób i jaka okazja?',
        inputType: 'guests',
        buildQuery: (persons, occasion) => `Przygotuj menu dla ${persons} osób na okazję: ${occasion}. Danie powinno robić wrażenie, ale być wykonalne.`
    }
};

function openFlowPicker(flowType) {
    const cfg = FLOW_CONFIG[flowType];
    if (!cfg) return;
    
    // Remove any existing picker
    const existing = document.getElementById('flowPicker');
    if (existing) existing.remove();
    
    let body = '';
    if (cfg.inputType === 'text') {
        body = `
            <input type="text" class="fp-input" id="fpTextInput" placeholder="${cfg.placeholder}" autofocus>
            <button class="fp-submit" onclick="submitFlowPicker('${flowType}')">Wygeneruj przepis →</button>
        `;
    } else if (cfg.inputType === 'chips') {
        body = `
            <div class="fp-chips">
                ${cfg.options.map(o => `
                    <button class="fp-chip" onclick="submitFlowPickerChip('${flowType}','${o.v.replace(/'/g,"\\'")}')">
                        <span class="fp-chip-emoji">${o.e}</span>
                        <span class="fp-chip-label">${o.l}</span>
                    </button>
                `).join('')}
            </div>
        `;
    } else if (cfg.inputType === 'guests') {
        body = `
            <label class="fp-label">Ile osób?</label>
            <div class="fp-stepper">
                <button onclick="fpStep(-1)">−</button>
                <span id="fpPersons">4</span>
                <button onclick="fpStep(1)">+</button>
            </div>
            <label class="fp-label">Okazja</label>
            <div class="fp-chips">
                ${['Kolacja','Urodziny','Rocznica','Spotkanie','Święta','Wigilia'].map(o => `
                    <button class="fp-chip" onclick="fpSelectOccasion(this,'${o}')">
                        <span class="fp-chip-label">${o}</span>
                    </button>
                `).join('')}
            </div>
            <button class="fp-submit" onclick="submitFlowPickerGuests()">Przygotuj menu →</button>
        `;
    }
    
    const html = `
        <div class="fp-backdrop" id="flowPicker" onclick="if(event.target===this)closeFlowPicker()">
            <div class="fp-card">
                <button class="fp-close" onclick="closeFlowPicker()">✕</button>
                <div class="fp-title">${cfg.title}</div>
                <div class="fp-subtitle">${cfg.subtitle}</div>
                ${body}
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);
    
    // Focus text input
    const txt = document.getElementById('fpTextInput');
    if (txt) {
        txt.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); submitFlowPicker(flowType); }
        });
        setTimeout(() => txt.focus(), 50);
    }
}

function closeFlowPicker() {
    const p = document.getElementById('flowPicker');
    if (p) p.remove();
}

function submitFlowPicker(flowType) {
    const cfg = FLOW_CONFIG[flowType];
    const val = document.getElementById('fpTextInput')?.value.trim();
    if (!val) return;
    closeFlowPicker();
    runFlowQuery(cfg.buildQuery(val));
}

function submitFlowPickerChip(flowType, value) {
    const cfg = FLOW_CONFIG[flowType];
    closeFlowPicker();
    runFlowQuery(cfg.buildQuery(value));
}

let _fpPersons = 4;
let _fpOccasion = null;
function fpStep(delta) {
    _fpPersons = Math.max(2, Math.min(20, _fpPersons + delta));
    const el = document.getElementById('fpPersons');
    if (el) el.textContent = _fpPersons;
}
function fpSelectOccasion(btn, occasion) {
    _fpOccasion = occasion;
    document.querySelectorAll('#flowPicker .fp-chip').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
}
function submitFlowPickerGuests() {
    if (!_fpOccasion) { alert('Wybierz okazję'); return; }
    const cfg = FLOW_CONFIG.guests;
    closeFlowPicker();
    runFlowQuery(cfg.buildQuery(_fpPersons, _fpOccasion));
    _fpPersons = 4;
    _fpOccasion = null;
}

function runFlowQuery(query) {
    showView('chat');
    const input = document.getElementById('input');
    input.value = query;
    // Trigger input event to enable send button
    input.dispatchEvent(new Event('input'));
    send();
}

function searchFromHome() {
    const input = document.getElementById('homeInput');
    const query = input.value.trim();
    
    if (!query) return;
    
    // Switch to chat and send query
    showView('chat');
    document.getElementById('input').value = query;
    send();
    
    // Clear home input
    input.value = '';
}

function showProModal() {
    // Simple alert for now - TODO: implement proper modal
    alert('Ta funkcja jest dostępna w wersji PRO.\n\nUzyskaj dostęp do:\n• Planera menu dla gości\n• Harmonogramu przygotowań\n• Skalowania przepisów\n• Eksportu do kalendarza\n\nKliknij PRO w prawym górnym rogu aby uaktualnić.');
}

function loadRecentRecipes() {
    // TODO: Load from history and show recent chips
    const recentEl = document.getElementById('recentRecipes');
    const scrollEl = document.getElementById('recentScroll');
    
    if (chatHistory.length > 0) {
        // Show recent recipes from chat history
        const recent = chatHistory
            .filter(msg => msg.type === 'recipe')
            .slice(-5)
            .reverse();
            
        if (recent.length > 0) {
            scrollEl.innerHTML = recent.map(recipe => 
                `<div class="recent-chip" onclick="showRecipeFromHistory('${recipe.id}')">${recipe.data?.title || 'Przepis'}</div>`
            ).join('');
            recentEl.style.display = 'block';
        }
    }
}

function showRecipeFromHistory(recipeId) {
    // TODO: Show recipe from history
    console.log('Show recipe from history:', recipeId);
    showView('chat');
}

// ─── FLOW 4: CLASSIC FUNCTIONS ───

let _classicsData = null;
let _clsActiveCat = null;

async function loadClassicChips() {
    const container = document.getElementById('classicCategories');
    if (!container) return;
    try {
        const res = await fetch('/api/recipes/classic', {
            method: 'POST', headers: authHeaders(), body: JSON.stringify({})
        });
        const data = await res.json();
        if (data.success && data.classics) {
            _classicsData = data.classics;
            _clsIndex = data.classics;
            renderClassicIndex(data.classics, container);
            renderProfileBanner(data.profile);
            renderCatTabs(data.classics.categories || []);
            initClsScrollSpy();
        }
    } catch (e) { console.error('Error loading classics:', e); }
}

let _clsProfile = null;
let _clsIndex = null;

function renderProfileBanner(p) {
    _clsProfile = p;
    const banner = document.getElementById('clsProfileBanner');
    const text = document.getElementById('clsProfileText');
    const sub = document.getElementById('clsHeroSub');
    if (!banner || !p) return;
    
    const parts = [];
    if (p.dietary?.length) parts.push(`🥗 ${p.dietary.join(', ')}`);
    if (p.banned?.length) parts.push(`� AI zastąpi: ${p.banned.join(', ')}`);
    if (p.hidden > 0) parts.push(`ukryto ${p.hidden}`);
    
    if (parts.length) {
        text.innerHTML = parts.join(' · ');
        banner.style.display = 'flex';
    } else {
        banner.style.display = 'none';
    }
    
    const total = p.filtered_dishes || 230;
    if (sub) sub.textContent = p.banned?.length
        ? `${total} przepisów · AI dostosuje do profilu`
        : `${total} sprawdzonych przepisów`;
}

function renderCatTabs(cats) {
    const bar = document.getElementById('clsCatBar');
    if (!bar || !cats.length) return;
    bar.innerHTML = `<button class="cls-cat-tab active" data-cat="all" onclick="scrollToCat('all')">Wszystkie</button>` +
        cats.sort((a,b) => a.order - b.order).map(c =>
            `<button class="cls-cat-tab" data-cat="${c.id}" onclick="scrollToCat('${c.id}')">${c.emoji} ${c.name}</button>`
        ).join('');
}

function scrollToCat(catId) {
    // Activate tab
    document.querySelectorAll('.cls-cat-tab').forEach(t => t.classList.toggle('active', t.dataset.cat === catId));
    if (catId === 'all') {
        document.getElementById('clsContent')?.scrollTo({top: 0, behavior: 'smooth'});
        return;
    }
    const section = document.querySelector(`.category-section[data-cat="${catId}"]`);
    if (section) section.scrollIntoView({behavior: 'smooth', block: 'start'});
}

function initClsScrollSpy() {
    const content = document.getElementById('clsContent');
    if (!content) return;
    content.addEventListener('scroll', () => {
        const sections = content.querySelectorAll('.category-section');
        let current = 'all';
        sections.forEach(s => {
            if (s.getBoundingClientRect().top < 120) current = s.dataset.cat;
        });
        if (current !== _clsActiveCat) {
            _clsActiveCat = current;
            document.querySelectorAll('.cls-cat-tab').forEach(t => t.classList.toggle('active', t.dataset.cat === current));
            // Scroll tab into view
            const activeTab = document.querySelector(`.cls-cat-tab[data-cat="${current}"]`);
            if (activeTab) activeTab.scrollIntoView({behavior: 'smooth', block: 'nearest', inline: 'center'});
        }
    }, {passive: true});
}

function fmtTime(min) {
    if (min >= 1440) return Math.round(min/1440) + 'd';
    if (min >= 60) { const h = Math.floor(min/60); const m = min%60; return m ? h+'h'+m+'m' : h+'h'; }
    return min + 'm';
}

function renderClassicIndex(idx, container) {
    const cats = (idx.categories || []).slice().sort((a,b) => a.order - b.order);
    const dishes = idx.dishes || [];
    const grouped = {};
    dishes.forEach(d => { (grouped[d.category] = grouped[d.category] || []).push(d); });
    
    let html = '';
    cats.forEach(cat => {
        const items = grouped[cat.id] || [];
        if (!items.length) return;
        html += `<div class="category-section" data-cat="${cat.id}">
          <div class="category-title">${cat.emoji} ${cat.name} <span class="cat-count">${items.length}</span></div>
          <div class="category-chips">${items.map(d => {
            const diff = '★'.repeat(d.difficulty) + '☆'.repeat(3 - d.difficulty);
            const hasBest = d.best_version;
            
            if (hasBest) {
              return `<div class="classic-chip chip-expandable" data-name="${d.name.toLowerCase()}" data-dish-id="${d.id}">
                <div class="chip-header" onclick="toggleChipExpansion('${d.id}')">
                  <span class="chip-emoji">${d.emoji}</span>
                  <span class="chip-name">${d.name}</span>
                  <span class="chip-meta">${fmtTime(d.time)} · ${diff}</span>
                  <span class="chip-expand">▼</span>
                </div>
                <div class="chip-versions" style="display: none;">
                  <button class="version-btn classic-version" onclick="loadClassicRecipe('${d.id}', 'classic')">
                    🏠 Klasyczny <span class="version-meta">${fmtTime(d.time)} · ${diff}</span>
                  </button>
                  <button class="version-btn best-version" onclick="showBestVersionPreview('${d.id}')">
                    👑 Najlepsza <span class="version-meta">${fmtTime(d.best_version.time)} · ${'★'.repeat(d.best_version.difficulty) + '☆'.repeat(4 - d.best_version.difficulty)}</span>
                  </button>
                </div>
              </div>`;
            } else {
              return `<div class="classic-chip" onclick="loadClassicRecipe('${d.id}')" data-name="${d.name.toLowerCase()}">
                <span class="chip-emoji">${d.emoji}</span>
                <span class="chip-name">${d.name}</span>
                <span class="chip-meta">${fmtTime(d.time)} · ${diff}</span>
              </div>`;
            }
          }).join('')}</div></div>`;
    });
    container.innerHTML = html;
}

function _applyClassicFilter() {
    const q = (document.getElementById('classicSearch')?.value || '').trim().toLowerCase();
    if (!q) {
        document.querySelectorAll('#classicCategories .classic-chip').forEach(c => c.style.display = '');
        document.querySelectorAll('#classicCategories .category-section').forEach(s => s.style.display = '');
        document.getElementById('clsCatBar') && (document.getElementById('clsCatBar').style.display = '');
        return;
    }
    // Hide category tabs when searching
    document.getElementById('clsCatBar') && (document.getElementById('clsCatBar').style.display = 'none');
    document.querySelectorAll('#classicCategories .classic-chip').forEach(c => {
        const name = c.dataset.name || c.textContent.toLowerCase();
        c.style.display = name.includes(q) ? '' : 'none';
    });
    document.querySelectorAll('#classicCategories .category-section').forEach(s => {
        const visible = s.querySelectorAll('.classic-chip:not([style*="display: none"])');
        s.style.display = visible.length ? '' : 'none';
    });
}

function toggleChipExpansion(dishId) {
    const chip = document.querySelector(`[data-dish-id="${dishId}"]`);
    if (!chip) return;
    
    const versions = chip.querySelector('.chip-versions');
    const expand = chip.querySelector('.chip-expand');
    
    if (versions.style.display === 'none') {
        versions.style.display = 'block';
        expand.textContent = '▲';
        chip.classList.add('expanded');
    } else {
        versions.style.display = 'none';
        expand.textContent = '▼';
        chip.classList.remove('expanded');
    }
}

function showBestVersionPreview(dishId) {
    const dish = _clsIndex?.dishes?.find(d => d.id === dishId);
    if (!dish?.best_version) return;
    
    const modal = document.getElementById('bestVersionModal') || createBestVersionModal();
    const content = modal.querySelector('.modal-content');
    
    const techniques = dish.best_version.techniques.map(t => 
        `<div class="technique-item">
            <span class="technique-emoji">${t.emoji}</span>
            <div class="technique-text">
                <strong>${t.name}</strong> — ${t.why}
            </div>
        </div>`
    ).join('');
    
    content.innerHTML = `
        <div class="modal-header">
            <h3>${dish.emoji} ${dish.name}</h3>
            <span class="modal-close" onclick="closeBestVersionModal()">&times;</span>
        </div>
        <div class="modal-body">
            <div class="version-badge">👑 Najlepsza wersja</div>
            <div class="version-stats">
                ⏱ ${fmtTime(dish.best_version.time)} · ${'★'.repeat(dish.best_version.difficulty) + '☆'.repeat(4 - dish.best_version.difficulty)}
            </div>
            <h4>Co robimy inaczej:</h4>
            <div class="techniques-list">
                ${techniques}
            </div>
            <div class="modal-actions">
                <button class="btn-secondary" onclick="closeBestVersionModal()">Anuluj</button>
                <button class="btn-primary" onclick="loadClassicRecipe('${dishId}', 'best'); closeBestVersionModal()">Otwórz przepis →</button>
            </div>
        </div>
    `;
    
    modal.style.display = 'flex';
}

function createBestVersionModal() {
    const modal = document.createElement('div');
    modal.id = 'bestVersionModal';
    modal.className = 'modal-overlay';
    modal.innerHTML = '<div class="modal-content"></div>';
    document.body.appendChild(modal);
    return modal;
}

function closeBestVersionModal() {
    const modal = document.getElementById('bestVersionModal');
    if (modal) modal.style.display = 'none';
}

async function loadClassicRecipe(recipeId, version = 'classic') {
    const loadingEl = document.getElementById('classicLoading');
    const catsEl = document.getElementById('classicCategories');
    const chip = document.querySelector(`[data-dish-id="${recipeId}"], .classic-chip[onclick*="'${recipeId}'"]`);
    const dishName = chip?.querySelector('.chip-name')?.textContent || recipeId;
    
    const loadTxt = document.querySelector('#classicLoading .loading-text');
    if (loadTxt) loadTxt.textContent = version === 'best' 
        ? `Generuję najlepszą wersję: ${dishName}...`
        : `Generuję: ${dishName}...`;
    if (loadingEl && catsEl) { catsEl.style.display = 'none'; loadingEl.style.display = 'flex'; }
    
    try {
        const res = await fetch('/api/recipes/classic', {
            method: 'POST', headers: authHeaders(),
            body: JSON.stringify({ recipe_id: recipeId, version: version })
        });
        const data = await res.json();
        
        if (data.success && data.recipe) {
            showView('chat');
            if (version === 'best') {
                addMsg('system', `👑 Wygenerowano najlepszą wersję przepisu "${dishName}" z zaawansowanymi technikami kulinarnymi`);
            } else if (data.adapted && _clsProfile?.banned?.length) {
                addMsg('system', `✅ Przepis "${dishName}" dostosowany — bez: ${_clsProfile.banned.join(', ')}`);
            }
            handleResponse(data.recipe);
        } else {
            alert('Nie udało się załadować przepisu: ' + (data.error || 'Nieznany błąd'));
        }
    } catch (e) {
        console.error('Error loading classic recipe:', e);
        alert('Błąd ładowania przepisu');
    } finally {
        if (loadingEl && catsEl) { loadingEl.style.display = 'none'; catsEl.style.display = ''; }
    }
}

// ─── FLOW 2: QUICK FUNCTIONS ───

let _quickSelectedTime = 30;
let _quickSelectedCategory = null;

function initQuickFlow() {
    _quickSelectedTime = 30;
    _quickSelectedCategory = null;
    
    // Reset time chips
    document.querySelectorAll('.time-chip').forEach(chip => {
        chip.classList.toggle('active', parseInt(chip.dataset.time) === 30);
    });
    
    // Reset category tiles
    document.querySelectorAll('.category-tile').forEach(tile => {
        tile.classList.remove('active');
    });
}

function selectTime(time) {
    _quickSelectedTime = time;
    
    // Update UI
    document.querySelectorAll('.time-chip').forEach(chip => {
        chip.classList.toggle('active', parseInt(chip.dataset.time) === time);
    });
    
    // Haptic feedback if mobile
    if (navigator.vibrate) navigator.vibrate(10);
}

function selectCategory(category) {
    _quickSelectedCategory = category;
    
    // Visual feedback
    const tile = document.querySelector(`[data-category="${category}"]`);
    if (tile) {
        tile.classList.add('active');
        setTimeout(() => {
            loadQuickResults(category, _quickSelectedTime);
        }, 200);
    }
}

async function loadQuickResults(category, maxTime) {
    // Show loading state immediately
    showView('quick-results');
    const content = document.getElementById('quickResultsContent');
    if (content) content.innerHTML = `
        <div style="text-align:center;padding:60px 20px;color:var(--text-muted);">
            <div class="loading-dots" style="margin:0 auto 16px;display:inline-flex;gap:6px"><span></span><span></span><span></span></div>
            <div style="font-size:14px">AI dobiera dla Ciebie 8 dań…</div>
        </div>`;
    document.getElementById('quickResultsTitle').textContent = '⚡ Szukam propozycji…';
    document.getElementById('quickResultsCount').textContent = '';
    
    try {
        const res = await fetch('/api/recipes/quick', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ category, max_time: maxTime, random: false })
        });
        const data = await res.json();
        if (data.success && data.type === 'list') {
            renderQuickResults(data, category, maxTime);
        } else {
            content.innerHTML = `<div style="text-align:center;padding:40px 20px;color:var(--text-muted)"><div style="font-size:32px;margin-bottom:12px">😕</div>${data.error || 'Nie udało się załadować propozycji'}</div>`;
        }
    } catch (e) {
        console.error('Error loading quick results:', e);
        content.innerHTML = `<div style="text-align:center;padding:40px 20px;color:var(--text-muted)"><div style="font-size:32px;margin-bottom:12px">⚠️</div>Błąd połączenia</div>`;
    }
}

function renderQuickResults(data, category, maxTime) {
    const categoryNames = {
        'mieso': 'Mięso', 'ryba': 'Ryba', 'makaron': 'Makaron',
        'salatka': 'Sałatka', 'jajka': 'Jajka', 'zupa': 'Zupa',
        'kanapka': 'Kanapka', 'wrap': 'Wrap', 'one_pot': 'One-pot'
    };
    
    const categoryName = categoryNames[category] || category;
    
    // Update header
    document.getElementById('quickResultsTitle').textContent = `⚡ ${categoryName} · do ${maxTime} min`;
    document.getElementById('quickResultsCount').textContent = `Znaleziono ${data.dishes.length} przepisów`;
    
    // Render cards
    const content = document.getElementById('quickResultsContent');
    if (!data.dishes.length) {
        content.innerHTML = `
            <div style="text-align: center; padding: 40px 20px; color: var(--text-muted);">
                <div style="font-size: 48px; margin-bottom: 16px;">🤷‍♂️</div>
                <div style="font-size: 16px; margin-bottom: 8px;">Brak przepisów w tej kombinacji</div>
                <div style="font-size: 14px;">Spróbuj wydłużyć czas lub zmienić kategorię</div>
                <button onclick="randomQuickFromOther()" style="margin-top: 16px; padding: 8px 16px; border-radius: 8px; background: var(--gold); border: none; color: var(--bg); font-weight: 600; cursor: pointer;">
                    🎲 Losuj z innej kategorii
                </button>
            </div>
        `;
        return;
    }
    
    content.innerHTML = data.dishes.map((dish, i) => {
        const safeName = esc(dish.name);
        const safeDesc = esc(dish.desc || '');
        const stars = '★'.repeat(dish.difficulty) + '☆'.repeat(3 - dish.difficulty);
        return `
        <div class="quick-result-card" data-dish-name="${safeName}" data-dish-idx="${i}">
            <div class="quick-result-header">
                <div class="quick-result-emoji">${dish.emoji || '🍽️'}</div>
                <div style="flex:1;min-width:0">
                    <div class="quick-result-name">${safeName}</div>
                    ${safeDesc ? `<div class="quick-result-desc">${safeDesc}</div>` : ''}
                </div>
                <div class="quick-result-open">→</div>
            </div>
            <div class="quick-result-meta">
                <span>⏱ ${dish.time} min</span>
                <span>${stars}</span>
            </div>
        </div>`;
    }).join('');
    
    // Wire up click via delegation (avoids quote-escape bugs in dish names)
    content.querySelectorAll('.quick-result-card').forEach(card => {
        card.addEventListener('click', () => {
            const name = card.getAttribute('data-dish-name');
            if (name) generateQuickRecipe(name);
        });
    });
}

async function generateQuickRecipe(recipeName) {
    showView('chat');
    addMsg('user', recipeName);
    
    // Loading bubble
    const msgs = document.getElementById('messages');
    const ld = document.createElement('div');
    ld.className = 'msg';
    ld.innerHTML = '<div class="msg-text">' + loadingDots() + '</div>';
    msgs.appendChild(ld);
    scrollBottom(true);
    
    try {
        const res = await fetch(API + '/api/ask', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ question: recipeName, history: [], lang: currentLang })
        });
        const data = await res.json();
        ld.remove();
        if (data.data) {
            handleResponse(data.data);
        } else {
            addMsg('t', 'Nie udało się wygenerować przepisu: ' + (data.error || 'Nieznany błąd'));
        }
    } catch (e) {
        ld.remove();
        console.error('Error generating quick recipe:', e);
        addMsg('t', 'Błąd generowania przepisu');
    }
}

async function randomQuick() {
    try {
        // Animate dice
        const btn = document.querySelector('.random-btn');
        btn.style.transform = 'rotate(360deg)';
        setTimeout(() => btn.style.transform = '', 300);
        
        // Get all categories
        const categories = ['mieso', 'ryba', 'makaron', 'salatka', 'jajka', 'zupa', 'kanapka', 'wrap', 'one_pot'];
        const randomCategory = categories[Math.floor(Math.random() * categories.length)];
        
        const res = await fetch('/api/recipes/quick', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                category: randomCategory,
                max_time: _quickSelectedTime,
                random: true
            })
        });
        
        const data = await res.json();
        
        if (data.success && data.dishes && data.dishes.length > 0) {
            const randomDish = data.dishes[0];
            showView('chat');
            addMsg('system', `🎲 Wylosowano dla Ciebie przepis na: ${randomDish.name} (${_quickSelectedTime} min)!`);
            
            // Generate the actual recipe
            const recipeRes = await fetch(API + '/api/ask', {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify({ 
                    question: randomDish.name,
                    history: [],
                    lang: currentLang
                })
            });
            
            const recipeData = await recipeRes.json();
            if (recipeData.data) {
                handleResponse(recipeData.data);
            }
        } else {
            alert('Nie udało się wylosować przepisu: ' + (data.error || 'Nieznany błąd'));
        }
    } catch (e) {
        console.error('Error random quick:', e);
        alert('Błąd losowania przepisu');
    }
}

function randomQuickFromOther() {
    // Pick a random category and try again
    const categories = ['mieso', 'ryba', 'makaron', 'salatka', 'jajka', 'zupa', 'kanapka', 'wrap', 'one_pot'];
    const randomCategory = categories[Math.floor(Math.random() * categories.length)];
    
    selectCategory(randomCategory);
}

function searchClassic() {
    const input = document.getElementById('classicSearch');
    const q = input?.value.trim().toLowerCase();
    if (!q) return;
    
    const visible = document.querySelectorAll('#classicCategories .classic-chip:not([style*="display: none"])');
    if (visible.length === 1) {
        visible[0].click();
        input.value = '';
        _applyClassicFilter();
        return;
    }
    if (visible.length === 0) {
        input.value = '';
        _applyClassicFilter();
        showView('chat');
        document.getElementById('input').value = q;
        send();
    }
}

// Live filter + Enter
document.addEventListener('DOMContentLoaded', () => {
    const el = document.getElementById('classicSearch');
    if (el) {
        el.addEventListener('input', () => _applyClassicFilter());
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); searchClassic(); }
        });
    }
});
