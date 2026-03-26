// ─── Profile View ───
async function loadProfileView(){
  const el=document.getElementById('profileContent');
  el.innerHTML=loadingDots();
  try{
    const r=await fetch(API+'/api/profile',{headers:authHeaders()});const p=await r.json();
    renderProfileView(p,el);
  }catch{el.innerHTML='<div style="padding:20px;color:var(--text-faint)">Nie udało się załadować profilu.</div>'}
}

function renderProfileView(p,el){
  let h='';
  const userName=currentUser?currentUser.name:'Użytkownik';

  // ─── Equipment ───
  h+='<div class="profile-section"><h3>🔧 Mój sprzęt</h3>';
  h+='<div class="profile-hint">Bot będzie podawał konkretne ustawienia Twojego sprzętu w przepisach.</div>';
  h+='<div class="tag-list">';
  (p.equipment||[]).forEach(e=>{
    h+='<span class="tag removable" onclick="removeProfileTag(\'equipment\',\''+esc(e).replace(/'/g,"\\'")+'\')">'+esc(e)+' ✕</span>';
  });
  h+='<span class="tag-add" onclick="addEquipment()">+ Dodaj sprzęt</span>';
  h+='</div>';
  if(!(p.equipment||[]).length){
    h+='<div class="profile-presets"><div class="profile-hint" style="margin-top:8px">Szybki start:</div>';
    h+='<button class="action-btn" onclick="loadEquipmentPreset(\'basic\')" style="margin:3px">🏠 Podstawowy</button>';
    h+='<button class="action-btn" onclick="loadEquipmentPreset(\'advanced\')" style="margin:3px">👨‍🍳 Zaawansowany</button>';
    h+='<button class="action-btn" onclick="loadFullPreset(\'lukasz\')" style="margin:3px">⭐ Zestaw Łukasza</button>';
    h+='</div>';
  }
  h+='</div>';

  // ─── Banned ingredients ───
  h+='<div class="profile-section"><h3>🚫 Zakazy (składniki których nie jem)</h3>';
  h+='<div class="profile-hint">Bot NIGDY nie zaproponuje tych składników.</div>';
  h+='<div class="tag-list">';
  (p.banned_ingredients||[]).forEach(b=>{
    h+='<span class="tag removable tag-ban" onclick="removeProfileTag(\'banned_ingredients\',\''+esc(b).replace(/'/g,"\\'")+'\')">'+esc(b)+' ✕</span>';
  });
  h+='<span class="tag-add" onclick="addProfileTag(\'banned_ingredients\',\'Składnik do wykluczenia:\')">+ Dodaj zakaz</span>';
  h+='</div>';
  if(!(p.banned_ingredients||[]).length){
    h+='<div class="profile-presets"><div class="profile-hint" style="margin-top:8px">Popularne zestawy zakazów:</div>';
    h+='<button class="action-btn" onclick="loadBanPreset(\'lukasz\')" style="margin:3px">⭐ Zakazy Łukasza</button>';
    h+='<button class="action-btn" onclick="loadBanPreset(\'vegetarian\')" style="margin:3px">🥬 Wegetariańskie</button>';
    h+='<button class="action-btn" onclick="loadBanPreset(\'lactose\')" style="margin:3px">🥛 Bez laktozy</button>';
    h+='</div>';
  }
  h+='</div>';

  // ─── Favorite ingredients ───
  h+='<div class="profile-section"><h3>🥕 Ulubione składniki</h3>';
  h+='<div class="profile-hint">Bot będzie częściej proponował te składniki.</div>';
  h+='<div class="tag-list">';
  (p.favorite_ingredients||[]).forEach(i=>{
    h+='<span class="tag removable" onclick="removeProfileTag(\'favorite_ingredients\',\''+esc(i).replace(/'/g,"\\'")+'\')">'+esc(i)+' ✕</span>';
  });
  h+='<span class="tag-add" onclick="addProfileTag(\'favorite_ingredients\',\'Ulubiony składnik:\')">+ Dodaj</span>';
  h+='</div></div>';

  // ─── Stats ───
  h+='<div class="profile-section"><h3>📊 Statystyki</h3>';
  h+='<div class="profile-stat"><span class="ps-label">Ugotowanych przepisów</span><span class="ps-value">'+(p.cooked_recipes?.length||0)+'</span></div>';
  h+='<div class="profile-stat"><span class="ps-label">Opanowane umiejętności</span><span class="ps-value">'+(p.mastered_skills?.length||0)+'</span></div>';
  h+='<div class="profile-stat"><span class="ps-label">Ocenionych dań</span><span class="ps-value">'+(p.ratings?.length||0)+'</span></div>';
  h+='</div>';

  // ─── Cooked recipes ───
  if(p.cooked_recipes?.length){
    h+='<div class="profile-section"><h3>🍽 Ostatnio gotowane</h3>';
    p.cooked_recipes.slice(-10).reverse().forEach(r=>{
      h+='<div class="profile-stat"><span class="ps-label">'+esc(r.title)+'</span><span class="ps-value" style="font-size:0.72rem;color:var(--text-faint)">'+(r.date?new Date(r.date).toLocaleDateString('pl'):'')+'</span></div>';
    });
    h+='</div>';
  }

  // ─── Favorite techniques ───
  h+='<div class="profile-section"><h3>🔥 Ulubione techniki</h3>';
  h+='<div class="tag-list">';
  (p.favorite_techniques||[]).forEach(t=>{
    h+='<span class="tag removable" onclick="removeProfileTag(\'favorite_techniques\',\''+esc(t).replace(/'/g,"\\'")+'\')">'+esc(t)+' ✕</span>';
  });
  h+='<span class="tag-add" onclick="addProfileTag(\'favorite_techniques\',\'Nowa technika:\')">+ Dodaj</span>';
  h+='</div></div>';

  // ─── Discovered preferences ───
  h+='<div class="profile-section"><h3>💡 Odkryte preferencje</h3>';
  h+='<div class="tag-list">';
  (p.discovered_preferences||[]).forEach(pr=>{
    h+='<span class="tag removable" onclick="removeProfileTag(\'discovered_preferences\',\''+esc(pr).replace(/'/g,"\\'")+'\')">'+esc(pr)+' ✕</span>';
  });
  h+='<span class="tag-add" onclick="addProfileTag(\'discovered_preferences\',\'Nowa preferencja:\')">+ Dodaj</span>';
  h+='</div></div>';

  // ─── Mastered skills ───
  if(p.mastered_skills?.length){
    h+='<div class="profile-section"><h3>🏆 Opanowane</h3><div class="tag-list">';
    p.mastered_skills.forEach(s=>{h+='<span class="tag" style="border-color:var(--success);color:var(--success)">✓ '+esc(s)+'</span>'});
    h+='</div></div>';
  }

  // ─── Ratings ───
  if(p.ratings?.length){
    h+='<div class="profile-section"><h3>⭐ Oceny dań</h3>';
    p.ratings.slice(-10).reverse().forEach(r=>{
      const stars='★'.repeat(r.score||0)+'☆'.repeat(5-(r.score||0));
      h+='<div class="profile-rating"><span class="stars">'+stars+'</span><span>'+esc(r.title)+'</span>'+(r.comment?'<span style="color:var(--text-faint);font-size:0.75rem;margin-left:auto">'+esc(r.comment)+'</span>':'')+'</div>';
    });
    h+='</div>';
  }

  // ─── Reset ───
  h+='<div style="text-align:center;margin-top:16px"><button class="action-btn" style="color:var(--danger);border-color:var(--danger)" onclick="resetProfile()">🗑 Resetuj profil</button></div>';

  el.innerHTML=h;
}

// ─── Equipment presets ───
const EQUIPMENT_PRESETS={
  basic:['Piekarnik','Płyta indukcyjna/gazowa','Patelnia nieprzywierająca','Garnek','Mikser ręczny','Waga kuchenna','Nóż szefa kuchni'],
  advanced:['Piekarnik z termoobiegiem','Płyta indukcyjna','Patelnia stalowa','Patelnia żeliwna','Patelnia nieprzywierająca','Sous-vide cyrkulator','Robot kuchenny','Blender','Waga kuchenna','Termometr sondowy','Maszynka do mielenia'],
  lukasz:['AEG indukcja (poziomy 1-14 + Boost)','Piekarnik AEG z termosondą','Sous-vide cyrkulator','Płyta stalowa 8mm','Braun MQ7 blender (prędkość 1-5)','Bosch MUM5 robot (prędkość 1-7)','Marcato Atlas 150 (grubość 1-7)','Maszynka do mielenia','Waga analityczna 0.001g','Waga kuchenna','Syfon iSi (N2O)','Vacuum sealer','Pirometr','Hydrokoloidy (agar, alginian+CaCl2, pektyna NH, żelatyna 200 Bloom, ksantan, lecytyna, cytrynian sodu)']
};

const BAN_PRESETS={
  lukasz:['Cebula (każda forma: surowa, smażona, proszek, szalotka, dymka, por, szczypiorek, zielona cebulka)','Surowizna (tatar, sushi, carpaccio)','Kaczka','Gęś','Małże','Ośmiornica','Kalmary','Ostrygi','Kraby','Homary','Kolendra (świeża i mielona)','Anyż','Badian','Koper włoski (fennel)','Lukrecja','Estragon','Absynt'],
  vegetarian:['Mięso wołowe','Mięso wieprzowe','Drób','Ryby','Owoce morza','Żelatyna','Smalec'],
  lactose:['Mleko krowie','Śmietana','Masło','Ser żółty','Ser biały','Jogurt','Kefir']
};

async function loadEquipmentPreset(preset){
  const items=EQUIPMENT_PRESETS[preset];
  if(!items) return;
  await fetch(API+'/api/profile',{method:'POST',headers:authHeaders(),body:JSON.stringify({equipment:items})});
  loadProfileView();
}

async function loadBanPreset(preset){
  const items=BAN_PRESETS[preset];
  if(!items) return;
  await fetch(API+'/api/profile',{method:'POST',headers:authHeaders(),body:JSON.stringify({banned_ingredients:items})});
  loadProfileView();
}

async function loadFullPreset(preset){
  const equip=EQUIPMENT_PRESETS[preset];
  const bans=BAN_PRESETS[preset];
  const update={};
  if(equip) update.equipment=equip;
  if(bans) update.banned_ingredients=bans;
  await fetch(API+'/api/profile',{method:'POST',headers:authHeaders(),body:JSON.stringify(update)});
  loadProfileView();
}

function addEquipment(){
  const val=prompt('Dodaj sprzęt (np. "Piekarnik z termoobiegiem", "Patelnia żeliwna 28cm"):');
  if(!val||!val.trim()) return;
  addProfileTag('equipment',null,val.trim());
}

// ─── Tag management ───
async function addProfileTag(field,promptText,directValue){
  const val=directValue||prompt(promptText);
  if(!val||!val.trim()) return;
  try{
    const r=await fetch(API+'/api/profile',{headers:authHeaders()});const p=await r.json();
    const list=p[field]||[];
    if(!list.includes(val.trim())){list.push(val.trim())}
    await fetch(API+'/api/profile',{method:'POST',headers:authHeaders(),body:JSON.stringify({[field]:list})});
    loadProfileView();
  }catch{}
}

async function removeProfileTag(field,val){
  try{
    const r=await fetch(API+'/api/profile',{headers:authHeaders()});const p=await r.json();
    const list=(p[field]||[]).filter(x=>x!==val);
    await fetch(API+'/api/profile',{method:'POST',headers:authHeaders(),body:JSON.stringify({[field]:list})});
    loadProfileView();
  }catch{}
}

async function resetProfile(){
  if(!confirm('Na pewno zresetować cały profil?')) return;
  try{await fetch(API+'/api/profile/reset',{method:'POST',headers:authHeaders()});loadProfileView()}catch{}
}
