# ADR 0010: Quorum tracks live presence, not a fixed floor

## Status

Partially superseded by ADR 0012: the minimum-turnout rule below no longer applies.
Heartbeat tuning and rechecking an open vote after departure remain in effect.
This record preserves the original decision and its limitations.

## Context

Socket.IO only detects a silently-dead connection (phone locked, wifi lost,
tab killed without a clean close) once its heartbeat times out. With the
library's defaults (`pingInterval` 25s, `pingTimeout` 20s) that can take up to
45 seconds — long enough for a "ghost" account to outlive an entire
15-second vote while still being counted present.

That ghost doesn't let a bad proposal pass: `tallyVotes` already only counts
cast YES/NO ballots, so an account that never votes is just an abstain,
exactly as if it had never been in the room. The problem is the other
direction. `MIN_NON_ABSTAIN_VOTES` (2) is a fixed floor, and a ghost still
counts toward *presence*:

- `ProposalManager.openProposal`'s sole-listener fast path (ADR 0004) checks
  `presentCount === 1` at request time — a ghost makes a genuine sole
  listener look like 2 people, so they miss it.
- The early-resolution check (ADR 0009, "every present account has voted")
  never fires, because the ghost never votes.
- The 15-second deadline (`resolveRoom`) then tallies only the ballots
  actually cast — with a real sole listener, that's 1 YES, below the fixed
  floor of 2 — and FAILS, even once the ghost is long gone.

ADR 0004 already called this out as a known gap: "If others leave while a
vote is open, that vote still resolves under the normal rules; the one
person left can simply propose again." In practice that meant re-proposing
Play/Pause/Skip for up to 45 seconds after the room was really already down
to one listener — exactly the "people look present but are actually gone"
failure this ADR fixes.

## Decision

Two changes, together:

1. **Tighter heartbeat.** `server/src/index.ts` sets `pingInterval: 5000,
   pingTimeout: 5000` on the Socket.IO `Server`, so the worst case for
   noticing a dead connection (~10s) lands inside the 15-second voting
   window instead of past it.
2. **Quorum caps at live presence, not just a fixed minimum.**
   `shared/src/voting.ts`'s `tallyVotes`/`resolveProposal` take an optional
   `presentCount`; when given, the minimum valid-vote requirement becomes
   `min(MIN_NON_ABSTAIN_VOTES, presentCount)` instead of the bare constant.
   Omitting it keeps the old fixed-2 behaviour (every existing unit test of
   the pure engine is unaffected). `ProposalManager` now passes live
   presence into both the 15-second deadline path (`resolveRoom`) and the
   early-resolution path, and a new `reconcilePresence` method (called from
   `realtime.ts`'s `leaveCurrentRoom`, alongside the existing DJ-handoff
   reconcile) re-runs the early-resolution check whenever someone's
   departure is detected — not only when a new ballot is cast.

Together, a room that genuinely degrades to one real listener mid-vote
resolves on that listener's own ballot (PASSED on YES, FAILED on NO) as soon
as presence catches up — instead of waiting out, and then failing, a
quorum nobody could possibly complete. A room with several people still
present but who simply choose not to vote is unaffected: the floor only
relaxes to match how many people *could* still vote, never below what
actually showed up to decide.

## Consequences

- Supersedes the ADR 0004 consequence quoted above: a proposal no longer
  needs to be re-requested after the room degrades to a sole listener
  mid-vote — the open one now resolves on its own.
- A dozen extra heartbeat round-trips per room is negligible, and heartbeat
  traffic was never "meaningful activity" for the 2-hour auto-close timer
  (CLAUDE.md's Rooms section) — this doesn't change that.
- Still bounded by real network conditions: a connection that takes longer
  than ~10s to be noticed as dead can still hold up a vote for part of its
  window. This is a mitigation, not a guarantee of instant detection.
