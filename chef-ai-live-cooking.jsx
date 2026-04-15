import { useState, useEffect, useRef, useCallback } from "react";

// ─── TOKENS ───────────────────────────────────────────
const T = {
  bg: "#09090B",
  card: "rgba(255,255,255,0.03)",
  glass: "rgba(255,255,255,0.04)",
  glassBorder: "rgba(255,255,255,0.06)",
  surface: "rgba(255,255,255,0.06)",
  gold: "#E2B44F",
  goldLight: "#F0D078",
  goldDim: "rgba(226,180,79,0.10)",
  goldGlow: "rgba(226,180,79,0.20)",
  goldBorder: "rgba(226,180,79,0.25)",
  emerald: "#34D399",
  emeraldDim: "rgba(52,211,153,0.10)",
  coral: "#F87171",
  coralDim: "rgba(248,113,113,0.10)",
  text: "#FAFAF9",
  textSoft: "#A8A29E",
  textMuted: "#57534E",
  border: "rgba(255,255,255,0.06)",
  borderActive: "rgba(255,255,255,0.12)",
};

// ─── RECIPE DATA ──────────────────────────────────────
const steps = [
  {
    n: 1, title: "Sous-vide kurczaka",
    body: "Włóż pierś z kurczaka (300g) do woreczka z pieprzem (3g). Zamknij vacuum sealerem. Ustaw cyrkulator na 60°C, gotuj 60 minut.",
    eq: "sous-vide 60°C · vacuum sealer",
    why: "60°C denaturuje miozynę bez uszkodzenia aktyny — mięso soczyste i miękkie.",
    tip: "Mięso po ugotowaniu jednolicie białe, bez twardych ani surowych fragmentów.",
    timer: 3600,
    ingredients: ["300g pierś z kurczaka", "3g pieprz czarny"],
  },
  {
    n: 2, title: "Marynowanie rzodkiewek",
    body: "W misce wymieszaj ocet ryżowy (20ml), cukier (10g) i sól (3g). Dodaj pokrojone rzodkiewki (50g). Odstaw na 15 minut.",
    eq: "miska · waga kuchenna",
    why: "Kwas i sól szybko zmiękczają rzodkiewkę, cukier równoważy kwasowość.",
    tip: "Rzodkiewki lekko jędrne i kwaśno-słodkie.",
    timer: 900,
    ingredients: ["20ml ocet ryżowy", "10g cukier", "3g sól", "50g rzodkiewki"],
  },
  {
    n: 3, title: "Sos pomarańczowy",
    body: "Sok pomarańczowy (100ml) z cukrem (10g) redukuj na mocy 7 przez 8 min do połowy objętości. Dodaj masło (30g) poza ogniem, mieszaj trzepaczką do emulsji. Dopraw solą (2g).",
    eq: "indukcja 7 · rondelek · trzepaczka",
    why: "Redukcja koncentruje smak, masło poza ogniem emulguje bez rozwarstwiania.",
    tip: "Sos pokrywa łyżkę — konsystencja nappe. Błyszczący, nie matowy.",
    timer: 480,
    ingredients: ["100ml sok pomarańczowy", "10g cukier", "30g masło", "2g sól"],
  },
  {
    n: 4, title: "Searing kurczaka",
    body: "Wyjmij pierś z woreczka, osusz dokładnie ręcznikiem. Na patelni rozgrzanej na mocy 9 smaż 1.5 min z każdej strony do złotej skorupki.",
    eq: "indukcja 9 · patelnia · pirometr",
    why: "Suche mięso + gorąca patelnia = intensywny Maillard bez gotowania na parze.",
    tip: "Skorupka złocista, wnętrze nadal soczyste i białe. Nie smaż dłużej niż 1.5 min/stronę.",
    timer: 180,
    ingredients: [],
  },
  {
    n: 5, title: "Szparagi",
    body: "Szparagi (150g) blanszuj 2 min we wrzącej osolonej wodzie. Szok lodowy. Osusz, podsmaż na maśle (10g) na mocy 6 przez 2 min.",
    eq: "indukcja 6 · patelnia · garnek",
    why: "Blanszowanie + szok = kolor i chrupkość. Masło dodaje aromatu.",
    tip: "Jasnozielone, jędrne, nie gumowate.",
    timer: 240,
    ingredients: ["150g szparagi", "10g masło"],
  },
  {
    n: 6, title: "Podanie",
    body: "Na talerzu ułóż szparagi, obok pokrojony kurczak, polej sosem pomarańczowym. Udekoruj pickled rzodkiewkami i skórką pomarańczową (5g).",
    eq: "talerz · łyżka do sosu",
    why: "Kontrast: kremowe mięso, chrupiące szparagi, kwasowe pickles, słodki sos.",
    tip: "Sos na talerz, nie na mięso — zachowasz chrupkość skorupki.",
    timer: null,
    ingredients: ["5g skórka pomarańczowa"],
  },
];

const recipeName = "Kurczak w sosie pomarańczowym";

// ─── TIMER HOOK ───────────────────────────────────────
function useTimer() {
  const [seconds, setSeconds] = useState(0);
  const [running, setRunning] = useState(false);
  const [initial, setInitial] = useState(0);
  const interval = useRef(null);

  const start = useCallback((duration) => {
    setInitial(duration);
    setSeconds(duration);
    setRunning(true);
  }, []);

  const toggle = useCallback(() => setRunning(r => !r), []);
  const reset = useCallback(() => { setSeconds(initial); setRunning(false); }, [initial]);

  useEffect(() => {
    if (running && seconds > 0) {
      interval.current = setInterval(() => setSeconds(s => s - 1), 1000);
    } else {
      clearInterval(interval.current);
      if (seconds === 0 && running) setRunning(false);
    }
    return () => clearInterval(interval.current);
  }, [running, seconds]);

  const fmt = (s) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };

  const progress = initial > 0 ? (initial - seconds) / initial : 0;
  const done = initial > 0 && seconds === 0 && !running;

  return { seconds, running, progress, done, formatted: fmt(seconds), start, toggle, reset };
}

// ─── CIRCULAR TIMER ───────────────────────────────────
const CircleTimer = ({ progress, formatted, running, done, onToggle, onReset, size = 200 }) => {
  const r = (size - 16) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - progress);

  return (
    <div style={{ position: "relative", width: size, height: size, margin: "0 auto" }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        {/* Track */}
        <circle cx={size/2} cy={size/2} r={r}
          fill="none" stroke={T.surface} strokeWidth="6" />
        {/* Progress */}
        <circle cx={size/2} cy={size/2} r={r}
          fill="none"
          stroke={done ? T.emerald : running ? T.gold : T.textMuted}
          strokeWidth="6"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 1s linear, stroke 0.3s" }}
        />
      </svg>
      {/* Center content */}
      <div style={{
        position: "absolute", inset: 0,
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      }}>
        <span style={{
          fontSize: size > 160 ? 42 : 32,
          fontWeight: 800,
          color: done ? T.emerald : T.text,
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "-0.02em",
          lineHeight: 1,
        }}>{done ? "✓" : formatted}</span>
        {done && (
          <span style={{ fontSize: 13, color: T.emerald, marginTop: 4, fontWeight: 600 }}>
            Gotowe!
          </span>
        )}
        {!done && (
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={onToggle} style={{
              width: 44, height: 44, borderRadius: "50%",
              background: running ? "rgba(255,255,255,0.08)" : `linear-gradient(135deg, ${T.gold}, ${T.goldLight})`,
              border: "none", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: running ? "none" : `0 2px 12px ${T.goldDim}`,
            }}>
              {running ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill={T.text}>
                  <rect x="6" y="4" width="4" height="16" rx="1"/>
                  <rect x="14" y="4" width="4" height="16" rx="1"/>
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill={T.bg}>
                  <polygon points="6,3 20,12 6,21"/>
                </svg>
              )}
            </button>
            {running && (
              <button onClick={onReset} style={{
                width: 44, height: 44, borderRadius: "50%",
                background: "rgba(255,255,255,0.06)", border: "none", cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={T.textMuted} strokeWidth="2" strokeLinecap="round">
                  <path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
                </svg>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

// ─── PROGRESS BAR (top) ───────────────────────────────
const TopProgress = ({ current, total }) => (
  <div style={{
    display: "flex", gap: 3, padding: "0 16px",
    height: 3,
  }}>
    {Array.from({ length: total }, (_, i) => (
      <div key={i} style={{
        flex: 1, borderRadius: 2,
        background: i < current ? T.gold : i === current ? T.goldGlow : T.surface,
        transition: "background 0.3s",
      }}/>
    ))}
  </div>
);

// ─── INGREDIENT CHIP ──────────────────────────────────
const IngChip = ({ text }) => (
  <span style={{
    display: "inline-flex", padding: "4px 10px", borderRadius: 7,
    background: T.glass, border: `1px solid ${T.glassBorder}`,
    fontSize: 12, color: T.textSoft, fontWeight: 500,
    whiteSpace: "nowrap",
  }}>{text}</span>
);

// ─── MAIN APP ─────────────────────────────────────────
export default function LiveCooking() {
  const [step, setStep] = useState(0);
  const [showWhy, setShowWhy] = useState(false);
  const [showIngredients, setShowIngredients] = useState(false);
  const timer = useTimer();
  const current = steps[step];
  const hasTimer = current.timer !== null;

  // Reset when changing steps
  useEffect(() => {
    setShowWhy(false);
    setShowIngredients(false);
    timer.reset();
  }, [step]);

  const goNext = () => { if (step < steps.length - 1) setStep(step + 1); };
  const goPrev = () => { if (step > 0) setStep(step - 1); };

  return (
    <div style={{
      width: "100%", maxWidth: 430, margin: "0 auto", height: "100vh",
      background: T.bg, display: "flex", flexDirection: "column",
      fontFamily: "'DM Sans', -apple-system, sans-serif",
      color: T.text, position: "relative", overflow: "hidden",
      userSelect: "none", WebkitUserSelect: "none",
    }}>

      {/* ═══ TOP BAR ══════════════════════════ */}
      <div style={{ flexShrink: 0, paddingTop: 8 }}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "8px 16px",
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: 12, color: T.gold, fontWeight: 600,
              letterSpacing: "0.04em", textTransform: "uppercase",
              marginBottom: 2,
            }}>Krok {current.n} z {steps.length}</div>
            <div style={{
              fontSize: 13, color: T.textMuted, fontWeight: 500,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>{recipeName}</div>
          </div>
          <button onClick={() => window.history?.back?.()} style={{
            width: 40, height: 40, borderRadius: 12,
            background: T.surface, border: "none", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={T.textMuted} strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Progress segments */}
        <TopProgress current={step} total={steps.length} />
      </div>

      {/* ═══ MAIN CONTENT (scrollable) ════════ */}
      <div style={{
        flex: 1, overflowY: "auto", overflowX: "hidden",
        WebkitOverflowScrolling: "touch",
        padding: "20px 16px 0",
        display: "flex", flexDirection: "column",
      }}>

        {/* Step number + title */}
        <div style={{ marginBottom: 16 }}>
          <div style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 40, height: 40, borderRadius: 12,
            background: `linear-gradient(135deg, ${T.gold}, ${T.goldLight})`,
            color: T.bg, fontSize: 18, fontWeight: 800,
            boxShadow: `0 4px 16px ${T.goldDim}`,
            marginBottom: 12,
          }}>{current.n}</div>
          <h1 style={{
            fontSize: 24, fontWeight: 800, margin: 0,
            letterSpacing: "-0.03em", lineHeight: 1.2,
          }}>{current.title}</h1>
        </div>

        {/* Instruction — large, readable */}
        <p style={{
          fontSize: 17, color: T.textSoft, lineHeight: 1.65,
          margin: "0 0 16px", fontWeight: 400,
        }}>{current.body}</p>

        {/* Equipment badge */}
        {current.eq && (
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "6px 14px", borderRadius: 9,
            background: T.goldDim, marginBottom: 16,
            fontSize: 13, fontWeight: 600, color: T.gold,
            alignSelf: "flex-start",
          }}>🔥 {current.eq}</div>
        )}

        {/* Ingredients for this step (toggle) */}
        {current.ingredients.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <button onClick={() => setShowIngredients(!showIngredients)} style={{
              display: "flex", alignItems: "center", gap: 6,
              background: "none", border: "none", cursor: "pointer",
              color: T.textMuted, fontSize: 13, fontWeight: 500,
              padding: "4px 0", fontFamily: "inherit",
            }}>
              🧂 Składniki do tego kroku
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke={T.textMuted} strokeWidth="1.5" strokeLinecap="round"
                style={{ transform: showIngredients ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s" }}>
                <polyline points="2,4 6,8 10,4"/>
              </svg>
            </button>
            {showIngredients && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                {current.ingredients.map((ing, i) => <IngChip key={i} text={ing}/>)}
              </div>
            )}
          </div>
        )}

        {/* Why + Tip (toggle) */}
        <button onClick={() => setShowWhy(!showWhy)} style={{
          display: "flex", alignItems: "center", gap: 6,
          background: "none", border: "none", cursor: "pointer",
          color: T.textMuted, fontSize: 13, fontWeight: 500,
          padding: "4px 0", marginBottom: showWhy ? 8 : 16,
          fontFamily: "inherit",
        }}>
          {showWhy ? "Ukryj szczegóły" : "💡 Nauka + wskazówka"}
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke={T.textMuted} strokeWidth="1.5" strokeLinecap="round"
            style={{ transform: showWhy ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s" }}>
            <polyline points="2,4 6,8 10,4"/>
          </svg>
        </button>
        {showWhy && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
            <div style={{
              borderLeft: `2px solid ${T.goldBorder}`, paddingLeft: 12,
              fontSize: 14, color: T.textMuted, lineHeight: 1.6,
            }}>{current.why}</div>
            <div style={{
              fontSize: 14, color: T.emerald, lineHeight: 1.6,
              background: T.emeraldDim, padding: "10px 14px", borderRadius: 10,
            }}>💡 {current.tip}</div>
          </div>
        )}

        {/* ─── TIMER ─────────────────────── */}
        {hasTimer && (
          <div style={{
            flex: 1, display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            minHeight: 240, padding: "10px 0",
          }}>
            {timer.seconds === 0 && !timer.done ? (
              /* Timer not started — show big start button */
              <button onClick={() => timer.start(current.timer)} style={{
                width: 180, height: 180, borderRadius: "50%",
                background: `linear-gradient(135deg, ${T.gold}, ${T.goldLight})`,
                border: "none", cursor: "pointer",
                display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center",
                boxShadow: `0 8px 40px ${T.goldGlow}`,
                transition: "transform 0.15s",
              }}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill={T.bg} style={{ marginBottom: 8 }}>
                  <polygon points="6,3 20,12 6,21"/>
                </svg>
                <span style={{ fontSize: 14, fontWeight: 700, color: T.bg, letterSpacing: "0.02em" }}>
                  START
                </span>
                <span style={{
                  fontSize: 20, fontWeight: 800, color: T.bg, marginTop: 2,
                  fontVariantNumeric: "tabular-nums",
                }}>
                  {Math.floor(current.timer / 60)}:{String(current.timer % 60).padStart(2, "0")}
                </span>
              </button>
            ) : (
              /* Timer running/paused/done — show circle */
              <CircleTimer
                progress={timer.progress}
                formatted={timer.formatted}
                running={timer.running}
                done={timer.done}
                onToggle={timer.toggle}
                onReset={timer.reset}
                size={210}
              />
            )}
          </div>
        )}

        {/* Spacer */}
        <div style={{ height: 100 }}/>
      </div>

      {/* ═══ BOTTOM NAV ═══════════════════════ */}
      <div style={{
        position: "absolute", bottom: 0, left: 0, right: 0,
        background: `linear-gradient(transparent, ${T.bg} 25%)`,
        padding: "30px 16px 16px",
      }}>
        {/* SOS button */}
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
          <button style={{
            padding: "6px 16px", borderRadius: 20,
            background: T.coralDim, border: `1px solid rgba(248,113,113,0.15)`,
            color: T.coral, fontSize: 12, fontWeight: 700,
            cursor: "pointer", letterSpacing: "0.03em",
          }}>🆘 Pomoc z tym krokiem</button>
        </div>

        {/* Nav buttons */}
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={goPrev} disabled={step === 0} style={{
            flex: 1, height: 54, borderRadius: 14,
            background: T.glass, border: `1px solid ${T.glassBorder}`,
            color: step === 0 ? T.textMuted : T.textSoft,
            fontSize: 15, fontWeight: 600, cursor: step === 0 ? "default" : "pointer",
            opacity: step === 0 ? 0.4 : 1,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            fontFamily: "inherit",
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            Wstecz
          </button>

          <button onClick={goNext} disabled={step === steps.length - 1} style={{
            flex: 2, height: 54, borderRadius: 14,
            background: step === steps.length - 1
              ? `linear-gradient(135deg, ${T.emerald}, #6EE7B7)`
              : `linear-gradient(135deg, ${T.gold}, ${T.goldLight})`,
            border: "none",
            color: T.bg, fontSize: 15, fontWeight: 700, cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            boxShadow: `0 4px 20px ${step === steps.length - 1 ? T.emeraldDim : T.goldDim}`,
            fontFamily: "inherit",
            letterSpacing: "-0.01em",
          }}>
            {step === steps.length - 1 ? (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={T.bg} strokeWidth="2.5" strokeLinecap="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                Gotowe!
              </>
            ) : (
              <>
                Dalej
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <polyline points="9 18 15 12 9 6"/>
                </svg>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
