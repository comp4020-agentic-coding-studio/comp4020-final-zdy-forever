import type { LogEventView } from "../../shared/src/types.ts";

// Plain-language, non-jargon line for one logged action, rendered instead of
// raw JSON. `who` is the decorated accountDisplayName (never the raw
// accountId — see LogEventView's own doc comment for why that's the only
// safe per-user label). Never includes message text (CHAT_SEND never carries
// it in the first place — see server/src/logging.ts) or anything the server
// doesn't already consider safe to show. An action this switch doesn't
// recognize (a future addition to LOG_ACTIONS) falls back to a generic line
// rather than crashing.
export function describeLogEvent(event: LogEventView): string {
  const who = event.accountDisplayName ?? "someone";
  switch (event.action) {
    case "ROOM_CREATE":
      return `🎉 ${who} created the room`;
    case "ROOM_JOIN":
      return event.result === "ok" ? `🚪 ${who} joined the room` : `🚫 ${who} tried to join and was turned away (${event.result})`;
    case "ROOM_LEAVE":
      return `🚶 ${who} left the room`;
    case "RECONNECT":
      return `🔄 ${who} reconnected`;
    case "TRACK_ADD":
      return event.result === "ok" ? `➕ ${who} added a track to the queue` : `⚠️ ${who} tried adding a track (${event.result})`;
    case "PROPOSAL_CREATE":
      return `🗳️ ${who} started a ${event.detail ?? "vote"}`;
    case "VOTE_CAST":
      return `☑️ ${who} voted ${event.detail ?? ""}`.trim();
    case "PROPOSAL_PASS":
      return event.detail ? `✅ a ${event.detail} vote passed` : "✅ a vote passed";
    case "PROPOSAL_FAIL":
      return event.detail ? `❌ a ${event.detail} vote failed` : "❌ a vote failed";
    case "PROPOSAL_CANCEL":
      return `🛑 ${who} cancelled their vote`;
    case "PLAYBACK_CHANGE":
      return `▶️ playback changed (${event.detail ?? "updated"})`;
    case "QUEUE_REMOVE":
      return "🗑️ a track was removed from the queue";
    case "QUEUE_REORDER":
      return "↕️ the queue was reordered";
    case "CHAT_SEND":
      return `💬 ${who} sent a message`;
    case "ROOM_AUTO_CLOSE":
      return "⏰ the room closed from inactivity";
    default:
      return `• ${event.action as string}`;
  }
}

// Pure (caller supplies nowMs), same style as shared/src/voting.ts — trivially
// testable without fake timers.
export function relativeLogTime(iso: string, nowMs: number): string {
  const diffSec = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  return `${Math.round(diffMin / 60)}h ago`;
}
