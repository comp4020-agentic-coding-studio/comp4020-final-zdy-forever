import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAccount } from "./accounts.ts";
import { openDatabase } from "./db.ts";
import {
  AUTO_CLOSE_INACTIVITY_MS,
  createRoom,
  generateActiveRoomCode,
  generateActiveRoomNumber,
  getActiveRoomByCode,
  getActiveRoomByNumber,
  getRoomById,
  isAutoCloseDue,
  isRoomMember,
  joinRoom,
  listPublicLobby,
  MAX_ROOM_USERS,
  RoomClosedError,
  RoomNotFoundError,
  touchRoomActivity,
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
    // PUBLIC rooms get the 7-digit quick-join number instead of a code.
    expect(room.roomNumber).toMatch(/^\d{7}$/);
    expect(room.visibility).toBe("PUBLIC");
    expect(room.creatorAccountId).toBe(creatorAccountId);
    expect(room.maxUsers).toBe(MAX_ROOM_USERS);
    expect(room.closed).toBe(false);
    expect(room.lastMeaningfulActivityAt).toBe(room.createdAt);
  });

  it("creates a private room with a 6-digit numeric code, and no room number", () => {
    const room = createRoom(db, {
      accountId: creatorAccountId,
      name: "Secret room",
      visibility: "PRIVATE",
      autoCloseEnabled: true,
    });

    expect(room.code).toMatch(/^\d{6}$/);
    expect(room.roomNumber).toBeNull();
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

  it("retries room-number generation past a collision with another active room's number", () => {
    const taken = createRoom(db, {
      accountId: creatorAccountId,
      name: "Taken",
      visibility: "PUBLIC",
      autoCloseEnabled: false,
    }).roomNumber as string;

    const numbers = [taken, "7654321"];
    const roomNumber = generateActiveRoomNumber(db, () => numbers.shift() as string);

    expect(roomNumber).toBe("7654321");
  });

  it("allows a closed room's number to be reused by a new active room", () => {
    const closedOne = createRoom(db, {
      accountId: creatorAccountId,
      name: "Old room",
      visibility: "PUBLIC",
      autoCloseEnabled: false,
    });
    db.prepare("UPDATE rooms SET closed = 1 WHERE roomId = ?").run(closedOne.roomId);

    const roomNumber = generateActiveRoomNumber(db, () => closedOne.roomNumber as string);
    expect(roomNumber).toBe(closedOne.roomNumber);
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

  it("records a joining account as a member of the room", () => {
    const room = createRoom(db, {
      accountId: creatorAccountId,
      name: "Public room",
      visibility: "PUBLIC",
      autoCloseEnabled: false,
    });
    const joinerId = registerAccount(db, "client-joiner", "Joiner").accountId;
    expect(isRoomMember(db, room.roomId, joinerId)).toBe(false);

    const joined = joinRoom(db, room.roomId, joinerId);

    expect(joined.roomId).toBe(room.roomId);
    expect(isRoomMember(db, room.roomId, joinerId)).toBe(true);
  });

  it("admits the creator as a member of their own room, private or not", () => {
    const room = createRoom(db, {
      accountId: creatorAccountId,
      name: "Secret",
      visibility: "PRIVATE",
      autoCloseEnabled: false,
    });

    expect(isRoomMember(db, room.roomId, creatorAccountId)).toBe(true);
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
    joinRoom(db, room.roomId, joinerId);

    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM room_participants WHERE roomId = ? AND accountId = ?")
      .get(room.roomId, joinerId) as { n: number };
    expect(rows.n).toBe(1);
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

  // Regression: membership used to double as capacity, so a room whose
  // twelfth visitor had come and gone stayed full forever. Capacity is now
  // live presence (see presence.test.ts and realtime.test.ts's capacity
  // tests); membership just keeps growing as people visit.
  it("never caps membership: more than maxUsers accounts can join over a room's lifetime", () => {
    const room = createRoom(db, {
      accountId: creatorAccountId,
      name: "Busy room",
      visibility: "PUBLIC",
      autoCloseEnabled: false,
    });

    for (let i = 0; i <= MAX_ROOM_USERS; i++) {
      const accountId = registerAccount(db, `client-visitor-${i}`, `Visitor ${i}`).accountId;
      joinRoom(db, room.roomId, accountId);
      expect(isRoomMember(db, room.roomId, accountId)).toBe(true);
    }
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

  it("finds an active public room by its room number", () => {
    const room = createRoom(db, {
      accountId: creatorAccountId,
      name: "Open room",
      visibility: "PUBLIC",
      autoCloseEnabled: false,
    });

    const found = getActiveRoomByNumber(db, room.roomNumber as string);
    expect(found?.roomId).toBe(room.roomId);
  });

  it("returns undefined for a room number that does not belong to any active room", () => {
    expect(getActiveRoomByNumber(db, "0000000")).toBeUndefined();
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

    const lobby = listPublicLobby(db, (roomId) => (roomId === publicRoom.roomId ? 1 : 0));

    expect(lobby).toHaveLength(1);
    expect(lobby[0]).toEqual({
      roomId: publicRoom.roomId,
      name: "Open room",
      roomNumber: publicRoom.roomNumber,
      occupancy: 1,
      capacity: MAX_ROOM_USERS,
      joinable: true,
    });
  });

  it("reports a room as not joinable in the lobby only while it's full right now", () => {
    const room = createRoom(db, {
      accountId: creatorAccountId,
      name: "Popular room",
      visibility: "PUBLIC",
      autoCloseEnabled: false,
    });

    expect(listPublicLobby(db, () => MAX_ROOM_USERS)[0]).toMatchObject({ roomId: room.roomId, joinable: false });
    expect(listPublicLobby(db, () => MAX_ROOM_USERS - 1)[0]).toMatchObject({ roomId: room.roomId, joinable: true });
  });

  // CLAUDE.md's Rooms section: "auto close after 7 days of inactivity,"
  // restart-safe, using timestamps rather than in-memory timers — every test
  // here drives the clock with an explicit nowMs rather than a real timer.
  describe("auto-close inactivity", () => {
    const T0 = 1_700_000_000_000;

    it("isAutoCloseDue is false before the window elapses and true once it has", () => {
      const room = createRoom(db, {
        accountId: creatorAccountId,
        name: "Idle room",
        visibility: "PUBLIC",
        autoCloseEnabled: true,
      });
      const created = Date.parse(room.createdAt);

      expect(isAutoCloseDue(room, created + AUTO_CLOSE_INACTIVITY_MS - 1)).toBe(false);
      expect(isAutoCloseDue(room, created + AUTO_CLOSE_INACTIVITY_MS)).toBe(true);
      expect(isAutoCloseDue(room, created + AUTO_CLOSE_INACTIVITY_MS + 1_000_000)).toBe(true);
    });

    it("cannot disable automatic closure via an older client's request", () => {
      const room = createRoom(db, {
        accountId: creatorAccountId,
        name: "Forever room",
        visibility: "PUBLIC",
        autoCloseEnabled: false,
      });
      const created = Date.parse(room.createdAt);

      expect(room.autoCloseEnabled).toBe(true);
      expect(isAutoCloseDue(room, created + AUTO_CLOSE_INACTIVITY_MS)).toBe(true);
    });

    it("isAutoCloseDue is always false for a room already marked closed", () => {
      const room = createRoom(db, {
        accountId: creatorAccountId,
        name: "Already closed",
        visibility: "PUBLIC",
        autoCloseEnabled: true,
      });
      const created = Date.parse(room.createdAt);

      expect(isAutoCloseDue({ ...room, closed: true }, created + AUTO_CLOSE_INACTIVITY_MS * 100)).toBe(false);
    });

    it("getRoomById persists closure once the inactivity window has elapsed, purely from the stored timestamp", () => {
      const room = createRoom(db, {
        accountId: creatorAccountId,
        name: "Auto-close room",
        visibility: "PUBLIC",
        autoCloseEnabled: true,
      });
      db.prepare("UPDATE rooms SET lastMeaningfulActivityAt = ? WHERE roomId = ?").run(
        new Date(T0).toISOString(),
        room.roomId,
      );

      // Still within the window: not yet closed.
      const stillOpen = getRoomById(db, room.roomId, T0 + AUTO_CLOSE_INACTIVITY_MS - 1);
      expect(stillOpen?.closed).toBe(false);

      // The window has elapsed: the very first read after expiry both
      // reports and persists the closure.
      const nowClosed = getRoomById(db, room.roomId, T0 + AUTO_CLOSE_INACTIVITY_MS);
      expect(nowClosed?.closed).toBe(true);

      // Persisted, not just returned: a later read with no sweep needed still
      // reports closed, and a raw row confirms the DB column itself flipped.
      const raw = db.prepare("SELECT closed FROM rooms WHERE roomId = ?").get(room.roomId) as { closed: number };
      expect(raw.closed).toBe(1);
    });

    it("sweeps legacy rooms even if their stored auto-close flag is off", () => {
      const room = createRoom(db, {
        accountId: creatorAccountId,
        name: "Never auto-closes",
        visibility: "PUBLIC",
        autoCloseEnabled: false,
      });
      db.prepare("UPDATE rooms SET lastMeaningfulActivityAt = ? WHERE roomId = ?").run(
        new Date(T0).toISOString(),
        room.roomId,
      );

      db.prepare("UPDATE rooms SET autoCloseEnabled = 0 WHERE roomId = ?").run(room.roomId);
      const found = getRoomById(db, room.roomId, T0 + AUTO_CLOSE_INACTIVITY_MS);
      expect(found?.closed).toBe(true);
    });

    it("touchRoomActivity delays closure by resetting the inactivity window", () => {
      const room = createRoom(db, {
        accountId: creatorAccountId,
        name: "Kept alive",
        visibility: "PUBLIC",
        autoCloseEnabled: true,
      });
      db.prepare("UPDATE rooms SET lastMeaningfulActivityAt = ? WHERE roomId = ?").run(
        new Date(T0).toISOString(),
        room.roomId,
      );

      // Meaningful activity lands just before the original window would have
      // expired.
      const activityAt = T0 + AUTO_CLOSE_INACTIVITY_MS - 1_000;
      touchRoomActivity(db, room.roomId, activityAt);

      // The original expiry instant no longer closes the room...
      const stillOpen = getRoomById(db, room.roomId, T0 + AUTO_CLOSE_INACTIVITY_MS);
      expect(stillOpen?.closed).toBe(false);

      // ...but a full fresh window after the new activity does.
      const nowClosed = getRoomById(db, room.roomId, activityAt + AUTO_CLOSE_INACTIVITY_MS);
      expect(nowClosed?.closed).toBe(true);
    });

    it("getActiveRoomByCode sweeps and then correctly reports no active match for an auto-closed code", () => {
      const room = createRoom(db, {
        accountId: creatorAccountId,
        name: "Private idle room",
        visibility: "PRIVATE",
        autoCloseEnabled: true,
      });
      const code = room.code as string;
      db.prepare("UPDATE rooms SET lastMeaningfulActivityAt = ? WHERE roomId = ?").run(
        new Date(T0).toISOString(),
        room.roomId,
      );

      expect(getActiveRoomByCode(db, code, T0 + AUTO_CLOSE_INACTIVITY_MS)).toBeUndefined();
    });

    it("generateActiveRoomCode treats an auto-closed room's code as free", () => {
      const stale = createRoom(db, {
        accountId: creatorAccountId,
        name: "Stale code holder",
        visibility: "PRIVATE",
        autoCloseEnabled: true,
      });
      db.prepare("UPDATE rooms SET lastMeaningfulActivityAt = ? WHERE roomId = ?").run(
        new Date(T0).toISOString(),
        stale.roomId,
      );

      const code = generateActiveRoomCode(db, () => stale.code as string, T0 + AUTO_CLOSE_INACTIVITY_MS);
      expect(code).toBe(stale.code);
    });

    it("listPublicLobby excludes a room the moment its inactivity window elapses", () => {
      const room = createRoom(db, {
        accountId: creatorAccountId,
        name: "Fading room",
        visibility: "PUBLIC",
        autoCloseEnabled: true,
      });
      db.prepare("UPDATE rooms SET lastMeaningfulActivityAt = ? WHERE roomId = ?").run(
        new Date(T0).toISOString(),
        room.roomId,
      );

      expect(listPublicLobby(db, () => 0, T0 + AUTO_CLOSE_INACTIVITY_MS - 1)).toHaveLength(1);
      expect(listPublicLobby(db, () => 0, T0 + AUTO_CLOSE_INACTIVITY_MS)).toHaveLength(0);
    });

    it("joinRoom rejects an auto-closed room with RoomClosedError, exactly like a manually closed room", () => {
      const room = createRoom(db, {
        accountId: creatorAccountId,
        name: "Went quiet",
        visibility: "PUBLIC",
        autoCloseEnabled: true,
      });
      db.prepare("UPDATE rooms SET lastMeaningfulActivityAt = ? WHERE roomId = ?").run(
        new Date(T0).toISOString(),
        room.roomId,
      );
      const joinerId = registerAccount(db, "client-late-joiner", "Late joiner").accountId;

      expect(() => joinRoom(db, room.roomId, joinerId, T0 + AUTO_CLOSE_INACTIVITY_MS)).toThrow(RoomClosedError);
    });

    it("auto-close is restart-safe: a server restart between the last activity and now still closes the room on first read", () => {
      const room = createRoom(db, {
        accountId: creatorAccountId,
        name: "Restart room",
        visibility: "PUBLIC",
        autoCloseEnabled: true,
      });
      db.prepare("UPDATE rooms SET lastMeaningfulActivityAt = ? WHERE roomId = ?").run(
        new Date(T0).toISOString(),
        room.roomId,
      );

      // Simulate the process restarting: close this handle and reopen the
      // same file, with nothing in memory carried over.
      db.close();
      const reopened = openDatabase(dbPath);

      const found = getRoomById(reopened, room.roomId, T0 + AUTO_CLOSE_INACTIVITY_MS + 60_000);
      expect(found?.closed).toBe(true);

      db = reopened;
    });

    it("auto-closing a room never deletes its historical persisted data — only the closed flag changes", () => {
      const room = createRoom(db, {
        accountId: creatorAccountId,
        name: "Rich history room",
        visibility: "PUBLIC",
        autoCloseEnabled: true,
      });
      const joinerId = registerAccount(db, "client-history-joiner", "History joiner").accountId;
      joinRoom(db, room.roomId, joinerId, T0);
      db.prepare("UPDATE rooms SET lastMeaningfulActivityAt = ? WHERE roomId = ?").run(
        new Date(T0).toISOString(),
        room.roomId,
      );

      const closed = getRoomById(db, room.roomId, T0 + AUTO_CLOSE_INACTIVITY_MS);
      expect(closed?.closed).toBe(true);

      // The room row itself is still there (only closed flipped), and the
      // membership row from before closure is untouched.
      const rawRoom = db.prepare("SELECT roomId, name FROM rooms WHERE roomId = ?").get(room.roomId);
      expect(rawRoom).toEqual({ roomId: room.roomId, name: "Rich history room" });
      expect(isRoomMember(db, room.roomId, joinerId)).toBe(true);
    });
  });
});
