# Crit 10 — Fly by instruments

**The breakthrough.** At the crit, two classmates opened the deployed app from its URL alone, each in their own Chrome profile, while I followed the server logs. I could follow who joined, who added which video, who proposed a vote, how each person voted and what the server did. I could tell the two people apart throughout, without seeing their chat messages. The logging rules in [CLAUDE.md](../CLAUDE.md) never record message text, `clientId`, `socketId` or IP, only an account and what it did. Seeing this work with classmates gave me more confidence than the passing [`logging.test.ts`](../server/src/logging.test.ts) alone.

Afterwards the classmates called the vote a new idea they had not thought of, and said it worked because someone temporarily offline could not block it. Their one complaint was the wait, so I shortened votes from 15 to 10 seconds ([ADR 0016](../docs/adr/0016-ten-second-votes.md)).

**A smaller version of what others did.** Other students had added a "report a bug" feature. At first I thought I probably would not need one. Then I remembered the voting bug I had found myself. I added an email address to the entry page so someone can report a problem and I can use the logs to work out what happened. Permissions are written down in [ADR 0015](../docs/adr/0015-who-may-see-and-change-what.md).

**What this changed.** If someone says a vote went wrong, the logs help me work out who did what. I cannot tell what people meant from those records, and I am comfortable with that for privacy. I want to get into the habit of asking what the evidence actually tells me before I accept a result.
