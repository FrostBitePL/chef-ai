// ─── Scaling ───
let currentServings = {};

function scaleRecipe(btn, delta) {
  const card = btn.closest('.recipe-card');
  const rid = card?.dataset?.rid;
  if (!rid) return;
  const r = recipeStore[rid];
  if (!r) return;

  if (!currentServings[rid]) currentServings[rid] = r.servings || 2;
  const newServings = Math.max(1, Math.min(12, currentServings[rid] + delta));
  if (newServings === currentServings[rid]) return;

  const ratio = newServings / (currentServings[rid]);
  currentServings[rid] = newServings;

  // Scale ingredients
  r.ingredients = (r.ingredients || []).map(ing => {
    const scaled = scaleAmount(ing.amount, ratio);
    return { ...ing, amount: scaled };
  });
  r.shopping_list = (r.shopping_list || []).map(item => {
    return { ...item, amount: scaleAmount(item.amount, ratio) };
  });
  r.servings = newServings;

  // Re-render card in place
  const newCard = document.createElement('div');
  newCard.className = 'msg';
  newCard.innerHTML = buildRecipeHTML(r);
  card.closest('.msg').replaceWith(newCard);
}

function scaleAmount(amountStr, ratio) {
  if (!amountStr) return amountStr;
  return amountStr.replace(/(\d+(?:[.,]\d+)?)/g, (match, num) => {
    const scaled = parseFloat(num.replace(',', '.')) * ratio;
    return scaled % 1 === 0 ? scaled.toFixed(0) : scaled.toFixed(1).replace('.', ',');
  });
}

// ─── Drink Pairing ───
async function showPairing(btn) {
  const r = getRecipe(btn);
  if (!r) return;
  const modal = createModal('🍷 Parowanie napojów', '<div class="modal-loading">'+loadingDots()+'</div>');
  try {
    const summary = (r.ingredients || []).slice(0, 6).map(i => i.item).join(', ');
    const resp = await fetch(API + '/api/pairing', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ title: r.title, summary })
    });
    const d = await resp.json();
    if (!d.success) { modal.setContent('<p>Błąd: ' + esc(d.error || '') + '</p>'); return; }
    const pairings = d.data?.pairings || [];
    const html = pairings.map(p => `
      <div class="pairing-item">
        <div class="pairing-cat">${esc(p.category)}</div>
        <div class="pairing-name">${esc(p.name)}</div>
        <div class="pairing-why">${esc(p.why)}</div>
        <div class="pairing-serve">🌡 ${esc(p.serve)}</div>
      </div>`).join('');
    modal.setContent(html || '<p>Brak wyników</p>');
  } catch (e) { modal.setContent('<p>Błąd połączenia</p>'); }
}

// ─── Cooking Timeline ───
async function showTimeline(btn) {
  const r = getRecipe(btn);
  if (!r || !r.steps?.length) return;
  const modal = createModal('📊 Harmonogram gotowania', '<div class="modal-loading">'+loadingDots()+'</div>');
  try {
    const resp = await fetch(API + '/api/timeline', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ title: r.title, steps: r.steps })
    });
    const d = await resp.json();
    if (!d.success) { modal.setContent('<p>Błąd</p>'); return; }
    const tl = d.data;
    let html = `<div class="tl-summary">⏱ Aktywna praca: <b>${tl.total_active_min} min</b> | Łącznie: <b>${tl.total_elapsed_min} min</b></div>`;
    html += '<div class="tl-rows">';
    (tl.timeline || []).forEach(row => {
      html += `<div class="tl-row"><div class="tl-min">${row.minute}'</div><div class="tl-tasks">`;
      (row.parallel || []).forEach(task => {
        html += `<div class="tl-task tl-${task.type}">
          <span class="tl-step">${task.step_num}</span>
          <span>${esc(task.action)}</span>
          <span class="tl-dur">${task.duration_min}min</span>
        </div>`;
      });
      html += '</div></div>';
    });
    html += '</div>';
    if (tl.tips?.length) html += '<div class="tl-tips">' + tl.tips.map(t => `<div>💡 ${esc(t)}</div>`).join('') + '</div>';
    modal.setContent(html);
  } catch { modal.setContent('<p>Błąd połączenia</p>'); }
}

// ─── Fix Step ───
async function fixStep(stepNum, stepTitle, recipeTitle) {
  const problem = prompt(`Problem przy kroku "${stepTitle}"?\nOpisz co poszło nie tak:`);
  if (!problem) return;
  const modal = createModal('🆘 Naprawa przepisu', '<div class="modal-loading">'+loadingDots()+'</div>');
  try {
    const resp = await fetch(API + '/api/fix', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ step: stepTitle, problem, recipe_title: recipeTitle })
    });
    const d = await resp.json();
    if (!d.success) { modal.setContent('<p>Błąd</p>'); return; }
    const fix = d.data;
    let html = `<div class="fix-diag">${esc(fix.diagnosis)}</div>`;
    html += `<div class="fix-save ${fix.can_save ? 'yes' : 'no'}">${fix.can_save ? '✅ Da się uratować' : '❌ Zacznij od nowa'}</div>`;
    html += '<div class="fix-steps">' + (fix.fix_now || []).map((s,i) => `<div class="fix-step"><span>${i+1}</span>${esc(s)}</div>`).join('') + '</div>';
    if (fix.prevention) html += `<div class="fix-prev">💡 Następnym razem: ${esc(fix.prevention)}</div>`;
    modal.setContent(html);
  } catch { modal.setContent('<p>Błąd połączenia</p>'); }
}

// ─── Recipe Variant ───
async function makeVariant(btn, mode) {
  const r = getRecipe(btn);
  if (!r) return;
  const label = mode === 'healthier' ? '🥗 Zdrowsza wersja' : '👑 Bogatsza wersja';
  const loadDiv = document.createElement('div');
  loadDiv.className = 'msg';
  const prev = document.createElement('div');
  prev.className = 'stream-preview';
  prev.innerHTML = loadingDots() + ` <span style="color:var(--gold)">${label}…</span>`;
  loadDiv.appendChild(prev);
  document.getElementById('messages').appendChild(loadDiv);
  scrollBottom();
  try {
    const resp = await fetch(API + '/api/variant', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ mode, recipe: r })
    });
    const d = await resp.json();
    loadDiv.remove();
    if (d.is_limit) { showLimitMessage(d.message); return; }
    if (!d.success) { addMsg('t', 'Błąd: ' + (d.error || '')); return; }
    const recipe = d.data;
    if (recipe.variant_note) {
      addMsg('t', `${label}\n\n${recipe.variant_note}`);
    }
    handleResponse(recipe);
  } catch { loadDiv.remove(); addMsg('t', 'Błąd połączenia.'); }
  scrollBottom();
}

// ─── Recipe Notes ───
async function openNotes(btn) {
  const r = getRecipe(btn);
  if (!r) return;
  let existing = '';
  try {
    const resp = await fetch(API + '/api/notes/' + encodeURIComponent(r.title), { headers: authHeaders() });
    const d = await resp.json();
    existing = d.note?.text || '';
  } catch {}

  const modal = createModal('📝 Notatki do przepisu: ' + r.title,
    `<textarea class="note-textarea" id="noteText" placeholder="Twoje notatki po ugotowaniu — co zmienić, co wyszło świetnie...">${esc(existing)}</textarea>
     <button class="modal-save-btn" onclick="saveNote('${esc(r.title).replace(/'/g,"\\'")}')">💾 Zapisz</button>`
  );
}

async function saveNote(title) {
  const text = document.getElementById('noteText')?.value || '';
  try {
    await fetch(API + '/api/notes', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ recipe_title: title, note: text })
    });
    closeModal();
    showStatus('Notatka zapisana ✓');
  } catch { showStatus('Błąd zapisu'); }
}

// ─── Modal helper ───
function createModal(title, content) {
  const existing = document.getElementById('recipeModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'recipeModal';
  modal.className = 'recipe-modal';
  modal.innerHTML = `
    <div class="recipe-modal-backdrop" onclick="closeModal()"></div>
    <div class="recipe-modal-box">
      <div class="recipe-modal-header">
        <div class="recipe-modal-title">${title}</div>
        <button class="recipe-modal-close" onclick="closeModal()">✕</button>
      </div>
      <div class="recipe-modal-body" id="modalBody">${content}</div>
    </div>`;
  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('open'));

  return {
    setContent(html) { document.getElementById('modalBody').innerHTML = html; }
  };
}

function closeModal() {
  const m = document.getElementById('recipeModal');
  if (m) { m.classList.remove('open'); setTimeout(() => m.remove(), 250); }
}
