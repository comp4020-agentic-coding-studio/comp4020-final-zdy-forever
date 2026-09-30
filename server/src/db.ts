import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

// Opens (creating if needed) the SQLite file at dbPath and brings the schema
// up to date. Safe to call repeatedly against the same file: CREATE TABLE IF
// NOT EXISTS makes initialization idempotent, so restarts and redeploys never
// fail on an existing database.
export function openDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:") {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      accountId  TEXT PRIMARY KEY,
      clientId   TEXT NOT NULL UNIQUE,
      displayName TEXT NOT NULL,
      createdAt  TEXT NOT NULL
    )
  `);

  // queueRevision is this room's queue *membership* counter (see
  // shared/src/voting.ts's "queue" reference kind) — it advances whenever a
  // REMOVE_QUEUE_ITEM (or, later, REORDER_QUEUE) proposal actually mutates
  // the queue, so a REMOVE/REORDER proposal opened against an earlier
  // revision can be detected as stale at resolution time. Adding a track
  // deliberately does NOT bump this (see queue.ts's addTrack) — mirroring
  // how adding to the queue never bumps room_playback.revision either, an
  // unrelated addition must never invalidate an in-flight queue vote.
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      roomId       TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      creatorAccountId TEXT NOT NULL REFERENCES accounts(accountId),
      visibility   TEXT NOT NULL CHECK (visibility IN ('PUBLIC', 'PRIVATE')),
      code         TEXT,
      maxUsers     INTEGER NOT NULL,
      autoCloseEnabled INTEGER NOT NULL,
      createdAt    TEXT NOT NULL,
      lastMeaningfulActivityAt TEXT NOT NULL,
      closed       INTEGER NOT NULL DEFAULT 0,
      queueRevision INTEGER NOT NULL DEFAULT 1
    )
  `);

  const existingRoomColumns = new Set(
    (db.prepare("PRAGMA table_info(rooms)").all() as { name: string }[]).map((c) => c.name),
  );
  if (!existingRoomColumns.has("queueRevision")) {
    db.exec("ALTER TABLE rooms ADD COLUMN queueRevision INTEGER NOT NULL DEFAULT 1");
  }

  // A code is exclusive only while its room is active (closed = 0), so a
  // closed room's code is free for a new room to reuse.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS rooms_active_code
      ON rooms(code)
      WHERE closed = 0 AND code IS NOT NULL
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS room_participants (
      roomId    TEXT NOT NULL REFERENCES rooms(roomId),
      accountId TEXT NOT NULL REFERENCES accounts(accountId),
      joinedAt  TEXT NOT NULL,
      PRIMARY KEY (roomId, accountId)
    )
  `);

  // queueItemId (not this table's implicit rowid, and never an array index)
  // is the stable identity of a queue item; rowid is only ever used as a
  // tie-breaker for two rows that would otherwise share a position (there
  // should never be any, but it keeps ordering deterministic regardless).
  db.exec(`
    CREATE TABLE IF NOT EXISTS queue_items (
      queueItemId  TEXT PRIMARY KEY,
      roomId       TEXT NOT NULL REFERENCES rooms(roomId),
      videoId      TEXT NOT NULL,
      title        TEXT NOT NULL,
      channelTitle TEXT NOT NULL,
      thumbnailUrl TEXT NOT NULL,
      addedBy      TEXT NOT NULL REFERENCES accounts(accountId),
      addedAt      TEXT NOT NULL
    )
  `);

  // position is this room's explicit queue order — the only thing a passed
  // REORDER_QUEUE proposal ever changes (see server/src/queue.ts's
  // reorderQueueItem). A pre-reorder database has no such column yet, so a
  // fresh row defaults every existing item to 0 and listQueue/getNextTrack
  // fall back to rowid (insertion order) to break the tie, exactly
  // reproducing the old rowid-only ordering until something is actually
  // reordered for the first time in that room.
  const existingQueueItemColumns = new Set(
    (db.prepare("PRAGMA table_info(queue_items)").all() as { name: string }[]).map((c) => c.name),
  );
  if (!existingQueueItemColumns.has("position")) {
    db.exec("ALTER TABLE queue_items ADD COLUMN position INTEGER NOT NULL DEFAULT 0");
  }
  // durationMs is the track's length as looked up when it was added, or NULL
  // when unknown — including every item added before this column existed,
  // for which a reported track end simply can't be checked (see
  // shared/src/playbackSync.ts's isPlausibleTrackEnd).
  if (!existingQueueItemColumns.has("durationMs")) {
    db.exec("ALTER TABLE queue_items ADD COLUMN durationMs INTEGER");
  }

  // The currently-playing queue item, one row per room (no row = nothing
  // currently playing), plus the server-authoritative sync anchor: status,
  // anchorPositionMs and anchorServerTimeMs let a client calculate its
  // expected position (see shared/src/playbackSync.ts) without the server
  // ever broadcasting currentTime continuously. playbackId identifies this
  // particular "now playing" instance — it changes only on a track
  // transition, even if the same queueItemId were ever to play again.
  // revision identifies this particular playback *control* state and
  // advances on every anchor rebase (play/pause/seek, track transition, or a
  // server-restart recovery) — it never resets, including across a track
  // change. A future vote/skip proposal must reference both {playbackId,
  // revision} to detect staleness (see isStaleReference). The DJ for the
  // current track is never stored here: it's always looked up live as
  // queue_items.addedBy for this row's queueItemId, so it belongs to the
  // track (not permanently to the room) and can't drift out of sync.
  db.exec(`
    CREATE TABLE IF NOT EXISTS room_playback (
      roomId             TEXT PRIMARY KEY REFERENCES rooms(roomId),
      playbackId         TEXT NOT NULL,
      queueItemId        TEXT NOT NULL REFERENCES queue_items(queueItemId),
      startedAt          TEXT NOT NULL,
      status             TEXT NOT NULL CHECK (status IN ('PLAYING', 'PAUSED')),
      anchorPositionMs    INTEGER NOT NULL,
      anchorServerTimeMs INTEGER NOT NULL,
      revision           INTEGER NOT NULL
    )
  `);

  // A room_playback table created before these sync columns existed (an
  // earlier phase's database file) won't have them — CREATE TABLE IF NOT
  // EXISTS is a no-op against an existing table, schema mismatches and all.
  // ALTER TABLE ADD COLUMN itself isn't idempotent (it throws if the column
  // already exists), hence the explicit check.
  const existingColumns = new Set(
    (db.prepare("PRAGMA table_info(room_playback)").all() as { name: string }[]).map((c) => c.name),
  );
  if (!existingColumns.has("status")) {
    db.exec("ALTER TABLE room_playback ADD COLUMN status TEXT NOT NULL DEFAULT 'PAUSED'");
    db.exec("ALTER TABLE room_playback ADD COLUMN anchorPositionMs INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE room_playback ADD COLUMN anchorServerTimeMs INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE room_playback ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
  }

  // (A reorder_tokens table may still exist in an older database: reorders
  // used to be rationed by tokens, which docs/adr/0005 removed. Nothing reads
  // or writes it any more.)

  // One row per recorded reaction (CLAUDE.md's Reactions section). displayName
  // is denormalized here (rather than looked up live from accounts, as the DJ
  // is in room_playback) because a reaction is a historical record of what
  // was shown at the time — it should read the same on replay even if the
  // account later changes its display name. There is no "kind" (LIVE/ECHO)
  // column: that distinction only ever exists at the wire level (see
  // shared/src/types.ts's ReactionEvent) — a stored row is always just the
  // fact of a live moment. Matching for historical replay is by (roomId,
  // videoId) alone (see reactions_room_video below), deliberately never by
  // playbackId, since a video restarting under a brand new playbackId is
  // exactly the "same video plays again" case that must still surface prior
  // reactions — playbackId is kept purely for reference/debugging.
  db.exec(`
    CREATE TABLE IF NOT EXISTS reactions (
      reactionId  TEXT PRIMARY KEY,
      roomId      TEXT NOT NULL REFERENCES rooms(roomId),
      videoId     TEXT NOT NULL,
      playbackId  TEXT NOT NULL,
      accountId   TEXT NOT NULL REFERENCES accounts(accountId),
      displayName TEXT NOT NULL,
      reaction    TEXT NOT NULL CHECK (reaction IN ('❤️', '🔥', '😭', '✨')),
      positionMs  INTEGER NOT NULL,
      createdAt   TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS reactions_room_video ON reactions(roomId, videoId)
  `);

  // The last moment this server process was known to be running, refreshed
  // every few seconds (see playback.ts's recordServerAlive). One row at most.
  // It lets a restart recover a PLAYING track where it had actually got to,
  // rather than back at its last anchor (for a track nobody ever paused or
  // sought, the very start). This is process liveness, not network traffic,
  // and never counts as room activity.
  db.exec(`
    CREATE TABLE IF NOT EXISTS server_liveness (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      lastAliveMs INTEGER NOT NULL
    )
  `);

  // Append-only structured observability log (see server/src/logging.ts) —
  // every row is one meaningful action (ROOM_CREATE, VOTE_CAST, ...), never a
  // full request/response dump, and deliberately carries no displayName,
  // clientId or socketId (CLAUDE.md: "Do not log unnecessary personal
  // information" / "Do not persist socket IDs or transient UI state").
  db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp  TEXT NOT NULL,
      action     TEXT NOT NULL,
      result     TEXT NOT NULL,
      roomId     TEXT,
      accountId  TEXT,
      proposalId TEXT,
      playbackId TEXT,
      revision   INTEGER,
      detail     TEXT
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS logs_room_idx ON logs(roomId)
  `);

  // Supports logging.ts's pruneOldLogs, which deletes by timestamp on every
  // logAction call (a 20-minute retention window — see logging.ts).
  db.exec(`
    CREATE INDEX IF NOT EXISTS logs_timestamp_idx ON logs(timestamp)
  `);

  return db;
}
