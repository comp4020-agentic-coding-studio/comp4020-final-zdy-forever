# Verification record — 11 October 2026

This record was prepared by Codex from tool observations and retained outputs. It is not a student-performed measurement or a completed Crit 10 peer exercise.

## Deployed rehearsal, before the correction

- URL: https://comp4020-final-zdy-forever.fly.dev/
- Time: approximately 18:27–18:35 Australia/Sydney, or 07:27–07:35 UTC.
- Operator: one agent using Chrome and the Codex in-app browser with independent storage and accounts. These were not two classmates or two Chrome profiles. The operator knew the application and controlled both interfaces.
- Source checkout at inspection: `da1d039f48932882a76aad6bbab54a3cdff4ca0a`. The deployed build's commit was not independently verified.
- Scope: one temporary private room, two accounts, one YouTube video, chat, Pause, Skip and departure. Both accounts explicitly left after testing.

### Observations

| Observation | Evidence | What it establishes |
| --- | --- | --- |
| B's chat appeared in A's browser without reload. | `CHAT_SEND` at 07:28:11.168 UTC; no text in this event. | The observed chat action and its actor; no measured delivery latency. |
| The first Pause expired. | `proposal-1`, 07:28:11.760–07:28:26.762. | Automation used the wrong accessible control role and missed the vote; this is not a human usability finding. |
| The second Pause passed after B voted YES. | `proposal-2`, 07:28:45.147–07:28:45.763; screenshots below. | The event chain identifies proposal, voter, outcome and resulting playback change. |
| B stayed connected without inputs for 309.512 seconds; A's Skip failed. | `proposal-3`, 07:33:55.273–07:34:10.275. | A connected abstainer still blocked this deployed version after the full 15.002-second window. |
| A's next Skip passed after B explicitly left. | `proposal-4`, opened 07:34:27.212; B left 07:34:27.605; passed 07:34:42.213. | This observation resolved at the original deadline, not immediately at departure. |

[Server event extract](server-events.json) contains the 18 retained events from this room. Account, room, proposal and playback identifiers have been replaced with consistent aliases; event types, order, timestamps, revision and action details are unchanged. It is a filtered and pseudonymised extract, not a complete production log or authentication audit.

Screenshots preserve the original interface display rather than the aliases:

- [Participant A after Pause passed](two-identities-pause-passed.png)
- [Participant B after Pause passed](second-browser-pause-passed.png)
- [Connected idle participant and failed Skip](idle-five-minutes-skip-failed.png)
- [Actual departure and passed Skip](actual-departure-skip-result.png)

### Limits

This rehearsal did not test unfamiliar users' onboarding, log-only narration, adversarial authorisation, a server restart, next-day persistence, end-to-end latency or buffering performance. It cannot validate the earlier “17 times faster” report or identify the cause of video buffering. The observed departure timing also differs from the local source's early-resolution behaviour; verify the deployed revision and repeat the case before claiming deployment parity.

## Local correction and checks, after the rehearsal

The owner authorised a correction: nonresponders abstain at the deadline without being disconnected. [ADR 0012](../../adr/0012-abstention-does-not-block-votes.md) records the rule and costs. At the time of the local checks below, these changes were in the working tree; a subsequent manual deployment is recorded in the following section.

- `server/src/proposals.test.ts` simulates 310 seconds without interaction and checks that a connected abstainer remains present, the deadline is respected and the action is applied once. The five-minute passage here uses a simulated clock, not a second five-minute browser session.
- `server/src/voting.test.ts` checks strict majorities, one YES, one NO, no ballots and ties.
- `spec/brief.test.ts` uses two real Socket.IO clients against the local app. One abstains while staying connected; both receive the same passed Skip after the real 15-second window. It does not exercise the visible YouTube player.
- The complete local `APP_URL=http://localhost:18080 pnpm check` passed type checks and 410 tests in 26 files, starting at 18:42:47. [Retained output](local-check-output.txt).
- After adjusting the integration test to observe both initial proposal broadcasts before waiting for results, its three brief tests passed again at 18:43:22. [Retained output](local-brief-check-output.txt).
- `pnpm build` also completed successfully in that correction session. Its output was not retained in this bundle; this statement is the agent's execution record, not an attached build log.

The local server used a temporary SQLite database. The log files replace the absolute checkout path with `<checkout>`; test counts and results are unchanged. These checks verify the local correction within their scope.

## Deployed correction, after the local checks

The corrected working tree was manually deployed to `https://comp4020-final-zdy-forever.fly.dev/` on 11 October 2026. Fly reported a healthy machine and successful DNS check. A fresh local build, type check and full suite passed again before deployment: 410 tests in 26 files. An online run of `spec/invariants.test.ts` and `spec/brief.test.ts` then passed all five tests in 17.85 seconds, including the two-connection Skip case. These are agent-executed checks.

A further protocol check tested the original long-idle condition against the deployed app. Two independent Socket.IO accounts joined one public test room. Account B sent no app input for **310.001 seconds** while staying connected. Account A then requested Skip. The server opened a 15,000 ms window at **08:09:49.353 UTC**. At **08:10:04.367 UTC**, both accounts received the same `PASSED` result with `applied: true`. The only ballot was A's YES, and B remained connected before and after the result. The observed receipt was roughly 15.014 seconds after creation; this is not a general latency measurement.

The long-idle check used Socket.IO clients, not visible browsers or classmates. It tested the server's connected/abstaining rule, not player buffering, accessibility or unfamiliar users' experience. The initial attempt used a private room but did not reach voting because B had not completed private-room joining; the successful check used a public room, as the application-level spec does. The test sockets were closed afterwards, and the room follows normal expiry. This result does not replace the formal Crit 10 peer exercise.

The public `main` branch also triggers course CI on push. A successful manual deployment does not by itself establish that CI rebuilt the eventual commit; check that run separately.
