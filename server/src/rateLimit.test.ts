import { describe, expect, it } from "vitest";
import { checkRateLimit, type RateLimitState } from "../../shared/src/rateLimit.ts";

const T0 = 1_000_000;
const CONFIG = { limit: 3, windowMs: 10_000 };

describe("checkRateLimit", () => {
  it("a brand new key (null state) is allowed and starts a fresh window", () => {
    const result = checkRateLimit(null, CONFIG, T0);
    expect(result).toEqual({ allowed: true, state: { windowStartMs: T0, count: 1 } });
  });

  it("allows up to the configured limit within one window", () => {
    let state: RateLimitState | null = null;
    for (let i = 0; i < CONFIG.limit; i++) {
      const result = checkRateLimit(state, CONFIG, T0);
      expect(result.allowed).toBe(true);
      state = result.state;
    }
    expect(state).toEqual({ windowStartMs: T0, count: CONFIG.limit });
  });

  it("rejects the call that would exceed the limit, without bumping count further", () => {
    let state: RateLimitState = { windowStartMs: T0, count: CONFIG.limit };
    const result = checkRateLimit(state, CONFIG, T0 + 1);
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.state).toEqual(state);
    expect(result.retryAfterMs).toBe(CONFIG.windowMs - 1);
  });

  it("a window that has fully elapsed resets the count, even if it was previously maxed", () => {
    const state: RateLimitState = { windowStartMs: T0, count: CONFIG.limit };
    const result = checkRateLimit(state, CONFIG, T0 + CONFIG.windowMs);
    expect(result).toEqual({ allowed: true, state: { windowStartMs: T0 + CONFIG.windowMs, count: 1 } });
  });

  it("a window one ms short of elapsing is still the same window", () => {
    const state: RateLimitState = { windowStartMs: T0, count: CONFIG.limit };
    const result = checkRateLimit(state, CONFIG, T0 + CONFIG.windowMs - 1);
    expect(result.allowed).toBe(false);
  });

  it("never mutates the state object passed in", () => {
    const state: RateLimitState = { windowStartMs: T0, count: 1 };
    const snapshot = { ...state };
    checkRateLimit(state, CONFIG, T0 + 1);
    expect(state).toEqual(snapshot);
  });
});
