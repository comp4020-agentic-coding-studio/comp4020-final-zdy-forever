// Pure, framework-free playback synchronization logic shared between the
// server (which owns the authoritative anchor) and the client (which uses
// these same functions to calculate its expected position and decide
// whether/how to correct local drift). None of this touches the network,
// Socket.IO, or the YouTube IFrame API — see server/src/playback.ts for the
// authoritative anchor state machine and client/src for the IFrame-facing
// glue that calls into this file.

import type { PlaybackState, PlaybackStatus } from "./types.ts";

export interface PlaybackAnchor {
  status: PlaybackStatus;
  anchorPositionMs: number;
  anchorServerTimeMs: number;
}

// The position a client should expect the video to be at right now, given
// the authoritative anchor and the current time (in the same clock as
// anchorServerTimeMs — i.e. server time; a client folds its clock offset in
// before calling this, see the design notes in CLAUDE.md's Playback sync
// section). PAUSED never advances, regardless of how much time has passed.
// A negative elapsed value (nowMs earlier than the anchor's own timestamp —
// e.g. a slightly out-of-order event, or clock skew) is clamped to zero
// rather than allowed to run the position backwards.
export function computeExpectedPositionMs(anchor: PlaybackAnchor, nowMs: number): number {
  if (anchor.status !== "PLAYING") {
    return anchor.anchorPositionMs;
  }
  const elapsedMs = Math.max(0, nowMs - anchor.anchorServerTimeMs);
  return anchor.anchorPositionMs + elapsedMs;
}

// Below this, drift is ignored outright: ordinary decode/network jitter,
// not worth a visible correction.
export const DRIFT_IGNORE_MS = 1000;

// At or above this, the player is treated as too far gone for a plain seek
// to feel like "catching up" rather than "broken" — reload the video before
// seeking. Chosen to comfortably exceed anything a brief buffering stall or
// normal jitter would produce, while still catching a backgrounded-tab-style
// stall quickly once the tab is foregrounded again.
export const DRIFT_HARD_RESYNC_MS = 5000;

export type DriftCorrection = "none" | "seek" | "hard-resync";

// actualMs is what the local player reports (e.g. getCurrentTime() * 1000);
// expectedMs is computeExpectedPositionMs's result. Only meaningful while
// status is PLAYING and the local player is actually in a PLAYING state —
// callers must not invoke this during PAUSED, buffering, ads, or the brief
// grace period right after receiving a fresh anchor (see client/src for
// where those checks live; this function only classifies a given gap).
export function classifyDrift(actualMs: number, expectedMs: number): DriftCorrection {
  const driftMs = Math.abs(actualMs - expectedMs);
  if (driftMs < DRIFT_IGNORE_MS) return "none";
  if (driftMs < DRIFT_HARD_RESYNC_MS) return "seek";
  return "hard-resync";
}

// How far before a track's known end a reported "ended" is still believed. A
// client can legitimately run a few seconds ahead of the anchor before drift
// correction catches it (see DRIFT_HARD_RESYNC_MS), and YouTube reports
// duration to the whole second. Anything earlier is a skip, not an end —
// e.g. someone dragging the visible player's own scrubber to the end — and
// skipping requires a vote (CLAUDE.md's Voting section).
export const TRACK_END_TOLERANCE_MS = 10_000;

// Whether a client's "my player reached the end" can be true, judged from
// the authoritative anchor alone: the room's expected position must be
// within TRACK_END_TOLERANCE_MS of the track's length. A PAUSED room never
// gets there unless it was paused right at the end. With no known duration
// there is nothing to check against, so the report is taken at its word.
export function isPlausibleTrackEnd(state: PlaybackAnchor & { durationMs: number | null }, nowMs: number): boolean {
  if (state.durationMs === null) return true;
  return computeExpectedPositionMs(state, nowMs) >= state.durationMs - TRACK_END_TOLERANCE_MS;
}

export interface StaleCheckRef {
  playbackId: string;
  revision: number;
}

// True if `proposal` (captured when some future voting proposal was opened)
// no longer matches `current` (the authoritative state at the moment that
// proposal would execute) — on either axis. playbackId catches a track
// transition happening mid-proposal; revision catches any other anchor
// rebase (play/pause/seek, or a server-restart recovery) landing first. A
// stale proposal must be rejected outright, never partially applied.
export function isStaleReference(current: StaleCheckRef, proposal: StaleCheckRef): boolean {
  return current.playbackId !== proposal.playbackId || current.revision !== proposal.revision;
}

export function toAnchor(state: PlaybackState): PlaybackAnchor {
  return {
    status: state.status,
    anchorPositionMs: state.anchorPositionMs,
    anchorServerTimeMs: state.anchorServerTimeMs,
  };
}
