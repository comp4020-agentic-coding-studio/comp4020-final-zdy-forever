import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, YoutubeVideoMetadata } from "../../shared/src/types.ts";
import { registerAccount } from "./accounts.ts";
import { openDatabase } from "./db.ts";
import { advanceToNextTrack, ensureCurrentTrack, getCurrentPlayback, getNextTrack, setPlaybackStatus } from "./playback.ts";
import { ProposalManager, type ProposalBroadcast } from "./proposals.ts";
import { addTrack, getQueueRevision, listQueue, removeQueueItem } from "./queue.ts";
import { createRoom, getRoomById } from "./rooms.ts";

// A minimal io.Server stand-in: ProposalManager only ever calls
// io.to(roomId).emit(event, payload), so a fake this thin is enough to
// capture every broadcast without pulling in a real Socket.IO server.
function fakeIo() {
  const emitted: Array<{ roomId: string; event: string; payload: unknown }> = [];
  const io = {
    to(roomId: string) {
      return {
        emit(event: string, payload: unknown) {
          emitted.push({ roomId, event, payload });
        },
      };
    },
  };
  return { io: io as unknown as import("socket.io").Server, emitted };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SONG_ID = "aaaaaaaaaaa";

describe("ProposalManager", () => {
  let dir: string;
  let db: DatabaseSync;
  let roomId: string;
  let alice: Account;
  let bob: Account;
  let carol: Account;

  const SONG: YoutubeVideoMetadata = {
    videoId: SONG_ID,
    title: "Song A",
    channelTitle: "Channel A",
    thumbnailUrl: "https://example.com/a.jpg",
    embeddable: true,
  };
  const resolveMetadata = async (videoId: string): Promise<YoutubeVideoMetadata | null> =>
    videoId === SONG_ID ? SONG : null;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "echo-room-proposals-"));
    db = openDatabase(path.join(dir, "echo-room.sqlite"));
    alice = registerAccount(db, "client-alice", "Alice");
    bob = registerAccount(db, "client-bob", "Bob");
    carol = registerAccount(db, "client-carol", "Carol");
    roomId = createRoom(db, {
      accountId: alice.accountId,
      name: "Room",
      visibility: "PUBLIC",
      autoCloseEnabled: false,
    }).roomId;

    const item = await addTrack(db, roomId, alice.accountId, SONG_ID, { resolveMetadata });
    ensureCurrentTrack(db, roomId, item.queueItemId);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes immediately when both present accounts vote YES and cancels the timer", () => {
    vi.useFakeTimers();
    const manager = new ProposalManager(() => [alice.accountId, bob.accountId]);
    const { io, emitted } = fakeIo();
    try {
      const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "PAUSE", { presentCount: 2 });
      if (!requested.ok) throw new Error(requested.error);
      expect(getCurrentPlayback(db, roomId)?.status).toBe("PLAYING");
      const result = manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "YES");
      expect(result.ok && result.proposal.state).toBe("PASSED");
      expect(getCurrentPlayback(db, roomId)?.status).toBe("PAUSED");
      expect(manager.getActiveProposal(roomId)).toBeNull();
      const updates = emitted.filter((event) => event.event === "playback:update").length;
      vi.advanceTimersByTime(15_000);
      expect(emitted.filter((event) => event.event === "playback:update")).toHaveLength(updates);
    } finally { manager.dispose(); vi.useRealTimers(); }
  });

  it("waits for an abstaining member, then immediately passes a 2 YES / 1 NO majority", () => {
    const manager = new ProposalManager(() => [alice.accountId, bob.accountId, carol.accountId]);
    const { io } = fakeIo();
    try {
      const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "PAUSE");
      if (!requested.ok) throw new Error(requested.error);
      manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "YES");
      expect(manager.getActiveProposal(roomId)?.state).toBe("OPEN");
      manager.castVote(io, db, roomId, requested.proposal.proposalId, carol.accountId, "NO");
      expect(getCurrentPlayback(db, roomId)?.status).toBe("PAUSED");
      expect(manager.getActiveProposal(roomId)).toBeNull();
    } finally { manager.dispose(); }
  });

  it.each(["tie", "no-majority"])("fails immediately when everyone voted with a %s", (outcome) => {
    vi.useFakeTimers();
    const present = outcome === "tie" ? [alice.accountId, bob.accountId] : [alice.accountId, bob.accountId, carol.accountId];
    const manager = new ProposalManager(() => present);
    const { io, emitted } = fakeIo();
    try {
      const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "PAUSE");
      if (!requested.ok) throw new Error(requested.error);
      manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "NO");
      if (outcome !== "tie") {
        expect(manager.getActiveProposal(roomId)?.state).toBe("OPEN");
        manager.castVote(io, db, roomId, requested.proposal.proposalId, carol.accountId, "NO");
      }
      expect(manager.getActiveProposal(roomId)).toBeNull();
      expect(getCurrentPlayback(db, roomId)?.status).toBe("PLAYING");
      expect(emitted.at(-1)?.payload).toMatchObject({ proposal: { state: "FAILED" }, applied: false });
      const count = emitted.length;
      vi.advanceTimersByTime(15_000);
      expect(emitted).toHaveLength(count);
      expect(manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "YES").ok).toBe(false);
    } finally { manager.dispose(); vi.useRealTimers(); }
  });

  it("does not substitute a departed YES vote for a newly joined member", () => {
    const manager = new ProposalManager(() => [alice.accountId, carol.accountId]);
    const { io } = fakeIo();
    try {
      const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "PAUSE");
      if (!requested.ok) throw new Error(requested.error);
      manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "YES");
      expect(manager.getActiveProposal(roomId)?.state).toBe("OPEN");
      expect(getCurrentPlayback(db, roomId)?.status).toBe("PLAYING");
    } finally { manager.dispose(); }
  });

  it("still rejects applying a stale proposal even when everybody agrees early", () => {
    const manager = new ProposalManager(() => [alice.accountId, bob.accountId]);
    const { io, emitted } = fakeIo();
    try {
      const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "PAUSE");
      if (!requested.ok) throw new Error(requested.error);
      setPlaybackStatus(db, roomId, "PAUSED");
      const rebased = setPlaybackStatus(db, roomId, "PLAYING");
      manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "YES");
      expect(getCurrentPlayback(db, roomId)).toEqual(rebased);
      expect(emitted.at(-1)?.payload).toMatchObject({ proposal: { state: "PASSED" }, applied: false });
    } finally { manager.dispose(); }
  });

  it("replays an exhausted queue from the chosen item at zero, then follows the existing order", async () => {
    const manager = new ProposalManager();
    const { io, emitted } = fakeIo();
    const firstPlaybackId = getCurrentPlayback(db, roomId)!.playbackId;
    const second = await addTrack(db, roomId, bob.accountId, "bbbbbbbbbbb", {
      resolveMetadata: async (videoId) => ({ ...SONG, videoId }),
    });
    const third = await addTrack(db, roomId, alice.accountId, "ccccccccccc", {
      resolveMetadata: async (videoId) => ({ ...SONG, videoId }),
    });
    while (getCurrentPlayback(db, roomId)) advanceToNextTrack(db, roomId);
    const before = listQueue(db, roomId);
    const result = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "REPLAY_QUEUE_ITEM", {
      queueItemId: second.queueItemId, presentCount: 1,
    });

    expect(result.ok).toBe(true);
    expect(getCurrentPlayback(db, roomId)).toMatchObject({
      queueItemId: second.queueItemId, status: "PLAYING", anchorPositionMs: 0,
      dj: { accountId: bob.accountId },
    });
    expect(getCurrentPlayback(db, roomId)!.playbackId).not.toBe(firstPlaybackId);
    expect(listQueue(db, roomId)).toEqual(before);
    expect(emitted.some((event) => event.event === "playback:update")).toBe(true);
    expect(advanceToNextTrack(db, roomId)?.queueItemId).toBe(third.queueItemId);
    expect(advanceToNextTrack(db, roomId)).toBeNull();
    manager.dispose();
  });

  it.each(["PLAYING", "PAUSED"] as const)("rejects queue replay while playback is %s", (status) => {
    const manager = new ProposalManager();
    const { io } = fakeIo();
    setPlaybackStatus(db, roomId, status);
    const before = getCurrentPlayback(db, roomId)!;
    expect(manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "REPLAY_QUEUE_ITEM", {
      queueItemId: before.queueItemId, presentCount: 1,
    }).ok).toBe(false);
    expect(getCurrentPlayback(db, roomId)).toEqual(before);
    manager.dispose();
  });

  it("rejects missing and foreign-room replay targets", async () => {
    const manager = new ProposalManager();
    const { io } = fakeIo();
    advanceToNextTrack(db, roomId);
    const other = createRoom(db, { accountId: alice.accountId, name: "Other", visibility: "PUBLIC", autoCloseEnabled: false });
    const foreign = await addTrack(db, other.roomId, alice.accountId, SONG_ID, { resolveMetadata });
    for (const queueItemId of [undefined, "missing", foreign.queueItemId]) {
      expect(manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "REPLAY_QUEUE_ITEM", {
        queueItemId, presentCount: 1,
      }).ok).toBe(false);
    }
    expect(getCurrentPlayback(db, roomId)).toBeNull();
    manager.dispose();
  });

  it.each(["unchanged", "removed", "started"] as const)("resolves replay voting safely when the target is %s", (change) => {
    vi.useFakeTimers();
    const manager = new ProposalManager();
    const { io, emitted } = fakeIo();
    try {
      const target = getCurrentPlayback(db, roomId)!.queueItemId;
      advanceToNextTrack(db, roomId);
      const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "REPLAY_QUEUE_ITEM", {
        queueItemId: target, presentCount: 2,
      });
      expect(requested.ok).toBe(true);
      if (!requested.ok) return;
      expect(getCurrentPlayback(db, roomId)).toBeNull();
      manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "YES");
      if (change === "removed") removeQueueItem(db, roomId, target);
      if (change === "started") ensureCurrentTrack(db, roomId, target);
      const before = getCurrentPlayback(db, roomId);
      vi.advanceTimersByTime(15_000);
      const final = emitted.filter((event) => event.event === "proposal:update").at(-1)!.payload as ProposalBroadcast;
      expect(final.applied).toBe(change === "unchanged");
      if (change === "unchanged") expect(getCurrentPlayback(db, roomId)?.queueItemId).toBe(target);
      else expect(getCurrentPlayback(db, roomId)).toEqual(before);
    } finally {
      manager.dispose();
      vi.useRealTimers();
    }
  });

  it("resolves a PAUSE proposal that passes and applies it to authoritative playback", async () => {
    const manager = new ProposalManager();
    const { io, emitted } = fakeIo();

    const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "PAUSE", {
      votingWindowMs: 20,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    // Alice (proposer) auto-voted YES; Bob provides the second non-abstain
    // vote needed to clear the minimum-2 threshold.
    const voted = manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "YES");
    expect(voted.ok).toBe(true);

    await sleep(60);

    expect(manager.getActiveProposal(roomId)).toBeNull();
    const current = getCurrentPlayback(db, roomId);
    expect(current?.status).toBe("PAUSED");

    const resolutions = emitted.filter((e) => e.event === "proposal:update").map((e) => e.payload as ProposalBroadcast);
    const final = resolutions[resolutions.length - 1];
    expect(final.proposal.state).toBe("PASSED");
    expect(final.applied).toBe(true);

    expect(emitted.some((e) => e.event === "playback:update")).toBe(true);
  });

  it("fails a proposal with only one non-abstain vote (the proposer's own) and leaves playback unchanged", async () => {
    const manager = new ProposalManager();
    const { io, emitted } = fakeIo();

    const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "PAUSE", {
      votingWindowMs: 20,
    });
    expect(requested.ok).toBe(true);

    await sleep(60);

    const current = getCurrentPlayback(db, roomId);
    expect(current?.status).toBe("PLAYING");

    const resolutions = emitted.filter((e) => e.event === "proposal:update").map((e) => e.payload as ProposalBroadcast);
    const final = resolutions[resolutions.length - 1];
    expect(final.proposal.state).toBe("FAILED");
    expect(final.applied).toBe(false);
  });

  it("fails a tied vote (one YES, one NO) even though the minimum vote count is met", async () => {
    const manager = new ProposalManager();
    const { io, emitted } = fakeIo();

    const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "PAUSE", {
      votingWindowMs: 20,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "NO");

    await sleep(60);

    expect(getCurrentPlayback(db, roomId)?.status).toBe("PLAYING");
    const resolutions = emitted.filter((e) => e.event === "proposal:update").map((e) => e.payload as ProposalBroadcast);
    expect(resolutions[resolutions.length - 1].proposal.state).toBe("FAILED");
  });

  // --- duplicate vote --------------------------------------------------

  it("a duplicate vote from the same account replaces their earlier ballot rather than counting twice", async () => {
    const manager = new ProposalManager();
    const { io } = fakeIo();

    const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "PAUSE", {
      votingWindowMs: 5_000,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    const first = manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "YES");
    expect(first.ok).toBe(true);
    const second = manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "NO");
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.proposal.votes[bob.accountId]).toBe("NO");
    expect(Object.keys(second.proposal.votes)).toHaveLength(2); // alice + bob, not three entries
  });

  // --- concurrent proposals ---------------------------------------------

  it("rejects a second proposal request while one is already open in the same room", () => {
    const manager = new ProposalManager();
    const { io } = fakeIo();

    const first = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "PAUSE", {
      votingWindowMs: 5_000,
    });
    expect(first.ok).toBe(true);

    const second = manager.requestPlaybackProposal(io, db, roomId, bob.accountId, "PAUSE", { votingWindowMs: 5_000 });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toMatch(/already in progress/);
  });

  it("allows a fresh proposal in the same room once the previous one has resolved", async () => {
    const manager = new ProposalManager();
    const { io } = fakeIo();

    const first = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "PAUSE", { votingWindowMs: 20 });
    expect(first.ok).toBe(true);
    await sleep(60);
    // First proposal failed (only proposer voted), so playback is still PLAYING.

    const second = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "PAUSE", { votingWindowMs: 5_000 });
    expect(second.ok).toBe(true);
  });

  // --- stale playback revision -------------------------------------------

  it("does not apply a passed proposal whose reference has gone stale by resolution time", async () => {
    const manager = new ProposalManager();
    const { io, emitted } = fakeIo();

    const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "PAUSE", {
      votingWindowMs: 20,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "YES");

    // Something else (e.g. a track transition) rebases playback state before
    // the vote closes, invalidating the proposal's captured reference.
    setPlaybackStatus(db, roomId, "PAUSED");
    setPlaybackStatus(db, roomId, "PLAYING");

    await sleep(60);

    const resolutions = emitted.filter((e) => e.event === "proposal:update").map((e) => e.payload as ProposalBroadcast);
    const final = resolutions[resolutions.length - 1];
    expect(final.proposal.state).toBe("PASSED");
    expect(final.applied).toBe(false);
    // The out-of-band flip landed it back on PLAYING; the stale PAUSE
    // proposal must not have flipped it again.
    expect(getCurrentPlayback(db, roomId)?.status).toBe("PLAYING");
  });

  // --- Play proposal while already playing / Pause while already paused --

  it("rejects a PLAY proposal request when the room is already playing", () => {
    const manager = new ProposalManager();
    const { io } = fakeIo();

    const result = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "PLAY", { votingWindowMs: 5_000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/already playing/);
  });

  it("rejects a PAUSE proposal request when the room is already paused", () => {
    setPlaybackStatus(db, roomId, "PAUSED");
    const manager = new ProposalManager();
    const { io } = fakeIo();

    const result = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "PAUSE", { votingWindowMs: 5_000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/already paused/);
  });

  // --- participant disconnect during vote --------------------------------

  it("resolves normally when a voter never casts a ballot (equivalent to a disconnect mid-vote)", async () => {
    // Carol never votes at all here — from the engine's point of view this
    // is indistinguishable from Carol having disconnected before voting: her
    // absence is simply an ABSTAIN, excluded from the denominator, and does
    // not block the other two votes from resolving the proposal.
    const manager = new ProposalManager();
    const { io, emitted } = fakeIo();

    const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "PAUSE", {
      votingWindowMs: 20,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "YES");
    void carol;

    await sleep(60);

    expect(getCurrentPlayback(db, roomId)?.status).toBe("PAUSED");
    const resolutions = emitted.filter((e) => e.event === "proposal:update").map((e) => e.payload as ProposalBroadcast);
    expect(resolutions[resolutions.length - 1].proposal.state).toBe("PASSED");
  });

  it("a vote cast after the window has closed is rejected and does not affect the outcome", async () => {
    const manager = new ProposalManager();
    const { io } = fakeIo();

    const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "PAUSE", {
      votingWindowMs: 20,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    await sleep(60);

    const lateVote = manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "YES");
    expect(lateVote.ok).toBe(false);
  });

  it("rejects a vote referencing a proposalId that isn't the room's current active proposal", () => {
    const manager = new ProposalManager();
    const { io } = fakeIo();

    const result = manager.castVote(io, db, roomId, "not-a-real-id", bob.accountId, "YES");
    expect(result.ok).toBe(false);
  });

  it("keeps proposals in separate rooms fully independent", async () => {
    const manager = new ProposalManager();
    const { io } = fakeIo();

    const otherRoomId = createRoom(db, {
      accountId: bob.accountId,
      name: "Other room",
      visibility: "PUBLIC",
      autoCloseEnabled: false,
    }).roomId;
    const item = await addTrack(db, otherRoomId, bob.accountId, SONG_ID, { resolveMetadata });
    ensureCurrentTrack(db, otherRoomId, item.queueItemId);

    const first = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "PAUSE", { votingWindowMs: 5_000 });
    const second = manager.requestPlaybackProposal(io, db, otherRoomId, bob.accountId, "PAUSE", {
      votingWindowMs: 5_000,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  it("rejects a proposal request in a room with nothing currently playing", () => {
    const manager = new ProposalManager();
    const { io } = fakeIo();

    const emptyRoomId = createRoom(db, {
      accountId: alice.accountId,
      name: "Empty room",
      visibility: "PUBLIC",
      autoCloseEnabled: false,
    }).roomId;

    const result = manager.requestPlaybackProposal(io, db, emptyRoomId, alice.accountId, "PLAY", {
      votingWindowMs: 5_000,
    });
    expect(result.ok).toBe(false);
  });

  // --- SKIP ----------------------------------------------------------------

  it("a SKIP proposal references the current playback (kind + playbackId)", () => {
    const manager = new ProposalManager();
    const { io } = fakeIo();
    const before = getCurrentPlayback(db, roomId)!;

    const result = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "SKIP", {
      votingWindowMs: 5_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.reference).toEqual({
      kind: "playback",
      playbackId: before.playbackId,
      revision: before.revision,
    });
  });

  it("advances to the next queue item, assigns a new playbackId, and updates the DJ when a SKIP proposal passes", async () => {
    const manager = new ProposalManager();
    const { io, emitted } = fakeIo();
    const before = getCurrentPlayback(db, roomId)!;

    const nextItem = await addTrack(db, roomId, bob.accountId, SONG_ID, { resolveMetadata });

    const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "SKIP", {
      votingWindowMs: 20,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "YES");

    await sleep(60);

    const after = getCurrentPlayback(db, roomId);
    expect(after?.queueItemId).toBe(nextItem.queueItemId);
    expect(after?.playbackId).not.toBe(before.playbackId);
    expect(after?.status).toBe("PLAYING");
    expect(after?.dj.accountId).toBe(bob.accountId);

    const resolutions = emitted.filter((e) => e.event === "proposal:update").map((e) => e.payload as ProposalBroadcast);
    const final = resolutions[resolutions.length - 1];
    expect(final.proposal.state).toBe("PASSED");
    expect(final.applied).toBe(true);
    expect(emitted.some((e) => e.event === "playback:update")).toBe(true);
  });

  it("a SKIP proposal that goes stale before resolving is never applied, and never skips the track that's now actually playing", async () => {
    // Three tracks queued: the one already playing (A, from beforeEach), B,
    // and C. A SKIP proposal is opened while A is current (referencing A).
    // Before it resolves, something else (simulated directly here, but
    // equally an unrelated natural end or a second SKIP) advances playback
    // to B. The stale SKIP-on-A proposal must not then also advance B to C
    // — one vote about one track must never affect the next.
    const manager = new ProposalManager();
    const { io, emitted } = fakeIo();

    await addTrack(db, roomId, bob.accountId, SONG_ID, { resolveMetadata }); // B
    await addTrack(db, roomId, bob.accountId, SONG_ID, { resolveMetadata }); // C

    const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "SKIP", {
      votingWindowMs: 30,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "YES");

    const movedToB = advanceToNextTrack(db, roomId);

    await sleep(60);

    const final = getCurrentPlayback(db, roomId);
    // Still on B — the stale SKIP-on-A proposal did not additionally skip to C.
    expect(final?.playbackId).toBe(movedToB?.playbackId);
    expect(final?.queueItemId).toBe(movedToB?.queueItemId);

    const resolutions = emitted.filter((e) => e.event === "proposal:update").map((e) => e.payload as ProposalBroadcast);
    const last = resolutions[resolutions.length - 1];
    expect(last.proposal.state).toBe("PASSED");
    expect(last.applied).toBe(false);
  });

  it("a DB write failure while applying a passed SKIP never crashes resolution — it reports PASSED-but-not-applied, leaves playback untouched, and frees the room for a fresh proposal", async () => {
    // Regression test: resolveRoom's real setTimeout callback used to have
    // no error handling around applying a passed vote. A thrown error there
    // (a full disk, a locked file, ...) would be an uncaught exception that
    // crashes the entire process, not just this one room. This simulates
    // that failure by making the SKIP branch's own persisting statement
    // (advanceToNextTrack's INSERT INTO room_playback) throw.
    const manager = new ProposalManager();
    const { io, emitted } = fakeIo();
    const before = getCurrentPlayback(db, roomId)!;

    await addTrack(db, roomId, bob.accountId, SONG_ID, { resolveMetadata });

    const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "SKIP", {
      votingWindowMs: 20,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "YES");

    const realPrepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("INSERT INTO room_playback")) {
        throw new Error("simulated disk write failure");
      }
      return realPrepare(sql);
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await sleep(60);

    spy.mockRestore();
    consoleSpy.mockRestore();

    // Playback is exactly as it was before the vote — no half-applied skip:
    // the track is still current, and still in the queue.
    expect(getCurrentPlayback(db, roomId)).toEqual(before);
    expect(listQueue(db, roomId).some((q) => q.queueItemId === before.queueItemId)).toBe(true);

    const resolutions = emitted.filter((e) => e.event === "proposal:update").map((e) => e.payload as ProposalBroadcast);
    const last = resolutions[resolutions.length - 1];
    expect(last.proposal.state).toBe("PASSED");
    expect(last.applied).toBe(false);
    expect(emitted.some((e) => e.event === "playback:update")).toBe(false);

    // The room is not left stuck: a fresh proposal can be requested right away.
    expect(manager.getActiveProposal(roomId)).toBeNull();
    const retried = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "SKIP", { votingWindowMs: 20 });
    expect(retried.ok).toBe(true);
  });

  it("invalidates an open SKIP proposal immediately when its track naturally ends, and advances to the next item exactly once", async () => {
    const manager = new ProposalManager();
    const { io, emitted } = fakeIo();
    const before = getCurrentPlayback(db, roomId)!;
    const nextItem = await addTrack(db, roomId, bob.accountId, SONG_ID, { resolveMetadata });

    const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "SKIP", {
      votingWindowMs: 30,
    });
    expect(requested.ok).toBe(true);

    manager.handleTrackEnded(io, db, roomId, before.playbackId, { accountId: alice.accountId, presentCount: 1 });

    // Invalidated synchronously: no more active proposal, and the room has
    // already moved on, well before the original 30ms window would fire.
    expect(manager.getActiveProposal(roomId)).toBeNull();
    const afterEnd = getCurrentPlayback(db, roomId);
    expect(afterEnd?.queueItemId).toBe(nextItem.queueItemId);

    const invalidated = emitted
      .filter((e) => e.event === "proposal:update")
      .map((e) => e.payload as ProposalBroadcast)
      .at(-1)!;
    expect(invalidated.proposal.state).toBe("FAILED");
    expect(invalidated.applied).toBe(false);

    // The original timer must genuinely be cancelled, not merely ignored:
    // waiting past the original window must produce no further transition.
    await sleep(60);
    expect(getCurrentPlayback(db, roomId)?.queueItemId).toBe(nextItem.queueItemId);
    expect(emitted.filter((e) => e.event === "playback:update")).toHaveLength(1);
  });

  it("ignores a playback:ended report whose playbackId does not match the room's current playback", () => {
    const manager = new ProposalManager();
    const { io, emitted } = fakeIo();
    const before = getCurrentPlayback(db, roomId)!;

    manager.handleTrackEnded(io, db, roomId, "not-the-real-playback-id", { accountId: alice.accountId, presentCount: 1 });

    expect(getCurrentPlayback(db, roomId)?.playbackId).toBe(before.playbackId);
    expect(emitted).toHaveLength(0);
  });

  it("treats a second playback:ended report for the same (now superseded) track as stale and does not double-advance", async () => {
    // Simulates two clients whose players both reach the end around the
    // same moment and both report it.
    const manager = new ProposalManager();
    const { io } = fakeIo();
    const before = getCurrentPlayback(db, roomId)!;
    const b = await addTrack(db, roomId, bob.accountId, SONG_ID, { resolveMetadata });
    await addTrack(db, roomId, bob.accountId, SONG_ID, { resolveMetadata }); // C, should never be reached

    manager.handleTrackEnded(io, db, roomId, before.playbackId, { accountId: alice.accountId, presentCount: 1 });
    const afterFirst = getCurrentPlayback(db, roomId);
    expect(afterFirst?.queueItemId).toBe(b.queueItemId);

    // Second, late report still names the now-superseded playbackId.
    manager.handleTrackEnded(io, db, roomId, before.playbackId, { accountId: alice.accountId, presentCount: 1 });
    const afterSecond = getCurrentPlayback(db, roomId);
    expect(afterSecond?.queueItemId).toBe(b.queueItemId);
    expect(afterSecond?.playbackId).toBe(afterFirst?.playbackId);
  });

  it("a track added to the queue mid-vote does not change what an in-flight SKIP proposal skips to", async () => {
    // B is already queued before the vote opens, so it is the legitimate
    // "next" track; C is added only after the vote is already open. The
    // proposal itself carries no snapshot of "next" — getNextTrack is
    // consulted fresh at resolution time — so this also doubles as coverage
    // for "queue update concurrent with an open proposal".
    const manager = new ProposalManager();
    const { io } = fakeIo();
    const b = await addTrack(db, roomId, bob.accountId, SONG_ID, { resolveMetadata });

    const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "SKIP", {
      votingWindowMs: 30,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "YES");

    await addTrack(db, roomId, bob.accountId, SONG_ID, { resolveMetadata }); // C, added mid-vote

    await sleep(60);

    expect(getCurrentPlayback(db, roomId)?.queueItemId).toBe(b.queueItemId);
  });

  it("lets the current DJ open a SEEK proposal that, once passed, rebases the anchor without changing playbackId", async () => {
    const manager = new ProposalManager();
    const { io } = fakeIo();
    const before = getCurrentPlayback(db, roomId)!;

    // alice added the currently-playing track in beforeEach, so she is the DJ.
    const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "SEEK", {
      votingWindowMs: 30,
      positionMs: 42_000,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "YES");

    await sleep(60);

    const after = getCurrentPlayback(db, roomId)!;
    expect(after.playbackId).toBe(before.playbackId); // a seek is not a track transition
    expect(after.anchorPositionMs).toBe(42_000);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.status).toBe(before.status);
    expect(manager.getActiveProposal(roomId)).toBeNull();
  });

  it("rejects a SEEK request from an account that is not the current DJ with a typed NOT_CURRENT_DJ error", () => {
    const manager = new ProposalManager();
    const { io } = fakeIo();

    // bob did not add the currently-playing track — alice did.
    const result = manager.requestPlaybackProposal(io, db, roomId, bob.accountId, "SEEK", {
      votingWindowMs: 30,
      positionMs: 10_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("NOT_CURRENT_DJ");
    expect(manager.getActiveProposal(roomId)).toBeNull();
  });

  it("rejects a SEEK request with a negative target position before ever opening a vote", () => {
    const manager = new ProposalManager();
    const { io } = fakeIo();

    const result = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "SEEK", {
      votingWindowMs: 30,
      positionMs: -1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/non-negative/);
    expect(manager.getActiveProposal(roomId)).toBeNull();
  });

  it("does not apply a passed SEEK proposal whose reference has gone stale by resolution time", async () => {
    const manager = new ProposalManager();
    const { io, emitted } = fakeIo();

    const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "SEEK", {
      votingWindowMs: 30,
      positionMs: 99_000,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "YES");

    // Something else rebases playback (bumping revision) while the vote is
    // still open — by resolution time the proposal's reference is stale.
    const rebased = setPlaybackStatus(db, roomId, "PAUSED")!;

    await sleep(60);

    const final = getCurrentPlayback(db, roomId)!;
    expect(final.anchorPositionMs).toBe(rebased.anchorPositionMs); // not overwritten by the stale seek
    const resolution = emitted.find(
      (e) => e.event === "proposal:update" && (e.payload as ProposalBroadcast).proposal.state === "PASSED",
    );
    expect((resolution?.payload as ProposalBroadcast).applied).toBe(false);
  });

  it("removes a queue item once a REMOVE_QUEUE_ITEM vote passes, leaving unrelated items and current playback untouched", async () => {
    const manager = new ProposalManager();
    const { io, emitted } = fakeIo();
    const current = getCurrentPlayback(db, roomId)!;
    const b = await addTrack(db, roomId, bob.accountId, SONG_ID, { resolveMetadata });
    const c = await addTrack(db, roomId, carol.accountId, SONG_ID, { resolveMetadata });

    const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "REMOVE_QUEUE_ITEM", {
      votingWindowMs: 30,
      queueItemId: b.queueItemId,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "YES");

    await sleep(60);

    const queue = listQueue(db, roomId);
    expect(queue.some((q) => q.queueItemId === b.queueItemId)).toBe(false);
    expect(queue.some((q) => q.queueItemId === c.queueItemId)).toBe(true);
    expect(getCurrentPlayback(db, roomId)?.queueItemId).toBe(current.queueItemId);

    const resolution = emitted.find(
      (e) => e.event === "proposal:update" && (e.payload as ProposalBroadcast).proposal.state === "PASSED",
    );
    expect((resolution?.payload as ProposalBroadcast).applied).toBe(true);
    const removedEvent = emitted.find((e) => e.event === "queue:itemRemoved");
    expect((removedEvent?.payload as { queueItemId: string }).queueItemId).toBe(b.queueItemId);
    expect(manager.getActiveProposal(roomId)).toBeNull();
  });

  it("rejects a REMOVE_QUEUE_ITEM request targeting the currently-playing item with a typed IS_CURRENT_TRACK error", () => {
    const manager = new ProposalManager();
    const { io } = fakeIo();
    const current = getCurrentPlayback(db, roomId)!;

    const result = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "REMOVE_QUEUE_ITEM", {
      votingWindowMs: 30,
      queueItemId: current.queueItemId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("IS_CURRENT_TRACK");
    expect(manager.getActiveProposal(roomId)).toBeNull();
  });

  it("rejects a REMOVE_QUEUE_ITEM request for a queueItemId that does not exist in this room before ever opening a vote", () => {
    const manager = new ProposalManager();
    const { io } = fakeIo();

    const result = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "REMOVE_QUEUE_ITEM", {
      votingWindowMs: 30,
      queueItemId: "not-a-real-queue-item-id",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/no such queue item/);
    expect(manager.getActiveProposal(roomId)).toBeNull();
  });

  it("does not apply a passed REMOVE_QUEUE_ITEM proposal once queueRevision has moved on mid-vote", async () => {
    const manager = new ProposalManager();
    const { io, emitted } = fakeIo();
    const b = await addTrack(db, roomId, bob.accountId, SONG_ID, { resolveMetadata });
    const c = await addTrack(db, roomId, carol.accountId, SONG_ID, { resolveMetadata });

    const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "REMOVE_QUEUE_ITEM", {
      votingWindowMs: 30,
      queueItemId: b.queueItemId,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "YES");

    // Something else (here, a second removal applied directly) bumps
    // queueRevision while the vote on b is still open.
    removeQueueItem(db, roomId, c.queueItemId);

    await sleep(60);

    const queue = listQueue(db, roomId);
    expect(queue.some((q) => q.queueItemId === b.queueItemId)).toBe(true); // never removed — stale
    const resolution = emitted.find(
      (e) => e.event === "proposal:update" && (e.payload as ProposalBroadcast).proposal.state === "PASSED",
    );
    expect((resolution?.payload as ProposalBroadcast).applied).toBe(false);
  });

  it("falls back to execution-time defense-in-depth: never removes an item that became the current track mid-vote", async () => {
    const manager = new ProposalManager();
    const { io, emitted } = fakeIo();
    const b = await addTrack(db, roomId, bob.accountId, SONG_ID, { resolveMetadata });

    const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "REMOVE_QUEUE_ITEM", {
      votingWindowMs: 30,
      queueItemId: b.queueItemId,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "YES");

    // b becomes the current track mid-vote (a SKIP passed elsewhere) — this
    // never bumps queueRevision, so the REMOVE_QUEUE_ITEM proposal's
    // queue-kind reference is not stale by the usual check; the execution-
    // time defense-in-depth inside removeQueueItem must catch this instead.
    advanceToNextTrack(db, roomId);
    expect(getCurrentPlayback(db, roomId)?.queueItemId).toBe(b.queueItemId);

    await sleep(60);

    expect(listQueue(db, roomId).some((q) => q.queueItemId === b.queueItemId)).toBe(true); // never removed
    const resolution = emitted.find(
      (e) => e.event === "proposal:update" && (e.payload as ProposalBroadcast).proposal.state === "PASSED",
    );
    expect((resolution?.payload as ProposalBroadcast).applied).toBe(false);
  });

  it("a track added to the queue mid-vote does not invalidate an in-flight REMOVE_QUEUE_ITEM proposal for a different item", async () => {
    const manager = new ProposalManager();
    const { io, emitted } = fakeIo();
    const b = await addTrack(db, roomId, bob.accountId, SONG_ID, { resolveMetadata });

    const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "REMOVE_QUEUE_ITEM", {
      votingWindowMs: 30,
      queueItemId: b.queueItemId,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "YES");

    await addTrack(db, roomId, carol.accountId, SONG_ID, { resolveMetadata }); // C, added mid-vote

    await sleep(60);

    expect(listQueue(db, roomId).some((q) => q.queueItemId === b.queueItemId)).toBe(false);
    const resolution = emitted.find(
      (e) => e.event === "proposal:update" && (e.payload as ProposalBroadcast).proposal.state === "PASSED",
    );
    expect((resolution?.payload as ProposalBroadcast).applied).toBe(true);
  });

  it("invalidates an open REMOVE_QUEUE_ITEM proposal immediately when its room's current track naturally ends", async () => {
    const manager = new ProposalManager();
    const { io, emitted } = fakeIo();
    const before = getCurrentPlayback(db, roomId)!;
    const b = await addTrack(db, roomId, bob.accountId, SONG_ID, { resolveMetadata });

    const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "REMOVE_QUEUE_ITEM", {
      votingWindowMs: 30,
      queueItemId: b.queueItemId,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "YES");

    manager.handleTrackEnded(io, db, roomId, before.playbackId, { accountId: alice.accountId, presentCount: 1 });

    expect(manager.getActiveProposal(roomId)).toBeNull();
    expect(listQueue(db, roomId).some((q) => q.queueItemId === b.queueItemId)).toBe(true); // never removed
    const updates = emitted
      .filter((e) => e.event === "proposal:update" && (e.payload as ProposalBroadcast).proposal.proposalId === requested.proposal.proposalId)
      .map((e) => e.payload as ProposalBroadcast);
    expect(updates[updates.length - 1].proposal.state).toBe("FAILED");
  });

  // --- REORDER_QUEUE ------------------------------------------------------

  it("reorders the queue once a REORDER_QUEUE vote passes", async () => {
    const manager = new ProposalManager();
    const { io, emitted } = fakeIo();
    const b = await addTrack(db, roomId, bob.accountId, SONG_ID, { resolveMetadata });
    const c = await addTrack(db, roomId, carol.accountId, SONG_ID, { resolveMetadata });
    // Order before: [a(current), b, c]. Move c before b -> [a, c, b].

    const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "REORDER_QUEUE", {
      votingWindowMs: 30,
      queueItemId: c.queueItemId,
      beforeQueueItemId: b.queueItemId,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "YES");

    await sleep(60);

    const queue = listQueue(db, roomId);
    expect(queue.map((q) => q.queueItemId)).toEqual([
      (await getCurrentPlayback(db, roomId))!.queueItemId,
      c.queueItemId,
      b.queueItemId,
    ]);

    const resolution = emitted.find(
      (e) => e.event === "proposal:update" && (e.payload as ProposalBroadcast).proposal.state === "PASSED",
    );
    expect((resolution?.payload as ProposalBroadcast).applied).toBe(true);

    const reorderedEvent = emitted.find((e) => e.event === "queue:reordered");
    expect((reorderedEvent?.payload as { queue: unknown[] }).queue.map((q) => (q as { queueItemId: string }).queueItemId)).toEqual([
      (await getCurrentPlayback(db, roomId))!.queueItemId,
      c.queueItemId,
      b.queueItemId,
    ]);

    expect(manager.getActiveProposal(roomId)).toBeNull();
  });

  it("leaves the queue alone when a REORDER_QUEUE proposal fails its vote", async () => {
    const manager = new ProposalManager();
    const { io, emitted } = fakeIo();
    const b = await addTrack(db, roomId, bob.accountId, SONG_ID, { resolveMetadata });
    const c = await addTrack(db, roomId, carol.accountId, SONG_ID, { resolveMetadata });
    const beforeQueue = listQueue(db, roomId).map((q) => q.queueItemId);

    const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "REORDER_QUEUE", {
      votingWindowMs: 20,
      queueItemId: c.queueItemId,
      beforeQueueItemId: b.queueItemId,
    });
    expect(requested.ok).toBe(true);
    // Only alice (the proposer, auto-YES) ever votes — one non-abstain vote
    // is short of the minimum 2, so this fails without anyone else voting.

    await sleep(60);

    expect(listQueue(db, roomId).map((q) => q.queueItemId)).toEqual(beforeQueue);

    const resolutions = emitted.filter((e) => e.event === "proposal:update").map((e) => e.payload as ProposalBroadcast);
    const final = resolutions[resolutions.length - 1];
    expect(final.proposal.state).toBe("FAILED");
    expect(final.applied).toBe(false);
    expect(emitted.some((e) => e.event === "queue:reordered")).toBe(false);
  });

  it("does not apply a passed REORDER_QUEUE proposal once queueRevision has moved on mid-vote", async () => {
    const manager = new ProposalManager();
    const { io, emitted } = fakeIo();
    const b = await addTrack(db, roomId, bob.accountId, SONG_ID, { resolveMetadata });
    const c = await addTrack(db, roomId, carol.accountId, SONG_ID, { resolveMetadata });
    const d = await addTrack(db, roomId, carol.accountId, SONG_ID, { resolveMetadata });
    const beforeOrder = listQueue(db, roomId).map((q) => q.queueItemId);

    const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "REORDER_QUEUE", {
      votingWindowMs: 30,
      queueItemId: c.queueItemId,
      beforeQueueItemId: b.queueItemId,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "YES");

    // Something else (here, an unrelated removal) bumps queueRevision while
    // the reorder vote on b/c is still open.
    removeQueueItem(db, roomId, d.queueItemId);

    await sleep(60);

    // b and c are still in their original relative order — never reordered —
    // only d (removed out of band) is gone.
    expect(listQueue(db, roomId).map((q) => q.queueItemId)).toEqual(beforeOrder.filter((id) => id !== d.queueItemId));

    const resolution = emitted.find(
      (e) => e.event === "proposal:update" && (e.payload as ProposalBroadcast).proposal.state === "PASSED",
    );
    expect((resolution?.payload as ProposalBroadcast).applied).toBe(false);
    expect(emitted.some((e) => e.event === "queue:reordered")).toBe(false);
  });

  it("rejects a second REORDER_QUEUE proposal request while one is already open in the same room", async () => {
    const manager = new ProposalManager();
    const { io } = fakeIo();
    const b = await addTrack(db, roomId, bob.accountId, SONG_ID, { resolveMetadata });
    const c = await addTrack(db, roomId, carol.accountId, SONG_ID, { resolveMetadata });

    const first = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "REORDER_QUEUE", {
      votingWindowMs: 5_000,
      queueItemId: c.queueItemId,
      beforeQueueItemId: b.queueItemId,
    });
    expect(first.ok).toBe(true);

    const second = manager.requestPlaybackProposal(io, db, roomId, bob.accountId, "REORDER_QUEUE", {
      votingWindowMs: 5_000,
      queueItemId: b.queueItemId,
      beforeQueueItemId: null,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toMatch(/already in progress/);
  });

  it("rejects a REORDER_QUEUE request that would produce no real change with a typed NO_OP error, before ever opening a vote", async () => {
    const manager = new ProposalManager();
    const { io } = fakeIo();
    const b = await addTrack(db, roomId, bob.accountId, SONG_ID, { resolveMetadata });
    const c = await addTrack(db, roomId, carol.accountId, SONG_ID, { resolveMetadata });
    // Order is [a, b, c] — b is already immediately before c, so "move b
    // before c" changes nothing.

    const result = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "REORDER_QUEUE", {
      votingWindowMs: 5_000,
      queueItemId: b.queueItemId,
      beforeQueueItemId: c.queueItemId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("NO_OP");
    expect(manager.getActiveProposal(roomId)).toBeNull();
  });

  it("rejects a REORDER_QUEUE request that would move a track in front of the playing one with a typed MOVE_NOT_ALLOWED error", async () => {
    const manager = new ProposalManager();
    const { io } = fakeIo();
    const current = getCurrentPlayback(db, roomId)!;
    const b = await addTrack(db, roomId, bob.accountId, SONG_ID, { resolveMetadata });
    // Order is [a (playing), b]: moving b before a would mean b never plays.

    const result = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "REORDER_QUEUE", {
      votingWindowMs: 5_000,
      queueItemId: b.queueItemId,
      beforeQueueItemId: current.queueItemId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("MOVE_NOT_ALLOWED");
    expect(manager.getActiveProposal(roomId)).toBeNull();
  });

  // Reorders used to be rationed (5 tokens, 1 back every 5 minutes); the
  // vote is now the only gate (docs/adr/0005).
  it("places no limit on how many times one account may reorder", async () => {
    const manager = new ProposalManager();
    const { io } = fakeIo();
    const b = await addTrack(db, roomId, bob.accountId, SONG_ID, { resolveMetadata });
    const c = await addTrack(db, roomId, carol.accountId, SONG_ID, { resolveMetadata });

    // Well past the old cap of 5: swap b and c back and forth.
    for (let i = 0; i < 8; i += 1) {
      const [moved, before] = i % 2 === 0 ? [c, b] : [b, c];
      const result = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "REORDER_QUEUE", {
        presentCount: 1,
        queueItemId: moved.queueItemId,
        beforeQueueItemId: before.queueItemId,
      });
      expect(result.ok && result.proposal.state).toBe("PASSED");
    }
    expect(listQueue(db, roomId).map((q) => q.queueItemId).slice(1)).toEqual([b.queueItemId, c.queueItemId]);
  });
});

// Regression: any one client's playback:ended used to advance the room with no
// vote — including one sent because someone dragged the visible player's own
// scrubber to the end. With the track's length known, the server now checks
// the report against its own anchor first.
describe("ProposalManager with a known track length", () => {
  let dir: string;
  let db: DatabaseSync;
  let roomId: string;
  let alice: Account;

  const LENGTH_MS = 200_000;
  const resolveMetadata = async (videoId: string): Promise<YoutubeVideoMetadata | null> => ({
    videoId,
    title: "Timed song",
    channelTitle: "Channel",
    thumbnailUrl: "https://example.com/t.jpg",
    embeddable: true,
    durationMs: LENGTH_MS,
  });

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "echo-room-proposals-duration-"));
    db = openDatabase(path.join(dir, "echo-room.sqlite"));
    alice = registerAccount(db, "client-alice", "Alice");
    roomId = createRoom(db, { accountId: alice.accountId, name: "Room", visibility: "PUBLIC", autoCloseEnabled: false })
      .roomId;
    const first = await addTrack(db, roomId, alice.accountId, SONG_ID, { resolveMetadata });
    ensureCurrentTrack(db, roomId, first.queueItemId);
    await addTrack(db, roomId, alice.accountId, SONG_ID, { resolveMetadata });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function rewindAnchorBy(ms: number): void {
    db.prepare("UPDATE room_playback SET anchorServerTimeMs = anchorServerTimeMs - ? WHERE roomId = ?").run(ms, roomId);
  }

  it("ignores a track-ended report that arrives long before the track can be over", () => {
    const manager = new ProposalManager();
    const { io, emitted } = fakeIo();
    const before = getCurrentPlayback(db, roomId)!;
    rewindAnchorBy(30_000); // 30s into a 200s track

    manager.handleTrackEnded(io, db, roomId, before.playbackId, { accountId: alice.accountId, presentCount: 1 });

    const after = getCurrentPlayback(db, roomId)!;
    expect(after.playbackId).toBe(before.playbackId);
    expect(after.revision).toBe(before.revision);
    expect(emitted.some((e) => e.event === "playback:update")).toBe(false);
  });

  it("advances on a track-ended report once the room's anchor has reached the end", () => {
    const manager = new ProposalManager();
    const { io } = fakeIo();
    const before = getCurrentPlayback(db, roomId)!;
    rewindAnchorBy(LENGTH_MS - 2_000); // within the tolerance of the end

    manager.handleTrackEnded(io, db, roomId, before.playbackId, { accountId: alice.accountId, presentCount: 1 });

    expect(getCurrentPlayback(db, roomId)?.playbackId).not.toBe(before.playbackId);
  });

  it("rejects a SEEK past the end of the track without opening a vote", () => {
    const manager = new ProposalManager();
    const { io } = fakeIo();

    const result = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "SEEK", {
      votingWindowMs: 5_000,
      positionMs: LENGTH_MS + 1,
    });

    expect(result.ok).toBe(false);
    expect(manager.getActiveProposal(roomId)).toBeNull();
    expect(
      manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "SEEK", { votingWindowMs: 5_000, positionMs: LENGTH_MS })
        .ok,
    ).toBe(true);
    manager.dispose();
  });
});

describe("ProposalManager timer bookkeeping", () => {
  it("forceResolve is idempotent once a room's proposal has already resolved", async () => {
    vi.useRealTimers();
    const dir = mkdtempSync(path.join(tmpdir(), "echo-room-proposals-timer-"));
    const db = openDatabase(path.join(dir, "echo-room.sqlite"));
    try {
      const alice = registerAccount(db, "client-alice", "Alice");
      const room = createRoom(db, { accountId: alice.accountId, name: "Room", visibility: "PUBLIC", autoCloseEnabled: false });
      const resolveMetadata = async (videoId: string): Promise<YoutubeVideoMetadata | null> => ({
        videoId,
        title: "Song",
        channelTitle: "Channel",
        thumbnailUrl: "https://example.com/x.jpg",
        embeddable: true,
      });
      const item = await addTrack(db, room.roomId, alice.accountId, SONG_ID, { resolveMetadata });
      ensureCurrentTrack(db, room.roomId, item.queueItemId);

      const manager = new ProposalManager();
      const { io } = fakeIo();
      manager.requestPlaybackProposal(io, db, room.roomId, alice.accountId, "PAUSE", { votingWindowMs: 10 });
      await sleep(40);
      expect(manager.getActiveProposal(room.roomId)).toBeNull();

      // Calling forceResolve again with nothing active must be a safe no-op.
      manager.forceResolve(io, db, room.roomId);
      expect(manager.getActiveProposal(room.roomId)).toBeNull();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// CLAUDE.md's Rooms section lists "proposal create," "vote," "successful
// shared playback action" and "successful reorder" as meaningful activity —
// each must bump the room's lastMeaningfulActivityAt (the timestamp
// server/src/rooms.ts's auto-close sweep reads), so an auto-close-enabled
// room never closes while votes keep happening in it.
describe("ProposalManager touches room activity", () => {
  let dir: string;
  let db: DatabaseSync;
  let roomId: string;
  let alice: Account;
  let bob: Account;
  let firstQueueItemId: string;

  const SONG: YoutubeVideoMetadata = {
    videoId: SONG_ID,
    title: "Song A",
    channelTitle: "Channel A",
    thumbnailUrl: "https://example.com/a.jpg",
    embeddable: true,
  };
  const resolveMetadata = async (videoId: string): Promise<YoutubeVideoMetadata | null> =>
    videoId === SONG_ID ? SONG : null;
  const STALE = "2000-01-01T00:00:00.000Z";

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "echo-room-proposals-activity-"));
    db = openDatabase(path.join(dir, "echo-room.sqlite"));
    alice = registerAccount(db, "client-alice", "Alice");
    bob = registerAccount(db, "client-bob", "Bob");
    roomId = createRoom(db, { accountId: alice.accountId, name: "Room", visibility: "PUBLIC", autoCloseEnabled: true })
      .roomId;

    const item = await addTrack(db, roomId, alice.accountId, SONG_ID, { resolveMetadata });
    ensureCurrentTrack(db, roomId, item.queueItemId);
    firstQueueItemId = item.queueItemId;
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function markStale(): void {
    db.prepare("UPDATE rooms SET lastMeaningfulActivityAt = ? WHERE roomId = ?").run(STALE, roomId);
  }

  it("proposal create touches activity", () => {
    const manager = new ProposalManager();
    const { io } = fakeIo();
    markStale();

    manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "PAUSE", { votingWindowMs: 10_000 });

    expect(getRoomById(db, roomId)!.lastMeaningfulActivityAt).not.toBe(STALE);
    manager.dispose();
  });

  it("casting a vote touches activity", () => {
    const manager = new ProposalManager();
    const { io } = fakeIo();
    const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "PAUSE", {
      votingWindowMs: 10_000,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    markStale();

    manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "YES");

    expect(getRoomById(db, roomId)!.lastMeaningfulActivityAt).not.toBe(STALE);
    manager.dispose();
  });

  it("a successful shared playback action (PAUSE passing) touches activity", async () => {
    const manager = new ProposalManager();
    const { io } = fakeIo();
    const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "PAUSE", {
      votingWindowMs: 20,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "YES");
    markStale();

    await sleep(60);

    expect(getCurrentPlayback(db, roomId)?.status).toBe("PAUSED");
    expect(getRoomById(db, roomId)!.lastMeaningfulActivityAt).not.toBe(STALE);
  });

  it("a successful reorder touches activity", async () => {
    const upcoming = async () =>
      addTrack(db, roomId, alice.accountId, "bbbbbbbbbbb", {
        resolveMetadata: async (videoId) => ({
          videoId,
          title: "Song B",
          channelTitle: "Channel B",
          thumbnailUrl: "https://example.com/b.jpg",
          embeddable: true,
        }),
      });
    // [first (playing), second, third] — reorder among the two still to come.
    const second = await upcoming();
    const third = await upcoming();

    const manager = new ProposalManager();
    const { io } = fakeIo();
    const requested = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "REORDER_QUEUE", {
      votingWindowMs: 20,
      queueItemId: third.queueItemId,
      beforeQueueItemId: second.queueItemId,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    manager.castVote(io, db, roomId, requested.proposal.proposalId, bob.accountId, "YES");
    markStale();

    await sleep(60);

    expect(getRoomById(db, roomId)!.lastMeaningfulActivityAt).not.toBe(STALE);
  });
});

// Regression: a vote needs 2 non-abstain votes, so a room with one person in
// it could never pass anything — once paused (every server restart pauses a
// playing room) it stayed paused for good. Now the only person present gets
// their own proposal through at once (docs/adr/0004).
describe("ProposalManager with a sole listener", () => {
  let dir: string;
  let db: DatabaseSync;
  let roomId: string;
  let alice: Account;
  let bob: Account;
  const SOLO = { presentCount: 1, votingWindowMs: 5_000 };

  const resolveMetadata = async (videoId: string): Promise<YoutubeVideoMetadata | null> => ({
    videoId,
    title: "Song",
    channelTitle: "Channel",
    thumbnailUrl: "https://example.com/s.jpg",
    embeddable: true,
  });

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "echo-room-proposals-solo-"));
    db = openDatabase(path.join(dir, "echo-room.sqlite"));
    alice = registerAccount(db, "client-alice", "Alice");
    bob = registerAccount(db, "client-bob", "Bob");
    roomId = createRoom(db, { accountId: alice.accountId, name: "Room", visibility: "PUBLIC", autoCloseEnabled: false })
      .roomId;
    const first = await addTrack(db, roomId, alice.accountId, SONG_ID, { resolveMetadata });
    ensureCurrentTrack(db, roomId, first.queueItemId);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes and applies the only listener's proposal at once, with no vote left open", () => {
    const manager = new ProposalManager();
    const { io, emitted } = fakeIo();

    const result = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "PAUSE", SOLO);

    expect(result.ok && result.proposal.state).toBe("PASSED");
    expect(getCurrentPlayback(db, roomId)?.status).toBe("PAUSED");
    expect(manager.getActiveProposal(roomId)).toBeNull();
    const updates = emitted.filter((e) => e.event === "proposal:update").map((e) => e.payload as ProposalBroadcast);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ proposal: { state: "PASSED" }, applied: true });

    // And back again: the room is never stuck paused with one person in it.
    manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "PLAY", SOLO);
    expect(getCurrentPlayback(db, roomId)?.status).toBe("PLAYING");
  });

  it("keeps a skipped track as history, which can then be moved back down to play again", async () => {
    const manager = new ProposalManager();
    const { io } = fakeIo();
    const skipped = getCurrentPlayback(db, roomId)!.queueItemId;
    const next = await addTrack(db, roomId, alice.accountId, SONG_ID, { resolveMetadata });
    const last = await addTrack(db, roomId, alice.accountId, SONG_ID, { resolveMetadata });

    manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "SKIP", SOLO);
    expect(listQueue(db, roomId).map((q) => q.queueItemId)).toEqual([skipped, next.queueItemId, last.queueItemId]);

    const up = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "REORDER_QUEUE", {
      ...SOLO,
      queueItemId: last.queueItemId,
      beforeQueueItemId: skipped,
    });
    expect(!up.ok && up.code).toBe("MOVE_NOT_ALLOWED"); // nothing moves above the playing track

    manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "REORDER_QUEUE", {
      ...SOLO,
      queueItemId: skipped,
      beforeQueueItemId: last.queueItemId,
    });
    expect(listQueue(db, roomId).map((q) => q.queueItemId)).toEqual([next.queueItemId, skipped, last.queueItemId]);
    expect(getNextTrack(db, roomId)?.queueItemId).toBe(skipped);
  });

  it("still enforces every request-time rule for a sole listener", () => {
    const manager = new ProposalManager();
    const { io } = fakeIo();
    db.prepare("UPDATE queue_items SET addedBy = ? WHERE roomId = ?").run(bob.accountId, roomId); // Bob is the DJ

    const seek = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "SEEK", { ...SOLO, positionMs: 10_000 });
    expect(!seek.ok && seek.code).toBe("NOT_CURRENT_DJ");
    const play = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "PLAY", SOLO);
    expect(play.ok).toBe(false); // already playing
  });

  it("applies a sole listener's reorder at once, just like a passed vote", async () => {
    const manager = new ProposalManager();
    const { io } = fakeIo();
    const b = await addTrack(db, roomId, alice.accountId, SONG_ID, { resolveMetadata });
    const c = await addTrack(db, roomId, alice.accountId, SONG_ID, { resolveMetadata });

    manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "REORDER_QUEUE", {
      ...SOLO,
      queueItemId: c.queueItemId,
      beforeQueueItemId: b.queueItemId,
    });

    expect(listQueue(db, roomId).map((q) => q.queueItemId).slice(1)).toEqual([c.queueItemId, b.queueItemId]);
  });

  it("opens an ordinary vote as soon as a second person is present", () => {
    const manager = new ProposalManager();
    const { io } = fakeIo();

    const result = manager.requestPlaybackProposal(io, db, roomId, alice.accountId, "PAUSE", { presentCount: 2, votingWindowMs: 5_000 });

    expect(result.ok && result.proposal.state).toBe("OPEN");
    expect(getCurrentPlayback(db, roomId)?.status).toBe("PLAYING");
    manager.dispose();
  });
});
