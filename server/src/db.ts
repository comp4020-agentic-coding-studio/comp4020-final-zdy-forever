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

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      accountId  TEXT PRIMARY KEY,
      clientId   TEXT NOT NULL UNIQUE,
      displayName TEXT NOT NULL,
      createdAt  TEXT NOT NULL
    )
  `);

  return db;
}
