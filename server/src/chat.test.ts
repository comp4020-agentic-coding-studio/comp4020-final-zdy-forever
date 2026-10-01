import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_MAX_LENGTH } from "../../shared/src/types.ts";
import { registerAccount, renameAccount } from "./accounts.ts";
import { ChatRateLimiter, listChatMessages, normalizeChatText, recordChatMessage } from "./chat.ts";
import { openDatabase } from "./db.ts";
import { AUTO_CLOSE_INACTIVITY_MS, createRoom, getRoomById, sweepInactiveRooms } from "./rooms.ts";

describe("room chat storage", () => {
  let dir: string;
  let db: DatabaseSync;
  let dbPath: string;
  let roomId: string;
  let accountId: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "room-chat-"));
    dbPath = path.join(dir, "chat.sqlite");
    db = openDatabase(dbPath);
    accountId = registerAccount(db, "alice-device", "Alice").accountId;
    roomId = createRoom(db, { accountId, name: "Room", visibility: "PUBLIC", autoCloseEnabled: true }).roomId;
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it("preserves order, server identity, plain text and history across a restart", () => {
    const now = Date.now();
    const first = recordChatMessage(db, roomId, accountId, "  hello 👋\n<script>literal text</script>  ", now);
    renameAccount(db, accountId, "New name");
    const second = recordChatMessage(db, roomId, accountId, "second", now);
    db.close();
    db = openDatabase(dbPath);
    expect(listChatMessages(db, roomId)).toEqual([first, second]);
    expect(first).toMatchObject({ accountId, displayName: "Alice", text: "hello 👋\n<script>literal text</script>" });
    expect(second.displayName).toBe("New name");
    expect(first.messageId).not.toBe(second.messageId);
  });

  it("deletes only the closing room's history and prevents new writes", () => {
    const other = createRoom(db, { accountId, name: "Other", visibility: "PUBLIC", autoCloseEnabled: false }).roomId;
    recordChatMessage(db, roomId, accountId, "private to this room");
    recordChatMessage(db, other, accountId, "keep me");
    db.prepare("UPDATE rooms SET closed = 1 WHERE roomId = ?").run(roomId);
    expect(listChatMessages(db, roomId)).toEqual([]);
    expect(listChatMessages(db, other).map(m => m.text)).toEqual(["keep me"]);
    expect(() => recordChatMessage(db, roomId, accountId, "too late")).toThrow(/closed/);
    expect(() => db.prepare("INSERT INTO chat_messages VALUES (?, ?, ?, ?, ?, ?)").run("bypass", roomId, accountId, "Alice", "late", new Date().toISOString())).toThrow(/closed/);
    db.close();
    db = openDatabase(dbPath);
    expect(listChatMessages(db, roomId)).toEqual([]);
  });

  it("treats chat as activity and purges history when an unoccupied room expires", () => {
    const now = Date.now();
    recordChatMessage(db, roomId, accountId, "hello", now);
    expect(getRoomById(db, roomId, now)!.lastMeaningfulActivityAt).toBe(new Date(now).toISOString());
    sweepInactiveRooms(db, now + AUTO_CLOSE_INACTIVITY_MS - 1);
    expect(listChatMessages(db, roomId)).toHaveLength(1);
    sweepInactiveRooms(db, now + AUTO_CLOSE_INACTIVITY_MS);
    expect(listChatMessages(db, roomId)).toEqual([]);
  });

  it("rolls back the message if updating room activity fails", () => {
    const original = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (sql.startsWith("UPDATE rooms SET lastMeaningfulActivityAt")) throw new Error("disk failure");
      return original(sql);
    });
    expect(() => recordChatMessage(db, roomId, accountId, "must not remain")).toThrow("disk failure");
    expect(listChatMessages(db, roomId)).toEqual([]);
  });

  it("removes the retired reaction table when upgrading an existing database", () => {
    db.exec("CREATE TABLE reactions (text TEXT); INSERT INTO reactions VALUES ('old reaction')");
    db.close();
    db = openDatabase(dbPath);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'reactions'").get()).toBeUndefined();
  });
});

it("validates message text and its size", () => {
  for (const value of [undefined, null, 42, {}, "", " \n\t", "x".repeat(CHAT_MAX_LENGTH + 1)]) expect(normalizeChatText(value)).toBeNull();
  expect(normalizeChatText("x".repeat(CHAT_MAX_LENGTH))).toHaveLength(CHAT_MAX_LENGTH);
  expect(normalizeChatText(" hi ")).toBe("hi");
});

it("rate limits per account across tabs, separately for each room, and resets after the window", () => {
  const limiter = new ChatRateLimiter();
  for (let i = 0; i < 8; i++) expect(limiter.tryConsume("room", "alice", 100)).toBe(true);
  expect(limiter.tryConsume("room", "alice", 101)).toBe(false);
  expect(limiter.tryConsume("room", "bob", 101)).toBe(true);
  expect(limiter.tryConsume("other", "alice", 101)).toBe(true);
  expect(limiter.tryConsume("room", "alice", 10_100)).toBe(true);
});
