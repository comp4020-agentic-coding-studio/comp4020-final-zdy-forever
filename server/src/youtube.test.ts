import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidVideoId, parseYouTubeVideoId } from "../../shared/src/youtube.ts";
import { getVideoMetadata, YoutubeLookupError } from "./youtube.ts";

describe("isValidVideoId", () => {
  it("accepts an 11-character videoId with letters, digits, - and _", () => {
    expect(isValidVideoId("dQw4w9WgXcQ")).toBe(true);
    expect(isValidVideoId("a-b_c1234D5")).toBe(true);
  });

  it("rejects the wrong length or invalid characters", () => {
    expect(isValidVideoId("dQw4w9WgXc")).toBe(false); // 10 chars
    expect(isValidVideoId("dQw4w9WgXcQQ")).toBe(false); // 12 chars
    expect(isValidVideoId("dQw4w9WgX!Q")).toBe(false); // invalid char
    expect(isValidVideoId("")).toBe(false);
  });
});

describe("parseYouTubeVideoId", () => {
  it("accepts a bare videoId", () => {
    expect(parseYouTubeVideoId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(parseYouTubeVideoId("  dQw4w9WgXcQ  ")).toBe("dQw4w9WgXcQ");
  });

  it("parses a standard watch URL, including extra query params", () => {
    expect(parseYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(parseYouTubeVideoId("https://youtube.com/watch?v=dQw4w9WgXcQ&t=30s&list=abc")).toBe(
      "dQw4w9WgXcQ",
    );
  });

  it("parses a youtu.be short link, with or without a trailing query", () => {
    expect(parseYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(parseYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ?t=10")).toBe("dQw4w9WgXcQ");
  });

  it("parses embed and shorts URLs", () => {
    expect(parseYouTubeVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(parseYouTubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("handles the m. mobile subdomain and youtube-nocookie.com", () => {
    expect(parseYouTubeVideoId("https://m.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(parseYouTubeVideoId("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ",
    );
  });

  it("rejects unrelated URLs, malformed input, and non-video YouTube pages", () => {
    expect(parseYouTubeVideoId("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(parseYouTubeVideoId("not a url at all")).toBeNull();
    expect(parseYouTubeVideoId("https://www.youtube.com/results?search_query=x")).toBeNull();
    expect(parseYouTubeVideoId("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(parseYouTubeVideoId("")).toBeNull();
  });
});

// YouTube's oEmbed endpoint, as it answers for real: 200 with the video's
// details, 400 for an id that never existed, 404 for one that's gone, and
// 401/403 for one that exists but can't be embedded (owner disabled it, or
// it's private).
describe("getVideoMetadata (oEmbed)", () => {
  function answer(status: number, body: unknown = {}) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks the public oEmbed endpoint, with no API key, and maps its answer", async () => {
    const fetchMock = answer(200, {
      title: "Never Gonna Give You Up",
      author_name: "Rick Astley",
      thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    });

    const metadata = await getVideoMetadata("dQw4w9WgXcQ");

    const requested = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect(requested.origin + requested.pathname).toBe("https://www.youtube.com/oembed");
    expect(requested.searchParams.get("url")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(requested.searchParams.has("key")).toBe(false);
    expect(metadata).toEqual({
      videoId: "dQw4w9WgXcQ",
      title: "Never Gonna Give You Up",
      channelTitle: "Rick Astley",
      thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      embeddable: true,
      durationMs: null,
    });
  });

  it("reports a video that doesn't exist as not found", async () => {
    answer(400);
    expect(await getVideoMetadata("aaaaaaaaaaa")).toBeNull();
    answer(404);
    expect(await getVideoMetadata("aaaaaaaaaaa")).toBeNull();
  });

  it("reports a video that can't be embedded as not embeddable", async () => {
    for (const status of [401, 403]) {
      answer(status);
      expect(await getVideoMetadata("dQw4w9WgXcQ")).toMatchObject({ videoId: "dQw4w9WgXcQ", embeddable: false });
    }
  });

  it("treats YouTube being unreachable or failing as a lookup error, not as a verdict on the video", async () => {
    answer(500);
    await expect(getVideoMetadata("dQw4w9WgXcQ")).rejects.toBeInstanceOf(YoutubeLookupError);
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    await expect(getVideoMetadata("dQw4w9WgXcQ")).rejects.toBeInstanceOf(YoutubeLookupError);
  });
});
