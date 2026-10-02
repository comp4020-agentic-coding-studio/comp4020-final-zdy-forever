// A short two-tone "ding" played when a new vote opens in the room (see
// usePlaybackSync.ts's proposal:update handler) — generated with the Web
// Audio API rather than shipping an audio asset, to keep this to a single
// small, dependency-free file.
//
// The AudioContext is created lazily, on the first call, and reused after
// that: browsers refuse to start one before any user gesture, but by the
// time a vote can open the player is already in a room the user clicked
// into, so a gesture has always already happened.
let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioContext) audioContext = new Ctor();
  if (audioContext.state === "suspended") void audioContext.resume();
  return audioContext;
}

function playTone(ctx: AudioContext, startMs: number, frequencyHz: number, durationMs: number): void {
  const startAt = ctx.currentTime + startMs / 1000;
  const durationSec = durationMs / 1000;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = frequencyHz;
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(0.2, startAt + 0.01);
  gain.gain.linearRampToValueAtTime(0, startAt + durationSec);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + durationSec + 0.02);
}

// Called once per newly-opened proposal (never for a resolved one, and never
// just because its vote tally changed) — see the isNewProposal check at the
// call site.
export function playVoteChime(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    playTone(ctx, 0, 880, 120);
    playTone(ctx, 110, 1175, 150);
  } catch {
    // Audio is a nicety, never allowed to break the vote it's announcing.
  }
}
