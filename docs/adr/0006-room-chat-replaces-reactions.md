# Room chat replaces reactions

Status: accepted (product requirement).

The room now provides plain-text chat instead of emoji reactions and historical
reaction playback. This supersedes the earlier no-chat restriction.

Messages belong to a room, not a video or playback. The authenticated socket
supplies membership and identity; clients supply only message text. SQLite
preserves history across reconnects and restarts until the room closes.

An SQLite trigger deletes all messages as part of the room's closure update.
A second trigger rejects inserts into closed rooms. The inactivity sweep runs
at startup and periodically even for unoccupied rooms, so their history is
also removed. The room:closed event clears the online clients' state.

The old reaction table is removed during schema initialization. Message bodies
are excluded from observability logs. Sending chat counts as activity and is
limited to 500 characters and eight sends per account/room per ten seconds.
