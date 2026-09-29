import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Account } from "../../shared/src/types.ts";
import { MAX_REORDER_TOKENS, REORDER_TOKEN_REGEN_INTERVAL_MS } from "../../shared/src/reorderTokens.ts";
import { registerAccount } from "./accounts.ts";
import { openDatabase } from "./db.ts";
import { consumeReorderToken, getReorderTokenBalance } from "./reorderTokenStore.ts";
import { createRoom } from "./rooms.ts";

// All "elapsed time" here is simulated by passing an explicit nowMs to
// getReorderTokenBalance/consumeReorderToken — per shared/src/reorderTokens.ts,
// neither function ever reads the clock itself, so these tests need no real
// waiting and no fake-timer library (mirroring playback.test.ts's style for
// the same reason).
describe("reorder token store (DB-backed)", () => {
  let dir: string;
  let dbPath: string;
  let db: DatabaseSync;
  let roomId: string;
  let alice: Account;
  let bob: Account;

  const T0 = 1_700_000_000_000;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "echo-room-reorder-tokens-"));
    dbPath = path.join(dir, "echo-room.sqlite");
    db = openDatabase(dbPath);
    alice = registerAccount(db, "client-alice", "Alice");
    bob = registerAccount(db, "client-bob", "Bob");
    roomId = createRoom(db, { accountId: alice.accountId, name: "Room", visibility: "PUBLIC", autoCloseEnabled: false }).roomId;
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed by a test that reopens the file
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts at 5 for an account that has never touched a reorder token in this room", () => {
    const balance = getReorderTokenBalance(db, roomId, alice.accountId, T0);
    expect(balance).toEqual({
      roomId,
      accountId: alice.accountId,
      tokens: 5,
      maxTokens: MAX_REORDER_TOKENS,
      nextRegenAt: null, // already at the cap — nothing to wait for
    });
  });

  it("querying a fresh account's balance never persists a row (pure read)", () => {
    getReorderTokenBalance(db, roomId, alice.accountId, T0);
    const row = db
      .prepare("SELECT 1 FROM reorder_tokens WHERE roomId = ? AND accountId = ?")
      .get(roomId, alice.accountId);
    expect(row).toBeUndefined();
  });

  it("different accounts, and the same account in different rooms, are tracked independently", () => {
    consumeReorderToken(db, roomId, alice.accountId, T0);
    expect(getReorderTokenBalance(db, roomId, alice.accountId, T0).tokens).toBe(4);
    expect(getReorderTokenBalance(db, roomId, bob.accountId, T0).tokens).toBe(5);

    const otherRoomId = createRoom(db, {
      accountId: alice.accountId,
      name: "Other room",
      visibility: "PUBLIC",
      autoCloseEnabled: false,
    }).roomId;
    expect(getReorderTokenBalance(db, otherRoomId, alice.accountId, T0).tokens).toBe(5);
  });

  describe("spending", () => {
    it("consuming a token drops the balance by exactly one and reports it", () => {
      const result = consumeReorderToken(db, roomId, alice.accountId, T0);
      expect(result).toEqual({
        ok: true,
        balance: {
          roomId,
          accountId: alice.accountId,
          tokens: 4,
          maxTokens: MAX_REORDER_TOKENS,
          nextRegenAt: new Date(T0 + REORDER_TOKEN_REGEN_INTERVAL_MS).toISOString(),
        },
      });
    });

    it("the spend is persisted — a later read (even at the same instant) reflects it", () => {
      consumeReorderToken(db, roomId, alice.accountId, T0);
      expect(getReorderTokenBalance(db, roomId, alice.accountId, T0).tokens).toBe(4);
    });

    it("spending down to zero, then spending again fails and changes nothing", () => {
      for (let i = 0; i < MAX_REORDER_TOKENS; i++) {
        expect(consumeReorderToken(db, roomId, alice.accountId, T0).ok).toBe(true);
      }
      expect(getReorderTokenBalance(db, roomId, alice.accountId, T0).tokens).toBe(0);

      const failed = consumeReorderToken(db, roomId, alice.accountId, T0);
      expect(failed).toEqual({
        ok: false,
        balance: {
          roomId,
          accountId: alice.accountId,
          tokens: 0,
          maxTokens: MAX_REORDER_TOKENS,
          nextRegenAt: new Date(T0 + REORDER_TOKEN_REGEN_INTERVAL_MS).toISOString(),
        },
      });
      expect(getReorderTokenBalance(db, roomId, alice.accountId, T0).tokens).toBe(0);
    });

    it("a failed spend (no tokens yet) writes no row at all — a genuine no-op", () => {
      // Never having consumed anything, there's no row yet; force a failed
      // spend by asking at the very moment the account is (hypothetically)
      // empty — simulate via manually draining first, then reading the raw
      // table state before vs. after a failed attempt.
      for (let i = 0; i < MAX_REORDER_TOKENS; i++) {
        consumeReorderToken(db, roomId, alice.accountId, T0);
      }
      const before = db
        .prepare("SELECT tokens, anchorMs FROM reorder_tokens WHERE roomId = ? AND accountId = ?")
        .get(roomId, alice.accountId);

      consumeReorderToken(db, roomId, alice.accountId, T0 + 1); // still well within the same interval
      const after = db
        .prepare("SELECT tokens, anchorMs FROM reorder_tokens WHERE roomId = ? AND accountId = ?")
        .get(roomId, alice.accountId);

      expect(after).toEqual(before);
    });
  });

  describe("regeneration over time", () => {
    it("+1 after 5 minutes", () => {
      consumeReorderToken(db, roomId, alice.accountId, T0); // 5 -> 4
      const after = getReorderTokenBalance(db, roomId, alice.accountId, T0 + REORDER_TOKEN_REGEN_INTERVAL_MS);
      expect(after.tokens).toBe(5);
    });

    it("less than 5 minutes: no regen yet", () => {
      consumeReorderToken(db, roomId, alice.accountId, T0); // 5 -> 4
      const after = getReorderTokenBalance(db, roomId, alice.accountId, T0 + REORDER_TOKEN_REGEN_INTERVAL_MS - 1);
      expect(after.tokens).toBe(4);
    });

    it("multiple intervals grant multiple tokens", () => {
      for (let i = 0; i < 3; i++) consumeReorderToken(db, roomId, alice.accountId, T0); // 5 -> 2
      const after = getReorderTokenBalance(db, roomId, alice.accountId, T0 + 2 * REORDER_TOKEN_REGEN_INTERVAL_MS);
      expect(after.tokens).toBe(4);
    });

    it("caps at 5 no matter how long it's been", () => {
      consumeReorderToken(db, roomId, alice.accountId, T0); // 5 -> 4
      const after = getReorderTokenBalance(db, roomId, alice.accountId, T0 + 1000 * REORDER_TOKEN_REGEN_INTERVAL_MS);
      expect(after.tokens).toBe(MAX_REORDER_TOKENS);
      expect(after.nextRegenAt).toBeNull();
    });

    it("regen accrues even without ever calling getReorderTokenBalance in between (no in-memory timer involved)", () => {
      consumeReorderToken(db, roomId, alice.accountId, T0); // 5 -> 4, persisted anchor = T0
      // Nothing reads/writes this account's balance for a long stretch...
      const muchLater = T0 + 4 * REORDER_TOKEN_REGEN_INTERVAL_MS;
      // ...and the very next read still correctly reflects 3 regenerated
      // ticks capped at 5 (4 + 4 ticks -> capped), purely from the persisted
      // anchor and the timestamp handed in now.
      expect(getReorderTokenBalance(db, roomId, alice.accountId, muchLater).tokens).toBe(MAX_REORDER_TOKENS);
    });
  });

  describe("restart", () => {
    it("survives closing and reopening the database file, recomputing correctly against a later clock", () => {
      consumeReorderToken(db, roomId, alice.accountId, T0); // 5 -> 4
      consumeReorderToken(db, roomId, alice.accountId, T0); // 4 -> 3
      db.close();

      const reopened = openDatabase(dbPath);
      // "Restart" happens at T0 + 2 intervals: 2 ticks should have
      // regenerated while the process was down, purely from the persisted
      // row — nothing in-memory survived the close/reopen.
      const restartNowMs = T0 + 2 * REORDER_TOKEN_REGEN_INTERVAL_MS;
      const balance = getReorderTokenBalance(reopened, roomId, alice.accountId, restartNowMs);
      reopened.close();

      // Re-point db to a fresh open so afterEach's db.close() doesn't throw.
      db = openDatabase(dbPath);

      expect(balance.tokens).toBe(5);
    });

    it("a restart-time read never itself corrupts the persisted anchor for a subsequent spend", () => {
      consumeReorderToken(db, roomId, alice.accountId, T0); // 5 -> 4, anchor T0
      db.close();

      const reopened = openDatabase(dbPath);
      const restartNowMs = T0 + REORDER_TOKEN_REGEN_INTERVAL_MS + 1_000; // one tick, plus a bit
      expect(getReorderTokenBalance(reopened, roomId, alice.accountId, restartNowMs).tokens).toBe(5);

      // Spending right after this read-only balance check must still see
      // the correctly regenerated value (the read must not have persisted a
      // stale intermediate row that a naive implementation might have
      // written).
      const spent = consumeReorderToken(reopened, roomId, alice.accountId, restartNowMs);
      expect(spent).toEqual({ ok: true, balance: expect.objectContaining({ tokens: 4 }) });
      reopened.close();

      db = openDatabase(dbPath);
    });

    it("an account that never spent anything before restart is still full afterwards", () => {
      db.close();
      const reopened = openDatabase(dbPath);
      const balance = getReorderTokenBalance(reopened, roomId, alice.accountId, T0 + 999 * REORDER_TOKEN_REGEN_INTERVAL_MS);
      reopened.close();
      db = openDatabase(dbPath);

      expect(balance.tokens).toBe(5);
    });
  });
});
