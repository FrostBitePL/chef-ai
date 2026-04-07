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

const WELCOME_MSG="Cześć! 🍳 Co dziś gotujemy?\n\nPowiedz mi co chcesz ugotować, a przygotuję przepis dopasowany do Twojego sprzętu i preferencji.\n\nMożesz też kliknąć jedną z podpowiedzi poniżej, aby szybko zacząć.";
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
  inp.addEventListener('input',()=>{sb.disabled=!inp.value.trim();inp.style.height='auto';inp.style.height=Math.min(inp.scrollHeight,90)+'px'});
  inp.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});
  document.getElementById('feedbackField')?.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendFeedback()}});
});

// ─── Supabase Init ───
async function initSupabase(){
  try{
    const r=await fetch(API+'/api/config');
    const cfg=await r.json();
    if(!cfg.supabase_url||!cfg.supabase_anon_key){showAuthScreen('Supabase nie skonfigurowane');return}
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
  }catch(e){console.error('Supabase init error:',e);showAuthScreen('Błąd połączenia')}
}

async function onLogin(){
  hideAuthScreen();
  // Load profile
  try{
    const r=await fetch(API+'/api/profile',{headers:authHeaders()});
    userProfile=await r.json();
  }catch{userProfile={}}
  
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
  addWelcome();
  checkServer();
  checkSharedRecipe();
  newSession();
  loadProgress();
  // Check for payment return
  const params=new URLSearchParams(window.location.search);
  if(params.get('payment')==='success'){
    setTimeout(()=>{addMsg('t','🎉 Witaj w Chef AI PRO! Gotujemy bez limitów.');loadSubStatus().then(()=>renderUserInfo())},500);
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
      addMsg('t','🔗 Udostępniony przepis:');
      handleResponse(d.recipe);
    } else {
      addMsg('t','⚠️ Link wygasł lub jest nieprawidłowy.');
    }
  }catch{addMsg('t','⚠️ Nie udało się załadować przepisu.');}
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
  document.getElementById('authTitle').textContent=isLogin?'Rejestracja':'Logowanie';
  document.getElementById('authSubmitBtn').textContent=isLogin?'Zarejestruj się':'Zaloguj się';
  document.getElementById('authToggle').innerHTML=isLogin?'Masz konto? <a href="#" onclick="toggleAuthMode();return false">Zaloguj się</a>':'Nie masz konta? <a href="#" onclick="toggleAuthMode();return false">Zarejestruj się</a>';
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
  if(!email||!pass){errEl.textContent='Podaj email i hasło';return}
  if(pass.length<6){errEl.textContent='Hasło min. 6 znaków';return}
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
  }catch(e){errEl.textContent='Błąd: '+e.message}
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
  }catch(e){document.getElementById('authError').textContent='Błąd: '+e.message}
}

// ─── User Info ───
let subStatus={is_pro:false,status:'free',recipes_today:0,recipes_limit:5};

function renderUserInfo(){
  const el=document.getElementById('userInfo');
  if(!el) return;
  const name=userProfile?.name||currentUser?.email?.split('@')[0]||'User';
  let h='<span class="user-name">'+esc(name)+'</span>';
  if(subStatus.is_pro){
    h+='<span class="pro-badge">PRO</span>';
  } else {
    h+='<button class="upgrade-btn" onclick="openUpgrade()">⭐ PRO</button>';
  }
  h+='<button class="user-logout-btn" onclick="logout()">Wyloguj</button>';
  el.innerHTML=h;
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
  h+='<div class="upgrade-header"><h2>⭐ Chef AI PRO</h2><p>Gotowanie bez limitów</p></div>';
  h+='<div class="upgrade-body">';
  h+='<div class="upgrade-price"><span class="upgrade-amount">€6.99</span><span class="upgrade-period">/miesiąc</span></div>';
  h+='<div class="upgrade-features">';
  h+='<div class="upgrade-feat">✓ Nielimitowane przepisy</div>';
  h+='<div class="upgrade-feat">✓ Nielimitowany import z URL</div>';
  h+='<div class="upgrade-feat">✓ Live cooking z przyciskiem Problem</div>';
  h+='<div class="upgrade-feat">✓ Pełne szkolenie (45 modułów)</div>';
  h+='<div class="upgrade-feat">✓ Personalizacja sprzętu</div>';
  h+='<div class="upgrade-feat">✓ Porównanie technik</div>';
  h+='</div>';
  h+='<button class="auth-submit" onclick="startCheckout()" id="checkoutBtn">Przejdź na PRO →</button>';
  h+='<div class="upgrade-note">Możesz anulować w każdej chwili</div>';
  h+='</div></div>';
  const div=document.createElement('div');div.className='msg';div.innerHTML=h;
  el.appendChild(div);scrollBottom();
}

async function startCheckout(){
  const btn=document.getElementById('checkoutBtn');
  if(btn){btn.disabled=true;btn.textContent='⏳ Przekierowuję...'}
  try{
    const r=await fetch(API+'/api/stripe/checkout',{method:'POST',headers:authHeaders()});
    const d=await r.json();
    if(d.url) window.location.href=d.url;
    else if(btn){btn.disabled=false;btn.textContent='Przejdź na PRO →'}
  }catch{if(btn){btn.disabled=false;btn.textContent='Przejdź na PRO →'}}
}

function showLimitMessage(msg){
  const el=document.getElementById('messages');
  let h='<div class="limit-card">';
  h+='<div class="limit-icon">🔒</div>';
  h+='<div class="limit-text">'+esc(msg)+'</div>';
  h+='<button class="auth-submit" onclick="openUpgrade()" style="margin-top:12px">⭐ Przejdź na PRO</button>';
  h+='</div>';
  const div=document.createElement('div');div.className='msg';div.innerHTML=h;
  el.appendChild(div);scrollBottom();
}

function renderQuickTags(){
  const bp=botProfile();
  document.getElementById('quickTags').innerHTML=(QTAGS[bp]||QTAGS.guest).map(t=>'<button class="quick-tag" onclick="sendQ(\''+t.q.replace(/'/g,"\\'")+'\')">'+t.e+' '+t.l+'</button>').join('');
}

function addWelcome(){
  const name=userProfile?.name||currentUser?.email?.split('@')[0]||'';
  const msg=WELCOME_MSG.replace('Cześć!','Cześć'+(name?' '+name:'')+'!');
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
  if(n==='planner') renderSavedPlans();
}

async function loadModulesFromServer(){
  try{const r=await fetch(API+'/api/modules');const d=await r.json();MODULES=d.modules||[];CATEGORIES=d.categories||[];LEVELS=d.levels||[];LEVEL_NAMES=d.level_names||{}}catch{}
}

async function checkServer(){const s=document.getElementById('status');s.className='status-bar show waking';s.textContent='Łączę...';try{const r=await fetch(API+'/api/health');s.className='status-bar show online';s.textContent='✓ Połączono';setTimeout(()=>s.classList.remove('show'),1500)}catch{s.className='status-bar show offline';s.textContent='Brak połączenia z serwerem'}}

function toggleKcal(){const r=document.getElementById('kcalRow'),b=document.getElementById('kcalToggle'),v=r.style.display!=='none';r.style.display=v?'none':'flex';b.classList.toggle('active',!v);if(!v)updateKcalSummary()}
function clearKcal(){document.getElementById('kcalInput').value='';document.getElementById('kcalServings').value='1';document.getElementById('kcalSummary').textContent='';document.getElementById('kcalRow').style.display='none';document.getElementById('kcalToggle').classList.remove('active')}
function getKcalValue(){const v=document.getElementById('kcalInput')?.value?.trim();return(!v||isNaN(v)||+v<50)?0:parseInt(v,10)}
function getServingsValue(){return parseInt(document.getElementById('kcalServings')?.value||'1',10)||1}
function updateKcalSummary(){const k=getKcalValue(),s=getServingsValue(),el=document.getElementById('kcalSummary');if(k>0){el.textContent='= '+(k*s)+' kcal łącznie'}else{el.textContent=''}}

function esc(s){if(!s)return'';const d=document.createElement('div');d.textContent=s;return d.innerHTML}
function scrollBottom(){const m=document.getElementById('messages');setTimeout(()=>m.scrollTop=m.scrollHeight,40)}
function fmtT(s){if(s<0)s=0;return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}
function addMsg(t,text){const d=document.createElement('div');d.className='msg';if(t==='user')d.innerHTML='<div class="msg-user">'+esc(text)+'</div>';else{d.innerHTML='<div class="msg-text">'+esc(text)+'</div>'}document.getElementById('messages').appendChild(d);scrollBottom()}
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
    el.innerHTML=dots+'<h2 class="ob-title">Cześć! 👋</h2>'
      +'<p class="ob-sub">Jak masz na imię?</p>'
      +'<input type="text" class="auth-input" id="obName" value="'+esc(obData.name)+'" placeholder="Twoje imię" autofocus>'
      +'<p class="ob-sub" style="margin-top:20px">Twój poziom w kuchni:</p>'
      +'<div class="ob-levels">'
      +'<button class="ob-level'+(obData.level==='beginner'?' active':'')+'" onclick="obData.level=\'beginner\';renderObStep()"><span class="ob-level-icon">🥚</span><span class="ob-level-name">Początkujący</span><span class="ob-level-desc">Uczę się podstaw</span></button>'
      +'<button class="ob-level'+(obData.level==='mid'?' active':'')+'" onclick="obData.level=\'mid\';renderObStep()"><span class="ob-level-icon">🍳</span><span class="ob-level-name">Średni</span><span class="ob-level-desc">Gotuję regularnie</span></button>'
      +'<button class="ob-level'+(obData.level==='pro'?' active':'')+'" onclick="obData.level=\'pro\';renderObStep()"><span class="ob-level-icon">👨‍🍳</span><span class="ob-level-name">Zaawansowany</span><span class="ob-level-desc">Szukam precyzji</span></button>'
      +'</div>'
      +'<button class="auth-submit" onclick="obNext()" style="margin-top:20px">Dalej →</button>';
  }
  else if(obStep===1){
    el.innerHTML=dots+'<h2 class="ob-title">Twój sprzęt 🔧</h2>'
      +'<p class="ob-sub">Wybierz zestaw lub dodaj własny sprzęt</p>'
      +'<div class="ob-presets">'
      +'<button class="ob-preset'+(obData.equipmentPreset==='basic'?' active':'')+'" onclick="selectEquipPreset(\'basic\')">🏠 Podstawowy</button>'
      +'<button class="ob-preset'+(obData.equipmentPreset==='advanced'?' active':'')+'" onclick="selectEquipPreset(\'advanced\')">👨‍🍳 Zaawansowany</button>'
      +'<button class="ob-preset'+(obData.equipmentPreset==='pro'?' active':'')+'" onclick="selectEquipPreset(\'pro\')">⭐ Profesjonalny</button>'
      +'</div>'
      +'<div class="ob-tags" id="obEquipTags"></div>'
      +'<div class="ob-add-row"><input type="text" class="auth-input" id="obNewEquip" placeholder="Dodaj sprzęt..." style="margin:0;flex:1"><button class="ob-add-btn" onclick="obAddEquip()">+</button></div>'
      +'<div class="ob-nav"><button class="ob-back" onclick="obStep=0;renderObStep()">← Wstecz</button><button class="auth-submit" onclick="obNext()" style="flex:1">Dalej →</button></div>';
    renderObEquipTags();
  }
  else if(obStep===2){
    el.innerHTML=dots+'<h2 class="ob-title">Czego nie jesz? 🚫</h2>'
      +'<p class="ob-sub">Nigdy nie zaproponujemy tych składników</p>'
      +'<div class="ob-presets">'
      +'<button class="ob-preset" onclick="addBanPresetOb(\'lactose\')">🥛 Bez laktozy</button>'
      +'<button class="ob-preset" onclick="addBanPresetOb(\'gluten\')">🌾 Bez glutenu</button>'
      +'<button class="ob-preset" onclick="addBanPresetOb(\'vegan\')">🌿 Vegan</button>'
      +'</div>'
      +'<div class="ob-tags" id="obBanTags"></div>'
      +'<div class="ob-add-row"><input type="text" class="auth-input" id="obNewBan" placeholder="Dodaj zakaz..." style="margin:0;flex:1"><button class="ob-add-btn" onclick="obAddBan()">+</button></div>'
      +'<div class="ob-nav"><button class="ob-back" onclick="obStep=1;renderObStep()">← Wstecz</button><button class="auth-submit ob-finish" onclick="finishOnboarding()" style="flex:1">🍳 Gotujemy!</button></div>';
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
  if(btn){btn.disabled=true;btn.textContent='⏳ Zapisuję...'}
  
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
    const q=obData.level==='beginner'?'Zaproponuj 3 proste dania na dobry start':
            obData.level==='mid'?'Zaproponuj 3 ciekawe dania dopasowane do mojego sprzętu':
            'Zaproponuj 3 ambitne dania które wykorzystają mój profesjonalny sprzęt';
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
            alert('Błąd: ' + data.error);
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
        alert('Błąd podczas otwierania checkout: ' + error.message);
    }
}

// Hook this to the PRO badge/button click
document.addEventListener('DOMContentLoaded', () => {
    const proBtn = document.getElementById('proBadge');
    if (proBtn) {
        proBtn.addEventListener('click', openStripeCheckout);
    }
});
