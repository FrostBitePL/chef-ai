#!/usr/bin/env python3
"""Chef AI v11 — Supabase Auth + PostgreSQL + Stripe"""

import os,json,logging,traceback,random,re,functools
from datetime import datetime
from openai import OpenAI
from flask import Flask,request,jsonify,send_from_directory,g
from flask_cors import CORS
import chromadb
from chromadb.utils import embedding_functions
from supabase import create_client,Client
import stripe
try:
    import requests as http_requests
except ImportError:
    http_requests=None

CHROMA_DB_PATH="./chroma_db"
MAX_HISTORY=20; SEARCH_RESULTS=8

# ─── AI Model ───
OPENAI_API_KEY=os.environ.get("OPENAI_API_KEY","")
AI_MODEL="gpt-4o"
AI_MAX_TOKENS=4096
AI_BASE_URL="https://api.openai.com/v1"

SUPABASE_URL=os.environ.get("SUPABASE_URL","")
SUPABASE_KEY=os.environ.get("SUPABASE_SERVICE_KEY","")
SUPABASE_ANON_KEY=os.environ.get("SUPABASE_ANON_KEY","")

STRIPE_SECRET_KEY=os.environ.get("STRIPE_SECRET_KEY","")
STRIPE_WEBHOOK_SECRET=os.environ.get("STRIPE_WEBHOOK_SECRET","")
STRIPE_PRICE_ID=os.environ.get("STRIPE_PRICE_ID","price_1TFBHf91D0CH9ZxXCpC7iZRV")
stripe.api_key=STRIPE_SECRET_KEY

# ─── Free tier limits ───
FREE_RECIPES_PER_DAY=5
FREE_IMPORTS_PER_DAY=2

logging.basicConfig(level=logging.INFO,format="%(asctime)s [%(levelname)s] %(message)s")
logger=logging.getLogger(__name__)

# ─── Supabase Client ───
sb:Client=None
def init_supabase():
    global sb
    if SUPABASE_URL and SUPABASE_KEY:
        sb=create_client(SUPABASE_URL,SUPABASE_KEY)
        logger.info("Supabase connected")
    else:
        logger.warning("Supabase not configured")

# ─── Auth Middleware ───
def get_user_from_token():
    """Extract user_id from Bearer token. Returns None if not authenticated."""
    auth=request.headers.get("Authorization","")
    if not auth.startswith("Bearer "): return None
    token=auth[7:]
    try:
        # Verify token with Supabase
        user_resp=sb.auth.get_user(token)
        if user_resp and user_resp.user:
            return user_resp.user.id
    except Exception as e:
        logger.debug(f"Auth error: {e}")
    return None

def require_auth(f):
    """Decorator: require valid auth token."""
    @functools.wraps(f)
    def wrapper(*args,**kwargs):
        uid=get_user_from_token()
        if not uid: return jsonify({"error":"Unauthorized"}),401
        g.user_id=uid
        return f(*args,**kwargs)
    return wrapper

def optional_auth(f):
    """Decorator: auth optional, sets g.user_id or None."""
    @functools.wraps(f)
    def wrapper(*args,**kwargs):
        g.user_id=get_user_from_token()
        return f(*args,**kwargs)
    return wrapper

# ─── Database Operations ───
DEFAULT_PROFILE={"equipment":[],"banned_ingredients":[],"favorite_ingredients":[],"favorite_techniques":[],"mastered_skills":[],"discovered_preferences":[],"cooked_recipes":[],"ratings":[],"feedback_history":[],"stats":{"total_recipes":0}}

def db_get_profile(uid):
    try:
        r=sb.table("profiles").select("*").eq("id",uid).single().execute()
        return r.data if r.data else dict(DEFAULT_PROFILE)
    except: return dict(DEFAULT_PROFILE)

def db_update_profile(uid,updates):
    updates["updated_at"]=datetime.utcnow().isoformat()
    try: sb.table("profiles").update(updates).eq("id",uid).execute()
    except Exception as e: logger.error(f"Profile update error: {e}")

def db_get_history(uid):
    try:
        r=sb.table("chat_sessions").select("*").eq("user_id",uid).order("saved_at",desc=True).limit(50).execute()
        return {"sessions":[{"id":s["id"],"title":s["title"],"profile":s["bot_profile"],"messages":s["messages"],"saved_at":s["saved_at"]} for s in (r.data or [])]}
    except: return {"sessions":[]}

def db_save_session(uid,session):
    try:
        sb.table("chat_sessions").upsert({
            "id":session["id"],"user_id":uid,"title":session.get("title","Sesja"),
            "bot_profile":session.get("profile","guest"),"messages":session.get("messages",[]),
            "saved_at":datetime.utcnow().isoformat()
        }).execute()
    except Exception as e: logger.error(f"Session save error: {e}")

def db_delete_session(uid,sid):
    try: sb.table("chat_sessions").delete().eq("id",sid).eq("user_id",uid).execute()
    except Exception as e: logger.error(f"Session delete error: {e}")

def db_get_progress(uid):
    try:
        r=sb.table("training_progress").select("*").eq("user_id",uid).execute()
        modules={}
        for row in (r.data or []):
            modules[row["module_id"]]={"theory":row["theory"],"exercise":row["exercise"],"feedback":row["feedback"],"completed":row["completed"],"notes":row["notes"],"last_updated":row["updated_at"]}
        return {"modules":modules}
    except: return {"modules":{}}

def db_save_progress(uid,mid,data):
    try:
        sb.table("training_progress").upsert({
            "user_id":uid,"module_id":mid,
            "theory":data.get("theory",False),"exercise":data.get("exercise",False),
            "feedback":data.get("feedback",False),"completed":data.get("completed",False),
            "notes":data.get("notes",""),"updated_at":datetime.utcnow().isoformat()
        }).execute()
    except Exception as e: logger.error(f"Progress save error: {e}")

def db_reset_progress(uid):
    try: sb.table("training_progress").delete().eq("user_id",uid).execute()
    except Exception as e: logger.error(f"Progress reset error: {e}")

def db_get_favorites(uid):
    try:
        r=sb.table("favorites").select("*").eq("user_id",uid).order("saved_at",desc=True).execute()
        return [{"id":f["id"],"recipe":f["recipe"],"saved_at":f["saved_at"]} for f in (r.data or [])]
    except: return []

def db_add_favorite(uid,recipe):
    try: sb.table("favorites").insert({"user_id":uid,"recipe":recipe}).execute()
    except Exception as e: logger.error(f"Favorite add error: {e}")

def db_remove_favorite(uid,fav_id):
    try: sb.table("favorites").delete().eq("id",fav_id).eq("user_id",uid).execute()
    except Exception as e: logger.error(f"Favorite remove error: {e}")

# ─── Profile Context ───
def profile_to_context(p):
    parts=[]
    eq=p.get("equipment",[]); bans=p.get("banned_ingredients",[])
    if isinstance(eq,str): eq=json.loads(eq) if eq else []
    if isinstance(bans,str): bans=json.loads(bans) if bans else []
    fav=p.get("favorite_ingredients",[]); techs=p.get("favorite_techniques",[])
    if isinstance(fav,str): fav=json.loads(fav) if fav else []
    if isinstance(techs,str): techs=json.loads(techs) if techs else []
    cooked=p.get("cooked_recipes",[]); skills=p.get("mastered_skills",[])
    if isinstance(cooked,str): cooked=json.loads(cooked) if cooked else []
    if isinstance(skills,str): skills=json.loads(skills) if skills else []
    prefs=p.get("discovered_preferences",[]); ratings=p.get("ratings",[])
    if isinstance(prefs,str): prefs=json.loads(prefs) if prefs else []
    if isinstance(ratings,str): ratings=json.loads(ratings) if ratings else []
    fb=p.get("feedback_history",[])
    if isinstance(fb,str): fb=json.loads(fb) if fb else []

    if eq: parts.append("SPRZET UZYTKOWNIKA: "+", ".join(eq[:20]))
    if bans: parts.append("ABSOLUTNE ZAKAZY (NIGDY nie uzywaj!): "+", ".join(bans[:20]))
    if fav: parts.append("ULUBIONE SKLADNIKI: "+", ".join(fav[:12]))
    if cooked:
        recent=cooked[-15:]
        parts.append("OSTATNIO GOTOWAL: "+", ".join(r.get("title","?") if isinstance(r,dict) else str(r) for r in recent))
    if techs: parts.append("ULUBIONE TECHNIKI: "+", ".join(techs[:8]))
    if skills: parts.append("OPANOWANE: "+", ".join(skills[:10]))
    if prefs: parts.append("PREFERENCJE: "+", ".join(prefs[:8]))
    if ratings:
        top=[r for r in ratings if isinstance(r,dict) and r.get("score",0)>=4][-5:]
        if top: parts.append("NAJLEPIEJ OCENIONE: "+", ".join(r.get("title","") for r in top))
    if fb:
        issues=list(set(f.get("issue","") for f in fb[-10:] if isinstance(f,dict) and f.get("issue")))[:5]
        if issues: parts.append("CZESTE PROBLEMY: "+", ".join(issues))
    return "\n".join(parts) if parts else "Nowy uzytkownik."

def auto_update_profile(uid,data):
    if not uid or data.get("type")!="recipe": return
    title=data.get("title","")
    if not title: return
    p=db_get_profile(uid)
    cooked=p.get("cooked_recipes",[])
    if isinstance(cooked,str): cooked=json.loads(cooked) if cooked else []
    existing=[r["title"] for r in cooked if isinstance(r,dict)]
    if title not in existing:
        cooked.append({"title":title,"date":datetime.utcnow().isoformat(),"difficulty":data.get("difficulty",3)})
        cooked=cooked[-100:]
    techs=p.get("favorite_techniques",[])
    if isinstance(techs,str): techs=json.loads(techs) if techs else []
    for step in data.get("steps",[]):
        eq=(step.get("equipment","")).lower()
        if "sous-vide" in eq and "Sous-vide" not in techs: techs.append("Sous-vide")
        if ("poziom 8" in eq or "poziom 9" in eq) and "Searing" not in techs: techs.append("Searing")
        if "atlas" in eq and "Makaron domowy" not in techs: techs.append("Makaron domowy")
    db_update_profile(uid,{"cooked_recipes":cooked,"favorite_techniques":techs,"stats":{"total_recipes":len(cooked)}})

# ─── Ban Enforcement ───
def _ban_keywords(ban_list):
    keywords=[]
    for ban in ban_list:
        main=ban.split("(")[0].strip().lower()
        if main: keywords.append(main)
        if "(" in ban:
            inside=ban.split("(")[1].rstrip(")").lower()
            for part in re.split(r'[,;:/]',inside):
                w=part.strip()
                if w and w not in ('każda forma','każda','forma','surowa','smażona','proszek','świeża','mielona','i'):
                    keywords.append(w)
    return list(set(keywords))

def _matches_ban(text,ban_keywords):
    text_lower=text.lower()
    for kw in ban_keywords:
        if kw in text_lower: return True
    return False

def enforce_bans(data,banned_ingredients):
    if not banned_ingredients or not isinstance(data,dict): return data
    if isinstance(banned_ingredients,str): banned_ingredients=json.loads(banned_ingredients) if banned_ingredients else []
    if data.get("type") not in ("recipe","meal_plan"): return data
    keywords=_ban_keywords(banned_ingredients)
    if not keywords: return data
    removed=[]
    if data.get("type")=="recipe":
        if data.get("ingredients"):
            clean=[]
            for ing in data["ingredients"]:
                if _matches_ban(ing.get("item",""),keywords): removed.append(ing.get("item",""))
                else: clean.append(ing)
            data["ingredients"]=clean
        if data.get("shopping_list"):
            clean=[]
            for item in data["shopping_list"]:
                if _matches_ban(item.get("item",""),keywords):
                    if item.get("item","") not in removed: removed.append(item.get("item",""))
                else: clean.append(item)
            data["shopping_list"]=clean
        if data.get("mise_en_place"):
            data["mise_en_place"]=[m for m in data["mise_en_place"] if not _matches_ban(m,keywords)]
        if removed:
            warn={"problem":"Usunięto zakazane składniki: "+", ".join(removed),"solution":"Te składniki zostały automatycznie usunięte z przepisu."}
            if not data.get("warnings"): data["warnings"]=[]
            data["warnings"].insert(0,warn)
    return data

# ─── Skill Tree ───
SKILL_CATEGORIES=[
    {"id":"basics","name":"Techniki bazowe","icon":"🔥","color":"#c45050"},
    {"id":"sousvide","name":"Sous-vide","icon":"🌡","color":"#5cb870"},
    {"id":"sauces","name":"Sosy","icon":"🥄","color":"#d4a24e"},
    {"id":"baking","name":"Ciasta i wypieki","icon":"🍰","color":"#c45e8a"},
    {"id":"pasta","name":"Makaron domowy","icon":"🍝","color":"#d4a24e"},
    {"id":"italian","name":"Kuchnia włoska","icon":"🇮🇹","color":"#5cb870"},
    {"id":"asian","name":"Kuchnia azjatycka","icon":"🥢","color":"#c45050"},
    {"id":"grill","name":"Grillowanie i BBQ","icon":"🔥","color":"#d4a24e"},
    {"id":"fermentation","name":"Fermentacja","icon":"🫙","color":"#8b3a62"},
    {"id":"molecular","name":"Hydrokoloidy","icon":"🧪","color":"#5e8ac4"},
    {"id":"fish","name":"Ryby i krewetki","icon":"🐟","color":"#5cb870"},
    {"id":"vegetables","name":"Warzywa","icon":"🥬","color":"#5cb870"},
    {"id":"knives","name":"Noże i cięcie","icon":"🔪","color":"#8a7e84"},
    {"id":"plating","name":"Platowanie","icon":"🎨","color":"#c45e8a"},
    {"id":"mealprep","name":"Meal prep","icon":"📦","color":"#5e8ac4"},
]
SKILL_LEVELS=["basic","intermediate","advanced"]
SKILL_LEVEL_NAMES={"basic":"Podstawy","intermediate":"Średni","advanced":"Zaawansowany"}

def _mods():
    modules=[]
    queries={
        "basics":{"basic":["searing maillard","boiling vs simmering","blanching vegetables"],"intermediate":["braising collagen","poaching technique","roasting convection"],"advanced":["confit technique","smoking cold hot","pressure cooking science"]},
        "sousvide":{"basic":["sous vide basics temperature","sous vide equipment setup","sous vide vs traditional"],"intermediate":["sous vide time temperature chart","sous vide eggs precision","sous vide vegetables"],"advanced":["sous vide 24h short ribs","sous vide compression","sous vide custard dessert"]},
        "sauces":{"basic":["mother sauces bechamel veloute","roux technique flour butter","pan sauce deglaze"],"intermediate":["espagnole demi-glace reduction","hollandaise emulsion technique","beurre blanc butter sauce"],"advanced":["gastrique sauce","sauce soubise","compound butter advanced"]},
        "baking":{"basic":["sponge cake ratio eggs sugar","shortcrust pastry technique","basic bread dough"],"intermediate":["croissant lamination butter","choux pastry technique","meringue types french swiss italian"],"advanced":["sourdough starter fermentation","tempered chocolate technique","entremets modern pastry"]},
        "pasta":{"basic":["fresh pasta dough ratio eggs","pasta rolling machine thickness","cooking pasta al dente"],"intermediate":["filled pasta ravioli tortellini","gnocchi potato technique","pasta shapes sauce pairing"],"advanced":["colored pasta squid ink beet","laminated pasta herbs","ramen noodles alkaline"]},
        "italian":{"basic":["risotto technique arborio","pizza dough fermentation","aglio olio simple pasta"],"intermediate":["ossobuco milanese braising","tiramisu mascarpone technique","pesto variations mortar"],"advanced":["fresh mozzarella stretching","truffle techniques","italian bread ciabatta focaccia"]},
        "asian":{"basic":["stir fry wok technique heat","rice cooking methods","basic curry paste"],"intermediate":["dumplings folding technique","ramen broth tonkotsu","thai curry coconut"],"advanced":["dim sum advanced","miso fermentation dashi","szechuan mapo tofu technique"]},
        "grill":{"basic":["direct indirect grilling","marinades rubs basics","grilling temperature zones"],"intermediate":["reverse sear technique","smoking wood chips technique","yakitori skewer technique"],"advanced":["whole animal roasting","bbq low slow brisket","kamado ceramic grill"]},
        "fermentation":{"basic":["sauerkraut lacto fermentation","yogurt culture technique","quick pickles vinegar"],"intermediate":["kimchi gochugaru technique","kombucha scoby brewing","hot sauce fermented"],"advanced":["miso koji fermentation","tempeh soybean culture","vinegar mother acetic"]},
        "molecular":{"basic":["agar gelation basics","xanthan thickening technique","lecithin foam air"],"intermediate":["spherification alginate calcium","gellan gum fluid gel","methylcellulose hot gel"],"advanced":["transglutaminase meat glue","sous vide compression texture","cryogenic techniques liquid nitrogen"]},
        "fish":{"basic":["pan searing fish skin crispy","poaching fish court bouillon","shrimp cleaning cooking"],"intermediate":["ceviche acid cooking","fish en papillote technique","gravlax curing salmon"],"advanced":["whole fish roasting deboning","fish mousse quenelle","crustacean bisque extraction"]},
        "vegetables":{"basic":["roasting vegetables caramelization","steaming blanching green vegetables","salad dressing vinaigrette"],"intermediate":["vegetable puree silky technique","grilling charring vegetables","pickling quick fermented"],"advanced":["vegetable tasting menu","dehydration vegetable chips","vegetable stock dashi"]},
        "knives":{"basic":["knife grip technique safety","basic cuts julienne brunoise dice","knife sharpening honing"],"intermediate":["chiffonade tourne paysanne cuts","butchery basics breaking down chicken","filleting fish technique"],"advanced":["japanese knife techniques katsuramuki","precision cuts tournee","speed cutting professional"]},
        "plating":{"basic":["plate composition basics rule thirds","color contrast plating","sauce plating dots smears"],"intermediate":["height dimension plating","texture contrast crispy smooth","negative space elegance"],"advanced":["fine dining multi component plating","edible flowers garnish","molecular plating techniques"]},
        "mealprep":{"basic":["batch cooking basics containers","meal prep planning shopping list","food storage safety temperatures"],"intermediate":["freezer meals technique","grain prep variety week","protein prep marination advance"],"advanced":["restaurant style mise en place home","vacuum seal meal prep","weekly menu rotation seasonal"]},
    }
    for cat in SKILL_CATEGORIES:
        cid=cat["id"]
        for lvl in SKILL_LEVELS:
            mid=f"{cid}_{lvl}"
            sq=queries.get(cid,{}).get(lvl,["cooking technique"])
            modules.append({"id":mid,"category":cid,"level":lvl,"title":f"{cat['name']} — {SKILL_LEVEL_NAMES[lvl]}","subtitle":f"{cat['icon']} {SKILL_LEVEL_NAMES[lvl]}","icon":cat["icon"],"search_queries":sq})
    return modules

TRAINING_MODULES=_mods()
SURPRISE_THEMES=["Cos z kurczakiem i cytryna","Comfort food na wieczor","Cos wloskiego","Azjatyckie smaki","Danie jednogarnkowe","Makaron domowy","Meksykanskie smaki","Ryba z sosem","Kremowe risotto","Burger domowy","Steak z sosem","Deser","Salatka na cieplo","Zupa krem","Cos z krewetkami","Sniadanie mistrzow","Pizza domowa","Danie z piekarnika","Warzywa jako gwiazda","Danie z ryzu"]

# ─── Prompts ───
RECIPE_JSON='{"type":"recipe","title":"...","subtitle":"...","times":{"prep_min":0,"cook_min":0,"total_min":0},"difficulty":3,"servings":2,"science":"...","shopping_list":[{"item":"...","amount":"...","section":"..."}],"ingredients":[{"item":"...","amount":"...","note":"..."}],"substitutes":[{"original":"...","substitute":"...","note":"..."}],"mise_en_place":["..."],"steps":[{"number":1,"title":"...","instruction":"...","equipment":"...","timer_seconds":0,"tip":"...","why":"..."}],"warnings":[{"problem":"...","solution":"..."}],"upgrade":"..."}'

RESPONSE_RULES=f"""
## FORMAT:
- PRZEPIS -> JSON type:"recipe" (schemat: {RECIPE_JSON})
- PYTANIE -> {{"type":"text","content":"..."}}
- TEORIA -> {{"type":"training_theory","module":"...","title":"...","content":"...","key_points":["..."],"exercise_prompt":"..."}}
- FEEDBACK -> {{"type":"training_feedback","analysis":"...","tips":["..."],"next_steps":"..."}}
- MEAL PLAN -> {{"type":"meal_plan","days":[{{"day":"...","meals":[{{"meal":"...","title":"...","prep_time":0}}]}}],"shopping_list":[{{"item":"...","amount":"...","section":"..."}}]}}
- POROWNANIE TECHNIK -> {{"type":"comparison","topic":"...","variants":[{{"method":"...","difficulty":2,"time_min":25,"texture":"...","flavor":"...","best_for":"...","steps_summary":"...","pro":"...","con":"...","equipment":"..."}}],"verdict":"..."}}
Gdy uzytkownik pyta o porownanie, roznice, "na ile sposobow", "co lepsze" — uzyj type:comparison z 2-4 wariantami.
Opcjonalne: "kcal_per_serving" jesli user poda limit.

## ZASADY:
- ZAWSZE czysty JSON, zero tekstu poza nim
- ZAWSZE gramy/ml (nigdy lyzki)
- ZAWSZE C (+F w nawiasie)
- UZYJ wiedzy z kontekstu do wyjasniania nauki i technik, ale NIGDY nie podawaj tytulow ksiazek ani nazwisk autorow. Pisz jak ekspert ktory po prostu WIE — nie powoluj sie na zrodla.
- ZAWSZE timer_seconds w krokach z czekaniem
- ZAWSZE w instrukcji kroku podawaj DOKLADNA ILOSC skladnika w nawiasie przy kazdym dodaniu
- NIE dodawaj pola "sources" do odpowiedzi.
- Ton: kumpel-ekspert z pasja. POLSKI."""

PROMPT_LUKASZ="""Jestes osobistym mentorem kulinarnym. PRZEDE WSZYSTKIM PYSZNIE.
Masz gleboka wiedze kulinarna. Uzywaj jej do wyjasniania nauki za gotowaniem.
## PROFIL:
- Lokalizacja: Zarow (Swidnica, Wroclaw)
- Nie liczymy kalorii domyslnie
## ZAKAZY i SPRZET z profilu uzytkownika ponizej — BEZWZGLEDNIE przestrzegaj zakazow! Jesli uzytkownik ma sprzet, podawaj KONKRETNE ustawienia (poziomy, temperatury, tryby).
## PAMIEC UZYTKOWNIKA:
{profile_context}
"""+RESPONSE_RULES

PROMPT_GUEST="""Jestes ekspertem kulinarnym. PRZEDE WSZYSTKIM PYSZNIE.
Masz gleboka wiedze kulinarna. Ogolne instrukcje, domyslnie 2 porcje.
Jesli uzytkownik ma zakazy lub sprzet w profilu — BEZWZGLEDNIE przestrzegaj zakazow i podawaj ustawienia sprzetu.
## PAMIEC UZYTKOWNIKA:
{profile_context}
"""+RESPONSE_RULES

PROFILES={"lukasz":PROMPT_LUKASZ,"guest":PROMPT_GUEST}

def build_training_prompt(mod_id,phase,profile,ctx,profile_ctx):
    mod=next((m for m in TRAINING_MODULES if m["id"]==mod_id),None)
    if not mod: return PROFILES.get(profile,PROMPT_LUKASZ).replace("{profile_context}",profile_ctx)
    base=PROFILES.get(profile,PROMPT_LUKASZ).replace("{profile_context}",profile_ctx)
    extras={"theory":f"\n## SZKOLENIE TEORIA: {mod['title']}\nSolidna teoria, uzyj wiedzy z kontekstu ale NIE podawaj tytulow ksiazek ani autorow. Daj key_points i exercise_prompt. JSON type:training_theory. 800-1500 slow.",
            "exercise":f"\n## SZKOLENIE CWICZENIE: {mod['title']}\nPrzepis treningowy z 'why' w kazdym kroku. JSON type:recipe.",
            "feedback":f"\n## SZKOLENIE FEEDBACK: {mod['title']}\nAnalizuj, wskazowki, next_steps. JSON type:training_feedback."}
    return base+extras.get(phase,"")+(f"\n\n## KONTEKST WIEDZY:\n{ctx}" if ctx else "")

# ─── Assistant ───
import hashlib
from functools import lru_cache
import time as _time

# Profile cache (TTL 60s)
_profile_cache={}
_PROFILE_TTL=60

def db_get_profile_cached(uid):
    now=_time.time()
    if uid in _profile_cache:
        data,ts=_profile_cache[uid]
        if now-ts<_PROFILE_TTL: return data
    data=db_get_profile(uid)
    _profile_cache[uid]=(data,now)
    return data

def invalidate_profile_cache(uid):
    _profile_cache.pop(uid,None)

class CulinaryAssistant:
    def __init__(self,api_key):
        self.client=OpenAI(api_key=api_key,base_url=AI_BASE_URL)
        
        self.chroma=chromadb.PersistentClient(path=CHROMA_DB_PATH)
        self.ef=embedding_functions.DefaultEmbeddingFunction()
        try: self.col=self.chroma.get_collection("culinary_knowledge",embedding_function=self.ef); logger.info(f"DB: {self.col.count()}")
        except: self.col=self.chroma.create_collection("culinary_knowledge",embedding_function=self.ef)
        self._search_cache={}
        self._CACHE_SIZE=200

    def search(self,q,n=SEARCH_RESULTS):
        if self.col.count()==0: return []
        # Cache key = query + n
        cache_key=hashlib.md5((q+str(n)).encode()).hexdigest()
        if cache_key in self._search_cache:
            return self._search_cache[cache_key]
        r=self.col.query(query_texts=[q],n_results=min(n,self.col.count()))
        result=[{"text":r["documents"][0][i]} for i in range(len(r["documents"][0]))] if r["documents"] and r["documents"][0] else []
        # Evict old entries if cache too big
        if len(self._search_cache)>=self._CACHE_SIZE:
            oldest=next(iter(self._search_cache))
            del self._search_cache[oldest]
        self._search_cache[cache_key]=result
        return result

    def multi_search(self,queries,n=3):
        all_c,seen=[],set()
        for q in queries:
            for c in self.search(q,n):
                k=c["text"][:100]
                if k not in seen: seen.add(k); all_c.append(c)
        return all_c

    def _call(self,prompt,msgs,mode=None):
        resp=self.client.chat.completions.create(model=AI_MODEL,max_tokens=AI_MAX_TOKENS,messages=[{"role":"system","content":prompt}]+msgs,temperature=0.7,response_format={"type":"json_object"})
        raw=resp.choices[0].message.content
        try: parsed=json.loads(raw)
        except:
            c=raw.strip()
            if c.startswith("```"): c=c.split("\n",1)[-1].rsplit("```",1)[0]
            try: parsed=json.loads(c)
            except: parsed={"type":"text","content":raw}
        return parsed,resp.usage

    def _call_stream(self,prompt,msgs,mode=None):
        """Streaming version — yields chunks of text as they arrive."""
        resp=self.client.chat.completions.create(model=AI_MODEL,max_tokens=AI_MAX_TOKENS,messages=[{"role":"system","content":prompt}]+msgs,temperature=0.7,response_format={"type":"json_object"},stream=True)
        full=""
        for chunk in resp:
            if chunk.choices and chunk.choices[0].delta.content:
                text=chunk.choices[0].delta.content
                full+=text
                yield text
        return full

    def ask(self,question,history=None,profile="lukasz",uid=None):
        prof_data=db_get_profile_cached(uid) if uid else dict(DEFAULT_PROFILE)
        prof_ctx=profile_to_context(prof_data)
        chunks=self.search(question)
        ctx="\n---\n".join([c['text'] for c in chunks])
        base=PROFILES.get(profile,PROMPT_LUKASZ).replace("{profile_context}",prof_ctx)
        prompt=base+(f"\n\n## KONTEKST WIEDZY:\n{ctx}" if ctx else "")
        msgs=list(history or [])+[{"role":"user","content":question}]
        parsed,usage=self._call(prompt,msgs)
        parsed.pop("sources",None); parsed.pop("book_references",None)
        bans=prof_data.get("banned_ingredients",[])
        if isinstance(bans,str): bans=json.loads(bans) if bans else []
        parsed=enforce_bans(parsed,bans)
        auto_update_profile(uid,parsed)
        return {"data":parsed,"profile":profile,"usage":{"prompt_tokens":usage.prompt_tokens if usage else 0,"completion_tokens":usage.completion_tokens if usage else 0}}

    def train(self,mod_id,phase,question="",history=None,profile="lukasz",uid=None):
        mod=next((m for m in TRAINING_MODULES if m["id"]==mod_id),None)
        if not mod: return {"data":{"type":"text","content":"Nieznany modul."},"profile":profile,"usage":{}}
        prof_data=db_get_profile(uid) if uid else dict(DEFAULT_PROFILE)
        prof_ctx=profile_to_context(prof_data)
        chunks=self.multi_search(mod["search_queries"]) if phase in ("theory","exercise") else (self.search(question) if question else self.multi_search(mod["search_queries"][:2]))
        ctx="\n---\n".join([c['text'] for c in chunks])
        prompt=build_training_prompt(mod_id,phase,profile,ctx,prof_ctx)
        msgs=list(history or [])
        if phase=="theory": msgs.append({"role":"user","content":f"Naucz mnie: {mod['title']}"})
        elif phase=="exercise": msgs.append({"role":"user","content":f"Cwiczenie: {mod['title']}"})
        else: msgs.append({"role":"user","content":question or "Jak mi poszlo?"})
        parsed,usage=self._call(prompt,msgs,mode="smart")
        parsed.pop("sources",None); parsed.pop("book_references",None)
        bans=prof_data.get("banned_ingredients",[])
        if isinstance(bans,str): bans=json.loads(bans) if bans else []
        parsed=enforce_bans(parsed,bans)
        auto_update_profile(uid,parsed)
        return {"data":parsed,"profile":profile,"usage":{"prompt_tokens":usage.prompt_tokens if usage else 0,"completion_tokens":usage.completion_tokens if usage else 0}}

    def meal_plan(self,days=7,prefs="",profile="lukasz",uid=None):
        prof_data=db_get_profile(uid) if uid else dict(DEFAULT_PROFILE)
        prof_ctx=profile_to_context(prof_data)
        chunks=self.multi_search(["weekly meal plan","quick dinner","batch cooking","balanced meals"])
        ctx="\n---\n".join([c['text'] for c in chunks])
        base=PROFILES.get(profile,PROMPT_LUKASZ).replace("{profile_context}",prof_ctx)
        prompt=base+(f"\n\n## KONTEKST WIEDZY:\n{ctx}" if ctx else "")
        parsed,usage=self._call(prompt,[{"role":"user","content":f"Plan posilkow na {days} dni. {prefs}. JSON type:meal_plan."}],mode="smart")
        parsed.pop("sources",None)
        bans=prof_data.get("banned_ingredients",[])
        if isinstance(bans,str): bans=json.loads(bans) if bans else []
        parsed=enforce_bans(parsed,bans)
        return {"data":parsed,"profile":profile,"usage":{"prompt_tokens":usage.prompt_tokens if usage else 0,"completion_tokens":usage.completion_tokens if usage else 0}}

    def surprise(self,profile="lukasz",uid=None):
        return self.ask(random.choice(SURPRISE_THEMES),profile=profile,uid=uid)

    def import_url(self,url,page_text,profile="guest",uid=None):
        prof_data=db_get_profile(uid) if uid else dict(DEFAULT_PROFILE)
        prof_ctx=profile_to_context(prof_data)
        bans=prof_data.get("banned_ingredients",[])
        if isinstance(bans,str): bans=json.loads(bans) if bans else []
        ban_text=""
        if bans:
            ban_text="\n\n## !!! ABSOLUTNE ZAKAZY — KRYTYCZNE !!!\nNastepujace skladniki sa ZAKAZANE. NIGDY ich nie uzywaj, nawet jesli sa w oryginalnym przepisie!\nZAKAZANE: "+", ".join(bans)+"\nJesli oryginalny przepis zawiera zakazany skladnik — USUN go i zaproponuj zamiennik w polu 'substitutes'. W steps uzyj ZAMIENNIKA, nie oryginalu."
        search_text=page_text[:500]
        chunks=self.multi_search([search_text[:80],search_text[80:160]],n=4)
        ctx="\n---\n".join([c['text'] for c in chunks])
        base=PROFILES.get(profile,PROMPT_LUKASZ).replace("{profile_context}",prof_ctx)
        prompt=base+ban_text+"""

## ZADANIE: WIERNY IMPORT PRZEPISU Z INTERNETU
Przeksztalc ponizszy przepis na JSON type:recipe.

NAJWAZNIEJSZA ZASADA: WIERNOSC ORYGINALOWI!
- Uzyj DOKLADNIE tych samych skladnikow co oryginal. NIE usuwaj, NIE zamieniaj, NIE dodawaj skladnikow od siebie!
- Jedyny wyjątek: skladniki z listy ZAKAZANYCH — te usun i zaproponuj zamiennik.
- Jesli oryginal ma ketchup, sos chili, ocet — TY TEZ je masz. Nie "ulepszaj" przepisu.

KOLEJNOSC KROKOW:
- Zachowaj IDENTYCZNA kolejnosc i sposob przygotowania co oryginal!
- Jesli oryginal mowi "obtocz w skrobi, potem w jajku, potem w mace" — TY TEZ robisz DOKLADNIE tak, w ODDZIELNYCH krokach.
- NIE LACZ krokow. NIE UPRASZCZAJ. Odtwarzaj procedury 1:1.
- Jesli oryginal smazy w glebokym tlustczy — ty tez. Jesli piecze — ty tez.

PRZELICZENIA:
- Przelicz na gramy/ml: lyzka = 15ml/15g, lyzeczka = 5ml/5g, szklanka = 250ml, szczypta = 1g.

WZBOGACENIE (dodaj ALE nie zmieniaj oryginalnych skladnikow/krokow):
- Dodaj 'science' — uzyj wiedzy z kontekstu ale NIE podawaj tytulow ksiazek ani autorow. Pisz jak ekspert ktory WIE.
- W kazdym kroku: 'why' z nauka, 'tip' ze wskazowka, 'equipment' ze sprzetem uzytkownika
- Dodaj 'warnings' i 'upgrade' (jako sugestie, nie jako zmiany w przepisie)
- W 'substitutes' dodaj SUGESTIE ULEPSZEN — jesli jakis skladnik mozna zastapic lepszym, zaproponuj to z wyjasnieniem DLACZEGO to lepsze. Ale oryginalny skladnik ZOSTAJE w przepisie.
- ZAWSZE podawaj ilosci w nawiasach w instrukcjach krokow
- NIE dodawaj pola 'sources' do odpowiedzi"""
        if ctx:
            prompt+=f"\n\n## KONTEKST WIEDZY:\n{ctx}"
        parsed,usage=self._call(prompt,[{"role":"user","content":f"URL: {url}\n\nTRESC PRZEPISU ZE STRONY (zachowaj WSZYSTKIE kroki wiernie!):\n{page_text[:5000]}"}],mode="smart")
        parsed.pop("sources",None)
        parsed.pop("book_references",None)
        parsed=enforce_bans(parsed,bans)
        auto_update_profile(uid,parsed)
        return {"data":parsed,"profile":profile,"usage":{"prompt_tokens":usage.prompt_tokens if usage else 0,"completion_tokens":usage.completion_tokens if usage else 0}}

# ─── Flask ───
def create_app():
    app=Flask(__name__,static_folder="static",static_url_path="/static")
    CORS(app,resources={r"/api/*":{"origins":"*"}})
    key=os.environ.get("OPENAI_API_KEY") or os.environ.get("DEEPSEEK_API_KEY")
    app.config["assistant"]=CulinaryAssistant(key) if key else None
    if key and app.config["assistant"]: logger.info(f"Ready: {app.config['assistant'].col.count()} chunks, model: {AI_MODEL}")
    init_supabase()

    @app.route("/api/health")
    def health():
        a=app.config.get("assistant")
        return jsonify({"status":"ok","chunks":a.col.count() if a else 0,"model":AI_MODEL,"supabase":sb is not None})

    @app.route("/api/config")
    def config():
        return jsonify({"supabase_url":SUPABASE_URL,"supabase_anon_key":SUPABASE_ANON_KEY})

    # ─── Subscription Helpers ───
    def is_pro(uid):
        """Check if user has active PRO subscription."""
        p=db_get_profile(uid)
        status=p.get("subscription_status","free")
        if status=="active": return True
        # Check expiry for canceled but still valid
        end=p.get("subscription_end")
        if end and status in ("canceled","past_due"):
            try:
                if datetime.fromisoformat(str(end).replace("Z","+00:00"))>datetime.utcnow().replace(tzinfo=None):
                    return True
            except: pass
        return False

    def check_daily_limit(uid,limit_type="recipes"):
        """Check if free user exceeded daily limit. Returns (allowed, count, limit)."""
        p=db_get_profile(uid)
        if p.get("subscription_status")=="active": return True,0,999
        stats=p.get("stats",{})
        if isinstance(stats,str): stats=json.loads(stats) if stats else {}
        today=datetime.utcnow().strftime("%Y-%m-%d")
        key=f"daily_{limit_type}"
        daily=stats.get(key,{})
        if isinstance(daily,str): daily=json.loads(daily) if daily else {}
        if daily.get("date")!=today: daily={"date":today,"count":0}
        limit=FREE_RECIPES_PER_DAY if limit_type=="recipes" else FREE_IMPORTS_PER_DAY
        return daily["count"]<limit, daily["count"], limit

    def increment_daily(uid,limit_type="recipes"):
        p=db_get_profile(uid)
        stats=p.get("stats",{})
        if isinstance(stats,str): stats=json.loads(stats) if stats else {}
        today=datetime.utcnow().strftime("%Y-%m-%d")
        key=f"daily_{limit_type}"
        daily=stats.get(key,{})
        if isinstance(daily,str): daily=json.loads(daily) if daily else {}
        if daily.get("date")!=today: daily={"date":today,"count":0}
        daily["count"]+=1
        stats[key]=daily
        db_update_profile(uid,{"stats":stats})

    # ─── Stripe Endpoints ───
    @app.route("/api/stripe/checkout",methods=["POST"])
    @require_auth
    def create_checkout():
        if not STRIPE_SECRET_KEY: return jsonify({"error":"Stripe not configured"}),503
        p=db_get_profile(g.user_id)
        try:
            # Get or create Stripe customer
            customer_id=p.get("stripe_customer_id")
            if not customer_id:
                customer=stripe.Customer.create(
                    metadata={"supabase_uid":g.user_id},
                    email=None  # Supabase handles email
                )
                customer_id=customer.id
                db_update_profile(g.user_id,{"stripe_customer_id":customer_id})

            session=stripe.checkout.Session.create(
                customer=customer_id,
                payment_method_types=["card"],
                line_items=[{"price":STRIPE_PRICE_ID,"quantity":1}],
                mode="subscription",
                success_url=request.host_url.rstrip("/")+"?payment=success",
                cancel_url=request.host_url.rstrip("/")+"?payment=cancel",
                metadata={"supabase_uid":g.user_id}
            )
            return jsonify({"url":session.url})
        except Exception as e:
            logger.error(f"Stripe checkout error: {e}")
            return jsonify({"error":str(e)}),500

    @app.route("/api/stripe/portal",methods=["POST"])
    @require_auth
    def customer_portal():
        if not STRIPE_SECRET_KEY: return jsonify({"error":"Stripe not configured"}),503
        p=db_get_profile(g.user_id)
        customer_id=p.get("stripe_customer_id")
        if not customer_id: return jsonify({"error":"No subscription"}),400
        try:
            session=stripe.billing_portal.Session.create(
                customer=customer_id,
                return_url=request.host_url.rstrip("/")
            )
            return jsonify({"url":session.url})
        except Exception as e:
            return jsonify({"error":str(e)}),500

    @app.route("/api/stripe/status")
    @require_auth
    def subscription_status():
        p=db_get_profile(g.user_id)
        pro=is_pro(g.user_id)
        # Get daily usage
        allowed_r,count_r,limit_r=check_daily_limit(g.user_id,"recipes")
        allowed_i,count_i,limit_i=check_daily_limit(g.user_id,"imports")
        return jsonify({
            "is_pro":pro,
            "status":p.get("subscription_status","free"),
            "recipes_today":count_r,"recipes_limit":limit_r,
            "imports_today":count_i,"imports_limit":limit_i
        })

    @app.route("/api/stripe/webhook",methods=["POST"])
    def stripe_webhook():
        payload=request.get_data()
        sig=request.headers.get("Stripe-Signature")
        try:
            event=stripe.Webhook.construct_event(payload,sig,STRIPE_WEBHOOK_SECRET)
        except Exception as e:
            logger.error(f"Webhook signature error: {e}")
            return jsonify({"error":"Invalid signature"}),400

        etype=event["type"]
        data=event["data"]["object"]
        logger.info(f"Stripe webhook: {etype}")

        if etype=="checkout.session.completed":
            uid=data.get("metadata",{}).get("supabase_uid")
            customer_id=data.get("customer")
            if uid:
                db_update_profile(uid,{
                    "stripe_customer_id":customer_id,
                    "subscription_status":"active"
                })
                logger.info(f"PRO activated for {uid}")

        elif etype in ("customer.subscription.updated","customer.subscription.deleted"):
            customer_id=data.get("customer")
            status=data.get("status","")  # active, canceled, past_due, unpaid
            period_end=data.get("current_period_end")
            # Find user by stripe_customer_id
            try:
                r=sb.table("profiles").select("id").eq("stripe_customer_id",customer_id).execute()
                if r.data:
                    uid=r.data[0]["id"]
                    updates={"subscription_status":status if status!="canceled" else "canceled"}
                    if period_end:
                        updates["subscription_end"]=datetime.utcfromtimestamp(period_end).isoformat()
                    db_update_profile(uid,updates)
                    logger.info(f"Subscription {status} for {uid}")
            except Exception as e:
                logger.error(f"Webhook user lookup error: {e}")

        return jsonify({"received":True})

    # ─── Chat ───
    @app.route("/api/ask",methods=["POST"])
    @require_auth
    def api_ask():
        a=app.config.get("assistant")
        if not a: return jsonify({"error":"Not init"}),503
        allowed,count,limit=check_daily_limit(g.user_id,"recipes")
        if not allowed: return jsonify({"error":"limit","message":f"Dzienny limit {limit} przepisów wyczerpany. Przejdź na PRO!","is_limit":True}),429
        d=request.get_json(silent=True) or {}
        q=(d.get("question") or "").strip()
        if not q: return jsonify({"error":"No question"}),400
        p=db_get_profile_cached(g.user_id)
        pr=p.get("bot_profile","guest")
        h=[{"role":m["role"],"content":m["content"]} for m in (d.get("conversation_history") or []) if isinstance(m,dict) and m.get("role") in ("user","assistant")][-MAX_HISTORY:]
        try:
            result=a.ask(q,h,profile=pr,uid=g.user_id)
            increment_daily(g.user_id,"recipes")
            return jsonify({"success":True,**result})
        except: logger.error(traceback.format_exc()); return jsonify({"error":"Blad serwera."}),500

    @app.route("/api/ask-stream",methods=["POST"])
    @require_auth
    def api_ask_stream():
        from flask import Response,stream_with_context
        a=app.config.get("assistant")
        if not a: return jsonify({"error":"Not init"}),503
        allowed,count,limit=check_daily_limit(g.user_id,"recipes")
        if not allowed: return jsonify({"error":"limit","message":"Limit wyczerpany","is_limit":True}),429
        d=request.get_json(silent=True) or {}
        q=(d.get("question") or "").strip()
        if not q: return jsonify({"error":"No question"}),400
        p=db_get_profile_cached(g.user_id)
        pr=p.get("bot_profile","guest")
        prof_ctx=profile_to_context(p)
        chunks=a.search(q)
        ctx="\n---\n".join([c['text'] for c in chunks])
        base=PROFILES.get(pr,PROMPT_LUKASZ).replace("{profile_context}",prof_ctx)
        prompt=base+(f"\n\n## KONTEKST WIEDZY:\n{ctx}" if ctx else "")
        h=[{"role":m["role"],"content":m["content"]} for m in (d.get("conversation_history") or []) if isinstance(m,dict) and m.get("role") in ("user","assistant")][-MAX_HISTORY:]
        msgs=list(h)+[{"role":"user","content":q}]
        uid=g.user_id
        def generate():
            full=""
            try:
                for chunk_text in a._call_stream(prompt,msgs):
                    full+=chunk_text
                    yield f"data: {json.dumps({'chunk':chunk_text})}\n\n"
                # Parse final result
                try: parsed=json.loads(full)
                except:
                    c=full.strip()
                    if c.startswith("```"): c=c.split("\n",1)[-1].rsplit("```",1)[0]
                    try: parsed=json.loads(c)
                    except: parsed={"type":"text","content":full}
                parsed.pop("sources",None); parsed.pop("book_references",None)
                bans=p.get("banned_ingredients",[])
                if isinstance(bans,str): bans=json.loads(bans) if bans else []
                parsed=enforce_bans(parsed,bans)
                auto_update_profile(uid,parsed)
                increment_daily(uid,"recipes")
                yield f"data: {json.dumps({'done':True,'data':parsed})}\n\n"
            except Exception as e:
                logger.error(f"Stream error: {e}")
                yield f"data: {json.dumps({'error':str(e)})}\n\n"
        return Response(stream_with_context(generate()),mimetype='text/event-stream',headers={'Cache-Control':'no-cache','X-Accel-Buffering':'no'})

    @app.route("/api/surprise",methods=["POST"])
    @require_auth
    def api_surprise():
        a=app.config.get("assistant")
        if not a: return jsonify({"error":"Not init"}),503
        allowed,count,limit=check_daily_limit(g.user_id,"recipes")
        if not allowed: return jsonify({"error":"limit","message":f"Dzienny limit {limit} przepisów wyczerpany. Przejdź na PRO!","is_limit":True}),429
        p=db_get_profile(g.user_id)
        try:
            result=a.surprise(profile=p.get("bot_profile","guest"),uid=g.user_id)
            increment_daily(g.user_id,"recipes")
            return jsonify({"success":True,**result})
        except: logger.error(traceback.format_exc()); return jsonify({"error":"Blad."}),500

    @app.route("/api/meal-plan",methods=["POST"])
    @require_auth
    def api_meal_plan():
        a=app.config.get("assistant")
        if not a: return jsonify({"error":"Not init"}),503
        d=request.get_json(silent=True) or {}
        p=db_get_profile(g.user_id)
        try: return jsonify({"success":True,**a.meal_plan(min(int(d.get("days",7)),14),(d.get("preferences") or ""),p.get("bot_profile","guest"),uid=g.user_id)})
        except: logger.error(traceback.format_exc()); return jsonify({"error":"Blad."}),500

    @app.route("/api/import-url",methods=["POST"])
    @require_auth
    def api_import_url():
        a=app.config.get("assistant")
        if not a: return jsonify({"error":"Not init"}),503
        if not http_requests: return jsonify({"error":"Modul requests niedostepny"}),500
        allowed,count,limit=check_daily_limit(g.user_id,"imports")
        if not allowed: return jsonify({"error":"limit","message":f"Dzienny limit {limit} importów wyczerpany. Przejdź na PRO!","is_limit":True}),429
        d=request.get_json(silent=True) or {}
        url=(d.get("url") or "").strip()
        if not url: return jsonify({"error":"Brak URL"}),400
        p=db_get_profile(g.user_id)
        try:
            resp=http_requests.get(url,timeout=15,headers={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"})
            resp.raise_for_status()
            html=resp.text
            import re as _re
            ld_text=""
            for ld_match in _re.finditer(r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',html,_re.S|_re.I):
                try:
                    ld_data=json.loads(ld_match.group(1))
                    if isinstance(ld_data,list): ld_data=next((x for x in ld_data if isinstance(x,dict) and x.get("@type","")=="Recipe"),None)
                    elif isinstance(ld_data,dict) and "@graph" in ld_data: ld_data=next((x for x in ld_data["@graph"] if isinstance(x,dict) and x.get("@type","")=="Recipe"),None)
                    if ld_data and (ld_data.get("@type")=="Recipe" or ld_data.get("recipeIngredient")):
                        ld_text="DANE STRUKTURALNE PRZEPISU:\n"
                        ld_text+=f"Nazwa: {ld_data.get('name','')}\nOpis: {ld_data.get('description','')}\n"
                        if ld_data.get("recipeIngredient"): ld_text+="Skladniki:\n"+"\n".join(f"- {i}" for i in ld_data["recipeIngredient"])+"\n"
                        if ld_data.get("recipeInstructions"):
                            ld_text+="Kroki:\n"
                            for idx,step in enumerate(ld_data["recipeInstructions"],1):
                                if isinstance(step,dict): ld_text+=f"{idx}. {step.get('text','')}\n"
                                elif isinstance(step,str): ld_text+=f"{idx}. {step}\n"
                        if ld_data.get("recipeYield"): ld_text+=f"Porcje: {ld_data['recipeYield']}\n"
                        break
                except: continue
            text=html
            for tag in ['nav','header','footer','aside','script','style','noscript']:
                text=_re.sub(rf'<{tag}[^>]*>.*?</{tag}>','',text,flags=_re.S|_re.I)
            text=_re.sub(r'<[^>]+>',' ',text)
            text=_re.sub(r'\s+',' ',text).strip()
            recipe_start=None
            for marker in ['Składniki','Ingredients','Przygotowanie','Preparation','Instrukcje']:
                pos=text.find(marker)
                if pos>0: recipe_start=max(0,pos-200); break
            if recipe_start: text=text[recipe_start:recipe_start+4000]
            else: text=text[:4000]
            full_text=(ld_text+"\n\nTEKST ZE STRONY:\n"+text) if ld_text else text
            result=a.import_url(url,full_text[:7000],p.get("bot_profile","guest"),uid=g.user_id)
            increment_daily(g.user_id,"imports")
            return jsonify({"success":True,**result})
        except http_requests.RequestException as e:
            return jsonify({"error":f"Nie udalo sie pobrac strony: {str(e)[:100]}"}),400
        except: logger.error(traceback.format_exc()); return jsonify({"error":"Blad."}),500

    @app.route("/api/train",methods=["POST"])
    @require_auth
    def api_train():
        a=app.config.get("assistant")
        if not a: return jsonify({"error":"Not init"}),503
        d=request.get_json(silent=True) or {}
        p=db_get_profile(g.user_id)
        h=[{"role":m["role"],"content":m["content"]} for m in (d.get("conversation_history") or []) if isinstance(m,dict) and m.get("role") in ("user","assistant")][-MAX_HISTORY:]
        try: return jsonify({"success":True,**a.train(d.get("module",""),d.get("phase","theory"),(d.get("question") or "").strip(),h,p.get("bot_profile","guest"),uid=g.user_id)})
        except: logger.error(traceback.format_exc()); return jsonify({"error":"Blad."}),500

    @app.route("/api/modules")
    def api_modules(): return jsonify({"modules":TRAINING_MODULES,"categories":SKILL_CATEGORIES,"levels":SKILL_LEVELS,"level_names":SKILL_LEVEL_NAMES})

    # Progress
    @app.route("/api/progress")
    @require_auth
    def get_prog(): return jsonify(db_get_progress(g.user_id))

    @app.route("/api/progress",methods=["POST"])
    @require_auth
    def save_prog():
        d=request.get_json(silent=True) or {}
        mid=d.get("module_id","")
        if not mid: return jsonify({"error":"No id"}),400
        p=db_get_progress(g.user_id)
        mod_data=p["modules"].get(mid,{"theory":False,"exercise":False,"feedback":False,"completed":False,"notes":""})
        ph=d.get("phase","")
        if ph in ("theory","exercise","feedback"): mod_data[ph]=d.get("completed",False)
        if "completed" in d: mod_data["completed"]=d["completed"]
        if mod_data.get("theory") and mod_data.get("exercise") and mod_data.get("feedback"): mod_data["completed"]=True
        db_save_progress(g.user_id,mid,mod_data)
        if mod_data.get("completed"):
            prof=db_get_profile(g.user_id)
            mod=next((x for x in TRAINING_MODULES if x["id"]==mid),None)
            skills=prof.get("mastered_skills",[])
            if isinstance(skills,str): skills=json.loads(skills) if skills else []
            if mod and mod["title"] not in skills:
                skills.append(mod["title"])
                db_update_profile(g.user_id,{"mastered_skills":skills})
        p["modules"][mid]=mod_data
        return jsonify({"success":True,"progress":p})

    @app.route("/api/progress/reset",methods=["POST"])
    @require_auth
    def reset_prog():
        db_reset_progress(g.user_id)
        return jsonify({"success":True})

    # History
    @app.route("/api/history")
    @require_auth
    def get_hist(): return jsonify(db_get_history(g.user_id))

    @app.route("/api/history",methods=["POST"])
    @require_auth
    def save_hist():
        d=request.get_json(silent=True) or {}
        s=d.get("session")
        if not s: return jsonify({"error":"No session"}),400
        db_save_session(g.user_id,s)
        return jsonify({"success":True})

    @app.route("/api/history/<sid>",methods=["DELETE"])
    @require_auth
    def del_hist(sid):
        db_delete_session(g.user_id,sid)
        return jsonify({"success":True})

    # Profile
    @app.route("/api/profile")
    @require_auth
    def get_profile_ep(): return jsonify(db_get_profile(g.user_id))

    @app.route("/api/profile",methods=["POST"])
    @require_auth
    def update_profile_ep():
        d=request.get_json(silent=True) or {}
        updates={}
        for key in ["favorite_ingredients","favorite_techniques","discovered_preferences","mastered_skills","equipment","banned_ingredients","bot_profile","name"]:
            if key in d: updates[key]=d[key]
        if "rating" in d:
            p=db_get_profile(g.user_id)
            ratings=p.get("ratings",[])
            if isinstance(ratings,str): ratings=json.loads(ratings) if ratings else []
            r=d["rating"]
            ratings.append({"title":r.get("title",""),"score":r.get("score",3),"comment":r.get("comment",""),"date":datetime.utcnow().isoformat()})
            updates["ratings"]=ratings[-50:]
        if "feedback" in d:
            p=db_get_profile(g.user_id)
            fb=p.get("feedback_history",[])
            if isinstance(fb,str): fb=json.loads(fb) if fb else []
            f=d["feedback"]
            fb.append({"recipe":f.get("recipe",""),"issue":f.get("issue",""),"date":datetime.utcnow().isoformat()})
            updates["feedback_history"]=fb[-50:]
        if updates:
            db_update_profile(g.user_id,updates)
        return jsonify({"success":True,"profile":db_get_profile(g.user_id)})

    @app.route("/api/profile/reset",methods=["POST"])
    @require_auth
    def reset_profile_ep():
        db_update_profile(g.user_id,dict(DEFAULT_PROFILE))
        return jsonify({"success":True})

    # Favorites
    @app.route("/api/favorites")
    @require_auth
    def get_favs(): return jsonify({"favorites":db_get_favorites(g.user_id)})

    @app.route("/api/favorites",methods=["POST"])
    @require_auth
    def add_fav():
        d=request.get_json(silent=True) or {}
        recipe=d.get("recipe")
        if not recipe: return jsonify({"error":"No recipe"}),400
        db_add_favorite(g.user_id,recipe)
        return jsonify({"success":True})

    @app.route("/api/favorites/<int:fav_id>",methods=["DELETE"])
    @require_auth
    def del_fav(fav_id):
        db_remove_favorite(g.user_id,fav_id)
        return jsonify({"success":True})

    @app.route("/api/stats")
    def stats():
        a=app.config.get("assistant")
        return jsonify({"chunks":a.col.count() if a else 0,"model":AI_MODEL})

    @app.route("/")
    def index(): return send_from_directory("static","index.html")

    return app

app=create_app()
if __name__=="__main__":
    port=int(os.environ.get("PORT",5000))
    logger.info(f"Chef AI v10 — http://localhost:{port}")
    app.run(host="0.0.0.0",port=port,debug=False)
