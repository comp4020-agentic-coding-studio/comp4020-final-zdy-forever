import { useEffect, useId, useRef, useState } from "react";
import { PING_SIGNALS, type PingSignal } from "../../shared/src/types.ts";
import { PING_META } from "./PingWheel.tsx";

// The ping wheel without Ctrl or a mouse: a visible button in the room bar
// that opens the same eight signals as ordinary buttons, so keyboard and
// touch users (a phone has no Ctrl key) can send them too. It calls the same
// onSendSignal as the wheel, so the server's rate limit and the broadcast
// are unchanged. The signal appears where this button sits, as a fraction of
// the viewport, the same rule the wheel follows for its anchor.
export function SignalMenu({ onSendSignal }: { onSendSignal: (signal: PingSignal, xRatio: number, yRatio: number) => void }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) setOpen(false);
    };
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissEscape);
    };
  }, [open]);

  const send = (signal: PingSignal) => {
    const rect = buttonRef.current?.getBoundingClientRect();
    const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const y = rect ? rect.bottom : window.innerHeight / 2;
    onSendSignal(signal, x / window.innerWidth, y / window.innerHeight);
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <div ref={containerRef} className="signal-menu" onBlur={(event) => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <button ref={buttonRef} type="button" className="chip signal-menu-toggle"
        aria-label="send a signal to the room (or hold Ctrl for the ping wheel)"
        aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
        📣
      </button>
      {open && (
        <div id={panelId} className="card card--accent-orange signal-menu-panel" role="group" aria-label="signals">
          {PING_SIGNALS.map((signal) => (
            <button key={signal} type="button" className="btn btn--sm" onClick={() => send(signal)}>
              <span aria-hidden="true">{PING_META[signal].icon}</span> {PING_META[signal].label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
