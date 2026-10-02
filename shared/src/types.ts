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

// code is only set for PRIVATE rooms (6 digits), and is only ever returned to
// the creator here — there's no room listing yet, and when one exists it must
// never include a PRIVATE room or its code to anyone but its members.
// roomNumber is the PUBLIC-room counterpart (7 digits, always one digit
// longer so a single "join by code or number" input can tell them apart
// purely by length — see server/src/index.ts's join-by-code handler): a
// quick-join shortcut so a crowded lobby never needs to be scrolled.
// maxUsers is fixed by course spec (not creator-configurable).
export interface Room {
  roomId: string;
  name: string;
  creatorAccountId: string;
  visibility: RoomVisibility;
  code: string | null;
  roomNumber: string | null;
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
  // Accepted for older clients only; rooms always auto-close after inactivity.
  autoCloseEnabled?: boolean;
}

// The public lobby only ever lists PUBLIC, open rooms — never a PRIVATE
// room, and never its code. roomNumber is public knowledge for a PUBLIC room
// (it's listed right here), unlike a PRIVATE room's code.
export interface LobbyRoom {
  roomId: string;
  name: string;
  roomNumber: string | null;
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
  chatMessages: ChatMessage[];
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
// DJ starts as the track's adder, with a persisted override when they leave.
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

// Plain-text, room-scoped messages. History exists only while the room is open.
export const CHAT_MAX_LENGTH = 500;

export interface ChatMessage {
  messageId: string;
  roomId: string;
  accountId: string;
  displayName: string;
  text: string;
  createdAt: string;
}

export type ChatSendResult = { ok: true } | { ok: false; error: string };

export interface DjHandoff {
  requestId: string;
  expiresAt: number;
}
