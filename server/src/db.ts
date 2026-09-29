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
  // is the stable identity of a queue item; rowid is only ever used to
  // recover insertion order for display, never as identity.
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

  return db;
}
