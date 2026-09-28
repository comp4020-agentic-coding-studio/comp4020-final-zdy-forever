import { randomInt, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CreateRoomRequest, Room } from "../../shared/src/types.ts";

// Fixed by course spec, not something a creator can configure.
export const MAX_ROOM_USERS = 12;

function randomSixDigitCode(): string {
  return String(randomInt(1_000_000)).padStart(6, "0");
}

// A code is exclusive only among currently-active (non-closed) rooms — see
// the rooms_active_code index in db.ts, which is the authority under
// concurrent writers. This retries past a collision it observes; `generate`
// is overridable so tests can force one deterministically.
export function generateActiveRoomCode(
  db: DatabaseSync,
  generate: () => string = randomSixDigitCode,
): string {
  const isTaken = db.prepare("SELECT 1 FROM rooms WHERE code = ? AND closed = 0");
  for (let attempt = 0; attempt < 100; attempt++) {
    const code = generate();
    if (!isTaken.get(code)) return code;
  }
  throw new Error("could not find a free 6-digit room code after 100 attempts");
}

function rowToRoom(row: unknown): Room {
  const r = row as {
    roomId: string;
    name: string;
    creatorAccountId: string;
    visibility: "PUBLIC" | "PRIVATE";
    code: string | null;
    maxUsers: number;
    autoCloseEnabled: number;
    createdAt: string;
    lastMeaningfulActivityAt: string;
    closed: number;
  };
  return {
    roomId: r.roomId,
    name: r.name,
    creatorAccountId: r.creatorAccountId,
    visibility: r.visibility,
    code: r.code,
    maxUsers: r.maxUsers,
    autoCloseEnabled: r.autoCloseEnabled === 1,
    createdAt: r.createdAt,
    lastMeaningfulActivityAt: r.lastMeaningfulActivityAt,
    closed: r.closed === 1,
  };
}

export function getRoomById(db: DatabaseSync, roomId: string): Room | undefined {
  const row = db.prepare("SELECT * FROM rooms WHERE roomId = ?").get(roomId);
  return row ? rowToRoom(row) : undefined;
}

export function createRoom(db: DatabaseSync, request: CreateRoomRequest): Room {
  const now = new Date().toISOString();
  const code = request.visibility === "PRIVATE" ? generateActiveRoomCode(db) : null;

  const room: Room = {
    roomId: randomUUID(),
    name: request.name,
    creatorAccountId: request.accountId,
    visibility: request.visibility,
    code,
    maxUsers: MAX_ROOM_USERS,
    autoCloseEnabled: request.autoCloseEnabled,
    createdAt: now,
    lastMeaningfulActivityAt: now,
    closed: false,
  };

  db.prepare(
    `INSERT INTO rooms
       (roomId, name, creatorAccountId, visibility, code, maxUsers, autoCloseEnabled, createdAt, lastMeaningfulActivityAt, closed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    room.roomId,
    room.name,
    room.creatorAccountId,
    room.visibility,
    room.code,
    room.maxUsers,
    room.autoCloseEnabled ? 1 : 0,
    room.createdAt,
    room.lastMeaningfulActivityAt,
    room.closed ? 1 : 0,
  );

  return room;
}
