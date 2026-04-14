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

  const ratio = newServings / currentServings[rid];
  currentServings[rid] = newServings;

  // Scale data in store
  r.ingredients = (r.ingredients || []).map(ing => ({ ...ing, amount: scaleAmount(ing.amount, ratio) }));
  r.shopping_list = (r.shopping_list || []).map(item => ({ ...item, amount: scaleAmount(item.amount, ratio) }));
  r.servings = newServings;

  // Update only the parts that changed — no full re-render
  const scaleVal = card.querySelector('.scale-val,.stepper-val');
  if (scaleVal) scaleVal.textContent = newServings;

  // Update ingredients section body
  const ingSection = [...card.querySelectorAll('.section-body')].find(el =>
    el.previousElementSibling?.textContent?.includes('Składniki')
  );
  if (ingSection){
    const inner=ingSection.querySelector('.section-body-inner')||ingSection;
    inner.innerHTML=(typeof bIng2==='function'?bIng2:bIng)(r.ingredients);
  }

  // Update shopping list section body
  const shopSection = [...card.querySelectorAll('.section-body')].find(el =>
    el.previousElementSibling?.textContent?.includes('Zakupy')
  );
  if (shopSection){
    const inner=shopSection.querySelector('.section-body-inner')||shopSection;
    inner.innerHTML=bShopExport(rid)+bShop(r.shopping_list);
  }

  // Update servings meta pill
  const pills = card.querySelectorAll('.meta-pill');
  pills.forEach(p => { if (p.textContent.startsWith('🍽')) p.textContent = '🍽' + newServings; });
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
  const modal = createModal(t('modal.pairing'), '<div class="modal-loading">'+loadingDots()+'</div>');
  try {
    const summary = (r.ingredients || []).slice(0, 6).map(i => i.item).join(', ');
    const resp = await fetch(API + '/api/pairing', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ title: r.title, summary })
    });
    const d = await resp.json();
    if (!d.success) { modal.setContent('<p>'+t('error')+': ' + esc(d.error || '') + '</p>'); return; }
    const pairings = d.data?.pairings || [];
    const html = pairings.map(p => `
      <div class="pairing-item">
        <div class="pairing-cat">${esc(p.category)}</div>
        <div class="pairing-name">${esc(p.name)}</div>
        <div class="pairing-why">${esc(p.why)}</div>
        <div class="pairing-serve">🌡 ${esc(p.serve)}</div>
      </div>`).join('');
    modal.setContent(html || '<p>'+t('modal.no_results')+'</p>');
  } catch (e) { modal.setContent('<p>'+t('modal.conn_error')+'</p>'); }
}

// ─── Cooking Timeline ───
async function showTimeline(btn) {
  const r = getRecipe(btn);
  if (!r || !r.steps?.length) return;
  const modal = createModal(t('modal.timeline'), '<div class="modal-loading">'+loadingDots()+'</div>');
  try {
    const resp = await fetch(API + '/api/timeline', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ title: r.title, steps: r.steps })
    });
    const d = await resp.json();
    if (!d.success) { modal.setContent('<p>'+t('modal.error')+'</p>'); return; }
    const tl = d.data;
    let html = `<div class="tl-summary">${t('timeline.active')} <b>${tl.total_active_min} ${t('timeline.min')}</b> | ${t('timeline.total')} <b>${tl.total_elapsed_min} ${t('timeline.min')}</b></div>`;
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
    if (tl.tips?.length) html += '<div class="tl-tips">' + tl.tips.map(tp => `<div>💡 ${esc(tp)}</div>`).join('') + '</div>';
    modal.setContent(html);
  } catch { modal.setContent('<p>'+t('modal.conn_error')+'</p>'); }
}

// ─── Fix Step ───
async function fixStep(stepNum, stepTitle, recipeTitle) {
  const problem = prompt(`${t('fix.prompt_title')} "${stepTitle}"?\n${t('fix.prompt_desc')}`);
  if (!problem) return;
  const modal = createModal(t('modal.fix'), '<div class="modal-loading">'+loadingDots()+'</div>');
  try {
    const resp = await fetch(API + '/api/fix', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ step: stepTitle, problem, recipe_title: recipeTitle })
    });
    const d = await resp.json();
    if (!d.success) { modal.setContent('<p>'+t('modal.error')+'</p>'); return; }
    const fix = d.data;
    let html = `<div class="fix-diag">${esc(fix.diagnosis)}</div>`;
    html += `<div class="fix-save ${fix.can_save ? 'yes' : 'no'}">${fix.can_save ? t('fix.can_save') : t('fix.restart')}</div>`;
    html += '<div class="fix-steps">' + (fix.fix_now || []).map((s,i) => `<div class="fix-step"><span>${i+1}</span>${esc(s)}</div>`).join('') + '</div>';
    if (fix.prevention) html += `<div class="fix-prev">${t('fix.prevention')}${esc(fix.prevention)}</div>`;
    modal.setContent(html);
  } catch { modal.setContent('<p>'+t('modal.conn_error')+'</p>'); }
}

// ─── Recipe Variant ───
async function makeVariant(btn, mode) {
  const r = getRecipe(btn);
  if (!r) return;
  const label = mode === 'healthier' ? t('variant.healthier') : t('variant.richer');
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
    if (!d.success) { addMsg('t', t('error')+': ' + (d.error || '')); return; }
    const recipe = d.data;
    if (recipe.variant_note) {
      addMsg('t', `${label}\n\n${recipe.variant_note}`);
    }
    handleResponse(recipe);
  } catch { loadDiv.remove(); addMsg('t', t('error.conn')); }
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

  const modal = createModal(t('modal.notes') + r.title,
    `<textarea class="note-textarea" id="noteText" placeholder="${t('modal.notes_placeholder')}">${esc(existing)}</textarea>
     <button class="modal-save-btn" onclick="saveNote('${esc(r.title).replace(/'/g,"\\'")}')">${t('modal.save')}</button>`
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
    showStatus(t('modal.note_saved'));
  } catch { showStatus(t('modal.note_error')); }
}

// ─── Share Recipe ───
async function shareRecipe(btn) {
  const r = getRecipe(btn);
  if (!r) return;
  try {
    const resp = await fetch(API + '/api/share', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ recipe: r })
    });
    const d = await resp.json();
    if (!d.success) { showStatus(t('share.error')); return; }
    const url = window.location.origin + '/?share=' + d.token;
    if (navigator.share) {
      await navigator.share({ title: r.title, text: r.subtitle || '', url });
    } else {
      await navigator.clipboard.writeText(url);
      showStatus(t('share.link_copied'));
    }
  } catch (e) { showStatus(t('share.error')); }
}

// ─── Cost Calculator ───
async function showCost(btn) {
  const r = getRecipe(btn);
  if (!r) return;
  const modal = createModal(t('modal.cost'), '<div class="modal-loading">' + loadingDots() + '</div>');
  try {
    const resp = await fetch(API + '/api/cost', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ ingredients: r.ingredients || [], servings: r.servings || 2 })
    });
    const d = await resp.json();
    if (!d.success) { modal.setContent('<p>'+t('error')+': ' + esc(d.error || '') + '</p>'); return; }
    const c = d.data;
    const ratingColor = { tanie: 'var(--accent)', średnie: 'var(--warning)', drogie: 'var(--danger)' };
    let html = `<div class="cost-summary">
      <div class="cost-total">${c.cost_total_pln?.toFixed(2)} zł <span>${t('cost.total')}</span></div>
      <div class="cost-per">${c.cost_per_serving_pln?.toFixed(2)} ${t('cost.per_serving')}</div>
      ${c.budget_rating ? `<div class="cost-rating" style="color:${ratingColor[c.budget_rating]||'var(--gold)'}">● ${c.budget_rating}</div>` : ''}
    </div>`;
    if (c.breakdown?.length) {
      html += '<div class="cost-breakdown">';
      c.breakdown.forEach(item => {
        html += `<div class="cost-row">
          <span class="cost-item">${esc(item.item)}</span>
          <span class="cost-amount">${esc(item.amount||'')}</span>
          <span class="cost-price">${item.price_pln?.toFixed(2)} zł</span>
          ${item.note ? `<span class="cost-note">${esc(item.note)}</span>` : ''}
        </div>`;
      });
      html += '</div>';
    }
    if (c.tips?.length) {
      html += '<div class="cost-tips">' + c.tips.map(tp => `<div>💡 ${esc(tp)}</div>`).join('') + '</div>';
    }
    modal.setContent(html);
  } catch (e) { modal.setContent('<p>'+t('modal.conn_error')+'</p>'); }
}

// ─── Export Shopping List ───
function exportShoppingList(rid, mode) {
  const r = recipeStore[rid];
  if (!r?.shopping_list?.length) return;

  const grouped = {};
  r.shopping_list.forEach(i => {
    const sec = i.section || 'inne';
    if (!grouped[sec]) grouped[sec] = [];
    grouped[sec].push(`${i.amount ? i.amount + ' ' : ''}${i.item}`);
  });

  const lines = [`${t('shop.list_title')}: ${r.title}`, ''];
  Object.entries(grouped).forEach(([sec, items]) => {
    lines.push(`── ${sec.toUpperCase()} ──`);
    items.forEach(i => lines.push('• ' + i));
    lines.push('');
  });
  const text = lines.join('\n');

  if (mode === 'copy') {
    navigator.clipboard.writeText(text).then(() => showStatus(t('shop.list_copied')));
  } else if (mode === 'share') {
    if (navigator.share) {
      navigator.share({ title: t('shop.list_title') + ': ' + r.title, text });
    } else {
      navigator.clipboard.writeText(text).then(() => showStatus(t('shop.list_copied')));
    }
  } else if (mode === 'print') {
    const w = window.open('', '_blank');
    w.document.write(`<html><head><title>${t('shop.list_title')}: ${r.title}</title>
      <style>body{font-family:sans-serif;padding:20px;max-width:400px}h1{font-size:1.2rem}
      pre{white-space:pre-wrap;font-size:0.95rem;line-height:1.8}</style></head>
      <body><h1>${t('shop.list_title')}</h1><h2>${r.title}</h2><pre>${text}</pre></body></html>`);
    w.document.close();
    w.print();
  }
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
