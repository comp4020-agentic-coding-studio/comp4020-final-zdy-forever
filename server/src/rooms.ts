import { randomInt, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CreateRoomRequest, JoinRoomResult, LobbyRoom, Room } from "../../shared/src/types.ts";

export class RoomNotFoundError extends Error {}
export class RoomClosedError extends Error {}
export class RoomFullError extends Error {}

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

// Only ever matches an active room: closed rooms free their code (see the
// rooms_active_code index), so a code that once belonged to a since-closed
// room correctly reports no match here.
export function getActiveRoomByCode(db: DatabaseSync, code: string): Room | undefined {
  const row = db.prepare("SELECT * FROM rooms WHERE code = ? AND closed = 0").get(code);
  return row ? rowToRoom(row) : undefined;
}

export function getOccupancy(db: DatabaseSync, roomId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM room_participants WHERE roomId = ?").get(roomId) as {
    n: number;
  };
  return row.n;
}

export function listPublicLobby(db: DatabaseSync): LobbyRoom[] {
  const rows = db
    .prepare(
      `SELECT roomId, name, maxUsers,
              (SELECT COUNT(*) FROM room_participants WHERE roomId = rooms.roomId) AS occupancy
         FROM rooms
        WHERE visibility = 'PUBLIC' AND closed = 0
        ORDER BY createdAt ASC`,
    )
    .all() as { roomId: string; name: string; maxUsers: number; occupancy: number }[];

  return rows.map((r) => ({
    roomId: r.roomId,
    name: r.name,
    occupancy: r.occupancy,
    capacity: r.maxUsers,
    joinable: r.occupancy < r.maxUsers,
  }));
}

// The capacity check and the participant insert are one SQL statement, not a
// separate SELECT-then-INSERT: node:sqlite is fully synchronous and nothing
// here ever awaits, so no other request can interleave between "check" and
// "write" in this single-threaded process. That makes the race structurally
// impossible rather than merely unlikely — see rooms.test.ts's concurrent
// join test.
export function joinRoom(db: DatabaseSync, roomId: string, accountId: string): JoinRoomResult {
  const room = getRoomById(db, roomId);
  if (!room) throw new RoomNotFoundError(`no room with id ${roomId}`);
  if (room.closed) throw new RoomClosedError(`room ${roomId} is closed`);

  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO room_participants (roomId, accountId, joinedAt)
       SELECT ?, ?, ?
        WHERE (SELECT COUNT(*) FROM room_participants WHERE roomId = ?) < ?
          AND NOT EXISTS (SELECT 1 FROM room_participants WHERE roomId = ? AND accountId = ?)`,
    )
    .run(roomId, accountId, now, roomId, room.maxUsers, roomId, accountId);

  if (result.changes === 0) {
    // The insert only ever no-ops for one of two reasons: the room was
    // already full, or this account is already a participant (idempotent
    // re-join, which is not an error).
    const alreadyJoined = db
      .prepare("SELECT 1 FROM room_participants WHERE roomId = ? AND accountId = ?")
      .get(roomId, accountId);
    if (!alreadyJoined) {
      throw new RoomFullError(`room ${roomId} is full`);
    }
  }

  return { room, occupancy: getOccupancy(db, roomId) };
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
