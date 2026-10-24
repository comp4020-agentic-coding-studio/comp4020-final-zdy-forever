# Mandatory room expiry and DJ departure handoff

All rooms close after a period without meaningful activity (originally two
hours; seven days since [ADR 0014](0014-one-week-room-expiry.md)). Ignore the legacy
creation flag and migrate existing rooms to enabled; timestamp-based sweeps
also cover legacy rows whose flag is still false. Chat deletion on closure is
unchanged.

The current DJ may choose a present successor when leaving. A server-owned
10-second deadline chooses randomly among the remaining distinct accounts if
there is no valid choice. Zero candidates means simply leave; one means an
immediate handoff. Another tab of the departing account preserves its presence
and role. Abrupt disconnects always allow a 10-second reconnect grace window,
even with one candidate. Only an explicit Leave bypasses the dialog and wait
when there is a single successor; a refresh must not transfer the DJ role.

Store the successor as a nullable `room_playback.djAccountId` override. Preserve
the video, timing anchor, and queue's `addedBy`. Increment playback revision so
old SEEK proposals become stale. Track transitions clear the override, then
reconcile if the next track's adder is absent. No new voting requirement applies
to departure itself.

Only an authenticated room socket with a pending request may choose; validate
the request ID, source account, deadline and current candidate presence. Choices
never affect a different playback. Room closure cancels pending handoffs.
