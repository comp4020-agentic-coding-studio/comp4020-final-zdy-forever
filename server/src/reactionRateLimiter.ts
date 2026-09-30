import { checkRateLimit, type RateLimitState } from "../../shared/src/rateLimit.ts";

// Reactions never require voting (CLAUDE.md's Voting section), so this is
// the only thing standing between a client and reaction spam. In-memory only, never
// persisted (CLAUDE.md's Persistence section: "Do not persist ... transient
// UI state") — mirrors server/src/presence.ts's ephemeral-store pattern.
const REACTION_RATE_LIMIT = { limit: 8, windowMs: 10_000 };

export class ReactionRateLimiter {
  private state = new Map<string, RateLimitState>();

  // True if this account may send another reaction in this room right now
  // (and, if so, records that it just did) — false if it's currently over
  // the limit, in which case nothing is recorded.
  tryConsume(roomId: string, accountId: string, nowMs: number): boolean {
    const key = `${roomId}:${accountId}`;
    const result = checkRateLimit(this.state.get(key) ?? null, REACTION_RATE_LIMIT, nowMs);
    this.state.set(key, result.state);
    return result.allowed;
  }
}
