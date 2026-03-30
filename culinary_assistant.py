#!/usr/bin/env python3
"""Chef AI v11 â€” Supabase Auth + PostgreSQL + Stripe"""

# Load environment variables from .env file
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

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

# â”€â”€â”€ Free tier limits â”€â”€â”€
FREE_RECIPES_PER_DAY=5
FREE_IMPORTS_PER_DAY=2

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
                if w and w not in ('kaĹĽda forma','kaĹĽda','forma','surowa','smaĹĽona','proszek','Ĺ›wieĹĽa','mielona','i'):
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
            warn={"problem":"UsuniÄ™to zakazane skĹ‚adniki: "+", ".join(removed),"solution":"Te skĹ‚adniki zostaĹ‚y automatycznie usuniÄ™te z przepisu."}
            if not data.get("warnings"): data["warnings"]=[]
            data["warnings"].insert(0,warn)
    return data

# â”€â”€â”€ Skill Tree â”€â”€â”€
SKILL_CATEGORIES=[
    {"id":"basics","name":"Techniki bazowe","icon":"đź”Ą","color":"#c45050"},
    {"id":"sousvide","name":"Sous-vide","icon":"đźŚˇ","color":"#5cb870"},
    {"id":"sauces","name":"Sosy","icon":"đźĄ„","color":"#d4a24e"},
    {"id":"baking","name":"Ciasta i wypieki","icon":"đźŤ°","color":"#c45e8a"},
    {"id":"pasta","name":"Makaron domowy","icon":"đźŤť","color":"#d4a24e"},
    {"id":"italian","name":"Kuchnia wĹ‚oska","icon":"đź‡®đź‡ą","color":"#5cb870"},
    {"id":"asian","name":"Kuchnia azjatycka","icon":"đźĄ˘","color":"#c45050"},
    {"id":"grill","name":"Grillowanie i BBQ","icon":"đź”Ą","color":"#d4a24e"},
    {"id":"fermentation","name":"Fermentacja","icon":"đź«™","color":"#8b3a62"},
    {"id":"molecular","name":"Hydrokoloidy","icon":"đź§Ş","color":"#5e8ac4"},
    {"id":"fish","name":"Ryby i krewetki","icon":"đźź","color":"#5cb870"},
    {"id":"vegetables","name":"Warzywa","icon":"đźĄ¬","color":"#5cb870"},
    {"id":"knives","name":"NoĹĽe i ciÄ™cie","icon":"đź”Ş","color":"#8a7e84"},
    {"id":"plating","name":"Platowanie","icon":"đźŽ¨","color":"#c45e8a"},
    {"id":"mealprep","name":"Meal prep","icon":"đź“¦","color":"#5e8ac4"},
]
SKILL_LEVELS=["basic","intermediate","advanced"]
SKILL_LEVEL_NAMES={"basic":"Podstawy","intermediate":"Ĺšredni","advanced":"Zaawansowany"}

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
            modules.append({"id":mid,"category":cid,"level":lvl,"title":f"{cat['name']} â€” {SKILL_LEVEL_NAMES[lvl]}","subtitle":f"{cat['icon']} {SKILL_LEVEL_NAMES[lvl]}","icon":cat["icon"],"search_queries":sq})
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
Gdy uzytkownik pyta o porownanie, roznice, "na ile sposobow", "co lepsze" â€” uzyj type:comparison z 2-4 wariantami.
Opcjonalne: "kcal_per_serving" jesli user poda limit.

## ZASADY:
- ZAWSZE czysty JSON, zero tekstu poza nim
- ZAWSZE gramy/ml (nigdy lyzki)
- ZAWSZE C (+F w nawiasie)
- UZYJ wiedzy z kontekstu do wyjasniania nauki i technik, ale NIGDY nie podawaj tytulow ksiazek ani nazwisk autorow. Pisz jak ekspert ktory po prostu WIE â€” nie powoluj sie na zrodla.
- ZAWSZE timer_seconds w krokach z czekaniem
- ZAWSZE w instrukcji kroku podawaj DOKLADNA ILOSC skladnika w nawiasie przy kazdym dodaniu
- NIE dodawaj pola "sources" do odpowiedzi.
- Ton: kumpel-ekspert z pasja. POLSKI."""

PROMPT_LUKASZ="""Jestes osobistym mentorem kulinarnym. PRZEDE WSZYSTKIM PYSZNIE.
Masz gleboka wiedze kulinarna. Uzywaj jej do wyjasniania nauki za gotowaniem.
## PROFIL:
- Lokalizacja: Zarow (Swidnica, Wroclaw)
- Nie liczymy kalorii domyslnie
## ZAKAZY i SPRZET z profilu uzytkownika ponizej â€” BEZWZGLEDNIE przestrzegaj zakazow! Jesli uzytkownik ma sprzet, podawaj KONKRETNE ustawienia (poziomy, temperatury, tryby).
## PAMIEC UZYTKOWNIKA:
{profile_context}
"""+RESPONSE_RULES

PROMPT_GUEST="""Jestes ekspertem kulinarnym. PRZEDE WSZYSTKIM PYSZNIE.
Masz gleboka wiedze kulinarna. Ogolne instrukcje, domyslnie 2 porcje.
Jesli uzytkownik ma zakazy lub sprzet w profilu â€” BEZWZGLEDNIE przestrzegaj zakazow i podawaj ustawienia sprzetu.
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
LAYER_K = 5  # top-K results per layer

def load_culinary_knowledge_base():
    """Load culinary knowledge JSON files from 4 category folders."""
    base_path = os.path.join(os.path.expanduser("~"), "Downloads")
    knowledge_data = {}
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

SYSTEM_PROMPT_ENGINE = """You are a culinary decision engine.

You DO NOT generate generic recipes.
You design dishes using 4 knowledge layers:

1. COMPOSITION (structure, balance, contrast)
2. FLAVOR (pairings, boosters, balancing)
3. CORE (physics: temperature, time, transformations)
4. TECHNIQUES (execution procedures)

You MUST follow this order:
1. First: design the dish (composition)
2. Then: select flavors
3. Then: define physical parameters
4. Then: define execution

Do NOT skip steps. Do NOT mix layers.
Every decision must be justified.

IMPORTANT RULES:
- ALWAYS use grams/ml (never spoons)
- ALWAYS Celsius (+Fahrenheit in parentheses)
- ALWAYS timer_seconds in steps that require waiting
- ALWAYS specify exact amounts in step instructions
- Write in Polish unless user asks otherwise
- Do NOT mention book titles or author names. Write as an expert who simply KNOWS.
"""

TASK_PROMPT_TEMPLATE = """USER INPUT:
{user_input}

CONSTRAINTS:
{constraints}

---

## COMPOSITION RULES (structure, balance):
{composition_data}

## FLAVOR DATA (pairings, boosters):
{flavor_data}

## CORE DATA (physics, temperatures, processes):
{core_data}

## TECHNIQUES (execution procedures):
{techniques_data}

---

TASK:
Design a dish as a decision system. Follow the 4-layer order strictly.

Return JSON with this EXACT structure:
{{
  "type": "recipe",
  "title": "...",
  "subtitle": "...",
  "decision_layers": {{
    "composition": {{
      "structure": "dish structure description",
      "hero": "main ingredient",
      "elements": ["element1", "element2"],
      "balance": "balance logic",
      "contrast": "contrast logic"
    }},
    "flavor": {{
      "pairings": ["pairing1", "pairing2"],
      "boosters": ["booster1"],
      "balancing": ["acid/sweet/etc"]
    }},
    "core": {{
      "key_processes": [{{"process": "...", "target_temp_c": 0, "time_min": 0, "mechanism": "..."}}],
      "critical_points": ["point1"]
    }},
    "techniques": [
      {{"name": "...", "why": "...", "critical_steps": ["step1"]}}
    ],
    "failure_analysis": [
      {{"case": "...", "fix": "..."}}
    ]
  }},
  "science": "overall science explanation",
  "times": {{"prep_min": 0, "cook_min": 0, "total_min": 0}},
  "difficulty": 3,
  "servings": 2,
  "shopping_list": [{{"item": "...", "amount": "...", "section": "..."}}],
  "ingredients": [{{"item": "...", "amount": "...", "note": "..."}}],
  "substitutes": [{{"original": "...", "substitute": "...", "note": "..."}}],
  "mise_en_place": ["..."],
  "steps": [{{"number": 1, "title": "...", "instruction": "...", "equipment": "...", "timer_seconds": 0, "tip": "...", "why": "..."}}],
  "warnings": [{{"problem": "...", "solution": "..."}}],
  "upgrade": "..."
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

    def __init__(self, api_key):
        self.client = OpenAI(api_key=api_key, base_url=AI_BASE_URL)
        self.embedding_function = embedding_functions.DefaultEmbeddingFunction()
        self._search_cache = {}

        # 4 separate ChromaDB collections — one per knowledge layer
        db = chromadb.PersistentClient(path=CHROMA_DB_PATH)
        self.collections = {}
        for layer, cfg in KNOWLEDGE_LAYERS.items():
            self.collections[layer] = db.get_or_create_collection(
                cfg["collection"], embedding_function=self.embedding_function
            )

        # Legacy single collection for backward compat (training, meal_plan)
        self.col = db.get_or_create_collection(
            "culinary_knowledge", embedding_function=self.embedding_function
        )

        self._load_knowledge_base()

    def _load_knowledge_base(self):
        """Load JSON files and index into 4 separate ChromaDB collections."""
        try:
            knowledge_data = load_culinary_knowledge_base()
            all_docs, all_metas, all_ids = [], [], []

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

                # Also add to legacy combined collection
                all_docs.extend(docs)
                all_metas.extend(metas)
                all_ids.extend(ids)

            # Update legacy combined collection
            if all_docs:
                try:
                    existing = self.col.get()
                    if existing and existing["ids"]:
                        self.col.delete(ids=existing["ids"])
                except Exception:
                    pass
                self.col.add(documents=all_docs, metadatas=all_metas, ids=all_ids)
                logger.info(f"  [combined] indexed {len(all_docs)} total documents")

        except Exception as e:
            logger.error(f"Knowledge base load error: {e}")

    # ─── Layer-specific search (TOP-K per layer) ───

    def search_layer(self, layer, query, k=LAYER_K):
        """Search a single knowledge layer. Returns list of text strings."""
        col = self.collections.get(layer)
        if not col or col.count() == 0:
            return []
        cache_key = hashlib.md5(f"{layer}:{query}:{k}".encode()).hexdigest()
        if cache_key in self._search_cache:
            return self._search_cache[cache_key]
        r = col.query(query_texts=[query], n_results=min(k, col.count()))
        texts = r["documents"][0] if r["documents"] and r["documents"][0] else []
        if len(self._search_cache) >= self._CACHE_SIZE:
            del self._search_cache[next(iter(self._search_cache))]
        self._search_cache[cache_key] = texts
        return texts

    def search_all_layers(self, query, k=LAYER_K):
        """Search all 4 layers separately. Returns dict {layer: [texts]}."""
        return {layer: self.search_layer(layer, query, k) for layer in KNOWLEDGE_LAYERS}

    # Legacy search methods (for training, meal_plan, import)
    def search(self, q, n=SEARCH_RESULTS):
        if self.col.count() == 0:
            return []
        cache_key = hashlib.md5((q + str(n)).encode()).hexdigest()
        if cache_key in self._search_cache:
            return self._search_cache[cache_key]
        r = self.col.query(query_texts=[q], n_results=min(n, self.col.count()))
        result = [{"text": r["documents"][0][i]} for i in range(len(r["documents"][0]))] if r["documents"] and r["documents"][0] else []
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

    # ─── 4-STAGE PIPELINE: ask() ───

    def ask(self, question, history=None, profile="lukasz", uid=None):
        """Main pipeline: 4-layer retrieval → structured prompt → decision engine."""
        prof_data = db_get_profile_cached(uid) if uid else dict(DEFAULT_PROFILE)
        prof_ctx = profile_to_context(prof_data)
        bans = prof_data.get("banned_ingredients", [])
        if isinstance(bans, str):
            bans = json.loads(bans) if bans else []

        # STAGE 1: Layer-specific retrieval (top-K per layer)
        layers = self.search_all_layers(question, k=LAYER_K)

        composition_ctx = "\n---\n".join(layers.get("composition", []))
        flavor_ctx = "\n---\n".join(layers.get("flavor", []))
        core_ctx = "\n---\n".join(layers.get("core", []))
        techniques_ctx = "\n---\n".join(layers.get("techniques", []))

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

        layers = self.search_all_layers(question, k=LAYER_K)
        composition_ctx = "\n---\n".join(layers.get("composition", []))
        flavor_ctx = "\n---\n".join(layers.get("flavor", []))
        core_ctx = "\n---\n".join(layers.get("core", []))
        techniques_ctx = "\n---\n".join(layers.get("techniques", []))

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

    def meal_plan(self, days=7, prefs="", profile="lukasz", uid=None):
        prof_data = db_get_profile(uid) if uid else dict(DEFAULT_PROFILE)
        prof_ctx = profile_to_context(prof_data)
        # Use layer search for meal planning
        layers = self.search_all_layers("meal plan balanced dinner lunch", k=3)
        ctx = "\n---\n".join(layers.get("composition", []) + layers.get("flavor", []))
        base = PROFILES.get(profile, PROMPT_LUKASZ).replace("{profile_context}", prof_ctx)
        prompt = base + (f"\n\n## KONTEKST WIEDZY:\n{ctx}" if ctx else "")
        parsed, usage = self._call(prompt, [{"role": "user", "content": f"Plan posilkow na {days} dni. {prefs}. JSON type:meal_plan."}], mode="smart")
        parsed.pop("sources", None)
        bans = prof_data.get("banned_ingredients", [])
        if isinstance(bans, str):
            bans = json.loads(bans) if bans else []
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

                # znajdĹş usera po stripe_customer_id
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
        try: return jsonify({"success":True,**a.meal_plan(min(int(d.get("days",7)),14),(d.get("preferences") or ""),p.get("bot_profile","guest"),uid=g.user_id)})
        except: logger.error(traceback.format_exc()); return jsonify({"error":"Blad."}),500

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
            for marker in ['SkĹ‚adniki','Ingredients','Przygotowanie','Preparation','Instrukcje']:
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

