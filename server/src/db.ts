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
      closed       INTEGER NOT NULL DEFAULT 0
    )
  `);

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

  return db;
}
