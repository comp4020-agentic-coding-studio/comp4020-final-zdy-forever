# Watch YouTube Together

[Open the app](https://comp4020-final-zdy-forever.fly.dev/), choose a display name, then create a room or join with a friend's link or room number. Paste a YouTube link to add a video. Share the room link so friends can join, watch and chat together. No password or YouTube API key is required.

## What good means here

I want a small group of friends to feel together across physical distance. I enjoyed this feeling when using QQ Music's listen-together feature, but in my experience it was available on mobile rather than the desktop and web interfaces I wanted to use. That experience motivated this browser-based project; it is not a claim about QQ Music's current feature availability.

A useful comparison, introduced during this documentation revision, is Robin Sloan's [*An app can be a home-cooked meal*](https://www.robinsloan.com/notes/home-cooked-app/). His family messaging app values a particular group's connection over a large audience. My definition of good similarly starts with friends sharing an experience. This app adds a further concern: changing shared playback interrupts other people.

## Free contributions, shared interruptions

Anyone can add videos and chat without permission. Adding to the queue lets each person contribute an idea; Pause or Skip changes what others are experiencing, so playback controls require voting. Play, Pause, Skip, Seek, Remove and Reorder follow this rule. Only the current DJ can propose Seek.

A vote lasts up to 15 seconds. YES and NO count; nonresponses abstain. A strict majority of votes cast passes, ties fail, and one YES with no NO passes at the deadline. A sole listener acts immediately; otherwise early resolution requires everyone present to vote. Abstaining leaves you in the room. The cost is deliberate: silence does not veto another person's request, so someone who objects must respond.

A Ctrl-held ping wheel sends a quick, rate-limited reaction to everyone present without a vote, since it changes nobody's playback; click confetti is a purely local flourish nobody else sees.

**Verification, 11 October 2026:** the earlier deployment rejected a lone YES when another connected member abstained. After the correction was deployed, an agent-run check kept that member connected but idle for 310 seconds; Skip passed at the end of the 15-second vote. The [verification record](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/blob/main/docs/evidence/2026-10-11/README.md) distinguishes the before and after results.

## Small rooms with a limited lifetime

I chose 12 people because larger groups make everyone wait longer for their selection. I chose 15 seconds to keep votes brief. These are design judgements, not values established by a user study.

Rooms close after two hours without meaningful activity. I expect each gathering to use a fresh room, and expiry prevents abandoned rooms accumulating. SQLite preserves open-room state across refreshes and restarts; closure deletes the room's chat. This deliberately limits shared memory and needs review against the course's next-day persistence requirement.

## Boundaries and evaluation

Videos use YouTube's official visible player and keyless oEmbed metadata. Buffering, autoplay restrictions and network differences mean synchronisation is convergence, not identical playback. Link entry replaces search; I omitted profiles, voice chat and recommendations to keep attention on friends' selections.

Tests check capacity, voting, stale actions and shared state. My own browser tests exposed voting and interface problems; a later agent-assisted rehearsal captured server events. Neither establishes that unfamiliar groups enjoy the experience. That requires people trying the room, including the still-pending Crit 10 peer exercise. Whether the room feels welcoming and the vote window feels fair remains a human judgement.
