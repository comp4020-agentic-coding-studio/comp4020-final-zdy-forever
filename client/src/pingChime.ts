// A short, bright notification sound played whenever a ping-wheel signal
// arrives (see usePlaybackSync.ts's "ping:new" handler) — everyone in the
// room hears it, not just the sender, mirroring how a League of Legends ping
// sounds for the whole team. Generated with the Web Audio API, in the same
// style as voteChime.ts, rather than shipping an audio asset — this project
// can only use sounds it synthesizes itself, not a game's actual audio.
//
// The AudioContext is created lazily, on the first call, and reused after
// that — browsers refuse to start one before a user gesture, but by the time
// a ping can arrive the user has already clicked into a room.
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
  oscillator.type = "triangle";
  oscillator.frequency.value = frequencyHz;
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(0.22, startAt + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationSec);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + durationSec + 0.02);
}

// A quick rising two-note "ping" — distinct from playVoteChime's two-tone
// vote announcement so the two are never confused by ear.
export function playPingChime(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    playTone(ctx, 0, 1046, 90);
    playTone(ctx, 70, 1568, 140);
  } catch {
    // Audio is a nicety, never allowed to break the signal it's announcing.
  }
}
