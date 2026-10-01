# Watch YouTube Together

A good shared listening room should make people feel they are genuinely
listening together, not that one person is broadcasting to passive
listeners. Every mechanical constraint here — the room cap, the vote, the
track-scoped DJ, the room-scoped chat — exists to protect that feeling. This
argues why, grounded in what the code enforces, not what it merely hopes for.

## Shared presence

Presence has to be small enough to be legible. Watch YouTube Together caps every room at
12 participants (`MAX_ROOM_USERS`, `server/src/rooms.ts`) so the presence
list stays something a person can read at a glance, not a number that
scrolls off screen. Presence lives only in memory (`server/src/presence.ts`),
never persisted; a reconnect or late join always replays from an
authoritative server snapshot (`server/src/realtime.ts`) rather than
trusting what the client remembered, so nobody's view of who's in the room
can silently drift from the server's.

## Shared control

Broadcasting has one operator; a shared room has none. Play, pause, skip,
seek, queue removal, and reorder all require a vote — a 15-second window,
YES/NO, non-responses counted as abstain and excluded from the denominator,
a minimum of two non-abstaining votes, and `floor(validVotes / 2) + 1`
required yeses, with a tie failing (`shared/src/voting.ts`). Someone alone in
a room has nobody to vote with, so their own proposals pass straight away
rather than never. Every proposal
carries the playback or queue revision it was opened against, so a vote that
resolves late can never land on a state that has already moved on. Voting
only guards actions that take something away from the room; adding a song,
joining, leaving, and chatting need none, because none of them removes
anyone else's agency.

The DJ starts as the current track's adder. When leaving, they have 10 seconds
to select a successor; the server randomly selects a remaining member on timeout.
With zero or one successor, no dialog is needed. A persisted per-playback override
keeps the handoff separate from who added the track. The next track starts with
its own adder, with a fallback if they are absent. All rooms automatically close
after two hours without meaningful activity; this cannot be disabled.

That a vote passes or fails is mechanical. Whether 15 seconds and a bare
majority actually *feel* fair to a room of 12 is a judgement this codebase
can't verify on its own — that's for playtesting, not a test suite.

## Room chat

Everyone in a room can chat, including while the queue is empty. Messages
show who sent them and when, and are delivered only to members of that room.
Refreshing or reconnecting restores the room's chat history from SQLite.
Messages are plain text, limited to 500 characters and eight sends per account
per room in ten seconds. Sending counts as room activity.

Chat history lasts exactly as long as the room: closing a room deletes its
messages in the same database operation and clears connected clients. An
inactivity sweep includes unoccupied rooms and runs at startup and once a
minute. Message text is never copied into the server logs.

## Why YouTube, despite the constraints

Only YouTube's official oEmbed endpoint (for video details) and the visible
IFrame Player are used — never
`yt-dlp`, audio extraction, or hidden playback. That rules out
sample-perfect audio sync: ads, buffering, and per-viewer autoplay
restrictions all exist. The server never chases perfect alignment; it holds
an authoritative anchor (`videoId`, `status`, `anchorPositionMs`,
`anchorServerTimeMs`, `revision`) that clients converge toward, tolerating
small drift and correcting large drift through the official player API.
Synchronization means convergence, not identical audio samples — accepted
because it's the only path that respects YouTube's own terms.

## What's mechanical, what isn't

The room cap, vote thresholds, revision-checked proposals, and track-scoped
DJ lookup are enforced by code and covered by tests (`server/src/*.test.ts`;
`docs/adr/` records the decisions behind them in detail).
Whether a 12-person cap, a 15-second window, or room chat
actually *produce* the feeling of listening together is not something this
repository can assert for itself — that judgement belongs to the people
using the room.
