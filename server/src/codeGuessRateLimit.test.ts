import { describe, expect, it } from "vitest";
import { CodeGuessRateLimiter } from "./codeGuessRateLimit.ts";

describe("CodeGuessRateLimiter", () => {
  it("allows the first 10 attempts in a minute, then rejects an 11th", () => {
    const limiter = new CodeGuessRateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) expect(limiter.tryConsume("alice", t0 + i)).toBe(true);
    expect(limiter.tryConsume("alice", t0 + 10)).toBe(false);
  });

  it("allows an attempt once the 60-second window has elapsed", () => {
    const limiter = new CodeGuessRateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) limiter.tryConsume("alice", t0 + i);
    expect(limiter.tryConsume("alice", t0 + 10)).toBe(false);
    expect(limiter.tryConsume("alice", t0 + 60_000)).toBe(true);
  });

  it("tracks each account independently", () => {
    const limiter = new CodeGuessRateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) limiter.tryConsume("alice", t0 + i);
    expect(limiter.tryConsume("alice", t0 + 10)).toBe(false);
    expect(limiter.tryConsume("bob", t0 + 10)).toBe(true);
  });

  it("counts every attempt, including correct guesses — a right answer never resets the budget", () => {
    const limiter = new CodeGuessRateLimiter();
    const t0 = 1_000_000;
    // tryConsume has no notion of "correct" at all — it's called once per
    // attempt regardless of outcome (server/src/index.ts calls it before
    // even looking the code up), so this is really just re-asserting the
    // plain counting behavior under a name that makes the security intent
    // explicit: nothing about a successful join or logs lookup gets to
    // special-case its own attempt out of the count.
    for (let i = 0; i < 10; i++) expect(limiter.tryConsume("alice", t0 + i)).toBe(true);
    expect(limiter.tryConsume("alice", t0 + 10)).toBe(false);
  });
});
