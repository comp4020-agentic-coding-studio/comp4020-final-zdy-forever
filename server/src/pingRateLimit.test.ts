import { describe, expect, it } from "vitest";
import { PingRateLimiter } from "./pingRateLimit.ts";

describe("PingRateLimiter", () => {
  it("allows the first 3 pings in a window, then rejects a 4th", () => {
    const limiter = new PingRateLimiter();
    const t0 = 1_000_000;
    expect(limiter.tryConsume("room-1", "alice", t0)).toBe(true);
    expect(limiter.tryConsume("room-1", "alice", t0 + 1)).toBe(true);
    expect(limiter.tryConsume("room-1", "alice", t0 + 2)).toBe(true);
    expect(limiter.tryConsume("room-1", "alice", t0 + 3)).toBe(false);
  });

  it("allows a 4th ping once the 10-second window has elapsed", () => {
    const limiter = new PingRateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) limiter.tryConsume("room-1", "alice", t0 + i);
    expect(limiter.tryConsume("room-1", "alice", t0 + 3)).toBe(false);
    expect(limiter.tryConsume("room-1", "alice", t0 + 10_000)).toBe(true);
  });

  it("tracks each room and account independently", () => {
    const limiter = new PingRateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) limiter.tryConsume("room-1", "alice", t0 + i);
    expect(limiter.tryConsume("room-1", "alice", t0 + 3)).toBe(false);
    // A different account in the same room, and the same account in a
    // different room, are both unaffected.
    expect(limiter.tryConsume("room-1", "bob", t0 + 3)).toBe(true);
    expect(limiter.tryConsume("room-2", "alice", t0 + 3)).toBe(true);
  });

  it("clearRoom resets that room's counters", () => {
    const limiter = new PingRateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) limiter.tryConsume("room-1", "alice", t0 + i);
    expect(limiter.tryConsume("room-1", "alice", t0 + 3)).toBe(false);
    limiter.clearRoom("room-1");
    expect(limiter.tryConsume("room-1", "alice", t0 + 3)).toBe(true);
  });
});
