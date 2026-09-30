// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRoomId, saveRoomId } from "./roomSession.ts";

describe("roomSession", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it("remembers the room this tab is in until it leaves", () => {
    expect(loadRoomId()).toBeNull();
    saveRoomId("room-1");
    expect(loadRoomId()).toBe("room-1");
    saveRoomId(null);
    expect(loadRoomId()).toBeNull();
  });

  it("degrades to 'no remembered room' when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    expect(() => saveRoomId("room-1")).not.toThrow();
    expect(loadRoomId()).toBeNull();
  });
});
