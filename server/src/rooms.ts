import { randomInt, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CreateRoomRequest, LobbyRoom, Room } from "../../shared/src/types.ts";
import { logAction } from "./logging.ts";

export class RoomNotFoundError extends Error {}
export class RoomClosedError extends Error {}

// Fixed by course spec, not something a creator can configure. Enforced
// against live presence (server/src/presence.ts's canAdmit), never against
// the persisted membership below.
export const MAX_ROOM_USERS = 12;

// CLAUDE.md's Rooms section: "closure after 2 hours of inactivity."
export const AUTO_CLOSE_INACTIVITY_MS = 2 * 60 * 60 * 1000;

function randomSixDigitCode(): string {
  return String(randomInt(1_000_000)).padStart(6, "0");
}

// One more digit than a PRIVATE room's code, so the two can never be
// confused — the join-by-code handler (server/src/index.ts) tells them apart
// purely by how many digits were typed.
function randomSevenDigitNumber(): string {
  return String(randomInt(10_000_000)).padStart(7, "0");
}

// Pure: whether `room` is due to auto-close as of nowMs, given only its own
// lastMeaningfulActivityAt — never itself mutates
// anything, so it's the seam fake-clock tests probe directly. An
// already-closed room is never "due" (closing is one-way).
export function isAutoCloseDue(room: Room, nowMs: number): boolean {
  if (room.closed) return false;
  return nowMs - Date.parse(room.lastMeaningfulActivityAt) >= AUTO_CLOSE_INACTIVITY_MS;
}

// Persists auto-close for every room whose inactivity window has elapsed,
// computed purely from each room's stored lastMeaningfulActivityAt against
// `nowMs` — never an in-memory timer — so the outcome is identical whether
// the server has been running for days or was just restarted a moment ago.
// Called opportunistically (see getRoomById/getActiveRoomByCode/
// listPublicLobby below) rather than on any schedule of its own.
export function sweepInactiveRooms(db: DatabaseSync, nowMs: number): void {
  const candidates = db
    .prepare("SELECT roomId, lastMeaningfulActivityAt FROM rooms WHERE closed = 0")
    .all() as { roomId: string; lastMeaningfulActivityAt: string }[];
  if (candidates.length === 0) return;

  const close = db.prepare("UPDATE rooms SET closed = 1 WHERE roomId = ? AND closed = 0");
  for (const candidate of candidates) {
    if (nowMs - Date.parse(candidate.lastMeaningfulActivityAt) >= AUTO_CLOSE_INACTIVITY_MS) {
      close.run(candidate.roomId);
      // Fires exactly once per room: a swept-closed room drops out of the
      // `closed = 0` candidate set immediately, so it can never be selected
      // (and logged) again.
      logAction(db, { action: "ROOM_AUTO_CLOSE", result: "ok", roomId: candidate.roomId }, nowMs);
    }
  }
}

// Bumps a room's lastMeaningfulActivityAt to nowMs — the only thing that
// keeps an auto-close-enabled room open. Callers are exactly CLAUDE.md's
// meaningful-activity list (join, track add, proposal create, vote,
// successful shared playback action, successful reorder, chat message) — never
// heartbeat/presence/polling/background traffic. A no-op against an
// already-closed room: activity can never reopen a closed room.
export function touchRoomActivity(db: DatabaseSync, roomId: string, nowMs: number = Date.now()): void {
  db.prepare("UPDATE rooms SET lastMeaningfulActivityAt = ? WHERE roomId = ? AND closed = 0").run(
    new Date(nowMs).toISOString(),
    roomId,
  );
}

// A code/number is exclusive only among currently-active (non-closed) rooms
// — see the rooms_active_code/rooms_active_number indexes in db.ts, which are
// the authority under concurrent writers. This retries past a collision it
// observes. Sweeps first so a token held by a room that has just gone
// auto-close-inactive is correctly treated as free rather than as a live
// collision. Shared by generateActiveRoomCode (code, 6 digits, PRIVATE rooms)
// and generateActiveRoomNumber (roomNumber, 7 digits, PUBLIC rooms) below —
// `column` is always one of those two fixed literals, never user input.
function generateActiveRoomToken(
  db: DatabaseSync,
  column: "code" | "roomNumber",
  generate: () => string,
  nowMs: number,
): string {
  sweepInactiveRooms(db, nowMs);
  const isTaken = db.prepare(`SELECT 1 FROM rooms WHERE ${column} = ? AND closed = 0`);
  for (let attempt = 0; attempt < 100; attempt++) {
    const token = generate();
    if (!isTaken.get(token)) return token;
  }
  throw new Error(`could not find a free ${column} after 100 attempts`);
}

// `generate` is overridable so tests can force a value deterministically.
export function generateActiveRoomCode(
  db: DatabaseSync,
  generate: () => string = randomSixDigitCode,
  nowMs: number = Date.now(),
): string {
  return generateActiveRoomToken(db, "code", generate, nowMs);
}

// PUBLIC rooms' 7-digit quick-join shortcut — otherwise identical in spirit
// to generateActiveRoomCode. See the rooms_active_number index comment in
// db.ts for why the two never collide with each other.
export function generateActiveRoomNumber(
  db: DatabaseSync,
  generate: () => string = randomSevenDigitNumber,
  nowMs: number = Date.now(),
): string {
  return generateActiveRoomToken(db, "roomNumber", generate, nowMs);
}

function rowToRoom(row: unknown): Room {
  const r = row as {
    roomId: string;
    name: string;
    creatorAccountId: string;
    visibility: "PUBLIC" | "PRIVATE";
    code: string | null;
    roomNumber: string | null;
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
    roomNumber: r.roomNumber,
    maxUsers: r.maxUsers,
    autoCloseEnabled: true,
    createdAt: r.createdAt,
    lastMeaningfulActivityAt: r.lastMeaningfulActivityAt,
    closed: r.closed === 1,
  };
}

// Sweeps for auto-close inactivity before reading, so a room whose 2-hour
// window has elapsed reports closed: true here even if nothing had touched
// it since — the very first read after expiry is what persists the closure.
export function getRoomById(db: DatabaseSync, roomId: string, nowMs: number = Date.now()): Room | undefined {
  sweepInactiveRooms(db, nowMs);
  const row = db.prepare("SELECT * FROM rooms WHERE roomId = ?").get(roomId);
  return row ? rowToRoom(row) : undefined;
}

// Only ever matches an active room: closed rooms (including one just swept
// closed for inactivity) free their code (see the rooms_active_code index),
// so a code that once belonged to a since-closed room correctly reports no
// match here.
export function getActiveRoomByCode(db: DatabaseSync, code: string, nowMs: number = Date.now()): Room | undefined {
  sweepInactiveRooms(db, nowMs);
  const row = db.prepare("SELECT * FROM rooms WHERE code = ? AND closed = 0").get(code);
  return row ? rowToRoom(row) : undefined;
}

// PUBLIC rooms' equivalent of getActiveRoomByCode — a 7-digit roomNumber is
// only ever set on a PUBLIC room (see createRoom), so this can never surface
// a PRIVATE one; server/src/index.ts's join-by-code handler still double-checks
// visibility defensively anyway.
export function getActiveRoomByNumber(db: DatabaseSync, roomNumber: string, nowMs: number = Date.now()): Room | undefined {
  sweepInactiveRooms(db, nowMs);
  const row = db.prepare("SELECT * FROM rooms WHERE roomNumber = ? AND closed = 0").get(roomNumber);
  return row ? rowToRoom(row) : undefined;
}

// room_participants records which accounts have been admitted to a room —
// its creator, and anyone who has joined it (for a PRIVATE room, only ever by
// its 6-digit code). It is membership, not presence: nothing is removed when
// someone leaves, and it's never what capacity is counted against (see
// MAX_ROOM_USERS). What it gates is re-entry: a PRIVATE room's socket join
// requires it (server/src/realtime.ts), so a bare roomId never gets anyone in.
export function isRoomMember(db: DatabaseSync, roomId: string, accountId: string): boolean {
  return db.prepare("SELECT 1 FROM room_participants WHERE roomId = ? AND accountId = ?").get(roomId, accountId) !== undefined;
}

function recordMembership(db: DatabaseSync, roomId: string, accountId: string, nowMs: number): void {
  db.prepare("INSERT OR IGNORE INTO room_participants (roomId, accountId, joinedAt) VALUES (?, ?, ?)").run(
    roomId,
    accountId,
    new Date(nowMs).toISOString(),
  );
}

// occupancyOf is how many people are in a room right now — live presence
// (server/src/presence.ts), which this module has no access to by design, so
// the caller supplies it.
export function listPublicLobby(
  db: DatabaseSync,
  occupancyOf: (roomId: string) => number,
  nowMs: number = Date.now(),
): LobbyRoom[] {
  sweepInactiveRooms(db, nowMs);
  const rows = db
    .prepare(
      `SELECT roomId, name, roomNumber, maxUsers
         FROM rooms
        WHERE visibility = 'PUBLIC' AND closed = 0
        ORDER BY createdAt ASC`,
    )
    .all() as { roomId: string; name: string; roomNumber: string | null; maxUsers: number }[];

  return rows.map((r) => {
    const occupancy = occupancyOf(r.roomId);
    return {
      roomId: r.roomId,
      name: r.name,
      roomNumber: r.roomNumber,
      occupancy,
      capacity: r.maxUsers,
      joinable: occupancy < r.maxUsers,
    };
  });
}

// Admits `accountId` to an open room (idempotently) and counts as meaningful
// activity. It deliberately does not check capacity: that's measured against
// who is present right now, which only the realtime layer knows — callers
// check presence.canAdmit in the same synchronous turn first.
export function joinRoom(db: DatabaseSync, roomId: string, accountId: string, nowMs: number = Date.now()): Room {
  const room = getRoomById(db, roomId, nowMs);
  if (!room) throw new RoomNotFoundError(`no room with id ${roomId}`);
  if (room.closed) throw new RoomClosedError(`room ${roomId} is closed`);

  recordMembership(db, roomId, accountId, nowMs);
  // "join" is meaningful activity (CLAUDE.md's Rooms section) — covers both
  // a fresh join and an idempotent re-join alike.
  touchRoomActivity(db, roomId, nowMs);

  return room;
}

export function createRoom(db: DatabaseSync, request: CreateRoomRequest): Room {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const code = request.visibility === "PRIVATE" ? generateActiveRoomCode(db) : null;
  // PUBLIC rooms get the 7-digit quick-join number instead; PRIVATE rooms
  // never do, symmetrically with PUBLIC rooms never getting a code.
  const roomNumber = request.visibility === "PUBLIC" ? generateActiveRoomNumber(db) : null;

  const room: Room = {
    roomId: randomUUID(),
    name: request.name,
    creatorAccountId: request.accountId,
    visibility: request.visibility,
    code,
    roomNumber,
    maxUsers: MAX_ROOM_USERS,
    autoCloseEnabled: true,
    createdAt: now,
    lastMeaningfulActivityAt: now,
    closed: false,
  };

  db.prepare(
    `INSERT INTO rooms
       (roomId, name, creatorAccountId, visibility, code, roomNumber, maxUsers, autoCloseEnabled, createdAt, lastMeaningfulActivityAt, closed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    room.roomId,
    room.name,
    room.creatorAccountId,
    room.visibility,
    room.code,
    room.roomNumber,
    room.maxUsers,
    room.autoCloseEnabled ? 1 : 0,
    room.createdAt,
    room.lastMeaningfulActivityAt,
    room.closed ? 1 : 0,
  );
  // The creator is the one account admitted to a PRIVATE room without its
  // code — it's handed the code by this very call.
  recordMembership(db, room.roomId, room.creatorAccountId, nowMs);

  logAction(db, { action: "ROOM_CREATE", result: "ok", roomId: room.roomId, accountId: room.creatorAccountId }, nowMs);

  return room;
}
