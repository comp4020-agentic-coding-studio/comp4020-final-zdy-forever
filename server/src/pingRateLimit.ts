import { checkRateLimit, type RateLimitState } from "../../shared/src/rateLimit.ts";

// Per-room, per-account rate limiting for the ping wheel's signal broadcasts
// — the first 3 pings are free, then throttled to 3 per rolling 10 seconds
// (shared/src/rateLimit.ts's existing fixed-window semantics already cover
// this exactly; no new primitive needed). Mirrors ChatRateLimiter in
// server/src/chat.ts, just with a tighter window for a purely cosmetic,
// never-persisted signal rather than a lasting chat message.
export class PingRateLimiter {
  private rooms = new Map<string, Map<string, RateLimitState>>();

  tryConsume(roomId: string, accountId: string, nowMs: number): boolean {
    const accounts = this.rooms.get(roomId) ?? new Map<string, RateLimitState>();
    const result = checkRateLimit(accounts.get(accountId) ?? null, { limit: 3, windowMs: 10_000 }, nowMs);
    accounts.set(accountId, result.state);
    this.rooms.set(roomId, accounts);
    return result.allowed;
  }

  clearRoom(roomId: string): void {
    this.rooms.delete(roomId);
  }
}
