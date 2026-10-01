import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { registerAccount } from "./accounts.ts";
import { createRoom } from "./rooms.ts";
import { addTrack, listQueue } from "./queue.ts";
import { advanceToNextTrack, ensureCurrentTrack, getCurrentPlayback } from "./playback.ts";
import { PresenceStore } from "./presence.ts";
import { DJ_HANDOFF_MS, DjHandoffManager } from "./djHandoff.ts";
import { ProposalManager } from "./proposals.ts";

describe("DJ handoff", () => {
  let db: DatabaseSync;
  let roomId: string;
  let ids: string[];
  let presence: PresenceStore;
  let manager: DjHandoffManager;
  const broadcast = vi.fn();
  const metadata = async (videoId: string) => ({ videoId, title: "Song", channelTitle: "Channel", thumbnailUrl: "", embeddable: true });
  const current = () => getCurrentPlayback(db, roomId)!;
  const leave = () => presence.leave(roomId, "socket-0");

  beforeEach(async () => {
    vi.useFakeTimers();
    db = openDatabase(":memory:");
    ids = [0, 1, 2].map((n) => registerAccount(db, `client-${n}`, `Person ${n}`).accountId);
    roomId = createRoom(db, { accountId: ids[0], name: "Room", visibility: "PUBLIC" }).roomId;
    const item = await addTrack(db, roomId, ids[0], "aaaaaaaaaaa", { resolveMetadata: metadata });
    ensureCurrentTrack(db, roomId, item.queueItemId);
    presence = new PresenceStore();
    ids.forEach((accountId, n) => presence.join(roomId, `socket-${n}`, { accountId, displayName: `Person ${n}` }));
    broadcast.mockClear();
    manager = new DjHandoffManager(db, presence, broadcast);
  });
  afterEach(() => { manager.dispose(); db.close(); vi.useRealTimers(); });

  it("offers 10 seconds, transfers to the chosen member without changing the track or queue, and updates seek permissions", () => {
    const before = current();
    const queue = listQueue(db, roomId);
    const prompt = manager.requestLeave(roomId, ids[0], leave)!;
    expect(prompt.expiresAt).toBe(Date.now() + DJ_HANDOFF_MS);
    expect(presence.isPresent(roomId, ids[0])).toBe(true);
    expect(manager.choose(roomId, ids[0], prompt.requestId, ids[2])).toBe(true);
    expect(presence.isPresent(roomId, ids[0])).toBe(false);
    expect(current()).toEqual({ ...before, revision: before.revision + 1, dj: { accountId: ids[2], displayName: "Person 2" } });
    expect(listQueue(db, roomId)).toEqual(queue);
    expect(broadcast).toHaveBeenCalledTimes(1);
    const proposals = new ProposalManager();
    const io = { to: () => ({ emit: () => {} }) } as unknown as import("socket.io").Server;
    expect(proposals.requestPlaybackProposal(io, db, roomId, ids[0], "SEEK", { positionMs: 0 }).ok).toBe(false);
    expect(proposals.requestPlaybackProposal(io, db, roomId, ids[2], "SEEK", { positionMs: 0 }).ok).toBe(true);
    proposals.dispose();
    vi.advanceTimersByTime(DJ_HANDOFF_MS);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("uses the original deadline and only current candidates for the timeout", () => {
    const first = manager.requestLeave(roomId, ids[0], leave)!;
    vi.advanceTimersByTime(9_000);
    expect(manager.requestLeave(roomId, ids[0], leave)).toEqual(first);
    expect(current().dj.accountId).toBe(ids[0]);
    presence.leave(roomId, "socket-1");
    vi.advanceTimersByTime(1_000);
    expect(current().dj.accountId).toBe(ids[2]);
    expect(presence.isPresent(roomId, ids[0])).toBe(false);
  });

  it("randomly selects one of the remaining members after 10 seconds", () => {
    manager.requestLeave(roomId, ids[0], leave);
    vi.advanceTimersByTime(DJ_HANDOFF_MS);
    expect(ids.slice(1)).toContain(current().dj.accountId);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1])("leaves without a dialog with %s eligible successors", (count) => {
    presence.leave(roomId, "socket-2");
    if (count === 0) presence.leave(roomId, "socket-1");
    expect(manager.requestLeave(roomId, ids[0], leave)).toBeNull();
    expect(presence.isPresent(roomId, ids[0])).toBe(false);
    expect(current().dj.accountId).toBe(count ? ids[1] : ids[0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects forged, stale, self and departed member choices", () => {
    const prompt = manager.requestLeave(roomId, ids[0], leave)!;
    expect(manager.choose(roomId, ids[1], prompt.requestId, ids[2])).toBe(false);
    expect(manager.choose(roomId, ids[0], "wrong-request", ids[2])).toBe(false);
    expect(manager.choose(roomId, ids[0], prompt.requestId, ids[0])).toBe(false);
    expect(manager.choose(roomId, ids[0], prompt.requestId, "outsider")).toBe(false);
    presence.leave(roomId, "socket-2");
    expect(manager.choose(roomId, ids[0], prompt.requestId, ids[2])).toBe(false);
    expect(current().dj.accountId).toBe(ids[0]);
  });

  it("retains the role while another tab of the DJ remains", () => {
    presence.join(roomId, "other-tab", { accountId: ids[0], displayName: "Person 0" });
    expect(manager.requestLeave(roomId, ids[0], leave)).toBeNull();
    manager.reconcile(roomId);
    vi.advanceTimersByTime(DJ_HANDOFF_MS);
    expect(current().dj.accountId).toBe(ids[0]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it.each([1, 2])("allows reconnect before transferring after an abrupt disconnect with %s candidates", (count) => {
    if (count === 1) presence.leave(roomId, "socket-2");
    leave();
    manager.reconcile(roomId);
    vi.advanceTimersByTime(5_000);
    expect(current().dj.accountId).toBe(ids[0]);
    presence.join(roomId, "socket-0", { accountId: ids[0], displayName: "Person 0" });
    manager.reconcile(roomId);
    vi.advanceTimersByTime(5_000);
    expect(current().dj.accountId).toBe(ids[0]);
    leave();
    manager.reconcile(roomId);
    vi.advanceTimersByTime(DJ_HANDOFF_MS);
    expect(ids.slice(1)).toContain(current().dj.accountId);
  });

  it("does not apply a pending choice to the next track and resets the override on transition", async () => {
    const next = await addTrack(db, roomId, ids[1], "bbbbbbbbbbb", { resolveMetadata: metadata });
    const prompt = manager.requestLeave(roomId, ids[0], leave)!;
    advanceToNextTrack(db, roomId);
    manager.choose(roomId, ids[0], prompt.requestId, ids[2]);
    expect(current().queueItemId).toBe(next.queueItemId);
    expect(current().dj.accountId).toBe(ids[1]);
    const secondPrompt = manager.requestLeave(roomId, ids[1], () => presence.leave(roomId, "socket-1"));
    expect(secondPrompt).toBeNull(); // only Person 2 remains
    expect(current().dj.accountId).toBe(ids[2]);
    const third = await addTrack(db, roomId, ids[1], "ccccccccccc", { resolveMetadata: metadata });
    advanceToNextTrack(db, roomId);
    expect(current().queueItemId).toBe(third.queueItemId);
    expect(current().dj.accountId).toBe(ids[1]);
    manager.reconcile(roomId);
    vi.advanceTimersByTime(DJ_HANDOFF_MS);
    expect(current().dj.accountId).toBe(ids[2]);
  });

  it("does not transfer to anybody when the room closes or all candidates leave", () => {
    manager.requestLeave(roomId, ids[0], leave);
    presence.leave(roomId, "socket-1");
    presence.leave(roomId, "socket-2");
    vi.advanceTimersByTime(DJ_HANDOFF_MS);
    expect(broadcast).not.toHaveBeenCalled();
    presence.join(roomId, "socket-1", { accountId: ids[1], displayName: "Person 1" });
    db.prepare("UPDATE rooms SET closed = 1 WHERE roomId = ?").run(roomId);
    manager.reconcile(roomId);
    vi.advanceTimersByTime(DJ_HANDOFF_MS);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
