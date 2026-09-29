# ADR 0001: Reorder tokens are scoped per (room, account), not per account globally

## Status

Accepted.

## Context

CLAUDE.md's Reorder section says:

> Each account: starts with 5 reorder tokens; maximum 5; recovers 1 every 5
> minutes.

It says "each account," but doesn't say whether that balance is one number
shared across every room the account is ever in, or a separate balance per
room.

Reorder tokens exist to rate-limit how often one account can force a
successful queue reorder in *a room's queue*. Queue membership, DJ status,
voting, and `queueRevision` are all scoped to a single room — nothing about
"the queue" is a cross-room concept anywhere else in this codebase.

## Decision

A reorder-token balance is keyed by `(roomId, accountId)`, not by `accountId`
alone. An account present in two rooms at once holds two independent
balances of up to 5 tokens each.

## Consequences

- An account can't be penalized in Room B for having spent tokens reordering
  Room A's queue, and vice versa — each room's queue-reorder rate limit is
  independent, matching how everything else reorder touches (the queue
  itself, DJ, voting) is already room-scoped.
- Storage is one row per `(roomId, accountId)` pair that has ever spent a
  token in that room (see `reorder_tokens` in `server/src/db.ts`), not one
  row per account. An account that never reorders anything, anywhere, never
  gets a row at all.
- If a future requirement wants a *global*, cross-room reorder budget
  instead, that's a different balance model and would need its own ADR
  superseding this one — the current implementation
  (`shared/src/reorderTokens.ts`, `server/src/reorderTokenStore.ts`) does not
  support it.
