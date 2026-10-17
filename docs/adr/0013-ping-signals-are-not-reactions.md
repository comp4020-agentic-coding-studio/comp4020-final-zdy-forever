# Ping signals are not reactions

Status: accepted (product requirement).

The room gains a Ctrl-held radial picker that broadcasts a short-lived signal
(an emoji/label pair — "😂 Laugh", "👍 Thumbs up", "❓ Confused", "🔥 Fire",
"⏫ Catch me up", and similar) to everyone currently present, synced over a
plain Socket.IO event pair outside the voting engine.

This looks like the emoji reactions docs/adr/0006 removed, so it is worth
saying explicitly why it does not reopen that decision. ADR 0006 removed a
feature that was **persisted and replayable**: a reaction tied to a moment in
a video, stored in a now-deleted table, and played back to later joiners as
history. Its own language is specific about this — "historical reaction
playback" and "the old reaction table is removed" — and chat was introduced
as what a room's *lasting* expression should look like instead.

A ping signal is architecturally different on every axis that mattered to
0006:

- Nothing is written to SQLite. There is no table, and nothing survives a
  disconnect, a server restart, or a late joiner's snapshot.
- Nothing is replayed. `room:snapshot` never includes past pings; a signal
  that arrives before you do is simply missed, like a heartbeat.
- It is not tied to video content or a playback position — it is a live,
  momentary broadcast to whoever is in the room right now, closer in kind to
  presence (`presence:join`/`presence:leave`) than to a reaction-on-a-video.
- It never counts as voting-eligible activity (CLAUDE.md's Voting section's
  list — Play/Pause/Skip/Seek/Remove/Reorder — is exhaustive and deliberately
  excludes it) and never counts as the activity that keeps a room from
  auto-closing (it is cosmetic, not a use of the room).

So "chat replaces reactions" still holds for anything meant to last — chat is
still the room's only persisted, replayable communication. A ping is neither
persisted nor replayable; it is closer to clapping than to writing something
down. Rate-limited per account (first 3 free, then throttled to 3 per rolling
10 seconds — mirrors the existing `shared/src/rateLimit.ts` window chat
already uses, just a tighter one) so it cannot be used to spam the room the
way an unlimited reaction stream once could.
