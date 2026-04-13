// ─── Server-side Favorites ───
async function loadFavorites(){
  try{
    const r=await fetch(API+'/api/favorites',{headers:authHeaders()});
    const d=await r.json();
    favorites=d.favorites||[];
    updateFavBadge();
  }catch{favorites=[]}
}

async function toggleFav(b){
  const r=getRecipe(b);if(!r)return;
  const existing=favorites.find(f=>f.recipe?.title===r.title);
  if(existing){
    await fetch(API+'/api/favorites/'+existing.id,{method:'DELETE',headers:authHeaders()});
    b.className='action-btn';b.textContent=t('recipe.save');
  } else {
    await fetch(API+'/api/favorites',{method:'POST',headers:authHeaders(),body:JSON.stringify({recipe:r})});
    b.className='action-btn saved';b.textContent=t('recipe.saved');
  }
  await loadFavorites();
}

function updateFavBadge(){const b=document.getElementById('fav-badge');if(favorites.length){b.style.display='inline-flex';b.textContent=favorites.length}else b.style.display='none'}

async function renderFavorites(){
  await loadFavorites();
  const l=document.getElementById('favList');
  if(!favorites.length){l.innerHTML='<div class="fav-empty"><div style="font-size:2.2rem;margin-bottom:8px">❤️</div><div style="font-size:0.95rem;color:var(--text-dim)">'+t('fav.empty_title')+'</div><div style="font-size:0.8rem;color:var(--text-faint);margin-top:4px">'+t('fav.empty_hint')+'</div></div>';return}
  l.innerHTML=favorites.map((f,i)=>{
    const r=f.recipe||{};
    return '<div class="fav-item" onclick="showFavRecipe('+i+')"><h3>'+esc(r.title||'?')+'</h3><div class="fav-meta">'+(r.times?'⏱ '+(r.times.total_min||'?')+' min':'')+'</div><div class="fav-actions"><button class="action-btn" onclick="event.stopPropagation();removeFav('+f.id+')">'+t('fav.delete')+'</button><button class="action-btn" onclick="event.stopPropagation();cpTxt(favorites['+i+'].recipe)">'+t('recipe.copy')+'</button></div></div>';
  }).join('');
}

function showFavRecipe(i){if(favorites[i]?.recipe){showView('chat');renderRecipeCard(favorites[i].recipe);scrollBottom()}}

async function removeFav(fid){
  await fetch(API+'/api/favorites/'+fid,{method:'DELETE',headers:authHeaders()});
  await loadFavorites();
  renderFavorites();
}

function copyRecipe(b){const r=getRecipe(b);if(r){cpTxt(r);b.textContent=t('recipe.copied');setTimeout(()=>{b.textContent=t('recipe.copy')},1500)}}
function cpTxt(r){let txt=r.title+'\n';if(r.subtitle)txt+=r.subtitle+'\n';txt+='\n⏱'+(r.times?.total_min||'?')+'m | 🍽'+(r.servings||2)+'\n';if(r.shopping_list?.length){txt+='\nZAKUPY:\n';r.shopping_list.forEach(s=>{txt+='☐ '+s.amount+' '+s.item+'\n'})}if(r.ingredients?.length){txt+='\nSKŁADNIKI:\n';r.ingredients.forEach(s=>{txt+='• '+s.amount+' '+s.item+(s.note?' ('+s.note+')':'')+'\n'})}if(r.steps?.length){txt+='\nMETODA:\n';r.steps.forEach(s=>{txt+='\n'+s.number+'. '+(s.title||'')+'\n'+s.instruction+'\n';if(s.equipment)txt+='  🔥 '+s.equipment+'\n'})}navigator.clipboard?.writeText(txt)}
