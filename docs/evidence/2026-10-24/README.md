# Two-viewport check — 24 October 2026

Agent-run (Claude Code) black-box check of the deployed app, recorded for the
brief's marking conditions: two isolated browser profiles, one at each marking
viewport, plus simultaneous actions and a degraded network. It is not a human
usability session and not the Crit 10 classmate exercise.

- URL: https://comp4020-final-zdy-forever.fly.dev/ (release v12, commit
  `dac6174`, before the one-week expiry change).
- Tool: [`two-viewport-check.mjs`](two-viewport-check.mjs), Playwright driving
  local Chrome headless. Profile A at 1920×1080; profile B at 390×844, mobile
  emulation. Separate browser contexts share no cookies or storage.
- Scope: one private room (code 214409), two accounts, three public YouTube
  videos. The same script first passed 18/18 against a local build.

## Results (deployed, 18/18 passed)

| Check | Result |
| --- | --- |
| No horizontal scroll, lobby and room, both viewports | pass |
| B joins A's private room by its 6-digit code | pass |
| Chat A→B / B→A appears without reload | 79 ms / 82 ms |
| A and B add tracks at the same moment | both kept; both views show the same queue |
| A and B propose Skip at the same moment | one vote opens; both see it |
| Both vote (YES/NO) | resolves 24 ms after the second vote; tie fails |
| Desktop room fits 1080 px height, player fully visible | pass (`scrollHeight` 1080) |
| Phone player within 390 px width | pass (312×172) |
| B offline ~3 s while A chats, then back online | missed message appears 4.3 s after reconnect |
| B refreshes | chat history and queue restored |
| No uncaught page errors in either profile | pass |

Screenshots: [desktop room](room-1920.png), [phone room, full page](room-390-full.png),
[phone lobby](lobby-390.png). The video area is black because headless Chrome
did not render YouTube video; the decorations scattered over the page are the
local click confetti from the script's own clicks.

## Slow link (follow-up run)

The throttling step above did not slow the WebSocket (chat still arrived in
about 80 ms), so a second script, [`slow-link-check.mjs`](slow-link-check.mjs),
sent profile B through a local proxy to the same deployment that delays every
chunk by 300 ms each way, WebSocket frames included (about 600 ms added per
round trip). Profile A connected directly.

| Check | Result |
| --- | --- |
| B joins A's private room | 816 ms |
| Chat A→B, three samples | 1794, 790, 791 ms |
| Chat B→A, three samples | 788, 795, 793 ms |
| B proposes Pause; A sees the vote | 821 ms |
| A votes YES; B sees it resolve | 813 ms |

With 600 ms of added delay, changes still reached the other profile in about
0.8 s, in order and without loss. The first sample's 1.8 s is plausibly the
connection before its WebSocket upgrade; that cause was not verified. The
script's own "used websocket" probe is unreliable (resource timing does not
list WebSockets) and is not counted. Bandwidth limits and packet loss were not
simulated.

## Keyboard and resize (follow-up run)

[`keyboard-resize-check.mjs`](keyboard-resize-check.mjs) drove profile B with
the keyboard only (Tab, Enter, Escape) and resized windows mid-interaction,
against the deployment (release with commit `b176ed3`). 22/22 passed:

- Tab reaches the name field, join field, chat, vote buttons, member popover
  and queue move buttons; focused controls show an outline.
- Enter joins by code, sends chat, opens a Pause vote and a reorder vote that
  the other profile sees. The member popover closes on Escape and focus
  returns to its button.
- Shrinking 1280×800 → 390×844 while typing keeps the chat draft and focus,
  does not reload the player, and the finished message still sends.
- Resizing to 1600×900 and 820×1180 during an open vote keeps it usable; it
  resolves when B votes. 1366×640 has no horizontal scroll and the player
  stays visible.

Early failures were the script's own faults, not the app's: tabbing before
the socket connected, too few tracks for a move to be legal, and, on a rerun
against the final deployment (commit `b3568b1`), a 19-second
first video that headless Chrome actually played to the end, so playback
correctly became empty and the queue showed "restart here" instead of Pause.
The script now starts with a ten-minute video and passed 22/22 again on the
final deployment, alongside the two-viewport run (18/18), the signal button
check and the slow-link run.

What the run could not test was the ping wheel: it needs Ctrl plus a mouse,
so keyboard users and phones (no Ctrl key) could not send a signal at all.
That gap was fixed in `141982e` with a visible signal button; a follow-up
browser check sent a signal by touch at 390×844 and by keyboard at 1920×1080,
and each reached the other profile.

## Limits

- In the first run, Chrome's network throttling (400 ms latency, 50 kB/s) did
  not apply to the already-open WebSocket, so that step measured nothing about
  slow links; the proxy run above replaces it. The offline step does test reconnection, which
  recovers from the server snapshot rather than from missed events, matching
  Socket.IO's at-most-once delivery.
- YouTube playback sync, ads and buffering were not observed.
- One run; timings are single samples, not distributions.
