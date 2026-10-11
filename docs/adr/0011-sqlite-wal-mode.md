# ADR 0011: SQLite WAL mode and synchronous = NORMAL

## Status

Implemented in [3863e71](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/3863e71). Evidence wording corrected on 11 October 2026. This is a database configuration decision, not a verified diagnosis of playback buffering.

## Observed problem and evidence limits

The owner observed occasional video buffering on the deployed website even with two users. They asked the coding agent to inspect logs; the agent reported a fix. The owner did not independently identify the cause.

The earlier account reported a local benchmark of 500 insert/delete commits and an approximately 17-fold improvement. No original measurement output or reproducible benchmark script has been retained with this ADR. The owner did not run or interpret it. Treat the magnitude as an unverified agent report, not a measured project result. There is also no controlled playback comparison connecting that number to the buffering symptom.

A plausible concern is that `node:sqlite`'s `DatabaseSync` operations share the Node event loop with realtime message handling. Reducing time spent writing could improve responsiveness. This mechanism alone does not establish that database writes caused the observed video buffering: player behaviour and network conditions remain untested alternatives.

## Decision

`server/src/db.ts` configures file-backed databases with:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
```

`server/src/logging.ts` groups the action-log insert and pruning delete in one transaction rather than two separate autocommits, and catches logging failures. SQLite does not switch an in-memory database to WAL, so in-memory test performance is not evidence for this file-backed configuration.

The choice trades some power-loss durability for reduced per-transaction synchronisation work. SQLite's [synchronous documentation](https://www.sqlite.org/pragma.html#pragma_synchronous) explains that WAL with NORMAL remains consistent, but recent transactions can roll back after power loss or an operating-system crash. Application crashes have different durability semantics. It is inaccurate to call the change fully durable under every crash scenario.

## Alternatives and consequences

- Keeping WAL with FULL would add a WAL synchronisation at each commit, providing stronger durability at additional write cost. No retained comparison establishes its user-visible cost in this deployment.
- NORMAL does not make synchronous JavaScript database calls non-blocking. The server still waits for those calls, and the setting is not proof that contention has disappeared.
- Potential rollback concerns every recent transaction using this configuration, including room, queue, playback and chat state, not only logs. The amount of lost history is not established as a fixed number of seconds.
- The database's WAL and shared-memory sidecar files live alongside it on the mounted data volume. Persistence checks should use a file-backed database and distinguish an application restart from power loss.

The performance/durability trade-off is recorded explicitly. To claim a numerical improvement, retain a reproducible workload, environment and before/after results. To claim a buffering fix, also measure the relevant playback behaviour under comparable conditions. Neither claim is established by the existing rehearsal.
