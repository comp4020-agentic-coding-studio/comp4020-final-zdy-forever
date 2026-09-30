# ADR 0004: A sole listener's proposals pass immediately

## Status

Accepted.

## Context

CLAUDE.md's voting rules require a minimum of 2 non-abstain votes for a
proposal to pass. With only one person in a room, that can never happen, so
Play, Pause, Skip, Seek, removing and reordering were all impossible.

This isn't only a problem for someone listening alone by choice. Every server
restart recovers a playing room as PAUSED (CLAUDE.md's Persistence section).
A room with one person in it at that moment then stayed paused for good, or
until a second person happened to join.

## Decision

When the proposer is the only account present in the room (live presence,
one account's several tabs counting once), their proposal passes as soon as
it's requested. There's no 15-second window and no vote.
`ProposalManager.openProposal` handles this, with `presentCount` supplied by
the realtime layer. The pure voting engine (`shared/src/voting.ts`) is
unchanged.

Everything checked before a vote would open still applies: only the DJ may
Seek, a no-op or disallowed reorder is refused, Play-while-playing is
refused, and so on. The passed proposal goes through the same execution path
as a vote that passed.

## Consequences

- One person can listen alone and still control the room, including
  resuming it after a restart.
- It applies only at request time. If others leave while a vote is open, that
  vote still resolves under the normal rules; the one person left can simply
  propose again.
- It's a deliberate exception to the "minimum 2 non-abstain votes" rule, and
  it's recorded in CLAUDE.md's Voting section.
