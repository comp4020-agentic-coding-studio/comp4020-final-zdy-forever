import { describe, expect, it } from "vitest";
import { LOG_ACTIONS, type LogEventView } from "../../shared/src/types.ts";
import { describeLogEvent, relativeLogTime } from "./logViewerFormat.ts";

function event(overrides: Partial<LogEventView>): LogEventView {
  return {
    timestamp: new Date(0).toISOString(),
    action: "ROOM_JOIN",
    result: "ok",
    accountDisplayName: "Alice",
    ...overrides,
  };
}

describe("describeLogEvent", () => {
  it("never throws and renders every known LOG_ACTIONS value", () => {
    for (const action of LOG_ACTIONS) {
      expect(() => describeLogEvent(event({ action }))).not.toThrow();
      expect(describeLogEvent(event({ action }))).not.toBe("");
    }
  });

  it("falls back to a generic line for an unknown action, never crashing", () => {
    const text = describeLogEvent(event({ action: "SOMETHING_NEW" as never }));
    expect(text).toContain("SOMETHING_NEW");
  });

  it("uses a generic label when accountDisplayName is null", () => {
    expect(describeLogEvent(event({ action: "ROOM_JOIN", accountDisplayName: null }))).toContain("someone");
  });

  it("never renders message text for CHAT_SEND — it was never in the data to begin with", () => {
    const text = describeLogEvent(event({ action: "CHAT_SEND" }));
    expect(text).toBe("💬 Alice sent a message");
  });

  it("includes the vote type in PROPOSAL_PASS/FAIL when present", () => {
    expect(describeLogEvent(event({ action: "PROPOSAL_PASS", detail: "SKIP" }))).toBe("✅ a SKIP vote passed");
    expect(describeLogEvent(event({ action: "PROPOSAL_FAIL", detail: "SEEK" }))).toBe("❌ a SEEK vote failed");
  });

  it("reports a failed ROOM_JOIN distinctly from a successful one", () => {
    expect(describeLogEvent(event({ action: "ROOM_JOIN", result: "room-full" }))).toContain("turned away");
  });
});

describe("relativeLogTime", () => {
  const base = Date.parse("2026-01-01T00:00:00.000Z");

  it("renders 'just now' for anything under 5 seconds old", () => {
    expect(relativeLogTime(new Date(base).toISOString(), base + 2_000)).toBe("just now");
  });

  it("renders seconds, minutes, and hours at the right thresholds", () => {
    expect(relativeLogTime(new Date(base).toISOString(), base + 30_000)).toBe("30s ago");
    expect(relativeLogTime(new Date(base).toISOString(), base + 5 * 60_000)).toBe("5m ago");
    expect(relativeLogTime(new Date(base).toISOString(), base + 3 * 3_600_000)).toBe("3h ago");
  });
});
