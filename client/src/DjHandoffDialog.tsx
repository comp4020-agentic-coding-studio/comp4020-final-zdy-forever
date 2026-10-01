import { useEffect, useRef, useState } from "react";
import type { DjHandoff, PresenceEntry } from "../../shared/src/types.ts";

export function DjHandoffDialog({ handoff, members, error, onChoose }: {
  handoff: DjHandoff;
  members: PresenceEntry[];
  error: string | null;
  onChoose: (requestId: string, accountId: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [now, setNow] = useState(Date.now());
  const seconds = Math.max(0, Math.ceil((handoff.expiresAt - now) / 1_000));
  useEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => { clearInterval(timer); dialog.close(); };
  }, []);

  return (
    <dialog ref={dialogRef} className="card dj-handoff-dialog" aria-labelledby="dj-handoff-title"
      onCancel={(event) => event.preventDefault()}>
      <h2 id="dj-handoff-title">Pass the DJ role</h2>
      <p>Who should be DJ after you leave?</p>
      <p role="status">{seconds > 0
        ? `Choose within ${seconds}s, or we'll pick someone at random.`
        : "Assigning the next DJ…"}</p>
      <div className="dj-handoff-members">
        {members.map((member) => (
          <button className="btn" type="button" key={member.accountId} disabled={seconds === 0}
            onClick={() => onChoose(handoff.requestId, member.accountId)}>
            {member.displayName}
          </button>
        ))}
      </div>
      {!members.length && <p>No other members remain. You'll leave when the countdown ends.</p>}
      {error && <p role="alert">{error}</p>}
    </dialog>
  );
}
