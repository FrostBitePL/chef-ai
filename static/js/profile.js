// ─── Profile View ───
async function loadProfileView(){
  const el=document.getElementById('profileContent');
  el.innerHTML=loadingDots();
  try{
    // Load both profile and subscription status
    const [profileRes, subRes] = await Promise.all([
      fetch(API+'/api/profile',{headers:authHeaders()}),
      loadSubStatus()
    ]);
    const p = await profileRes.json();
    renderProfileView(p,el);
  }catch{el.innerHTML='<div style="padding:20px;color:var(--text-faint)">'+t('profile.load_error')+'</div>'}
}

function renderProfileView(p,el){
  let h='';
  const userName = currentUser?.user_metadata?.full_name || p?.name || currentUser?.name || currentUser?.email?.split('@')[0] || 'Użytkownik';
  const userEmail = currentUser?.email || '';
  const initials = userName.slice(0,2).toUpperCase();
  
  // ─── HERO CARD ───
  h+='<div class="profile-hero">';
  h+='<div class="profile-avatar">'+initials+'</div>';
  h+='<div class="profile-name">'+esc(userName)+'</div>';
  h+='<div class="profile-email">'+esc(userEmail)+'</div>';
  h+='<div class="profile-pro-row">';
  if(subStatus.is_pro){
    h+='<span class="profile-pro-badge">PRO</span> · od marca 2025';
  } else {
    h+='<span class="profile-free-badge">FREE</span>';
  }
  h+='</div>';
  h+='</div>';

  // ─── STATYSTYKI BAR ───
  const cookedCount = p.cooked_recipes?.length || 0;
  const masteredCount = p.mastered_skills?.length || 0;
  const ratedCount = p.ratings?.length || 0;
  
  h+='<div class="profile-stats-bar">';
  h+='<div class="profile-stat-col"><div class="profile-stat-value">'+cookedCount+'</div><div class="profile-stat-label">Ugotowane</div></div>';
  h+='<div class="profile-stat-sep"></div>';
  h+='<div class="profile-stat-col"><div class="profile-stat-value">'+masteredCount+'</div><div class="profile-stat-label">Opanowane</div></div>';
  h+='<div class="profile-stat-sep"></div>';
  h+='<div class="profile-stat-col"><div class="profile-stat-value">'+ratedCount+'</div><div class="profile-stat-label">Ocenione</div></div>';
  h+='</div>';

  // ─── GRUPA: MOJA KUCHNIA ───
  const equipCount = (p.equipment||[]).length;
  const banCount = (p.banned_ingredients||[]).length;
  const favCount = (p.favorite_ingredients||[]).length;
  const prefCount = (p.discovered_preferences||[]).length;
  
  h+='<div class="profile-group">';
  h+='<div class="profile-group-header" onclick="toggleProfileGroup(\'kitchen\')">🔧 Moja kuchnia</div>';
  h+='<div class="profile-group-body" id="profileGroupKitchen">';
  
  h+='<div class="profile-accordion-item" onclick="toggleAccordionItem(\'equipment\')">';
  h+='<div class="profile-accordion-header">🔧 Sprzęt <span class="profile-count">'+equipCount+'</span> <span class="profile-chevron">▼</span></div>';
  h+='<div class="profile-accordion-body" id="accordionEquipment">';
  h+=renderEquipmentSection(p);
  h+='</div></div>';
  
  h+='<div class="profile-accordion-item" onclick="toggleAccordionItem(\'bans\')">';
  h+='<div class="profile-accordion-header">🚫 Zakazy <span class="profile-count">'+banCount+'</span> <span class="profile-chevron">▼</span></div>';
  h+='<div class="profile-accordion-body" id="accordionBans">';
  h+=renderBansSection(p);
  h+='</div></div>';
  
  if(favCount > 0){
    h+='<div class="profile-accordion-item" onclick="toggleAccordionItem(\'favorites\')">';
    h+='<div class="profile-accordion-header">💚 Ulubione składniki <span class="profile-count">'+favCount+'</span> <span class="profile-chevron">▼</span></div>';
    h+='<div class="profile-accordion-body" id="accordionFavorites">';
    h+=renderFavoritesSection(p);
    h+='</div></div>';
  }
  
  if(prefCount > 0){
    h+='<div class="profile-accordion-item" onclick="toggleAccordionItem(\'preferences\')">';
    h+='<div class="profile-accordion-header">💡 Preferencje smakowe <span class="profile-count">'+prefCount+'</span> <span class="profile-chevron">▼</span></div>';
    h+='<div class="profile-accordion-body" id="accordionPreferences">';
    h+=renderPreferencesSection(p);
    h+='</div></div>';
  }
  
  h+='</div></div>';

  // ─── GRUPA: MOJE POSTĘPY ───
  h+='<div class="profile-group">';
  const progressCount = cookedCount + masteredCount + ratedCount;
  h+='<div class="profile-group-header" onclick="toggleProfileGroup(\'progress\')">🏆 Moje postępy <span class="profile-group-count">'+progressCount+'</span></div>';
  h+='<div class="profile-group-body" id="profileGroupProgress">';
  
  if(cookedCount > 0){
    h+='<div class="profile-accordion-item" onclick="toggleAccordionItem(\'recent\')">';
    h+='<div class="profile-accordion-header">🕐 Ostatnio gotowane <span class="profile-count">'+cookedCount+'</span> <span class="profile-chevron">▼</span></div>';
    h+='<div class="profile-accordion-body" id="accordionRecent">';
    h+=renderRecentSection(p);
    h+='</div></div>';
  }
  
  if(masteredCount > 0){
    h+='<div class="profile-accordion-item" onclick="toggleAccordionItem(\'mastered\')">';
    h+='<div class="profile-accordion-header">🏆 Opanowane techniki <span class="profile-count">'+masteredCount+'</span> <span class="profile-chevron">▼</span></div>';
    h+='<div class="profile-accordion-body" id="accordionMastered">';
    h+=renderMasteredSection(p);
    h+='</div></div>';
  }
  
  if(ratedCount > 0){
    h+='<div class="profile-accordion-item" onclick="toggleAccordionItem(\'ratings\')">';
    h+='<div class="profile-accordion-header">⭐ Oceny dań <span class="profile-count">'+ratedCount+'</span> <span class="profile-chevron">▼</span></div>';
    h+='<div class="profile-accordion-body" id="accordionRatings">';
    h+=renderRatingsSection(p);
    h+='</div></div>';
  }
  
  h+='</div></div>';

  // ─── USTAWIENIA ───
  h+='<div class="profile-settings">';
  h+='<div class="profile-settings-header">⚙️ Ustawienia</div>';
  h+='<div class="profile-settings-item" onclick="openLanguageSettings()"><div class="profile-settings-left"><span>🌐</span><span>Język</span></div><div class="profile-settings-right"><span>PL</span><span>→</span></div></div>';
  h+='<div class="profile-settings-item" onclick="openSubscriptionSettings()"><div class="profile-settings-left"><span>📊</span><span>Subskrypcja</span></div><div class="profile-settings-right"><span>'+(subStatus.is_pro?'PRO':'FREE')+'</span><span>→</span></div></div>';
  h+='<div class="profile-settings-item" onclick="openPasswordSettings()"><div class="profile-settings-left"><span>�</span><span>Zmień hasło</span></div><div class="profile-settings-right"><span>→</span></div></div>';
  h+='<div class="profile-settings-item" onclick="exportProfileData()"><div class="profile-settings-left"><span>�</span><span>Eksport danych</span></div><div class="profile-settings-right"><span>→</span></div></div>';
  h+='<div class="profile-settings-item" onclick="showResetConfirmation()"><div class="profile-settings-left"><span>🗑️</span><span>Resetuj profil</span></div><div class="profile-settings-right"><span>→</span></div></div>';
  h+='</div>';

  // ─── WYLOGUJ ───
  h+='<button class="profile-logout" onclick="logout()">Wyloguj</button>';

  el.innerHTML=h;
}

// ─── Section renderers ───
function renderEquipmentSection(p) {
  let h = '';
  const equipment = p.equipment || [];
  
  if(equipment.length === 0) {
    h += '<div class="profile-empty">Brak sprzętu — dodaj podstawowe narzędzia kuchenne.</div>';
    h += '<div class="profile-presets">';
    h += '<button class="profile-preset-btn" onclick="loadEquipmentPreset(\'basic\')">Podstawowy</button>';
    h += '<button class="profile-preset-btn" onclick="loadEquipmentPreset(\'advanced\')">Zaawansowany</button>';
    h += '<button class="profile-preset-btn" onclick="loadFullPreset(\'lukasz\')">Łukasz</button>';
    h += '</div>';
  } else {
    // Group equipment by categories
    const categories = categorizeEquipment(equipment);
    Object.entries(categories).forEach(([cat, items]) => {
      if(items.length > 0) {
        h += '<div class="profile-category-label">'+cat+'</div>';
        h += '<div class="profile-chip-list">';
        items.forEach(item => {
          h += '<span class="profile-chip profile-chip-equipment" onclick="removeProfileTag(\'equipment\',\''+esc(item).replace(/'/g,"\\'")+'\')">';
          h += esc(item) + ' <span class="profile-chip-x">×</span></span>';
        });
        h += '</div>';
      }
    });
  }
  
  h += '<button class="profile-add-btn" onclick="addEquipment()">+ Dodaj sprzęt</button>';
  return h;
}

function renderBansSection(p) {
  let h = '';
  const bans = p.banned_ingredients || [];
  
  if(bans.length === 0) {
    h += '<div class="profile-empty">Brak zakazów — dodaj składniki których nie lubisz.</div>';
    h += '<div class="profile-presets">';
    h += '<button class="profile-preset-btn" onclick="loadBanPreset(\'lukasz\')">Łukasz</button>';
    h += '<button class="profile-preset-btn" onclick="loadBanPreset(\'vegetarian\')">Wegetariańskie</button>';
    h += '<button class="profile-preset-btn" onclick="loadBanPreset(\'lactose\')">Bez laktozy</button>';
    h += '</div>';
  } else {
    // Group bans by categories
    const categories = categorizeBans(bans);
    Object.entries(categories).forEach(([cat, items]) => {
      if(items.length > 0) {
        h += '<div class="profile-category-label">'+cat+'</div>';
        h += '<div class="profile-chip-list">';
        items.forEach(item => {
          h += '<span class="profile-chip profile-chip-ban" onclick="removeProfileTag(\'banned_ingredients\',\''+esc(item).replace(/'/g,"\\'")+'\')">';
          h += esc(item) + ' <span class="profile-chip-x">×</span></span>';
        });
        h += '</div>';
      }
    });
  }
  
  h += '<button class="profile-add-btn profile-add-btn-ban" onclick="addProfileTag(\'banned_ingredients\',\''+t('profile.ban_prompt')+'\')">+ Dodaj zakaz</button>';
  return h;
}

function renderFavoritesSection(p) {
  let h = '';
  const favorites = p.favorite_ingredients || [];
  
  h += '<div class="profile-chip-list">';
  favorites.forEach(item => {
    h += '<span class="profile-chip profile-chip-favorite" onclick="removeProfileTag(\'favorite_ingredients\',\''+esc(item).replace(/'/g,"\\'")+'\')">';
    h += esc(item) + ' <span class="profile-chip-x">×</span></span>';
  });
  h += '</div>';
  h += '<button class="profile-add-btn profile-add-btn-favorite" onclick="addProfileTag(\'favorite_ingredients\',\''+t('profile.fav_prompt')+'\')">+ Dodaj składnik</button>';
  return h;
}

function renderPreferencesSection(p) {
  let h = '';
  const prefs = p.discovered_preferences || [];
  
  h += '<div class="profile-empty">Bot uczy się Twoich preferencji z ocen dań i historii gotowania.</div>';
  if(prefs.length > 0) {
    h += '<div class="profile-chip-list">';
    prefs.forEach(pref => {
      h += '<span class="profile-chip profile-chip-preference">'+esc(pref)+'</span>';
    });
    h += '</div>';
  } else {
    h += '<div class="profile-empty">Brak odkrytych preferencji — gotuj i oceniaj dania, a bot dostosuje się do Twojego gustu.</div>';
  }
  return h;
}

function renderRecentSection(p) {
  let h = '';
  const recent = p.cooked_recipes || [];
  
  recent.slice(-10).reverse().forEach(recipe => {
    h += '<div class="profile-recent-item">';
    h += '<div class="profile-recent-name">'+esc(recipe.title)+'</div>';
    h += '<div class="profile-recent-date">'+(recipe.date ? new Date(recipe.date).toLocaleDateString('pl') : '')+'</div>';
    h += '</div>';
  });
  return h;
}

function renderMasteredSection(p) {
  let h = '';
  const mastered = p.mastered_skills || [];
  
  h += '<div class="profile-chip-list">';
  mastered.forEach(skill => {
    h += '<span class="profile-chip profile-chip-mastered">✓ '+esc(skill)+'</span>';
  });
  h += '</div>';
  return h;
}

function renderRatingsSection(p) {
  let h = '';
  const ratings = p.ratings || [];
  
  ratings.slice(-10).reverse().forEach(rating => {
    const stars = '★'.repeat(rating.score || 0) + '☆'.repeat(5 - (rating.score || 0));
    h += '<div class="profile-rating-item">';
    h += '<span class="profile-rating-stars">'+stars+'</span>';
    h += '<span class="profile-rating-name">'+esc(rating.title)+'</span>';
    h += '</div>';
  });
  return h;
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
  const val=prompt(t('profile.equip_prompt'));
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

// ─── Categorization functions ───
function categorizeEquipment(equipment) {
  const categories = {
    'GOTOWANIE': [],
    'PRZETWARZANIE': [],
    'POMIARY': [],
    'SPECJALNE': [],
    'NACZYNIA': [],
    'INNE': []
  };
  
  equipment.forEach(item => {
    const lower = item.toLowerCase();
    if(lower.includes('piekarnik') || lower.includes('płyta') || lower.includes('indukcja') || lower.includes('gazowa')) {
      categories['GOTOWANIE'].push(item);
    } else if(lower.includes('blender') || lower.includes('robot') || lower.includes('maszynka') || lower.includes('mikser')) {
      categories['PRZETWARZANIE'].push(item);
    } else if(lower.includes('waga') || lower.includes('termometr') || lower.includes('pirometr') || lower.includes('analityczna')) {
      categories['POMIARY'].push(item);
    } else if(lower.includes('sous-vide') || lower.includes('syfon') || lower.includes('hydrokoloidy') || lower.includes('vacuum')) {
      categories['SPECJALNE'].push(item);
    } else if(lower.includes('patelnia') || lower.includes('garnek') || lower.includes('płyta stalowa')) {
      categories['NACZYNIA'].push(item);
    } else {
      categories['INNE'].push(item);
    }
  });
  
  return categories;
}

function categorizeBans(bans) {
  const categories = {
    'WARZYWA': [],
    'DRÓB I MIĘSO': [],
    'OWOCE MORZA': [],
    'PRZYPRAWY I AROMATY': [],
    'SUROWE DANIA': [],
    'INNE': []
  };
  
  bans.forEach(item => {
    const lower = item.toLowerCase();
    if(lower.includes('cebula') || lower.includes('kolendra') || lower.includes('por') || lower.includes('szczypiorek')) {
      categories['WARZYWA'].push(item);
    } else if(lower.includes('kaczka') || lower.includes('gęś') || lower.includes('mięso') || lower.includes('drób')) {
      categories['DRÓB I MIĘSO'].push(item);
    } else if(lower.includes('małże') || lower.includes('ośmiornica') || lower.includes('kalmary') || lower.includes('ostrygi') || lower.includes('kraby') || lower.includes('homary') || lower.includes('owoce morza')) {
      categories['OWOCE MORZA'].push(item);
    } else if(lower.includes('anyż') || lower.includes('badian') || lower.includes('koper') || lower.includes('lukrecja') || lower.includes('estragon') || lower.includes('absynt')) {
      categories['PRZYPRAWY I AROMATY'].push(item);
    } else if(lower.includes('surowizna') || lower.includes('tatar') || lower.includes('sushi') || lower.includes('carpaccio')) {
      categories['SUROWE DANIA'].push(item);
    } else {
      categories['INNE'].push(item);
    }
  });
  
  return categories;
}

// ─── Accordion functions ───
function toggleAccordionItem(itemId) {
  const body = document.getElementById('accordion' + itemId.charAt(0).toUpperCase() + itemId.slice(1));
  const chevron = body?.parentElement.querySelector('.profile-chevron');
  
  if(body) {
    const isOpen = body.classList.contains('open');
    body.classList.toggle('open', !isOpen);
    if(chevron) chevron.textContent = isOpen ? '▼' : '▲';
  }
}

function toggleProfileGroup(groupId) {
  const body = document.getElementById('profileGroup' + groupId.charAt(0).toUpperCase() + groupId.slice(1));
  if(body) {
    body.classList.toggle('open');
  }
}

// ─── Settings functions ───
function openLanguageSettings() {
  cycleLang(); // Use existing language cycling
}

function openSubscriptionSettings() {
  openUpgrade(); // Use existing subscription management
}

function openPasswordSettings() {
  alert('Zmiana hasła - funkcja w przygotowaniu');
}

function exportProfileData() {
  alert('Eksport danych - funkcja w przygotowaniu');
}

function showResetConfirmation() {
  // TODO: Implement reset confirmation drawer
  resetProfile();
}

async function resetProfile(){
  if(!confirm(t('profile.reset_confirm'))) return;
  try{await fetch(API+'/api/profile/reset',{method:'POST',headers:authHeaders()});loadProfileView()}catch{}
}
