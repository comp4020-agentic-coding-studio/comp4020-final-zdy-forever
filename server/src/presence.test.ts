import { describe, expect, it } from "vitest";
import { PresenceStore } from "./presence.ts";

describe("PresenceStore", () => {
  it("lists two different users each present once", () => {
    const store = new PresenceStore();
    store.join("room-1", "socket-alice", { accountId: "acct-alice", displayName: "Alice" });
    store.join("room-1", "socket-bob", { accountId: "acct-bob", displayName: "Bob" });

    const presence = store.list("room-1");
    expect(presence).toHaveLength(2);
    expect(presence.map((p) => p.accountId).sort()).toEqual(["acct-alice", "acct-bob"]);
  });

  it("keeps two accounts with the same displayName distinct", () => {
    const store = new PresenceStore();
    store.join("room-1", "socket-a", { accountId: "acct-a", displayName: "Sam" });
    store.join("room-1", "socket-b", { accountId: "acct-b", displayName: "Sam" });

    const presence = store.list("room-1");
    expect(presence).toHaveLength(2);
    expect(presence.map((p) => p.accountId).sort()).toEqual(["acct-a", "acct-b"]);
    expect(presence.every((p) => p.displayName === "Sam")).toBe(true);
  });

  it("counts an account present only once across two simultaneous sockets (duplicate tabs)", () => {
    const store = new PresenceStore();
    const first = store.join("room-1", "socket-tab-1", { accountId: "acct-alice", displayName: "Alice" });
    const second = store.join("room-1", "socket-tab-2", { accountId: "acct-alice", displayName: "Alice" });

    expect(first.becamePresent).toBe(true);
    expect(second.becamePresent).toBe(false);
    expect(store.list("room-1")).toEqual([{ accountId: "acct-alice", displayName: "Alice" }]);
  });

  it("does not report absence until the last socket for an account leaves", () => {
    const store = new PresenceStore();
    store.join("room-1", "socket-tab-1", { accountId: "acct-alice", displayName: "Alice" });
    store.join("room-1", "socket-tab-2", { accountId: "acct-alice", displayName: "Alice" });

    const afterFirstLeave = store.leave("room-1", "socket-tab-1");
    expect(afterFirstLeave?.becameAbsent).toBe(false);
    expect(store.list("room-1")).toEqual([{ accountId: "acct-alice", displayName: "Alice" }]);

    const afterSecondLeave = store.leave("room-1", "socket-tab-2");
    expect(afterSecondLeave?.becameAbsent).toBe(true);
    expect(store.list("room-1")).toEqual([]);
  });

  it("removes an account entirely on disconnect (single tab)", () => {
    const store = new PresenceStore();
    store.join("room-1", "socket-bob", { accountId: "acct-bob", displayName: "Bob" });

    const result = store.leave("room-1", "socket-bob");
    expect(result).toEqual({ accountId: "acct-bob", becameAbsent: true });
    expect(store.list("room-1")).toEqual([]);
  });

  it("ignores leaving a socket that was never joined", () => {
    const store = new PresenceStore();
    expect(store.leave("room-1", "no-such-socket")).toBeUndefined();
    expect(store.leave("no-such-room", "no-such-socket")).toBeUndefined();
  });

  it("counts distinct accounts, not sockets, toward capacity", () => {
    const store = new PresenceStore();
    store.join("room-1", "socket-tab-1", { accountId: "acct-alice", displayName: "Alice" });
    store.join("room-1", "socket-tab-2", { accountId: "acct-alice", displayName: "Alice" });
    store.join("room-1", "socket-bob", { accountId: "acct-bob", displayName: "Bob" });

    expect(store.count("room-1")).toBe(2);
    expect(store.count("no-such-room")).toBe(0);
  });

  it("admits a new account only while the room is below capacity, but always admits one already present", () => {
    const store = new PresenceStore();
    store.join("room-1", "socket-alice", { accountId: "acct-alice", displayName: "Alice" });
    store.join("room-1", "socket-bob", { accountId: "acct-bob", displayName: "Bob" });

    expect(store.canAdmit("room-1", "acct-carol", 2)).toBe(false);
    expect(store.canAdmit("room-1", "acct-alice", 2)).toBe(true);
    expect(store.canAdmit("room-1", "acct-carol", 3)).toBe(true);
  });

  // Regression: capacity used to count every account that had ever joined,
  // so a room stayed "full" forever once it had seen `capacity` visitors.
  it("frees a place as soon as an account's last socket leaves", () => {
    const store = new PresenceStore();
    store.join("room-1", "socket-alice", { accountId: "acct-alice", displayName: "Alice" });
    store.join("room-1", "socket-bob", { accountId: "acct-bob", displayName: "Bob" });
    expect(store.canAdmit("room-1", "acct-carol", 2)).toBe(false);

    store.leave("room-1", "socket-bob");
    expect(store.count("room-1")).toBe(1);
    expect(store.canAdmit("room-1", "acct-carol", 2)).toBe(true);
  });

  it("keeps rooms independent of one another", () => {
    const store = new PresenceStore();
    store.join("room-1", "socket-alice", { accountId: "acct-alice", displayName: "Alice" });
    store.join("room-2", "socket-bob", { accountId: "acct-bob", displayName: "Bob" });

    expect(store.list("room-1")).toEqual([{ accountId: "acct-alice", displayName: "Alice" }]);
    expect(store.list("room-2")).toEqual([{ accountId: "acct-bob", displayName: "Bob" }]);
  });
});
