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

  // One row per (roomId, accountId) that has ever touched a reorder token in
  // that room — see shared/src/reorderTokens.ts and docs/adr/0001-reorder-
  // token-scope.md for why balances are scoped per room rather than per
  // account globally. tokens/anchorMs is that pair's last-persisted
  // (balance, anchor) snapshot: tokens is the balance as of anchorMs, not a
  // live value, and every read recomputes forward from it against the
  // current clock (server/src/reorderTokenStore.ts) rather than trusting any
  // in-memory timer. No row at all means "never spent, still at the
  // 5-token cap" — the default is synthesized on read, not pre-inserted for
  // every participant.
  db.exec(`
    CREATE TABLE IF NOT EXISTS reorder_tokens (
      roomId    TEXT NOT NULL REFERENCES rooms(roomId),
      accountId TEXT NOT NULL REFERENCES accounts(accountId),
      tokens    INTEGER NOT NULL,
      anchorMs  INTEGER NOT NULL,
      PRIMARY KEY (roomId, accountId)
    )
  `);

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

  return db;
}
