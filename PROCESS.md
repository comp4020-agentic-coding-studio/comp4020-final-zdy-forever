# Process overview

Watch YouTube Together is a shared room where users can watch YouTube videos together. The main rule is simple: actions that do not interrupt other users, such as chatting or adding a song, can happen directly. Actions that change what everyone is currently watching, such as Play, Pause, Skip, Seek, Remove or Reorder, require a vote.

This section explains how the current application implements those rules and how some of the design decisions changed during development.

## Stack and architecture

The client uses React, TypeScript and Vite. The server uses Node, Express and Socket.IO, with SQLite as the database. YouTube videos are played through the official IFrame Player, while oEmbed is used to retrieve basic video information.

The application is intentionally kept as one deployable system rather than splitting the frontend, backend and database into separate services. The course deployment environment provides one `shared-cpu-1x` machine, 256 MB of memory and one volume, so a simple architecture is more suitable for the scale of this project. Using a separate frontend deployment or managed PostgreSQL database would add more deployment and configuration work without providing much benefit here ([`f32f4df`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/f32f4df)).

YouTube also affects the design. Because there is no YouTube Data API key, the application does not provide search and users add videos by pasting links. The application also does not extract audio, so perfectly identical playback between different users is unrealistic. Instead, the server stores the current video, playback status, position, server time and revision. Clients use this information to stay close to the shared playback state.

## Keeping one shared room state

For a multi-user application, the browsers should not independently decide the final room state. Otherwise, different users could end up seeing different queues or playback states.

Because of this, the server is responsible for the room membership, queue and current playback state. Clients only send requests such as "add this song" or "vote yes", and the server decides what the final result should be.

The early implementation added persistent rooms and user identities ([`f32f4df`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/f32f4df), [`434291e`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/434291e)). The queue was also designed so that two users adding songs at the same time would not overwrite each other's changes ([`873a4c7`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/873a4c7)).

The voting logic for Play, Pause, Skip and Seek was implemented separately from the UI and server so that its rules could be unit-tested directly ([`4cb0237`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/4cb0237)).

Adding a song and sending a chat message do not require a vote. Play, Pause, Skip, Seek, Remove and Reorder do.

This behaviour is also checked by `spec/brief.test.ts` against the running application. For example, adding a track should not create a vote, while trying to pause a room with two users should create a proposal instead of pausing immediately.

## Handling users joining and leaving

Real-time updates are sent through Socket.IO, and users normally see room changes without reloading the page. However, the more difficult problem was deciding what should happen when users disconnect or when the number of active participants changes.

The current track has a DJ, which is the user who added it. The DJ is treated as a user role rather than a particular browser connection. If that user disconnects, the role can be handed to another active user instead of leaving the room stuck ([`b2e230d`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/b2e230d)).

A similar problem appeared in voting. The original rule required at least two valid votes. This could fail when another user's connection had already disappeared but the server had not detected it yet. The remaining user could not reach two votes even though nobody else was actually available to participate.

The decision is documented in `docs/adr/0010-live-presence-quorum.md`. The required quorum now depends on the number of users who are actually present, and an active vote is checked again when presence changes instead of only when another vote is submitted ([`d711fc6`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/d711fc6)).

One alternative was simply to reduce the Socket.IO heartbeat timeout so disconnected users would disappear more quickly. However, this would only make the problem last for a shorter time rather than fixing the voting rule itself, so I chose to change the rule.

## Logging and performance

The server records structured logs for important actions, including who performed an action, what happened and which room it happened in. I also added a room-specific log view so that system behaviour can be inspected during a demo ([`3f1eab5`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/3f1eab5), [`6c62f8d`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/6c62f8d)).

Later, playback was reported to become less smooth when more users were active. The logs helped identify that the database was contributing to the problem.

Actions such as voting, chatting and joining a room all write data to SQLite. `node:sqlite` performs these writes synchronously, so database operations can temporarily block the same Node.js event loop that is also responsible for sending real-time Socket.IO messages.

The original SQLite configuration made these writes more expensive than necessary. `docs/adr/0011-sqlite-wal-mode.md` records the changes: enabling WAL mode, using `synchronous = NORMAL`, and combining related log operations into one transaction.

A small benchmark showed that these changes made each commit around 17 times faster on the local test machine ([`3863e71`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/3863e71)).

This was useful because logging was originally added mainly to make the application easier to inspect, but it later became evidence that helped identify a performance problem.

## Directing, checking and correcting agent work

My general workflow with coding agents was not to accept a change simply because the generated code looked correct. I tried to run the application and compare its actual behaviour with the brief.

For example, I filled a room with 12 users and then tried to join as the 13th user. This checked not only whether the limit existed in the code, but also whether the rejected user received a clear error instead of nothing happening.

I also tested seeking beyond the actual length of a video. This revealed that the stored duration was often unavailable, so the live YouTube player's `getDuration()` value was a more reliable source.

UI problems were also easier to notice by looking at the running application rather than only reading the code. For example, a rotation effect that originally made an emoji look like a sticker became visually confusing after the same element was changed into a button.

When I found a problem that could happen again, I tried not to fix only that individual case. Important rules were added to `CLAUDE.md` or to tests in `spec/` so that later agent changes could be checked against them.

The voting quorum issue is one example. It started as a problem with a stuck vote, but the final fix included the code change, an updated rule in `CLAUDE.md`, and a test that checks the behaviour. This makes the correction part of the project rules rather than a one-time patch.