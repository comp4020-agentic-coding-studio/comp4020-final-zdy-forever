# Watch YouTube Together

[Open the app](https://comp4020-final-zdy-forever.fly.dev/), choose a display name, then create a room or join with a friend's link or room number. Paste a YouTube link to add a video. Share the room link so friends can join, watch and chat together. No password or YouTube API key is required.

## What good means here

I want a small group of friends to feel together across physical distance. I enjoyed this feeling in QQ Music's listen-together feature, which in my experience was mobile-only; I wanted it in a browser.

Two readings sharpened this. Clay Shirky's [*Situated Software*](https://gwern.net/doc/technology/2004-03-30-shirky-situatedsoftware.html) (2004) describes software built "for use by a specific social group, rather than for a generic set of 'users'", and Robin Sloan's [*An app can be a home-cooked meal*](https://www.robinsloan.com/notes/home-cooked-app/) values one family's connection over scale. Both argue against the alternative I rejected: an open, growing audience. My definition of good starts with friends sharing an experience, and adds a concern neither raises: changing shared playback interrupts other people.

## Free contributions, shared interruptions

Anyone can add videos and chat without permission. Adding to the queue lets each person contribute an idea; Pause or Skip changes what others are experiencing, so playback controls require voting. Play, Pause, Skip, Seek, Remove and Reorder follow this rule. Only the current DJ can propose Seek.

A vote lasts up to 15 seconds. YES and NO count; nonresponses abstain. A strict majority of votes cast passes, ties fail, and one YES with no NO passes at the deadline. A sole listener acts immediately; otherwise early resolution requires everyone present to vote. Abstaining leaves you in the room. The cost is deliberate: silence does not veto another person's request, so someone who objects must respond.

A Ctrl-held ping wheel, modelled on League of Legends' ping wheel, sends a quick, rate-limited signal to everyone without typing or voting, since it changes nobody's playback. Click confetti is a purely local flourish.

**Verification, 11 October 2026:** the earlier deployment rejected a lone YES when another connected member abstained; after the fix, an agent-run check kept that member idle for 310 seconds and Skip passed at the deadline. The [verification record](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/blob/main/docs/evidence/2026-10-11/README.md) distinguishes the before and after results.

## Small rooms with a limited lifetime

I chose 12 people because larger groups make everyone wait longer for their selection. I chose 15 seconds to keep votes brief. These are design judgements, not values established by a user study.

Rooms close after a week without meaningful activity. I first chose two hours for one-off gatherings, but then a room was always gone by the next day, so returning friends found nothing ([ADR 0014](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/blob/main/docs/adr/0014-one-week-room-expiry.md)). A week covers a return visit while abandoned rooms still disappear. SQLite keeps queue, playback position and chat across refreshes, restarts and redeploys; closure deletes the chat.

## Boundaries and evaluation

Videos use YouTube's official visible player and keyless oEmbed metadata. Buffering, autoplay restrictions and network differences mean synchronisation is convergence, not identical playback. Link entry replaces search; I omitted profiles, voice chat and recommendations to keep attention on friends' selections.

**Enforced** claims are checked by tests in `spec/` and `server/`: capacity, voting rules, stale actions, permissions, persistence and logs without chat text. **Judged** claims are not: whether the room feels welcoming and the vote window fair. Those I judged from my own use, and from Crit 10, where two classmates used the deployed app from its URL while I followed only the logs. Every important action and actor was visible; chat text was not.
