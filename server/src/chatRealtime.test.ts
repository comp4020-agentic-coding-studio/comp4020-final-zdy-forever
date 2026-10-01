import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { Server } from "socket.io";
import { io as connectClient, type Socket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage, ChatSendResult, RoomSnapshot } from "../../shared/src/types.ts";
import { registerAccount } from "./accounts.ts";
import { listChatMessages, recordChatMessage } from "./chat.ts";
import { openDatabase } from "./db.ts";
import { attachRealtime, type RealtimeHandles } from "./realtime.ts";
import { AUTO_CLOSE_INACTIVITY_MS, createRoom } from "./rooms.ts";

describe("room chat sockets", () => {
  let db: DatabaseSync;
  let http: HttpServer;
  let io: Server;
  let handles: RealtimeHandles;
  let url: string;
  let roomId: string;
  let clients: Socket[];
  const next = <T>(socket: Socket, event: string) => new Promise<T>(resolve => socket.once(event, resolve));
  const send = (socket: Socket, payload: unknown) => new Promise<ChatSendResult>((resolve, reject) => {
    socket.timeout(2000).emit("chat:send", payload, (error: Error | null, result: ChatSendResult) => error ? reject(error) : resolve(result));
  });
  async function connect(clientId: string) {
    const account = registerAccount(db, clientId, clientId);
    const socket = connectClient(url, { auth: { accountId: account.accountId, clientId }, transports: ["websocket"], forceNew: true });
    clients.push(socket);
    await next(socket, "connect");
    return { socket, account };
  }
  async function join(socket: Socket, id = roomId) {
    const snapshot = next<RoomSnapshot>(socket, "room:snapshot");
    socket.emit("room:join", { roomId: id });
    return snapshot;
  }
  beforeEach(async () => {
    db = openDatabase(":memory:");
    clients = [];
    http = createServer();
    io = new Server(http);
    handles = attachRealtime(io, db, { closureCheckIntervalMs: 0 });
    await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const host = registerAccount(db, "host", "Host");
    roomId = createRoom(db, { accountId: host.accountId, name: "Chat", visibility: "PUBLIC", autoCloseEnabled: true }).roomId;
  });
  afterEach(async () => {
    handles.proposals.dispose();
    clients.forEach(client => client.close());
    await new Promise<void>(resolve => io.close(() => resolve()));
    db.close();
  });

  it("broadcasts without playback, derives identity server-side and restores history on rejoin", async () => {
    const alice = await connect("Alice");
    const bob = await connect("Bob");
    await join(alice.socket);
    await join(bob.socket);
    const received = next<ChatMessage>(bob.socket, "chat:new");
    expect(await send(alice.socket, { text: "hello", accountId: bob.account.accountId, displayName: "forged", roomId: "other" })).toEqual({ ok: true });
    const message = await received;
    expect(message).toMatchObject({ roomId, accountId: alice.account.accountId, displayName: "Alice", text: "hello" });
    expect((await join(bob.socket)).chatMessages).toEqual([message]);
    const reconnected = await connect("Alice");
    expect((await join(reconnected.socket)).chatMessages).toEqual([message]);
    const logs = JSON.stringify(db.prepare("SELECT * FROM logs WHERE action = 'CHAT_SEND'").all());
    expect(logs).not.toContain("hello");
  });

  it("isolates rooms and does not disclose a private room's history", async () => {
    const alice = await connect("Alice");
    const outsider = await connect("Outsider");
    const privateRoom = createRoom(db, { accountId: alice.account.accountId, name: "Private", visibility: "PRIVATE", autoCloseEnabled: false });
    await join(alice.socket, privateRoom.roomId);
    await send(alice.socket, { text: "secret" });
    const refused = next<{ error: string }>(outsider.socket, "room:joinError");
    outsider.socket.emit("room:join", { roomId: privateRoom.roomId });
    expect((await refused).error).toBe("that room doesn't exist");
    expect((await join(outsider.socket)).chatMessages).toEqual([]);
    expect(await send(outsider.socket, { roomId: privateRoom.roomId, text: "public" })).toEqual({ ok: true });
    expect(listChatMessages(db, privateRoom.roomId).map(m => m.text)).toEqual(["secret"]);
    expect(listChatMessages(db, roomId).map(m => m.text)).toEqual(["public"]);
  });

  it("rejects missing membership, malformed text and excessive sends", async () => {
    const { socket } = await connect("Alice");
    expect(await send(socket, { text: "hello" })).toMatchObject({ ok: false, error: "join a room before chatting" });
    await join(socket);
    for (const payload of [null, {}, { text: 42 }, { text: " " }, { text: "x".repeat(501) }]) expect(await send(socket, payload)).toMatchObject({ ok: false });
    for (let i = 0; i < 8; i++) expect(await send(socket, { text: `message ${i}` })).toEqual({ ok: true });
    expect(await send(socket, { text: "too many" })).toMatchObject({ ok: false, error: "slow down — too many messages" });
    expect(listChatMessages(db, roomId)).toHaveLength(8);
  });

  it("the periodic check also deletes history for expired rooms with nobody connected", () => {
    const author = registerAccount(db, "former-member", "Former member");
    recordChatMessage(db, roomId, author.accountId, "left behind");
    db.prepare("UPDATE rooms SET lastMeaningfulActivityAt = ? WHERE roomId = ?")
      .run(new Date(Date.now() - AUTO_CLOSE_INACTIVITY_MS - 1).toISOString(), roomId);
    expect(handles.presence.count(roomId)).toBe(0);
    handles.checkClosedRooms();
    expect(listChatMessages(db, roomId)).toEqual([]);
  });

  it("notifies members and deletes all history when the room closes", async () => {
    const { socket } = await connect("Alice");
    await join(socket);
    await send(socket, { text: "temporary" });
    db.prepare("UPDATE rooms SET lastMeaningfulActivityAt = ? WHERE roomId = ?")
      .run(new Date(Date.now() - AUTO_CLOSE_INACTIVITY_MS - 1).toISOString(), roomId);
    const closed = next<{ roomId: string }>(socket, "room:closed");
    handles.checkClosedRooms();
    expect(await closed).toEqual({ roomId });
    expect(listChatMessages(db, roomId)).toEqual([]);
    expect(await send(socket, { text: "late" })).toMatchObject({ ok: false });
  });
});
