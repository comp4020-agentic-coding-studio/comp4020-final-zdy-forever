import type { YoutubeVideoMetadata } from "../../shared/src/types.ts";

// YouTube itself couldn't be reached, or answered in a way that says nothing
// about the video asked for — a temporary failure on YouTube's side.
export class YoutubeLookupError extends Error {}

// Video metadata comes from YouTube's public oEmbed endpoint: official, and
// it needs no API key (the Data API v3 isn't available to this course — see
// docs/adr/0003-youtube-metadata-via-oembed.md). It says whether a video
// exists, whether it can be embedded, and its title, channel and thumbnail.
// It does not report a video's length, and there is no search.
const OEMBED_ENDPOINT = "https://www.youtube.com/oembed";

interface OEmbedResponse {
  title?: unknown;
  author_name?: unknown;
  thumbnail_url?: unknown;
}

const text = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() ? value : fallback);

export async function getVideoMetadata(videoId: string): Promise<YoutubeVideoMetadata | null> {
  const url = new URL(OEMBED_ENDPOINT);
  url.searchParams.set("url", `https://www.youtube.com/watch?v=${videoId}`);
  url.searchParams.set("format", "json");

  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new YoutubeLookupError("couldn't reach YouTube");
  }

  // No such video: YouTube answers 400 for an id that never existed, 404
  // for one that's gone.
  if (res.status === 400 || res.status === 404) return null;
  // The video exists but can't be played outside youtube.com: its owner
  // turned embedding off, or it's private.
  if (res.status === 401 || res.status === 403) {
    return { videoId, title: videoId, channelTitle: "", thumbnailUrl: "", embeddable: false, durationMs: null };
  }
  if (!res.ok) throw new YoutubeLookupError(`YouTube lookup failed: ${res.status}`);

  let body: OEmbedResponse;
  try {
    body = (await res.json()) as OEmbedResponse;
  } catch {
    throw new YoutubeLookupError("YouTube sent an unreadable answer");
  }
  return {
    videoId,
    title: text(body.title, videoId),
    channelTitle: text(body.author_name, ""),
    thumbnailUrl: text(body.thumbnail_url, ""),
    embeddable: true,
    // Unknown, always: oEmbed doesn't report it. A reported track end is
    // then judged by a majority of listeners (ProposalManager.handleTrackEnded).
    durationMs: null,
  };
}
