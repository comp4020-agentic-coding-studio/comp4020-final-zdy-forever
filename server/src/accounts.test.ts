import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAccountByClientId, registerAccount } from "./accounts.ts";
import { openDatabase } from "./db.ts";

describe("accounts", () => {
  let dir: string;
  let dbPath: string;
  let db: DatabaseSync;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "echo-room-accounts-"));
    dbPath = path.join(dir, "echo-room.sqlite");
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    // A couple of tests close `db` themselves to reopen the same file, so
    // this may already be closed.
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("gives each distinct client a unique accountId", () => {
    const a = registerAccount(db, "client-a", "Alex");
    const b = registerAccount(db, "client-b", "Blair");

    expect(a.accountId).not.toBe(b.accountId);
  });

  it("is idempotent per clientId: re-registering the same client returns the same account", () => {
    const first = registerAccount(db, "client-a", "Alex");
    const second = registerAccount(db, "client-a", "Alex");

    expect(second.accountId).toBe(first.accountId);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it("allows duplicate displayNames across different accounts", () => {
    const a = registerAccount(db, "client-a", "Sam");
    const b = registerAccount(db, "client-b", "Sam");

    expect(a.accountId).not.toBe(b.accountId);
    expect(a.displayName).toBe("Sam");
    expect(b.displayName).toBe("Sam");
  });

  it("persists accounts across a database reopen", () => {
    const created = registerAccount(db, "client-a", "Alex");
    db.close();

    const reopened = openDatabase(dbPath);
    const found = getAccountByClientId(reopened, "client-a");
    reopened.close();

    expect(found).toEqual(created);
  });

  it("re-initializes the same schema on an existing database file without error or data loss", () => {
    registerAccount(db, "client-a", "Alex");
    db.close();

    // openDatabase runs CREATE TABLE IF NOT EXISTS every time, so reopening
    // an already-initialized file must not throw or lose data.
    const reopened = openDatabase(dbPath);
    const found = getAccountByClientId(reopened, "client-a");
    reopened.close();

    expect(found?.displayName).toBe("Alex");
  });
});
