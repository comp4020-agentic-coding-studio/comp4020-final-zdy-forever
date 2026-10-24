# The spec

The [final project brief](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/assessments/final-project/)
and its spec are on the course website, along with the specs for crits 8, 9 and
10, which run in this repo. The brief poses the problem; the spec is the fixed
contract.

## What ships

`invariants.test.ts` checks the two things the course relies on:

- `/` answers with a 200, which is what the deploy and the crit capture read
- `/readme/` publishes `README.md`. Markdown renderers all differ slightly, so
  it checks the README's headings rather than every word: each one has to
  appear, in order, in the HTML the server sends, since no script runs. Render
  it however you like, as long as it's there in full; the marker reads it there.

Both run against the **running** app over HTTP, so they hold whatever it's built
with. In CI that app is the image your `Dockerfile` builds, started with a
throwaway `/data`, and a red run blocks the deploy. Locally, start the app
however you run it and `pnpm check` finds it at `APP_URL` (default
`http://localhost:8080`). Keep them; don't delete them.

## Your checks

Everything else in `spec/` is yours to write. Any `spec/*.test.ts` runs with
`pnpm check`, against the same running app. Some lines of a spec only a person
can judge; those are left to the crit and the marker.

At a crit, a green `check` job is half the shipped mark, but it's never the
judgement of the work: your tutor checks what you deployed against the published
spec.

## This project's promises and evidence

The course invariants above remain unchanged. These additional checks support
the definition of good in [README.md](../README.md); they do not replace human
judgement of the shared-viewing experience.

| Promise | Existing checks | What still needs judgement or external evidence |
| --- | --- | --- |
| Contribute freely; vote before interrupting shared playback. | [brief.test.ts](brief.test.ts) checks direct addition and a Pause proposal broadcast to another client; [proposals.test.ts](../server/src/proposals.test.ts) exercises other proposal types and stale references. | Whether voting feels fair and understandable to an unfamiliar group. |
| An abstainer remains connected and does not block a majority at the deadline. | [voting.test.ts](../server/src/voting.test.ts), [proposals.test.ts](../server/src/proposals.test.ts), and the two-socket Skip test in [brief.test.ts](brief.test.ts). | The corrected version passed a deployed two-connection test. |
| Capacity concerns distinct present accounts, not historical membership or tabs. | [presence.test.ts](../server/src/presence.test.ts) and [realtime.test.ts](../server/src/realtime.test.ts). | Whether 12 is a comfortable group size; tests only enforce the selected limit. |
| Open-room state survives reconnects and storage reopening. | [rooms.test.ts](../server/src/rooms.test.ts), [queue.test.ts](../server/src/queue.test.ts), [playback.test.ts](../server/src/playback.test.ts) and [chat.test.ts](../server/src/chat.test.ts) cover persisted state and recovery. | Rooms now stay open for 7 days of inactivity ([ADR 0014](../docs/adr/0014-one-week-room-expiry.md)); these checks use the constant, but a real next-day return on the deployment is a manual observation. |
| Server identity and permissions govern shared actions. | [realtime.test.ts](../server/src/realtime.test.ts), [djHandoff.test.ts](../server/src/djHandoff.test.ts), [chatRealtime.test.ts](../server/src/chatRealtime.test.ts) and the present-member read checks in [rooms.test.ts](rooms.test.ts) include rejection and identity cases. | The rules are listed in [ADR 0015](../docs/adr/0015-who-may-see-and-change-what.md); ordinary-use logs are not an adversarial security audit. |
| Logs expose actions and actors without recording chat text. | [logging.test.ts](../server/src/logging.test.ts) and the [11 October rehearsal](../docs/evidence/2026-10-11/README.md). | At Crit 10 two classmates used the deployed app while I narrated from the logs: the important actions and their actors were visible, chat text was not ([reflection](../reflections/crit-10.md)). |
| A ping-wheel signal reaches the whole room, is rate-limited server-side, and never blocks on an unsynchronized local guess. | [pingRateLimit.test.ts](../server/src/pingRateLimit.test.ts), the ping-signal cases in [realtime.test.ts](../server/src/realtime.test.ts), [pingWheelGeometry.test.ts](../client/src/pingWheelGeometry.test.ts) and [PingWheel.test.ts](../client/src/PingWheel.test.ts). | Whether the signal feels useful rather than noisy is a human judgement; the student has tried it on the deployment. |
| Signals are reachable without Ctrl or a mouse (keyboard and touch). | [SignalMenu.test.ts](../client/src/SignalMenu.test.ts); the agent-run [keyboard and resize check](../docs/evidence/2026-10-24/keyboard-resize-check.mjs). | Screen-reader use was not tested. |
| Guessing a room's private code/number is throttled, shared across every endpoint that resolves one. | [codeGuessRateLimit.test.ts](../server/src/codeGuessRateLimit.test.ts) and the shared-budget case in [rooms.test.ts](rooms.test.ts). | Whether 10 attempts/minute is the right balance for a real typo versus a real attacker is a judgement call, not something a test proves. |
| A pre-join activity log viewer renders plain language, never raw rows or chat text. | [logViewerFormat.test.ts](../client/src/logViewerFormat.test.ts) and [LogViewer.test.ts](../client/src/LogViewer.test.ts). | Whether the wording reads clearly to an unfamiliar visitor is a human judgement. |

Run the app separately, then use `APP_URL=http://localhost:8080 pnpm check`
for type checks and the complete suite. Set `APP_URL` to the actual local port.
`pnpm check:evidence` verifies that PROCESS commit citations resolve; it cannot
validate the truth of personal experience or the strength of an argument.

The [evidence bundle](../docs/evidence/2026-10-11/README.md) records the checks
already run and distinguishes local results from the earlier deployment.
