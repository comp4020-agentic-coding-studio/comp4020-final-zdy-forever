# Watch YouTube Together

## Goal

Watch YouTube Together is a real-time shared viewing room for up to 12 users.
Open-room state is persistent; rooms close after seven days of inactivity and
closure deletes their chat. Do not describe this as unlimited shared memory.

Product principle:

> Friends can freely contribute videos and chat; changes that interrupt the
> shared viewing experience require a vote. Nonresponse is abstention, not consent.

The owner chose 12 members to limit waiting for each person's selection,
15-second votes to reduce waiting, and one-week expiry so abandoned rooms do
not accumulate while a next-day return still finds the room (it was two hours;
see `docs/adr/0014-one-week-room-expiry.md`). These are product judgements, not
experimentally optimised values; do not claim that a rationale alone
establishes compliance.

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

- Public: visible in lobby, and also reachable directly by a 7-digit room number (so a crowded lobby never needs to be scrolled)
- Private: hidden and joined with a 6-digit code

Room names are at most 20 characters.

Maximum 12 users.

Private codes, and public room numbers, must each be checked for active collisions. A room's code/number is exclusive only while it's open; a closed room's frees up for reuse. The "join a room" input is a single field: 6 digits means a private code, 7 digits means a public room number — the two lengths are deliberately different so one input can always tell which is meant.

Sharing a room (a copyable link, or the native share sheet) carries its code/number, and opening it joins automatically — a first-time visitor registers a name first, then joins the moment they do. Knowing the code/number at all is already everything a manual join requires, so this gives away nothing a typed-in code wouldn't.

Every room automatically closes after 7 days of inactivity. This is mandatory,
including legacy rooms; there is no creation-form toggle or client opt-out.

Heartbeat/network traffic does not count as activity.

The pre-join lobby offers a view of a room's recent structured activity log by
its code/number, without requiring membership or presence — unlike reading a
room's log once inside it. Render it in plain language, never raw log rows.
Server-side observability logging never records message text, clientId,
socketId or IP — only a stable account identity and what it did — so there is
nothing sensitive for this view to accidentally surface.

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

Once playback is empty, listeners may replay from any retained queue item.
Use a REPLAY_QUEUE_ITEM proposal (the usual sole-listener exception applies),
checking the queue revision and that playback is still empty at execution.
Start a fresh playbackId at zero on that item and follow the existing order;
do not duplicate, delete or reorder history. Once the queue finishes, show
"restart here" directly in place of each row's move/delete controls and disable
dragging. Restore the normal controls when authoritative playback restarts.

The DJ initially comes from the account that added the current queue item.
On departure, offer a 10-second choice of present successors, then choose one
randomly on the server. With zero/one successor, leave/transfer immediately
without a dialog. Another active tab of the same account retains the role.
Unexpected disconnects always get a 10-second reconnect grace period, even
with only one successor; only an explicit Leave may transfer immediately.
Store a per-playback DJ override, without changing queue attribution or playback
position; advance the revision so old DJ seek votes cannot apply after transfer.
New tracks start with their adder, falling back to a present member if absent.

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
- Resolve immediately once every currently present account has voted, whether
  YES or NO; otherwise wait for the deadline. Keep majority and stale
  reference checks, and cancel the timer after early resolution.
- YES / NO
- no response within 15 seconds = ABSTAIN; do not disconnect or remove that member
- ABSTAIN excluded from denominator
- no minimum turnout: at the deadline, decide by a strict majority of YES/NO votes cast; one YES with no NO passes, zero votes or a tie fails — see `docs/adr/0012-abstention-does-not-block-votes.md`
- required YES = floor(validVotes / 2) + 1
- tie fails

Exception: when the proposer is the only person in the room, there is nobody to vote with, so their proposal passes immediately (all other rules, e.g. DJ-only Seek, still apply). See `docs/adr/0004-sole-listener-proposals-pass.md`. If everyone still present has voted after a departure, resolve early; otherwise wait until the deadline.

One account gets one vote, and may change it between YES and NO any number of times before the proposal resolves. The proposer may also cancel their own open proposal before it resolves; nobody else may cancel it for them.

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

Never seek or reload a playing video beyond its known duration. Hold a locally
finished playback until the server changes its playbackId or revision; an old
PLAYING anchor may remain while end reports are collected. Report the end once
per connection/anchor, and ignore state events from the previous video during
track transitions.

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

## Signals

A ping wheel lets a room member hold Ctrl to open a radial picker anchored at
the cursor and release over a slice to broadcast a signal. This is not a
reaction echo (see `docs/adr/0013-ping-signals-are-not-reactions.md` for why
it does not reopen Room chat's replacement of reactions):

- Never persisted; never replayed to a late joiner or on reconnect.
- Never logged (not one of the 15 observability actions) and never counts as
  meaningful room activity.
- Broadcast as a fraction of the sender's own viewport (not raw pixels), so
  it appears at the same relative position for every viewer.
- Rate-limited server-side per room/account (currently 3 per rolling 10
  seconds); the client may dim the wheel as a local hint of this, but must
  never itself block a send — only the server's rejection is authoritative,
  and a rejection must be shown to the sender, never swallowed silently.
- Sending one never requires voting.
- Never mouse- or Ctrl-only: a visible signal button in the room bar opens
  the same signals as ordinary buttons for keyboard and touch (a phone has
  no Ctrl key), through the same send path and rate limit.

A 6-digit private room code or 7-digit public room number is a secret that
can only be reached by guessing it; any endpoint that resolves one (joining,
or looking up a room's activity log before joining) must share one
per-account rate limit against that same guess space, not reset separately
per endpoint.

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

Room information stays at the top; its member-count button opens DJ/listener
details in a dismissible popover. Wide screens put vote/chat on the left,
the player in the center, and add-link/queue on the right.
When only one sidebar fits, prioritize vote/chat; place add-link/queue below
the player. Small screens stack these sections without remounting the player.
Wide desktop rooms fit the viewport with aligned player/chat/queue card bottoms.
Scale using both viewport dimensions, preserve the video's aspect ratio, and
scroll chat/queue contents inside their panels rather than growing the page.

A small confetti burst and sound at every left click is purely decorative and
purely local to the clicking browser — never broadcast, synced or persisted,
unlike a ping wheel signal.

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

Describe acceptance scenarios in observable terms before reporting a fix.
Distinguish connection state from participation: a still-connected viewer who
does not vote must be tested separately from a departed viewer. Agents may
implement and execute checks; report their scope and remaining uncertainty.

In documentation, distinguish owner-reported experience, agent-executed checks,
agent-reported hypotheses and measured results. A successful build or changed
configuration does not establish a performance improvement or root cause.
Do not invent peer discussion, personal literature reading or completed crit
activities. Label later rehearsals and local versus deployed verification.

Preserve meaningful commits and real iteration for `PROCESS.md`. Never invent failures or evidence.

在回复的时候说中文
