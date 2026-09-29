import type { PresenceEntry } from "../../shared/src/types.ts";

interface SocketRecord {
  accountId: string;
  displayName: string;
}

// Tracks which sockets are currently in which rooms, purely in memory —
// presence is ephemeral by design and is never written to SQLite (see
// CLAUDE.md's Persistence section: "Do not persist socket IDs or transient
// UI state"). Kept free of any Socket.IO/network dependency so it's directly
// unit-testable.
//
// One account may hold several simultaneous sockets in the same room (e.g.
// two browser tabs): that is allowed, but the account only ever counts as
// "present" once. It becomes absent only when its last socket in that room
// is gone — that is the explicit duplicate-tab behaviour.
export class PresenceStore {
  private rooms = new Map<string, Map<string, SocketRecord>>();

  // Every accountId that has ever become present in a room during this
  // process's lifetime — purely in-memory, never persisted (same rule as
  // `rooms` above). Used only to tell a genuinely first-ever join in a room
  // apart from a reconnect/late join by an account this process has already
  // seen there (see the "returning" field below), which the socket layer
  // logs as RECONNECT rather than ROOM_JOIN (server/src/realtime.ts).
  private everPresent = new Map<string, Set<string>>();

  join(roomId: string, socketId: string, record: SocketRecord): { becamePresent: boolean; returning: boolean } {
    let sockets = this.rooms.get(roomId);
    if (!sockets) {
      sockets = new Map();
      this.rooms.set(roomId, sockets);
    }

    const wasPresent = [...sockets.values()].some((s) => s.accountId === record.accountId);
    sockets.set(socketId, record);

    let seen = this.everPresent.get(roomId);
    if (!seen) {
      seen = new Set();
      this.everPresent.set(roomId, seen);
    }
    const returning = seen.has(record.accountId);
    seen.add(record.accountId);

    return { becamePresent: !wasPresent, returning };
  }

  leave(roomId: string, socketId: string): { accountId: string; becameAbsent: boolean } | undefined {
    const sockets = this.rooms.get(roomId);
    if (!sockets) return undefined;

    const record = sockets.get(socketId);
    if (!record) return undefined;

    sockets.delete(socketId);
    const stillPresent = [...sockets.values()].some((s) => s.accountId === record.accountId);
    if (sockets.size === 0) this.rooms.delete(roomId);

    return { accountId: record.accountId, becameAbsent: !stillPresent };
  }

  list(roomId: string): PresenceEntry[] {
    const sockets = this.rooms.get(roomId);
    if (!sockets) return [];

    const byAccount = new Map<string, PresenceEntry>();
    for (const record of sockets.values()) {
      if (!byAccount.has(record.accountId)) {
        byAccount.set(record.accountId, { accountId: record.accountId, displayName: record.displayName });
      }
    }
    return [...byAccount.values()];
  }
}
