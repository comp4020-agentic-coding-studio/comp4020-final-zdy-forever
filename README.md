# Echo Room

A good shared listening room should make people feel they are genuinely
listening together, not that one person is broadcasting to passive
listeners. Every mechanical constraint here — the room cap, the vote, the
track-scoped DJ, the missing chat box — exists to protect that feeling. This
argues why, grounded in what the code enforces, not what it merely hopes for.

## Shared presence

Presence has to be small enough to be legible. Echo Room caps every room at
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
required yeses, with a tie failing (`shared/src/voting.ts`). Every proposal
carries the playback or queue revision it was opened against, so a vote that
resolves late can never land on a state that has already moved on. Voting
only guards actions that take something away from the room; adding a song,
joining, leaving, and reacting need none, because none of them removes
anyone else's agency.

The DJ is deliberately not a permanent role: it belongs to whichever account
added the currently playing track, looked up fresh from the queue item, not
cached at session start (`server/src/playback.ts`). Their browser is never
authoritative over playback — only their identity as "whoever brought this
track" is real, and it rotates automatically as the queue advances, keeping
control moving through the room instead of settling on one person.

That a vote passes or fails is mechanical. Whether 15 seconds and a bare
majority actually *feel* fair to a room of 12 is a judgement this codebase
can't verify on its own — that's for playtesting, not a test suite.

## Shared memory

Echo Room deliberately has no chat, no followers, and no social feed —
CLAUDE.md rules text chat out entirely, and nothing asks who anyone follows.
Those features build an audience; this app is trying to build a room.
Reactions (❤️ 🔥 😭 ✨) are the one social signal it keeps, timestamped
against playback position, not just wall-clock time
(`server/src/reactions.ts`). When the same video plays again, historical
reactions reappear near their original position with their original date,
so a room's history reads as shared memory of *this song*, not a
leaderboard.

## Why YouTube, despite the constraints

Only the official Data API v3 and the visible IFrame Player are used — never
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
`docs/adr/0001-reorder-token-scope.md` records one such decision in detail).
Whether a 12-person cap, a 15-second window, or timestamped reactions
actually *produce* the feeling of listening together is not something this
repository can assert for itself — that judgement belongs to the people
using the room.
