import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAccount } from "./accounts.ts";
import { openDatabase } from "./db.ts";
import {
  createRoom,
  generateActiveRoomCode,
  getActiveRoomByCode,
  getOccupancy,
  getRoomById,
  joinRoom,
  listPublicLobby,
  MAX_ROOM_USERS,
  RoomClosedError,
  RoomFullError,
  RoomNotFoundError,
} from "./rooms.ts";

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

  it("joins a public room and increments occupancy", () => {
    const room = createRoom(db, {
      accountId: creatorAccountId,
      name: "Public room",
      visibility: "PUBLIC",
      autoCloseEnabled: false,
    });
    const joinerId = registerAccount(db, "client-joiner", "Joiner").accountId;

    const result = joinRoom(db, room.roomId, joinerId);

    expect(result.occupancy).toBe(1);
    expect(getOccupancy(db, room.roomId)).toBe(1);
  });

  it("is idempotent when the same account joins twice", () => {
    const room = createRoom(db, {
      accountId: creatorAccountId,
      name: "Public room",
      visibility: "PUBLIC",
      autoCloseEnabled: false,
    });
    const joinerId = registerAccount(db, "client-joiner", "Joiner").accountId;

    joinRoom(db, room.roomId, joinerId);
    const second = joinRoom(db, room.roomId, joinerId);

    expect(second.occupancy).toBe(1);
    expect(getOccupancy(db, room.roomId)).toBe(1);
  });

  it("throws RoomNotFoundError for a nonexistent room", () => {
    expect(() => joinRoom(db, "no-such-room", creatorAccountId)).toThrow(RoomNotFoundError);
  });

  it("throws RoomClosedError for a closed room", () => {
    const room = createRoom(db, {
      accountId: creatorAccountId,
      name: "Closing soon",
      visibility: "PUBLIC",
      autoCloseEnabled: false,
    });
    db.prepare("UPDATE rooms SET closed = 1 WHERE roomId = ?").run(room.roomId);

    expect(() => joinRoom(db, room.roomId, creatorAccountId)).toThrow(RoomClosedError);
  });

  it("throws RoomFullError once maxUsers participants have joined", () => {
    const room = createRoom(db, {
      accountId: creatorAccountId,
      name: "Tiny room",
      visibility: "PUBLIC",
      autoCloseEnabled: false,
    });

    for (let i = 0; i < MAX_ROOM_USERS; i++) {
      const accountId = registerAccount(db, `client-fill-${i}`, `User ${i}`).accountId;
      joinRoom(db, room.roomId, accountId);
    }
    expect(getOccupancy(db, room.roomId)).toBe(MAX_ROOM_USERS);

    const overflowId = registerAccount(db, "client-overflow", "Overflow").accountId;
    expect(() => joinRoom(db, room.roomId, overflowId)).toThrow(RoomFullError);
    expect(getOccupancy(db, room.roomId)).toBe(MAX_ROOM_USERS);
  });

  it("never lets 13 participants into a 12-capacity room under concurrent join attempts", () => {
    const room = createRoom(db, {
      accountId: creatorAccountId,
      name: "Race room",
      visibility: "PUBLIC",
      autoCloseEnabled: false,
    });

    // Seed 11 existing participants, then race two more for the last slot.
    for (let i = 0; i < MAX_ROOM_USERS - 1; i++) {
      const accountId = registerAccount(db, `client-seed-${i}`, `Seed ${i}`).accountId;
      joinRoom(db, room.roomId, accountId);
    }
    expect(getOccupancy(db, room.roomId)).toBe(MAX_ROOM_USERS - 1);

    const racerA = registerAccount(db, "client-racer-a", "Racer A").accountId;
    const racerB = registerAccount(db, "client-racer-b", "Racer B").accountId;

    // node:sqlite is synchronous and joinRoom never awaits, so wrapping each
    // call in a resolved-promise microtask is the closest thing to a genuine
    // "simultaneous" race this single-threaded runtime allows: both attempts
    // are queued before either runs, and the atomic INSERT ... SELECT inside
    // joinRoom is what actually has to hold the line.
    const attempt = (accountId: string) => Promise.resolve().then(() => joinRoom(db, room.roomId, accountId));

    return Promise.allSettled([attempt(racerA), attempt(racerB)]).then((results) => {
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(RoomFullError);
      expect(getOccupancy(db, room.roomId)).toBe(MAX_ROOM_USERS);
    });
  });

  it("finds an active private room by its code", () => {
    const room = createRoom(db, {
      accountId: creatorAccountId,
      name: "Secret",
      visibility: "PRIVATE",
      autoCloseEnabled: false,
    });

    const found = getActiveRoomByCode(db, room.code as string);
    expect(found?.roomId).toBe(room.roomId);
  });

  it("returns undefined for a code that does not belong to any active room", () => {
    expect(getActiveRoomByCode(db, "000000")).toBeUndefined();
  });

  it("lists only PUBLIC, non-closed rooms in the lobby with occupancy/capacity/joinable", () => {
    const publicRoom = createRoom(db, {
      accountId: creatorAccountId,
      name: "Open room",
      visibility: "PUBLIC",
      autoCloseEnabled: false,
    });
    createRoom(db, {
      accountId: creatorAccountId,
      name: "Secret room",
      visibility: "PRIVATE",
      autoCloseEnabled: false,
    });
    const closedRoom = createRoom(db, {
      accountId: creatorAccountId,
      name: "Closed room",
      visibility: "PUBLIC",
      autoCloseEnabled: false,
    });
    db.prepare("UPDATE rooms SET closed = 1 WHERE roomId = ?").run(closedRoom.roomId);

    const joinerId = registerAccount(db, "client-joiner", "Joiner").accountId;
    joinRoom(db, publicRoom.roomId, joinerId);

    const lobby = listPublicLobby(db);

    expect(lobby).toHaveLength(1);
    expect(lobby[0]).toEqual({
      roomId: publicRoom.roomId,
      name: "Open room",
      occupancy: 1,
      capacity: MAX_ROOM_USERS,
      joinable: true,
    });
  });
});
