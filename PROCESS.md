# Process overview

## My role and workflow

I gave Claude Code my requirements and worked through the first complete system with it on 29 September. We went phase by phase (rooms, queue, presence, voting, reorder, closure, UI), with one commit per phase. That is why there are fourteen commits that day. After that, I changed things incrementally. I proposed features, reported problems and decided which suggestions to accept. The agent wrote the implementation. Usually I described what I wanted, tried it, then went back with whatever felt wrong. The [evidence register](docs/evidence/author-account.md) separates my account from commits and agent reports.

Two practices shaped the harness. Anthropic's [Claude Code best practices](https://code.claude.com/docs/en/best-practices) describe CLAUDE.md as "persistent context it can't infer from code alone" and say "give Claude a check it can run". Böckeler's [harness engineering](https://martinfowler.com/articles/harness-engineering.html) separates guidance before the agent acts from checks after. So product rules live in [CLAUDE.md](CLAUDE.md), decisions in [ADRs](docs/adr/), and checks in `spec/` and the server tests. The cost is upkeep: changing room expiry meant CLAUDE.md, two ADRs and the spec map changing together ([`529c001`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/529c001)).

## Why this stack

The agent proposed React, TypeScript and Vite with Node, Express, Socket.IO and SQLite; I accepted it without benchmarking alternatives ([`f32f4df`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/f32f4df)). The case rests on the course's fixed deployment: one small machine and one volume. The [SQLite documentation](https://www.sqlite.org/whentouse.html) says it "works great as the database engine for most low to medium traffic websites", recommending a client/server database only when many writers must write "at the same instant" or data sits on another machine. Neither applies to rooms of 12.

Socket.IO gives two-way events, which votes and chat need; server-sent events would need a second channel for intentions. Its [delivery guarantees](https://socket.io/docs/v4/delivery-guarantees) shaped the design: ordering is guaranteed, but delivery is "at most once" and missed events are not replayed. So every reconnect starts from an authoritative room snapshot, and playback is a server anchor clients compute from, not a stream of times. A browser taken offline while chat continued showed the missed message after reconnecting, which is how I knew the snapshot design held ([evidence](docs/evidence/2026-10-24/README.md)).

Without a YouTube Data API key there is no search, so I accepted pasted links with oEmbed metadata ([`e866195`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/e866195)). Buffering and ads in the visible IFrame Player are outside my control. The players try to catch up with each other, but I cannot guarantee identical viewing.

## What I threw away

The obvious design for shared playback is whoever presses the button wins, or a host decides. I chose votes instead (README), and several later designs were discarded by testing them against that idea:

- **Reorder tokens.** Each account began with five reorders. I realised the group already gets a vote on every reorder, so I did not see why people also needed tokens. It was one more counter to keep track of. I removed them ([ADR 0005](docs/adr/0005-unlimited-reorders.md), [`57f3a90`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/57f3a90)).
- **Emoji reactions as the main channel.** Friends need to say more than emoji can express, so I made room chat the primary channel ([ADR 0006](docs/adr/0006-room-chat-replaces-reactions.md), [`b2e230d`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/b2e230d)). I use the ping wheel for quick signals when typing takes too long. The agent pointed out that this overlapped with reactions. [ADR 0013](docs/adr/0013-ping-signals-are-not-reactions.md) explains why I kept it: people talk in chat, and pings accompany that conversation without being stored.
- **Fifteen-second votes.** At Crit 10, classmates said the vote was new to them and worked, but 15 seconds felt too long. That made me cut it to 10 seconds. The agent pointed out that the heartbeat would then need to detect dead connections sooner, so both changed together ([ADR 0016](docs/adr/0016-ten-second-votes.md), [`6678eaa`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/6678eaa)).
- **Two-hour expiry.** When I checked this against the brief, I realised a friend or marker returning the next day would find the room closed and its chat deleted. I changed it to a week ([ADR 0014](docs/adr/0014-one-week-room-expiry.md)). That also means stale rooms stay around longer.

## A correction that did not first solve my problem

I found the voting bug while using two pages myself. I left one connected without touching it for about five minutes, then tried Skip on the other. The vote would not pass. I asked the agent to handle people being temporarily away. When I tried again, it looked normal, so I thought it was fixed. Later I learned that the change ([`d711fc6`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/d711fc6)) only handled people leaving. It still did not cover someone staying connected and ignoring the vote.

An agent-run rehearsal reproduced it on the deployment: B stayed connected without input for 309 seconds and A's Skip failed after 15 ([event record](docs/evidence/2026-10-11/README.md)). I authorised [ADR 0012](docs/adr/0012-abstention-does-not-block-votes.md): at the deadline nonresponses abstain, so one YES with no NO passes. I could have removed idle viewers, but someone who stops clicking should be able to stay in the room and keep their DJ role. The rule went into CLAUDE.md with a two-socket test that runs the full window ([`70ca825`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/70ca825)). Now I spell out the condition, "the other person stays connected throughout", and ask for a check that reproduces the failure before accepting the fix.

## Checks that found what review missed

The same rule caught two later gaps. Writing [ADR 0015](docs/adr/0015-who-may-see-and-change-what.md)'s permission table showed queue and playback could be read by anyone holding a public room's ID; a spec check failed before the fix and passed after ([`b176ed3`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/b176ed3)). A keyboard-only run showed the ping wheel, needing Ctrl and a mouse, excluded keyboard users and every phone; a visible signal button now opens the same signals, and CLAUDE.md says signals are never mouse-only ([`141982e`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/141982e)).

## Observability and limits

Logs record each account and what it did, never chat text, `clientId` or IP ([`3f1eab5`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/3f1eab5)). At Crit 10, two classmates used the app from its URL while I read only the logs: every important action and actor was visible, chat content was not. Others added bug-report features; I added an email address on the entry page, since logs reconstruct what happened once someone reports it.

When video buffered, the agent reported a SQLite fix as "17 times faster" ([`3863e71`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/3863e71)). I never saw a measurement, so [ADR 0011](docs/adr/0011-sqlite-wal-mode.md) records it as unverified.

Agent-run browser checks on 24 October ([evidence](docs/evidence/2026-10-24/README.md)) covered both marking viewports, simultaneous actions, keyboard-only use, resizing mid-vote, and a proxy adding 600 ms per round trip, under which chat and votes still arrived in about 0.8 seconds. Whether the vote feels fair to a new group is a judgement no test makes.
