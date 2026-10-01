import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CHAT_MAX_LENGTH, type ChatMessage } from "../../shared/src/types.ts";
import { checkRateLimit, type RateLimitState } from "../../shared/src/rateLimit.ts";
import { getAccountById } from "./accounts.ts";
import { getRoomById, touchRoomActivity } from "./rooms.ts";

export function normalizeChatText(value: unknown): string | null {
  if (typeof value !== "string" || value.length > CHAT_MAX_LENGTH) return null;
  const text = value.trim();
  return text.length ? text : null;
}

export function listChatMessages(db: DatabaseSync, roomId: string): ChatMessage[] {
  return db.prepare("SELECT messageId, roomId, accountId, displayName, text, createdAt FROM chat_messages WHERE roomId = ? ORDER BY rowid")
    .all(roomId) as unknown as ChatMessage[];
}

// Identity and time come from the server. No message text enters the logs.
export function recordChatMessage(db: DatabaseSync, roomId: string, accountId: string, input: unknown, nowMs = Date.now()): ChatMessage {
  const text = normalizeChatText(input);
  if (text === null) throw new Error(`messages must contain 1–${CHAT_MAX_LENGTH} characters`);
  const room = getRoomById(db, roomId, nowMs);
  if (!room || room.closed) throw new Error("that room has closed");
  const account = getAccountById(db, accountId);
  if (!account) throw new Error("account not found");
  const message: ChatMessage = {
    messageId: randomUUID(), roomId, accountId, displayName: account.displayName,
    text, createdAt: new Date(nowMs).toISOString(),
  };
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO chat_messages (messageId, roomId, accountId, displayName, text, createdAt) VALUES (?, ?, ?, ?, ?, ?)")
      .run(message.messageId, roomId, accountId, message.displayName, text, message.createdAt);
    touchRoomActivity(db, roomId, nowMs);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return message;
}

export class ChatRateLimiter {
  private rooms = new Map<string, Map<string, RateLimitState>>();

  tryConsume(roomId: string, accountId: string, nowMs: number): boolean {
    const accounts = this.rooms.get(roomId) ?? new Map<string, RateLimitState>();
    const result = checkRateLimit(accounts.get(accountId) ?? null, { limit: 8, windowMs: 10_000 }, nowMs);
    accounts.set(accountId, result.state);
    this.rooms.set(roomId, accounts);
    return result.allowed;
  }

  clearRoom(roomId: string): void {
    this.rooms.delete(roomId);
  }
}
