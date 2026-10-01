# Watch YouTube Together

## Goal

Watch YouTube Together is a persistent, real-time shared listening room for up to 12 users.

Product principle:

> A good shared listening room should feel like people are listening together, with shared presence, shared control, and shared memory.

Do not add unrelated features or over-engineer.

## Stack

Use:

- React + TypeScript + Vite
- Node.js + Express
- Socket.IO
- SQLite
- YouTube oEmbed (video metadata, no API key)
- YouTube IFrame Player API

Prefer one deployable Node application.

Keep shared client/server types in one place where practical.

## YouTube

Use official YouTube APIs only.

The YouTube Data API v3 is not available for this course: no API key, and so no search (see `docs/adr/0003-youtube-metadata-via-oembed.md`).

Allowed:

- video metadata (existence, embeddability, title, channel, thumbnail) through YouTube's public oEmbed endpoint
- visible IFrame Player
- play, pause, seek, player state and current time

Never use:

- yt-dlp / youtube-dl
- audio extraction
- unofficial streaming APIs
- hidden audio-only YouTube playback
- ad blocking or autoplay bypasses

Use `videoId` as track identity.

Handle ads, buffering, autoplay restrictions and unavailable videos gracefully.

## Identity

Keep these separate:

- `accountId`: unique server identity
- `displayName`: may duplicate
- `clientId`: browser/device identity
- `socketId`: temporary connection

Never use displayName or socketId as permanent identity.

`accountId` is public (rooms broadcast it). Never accept it alone as proof of who is calling: verify it against the caller's `clientId`, on sockets and REST alike.

## Rooms

Rooms may be:

- Public: visible in lobby
- Private: hidden and joined with a 6-digit code

Maximum 12 users.

Private codes must be checked for active collisions.

Every room automatically closes after 2 hours of inactivity, with no user opt-out.

Heartbeat/network traffic does not count as activity.

## Authority

The server is authoritative for all shared state.

Clients send intentions, not complete state.

Route playback input through the room controls. Lock direct YouTube input by
default. A listener may temporarily unlock the native menu for local quality
and subtitle settings; Done locks input and reapplies the latest room anchor.
Never broadcast these viewing preferences. Keep playback speed at 1x. When
room playback is null (including an exhausted queue), reject local playback.
See `docs/adr/0007-local-player-settings.md` for the official API limitations.

Example:

`ADD_TRACK(videoId)` is valid.

Sending an entire replacement queue from the client is not.

Validate all external/client input server-side.

Use stable IDs and revisions for shared state.

## Persistence

Persist:

- rooms/config
- accounts
- queue and who added each item
- current playback state
- room chat messages (delete when the room closes)

Do not persist socket IDs or transient UI state.

After server restart, a previously playing track must recover at its last saved position as `PAUSED`.

## Queue and DJ

Adding a track does not require voting.

Queue items use stable IDs.

Concurrent additions must never overwrite each other.

Finished tracks (played to the end, or skipped) stay in the queue as history, above the current track. The queue view shows the current track as its first row; history is reached by scrolling up.

The DJ starts as the current track's adder. On departure, offer a 10-second
choice of present successors, then randomly assign one on the server. With
zero/one successor, leave/transfer immediately without a dialog. Keep the role
while another tab of that account remains. Persist the per-playback DJ override
without changing queue attribution or playback position, and bump revision.

DJ is a logical role; the DJ browser is never authoritative.

## Voting

These require voting:

- Play
- Pause
- Skip
- Seek
- Remove queue item
- Reorder queue

These do not:

- Add song
- Join/leave
- Chat message

Voting rules:

- 15-second window
- Resolve immediately once all currently present accounts have voted (YES or
  NO); otherwise wait for the deadline. Keep majority, quorum and stale checks.
- YES / NO
- no response = ABSTAIN
- ABSTAIN excluded from denominator
- minimum 2 non-abstain votes
- required YES = floor(validVotes / 2) + 1
- tie fails

Exception: when the proposer is the only person in the room, there is nobody to vote with, so their proposal passes immediately (all other rules, e.g. DJ-only Seek, still apply). See `docs/adr/0004-sole-listener-proposals-pass.md`.

One account gets one vote.

Proposals must reference relevant `playbackId` or queue revision so stale proposals cannot affect later state.

Only the current DJ may initiate Seek.

The server executes passed actions.

## Reorder

Queue reorder uses drag-and-drop and voting.

There is no limit on how often anyone may reorder: the vote is the only gate (see `docs/adr/0005-unlimited-reorders.md`, which replaced the original 5-token rule).

The current track never moves. Tracks still to come move only among themselves (never above the current track). A history track can only move down; placed after the current track, it will play again.

Stale or no-op reorders never change the queue.

## Playback sync

Do not continuously broadcast `currentTime`.

Server playback state should use:

- videoId
- status
- anchorPosition
- anchorServerTime
- playbackId
- revision

Clients calculate expected playback position from the server anchor.

Tolerate small drift and correct significant drift using the official YouTube player API.

Synchronization means convergence, not sample-perfect audio.

Reconnect and late join must start from an authoritative room snapshot.

## Room chat

Use room-scoped plain-text chat instead of reactions or historical echoes.

- Only authenticated members currently in the room may send or receive messages.
- Derive account, display name, room and timestamp on the server.
- Chat works even when no track is playing and never requires voting.
- Messages survive refresh, reconnect and server restart while the room is open.
- Delete chat records atomically when the room closes; clear connected clients too.
- Sending a message counts as meaningful room activity; reading does not.
- Validate text length and rate-limit sends per room/account.
- Never put message text in server logs.

## UI

Use a playful party-game visual language:

- large rounded corners
- candy colours
- high saturation
- thick outlines
- soft toy/rubber feel
- chunky buttons
- subtle 3D shadows
- cute icons
- sticker decoration
- elastic micro-interactions

Do not copy Eggy Party characters, logos, assets or exact screens.

Support desktop and mobile.

Keep the YouTube player visible.

Room information stays at the top; the member-count button opens DJ/listener
details in a dismissible popover. Wide screens put vote/chat on the left,
the player in the center, and add-link/queue on the right.
Prioritize the vote/chat sidebar when only one fits; stack on small screens.

## Reliability

Assume users act concurrently.

Pay particular attention to:

- room capacity races
- simultaneous queue changes
- conflicting proposals
- stale revisions
- track ending during Skip vote
- reorder while queue changes
- disconnect/reconnect during votes or track changes

An unexpected error applying a passed vote or handling a request (e.g. a DB write failure) must degrade that one room/request gracefully, never crash the whole server. This includes Socket.IO event handlers: they run from `process.nextTick`, so a throw there is an uncaught exception. Wrap every handler (see `guarded` in `server/src/realtime.ts`).

When a bug reveals a reusable invariant:

1. fix it
2. add a regression test
3. update CLAUDE.md only if the lesson is broadly reusable
4. use an ADR for important architectural decisions

## Workflow

Before editing, read relevant files.

Implement only the requested phase.

Do not perform unrelated refactors or add speculative abstractions.

After changes:

- run relevant tests
- run repository/course checks
- run build/typecheck
- report remaining risks

Do not claim something works without verifying it.

Preserve meaningful commits and real iteration for `PROCESS.md`. Never invent failures or evidence.

在回复的时候说中文
