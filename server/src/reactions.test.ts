import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Account } from "../../shared/src/types.ts";
import { registerAccount } from "./accounts.ts";
import { openDatabase } from "./db.ts";
import { isReactionEmoji, listReactionsForVideo, recordReaction } from "./reactions.ts";
import { createRoom } from "./rooms.ts";

describe("isReactionEmoji", () => {
  it("accepts exactly the fixed set", () => {
    expect(isReactionEmoji("❤️")).toBe(true);
    expect(isReactionEmoji("🔥")).toBe(true);
    expect(isReactionEmoji("😭")).toBe(true);
    expect(isReactionEmoji("✨")).toBe(true);
  });

  it("rejects anything outside the fixed set, including free text (no chat allowed)", () => {
    expect(isReactionEmoji("👍")).toBe(false);
    expect(isReactionEmoji("hello")).toBe(false);
    expect(isReactionEmoji("")).toBe(false);
    expect(isReactionEmoji(undefined)).toBe(false);
    expect(isReactionEmoji(42)).toBe(false);
  });
});

describe("reactions (DB-backed)", () => {
  let dir: string;
  let dbPath: string;
  let db: DatabaseSync;
  let roomId: string;
  let alice: Account;
  let bob: Account;

  const T0 = 1_700_000_000_000;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "echo-room-reactions-"));
    dbPath = path.join(dir, "echo-room.sqlite");
    db = openDatabase(dbPath);
    alice = registerAccount(db, "client-alice", "Alice");
    bob = registerAccount(db, "client-bob", "Bob");
    roomId = createRoom(db, { accountId: alice.accountId, name: "Room", visibility: "PUBLIC", autoCloseEnabled: false })
      .roomId;
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed by a test that reopens the file
    }
    rmSync(dir, { recursive: true, force: true });
  });

  describe("recordReaction / listReactionsForVideo (persistence)", () => {
    it("persists every required field exactly as given", () => {
      const reaction = recordReaction(db, {
        roomId,
        videoId: "abc123",
        playbackId: "playback-1",
        accountId: alice.accountId,
        displayName: "Alice",
        reaction: "🔥",
        positionMs: 42_000,
        nowMs: T0,
      });

      expect(reaction).toEqual({
        reactionId: expect.any(String),
        roomId,
        videoId: "abc123",
        playbackId: "playback-1",
        accountId: alice.accountId,
        displayName: "Alice",
        reaction: "🔥",
        positionMs: 42_000,
        createdAt: new Date(T0).toISOString(),
      });
    });

    it("a recorded reaction is immediately visible via listReactionsForVideo", () => {
      recordReaction(db, {
        roomId,
        videoId: "abc123",
        playbackId: "playback-1",
        accountId: alice.accountId,
        displayName: "Alice",
        reaction: "❤️",
        positionMs: 1_000,
        nowMs: T0,
      });

      const list = listReactionsForVideo(db, roomId, "abc123");
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ reaction: "❤️", positionMs: 1_000, accountId: alice.accountId });
    });

    it("survives closing and reopening the database file", () => {
      recordReaction(db, {
        roomId,
        videoId: "abc123",
        playbackId: "playback-1",
        accountId: alice.accountId,
        displayName: "Alice",
        reaction: "✨",
        positionMs: 5_000,
        nowMs: T0,
      });
      db.close();

      const reopened = openDatabase(dbPath);
      const list = listReactionsForVideo(reopened, roomId, "abc123");
      reopened.close();
      db = openDatabase(dbPath);

      expect(list).toHaveLength(1);
      expect(list[0].reaction).toBe("✨");
    });

    it("is ordered by positionMs ascending regardless of insertion order", () => {
      recordReaction(db, {
        roomId,
        videoId: "abc123",
        playbackId: "playback-1",
        accountId: alice.accountId,
        displayName: "Alice",
        reaction: "😭",
        positionMs: 30_000,
        nowMs: T0,
      });
      recordReaction(db, {
        roomId,
        videoId: "abc123",
        playbackId: "playback-1",
        accountId: bob.accountId,
        displayName: "Bob",
        reaction: "🔥",
        positionMs: 10_000,
        nowMs: T0 + 1,
      });

      const list = listReactionsForVideo(db, roomId, "abc123");
      expect(list.map((r) => r.positionMs)).toEqual([10_000, 30_000]);
    });

    it("scopes strictly by (roomId, videoId) — a different room or video never leaks in", () => {
      const otherRoomId = createRoom(db, {
        accountId: alice.accountId,
        name: "Other room",
        visibility: "PUBLIC",
        autoCloseEnabled: false,
      }).roomId;

      recordReaction(db, {
        roomId,
        videoId: "abc123",
        playbackId: "playback-1",
        accountId: alice.accountId,
        displayName: "Alice",
        reaction: "❤️",
        positionMs: 1_000,
        nowMs: T0,
      });
      recordReaction(db, {
        roomId,
        videoId: "different-video",
        playbackId: "playback-1",
        accountId: alice.accountId,
        displayName: "Alice",
        reaction: "❤️",
        positionMs: 1_000,
        nowMs: T0,
      });
      recordReaction(db, {
        roomId: otherRoomId,
        videoId: "abc123",
        playbackId: "playback-2",
        accountId: alice.accountId,
        displayName: "Alice",
        reaction: "❤️",
        positionMs: 1_000,
        nowMs: T0,
      });

      expect(listReactionsForVideo(db, roomId, "abc123")).toHaveLength(1);
    });
  });

  describe("historical echo / timestamp matching", () => {
    it("a reaction recorded during an earlier playbackId still surfaces when the same video plays again under a new playbackId", () => {
      // First play-through: playbackId "playback-1".
      const original = recordReaction(db, {
        roomId,
        videoId: "abc123",
        playbackId: "playback-1",
        accountId: alice.accountId,
        displayName: "Alice",
        reaction: "🔥",
        positionMs: 15_000,
        nowMs: T0,
      });

      // Much later, the same video starts again under a brand new
      // playbackId (a fresh "now playing" instance) — the historical
      // reaction must still be found by (roomId, videoId) alone.
      const muchLater = T0 + 7 * 24 * 60 * 60 * 1000;
      const replayed = listReactionsForVideo(db, roomId, "abc123");

      expect(replayed).toHaveLength(1);
      expect(replayed[0].reactionId).toBe(original.reactionId);
      // The original position and date are preserved verbatim — a replay
      // must show the reaction's *original* timestamp, never today's.
      expect(replayed[0].positionMs).toBe(15_000);
      expect(replayed[0].createdAt).toBe(new Date(T0).toISOString());
      expect(replayed[0].createdAt).not.toBe(new Date(muchLater).toISOString());
      // playbackId on the stored row is still the original one — matching
      // never depended on it lining up with the new playthrough's playbackId.
      expect(replayed[0].playbackId).toBe("playback-1");
    });

    it("reactions from many distinct historical playbackIds of the same video all reappear together, ordered by original position", () => {
      recordReaction(db, {
        roomId,
        videoId: "abc123",
        playbackId: "playback-1",
        accountId: alice.accountId,
        displayName: "Alice",
        reaction: "❤️",
        positionMs: 5_000,
        nowMs: T0,
      });
      recordReaction(db, {
        roomId,
        videoId: "abc123",
        playbackId: "playback-2", // a second, later playthrough
        accountId: bob.accountId,
        displayName: "Bob",
        reaction: "✨",
        positionMs: 20_000,
        nowMs: T0 + 1_000_000,
      });
      recordReaction(db, {
        roomId,
        videoId: "abc123",
        playbackId: "playback-3", // a third playthrough
        accountId: alice.accountId,
        displayName: "Alice",
        reaction: "😭",
        positionMs: 12_000,
        nowMs: T0 + 2_000_000,
      });

      const list = listReactionsForVideo(db, roomId, "abc123");
      expect(list.map((r) => ({ playbackId: r.playbackId, positionMs: r.positionMs }))).toEqual([
        { playbackId: "playback-1", positionMs: 5_000 },
        { playbackId: "playback-3", positionMs: 12_000 },
        { playbackId: "playback-2", positionMs: 20_000 },
      ]);
    });
  });
});
