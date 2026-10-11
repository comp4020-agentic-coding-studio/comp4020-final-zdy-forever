# ADR 0012: Abstention does not block a vote

## Status

Accepted. Supersedes the minimum-turnout rule in ADR 0010.

## Context

During an agent-run check on 11 October 2026, two independent browser identities
joined the deployed app. One remained connected but made no input for over five
minutes. The other proposed Skip. It failed after 15 seconds because the engine
still required two ballots. The owner confirmed that people temporarily away
from their computers should not prevent those participating from proceeding.

Presence and participation are different: a connected viewer may be watching
without clicking, so inactivity is not a reliable reason to disconnect them.

## Decision

Keep the 15-second voting window. At its deadline, count only YES and NO ballots;
nonresponders abstain. A strict majority passes, including one YES and no NO.
Zero ballots, ties and a majority of NO votes fail. The proposer still starts
with a YES and may change or cancel it before resolution.

Resolve earlier only if every currently present account has voted, or the
proposer is the sole listener. A missing response never removes an account,
changes its DJ role, or prevents it voting in the next proposal. All permission,
stale-reference and single-execution protections remain in force.

## Alternatives and costs

- Keep a minimum of two ballots: preserves a turnout requirement but reproduces
  the demonstrated failure when another connected member is away.
- Mark idle or nonvoting viewers offline: confuses attention with connectivity,
  risks removing passive viewers, and unnecessarily affects capacity and DJ roles.
- Count abstentions as NO: gives nonresponse veto power, contrary to the chosen
  interaction rule.

The accepted trade-off is that one person can change playback after the full
window if nobody else votes. Silence is abstention, not affirmative agreement;
users who object must vote NO within the window. This rule applies consistently
to all proposal types, not only Skip.

## Checks

- `server/src/proposals.test.ts`: simulated five-minute inactivity, full deadline,
  single application, late NO with an abstaining third member, and departure cases.
- `server/src/voting.test.ts`: one YES, one NO, no ballots, ties and strict majorities.
- `spec/brief.test.ts`: two real Socket.IO clients; one stays connected without
  voting, both receive a passed Skip at the 15-second deadline.
- [11 October deployed check](../evidence/2026-10-11/README.md): the second
  account remained connected and inactive for 310 seconds before Skip; both
  sockets received PASSED at the deadline, with the second still connected.
