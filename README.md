# Watch YouTube Together

[Open the app](https://comp4020-final-zdy-forever.fly.dev/), choose a display name, then create a room or join with a friend's link or room number. No password is needed.

## What good means here

One idea runs through this app: **anyone may add; nobody interrupts over an objection.** Adding videos and chatting are free; anything that changes what everyone watches goes to a vote, and one NO stops a lone request.

I want a small group of friends to feel together across distance, as I did in QQ Music's listen-together feature, which in my experience was mobile-only. Clay Shirky's [*Situated Software*](https://gwern.net/doc/technology/2004-03-30-shirky-situatedsoftware.html) (2004) describes software built "for use by a specific social group, rather than for a generic set of 'users'", and Robin Sloan's [*An app can be a home-cooked meal*](https://www.robinsloan.com/notes/home-cooked-app/) values one family's connection over scale. Both reject an open, growing audience, as I do. Neither addresses what happens when a shared experience can be interrupted.

## Freedom and respect

Adding a video is free expression: it takes nothing from anyone. Pausing or skipping interrupts everyone else, so Play, Pause, Skip, Seek, Remove and Reorder need a vote; adding and chatting never do. Only the DJ, whoever added the current video, can propose a Seek: they chose it and know where to jump, but the group still votes, so the DJ is a guide, not a host.

Existing tools choose one side. Watch2Gether by default lets [all users "interact with the player (play/pause)"](https://community.w2g.tv/t/how-to-use-watch2gether/736): anyone can interrupt anyone. Its owner can restrict the player to moderators, and Teleparty's host can choose ["Only I have control"](https://www.howtogeek.com/you-can-use-teleparty-to-create-a-watch-party-with-any-streaming-service/): one person decides for everyone. I wanted neither.

A vote lasts up to 10 seconds. Nonresponses abstain; a strict majority of votes cast passes, so one YES with no NO passes. The cost: silence does not veto, so objectors must respond ([verified on the deployment](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/blob/main/docs/evidence/2026-10-11/README.md)). At Crit 10, classmates called the vote a new idea they had not thought of, and said it worked because a member who had gone quiet could not block it. Their complaint was the wait, so I cut it from 15 to 10 seconds ([ADR 0016](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/blob/main/docs/adr/0016-ten-second-votes.md)).

The same idea decides the rest. Chat is the main way to talk, since emoji alone cannot carry a conversation; a ping wheel, modelled on League of Legends', adds a quick emoji signal when typing is too slow. Neither interrupts playback, so no vote. Rooms hold 12 so everyone's selection comes up soon. Before joining, anyone with a room's code can read its recent activity in plain words, to see whether its members respect each other. Click confetti is local party atmosphere.

## A room that is still there tomorrow

Rooms close after a week idle. Two hours, my first choice, meant a room was always gone by the next day ([ADR 0014](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/blob/main/docs/adr/0014-one-week-room-expiry.md)). SQLite keeps queue, playback position and chat across restarts and redeploys. The 12-person, 10-second and one-week values are judgements, not study results.

## Boundaries and evaluation

The official YouTube player leaves buffering and ads outside my control: synchronisation means convergence, not identical playback. I omitted search, profiles and voice chat.

**Enforced** by tests in `spec/` and `server/`: interruptions need a passing vote, abstainers cannot block it, stale votes cannot apply, only present members act or read, and logs never contain chat text. **Judged**, not tested: whether the room feels welcoming and the vote fair, from my own use and Crit 10, where I followed only the server logs and could see every important action and actor, but no chat text.
