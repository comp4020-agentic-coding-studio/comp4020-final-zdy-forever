import type { DatabaseSync } from "node:sqlite";

// Structured server-side observability (see CLAUDE.md's request: "Add
// structured server-side observability"). Exactly these 14 action kinds are
// ever logged — one per meaningful state change, never a raw request/response
// dump.
export const LOG_ACTIONS = [
  "ROOM_CREATE",
  "ROOM_JOIN",
  "ROOM_LEAVE",
  "TRACK_ADD",
  "PROPOSAL_CREATE",
  "VOTE_CAST",
  "PROPOSAL_PASS",
  "PROPOSAL_FAIL",
  "PLAYBACK_CHANGE",
  "QUEUE_REMOVE",
  "QUEUE_REORDER",
  "CHAT_SEND",
  "RECONNECT",
  "ROOM_AUTO_CLOSE",
] as const;

export type LogAction = (typeof LOG_ACTIONS)[number];

// Deliberately narrow: there is no displayName, clientId, socketId or IP
// field here at all, so a caller can't accidentally log one through — see
// CLAUDE.md's Persistence section ("Do not persist socket IDs or transient
// UI state") and this feature's own "do not log unnecessary personal
// information" requirement. accountId (a stable server identity, never a
// display name) is the only per-user field.
export interface LogEvent {
  timestamp: string;
  action: LogAction;
  result: string;
  roomId?: string;
  accountId?: string;
  proposalId?: string;
  playbackId?: string;
  revision?: number;
  detail?: string;
}

export type LogEventInput = Omit<LogEvent, "timestamp">;

// Pure: stamps `timestamp` from nowMs, which is caller-suppliable (like
// touchRoomActivity's nowMs in server/src/rooms.ts) purely for deterministic
// tests — production call sites never pass it, so the wall clock at the
// moment of the call is always what's recorded.
export function formatLogEvent(input: LogEventInput, nowMs: number = Date.now()): LogEvent {
  return { ...input, timestamp: new Date(nowMs).toISOString() };
}

const LOG_COLUMNS = "timestamp, action, result, roomId, accountId, proposalId, playbackId, revision, detail";

// Logs are kept for 20 minutes only — this is a live "what's happening right
// now" feed, not an audit trail, so unbounded growth is never a concern.
export const LOG_RETENTION_MS = 20 * 60 * 1000;

// Deletes every row older than the retention window, computed from each
// row's own stored timestamp against `nowMs` — never an in-memory repeating
// timer (mirrors sweepInactiveRooms in server/src/rooms.ts for the same
// reason: identical outcome whether the server has been running for days or
// was just restarted). Called opportunistically from logAction itself rather
// than on any schedule of its own.
function pruneOldLogs(db: DatabaseSync, nowMs: number): void {
  const cutoff = new Date(nowMs - LOG_RETENTION_MS).toISOString();
  db.prepare("DELETE FROM logs WHERE timestamp < ?").run(cutoff);
}

// Persists one row to the `logs` table and prints the same event as a single
// JSON line to stdout, so what multiple concurrent users are doing can be
// read straight off the server's own logs without ever opening the client UI.
// A failure to persist the row (e.g. a DB write failure) is caught and
// reported via console.error rather than thrown: logging an action must
// never be why the request or room it describes crashes (CLAUDE.md's
// Reliability section — mirrors server/src/httpErrors.ts's handleYoutubeError,
// which exists for the identical reason).
export function logAction(db: DatabaseSync, input: LogEventInput, nowMs: number = Date.now()): void {
  const event = formatLogEvent(input, nowMs);

  try {
    db.prepare(`INSERT INTO logs (${LOG_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      event.timestamp,
      event.action,
      event.result,
      event.roomId ?? null,
      event.accountId ?? null,
      event.proposalId ?? null,
      event.playbackId ?? null,
      event.revision ?? null,
      event.detail ?? null,
    );
    pruneOldLogs(db, nowMs);
  } catch (err) {
    console.error(`failed to persist log event ${event.action}:`, err);
  }

  console.log(JSON.stringify(event));
}
