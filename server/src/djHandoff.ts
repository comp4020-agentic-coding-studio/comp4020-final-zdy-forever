import { randomInt, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DjHandoff, PlaybackState } from "../../shared/src/types.ts";
import { getCurrentPlayback } from "./playback.ts";
import { PresenceStore } from "./presence.ts";
import { getRoomById, touchRoomActivity } from "./rooms.ts";
import { logAction } from "./logging.ts";

export const DJ_HANDOFF_MS = 10_000;
interface Pending extends DjHandoff {
  accountId: string;
  playbackId: string;
  finishLeaving?: () => void;
  timer: ReturnType<typeof setTimeout>;
}

// Timers and candidates are server-owned. Never change queue attribution,
// and never apply a choice to a different playback after a track transition.
export class DjHandoffManager {
  private pending = new Map<string, Pending>();

  constructor(
    private db: DatabaseSync,
    private presence: PresenceStore,
    private broadcast: (roomId: string, playback: PlaybackState) => void,
  ) {}

  private candidates(roomId: string, accountId: string) {
    return this.presence.list(roomId).filter((person) => person.accountId !== accountId);
  }

  requestLeave(roomId: string, accountId: string, finishLeaving: () => void): DjHandoff | null {
    const current = getCurrentPlayback(this.db, roomId);
    if (!current || current.dj.accountId !== accountId || this.presence.connectionCount(roomId, accountId) > 1) {
      finishLeaving();
      this.reconcile(roomId);
      return null;
    }
    const existing = this.pending.get(roomId);
    if (existing?.finishLeaving) return { requestId: existing.requestId, expiresAt: existing.expiresAt };
    this.clear(roomId);
    const pending = this.schedule(roomId, current, finishLeaving);
    if (this.candidates(roomId, accountId).length <= 1) {
      this.finish(roomId);
      return null;
    }
    return { requestId: pending.requestId, expiresAt: pending.expiresAt };
  }

  choose(roomId: string, accountId: string, requestId: string, targetId: string): boolean {
    const pending = this.pending.get(roomId);
    if (!pending?.finishLeaving || pending.accountId !== accountId || pending.requestId !== requestId) return false;
    if (Date.now() >= pending.expiresAt) {
      this.finish(roomId);
      return false;
    }
    if (!this.candidates(roomId, accountId).some((person) => person.accountId === targetId)) return false;
    this.finish(roomId, targetId);
    return true;
  }

  // Also called after disconnect/join and on a local server sweep: a new
  // track can belong to an adder who already left. Reconnect within the
  // grace window cancels an automatic handoff; another tab retains the role.
  reconcile(roomId: string): void {
    const room = getRoomById(this.db, roomId);
    if (!room || room.closed) { this.clear(roomId); return; }
    const current = getCurrentPlayback(this.db, roomId);
    const pending = this.pending.get(roomId);
    if (pending?.finishLeaving) return;
    if (!current || this.presence.isPresent(roomId, current.dj.accountId)) {
      this.clear(roomId);
      return;
    }
    if (pending?.playbackId === current.playbackId && pending.accountId === current.dj.accountId) return;
    this.clear(roomId);
    const candidates = this.candidates(roomId, current.dj.accountId);
    if (!candidates.length) return;
    this.schedule(roomId, current);
    // A missing socket may just be a refresh/hot reload. Always allow the
    // reconnection grace window, even with one successor. Only an explicit
    // Leave request takes the immediate single-successor path above.
  }

  private schedule(roomId: string, playback: PlaybackState, finishLeaving?: () => void): Pending {
    const pending: Pending = {
      requestId: randomUUID(), accountId: playback.dj.accountId, playbackId: playback.playbackId,
      expiresAt: Date.now() + DJ_HANDOFF_MS, finishLeaving,
      timer: setTimeout(() => {
        try { this.finish(roomId); }
        catch (error) { console.error("DJ handoff failed:", error); }
      }, DJ_HANDOFF_MS),
    };
    pending.timer.unref?.();
    this.pending.set(roomId, pending);
    return pending;
  }

  private finish(roomId: string, targetId?: string): void {
    const pending = this.pending.get(roomId);
    if (!pending) return;
    this.clear(roomId);
    pending.finishLeaving?.();
    const room = getRoomById(this.db, roomId);
    if (!room || room.closed) return;
    const current = getCurrentPlayback(this.db, roomId);
    if (!current || current.playbackId !== pending.playbackId || current.dj.accountId !== pending.accountId ||
        this.presence.isPresent(roomId, pending.accountId)) {
      this.reconcile(roomId);
      return;
    }
    const candidates = this.candidates(roomId, pending.accountId);
    const chosen = candidates.find((person) => person.accountId === targetId) ??
      (candidates.length ? candidates[randomInt(candidates.length)] : undefined);
    if (!chosen) return;
    this.db.prepare("UPDATE room_playback SET djAccountId = ?, revision = revision + 1 WHERE roomId = ? AND playbackId = ?")
      .run(chosen.accountId, roomId, current.playbackId);
    const updated = getCurrentPlayback(this.db, roomId)!;
    touchRoomActivity(this.db, roomId);
    logAction(this.db, { action: "PLAYBACK_CHANGE", result: "ok", roomId,
      playbackId: current.playbackId, revision: updated.revision, accountId: chosen.accountId, detail: "dj-handoff" });
    this.broadcast(roomId, updated);
  }

  clear(roomId: string): void {
    const pending = this.pending.get(roomId);
    if (pending) clearTimeout(pending.timer);
    this.pending.delete(roomId);
  }

  dispose(): void {
    for (const roomId of this.pending.keys()) this.clear(roomId);
  }
}
