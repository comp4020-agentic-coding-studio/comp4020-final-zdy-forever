// Pure, framework-free reorder-token accounting shared between server and
// client (CLAUDE.md's Reorder section: 5 starting/max tokens, +1 every 5
// minutes, computed from timestamps rather than an in-memory repeating
// timer). Like shared/src/voting.ts, every function here does ms arithmetic
// against a caller-supplied `nowMs` and never reads the clock itself, so the
// whole engine stays a pure state machine and is trivially testable without
// fake timers — a test just picks whatever nowMs it wants.
//
// This module only models "does this account currently have a token, and
// when does its next one arrive," independent of how a token gets spent (a
// passed REORDER_QUEUE vote — see server/src/proposals.ts).

export const MAX_REORDER_TOKENS = 5;

export const REORDER_TOKEN_REGEN_INTERVAL_MS = 5 * 60 * 1000;

// tokens is this account's balance as of anchorMs — never a live "now"
// value. Recomputing toward any later nowMs always starts from this pair
// (see computeReorderTokenBalance), the same way room_playback's
// anchorPositionMs/anchorServerTimeMs let a client derive expected position
// without the server ever polling a timer.
export interface ReorderTokenState {
  tokens: number;
  anchorMs: number;
}

// The state a brand-new (never-touched) account/room pair starts at: full,
// anchored at whatever moment it's first observed.
export function initialReorderTokenState(nowMs: number): ReorderTokenState {
  return { tokens: MAX_REORDER_TOKENS, anchorMs: nowMs };
}

// Normalizes `state` forward to `nowMs`: applies as many whole
// REORDER_TOKEN_REGEN_INTERVAL_MS ticks as have elapsed since anchorMs,
// capped at MAX_REORDER_TOKENS, carrying forward only the sub-interval
// remainder toward the next tick (regeneration is quantized — a partial
// interval is never a partial token). Once already at the cap there is
// nothing left to bank: the anchor jumps straight to nowMs, so that if this
// account spends a token much later, its regen clock starts counting from
// the moment it actually spent, not from however long ago it happened to
// last hit the cap.
export function computeReorderTokenBalance(state: ReorderTokenState, nowMs: number): ReorderTokenState {
  if (state.tokens >= MAX_REORDER_TOKENS) {
    return { tokens: MAX_REORDER_TOKENS, anchorMs: nowMs };
  }

  const elapsedMs = Math.max(0, nowMs - state.anchorMs);
  const ticks = Math.floor(elapsedMs / REORDER_TOKEN_REGEN_INTERVAL_MS);
  if (ticks <= 0) {
    return state;
  }

  const tokens = Math.min(MAX_REORDER_TOKENS, state.tokens + ticks);
  if (tokens >= MAX_REORDER_TOKENS) {
    return { tokens: MAX_REORDER_TOKENS, anchorMs: nowMs };
  }
  // Only the whole intervals actually consumed advance the anchor — the
  // remainder (elapsedMs % REORDER_TOKEN_REGEN_INTERVAL_MS) stays live,
  // still counting toward the next tick.
  return { tokens, anchorMs: state.anchorMs + ticks * REORDER_TOKEN_REGEN_INTERVAL_MS };
}

export type SpendReorderTokenResult =
  | { ok: true; state: ReorderTokenState }
  | { ok: false; state: ReorderTokenState };

// Spends one token, first normalizing `state` to `nowMs` so a long-idle
// account gets any regen it's earned before the spend is evaluated. Fails
// (ok: false) without changing anything if the normalized balance is
// already zero — per CLAUDE.md, "failed, stale or no-op reorder attempts
// cost nothing," so a caller must never persist state from a failed result.
export function spendReorderToken(state: ReorderTokenState, nowMs: number): SpendReorderTokenResult {
  const normalized = computeReorderTokenBalance(state, nowMs);
  if (normalized.tokens < 1) {
    return { ok: false, state: normalized };
  }
  return { ok: true, state: { tokens: normalized.tokens - 1, anchorMs: normalized.anchorMs } };
}
