import JSConfetti from "js-confetti";

// A small left-click burst at the cursor, site-wide — purely cosmetic and
// purely client-local (never synced to a room, never persisted, and never
// seen/heard by anyone else — unlike the ping wheel's broadcast signal,
// nothing here ever reaches a socket). js-confetti creates its own
// full-viewport canvas (position: fixed, pointer-events: none, z-index: 1000
// — see its dist/es/index.js), so it never blocks a click and needs no CSS
// of its own here.
//
// Constructed lazily, once, on first use — js-confetti's own docs warn its
// constructor "creates HTML Canvas element and adds it to page, so call it
// only once!" — the same lazy-singleton shape voteChime.ts/pingChime.ts use
// for their own AudioContext below.
let confetti: JSConfetti | null = null;

function getConfetti(): JSConfetti | null {
  if (typeof window === "undefined") return null;
  if (!confetti) confetti = new JSConfetti();
  return confetti;
}

// A quiet "pop" alongside the confetti burst — purely local (see above),
// generated with the Web Audio API in the same style as voteChime.ts/
// pingChime.ts rather than shipping an audio asset. Kept short and soft
// since, unlike those two (a handful of times per vote/signal), this fires
// on every single click: anything louder or longer would wear thin fast.
let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioContext) audioContext = new Ctor();
  if (audioContext.state === "suspended") void audioContext.resume();
  return audioContext;
}

// A little pitch jitter per click so a rapid burst of clicks doesn't sound
// like a mechanical, identical repeat — purely cosmetic variety.
function playClickPop(ctx: AudioContext, nowMs: number): void {
  const startAt = ctx.currentTime;
  const frequencyHz = 700 + ((nowMs * 37) % 200);
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequencyHz, startAt);
  oscillator.frequency.exponentialRampToValueAtTime(frequencyHz * 0.6, startAt + 0.05);
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(0.1, startAt + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.06);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + 0.08);
}

// Matches the candy palette already defined in client/src/index.css
// (--candy-pink, --candy-yellow, --candy-green, --candy-blue, --candy-purple,
// --candy-orange) plus a handful of themed emoji.
const CONFETTI_COLORS = ["#ff5ca8", "#ffd23f", "#2fd699", "#38bdf8", "#a78bfa", "#ff9a3c"];
const CONFETTI_EMOJIS = ["🎉", "✨", "💖", "🌈", "🍬", "⭐️", "🧁"];

// This fires on every single left-click, not a rare celebration, so each
// burst stays small — the library's own demo default (500 pieces) would
// flood the screen at this frequency.
const CONFETTI_NUMBER = 8;

// Guards a double-click / rapid-fire burst from piling up two bursts on top
// of each other; a module-level timestamp, not component state, since this
// has nothing to do with React's render cycle.
const MIN_INTERVAL_MS = 60;
let lastFiredAt = 0;

// Fires a small confetti burst (plus its matching pop sound) at the given
// viewport coordinates (e.g. a click event's clientX/clientY). Both are a
// nicety, never allowed to break the click they're decorating, so any
// failure in either is swallowed independently of the other.
export function fireConfettiAt(x: number, y: number, nowMs: number = Date.now()): void {
  if (nowMs - lastFiredAt < MIN_INTERVAL_MS) return;
  lastFiredAt = nowMs;

  const instance = getConfetti();
  if (instance) {
    try {
      void instance.addConfettiAtPosition({
        confettiDispatchPosition: { x, y },
        confettiNumber: CONFETTI_NUMBER,
        confettiColors: CONFETTI_COLORS,
        emojis: CONFETTI_EMOJIS,
      });
    } catch {
      // Never allowed to break the click it's decorating.
    }
  }

  const ctx = getAudioContext();
  if (ctx) {
    try {
      playClickPop(ctx, nowMs);
    } catch {
      // Never allowed to break the click it's decorating.
    }
  }
}
