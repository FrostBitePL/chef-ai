# Chef AI — Audyt aplikacji

**Data:** 27 kwietnia 2026  
**Wersja:** v11 (cache assets `v=16`)  
**Stack:** Flask (Python 3) + vanilla JS + Supabase + Stripe + Groq/OpenAI LLM + ChromaDB (RAG)

---

## 1. Architektura ogólna

### Backend (`culinary_assistant.py` — ~5970 linii, monolit)
- **Framework:** Flask + Flask-CORS
- **DB użytkownika:** Supabase (auth, profiles, history, plans, favorites, progress, daily_limits)
- **Wiedza (RAG):** ChromaDB, 5 warstw kolekcji: `core`, `composition`, `flavor`, `techniques`, `baking`
- **Korpus:** foldery `Smak/`, `Techniki/`, `Wypieki/`, `Kompozycja/`, `Procedury/`, `Dane/`
- **LLM:** Groq (`llama-3.3-70b-versatile` lub kompatybilny model w `AI_MODEL`)
- **Płatności:** Stripe Checkout + Customer Portal + webhook
- **Auth:** Supabase JWT + cookie session fallback (`get_user_from_token`, `get_user_from_session`)
- **Cache:** profil użytkownika (60s TTL), plan/recipe (LRU w `_plan_cache`/`_recipe_cache`), proposals quick (in-memory)

### Frontend (`static/`)
- **Index:** SPA z 9 widokami (Home, Flow Classic, Flow Quick, Quick Results, Chat, Training, Planner, History, Favorites, Profile) + onboarding overlay + step mode + plan overlay + swap drawer + timery + admin panel
- **JS modułowy** (vanilla, bez bundlera):
  - `app.js` (61KB) — bootstrap, navigation, onboarding, Quick flow, Live cooking, scroll, profil
  - `chat.js` (29KB) — proposals, streaming SSE, render recipe card, timers, edukacja
  - `i18n.js` (72KB) — 5 języków: pl/en/de/es/fr
  - `planner.js` (31KB) — meal planner, draft → swap → finalize
  - `profile.js` (19KB) — edycja profilu, equipment, dietary
  - `recipe_tools.js` (13KB) — pairing, fix, variant, cost, share
  - `live.js` (12KB) — krok-po-kroku z timerem
  - `training.js` (10KB) — skill tree, fazy nauki
  - `filters.js` (10KB) — panel filtrów
  - `favorites.js` (3KB), `history.js` (2KB)
- **Service Worker** (`sw.js`) — PWA / offline cache assets
- **Manifest** — instalowalna aplikacja mobilna

---

## 2. Endpointy API (pełna lista)

### Auth / Config / Health
| Endpoint | Metoda | Opis | Stan |
|---|---|---|---|
| `/api/health` | GET | Status + liczba chunków RAG | ✅ |
| `/api/config` | GET | Supabase URL + anon key (frontend bootstrap) | ✅ |
| `/api/stats` | GET | Liczba chunków + model | ✅ |

### Stripe / Subskrypcje
| Endpoint | Metoda | Opis | Stan |
|---|---|---|---|
| `/api/stripe/checkout` | POST | Tworzy sesję Stripe Checkout | ✅ |
| `/api/stripe/portal` | POST | Customer portal (zarządzanie subskrypcją) | ✅ |
| `/api/stripe/status` | GET | Status sub + dzienne limity | ✅ |
| `/api/stripe/webhook` | POST | Webhook (checkout/cancel/expired) | ✅ |

### Debug (DEV)
| Endpoint | Metoda | Opis | Uwaga |
|---|---|---|---|
| `/api/debug/grant-pro` | POST | Nadaje `role=admin` bieżącemu userowi | ⚠️ DEV — usunąć przed produkcją |
| `/api/debug/me` | GET | Surowy odczyt profilu z bazy | ⚠️ DEV |
| `/admin-debug` | GET | HTML debug session/token | ⚠️ DEV |

### Chat / Generowanie przepisów
| Endpoint | Metoda | Opis | Stan |
|---|---|---|---|
| `/api/ask` | POST | 4-warstwowy pipeline (synchroniczny) | ✅ (po fixie języka) |
| `/api/ask-2step` | POST | 2-step planner+executor | ✅ |
| `/api/ask-stream` | POST | SSE streaming odpowiedź | ✅ |
| `/api/proposals` | POST | 5 propozycji dań (specific vs vague) | ✅ (po fixie języka) |
| `/api/sos` | POST | Awaryjny doradca (przypalone, surowe, etc.) | ✅ |
| `/api/surprise` | POST | Losowy temat → przepis | ✅ |
| `/api/import-url` | POST | Import przepisu z URL (LD-JSON + CSS + AI) | ✅ |

### Meal Planner
| Endpoint | Metoda | Opis | Stan |
|---|---|---|---|
| `/api/meal-plan` | POST | Pełny plan w jednym wywołaniu (legacy) | ✅ |
| `/api/plan/draft` | POST | Lekki draft (tytuły + kcal) | ✅ |
| `/api/plan/swap` | POST | 3 alternatywy dla 1 posiłku | ✅ |
| `/api/plan/swap-custom` | POST | User pisze własny meal | ✅ |
| `/api/plan/finalize` | POST | Pełne przepisy z draftu | ✅ |
| `/api/planner` | GET/POST | Lista / zapis planów | ✅ |
| `/api/planner/<id>` | GET/DELETE | Szczegóły / usuń | ✅ |

### Flow Endpoints (Quick / Classic)
| Endpoint | Metoda | Opis | Stan |
|---|---|---|---|
| `/api/recipes/quick` | POST | AI generuje 8 dań per kategoria+czas+profil | ✅ (przepisany) |
| `/api/recipes/classic` | POST | Index chips + DB / AI on-demand | ✅ |

### Training
| Endpoint | Metoda | Opis | Stan |
|---|---|---|---|
| `/api/train` | POST | Lekcja teorii/praktyki | ✅ |
| `/api/modules` | GET | Lista modułów + skill tree | ✅ |
| `/api/progress` | GET/POST | Postęp użytkownika | ✅ |
| `/api/progress/reset` | POST | Reset postępu | ✅ |

### Profile / History / Favorites
| Endpoint | Metoda | Opis | Stan |
|---|---|---|---|
| `/api/profile` | GET/POST | Pobierz/zapisz profil | ✅ |
| `/api/profile/reset` | POST | Reset do defaults | ✅ |
| `/api/history` | GET/POST | Lista/zapis sesji | ✅ |
| `/api/history/<sid>` | DELETE | Usuń sesję | ✅ |
| `/api/favorites` | GET/POST | Lista/dodaj | ✅ |
| `/api/favorites/<id>` | DELETE | Usuń | ✅ |

### Recipe Tools
| Endpoint | Metoda | Opis | Stan |
|---|---|---|---|
| `/api/pairing` | POST | Dobór napojów (wino, piwo, drink, mocktail) | ✅ |
| `/api/timeline` | POST | Timeline kroków (parallel cooking) | ✅ |
| `/api/fix` | POST | Naprawa błędu (przesolone, etc.) | ✅ |
| `/api/variant` | POST | Wariant przepisu (lighter, vegan, etc.) | ✅ |
| `/api/cost` | POST | Szacunkowy koszt | ✅ |
| `/api/pantry` | GET/POST | Spiżarnia użytkownika | ✅ |
| `/api/notes` | GET/POST | Notatki do przepisu | ✅ |
| `/api/share` | POST | Generuje token do dzielenia | ✅ |
| `/api/share/<token>` | GET | Pobierz przepis publicznie | ✅ |

### Knowledge / RAG
| Endpoint | Metoda | Opis | Stan |
|---|---|---|---|
| `/api/knowledge/reload` | POST | Reindex korpusu (admin) | ✅ |
| `/api/knowledge/stats` | GET | Statystyki kolekcji | ✅ |

### Admin Panel (`/admin` + `/admin/api/*`)
| Endpoint | Stan |
|---|---|
| `/admin` (HTML) | ✅ |
| `/admin/api/stats` (metryki agregowane) | ✅ |
| `/admin/api/users` (lista profili + auth users) | ✅ |
| `/admin/api/users/<id>` (szczegóły) | ✅ |
| `/admin/api/users/<id>/role` (POST role) | ✅ |
| `/admin/api/health` (system health) | ✅ |

### Static / SEO
- `/`, `/favicon.ico`, `/robots.txt`, `/sitemap.xml`, `/test`

**Łącznie: ~60 endpointów REST/SSE.**

---

## 3. Pipeline AI (klucz aplikacji)

### `assistant.ask()` — 4-warstwowy (główny flow chatu)
1. **Stage 0:** detekcja SOS (przypalone/za słone/surowe) → bypass do `generate_sos_response()`
2. **Stage 1:** layer-specific retrieval — równoległe wyszukiwanie po 5 kolekcjach (`composition`, `flavor`, `core`, `techniques`, `baking`) z dedykowanymi zapytaniami
3. **Stage 2-4:** budowa promptu warstwowego z kontekstami z RAG + profil + bany + ekwipunek
4. **Stage final:** wywołanie LLM z `SYSTEM_PROMPT_ENGINE` + `get_lang_instruction(lang)` (✅ po dzisiejszym fixie)
5. **Post-processing:** `enforce_bans()`, `enforce_equipment()`, `auto_update_profile()`

### `assistant.generate_recipe()` — 2-step (alternatywny)
1. **PLANNER:** struktura decyzyjna (technika, czas, składniki kluczowe) — z cache
2. **EXECUTOR:** pełny przepis JSON — `EXECUTOR_PROMPT_FAST` (proste) lub `EXECUTOR_PROMPT` (pełne)
3. **Validation:** `validate_plan()`, `validate_recipe()` — twardy schema check
4. Oba wywołania mają teraz `get_lang_instruction(lang)` w system prompt (✅ fix)

### `assistant.proposals()` — propozycje dań
- 5 propozycji `{title, subtitle, time_min, difficulty, cuisine, wow}`
- Wykrywa specific vs vague query
- Wymusza wyjściowy język w prompt + system prompt (✅ fix)

### `assistant.surprise()` / `import_url()` / `meal_plan()` / `train()` / `pairing()` / `fix()` / `variant()`
- Każda metoda buduje własny prompt + dodaje `get_lang_instruction(lang)` na końcu

### `assistant.ask_stream()` — streaming SSE
- Używa `SYSTEM_PROMPT_ENGINE + get_lang_instruction(lang)` (✅ od początku poprawnie)
- JSON parser odbiera chunki, parsuje na bieżąco, FE renderuje preview

---

## 4. Widoki frontendowe (UI)

| Widok | Plik JS | Status |
|---|---|---|
| **Home** (Łukasz, co dziś gotujemy?) | `app.js` | ✅ skrócone powitanie |
| **Flow Classic** (klasyki kuchni) | `app.js` (`loadClassicIndex`, `showBestVersionPreview`) | ✅ |
| **Flow Quick** (kategorie + czas) | `app.js` | ✅ |
| **Quick Results** | `app.js` (`renderQuickResults`) | ✅ przepisany — 8 dań, hook desc, smart click |
| **Chat** | `chat.js` | ✅ smart-scroll z pill, streaming, proposals |
| **Training** (skill tree) | `training.js` | ✅ |
| **Planner** | `planner.js` | ✅ draft → swap → finalize |
| **History** | `history.js` | ✅ |
| **Favorites** | `favorites.js` | ✅ |
| **Profile** | `profile.js` | ✅ ban, equipment, dietary, stats |
| **Step mode overlay** | `app.js` | ✅ pełny ekran krok-po-kroku |
| **Live cooking** | `live.js` | ✅ timery, SOS help in-step |
| **Onboarding** (4 kroki) | `app.js` | ✅ |
| **Filters panel** | `filters.js` | ✅ czas/kuchnia/dieta/cel |
| **Admin** (`/admin`) | inline HTML | ✅ wymaga `role=admin` |

---

## 5. Co naprawiłem w tej sesji

### Bugi krytyczne
1. **Walka o PRO:** `is_pro()` ignorował `role` field — sprawdzał tylko `subscription_status`. Teraz uwzględnia role `pro/admin/premium` (`@culinary_assistant.py:4098-4113`)
2. **Endpoint `/admin`:** użytkownicy z poprawną rolą w bazie nie mieli dostępu (przez bug #1). Naprawione.
3. **Język w przepisach (chicken-and-egg dla nowych userów):**
   - `assistant.ask()` nie miał `lang` parameter — nie wstrzykiwał `get_lang_instruction()`
   - `assistant.generate_recipe()` używał pustego system promptu w obu krokach (planner + executor)
   - `assistant.proposals()` miał tylko angielski prompt + brak instrukcji wyjściowej
   - **Wszystkie naprawione** — każdy endpoint czyta `lang` z body/profilu/`pl` fallback i wstrzykuje instrukcję
4. **Chat scrollowanie:** `.app{min-height:100dvh}` pozwalał kontenerowi rosnąć ponad viewport, więc `.messages` nigdy nie scrollowała wewnętrznie. Zmienione na `height:100dvh; overflow:hidden`. Każdy `.view.active` ma teraz `flex:1; min-height:0; overflow-y:auto`, oprócz chatu który ma własny scroller.

### Refaktory
5. **Quick flow** — przepisany od zera. Backend: AI generuje 8 dań per (kategoria × czas × profil) z cache, zamiast 3 sztywnych pozycji. Frontend: loading state, opisy-hooki, event delegation (koniec z bugami przy nazwach z apostrofami).
6. **Smart auto-scroll w chacie:** auto-scroll tylko gdy user blisko dołu; w przeciwnym razie pokazuje pill **"↓ Nowa wiadomość"** żeby nie wyrywać z czytania.
7. **Welcome message** skrócony we wszystkich 5 językach z 3-paragrafowej tirady do jednej linii.

---

## 6. Stan bezpieczeństwa

### ✅ Dobre
- Wszystkie wrażliwe endpointy mają `@require_auth`
- Admin endpointy mają `@admin_required` (sprawdza `role=admin` z DB)
- Stripe webhook weryfikuje signature
- Bany składników wymuszane post-LLM przez `enforce_bans()`
- Profile cache ma TTL (60s) — minimalne ryzyko stale data

### ⚠️ Do uwagi
- **`/api/debug/grant-pro` i `/api/debug/me`** — nadają role admin każdemu zalogowanemu. Należy **usunąć przed produkcją** (lub osłonić env-flag `ENABLE_DEBUG=true`).
- `_quick_cache`, `_plan_cache`, `_recipe_cache` rosną w nieskończoność (brak eviction) — przy long-running serverze może być wyciek pamięci. **TODO:** LRU z limitem.
- `_profile_cache` w pamięci procesu — przy multi-worker setup (gunicorn) cache nie jest spójny między workerami.
- `prompt_test.py`, `test_groq*.py`, `test_compare.py`, `test_rag.py` zostawione w repo — OK lokalnie, ale do wykluczenia z deploya.

---

## 7. Wydajność

### ✅ Optymalizacje obecne
- Layer-specific RAG queries równolegle (`parallel_search()`)
- Cache planu i przepisu na MD5 hashu
- Profile cache (60s TTL)
- Streaming SSE — natychmiastowy feedback
- Aggressive context trimming (`trim_context()` z limitami per warstwa)
- `is_simple_query()` aktywuje fast mode (krótszy prompt, mniej max_tokens)

### ⚠️ Bottlenecki / TODO
- Quick flow generuje 8 dań przez LLM (~2-4s) — UX dobry dzięki loading state, ale można rozważyć pre-computed cache popularnych kombinacji
- Brak rate limiting na poziomie aplikacji (poza `daily_limits` per user)
- ChromaDB w lokalnym pliku — przy >100k chunków rozważyć Qdrant/pgvector

---

## 8. Internacjonalizacja (i18n)

- 5 języków: **pl** (domyślny), **en**, **de**, **es**, **fr**
- Frontend: `i18n.js` z `t(key, params)` + `data-i18n="key"` + `data-i18n-placeholder="key"`
- Backend: `get_lang_instruction(lang)` wstrzykiwany do **każdego** prompta LLM
- **Stan:** ✅ Po dzisiejszym fixie wszystkie endpointy AI uwzględniają `lang` (request body → profile.lang → "pl")

---

## 9. PWA / Mobile

- ✅ `manifest.json`, `sw.js` (offline assets)
- ✅ `apple-mobile-web-app-capable`, theme-color, viewport meta
- ✅ Sticky input area, smart scroll, touch-friendly
- ✅ Responsywne `100dvh` (dynamic viewport height — uwzględnia mobile address bar)
- ⚠️ Brak push notifications (placeholder w SW)

---

## 10. Pliki / dane

| Plik / Folder | Zawartość | Rola |
|---|---|---|
| `culinary_assistant.py` | 5970 linii | Cały backend (monolith) |
| `Smak/`, `Techniki/`, `Wypieki/`, `Kompozycja/`, `Procedury/` | MD/TXT z wiedzą kulinarną | Korpus RAG |
| `Dane/` | JSON-y (klasyki, kategorie, etc.) | Statyczne dane do flow |
| `chroma_db/` | ChromaDB persistent | Generowany z korpusu |
| `migrations/` | SQL migrations | Supabase schema |
| `static/` | Frontend SPA | UI |
| `.env` | Klucze (Supabase, Groq, Stripe) | **Nie commitować** |
| `server.log` | Logi runtime | Debug — duży, `.gitignore` |

---

## 11. Rekomendacje (priorytet malejący)

### 🔴 Wysoki
1. **Usuń lub zabezpiecz `/api/debug/*` przed produkcją** — obecnie każdy zalogowany może nadać sobie admin
2. **LRU cap** na `_quick_cache`, `_plan_cache`, `_recipe_cache` (np. `functools.lru_cache` lub `cachetools.LRUCache(maxsize=500)`)
3. **Rate limiting** (`flask-limiter`) na endpointach AI — chroni przed abusem i kosztami LLM

### 🟡 Średni
4. Rozbij `culinary_assistant.py` na moduły — 5970 linii utrudnia utrzymanie
5. Dodaj **healthchecks deployment** (Docker `HEALTHCHECK`)
6. Migracja `_profile_cache` do Redis — wymóg multi-worker setupu
7. Pre-compute popularne kombinacje Quick (cache na poziomie startupu)
8. Dodaj **testy integracyjne** dla 4-warstwowego pipeline (obecnie tylko `test_rag.py`, `test_groq.py`)

### 🟢 Niski
9. Push notifications (PWA)
10. Dark mode toggle (obecnie tylko dark)
11. Eksport przepisu do PDF
12. Historia z search/filter
13. Social — public recipe gallery
14. Admin: dashboard kosztów LLM (per user / per day)

---

## 12. Podsumowanie

**Aplikacja jest w stanie produkcyjnym (z drobnym sprzątaniem przed deployem).** Pełny stack działa: auth (Supabase), płatności (Stripe), AI (Groq + RAG ChromaDB), 5-językowy UI, PWA, admin panel, planner, training. Po dzisiejszej sesji rozwiązane zostały:

- ✅ Bug PRO/admin role detection
- ✅ Generowanie po angielsku dla nowych userów (3 endpointy AI naprawione)
- ✅ Chat scrolling (smart auto-scroll z pill)
- ✅ Quick flow przepisany na AI z cache
- ✅ Welcome message skrócony

**Przed deployem wymagane:**
1. Usuń `/api/debug/grant-pro` i `/api/debug/me`
2. Dodaj LRU cap do trzech cache'y in-memory
3. Skonfiguruj rate limiting na `/api/ask*`, `/api/proposals`, `/api/recipes/*`

**Kod jest spójny, dobrze udokumentowany komentarzami sekcyjnymi (`─── X ───`), używa cache i parallelism gdzie warto.** Główny dług techniczny to monolityczny rozmiar `culinary_assistant.py` — refaktor na pakiet (`/routes`, `/services`, `/models`) zalecany w średnim horyzoncie.
