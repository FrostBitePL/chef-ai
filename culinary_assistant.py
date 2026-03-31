#!/usr/bin/env python3
"""Chef AI v11 — Supabase Auth + PostgreSQL + Stripe"""

# Load environment variables from .env file
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

import os,json,logging,traceback,random,re,functools,uuid
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

PROJECT_ROOT=os.path.dirname(os.path.abspath(__file__))
KNOWLEDGE_BASE_ROOT=PROJECT_ROOT
CHROMA_DB_PATH=os.path.join(PROJECT_ROOT,"chroma_db")
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
PLAN_TABLE="planner_plans"

logging.basicConfig(level=logging.INFO,format="%(asctime)s [%(levelname)s] %(message)s")
logger=logging.getLogger(__name__)

# â”€â”€â”€ Supabase Client â”€â”€â”€
sb:Client=None
def init_supabase():
    global sb
    if SUPABASE_URL and SUPABASE_KEY:
        sb=create_client(SUPABASE_URL,SUPABASE_KEY)
        logger.info("Supabase connected")
    else:
        logger.warning("Supabase not configured")

# â”€â”€â”€ Auth Middleware â”€â”€â”€
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

# â”€â”€â”€ Database Operations â”€â”€â”€
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

def db_save_history(uid,session):
    try:
        sb.table("chat_sessions").upsert({
            "id":session["id"],"user_id":uid,"title":session.get("title","Sesja"),
            "bot_profile":session.get("profile","guest"),"messages":session.get("messages",[]),
            "saved_at":datetime.utcnow().isoformat()
        }).execute()
    except Exception as e:
        logger.error(f"Session save error: {e}")

def db_save_plan(uid,plan_id,title,plan_body):
    payload={
        "id":plan_id,
        "user_id":uid,
        "title":title,
        "plan":plan_body,
        "created_at":datetime.utcnow().isoformat()
    }
    try:
        r=sb.table(PLAN_TABLE).upsert(payload).execute()
        logger.info(f"Plan saved: {plan_id} for user {uid}")
        return payload
    except Exception as e:
        logger.error(f"Planner save error: {e}")
        logger.error(f"Payload keys: {list(payload.keys())}, plan_id={plan_id}")
        return None

def db_get_plans(uid):
    try:
        r=sb.table(PLAN_TABLE).select("id,title,created_at,plan").eq("user_id",uid).order("created_at",desc=True).limit(20).execute()
        return r.data or []
    except Exception as e:
        logger.error(f"Planner fetch error: {e}")
        return []

def db_get_plan(uid,plan_id):
    try:
        r=sb.table(PLAN_TABLE).select("id,title,created_at,plan").eq("user_id",uid).eq("id",plan_id).single().execute()
        return r.data
    except Exception as e:
        logger.error(f"Planner get error: {e}")
        return None

def db_delete_plan(uid,plan_id):
    try:
        sb.table(PLAN_TABLE).delete().eq("user_id",uid).eq("id",plan_id).execute()
        return True
    except Exception as e:
        logger.error(f"Planner delete error: {e}")
        return False

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

# â”€â”€â”€ Profile Context â”€â”€â”€
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

    if eq: parts.append("⚠️ SPRZĘT UŻYTKOWNIKA (MUSISZ UŻYWAĆ W PRZEPISIE): "+", ".join(eq[:20]))
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

# â”€â”€â”€ Ban Enforcement â”€â”€â”€
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
    {"id":"basics","name":"Techniki bazowe","icon":"🍳","color":"#c45050"},
    {"id":"sousvide","name":"Sous-vide","icon":"🥇","color":"#5cb870"},
    {"id":"sauces","name":"Sosy","icon":"🥄","color":"#d4a24e"},
    {"id":"baking","name":"Ciasta i wypieki","icon":"🍰","color":"#c45e8a"},
    {"id":"pasta","name":"Makaron domowy","icon":"🍝","color":"#d4a24e"},
    {"id":"italian","name":"Kuchnia włoska","icon":"🇮🇹","color":"#5cb870"},
    {"id":"asian","name":"Kuchnia azjatycka","icon":"🥘","color":"#c45050"},
    {"id":"grill","name":"Grillowanie i BBQ","icon":"🔥","color":"#d4a24e"},
    {"id":"fermentation","name":"Fermentacja","icon":"🫙","color":"#8b3a62"},
    {"id":"molecular","name":"Hydrokoloidy","icon":"🧪","color":"#5e8ac4"},
    {"id":"fish","name":"Ryby i krewetki","icon":"🦐","color":"#5cb870"},
    {"id":"vegetables","name":"Warzywa","icon":"🥬","color":"#5cb870"},
    {"id":"knives","name":"Noże i cięcie","icon":"🔪","color":"#8a7e84"},
    {"id":"plating","name":"Platowanie","icon":"🍽️","color":"#c45e8a"},
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

# â”€â”€â”€ Prompts â”€â”€â”€
RECIPE_JSON='{"type":"recipe","title":"...","subtitle":"...","times":{"prep_min":0,"cook_min":0,"total_min":0},"difficulty":3,"servings":2,"science":"...","shopping_list":[{"item":"...","amount":"...","section":"..."}],"ingredients":[{"item":"...","amount":"...","note":"..."}],"substitutes":[{"original":"...","substitute":"...","note":"..."}],"mise_en_place":["..."],"steps":[{"number":1,"title":"...","instruction":"...","equipment":"...","timer_seconds":0,"tip":"...","why":"..."}],"warnings":[{"problem":"...","solution":"..."}],"upgrade":"..."}'

RESPONSE_RULES=f"""
## FORMAT:
- PRZEPIS -> JSON type:"recipe" (schemat: {RECIPE_JSON})
- PYTANIE -> {{"type":"text","content":"..."}}
- TEORIA -> {{"type":"training_theory","module":"...","title":"...","content":"...","key_points":["..."],"exercise_prompt":"..."}}
- FEEDBACK -> {{"type":"training_feedback","analysis":"...","tips":["..."],"next_steps":"..."}}
- MEAL PLAN -> {{"type":"meal_plan","days":[{{"day":"...","meals":[{{"meal":"...","title":"...","prep_time":0}}]}}],"shopping_list":[{{"item":"...","amount":"...","section":"..."}}]}}
- POROWNANIE TECHNIK -> {{"type":"comparison","topic":"...","variants":[{{"method":"...","difficulty":2,"time_min":25,"texture":"...","flavor":"...","best_for":"...","steps_summary":"...","pro":"...","con":"...","equipment":"..."}}],"verdict":"..."}}
Gdy użytkownik pyta o porównanie, różnice, "na ile sposobów", "co lepsze" — użyj type:comparison z 2-4 wariantami.
Opcjonalne: "kcal_per_serving" jesli user poda limit.

## ZASADY:
- ZAWSZE czysty JSON, zero tekstu poza nim
- ZAWSZE gramy/ml (nigdy lyzki)
- ZAWSZE C (+F w nawiasie)
- UŻYJ wiedzy z kontekstu do wyjaśniania nauki i technik, ale NIGDY nie podawaj tytułów książek ani nazwisk autorów. Pisz jak ekspert który po prostu WIE — nie powołuj się na źródła.
- ZAWSZE timer_seconds w krokach z czekaniem
- ZAWSZE w instrukcji kroku podawaj DOKLADNA ILOSC skladnika w nawiasie przy kazdym dodaniu
- NIE dodawaj pola "sources" do odpowiedzi.
- Ton: kumpel-ekspert z pasja. POLSKI."""

PROMPT_LUKASZ="""Jestes osobistym mentorem kulinarnym. PRZEDE WSZYSTKIM PYSZNIE.
Masz gleboka wiedze kulinarna. Uzywaj jej do wyjasniania nauki za gotowaniem.
## PROFIL:
- Lokalizacja: Zarow (Swidnica, Wroclaw)
- Nie liczymy kalorii domyslnie
## ZAKAZY i SPRZĘT z profilu użytkownika poniżej — BEZWZGLEDNIE przestrzegaj zakazów! Jeśli użytkownik ma sprzęt, podawaj KONKRETNE ustawienia (poziomy, temperatury, tryby).
## PAMIEC UZYTKOWNIKA:
{profile_context}
"""+RESPONSE_RULES

PROMPT_GUEST="""Jestes ekspertem kulinarnym. PRZEDE WSZYSTKIM PYSZNIE.
Masz gleboka wiedze kulinarna. Ogolne instrukcje, domyslnie 2 porcje.
Jeśli użytkownik ma zakazy lub sprzęt w profilu — BEZWZGLEDNIE przestrzegaj zakazów i podawaj ustawienia sprzętu.
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
    return base+extras.get(phase,"")+(f"\n\n## KONTEKST WIEDZY (OBOWIAZKOWO UZYJ TEJ WIEDZY W PRZEPISIE):\n{ctx}" if ctx else "")

# ─── Knowledge Base: 4-Layer System ───
KNOWLEDGE_LAYERS = {
    "core":        {"folder": "Dane",       "collection": "kb_core"},
    "composition": {"folder": "Kompozycja", "collection": "kb_composition"},
    "flavor":      {"folder": "Smak",       "collection": "kb_flavor"},
    "techniques":  {"folder": "Techniki",   "collection": "kb_techniques"},
}
CULINARY_KNOWLEDGE = {}
# Layer-specific K values - optimized for context reduction
LAYER_K_CONFIG = {
    "core": 3,
    "techniques": 2, 
    "composition": 2,
    "flavor": 2
}
LAYER_K = 5  # fallback for backward compatibility

def trim_context(text, max_chars=2000):
    """Trim text to prevent context overflow."""
    if not text:
        return text
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "...[trimmed]"

# ─── 2-STEP PIPELINE PROMPTS ───

PLANNER_PROMPT = """# SYSTEM

Jesteś silnikiem planowania kulinarnego.

Twoim zadaniem NIE jest pisanie przepisu.

Twoim zadaniem jest:
👉 zbudować STRUKTURĘ DECYZJI dla dania

---

# DOSTĘPNE WARSTWY WIEDZY

Masz dostęp do:

CORE → fizyka (temperatura, procesy, transformacje)
COMPOSITION → struktura dania, balans
TECHNIQUES → jak wykonać operacje
FLAVOR → pairing i balans smaków

---

# CEL

Na podstawie zapytania użytkownika:

👉 zaprojektuj danie jako SYSTEM DECYZJI

---

# WYMAGANIA (OBOWIĄZKOWE)

Musisz wygenerować:

## 1. DISH IDENTITY

- dish_type (np. "protein_centered", "soup", "pasta")
- main_ingredient
- style (np. "classic", "modern", "comfort")

---

## 2. STRUCTURE (z COMPOSITION)

- structure_rule (np. "protein_centered_plate")
- elements (lista elementów dania)

---

## 3. CORE DECISIONS (MIN 3, MAX 3)

Każda decyzja MUSI:

- zawierać konkretną temperaturę
- być powiązana z procesem fizycznym
- mieć wpływ na efekt końcowy

Zabronione:
- ogólne decyzje ("cook properly")
- brak temperatury

Wymuś różnorodność typów:

MUSISZ wygenerować:
- 1 decyzję: protein doneness
- 1 decyzję: browning / Maillard
- 1 decyzję: moisture / texture control

Każda decyzja:

{
  "ingredient": "",
  "intent": "",
  "target_temp": number,
  "reason": "",
  "decision_type": "protein_doneness|browning|moisture"
}

---

## 4. TECHNIQUES (MIN 2, MAX 2)

{
  "technique": "",
  "applies_to": "",
  "goal": ""
}

---

## 5. FLAVOR LOGIC

- pairings
- contrast
- balancing_elements

---

## 5. EXECUTION FLOW (OBOWIĄZKOWE)

Musisz zdefiniować kolejność wykonywania:

"execution_flow": [
  "sear_protein",
  "build_sauce", 
  "combine_and_finish"
]

---

## 6. FAILURE RISKS (MAX 2)

Lista realnych zagrożeń

---

# ZASADY

- NIE piszesz przepisu
- NIE piszesz kroków
- TYLKO decyzje

---

# OUTPUT

Zwróć JSON:

{
  "dish_identity": {},
  "structure": {},
  "core_decisions": [],
  "techniques": [],
  "flavor_logic": {},
  "execution_flow": [],
  "failure_risks": []
}"""

EXECUTOR_PROMPT = """# SYSTEM

Jesteś deterministycznym wykonawcą planu kulinarnego.

Dostajesz PLAN (JSON).

Twoim zadaniem NIE jest kreatywność.

Twoim zadaniem jest:

👉 PRZEŁOŻYĆ PLAN 1:1 NA PRZEPIS

---

# KRYTYCZNE ZASADY (MUSISZ PRZESTRZEGAĆ)

1. KAŻDA core_decision MUSI pojawić się w przepisie:
   - ta sama temperatura
   - ten sam składnik
   - ten sam cel

2. KAŻDA technika MUSI być użyta w steps

3. NIE WOLNO:
   - zmieniać temperatur
   - pomijać decyzji
   - dodawać nowych technik

4. Jeśli nie użyjesz elementu planu → OUTPUT JEST BŁĘDNY

---

# MAPOWANIE (OBOWIĄZKOWE)

Dla każdej decyzji:

{
  "ingredient": "chicken",
  "target_temp": 65
}

👉 MUSISZ mieć krok:

"Piecz kurczaka do 65°C (wewnętrznie)"

---

# OUTPUT DODATKOWY (OBOWIĄZKOWY)

"decisions_used": {
  "core": [
    "chicken 65°C protein coagulation",
    ...
  ],
  "techniques": [
    "roasting",
    ...
  ]
}

---

# STRUKTURA OUTPUTU

{
  "type": "recipe",
  "title": "",
  "subtitle": "",
  "times": {"prep_min": 0, "cook_min": 0, "total_min": 0},
  "difficulty": 3,
  "servings": 2,
  "science": "",
  "flavor_logic": "",
  "plating": "",
  "decisions_used": {
    "core": [],
    "techniques": []
  },
  "shopping_list": [],
  "ingredients": [],
  "substitutes": [],
  "mise_en_place": [],
  "steps": [],
  "warnings": [],
  "upgrade": ""
}

---

# W STEPS MUSI BYĆ:

- sprzęt
- temperatura
- czas
- co się dzieje (WHY)
- na co patrzeć (WATCH_FOR)

---

# FAILURE CONTROL

Uwzględnij failure_risks z planu i zapobiegaj im w krokach.

---

# INPUT

<<PLAN JSON>>"""

def smart_trim(entry):
    """Smart trim that preserves decision-relevant fields."""
    if isinstance(entry, str):
        return entry[:500] + "...[trimmed]" if len(entry) > 500 else entry
    
    if isinstance(entry, dict):
        # Keep only decision-critical fields
        trimmed = {}
        critical_fields = ["target", "limits", "failure_state", "decision", "process", "temperature", "time", "technique"]
        
        for field in critical_fields:
            if field in entry:
                value = entry[field]
                if isinstance(value, str) and len(value) > 200:
                    trimmed[field] = value[:200] + "...[trimmed]"
                else:
                    trimmed[field] = value
        
        return trimmed
    
    return str(entry)[:500] + "...[trimmed]" if len(str(entry)) > 500 else str(entry)

# ─── 2-STEP PIPELINE VALIDATION ───

def validate_plan(plan):
    """Validate plan meets minimum requirements."""
    errors = []
    
    # Check required sections
    required_sections = ["dish_identity", "structure", "core_decisions", "techniques", "flavor_logic", "execution_flow", "failure_risks"]
    for section in required_sections:
        if section not in plan:
            errors.append(f"Missing required section: {section}")
    
    # Check exact core decisions (3 max)
    core_count = len(plan.get("core_decisions", []))
    if core_count != 3:
        errors.append(f"Need exactly 3 core decisions, got {core_count}")
    
    # Check exact techniques (2 max)
    tech_count = len(plan.get("techniques", []))
    if tech_count != 2:
        errors.append(f"Need exactly 2 techniques, got {tech_count}")
    
    # Check execution flow
    flow_count = len(plan.get("execution_flow", []))
    if flow_count < 2:
        errors.append(f"Need at least 2 execution steps, got {flow_count}")
    
    # Check failure risks limit
    risk_count = len(plan.get("failure_risks", []))
    if risk_count > 2:
        errors.append(f"Too many failure risks, max 2 allowed, got {risk_count}")
    
    # Validate core decisions structure
    for i, decision in enumerate(plan.get("core_decisions", [])):
        if not isinstance(decision, dict):
            errors.append(f"Core decision {i} must be dict")
            continue
        
        required_fields = ["ingredient", "intent", "target_temp", "reason", "decision_type"]
        for field in required_fields:
            if field not in decision:
                errors.append(f"Core decision {i} missing field: {field}")
        
        if "target_temp" in decision and not isinstance(decision["target_temp"], (int, float)):
            errors.append(f"Core decision {i} target_temp must be number")
        
        # Check decision type is valid
        valid_types = ["protein_doneness", "browning", "moisture"]
        decision_type = decision.get("decision_type", "")
        if decision_type not in valid_types:
            errors.append(f"Core decision {i} invalid decision_type: {decision_type}")
        
        # Check temperature is reasonable
        temp = decision.get("target_temp", 0)
        if temp < 0 or temp > 250:
            errors.append(f"Core decision {i} unreasonable temperature: {temp}°C")
    
    # Validate techniques structure
    for i, technique in enumerate(plan.get("techniques", [])):
        if not isinstance(technique, dict):
            errors.append(f"Technique {i} must be dict")
            continue
        
        required_fields = ["technique", "applies_to", "goal"]
        for field in required_fields:
            if field not in technique:
                errors.append(f"Technique {i} missing field: {field}")
    
    if errors:
        raise ValueError(f"Plan validation failed: {'; '.join(errors)}")
    
    return True

def validate_recipe(recipe, plan):
    """Validate recipe uses all elements from plan using structured decisions_used."""
    errors = []
    
    # Get decisions_used from recipe (structured validation)
    used = recipe.get("decisions_used", {})
    core_used = used.get("core", [])
    tech_used = used.get("techniques", [])
    
    # CORE DECISIONS - check count matches
    required_core = len(plan.get("core_decisions", []))
    if len(core_used) < required_core:
        errors.append(f"Missing core decisions: used {len(core_used)}, required {required_core}")
    
    # TECHNIQUES - check count matches
    required_tech = len(plan.get("techniques", []))
    if len(tech_used) < required_tech:
        errors.append(f"Missing techniques: used {len(tech_used)}, required {required_tech}")
    
    # Verify specific core decisions are mentioned
    for i, decision in enumerate(plan.get("core_decisions", [])):
        ingredient = decision.get("ingredient", "").lower()
        target_temp = str(decision.get("target_temp", ""))
        
        found = False
        for used_decision in core_used:
            used_text = used_decision.lower()
            if ingredient in used_text and target_temp in used_text:
                found = True
                break
        
        if not found:
            errors.append(f"Core decision {i} not properly declared: {ingredient} @ {target_temp}°C")
    
    # Verify specific techniques are mentioned
    for i, technique in enumerate(plan.get("techniques", [])):
        tech_name = technique.get("technique", "").lower()
        
        found = False
        for used_tech in tech_used:
            if tech_name in used_tech.lower():
                found = True
                break
        
        if not found:
            errors.append(f"Technique {i} not properly declared: {tech_name}")
    
    # Check structure rule is preserved
    structure_rule = plan.get("structure", {}).get("structure_rule", "")
    if structure_rule:
        recipe_text = str(recipe).lower()
        if structure_rule.lower() not in recipe_text:
            errors.append(f"Structure rule not preserved: {structure_rule}")
    
    if errors:
        raise ValueError(f"Recipe validation failed: {'; '.join(errors)}")
    
    return True

KB_HASH_FILE = os.path.join(CHROMA_DB_PATH, "kb_hash.json")

def load_culinary_knowledge_base():
    """Load culinary knowledge JSON files from 4 category folders."""
    base_path = KNOWLEDGE_BASE_ROOT
    knowledge_data = {}
    logger.info(f"Loading knowledge base from: {base_path}")
    for layer, cfg in KNOWLEDGE_LAYERS.items():
        folder = os.path.join(base_path, cfg["folder"])
        if not os.path.exists(folder):
            logger.warning(f"Knowledge folder not found: {folder}")
            continue
        knowledge_data[layer] = []
        for fn in sorted(os.listdir(folder)):
            if not fn.endswith('.json'):
                continue
            try:
                with open(os.path.join(folder, fn), 'r', encoding='utf-8') as f:
                    data = json.load(f)
                if isinstance(data, list):
                    knowledge_data[layer].extend(data)
                else:
                    knowledge_data[layer].append(data)
                logger.info(f"  [{layer}] +{len(data) if isinstance(data,list) else 1} from {fn}")
            except Exception as e:
                logger.error(f"  [{layer}] error in {fn}: {e}")
    global CULINARY_KNOWLEDGE
    CULINARY_KNOWLEDGE = knowledge_data
    total = sum(len(v) for v in knowledge_data.values())
    logger.info(f"Knowledge base loaded: {total} items across {len(knowledge_data)} layers")
    return knowledge_data

def _compute_kb_hash(knowledge_data):
    """Compute a content hash of all knowledge data to detect changes."""
    h = hashlib.md5()
    for layer in sorted(knowledge_data.keys()):
        for item in knowledge_data[layer]:
            h.update(json.dumps(item, sort_keys=True, ensure_ascii=False).encode())
    return h.hexdigest()

def _read_kb_hash():
    try:
        with open(KB_HASH_FILE, 'r') as f:
            return json.load(f)
    except Exception:
        return {}

def _write_kb_hash(hash_data):
    os.makedirs(os.path.dirname(KB_HASH_FILE), exist_ok=True)
    with open(KB_HASH_FILE, 'w') as f:
        json.dump(hash_data, f)

# ─── Per-layer document formatters (rich text for vector search) ───
def _fmt_core(item):
    """Format a CORE (Dane) item into rich searchable text."""
    parts = []
    parts.append(f"INGREDIENT: {item.get('ingredient','')}")
    parts.append(f"STATE: {item.get('ingredient_state','')}")
    parts.append(f"INTENT: {item.get('intent','')}")
    parts.append(f"PROCESS: {item.get('process','')}")
    parts.append(f"MECHANISM: {item.get('mechanism','')}")
    t = item.get('target', {})
    if t:
        parts.append(f"TARGET: {t.get('temperature_c','')}C / {t.get('time_minutes','')} min")
    tol = item.get('tolerance', {})
    if tol:
        parts.append(f"TOLERANCE: temp {tol.get('temperature_c','')}, time {tol.get('time_minutes','')}")
    lim = item.get('limits', {})
    for bound in ('lower', 'upper'):
        b = lim.get(bound, {})
        if b:
            parts.append(f"LIMIT_{bound.upper()}: {b.get('temperature_c','')}C -> {b.get('effect','')}")
    parts.append(f"EQUIPMENT: {item.get('equipment','')}")
    parts.append(f"CONDITION: {item.get('condition','')}")
    parts.append(f"DECISION: {item.get('decision','')}")
    fs = item.get('failure_state')
    if fs and isinstance(fs, list):
        for f in fs:
            parts.append(f"FAILURE: {f.get('case','')} -> {f.get('result','')}")
    parts.append(f"EFFECT: {item.get('effect','')}")
    s = item.get('sensory')
    if s and isinstance(s, dict):
        parts.append(f"SENSORY: texture={s.get('texture','')}, juiciness={s.get('juiciness','')}, appearance={s.get('appearance','')}")
    return "\n".join(p for p in parts if p.split(": ",1)[-1].strip())

def _fmt_composition(item):
    """Format a COMPOSITION (Kompozycja) item."""
    parts = []
    parts.append(f"RULE: {item.get('rule','')}")
    parts.append(f"CATEGORY: {item.get('category','')}")
    parts.append(f"APPLIES TO: {', '.join(item.get('applies_to',[]))}")
    parts.append(f"DESCRIPTION: {item.get('description','')}")
    st = item.get('structure', [])
    if st:
        parts.append(f"STRUCTURE: {' -> '.join(st)}")
    roles = item.get('roles', {})
    for k, v in roles.items():
        parts.append(f"  ROLE [{k}]: {v}")
    parts.append(f"BALANCE: {item.get('balance_logic','')}")
    parts.append(f"CONTRAST: {item.get('contrast_logic','')}")
    for ex in item.get('examples', []):
        parts.append(f"EXAMPLE: {ex}")
    for fm in item.get('failure_modes', []):
        parts.append(f"FAILURE: {fm.get('case','')} -> {fm.get('result','')}")
    return "\n".join(p for p in parts if p.split(": ",1)[-1].strip())

def _fmt_flavor(item):
    """Format a FLAVOR (Smak) item."""
    parts = []
    parts.append(f"INGREDIENT: {item.get('ingredient','')}")
    parts.append(f"CATEGORY: {item.get('category','')}")
    fp = item.get('flavor_profile', {})
    if fp:
        parts.append(f"TASTES: {', '.join(fp.get('primary_tastes',[]))}")
        parts.append(f"AROMA: {', '.join(fp.get('aroma',[]))}")
        parts.append(f"INTENSITY: {fp.get('intensity','')}")
        parts.append(f"FAT: {fp.get('fat_content','')}")
    parts.append(f"PAIRS WITH: {', '.join(item.get('pairs_with',[]))}")
    parts.append(f"CONTRAST WITH: {', '.join(item.get('contrast_with',[]))}")
    parts.append(f"BOOSTERS: {', '.join(item.get('boosters',[]))}")
    parts.append(f"BALANCING: {', '.join(item.get('balancing_elements',[]))}")
    parts.append(f"AVOID: {', '.join(item.get('avoid_combinations',[]))}")
    ac = item.get('aroma_compounds', [])
    if ac:
        parts.append(f"AROMA COMPOUNDS: {', '.join(ac)}")
    return "\n".join(p for p in parts if p.split(": ",1)[-1].strip())

def _fmt_technique(item):
    """Format a TECHNIQUES (Techniki) item."""
    parts = []
    parts.append(f"TECHNIQUE: {item.get('technique','')}")
    parts.append(f"CATEGORY: {item.get('category','')}")
    parts.append(f"GOAL: {item.get('goal','')}")
    parts.append(f"WHEN TO USE: {item.get('when_to_use','')}")
    parts.append(f"INPUTS: {', '.join(item.get('inputs',[]))}")
    parts.append(f"EQUIPMENT: {', '.join(item.get('equipment',[]))}")
    for i, step in enumerate(item.get('steps', []), 1):
        parts.append(f"STEP {i}: {step}")
    for cp in item.get('critical_control_points', []):
        parts.append(f"CRITICAL: {cp}")
    cv = item.get('control_variables', {})
    if cv:
        parts.append(f"CONTROLS: {', '.join(f'{k}={v}' for k,v in cv.items())}")
    for fm in item.get('failure_modes', []):
        parts.append(f"FAILURE: {fm.get('case','')} -> {fm.get('result','')}")
    sig = item.get('signals', {})
    if sig:
        parts.append(f"SIGNALS: visual={sig.get('visual','')}, touch={sig.get('touch','')}, sound={sig.get('sound','')}")
    out = item.get('output', {})
    if out:
        parts.append(f"OUTPUT: texture={out.get('texture','')}, appearance={out.get('appearance','')}, flavor={out.get('flavor','')}")
    return "\n".join(p for p in parts if p.split(": ",1)[-1].strip())

_LAYER_FORMATTERS = {
    "core": _fmt_core,
    "composition": _fmt_composition,
    "flavor": _fmt_flavor,
    "techniques": _fmt_technique,
}

def format_layer_for_chroma(layer_name, items):
    """Format items for a single ChromaDB collection. Returns (docs, metas, ids)."""
    fmt = _LAYER_FORMATTERS.get(layer_name)
    if not fmt:
        return [], [], []
    docs, metas, ids = [], [], []
    for i, item in enumerate(items):
        try:
            text = fmt(item)
            if not text.strip():
                continue
            meta = {"layer": layer_name}
            for key in ("ingredient", "technique", "rule", "category", "intent", "process"):
                if key in item:
                    val = item[key]
                    if isinstance(val, str):
                        meta[key] = val
            docs.append(text)
            metas.append(meta)
            ids.append(f"{layer_name}_{i}")
        except Exception as e:
            logger.error(f"Error formatting {layer_name} item {i}: {e}")
            continue
    return docs, metas, ids

# ─── 4-Stage Decision Engine Prompts ───

SYSTEM_PROMPT_ENGINE = """Jesteś silnikiem decyzyjnym kuchni — Chef AI.

NIE jesteś chatbotem z przepisami. Jesteś systemem, który myśli jak doświadczony szef kuchni z głęboką wiedzą o fizyce jedzenia, kompozycji smaków i technikach profesjonalnej kuchni.

Masz dostęp do 4 warstw bazy wiedzy kulinarnej:
1. COMPOSITION — struktura dania, balans, kontrasty, architektura talerza
2. FLAVOR — parowanie smaków, wzmacniacze (umami, Maillard, fermentacja), równowaga kwas/sól/tłuszcz/słodycz
3. CORE — fizyka gotowania: temperatury, czasy, przemiany chemiczne, punkty krytyczne, stany awaryjne
4. TECHNIQUES — procedury wykonania, kroki krytyczne, troubleshooting

## TRYB ROZPOZNAWANIA DANIA

Przed rozpoczęciem ZAWSZE określ typ zapytania:

### A) DANIE KANONICZNE (carbonara, ramen tonkotsu, sos boloński, boeuf bourguignon, pad thai, risotto, pierogi ruskie, barszcz, ossobuco, cacio e pepe, french onion soup, etc.)
Jeśli użytkownik pyta o danie z ustaloną tożsamością kulinarną:
- NIE wymyślaj na nowo. NIE "ulepszaj" klasyki na siłę.
- Skup się na tym CO ODRÓŻNIA wersję doskonałą od przeciętnej.
- Wyjaśnij DLACZEGO każdy krok jest ważny — fizyka, chemia, mechanizm.
- Podaj NAJCZĘSTSZE BŁĘDY i jak ich uniknąć.
- Podkreśl detale, które większość ludzi pomija (np. woda z makaronu w carbonara, tempo emulsji, typ mąki).
- ZAWSZE podawaj TRADYCYJNE PROPORCJE składników z wyjaśnieniem DLACZEGO takie a nie inne (np. sos boloński: wołowina:wieprzowina 2:1 — wieprzowina dodaje tłuszcz i słodycz, wołowina daje głębię i strukturę).
- Traktuj to jak masterclass: "Tak robi to ktoś, kto naprawdę rozumie to danie."
- W polu "why_this_recipe" wyjaśnij filozofię tego dania i dlaczego kanon działa.

### B) ZAPYTANIE KREATYWNE ("coś z kurczakiem", "lekki obiad", "kolacja na randkę")
Jeśli użytkownik daje otwarte zapytanie:
- ZAWSZE proponuj danie na poziomie dobrej restauracji, nigdy "szybki obiad z patelni".
- Myśl jak szef kuchni: co sprawi, że to danie będzie wyjątkowe? Jaki element zaskoczenia?
- Dodaj JEDEN nieoczywisty element, który podnosi danie (np. fermentowany czosnek, dashi zamiast bulionu, pickled element, finishing oil, teksturowy kontrast).
- Każde danie musi mieć wyraźną architekturę: hero ingredient + supporting cast + accent.
- Nie proponuj "kurczaka z ryżem" — proponuj "kurczak w miso-karmelowym glaze z pickled rzodkiewką i furikake".

## KOLEJNOŚĆ MYŚLENIA (ZAWSZE)
1. Zidentyfikuj typ dania (kanoniczne vs kreatywne)
2. Zaprojektuj architekturę dania (composition)
3. Zablokuj logikę smakową (flavor)
4. Zdefiniuj parametry fizyczne — temp, czas, mechanizmy (core)
5. Przekształć w konkretne kroki wykonania (techniques)
6. Wyeliminuj ogólnikowe frazy — zastąp precyzyjnym językiem kulinarnym
7. Każdy krok musi UCZYĆ — nie tylko mówić co robić, ale DLACZEGO

## ZASADY JAKOŚCI
- Każdy przepis musi wyglądać jak produkt doświadczonego szefa kuchni, nie jak blog kulinarny.
- Kroki muszą być GĘSTE w wiedzę: co się dzieje chemicznie, na co patrzeć, co może pójść nie tak.
- Podawaj KONKRETNE wskaźniki gotowości (kolor, konsystencja, dźwięk, zapach) — nie tylko czas.
- Jeśli danie ma element, który wymaga precyzji (emulsja, temperowanie, fermentacja) — poświęć mu dodatkową uwagę.

## SPRZĘT UŻYTKOWNIKA (OBOWIĄZKOWO)
- Jeśli w profilu użytkownika jest lista sprzętu — MUSISZ go aktywnie wykorzystywać w przepisie.
- Dla KAŻDEGO urządzenia podaj DOKŁADNE parametry: temperatura, tryb, czas, poziom mocy.
- Przykłady:
  - Piekarnik: "Rozgrzej piekarnik do 200°C (392°F), termoobieg, środkowa półka"
  - Sous-vide: "Ustaw cyrkulor na 58°C, gotuj 2h w woreczku próżniowym"
  - Patelnia żeliwna: "Rozgrzej patelnię żeliwną na max przez 3 min, potem zmniejsz do średniego"
  - Thermomix: "Thermomix: 100°C, prędkość 2, 8 minut, łopatka"
  - Maszynka do makaronu (Atlas 150): "Przepuść ciasto przez Atlas 150 od poziomu 1 do 5, składając na pół po każdym przejściu"
  - Grill: "Grill bezpośredni 280°C, ruszt natłuszczony, 3 min na stronę"
- W polu "equipment" każdego kroku ZAWSZE wpisz konkretne urządzenie z profilu użytkownika + ustawienia.
- Jeśli użytkownik ma specjalistyczny sprzęt (sous-vide, Thermomix, wędzarnia, grill) — preferuj techniki które go wykorzystują.
- NIE ignoruj sprzętu użytkownika. Jeśli ma patelnię żeliwną — używaj jej zamiast "patelni". Jeśli ma termometr — podaj dokładne temperatury wewnętrzne.

## PRZYPRAWY I PRZYPRAWIENIE (OBOWIĄZKOWO)
- KAŻDY przepis MUSI zawierać WSZYSTKIE użyte przyprawy i przyprawy z DOKŁADNYMI ilościami w gramach.
- Nigdy nie pisz "dopraw do smaku", "sól i pieprz" bez ilości. Podaj konkretnie: "sól 5g", "pieprz czarny świeżo mielony 2g".
- KAŻDA przyprawa, zioło, olej, ocet, sos — MUSI pojawić się w trzech miejscach:
  1. "ingredients" — z dokładną ilością i notatką dlaczego ta przyprawa
  2. "shopping_list" — w sekcji "Przyprawy" lub "Pantry"
  3. "steps" — w instrukcji kroku z dokładną ilością (np. "dodaj 3g kuminu i 2g wędzonej papryki")
- Typowe przyprawy do uwzględnienia: sól, pieprz, olej/masło do smażenia, oliwa, czosnek, cebula, zioła (tymianek, rozmaryn, oregano, bazylia), przyprawy (kumin, papryka, kurkuma, cynamon etc.), sosy (sojowy, rybny, Worcestershire), octy, cukier, mąka do obtaczania.
- NIE zakładaj, że użytkownik ma przyprawy w domu. Traktuj je jak pełnoprawne składniki.

## REGUŁY FORMATU
- ZAWSZE gramy/ml (nigdy łyżki/szklanki)
- ZAWSZE Celsjusz (+Fahrenheit w nawiasie)
- ZAWSZE timer_seconds w krokach wymagających czekania
- ZAWSZE podawaj dokładne ilości W NAWIASACH w instrukcjach kroków — użytkownik może nie robić mise en place!
  Przykład: "Dodaj masło (30g) na rozgrzaną patelnię, gdy się spieni dodaj czosnek (3 ząbki, drobno posiekany) i sól (3g)"
  Przykład: "Wlej oliwę (15ml) i dodaj paprykę wędzoną (2g), kumin (3g) i pieprz cayenne (1g)"
  NIGDY nie pisz "dodaj czosnek" bez ilości. Każdy składnik w kroku MUSI mieć ilość w nawiasie.
- Pisz po polsku, chyba że użytkownik prosi inaczej
- NIE wspominaj o książkach, autorach, źródłach, bazie danych — pisz jak ekspert, który po prostu WIE.
- Preferuj gęstość i precyzję nad zwięzłość.
"""

TASK_PROMPT_TEMPLATE = """ZAPYTANIE UŻYTKOWNIKA:
{user_input}

OGRANICZENIA / PROFIL:
{constraints}

---

## CORE DATA (fizyka, temperatury, procesy, progi transformacji, stany awaryjne) - ABSOLUTNY PRIORYTET
{core_data}

## COMPOSITION RULES (architektura dania, balans, kontrasty, struktura) - PRIORYTET 2
{composition_data}

## TECHNIQUES (procedury wykonania, kroki krytyczne, troubleshooting, timing) - PRIORYTET 3
{techniques_data}

## FLAVOR DATA (parowanie smaków, wzmacniacze, balans kwas/sól/tłuszcz/słodycz, logika aromatyczna) - PRIORYTET 4
{flavor_data}

## WAŻNE: HIERARCHIA PRIORYTETÓW
Jeśli wystąpi konflikt między danymi z różnych warstw:
1. CORE ma absolutny priorytet nad TECHNIQUES (fizyka > procedura)
2. COMPOSITION ma priorytet nad FLAVOR (struktura > smak)
3. CORE > COMPOSITION > TECHNIQUES > FLAVOR

---

ZADANIE:
Zaprojektuj danie jako system decyzyjny. Wykorzystaj kontekst z bazy wiedzy agresywnie — wyciągaj z niego maksimum detali.

## OBOWIĄZKOWE WYKORZYSTANIE WARSTW:
MUSISZ jawnie wykorzystać w przepisie:
- **minimum 2 decyzje z CORE** (temperatura, proces, progi transformacji, stany awaryjne)
- **minimum 1 regułę z COMPOSITION** (architektura dania, balans, kontrasty, struktura)
- **minimum 1 technikę z TECHNIQUES** (procedura wykonania, kroki krytyczne, timing)

Jeśli tego nie zrobisz, odpowiedź jest niepoprawna. Każda decyzja musi być widoczna w JSON.

Przed napisaniem JSON-a wykonaj wewnętrznie tę sekwencję:
1. ROZPOZNAJ TYP: Czy to danie kanoniczne (ma ustaloną tożsamość kulinarną) czy zapytanie kreatywne?
2. DLA DAŃ KANONICZNYCH: Nie zmieniaj istoty dania. Skup się na perfekcji wykonania, wyjaśnij DLACZEGO każdy element jest ważny, podaj najczęstsze błędy i co odróżnia wersję doskonałą od przeciętnej. Traktuj to jak masterclass.
3. DLA ZAPYTAŃ KREATYWNYCH: Zaproponuj danie na poziomie dobrej restauracji. Dodaj minimum jeden element zaskoczenia (nietypowe parowanie, technika, finishing). Nigdy nie proponuj banalnych kombinacji.
4. Wyprowadź strukturę z warstwy composition.
5. ZIDENTYFIKUJ i ZAPISZ które konkretnie decyzje z każdej warstwy wykorzystujesz.
5. Wyprowadź logikę smakową z warstwy flavor.
6. Przekształć koncept w decyzje temp/czas/mechanizm z warstwy core.
7. Przekształć decyzje w precyzyjne kroki z warstwy techniques.
8. Wyeliminuj ogólnikowe frazy i zastąp precyzyjnym językiem kulinarnym.
9. Każdy krok musi UCZYĆ — nie tylko co robić, ale DLACZEGO to działa i CO MOŻE PÓJŚĆ NIE TAK.
10. Dodaj wskaźniki gotowości sensoryczne (kolor, zapach, konsystencja, dźwięk) oprócz czasu.

Zwróć JSON z DOKŁADNIE taką strukturą:
{{
  "type": "recipe",
  "dish_type": "canonical | creative",
  "title": "nazwa dania",
  "subtitle": "krótki opis z charakterem — nie nudny",
  "why_this_recipe": "DLA KANONICZNYCH: filozofia dania i dlaczego kanon działa. DLA KREATYWNYCH: dlaczego ta propozycja jest najlepsza odpowiedź na zapytanie.",
  "common_mistakes": ["błąd 1 i dlaczego to problem", "błąd 2"],
  "what_makes_it_great": "co odróżnia wersję doskonałą od przeciętnej — jeden gęsty akapit",
  "decision_layers": {{
    "composition": {{
      "structure": "architektura dania",
      "hero": "główny składnik i dlaczego on",
      "elements": ["element1 + jego rola", "element2 + jego rola"],
      "balance": "logika balansu",
      "contrast": "logika kontrastu (tekstura, temperatura, smak)"
    }},
    "flavor": {{
      "pairings": ["parowanie1 + dlaczego działa", "parowanie2"],
      "boosters": ["wzmacniacz1 + mechanizm"],
      "balancing": ["co równoważy co i dlaczego"]
    }},
    "core": {{
      "key_processes": [{{"process": "...", "target_temp_c": 0, "time_min": 0, "mechanism": "co się dzieje na poziomie molekularnym/fizycznym"}}],
      "critical_points": ["punkt krytyczny + co się stanie jeśli go przekroczysz"]
    }},
    "techniques": [
      {{"name": "...", "why": "dlaczego ta technika a nie inna", "critical_steps": ["krok + na co uważać"]}}
    ],
    "failure_analysis": [
      {{"case": "co może pójść nie tak", "why": "mechanizm problemu", "fix": "jak naprawić"}}
    ]
  }},
  "precision_controls": [
    {{"control": "...", "target": "...", "sensory_check": "jak rozpoznać bez termometru/zegarka", "why": "..."}}
  ],
  "science": "gęste wyjaśnienie nauki stojącej za daniem — pisz jakbyś tłumaczył pasjonatowi kuchni, nie studentowi",
  "flavor_logic": "jak system smakowy tego dania działa jako całość — nie lista, tylko narracja",
  "plating": "jak wykończyć i podać — z konkretnymi elementami wizualnymi",
  "decisions_used": {{
    "core": ["konkretna decyzja 1 z CORE", "konkretna decyzja 2 z CORE"],
    "composition": ["konkretna reguła z COMPOSITION"],
    "techniques": ["konkretna technika z TECHNIQUES"],
    "flavor": ["konkretna decyzja smakowa z FLAVOR (opcjonalnie)"]
  }},
  "times": {{"prep_min": 0, "cook_min": 0, "total_min": 0}},
  "difficulty": 3,
  "servings": 2,
  "shopping_list": [{{"item": "...", "amount": "...", "section": "mięso/nabiał/warzywa/przyprawy/pantry/..."}}],
  "ingredients": [{{"item": "...", "amount": "...g/ml", "note": "dlaczego ten składnik/gatunek/forma a nie inny"}}],
  // WAŻNE: shopping_list i ingredients MUSZĄ zawierać WSZYSTKIE przyprawy, zioła, oleje, sosy z dokładnymi ilościami.
  "substitutes": [
    {{
      "original": "oryginalny składnik",
      "substitute": "zamiennik",
      "flavor_impact": "jak zmieni się smak (np. mniej umami, więcej słodyczy, ostrzejszy)",
      "texture_impact": "jak zmieni się tekstura (np. bardziej kruche, mniej soczysty, gęstszy sos)",
      "overall_effect": "ogólny wpływ na danie — czy to nadal będzie to samo danie, czy zmieni charakter",
      "recommendation": "kiedy warto użyć zamiennika (np. dieta, dostępność, preferencje)"
    }}
  ],
  "mise_en_place": ["przygotowanie + dlaczego w tej kolejności"],
  "steps": [{{"number": 1, "title": "...", "instruction": "Każdy składnik z ilością W NAWIASIE np: Dodaj masło (30g), czosnek (3 ząbki), sól (3g). Użytkownik czyta krok i od razu wie ile czego dodać.", "equipment": "konkretne urządzenie + ustawienia", "timer_seconds": 0, "tip": "pro tip", "why": "co się dzieje i dlaczego", "watch_for": "wskaźniki sensoryczne gotowości"}}],
  "warnings": [{{"problem": "...", "solution": "...", "prevention": "jak uniknąć od początku"}}],
  "upgrade": "jeden konkretny sposób na podniesienie dania o poziom (nie abstrakcja, konkret)",
  "variation": "jedna inteligentna wariacja, która wykorzystuje tę samą bazę wiedzy inaczej",
  "storage": "jak przechować, co przygotować wcześniej, co traci jakość z czasem"
}}
"""

def build_pipeline_prompt(user_input, constraints, composition_ctx, flavor_ctx, core_ctx, techniques_ctx):
    """Build the full task prompt with all 4 knowledge layers injected."""
    return TASK_PROMPT_TEMPLATE.format(
        user_input=user_input,
        constraints=constraints,
        composition_data=composition_ctx or "(no composition data found)",
        flavor_data=flavor_ctx or "(no flavor data found)",
        core_data=core_ctx or "(no core data found)",
        techniques_data=techniques_ctx or "(no techniques data found)",
    )

# ─── Assistant ───â”€â”€â”€
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
    _CACHE_SIZE = 128
    _MAX_CACHE_MB = 20  # CRITICAL: Prevent memory leak

    def __init__(self, api_key):
        self.client = OpenAI(api_key=api_key, base_url=AI_BASE_URL)
        # Use OpenAI embeddings instead of local model — saves ~350MB RAM
        self.embedding_function = embedding_functions.OpenAIEmbeddingFunction(
            api_key=api_key, model_name="text-embedding-3-small"
        )
        self._search_cache = {}

        # 4 separate ChromaDB collections — one per knowledge layer
        self._db = chromadb.PersistentClient(path=CHROMA_DB_PATH)
        # Clean up legacy combined collection if it exists (saves RAM)
        try:
            self._db.delete_collection("culinary_knowledge")
            logger.info("Deleted legacy combined collection")
        except Exception:
            pass
        self.collections = {}
        for layer, cfg in KNOWLEDGE_LAYERS.items():
            col_name = cfg["collection"]
            try:
                col = self._db.get_or_create_collection(
                    col_name, embedding_function=self.embedding_function
                )
                # Validate dimensions match — if old 384-dim data exists, recreate
                if col.count() > 0:
                    try:
                        col.query(query_texts=["test"], n_results=1)
                    except Exception:
                        logger.warning(f"Dimension mismatch in {col_name} — recreating collection")
                        self._db.delete_collection(col_name)
                        col = self._db.get_or_create_collection(
                            col_name, embedding_function=self.embedding_function
                        )
                self.collections[layer] = col
            except Exception as e:
                logger.error(f"Collection {col_name} error: {e}")
                try:
                    self._db.delete_collection(col_name)
                except Exception:
                    pass
                self.collections[layer] = self._db.get_or_create_collection(
                    col_name, embedding_function=self.embedding_function
                )

        self._load_knowledge_base()

    def _load_knowledge_base(self):
        """Load JSON files and index into 4 ChromaDB collections. Skip if unchanged."""
        global CULINARY_KNOWLEDGE
        try:
            knowledge_data = load_culinary_knowledge_base()
            new_hash = _compute_kb_hash(knowledge_data)
            old_hashes = _read_kb_hash()

            # Check if any layer already has data and hash matches
            all_match = old_hashes.get("hash") == new_hash
            if all_match:
                counts = {l: self.collections[l].count() for l in KNOWLEDGE_LAYERS}
                if all(c > 0 for c in counts.values()):
                    logger.info(f"Knowledge base unchanged — skipping re-index. Counts: {counts}")
                    CULINARY_KNOWLEDGE = {}  # free memory
                    return

            logger.info("Knowledge base changed or first run — re-indexing...")
            for layer, items in knowledge_data.items():
                col = self.collections.get(layer)
                if not col or not items:
                    continue
                docs, metas, ids = format_layer_for_chroma(layer, items)
                if not docs:
                    continue

                # Delete old data in this layer collection
                try:
                    existing = col.get()
                    if existing and existing["ids"]:
                        col.delete(ids=existing["ids"])
                except Exception:
                    pass

                col.add(documents=docs, metadatas=metas, ids=ids)
                logger.info(f"  [{layer}] indexed {len(docs)} documents")

            _write_kb_hash({"hash": new_hash})
            # Free raw knowledge data from memory
            CULINARY_KNOWLEDGE = {}

        except Exception as e:
            logger.error(f"Knowledge base load error: {e}")

    # ─── Layer-specific search (TOP-K per layer) ───

    def search_layer(self, layer, query, k=None):
        """Search a single knowledge layer. Returns list of text strings."""
        col = self.collections.get(layer)
        if not col or col.count() == 0:
            return []
        
        # Use layer-specific K value if not provided
        if k is None:
            k = LAYER_K_CONFIG.get(layer, LAYER_K)
        
        cache_key = hashlib.md5(f"{layer}:{query}:{k}".encode()).hexdigest()
        if cache_key in self._search_cache:
            return self._search_cache[cache_key]
        try:
            r = col.query(query_texts=[query], n_results=min(k, col.count()))
            texts = r["documents"][0] if r["documents"] and r["documents"][0] else []
        except Exception as e:
            logger.warning(f"ChromaDB query error in {layer}: {e} — attempting recovery")
            try:
                self._rebuild_layer(layer)
                col = self.collections.get(layer)
                if col and col.count() > 0:
                    r = col.query(query_texts=[query], n_results=min(k, col.count()))
                    texts = r["documents"][0] if r["documents"] and r["documents"][0] else []
                else:
                    texts = []
            except Exception as e2:
                logger.error(f"ChromaDB recovery failed for {layer}: {e2}")
                texts = []
        # CRITICAL: Trim cache entries to prevent memory leak
        trimmed_texts = [t[:500] for t in texts]  # Store only first 500 chars
        
        # Check memory usage and enforce MB limit
        if len(self._search_cache) >= self._CACHE_SIZE:
            del self._search_cache[next(iter(self._search_cache))]
        
        # Additional memory check
        current_cache_size = sum(len(str(k)) + len(str(v)) for k, v in self._search_cache.items()) / 1024 / 1024
        if current_cache_size > self._MAX_CACHE_MB:
            # Clear half the cache if over limit
            keys_to_remove = list(self._search_cache.keys())[:len(self._search_cache)//2]
            for k in keys_to_remove:
                del self._search_cache[k]
        
        self._search_cache[cache_key] = trimmed_texts
        return texts

    def _rebuild_layer(self, layer):
        """Rebuild a single ChromaDB layer from knowledge base files."""
        import shutil
        logger.info(f"Rebuilding ChromaDB layer: {layer}")
        cfg = KNOWLEDGE_LAYERS.get(layer)
        if not cfg:
            return
        col_name = cfg["collection"]
        try:
            self._db.delete_collection(col_name)
        except Exception:
            pass
        col = self._db.get_or_create_collection(col_name, embedding_function=self.embedding_function)
        self.collections[layer] = col
        knowledge_data = load_culinary_knowledge_base()
        items = knowledge_data.get(layer, [])
        if items:
            docs, metas, ids = format_layer_for_chroma(layer, items)
            if docs:
                col.add(documents=docs, metadatas=metas, ids=ids)
                logger.info(f"  [{layer}] re-indexed {len(docs)} documents")
        global CULINARY_KNOWLEDGE
        CULINARY_KNOWLEDGE = {}

    def search_all_layers(self, query, k=LAYER_K):
        """Search all 4 layers separately. Returns dict {layer: [texts]}."""
        return {layer: self.search_layer(layer, query, k) for layer in KNOWLEDGE_LAYERS}

    # Legacy search methods — now use layer collections instead of combined
    def search(self, q, n=SEARCH_RESULTS):
        cache_key = hashlib.md5(("legacy:" + q + str(n)).encode()).hexdigest()
        if cache_key in self._search_cache:
            return self._search_cache[cache_key]
        # Search across all layers and merge results
        all_texts = []
        per_layer = max(2, n // len(KNOWLEDGE_LAYERS))
        for layer in KNOWLEDGE_LAYERS:
            all_texts.extend(self.search_layer(layer, q, k=per_layer))
        result = [{"text": t} for t in all_texts[:n]]
        if len(self._search_cache) >= self._CACHE_SIZE:
            del self._search_cache[next(iter(self._search_cache))]
        self._search_cache[cache_key] = result
        return result

    def multi_search(self, queries, n=3):
        all_c, seen = [], set()
        for q in queries:
            for c in self.search(q, n):
                k = c["text"][:100]
                if k not in seen:
                    seen.add(k)
                    all_c.append(c)
        return all_c

    # ─── LLM calls ───

    def _call(self, prompt, msgs, mode=None):
        resp = self.client.chat.completions.create(
            model=AI_MODEL, max_tokens=AI_MAX_TOKENS,
            messages=[{"role": "system", "content": prompt}] + msgs,
            temperature=0.7, response_format={"type": "json_object"}
        )
        raw = resp.choices[0].message.content
        try:
            parsed = json.loads(raw)
        except Exception:
            c = raw.strip()
            if c.startswith("```"):
                c = c.split("\n", 1)[-1].rsplit("```", 1)[0]
            try:
                parsed = json.loads(c)
            except Exception:
                parsed = {"type": "text", "content": raw}
        return parsed, resp.usage

    def _call_stream(self, prompt, msgs, mode=None):
        """Streaming version — yields chunks of text as they arrive."""
        resp = self.client.chat.completions.create(
            model=AI_MODEL, max_tokens=AI_MAX_TOKENS,
            messages=[{"role": "system", "content": prompt}] + msgs,
            temperature=0.7, response_format={"type": "json_object"}, stream=True
        )
        full = ""
        for chunk in resp:
            if chunk.choices and chunk.choices[0].delta.content:
                text = chunk.choices[0].delta.content
                full += text
                yield text
        return full

    # ─── 2-STEP PIPELINE: generate_recipe() ───

    def generate_recipe(self, question, history=None, profile="lukasz", uid=None):
        """2-step pipeline: planner → executor → validation."""
        prof_data = db_get_profile_cached(uid) if uid else dict(DEFAULT_PROFILE)
        prof_ctx = profile_to_context(prof_data)
        bans = prof_data.get("banned_ingredients", [])
        if isinstance(bans, str):
            bans = json.loads(bans) if bans else []

        # STEP 1: Layer-specific retrieval
        words = question.lower().split()
        main_ingredient = next((w for w in words if w in ["kurczak", "wołowina", "wieprzowina", "ryba", "warzywa", "makaron"]), "")
        dish_type = next((w for w in words if w in ["zupa", "stek", "gulasz", "sałatka", "danie", "przystawka"]), "")
        
        layer_queries = {
            "core": f"{main_ingredient} temperature doneness process" if main_ingredient else question,
            "techniques": f"{main_ingredient} cooking technique" if main_ingredient else question,
            "composition": f"{dish_type} structure balance" if dish_type else question,
            "flavor": f"{main_ingredient} pairing flavor" if main_ingredient else question
        }
        
        layers = {}
        for layer, query in layer_queries.items():
            layers[layer] = self.search_layer(layer, query)
        
        # Build context for planner
        core_data = trim_context('\n---\n'.join(layers.get('core', [])), 2000)
        comp_data = trim_context('\n---\n'.join(layers.get('composition', [])), 1500)
        tech_data = trim_context('\n---\n'.join(layers.get('techniques', [])), 1500)
        flavor_data = trim_context('\n---\n'.join(layers.get('flavor', [])), 1000)
        banned_text = ', '.join(bans) if bans else 'none'
        
        context = f"""# KNOWLEDGE CONTEXT

## CORE DATA (fizyka, temperatury, procesy)
{core_data}

## COMPOSITION RULES (architektura dania, balans)
{comp_data}

## TECHNIQUES (procedury wykonania, kroki krytyczne)
{tech_data}

## FLAVOR DATA (parowanie smaków, balans)
{flavor_data}

## USER PROFILE
{prof_ctx}

## BANNED INGREDIENTS
{banned_text}

---

# USER QUERY
{question}
"""

        # STEP 2: PLANNER - generate decision structure (with cache)
        cache_key = hashlib.md5(f"plan_{question}_{prof_ctx}".encode()).hexdigest()
        if cache_key in getattr(self, '_plan_cache', {}):
            plan = self._plan_cache[cache_key]
            plan_usage = None
        else:
            planner_msgs = [{"role": "user", "content": context}]
            plan, plan_usage = self._call(PLANNER_PROMPT, planner_msgs)
            # Cache the plan
            if not hasattr(self, '_plan_cache'):
                self._plan_cache = {}
            self._plan_cache[cache_key] = plan
        
        # STEP 3: Validate plan
        try:
            validate_plan(plan)
        except ValueError as e:
            logger.error(f"Plan validation failed: {e}")
            # Fallback to original ask method
            return self.ask(question, history, profile, uid)
        
        # STEP 4: EXECUTOR - generate recipe from plan
        executor_prompt = EXECUTOR_PROMPT.replace("<<PLAN JSON>>", json.dumps(plan, ensure_ascii=False, indent=2))
        executor_msgs = [{"role": "user", "content": executor_prompt}]
        recipe, recipe_usage = self._call(executor_prompt, executor_msgs)
        
        # STEP 5: Validate recipe against plan
        try:
            validate_recipe(recipe, plan)
        except ValueError as e:
            logger.error(f"Recipe validation failed: {e}")
            # Still return recipe but log error
        
        # STEP 6: Post-processing
        recipe = enforce_bans(recipe, bans)
        auto_update_profile(uid, recipe)
        
        # Combine usage
        total_usage = {
            "prompt_tokens": (plan_usage.prompt_tokens if plan_usage else 0) + (recipe_usage.prompt_tokens if recipe_usage else 0),
            "completion_tokens": (plan_usage.completion_tokens if plan_usage else 0) + (recipe_usage.completion_tokens if recipe_usage else 0)
        }
        
        return {
            "data": recipe,
            "profile": profile,
            "usage": total_usage,
            "plan": plan  # Include plan for debugging
        }

    # ─── 4-STAGE PIPELINE: ask() ───

    def ask(self, question, history=None, profile="lukasz", uid=None):
        """Main pipeline: 4-layer retrieval → structured prompt → decision engine."""
        prof_data = db_get_profile_cached(uid) if uid else dict(DEFAULT_PROFILE)
        prof_ctx = profile_to_context(prof_data)
        bans = prof_data.get("banned_ingredients", [])
        if isinstance(bans, str):
            bans = json.loads(bans) if bans else []

        # STAGE 1: Layer-specific retrieval with layer-specific queries
        # Extract key terms for better retrieval
        words = question.lower().split()
        main_ingredient = next((w for w in words if w in ["kurczak", "wołowina", "wieprzowina", "ryba", "warzywa", "makaron"]), "")
        dish_type = next((w for w in words if w in ["zupa", "stek", "gulasz", "sałatka", "danie", "przystawka"]), "")
        
        # Layer-specific queries for targeted retrieval
        layer_queries = {
            "core": f"{main_ingredient} temperature doneness process" if main_ingredient else question,
            "techniques": f"{main_ingredient} cooking technique" if main_ingredient else question,
            "composition": f"{dish_type} structure balance" if dish_type else question,
            "flavor": f"{main_ingredient} pairing flavor" if main_ingredient else question
        }
        
        # Retrieve with layer-specific queries
        layers = {}
        for layer, query in layer_queries.items():
            layers[layer] = self.search_layer(layer, query)
        
        composition_ctx = trim_context("\n---\n".join(layers.get("composition", [])), 2000)
        flavor_ctx = trim_context("\n---\n".join(layers.get("flavor", [])), 1500)
        core_ctx = trim_context("\n---\n".join(layers.get("core", [])), 2000)
        techniques_ctx = trim_context("\n---\n".join(layers.get("techniques", [])), 1500)  # CRITICAL: techniques was 13KB

        # Build constraints from user profile
        constraints_parts = []
        if prof_ctx:
            constraints_parts.append(prof_ctx)
        if bans:
            constraints_parts.append("BANNED INGREDIENTS: " + ", ".join(bans))
        constraints = "\n".join(constraints_parts) if constraints_parts else "none"

        # STAGE 2-4: Build layered prompt (composition → flavor → core → techniques)
        task_prompt = build_pipeline_prompt(
            user_input=question,
            constraints=constraints,
            composition_ctx=composition_ctx,
            flavor_ctx=flavor_ctx,
            core_ctx=core_ctx,
            techniques_ctx=techniques_ctx,
        )

        system_prompt = SYSTEM_PROMPT_ENGINE
        msgs = list(history or []) + [{"role": "user", "content": task_prompt}]

        # FINAL: LLM call with decision engine
        parsed, usage = self._call(system_prompt, msgs)
        parsed.pop("sources", None)
        parsed.pop("book_references", None)
        parsed = enforce_bans(parsed, bans)
        auto_update_profile(uid, parsed)

        return {
            "data": parsed,
            "profile": profile,
            "usage": {
                "prompt_tokens": usage.prompt_tokens if usage else 0,
                "completion_tokens": usage.completion_tokens if usage else 0,
            },
        }

    def ask_stream_prompt(self, question, history=None, profile="lukasz", uid=None):
        """Build prompt for streaming — returns (system_prompt, messages, prof_data)."""
        prof_data = db_get_profile_cached(uid) if uid else dict(DEFAULT_PROFILE)
        prof_ctx = profile_to_context(prof_data)
        bans = prof_data.get("banned_ingredients", [])
        if isinstance(bans, str):
            bans = json.loads(bans) if bans else []

        # STAGE 1: Layer-specific retrieval with layer-specific queries (streaming version)
        # Extract key terms for better retrieval
        words = question.lower().split()
        main_ingredient = next((w for w in words if w in ["kurczak", "wołowina", "wieprzowina", "ryba", "warzywa", "makaron"]), "")
        dish_type = next((w for w in words if w in ["zupa", "stek", "gulasz", "sałatka", "danie", "przystawka"]), "")
        
        # Layer-specific queries for targeted retrieval
        layer_queries = {
            "core": f"{main_ingredient} temperature doneness process" if main_ingredient else question,
            "techniques": f"{main_ingredient} cooking technique" if main_ingredient else question,
            "composition": f"{dish_type} structure balance" if dish_type else question,
            "flavor": f"{main_ingredient} pairing flavor" if main_ingredient else question
        }
        
        # Retrieve with layer-specific queries
        layers = {}
        for layer, query in layer_queries.items():
            layers[layer] = self.search_layer(layer, query)
        
        composition_ctx = trim_context("\n---\n".join(layers.get("composition", [])), 2000)
        flavor_ctx = trim_context("\n---\n".join(layers.get("flavor", [])), 1500)
        core_ctx = trim_context("\n---\n".join(layers.get("core", [])), 2000)
        techniques_ctx = trim_context("\n---\n".join(layers.get("techniques", [])), 1500)  # CRITICAL: techniques was 13KB

        constraints_parts = []
        if prof_ctx:
            constraints_parts.append(prof_ctx)
        if bans:
            constraints_parts.append("BANNED INGREDIENTS: " + ", ".join(bans))
        constraints = "\n".join(constraints_parts) if constraints_parts else "none"

        task_prompt = build_pipeline_prompt(
            user_input=question,
            constraints=constraints,
            composition_ctx=composition_ctx,
            flavor_ctx=flavor_ctx,
            core_ctx=core_ctx,
            techniques_ctx=techniques_ctx,
        )

        msgs = list(history or []) + [{"role": "user", "content": task_prompt}]
        return SYSTEM_PROMPT_ENGINE, msgs, prof_data

    # ─── Other methods (training, meal plan, surprise, import) ───

    def train(self, mod_id, phase, question="", history=None, profile="lukasz", uid=None):
        mod = next((m for m in TRAINING_MODULES if m["id"] == mod_id), None)
        if not mod:
            return {"data": {"type": "text", "content": "Nieznany modul."}, "profile": profile, "usage": {}}
        prof_data = db_get_profile(uid) if uid else dict(DEFAULT_PROFILE)
        prof_ctx = profile_to_context(prof_data)
        chunks = self.multi_search(mod["search_queries"]) if phase in ("theory", "exercise") else (self.search(question) if question else self.multi_search(mod["search_queries"][:2]))
        ctx = "\n---\n".join([c['text'] for c in chunks])
        prompt = build_training_prompt(mod_id, phase, profile, ctx, prof_ctx)
        msgs = list(history or [])
        if phase == "theory":
            msgs.append({"role": "user", "content": f"Naucz mnie: {mod['title']}"})
        elif phase == "exercise":
            msgs.append({"role": "user", "content": f"Cwiczenie: {mod['title']}"})
        else:
            msgs.append({"role": "user", "content": question or "Jak mi poszlo?"})
        parsed, usage = self._call(prompt, msgs, mode="smart")
        parsed.pop("sources", None)
        parsed.pop("book_references", None)
        bans = prof_data.get("banned_ingredients", [])
        if isinstance(bans, str):
            bans = json.loads(bans) if bans else []
        parsed = enforce_bans(parsed, bans)
        auto_update_profile(uid, parsed)
        return {"data": parsed, "profile": profile, "usage": {"prompt_tokens": usage.prompt_tokens if usage else 0, "completion_tokens": usage.completion_tokens if usage else 0}}

    def meal_plan(self, days=7, prefs="", profile="lukasz", uid=None, persons=2, kcal=0, meals=None, diet=""):
        prof_data = db_get_profile(uid) if uid else dict(DEFAULT_PROFILE)
        prof_ctx = profile_to_context(prof_data)
        layers = self.search_all_layers("meal plan balanced dinner lunch breakfast", k=3)
        ctx = "\n---\n".join(layers.get("composition", []) + layers.get("flavor", []))
        base = PROFILES.get(profile, PROMPT_LUKASZ).replace("{profile_context}", prof_ctx)
        prompt = base + (f"\n\n## KONTEKST WIEDZY:\n{ctx}" if ctx else "")
        bans = prof_data.get("banned_ingredients", [])
        if isinstance(bans, str):
            bans = json.loads(bans) if bans else []
        ban_text = ""
        if bans:
            ban_text = f"\nZAKAZANE SKŁADNIKI (nigdy nie używaj): {', '.join(bans)}."
        meal_types = meals or ["obiad", "kolacja"]
        meal_str = ", ".join(meal_types)
        kcal_str = f" Cel kaloryczny: ~{kcal} kcal/dzień." if kcal else ""
        diet_str = f" Dieta: {diet}." if diet else ""
        user_msg = (
            f"Stwórz plan posiłków na {days} dni dla {persons} osób.{diet_str}{kcal_str}{ban_text}\n"
            f"Posiłki do zaplanowania: {meal_str}.\n"
            f"Preferencje: {prefs or 'brak'}.\n\n"
            f"WAŻNE: Odpowiedz WYŁĄCZNIE poprawnym JSON.\n"
            f"Format:\n"
            f'{{"type":"meal_plan","days":[\n'
            f'  {{"day":"Dzień 1","meals":[\n'
            f'    {{"meal":"obiad","title":"Nazwa dania","prep_time":30,"kcal":550,\n'
            f'      "ingredients":[{{"amount":"200g","item":"kurczak"}},...],\n'
            f'      "steps":["Krok 1...","Krok 2..."]\n'
            f'    }}\n'
            f'  ]}}\n'
            f'],\n'
            f'"shopping_list":[{{"amount":"400g","item":"kurczak","section":"mięso","sources":["Dzień 1 obiad"]}}]\n'
            f'}}'
        )
        parsed, usage = self._call(prompt, [{"role": "user", "content": user_msg}], mode="smart")
        parsed.pop("sources", None)
        parsed = enforce_bans(parsed, bans)
        return {"data": parsed, "profile": profile, "usage": {"prompt_tokens": usage.prompt_tokens if usage else 0, "completion_tokens": usage.completion_tokens if usage else 0}}

    def surprise(self, profile="lukasz", uid=None):
        return self.ask(random.choice(SURPRISE_THEMES), profile=profile, uid=uid)

    def import_url(self, url, page_text, profile="guest", uid=None):
        prof_data = db_get_profile(uid) if uid else dict(DEFAULT_PROFILE)
        prof_ctx = profile_to_context(prof_data)
        bans = prof_data.get("banned_ingredients", [])
        if isinstance(bans, str):
            bans = json.loads(bans) if bans else []
        ban_text = ""
        if bans:
            ban_text = "\n\n## !!! ABSOLUTNE ZAKAZY !!!\nZAKAZANE: " + ", ".join(bans) + "\nUsun zakazane i zaproponuj zamiennik w 'substitutes'."
        # Layer search for import context
        search_text = page_text[:300]
        layers = self.search_all_layers(search_text, k=3)
        core_ctx = "\n---\n".join(layers.get("core", []))
        tech_ctx = "\n---\n".join(layers.get("techniques", []))
        import_knowledge = ""
        if core_ctx or tech_ctx:
            import_knowledge = f"\n\n## CORE DATA:\n{core_ctx}\n\n## TECHNIQUES:\n{tech_ctx}"
        base = PROFILES.get(profile, PROMPT_LUKASZ).replace("{profile_context}", prof_ctx)
        prompt = base + ban_text + import_knowledge + """

## ZADANIE: WIERNY IMPORT PRZEPISU Z INTERNETU
Przeksztalc ponizszy przepis na JSON type:recipe.

NAJWAZNIEJSZA ZASADA: WIERNOSC ORYGINALOWI!
- Uzyj DOKLADNIE tych samych skladnikow co oryginal. NIE usuwaj, NIE zamieniaj, NIE dodawaj skladnikow od siebie!
- Jedyny wyjatek: skladniki z listy ZAKAZANYCH.
- Zachowaj IDENTYCZNA kolejnosc i sposob przygotowania co oryginal!
- NIE LACZ krokow. NIE UPRASZCZAJ. Odtwarzaj procedury 1:1.
- Przelicz na gramy/ml: lyzka=15ml, lyzeczka=5ml, szklanka=250ml, szczypta=1g.
- Dodaj 'science', 'why', 'tip', 'warnings', 'upgrade' ale NIE zmieniaj oryginalnych skladnikow/krokow.
- ZAWSZE podawaj ilosci w nawiasach w instrukcjach krokow.
- NIE dodawaj pola 'sources' do odpowiedzi."""
        parsed, usage = self._call(prompt, [{"role": "user", "content": f"URL: {url}\n\nTRESC PRZEPISU:\n{page_text[:5000]}"}], mode="smart")
        parsed.pop("sources", None)
        parsed.pop("book_references", None)
        parsed = enforce_bans(parsed, bans)
        auto_update_profile(uid, parsed)
        return {"data": parsed, "profile": profile, "usage": {"prompt_tokens": usage.prompt_tokens if usage else 0, "completion_tokens": usage.completion_tokens if usage else 0}}

    def total_chunks(self):
        """Total chunks across all 4 layer collections."""
        return sum(col.count() for col in self.collections.values())

# â”€â”€â”€ Flask â”€â”€â”€
def create_app():
    app=Flask(__name__,static_folder="static",static_url_path="/static")
    CORS(app,resources={r"/api/*":{"origins":"*"}})
    key=os.environ.get("OPENAI_API_KEY") or os.environ.get("GROQ_API_KEY") or os.environ.get("DEEPSEEK_API_KEY")
    app.config["assistant"]=CulinaryAssistant(key) if key else None
    if key and app.config["assistant"]:
        a=app.config["assistant"]
        layer_info = " | ".join(f"{l}:{a.collections[l].count()}" for l in KNOWLEDGE_LAYERS)
        logger.info(f"Ready: {a.total_chunks()} chunks [{layer_info}], model: {AI_MODEL}")
    init_supabase()

    @app.route("/api/health")
    def health():
        a=app.config.get("assistant")
        layers_info = {l: a.collections[l].count() for l in KNOWLEDGE_LAYERS} if a else {}
        return jsonify({"status":"ok","chunks":a.total_chunks() if a else 0,"layers":layers_info,"model":AI_MODEL,"supabase":sb is not None})

    @app.route("/api/config")
    def config():
        return jsonify({"supabase_url":SUPABASE_URL,"supabase_anon_key":SUPABASE_ANON_KEY})

    # â”€â”€â”€ Subscription Helpers â”€â”€â”€
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

    # â”€â”€â”€ Stripe Endpoints â”€â”€â”€
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

    @app.route("/api/stripe/webhook", methods=["POST"])
    def stripe_webhook():
        payload = request.get_data()
        sig = request.headers.get("Stripe-Signature")

        try:
            event = stripe.Webhook.construct_event(
                payload, sig, STRIPE_WEBHOOK_SECRET
            )
        except Exception as e:
            logger.error(f"Webhook signature error: {e}")
            return jsonify({"error": "Invalid signature"}), 400

        etype = event["type"]
        data = event["data"]["object"]

        logger.info(f"Stripe webhook: {etype}")

        # âś… CHECKOUT COMPLETED
        if etype == "checkout.session.completed":
            try:
                metadata = data["metadata"] if "metadata" in data else {}
                uid = metadata.get("supabase_uid")

                customer_id = data["customer"] if "customer" in data else None

                if not uid:
                    logger.error("No supabase_uid in metadata")
                    return jsonify({"error": "No UID"}), 200

                db_update_profile(uid, {
                    "stripe_customer_id": customer_id,
                    "subscription_status": "active"
                })

                logger.info(f"PRO activated for {uid}")

            except Exception as e:
                logger.error(f"Checkout webhook error: {e}")
                return jsonify({"error": "Webhook error"}), 500

        # âś… SUBSCRIPTION UPDATE / DELETE
        elif etype in ("customer.subscription.updated", "customer.subscription.deleted"):
            try:
                customer_id = data["customer"] if "customer" in data else None
                status = data["status"] if "status" in data else ""
                period_end = data["current_period_end"] if "current_period_end" in data else None

                if not customer_id:
                    return jsonify({"error": "No customer_id"}), 200

                # znajdź usera po stripe_customer_id
                r = sb.table("profiles").select("id").eq("stripe_customer_id", customer_id).execute()

                if r.data:
                    uid = r.data[0]["id"]

                    updates = {
                        "subscription_status": status if status != "canceled" else "canceled"
                    }

                    if period_end:
                        updates["subscription_end"] = datetime.utcfromtimestamp(period_end).isoformat()

                    db_update_profile(uid, updates)

                    logger.info(f"Subscription {status} for {uid}")

            except Exception as e:
                logger.error(f"Subscription webhook error: {e}")
                return jsonify({"error": "Webhook error"}), 500

        return jsonify({"received": True}), 200

    # â”€â”€â”€ Chat â”€â”€â”€
    @app.route("/api/ask",methods=["POST"])
    @require_auth
    def api_ask():
        a=app.config.get("assistant")
        if not a: return jsonify({"error":"Not init"}),503
        allowed,count,limit=check_daily_limit(g.user_id,"recipes")
        if not allowed: return jsonify({"error":"limit","message":f"Dzienny limit {limit} przepisĂłw wyczerpany. PrzejdĹş na PRO!","is_limit":True}),429
        d=request.get_json(silent=True) or {}
        q=(d.get("question") or "").strip()
        if not q: return jsonify({"error":"No question"}),400
        p=db_get_profile_cached(g.user_id)
        pr=p.get("bot_profile","guest")
        h=[{"role":m["role"],"content":m["content"]} for m in (d.get("conversation_history") or []) if isinstance(m,dict) and m.get("role") in ("user","assistant")][-MAX_HISTORY:]
        try:
            # Use 2-step pipeline by default, fallback to 4-layer if needed
            try:
                result=a.generate_recipe(q,h,profile=pr,uid=g.user_id)
            except Exception as e:
                logger.error(f"2-step pipeline failed: {e}, falling back to 4-layer")
                result=a.ask(q,h,profile=pr,uid=g.user_id)
            increment_daily(g.user_id,"recipes")
            return jsonify({"success":True,**result})
        except: logger.error(traceback.format_exc()); return jsonify({"error":"Blad serwera."}),500

    @app.route("/api/ask-2step",methods=["POST"])
    @require_auth
    def api_ask_2step():
        """Explicit 2-step pipeline endpoint for testing."""
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
        
        # Force 2-step pipeline
        try:
            result=a.generate_recipe(q,h,profile=pr,uid=g.user_id)
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
        h=[{"role":m["role"],"content":m["content"]} for m in (d.get("conversation_history") or []) if isinstance(m,dict) and m.get("role") in ("user","assistant")][-MAX_HISTORY:]
        # Use 4-layer pipeline for streaming
        system_prompt,msgs,prof_data=a.ask_stream_prompt(q,h,profile=pr,uid=g.user_id)
        uid=g.user_id
        def generate():
            full=""
            try:
                for chunk_text in a._call_stream(system_prompt,msgs):
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
                bans=prof_data.get("banned_ingredients",[])
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
        if not allowed: return jsonify({"error":"limit","message":f"Dzienny limit {limit} przepisĂłw wyczerpany. PrzejdĹş na PRO!","is_limit":True}),429
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
        try:
            return jsonify({"success":True,**a.meal_plan(
                days=min(int(d.get("days",7)),14),
                prefs=(d.get("preferences") or ""),
                profile=p.get("bot_profile","guest"),
                uid=g.user_id,
                persons=min(int(d.get("persons",2)),10),
                kcal=int(d.get("kcal",0) or 0),
                meals=d.get("meals"),
                diet=(d.get("diet") or "")
            )})
        except:
            logger.error(traceback.format_exc())
            return jsonify({"error":"Blad generowania planu."}),500

    @app.route("/api/planner",methods=["POST"])
    @require_auth
    def api_save_plan():
        d=request.get_json(silent=True) or {}
        plan_body=d.get("body")
        if not plan_body:
            return jsonify({"error":"Brak planu"}),400
        plan_id=d.get("plan_id") or f"plan_{uuid.uuid4().hex}"
        title=(d.get("title") or "Plan posiłków").strip()
        saved=db_save_plan(g.user_id,plan_id,title,plan_body)
        if not saved:
            return jsonify({"error":"Nie udało się zapisać planu"}),500
        return jsonify({"success":True,"plan":saved})

    @app.route("/api/planner",methods=["GET"])
    @require_auth
    def api_list_plans():
        plans=db_get_plans(g.user_id)
        return jsonify({"plans":plans})

    @app.route("/api/planner/<plan_id>",methods=["GET","DELETE"])
    @require_auth
    def api_plan(plan_id):
        if request.method=="GET":
            plan=db_get_plan(g.user_id,plan_id)
            if not plan: return jsonify({"error":"Plan nie znaleziony"}),404
            return jsonify({"plan":plan["plan"] if plan else None})
        else:
            success=db_delete_plan(g.user_id,plan_id)
            if not success: return jsonify({"error":"Nie udało się usunąć"}),500
            return jsonify({"success":True})

    @app.route("/api/import-url",methods=["POST"])
    @require_auth
    def api_import_url():
        a=app.config.get("assistant")
        if not a: return jsonify({"error":"Not init"}),503
        if not http_requests: return jsonify({"error":"Modul requests niedostepny"}),500
        allowed,count,limit=check_daily_limit(g.user_id,"imports")
        if not allowed: return jsonify({"error":"limit","message":f"Dzienny limit {limit} importĂłw wyczerpany. PrzejdĹş na PRO!","is_limit":True}),429
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

    @app.route("/api/knowledge/reload", methods=["POST"])
    @require_auth
    def reload_knowledge():
        """Reload culinary knowledge base into 4 layer collections."""
        try:
            a=app.config.get("assistant")
            if not a: return jsonify({"error":"Assistant not initialized"}),503
            a._load_knowledge_base()
            layers_info = {l: a.collections[l].count() for l in KNOWLEDGE_LAYERS}
            return jsonify({"success": True, "message": "Knowledge base reloaded", "total_chunks": a.total_chunks(), "layers": layers_info})
        except Exception as e:
            logger.error(f"Knowledge reload error: {e}")
            return jsonify({"error": str(e)}), 500

    @app.route("/api/knowledge/stats")
    @require_auth
    def knowledge_stats():
        """Get 4-layer knowledge base statistics."""
        try:
            a=app.config.get("assistant")
            if not a: return jsonify({"error":"Assistant not initialized"}),503
            layers = {}
            for layer in KNOWLEDGE_LAYERS:
                layers[layer] = {
                    "indexed_chunks": a.collections[layer].count(),
                    "raw_items": len(CULINARY_KNOWLEDGE.get(layer, [])),
                }
            return jsonify({"total_chunks": a.total_chunks(), "layers": layers})
        except Exception as e:
            logger.error(f"Knowledge stats error: {e}")
            return jsonify({"error": str(e)}), 500

    @app.route("/api/stats")
    def stats():
        a=app.config.get("assistant")
        return jsonify({"chunks":a.total_chunks() if a else 0,"model":AI_MODEL})

    @app.route("/")
    def index(): return send_from_directory("static","index.html")

    return app

app=create_app()
if __name__=="__main__":
    port=int(os.environ.get("PORT",5000))
    a=app.config.get("assistant")
    chunks=a.total_chunks() if a else 0
    logger.info(f"Chef AI v11 — http://localhost:{port} | {chunks} chunks | {AI_MODEL} | 4-layer pipeline")
    app.run(host="0.0.0.0",port=port,debug=False)

