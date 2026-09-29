import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Server } from "socket.io";
import { REACTION_EMOJIS, type Reaction, type ReactionEmoji } from "../../shared/src/types.ts";

export function isReactionEmoji(value: unknown): value is ReactionEmoji {
  return typeof value === "string" && (REACTION_EMOJIS as readonly string[]).includes(value);
}

const REACTION_COLUMNS = "reactionId, roomId, videoId, playbackId, accountId, displayName, reaction, positionMs, createdAt";

export interface RecordReactionParams {
  roomId: string;
  videoId: string;
  playbackId: string;
  accountId: string;
  displayName: string;
  reaction: ReactionEmoji;
  // Always the server-computed expected position at nowMs (see
  // shared/src/playbackSync.ts's computeExpectedPositionMs) — never a
  // client-claimed value (CLAUDE.md's Authority section).
  positionMs: number;
  nowMs: number;
}

// Persists a single reaction. Never requires voting, never overwrites an
// existing row (every reaction is its own permanent record) — see
// CLAUDE.md's Reactions and Voting sections.
export function recordReaction(db: DatabaseSync, params: RecordReactionParams): Reaction {
  const reactionId = randomUUID();
  const createdAt = new Date(params.nowMs).toISOString();

  db.prepare(`INSERT INTO reactions (${REACTION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    reactionId,
    params.roomId,
    params.videoId,
    params.playbackId,
    params.accountId,
    params.displayName,
    params.reaction,
    params.positionMs,
    createdAt,
  );

  return {
    reactionId,
    roomId: params.roomId,
    videoId: params.videoId,
    playbackId: params.playbackId,
    accountId: params.accountId,
    displayName: params.displayName,
    reaction: params.reaction,
    positionMs: params.positionMs,
    createdAt,
  };
}

// Every reaction ever recorded against this (roomId, videoId), ordered by
// where in the track it happened — deliberately NOT filtered by playbackId
// (see the comment on the reactions table in server/src/db.ts): a video
// restarting under a new playbackId is exactly the "same video plays again"
// case CLAUDE.md's Reactions section describes, and must still surface prior
// reactions near their original position.
export function listReactionsForVideo(db: DatabaseSync, roomId: string, videoId: string): Reaction[] {
  const rows = db
    .prepare(
      `SELECT ${REACTION_COLUMNS} FROM reactions WHERE roomId = ? AND videoId = ? ORDER BY positionMs ASC, createdAt ASC`,
    )
    .all(roomId, videoId);
  return rows.map((row) => row as unknown as Reaction);
}

// Pushes the full historical reaction list for whatever video is now
// current to everyone in the room. Called only at a genuine track transition
// (a fresh ensureCurrentTrack/advanceToNextTrack success) — never on every
// PLAY/PAUSE/SEEK broadcast, since those never change the video and a client
// already has that video's history cached from the last transition.
export function broadcastReactionHistory(io: Server, db: DatabaseSync, roomId: string, videoId: string): void {
  io.to(roomId).emit("reactions:history", { videoId, reactions: listReactionsForVideo(db, roomId, videoId) });
}
