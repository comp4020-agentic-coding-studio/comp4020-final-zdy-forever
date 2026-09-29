import { describe, expect, it } from "vitest";
import {
  computeReorderTokenBalance,
  initialReorderTokenState,
  MAX_REORDER_TOKENS,
  REORDER_TOKEN_REGEN_INTERVAL_MS,
  spendReorderToken,
  type ReorderTokenState,
} from "../../shared/src/reorderTokens.ts";

const T0 = 1_000_000;

describe("initialReorderTokenState", () => {
  it("a fresh account/room pair starts at 5, anchored at nowMs", () => {
    expect(initialReorderTokenState(T0)).toEqual({ tokens: 5, anchorMs: T0 });
    expect(initialReorderTokenState(T0).tokens).toBe(MAX_REORDER_TOKENS);
  });
});

describe("computeReorderTokenBalance", () => {
  it("no time elapsed at all: balance unchanged", () => {
    const state: ReorderTokenState = { tokens: 3, anchorMs: T0 };
    expect(computeReorderTokenBalance(state, T0)).toEqual(state);
  });

  it("less than a full interval elapsed: no token yet, anchor unchanged", () => {
    const state: ReorderTokenState = { tokens: 3, anchorMs: T0 };
    const result = computeReorderTokenBalance(state, T0 + REORDER_TOKEN_REGEN_INTERVAL_MS - 1);
    expect(result).toEqual(state);
  });

  it("+1 after exactly 5 minutes", () => {
    const state: ReorderTokenState = { tokens: 3, anchorMs: T0 };
    const result = computeReorderTokenBalance(state, T0 + REORDER_TOKEN_REGEN_INTERVAL_MS);
    expect(result.tokens).toBe(4);
    // The anchor advances by exactly the interval consumed, not to nowMs —
    // any (impossible, here zero) remainder must stay live for the next tick.
    expect(result.anchorMs).toBe(T0 + REORDER_TOKEN_REGEN_INTERVAL_MS);
  });

  it("multiple whole intervals grant multiple tokens in one recomputation", () => {
    const state: ReorderTokenState = { tokens: 0, anchorMs: T0 };
    const threeIntervals = T0 + 3 * REORDER_TOKEN_REGEN_INTERVAL_MS;
    const result = computeReorderTokenBalance(state, threeIntervals);
    expect(result.tokens).toBe(3);
    expect(result.anchorMs).toBe(threeIntervals);
  });

  it("a partial interval beyond whole ticks is carried forward, not discarded", () => {
    const state: ReorderTokenState = { tokens: 0, anchorMs: T0 };
    const twoIntervalsPlusHalf = T0 + 2 * REORDER_TOKEN_REGEN_INTERVAL_MS + REORDER_TOKEN_REGEN_INTERVAL_MS / 2;
    const result = computeReorderTokenBalance(state, twoIntervalsPlusHalf);
    expect(result.tokens).toBe(2);
    // Anchor only moves by the two whole intervals consumed — the remaining
    // half-interval is still live, counting toward the next tick.
    expect(result.anchorMs).toBe(T0 + 2 * REORDER_TOKEN_REGEN_INTERVAL_MS);
  });

  it("never regenerates past the cap of 5, however much time elapses", () => {
    const state: ReorderTokenState = { tokens: 4, anchorMs: T0 };
    const farFuture = T0 + 100 * REORDER_TOKEN_REGEN_INTERVAL_MS;
    const result = computeReorderTokenBalance(state, farFuture);
    expect(result.tokens).toBe(MAX_REORDER_TOKENS);
    // Capped: the anchor jumps to nowMs rather than banking unusable ticks.
    expect(result.anchorMs).toBe(farFuture);
  });

  it("already at the cap: anchor tracks nowMs forward with no ticks needed", () => {
    const state: ReorderTokenState = { tokens: MAX_REORDER_TOKENS, anchorMs: T0 };
    const later = T0 + 10 * REORDER_TOKEN_REGEN_INTERVAL_MS;
    expect(computeReorderTokenBalance(state, later)).toEqual({ tokens: MAX_REORDER_TOKENS, anchorMs: later });
  });

  it("is idempotent — recomputing an already-normalized state at the same nowMs changes nothing further", () => {
    const state: ReorderTokenState = { tokens: 2, anchorMs: T0 };
    const nowMs = T0 + 7 * REORDER_TOKEN_REGEN_INTERVAL_MS;
    const once = computeReorderTokenBalance(state, nowMs);
    const twice = computeReorderTokenBalance(once, nowMs);
    expect(twice).toEqual(once);
  });
});

describe("spendReorderToken", () => {
  it("spends one token from a full balance", () => {
    const state = initialReorderTokenState(T0);
    const result = spendReorderToken(state, T0);
    expect(result).toEqual({ ok: true, state: { tokens: 4, anchorMs: T0 } });
  });

  it("normalizes regen before evaluating the spend — a long-idle account earns its tokens back first", () => {
    const state: ReorderTokenState = { tokens: 0, anchorMs: T0 };
    const nowMs = T0 + 2 * REORDER_TOKEN_REGEN_INTERVAL_MS;
    const result = spendReorderToken(state, nowMs);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // Earned 2 back, spent 1: 1 remains.
    expect(result.state.tokens).toBe(1);
    expect(result.state.anchorMs).toBe(nowMs);
  });

  it("fails without changing anything when the normalized balance is already zero", () => {
    const state: ReorderTokenState = { tokens: 0, anchorMs: T0 };
    const nowMs = T0 + REORDER_TOKEN_REGEN_INTERVAL_MS - 1; // not even one tick yet
    const result = spendReorderToken(state, nowMs);
    expect(result).toEqual({ ok: false, state: { tokens: 0, anchorMs: T0 } });
  });

  it("spending down to zero, then spending again immediately fails", () => {
    let state = initialReorderTokenState(T0);
    for (let i = 0; i < MAX_REORDER_TOKENS; i++) {
      const result = spendReorderToken(state, T0);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      state = result.state;
    }
    expect(state.tokens).toBe(0);

    const final = spendReorderToken(state, T0);
    expect(final.ok).toBe(false);
  });
});
