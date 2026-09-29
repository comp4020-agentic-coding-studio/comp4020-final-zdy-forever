import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Server } from "socket.io";
import {
  canExecute,
  castVote as engineCastVote,
  createProposal,
  isProposalReferenceStale,
  resolveProposal,
  VOTING_WINDOW_MS,
  type Proposal,
  type ProposalPayload,
  type ProposalReference,
  type VoteChoice,
} from "../../shared/src/voting.ts";
import { advanceToNextTrack, getCurrentPlayback, seekPlayback, setPlaybackStatus } from "./playback.ts";

// Wires the pure voting engine (shared/src/voting.ts) to real playback state
// and real-time broadcast for PLAY/PAUSE/SKIP/SEEK — REMOVE_QUEUE_ITEM and
// REORDER_QUEUE are not connected yet. Owns the actual server-side clock: a
// real setTimeout schedules resolution at expiresAt, so the 15-second window
// is enforced by the server regardless of what any client claims about time.
//
// Every broadcast carries { proposal, applied } — `proposal.state` is the
// pure engine's honest verdict (OPEN/PASSED/FAILED), while `applied` says
// whether a PASSED verdict actually got to mutate playback/queue state (it
// may not, if the reference went stale between when the vote opened and when
// it closed).
export interface ProposalBroadcast {
  proposal: Proposal;
  applied: boolean;
}

// Machine-readable code for a request-time rejection a client needs to
// branch on (rather than just display): "only the current DJ may initiate
// Seek" (CLAUDE.md's Voting section) — a client is expected to distinguish
// this from an ordinary validation error.
export type ProposalRequestErrorCode = "NOT_CURRENT_DJ";

export type ProposalOutcome =
  | { ok: true; proposal: Proposal }
  | { ok: false; error: string; code?: ProposalRequestErrorCode };

interface RequestOptions {
  votingWindowMs?: number;
  // SEEK only: the DJ-chosen target position in ms. Never set by a client
  // for any other proposal type.
  positionMs?: number;
}

// One active proposal per room at a time (CLAUDE.md's Reliability section:
// "conflicting proposals") — a second request while one is open is rejected
// outright rather than queued, keeping the model simple and avoiding two
// in-flight proposals ever disagreeing about the same anchor.
export class ProposalManager {
  private active = new Map<string, Proposal>();
  private timers = new Map<string, NodeJS.Timeout>();

  getActiveProposal(roomId: string): Proposal | null {
    return this.active.get(roomId) ?? null;
  }

  requestPlaybackProposal(
    io: Server,
    db: DatabaseSync,
    roomId: string,
    proposerAccountId: string,
    type: "PLAY" | "PAUSE" | "SKIP" | "SEEK",
    options: RequestOptions = {},
  ): ProposalOutcome {
    if (this.active.has(roomId)) {
      return { ok: false, error: "a vote is already in progress in this room" };
    }

    const playback = getCurrentPlayback(db, roomId);
    if (!playback) {
      return { ok: false, error: "nothing is currently playing in this room" };
    }
    if (type === "PLAY" && playback.status === "PLAYING") {
      return { ok: false, error: "already playing" };
    }
    if (type === "PAUSE" && playback.status === "PAUSED") {
      return { ok: false, error: "already paused" };
    }
    // SKIP has no analogous up-front rejection: skipping past the last queue
    // item is a legitimate outcome (advanceToNextTrack simply stops
    // playback), not an error condition worth blocking at request time.

    if (type === "SEEK") {
      // Only the current DJ (the account that added the currently-playing
      // queue item) may initiate a Seek (CLAUDE.md's Voting section) — a
      // typed code lets the client distinguish this from an ordinary
      // validation error rather than just matching an error string.
      if (playback.dj.accountId !== proposerAccountId) {
        return { ok: false, error: "only the current DJ may initiate seek", code: "NOT_CURRENT_DJ" };
      }
      const positionMs = options.positionMs;
      // Duration isn't tracked anywhere in this codebase yet (the YouTube
      // metadata lookup never fetches contentDetails.duration), so "target <=
      // known duration where available" has no known duration to check
      // against right now — only the lower bound is enforced.
      if (typeof positionMs !== "number" || !Number.isFinite(positionMs) || positionMs < 0) {
        return { ok: false, error: "seek target must be a non-negative number of milliseconds" };
      }
    }

    const payload: ProposalPayload = type === "SEEK" ? { type: "SEEK", positionMs: options.positionMs! } : { type };
    const reference: ProposalReference = { kind: "playback", playbackId: playback.playbackId, revision: playback.revision };

    const nowMs = Date.now();
    let proposal = createProposal({
      proposalId: randomUUID(),
      proposer: proposerAccountId,
      roomId,
      createdAt: nowMs,
      payload,
      reference,
      votingWindowMs: options.votingWindowMs ?? VOTING_WINDOW_MS,
    });

    // The proposer implicitly votes YES for the action they just requested —
    // otherwise the person who wanted this would, oddly, have to separately
    // vote for their own proposal to have any chance of the minimum 2
    // non-abstain votes being met.
    const proposerVote = engineCastVote(proposal, proposerAccountId, "YES", nowMs);
    if (proposerVote.ok) proposal = proposerVote.proposal;

    this.active.set(roomId, proposal);
    this.broadcast(io, roomId, proposal, false);

    const timer = setTimeout(() => this.resolveRoom(io, db, roomId), Math.max(0, proposal.expiresAt - nowMs));
    timer.unref?.();
    this.timers.set(roomId, timer);

    return { ok: true, proposal };
  }

  castVote(io: Server, roomId: string, proposalId: string, accountId: string, choice: VoteChoice): ProposalOutcome {
    const proposal = this.active.get(roomId);
    if (!proposal || proposal.proposalId !== proposalId) {
      return { ok: false, error: "no matching active proposal in this room" };
    }

    const result = engineCastVote(proposal, accountId, choice, Date.now());
    if (!result.ok) {
      return {
        ok: false,
        error: result.reason === "expired" ? "voting has already closed" : "this proposal is no longer open",
      };
    }

    this.active.set(roomId, result.proposal);
    this.broadcast(io, roomId, result.proposal, false);
    return { ok: true, proposal: result.proposal };
  }

  // Exposed only so tests can force resolution deterministically instead of
  // waiting on a real setTimeout; production code never needs to call this
  // directly (the scheduled timer does).
  forceResolve(io: Server, db: DatabaseSync, roomId: string): void {
    this.resolveRoom(io, db, roomId);
  }

  // Called when a client reports that its player naturally reached the end
  // of `endedPlaybackId`. Stale/duplicate reports (the room has already
  // moved on — another client's report already advanced it, a SKIP vote
  // already passed, or the reported id is simply wrong) are silently
  // ignored: only a report matching the room's *current* playbackId is
  // trusted. A client can never make up an arbitrary playbackId to force a
  // transition — this only ever advances to whatever is genuinely next.
  //
  // Any proposal open against the ending track (most notably a SKIP vote,
  // but a PLAY/PAUSE vote references the same playback too) is invalidated
  // immediately rather than left to fail on its own 15-second timer: once
  // the track has moved on, that vote can no longer mean anything, and
  // clients should see it end right away rather than have a "voting..." UI
  // linger for up to 15 more seconds after the track it was about has gone.
  handleTrackEnded(io: Server, db: DatabaseSync, roomId: string, endedPlaybackId: string): void {
    const current = getCurrentPlayback(db, roomId);
    if (!current || current.playbackId !== endedPlaybackId) {
      return;
    }
    this.invalidateActive(io, roomId);
    const next = advanceToNextTrack(db, roomId);
    io.to(roomId).emit("playback:update", next);
  }

  // Cancels the room's pending resolution timer and marks its open proposal
  // FAILED without ever attempting to execute it — used when the state a
  // proposal referenced has been overtaken by something outside the normal
  // vote-then-resolve path (see handleTrackEnded). A no-op if no proposal is
  // open in the room.
  private invalidateActive(io: Server, roomId: string): void {
    const timer = this.timers.get(roomId);
    if (timer) clearTimeout(timer);
    this.timers.delete(roomId);

    const proposal = this.active.get(roomId);
    if (!proposal) return;
    this.active.delete(roomId);

    this.broadcast(io, roomId, { ...proposal, state: "FAILED" }, false);
  }

  // Cancels every pending resolution timer without touching the database or
  // broadcasting anything. Test-only: a test that closes its scratch
  // database while a proposal is still mid-vote must call this first, or the
  // still-pending setTimeout fires later against an already-closed database.
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.active.clear();
  }

  private resolveRoom(io: Server, db: DatabaseSync, roomId: string): void {
    const timer = this.timers.get(roomId);
    if (timer) clearTimeout(timer);
    this.timers.delete(roomId);

    const proposal = this.active.get(roomId);
    if (!proposal) return;
    this.active.delete(roomId);

    const resolved = resolveProposal(proposal, Date.now());

    if (!canExecute(resolved)) {
      this.broadcast(io, roomId, resolved, false);
      return;
    }

    // Never partially apply a passed vote against playback state it no
    // longer describes — something else (another anchor rebase, a track
    // transition) must have landed first.
    const currentRef = this.currentPlaybackReference(db, roomId);
    if (!currentRef || isProposalReferenceStale(resolved.reference, currentRef)) {
      this.broadcast(io, roomId, resolved, false);
      return;
    }

    if (resolved.type === "SKIP") {
      // advanceToNextTrack returning null just means the queue is now empty
      // (playback stops) — that is a successful skip, not a failure to
      // apply, so applied is unconditionally true once we get this far.
      const next = advanceToNextTrack(db, roomId);
      this.broadcast(io, roomId, resolved, true);
      io.to(roomId).emit("playback:update", next);
      return;
    }

    if (resolved.type === "SEEK") {
      // resolved.payload.type === "SEEK" is guaranteed here (payload.type and
      // proposal.type are set together in createProposal and never diverge),
      // but TS can't see through the reference cell, so this reads it back
      // narrowed.
      const positionMs = resolved.payload.type === "SEEK" ? resolved.payload.positionMs : 0;
      const updated = seekPlayback(db, roomId, positionMs);
      this.broadcast(io, roomId, resolved, updated !== null);
      if (updated) {
        io.to(roomId).emit("playback:update", updated);
      }
      return;
    }

    const status = resolved.type === "PLAY" ? "PLAYING" : "PAUSED";
    const updated = setPlaybackStatus(db, roomId, status);
    this.broadcast(io, roomId, resolved, updated !== null);
    if (updated) {
      io.to(roomId).emit("playback:update", updated);
    }
  }

  private currentPlaybackReference(db: DatabaseSync, roomId: string): ProposalReference | null {
    const playback = getCurrentPlayback(db, roomId);
    if (!playback) return null;
    return { kind: "playback", playbackId: playback.playbackId, revision: playback.revision };
  }

  private broadcast(io: Server, roomId: string, proposal: Proposal, applied: boolean): void {
    const payload: ProposalBroadcast = { proposal, applied };
    io.to(roomId).emit("proposal:update", payload);
  }
}
