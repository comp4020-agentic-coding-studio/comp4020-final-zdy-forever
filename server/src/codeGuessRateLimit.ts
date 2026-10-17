import { checkRateLimit, type RateLimitState } from "../../shared/src/rateLimit.ts";

// Throttles how often one account may attempt to resolve a room by its
// 6-digit private code or 7-digit public number. POST /api/rooms/join-by-code
// and GET /api/rooms/logs both guess against the same secret space (a
// private room's code is the only way to reach it at all — see
// server/src/rooms.ts), so a guess on either counts against the same
// budget: sharing one bucket means alternating between the two endpoints
// can never double an attacker's effective rate.
//
// A 6-digit code has 1,000,000 possibilities. Without this, nothing stopped
// any authenticated account from enumerating them — the account/clientId
// pairing (server/src/index.ts's authenticate/authenticateQuery) proves
// *who* is asking, never bounds *how often*. At 10 attempts/minute,
// exhausting the whole space from one account takes on the order of months,
// which is the point: this isn't meant to stop a single mistyped digit, only
// make brute-forcing impractical.
//
// Keyed by accountId only (never a room — there isn't one yet; that's the
// entire premise of guessing). Every call counts, successful or not, so a
// correct guess can never be used to reset or dodge the budget.
export class CodeGuessRateLimiter {
  private accounts = new Map<string, RateLimitState>();

  tryConsume(accountId: string, nowMs: number): boolean {
    const result = checkRateLimit(this.accounts.get(accountId) ?? null, { limit: 10, windowMs: 60_000 }, nowMs);
    this.accounts.set(accountId, result.state);
    return result.allowed;
  }
}
