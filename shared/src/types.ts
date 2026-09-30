// Domain types shared between client/ and server/. Type-only exports are
// elided at compile time (see verbatimModuleSyntax in each package's
// tsconfig), so importing this file from either side has no runtime cost
// and no build-ordering requirement.

import type { Proposal } from "./voting.ts";

export interface HealthResponse {
  status: "ok";
  uptime: number;
}

// accountId is the permanent server identity; displayName is user-facing and
// may duplicate across accounts. clientId (browser/device identity) is not
// part of the account's public shape — it's only used server-side to look an
// account back up.
export interface Account {
  accountId: string;
  displayName: string;
  createdAt: string;
}

export interface RegisterRequest {
  clientId: string;
  displayName: string;
}

export type RoomVisibility = "PUBLIC" | "PRIVATE";

// code is only set for PRIVATE rooms, and is only ever returned to the
// creator here — there's no room listing yet, and when one exists it must
// never include a PRIVATE room or its code to anyone but its members.
// maxUsers is fixed by course spec (not creator-configurable).
export interface Room {
  roomId: string;
  name: string;
  creatorAccountId: string;
  visibility: RoomVisibility;
  code: string | null;
  maxUsers: number;
  autoCloseEnabled: boolean;
  createdAt: string;
  lastMeaningfulActivityAt: string;
  closed: boolean;
}

export interface CreateRoomRequest {
  accountId: string;
  name: string;
  visibility: RoomVisibility;
  autoCloseEnabled: boolean;
}

// The public lobby only ever lists PUBLIC, open rooms — never a PRIVATE
// room, and never its code.
export interface LobbyRoom {
  roomId: string;
  name: string;
  occupancy: number;
  capacity: number;
  joinable: boolean;
}

// occupancy is how many people are in the room right now (live presence),
// the same number the 12-user maximum is enforced against.
export interface JoinRoomResult {
  room: Room;
  occupancy: number;
}

// What a single-video metadata lookup returns (YouTube's oEmbed endpoint —
// see server/src/youtube.ts): the video's details, whether it can actually be
// embedded elsewhere, and its length if known. oEmbed never reports one, so
// it's null for every newly added track; only items queued back when lengths
// were looked up still carry one.
export interface YoutubeVideoMetadata {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
  embeddable: boolean;
  durationMs?: number | null;
}

// queueItemId is this item's permanent identity — never its position in the
// returned array, which is only ever a display order. Metadata is always the
// server's own canonical lookup, never whatever the client claimed.
export interface QueueItem {
  queueItemId: string;
  roomId: string;
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
  // The track's length as the server looked it up when it was added, or null
  // if unknown — which, with lengths no longer available from YouTube (see
  // YoutubeVideoMetadata), is every newly added track.
  durationMs: number | null;
  addedBy: string;
  addedAt: string;
}

// input may be a pasted YouTube URL or a bare videoId — the server treats
// both identically and re-resolves/re-validates independently either way.
export interface AddTrackRequest {
  accountId: string;
  input: string;
}

// Presence is ephemeral (never persisted): identity here is always
// accountId, deduplicated across that account's simultaneous sockets (e.g.
// duplicate browser tabs), so one account only ever appears once regardless
// of how many connections it holds. displayName is carried along purely for
// display — never usable as identity, and may collide across accounts.
export interface PresenceEntry {
  accountId: string;
  displayName: string;
}

// Handed to a socket right after it (re)joins a room — the authoritative
// state at that moment: durable room config and queue, plus who's currently
// present. A client's own locally-held state is never trusted over this.
// activeProposal is included so a late joiner or a reconnecting client sees
// an in-flight vote immediately, rather than only on its next proposal:update.
export interface RoomSnapshot {
  room: Room;
  queue: QueueItem[];
  presence: PresenceEntry[];
  activeProposal: Proposal | null;
  playback: PlaybackState | null;
  // Every reaction ever recorded against the currently-playing video in this
  // room (empty array if nothing is playing) — seeded here so a late joiner
  // or reconnecting client can immediately start matching historical echoes
  // against local playback position, same as reactions:history on a later
  // track transition (see CLAUDE.md's Reactions section).
  reactionHistory: Reaction[];
}

// Client -> server socket payload for joining/rejoining a room. accountId
// and clientId are established once at connection time (socket auth), never
// resent per-event.
export interface RoomJoinPayload {
  roomId: string;
}

export type PlaybackStatus = "PLAYING" | "PAUSED";

// The currently-playing queue item, plus the server-authoritative anchor a
// client uses to calculate expected playback position (see
// shared/src/playbackSync.ts) instead of the server ever broadcasting
// currentTime continuously.
//
// playbackId identifies this particular "now playing" instance — it changes
// only on a track transition, even if the same queueItemId were ever to play
// again. revision identifies this particular playback *control* state
// (play/pause/seek) and advances on every anchor rebase, including within
// the same track and across a server restart — it never resets. A proposal
// (future voting layer) must reference both {playbackId, revision} at the
// moment it's opened; if either has changed by the time it would execute,
// the proposal is stale and must be rejected, never partially applied.
//
// dj is always the account that originally added this queue item — looked
// up live, never cached — so the DJ role belongs to the track, not
// permanently to the room, and is unaffected by that account's connection
// state.
export interface PlaybackState {
  playbackId: string;
  queueItemId: string;
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
  // Copied from the queue item; what a reported track end is checked
  // against (see shared/src/playbackSync.ts's isPlausibleTrackEnd).
  durationMs: number | null;
  startedAt: string;
  status: PlaybackStatus;
  anchorPositionMs: number;
  anchorServerTimeMs: number;
  revision: number;
  dj: { accountId: string; displayName: string };
}

// Handed back by GET .../playback: what's playing now (or null if nothing
// is), and what would play next — a read-only display snapshot.
export interface RoomPlaybackSnapshot {
  current: PlaybackState | null;
  next: QueueItem | null;
}

// The small fixed reaction set (CLAUDE.md's Reactions section) — deliberately
// closed, never free-text (that would be text chat, which CLAUDE.md
// explicitly forbids).
export const REACTION_EMOJIS = ["❤️", "🔥", "😭", "✨"] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

// A single stored reaction: the fact that `accountId` reacted with `reaction`
// at `positionMs` into `videoId`, in `roomId`, at `createdAt`. Reactions never
// require voting (CLAUDE.md's Voting section). positionMs is always the
// server-computed expected position at the moment it was sent (see
// shared/src/playbackSync.ts's computeExpectedPositionMs) — a client never
// gets to claim its own position. playbackId is carried along for
// reference/debugging only: matching for historical replay is deliberately
// by (roomId, videoId) alone, never playbackId, since a video restarting
// under a brand new playbackId is exactly the "same video plays again" case a
// historical echo must still cover.
export interface Reaction {
  reactionId: string;
  roomId: string;
  videoId: string;
  playbackId: string;
  accountId: string;
  displayName: string;
  reaction: ReactionEmoji;
  positionMs: number;
  createdAt: string;
}

// Distinguishes a reaction's live broadcast from a later historical replay at
// the wire level — this distinction is deliberately never stored in the
// database row itself (see server/src/db.ts's reactions table): a stored
// Reaction is always just "the fact of a live moment," and ECHO is purely a
// redelivery/replay interpretation of that same fact when the same video
// plays again, never a second persisted entity.
export type ReactionEvent =
  | { kind: "LIVE"; reaction: Reaction }
  | { kind: "ECHO"; reaction: Reaction };

// One account's reorder-token balance in one room (see CLAUDE.md's Reorder
// section and shared/src/reorderTokens.ts). Always server-computed from a
// persisted (tokens, anchorMs) pair plus the current clock — a client never
// tracks or claims its own balance. nextRegenAt is when the next +1 tick
// arrives, or null once already at maxTokens (there is nothing to wait for).
export interface ReorderTokenBalance {
  roomId: string;
  accountId: string;
  tokens: number;
  maxTokens: number;
  nextRegenAt: string | null;
}
