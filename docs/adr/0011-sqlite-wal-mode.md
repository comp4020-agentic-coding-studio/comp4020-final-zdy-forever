# ADR 0011: SQLite in WAL mode, synchronous = NORMAL

## Status

Accepted.

## Context

Reported symptom: video playback occasionally stutters, worse the more people
are in a room (or the more rooms are active on the same deployment at once).

`node:sqlite`'s `DatabaseSync` is synchronous — every call blocks the single
Node.js event loop that also has to promptly relay every room's
`proposal:update`/`playback:update`/presence events. The database was opened
with no `journal_mode`/`synchronous` pragma set, i.e. SQLite's defaults:
rollback-journal mode with `synchronous = FULL`. Under that mode, every write
transaction takes an exclusive lock on the *whole* database file and calls
`fsync()` as part of its commit. `logAction` alone — called on every vote,
chat message, join, proposal create/pass/fail, and playback change — did two
such commits per call (the insert, then `pruneOldLogs`'s delete). More people
means more of these actions happening concurrently, so more frequent, longer
event-loop stalls — which is exactly what would show up as stutter, since it
delays delivering the very playback-sync messages the client needs.

A local benchmark (500 commits of "insert + delete", same shape as
`logAction`) measured ~0.2ms/commit under the old defaults versus ~0.01ms/commit
in WAL mode — roughly 17x on this machine's local SSD. On a cloud disk, where
`fsync` typically costs far more than on local NVMe, the absolute gap would be
larger still.

## Decision

`server/src/db.ts`'s `openDatabase` now runs, right after opening the file:

```
PRAGMA journal_mode = WAL
PRAGMA synchronous = NORMAL
```

This is SQLite's own documented pairing for "one connection, frequent small
writes" — not something specific to this app. A commit in WAL mode is a
sequential append to a separate `-wal` file rather than an in-place,
exclusively-locked rewrite of the main file, and `synchronous = NORMAL` skips
the `fsync` on every commit (only syncing at WAL checkpoints). It's a no-op
for an in-memory database (`:memory:`, used by tests), which SQLite never
puts into WAL mode regardless.

`logAction` (`server/src/logging.ts`) also now wraps its insert and
`pruneOldLogs`'s delete in one transaction instead of two autocommits — it's
the single hottest write path in the app (every meaningful action calls it),
so halving its commit count compounds with the pragma change above. The
rollback itself is wrapped in its own try/catch, since it can throw too (e.g.
the database already closed) — `logAction` must never throw regardless
(CLAUDE.md's Reliability section), mirrored exactly from the no-throw
guarantee the function already had.

## Consequences

- Commits are both cheaper and no longer serialize unrelated rooms' writes
  behind a whole-file exclusive lock.
- `synchronous = NORMAL` is still fully crash-safe for this app: WAL mode can
  never corrupt the database on a crash or power loss, it can only lose the
  last commit(s) that hadn't yet been flushed. For a live listening room (not
  a ledger), losing a few seconds of the most recent log/activity rows in the
  event of an actual server crash is an acceptable trade for every normal
  commit being non-blocking.
- A file-backed database now has two extra files alongside it (`-wal`,
  `-shm`) in the same directory; nothing in the Dockerfile/deployment needs to
  change since both already share that directory with the main file.
