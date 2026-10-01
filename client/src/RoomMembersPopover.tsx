import { useEffect, useId, useRef, useState } from "react";
import type { PlaybackState, PresenceEntry } from "../../shared/src/types.ts";

export function RoomMembersPopover({ members, capacity, dj }: {
  members: PresenceEntry[];
  capacity: number;
  dj: PlaybackState["dj"] | null;
}) {
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

  return (
    <div ref={containerRef} className="room-members" onBlur={(event) => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <button ref={buttonRef} type="button" className="chip room-members-toggle"
        aria-label={`DJ and listeners: ${members.length} of ${capacity} members`}
        aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
        👥 {members.length}/{capacity}
      </button>
      {open && (
        <section id={panelId} className="card card--accent-purple room-members-panel" aria-labelledby={`${panelId}-title`}>
          <h2 id={`${panelId}-title`}>🎧 DJ &amp; listeners</h2>
          {dj && <p className="sticker sticker--dj">DJ: {dj.displayName}</p>}
          <div className="chip-row">
            {members.length === 0 ? <span>nobody yet</span> : members.map((member) => (
              <span key={member.accountId} className="chip">
                <span className="chip-avatar" aria-hidden="true">{member.displayName.slice(0, 1).toUpperCase()}</span>
                {member.displayName}
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
