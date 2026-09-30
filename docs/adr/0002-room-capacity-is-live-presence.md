# ADR 0002: Room capacity counts who is present now; `room_participants` is membership

## Status

Accepted.

## Context

CLAUDE.md's Rooms section says "Maximum 12 users."

The first implementation counted rows in `room_participants`, which were
inserted on every join and never removed. So capacity measured everyone who
had *ever* joined: after twelve different people had come and gone, an empty
room refused everyone else, and the lobby showed it as full for good. Since
`/api/register` hands out accounts freely, anyone could also fill any public
room permanently with twelve requests.

Removing a row when someone leaves wouldn't fix it on its own. A join over
REST without a socket would still hold a place with nothing to release it,
and rows would survive a restart that dropped every socket.

## Decision

- Capacity is measured against live presence
  (`PresenceStore.count`/`canAdmit` in `server/src/presence.ts`): distinct
  accounts with at least one socket in the room right now, one account's
  several tabs counting once. The socket's `room:join` enforces it in the
  same synchronous turn as `presence.join`, so two sockets racing for the
  last place can't both get it. The REST join endpoints and the lobby report
  the same number, but those are only early answers.
- `room_participants` records membership instead: the accounts admitted to a
  room (its creator, and anyone who has joined it). Nothing is removed when
  someone leaves, and capacity never reads it. What it gates is re-entry to a
  PRIVATE room: its socket join requires membership, which only its creator
  and people who joined with its 6-digit code have. A bare `roomId` therefore
  never gets anyone in.

## Consequences

- Places free up the moment someone's last tab leaves. After a restart, the
  room is empty until people reconnect, which is true.
- Occupancy is in-memory, per process. That's correct for the single-machine
  deployment `fly.toml` fixes. Running several instances would need shared
  presence, and so a new ADR.
- Someone who joined a private room once can rejoin it later without the code
  for as long as the room is open. That matches "joined with a code"
  membership. Revoking membership isn't a feature today.
