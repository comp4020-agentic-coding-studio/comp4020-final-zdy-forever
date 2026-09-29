import type { DatabaseSync } from "node:sqlite";
import {
  computeReorderTokenBalance,
  initialReorderTokenState,
  MAX_REORDER_TOKENS,
  REORDER_TOKEN_REGEN_INTERVAL_MS,
  spendReorderToken,
  type ReorderTokenState,
} from "../../shared/src/reorderTokens.ts";
import type { ReorderTokenBalance } from "../../shared/src/types.ts";

// Persists reorder-token accounting (see shared/src/reorderTokens.ts for the
// pure regeneration math this wraps) per docs/adr/0001-reorder-token-scope.md:
// balances are scoped per (roomId, accountId), not per account globally.
// Drag-and-drop reordering and REORDER_QUEUE voting are not wired up yet —
// this module only exposes "what's the current balance" and "spend one,"
// for a future REORDER_QUEUE resolution path to call.

function getRawState(db: DatabaseSync, roomId: string, accountId: string): ReorderTokenState | undefined {
  const row = db
    .prepare("SELECT tokens, anchorMs FROM reorder_tokens WHERE roomId = ? AND accountId = ?")
    .get(roomId, accountId) as { tokens: number; anchorMs: number } | undefined;
  return row ? { tokens: row.tokens, anchorMs: row.anchorMs } : undefined;
}

function toBalance(roomId: string, accountId: string, state: ReorderTokenState): ReorderTokenBalance {
  return {
    roomId,
    accountId,
    tokens: state.tokens,
    maxTokens: MAX_REORDER_TOKENS,
    nextRegenAt:
      state.tokens >= MAX_REORDER_TOKENS
        ? null
        : new Date(state.anchorMs + REORDER_TOKEN_REGEN_INTERVAL_MS).toISOString(),
  };
}

// Server-authoritative balance query: recomputes from whatever (tokens,
// anchorMs) pair is persisted — or the fresh-account default (full, anchored
// at nowMs) if this account has never touched a token in this room — against
// `nowMs`. Read-only: checking a balance can never itself be the thing that
// advances a stored row (only consumeReorderToken ever writes), so calling
// this repeatedly is always safe and side-effect-free.
export function getReorderTokenBalance(
  db: DatabaseSync,
  roomId: string,
  accountId: string,
  nowMs: number = Date.now(),
): ReorderTokenBalance {
  const raw = getRawState(db, roomId, accountId) ?? initialReorderTokenState(nowMs);
  const normalized = computeReorderTokenBalance(raw, nowMs);
  return toBalance(roomId, accountId, normalized);
}

export type ConsumeReorderTokenResult =
  | { ok: true; balance: ReorderTokenBalance }
  | { ok: false; balance: ReorderTokenBalance };

// The only path that ever persists reorder-token state. Per CLAUDE.md,
// "consume one token only after a reorder vote passes and a real reorder
// succeeds" — so the (not yet implemented) REORDER_QUEUE resolution path
// must call this only once its own vote and mutation have both already
// succeeded, never speculatively up front. A failed attempt (ok: false, no
// tokens available) writes nothing at all — "failed, stale or no-op reorder
// attempts cost nothing" holds literally, not just in the returned balance.
export function consumeReorderToken(
  db: DatabaseSync,
  roomId: string,
  accountId: string,
  nowMs: number = Date.now(),
): ConsumeReorderTokenResult {
  const raw = getRawState(db, roomId, accountId) ?? initialReorderTokenState(nowMs);
  const result = spendReorderToken(raw, nowMs);
  if (!result.ok) {
    return { ok: false, balance: toBalance(roomId, accountId, result.state) };
  }

  db.prepare(
    `INSERT INTO reorder_tokens (roomId, accountId, tokens, anchorMs)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(roomId, accountId) DO UPDATE SET
       tokens = excluded.tokens,
       anchorMs = excluded.anchorMs`,
  ).run(roomId, accountId, result.state.tokens, result.state.anchorMs);

  return { ok: true, balance: toBalance(roomId, accountId, result.state) };
}
