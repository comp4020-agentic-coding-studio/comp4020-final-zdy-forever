# Crit 10 — Fly by instruments

**The breakthrough.** At first, the main problem seemed to be that the video sometimes became laggy, especially when more people joined the room. My first guess was that the problem came from the YouTube player, buffering, or host's network speed. However, after checking the logs, I found that the real problem was somewhere else.

Every time a user voted, sent a chat message, or joined a room, the server wrote new data to SQLite. The `node:sqlite` library performs these writes synchronously, which means the server has to finish the database operation before it can continue doing other work. Because the same event loop is also responsible for sending real-time playback updates, frequent database writes could delay video synchronisation.

I asked agent tested this with a small benchmark and found that SQLite's WAL mode made writes about 17 times faster on my machine. This gave me clear evidence that the database configuration was contributing to the performance problem (`docs/adr/0011-sqlite-wal-mode.md`, [`3863e71`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/3863e71)).

**What this changed.** Before this crit, I mainly thought of logging as something useful for showing what the system was doing during a demo. After this experience, I realised that logs are also useful for debugging. They helped me to turn problems such as "the video sometimes lags" into a specific problem that I could test and measure.

I want to become a developer that should always check the evidence from logs to debug before making assumptions about the cause of a problem.  Debug by guessing which part is wrong in most of the time is not a good choice.
