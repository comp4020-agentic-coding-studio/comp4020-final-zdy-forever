// Pure: where a queue track may be moved to. Shared so the server enforces
// it (server/src/queue.ts's planQueueReorder) and the client offers exactly
// the same moves (its ⬆/⬇ buttons and drop targets).
//
// The queue is history (tracks that have already played, above the current
// one), the current track, then what's still to come — and what plays next
// is always the first track positioned after the current one (see
// server/src/playback.ts's getNextTrack). So where a track may be moved to
// depends on which part it's in:
//
// - the current track never moves;
// - a track still to come moves only among the tracks still to come: put in
//   front of the current track it would silently never play;
// - a history track moves only down, to a later spot — which is how it goes
//   back on: placed after the current track, it's still to come again.
//
// With nothing playing, every track counts as still to come, matching
// getNextTrack's own "whatever would start now" view. `to` is the index of
// the track it would land in front of, or order.length for the very end.
export function placementAllowed(currentIndex: number, from: number, to: number): boolean {
  if (currentIndex === -1) return true;
  if (from === currentIndex) return false;
  if (from > currentIndex) return to > currentIndex;
  return to > from;
}

