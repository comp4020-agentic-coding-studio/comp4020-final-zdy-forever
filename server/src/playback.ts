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
}

const QUEUE_ITEM_COLUMNS =
  "queueItemId, roomId, videoId, title, channelTitle, thumbnailUrl, addedBy, addedAt";

const PLAYBACK_ROW_COLUMNS =
  "roomId, playbackId, queueItemId, startedAt, status, anchorPositionMs, anchorServerTimeMs, revision";

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
  // Guaranteed to exist: queue_items rows are append-only (no remove/reorder
  // implemented yet), and room_playback.queueItemId has a foreign key into it.
  const item = getQueueItemById(db, row.queueItemId) as QueueItem;
  const djAccount = getAccountById(db, item.addedBy);

  return {
    playbackId: row.playbackId,
    queueItemId: item.queueItemId,
    videoId: item.videoId,
    title: item.title,
    channelTitle: item.channelTitle,
    thumbnailUrl: item.thumbnailUrl,
    startedAt: row.startedAt,
    status: row.status,
    anchorPositionMs: row.anchorPositionMs,
    anchorServerTimeMs: row.anchorServerTimeMs,
    revision: row.revision,
    // Looked up live from queue_items.addedBy rather than stored redundantly
    // here: the DJ belongs to the track, not the room, and this way it can
    // never drift out of sync with who actually added the track. Whether
    // that account is currently connected is irrelevant — a disconnected DJ
    // does not change or invalidate this.
    dj: { accountId: item.addedBy, displayName: djAccount?.displayName ?? "Unknown" },
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
       revision = excluded.revision`,
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

// Called once at server startup, before any client can connect: per
// CLAUDE.md's persistence requirement, "a previously playing track must
// recover at its last saved position as PAUSED." A room already PAUSED at
// shutdown is left completely untouched (its anchor already reflects exactly
// where it was left, and touching it would bump revision for no reason). A
// room that was PLAYING is flipped to PAUSED without ever extrapolating
// through the unknown downtime: anchorPositionMs is preserved exactly as
// last persisted (never advanced by elapsed wall-clock time), and
// anchorServerTimeMs is updated to "now" purely so a later resume calculates
// correctly from this moment forward. This is itself a legitimate
// control-state transition, so revision advances too.
export function recoverPlaybackOnStartup(db: DatabaseSync): void {
  db.prepare(
    `UPDATE room_playback
     SET status = 'PAUSED', anchorServerTimeMs = ?, revision = revision + 1
     WHERE status = 'PLAYING'`,
  ).run(Date.now());
}
