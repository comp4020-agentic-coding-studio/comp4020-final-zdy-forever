import { useId, useState } from "react";

const BLANK_TIME = { hours: "", minutes: "", seconds: "" };

export function SeekControl({
  onPropose,
  getDurationMs = () => null,
}: {
  onPropose: (positionMs: number) => void;
  // Reads the *live* player's own getDuration() at the moment of proposing,
  // rather than a prop value: oEmbed (server/src/queue.ts) never reports a
  // track's length, so the room's stored durationMs is null for virtually
  // every track — the actual loaded YouTube player is the only thing that
  // really knows how long the video is. Returns null before the player
  // knows (not yet ready) or for a genuinely lengthless video (a live
  // stream) — there's nothing to validate against then, same as the
  // server-side check this mirrors (server/src/proposals.ts).
  getDurationMs?: () => number | null;
}) {
  const [open, setOpen] = useState(false);
  const [time, setTime] = useState(BLANK_TIME);
  const [error, setError] = useState<string | null>(null);
  const formId = useId();

  return (
    <div className={`seek-control${open ? " seek-control--open" : ""}`}>
      <button type="button" className="btn btn--purple seek-toggle"
        aria-expanded={open} aria-controls={formId} onClick={() => setOpen((value) => !value)}>
        ⏩ Propose Seek
      </button>
      {open && (
        <form id={formId} className="seek-form" onSubmit={(event) => {
          event.preventDefault();
          const hours = Number(time.hours);
          const minutes = Number(time.minutes);
          const seconds = Number(time.seconds);
          const positionMs = (hours * 3600 + minutes * 60 + seconds) * 1000;
          if (![hours, minutes, seconds, positionMs].every((value) => Number.isSafeInteger(value) && value >= 0)) {
            setError("Enter a valid time using whole numbers.");
            return;
          }
          const durationMs = getDurationMs();
          if (durationMs !== null && positionMs > durationMs) {
            // Past the end of the track: silently refuse, no message — the
            // fields are left as they are so the time is still there to fix.
            setError(null);
            return;
          }
          onPropose(positionMs);
          // Collapses straight back to the plain "Propose Seek" toggle —
          // its default, closed state — rather than sitting open with a
          // time that was already sent. The server resolving the vote
          // (pass or fail) never remounts this component, so nothing else
          // would reset it otherwise.
          setOpen(false);
          setTime(BLANK_TIME);
          setError(null);
        }}>
          <div className="seek-time-fields">
            {(["hours", "minutes", "seconds"] as const).map((unit) => (
              <label key={unit}>
                <span>{unit[0].toUpperCase() + unit.slice(1)}</span>
                <input type="number" inputMode="numeric" min="0" step="1" placeholder="00"
                  aria-label={`Seek ${unit}`} value={time[unit]}
                  onChange={(event) => setTime((previous) => ({ ...previous, [unit]: event.target.value }))}
                  onBlur={() => setTime((previous) => ({ ...previous, [unit]: previous[unit] ? previous[unit].padStart(2, "0") : "" }))} />
              </label>
            ))}
          </div>
          <button type="submit" className="btn btn--sm">Propose</button>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
    </div>
  );
}
