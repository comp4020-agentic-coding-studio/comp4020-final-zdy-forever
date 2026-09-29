import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { QueueItem, YoutubeVideoMetadata } from "../../shared/src/types.ts";
import { parseYouTubeVideoId } from "../../shared/src/youtube.ts";
import { getVideoMetadata as defaultGetVideoMetadata } from "./youtube.ts";

export class InvalidTrackError extends Error {}

export interface AddTrackDeps {
  resolveMetadata?: (videoId: string) => Promise<YoutubeVideoMetadata | null>;
}

function rowToQueueItem(row: unknown): QueueItem {
  return row as QueueItem;
}

// rowid (SQLite's implicit row order) recovers insertion order for display
// only — queueItemId remains the one and only identity, so callers can never
// mistake position-in-array for identity.
export function listQueue(db: DatabaseSync, roomId: string): QueueItem[] {
  const rows = db
    .prepare(
      `SELECT queueItemId, roomId, videoId, title, channelTitle, thumbnailUrl, addedBy, addedAt
         FROM queue_items
        WHERE roomId = ?
        ORDER BY rowid ASC`,
    )
    .all(roomId);
  return rows.map(rowToQueueItem);
}

// input (a pasted URL, or a bare videoId handed back by search/demo songs) is
// always independently re-parsed and re-resolved here — the server never
// trusts client-supplied title/channelTitle/thumbnail, only the canonical
// metadata it looks up itself (see CLAUDE.md's Authority section). Adding a
// track never requires a vote.
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
