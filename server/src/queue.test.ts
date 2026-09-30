import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { YoutubeVideoMetadata } from "../../shared/src/types.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAccount } from "./accounts.ts";
import { createRoom, getRoomById } from "./rooms.ts";
import { openDatabase } from "./db.ts";
import { advanceToNextTrack, ensureCurrentTrack, getCurrentPlayback, getNextTrack } from "./playback.ts";
import { addTrack, InvalidTrackError, listQueue, planReorder, previewReorderQueue, reorderQueueItem } from "./queue.ts";

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

const SONG_C: YoutubeVideoMetadata = {
  videoId: "ddddddddddd",
  title: "Song C",
  channelTitle: "Channel C",
  thumbnailUrl: "https://img.example/d.jpg",
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

  it("stores the track's length from the server's own lookup, or null when it has none", async () => {
    const resolveMetadata = fakeMetadataFor({
      [SONG_A.videoId]: { ...SONG_A, durationMs: 213_000 },
      [SONG_B.videoId]: SONG_B,
    });

    const timed = await addTrack(db, roomId, accountId, SONG_A.videoId, { resolveMetadata });
    const untimed = await addTrack(db, roomId, accountId, SONG_B.videoId, { resolveMetadata });

    expect(timed.durationMs).toBe(213_000);
    expect(untimed.durationMs).toBeNull();
    expect(listQueue(db, roomId).map((item) => item.durationMs)).toEqual([213_000, null]);
  });

  // "track add" is meaningful activity (CLAUDE.md's Rooms section) — a room
  // with auto-close enabled must not close while tracks keep getting added.
  it("bumps the room's lastMeaningfulActivityAt on a successful add", async () => {
    const before = getRoomById(db, roomId)!.lastMeaningfulActivityAt;
    db.prepare("UPDATE rooms SET lastMeaningfulActivityAt = '2000-01-01T00:00:00.000Z' WHERE roomId = ?").run(roomId);
    expect(getRoomById(db, roomId)!.lastMeaningfulActivityAt).not.toBe(before);

    const resolveMetadata = fakeMetadataFor({ [SONG_A.videoId]: SONG_A });
    await addTrack(db, roomId, accountId, SONG_A.videoId, { resolveMetadata });

    const after = getRoomById(db, roomId)!.lastMeaningfulActivityAt;
    expect(Date.parse(after)).toBeGreaterThan(Date.parse("2000-01-01T00:00:00.000Z"));
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
    // The "input" is a bare videoId, and the server independently re-resolves
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

  describe("planReorder (pure)", () => {
    it("moves an item before another", () => {
      expect(planReorder(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    });

    it("moves an item to the end when beforeQueueItemId is null", () => {
      expect(planReorder(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
    });

    it("is a no-op when targeting itself", () => {
      expect(planReorder(["a", "b", "c"], "a", "a")).toBeNull();
    });

    it("is a no-op when dropped back in front of its own current successor (its original position)", () => {
      expect(planReorder(["a", "b", "c"], "a", "b")).toBeNull();
    });

    it("is a no-op when dropped at the end and it's already the last item", () => {
      expect(planReorder(["a", "b", "c"], "c", null)).toBeNull();
    });
  });

  describe("reorderQueueItem / previewReorderQueue", () => {
    let a: string;
    let b: string;
    let c: string;

    beforeEach(async () => {
      const resolveMetadata = fakeMetadataFor({
        [SONG_A.videoId]: SONG_A,
        [SONG_B.videoId]: SONG_B,
        [SONG_C.videoId]: SONG_C,
      });
      a = (await addTrack(db, roomId, accountId, SONG_A.videoId, { resolveMetadata })).queueItemId;
      b = (await addTrack(db, roomId, accountId, SONG_B.videoId, { resolveMetadata })).queueItemId;
      c = (await addTrack(db, roomId, accountId, SONG_C.videoId, { resolveMetadata })).queueItemId;
    });

    it("reorders the queue, persists the new order, and bumps queueRevision", () => {
      const revisionBefore = db.prepare("SELECT queueRevision FROM rooms WHERE roomId = ?").get(roomId) as {
        queueRevision: number;
      };

      const result = reorderQueueItem(db, roomId, c, a);

      expect(result).toEqual({ reordered: true, queue: expect.any(Array) });
      if (!result.reordered) throw new Error("unreachable");
      expect(result.queue.map((i) => i.queueItemId)).toEqual([c, a, b]);
      expect(listQueue(db, roomId).map((i) => i.queueItemId)).toEqual([c, a, b]);

      const revisionAfter = db.prepare("SELECT queueRevision FROM rooms WHERE roomId = ?").get(roomId) as {
        queueRevision: number;
      };
      expect(revisionAfter.queueRevision).toBe(revisionBefore.queueRevision + 1);
    });

    it("moves an item to the end of the queue when beforeQueueItemId is null", () => {
      const result = reorderQueueItem(db, roomId, a, null);
      expect(result).toEqual({ reordered: true, queue: expect.any(Array) });
      if (!result.reordered) throw new Error("unreachable");
      expect(result.queue.map((i) => i.queueItemId)).toEqual([b, c, a]);
    });

    it("costs nothing and bumps no revision when dropped back onto its original position", () => {
      const revisionBefore = db.prepare("SELECT queueRevision FROM rooms WHERE roomId = ?").get(roomId) as {
        queueRevision: number;
      };

      const result = reorderQueueItem(db, roomId, a, b); // a is already immediately before b — a no-op

      expect(result).toEqual({ reordered: false, reason: "no-op" });
      expect(listQueue(db, roomId).map((i) => i.queueItemId)).toEqual([a, b, c]);

      const revisionAfter = db.prepare("SELECT queueRevision FROM rooms WHERE roomId = ?").get(roomId) as {
        queueRevision: number;
      };
      expect(revisionAfter.queueRevision).toBe(revisionBefore.queueRevision);
    });

    it("rejects a queueItemId that doesn't exist in this room", () => {
      expect(reorderQueueItem(db, roomId, "does-not-exist", a)).toEqual({ reordered: false, reason: "not-found" });
    });

    it("rejects a beforeQueueItemId that doesn't exist in this room", () => {
      expect(reorderQueueItem(db, roomId, a, "does-not-exist")).toEqual({
        reordered: false,
        reason: "invalid-target",
      });
    });

    it("previewReorderQueue matches reorderQueueItem's would-change verdict without mutating anything", () => {
      expect(previewReorderQueue(db, roomId, c, a)).toBeNull();
      expect(previewReorderQueue(db, roomId, a, b)).toBe("no-op");
      expect(previewReorderQueue(db, roomId, "does-not-exist", a)).toBe("not-found");

      // Confirm the preview truly didn't mutate anything.
      expect(listQueue(db, roomId).map((i) => i.queueItemId)).toEqual([a, b, c]);
    });

    it("a successful reorder changes what getNextTrack reports as up next", () => {
      expect(getNextTrack(db, roomId)?.queueItemId).toBe(a);

      reorderQueueItem(db, roomId, c, a);

      expect(getNextTrack(db, roomId)?.queueItemId).toBe(c);
    });

    // Regression: the next track is always the first one positioned after
    // the playing one, so a reorder that touched the playing track, or put
    // an upcoming track in front of it, silently dropped that track from
    // what would ever play — while still counting as a successful reorder.
    describe("while a track is playing", () => {
      function playedOrder(): string[] {
        const played = [getCurrentPlayback(db, roomId)!.queueItemId];
        let next;
        while ((next = advanceToNextTrack(db, roomId))) played.push(next.queueItemId);
        return played;
      }

      beforeEach(() => {
        ensureCurrentTrack(db, roomId, a); // [a (playing), b, c]
      });

      it("refuses to move an upcoming track in front of the playing one", () => {
        expect(previewReorderQueue(db, roomId, b, a)).toBe("not-allowed");
        expect(reorderQueueItem(db, roomId, b, a)).toEqual({ reordered: false, reason: "not-allowed" });
        expect(playedOrder()).toEqual([a, b, c]);
      });

      it("refuses to move the playing track itself", () => {
        expect(reorderQueueItem(db, roomId, a, c)).toEqual({ reordered: false, reason: "not-allowed" });
        expect(reorderQueueItem(db, roomId, a, null)).toEqual({ reordered: false, reason: "not-allowed" });
        expect(playedOrder()).toEqual([a, b, c]);
      });

      // Finished tracks stay above the current one as history; the way
      // back is down, past the current track, to play again.
      it("keeps a finished track as history above the current one", () => {
        advanceToNextTrack(db, roomId); // a finished: [a (history), b (playing), c]
        expect(listQueue(db, roomId).map((i) => i.queueItemId)).toEqual([a, b, c]);
      });

      it("moves a history track down past the playing one, where it plays again", () => {
        advanceToNextTrack(db, roomId); // [a (history), b (playing), c]

        expect(reorderQueueItem(db, roomId, a, c).reordered).toBe(true); // right after b
        expect(listQueue(db, roomId).map((i) => i.queueItemId)).toEqual([b, a, c]);
        expect(getNextTrack(db, roomId)?.queueItemId).toBe(a);
        expect(playedOrder()).toEqual([b, a, c]);
      });

      it("moves a history track to the very end, to play last", () => {
        advanceToNextTrack(db, roomId);
        expect(reorderQueueItem(db, roomId, a, null).reordered).toBe(true);
        expect(playedOrder()).toEqual([b, c, a]);
      });

      it("never moves a history track up", () => {
        advanceToNextTrack(db, roomId);
        advanceToNextTrack(db, roomId); // [a, b (history), c (playing)]
        expect(reorderQueueItem(db, roomId, b, a)).toEqual({ reordered: false, reason: "not-allowed" });
        // Down within history is still down: harmless, and allowed.
        expect(reorderQueueItem(db, roomId, a, c).reordered).toBe(true);
        expect(listQueue(db, roomId).map((i) => i.queueItemId)).toEqual([b, a, c]);
      });

      it("reorders freely among the tracks still to come, and they then play in that order", () => {
        const result = reorderQueueItem(db, roomId, c, b);
        expect(result.reordered).toBe(true);
        expect(listQueue(db, roomId).map((i) => i.queueItemId)).toEqual([a, c, b]);
        expect(playedOrder()).toEqual([a, c, b]);
      });
    });
  });
});
