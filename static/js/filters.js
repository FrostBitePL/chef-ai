// ─── Filters & Pantry State ───
let activeFilters = {};
let pantryData = { ingredients: [], shopping_mode: false };
let filtersLoaded = false;

// ─── Init ───
async function initFiltersPanel() {
  if (filtersLoaded) return;
  filtersLoaded = true;
  await loadPantry();
  renderFiltersPanel();
}

// ─── Load/Save Pantry ───
async function loadPantry() {
  try {
    const r = await fetch(API + '/api/pantry', { headers: authHeaders() });
    const d = await r.json();
    if (d.pantry) pantryData = d.pantry;
    renderPantryTags();
  } catch {}
}

async function savePantry() {
  try {
    await fetch(API + '/api/pantry', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify(pantryData)
    });
  } catch {}
}

// ─── Render Panel ───
function renderFiltersPanel() {
  const panel = document.getElementById('filtersPanel');
  if (!panel) return;

  const timeOpts = [
    { v: '', l: 'Dowolny' },
    { v: '15', l: '⚡ <15 min' },
    { v: '30', l: '🕐 <30 min' },
    { v: '60', l: '🍳 <1h' },
    { v: '120', l: '🌿 <2h' },
    { v: '999', l: '🐌 Bez limitu' }
  ];

  const techniqueOpts = [
    { v: '', l: 'Dowolna' },
    { v: 'smażenie na patelni', l: '🍳 Smażenie' },
    { v: 'smażenie głębokie', l: '🍟 Deep fry' },
    { v: 'grillowanie', l: '🔥 Grillowanie' },
    { v: 'pieczenie w piekarniku', l: '🥐 Pieczenie' },
    { v: 'gotowanie na parze', l: '♨️ Para' },
    { v: 'duszenie', l: '🫕 Duszenie' },
    { v: 'sous-vide', l: '🌡 Sous-vide' },
    { v: 'wok', l: '🥢 Wok' },
    { v: 'wędzenie', l: '💨 Wędzenie' },
    { v: 'confit', l: '🦆 Confit' },
    { v: 'fermentacja', l: '🫙 Fermentacja' },
    { v: 'pieczenie w niskiej temperaturze', l: '🌡 Low & slow' },
    { v: 'blanszowanie', l: '🥦 Blanszowanie' },
    { v: 'marynowanie', l: '🧂 Marynata' }
  ];

  const cuisineOpts = [
    { v: '', l: 'Dowolna' },
    { v: 'włoska', l: '🇮🇹 Włoska' },
    { v: 'japońska', l: '🇯🇵 Japońska' },
    { v: 'koreańska', l: '🇰🇷 Koreańska' },
    { v: 'chińska', l: '🇨🇳 Chińska' },
    { v: 'tajska', l: '🇹🇭 Tajska' },
    { v: 'azjatycka', l: '🥢 Azjatycka mix' },
    { v: 'polska', l: '🇵🇱 Polska' },
    { v: 'francuska', l: '🥖 Francuska' },
    { v: 'grecka', l: '🫒 Grecka' },
    { v: 'śródziemnomorska', l: '🌊 Śródziemnomorska' },
    { v: 'meksykańska', l: '🌮 Meksykańska' },
    { v: 'indyjska', l: '🍛 Indyjska' },
    { v: 'bliskowschodnia', l: '🫙 Bliskowschodnia' },
    { v: 'skandynawska', l: '🇸🇪 Skandynawska' },
    { v: 'gruzińska', l: '🫕 Gruzińska' },
    { v: 'peruwańska', l: '🌶 Peruwańska' }
  ];

  const dietOpts = [
    { v: '', l: 'Bez ograniczeń' },
    { v: 'wegetariańska', l: '🥦 Wegetariańska' },
    { v: 'wegańska', l: '🌱 Wegańska' },
    { v: 'keto', l: '🥑 Keto' },
    { v: 'bezglutenowa', l: '🚫🌾 Bez glutenu' },
    { v: 'bezlaktozowa', l: '🥛 Bez laktozy' },
    { v: 'wysokobiałkowa', l: '💪 Wysokobiałkowa' },
    { v: 'niskokaloryczna', l: '📉 Niskokaloryczna' },
    { v: 'paleo', l: '🦴 Paleo' },
    { v: 'niskosodowa', l: '🧂 Niskosodowa' }
  ];

  const goalOpts = [
    { v: '', l: 'Bez celu' },
    { v: 'impress — danie na wyjątkową okazję restauracyjnego poziomu', l: '✨ Impress' },
    { v: 'romantyczna kolacja — eleganckie, zmysłowe, idealne na randkę', l: '❤️ Randka' },
    { v: 'comfort food — przytulne, sycące danie na relaks', l: '🛋 Comfort' },
    { v: 'fit po treningu — wysokobiałkowe, odżywcze, bez pustych kalorii', l: '🏋️ Fit/Sport' },
    { v: 'budżetowe — pyszne i tanie składniki', l: '💰 Budżetowe' },
    { v: 'meal prep — idealne do przygotowania z wyprzedzeniem', l: '📦 Meal prep' },
    { v: 'impreza — danie do podziału, łatwe do serwowania grupie', l: '🎉 Impreza' },
    { v: 'śniadanie lub brunch — syte, apetyczne, poranne', l: '☀️ Śniadanie' }
  ];

  const courseOpts = [
    { v: '', l: 'Dowolne' },
    { v: 'zupa', l: '🍲 Zupa' },
    { v: 'sałatka', l: '🥗 Sałatka' },
    { v: 'danie główne', l: '🍽 Danie główne' },
    { v: 'makaron lub risotto', l: '🍝 Makaron/Risotto' },
    { v: 'pizza lub flatbread', l: '🍕 Pizza' },
    { v: 'burger lub kanapka', l: '🍔 Burger/Kanapka' },
    { v: 'przekąska lub tapas', l: '🫒 Przekąska' },
    { v: 'deser', l: '🍰 Deser' },
    { v: 'śniadanie lub brunch', l: '🥞 Śniadanie' },
    { v: 'smoothie lub napój', l: '🥤 Napój' }
  ];

  const proteinOpts = [
    { v: '', l: 'Dowolny' },
    { v: 'kurczak', l: '🍗 Kurczak' },
    { v: 'wołowina', l: '🥩 Wołowina' },
    { v: 'wieprzowina', l: '🐷 Wieprzowina' },
    { v: 'jagnięcina', l: '🐑 Jagnięcina' },
    { v: 'ryby', l: '🐟 Ryby' },
    { v: 'owoce morza', l: '🦐 Owoce morza' },
    { v: 'jajka', l: '🥚 Jajka' },
    { v: 'tofu lub tempeh', l: '🌿 Tofu/Tempeh' },
    { v: 'rośliny strączkowe', l: '🫘 Strączkowe' },
    { v: 'sery', l: '🧀 Ser' }
  ];

  const makeChips = (opts, key) => opts.map(o =>
    `<button class="filter-chip ${activeFilters[key] === o.v && o.v ? 'active' : ''}"
      onclick="setFilter('${key}','${o.v.replace(/'/g, "\\'")}')">${o.l}</button>`
  ).join('');

  panel.innerHTML = `
    <div class="fp-header">
      <span class="fp-title">🎛 Filtry</span>
      <button class="fp-clear ${Object.values(activeFilters).some(v=>v) ? '' : 'hidden'}" onclick="clearFilters()">Wyczyść</button>
    </div>

    <div class="fp-section">
      <div class="fp-label">⏱ Czas przygotowania</div>
      <div class="fp-chips">${makeChips(timeOpts, 'time')}</div>
    </div>

    <div class="fp-section">
      <div class="fp-label">🍽 Rodzaj dania</div>
      <div class="fp-chips">${makeChips(courseOpts, 'course')}</div>
    </div>

    <div class="fp-section">
      <div class="fp-label">🥩 Główny składnik</div>
      <div class="fp-chips">${makeChips(proteinOpts, 'protein')}</div>
    </div>

    <div class="fp-section">
      <div class="fp-label">🔥 Technika gotowania</div>
      <div class="fp-chips">${makeChips(techniqueOpts, 'technique')}</div>
    </div>

    <div class="fp-section">
      <div class="fp-label">🌍 Kuchnia świata</div>
      <div class="fp-chips">${makeChips(cuisineOpts, 'cuisine')}</div>
    </div>

    <div class="fp-section">
      <div class="fp-label">🥗 Dieta</div>
      <div class="fp-chips">${makeChips(dietOpts, 'diet')}</div>
    </div>

    <div class="fp-section">
      <div class="fp-label">🎯 Cel</div>
      <div class="fp-chips">${makeChips(goalOpts, 'goal')}</div>
    </div>

    <div class="fp-divider"></div>

    <div class="fp-section">
      <div class="fp-label">🧺 Spiżarnia
        <label class="fp-toggle">
          <input type="checkbox" id="shoppingModeToggle" ${pantryData.shopping_mode ? 'checked' : ''}
            onchange="toggleShoppingMode(this.checked)">
          <span class="fp-toggle-label">${pantryData.shopping_mode ? '🛒 Idę na zakupy' : '🏠 Gotuję z tego co mam'}</span>
        </label>
      </div>
      <div class="pantry-tags" id="pantryTags"></div>
      <div class="pantry-input-row">
        <input type="text" class="pantry-input" id="pantryInput" placeholder="Dodaj składnik..."
          onkeydown="if(event.key==='Enter')addPantryItem()">
        <button class="pantry-add-btn" onclick="addPantryItem()">+</button>
      </div>
    </div>
  `;
  renderPantryTags();
  updateFiltersBadge();
}

function setFilter(key, value) {
  if (activeFilters[key] === value || !value) {
    delete activeFilters[key];
  } else {
    activeFilters[key] = value;
  }
  renderFiltersPanel();
}

function clearFilters() {
  activeFilters = {};
  renderFiltersPanel();
}

function updateFiltersBadge() {
  const count = Object.values(activeFilters).filter(v => v).length + (pantryData.ingredients.length > 0 ? 1 : 0);
  const badge = document.getElementById('filtersBadge');
  if (badge) {
    badge.textContent = count;
    badge.style.display = count > 0 ? 'flex' : 'none';
  }
}

// ─── Pantry ───
function renderPantryTags() {
  const el = document.getElementById('pantryTags');
  if (!el) return;
  el.innerHTML = pantryData.ingredients.map((ing, i) =>
    `<span class="pantry-tag">${esc(ing)}<button onclick="removePantryItem(${i})">×</button></span>`
  ).join('');
  updateFiltersBadge();
}

function addPantryItem() {
  const inp = document.getElementById('pantryInput');
  const val = (inp?.value || '').trim();
  if (!val) return;
  if (!pantryData.ingredients.includes(val)) {
    pantryData.ingredients.push(val);
    savePantry();
  }
  inp.value = '';
  renderPantryTags();
}

function removePantryItem(i) {
  pantryData.ingredients.splice(i, 1);
  renderPantryTags();
  savePantry();
}

function toggleShoppingMode(checked) {
  pantryData.shopping_mode = checked;
  const lbl = document.querySelector('.fp-toggle-label');
  if (lbl) lbl.textContent = checked ? '🛒 Idę na zakupy' : '🏠 Gotuję z tego co mam';
  savePantry();
}

// ─── Get active context for API calls ───
function getActiveFilters() {
  const hasFilters = Object.values(activeFilters).some(v => v);
  return hasFilters ? activeFilters : null;
}

function getActivePantry() {
  return pantryData.ingredients.length > 0 ? pantryData : null;
}

// ─── Toggle panel ───
function toggleFiltersPanel() {
  const panel = document.getElementById('filtersPanel');
  const overlay = document.getElementById('filtersOverlay');
  if (!panel) return;
  const open = panel.classList.toggle('open');
  if (overlay) overlay.classList.toggle('open', open);
  if (open) initFiltersPanel();
}
