import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Account, YoutubeVideoMetadata } from "../../shared/src/types.ts";
import { computeExpectedPositionMs } from "../../shared/src/playbackSync.ts";
import { registerAccount } from "./accounts.ts";
import { openDatabase } from "./db.ts";
import {
  advanceToNextTrack,
  ensureCurrentTrack,
  getCurrentPlayback,
  getNextTrack,
  recordServerAlive,
  recoverPlaybackOnStartup,
  setPlaybackStatus,
} from "./playback.ts";
import { PresenceStore } from "./presence.ts";
import { addTrack, listQueue } from "./queue.ts";
import { createRoom } from "./rooms.ts";

describe("playback state and DJ role", () => {
  let dir: string;
  let dbPath: string;
  let db: DatabaseSync;
  let roomId: string;
  let alice: Account;
  let bob: Account;

  function fakeMetadataFor(catalogue: Record<string, Omit<YoutubeVideoMetadata, "videoId">>) {
    return async (videoId: string): Promise<YoutubeVideoMetadata | null> => {
      const entry = catalogue[videoId];
      return entry ? { videoId, ...entry } : null;
    };
  }

  const SONG_A_ID = "aaaaaaaaaaa";
  const SONG_B_ID = "bbbbbbbbbbb";
  const SONG_A = { title: "Song A", channelTitle: "Channel A", thumbnailUrl: "https://example.com/a.jpg", embeddable: true };
  const SONG_B = { title: "Song B", channelTitle: "Channel B", thumbnailUrl: "https://example.com/b.jpg", embeddable: true };
  const resolveMetadata = fakeMetadataFor({ [SONG_A_ID]: SONG_A, [SONG_B_ID]: SONG_B });

  // Mirrors exactly what the server does after a successful POST to the
  // queue route: add the track, then let it become current if nothing else
  // is already playing.
  async function addAndMaybeStart(accountId: string, videoId: string) {
    const item = await addTrack(db, roomId, accountId, videoId, { resolveMetadata });
    ensureCurrentTrack(db, roomId, item.queueItemId);
    return item;
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "echo-room-playback-"));
    dbPath = path.join(dir, "echo-room.sqlite");
    db = openDatabase(dbPath);
    alice = registerAccount(db, "client-alice", "Alice");
    bob = registerAccount(db, "client-bob", "Bob");
    roomId = createRoom(db, { accountId: alice.accountId, name: "Room", visibility: "PUBLIC", autoCloseEnabled: false }).roomId;
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed by a test that reopens the file
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("has no current playback in a room with an empty queue", () => {
    expect(getCurrentPlayback(db, roomId)).toBeNull();
    expect(getNextTrack(db, roomId)).toBeNull();
  });

  it("the first track ever added becomes current, with its adder as DJ", async () => {
    const item = await addAndMaybeStart(alice.accountId, SONG_A_ID);

    const current = getCurrentPlayback(db, roomId);
    expect(current?.queueItemId).toBe(item.queueItemId);
    expect(current?.videoId).toBe(SONG_A_ID);
    expect(current?.dj).toEqual({ accountId: alice.accountId, displayName: "Alice" });
    expect(current?.playbackId).toBeTruthy();
  });

  it("a second track added while one is already playing does not steal current — it becomes next", async () => {
    const first = await addAndMaybeStart(alice.accountId, SONG_A_ID);
    const second = await addAndMaybeStart(bob.accountId, SONG_B_ID);

    expect(getCurrentPlayback(db, roomId)?.queueItemId).toBe(first.queueItemId);
    expect(getNextTrack(db, roomId)?.queueItemId).toBe(second.queueItemId);
  });

  it("advancing to the next track changes the current DJ, since DJ belongs to the track", async () => {
    await addAndMaybeStart(alice.accountId, SONG_A_ID);
    const second = await addAndMaybeStart(bob.accountId, SONG_B_ID);

    const before = getCurrentPlayback(db, roomId);
    expect(before?.dj.accountId).toBe(alice.accountId);

    const after = advanceToNextTrack(db, roomId);
    expect(after?.queueItemId).toBe(second.queueItemId);
    expect(after?.dj).toEqual({ accountId: bob.accountId, displayName: "Bob" });
    expect(after?.playbackId).not.toBe(before?.playbackId);
  });

  it("advancing past the last track stops playback rather than wrapping around", async () => {
    await addAndMaybeStart(alice.accountId, SONG_A_ID);

    const after = advanceToNextTrack(db, roomId);
    expect(after).toBeNull();
    expect(getCurrentPlayback(db, roomId)).toBeNull();
  });

  it("a track added after the queue drains resumes playback (current was null)", async () => {
    await addAndMaybeStart(alice.accountId, SONG_A_ID);
    advanceToNextTrack(db, roomId);
    expect(getCurrentPlayback(db, roomId)).toBeNull();

    const resumed = await addAndMaybeStart(bob.accountId, SONG_B_ID);
    expect(getCurrentPlayback(db, roomId)?.queueItemId).toBe(resumed.queueItemId);
    expect(getCurrentPlayback(db, roomId)?.dj.accountId).toBe(bob.accountId);
  });

  // A finished (or skipped) track stays in the queue as history, above the
  // new current track — see queue.ts's placementAllowed for how it goes back on.
  it("keeps the finished track in the queue as history when advancing", async () => {
    const first = await addAndMaybeStart(alice.accountId, SONG_A_ID);
    const second = await addAndMaybeStart(bob.accountId, SONG_B_ID);

    advanceToNextTrack(db, roomId);

    expect(listQueue(db, roomId).map((q) => q.queueItemId)).toEqual([first.queueItemId, second.queueItemId]);
    expect(getCurrentPlayback(db, roomId)?.queueItemId).toBe(second.queueItemId);
  });

  it("advancing when nothing is playing is a no-op", () => {
    expect(advanceToNextTrack(db, roomId)).toBeNull();
    expect(getCurrentPlayback(db, roomId)).toBeNull();
  });

  it("does not break when the current DJ has never connected (no presence entry at all)", async () => {
    const item = await addAndMaybeStart(alice.accountId, SONG_A_ID);

    // A fresh, empty PresenceStore: alice has no live socket in this room at
    // all. Current playback/DJ lookup must be entirely unaffected — it never
    // consults presence.
    const presence = new PresenceStore();
    expect(presence.list(roomId)).toEqual([]);

    const current = getCurrentPlayback(db, roomId);
    expect(current?.queueItemId).toBe(item.queueItemId);
    expect(current?.dj.accountId).toBe(alice.accountId);
  });

  it("survives a database reopen (current playback is persisted, not in-memory)", async () => {
    const item = await addAndMaybeStart(alice.accountId, SONG_A_ID);
    db.close();

    const reopened = openDatabase(dbPath);
    const current = getCurrentPlayback(reopened, roomId);
    reopened.close();

    expect(current?.queueItemId).toBe(item.queueItemId);
    expect(current?.dj.accountId).toBe(alice.accountId);
  });

  it("never lets two concurrent first-additions to an empty room both become current", async () => {
    // Two tracks added "simultaneously" to a room with nothing playing yet:
    // ensureCurrentTrack's INSERT OR IGNORE must let exactly one of them win
    // the room's current-playback row, not throw and not silently duplicate.
    const [itemA, itemB] = await Promise.all([
      addTrack(db, roomId, alice.accountId, SONG_A_ID, { resolveMetadata }),
      addTrack(db, roomId, bob.accountId, SONG_B_ID, { resolveMetadata }),
    ]);
    ensureCurrentTrack(db, roomId, itemA.queueItemId);
    ensureCurrentTrack(db, roomId, itemB.queueItemId);

    const current = getCurrentPlayback(db, roomId);
    expect([itemA.queueItemId, itemB.queueItemId]).toContain(current?.queueItemId);

    // Whichever lost is still in the queue as "next", never lost or overwritten.
    const next = getNextTrack(db, roomId);
    const other = current?.queueItemId === itemA.queueItemId ? itemB : itemA;
    expect(next?.queueItemId).toBe(other.queueItemId);
  });

  it("ensureCurrentTrack returns the started PlaybackState only when it actually started playback", async () => {
    const item = await addTrack(db, roomId, alice.accountId, SONG_A_ID, { resolveMetadata });
    const started = ensureCurrentTrack(db, roomId, item.queueItemId);
    expect(started?.queueItemId).toBe(item.queueItemId);
    expect(started?.status).toBe("PLAYING");
    expect(started?.anchorPositionMs).toBe(0);
    expect(started?.revision).toBe(1);

    const second = await addTrack(db, roomId, bob.accountId, SONG_B_ID, { resolveMetadata });
    expect(ensureCurrentTrack(db, roomId, second.queueItemId)).toBeNull();
  });

  it("a freshly started track begins PLAYING at position 0, and computeExpectedPositionMs agrees", async () => {
    const before = Date.now();
    await addAndMaybeStart(alice.accountId, SONG_A_ID);
    const current = getCurrentPlayback(db, roomId)!;

    expect(current.status).toBe("PLAYING");
    expect(current.anchorPositionMs).toBe(0);
    expect(current.anchorServerTimeMs).toBeGreaterThanOrEqual(before);
    expect(computeExpectedPositionMs(current, current.anchorServerTimeMs)).toBe(0);
  });

  it("advancing to the next track carries revision forward rather than resetting it, while playbackId does change", async () => {
    await addAndMaybeStart(alice.accountId, SONG_A_ID);
    setPlaybackStatus(db, roomId, "PAUSED"); // bumps revision to 2
    await addAndMaybeStart(bob.accountId, SONG_B_ID);

    const before = getCurrentPlayback(db, roomId)!;
    expect(before.revision).toBe(2);

    const after = advanceToNextTrack(db, roomId)!;
    expect(after.playbackId).not.toBe(before.playbackId);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.status).toBe("PLAYING");
    expect(after.anchorPositionMs).toBe(0);
  });

  describe("setPlaybackStatus", () => {
    it("is a no-op (returns null) when nothing is currently playing", () => {
      expect(setPlaybackStatus(db, roomId, "PAUSED")).toBeNull();
    });

    it("is a no-op (same revision) when the requested status already matches", async () => {
      await addAndMaybeStart(alice.accountId, SONG_A_ID);
      const before = getCurrentPlayback(db, roomId)!;
      const result = setPlaybackStatus(db, roomId, "PLAYING");
      expect(result?.revision).toBe(before.revision);
      expect(result?.status).toBe("PLAYING");
    });

    it("pausing rebases the anchor at the expected position and bumps revision, and resuming continues from there", async () => {
      await addAndMaybeStart(alice.accountId, SONG_A_ID);
      const playing = getCurrentPlayback(db, roomId)!;

      const paused = setPlaybackStatus(db, roomId, "PAUSED")!;
      expect(paused.status).toBe("PAUSED");
      expect(paused.revision).toBe(playing.revision + 1);
      // Rebased at (approximately) the position it was playing at when paused
      // — never negative, and consistent with computeExpectedPositionMs.
      expect(paused.anchorPositionMs).toBeGreaterThanOrEqual(0);
      expect(computeExpectedPositionMs(paused, paused.anchorServerTimeMs)).toBe(paused.anchorPositionMs);

      // While paused, expected position never advances no matter how much
      // later we ask.
      expect(computeExpectedPositionMs(paused, paused.anchorServerTimeMs + 10_000)).toBe(paused.anchorPositionMs);

      const resumed = setPlaybackStatus(db, roomId, "PLAYING")!;
      expect(resumed.status).toBe("PLAYING");
      expect(resumed.revision).toBe(paused.revision + 1);
      // Resuming continues from exactly where it was paused, not reset to 0.
      expect(resumed.anchorPositionMs).toBe(paused.anchorPositionMs);
    });
  });

  describe("recoverPlaybackOnStartup", () => {
    it("leaves an already-PAUSED room untouched", async () => {
      await addAndMaybeStart(alice.accountId, SONG_A_ID);
      const paused = setPlaybackStatus(db, roomId, "PAUSED")!;

      recoverPlaybackOnStartup(db);

      const after = getCurrentPlayback(db, roomId)!;
      expect(after).toEqual(paused);
    });

    it("flips a PLAYING room to PAUSED, preserving anchorPositionMs exactly (no extrapolation through downtime)", async () => {
      await addAndMaybeStart(alice.accountId, SONG_A_ID);
      const playing = getCurrentPlayback(db, roomId)!;

      recoverPlaybackOnStartup(db);

      const recovered = getCurrentPlayback(db, roomId)!;
      expect(recovered.status).toBe("PAUSED");
      expect(recovered.anchorPositionMs).toBe(playing.anchorPositionMs);
      expect(recovered.revision).toBe(playing.revision + 1);
    });

    it("survives a literal simulated restart: close the db, reopen it, then recover", async () => {
      await addAndMaybeStart(alice.accountId, SONG_A_ID);
      const playing = getCurrentPlayback(db, roomId)!;
      db.close();

      const reopened = openDatabase(dbPath);
      recoverPlaybackOnStartup(reopened);
      const recovered = getCurrentPlayback(reopened, roomId)!;
      reopened.close();

      // Re-point db to a fresh open so afterEach's db.close() doesn't throw.
      db = openDatabase(dbPath);

      expect(recovered.status).toBe("PAUSED");
      expect(recovered.anchorPositionMs).toBe(playing.anchorPositionMs);
    });

    it("does nothing when no room has ever played anything", () => {
      expect(() => recoverPlaybackOnStartup(db)).not.toThrow();
    });

    // Regression: only the anchor was kept, and a track's anchor only moves
    // on a play/pause/seek — so every restart sent an untouched track back
    // to 0:00, however far into it the room had got.
    it("recovers a PLAYING track where it had got to by the server's last sign of life, not at its anchor", async () => {
      await addAndMaybeStart(alice.accountId, SONG_A_ID);
      const playing = getCurrentPlayback(db, roomId)!;
      recordServerAlive(db, playing.anchorServerTimeMs + 90_000); // last alive 90s into the track

      const restartedAt = playing.anchorServerTimeMs + 600_000; // down for a while after that
      recoverPlaybackOnStartup(db, restartedAt);

      const recovered = getCurrentPlayback(db, roomId)!;
      expect(recovered.status).toBe("PAUSED");
      // 90s in: never extrapolated through the downtime after the last sign of life.
      expect(recovered.anchorPositionMs).toBe(playing.anchorPositionMs + 90_000);
      expect(recovered.anchorServerTimeMs).toBe(restartedAt);
    });

    it("never moves a track backwards when the last sign of life predates its anchor", async () => {
      await addAndMaybeStart(alice.accountId, SONG_A_ID);
      const playing = getCurrentPlayback(db, roomId)!;
      recordServerAlive(db, playing.anchorServerTimeMs - 3_000);

      recoverPlaybackOnStartup(db, playing.anchorServerTimeMs + 60_000);

      expect(getCurrentPlayback(db, roomId)!.anchorPositionMs).toBe(playing.anchorPositionMs);
    });
  });
});
