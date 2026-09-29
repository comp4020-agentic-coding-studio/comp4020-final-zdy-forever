import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { handleYoutubeError } from "./httpErrors.ts";
import { YoutubeApiError, YoutubeApiKeyMissingError } from "./youtube.ts";

// A minimal express.Response stand-in: handleYoutubeError only ever calls
// res.status(code).json(body), so a fake this thin is enough to capture the
// response without pulling in a real Express app.
function fakeResponse() {
  const calls: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      calls.status = code;
      return res;
    },
    json(body: unknown) {
      calls.body = body;
      return res;
    },
  };
  return { res: res as unknown as Response, calls };
}

describe("handleYoutubeError", () => {
  it("maps a missing API key to 503", () => {
    const { res, calls } = fakeResponse();
    handleYoutubeError(res, new YoutubeApiKeyMissingError("no key configured"));
    expect(calls.status).toBe(503);
  });

  it("maps a YoutubeApiError to 502 with its message", () => {
    const { res, calls } = fakeResponse();
    handleYoutubeError(res, new YoutubeApiError("quota exceeded"));
    expect(calls.status).toBe(502);
    expect(calls.body).toEqual({ error: "quota exceeded" });
  });

  // Regression test: this used to rethrow any error it didn't recognize.
  // Every caller is an async Express route handler, so that rethrow became
  // an unhandled promise rejection outside Express's own (synchronous-only)
  // error catching — crashing the whole process (every room's live
  // connections, not just the one failed request) on Node's default
  // --unhandled-rejections=throw behavior. A DB write failure surfacing
  // here is exactly this case.
  it("never rethrows an unexpected error (e.g. a DB write failure) — it responds 500 instead", () => {
    const { res, calls } = fakeResponse();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => handleYoutubeError(res, new Error("disk full"))).not.toThrow();
    expect(calls.status).toBe(500);

    consoleSpy.mockRestore();
  });
});
