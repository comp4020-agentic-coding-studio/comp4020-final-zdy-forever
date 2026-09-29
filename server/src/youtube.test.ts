import { describe, expect, it } from "vitest";
import { isValidVideoId, parseYouTubeVideoId } from "../../shared/src/youtube.ts";
import { isEmbeddable } from "./youtube.ts";

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

describe("isEmbeddable", () => {
  it("is true only when the owner allows embedding and the video isn't private", () => {
    expect(isEmbeddable({ embeddable: true, privacyStatus: "public" })).toBe(true);
    expect(isEmbeddable({ embeddable: true, privacyStatus: "unlisted" })).toBe(true);
  });

  it("is false when embedding is disallowed, even if not private", () => {
    expect(isEmbeddable({ embeddable: false, privacyStatus: "public" })).toBe(false);
  });

  it("is false when the video is private, even if embeddable is reported true", () => {
    expect(isEmbeddable({ embeddable: true, privacyStatus: "private" })).toBe(false);
  });

  it("defaults to false when status fields are missing", () => {
    expect(isEmbeddable({})).toBe(false);
  });
});
