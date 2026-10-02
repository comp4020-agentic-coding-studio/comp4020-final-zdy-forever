import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAccount } from "./accounts.ts";
import { openDatabase } from "./db.ts";
import { formatLogEvent, listRecentLogs, LOG_ACTIONS, LOG_RETENTION_MS, logAction, withAccountDisplayNames } from "./logging.ts";

describe("logging", () => {
  let dir: string;
  let dbPath: string;
  let db: DatabaseSync;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "echo-room-logging-"));
    dbPath = path.join(dir, "echo-room.sqlite");
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed by a test that exercises the write-failure path
    }
    rmSync(dir, { recursive: true, force: true });
  });

  describe("formatLogEvent", () => {
    it("stamps a valid ISO timestamp from the given nowMs", () => {
      const nowMs = Date.parse("2026-01-02T03:04:05.000Z");
      const event = formatLogEvent({ action: "ROOM_CREATE", result: "ok", roomId: "room-1" }, nowMs);
      expect(event.timestamp).toBe("2026-01-02T03:04:05.000Z");
    });

    // Regression guard: LogEvent has no displayName/clientId/socketId/IP
    // field at all, so this asserts the *shape* stays exactly what was passed
    // in plus timestamp — an accidental future PII field added to the input
    // would show up here as an unexpected key.
    it("only ever carries the input's own fields plus timestamp — never an extra field", () => {
      const input = {
        action: "VOTE_CAST" as const,
        result: "ok",
        roomId: "room-1",
        accountId: "account-1",
        proposalId: "proposal-1",
        detail: "YES",
      };
      const event = formatLogEvent(input);
      expect(Object.keys(event).sort()).toEqual([...Object.keys(input), "timestamp"].sort());
      expect(event).toEqual({ ...input, timestamp: event.timestamp });
    });

    it("covers exactly the 15 action kinds required by CLAUDE.md's observability request", () => {
      expect([...LOG_ACTIONS].sort()).toEqual(
        [
          "ROOM_CREATE",
          "ROOM_JOIN",
          "ROOM_LEAVE",
          "TRACK_ADD",
          "PROPOSAL_CREATE",
          "VOTE_CAST",
          "PROPOSAL_PASS",
          "PROPOSAL_FAIL",
          "PROPOSAL_CANCEL",
          "PLAYBACK_CHANGE",
          "QUEUE_REMOVE",
          "QUEUE_REORDER",
          "CHAT_SEND",
          "RECONNECT",
          "ROOM_AUTO_CLOSE",
        ].sort(),
      );
    });
  });

  describe("logAction", () => {
    it("persists a row into the logs table with the given fields", () => {
      logAction(db, {
        action: "PROPOSAL_PASS",
        result: "ok",
        roomId: "room-1",
        accountId: "account-1",
        proposalId: "proposal-1",
        playbackId: "playback-1",
        revision: 3,
        detail: "SKIP",
      });

      const row = db.prepare("SELECT * FROM logs WHERE action = 'PROPOSAL_PASS'").get() as
        | {
            action: string;
            result: string;
            roomId: string;
            accountId: string;
            proposalId: string;
            playbackId: string;
            revision: number;
            detail: string;
            timestamp: string;
          }
        | undefined;

      expect(row).toBeDefined();
      expect(row?.result).toBe("ok");
      expect(row?.roomId).toBe("room-1");
      expect(row?.accountId).toBe("account-1");
      expect(row?.proposalId).toBe("proposal-1");
      expect(row?.playbackId).toBe("playback-1");
      expect(row?.revision).toBe(3);
      expect(row?.detail).toBe("SKIP");
      expect(() => new Date(row!.timestamp).toISOString()).not.toThrow();
    });

    it("prints one JSON line to stdout matching the persisted event", () => {
      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const nowMs = Date.parse("2026-01-02T03:04:05.000Z");

      logAction(db, { action: "CHAT_SEND", result: "ok", roomId: "room-1", accountId: "account-1" }, nowMs);

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const printed = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(printed).toEqual({
        timestamp: "2026-01-02T03:04:05.000Z",
        action: "CHAT_SEND",
        result: "ok",
        roomId: "room-1",
        accountId: "account-1",
      });

      consoleLogSpy.mockRestore();
    });

    // 20-minute retention (CLAUDE.md-style: computed from stored timestamps,
    // never an in-memory repeating timer, same as rooms.ts's inactivity
    // sweep) — a row older than the window is pruned by the next logAction
    // call, a row still inside it is left alone.
    it("prunes log rows older than the 20-minute retention window, keeping newer ones", () => {
      const nowMs = Date.parse("2026-01-02T03:20:00.000Z");
      logAction(db, { action: "ROOM_CREATE", result: "ok", roomId: "old-room" }, nowMs - LOG_RETENTION_MS - 1000);
      logAction(db, { action: "ROOM_CREATE", result: "ok", roomId: "recent-room" }, nowMs - 1000);

      logAction(db, { action: "ROOM_JOIN", result: "ok", roomId: "trigger-room" }, nowMs);

      const rooms = (db.prepare("SELECT roomId FROM logs ORDER BY roomId ASC").all() as { roomId: string }[]).map(
        (r) => r.roomId,
      );
      expect(rooms).toEqual(["recent-room", "trigger-room"]);
    });

    // Regression test, mirroring server/src/httpErrors.test.ts's "never
    // rethrows an unexpected error" case: a logging failure (e.g. a DB write
    // failure) must never be why the request or room it describes crashes
    // (CLAUDE.md's Reliability section).
    it("never throws when the DB write fails — it logs the failure and still prints the event", () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      db.close();

      expect(() => logAction(db, { action: "ROOM_LEAVE", result: "ok", roomId: "room-1", accountId: "account-1" })).not.toThrow();
      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);

      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });
  });

  describe("listRecentLogs", () => {
    it("returns a room's rows newest first, and never another room's", () => {
      logAction(db, { action: "ROOM_CREATE", result: "ok", roomId: "room-1" }, Date.parse("2026-01-02T03:00:00.000Z"));
      logAction(db, { action: "TRACK_ADD", result: "ok", roomId: "room-2" }, Date.parse("2026-01-02T03:00:01.000Z"));
      logAction(db, { action: "ROOM_JOIN", result: "ok", roomId: "room-1" }, Date.parse("2026-01-02T03:00:02.000Z"));

      const rows = listRecentLogs(db, { roomId: "room-1", nowMs: Date.parse("2026-01-02T03:00:02.000Z") });

      expect(rows.map((r) => r.action)).toEqual(["ROOM_JOIN", "ROOM_CREATE"]);
    });

    it("prunes rows older than the retention window before reading them back", () => {
      const nowMs = Date.parse("2026-01-02T03:20:00.000Z");
      logAction(db, { action: "ROOM_CREATE", result: "ok", roomId: "room-1" }, nowMs - LOG_RETENTION_MS - 1000);

      const rows = listRecentLogs(db, { nowMs });

      expect(rows).toEqual([]);
    });
  });

  describe("withAccountDisplayNames", () => {
    it("decorates each event with its account's current displayName, without touching the stored event", () => {
      const account = registerAccount(db, "client-1", "Ash");
      const events = [formatLogEvent({ action: "CHAT_SEND", result: "ok", roomId: "room-1", accountId: account.accountId })];

      const [decorated] = withAccountDisplayNames(db, events);

      expect(decorated.accountDisplayName).toBe("Ash");
      expect(decorated.accountId).toBe(account.accountId);
    });

    it("resolves to null, never throwing, for an event with no accountId or an unknown one", () => {
      const events = [
        formatLogEvent({ action: "ROOM_AUTO_CLOSE", result: "ok", roomId: "room-1" }),
        formatLogEvent({ action: "CHAT_SEND", result: "ok", roomId: "room-1", accountId: "no-such-account" }),
      ];

      const decorated = withAccountDisplayNames(db, events);

      expect(decorated.map((e) => e.accountDisplayName)).toEqual([null, null]);
    });

    it("two accounts sharing a displayName decorate identically — this labels, it never re-identifies", () => {
      const a = registerAccount(db, "client-a", "Sam");
      const b = registerAccount(db, "client-b", "Sam");
      const events = [
        formatLogEvent({ action: "CHAT_SEND", result: "ok", roomId: "room-1", accountId: a.accountId }),
        formatLogEvent({ action: "CHAT_SEND", result: "ok", roomId: "room-1", accountId: b.accountId }),
      ];

      const decorated = withAccountDisplayNames(db, events);

      expect(decorated.map((e) => e.accountDisplayName)).toEqual(["Sam", "Sam"]);
      expect(decorated[0].accountId).not.toBe(decorated[1].accountId);
    });
  });
});
