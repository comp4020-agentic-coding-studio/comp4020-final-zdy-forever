# Crit 10 — Fly by instruments

**The breakthrough.** At the crit, two classmates opened the deployed app from its URL alone, each in their own Chrome profile, while I followed the server logs. The important actions were all there: who joined, who added which video, who proposed a vote, how each person voted and what the server then did. I could tell the two people apart throughout. What I could not see was what anyone said in chat. That is deliberate: the logging rules in [CLAUDE.md](../CLAUDE.md) never record message text, `clientId`, `socketId` or IP, only an account and what it did. The exercise confirmed the boundary works in practice, not only in [`logging.test.ts`](../server/src/logging.test.ts).

Afterwards the classmates called the vote a new idea they had not thought of, and said it worked because someone temporarily offline could not block it. Their one complaint was the wait, so I shortened votes from 15 to 10 seconds ([ADR 0016](../docs/adr/0016-ten-second-votes.md)).

**A smaller version of what others did.** Other students had added a "report a bug" feature. I first judged bugs unlikely, but I had already found one voting bug myself, so that reasoning did not hold. The entry page now gives an email address instead: someone reports a problem, and the logs reconstruct what happened. Permissions are written down in [ADR 0015](../docs/adr/0015-who-may-see-and-change-what.md).

**What this changed.** Logs answer "who did what" well, and that is the question I need when someone says the vote went wrong. They do not answer "what did people mean", and I am comfortable keeping it that way for privacy. I want to keep asking which question a piece of evidence can actually answer before I accept it.
