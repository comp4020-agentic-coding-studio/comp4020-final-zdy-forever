import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { QueueItem, YoutubeVideoMetadata } from "../../shared/src/types.ts";
import { parseYouTubeVideoId } from "../../shared/src/youtube.ts";
import { getVideoMetadata as defaultGetVideoMetadata } from "./youtube.ts";

export class InvalidTrackError extends Error {}

export interface AddTrackDeps {
  resolveMetadata?: (videoId: string) => Promise<YoutubeVideoMetadata | null>;
}

const QUEUE_ITEM_COLUMNS = "queueItemId, roomId, videoId, title, channelTitle, thumbnailUrl, addedBy, addedAt";

function rowToQueueItem(row: unknown): QueueItem {
  return row as QueueItem;
}

// rowid (SQLite's implicit row order) recovers insertion order for display
// only — queueItemId remains the one and only identity, so callers can never
// mistake position-in-array for identity.
export function listQueue(db: DatabaseSync, roomId: string): QueueItem[] {
  const rows = db
    .prepare(`SELECT ${QUEUE_ITEM_COLUMNS} FROM queue_items WHERE roomId = ? ORDER BY rowid ASC`)
    .all(roomId);
  return rows.map(rowToQueueItem);
}

// roomId-scoped so a queueItemId that happens to exist in a different room
// can never match — a REMOVE_QUEUE_ITEM proposal always resolves its target
// through this, never through a bare cross-room lookup.
export function getQueueItemById(db: DatabaseSync, roomId: string, queueItemId: string): QueueItem | undefined {
  const row = db
    .prepare(`SELECT ${QUEUE_ITEM_COLUMNS} FROM queue_items WHERE roomId = ? AND queueItemId = ?`)
    .get(roomId, queueItemId);
  return row ? rowToQueueItem(row) : undefined;
}

// The room's current queue-membership counter (see shared/src/voting.ts's
// "queue" ProposalReference kind) — a fresh room with no rows yet still
// reports 1, matching the column's DEFAULT.
export function getQueueRevision(db: DatabaseSync, roomId: string): number {
  const row = db.prepare("SELECT queueRevision FROM rooms WHERE roomId = ?").get(roomId) as
    | { queueRevision: number }
    | undefined;
  return row?.queueRevision ?? 1;
}

export type RemoveQueueItemResult =
  | { removed: true }
  | { removed: false; reason: "not-found" | "is-current-track" };

// Applies a passed REMOVE_QUEUE_ITEM proposal (see ProposalManager in
// server/src/proposals.ts) — the only caller; clients never reach this
// directly. Always re-verifies both preconditions itself rather than trusting
// the caller's earlier checks, since time has passed since the vote opened:
//
// - "not-found": the item is simply gone by now (already removed by an
//   earlier proposal, or never existed in this room) — this is also, in
//   practice, exactly what a stale queueRevision reference already implies,
//   since removal is the only thing that ever changes queueRevision; the
//   check stays here anyway as defense-in-depth, independent of whether the
//   caller remembered to compare revisions first.
// - "is-current-track": the target became the room's currently-playing item
//   since the vote opened (see ProposalManager's "current-track removal"
//   comment for why this can only be reached defensively, never in normal
//   operation, and why it is rejected rather than silently promoted into a
//   skip).
//
// A successful removal bumps queueRevision so any *other* still-open
// queue-kind proposal (a future REORDER_QUEUE vote) is correctly seen as
// stale afterwards.
export function removeQueueItem(db: DatabaseSync, roomId: string, queueItemId: string): RemoveQueueItemResult {
  const exists = db.prepare("SELECT 1 FROM queue_items WHERE roomId = ? AND queueItemId = ?").get(roomId, queueItemId);
  if (!exists) {
    return { removed: false, reason: "not-found" };
  }

  const current = db.prepare("SELECT queueItemId FROM room_playback WHERE roomId = ?").get(roomId) as
    | { queueItemId: string }
    | undefined;
  if (current?.queueItemId === queueItemId) {
    return { removed: false, reason: "is-current-track" };
  }

  db.prepare("DELETE FROM queue_items WHERE queueItemId = ?").run(queueItemId);
  db.prepare("UPDATE rooms SET queueRevision = queueRevision + 1 WHERE roomId = ?").run(roomId);
  return { removed: true };
}

// input (a pasted URL, or a bare videoId handed back by search/demo songs) is
// always independently re-parsed and re-resolved here — the server never
// trusts client-supplied title/channelTitle/thumbnail, only the canonical
// metadata it looks up itself (see CLAUDE.md's Authority section). Adding a
// track never requires a vote, and deliberately never bumps queueRevision:
// an addition can never invalidate an in-flight REMOVE_QUEUE_ITEM/
// REORDER_QUEUE vote about an existing, unrelated item, exactly as adding a
// track never bumps room_playback.revision and so never invalidates an
// in-flight SKIP vote either (see playback.ts).
export async function addTrack(
  db: DatabaseSync,
  roomId: string,
  accountId: string,
  input: string,
  deps: AddTrackDeps = {},
): Promise<QueueItem> {
  const resolveMetadata = deps.resolveMetadata ?? defaultGetVideoMetadata;

  const videoId = parseYouTubeVideoId(input);
  if (!videoId) throw new InvalidTrackError("not a recognizable YouTube video URL or videoId");

  const metadata = await resolveMetadata(videoId);
  if (!metadata) throw new InvalidTrackError("video not found");
  if (!metadata.embeddable) throw new InvalidTrackError("video is not embeddable");

  const item: QueueItem = {
    queueItemId: randomUUID(),
    roomId,
    videoId: metadata.videoId,
    title: metadata.title,
    channelTitle: metadata.channelTitle,
    thumbnailUrl: metadata.thumbnailUrl,
    addedBy: accountId,
    addedAt: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO queue_items (queueItemId, roomId, videoId, title, channelTitle, thumbnailUrl, addedBy, addedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    item.queueItemId,
    item.roomId,
    item.videoId,
    item.title,
    item.channelTitle,
    item.thumbnailUrl,
    item.addedBy,
    item.addedAt,
  );

  return item;
}
