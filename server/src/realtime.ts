import type { DatabaseSync } from "node:sqlite";
import type { Server, Socket } from "socket.io";
import type { RoomJoinPayload, RoomSnapshot } from "../../shared/src/types.ts";
import { getAccountByClientId } from "./accounts.ts";
import { PresenceStore } from "./presence.ts";
import { listQueue } from "./queue.ts";
import { joinRoom, RoomClosedError, RoomFullError, RoomNotFoundError } from "./rooms.ts";

interface SocketData {
  accountId: string;
  clientId: string;
  displayName: string;
  roomId: string | null;
}

// Wires Socket.IO into the app: identifies each connection against an
// already-registered account (never trusting a bare claimed accountId — see
// CLAUDE.md's Authority section), then tracks room presence and relays
// real-time room events. Returns the PresenceStore so the caller (index.ts)
// can also broadcast on it from REST routes (e.g. a queue addition).
export function attachRealtime(io: Server, db: DatabaseSync): PresenceStore {
  const presence = new PresenceStore();

  io.use((socket, next) => {
    const auth = socket.handshake.auth as { accountId?: unknown; clientId?: unknown };
    const accountId = typeof auth.accountId === "string" ? auth.accountId : "";
    const clientId = typeof auth.clientId === "string" ? auth.clientId : "";

    if (!accountId || !clientId) {
      next(new Error("accountId and clientId are required"));
      return;
    }

    // clientId is looked up server-side rather than trusting the paired
    // accountId at face value — a socket can only identify as the account
    // that clientId actually registered.
    const account = getAccountByClientId(db, clientId);
    if (!account || account.accountId !== accountId) {
      next(new Error("accountId does not match a registered account for this clientId"));
      return;
    }

    const data: SocketData = { accountId, clientId, displayName: account.displayName, roomId: null };
    socket.data = data;
    next();
  });

  function leaveCurrentRoom(io: Server, socket: Socket, data: SocketData): void {
    const roomId = data.roomId;
    if (!roomId) return;

    socket.leave(roomId);
    data.roomId = null;

    const result = presence.leave(roomId, socket.id);
    if (result?.becameAbsent) {
      io.to(roomId).emit("presence:leave", { accountId: result.accountId });
    }
  }

  io.on("connection", (socket: Socket) => {
    const data = socket.data as SocketData;

    socket.on("room:join", (payload: Partial<RoomJoinPayload>) => {
      const roomId = typeof payload?.roomId === "string" ? payload.roomId : "";
      if (!roomId) {
        socket.emit("room:joinError", { error: "roomId is required" });
        return;
      }

      if (data.roomId && data.roomId !== roomId) {
        leaveCurrentRoom(io, socket, data);
      }

      let room;
      try {
        room = joinRoom(db, roomId, data.accountId).room;
      } catch (err) {
        if (err instanceof RoomNotFoundError || err instanceof RoomClosedError || err instanceof RoomFullError) {
          socket.emit("room:joinError", { error: err.message });
          return;
        }
        throw err;
      }

      socket.join(roomId);
      data.roomId = roomId;

      const { becamePresent } = presence.join(roomId, socket.id, {
        accountId: data.accountId,
        displayName: data.displayName,
      });

      const snapshot: RoomSnapshot = {
        room,
        queue: listQueue(db, roomId),
        presence: presence.list(roomId),
      };
      socket.emit("room:snapshot", snapshot);

      if (becamePresent) {
        socket.to(roomId).emit("presence:join", { accountId: data.accountId, displayName: data.displayName });
      }
    });

    socket.on("disconnect", () => {
      leaveCurrentRoom(io, socket, data);
    });
  });

  return presence;
}
