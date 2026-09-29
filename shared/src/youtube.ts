// Pure YouTube URL / videoId parsing — no network, no API key. Shared so the
// client can validate a pasted URL before ever sending anything; the server
// always re-parses and re-validates independently regardless of what the
// client claims (see CLAUDE.md's Authority section).

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export function isValidVideoId(value: string): boolean {
  return VIDEO_ID_PATTERN.test(value);
}

// Accepts a bare videoId or any of YouTube's common URL shapes (watch,
// youtu.be, embed, shorts — with or without www./m., any extra query params
// or path segments) and returns the 11-character videoId, or null if the
// input isn't recognizable as a YouTube video reference.
export function parseYouTubeVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (isValidVideoId(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.)/, "");

  if (host === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0] ?? "";
    return isValidVideoId(id) ? id : null;
  }

  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") {
      const id = url.searchParams.get("v") ?? "";
      return isValidVideoId(id) ? id : null;
    }
    const match = url.pathname.match(/^\/(?:embed|shorts)\/([^/]+)/);
    if (match) return isValidVideoId(match[1]) ? match[1] : null;
  }

  return null;
}
