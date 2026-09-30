# Echo Room

## Goal

Echo Room is a persistent, real-time shared listening room for up to 12 users.

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

At room creation, users can enable/disable automatic closure after 2 hours of inactivity.

Heartbeat/network traffic does not count as activity.

## Authority

The server is authoritative for all shared state.

Clients send intentions, not complete state.

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
- reactions/history
- reorder-token state

Do not persist socket IDs or transient UI state.

After server restart, a previously playing track must recover at its last saved position as `PAUSED`.

## Queue and DJ

Adding a track does not require voting.

Queue items use stable IDs.

Concurrent additions must never overwrite each other.

The queue holds only the current track and what's still to come: a track leaves it once it finishes (plays to its end or is skipped).

The DJ for the current track is the account that added that queue item.

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
- Reaction

Voting rules:

- 15-second window
- YES / NO
- no response = ABSTAIN
- ABSTAIN excluded from denominator
- minimum 2 non-abstain votes
- required YES = floor(validVotes / 2) + 1
- tie fails

Exception: when the proposer is the only person in the room, there is nobody to vote with, so their proposal passes immediately (all other rules, e.g. DJ-only Seek and reorder tokens, still apply). See `docs/adr/0004-sole-listener-proposals-pass.md`.

One account gets one vote.

Proposals must reference relevant `playbackId` or queue revision so stale proposals cannot affect later state.

Only the current DJ may initiate Seek.

The server executes passed actions.

## Reorder

Queue reorder uses drag-and-drop and voting.

Each account:

- starts with 5 reorder tokens
- maximum 5
- recovers 1 every 5 minutes

Calculate regeneration from timestamps, not an in-memory repeating timer.

Consume one token only after a reorder vote passes and a real reorder succeeds.

Failed, stale or no-op reorder attempts cost nothing.

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

## Reactions

Use a small fixed reaction set such as:

❤️ 🔥 😭 ✨

Store reaction:

- videoId
- account
- position
- reaction
- date/time

Live reactions appear immediately.

When the same video is played again, historical reactions may reappear near their original timestamp with their original date.

Do not add text chat.

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

Core hierarchy:

current track → vote → DJ/presence → queue → reactions.

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