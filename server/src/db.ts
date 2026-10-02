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

  // This process is both the only writer and the thing relaying real-time
  // playback sync — node:sqlite's calls are synchronous, so every write
  // blocks the single event loop that also has to promptly relay every other
  // room's proposal/playback/presence events. Under SQLite's default rollback
  // journal, each commit takes an exclusive lock on the *whole* database file
  // and fsyncs to disk, so one room's vote/chat/join can stall delivery for
  // every other room on the same process — more concurrent activity (more
  // people, across one room or many) means more frequent, longer stalls,
  // which is what actually shows up as video stutter (CLAUDE.md's Reliability
  // section: "assume users act concurrently"). WAL mode turns a commit into a
  // sequential append instead, and NORMAL durability (still fully safe: WAL
  // never corrupts on a crash, it can just lose the last unforced commit) is
  // SQLite's own documented pairing for this — this combination is the
  // standard fix for "many small writers on one connection," not something
  // specific to this app. A no-op for an in-memory database (`:memory:`),
  // which SQLite never puts in WAL mode regardless of this pragma.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

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
      roomNumber   TEXT,
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
  if (!existingRoomColumns.has("roomNumber")) {
    db.exec("ALTER TABLE rooms ADD COLUMN roomNumber TEXT");
  }
  db.exec("UPDATE rooms SET autoCloseEnabled = 1 WHERE autoCloseEnabled = 0");

  // A code (PRIVATE rooms, 6 digits) or roomNumber (PUBLIC rooms, 7 digits —
  // a quick-join shortcut so a crowded lobby never needs to be scrolled) is
  // exclusive only while its room is active (closed = 0), so a closed room's
  // code/number is free for a new room to reuse. Distinct digit counts mean
  // the two can never collide with each other, so one input field can always
  // tell which table to look in just from what was typed (server/src/index.ts's
  // join-by-code handler).
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS rooms_active_code
      ON rooms(code)
      WHERE closed = 0 AND code IS NOT NULL
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS rooms_active_number
      ON rooms(roomNumber)
      WHERE closed = 0 AND roomNumber IS NOT NULL
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
  // revision} to detect staleness (see isStaleReference). djAccountId is a
  // nullable handoff override; NULL uses the current queue item's adder.
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
  if (!existingColumns.has("djAccountId")) {
    db.exec("ALTER TABLE room_playback ADD COLUMN djAccountId TEXT REFERENCES accounts(accountId)");
  }
  if (!existingColumns.has("status")) {
    db.exec("ALTER TABLE room_playback ADD COLUMN status TEXT NOT NULL DEFAULT 'PAUSED'");
    db.exec("ALTER TABLE room_playback ADD COLUMN anchorPositionMs INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE room_playback ADD COLUMN anchorServerTimeMs INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE room_playback ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
  }

  // (A reorder_tokens table may still exist in an older database: reorders
  // used to be rationed by tokens, which docs/adr/0005 removed. Nothing reads
  // or writes it any more.)

  // Reaction playback/echoes were replaced by room chat. Remove old storage
  // when opening an existing database as well as on fresh installations.
  db.exec("DROP TABLE IF EXISTS reactions");
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      messageId TEXT PRIMARY KEY,
      roomId TEXT NOT NULL REFERENCES rooms(roomId) ON DELETE CASCADE,
      accountId TEXT NOT NULL REFERENCES accounts(accountId),
      displayName TEXT NOT NULL,
      text TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_messages_room ON chat_messages(roomId);

    -- Closure and deletion of history must be one atomic operation, regardless
    -- of whether the room is closed by the sweep or another server code path.
    CREATE TRIGGER IF NOT EXISTS delete_chat_on_room_close
    AFTER UPDATE OF closed ON rooms WHEN NEW.closed = 1
    BEGIN
      DELETE FROM chat_messages WHERE roomId = NEW.roomId;
    END;
    CREATE TRIGGER IF NOT EXISTS reject_chat_in_closed_room
    BEFORE INSERT ON chat_messages
    WHEN NOT EXISTS (SELECT 1 FROM rooms WHERE roomId = NEW.roomId AND closed = 0)
    BEGIN
      SELECT RAISE(ABORT, 'room is closed');
    END;
    DELETE FROM chat_messages WHERE roomId IN (SELECT roomId FROM rooms WHERE closed = 1);
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
