# Crit 10 — Fly by instruments

**The breakthrough.** At the crit, two classmates opened the deployed app from its URL alone, each in their own Chrome profile, while I followed the server logs. The important actions were all there: who joined, who added which video, who proposed a vote, how each person voted and what the server then did. I could tell the two people apart throughout. What I could not see was what anyone said in chat. That is deliberate: the logging rules in [CLAUDE.md](../CLAUDE.md) never record message text, `clientId`, `socketId` or IP, only an account and what it did. The exercise confirmed the boundary works in practice, not only in [`logging.test.ts`](../server/src/logging.test.ts).

Before the crit I had only an [agent-assisted rehearsal](../docs/evidence/2026-10-11/README.md), where one agent drove two browsers. Real people, who did not know the interface, produced the same kind of trail, which is stronger evidence that the logs are readable by someone other than the person who designed them.

**A choice I did not follow.** Other students had added a "report a bug" feature. I decided not to, because this app has no complicated features and I judged bugs unlikely. The logs already reconstruct what happened in a room, and the per-user permissions are now written down in [ADR 0015](../docs/adr/0015-who-may-see-and-change-what.md).

**What this changed.** Logs answer "who did what" well, and that is the question I need when someone says the vote went wrong. They do not answer "what did people mean", and I am comfortable keeping it that way for privacy. I want to keep asking which question a piece of evidence can actually answer before I accept it.
