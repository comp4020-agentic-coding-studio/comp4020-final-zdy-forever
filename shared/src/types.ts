// Domain types shared between client/ and server/. Type-only exports are
// elided at compile time (see verbatimModuleSyntax in each package's
// tsconfig), so importing this file from either side has no runtime cost
// and no build-ordering requirement.

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

export interface JoinRoomResult {
  room: Room;
  occupancy: number;
}

// Shape returned by both search and the demo-songs list.
export interface YoutubeSearchResult {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
}

// The fuller record returned by a single-video metadata lookup, which also
// carries whether the video can actually be embedded elsewhere.
export interface YoutubeVideoMetadata extends YoutubeSearchResult {
  embeddable: boolean;
}
