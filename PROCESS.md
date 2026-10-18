# Process overview

## My role and workflow

I used Claude Code to build an initial complete system from my requirements, then changed it incrementally. I supplied product proposals, described failures and accepted or rejected suggestions; the agent generated the implementation. The stack was suggested by the agent and accepted by me. I did not independently benchmark competing frameworks before choosing it. Rules in [CLAUDE.md](CLAUDE.md) came from both my instructions and agent additions.

My workflow was to explain an intended experience, try the result, report a mismatch and ask for a correction. I personally tested the room limit, seeking, refresh/reconnection and phone/desktop layouts. These experiences are my retrospective account, not preserved recordings of every session. The [evidence register](docs/evidence/author-account.md) separates that account from commits, captured observations and agent reports. Crit presentations were opportunities to show the work; I am not attributing my discoveries to peer discussion.

## Product decisions and their costs

QQ Music's listen-together experience made me want to share media with distant friends through a browser. My governing rule is that adding a video expresses a preference without interrupting the current selection, while Pause or Skip affects everyone. I therefore allow adding and chatting freely but require votes for shared playback changes.

I chose 12 users because a larger queue means a longer wait for each person's selection, 15-second votes to reduce waiting, and two-hour idle closure because gatherings are temporary and abandoned rooms should not accumulate. These values express my judgement rather than measured optima. Closure also removes chat, so persistence is limited to open rooms. This remains a tension with the course's expectation of meaningful next-day persistence; documentation cannot resolve that product decision.

Sloan's small-group software essay was introduced during this revision to help articulate the design, not retroactively presented as my original inspiration. The source and comparison appear in [README.md](README.md).

## Why this architecture fits

The accepted stack is React, TypeScript and Vite, with Node, Express, Socket.IO and SQLite. Shared types connect client and server. The foundation is visible in [`f32f4df`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/f32f4df). One deployable application and a local database fit the course's single machine and persistent volume. A separate database service would add operational work outside that setup. This explains the fit; it does not establish that this stack outperforms alternatives.

The server owns shared state: browsers request actions rather than replace the queue. Persistent identities and rooms were added in [`434291e`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/434291e), and concurrent additions were addressed in [`873a4c7`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/873a4c7). Separating voting rules from transport made them directly testable ([`4cb0237`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/4cb0237)).

Without a YouTube Data API key, I accepted pasted links and official oEmbed metadata instead of search ([`e866195`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/e866195)). The visible IFrame Player keeps playback within YouTube's supported interface. It also leaves buffering and autoplay outside my control, so shared state can coordinate playback without guaranteeing identical viewing.

## A correction that did not initially solve my problem

I discovered the voting issue myself using two pages: one remained connected but inactive for roughly five minutes; the other requested Skip. Requiring two ballots blocked the participating person. I asked the agent to account for people temporarily away from their computers. After a retry appeared normal, I believed the issue was fixed.

The earlier change reconciled votes with live presence ([`d711fc6`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/d711fc6)); heartbeat settings were also tightened later. However, disconnection and nonparticipation are different. A connected viewer can ignore a vote without leaving. My retest had not established that this exact case worked.

On 11 October, a Codex-assisted rehearsal reproduced it on the deployment: participant B stayed connected, made no inputs for 309.512 seconds, and participant A's Skip failed after 15.002 seconds. The [event record and screenshots](docs/evidence/2026-10-11/README.md) support this narrower finding. They do not identify the deployment's exact source revision.

I authorised the revised rule in [ADR 0012](docs/adr/0012-abstention-does-not-block-votes.md): at the deadline, nonresponses abstain and only YES/NO ballots determine the majority. One YES can pass while another member remains connected. The cost is that silent viewers cannot veto a change. Removing idle viewers would also disturb membership and DJ roles, so abstention is a more targeted interpretation of my intention.

The correction updates CLAUDE.md and regression tests, including simulated five-minute inactivity and a real two-socket vote lasting the full window. The full local check passed 410 tests across 26 files; the three application-level brief tests were rerun after a test-ordering adjustment. These are agent-executed checks, recorded in the evidence bundle. After deployment, another two-connection check kept the abstainer connected and idle for 310 seconds; Skip passed at the deadline and both accounts received the same result. This tests the server rule, not the visible player or a human peer session.

## Observability and evidence limits

Structured logging records actions and actors ([`3f1eab5`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/3f1eab5)); a room log view and rejected-addition records followed ([`6c62f8d`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/6c62f8d)). During my own deployed testing, one person's video sometimes buffered even with only two users. I asked the agent to inspect logs and it reported a fix.

The SQLite WAL and logging changes are recorded in [`3863e71`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/3863e71). The earlier “17 times faster” number came from the agent; I did not run or interpret that benchmark. Without retained measurements or a controlled playback comparison, it cannot prove why buffering occurred. [ADR 0011](docs/adr/0011-sqlite-wal-mode.md) now distinguishes the implemented change, possible mechanism and unverified performance claim.

## Three lighter additions, not yet personally tried

This is a party site, so I wanted it to feel more like one. Rather than design the interaction from nothing, I looked for existing open-source projects with a similar feel and handed those to the agent as a starting point: a confetti library for the click effect, and a League of Legends-style ping wheel for the quick non-text signal. The log viewer was separate — I want it ready ahead of a later crit that asks me to account for what happened in a room from its logs, and I wanted a visitor to see what a room had recently been doing before committing to join it, rather than walking into a complete black box. The ping wheel fills a gap text chat leaves: sometimes I want to send a quick emotion or signal without the overhead of typing a message, and I kept this project's existing "don't disturb other people" principle in view — the signal has to reach everyone without taking control away from anyone, unlike Play/Pause/Skip. The click confetti and its sound are the smallest of the three: just a bit of feedback that makes clicking around the room feel more alive.

I asked for these as a follow-up round rather than part of the original voting work above. The agent flagged a tension on its own: the ping wheel's non-text, room-wide broadcast resembles the reaction feature Room chat had already replaced, so I accepted its proposal to document the distinction explicitly in [ADR 0013](docs/adr/0013-ping-signals-are-not-reactions.md) — a persisted, replayable reaction echo versus an ephemeral, never-stored signal — rather than silently reopening that earlier decision. I also asked it to check the deployment for a brute-force gap it had not been asked about: nothing previously bounded how often an account could guess a private room's 6-digit code, which the agent fixed with a shared rate limit across both the join and the new logs-lookup endpoints.

This work is recorded in [`41fc203`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/41fc203). The full local check passed 464 tests across 33 files before I pushed. [CI run 39030974277](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/actions/runs/39030974277) then rebuilt the Docker image, reran the same suite against it, and deployed; both its `check` and `deploy` jobs succeeded, and the agent confirmed the deployed site answered and that the new logs endpoint was live (a 401 for an unregistered account, not a 404 for a missing route). I have not yet personally opened the deployed site to try the ping wheel's two-person sync, the confetti, or the log viewer myself — what's established so far is that the automated suite and the deployment pipeline both passed, not that the experience itself is good.

## Making judgement repeatable

My self-tests also exposed seeking beyond a video's duration and a tilted decoration becoming confusing when reused as a button. The corresponding interface changes are visible in [`d7ab422`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/d7ab422); the commit corroborates the correction, not every detail of my testing session.

I still want to lead agent work without manually inspecting every function. The voting case changes what I ask for at acceptance: a concrete scenario, observable result and regression check. [spec/README.md](spec/README.md) maps promises to checks and remaining human judgements. The Crit 10 rehearsal is useful preparation, but two classmates' independent use and my log-only narration are still outstanding. Passing automation and an agent's completion report answer different questions from that exercise.
