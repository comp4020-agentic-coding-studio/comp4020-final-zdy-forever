# Watch YouTube Together

A good shared listening room should make users feel that they are watching something together, rather than one person controlling everything while everyone else simply follows. Because of this, the main design principle of Watch YouTube Together is simple: actions that do not affect other users can happen freely, while actions that change what everyone is watching require agreement.

## Where this started

The idea was inspired by Spotify Jam and QQ Music's "listen together" feature. Both allow a small group of people to share control of the same media session.

My original idea was to build something similar for music. However, I did not have access to a licensed music source or a YouTube Data API key. Since YouTube provides an official embeddable player, I changed the idea from "listen together" to "watch together".

The main idea stayed the same: a small group shares one media session and no single user has complete control.

## Shared presence

Each room has a maximum of 12 users (`MAX_ROOM_USERS`, `server/src/rooms.ts`). I chose a small room size because the application is designed for groups of friends rather than a large public audience.

The server keeps track of who is currently in the room (`server/src/presence.ts`). If a user refreshes the page or reconnects, the client gets the current room state from the server instead of relying on old information stored in the browser.

This helps make sure that everyone sees the same room membership and state.

## Shared control

Actions such as Play, Pause, Skip, Seek, Remove and Reorder affect everyone in the room, so they require a vote.

A vote lasts for 15 seconds. Users can vote YES or NO, while users who do not respond are treated as abstaining. The proposal passes when more than half of the valid votes are YES. A tie fails.

If only one user is in the room, the action can happen immediately because there is nobody else who would be affected.

Each proposal is also linked to the room state that existed when the vote started. If the room state changes before the vote finishes, an old vote cannot incorrectly change the newer state.

Actions such as adding a song, joining, leaving and chatting do not require a vote because they do not directly interrupt what other users are currently watching.

The user who added the current track becomes its DJ. This role is linked to the user rather than to a browser tab. If the DJ disconnects, the role can be passed to another active member so that the room does not become stuck.

Rooms also close automatically after two hours without activity.

## Room chat

Everyone in the room can use chat, even when there is no song in the queue. Chat does not require a vote because sending a message does not interrupt other users' playback.

Messages are limited to 500 characters. To reduce spam, each account can send up to eight messages in ten seconds in the same room.

Messages are stored in SQLite, so they remain after a refresh or reconnect. However, they only exist for the lifetime of the room. When the room is deleted, its messages are also deleted.

Chat message content is not written into the server logs.

## Why YouTube

The application only uses YouTube's official oEmbed endpoint and IFrame Player. It does not use tools such as `yt-dlp`, audio extraction, or hidden playback.

Because of YouTube's own behaviour, perfectly identical playback between users is not realistic. Different users may experience buffering, ads, autoplay restrictions or different network conditions.

Instead, the server stores the current video, playback state, position and time. Clients then adjust themselves toward that shared state.

The goal is therefore to keep users reasonably synchronised, rather than trying to make every browser match at the exact millisecond.

## What I chose not to build

- **No search** — without a YouTube Data API key, users add videos by pasting links.
- **No complex account system** — the application is designed for friends joining a temporary room, not for building long-term user profiles.
- **No voice chat** — voice would compete with the video's audio, and users can already use existing voice applications if they need it.
- **No recommendation system** — the main purpose of the room is for users to share content with each other, rather than receive algorithmic recommendations.

## What I can prove and what I cannot

Some parts of the design are directly enforced by code and tests. For example, the room size limit, voting rules, proposal checks and DJ behaviour can all be tested.

However, some design choices are about user experience rather than correctness.

For example, the code can prove that the room allows a maximum of 12 users, but it cannot prove that 12 is the ideal number of people for a shared watching experience. In the same way, the system can enforce a 15-second voting period, but tests cannot prove that users will find 15 seconds comfortable.

So far, I have mainly tested the system myself using multiple browser tabs. This can show that the rules work technically, but it cannot fully show whether real groups of users will enjoy the experience.

The main goal of the current design is therefore to enforce clear shared-control rules while keeping the application simple enough for a small group of people to use together.