import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { YoutubeVideoMetadata } from "../../shared/src/types.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAccount } from "./accounts.ts";
import { createRoom } from "./rooms.ts";
import { openDatabase } from "./db.ts";
import { addTrack, InvalidTrackError, listQueue } from "./queue.ts";

function fakeMetadataFor(catalogue: Record<string, YoutubeVideoMetadata | null>) {
  return async (videoId: string): Promise<YoutubeVideoMetadata | null> => {
    return Object.prototype.hasOwnProperty.call(catalogue, videoId) ? catalogue[videoId] : null;
  };
}

const SONG_A: YoutubeVideoMetadata = {
  videoId: "aaaaaaaaaaa",
  title: "Song A",
  channelTitle: "Channel A",
  thumbnailUrl: "https://img.example/a.jpg",
  embeddable: true,
};

const SONG_B: YoutubeVideoMetadata = {
  videoId: "bbbbbbbbbbb",
  title: "Song B",
  channelTitle: "Channel B",
  thumbnailUrl: "https://img.example/b.jpg",
  embeddable: true,
};

const PRIVATE_SONG: YoutubeVideoMetadata = {
  videoId: "ccccccccccc",
  title: "Private song",
  channelTitle: "Channel C",
  thumbnailUrl: "https://img.example/c.jpg",
  embeddable: false,
};

describe("queue", () => {
  let dir: string;
  let dbPath: string;
  let db: DatabaseSync;
  let accountId: string;
  let roomId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "echo-room-queue-"));
    dbPath = path.join(dir, "echo-room.sqlite");
    db = openDatabase(dbPath);
    accountId = registerAccount(db, "client-adder", "Adder").accountId;
    roomId = createRoom(db, {
      accountId,
      name: "Queue room",
      visibility: "PUBLIC",
      autoCloseEnabled: false,
    }).roomId;
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed by a test that reopens the file
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds a track with a stable queueItemId, canonical metadata, and addedBy/addedAt", async () => {
    const resolveMetadata = fakeMetadataFor({ [SONG_A.videoId]: SONG_A });

    const item = await addTrack(db, roomId, accountId, SONG_A.videoId, { resolveMetadata });

    expect(item.queueItemId).toBeTruthy();
    expect(item.roomId).toBe(roomId);
    expect(item.videoId).toBe(SONG_A.videoId);
    expect(item.title).toBe(SONG_A.title);
    expect(item.channelTitle).toBe(SONG_A.channelTitle);
    expect(item.thumbnailUrl).toBe(SONG_A.thumbnailUrl);
    expect(item.addedBy).toBe(accountId);
    expect(item.addedAt).toBeTruthy();

    expect(listQueue(db, roomId)).toEqual([item]);
  });

  it("resolves a pasted URL to its canonical videoId rather than trusting client input", async () => {
    const resolveMetadata = fakeMetadataFor({ [SONG_A.videoId]: SONG_A });

    const item = await addTrack(
      db,
      roomId,
      accountId,
      `https://www.youtube.com/watch?v=${SONG_A.videoId}`,
      { resolveMetadata },
    );

    expect(item.videoId).toBe(SONG_A.videoId);
  });

  it("ignores client-claimed metadata and stores only the server's own lookup", async () => {
    // The "input" is a bare videoId — a search result or demo song only ever
    // hands the client a videoId, and the server independently re-resolves
    // title/channelTitle/thumbnail rather than trusting anything else the
    // client might send alongside it.
    const resolveMetadata = fakeMetadataFor({ [SONG_A.videoId]: SONG_A });

    const item = await addTrack(db, roomId, accountId, SONG_A.videoId, { resolveMetadata });

    expect(item.title).toBe(SONG_A.title);
  });

  it("rejects a video the resolver reports as not found", async () => {
    const resolveMetadata = fakeMetadataFor({});

    await expect(addTrack(db, roomId, accountId, "zzzzzzzzzzz", { resolveMetadata })).rejects.toThrow(
      InvalidTrackError,
    );
    expect(listQueue(db, roomId)).toEqual([]);
  });

  it("rejects a video that isn't embeddable", async () => {
    const resolveMetadata = fakeMetadataFor({ [PRIVATE_SONG.videoId]: PRIVATE_SONG });

    await expect(
      addTrack(db, roomId, accountId, PRIVATE_SONG.videoId, { resolveMetadata }),
    ).rejects.toThrow(InvalidTrackError);
    expect(listQueue(db, roomId)).toEqual([]);
  });

  it("rejects input that isn't a recognizable YouTube URL or videoId, without ever calling the resolver", async () => {
    let called = false;
    const resolveMetadata = async () => {
      called = true;
      return null;
    };

    await expect(addTrack(db, roomId, accountId, "not a url at all", { resolveMetadata })).rejects.toThrow(
      InvalidTrackError,
    );
    expect(called).toBe(false);
    expect(listQueue(db, roomId)).toEqual([]);
  });

  it("assigns distinct, non-sequential queueItemIds to tracks added simultaneously, without overwriting either", async () => {
    const resolveMetadata = fakeMetadataFor({ [SONG_A.videoId]: SONG_A, [SONG_B.videoId]: SONG_B });

    const [a, b] = await Promise.all([
      addTrack(db, roomId, accountId, SONG_A.videoId, { resolveMetadata }),
      addTrack(db, roomId, accountId, SONG_B.videoId, { resolveMetadata }),
    ]);

    expect(a.queueItemId).not.toBe(b.queueItemId);

    const queue = listQueue(db, roomId);
    expect(queue).toHaveLength(2);
    expect(queue.map((item) => item.queueItemId).sort()).toEqual([a.queueItemId, b.queueItemId].sort());
    expect(new Set(queue.map((item) => item.videoId))).toEqual(new Set([SONG_A.videoId, SONG_B.videoId]));
  });

  it("survives a database reopen", async () => {
    const resolveMetadata = fakeMetadataFor({ [SONG_A.videoId]: SONG_A });
    const added = await addTrack(db, roomId, accountId, SONG_A.videoId, { resolveMetadata });
    db.close();

    const reopened = openDatabase(dbPath);
    const queue = listQueue(reopened, roomId);
    reopened.close();

    expect(queue).toEqual([added]);
  });

  it("keeps queues scoped to their own room", async () => {
    const resolveMetadata = fakeMetadataFor({ [SONG_A.videoId]: SONG_A, [SONG_B.videoId]: SONG_B });
    const otherRoomId = createRoom(db, {
      accountId,
      name: "Other room",
      visibility: "PUBLIC",
      autoCloseEnabled: false,
    }).roomId;

    await addTrack(db, roomId, accountId, SONG_A.videoId, { resolveMetadata });
    await addTrack(db, otherRoomId, accountId, SONG_B.videoId, { resolveMetadata });

    expect(listQueue(db, roomId).map((i) => i.videoId)).toEqual([SONG_A.videoId]);
    expect(listQueue(db, otherRoomId).map((i) => i.videoId)).toEqual([SONG_B.videoId]);
  });
});
