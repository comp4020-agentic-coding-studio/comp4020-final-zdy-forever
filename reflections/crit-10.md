# Crit 10 — Fly by instruments

*Preparation draft, updated 11 October 2026. The required two-classmate exercise has not yet been completed.*

**The breakthrough so far.** During my own testing of the deployed website, one person's video sometimes buffered even with only two people present. I asked the agent to inspect the logs. It reported resolving the problem and described a SQLite write optimisation as about “17 times faster.” I did not run or interpret that benchmark myself, and I do not know the original buffering cause.

The change exists in [`3863e71`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/3863e71), but a code change is not proof of that explanation. [ADR 0011](../docs/adr/0011-sqlite-wal-mode.md) now labels the number as an unverified agent report. A database benchmark would also need a separate connection to observed playback before supporting a causal claim.

A later [agent-assisted rehearsal](../docs/evidence/2026-10-11/README.md) produced stronger, narrower evidence: distinct participants, a vote, its result and the resulting playback event could be followed in the logs. It also reproduced the connected-but-abstaining Skip failure. This was one agent operating two browser contexts, not two classmates independently exploring from a URL, and not my narration using logs alone.

**What this changes.** I want to delegate diagnosis while asking for evidence that matches the claim. An event trail can establish who acted and what the server decided; it cannot automatically explain video buffering. For the actual crit, I still need to record what I could infer from logs, what I missed, and how that changes my judgement of the system. Those experiences cannot be supplied by this draft.
