# Process overview

## My role and workflow

I used Claude Code to build a first complete system from my requirements: on 29 September I directed it phase by phase (rooms, queue, presence, voting, reorder, closure, UI), one commit per phase, which is why that day holds fourteen commits. Everything after was incremental. I supplied product proposals, described failures and accepted or rejected suggestions; the agent wrote the implementation. My loop: describe an intended experience, try it, report a mismatch, ask for a correction. The [evidence register](docs/evidence/author-account.md) separates my account from commits and agent reports.

Two practices shaped the harness. Anthropic's [Claude Code best practices](https://code.claude.com/docs/en/best-practices) describe CLAUDE.md as "persistent context it can't infer from code alone" and say "give Claude a check it can run". Böckeler's [harness engineering](https://martinfowler.com/articles/harness-engineering.html) separates guidance before the agent acts from checks after. So product rules live in [CLAUDE.md](CLAUDE.md), decisions in [ADRs](docs/adr/), and checks in `spec/` and the server tests. The cost is upkeep: changing room expiry meant CLAUDE.md, two ADRs and the spec map changing together ([`529c001`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/529c001)).

## Why this stack

The agent proposed React, TypeScript and Vite with Node, Express, Socket.IO and SQLite; I accepted it without benchmarking alternatives ([`f32f4df`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/f32f4df)). The case rests on the course's fixed deployment: one small machine and one volume. The [SQLite documentation](https://www.sqlite.org/whentouse.html) says it "works great as the database engine for most low to medium traffic websites", recommending a client/server database only when many writers must write "at the same instant" or data sits on another machine. Neither applies to rooms of 12.

Socket.IO gives two-way events, which votes and chat need; server-sent events would need a second channel for intentions. Its [delivery guarantees](https://socket.io/docs/v4/delivery-guarantees) shaped the design: ordering is guaranteed, but delivery is "at most once" and missed events are not replayed. So every reconnect starts from an authoritative room snapshot, and playback is a server anchor clients compute from, not a stream of times. A browser taken offline while chat continued showed the missed message after reconnecting, which is how I knew the snapshot design held ([evidence](docs/evidence/2026-10-24/README.md)).

Without a YouTube Data API key there is no search, so I accepted pasted links with oEmbed metadata ([`e866195`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/e866195)). The visible IFrame Player leaves buffering and ads outside my control: sync means convergence, not identical viewing.

## What I threw away

The obvious design for shared playback is whoever presses the button wins, or a host decides. I chose votes instead (README), and several later designs were discarded by testing them against that idea:

- **Reorder tokens.** Each account began with five reorders. Since every reorder already needs a vote, the tokens rationed something the group already controlled, and added a counter to watch. I removed them ([ADR 0005](docs/adr/0005-unlimited-reorders.md), [`57f3a90`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/57f3a90)).
- **Emoji reactions as the main channel.** Emoji alone could not carry what friends wanted to say, so room chat became the primary channel ([ADR 0006](docs/adr/0006-room-chat-replaces-reactions.md), [`b2e230d`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/b2e230d)). Emoji still work well as a supplement: the ping wheel sends a quick signal when typing is too slow. The agent flagged the overlap, and [ADR 0013](docs/adr/0013-ping-signals-are-not-reactions.md) records the line: chat is the conversation, an unstored ping only accompanies it.
- **Fifteen-second votes.** At Crit 10, classmates called the vote new and usable but the wait too long. I cut it to 10 seconds; the agent pointed out the heartbeat then had to notice a dead connection sooner, so both changed together ([ADR 0016](docs/adr/0016-ten-second-votes.md), [`6678eaa`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/6678eaa)).
- **Two-hour expiry.** Checked against the brief, a friend or marker returning the next day would always find the room closed and its chat deleted. I changed it to a week ([ADR 0014](docs/adr/0014-one-week-room-expiry.md)); stale rooms now linger longer.

## A correction that did not first solve my problem

I found a voting bug myself: one page stayed connected but idle for about five minutes, and the other's Skip could not pass. I asked the agent to account for people temporarily away, a retry looked normal, and I believed it fixed. It was not: the change ([`d711fc6`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/d711fc6)) handled people leaving, not a connected person ignoring a vote.

An agent-run rehearsal reproduced it on the deployment: B stayed connected without input for 309 seconds and A's Skip failed after 15 ([event record](docs/evidence/2026-10-11/README.md)). I authorised [ADR 0012](docs/adr/0012-abstention-does-not-block-votes.md): at the deadline nonresponses abstain, so one YES with no NO passes. Removing idle viewers was the obvious alternative, but it would disturb membership and the DJ role for someone who merely stopped clicking. The rule went into CLAUDE.md with a two-socket test that runs the full window ([`70ca825`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/70ca825)). How I now know a fix is right: I name the observable condition ("the other person stays connected throughout") and require a check that reproduces it failing first.

## Checks that found what review missed

The same rule caught two later gaps. Writing [ADR 0015](docs/adr/0015-who-may-see-and-change-what.md)'s permission table showed queue and playback could be read by anyone holding a public room's ID; a spec check failed before the fix and passed after ([`b176ed3`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/b176ed3)). A keyboard-only run showed the ping wheel, needing Ctrl and a mouse, excluded keyboard users and every phone; a visible signal button now opens the same signals, and CLAUDE.md says signals are never mouse-only ([`141982e`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/141982e)).

## Observability and limits

Logs record each account and what it did, never chat text, `clientId` or IP ([`3f1eab5`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/3f1eab5)). At Crit 10, two classmates used the app from its URL while I read only the logs: every important action and actor was visible, chat content was not. Others added bug-report features; I added an email address on the entry page, since logs reconstruct what happened once someone reports it.

When video buffered, the agent reported a SQLite fix as "17 times faster" ([`3863e71`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/3863e71)). I never saw a measurement, so [ADR 0011](docs/adr/0011-sqlite-wal-mode.md) records it as unverified.

Agent-run browser checks on 24 October ([evidence](docs/evidence/2026-10-24/README.md)) covered both marking viewports, simultaneous actions, keyboard-only use, resizing mid-vote, and a proxy adding 600 ms per round trip, under which chat and votes still arrived in about 0.8 seconds. Whether the vote feels fair to a new group is a judgement no test makes.
