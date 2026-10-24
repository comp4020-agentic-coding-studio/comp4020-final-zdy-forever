# Watch YouTube Together

[Open the app](https://comp4020-final-zdy-forever.fly.dev/), choose a display name, then create a room or join with a friend's link or room number. Paste a YouTube link to add a video, and share the room link with friends. No password or account setup is needed.

## What good means here

One idea runs through this app: **anyone may add; nobody may interrupt alone.** Friends can freely contribute videos and chat, but anything that changes what everyone is watching needs a vote.

I want a small group of friends to feel together across distance. I enjoyed this in QQ Music's listen-together feature, which in my experience was mobile-only; I wanted it in a browser. Two readings sharpened the scope. Clay Shirky's [*Situated Software*](https://gwern.net/doc/technology/2004-03-30-shirky-situatedsoftware.html) (2004) describes software built "for use by a specific social group, rather than for a generic set of 'users'", and Robin Sloan's [*An app can be a home-cooked meal*](https://www.robinsloan.com/notes/home-cooked-app/) values one family's connection over scale. Both argue against the alternative I rejected, an open, growing audience. Neither addresses what happens when a shared experience can be interrupted.

## Freedom and respect

Adding a video you want to watch is free expression: it takes nothing from anyone. Pausing or skipping interrupts everyone else's viewing, so it needs the group's agreement. Play, Pause, Skip, Seek, Remove and Reorder require a vote; adding and chatting never do. Only the current DJ can propose Seek.

Existing tools choose one side. Watch2Gether by default lets [all users "interact with the player (play/pause)"](https://community.w2g.tv/t/how-to-use-watch2gether/736): anyone can interrupt anyone. Its owner can restrict the player to moderators, and Teleparty's host can choose ["Only I have control"](https://www.howtogeek.com/you-can-use-teleparty-to-create-a-watch-party-with-any-streaming-service/): one person decides for everyone. I wanted neither a free-for-all nor a host.

A vote lasts up to 15 seconds. Nonresponses abstain; a strict majority of votes cast passes, ties fail, so one YES with no NO passes. The cost is deliberate: silence does not veto another person's request, so someone who objects must respond ([verified on the deployment](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/blob/main/docs/evidence/2026-10-11/README.md)).

The same idea decides everything else. Chat is the main way to talk, because emoji alone cannot carry a conversation. A ping wheel, modelled on League of Legends', adds a quick emoji signal when typing is too slow; like chat it interrupts nobody's playback, so it needs no vote, but it is rate-limited and never stored. Rooms hold 12 people so everyone's selection comes up without a long wait.

## A room that is still there tomorrow

Rooms close after a week without meaningful activity. I first chose two hours for one-off gatherings, but a room was then always gone by the next day ([ADR 0014](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/blob/main/docs/adr/0014-one-week-room-expiry.md)). SQLite keeps queue, playback position and chat across refreshes, restarts and redeploys; closure deletes the chat. The 12-person, 15-second and one-week values are judgements, not results of a user study.

## Boundaries and evaluation

Videos use YouTube's official visible player and keyless oEmbed metadata. Buffering, autoplay and network differences mean synchronisation is convergence, not identical playback. I omitted search, profiles, voice chat and recommendations to keep attention on friends' selections.

**Enforced** by tests in `spec/` and `server/`: interruptions need a passing vote, abstainers cannot block it, stale votes cannot apply, only present members act or read, and logs never contain chat text. **Judged**, not tested: whether the room feels welcoming and the vote window fair. I judged those from my own use and from Crit 10, where two classmates used the deployed app from its URL while I followed only the logs: every important action and actor was visible, chat text was not.
