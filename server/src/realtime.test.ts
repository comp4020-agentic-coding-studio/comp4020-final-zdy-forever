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
import { addTrack } from "./queue.ts";
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
