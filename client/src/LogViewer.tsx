import { useEffect, useState } from "react";
import type { LogEventView } from "../../shared/src/types.ts";
import { describeLogEvent, relativeLogTime } from "./logViewerFormat.ts";

export interface LogViewerProps {
  events: LogEventView[] | "error" | null;
  loading: boolean;
  onRefresh: () => void;
}

// A readable, newest-first rendering of a room's recent activity feed
// (server/src/logging.ts's 20-minute retention window) — used by the
// landing-page "View activity log" viewer (App.tsx). Pure/presentational,
// same shape as RoomChat.tsx: data and callbacks in, no socket/fetch of its
// own.
export function LogViewer({ events, loading, onRefresh }: LogViewerProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="log-viewer">
      <div className="log-viewer-heading">
        <h3>📋 Activity log</h3>
        <button type="button" className="btn btn--sm" onClick={onRefresh} disabled={loading}>
          🔄 Refresh
        </button>
      </div>
      {loading && <p>Loading…</p>}
      {events === "error" && <p role="alert">couldn't load this room's activity log</p>}
      {Array.isArray(events) && events.length === 0 && <p>no activity in the last 20 minutes</p>}
      {Array.isArray(events) && events.length > 0 && (
        <ul className="log-viewer-list">
          {events.map((event, index) => (
            <li key={index} className="log-viewer-row">
              <span className="log-viewer-text">{describeLogEvent(event)}</span>
              <time dateTime={event.timestamp} title={new Date(event.timestamp).toLocaleString()}>
                {relativeLogTime(event.timestamp, now)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
