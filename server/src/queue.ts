import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { QueueItem, YoutubeVideoMetadata } from "../../shared/src/types.ts";
import { parseYouTubeVideoId } from "../../shared/src/youtube.ts";
import { touchRoomActivity } from "./rooms.ts";
import { getVideoMetadata as defaultGetVideoMetadata } from "./youtube.ts";

export class InvalidTrackError extends Error {}

export interface AddTrackDeps {
  resolveMetadata?: (videoId: string) => Promise<YoutubeVideoMetadata | null>;
}

const QUEUE_ITEM_COLUMNS = "queueItemId, roomId, videoId, title, channelTitle, thumbnailUrl, addedBy, addedAt";

function rowToQueueItem(row: unknown): QueueItem {
  return row as QueueItem;
}

// position is this room's explicit queue order (see reorderQueueItem below);
// rowid only ever breaks a tie between two rows that somehow share a
// position, which normal operation never produces. queueItemId remains the
// one and only identity — callers can never mistake position-in-array (or
// this position column) for identity.
export function listQueue(db: DatabaseSync, roomId: string): QueueItem[] {
  const rows = db
    .prepare(`SELECT ${QUEUE_ITEM_COLUMNS} FROM queue_items WHERE roomId = ? ORDER BY position ASC, rowid ASC`)
    .all(roomId);
  return rows.map(rowToQueueItem);
}

// The room's current queue order, identity-only — the shared basis for both
// planReorder's pure computation and reorderQueueItem's persistence.
function getQueueOrder(db: DatabaseSync, roomId: string): string[] {
  const rows = db
    .prepare("SELECT queueItemId FROM queue_items WHERE roomId = ? ORDER BY position ASC, rowid ASC")
    .all(roomId) as { queueItemId: string }[];
  return rows.map((row) => row.queueItemId);
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

// Pure: computes the reordered id list, or null if the move is a no-op —
// dropping the item back onto itself, or in front of the item that's already
// its immediate successor (equivalently: back onto its original position).
// Both queueItemId and beforeQueueItemId (when not null) are assumed already
// validated as present in order; reorderQueueItem/previewReorderQueue are
// responsible for that before calling this.
export function planReorder(order: string[], queueItemId: string, beforeQueueItemId: string | null): string[] | null {
  if (queueItemId === beforeQueueItemId) return null;

  const without = order.filter((id) => id !== queueItemId);
  const insertAt = beforeQueueItemId === null ? without.length : without.indexOf(beforeQueueItemId);
  const next = [...without.slice(0, insertAt), queueItemId, ...without.slice(insertAt)];

  const unchanged = next.length === order.length && next.every((id, index) => id === order[index]);
  return unchanged ? null : next;
}

// A read-only preview of whether a drag would produce a genuine reorder —
// used by ProposalManager.requestReorderQueue to reject a no-op drag before
// ever opening a 15-second vote over it (CLAUDE.md: "Failed, stale or no-op
// reorder attempts cost nothing," which is cheapest to honor by never
// starting the vote at all when the outcome is already known to be a no-op).
export function previewReorderQueue(
  db: DatabaseSync,
  roomId: string,
  queueItemId: string,
  beforeQueueItemId: string | null,
): boolean {
  const order = getQueueOrder(db, roomId);
  if (!order.includes(queueItemId)) return false;
  if (beforeQueueItemId !== null && !order.includes(beforeQueueItemId)) return false;
  return planReorder(order, queueItemId, beforeQueueItemId) !== null;
}

export type ReorderQueueItemResult =
  | { reordered: true; queue: QueueItem[] }
  | { reordered: false; reason: "not-found" | "invalid-target" | "no-op" };

// Applies a passed REORDER_QUEUE proposal (see ProposalManager) — the only
// caller; clients never reach this directly. Re-verifies both the dragged
// item and its target still exist in this room's queue, since time has
// passed since the vote opened (mirroring removeQueueItem's re-verification
// for the exact same reason): either one may have been removed mid-vote by
// an unrelated REMOVE_QUEUE_ITEM proposal, which a queueRevision staleness
// check would already have caught in the common case, but this stays as
// defense-in-depth regardless. beforeQueueItemId === null means "move to the
// end of the queue."
//
// A no-op reorder changes nothing and bumps nothing. Only a reorder that
// actually changes the resulting order persists new positions and bumps
// queueRevision — exactly mirroring removeQueueItem's staleness-detection
// mechanism for any other still-open queue-kind proposal.
export function reorderQueueItem(
  db: DatabaseSync,
  roomId: string,
  queueItemId: string,
  beforeQueueItemId: string | null,
): ReorderQueueItemResult {
  const order = getQueueOrder(db, roomId);
  if (!order.includes(queueItemId)) {
    return { reordered: false, reason: "not-found" };
  }
  if (beforeQueueItemId !== null && !order.includes(beforeQueueItemId)) {
    return { reordered: false, reason: "invalid-target" };
  }

  const next = planReorder(order, queueItemId, beforeQueueItemId);
  if (!next) {
    return { reordered: false, reason: "no-op" };
  }

  const update = db.prepare("UPDATE queue_items SET position = ? WHERE roomId = ? AND queueItemId = ?");
  next.forEach((id, index) => update.run(index, roomId, id));
  db.prepare("UPDATE rooms SET queueRevision = queueRevision + 1 WHERE roomId = ?").run(roomId);

  return { reordered: true, queue: listQueue(db, roomId) };
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

  // No await between this SELECT and the INSERT below, so nothing else on
  // the single-threaded event loop can interleave a second addTrack's own
  // SELECT+INSERT in between — concurrent additions can never race onto the
  // same position (same reasoning as removeQueueItem's synchronous
  // check-then-write, per node:sqlite's DatabaseSync being fully sync).
  const maxPosition = db
    .prepare("SELECT COALESCE(MAX(position), -1) AS maxPosition FROM queue_items WHERE roomId = ?")
    .get(roomId) as { maxPosition: number };
  const position = maxPosition.maxPosition + 1;

  db.prepare(
    `INSERT INTO queue_items (queueItemId, roomId, videoId, title, channelTitle, thumbnailUrl, addedBy, addedAt, position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    item.queueItemId,
    item.roomId,
    item.videoId,
    item.title,
    item.channelTitle,
    item.thumbnailUrl,
    item.addedBy,
    item.addedAt,
    position,
  );

  // "track add" is meaningful activity (CLAUDE.md's Rooms section).
  touchRoomActivity(db, roomId);

  return item;
}
