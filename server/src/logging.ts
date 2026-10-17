import type { DatabaseSync } from "node:sqlite";
import { LOG_ACTIONS, type LogAction, type LogEvent, type LogEventView } from "../../shared/src/types.ts";
import { getAccountById } from "./accounts.ts";

// LOG_ACTIONS/LogAction/LogEvent/LogEventView live in shared/src/types.ts
// (not here) so the landing-page activity-log viewer (client/src/LogViewer.tsx)
// can render them without the client ever importing from server/src —
// re-exported here so every existing server-side import of them keeps working
// unchanged.
export { LOG_ACTIONS, type LogAction, type LogEvent, type LogEventView };

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

  // One commit instead of two (the insert, and pruneOldLogs' delete) — this
  // runs on every single meaningful action in the app (every vote, chat
  // message, join, playback change, ...), so it's the hottest write path by
  // far; halving its commits matters more here than almost anywhere else.
  try {
    db.exec("BEGIN");
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
    db.exec("COMMIT");
  } catch (err) {
    // ROLLBACK can itself throw (e.g. the database closed out from under
    // this call, so there was never a transaction to roll back) — logAction
    // must never throw regardless, so that failure is swallowed too.
    try {
      db.exec("ROLLBACK");
    } catch {
      // nothing more to do
    }
    console.error(`failed to persist log event ${event.action}:`, err);
  }

  console.log(JSON.stringify(event));
}

function rowToLogEvent(row: unknown): LogEvent {
  const r = row as {
    timestamp: string;
    action: LogAction;
    result: string;
    roomId: string | null;
    accountId: string | null;
    proposalId: string | null;
    playbackId: string | null;
    revision: number | null;
    detail: string | null;
  };
  return {
    timestamp: r.timestamp,
    action: r.action,
    result: r.result,
    ...(r.roomId !== null && { roomId: r.roomId }),
    ...(r.accountId !== null && { accountId: r.accountId }),
    ...(r.proposalId !== null && { proposalId: r.proposalId }),
    ...(r.playbackId !== null && { playbackId: r.playbackId }),
    ...(r.revision !== null && { revision: r.revision }),
    ...(r.detail !== null && { detail: r.detail }),
  };
}

// Reads back the live feed itself — newest first, optionally narrowed to one
// room — for a "what's happening right now" view to render. Prunes first so
// a caller never sees a row older than LOG_RETENTION_MS.
export function listRecentLogs(db: DatabaseSync, options: { roomId?: string; nowMs?: number } = {}): LogEvent[] {
  const nowMs = options.nowMs ?? Date.now();
  pruneOldLogs(db, nowMs);
  const rows = options.roomId
    ? db.prepare(`SELECT ${LOG_COLUMNS} FROM logs WHERE roomId = ? ORDER BY id DESC`).all(options.roomId)
    : db.prepare(`SELECT ${LOG_COLUMNS} FROM logs ORDER BY id DESC`).all();
  return rows.map(rowToLogEvent);
}

// Decorates each row with its account's *current* displayName, purely for a
// human reading the feed: a read-only join done at render time, never stored
// or logged. displayName may duplicate across accounts (CLAUDE.md's Identity
// section — "displayName: may duplicate"), so this can never replace
// accountId as the row's real identity, only label it for display. A missing
// accountId, or an account since deleted, resolves to null rather than
// throwing.
export function withAccountDisplayNames(db: DatabaseSync, events: LogEvent[]): LogEventView[] {
  const cache = new Map<string, string | null>();
  return events.map((event) => {
    if (!event.accountId) return { ...event, accountDisplayName: null };
    if (!cache.has(event.accountId)) {
      cache.set(event.accountId, getAccountById(db, event.accountId)?.displayName ?? null);
    }
    return { ...event, accountDisplayName: cache.get(event.accountId) ?? null };
  });
}
