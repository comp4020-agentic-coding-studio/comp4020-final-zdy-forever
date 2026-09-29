import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PlaybackState, QueueItem } from "../../shared/src/types.ts";
import { getAccountById } from "./accounts.ts";

interface PlaybackRow {
  roomId: string;
  playbackId: string;
  queueItemId: string;
  startedAt: string;
}

const QUEUE_ITEM_COLUMNS =
  "queueItemId, roomId, videoId, title, channelTitle, thumbnailUrl, addedBy, addedAt";

function getQueueItemById(db: DatabaseSync, queueItemId: string): QueueItem | undefined {
  return db.prepare(`SELECT ${QUEUE_ITEM_COLUMNS} FROM queue_items WHERE queueItemId = ?`).get(queueItemId) as
    | QueueItem
    | undefined;
}

function getPlaybackRow(db: DatabaseSync, roomId: string): PlaybackRow | undefined {
  return db
    .prepare("SELECT roomId, playbackId, queueItemId, startedAt FROM room_playback WHERE roomId = ?")
    .get(roomId) as PlaybackRow | undefined;
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
// smallest rowid greater than the current item's rowid (queue insertion
// order), or, if nothing is currently playing, simply the first item in the
// queue (whatever would start if playback began now).
export function getNextTrack(db: DatabaseSync, roomId: string): QueueItem | null {
  const row = getPlaybackRow(db, roomId);

  if (!row) {
    const first = db
      .prepare(`SELECT ${QUEUE_ITEM_COLUMNS} FROM queue_items WHERE roomId = ? ORDER BY rowid ASC LIMIT 1`)
      .get(roomId) as QueueItem | undefined;
    return first ?? null;
  }

  const currentRowid = (
    db.prepare("SELECT rowid AS rowid FROM queue_items WHERE queueItemId = ?").get(row.queueItemId) as
      | { rowid: number }
      | undefined
  )?.rowid;

  const next = db
    .prepare(
      `SELECT ${QUEUE_ITEM_COLUMNS} FROM queue_items WHERE roomId = ? AND rowid > ? ORDER BY rowid ASC LIMIT 1`,
    )
    .get(roomId, currentRowid ?? 0) as QueueItem | undefined;

  return next ?? null;
}

// Called right after a track is successfully added: if nothing is currently
// playing in this room, the newly-added item becomes current (this is what
// lets the very first track ever added, or a track added after the queue
// drained, start playing without any vote — there is nothing to skip past
// yet). If something is already playing, this is a no-op.
//
// INSERT OR IGNORE (rather than a check-then-insert) is what makes this
// race-free: two concurrent additions to a room with nothing playing yet
// both attempt the same insert, and only the one that actually lands first
// wins the roomId row — the other is silently ignored rather than throwing
// on the PRIMARY KEY collision.
export function ensureCurrentTrack(db: DatabaseSync, roomId: string, queueItemId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO room_playback (roomId, playbackId, queueItemId, startedAt) VALUES (?, ?, ?, ?)",
  ).run(roomId, randomUUID(), queueItemId, new Date().toISOString());
}

// Moves playback to the next queue item, assigning it a fresh playbackId —
// this is what "next track automatically changes DJ" means: the DJ is
// derived from whichever queue item is current, so advancing to a track
// added by a different account changes the reported DJ with no separate
// bookkeeping required. If there is no next item, playback stops (nothing
// currently playing) rather than wrapping back around.
export function advanceToNextTrack(db: DatabaseSync, roomId: string): PlaybackState | null {
  const next = getNextTrack(db, roomId);
  if (!next) {
    db.prepare("DELETE FROM room_playback WHERE roomId = ?").run(roomId);
    return null;
  }

  db.prepare(
    `INSERT INTO room_playback (roomId, playbackId, queueItemId, startedAt) VALUES (?, ?, ?, ?)
     ON CONFLICT(roomId) DO UPDATE SET
       playbackId = excluded.playbackId,
       queueItemId = excluded.queueItemId,
       startedAt = excluded.startedAt`,
  ).run(roomId, randomUUID(), next.queueItemId, new Date().toISOString());

  return getCurrentPlayback(db, roomId);
}
