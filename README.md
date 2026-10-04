# Watch YouTube Together

A good shared listening room should make users feel they are watching
together, not that one person controls everything while everyone else
follows. So the main design principle is simple: actions that don't affect
other users happen freely; actions that change what everyone is watching
require agreement.

## Where this started

The idea was inspired by Spotify Jam and QQ Music's "listen together" —
both let a small group share control of one media session. My original idea
was music, but without a licensed audio source or a YouTube Data API key,
"listen together" became "watch together" using YouTube's official
embeddable player. The core idea stayed the same: one shared session, no
single user in full control.

## Shared presence

Each room holds at most 12 users (`MAX_ROOM_USERS`, `server/src/rooms.ts`) —
small, since this is built for groups of friends, not a public audience. The
server tracks who is present (`server/src/presence.ts`); a refresh or
reconnect always gets current state from the server rather than trusting
what the browser remembered.

## Shared control

Play, Pause, Skip, Seek, Remove and Reorder affect everyone, so each needs a
vote: 15 seconds, YES/NO, non-responses as abstain, more than half the valid
votes required, ties failing. Alone, a proposal passes immediately — nobody
else it could affect. Each proposal is linked to the room state when it
opened, so a late result can't change state already moved on. Adding a song,
joining, leaving and chatting skip the vote, since none of them interrupts
anyone else's viewing.

Whoever added the current track is its DJ — tied to the user, not a browser
tab. If the DJ disconnects, the role passes to another active member so the
room doesn't get stuck. Rooms close automatically after two hours idle.

## Room chat

Everyone can chat, even with an empty queue — sending a message doesn't
interrupt anyone's playback, so it needs no vote. Messages are capped at 500
characters, with each account limited to eight messages per room in ten
seconds. They're stored in SQLite and survive a refresh or reconnect, but
last only as long as the room — deleted along with it. Message content is
never written to the server logs.

## Why YouTube

Only YouTube's official oEmbed endpoint and IFrame Player are used — never
`yt-dlp`, audio extraction, or hidden playback. YouTube's own behaviour
(buffering, ads, autoplay, network differences) rules out identical
playback for every user, so the server stores the current video, state,
position and time, and clients adjust toward that shared state.

## What I chose not to build

- **No search** — no YouTube Data API key, so videos are added by pasting
  links.
- **No account system** — built for friends joining a temporary room, not
  long-term profiles.
- **No voice chat** — it would compete with the video's audio, and anyone
  who wants it already has a voice app.
- **No recommendations** — the point of the room is sharing with each
  other, not an algorithm doing it for you.

## What I can prove and what I cannot

The room cap, voting rules, proposal checks and DJ handoff are enforced by
code and tests. Whether 12 is the right number, or 15 seconds feels
comfortable, isn't something tests can show — that's a judgement about
experience, not correctness.

So far I've only tested this myself across multiple browser tabs: enough to
prove the rules work technically, not that real groups will enjoy it. The
goal for now is clear shared-control rules in an app simple enough for a
small group to actually use together.
