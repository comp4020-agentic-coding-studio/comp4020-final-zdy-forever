import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PlaybackState, PlaybackStatus, QueueItem } from "../../shared/src/types.ts";
import { getAccountById } from "./accounts.ts";

interface PlaybackRow {
  roomId: string;
  playbackId: string;
  queueItemId: string;
  startedAt: string;
  status: PlaybackStatus;
  anchorPositionMs: number;
  anchorServerTimeMs: number;
  revision: number;
  djAccountId: string | null;
}

const QUEUE_ITEM_COLUMNS =
  "queueItemId, roomId, videoId, title, channelTitle, thumbnailUrl, durationMs, addedBy, addedAt";

const PLAYBACK_ROW_COLUMNS =
  "roomId, playbackId, queueItemId, startedAt, status, anchorPositionMs, anchorServerTimeMs, revision, djAccountId";

function getQueueItemById(db: DatabaseSync, queueItemId: string): QueueItem | undefined {
  return db.prepare(`SELECT ${QUEUE_ITEM_COLUMNS} FROM queue_items WHERE queueItemId = ?`).get(queueItemId) as
    | QueueItem
    | undefined;
}

function getPlaybackRow(db: DatabaseSync, roomId: string): PlaybackRow | undefined {
  return db.prepare(`SELECT ${PLAYBACK_ROW_COLUMNS} FROM room_playback WHERE roomId = ?`).get(roomId) as
    | PlaybackRow
    | undefined;
}

function toPlaybackState(db: DatabaseSync, row: PlaybackRow): PlaybackState {
  // Guaranteed to exist: room_playback.queueItemId has a foreign key into
  // queue_items, and the current item can never be removed (see
  // queue.ts's removeQueueItem).
  const item = getQueueItemById(db, row.queueItemId) as QueueItem;
  const djAccountId = row.djAccountId ?? item.addedBy;
  const djAccount = getAccountById(db, djAccountId);

  return {
    playbackId: row.playbackId,
    queueItemId: item.queueItemId,
    videoId: item.videoId,
    title: item.title,
    channelTitle: item.channelTitle,
    thumbnailUrl: item.thumbnailUrl,
    durationMs: item.durationMs,
    startedAt: row.startedAt,
    status: row.status,
    anchorPositionMs: row.anchorPositionMs,
    anchorServerTimeMs: row.anchorServerTimeMs,
    revision: row.revision,
    dj: { accountId: djAccountId, displayName: djAccount?.displayName ?? "Unknown" },
  };
}

// The currently-playing queue item for a room, or null if nothing is
// playing (e.g. the room's queue is still empty).
export function getCurrentPlayback(db: DatabaseSync, roomId: string): PlaybackState | null {
  const row = getPlaybackRow(db, roomId);
  return row ? toPlaybackState(db, row) : null;
}

// The queue item that would play after the current one: the item with the
// smallest position greater than the current item's position (this room's
// explicit queue order — see reorderQueueItem in server/src/queue.ts; rowid
// only breaks a tie between rows that somehow share a position), or, if
// nothing is currently playing, simply the first item in the queue (whatever
// would start if playback began now). Reading position here rather than
// rowid is what makes a passed REORDER_QUEUE vote actually change what plays
// next, not just what a client happens to display.
export function getNextTrack(db: DatabaseSync, roomId: string): QueueItem | null {
  const row = getPlaybackRow(db, roomId);

  if (!row) {
    const first = db
      .prepare(`SELECT ${QUEUE_ITEM_COLUMNS} FROM queue_items WHERE roomId = ? ORDER BY position ASC, rowid ASC LIMIT 1`)
      .get(roomId) as QueueItem | undefined;
    return first ?? null;
  }

  const currentPosition = (
    db.prepare("SELECT position AS position FROM queue_items WHERE queueItemId = ?").get(row.queueItemId) as
      | { position: number }
      | undefined
  )?.position;

  const next = db
    .prepare(
      `SELECT ${QUEUE_ITEM_COLUMNS} FROM queue_items WHERE roomId = ? AND position > ? ORDER BY position ASC, rowid ASC LIMIT 1`,
    )
    .get(roomId, currentPosition ?? -1) as QueueItem | undefined;

  return next ?? null;
}

// Called right after a track is successfully added: if nothing is currently
// playing in this room, the newly-added item becomes current (this is what
// lets the very first track ever added, or a track added after the queue
// drained, start playing without any vote — there is nothing to skip past
// yet). If something is already playing, this is a no-op. Freshly started
// playback always begins PLAYING from position 0, with a brand new
// playbackId and revision 1 (a fresh track transition, never a continuation
// of whatever revision counter a previous, now-finished track reached).
//
// INSERT OR IGNORE (rather than a check-then-insert) is what makes this
// race-free: two concurrent additions to a room with nothing playing yet
// both attempt the same insert, and only the one that actually lands first
// wins the roomId row — the other is silently ignored rather than throwing
// on the PRIMARY KEY collision. Returns the resulting PlaybackState only when
// this call actually started it (result.changes > 0); returns null both when
// something was already playing and when the insert lost the race, so a
// caller can tell whether it should broadcast a fresh "playback started"
// event.
export function ensureCurrentTrack(db: DatabaseSync, roomId: string, queueItemId: string): PlaybackState | null {
  const nowMs = Date.now();
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO room_playback
         (roomId, playbackId, queueItemId, startedAt, status, anchorPositionMs, anchorServerTimeMs, revision)
       VALUES (?, ?, ?, ?, 'PLAYING', 0, ?, 1)`,
    )
    .run(roomId, randomUUID(), queueItemId, new Date(nowMs).toISOString(), nowMs);

  if (result.changes === 0) {
    return null;
  }
  return getCurrentPlayback(db, roomId);
}

// Moves playback to the next queue item, assigning it a fresh playbackId
// (this is what "next track automatically changes DJ" means: the DJ is
// derived from whichever queue item is current, so advancing to a track
// added by a different account changes the reported DJ with no separate
// bookkeeping required) and resetting the anchor to PLAYING from position 0.
// revision, unlike playbackId, is never reset here — it carries on from the
// outgoing track's revision (or 1, if nothing was playing before this
// transition), since it identifies the room's control-state timeline as a
// whole, not any one track. If there is no next item, playback stops
// (nothing currently playing) rather than wrapping back around.
//
// The track that just finished (played to its end, or skipped) stays in
// the queue as history, above the new current track: a history track can be
// moved back down after the current one to play again (see queue.ts's
// planQueueReorder), and the queue view scrolls it out of sight above the
// current track.
export function advanceToNextTrack(db: DatabaseSync, roomId: string): PlaybackState | null {
  const next = getNextTrack(db, roomId);
  if (!next) {
    db.prepare("DELETE FROM room_playback WHERE roomId = ?").run(roomId);
    return null;
  }

  const previousRevision = getPlaybackRow(db, roomId)?.revision ?? 0;
  const nowMs = Date.now();

  db.prepare(
    `INSERT INTO room_playback
       (roomId, playbackId, queueItemId, startedAt, status, anchorPositionMs, anchorServerTimeMs, revision)
     VALUES (?, ?, ?, ?, 'PLAYING', 0, ?, ?)
     ON CONFLICT(roomId) DO UPDATE SET
       playbackId = excluded.playbackId,
       queueItemId = excluded.queueItemId,
       startedAt = excluded.startedAt,
       status = excluded.status,
       anchorPositionMs = excluded.anchorPositionMs,
       anchorServerTimeMs = excluded.anchorServerTimeMs,
       revision = excluded.revision,
       djAccountId = NULL`,
  ).run(roomId, randomUUID(), next.queueItemId, new Date(nowMs).toISOString(), nowMs, previousRevision + 1);

  return getCurrentPlayback(db, roomId);
}

// Applies a passed PLAY/PAUSE proposal (see ProposalManager in
// server/src/proposals.ts) — the only caller; clients never reach this
// directly. A no-op if the room isn't currently playing anything, or if the
// requested status already matches the current one (no anchor rebase, no
// revision bump — nothing actually changed), which is defense-in-depth
// against a Play-while-playing/Pause-while-paused proposal on top of
// ProposalManager's own up-front rejection of those. On an actual transition, the anchor is rebased at the
// current expected position (so resuming PLAYING after a PAUSED interval
// continues from where it was paused, not from wherever it happened to be
// when it was first anchored) and revision advances by one, since this is
// itself a legitimate control-state change that must invalidate any stale
// in-flight proposal referencing the old revision.
export function setPlaybackStatus(db: DatabaseSync, roomId: string, status: PlaybackStatus): PlaybackState | null {
  const row = getPlaybackRow(db, roomId);
  if (!row) {
    return null;
  }
  if (row.status === status) {
    return toPlaybackState(db, row);
  }

  const nowMs = Date.now();
  const expectedPositionMs =
    row.status === "PLAYING" ? row.anchorPositionMs + Math.max(0, nowMs - row.anchorServerTimeMs) : row.anchorPositionMs;

  db.prepare(
    `UPDATE room_playback
     SET status = ?, anchorPositionMs = ?, anchorServerTimeMs = ?, revision = revision + 1
     WHERE roomId = ?`,
  ).run(status, expectedPositionMs, nowMs, roomId);

  return getCurrentPlayback(db, roomId);
}

// Applies a passed SEEK proposal (see ProposalManager) — rebases the anchor
// to an explicit target position rather than the "expected position right
// now" that setPlaybackStatus computes for a play/pause transition. status is
// left untouched: seeking while PLAYING keeps playing from the new position,
// seeking while PAUSED stays paused there. A no-op (null) if nothing is
// currently playing in this room; otherwise this is itself a legitimate
// control-state change, so revision advances by one, invalidating any other
// stale in-flight proposal referencing the old revision.
export function seekPlayback(db: DatabaseSync, roomId: string, positionMs: number): PlaybackState | null {
  const row = getPlaybackRow(db, roomId);
  if (!row) {
    return null;
  }

  db.prepare(
    `UPDATE room_playback
     SET anchorPositionMs = ?, anchorServerTimeMs = ?, revision = revision + 1
     WHERE roomId = ?`,
  ).run(positionMs, Date.now(), roomId);

  return getCurrentPlayback(db, roomId);
}

// How often the running server records that it's alive (see
// server_liveness in db.ts). A restart recovers a PLAYING track at most this
// much earlier than where it really was.
export const SERVER_ALIVE_INTERVAL_MS = 5_000;

export function recordServerAlive(db: DatabaseSync, nowMs: number = Date.now()): void {
  db.prepare(
    `INSERT INTO server_liveness (id, lastAliveMs) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET lastAliveMs = excluded.lastAliveMs`,
  ).run(nowMs);
}

// Called once at server startup, before any client can connect: per
// CLAUDE.md's persistence requirement, "a previously playing track must
// recover at its last saved position as PAUSED." A room already PAUSED at
// shutdown is left completely untouched (its anchor already reflects exactly
// where it was left, and touching it would bump revision for no reason).
//
// A room that was PLAYING is flipped to PAUSED at the position it had
// reached by the last moment the server was known to be running
// (server_liveness), never extrapolated through the unknown downtime after
// it. Only the anchor used to be kept, and a track's anchor is only moved by
// a play/pause/seek, so a track nobody touched recovered at 0:00 however far
// into it the room was. With no liveness record (a database from before it
// existed) the anchor is all there is. anchorServerTimeMs becomes "now" so a
// later resume calculates from this moment. This is itself a control-state
// transition, so revision advances too.
export function recoverPlaybackOnStartup(db: DatabaseSync, nowMs: number = Date.now()): void {
  const lastAliveMs =
    (db.prepare("SELECT lastAliveMs FROM server_liveness WHERE id = 1").get() as { lastAliveMs: number } | undefined)
      ?.lastAliveMs ?? null;
  db.prepare(
    `UPDATE room_playback
     SET status = 'PAUSED',
         anchorPositionMs = anchorPositionMs + (CASE WHEN ? IS NULL THEN 0 ELSE MAX(0, ? - anchorServerTimeMs) END),
         anchorServerTimeMs = ?,
         revision = revision + 1
     WHERE status = 'PLAYING'`,
  ).run(lastAliveMs, lastAliveMs, nowMs);
}
