# Ten-second votes

Changes the 15-second window set in CLAUDE.md's Voting section. Every other
voting rule is unchanged.

## Context

At Crit 10, classmates who used the deployed app said the vote was a new idea
they had not thought of, and that it worked because a member who had
temporarily gone quiet could not block it (ADR 0012). Their one complaint was
that waiting for the vote felt too long. This is the owner's report of
spoken feedback, not a recorded study.

## Decision

A vote lasts at most **10 seconds** (`VOTING_WINDOW_MS` in
`shared/src/voting.ts`). It still resolves early once everyone present has
voted, and still decides by a strict majority of YES/NO votes cast at the
deadline.

The server heartbeat is tightened from 5 s + 5 s to **4 s + 4 s**
(`server/src/index.ts`), so the worst case for noticing a dead connection
(about 8 s) still lands inside the window, preserving ADR 0010's guarantee
that a vanished member stops counting as present before the deadline.

## Options considered

- **Keep 15 s.** The feedback says it is too long; most votes end early anyway
  when everyone present answers, so the full wait only bites when someone is
  quiet.
- **5 s.** Too short to read the proposal, decide and click, especially on a
  phone, and shorter than the heartbeat could match.
- **10 s (chosen).** A third shorter, still enough to read and respond.

## Costs

- A member who is briefly distracted has less time to object. Because
  nonresponse abstains, a missed vote now passes sooner on one YES.
- Twelve heartbeats per minute per connection instead of ten. Heartbeats are
  not room activity and are negligible at this scale.
- Even if a dead connection were still counted present at the deadline, the
  outcome would not change: since ADR 0012 only YES/NO ballots decide. It could
  only prevent an early resolution.

## Evidence

`server/src/voting.test.ts`, `server/src/proposals.test.ts` and
`spec/brief.test.ts` assert the new window (the proposal tests reference the
constant, including one millisecond before the deadline).
