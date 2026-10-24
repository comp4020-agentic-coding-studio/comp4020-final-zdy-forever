# One-week room expiry

Supersedes the two-hour window in [ADR 0008](0008-mandatory-closure-and-dj-handoff.md);
the rest of 0008 (mandatory for every room, DJ handoff) is unchanged.

## Context

Rooms closed after two hours without meaningful activity, and closure deletes
their chat. The final-project brief requires actions to persist "across
sessions, restarts and redeploys", and markers return the next day after the
machine has stopped and restarted. With a two-hour window, a room a marker
created the day before has always closed by then: the queue, history and chat
they left are gone, so next-day persistence could not be observed at all.

## Decision

Rooms close after **7 days** without meaningful activity
(`AUTO_CLOSE_INACTIVITY_MS` in `server/src/rooms.ts`). Everything else stays:
closure is still mandatory, still computed from the stored
`lastMeaningfulActivityAt` (so a restart does not reset it), still deletes chat
atomically, and still frees the room's code/number. Heartbeats, reading and
ping signals still do not count as activity.

## Options considered

- **Keep two hours.** Matches the original "one-off gathering" idea, but makes
  next-day return impossible to demonstrate.
- **Keep closed rooms as read-only history.** Preserves memory forever, but
  needs a new UI state and contradicts deleting chat on closure.
- **24 hours.** Just enough for the marker's return, but a room left on Friday
  evening would be gone by a Sunday rewatch.
- **7 days (chosen).** Covers the next-day return with margin and a weekly
  rhythm among friends, without abandoned rooms accumulating indefinitely.

## Costs

- Abandoned rooms stay in the public lobby for up to a week. A lobby crowded by
  stale rooms is partly mitigated by the 7-digit room number, which reaches a
  room without scrolling.
- Codes/numbers stay reserved for a week, so the 6-digit private space holds
  fewer free codes at once. At this project's scale this is not a constraint.
- Chat now survives for up to a week of silence rather than two hours, which is
  more shared memory than the original design intended.

## Evidence

The existing timestamp-driven tests in `server/src/rooms.test.ts`,
`chat.test.ts`, `chatRealtime.test.ts` and `realtime.test.ts` reference the
constant rather than a literal, so they now exercise the 7-day boundary. A real
next-day return on the deployment is a separate, manual observation.
