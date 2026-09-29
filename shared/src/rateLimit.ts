// Pure, framework-free fixed-window rate limiting, mirroring
// shared/src/reorderTokens.ts's style: every function does ms arithmetic
// against a caller-supplied `nowMs` and never reads the clock itself, so the
// whole thing is trivially testable without fake timers or real waiting.
//
// Used to bound reaction spam (CLAUDE.md's Reactions section: reactions
// never require voting, so nothing else stops a client from sending them as
// fast as it likes) — see server/src/reactionRateLimiter.ts for the
// ephemeral, in-memory store built on top of this.

export interface RateLimitConfig {
  limit: number;
  windowMs: number;
}

// count is how many calls have been allowed since windowStartMs — never a
// live "now" value. A window that has fully elapsed by nowMs is simply
// replaced with a fresh one (see checkRateLimit), the same way
// reorderTokens.ts's regen resets its anchor once already at the cap.
export interface RateLimitState {
  windowStartMs: number;
  count: number;
}

export type RateLimitResult =
  | { allowed: true; state: RateLimitState }
  | { allowed: false; state: RateLimitState; retryAfterMs: number };

// state is null for a key that has never been seen before (a brand new
// room+account pair) — treated identically to a window that has already
// fully elapsed. Never mutates its input; a caller persists the returned
// state only when it means to (a rejected attempt still returns the
// normalized-but-unconsumed state, so a caller that discards a rejection's
// state on purpose doesn't cost the counter anything beyond what was already
// spent).
export function checkRateLimit(
  state: RateLimitState | null,
  config: RateLimitConfig,
  nowMs: number,
): RateLimitResult {
  const current =
    state && nowMs - state.windowStartMs < config.windowMs ? state : { windowStartMs: nowMs, count: 0 };

  if (current.count >= config.limit) {
    return { allowed: false, state: current, retryAfterMs: current.windowStartMs + config.windowMs - nowMs };
  }

  return { allowed: true, state: { windowStartMs: current.windowStartMs, count: current.count + 1 } };
}
