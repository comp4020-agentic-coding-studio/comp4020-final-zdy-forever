import { describe, expect, it } from "vitest";
import {
  classifyDrift,
  computeExpectedPositionMs,
  DRIFT_HARD_RESYNC_MS,
  DRIFT_IGNORE_MS,
  isPlausibleTrackEnd,
  isStaleReference,
  TRACK_END_TOLERANCE_MS,
} from "../../shared/src/playbackSync.ts";

describe("computeExpectedPositionMs", () => {
  it("PAUSED never advances, regardless of elapsed time", () => {
    const anchor = { status: "PAUSED" as const, anchorPositionMs: 42_000, anchorServerTimeMs: 1_000 };
    expect(computeExpectedPositionMs(anchor, 1_000)).toBe(42_000);
    expect(computeExpectedPositionMs(anchor, 999_999)).toBe(42_000);
  });

  it("PLAYING advances by exactly the elapsed wall-clock time", () => {
    const anchor = { status: "PLAYING" as const, anchorPositionMs: 10_000, anchorServerTimeMs: 5_000 };
    expect(computeExpectedPositionMs(anchor, 5_000)).toBe(10_000);
    expect(computeExpectedPositionMs(anchor, 8_000)).toBe(13_000);
  });

  it("clamps a nowMs earlier than the anchor's own timestamp to zero elapsed, never running backwards", () => {
    const anchor = { status: "PLAYING" as const, anchorPositionMs: 10_000, anchorServerTimeMs: 5_000 };
    expect(computeExpectedPositionMs(anchor, 1_000)).toBe(10_000);
  });
});

describe("classifyDrift", () => {
  it("ignores drift below the ignore threshold", () => {
    expect(classifyDrift(10_000, 10_000)).toBe("none");
    expect(classifyDrift(10_000, 10_000 + DRIFT_IGNORE_MS - 1)).toBe("none");
    expect(classifyDrift(10_000, 10_000 - (DRIFT_IGNORE_MS - 1))).toBe("none");
  });

  it("calls for a silent seek once at or above the ignore threshold but below hard-resync", () => {
    expect(classifyDrift(10_000, 10_000 + DRIFT_IGNORE_MS)).toBe("seek");
    expect(classifyDrift(10_000, 10_000 + DRIFT_HARD_RESYNC_MS - 1)).toBe("seek");
  });

  it("calls for a hard resync at or above the hard-resync threshold", () => {
    expect(classifyDrift(10_000, 10_000 + DRIFT_HARD_RESYNC_MS)).toBe("hard-resync");
    expect(classifyDrift(0, 50_000)).toBe("hard-resync");
  });

  it("is symmetric — being ahead of or behind expected drifts the same way", () => {
    expect(classifyDrift(10_000, 10_000 - DRIFT_HARD_RESYNC_MS)).toBe("hard-resync");
  });
});

describe("isStaleReference", () => {
  const base = { playbackId: "pb-1", revision: 3 };

  it("is not stale when both playbackId and revision still match", () => {
    expect(isStaleReference(base, { playbackId: "pb-1", revision: 3 })).toBe(false);
  });

  it("is stale when the track transitioned (playbackId changed)", () => {
    expect(isStaleReference(base, { playbackId: "pb-0", revision: 3 })).toBe(true);
  });

  it("is stale when any other anchor rebase landed first (revision changed)", () => {
    expect(isStaleReference(base, { playbackId: "pb-1", revision: 2 })).toBe(true);
  });

  it("is stale when both differ", () => {
    expect(isStaleReference(base, { playbackId: "pb-0", revision: 2 })).toBe(true);
  });
});

// Regression: any client's "my player ended" used to advance the room with no
// vote, so dragging the visible player's own scrubber to the end skipped the
// track for everyone.
describe("isPlausibleTrackEnd", () => {
  const T0 = 1_000_000;
  const track = (overrides: Partial<Parameters<typeof isPlausibleTrackEnd>[0]>) => ({
    status: "PLAYING" as const,
    anchorPositionMs: 0,
    anchorServerTimeMs: T0,
    durationMs: 200_000,
    ...overrides,
  });

  it("rejects an end reported well before the room's anchor reaches the track's length", () => {
    expect(isPlausibleTrackEnd(track({}), T0 + 30_000)).toBe(false);
  });

  it("accepts an end within the tolerance of the track's length, or past it", () => {
    expect(isPlausibleTrackEnd(track({}), T0 + 200_000 - TRACK_END_TOLERANCE_MS)).toBe(true);
    expect(isPlausibleTrackEnd(track({}), T0 + 200_000)).toBe(true);
    expect(isPlausibleTrackEnd(track({}), T0 + 260_000)).toBe(true);
  });

  it("never believes a PAUSED room's track ended unless it was paused right at the end", () => {
    expect(isPlausibleTrackEnd(track({ status: "PAUSED", anchorPositionMs: 60_000 }), T0 + 999_000)).toBe(false);
    expect(isPlausibleTrackEnd(track({ status: "PAUSED", anchorPositionMs: 195_000 }), T0)).toBe(true);
  });

  it("takes the report at its word when the track's length is unknown", () => {
    expect(isPlausibleTrackEnd(track({ durationMs: null }), T0 + 1_000)).toBe(true);
  });
});
