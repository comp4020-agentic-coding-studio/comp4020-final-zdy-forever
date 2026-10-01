import { useId, useState } from "react";

export function SeekControl({ onPropose }: { onPropose: (positionMs: number) => void }) {
  const [open, setOpen] = useState(false);
  const [time, setTime] = useState({ hours: "", minutes: "", seconds: "" });
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
          setError(null);
          onPropose(positionMs);
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
