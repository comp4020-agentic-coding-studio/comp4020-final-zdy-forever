import type { DatabaseSync } from "node:sqlite";
import type { Server, Socket } from "socket.io";
import type { RoomJoinPayload, RoomSnapshot } from "../../shared/src/types.ts";
import type { VoteChoice } from "../../shared/src/voting.ts";
import { getAccountByClientId } from "./accounts.ts";
import { getCurrentPlayback } from "./playback.ts";
import { PresenceStore } from "./presence.ts";
import { ProposalManager } from "./proposals.ts";
import { listQueue } from "./queue.ts";
import { joinRoom, RoomClosedError, RoomFullError, RoomNotFoundError } from "./rooms.ts";

interface SocketData {
  accountId: string;
  clientId: string;
  displayName: string;
  roomId: string | null;
}

export interface AttachRealtimeOptions {
  // Overrides the voting engine's 15-second default. Test-only seam (set by
  // the server, never by a client) so integration tests can exercise a full
  // propose→vote→resolve cycle without a real 15-second wait.
  votingWindowMs?: number;
}

export interface RealtimeHandles {
  presence: PresenceStore;
  // Exposed so a test can call proposals.dispose() to cancel any pending
  // resolution timers before closing its scratch database — production code
  // (index.ts) has no need to touch this directly.
  proposals: ProposalManager;
}

// Wires Socket.IO into the app: identifies each connection against an
// already-registered account (never trusting a bare claimed accountId — see
// CLAUDE.md's Authority section), then tracks room presence and relays
// real-time room events.
export function attachRealtime(io: Server, db: DatabaseSync, options: AttachRealtimeOptions = {}): RealtimeHandles {
  const presence = new PresenceStore();
  const proposals = new ProposalManager();

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
        activeProposal: proposals.getActiveProposal(roomId),
        playback: getCurrentPlayback(db, roomId),
      };
      socket.emit("room:snapshot", snapshot);

      if (becamePresent) {
        socket.to(roomId).emit("presence:join", { accountId: data.accountId, displayName: data.displayName });
      }
    });

    // Requests a PLAY, PAUSE, SKIP, SEEK, REMOVE_QUEUE_ITEM or REORDER_QUEUE
    // proposal — the client never sets playback status or mutates the queue
    // directly (CLAUDE.md's Authority section). ProposalManager enforces one
    // active proposal per room, rejects a redundant Play-while-playing/
    // Pause-while-paused/remove-the-current-track/no-op-reorder/no-tokens-
    // left request up front, and owns the real 15-second timer that resolves
    // the vote server-side.
    socket.on(
      "proposal:request",
      (payload: { type?: unknown; positionMs?: unknown; queueItemId?: unknown; beforeQueueItemId?: unknown }) => {
        if (!data.roomId) {
          socket.emit("proposal:requestError", { error: "join a room before requesting a vote" });
          return;
        }
        const type = payload?.type;
        if (
          type !== "PLAY" &&
          type !== "PAUSE" &&
          type !== "SKIP" &&
          type !== "SEEK" &&
          type !== "REMOVE_QUEUE_ITEM" &&
          type !== "REORDER_QUEUE"
        ) {
          socket.emit("proposal:requestError", { error: "unsupported proposal type" });
          return;
        }
        const positionMs = typeof payload?.positionMs === "number" ? payload.positionMs : undefined;
        const queueItemId = typeof payload?.queueItemId === "string" ? payload.queueItemId : undefined;
        // beforeQueueItemId is REORDER_QUEUE-only and three-way: a string
        // (move before that item), explicit null (move to the end of the
        // queue), or omitted entirely (any other proposal type, where it
        // must stay undefined rather than defaulting to null).
        const beforeQueueItemId =
          typeof payload?.beforeQueueItemId === "string"
            ? payload.beforeQueueItemId
            : payload?.beforeQueueItemId === null
              ? null
              : undefined;
        const result = proposals.requestPlaybackProposal(io, db, data.roomId, data.accountId, type, {
          votingWindowMs: options.votingWindowMs,
          positionMs,
          queueItemId,
          beforeQueueItemId,
        });
        if (!result.ok) {
          socket.emit("proposal:requestError", { error: result.error, code: result.code });
        }
      },
    );

    socket.on("proposal:vote", (payload: { proposalId?: unknown; choice?: unknown }) => {
      if (!data.roomId) {
        socket.emit("proposal:voteError", { error: "join a room before voting" });
        return;
      }
      const proposalId = typeof payload?.proposalId === "string" ? payload.proposalId : "";
      const choice = payload?.choice;
      if (!proposalId || (choice !== "YES" && choice !== "NO")) {
        socket.emit("proposal:voteError", { error: "proposalId and a YES/NO choice are required" });
        return;
      }
      const result = proposals.castVote(io, data.roomId, proposalId, data.accountId, choice as VoteChoice);
      if (!result.ok) {
        socket.emit("proposal:voteError", { error: result.error });
      }
    });

    // A client reports its own player naturally reaching the end of a track
    // — never something the server polls for, since the server has no
    // player of its own. The reported playbackId is only ever a hint: it is
    // matched against the room's actual current playback before anything
    // happens (see ProposalManager.handleTrackEnded), so a stale report from
    // a client that's fallen behind (or several clients all reporting the
    // same real end) can never double-advance or affect the wrong track.
    socket.on("playback:ended", (payload: { playbackId?: unknown }) => {
      if (!data.roomId) return;
      const playbackId = typeof payload?.playbackId === "string" ? payload.playbackId : "";
      if (!playbackId) return;
      proposals.handleTrackEnded(io, db, data.roomId, playbackId);
    });

    socket.on("disconnect", () => {
      // A participant disconnecting mid-vote is not special-cased: they
      // simply stop being reachable for future ballots, exactly like anyone
      // who never voted at all — their vote remains an ABSTAIN and the
      // proposal still resolves on schedule from whoever did vote.
      leaveCurrentRoom(io, socket, data);
    });
  });

  return { presence, proposals };
}
