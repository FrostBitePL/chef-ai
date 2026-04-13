async function loadHistory(){
  const el=document.getElementById('historyList');
  try{
    const r=await fetch(API+'/api/history',{headers:authHeaders()});const d=await r.json();
    if(!d.sessions?.length){el.innerHTML='<div class="fav-empty"><div style="font-size:2.2rem;margin-bottom:8px">🕐</div><div style="font-size:0.95rem;color:var(--text-dim)">'+t('history.empty_title')+'</div><div style="font-size:0.8rem;color:var(--text-faint);margin-top:4px">'+t('history.empty_hint')+'</div></div>';return}
    el.innerHTML=d.sessions.map(s=>'<div class="history-item" onclick="restoreSession(\''+esc(s.id)+'\')"><button class="h-del" onclick="event.stopPropagation();deleteSession(\''+esc(s.id)+'\')">'+t('history.delete')+'</button><h3>'+esc(s.title||t('history.session'))+'</h3><div class="h-meta">'+(s.profile==='lukasz'?'👨‍🍳':'🌍')+' · '+new Date(s.saved_at).toLocaleDateString(currentLang)+' · '+Math.floor((s.messages?.length||0)/2)+' '+t('history.messages')+'</div></div>').join('');
  }catch{el.innerHTML='<div style="padding:20px;color:var(--text-faint)">'+t('history.error')+'</div>'}
}

async function restoreSession(id){
  try{
    const r=await fetch(API+'/api/history',{headers:authHeaders()});const d=await r.json();
    const s=d.sessions?.find(x=>x.id===id);
    if(!s) return;

    // Switch to chat view first
    showView('chat');

    // Clear messages and rebuild from history
    chatHistory=s.messages||[];
    document.getElementById('messages').innerHTML='';

    chatHistory.forEach(m=>{
      if(m.role==='user'){
        addMsg('user',m.content);
      } else {
        try{
          const data=JSON.parse(m.content);
          if(data.type==='recipe') renderRecipeCard(data);
          else if(data.type==='comparison') renderComparison(data);
          else addMsg('t',data.content||m.content);
        }catch{
          addMsg('t',m.content);
        }
      }
    });

    chatSessionId=id;
    document.getElementById('quickTags').style.display='none';
    scrollBottom();
  }catch(e){console.error('Restore failed:',e)}
}

async function deleteSession(id){try{await fetch(API+'/api/history/'+id,{method:'DELETE',headers:authHeaders()});loadHistory()}catch{}}
