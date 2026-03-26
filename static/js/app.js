// ─── State ───
const API='';
let chatHistory=[],favorites=[];
let timers={},timerIdCounter=0,stepModeData=null,stepModeIndex=0;
let currentModule=null,currentPhase='theory',trainingHistory=[],progress={modules:{}};
let chatSessionId=null;
let MODULES=[],CATEGORIES=[],LEVELS=[],LEVEL_NAMES={};

// ─── Supabase Auth ───
let sbClient=null;
let authToken=null;
let currentUser=null; // supabase user object
let userProfile=null; // profile from our DB

const WELCOME_MSG="Cześć! 🍳 Co gotujemy?\n\nZnam Twój sprzęt, zakazy, preferencje. Pamiętam co ostatnio gotowałeś!";
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
      if(event==='SIGNED_IN'&&session){
        authToken=session.access_token;
        currentUser=session.user;
        await onLogin();
      } else if(event==='SIGNED_OUT'){
        authToken=null;currentUser=null;userProfile=null;
        showAuthScreen();
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
  renderUserInfo();
  renderQuickTags();
  addWelcome();
  checkServer();
  newSession();
  loadProgress();
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
function renderUserInfo(){
  const el=document.getElementById('userInfo');
  if(!el) return;
  const name=userProfile?.name||currentUser?.email?.split('@')[0]||'User';
  el.innerHTML='<span class="user-name">'+esc(name)+'</span><button class="user-logout-btn" onclick="logout()" title="Wyloguj">⏻</button>';
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
}

async function loadModulesFromServer(){
  try{const r=await fetch(API+'/api/modules');const d=await r.json();MODULES=d.modules||[];CATEGORIES=d.categories||[];LEVELS=d.levels||[];LEVEL_NAMES=d.level_names||{}}catch{}
}

async function checkServer(){const s=document.getElementById('status');s.className='status-bar show waking';s.textContent='⏳ Łączę...';try{const r=await fetch(API+'/api/health');const d=await r.json();s.className='status-bar show online';s.textContent='✓ '+d.chunks+' fragmentów · DeepSeek';setTimeout(()=>s.classList.remove('show'),2500)}catch{s.className='status-bar show offline';s.textContent='✗ Offline'}}

function toggleKcal(){const r=document.getElementById('kcalRow'),b=document.getElementById('kcalToggle'),v=r.style.display!=='none';r.style.display=v?'none':'flex';b.classList.toggle('active',!v)}
function clearKcal(){document.getElementById('kcalInput').value='';document.getElementById('kcalRow').style.display='none';document.getElementById('kcalToggle').classList.remove('active')}
function getKcal(){const v=document.getElementById('kcalInput')?.value?.trim();return(!v||isNaN(v)||+v<50)?'':`(limit:${v}kcal)`}

function esc(s){if(!s)return'';const d=document.createElement('div');d.textContent=s;return d.innerHTML}
function scrollBottom(){const m=document.getElementById('messages');setTimeout(()=>m.scrollTop=m.scrollHeight,40)}
function fmtT(s){if(s<0)s=0;return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}
function addMsg(t,text){const d=document.createElement('div');d.className='msg';if(t==='user')d.innerHTML='<div class="msg-user">'+esc(text)+'</div>';else{d.innerHTML='<div class="msg-text">'+esc(text)+'</div>'}document.getElementById('messages').appendChild(d);scrollBottom()}
function loadingDots(){return'<div class="loading-dots"><span></span><span></span><span></span></div>'}
