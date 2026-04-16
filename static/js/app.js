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

  // Language priority: 1) Supabase profile, 2) localStorage, 3) default Polish
  const profileLang = userProfile?.lang;
  if (profileLang && SUPPORTED_LANGS.includes(profileLang)) {
    setLang(profileLang, false); // apply without re-saving to profile
  } else if (!localStorage.getItem('chef_lang')) {
    setLang('pl', false); // new user — default to Polish
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
        // Update profile name
        if(name){
          setTimeout(async()=>{
            try{await fetch(API+'/api/profile',{method:'POST',headers:authHeaders(),body:JSON.stringify({name})})}catch{}
          },1000);
        }
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
  const badge=document.getElementById('subBadge');
  if(badge){
    badge.textContent=subStatus.is_pro?'PRO':'FREE';
    badge.classList.toggle('is-pro',subStatus.is_pro);
  }
  // Update lang label
  const ddLang=document.getElementById('ddLang');
  if(ddLang) ddLang.textContent='🌐 Język ('+((window.currentLang||'pl').toUpperCase())+')';
  // Legacy userInfo hidden via CSS
}

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
function scrollBottom(){const m=document.getElementById('messages');setTimeout(()=>m.scrollTop=m.scrollHeight,40)}
function fmtT(s){if(s<0)s=0;return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}
function addMsg(role,text){const d=document.createElement('div');d.className='msg';if(role==='user')d.innerHTML='<div class="msg-user">'+esc(text)+'</div>';else{d.innerHTML='<div class="msg-text">'+esc(text)+'</div>'}document.getElementById('messages').appendChild(d);scrollBottom()}
function loadingDots(){return'<div class="loading-dots"><span></span><span></span><span></span></div>'}

// ─── Onboarding ───
let obStep=0;
const OB_EQUIPMENT={
  basic:['Piekarnik','Płyta indukcyjna/gazowa','Patelnia nieprzywierająca','Garnek','Waga kuchenna','Nóż szefa kuchni'],
  advanced:['Piekarnik z termoobiegiem','Płyta indukcyjna','Patelnia stalowa','Patelnia żeliwna','Patelnia nieprzywierająca','Sous-vide cyrkulator','Robot kuchenny','Blender','Waga kuchenna','Termometr sondowy'],
  pro:['Płyta indukcyjna (poziomy 1-14)','Piekarnik z termosondą','Sous-vide cyrkulator','Płyta stalowa 8mm','Blender (prędkość 1-5)','Robot kuchenny (prędkość 1-7)','Maszynka do makaronu','Maszynka do mielenia','Waga analityczna 0.001g','Waga kuchenna','Syfon iSi (N2O)','Vacuum sealer','Pirometr','Hydrokoloidy']
};
const OB_BANS={
  none:[],
  lactose:['Mleko','Śmietana','Masło','Ser żółty','Jogurt'],
  gluten:['Mąka pszenna','Chleb','Makaron pszenny','Panierka'],
  vegan:['Mięso','Ryby','Nabiał','Jajka','Miód']
};
let obData={name:'',level:'mid',equipment:[],bans:[]};

function showOnboarding(){
  document.getElementById('appMain').style.display='none';
  document.getElementById('onboardingOverlay').style.display='flex';
  obStep=0;
  obData.name=userProfile?.name||currentUser?.user_metadata?.full_name||currentUser?.email?.split('@')[0]||'';
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
    el.innerHTML=dots+'<h2 class="ob-title">'+t('ob.equip_title')+'</h2>'
      +'<p class="ob-sub">'+t('ob.equip_sub')+'</p>'
      +'<div class="ob-presets">'
      +'<button class="ob-preset'+(obData.equipmentPreset==='basic'?' active':'')+'" onclick="selectEquipPreset(\'basic\')">'+t('ob.equip_basic')+'</button>'
      +'<button class="ob-preset'+(obData.equipmentPreset==='advanced'?' active':'')+'" onclick="selectEquipPreset(\'advanced\')">'+t('ob.equip_advanced')+'</button>'
      +'<button class="ob-preset'+(obData.equipmentPreset==='pro'?' active':'')+'" onclick="selectEquipPreset(\'pro\')">'+t('ob.equip_pro')+'</button>'
      +'</div>'
      +'<div class="ob-tags" id="obEquipTags"></div>'
      +'<div class="ob-add-row"><input type="text" class="auth-input" id="obNewEquip" placeholder="'+t('ob.equip_add')+'" style="margin:0;flex:1"><button class="ob-add-btn" onclick="obAddEquip()">+</button></div>'
      +'<div class="ob-nav"><button class="ob-back" onclick="obStep=0;renderObStep()">'+t('ob.back')+'</button><button class="auth-submit" onclick="obNext()" style="flex:1">'+t('ob.next')+'</button></div>';
    renderObEquipTags();
  }
  else if(obStep===2){
    el.innerHTML=dots+'<h2 class="ob-title">'+t('ob.bans_title')+'</h2>'
      +'<p class="ob-sub">'+t('ob.bans_sub')+'</p>'
      +'<div class="ob-presets">'
      +'<button class="ob-preset" onclick="addBanPresetOb(\'lactose\')">'+t('ob.ban_lactose')+'</button>'
      +'<button class="ob-preset" onclick="addBanPresetOb(\'gluten\')">'+t('ob.ban_gluten')+'</button>'
      +'<button class="ob-preset" onclick="addBanPresetOb(\'vegan\')">'+t('ob.ban_vegan')+'</button>'
      +'</div>'
      +'<div class="ob-tags" id="obBanTags"></div>'
      +'<div class="ob-add-row"><input type="text" class="auth-input" id="obNewBan" placeholder="'+t('ob.ban_add')+'" style="margin:0;flex:1"><button class="ob-add-btn" onclick="obAddBan()">+</button></div>'
      +'<div class="ob-nav"><button class="ob-back" onclick="obStep=1;renderObStep()">'+t('ob.back')+'</button><button class="auth-submit ob-finish" onclick="finishOnboarding()" style="flex:1">'+t('ob.finish')+'</button></div>';
    renderObBanTags();
  }
}

function selectEquipPreset(key){
  obData.equipmentPreset=key;
  obData.equipment=[...OB_EQUIPMENT[key]];
  renderObStep();
}

function renderObEquipTags(){
  const el=document.getElementById('obEquipTags');
  if(!el) return;
  el.innerHTML=obData.equipment.map((e,i)=>'<span class="ob-tag" onclick="obData.equipment.splice('+i+',1);renderObEquipTags()">'+esc(e)+' ✕</span>').join('');
}

function obAddEquip(){
  const inp=document.getElementById('obNewEquip');
  const v=inp?.value?.trim();
  if(v&&!obData.equipment.includes(v)){obData.equipment.push(v);inp.value='';renderObEquipTags()}
}

function addBanPresetOb(key){
  OB_BANS[key].forEach(b=>{if(!obData.bans.includes(b))obData.bans.push(b)});
  renderObBanTags();
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
    if(!obData.equipment.length){
      // Pre-select based on level
      if(obData.level==='beginner') obData.equipment=[...OB_EQUIPMENT.basic];
      else if(obData.level==='mid') obData.equipment=[...OB_EQUIPMENT.advanced];
      else obData.equipment=[...OB_EQUIPMENT.pro];
      obData.equipmentPreset=obData.level==='beginner'?'basic':obData.level==='mid'?'advanced':'pro';
    }
  }
  obStep++;
  renderObStep();
}

async function finishOnboarding(){
  const btn=document.querySelector('.ob-finish');
  if(btn){btn.disabled=true;btn.textContent=t('ob.saving')}
  
  const profile={
    name:obData.name,
    equipment:obData.equipment,
    banned_ingredients:obData.bans,
    bot_profile:obData.level==='pro'?'lukasz':'guest'
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
    if (flowType === 'guests' && userProfile?.role !== 'pro' && userProfile?.role !== 'admin') {
        showProModal();
        return;
    }
    
    switch(flowType) {
        case 'ingredients':
            // TODO: Implement ingredients flow
            showView('chat');
            addMessage('system', 'Flow "Z tego co mam" - w trakcie implementacji. Napisz jakie składniki masz.');
            break;
            
        case 'quick':
            // TODO: Implement quick flow  
            showView('chat');
            addMessage('system', 'Flow "Szybko" - w trakcie implementacji. Napisz czego szukasz do 30 minut.');
            break;
            
        case 'discover':
            // TODO: Implement discover flow
            showView('chat');
            addMessage('system', 'Flow "Coś nowego" - w trakcie implementacji. Napisz jakiej kuchni chcesz spróbować.');
            break;
            
        case 'classic':
            showView('flow-classic');
            loadClassicChips();
            break;
            
        case 'healthy':
            // TODO: Implement healthy flow
            showView('chat');
            addMessage('system', 'Flow "Zdrowe" - w trakcie implementacji. Napisz jakie masz cele żywieniowe.');
            break;
            
        case 'guests':
            // TODO: Implement guests flow (PRO only)
            showView('chat');
            addMessage('system', 'Flow "Dla gości" - w trakcie implementacji. Napisz na ile osób planujesz menu.');
            break;
    }
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

async function loadClassicChips() {
    try {
        const response = await fetch('/api/recipes/classic', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({})
        });
        
        const data = await response.json();
        
        if (data.success) {
            renderClassicChips(data.classics);
        } else {
            console.error('Failed to load classics:', data.error);
        }
    } catch (error) {
        console.error('Error loading classics:', error);
    }
}

function renderClassicChips(classics) {
    const polishEl = document.getElementById('polishChips');
    const worldEl = document.getElementById('worldChips');
    const dessertEl = document.getElementById('dessertChips');
    
    if (polishEl) {
        polishEl.innerHTML = classics.polish.map(recipe => 
            `<div class="classic-chip" onclick="generateClassicRecipe('${recipe.name}')">${recipe.name}</div>`
        ).join('');
    }
    
    if (worldEl) {
        worldEl.innerHTML = classics.world.map(recipe => 
            `<div class="classic-chip" onclick="generateClassicRecipe('${recipe.name}')">${recipe.name}</div>`
        ).join('');
    }
    
    if (dessertEl) {
        dessertEl.innerHTML = classics.desserts.map(recipe => 
            `<div class="classic-chip" onclick="generateClassicRecipe('${recipe.name}')">${recipe.name}</div>`
        ).join('');
    }
    
    // Show unavailable recipes as crossed out
    const dietary = userProfile?.dietary_preferences || [];
    if (dietary.length > 0) {
        const subtitle = document.querySelector('.flow-subtitle');
        if (subtitle) {
            subtitle.textContent = `Dopasowane do: ${dietary.join(', ')}`;
        }
    }
}

async function generateClassicRecipe(recipeName) {
    const loadingEl = document.getElementById('classicLoading');
    const categoriesEl = document.getElementById('classicCategories');
    
    // Show loading
    if (loadingEl && categoriesEl) {
        categoriesEl.style.display = 'none';
        loadingEl.style.display = 'flex';
    }
    
    try {
        const response = await fetch('/api/recipes/classic', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ query: recipeName })
        });
        
        const data = await response.json();
        
        if (data.success && data.recipe) {
            // Switch to chat and show recipe
            showView('chat');
            addMessage('assistant', '', data.recipe);
            
            // Add to chat history
            chatHistory.push({
                role: 'assistant',
                content: '',
                data: data.recipe,
                type: 'recipe',
                id: Date.now().toString()
            });
        } else {
            alert('Nie udało się wygenerować przepisu: ' + (data.error || 'Nieznany błąd'));
        }
    } catch (error) {
        console.error('Error generating recipe:', error);
        alert('Błąd podczas generowania przepisu');
    } finally {
        // Hide loading
        if (loadingEl && categoriesEl) {
            loadingEl.style.display = 'none';
            categoriesEl.style.display = 'block';
        }
    }
}

function searchClassic() {
    const searchInput = document.getElementById('classicSearch');
    const query = searchInput.value.trim();
    
    if (!query) return;
    
    generateClassicRecipe(query);
    searchInput.value = '';
}

// Add Enter handler for classic search
document.addEventListener('DOMContentLoaded', () => {
    const classicSearch = document.getElementById('classicSearch');
    if (classicSearch) {
        classicSearch.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                searchClassic();
            }
        });
    }
});
