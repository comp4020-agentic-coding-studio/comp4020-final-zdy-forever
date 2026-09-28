import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAccount } from "./accounts.ts";
import { openDatabase } from "./db.ts";
import { createRoom, generateActiveRoomCode, getRoomById, MAX_ROOM_USERS } from "./rooms.ts";

describe("rooms", () => {
  let dir: string;
  let dbPath: string;
  let db: DatabaseSync;
  let creatorAccountId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "echo-room-rooms-"));
    dbPath = path.join(dir, "echo-room.sqlite");
    db = openDatabase(dbPath);
    creatorAccountId = registerAccount(db, "client-creator", "Host").accountId;
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed by a test that reopens the file
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a public room with a stable roomId and no code", () => {
    const room = createRoom(db, {
      accountId: creatorAccountId,
      name: "Friday hangout",
      visibility: "PUBLIC",
      autoCloseEnabled: false,
    });

    expect(room.roomId).toBeTruthy();
    expect(room.code).toBeNull();
    expect(room.visibility).toBe("PUBLIC");
    expect(room.creatorAccountId).toBe(creatorAccountId);
    expect(room.maxUsers).toBe(MAX_ROOM_USERS);
    expect(room.closed).toBe(false);
    expect(room.lastMeaningfulActivityAt).toBe(room.createdAt);
  });

  it("creates a private room with a 6-digit numeric code", () => {
    const room = createRoom(db, {
      accountId: creatorAccountId,
      name: "Secret room",
      visibility: "PRIVATE",
      autoCloseEnabled: true,
    });

    expect(room.code).toMatch(/^\d{6}$/);
    expect(room.autoCloseEnabled).toBe(true);
  });

  it("assigns distinct roomIds to rooms created back to back", () => {
    const a = createRoom(db, { accountId: creatorAccountId, name: "A", visibility: "PUBLIC", autoCloseEnabled: false });
    const b = createRoom(db, { accountId: creatorAccountId, name: "B", visibility: "PUBLIC", autoCloseEnabled: false });

    expect(a.roomId).not.toBe(b.roomId);
  });

  it("rejects a second active room claiming a code already held by an active room", () => {
    const first = createRoom(db, {
      accountId: creatorAccountId,
      name: "First",
      visibility: "PRIVATE",
      autoCloseEnabled: false,
    });

    expect(() =>
      db
        .prepare(
          `INSERT INTO rooms
             (roomId, name, creatorAccountId, visibility, code, maxUsers, autoCloseEnabled, createdAt, lastMeaningfulActivityAt, closed)
           VALUES ('room-2', 'Second', ?, 'PRIVATE', ?, 12, 0, datetime('now'), datetime('now'), 0)`,
        )
        .run(creatorAccountId, first.code),
    ).toThrow();
  });

  it("retries code generation past a collision with another active room's code", () => {
    const taken = createRoom(db, {
      accountId: creatorAccountId,
      name: "Taken",
      visibility: "PRIVATE",
      autoCloseEnabled: false,
    }).code as string;

    const codes = [taken, "654321"];
    const code = generateActiveRoomCode(db, () => codes.shift() as string);

    expect(code).toBe("654321");
  });

  it("allows a closed room's code to be reused by a new active room", () => {
    const closedOne = createRoom(db, {
      accountId: creatorAccountId,
      name: "Old room",
      visibility: "PRIVATE",
      autoCloseEnabled: false,
    });
    db.prepare("UPDATE rooms SET closed = 1 WHERE roomId = ?").run(closedOne.roomId);

    // Not a collision once the holder is closed, so this must be accepted on
    // the first attempt rather than retried away.
    const code = generateActiveRoomCode(db, () => closedOne.code as string);
    expect(code).toBe(closedOne.code);

    const reused = createRoom(db, {
      accountId: creatorAccountId,
      name: "New room",
      visibility: "PRIVATE",
      autoCloseEnabled: false,
    });
    db.prepare("UPDATE rooms SET code = ? WHERE roomId = ?").run(closedOne.code, reused.roomId);

    expect(getRoomById(db, reused.roomId)?.code).toBe(closedOne.code);
  });

  it("persists rooms across a database reopen", () => {
    const created = createRoom(db, {
      accountId: creatorAccountId,
      name: "Persistent room",
      visibility: "PRIVATE",
      autoCloseEnabled: true,
    });
    db.close();

    const reopened = openDatabase(dbPath);
    const found = getRoomById(reopened, created.roomId);
    reopened.close();

    expect(found).toEqual(created);
  });
});
