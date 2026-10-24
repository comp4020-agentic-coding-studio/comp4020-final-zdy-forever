# Who may see and change what

Crit 10 asks that per-user visibility and edit permissions be enforced on the
server and written down. This records the rules already implemented, in one
place, and why.

## What counts as a person

An **account**: created by `POST /api/register` from a random `clientId` the
browser keeps in local storage, plus a display name that may duplicate. No
password or email; a separate Chrome profile is a separate person. The
`accountId` is public (rooms broadcast it), so it is never accepted alone: every
socket handshake and every authenticated REST call looks up the account by
`clientId` and rejects a mismatched `accountId` (`io.use` in
`server/src/realtime.ts`, `authenticate` in `server/src/index.ts`).

## Rules

| Action | Who | Enforced in |
| --- | --- | --- |
| See a public room in the lobby | anyone | `listPublicLobby` |
| Join a public room | any account, by lobby or 7-digit number | `room:join` |
| Join a private room | an account that entered its 6-digit code (recorded as a member) | `isRoomMember` check in `room:join` |
| Guess a code/number | any account, shared rate limit across join and log lookup | `codeGuessRateLimit.ts` |
| Add a track, chat, send a ping | accounts currently present in the open room | presence checks; chat and ping rate limits |
| Propose Play/Pause/Skip/Remove/Reorder | present accounts; executed only if the vote passes | `ProposalManager` |
| Propose Seek | the current DJ only | `requestProposal` DJ check |
| Vote | present accounts, one vote per account | voting engine keyed by `accountId` |
| Cancel a proposal | its proposer only | `proposal:cancel` |
| Choose the DJ successor | the departing DJ, among present accounts | `DjHandoffManager` |
| Read chat | accounts currently present | chat is sent only to the room's sockets |
| Read a room's log inside the room | accounts currently present | `GET /api/rooms/:roomId/logs` |
| Read a room's log before joining | any account that knows its code/number | `GET /api/rooms/logs` |
| Rename | the account itself | `POST /api/account/name` |

Nobody can directly change another person's data: no route edits another
account, and shared state (queue, playback) changes only through the server's
own validated actions or a passed vote. Wrong codes, private rooms and absent
members all receive the same "not found", so the server does not confirm that a
private room exists.

## Why

The product rule is that contributions are free but interruptions are shared
(README). Adding and chatting therefore need only presence; changing what others
are watching needs a vote. Account by `clientId` keeps entry to one step, which
matters because markers and friends arrive from a URL alone, at the cost that
clearing browser storage loses the account.

## Known limits

- Anyone who knows a room's internal `roomId` (a random UUID: listed in the
  lobby for public rooms, otherwise seen only by members) can read its queue and playback through `GET
  /api/rooms/:roomId/queue` and `/playback` without joining. These contain only
  video IDs and accountIds, not chat. This was left as is rather than added
  late; it is not an adversarial audit.
- Possession of the `clientId` is the whole credential. Another person on the
  same browser profile is the same account.
- The pre-join log viewer shows who did what to anyone with the code. Logs never
  contain chat text, `clientId`, `socketId` or IP (`server/src/logging.ts`).
