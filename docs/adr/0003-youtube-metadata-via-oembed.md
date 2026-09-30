# ADR 0003: Video metadata comes from YouTube's oEmbed endpoint, not the Data API v3

## Status

Accepted. Replaces the Data API v3 usage that CLAUDE.md originally allowed.

## Context

The YouTube Data API v3 needs an API key, and the course has said it can't be
used. Without a key, every track addition and search failed with "YouTube
API is not configured". Nothing could be queued at all.

The server still has to look a video up before queueing it. A pasted link
only gives a `videoId`, and the server needs to know that the video exists
and can be embedded (otherwise the room gets stuck on a track nobody can
play). It also needs a title, channel and thumbnail that it has looked up
itself, not ones a client claimed (CLAUDE.md's Authority section).

## Decision

Metadata comes from YouTube's public oEmbed endpoint
(`https://www.youtube.com/oembed?url=…&format=json`). It's an official YouTube
endpoint and needs no key (`server/src/youtube.ts`):

- 200 → the video's title, channel (`author_name`) and thumbnail
- 400 / 404 → no such video
- 401 / 403 → the video exists but can't be embedded (the owner disabled
  embedding, or it's private)
- anything else, or no answer → a lookup failure (HTTP 502), not a verdict on
  the video

Search is removed. YouTube offers no keyless search, so songs come from
pasted links.

## Consequences

- Adding a link and previewing one both work with no configuration.
- oEmbed reports no length, so every newly added track has
  `durationMs: null`. The server can't check a "my player ended" report
  against the anchor, so for these tracks
  `ProposalManager.handleTrackEnded` waits for a strict majority of the
  listeners present. One client alone still can't skip a track.
  - A client uses its own player's `getDuration()` to put itself back in
    sync after someone drags the scrubber to the end. That only decides what
    that client does, never what the room does.
  - A DJ's Seek can't be capped at the track's length any more. A target
    past the end simply ends the track once enough players get there.
- A track whose players can't play it (for example, blocked in someone's
  region, which oEmbed doesn't reveal) needs a Skip vote to move on.
- Items queued earlier with a Data API length keep it, and the length-based
  checks still apply to them.
