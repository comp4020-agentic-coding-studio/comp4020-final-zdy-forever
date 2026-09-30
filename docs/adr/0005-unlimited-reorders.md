# ADR 0005: Reorders are unlimited; the vote is the only gate

## Status

Accepted. Supersedes ADR 0001, and the reorder-token rules CLAUDE.md
originally set out.

## Context

CLAUDE.md's Reorder section rationed queue reorders per account: start with
5 reorder tokens, at most 5, 1 back every 5 minutes, and one spent per
successful reorder. In use, the token row ("2/5 reorder tokens · next +1 at
…") was one more thing to track in a room where every reorder already needs
a vote to pass. The project owner asked for the limit to go.

## Decision

There is no limit on how often anyone may reorder the queue. A
REORDER_QUEUE proposal is gated only by what gates every proposal: one open
vote per room at a time, the voting rules (or a sole listener's instant
pass, ADR 0004), and the queue checks. It must actually change the order of
the queue, moving the track to a place it may go (NO_OP / MOVE_NOT_ALLOWED),
and must still match the queue revision it was opened against when it
resolves.

The token machinery is removed:

- `shared/src/reorderTokens.ts`, `server/src/reorderTokenStore.ts` and their
  tests
- the `GET /api/rooms/:roomId/reorder-tokens/:accountId` endpoint
- the `reorderTokens:update` event
- the NO_REORDER_TOKENS request error
- the token row in the queue card

## Consequences

- Nobody runs out of reorders. Spamming them is held back by the one-vote-
  at-a-time rule and by each vote needing a majority, as with Skip.
- An older database may still contain a `reorder_tokens` table. Nothing
  reads or writes it any more.
- With the grey "drop here to move to end of queue" target also gone from
  the queue card, a track reaches the very end with the ⬇ button. Dragging
  drops a track in front of the one it lands on.
