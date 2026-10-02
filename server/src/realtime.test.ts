import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { Server } from "socket.io";
import type { Account, RoomSnapshot } from "../../shared/src/types.ts";
import { registerAccount } from "./accounts.ts";
import { openDatabase } from "./db.ts";
import { ensureCurrentTrack, getCurrentPlayback, setPlaybackStatus } from "./playback.ts";
import { addTrack } from "./queue.ts";
import type { ProposalManager } from "./proposals.ts";
import type { PresenceStore } from "./presence.ts";
import { attachRealtime } from "./realtime.ts";
import { AUTO_CLOSE_INACTIVITY_MS, createRoom, joinRoom, MAX_ROOM_USERS } from "./rooms.ts";

// Exercises the actual wire protocol end to end (real httpServer + socket.io
// Server + socket.io-client connections on localhost), not just PresenceStore
// in isolation — this is what proves "two different users", "disconnect",
// "reconnect" etc. actually work over a real connection, not merely in the
// in-memory data structure.
describe("realtime room presence", () => {
  let dir: string;
  let db: DatabaseSync;
  let httpServer: ReturnType<typeof createServer>;
  let io: Server;
  let baseUrl: string;
  let roomId: string;
  let clients: ClientSocket[];

  function makeAccount(clientId: string, displayName: string): Account {
    return registerAccount(db, clientId, displayName);
  }

  function connect(account: Account, clientId: string): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const socket = ioClient(baseUrl, {
        auth: { accountId: account.accountId, clientId },
        transports: ["websocket"],
        forceNew: true,
      });
      clients.push(socket);
      socket.once("connect", () => resolve(socket));
      socket.once("connect_error", (err) => reject(err));
    });
  }

  function waitFor<T = unknown>(socket: ClientSocket, event: string): Promise<T> {
    return new Promise((resolve) => socket.once(event, (payload: T) => resolve(payload)));
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "echo-room-realtime-"));
    db = openDatabase(path.join(dir, "echo-room.sqlite"));
    clients = [];

    httpServer = createServer();
    io = new Server(httpServer);
    attachRealtime(io, db);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://localhost:${port}`;

    const creator = makeAccount("client-creator", "Host");
    const room = createRoom(db, {
      accountId: creator.accountId,
      name: "Test room",
      visibility: "PUBLIC",
      autoCloseEnabled: false,
    });
    roomId = room.roomId;
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lets two different users see each other join without a refresh", async () => {
    const alice = makeAccount("client-alice", "Alice");
    const bob = makeAccount("client-bob", "Bob");

    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    await waitFor(aliceSocket, "room:snapshot");

    const bobJoinSeenByAlice = waitFor<{ accountId: string; displayName: string }>(aliceSocket, "presence:join");
    const bobSocket = await connect(bob, "client-bob");
    bobSocket.emit("room:join", { roomId });
    const bobSnapshot = await waitFor<RoomSnapshot>(bobSocket, "room:snapshot");

    const seenByAlice = await bobJoinSeenByAlice;
    expect(seenByAlice).toEqual({ accountId: bob.accountId, displayName: "Bob" });
    expect(bobSnapshot.presence.map((p) => p.accountId).sort()).toEqual(
      [alice.accountId, bob.accountId].sort(),
    );
  });

  it("keeps two accounts with the same displayName distinct in presence", async () => {
    const samA = makeAccount("client-sam-a", "Sam");
    const samB = makeAccount("client-sam-b", "Sam");

    const socketA = await connect(samA, "client-sam-a");
    socketA.emit("room:join", { roomId });
    await waitFor(socketA, "room:snapshot");

    const socketB = await connect(samB, "client-sam-b");
    socketB.emit("room:join", { roomId });
    const snapshot = await waitFor<RoomSnapshot>(socketB, "room:snapshot");

    expect(snapshot.presence).toHaveLength(2);
    expect(snapshot.presence.map((p) => p.accountId).sort()).toEqual([samA.accountId, samB.accountId].sort());
    expect(snapshot.presence.every((p) => p.displayName === "Sam")).toBe(true);
  });

  it("propagates a disconnect as presence:leave to the rest of the room", async () => {
    const alice = makeAccount("client-alice", "Alice");
    const bob = makeAccount("client-bob", "Bob");

    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    await waitFor(aliceSocket, "room:snapshot");

    const bobSocket = await connect(bob, "client-bob");
    bobSocket.emit("room:join", { roomId });
    await waitFor(bobSocket, "room:snapshot");
    await waitFor(aliceSocket, "presence:join");

    const leaveSeen = waitFor<{ accountId: string }>(aliceSocket, "presence:leave");
    bobSocket.close();
    const leaveEvent = await leaveSeen;

    expect(leaveEvent).toEqual({ accountId: bob.accountId });
  });

  it("supports reconnect: a fresh connection rejoins and gets a fresh authoritative snapshot", async () => {
    const alice = makeAccount("client-alice", "Alice");
    const observer = makeAccount("client-observer", "Observer");

    const observerSocket = await connect(observer, "client-observer");
    observerSocket.emit("room:join", { roomId });
    await waitFor(observerSocket, "room:snapshot");

    let aliceSocket = await connect(alice, "client-alice");
    const firstJoinSeen = waitFor(observerSocket, "presence:join");
    aliceSocket.emit("room:join", { roomId });
    await waitFor(aliceSocket, "room:snapshot");
    await firstJoinSeen;

    const leaveSeen = waitFor(observerSocket, "presence:leave");
    aliceSocket.close();
    await leaveSeen;

    // Reconnect: a brand-new connection for the same account, rejoining.
    const rejoinSeen = waitFor(observerSocket, "presence:join");
    aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    const snapshot = await waitFor<RoomSnapshot>(aliceSocket, "room:snapshot");
    await rejoinSeen;

    expect(snapshot.presence.map((p) => p.accountId).sort()).toEqual(
      [alice.accountId, observer.accountId].sort(),
    );
  });

  it("has explicit duplicate-tab behaviour: one account stays present once across two sockets, absent only once both close", async () => {
    const alice = makeAccount("client-alice", "Alice");
    const observer = makeAccount("client-observer", "Observer");

    const observerSocket = await connect(observer, "client-observer");
    observerSocket.emit("room:join", { roomId });
    await waitFor(observerSocket, "room:snapshot");

    const tab1 = await connect(alice, "client-alice");
    const firstJoinSeen = waitFor(observerSocket, "presence:join");
    tab1.emit("room:join", { roomId });
    await waitFor(tab1, "room:snapshot");
    await firstJoinSeen;

    let secondJoinFired = false;
    const onJoin = () => {
      secondJoinFired = true;
    };
    observerSocket.on("presence:join", onJoin);

    const tab2 = await connect(alice, "client-alice");
    tab2.emit("room:join", { roomId });
    const tab2Snapshot = await waitFor<RoomSnapshot>(tab2, "room:snapshot");
    expect(tab2Snapshot.presence.filter((p) => p.accountId === alice.accountId)).toHaveLength(1);

    await sleep(150);
    expect(secondJoinFired).toBe(false);
    observerSocket.off("presence:join", onJoin);

    let leaveFiredEarly = false;
    observerSocket.once("presence:leave", () => {
      leaveFiredEarly = true;
    });
    tab1.close();
    await sleep(150);
    expect(leaveFiredEarly).toBe(false);

    const finalLeaveSeen = waitFor<{ accountId: string }>(observerSocket, "presence:leave");
    tab2.close();
    expect(await finalLeaveSeen).toEqual({ accountId: alice.accountId });
  });

  it("delivers an authoritative snapshot with the room, current queue, and current presence on join", async () => {
    const alice = makeAccount("client-alice", "Alice");
    const bob = makeAccount("client-bob", "Bob");

    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    await waitFor(aliceSocket, "room:snapshot");

    const queuedItem = await addTrack(db, roomId, alice.accountId, "dQw4w9WgXcQ", {
      resolveMetadata: async (videoId) => ({
        videoId,
        title: "Never Gonna Give You Up",
        channelTitle: "Rick Astley",
        thumbnailUrl: "https://example.com/thumb.jpg",
        embeddable: true,
      }),
    });

    const bobSocket = await connect(bob, "client-bob");
    bobSocket.emit("room:join", { roomId });
    const snapshot = await waitFor<RoomSnapshot>(bobSocket, "room:snapshot");

    expect(snapshot.room.roomId).toBe(roomId);
    expect(snapshot.queue).toEqual([queuedItem]);
    expect(snapshot.presence.map((p) => p.accountId).sort()).toEqual([alice.accountId, bob.accountId].sort());
  });

  it("includes null playback in the snapshot when nothing is playing, and the started track once one is", async () => {
    const alice = makeAccount("client-alice", "Alice");

    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    const emptySnapshot = await waitFor<RoomSnapshot>(aliceSocket, "room:snapshot");
    expect(emptySnapshot.playback).toBeNull();

    const item = await addTrack(db, roomId, alice.accountId, "dQw4w9WgXcQ", {
      resolveMetadata: async (videoId) => ({
        videoId,
        title: "Never Gonna Give You Up",
        channelTitle: "Rick Astley",
        thumbnailUrl: "https://example.com/thumb.jpg",
        embeddable: true,
      }),
    });
    ensureCurrentTrack(db, roomId, item.queueItemId);

    aliceSocket.emit("room:join", { roomId });
    const snapshotAfterStart = await waitFor<RoomSnapshot>(aliceSocket, "room:snapshot");
    expect(snapshotAfterStart.playback?.queueItemId).toBe(item.queueItemId);
    expect(snapshotAfterStart.playback?.status).toBe("PLAYING");
  });

  it("relays a playback:update to everyone in the room when a track starts playing", async () => {
    const alice = makeAccount("client-alice", "Alice");
    const bob = makeAccount("client-bob", "Bob");

    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    await waitFor(aliceSocket, "room:snapshot");

    const bobSocket = await connect(bob, "client-bob");
    bobSocket.emit("room:join", { roomId });
    await waitFor(bobSocket, "room:snapshot");
    await waitFor(aliceSocket, "presence:join");

    // Mirrors exactly what index.ts's POST /api/rooms/:roomId/queue route
    // does after a successful ensureCurrentTrack: broadcast to everyone.
    const playbackSeen = waitFor(bobSocket, "playback:update");
    const item = await addTrack(db, roomId, alice.accountId, "dQw4w9WgXcQ", {
      resolveMetadata: async (videoId) => ({
        videoId,
        title: "Never Gonna Give You Up",
        channelTitle: "Rick Astley",
        thumbnailUrl: "https://example.com/thumb.jpg",
        embeddable: true,
      }),
    });
    const started = ensureCurrentTrack(db, roomId, item.queueItemId);
    io.to(roomId).emit("playback:update", started);

    expect(await playbackSeen).toEqual(started);
  });

  it("rejects a connection whose claimed accountId does not match its clientId", async () => {
    const alice = makeAccount("client-alice", "Alice");
    const bob = makeAccount("client-bob", "Bob");

    await expect(
      new Promise((resolve, reject) => {
        const socket = ioClient(baseUrl, {
          auth: { accountId: bob.accountId, clientId: "client-alice" },
          transports: ["websocket"],
          forceNew: true,
        });
        clients.push(socket);
        socket.once("connect", () => resolve(socket));
        socket.once("connect_error", (err) => reject(err));
      }),
    ).rejects.toThrow();

    // Sanity check the same server accepts the correctly paired identity.
    const socket = await connect(alice, "client-alice");
    expect(socket.connected).toBe(true);
  });

  it("relays a queue addition to everyone in the room in real time", async () => {
    const alice = makeAccount("client-alice", "Alice");
    const bob = makeAccount("client-bob", "Bob");

    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    await waitFor(aliceSocket, "room:snapshot");

    const bobSocket = await connect(bob, "client-bob");
    bobSocket.emit("room:join", { roomId });
    await waitFor(bobSocket, "room:snapshot");
    await waitFor(aliceSocket, "presence:join");

    // Mirrors exactly what index.ts's POST /api/rooms/:roomId/queue route
    // does after a successful addTrack: broadcast to everyone in the room.
    const itemAddedSeen = waitFor(bobSocket, "queue:itemAdded");
    const item = await addTrack(db, roomId, alice.accountId, "dQw4w9WgXcQ", {
      resolveMetadata: async (videoId) => ({
        videoId,
        title: "Never Gonna Give You Up",
        channelTitle: "Rick Astley",
        thumbnailUrl: "https://example.com/thumb.jpg",
        embeddable: true,
      }),
    });
    io.to(roomId).emit("queue:itemAdded", item);

    expect(await itemAddedSeen).toEqual(item);
  });
});

describe("realtime PLAY/PAUSE voting", () => {
  let dir: string;
  let db: DatabaseSync;
  let httpServer: ReturnType<typeof createServer>;
  let io: Server;
  let baseUrl: string;
  let roomId: string;
  let clients: ClientSocket[];
  let alice: Account;
  let bob: Account;
  let proposals: ProposalManager;

  function makeAccount(clientId: string, displayName: string): Account {
    return registerAccount(db, clientId, displayName);
  }

  function connect(account: Account, clientId: string): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const socket = ioClient(baseUrl, {
        auth: { accountId: account.accountId, clientId },
        transports: ["websocket"],
        forceNew: true,
      });
      clients.push(socket);
      socket.once("connect", () => resolve(socket));
      socket.once("connect_error", (err) => reject(err));
    });
  }

  function waitFor<T = unknown>(socket: ClientSocket, event: string): Promise<T> {
    return new Promise((resolve) => socket.once(event, (payload: T) => resolve(payload)));
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "echo-room-realtime-voting-"));
    db = openDatabase(path.join(dir, "echo-room.sqlite"));
    clients = [];

    httpServer = createServer();
    io = new Server(httpServer);
    // A short voting window keeps these tests fast without needing fake
    // timers, which would risk interfering with socket.io's own internal
    // timer usage (see AttachRealtimeOptions).
    ({ proposals } = attachRealtime(io, db, { votingWindowMs: 60 }));
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://localhost:${port}`;

    alice = makeAccount("client-alice", "Alice");
    bob = makeAccount("client-bob", "Bob");
    const room = createRoom(db, {
      accountId: alice.accountId,
      name: "Test room",
      visibility: "PUBLIC",
      autoCloseEnabled: false,
    });
    roomId = room.roomId;

    const item = await addTrack(db, roomId, alice.accountId, "dQw4w9WgXcQ", {
      resolveMetadata: async (videoId) => ({
        videoId,
        title: "Never Gonna Give You Up",
        channelTitle: "Rick Astley",
        thumbnailUrl: "https://example.com/thumb.jpg",
        embeddable: true,
      }),
    });
    ensureCurrentTrack(db, roomId, item.queueItemId);
  });

  afterEach(async () => {
    // Cancels any proposal timer still pending (e.g. a test that opened a
    // vote but didn't wait out its window) before the database underneath it
    // is closed.
    proposals.dispose();
    for (const client of clients) client.close();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs the full propose → vote → resolve → synchronize flow end to end", async () => {
    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    await waitFor(aliceSocket, "room:snapshot");

    const bobSocket = await connect(bob, "client-bob");
    bobSocket.emit("room:join", { roomId });
    await waitFor(bobSocket, "room:snapshot");
    await waitFor(aliceSocket, "presence:join");

    const bobSeesOpen = waitFor<{ proposal: { proposalId: string; type: string; state: string }; applied: boolean }>(
      bobSocket,
      "proposal:update",
    );
    aliceSocket.emit("proposal:request", { type: "PAUSE" });
    const opened = await bobSeesOpen;
    expect(opened.proposal.type).toBe("PAUSE");
    expect(opened.proposal.state).toBe("OPEN");

    const proposalId = opened.proposal.proposalId;

    // Every present member has voted after Bob's ballot: resolve immediately.
    const bobSeesFinal = waitFor<{ proposal: { state: string }; applied: boolean }>(bobSocket, "proposal:update");
    const alicePlaybackUpdate = waitFor(aliceSocket, "playback:update");
    bobSocket.emit("proposal:vote", { proposalId, choice: "YES" });

    const resolved = await bobSeesFinal;
    expect(resolved.proposal.state).toBe("PASSED");
    expect(resolved.applied).toBe(true);

    const playback = await alicePlaybackUpdate;
    expect((playback as { status: string }).status).toBe("PAUSED");
  });

  it("rejects a client attempting to directly set playback status via a bogus REST-style event (no such handler exists)", async () => {
    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    await waitFor(aliceSocket, "room:snapshot");

    let sawPlaybackUpdate = false;
    aliceSocket.once("playback:update", () => {
      sawPlaybackUpdate = true;
    });
    // There is no "playback:set" or similar handler server-side — clients can
    // only ever request a proposal, never mutate authoritative state.
    aliceSocket.emit("playback:set", { status: "PAUSED" });
    await sleep(100);
    expect(sawPlaybackUpdate).toBe(false);
  });

  it("rejects a duplicate proposal request while one is already open in the room", async () => {
    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    await waitFor(aliceSocket, "room:snapshot");

    const bobSocket = await connect(bob, "client-bob");
    bobSocket.emit("room:join", { roomId });
    await waitFor(bobSocket, "room:snapshot");
    await waitFor(aliceSocket, "presence:join");

    aliceSocket.emit("proposal:request", { type: "PAUSE" });
    await waitFor(bobSocket, "proposal:update");

    const requestError = waitFor<{ error: string }>(bobSocket, "proposal:requestError");
    bobSocket.emit("proposal:request", { type: "PAUSE" });
    expect((await requestError).error).toMatch(/already in progress/);
  });

  it("rejects ballot changes after all members voted and the tie has already failed", async () => {
    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    await waitFor(aliceSocket, "room:snapshot");

    const bobSocket = await connect(bob, "client-bob");
    bobSocket.emit("room:join", { roomId });
    await waitFor(bobSocket, "room:snapshot");
    await waitFor(aliceSocket, "presence:join");

    aliceSocket.emit("proposal:request", { type: "PAUSE" });
    const opened = await waitFor<{ proposal: { proposalId: string } }>(bobSocket, "proposal:update");
    const proposalId = opened.proposal.proposalId;

    const finalSeen = waitFor<{ proposal: { votes: Record<string, string>; state: string } }>(aliceSocket, "proposal:update");
    bobSocket.emit("proposal:vote", { proposalId, choice: "NO" });
    const final = await finalSeen;
    expect(final.proposal.state).toBe("FAILED");
    expect(final.proposal.votes[bob.accountId]).toBe("NO");
    expect(Object.keys(final.proposal.votes)).toHaveLength(2);
    const rejected = waitFor<{ error: string }>(bobSocket, "proposal:voteError");
    bobSocket.emit("proposal:vote", { proposalId, choice: "YES" });
    expect((await rejected).error).toMatch(/no matching active proposal/);
  });

  // Regression: with one person in the room no vote could ever pass (it
  // needs 2 non-abstain votes), so a paused room stayed paused for good.
  it("lets the only person in the room pause and resume it straight away", async () => {
    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    await waitFor(aliceSocket, "room:snapshot");

    const passed = waitFor<{ proposal: { state: string }; applied: boolean }>(aliceSocket, "proposal:update");
    const paused = waitFor<{ status: string }>(aliceSocket, "playback:update");
    aliceSocket.emit("proposal:request", { type: "PAUSE" });
    expect(await passed).toMatchObject({ proposal: { state: "PASSED" }, applied: true });
    expect((await paused).status).toBe("PAUSED");

    const resumed = waitFor<{ status: string }>(aliceSocket, "playback:update");
    aliceSocket.emit("proposal:request", { type: "PLAY" });
    expect((await resumed).status).toBe("PLAYING");
    expect(proposals.getActiveProposal(roomId)).toBeNull();
  });

  it("rejects a PLAY proposal request when the room is already playing", async () => {
    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    await waitFor(aliceSocket, "room:snapshot");

    const requestError = waitFor<{ error: string }>(aliceSocket, "proposal:requestError");
    aliceSocket.emit("proposal:request", { type: "PLAY" });
    expect((await requestError).error).toMatch(/already playing/);
  });

  it("a disconnect that leaves the proposer as the sole survivor resolves immediately on their own auto-YES (docs/adr/0010), instead of always failing a fixed minimum", async () => {
    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    await waitFor(aliceSocket, "room:snapshot");

    const bobSocket = await connect(bob, "client-bob");
    bobSocket.emit("room:join", { roomId });
    await waitFor(bobSocket, "room:snapshot");
    await waitFor(aliceSocket, "presence:join");

    aliceSocket.emit("proposal:request", { type: "PAUSE" });
    await waitFor(bobSocket, "proposal:update");

    // Bob disconnects mid-vote without ever casting a ballot. He was the
    // only account standing between Alice and quorum, so once presence
    // actually reflects his absence, Alice's own auto-YES is immediately
    // sufficient — the vote need not wait out the rest of its window just to
    // fail on a minimum nobody could ever meet again.
    const finalSeen = waitFor<{ proposal: { state: string } }>(aliceSocket, "proposal:update");
    bobSocket.close();

    const final = await finalSeen;
    expect(final.proposal.state).toBe("PASSED");
    expect(getCurrentPlayback(db, roomId)?.status).toBe("PAUSED");
  });

  it("proposal:cancel is rejected from anyone but the proposer", async () => {
    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    await waitFor(aliceSocket, "room:snapshot");

    const bobSocket = await connect(bob, "client-bob");
    bobSocket.emit("room:join", { roomId });
    await waitFor(bobSocket, "room:snapshot");

    aliceSocket.emit("proposal:request", { type: "PAUSE" });
    const opened = await waitFor<{ proposal: { proposalId: string } }>(bobSocket, "proposal:update");

    const rejected = waitFor<{ error: string }>(bobSocket, "proposal:cancelError");
    bobSocket.emit("proposal:cancel", { proposalId: opened.proposal.proposalId });
    expect((await rejected).error).toMatch(/proposer/);
    expect(proposals.getActiveProposal(roomId)?.state).toBe("OPEN");
  });

  it("lets the proposer cancel their own open vote, resolving it as cancelled without executing it", async () => {
    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    await waitFor(aliceSocket, "room:snapshot");

    const bobSocket = await connect(bob, "client-bob");
    bobSocket.emit("room:join", { roomId });
    await waitFor(bobSocket, "room:snapshot");

    aliceSocket.emit("proposal:request", { type: "PAUSE" });
    const opened = await waitFor<{ proposal: { proposalId: string } }>(bobSocket, "proposal:update");

    const cancelled = waitFor<{ proposal: { state: string }; applied: boolean; cancelled?: boolean }>(bobSocket, "proposal:update");
    aliceSocket.emit("proposal:cancel", { proposalId: opened.proposal.proposalId });

    expect(await cancelled).toMatchObject({ proposal: { state: "FAILED" }, applied: false, cancelled: true });
    expect(getCurrentPlayback(db, roomId)?.status).toBe("PLAYING");
    expect(proposals.getActiveProposal(roomId)).toBeNull();
  });
});

describe("realtime SKIP voting and natural track end", () => {
  let dir: string;
  let db: DatabaseSync;
  let httpServer: ReturnType<typeof createServer>;
  let io: Server;
  let baseUrl: string;
  let roomId: string;
  let clients: ClientSocket[];
  let alice: Account;
  let bob: Account;
  let proposals: ProposalManager;
  let firstQueueItemId: string;
  let secondQueueItemId: string;

  function makeAccount(clientId: string, displayName: string): Account {
    return registerAccount(db, clientId, displayName);
  }

  function connect(account: Account, clientId: string): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const socket = ioClient(baseUrl, {
        auth: { accountId: account.accountId, clientId },
        transports: ["websocket"],
        forceNew: true,
      });
      clients.push(socket);
      socket.once("connect", () => resolve(socket));
      socket.once("connect_error", (err) => reject(err));
    });
  }

  function waitFor<T = unknown>(socket: ClientSocket, event: string): Promise<T> {
    return new Promise((resolve) => socket.once(event, (payload: T) => resolve(payload)));
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "echo-room-realtime-skip-"));
    db = openDatabase(path.join(dir, "echo-room.sqlite"));
    clients = [];

    httpServer = createServer();
    io = new Server(httpServer);
    ({ proposals } = attachRealtime(io, db, { votingWindowMs: 60 }));
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://localhost:${port}`;

    alice = makeAccount("client-alice", "Alice");
    bob = makeAccount("client-bob", "Bob");
    const room = createRoom(db, {
      accountId: alice.accountId,
      name: "Test room",
      visibility: "PUBLIC",
      autoCloseEnabled: false,
    });
    roomId = room.roomId;

    const resolveMetadata = async (videoId: string) => ({
      videoId,
      title: "Never Gonna Give You Up",
      channelTitle: "Rick Astley",
      thumbnailUrl: "https://example.com/thumb.jpg",
      embeddable: true,
    });
    const first = await addTrack(db, roomId, alice.accountId, "dQw4w9WgXcQ", { resolveMetadata });
    firstQueueItemId = first.queueItemId;
    ensureCurrentTrack(db, roomId, first.queueItemId);
    const second = await addTrack(db, roomId, bob.accountId, "dQw4w9WgXcQ", { resolveMetadata });
    secondQueueItemId = second.queueItemId;
  });

  afterEach(async () => {
    proposals.dispose();
    for (const client of clients) client.close();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs the full SKIP propose → vote → resolve flow, advancing to the next track under a new DJ", async () => {
    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    await waitFor(aliceSocket, "room:snapshot");

    const bobSocket = await connect(bob, "client-bob");
    bobSocket.emit("room:join", { roomId });
    await waitFor(bobSocket, "room:snapshot");
    await waitFor(aliceSocket, "presence:join");

    const bobSeesOpen = waitFor<{ proposal: { proposalId: string; type: string } }>(bobSocket, "proposal:update");
    aliceSocket.emit("proposal:request", { type: "SKIP" });
    const opened = await bobSeesOpen;
    expect(opened.proposal.type).toBe("SKIP");

    const finalSeen = waitFor<{ proposal: { state: string }; applied: boolean }>(bobSocket, "proposal:update");
    const alicePlaybackUpdate = waitFor(aliceSocket, "playback:update");
    bobSocket.emit("proposal:vote", { proposalId: opened.proposal.proposalId, choice: "YES" });
    const resolved = await finalSeen;
    expect(resolved.proposal.state).toBe("PASSED");
    expect(resolved.applied).toBe(true);

    const playback = (await alicePlaybackUpdate) as { queueItemId: string; dj: { accountId: string } };
    expect(playback.queueItemId).toBe(secondQueueItemId);
    expect(playback.dj.accountId).toBe(bob.accountId);
  });

  it("advances to the next track when a client reports its player naturally reached the end", async () => {
    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    const snapshot = await waitFor<{ playback: { playbackId: string } | null }>(aliceSocket, "room:snapshot");
    const currentPlaybackId = snapshot.playback!.playbackId;

    const bobSocket = await connect(bob, "client-bob");
    bobSocket.emit("room:join", { roomId });
    await waitFor(bobSocket, "room:snapshot");

    // This track's length is unknown, so it takes a majority of the two
    // present: both players reaching the end, as they would.
    const bobSeesUpdate = waitFor<{ queueItemId: string }>(bobSocket, "playback:update");
    aliceSocket.emit("playback:ended", { playbackId: currentPlaybackId });
    bobSocket.emit("playback:ended", { playbackId: currentPlaybackId });

    const updated = await bobSeesUpdate;
    expect(updated.queueItemId).toBe(secondQueueItemId);
  });

  // Regression: with no known length to check against, any one client's
  // report used to advance the room — a skip with no vote, e.g. by dragging
  // the visible player's own scrubber to the end.
  it("does not let one listener end a track of unknown length for everyone", async () => {
    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    const snapshot = await waitFor<{ playback: { playbackId: string } | null }>(aliceSocket, "room:snapshot");
    const bobSocket = await connect(bob, "client-bob");
    bobSocket.emit("room:join", { roomId });
    await waitFor(bobSocket, "room:snapshot");

    let advanced = false;
    bobSocket.once("playback:update", () => {
      advanced = true;
    });
    aliceSocket.emit("playback:ended", { playbackId: snapshot.playback!.playbackId });
    aliceSocket.emit("playback:ended", { playbackId: snapshot.playback!.playbackId }); // same account twice counts once
    await sleep(100);

    expect(advanced).toBe(false);
    expect(getCurrentPlayback(db, roomId)?.queueItemId).toBe(firstQueueItemId);
  });

  it("forgets end reports once the room re-anchors, so they can't add up across a pause", async () => {
    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    const snapshot = await waitFor<{ playback: { playbackId: string } | null }>(aliceSocket, "room:snapshot");
    const bobSocket = await connect(bob, "client-bob");
    bobSocket.emit("room:join", { roomId });
    await waitFor(bobSocket, "room:snapshot");
    const playbackId = snapshot.playback!.playbackId;

    aliceSocket.emit("playback:ended", { playbackId });
    await sleep(50);
    setPlaybackStatus(db, roomId, "PAUSED"); // revision bump: everyone re-anchors
    bobSocket.emit("playback:ended", { playbackId });
    await sleep(100);

    expect(getCurrentPlayback(db, roomId)?.queueItemId).toBe(firstQueueItemId);
  });

  it("ignores a playback:ended report carrying a stale playbackId", async () => {
    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    await waitFor(aliceSocket, "room:snapshot");

    let sawUpdate = false;
    aliceSocket.once("playback:update", () => {
      sawUpdate = true;
    });
    aliceSocket.emit("playback:ended", { playbackId: "not-the-real-playback-id" });
    await sleep(100);
    expect(sawUpdate).toBe(false);
    expect(getCurrentPlayback(db, roomId)?.queueItemId).toBe(firstQueueItemId);
  });

  it("invalidates an in-flight SKIP vote right away when the track it's about naturally ends first", async () => {
    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    const snapshot = await waitFor<{ playback: { playbackId: string } | null }>(aliceSocket, "room:snapshot");
    const currentPlaybackId = snapshot.playback!.playbackId;

    const bobSocket = await connect(bob, "client-bob");
    bobSocket.emit("room:join", { roomId });
    await waitFor(bobSocket, "room:snapshot");
    await waitFor(aliceSocket, "presence:join");

    const bobSeesOpen = waitFor(bobSocket, "proposal:update");
    aliceSocket.emit("proposal:request", { type: "SKIP" });
    await bobSeesOpen;

    const invalidated = waitFor<{ proposal: { state: string }; applied: boolean }>(bobSocket, "proposal:update");
    const playbackUpdate = waitFor<{ queueItemId: string }>(bobSocket, "playback:update");
    aliceSocket.emit("playback:ended", { playbackId: currentPlaybackId });
    bobSocket.emit("playback:ended", { playbackId: currentPlaybackId });

    const invalidatedResult = await invalidated;
    expect(invalidatedResult.proposal.state).toBe("FAILED");
    expect(invalidatedResult.applied).toBe(false);

    const updated = await playbackUpdate;
    expect(updated.queueItemId).toBe(secondQueueItemId);

    // The original 60ms timer must not still be pending: waiting past it
    // must produce no further "PASSED" broadcast or second advance.
    await sleep(80);
    expect(proposals.getActiveProposal(roomId)).toBeNull();
    expect(getCurrentPlayback(db, roomId)?.queueItemId).toBe(secondQueueItemId);
  });
});

describe("realtime SEEK voting", () => {
  let dir: string;
  let db: DatabaseSync;
  let httpServer: ReturnType<typeof createServer>;
  let io: Server;
  let baseUrl: string;
  let roomId: string;
  let clients: ClientSocket[];
  let alice: Account;
  let bob: Account;
  let proposals: ProposalManager;

  function makeAccount(clientId: string, displayName: string): Account {
    return registerAccount(db, clientId, displayName);
  }

  function connect(account: Account, clientId: string): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const socket = ioClient(baseUrl, {
        auth: { accountId: account.accountId, clientId },
        transports: ["websocket"],
        forceNew: true,
      });
      clients.push(socket);
      socket.once("connect", () => resolve(socket));
      socket.once("connect_error", (err) => reject(err));
    });
  }

  function waitFor<T = unknown>(socket: ClientSocket, event: string): Promise<T> {
    return new Promise((resolve) => socket.once(event, (payload: T) => resolve(payload)));
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "echo-room-realtime-seek-"));
    db = openDatabase(path.join(dir, "echo-room.sqlite"));
    clients = [];

    httpServer = createServer();
    io = new Server(httpServer);
    ({ proposals } = attachRealtime(io, db, { votingWindowMs: 60 }));
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://localhost:${port}`;

    // Alice is the DJ throughout: she is the account that added the
    // currently-playing track, per playback.ts's live-derived DJ field.
    alice = makeAccount("client-alice", "Alice");
    bob = makeAccount("client-bob", "Bob");
    const room = createRoom(db, {
      accountId: alice.accountId,
      name: "Test room",
      visibility: "PUBLIC",
      autoCloseEnabled: false,
    });
    roomId = room.roomId;

    const item = await addTrack(db, roomId, alice.accountId, "dQw4w9WgXcQ", {
      resolveMetadata: async (videoId) => ({
        videoId,
        title: "Never Gonna Give You Up",
        channelTitle: "Rick Astley",
        thumbnailUrl: "https://example.com/thumb.jpg",
        embeddable: true,
      }),
    });
    ensureCurrentTrack(db, roomId, item.queueItemId);
  });

  afterEach(async () => {
    proposals.dispose();
    for (const client of clients) client.close();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs the full SEEK propose → vote → resolve flow, rebasing the authoritative anchor for everyone", async () => {
    const before = getCurrentPlayback(db, roomId)!;

    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    await waitFor(aliceSocket, "room:snapshot");

    const bobSocket = await connect(bob, "client-bob");
    bobSocket.emit("room:join", { roomId });
    await waitFor(bobSocket, "room:snapshot");
    await waitFor(aliceSocket, "presence:join");

    const bobSeesOpen = waitFor<{ proposal: { proposalId: string; type: string; payload: unknown } }>(
      bobSocket,
      "proposal:update",
    );
    aliceSocket.emit("proposal:request", { type: "SEEK", positionMs: 42_000 });
    const opened = await bobSeesOpen;
    expect(opened.proposal.type).toBe("SEEK");
    expect(opened.proposal.payload).toEqual({ type: "SEEK", positionMs: 42_000 });

    const finalSeen = waitFor<{ proposal: { state: string }; applied: boolean }>(bobSocket, "proposal:update");
    const alicePlaybackUpdate = waitFor(aliceSocket, "playback:update");
    bobSocket.emit("proposal:vote", { proposalId: opened.proposal.proposalId, choice: "YES" });
    const resolved = await finalSeen;
    expect(resolved.proposal.state).toBe("PASSED");
    expect(resolved.applied).toBe(true);

    const playback = (await alicePlaybackUpdate) as {
      playbackId: string;
      anchorPositionMs: number;
      revision: number;
    };
    expect(playback.playbackId).toBe(before.playbackId); // a seek is not a track transition
    expect(playback.anchorPositionMs).toBe(42_000);
    expect(playback.revision).toBe(before.revision + 1);
  });

  it("rejects a SEEK request from a non-DJ account with a typed NOT_CURRENT_DJ error and never opens a vote", async () => {
    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    await waitFor(aliceSocket, "room:snapshot");

    const bobSocket = await connect(bob, "client-bob");
    bobSocket.emit("room:join", { roomId });
    await waitFor(bobSocket, "room:snapshot");
    await waitFor(aliceSocket, "presence:join");

    const requestError = waitFor<{ error: string; code?: string }>(bobSocket, "proposal:requestError");
    bobSocket.emit("proposal:request", { type: "SEEK", positionMs: 10_000 });
    const err = await requestError;
    expect(err.code).toBe("NOT_CURRENT_DJ");
    expect(proposals.getActiveProposal(roomId)).toBeNull();
  });

  it("rejects a SEEK request with a negative target timestamp and never opens a vote", async () => {
    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    await waitFor(aliceSocket, "room:snapshot");

    const requestError = waitFor<{ error: string }>(aliceSocket, "proposal:requestError");
    aliceSocket.emit("proposal:request", { type: "SEEK", positionMs: -5000 });
    expect((await requestError).error).toMatch(/non-negative/);
    expect(proposals.getActiveProposal(roomId)).toBeNull();
  });

  it("does not apply a passed SEEK proposal once its playback reference has gone stale", async () => {
    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    await waitFor(aliceSocket, "room:snapshot");

    const bobSocket = await connect(bob, "client-bob");
    bobSocket.emit("room:join", { roomId });
    await waitFor(bobSocket, "room:snapshot");
    await waitFor(aliceSocket, "presence:join");

    const bobSeesOpen = waitFor<{ proposal: { proposalId: string } }>(bobSocket, "proposal:update");
    aliceSocket.emit("proposal:request", { type: "SEEK", positionMs: 30_000 });
    const opened = await bobSeesOpen;

    // Rebase before the last ballot; a fully cast stale vote must not apply.
    const rebased = setPlaybackStatus(db, roomId, "PAUSED")!;
    const finalSeen = waitFor<{ proposal: { state: string }; applied: boolean }>(bobSocket, "proposal:update");
    bobSocket.emit("proposal:vote", { proposalId: opened.proposal.proposalId, choice: "YES" });
    const final = await finalSeen;
    expect(final.proposal.state).toBe("PASSED");
    expect(final.applied).toBe(false);
    expect(getCurrentPlayback(db, roomId)?.anchorPositionMs).toBe(rebased.anchorPositionMs);
  });
});

describe("realtime REMOVE_QUEUE_ITEM voting", () => {
  let dir: string;
  let db: DatabaseSync;
  let httpServer: ReturnType<typeof createServer>;
  let io: Server;
  let baseUrl: string;
  let roomId: string;
  let clients: ClientSocket[];
  let alice: Account;
  let bob: Account;
  let proposals: ProposalManager;
  let current: { queueItemId: string };

  function makeAccount(clientId: string, displayName: string): Account {
    return registerAccount(db, clientId, displayName);
  }

  function connect(account: Account, clientId: string): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const socket = ioClient(baseUrl, {
        auth: { accountId: account.accountId, clientId },
        transports: ["websocket"],
        forceNew: true,
      });
      clients.push(socket);
      socket.once("connect", () => resolve(socket));
      socket.once("connect_error", (err) => reject(err));
    });
  }

  function waitFor<T = unknown>(socket: ClientSocket, event: string): Promise<T> {
    return new Promise((resolve) => socket.once(event, (payload: T) => resolve(payload)));
  }

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "echo-room-realtime-remove-"));
    db = openDatabase(path.join(dir, "echo-room.sqlite"));
    clients = [];

    httpServer = createServer();
    io = new Server(httpServer);
    ({ proposals } = attachRealtime(io, db, { votingWindowMs: 60 }));
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://localhost:${port}`;

    // Alice is the DJ throughout: she is the account that added the
    // currently-playing track, per playback.ts's live-derived DJ field.
    alice = makeAccount("client-alice", "Alice");
    bob = makeAccount("client-bob", "Bob");
    const room = createRoom(db, {
      accountId: alice.accountId,
      name: "Test room",
      visibility: "PUBLIC",
      autoCloseEnabled: false,
    });
    roomId = room.roomId;

    const item = await addTrack(db, roomId, alice.accountId, "dQw4w9WgXcQ", {
      resolveMetadata: async (videoId) => ({
        videoId,
        title: "Never Gonna Give You Up",
        channelTitle: "Rick Astley",
        thumbnailUrl: "https://example.com/thumb.jpg",
        embeddable: true,
      }),
    });
    ensureCurrentTrack(db, roomId, item.queueItemId);
    current = item;
  });

  afterEach(async () => {
    proposals.dispose();
    for (const client of clients) client.close();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs the full REMOVE_QUEUE_ITEM propose → vote → resolve flow and broadcasts queue:itemRemoved", async () => {
    const b = await addTrack(db, roomId, bob.accountId, "dQw4w9WgXcQ", {
      resolveMetadata: async (videoId) => ({
        videoId,
        title: "Another Song",
        channelTitle: "Someone Else",
        thumbnailUrl: "https://example.com/thumb2.jpg",
        embeddable: true,
      }),
    });

    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    await waitFor(aliceSocket, "room:snapshot");

    const bobSocket = await connect(bob, "client-bob");
    bobSocket.emit("room:join", { roomId });
    await waitFor(bobSocket, "room:snapshot");
    await waitFor(aliceSocket, "presence:join");

    const bobSeesOpen = waitFor<{ proposal: { proposalId: string; type: string; payload: unknown } }>(
      bobSocket,
      "proposal:update",
    );
    aliceSocket.emit("proposal:request", { type: "REMOVE_QUEUE_ITEM", queueItemId: b.queueItemId });
    const opened = await bobSeesOpen;
    expect(opened.proposal.type).toBe("REMOVE_QUEUE_ITEM");
    expect(opened.proposal.payload).toEqual({ type: "REMOVE_QUEUE_ITEM", queueItemId: b.queueItemId });

    const finalSeen = waitFor<{ proposal: { state: string }; applied: boolean }>(bobSocket, "proposal:update");
    const aliceSeesItemRemoved = waitFor<{ queueItemId: string }>(aliceSocket, "queue:itemRemoved");
    bobSocket.emit("proposal:vote", { proposalId: opened.proposal.proposalId, choice: "YES" });
    const resolved = await finalSeen;
    expect(resolved.proposal.state).toBe("PASSED");
    expect(resolved.applied).toBe(true);

    const removed = await aliceSeesItemRemoved;
    expect(removed.queueItemId).toBe(b.queueItemId);
    expect(getCurrentPlayback(db, roomId)?.queueItemId).toBe(current.queueItemId);
  });

  it("rejects a REMOVE_QUEUE_ITEM request targeting the currently-playing item with a typed IS_CURRENT_TRACK error and never opens a vote", async () => {
    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    await waitFor(aliceSocket, "room:snapshot");

    const requestError = waitFor<{ error: string; code?: string }>(aliceSocket, "proposal:requestError");
    aliceSocket.emit("proposal:request", { type: "REMOVE_QUEUE_ITEM", queueItemId: current.queueItemId });
    const err = await requestError;
    expect(err.code).toBe("IS_CURRENT_TRACK");
    expect(proposals.getActiveProposal(roomId)).toBeNull();
  });
});

// Regression: socket.io invokes event handlers from a process.nextTick
// callback, so a handler that throws (e.g. on a DB write failure) used to be
// an uncaught exception that took down the whole process — every room, not
// just the one socket whose event failed (CLAUDE.md's Reliability section).
describe("realtime error isolation", () => {
  let dir: string;
  let db: DatabaseSync;
  let httpServer: ReturnType<typeof createServer>;
  let io: Server;
  let baseUrl: string;
  let roomId: string;
  let clients: ClientSocket[];
  let alice: Account;
  let bob: Account;
  let proposals: ProposalManager;

  function connect(account: Account, clientId: string): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const socket = ioClient(baseUrl, {
        auth: { accountId: account.accountId, clientId },
        transports: ["websocket"],
        forceNew: true,
      });
      clients.push(socket);
      socket.once("connect", () => resolve(socket));
      socket.once("connect_error", (err) => reject(err));
    });
  }

  function waitFor<T = unknown>(socket: ClientSocket, event: string): Promise<T> {
    return new Promise((resolve) => socket.once(event, (payload: T) => resolve(payload)));
  }

  // Makes every statement whose SQL contains `fragment` throw, the way a full
  // disk or a locked file would, until the returned restore function runs.
  function failWrites(fragment: string): () => void {
    const realPrepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes(fragment)) throw new Error("simulated disk write failure");
      return realPrepare(sql);
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    return () => {
      spy.mockRestore();
      consoleSpy.mockRestore();
    };
  }

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "echo-room-realtime-errors-"));
    db = openDatabase(path.join(dir, "echo-room.sqlite"));
    clients = [];

    httpServer = createServer();
    io = new Server(httpServer);
    ({ proposals } = attachRealtime(io, db, { votingWindowMs: 60 }));
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://localhost:${port}`;

    alice = registerAccount(db, "client-alice", "Alice");
    bob = registerAccount(db, "client-bob", "Bob");
    const room = createRoom(db, {
      accountId: alice.accountId,
      name: "Test room",
      visibility: "PUBLIC",
      autoCloseEnabled: false,
    });
    roomId = room.roomId;

    const item = await addTrack(db, roomId, alice.accountId, "dQw4w9WgXcQ", {
      resolveMetadata: async (videoId) => ({
        videoId,
        title: "Never Gonna Give You Up",
        channelTitle: "Rick Astley",
        thumbnailUrl: "https://example.com/thumb.jpg",
        embeddable: true,
      }),
    });
    ensureCurrentTrack(db, roomId, item.queueItemId);
  });

  afterEach(async () => {
    proposals.dispose();
    for (const client of clients) client.close();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a DB write failure while sending a chat message fails only that event, and the server keeps serving", async () => {
    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    await waitFor(aliceSocket, "room:snapshot");

    const restore = failWrites("INSERT INTO chat_messages");
    const sendError = waitFor<{ error: string }>(aliceSocket, "chat:sendError");
    aliceSocket.emit("chat:send", { text: "Hello" });
    expect((await sendError).error).toBe("internal server error");
    restore();

    // Same socket, next event: still served normally.
    const live = waitFor<{ text: string }>(aliceSocket, "chat:new");
    aliceSocket.emit("chat:send", { text: "Hello" });
    expect((await live).text).toBe("Hello");
  });

  it("a DB write failure while joining reports a join error without leaving the socket half-present", async () => {
    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    await waitFor(aliceSocket, "room:snapshot");

    const bobSocket = await connect(bob, "client-bob");
    const restore = failWrites("UPDATE rooms SET lastMeaningfulActivityAt");
    const joinError = waitFor<{ error: string }>(bobSocket, "room:joinError");
    bobSocket.emit("room:join", { roomId });
    expect((await joinError).error).toBe("internal server error");
    restore();

    // The failed join never registered Bob as present...
    const aliceSeesBob = waitFor<{ accountId: string }>(aliceSocket, "presence:join");
    // ...so a retry is a genuinely fresh join that everyone else sees.
    bobSocket.emit("room:join", { roomId });
    const snapshot = await waitFor<RoomSnapshot>(bobSocket, "room:snapshot");
    expect((await aliceSeesBob).accountId).toBe(bob.accountId);
    expect(snapshot.presence.map((p) => p.accountId).sort()).toEqual([alice.accountId, bob.accountId].sort());
  });

  it("a DB write failure while opening a vote leaves no half-open proposal behind", async () => {
    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    await waitFor(aliceSocket, "room:snapshot");
    // Two present, so this opens an ordinary vote rather than a sole
    // listener's instant pass.
    const bobSocket = await connect(bob, "client-bob");
    bobSocket.emit("room:join", { roomId });
    await waitFor(bobSocket, "room:snapshot");

    const restore = failWrites("UPDATE rooms SET lastMeaningfulActivityAt");
    const requestError = waitFor<{ error: string }>(aliceSocket, "proposal:requestError");
    aliceSocket.emit("proposal:request", { type: "PAUSE" });
    expect((await requestError).error).toBe("internal server error");
    restore();

    expect(proposals.getActiveProposal(roomId)).toBeNull();
    const opened = waitFor<{ proposal: { state: string } }>(aliceSocket, "proposal:update");
    aliceSocket.emit("proposal:request", { type: "PAUSE" });
    expect((await opened).proposal.state).toBe("OPEN");
  });
});

describe("realtime room capacity and private rooms", () => {
  let dir: string;
  let db: DatabaseSync;
  let httpServer: ReturnType<typeof createServer>;
  let io: Server;
  let baseUrl: string;
  let clients: ClientSocket[];
  let presence: PresenceStore;
  let host: Account;

  function connect(account: Account, clientId: string): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const socket = ioClient(baseUrl, {
        auth: { accountId: account.accountId, clientId },
        transports: ["websocket"],
        forceNew: true,
      });
      clients.push(socket);
      socket.once("connect", () => resolve(socket));
      socket.once("connect_error", (err) => reject(err));
    });
  }

  type JoinOutcome = { snapshot: RoomSnapshot } | { error: string; code: string };

  function join(socket: ClientSocket, roomId: string): Promise<JoinOutcome> {
    return new Promise((resolve) => {
      socket.once("room:snapshot", (snapshot: RoomSnapshot) => resolve({ snapshot }));
      socket.once("room:joinError", (err: { error: string; code: string }) => resolve(err));
      socket.emit("room:join", { roomId });
    });
  }

  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(check()).toBe(true);
  }

  // Registers `n` fresh accounts, each with a matching clientId.
  function visitors(n: number, prefix: string): { account: Account; clientId: string }[] {
    return Array.from({ length: n }, (_, i) => {
      const clientId = `client-${prefix}-${i}`;
      return { account: registerAccount(db, clientId, `${prefix} ${i}`), clientId };
    });
  }

  function publicRoom(): string {
    return createRoom(db, { accountId: host.accountId, name: "Party", visibility: "PUBLIC", autoCloseEnabled: false })
      .roomId;
  }

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "echo-room-realtime-capacity-"));
    db = openDatabase(path.join(dir, "echo-room.sqlite"));
    clients = [];

    httpServer = createServer();
    io = new Server(httpServer);
    ({ presence } = attachRealtime(io, db));
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://localhost:${port}`;

    host = registerAccount(db, "client-host", "Host");
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Regression: capacity used to count every account that had *ever* joined,
  // so after twelve people had come and gone an empty room refused everyone.
  it("frees places as people leave: a 13th visitor gets into a room twelve others have already left", async () => {
    const roomId = publicRoom();
    for (const { account, clientId } of visitors(MAX_ROOM_USERS, "past")) {
      const socket = await connect(account, clientId);
      expect(await join(socket, roomId)).toHaveProperty("snapshot");
      socket.close();
      await until(() => presence.count(roomId) === 0);
    }

    const [latecomer] = visitors(1, "latecomer");
    const outcome = await join(await connect(latecomer.account, latecomer.clientId), roomId);
    expect(outcome).toHaveProperty("snapshot");
  });

  it("turns away a 13th person while twelve are present, and lets them in once someone leaves", async () => {
    const roomId = publicRoom();
    const sockets: ClientSocket[] = [];
    for (const { account, clientId } of visitors(MAX_ROOM_USERS, "present")) {
      const socket = await connect(account, clientId);
      expect(await join(socket, roomId)).toHaveProperty("snapshot");
      sockets.push(socket);
    }

    const [extra] = visitors(1, "extra");
    const extraSocket = await connect(extra.account, extra.clientId);
    expect(await join(extraSocket, roomId)).toMatchObject({ code: "room-full" });

    sockets[0].close();
    await until(() => presence.count(roomId) === MAX_ROOM_USERS - 1);
    expect(await join(extraSocket, roomId)).toHaveProperty("snapshot");
  });

  it("never lets two sockets racing for the last place both in", async () => {
    const roomId = publicRoom();
    for (const { account, clientId } of visitors(MAX_ROOM_USERS - 1, "seed")) {
      expect(await join(await connect(account, clientId), roomId)).toHaveProperty("snapshot");
    }

    const [a, b] = visitors(2, "racer");
    const [socketA, socketB] = await Promise.all([connect(a.account, a.clientId), connect(b.account, b.clientId)]);
    const outcomes = await Promise.all([join(socketA, roomId), join(socketB, roomId)]);

    expect(outcomes.filter((o) => "snapshot" in o)).toHaveLength(1);
    expect(outcomes.filter((o) => "code" in o && o.code === "room-full")).toHaveLength(1);
    expect(presence.count(roomId)).toBe(MAX_ROOM_USERS);
  });

  it("still admits another tab of someone already present when the room is full", async () => {
    const roomId = publicRoom();
    const people = visitors(MAX_ROOM_USERS, "tabs");
    for (const { account, clientId } of people) {
      expect(await join(await connect(account, clientId), roomId)).toHaveProperty("snapshot");
    }

    const secondTab = await connect(people[0].account, people[0].clientId);
    expect(await join(secondTab, roomId)).toHaveProperty("snapshot");
    expect(presence.count(roomId)).toBe(MAX_ROOM_USERS);
  });

  // A private room's roomId alone must not get anyone in — only its creator
  // and accounts admitted with its 6-digit code (POST /api/rooms/join-by-code,
  // which records membership via joinRoom) may join its socket room.
  it("admits only members to a private room, reporting it to anyone else as not found", async () => {
    const roomId = createRoom(db, {
      accountId: host.accountId,
      name: "Secret",
      visibility: "PRIVATE",
      autoCloseEnabled: false,
    }).roomId;
    const [guest] = visitors(1, "guest");
    const guestSocket = await connect(guest.account, guest.clientId);

    expect(await join(guestSocket, roomId)).toMatchObject({ code: "room-not-found" });
    expect(await join(await connect(host, "client-host"), roomId)).toHaveProperty("snapshot");

    joinRoom(db, roomId, guest.account.accountId);
    expect(await join(guestSocket, roomId)).toHaveProperty("snapshot");
  });
});

// Regression: a room that auto-closed while people were still in it (just
// listening isn't activity) let them carry on voting and reacting in a room
// that no longer existed for anyone else.
describe("realtime room closure", () => {
  let dir: string;
  let db: DatabaseSync;
  let httpServer: ReturnType<typeof createServer>;
  let io: Server;
  let baseUrl: string;
  let roomId: string;
  let clients: ClientSocket[];
  let alice: Account;
  let bob: Account;
  let handles: ReturnType<typeof attachRealtime>;

  function connect(account: Account, clientId: string): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const socket = ioClient(baseUrl, {
        auth: { accountId: account.accountId, clientId },
        transports: ["websocket"],
        forceNew: true,
      });
      clients.push(socket);
      socket.once("connect", () => resolve(socket));
      socket.once("connect_error", (err) => reject(err));
    });
  }

  function waitFor<T = unknown>(socket: ClientSocket, event: string): Promise<T> {
    return new Promise((resolve) => socket.once(event, (payload: T) => resolve(payload)));
  }

  async function joined(account: Account, clientId: string): Promise<ClientSocket> {
    const socket = await connect(account, clientId);
    socket.emit("room:join", { roomId });
    await waitFor(socket, "room:snapshot");
    return socket;
  }

  // Backdates the room's last activity past the 2-hour window, as if
  // everyone had just been listening all that time.
  function goQuiet(): void {
    const longAgo = new Date(Date.now() - AUTO_CLOSE_INACTIVITY_MS - 60_000).toISOString();
    db.prepare("UPDATE rooms SET lastMeaningfulActivityAt = ? WHERE roomId = ?").run(longAgo, roomId);
  }

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "echo-room-realtime-closure-"));
    db = openDatabase(path.join(dir, "echo-room.sqlite"));
    clients = [];

    httpServer = createServer();
    io = new Server(httpServer);
    handles = attachRealtime(io, db, { votingWindowMs: 5_000, closureCheckIntervalMs: 0 });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://localhost:${port}`;

    alice = registerAccount(db, "client-alice", "Alice");
    bob = registerAccount(db, "client-bob", "Bob");
    roomId = createRoom(db, { accountId: alice.accountId, name: "Quiet room", visibility: "PUBLIC", autoCloseEnabled: true })
      .roomId;
    const item = await addTrack(db, roomId, alice.accountId, "dQw4w9WgXcQ", {
      resolveMetadata: async (videoId) => ({
        videoId,
        title: "Song",
        channelTitle: "Channel",
        thumbnailUrl: "https://example.com/t.jpg",
        embeddable: true,
      }),
    });
    ensureCurrentTrack(db, roomId, item.queueItemId);
  });

  afterEach(async () => {
    handles.proposals.dispose();
    for (const client of clients) client.close();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lets everyone go the moment anyone acts in a room that has closed", async () => {
    const aliceSocket = await joined(alice, "client-alice");
    const bobSocket = await joined(bob, "client-bob");

    goQuiet();
    const aliceClosed = waitFor<{ roomId: string }>(aliceSocket, "room:closed");
    const bobClosed = waitFor<{ roomId: string }>(bobSocket, "room:closed");
    const refused = waitFor<{ error: string }>(aliceSocket, "chat:sendError");
    aliceSocket.emit("chat:send", { text: "Hello" });

    expect((await refused).error).toBe("that room has closed");
    expect((await aliceClosed).roomId).toBe(roomId);
    expect((await bobClosed).roomId).toBe(roomId);
    expect(handles.presence.count(roomId)).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get()).toEqual({ n: 0 });

    // Bob is out too: his next action is treated as coming from nowhere.
    const bobRefused = waitFor<{ error: string }>(bobSocket, "proposal:requestError");
    bobSocket.emit("proposal:request", { type: "PAUSE" });
    expect((await bobRefused).error).toBe("join a room before requesting a vote");
  });

  it("finds a closed room nobody is acting in, fails its open vote, and lets everyone go", async () => {
    const aliceSocket = await joined(alice, "client-alice");
    const bobSocket = await joined(bob, "client-bob");
    const opened = waitFor(bobSocket, "proposal:update");
    aliceSocket.emit("proposal:request", { type: "PAUSE" });
    await opened;

    goQuiet();
    const failed = waitFor<{ proposal: { state: string } }>(bobSocket, "proposal:update");
    const bobClosed = waitFor(bobSocket, "room:closed");
    handles.checkClosedRooms();

    expect((await failed).proposal.state).toBe("FAILED");
    await bobClosed;
    expect(handles.proposals.getActiveProposal(roomId)).toBeNull();
    expect(handles.presence.count(roomId)).toBe(0);
  });

  it("leaves an open room's occupants alone", async () => {
    await joined(alice, "client-alice");
    handles.checkClosedRooms();
    expect(handles.presence.count(roomId)).toBe(1);
  });
});
