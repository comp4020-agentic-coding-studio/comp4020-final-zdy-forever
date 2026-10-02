import type { Room } from "../../shared/src/types.ts";

// The token that gets someone else into this room: a PRIVATE room's 6-digit
// code, a PUBLIC room's 7-digit number — whichever the room actually has
// (see shared/src/types.ts's Room doc comment for why the two never clash).
function roomToken(room: Room): string | null {
  return room.visibility === "PRIVATE" ? room.code : room.roomNumber;
}

export interface ShareContent {
  text: string;
  url: string;
}

// Opening the link joins the room automatically (see App.tsx's effect
// reading `join` on mount) — a first-time visitor registers a name first,
// then joins the moment they do; a returning one joins as soon as their
// account restores. Knowing the token at all is already everything joining
// by hand requires, for a PRIVATE room exactly as much as typing its code in
// would be, so auto-joining from it gives away nothing a manual join
// wouldn't.
export function buildShareContent(room: Room): ShareContent | null {
  const token = roomToken(room);
  if (!token) return null;
  const url = new URL(window.location.href);
  url.search = `?join=${token}`;
  url.hash = "";
  return {
    text: `Come listen along in "${room.name}"! Room ${room.visibility === "PRIVATE" ? "code" : "number"}: ${token}`,
    url: url.toString(),
  };
}

export type ShareOutcome = "shared" | "copied" | "failed";

// Prefers the native share sheet (mobile); falls back to the clipboard
// (desktop, or wherever navigator.share isn't available). A user dismissing
// the native share sheet also rejects navigator.share's promise, so that's
// treated the same as "failed" rather than retried as a copy — retrying
// would paste something onto their clipboard they never asked to copy.
export async function shareRoom(room: Room): Promise<ShareOutcome> {
  const content = buildShareContent(room);
  if (!content) return "failed";

  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ title: "Watch YouTube Together", text: content.text, url: content.url });
      return "shared";
    } catch {
      return "failed";
    }
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(`${content.text} ${content.url}`);
      return "copied";
    } catch {
      return "failed";
    }
  }

  return "failed";
}
