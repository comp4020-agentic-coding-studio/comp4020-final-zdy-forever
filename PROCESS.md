# Process overview

## My role and workflow

I used Claude Code to build a first complete system from my requirements, then changed it incrementally. I supplied product proposals, described failures and accepted or rejected suggestions; the agent wrote the implementation. My loop was: describe an intended experience, try the result, report a mismatch, ask for a correction. I personally tested the room limit, seeking, refresh, phone/desktop layouts and, later, the ping wheel and log viewer. These are my retrospective account; the [evidence register](docs/evidence/author-account.md) separates it from commits and agent reports.

Two practices shaped the harness. Anthropic's [Claude Code best practices](https://code.claude.com/docs/en/best-practices) describe CLAUDE.md as "persistent context it can't infer from code alone", and tell you to "give Claude a check it can run". Böckeler's [harness engineering](https://martinfowler.com/articles/harness-engineering.html) separates guidance before the agent acts from checks after. So product rules live in [CLAUDE.md](CLAUDE.md) (written by me and the agent together), decisions in [ADRs](docs/adr/), and checks in `spec/` and the server tests. The cost is upkeep: when I changed room expiry, CLAUDE.md, two ADRs and the spec map all had to change together ([`529c001`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/529c001)).

## Why this stack

The agent proposed React, TypeScript and Vite with Node, Express, Socket.IO and SQLite; I accepted it without benchmarking alternatives ([`f32f4df`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/f32f4df)). The case for it rests on the course's fixed deployment: one small Fly machine and one volume. The [SQLite documentation](https://www.sqlite.org/whentouse.html) says it "works great as the database engine for most low to medium traffic websites", and recommends a client/server database only when many writers must write "at the same instant" or the data sits on another machine. Neither applies to rooms of 12, and one process in one container needs no second service.

Socket.IO gives two-way events, which votes and chat need, where server-sent events would need a second channel for intentions. Its [delivery guarantees](https://socket.io/docs/v4/delivery-guarantees) shaped the design: ordering is guaranteed, but delivery is "at most once" and events missed while disconnected are not replayed. That is why every reconnect starts from an authoritative room snapshot rather than catching up on events, and why playback is a server anchor clients compute from instead of a stream of times. A 24 October check confirmed this: a browser taken offline while chat continued showed the missed message after reconnecting ([evidence](docs/evidence/2026-10-24/README.md)).

Without a YouTube Data API key there is no search, so I accepted pasted links with oEmbed metadata ([`e866195`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/e866195)). The visible IFrame Player keeps playback within YouTube's terms but leaves buffering and ads outside my control: sync means convergence, not identical viewing.

## Product decisions and their costs

QQ Music's listen-together made me want to share media with distant friends in a browser. My rule is that adding a video expresses a preference without interrupting anyone, while Pause or Skip affects everyone, so only the latter need a vote. I chose 12 users to limit each person's wait for their selection and 15-second votes to keep waiting short. These are judgements, not measured optima.

I first chose two-hour room expiry for one-off gatherings. Checking it against the brief, I saw that a marker, or a friend, returning the next day would always find the room closed and its chat deleted. I changed it to one week ([ADR 0014](docs/adr/0014-one-week-room-expiry.md)). The cost is stale public rooms lingering in the lobby for up to a week.

## A correction that did not first solve my problem

I found a voting bug myself with two pages: one stayed connected but idle for about five minutes, and the other's Skip could not pass. I asked the agent to account for people temporarily away, a retry looked normal, and I believed it was fixed. It was not. The change ([`d711fc6`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/d711fc6)) handled people leaving; a connected person who simply ignores a vote is a different case.

On 11 October an agent-run rehearsal reproduced it on the deployment: B stayed connected without input for 309 seconds and A's Skip failed after 15 seconds ([event record](docs/evidence/2026-10-11/README.md)). I authorised the rule in [ADR 0012](docs/adr/0012-abstention-does-not-block-votes.md): at the deadline nonresponses abstain, so one YES with no NO passes. Silent viewers cannot veto; removing idle viewers instead would disturb membership and the DJ role. The rule went into CLAUDE.md with regression tests, including a two-socket vote that runs the full window ([`70ca825`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/70ca825)). The lesson changed what I ask for at acceptance: the exact observable condition, here "the other person stays connected throughout".

## Lighter additions

To make the room feel like a party, I gave the agent existing examples rather than designing from nothing: a confetti library for clicks, and League of Legends' ping wheel for a quick signal without typing. The agent flagged that a room-wide signal resembled the reactions chat had replaced; I accepted documenting the difference in [ADR 0013](docs/adr/0013-ping-signals-are-not-reactions.md) instead of quietly reopening that decision. It also found that nothing limited guessing a private 6-digit code and added one rate limit shared by joining and the new pre-join log viewer ([`41fc203`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/41fc203)). I have since tried all three on the deployment.

## Observability and multi-user evidence

Structured logs record each account and what it did, never chat text, `clientId` or IP ([`3f1eab5`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/3f1eab5)). At Crit 10, two classmates used the app from its URL in separate Chrome profiles while I read the logs: every important action and actor was visible, and chat content was not. The permission rules are collected in [ADR 0015](docs/adr/0015-who-may-see-and-change-what.md). Others added bug-report features; I judged this small app unlikely to need one.

When video buffered during my own testing, the agent reported a SQLite fix as "17 times faster" ([`3863e71`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/3863e71)). I never saw a measurement, so [ADR 0011](docs/adr/0011-sqlite-wal-mode.md) records it as unverified. A code change is not a root cause.

## What remains judged

The [spec map](spec/README.md) lists which promises tests enforce and which need people. An agent-run check on 24 October drove two isolated profiles at 1920×1080 and 390×844: simultaneous adds and proposals stayed consistent, and layouts had no horizontal scroll. Its network throttling did not slow the WebSocket, so slow-connection behaviour is still untested. Whether the vote feels fair to a new group is a judgement no test makes.
