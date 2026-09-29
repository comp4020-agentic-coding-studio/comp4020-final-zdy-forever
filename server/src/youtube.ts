import type { YoutubeSearchResult, YoutubeVideoMetadata } from "../../shared/src/types.ts";

export class YoutubeApiKeyMissingError extends Error {}
export class YoutubeApiError extends Error {}

const API_BASE = "https://www.googleapis.com/youtube/v3";

function requireApiKey(): string {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new YoutubeApiKeyMissingError("YOUTUBE_API_KEY is not configured");
  return key;
}

function thumbnailOf(thumbnails: Record<string, { url: string }> | undefined): string {
  return thumbnails?.medium?.url ?? thumbnails?.default?.url ?? "";
}

// A video is only genuinely embeddable elsewhere when its owner has allowed
// embedding AND it isn't private — YouTube reports `embeddable: true` on some
// private videos even though they can't actually be played outside
// youtube.com, so both fields must be checked.
export function isEmbeddable(status: { embeddable?: boolean; privacyStatus?: string }): boolean {
  return status.embeddable === true && status.privacyStatus !== "private";
}

interface YoutubeSearchApiResponse {
  items: {
    id: { videoId: string };
    snippet: { title: string; channelTitle: string; thumbnails?: Record<string, { url: string }> };
  }[];
}

interface YoutubeVideosApiResponse {
  items: {
    id: string;
    snippet: { title: string; channelTitle: string; thumbnails?: Record<string, { url: string }> };
    status: { embeddable?: boolean; privacyStatus?: string };
  }[];
}

const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const searchCache = new Map<string, { expiresAt: number; results: YoutubeSearchResult[] }>();

// Search is submit-driven only (see App.tsx) — this cache just avoids
// re-hitting the Data API quota for the same query in quick succession, not a
// substitute for that client-side behaviour.
export async function searchVideos(query: string): Promise<YoutubeSearchResult[]> {
  const cached = searchCache.get(query);
  if (cached && cached.expiresAt > Date.now()) return cached.results;

  const key = requireApiKey();
  const url = new URL(`${API_BASE}/search`);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("maxResults", "12");
  url.searchParams.set("q", query);
  url.searchParams.set("key", key);

  const res = await fetch(url);
  if (!res.ok) throw new YoutubeApiError(`YouTube search failed: ${res.status}`);
  const body = (await res.json()) as YoutubeSearchApiResponse;

  const results: YoutubeSearchResult[] = body.items.map((item) => ({
    videoId: item.id.videoId,
    title: item.snippet.title,
    channelTitle: item.snippet.channelTitle,
    thumbnailUrl: thumbnailOf(item.snippet.thumbnails),
  }));

  searchCache.set(query, { expiresAt: Date.now() + SEARCH_CACHE_TTL_MS, results });
  return results;
}

export async function getVideoMetadata(videoId: string): Promise<YoutubeVideoMetadata | null> {
  const key = requireApiKey();
  const url = new URL(`${API_BASE}/videos`);
  url.searchParams.set("part", "snippet,status");
  url.searchParams.set("id", videoId);
  url.searchParams.set("key", key);

  const res = await fetch(url);
  if (!res.ok) throw new YoutubeApiError(`YouTube metadata lookup failed: ${res.status}`);
  const body = (await res.json()) as YoutubeVideosApiResponse;

  const item = body.items[0];
  if (!item) return null;

  return {
    videoId: item.id,
    title: item.snippet.title,
    channelTitle: item.snippet.channelTitle,
    thumbnailUrl: thumbnailOf(item.snippet.thumbnails),
    embeddable: isEmbeddable(item.status),
  };
}

// A small fixed set of known-embeddable, known-available videos so the room
// always has something to play even without a search — never a substitute
// for real search, just a reliable fallback.
const DEMO_VIDEO_IDS = ["dQw4w9WgXcQ", "9bZkp7q19f0", "kJQP7kiw5Fk", "JGwWNGJdvx8"];

const DEMO_SONGS_CACHE_TTL_MS = 60 * 60 * 1000;
let demoSongsCache: { expiresAt: number; results: YoutubeSearchResult[] } | null = null;

export async function getDemoSongs(): Promise<YoutubeSearchResult[]> {
  if (demoSongsCache && demoSongsCache.expiresAt > Date.now()) return demoSongsCache.results;

  const key = requireApiKey();
  const url = new URL(`${API_BASE}/videos`);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("id", DEMO_VIDEO_IDS.join(","));
  url.searchParams.set("key", key);

  const res = await fetch(url);
  if (!res.ok) throw new YoutubeApiError(`YouTube demo songs lookup failed: ${res.status}`);
  const body = (await res.json()) as YoutubeVideosApiResponse;

  const results: YoutubeSearchResult[] = body.items.map((item) => ({
    videoId: item.id,
    title: item.snippet.title,
    channelTitle: item.snippet.channelTitle,
    thumbnailUrl: thumbnailOf(item.snippet.thumbnails),
  }));

  demoSongsCache = { expiresAt: Date.now() + DEMO_SONGS_CACHE_TTL_MS, results };
  return results;
}
