import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { Server } from "socket.io";
import type { Account, RoomSnapshot } from "../../shared/src/types.ts";
import { registerAccount } from "./accounts.ts";
import { openDatabase } from "./db.ts";
import { ensureCurrentTrack, getCurrentPlayback, setPlaybackStatus } from "./playback.ts";
import { addTrack } from "./queue.ts";
import type { ProposalManager } from "./proposals.ts";
import { attachRealtime } from "./realtime.ts";
import { createRoom } from "./rooms.ts";

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

    // Casting the ballot immediately re-broadcasts the still-OPEN proposal
    // (see ProposalManager.castVote) — that ack must be consumed before
    // waiting for the separate, later broadcast that the 15-second (here,
    // 60ms) timer produces once it actually resolves the vote.
    const bobSeesVoteAck = waitFor<{ proposal: { state: string } }>(bobSocket, "proposal:update");
    bobSocket.emit("proposal:vote", { proposalId, choice: "YES" });
    const voteAck = await bobSeesVoteAck;
    expect(voteAck.proposal.state).toBe("OPEN");

    const bobSeesFinal = waitFor<{ proposal: { state: string }; applied: boolean }>(bobSocket, "proposal:update");
    const alicePlaybackUpdate = waitFor(aliceSocket, "playback:update");

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

  it("rejects a duplicate vote-choice replacement being silently accepted twice: the ballot still counts once per account", async () => {
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

    bobSocket.emit("proposal:vote", { proposalId, choice: "NO" });
    await waitFor(aliceSocket, "proposal:update");
    const finalSeen = waitFor<{ proposal: { votes: Record<string, string>; state: string } }>(
      aliceSocket,
      "proposal:update",
    );
    bobSocket.emit("proposal:vote", { proposalId, choice: "YES" });

    const final = await finalSeen;
    expect(final.proposal.votes[bob.accountId]).toBe("YES");
    expect(Object.keys(final.proposal.votes)).toHaveLength(2);
  });

  it("rejects a PLAY proposal request when the room is already playing", async () => {
    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    await waitFor(aliceSocket, "room:snapshot");

    const requestError = waitFor<{ error: string }>(aliceSocket, "proposal:requestError");
    aliceSocket.emit("proposal:request", { type: "PLAY" });
    expect((await requestError).error).toMatch(/already playing/);
  });

  it("leaves an unresolved proposal to fail on disconnect: the disconnecting voter's silence counts as abstain, not as blocking resolution", async () => {
    const aliceSocket = await connect(alice, "client-alice");
    aliceSocket.emit("room:join", { roomId });
    await waitFor(aliceSocket, "room:snapshot");

    const bobSocket = await connect(bob, "client-bob");
    bobSocket.emit("room:join", { roomId });
    await waitFor(bobSocket, "room:snapshot");
    await waitFor(aliceSocket, "presence:join");

    aliceSocket.emit("proposal:request", { type: "PAUSE" });
    await waitFor(bobSocket, "proposal:update");

    // Bob disconnects mid-vote without ever casting a ballot.
    const finalSeen = waitFor<{ proposal: { state: string } }>(aliceSocket, "proposal:update");
    bobSocket.close();

    const final = await finalSeen;
    expect(final.proposal.state).toBe("FAILED"); // only alice's auto-YES; below minimum 2 non-abstain votes
    expect(getCurrentPlayback(db, roomId)?.status).toBe("PLAYING");
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

    const bobSeesVoteAck = waitFor<{ proposal: { state: string } }>(bobSocket, "proposal:update");
    bobSocket.emit("proposal:vote", { proposalId: opened.proposal.proposalId, choice: "YES" });
    await bobSeesVoteAck;

    const alicePlaybackUpdate = waitFor(aliceSocket, "playback:update");
    const resolved = await waitFor<{ proposal: { state: string }; applied: boolean }>(bobSocket, "proposal:update");
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

    const bobSeesUpdate = waitFor<{ queueItemId: string }>(bobSocket, "playback:update");
    aliceSocket.emit("playback:ended", { playbackId: currentPlaybackId });

    const updated = await bobSeesUpdate;
    expect(updated.queueItemId).toBe(secondQueueItemId);
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

    const bobSeesVoteAck = waitFor<{ proposal: { state: string } }>(bobSocket, "proposal:update");
    bobSocket.emit("proposal:vote", { proposalId: opened.proposal.proposalId, choice: "YES" });
    await bobSeesVoteAck;

    const alicePlaybackUpdate = waitFor(aliceSocket, "playback:update");
    const resolved = await waitFor<{ proposal: { state: string }; applied: boolean }>(bobSocket, "proposal:update");
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

    const bobSeesVoteAck = waitFor(bobSocket, "proposal:update");
    bobSocket.emit("proposal:vote", { proposalId: opened.proposal.proposalId, choice: "YES" });
    await bobSeesVoteAck;

    // Something else rebases the anchor out of band before the vote closes.
    const rebased = setPlaybackStatus(db, roomId, "PAUSED")!;

    const final = await waitFor<{ proposal: { state: string }; applied: boolean }>(bobSocket, "proposal:update");
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

    const bobSeesVoteAck = waitFor<{ proposal: { state: string } }>(bobSocket, "proposal:update");
    bobSocket.emit("proposal:vote", { proposalId: opened.proposal.proposalId, choice: "YES" });
    await bobSeesVoteAck;

    const aliceSeesItemRemoved = waitFor<{ queueItemId: string }>(aliceSocket, "queue:itemRemoved");
    const resolved = await waitFor<{ proposal: { state: string }; applied: boolean }>(bobSocket, "proposal:update");
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
