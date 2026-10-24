import type { DatabaseSync } from "node:sqlite";
import type { Server, Socket } from "socket.io";
import {
  CHAT_MAX_LENGTH,
  PING_SIGNALS,
  type ChatSendResult,
  type PingBroadcast,
  type PingSignal,
  type RoomJoinPayload,
  type RoomSnapshot,
} from "../../shared/src/types.ts";
import type { VoteChoice } from "../../shared/src/voting.ts";
import { getAccountByClientId } from "./accounts.ts";
import { logAction } from "./logging.ts";
import { getCurrentPlayback } from "./playback.ts";
import { PresenceStore } from "./presence.ts";
import { DjHandoffManager } from "./djHandoff.ts";
import { PingRateLimiter } from "./pingRateLimit.ts";
import { ProposalManager } from "./proposals.ts";
import { listQueue } from "./queue.ts";
import { ChatRateLimiter, listChatMessages, normalizeChatText, recordChatMessage } from "./chat.ts";
import { getRoomById, isRoomMember, joinRoom, sweepInactiveRooms } from "./rooms.ts";

type JoinErrorReason = "room-not-found" | "room-closed" | "room-full";

const ROOM_CLOSED_MESSAGE = "that room has closed";

const JOIN_ERROR_MESSAGES: Record<JoinErrorReason, string> = {
  "room-not-found": "that room doesn't exist",
  "room-closed": ROOM_CLOSED_MESSAGE,
  "room-full": "that room is full (12 people max)",
};

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
  // How often occupied rooms are checked for having auto-closed (see
  // evictIfClosed); 0 turns the periodic check off. Test-only seam.
  closureCheckIntervalMs?: number;
}

// Often enough that nobody sits in a room for long after it has closed; the
// check itself is a timestamp comparison per occupied room (rooms.ts), never
// counted as activity.
const CLOSURE_CHECK_INTERVAL_MS = 60_000;

export interface RealtimeHandles {
  presence: PresenceStore;
  // Exposed so a test can call proposals.dispose() to cancel any pending
  // resolution timers before closing its scratch database — production code
  // (index.ts) has no need to touch this directly.
  proposals: ProposalManager;
  // Runs the periodic closure check once, now. Exposed for tests.
  checkClosedRooms: () => void;
  // Lets everyone go from a room found closed (see evictIfClosed below) —
  // for a REST handler that notices the closure first.
  evictIfClosed: (roomId: string) => boolean;
}

// Wraps one socket event handler so an unexpected error (a DB write failure,
// a full disk, ...) fails only that event — reported back to this socket via
// `reportError` when the event has an error channel — and never the whole
// process. socket.io invokes handlers from a process.nextTick callback, so an
// uncaught throw there is an uncaught exception that takes down every room
// (CLAUDE.md's Reliability section).
function guarded<P>(event: string, reportError: ((error: string) => void) | null, handler: (payload: P) => void) {
  return (payload: P) => {
    try {
      handler(payload);
    } catch (err) {
      console.error(`unexpected error handling ${event}:`, err);
      reportError?.("internal server error");
    }
  };
}

// Wires Socket.IO into the app: identifies each connection against an
// already-registered account (never trusting a bare claimed accountId — see
// CLAUDE.md's Authority section), then tracks room presence and relays
// real-time room events.
export function attachRealtime(io: Server, db: DatabaseSync, options: AttachRealtimeOptions = {}): RealtimeHandles {
  const presence = new PresenceStore();
  const proposals = new ProposalManager((roomId) => presence.list(roomId).map((person) => person.accountId));
  const chatLimiter = new ChatRateLimiter();
  const pingLimiter = new PingRateLimiter();
  const handoffs = new DjHandoffManager(db, presence, (roomId, playback) => io.to(roomId).emit("playback:update", playback));
  const handoffSweep = setInterval(guarded("DJ presence check", null, () => {
    for (const roomId of presence.roomIds()) handoffs.reconcile(roomId);
  }), 1_000);
  handoffSweep.unref();
  io.httpServer?.once("close", () => { clearInterval(handoffSweep); handoffs.dispose(); });

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
    let account;
    try {
      account = getAccountByClientId(db, clientId);
    } catch (err) {
      console.error("unexpected error authenticating a socket:", err);
      next(new Error("internal server error"));
      return;
    }
    if (!account || account.accountId !== accountId) {
      next(new Error("accountId does not match a registered account for this clientId"));
      return;
    }

    const data: SocketData = { accountId, clientId, displayName: account.displayName, roomId: null };
    socket.data = data;
    next();
  });

  function leaveCurrentRoom(io: Server, socket: Socket, data: SocketData, reconcile = true): void {
    const roomId = data.roomId;
    if (!roomId) return;

    socket.leave(roomId);
    data.roomId = null;

    const result = presence.leave(roomId, socket.id);
    if (result?.becameAbsent) {
      io.to(roomId).emit("presence:leave", { accountId: result.accountId });
      logAction(db, { action: "ROOM_LEAVE", result: "ok", roomId, accountId: result.accountId });
    }
    if (reconcile) {
      handoffs.reconcile(roomId);
      // A departure can turn "not everyone present has voted yet" into
      // "yes, now they have" — most notably once a ghost connection presence
      // hadn't yet pruned finally drops, leaving a genuine sole listener (see
      // ProposalManager.reconcilePresence, docs/adr/0010).
      proposals.reconcilePresence(io, db, roomId);
    }
  }

  // A room auto-closes once 7 days pass with no meaningful activity,
  // decided from its stored timestamp whenever something reads it (see
  // rooms.ts's sweep). People can still be in it then — just listening isn't
  // activity — and they used to stay, still voting and chatting in a room
  // that no longer existed for anyone else. So once it's found closed,
  // everyone in it is told (room:closed) and let go, and any open vote fails.
  // True if the room is closed (everyone now evicted), false if still open.
  function evictIfClosed(roomId: string): boolean {
    const room = getRoomById(db, roomId);
    if (room && !room.closed) return false;

    proposals.closeRoom(io, roomId);
    handoffs.clear(roomId);
    chatLimiter.clearRoom(roomId);
    pingLimiter.clearRoom(roomId);
    io.to(roomId).emit("room:closed", { roomId });
    for (const socketId of presence.socketIdsIn(roomId)) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) leaveCurrentRoom(io, socket, socket.data as SocketData);
    }
    return true;
  }

  // Catches the room nobody touches — a closed room with nobody acting in it
  // would otherwise only be noticed on its members' next action.
  const checkClosedRooms = () => {
    sweepInactiveRooms(db, Date.now());
    for (const roomId of presence.roomIds()) evictIfClosed(roomId);
  };
  checkClosedRooms(); // Also purge expired rooms after a server restart.
  const closureCheckMs = options.closureCheckIntervalMs ?? CLOSURE_CHECK_INTERVAL_MS;
  if (closureCheckMs > 0) {
    const timer = setInterval(guarded("closure check", null, checkClosedRooms), closureCheckMs);
    timer.unref();
    io.httpServer?.once("close", () => clearInterval(timer));
  }

  io.on("connection", (socket: Socket) => {
    const data = socket.data as SocketData;
    const reportTo = (event: string) => (error: string) => socket.emit(event, { error });

    socket.on("room:join", guarded("room:join", reportTo("room:joinError"), (payload: Partial<RoomJoinPayload>) => {
      const roomId = typeof payload?.roomId === "string" ? payload.roomId : "";
      if (!roomId) {
        socket.emit("room:joinError", { error: "roomId is required" });
        return;
      }

      if (data.roomId && data.roomId !== roomId) {
        leaveCurrentRoom(io, socket, data);
      }

      // A PRIVATE room only admits an account already recorded as its member
      // (its creator, or someone who joined with its code via POST
      // /api/rooms/join-by-code); anyone else gets the same answer as for a
      // room that doesn't exist, so a bare roomId can't get in or even
      // confirm the room is there. Capacity is live presence, deduplicated
      // across one account's tabs. Every check here and presence.join below
      // run in one synchronous turn with no await, so two sockets racing for
      // the last place can never both get it.
      const found = getRoomById(db, roomId);
      const reason: JoinErrorReason | null =
        !found || (found.visibility === "PRIVATE" && !isRoomMember(db, roomId, data.accountId))
          ? "room-not-found"
          : found.closed
            ? "room-closed"
            : !presence.canAdmit(roomId, data.accountId, found.maxUsers)
              ? "room-full"
              : null;
      if (reason) {
        logAction(db, { action: "ROOM_JOIN", result: reason, roomId, accountId: data.accountId });
        socket.emit("room:joinError", { error: JOIN_ERROR_MESSAGES[reason], code: reason });
        return;
      }
      const room = joinRoom(db, roomId, data.accountId);

      // Every DB read the snapshot needs happens before this socket is
      // registered anywhere in memory, so a failure up to this point (see
      // guarded) leaves it not half-joined: never present without a snapshot.
      const playback = getCurrentPlayback(db, roomId);
      const queue = listQueue(db, roomId);
      const chatMessages = listChatMessages(db, roomId);

      socket.join(roomId);
      data.roomId = roomId;

      const { becamePresent, returning } = presence.join(roomId, socket.id, {
        accountId: data.accountId,
        displayName: data.displayName,
      });
      // A returning account (this process has already seen it present in
      // this room before) is logged as RECONNECT rather than ROOM_JOIN — see
      // PresenceStore.join's doc comment for why this also covers a late
      // join, not only a true post-disconnect reconnect.
      logAction(db, { action: returning ? "RECONNECT" : "ROOM_JOIN", result: "ok", roomId, accountId: data.accountId });

      const snapshot: RoomSnapshot = {
        room,
        queue,
        presence: presence.list(roomId),
        activeProposal: proposals.getActiveProposal(roomId),
        playback,
        chatMessages,
      };
      socket.emit("room:snapshot", snapshot);

      if (becamePresent) {
        socket.to(roomId).emit("presence:join", { accountId: data.accountId, displayName: data.displayName });
      }
      handoffs.reconcile(roomId);
    }));

    socket.on("room:leave", guarded("room:leave", reportTo("room:leaveError"), () => {
      const roomId = data.roomId;
      if (!roomId || evictIfClosed(roomId)) return;
      const handoff = handoffs.requestLeave(roomId, data.accountId, () => {
        if (data.roomId === roomId) leaveCurrentRoom(io, socket, data, false);
        socket.emit("room:left", { roomId });
      });
      if (handoff) socket.emit("dj:handoff", handoff);
    }));

    socket.on("dj:choose", guarded("dj:choose", reportTo("room:leaveError"), (payload: { requestId?: unknown; accountId?: unknown }) => {
      if (!data.roomId || evictIfClosed(data.roomId)) return;
      if (typeof payload?.requestId !== "string" || typeof payload?.accountId !== "string" ||
          !handoffs.choose(data.roomId, data.accountId, payload.requestId, payload.accountId)) {
        socket.emit("room:leaveError", { error: "That member is no longer available. Choose another member or wait for automatic assignment." });
      }
    }));

    // Requests a PLAY, PAUSE, SKIP, SEEK, REMOVE_QUEUE_ITEM or REORDER_QUEUE
    // proposal — the client never sets playback status or mutates the queue
    // directly (CLAUDE.md's Authority section). ProposalManager enforces one
    // active proposal per room, rejects a redundant Play-while-playing/
    // Pause-while-paused/remove-the-current-track/no-op-reorder/no-tokens-
    // left request up front, and owns the real 15-second timer that resolves
    // the vote server-side.
    socket.on(
      "proposal:request",
      guarded("proposal:request", reportTo("proposal:requestError"), (payload: {
        type?: unknown;
        positionMs?: unknown;
        queueItemId?: unknown;
        beforeQueueItemId?: unknown;
      }) => {
        if (!data.roomId) {
          socket.emit("proposal:requestError", { error: "join a room before requesting a vote" });
          return;
        }
        if (evictIfClosed(data.roomId)) {
          socket.emit("proposal:requestError", { error: ROOM_CLOSED_MESSAGE });
          return;
        }
        const type = payload?.type;
        if (
          type !== "PLAY" &&
          type !== "PAUSE" &&
          type !== "SKIP" &&
          type !== "SEEK" &&
          type !== "REMOVE_QUEUE_ITEM" &&
          type !== "REORDER_QUEUE" &&
          type !== "REPLAY_QUEUE_ITEM"
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
          presentCount: presence.count(data.roomId),
        });
        if (!result.ok) {
          socket.emit("proposal:requestError", { error: result.error, code: result.code });
        }
      }),
    );

    socket.on("proposal:vote", guarded("proposal:vote", reportTo("proposal:voteError"), (payload: { proposalId?: unknown; choice?: unknown }) => {
      if (!data.roomId) {
        socket.emit("proposal:voteError", { error: "join a room before voting" });
        return;
      }
      if (evictIfClosed(data.roomId)) {
        socket.emit("proposal:voteError", { error: ROOM_CLOSED_MESSAGE });
        return;
      }
      const proposalId = typeof payload?.proposalId === "string" ? payload.proposalId : "";
      const choice = payload?.choice;
      if (!proposalId || (choice !== "YES" && choice !== "NO")) {
        socket.emit("proposal:voteError", { error: "proposalId and a YES/NO choice are required" });
        return;
      }
      const result = proposals.castVote(io, db, data.roomId, proposalId, data.accountId, choice as VoteChoice);
      if (!result.ok) {
        socket.emit("proposal:voteError", { error: result.error });
      }
    }));

    // Only the proposer may withdraw their own open proposal — anyone else's
    // request is rejected by ProposalManager.cancelProposal itself, not just
    // hidden client-side.
    socket.on("proposal:cancel", guarded("proposal:cancel", reportTo("proposal:cancelError"), (payload: { proposalId?: unknown }) => {
      if (!data.roomId) {
        socket.emit("proposal:cancelError", { error: "join a room before cancelling a vote" });
        return;
      }
      if (evictIfClosed(data.roomId)) {
        socket.emit("proposal:cancelError", { error: ROOM_CLOSED_MESSAGE });
        return;
      }
      const proposalId = typeof payload?.proposalId === "string" ? payload.proposalId : "";
      const active = proposals.getActiveProposal(data.roomId);
      if (!proposalId || !active || active.proposalId !== proposalId) {
        socket.emit("proposal:cancelError", { error: "no matching active proposal in this room" });
        return;
      }
      const result = proposals.cancelProposal(io, db, data.roomId, data.accountId);
      if (!result.ok) {
        socket.emit("proposal:cancelError", { error: result.error });
      }
    }));

    // A client reports its own player naturally reaching the end of a track
    // — never something the server polls for, since the server has no
    // player of its own. The reported playbackId is only ever a hint: it is
    // matched against the room's actual current playback before anything
    // happens (see ProposalManager.handleTrackEnded), so a stale report from
    // a client that's fallen behind (or several clients all reporting the
    // same real end) can never double-advance or affect the wrong track.
    socket.on("playback:ended", guarded("playback:ended", null, (payload: { playbackId?: unknown }) => {
      if (!data.roomId || evictIfClosed(data.roomId)) return;
      const playbackId = typeof payload?.playbackId === "string" ? payload.playbackId : "";
      if (!playbackId) return;
      proposals.handleTrackEnded(io, db, data.roomId, playbackId, {
        accountId: data.accountId,
        presentCount: presence.count(data.roomId),
      });
    }));

    // Chat is available with or without a playing track. The authenticated
    // socket's current room and account are the only accepted identities.
    socket.on("chat:send", (payload: { text?: unknown }, acknowledge: unknown) => {
      const reply = (result: ChatSendResult) => {
        if (typeof acknowledge === "function") acknowledge(result);
      };
      const fail = (error: string) => {
        socket.emit("chat:sendError", { error });
        reply({ ok: false, error });
      };
      guarded("chat:send", fail, (input: { text?: unknown }) => {
        if (!data.roomId) return fail("join a room before chatting");
        if (evictIfClosed(data.roomId)) return fail(ROOM_CLOSED_MESSAGE);
        const text = normalizeChatText(input?.text);
        if (text === null) return fail(`messages must contain 1–${CHAT_MAX_LENGTH} characters`);
        const nowMs = Date.now();
        if (!chatLimiter.tryConsume(data.roomId, data.accountId, nowMs)) {
          return fail("slow down — too many messages");
        }
        const message = recordChatMessage(db, data.roomId, data.accountId, text, nowMs);
        io.to(data.roomId).emit("chat:new", message);
        logAction(db, { action: "CHAT_SEND", result: "ok", roomId: data.roomId, accountId: data.accountId });
        reply({ ok: true });
      })(payload);
    });

    // Broadcasts a ping-wheel signal to everyone currently present — never
    // persisted, never logged (not one of logging.ts's 15 LOG_ACTIONS; this
    // is cosmetic, not an auditable state change), and never meaningful
    // activity (no touchRoomActivity call — CLAUDE.md's activity list is
    // exhaustive and a cosmetic ping isn't on it, same reasoning as why
    // heartbeats don't count). See docs/adr/0013 for why this is not a
    // reopening of docs/adr/0006's removal of reactions.
    socket.on("ping:send", guarded("ping:send", reportTo("ping:sendError"), (payload: { signal?: unknown; xRatio?: unknown; yRatio?: unknown }) => {
      if (!data.roomId) {
        socket.emit("ping:sendError", { error: "join a room before sending a signal" });
        return;
      }
      if (evictIfClosed(data.roomId)) {
        socket.emit("ping:sendError", { error: ROOM_CLOSED_MESSAGE });
        return;
      }
      const signal = payload?.signal;
      if (typeof signal !== "string" || !(PING_SIGNALS as readonly string[]).includes(signal)) {
        socket.emit("ping:sendError", { error: "unsupported signal" });
        return;
      }
      // Viewport-relative position (0..1) the ping wheel was opened at —
      // never trusted beyond that range, clamped rather than rejected since
      // an out-of-range value only ever means it should show up at an edge.
      const clampRatio = (value: unknown) => Math.min(1, Math.max(0, typeof value === "number" && Number.isFinite(value) ? value : 0.5));
      const xRatio = clampRatio(payload?.xRatio);
      const yRatio = clampRatio(payload?.yRatio);
      if (!pingLimiter.tryConsume(data.roomId, data.accountId, Date.now())) {
        socket.emit("ping:sendError", { error: "slow down — too many signals" });
        return;
      }
      const broadcast: PingBroadcast = {
        accountId: data.accountId,
        displayName: data.displayName,
        signal: signal as PingSignal,
        xRatio,
        yRatio,
        sentAt: new Date().toISOString(),
      };
      io.to(data.roomId).emit("ping:new", broadcast);
    }));

    socket.on("disconnect", guarded("disconnect", null, () => {
      // A participant disconnecting mid-vote is not special-cased: they
      // simply stop being reachable for future ballots, exactly like anyone
      // who never voted at all — their vote remains an ABSTAIN and the
      // proposal still resolves on schedule from whoever did vote.
      leaveCurrentRoom(io, socket, data);
    }));
  });

  return { presence, proposals, checkClosedRooms, evictIfClosed };
}
