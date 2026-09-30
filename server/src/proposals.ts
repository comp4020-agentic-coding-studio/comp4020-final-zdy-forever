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
  type ProposalBroadcast,
  type ProposalPayload,
  type ProposalReference,
  type VoteChoice,
} from "../../shared/src/voting.ts";
import { isPlausibleTrackEnd } from "../../shared/src/playbackSync.ts";
import { logAction } from "./logging.ts";
import { advanceToNextTrack, getCurrentPlayback, seekPlayback, setPlaybackStatus } from "./playback.ts";
import {
  getQueueItemById,
  getQueueRevision,
  previewReorderQueue,
  removeQueueItem,
  reorderQueueItem,
} from "./queue.ts";
import { broadcastReactionHistory } from "./reactions.ts";
import { touchRoomActivity } from "./rooms.ts";

// Wires the pure voting engine (shared/src/voting.ts) to real playback/queue
// state and real-time broadcast for PLAY/PAUSE/SKIP/SEEK/REMOVE_QUEUE_ITEM/
// REORDER_QUEUE. Owns the actual server-side clock: a real setTimeout
// schedules resolution at expiresAt, so the 15-second window is enforced by
// the server regardless of what any client claims about time.
//
// Every broadcast carries { proposal, applied } — see ProposalBroadcast in
// shared/src/voting.ts, where it lives so the client can type it too.
export type { ProposalBroadcast };

// Machine-readable codes for request-time rejections a client needs to
// branch on (rather than just display): "only the current DJ may initiate
// Seek" (CLAUDE.md's Voting section), a request to remove the room's
// currently-playing queue item (see the "Current-track removal" comment on
// requestPlaybackProposal below), a REORDER_QUEUE drag that would produce no
// real change (re-verified right now, before ever opening a vote over it),
// and one that would put a track somewhere it may not go (see queue.ts's
// placementAllowed) — a client is expected to distinguish all of these from
// an ordinary validation error.
export type ProposalRequestErrorCode = "NOT_CURRENT_DJ" | "IS_CURRENT_TRACK" | "NO_OP" | "MOVE_NOT_ALLOWED";

export type ProposalOutcome =
  | { ok: true; proposal: Proposal }
  | { ok: false; error: string; code?: ProposalRequestErrorCode };

interface RequestOptions {
  votingWindowMs?: number;
  // SEEK only: the DJ-chosen target position in ms. Never set by a client
  // for any other proposal type.
  positionMs?: number;
  // REMOVE_QUEUE_ITEM/REORDER_QUEUE only: the target item's stable id. Never
  // a position/index — see CLAUDE.md's Queue and DJ section ("never use
  // array index as identity").
  queueItemId?: string;
  // REORDER_QUEUE only: the stable id of the item the dragged item should
  // land before, or null to mean "move to the end of the queue."
  beforeQueueItemId?: string | null;
  // How many accounts are in the room right now, the proposer included (set
  // by the realtime layer from live presence). See openProposal: with nobody
  // but the proposer there, the proposal passes at once.
  presentCount?: number;
}

// One active proposal per room at a time (CLAUDE.md's Reliability section:
// "conflicting proposals") — a second request while one is open is rejected
// outright rather than queued, keeping the model simple and avoiding two
// in-flight proposals ever disagreeing about the same anchor.
export class ProposalManager {
  private active = new Map<string, Proposal>();
  private timers = new Map<string, NodeJS.Timeout>();
  // Which accounts have reported the current track of a room ended, for a
  // track of unknown length (see handleTrackEnded). In-memory only, like the
  // proposals themselves: after a restart everything recovers PAUSED, so no
  // pending report could still be meaningful.
  private endReports = new Map<string, { key: string; accountIds: Set<string> }>();

  getActiveProposal(roomId: string): Proposal | null {
    return this.active.get(roomId) ?? null;
  }

  requestPlaybackProposal(
    io: Server,
    db: DatabaseSync,
    roomId: string,
    proposerAccountId: string,
    type: "PLAY" | "PAUSE" | "SKIP" | "SEEK" | "REMOVE_QUEUE_ITEM" | "REORDER_QUEUE",
    options: RequestOptions = {},
  ): ProposalOutcome {
    if (this.active.has(roomId)) {
      return { ok: false, error: "a vote is already in progress in this room" };
    }

    // REMOVE_QUEUE_ITEM and REORDER_QUEUE are queue-kind, not playback-kind
    // (see the "Current-track removal" comment above requestRemoveQueueItem)
    // — neither requires anything currently playing, so both branch off
    // before the playback-kind checks below.
    if (type === "REMOVE_QUEUE_ITEM") {
      return this.requestRemoveQueueItem(io, db, roomId, proposerAccountId, options);
    }
    if (type === "REORDER_QUEUE") {
      return this.requestReorderQueue(io, db, roomId, proposerAccountId, options);
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
      if (typeof positionMs !== "number" || !Number.isFinite(positionMs) || positionMs < 0) {
        return { ok: false, error: "seek target must be a non-negative number of milliseconds" };
      }
      // "target <= known duration where available" — a track added before
      // durations were recorded (or a live stream) has none to check.
      if (playback.durationMs !== null && positionMs > playback.durationMs) {
        return { ok: false, error: "seek target is past the end of the track" };
      }
    }

    const payload: ProposalPayload = type === "SEEK" ? { type: "SEEK", positionMs: options.positionMs! } : { type };
    const reference: ProposalReference = { kind: "playback", playbackId: playback.playbackId, revision: playback.revision };
    return this.openProposal(io, db, roomId, proposerAccountId, payload, reference, options);
  }

  // Current-track removal: REMOVE_QUEUE_ITEM may never target the room's
  // currently-playing queue item. Moving off the current track is SKIP's job
  // — it's a playback-state transition (track advance, DJ handoff, anchor
  // reset), backed by SKIP's own playback-kind reference/staleness
  // protection. Letting a queue-kind proposal also mutate playback state
  // would mean one proposal is staleness-checked against only one of the two
  // reference kinds it actually touches, weakening the "a stale vote can
  // never partially apply" invariant this whole module depends on. So this is
  // rejected outright, twice: here, at request time (typed "IS_CURRENT_TRACK"
  // so the client can distinguish it from an ordinary validation error), and
  // again, defensively, inside queue.ts's removeQueueItem itself at execution
  // time — structurally unreachable there given the one-active-proposal-per-
  // room invariant plus handleTrackEnded's invalidation of any open proposal
  // on a natural track end, but checked anyway per this codebase's
  // established defense-in-depth style.
  private requestRemoveQueueItem(
    io: Server,
    db: DatabaseSync,
    roomId: string,
    proposerAccountId: string,
    options: RequestOptions,
  ): ProposalOutcome {
    const queueItemId = options.queueItemId;
    if (!queueItemId) {
      return { ok: false, error: "queueItemId is required" };
    }

    const item = getQueueItemById(db, roomId, queueItemId);
    if (!item) {
      return { ok: false, error: "no such queue item in this room" };
    }

    const playback = getCurrentPlayback(db, roomId);
    if (playback && playback.queueItemId === queueItemId) {
      return {
        ok: false,
        error: "cannot remove the currently-playing track — use skip instead",
        code: "IS_CURRENT_TRACK",
      };
    }

    const reference: ProposalReference = { kind: "queue", queueRevision: getQueueRevision(db, roomId) };
    return this.openProposal(
      io,
      db,
      roomId,
      proposerAccountId,
      { type: "REMOVE_QUEUE_ITEM", queueItemId },
      reference,
      options,
    );
  }

  // REORDER_QUEUE is queue-kind, like REMOVE_QUEUE_ITEM — it never requires
  // anything currently playing. There is no limit on how often anyone may
  // reorder (docs/adr/0005): the vote is the only gate. previewReorderQueue
  // re-verifies, right now, that this drag would actually change the queue
  // order — a drag dropped back onto its original position (or its own
  // current successor) is rejected as NO_OP — and that the track may go
  // there at all (MOVE_NOT_ALLOWED: see queue.ts's placementAllowed), rather
  // than spending a 15-second vote on an outcome that could only resolve as
  // a no-op.
  private requestReorderQueue(
    io: Server,
    db: DatabaseSync,
    roomId: string,
    proposerAccountId: string,
    options: RequestOptions,
  ): ProposalOutcome {
    const queueItemId = options.queueItemId;
    if (!queueItemId) {
      return { ok: false, error: "queueItemId is required" };
    }
    const beforeQueueItemId = options.beforeQueueItemId ?? null;

    const item = getQueueItemById(db, roomId, queueItemId);
    if (!item) {
      return { ok: false, error: "no such queue item in this room" };
    }
    if (beforeQueueItemId !== null && !getQueueItemById(db, roomId, beforeQueueItemId)) {
      return { ok: false, error: "no such target queue item in this room" };
    }

    const rejection = previewReorderQueue(db, roomId, queueItemId, beforeQueueItemId);
    if (rejection === "not-allowed") {
      return {
        ok: false,
        error:
          "the playing track can't move, a played one can only move down, and one still to come can't move above the playing track",
        code: "MOVE_NOT_ALLOWED",
      };
    }
    if (rejection) {
      return { ok: false, error: "this would not change the queue order", code: "NO_OP" };
    }

    const reference: ProposalReference = { kind: "queue", queueRevision: getQueueRevision(db, roomId) };
    return this.openProposal(
      io,
      db,
      roomId,
      proposerAccountId,
      { type: "REORDER_QUEUE", queueItemId, beforeQueueItemId },
      reference,
      options,
    );
  }

  // Shared "create + auto-YES-vote + schedule resolution + broadcast" logic
  // for every proposal type, playback-kind or queue-kind alike — the only
  // difference between callers is what payload/reference they open with.
  private openProposal(
    io: Server,
    db: DatabaseSync,
    roomId: string,
    proposerAccountId: string,
    payload: ProposalPayload,
    reference: ProposalReference,
    options: RequestOptions,
  ): ProposalOutcome {
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

    // "proposal create" is meaningful activity (CLAUDE.md's Rooms section),
    // regardless of proposal type. It's the only DB write here, so it goes
    // first: if it throws, no proposal has been opened, broadcast or timed.
    touchRoomActivity(db, roomId, nowMs);

    // A sole listener's proposal passes at once (docs/adr/0004): with
    // nobody else in the room, no vote could ever reach the 2 non-abstain
    // votes it needs, so a room left with one person — after a server
    // restart paused it, say — could never be played, skipped or reordered
    // again. Everything checked before this point still holds (DJ-only Seek,
    // no-op reorders, ...), and it's applied exactly like a vote that passed.
    if (options.presentCount === 1) {
      logAction(
        db,
        { action: "PROPOSAL_CREATE", result: "ok", roomId, accountId: proposerAccountId, proposalId: proposal.proposalId, detail: `${payload.type} (sole listener)` },
        nowMs,
      );
      const passed: Proposal = { ...proposal, state: "PASSED" };
      this.applyPassed(io, db, roomId, passed);
      return { ok: true, proposal: passed };
    }

    this.active.set(roomId, proposal);
    this.broadcast(io, roomId, proposal, false);

    const timer = setTimeout(() => this.resolveRoom(io, db, roomId), Math.max(0, proposal.expiresAt - nowMs));
    timer.unref?.();
    this.timers.set(roomId, timer);

    logAction(
      db,
      { action: "PROPOSAL_CREATE", result: "ok", roomId, accountId: proposerAccountId, proposalId: proposal.proposalId, detail: payload.type },
      nowMs,
    );

    return { ok: true, proposal };
  }

  castVote(
    io: Server,
    db: DatabaseSync,
    roomId: string,
    proposalId: string,
    accountId: string,
    choice: VoteChoice,
  ): ProposalOutcome {
    const proposal = this.active.get(roomId);
    if (!proposal || proposal.proposalId !== proposalId) {
      return { ok: false, error: "no matching active proposal in this room" };
    }

    const nowMs = Date.now();
    const result = engineCastVote(proposal, accountId, choice, nowMs);
    if (!result.ok) {
      return {
        ok: false,
        error: result.reason === "expired" ? "voting has already closed" : "this proposal is no longer open",
      };
    }

    // "vote" is meaningful activity (CLAUDE.md's Rooms section) — written
    // before the ballot is recorded, so a failed write never half-counts it.
    touchRoomActivity(db, roomId, nowMs);
    this.active.set(roomId, result.proposal);
    this.broadcast(io, roomId, result.proposal, false);
    logAction(db, { action: "VOTE_CAST", result: "ok", roomId, accountId, proposalId, detail: choice }, nowMs);
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
  //
  // Otherwise any one client could skip the track for everyone with no vote,
  // just by dragging the visible player's own scrubber to the end. So:
  //
  // - With a known length, a report is believed only once the room's own
  //   anchor says the track can be over (isPlausibleTrackEnd), and the first
  //   such report advances the room.
  // - With no known length (a live stream, or a track queued before lengths
  //   were recorded) there's nothing to check against, so it takes reports
  //   from a strict majority of the accounts present — the same kind of
  //   majority a vote needs. Every listener's player reaches the end, so
  //   this costs a genuine end nothing but the slowest of that majority,
  //   while one client alone can no longer force it. Reports count per
  //   (playbackId, revision): a pause or seek re-anchors everyone, so
  //   earlier reports no longer say anything about where the track is.
  handleTrackEnded(
    io: Server,
    db: DatabaseSync,
    roomId: string,
    endedPlaybackId: string,
    report: { accountId: string; presentCount: number },
  ): void {
    const current = getCurrentPlayback(db, roomId);
    if (!current || current.playbackId !== endedPlaybackId) {
      return;
    }
    const rejectedAs = (result: string, detail = "track-ended") =>
      logAction(db, {
        action: "PLAYBACK_CHANGE",
        result,
        roomId,
        accountId: report.accountId,
        playbackId: current.playbackId,
        revision: current.revision,
        detail,
      });
    if (current.durationMs === null) {
      const key = `${current.playbackId}:${current.revision}`;
      let reports = this.endReports.get(roomId);
      if (!reports || reports.key !== key) {
        reports = { key, accountIds: new Set() };
        this.endReports.set(roomId, reports);
      }
      reports.accountIds.add(report.accountId);
      const needed = Math.floor(Math.max(1, report.presentCount) / 2) + 1;
      if (reports.accountIds.size < needed) {
        rejectedAs("awaiting-end-reports", `${reports.accountIds.size}/${needed}`);
        return;
      }
    } else if (!isPlausibleTrackEnd(current, Date.now())) {
      rejectedAs("rejected-early-end");
      return;
    }
    this.endReports.delete(roomId);
    this.invalidateActive(io, roomId);
    const next = advanceToNextTrack(db, roomId);
    io.to(roomId).emit("playback:update", next);
    if (next) broadcastReactionHistory(io, db, roomId, next.videoId);
    logAction(db, {
      action: "PLAYBACK_CHANGE",
      result: "ok",
      roomId,
      playbackId: next?.playbackId,
      revision: next?.revision,
      detail: "track-ended",
    });
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

  // The room has closed (see realtime.ts): any vote still open there fails
  // right away instead of resolving into a room nobody is in any more.
  closeRoom(io: Server, roomId: string): void {
    this.invalidateActive(io, roomId);
    this.endReports.delete(roomId);
  }

  // Cancels every pending resolution timer without touching the database or
  // broadcasting anything. Test-only: a test that closes its scratch
  // database while a proposal is still mid-vote must call this first, or the
  // still-pending setTimeout fires later against an already-closed database.
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.active.clear();
    this.endReports.clear();
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
      logAction(db, {
        action: "PROPOSAL_FAIL",
        result: "ok",
        roomId,
        proposalId: resolved.proposalId,
        accountId: resolved.proposer,
        detail: resolved.type,
      });
      this.broadcast(io, roomId, resolved, false);
      return;
    }

    this.applyPassed(io, db, roomId, resolved);
  }

  // Applies a PASSED proposal — one whose vote passed (resolveRoom), or a
  // sole listener's (openProposal).
  private applyPassed(io: Server, db: DatabaseSync, roomId: string, resolved: Proposal): void {
    logAction(db, {
      action: "PROPOSAL_PASS",
      result: "ok",
      roomId,
      proposalId: resolved.proposalId,
      accountId: resolved.proposer,
      detail: resolved.type,
    });

    // A passed vote's execution touches the DB and can throw (a write
    // failure, a full disk, ...). This runs from a real setTimeout callback
    // in production, so an uncaught throw here would be an uncaught
    // exception that crashes the entire process — every room, not just this
    // one. Treat any such failure the same as a vote that passed but whose
    // reference went stale: report it honestly as PASSED-but-not-applied and
    // let the room carry on.
    try {
      this.executePassedProposal(io, db, roomId, resolved);
    } catch (err) {
      console.error(`proposal ${resolved.proposalId} passed but failed to apply in room ${roomId}:`, err);
      const action =
        resolved.type === "REMOVE_QUEUE_ITEM" ? "QUEUE_REMOVE" : resolved.type === "REORDER_QUEUE" ? "QUEUE_REORDER" : "PLAYBACK_CHANGE";
      logAction(db, {
        action,
        result: "error",
        roomId,
        proposalId: resolved.proposalId,
        accountId: resolved.proposer,
        detail: resolved.type,
      });
      this.broadcast(io, roomId, resolved, false);
    }
  }

  private executePassedProposal(io: Server, db: DatabaseSync, roomId: string, resolved: Proposal): void {
    // Never partially apply a passed vote against state it no longer
    // describes — something else (another anchor rebase, a track transition,
    // a concurrent removal) must have landed first. The current reference
    // must be built with the *same* kind as what this proposal referenced
    // (playback for PLAY/PAUSE/SKIP/SEEK, queue for REMOVE_QUEUE_ITEM) —
    // isProposalReferenceStale treats any kind mismatch as automatically
    // stale, so comparing against the wrong kind would make every
    // REMOVE_QUEUE_ITEM proposal appear stale and never execute.
    const currentRef = this.currentReferenceFor(db, roomId, resolved.reference);
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
      if (next) broadcastReactionHistory(io, db, roomId, next.videoId);
      // "successful shared playback action" is meaningful activity
      // (CLAUDE.md's Rooms section) — a successful SKIP unconditionally.
      touchRoomActivity(db, roomId);
      logAction(db, {
        action: "PLAYBACK_CHANGE",
        result: "ok",
        roomId,
        proposalId: resolved.proposalId,
        playbackId: next?.playbackId,
        revision: next?.revision,
        detail: "skip",
      });
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
        // "successful shared playback action" is meaningful activity.
        touchRoomActivity(db, roomId);
        logAction(db, {
          action: "PLAYBACK_CHANGE",
          result: "ok",
          roomId,
          proposalId: resolved.proposalId,
          playbackId: updated.playbackId,
          revision: updated.revision,
          detail: "seek",
        });
      }
      return;
    }

    if (resolved.type === "REMOVE_QUEUE_ITEM") {
      // resolved.payload.type === "REMOVE_QUEUE_ITEM" is guaranteed here for
      // the same reason as the SEEK narrowing above.
      const queueItemId = resolved.payload.type === "REMOVE_QUEUE_ITEM" ? resolved.payload.queueItemId : "";
      const result = removeQueueItem(db, roomId, queueItemId);
      this.broadcast(io, roomId, resolved, result.removed);
      if (result.removed) {
        io.to(roomId).emit("queue:itemRemoved", { queueItemId });
        logAction(db, {
          action: "QUEUE_REMOVE",
          result: "ok",
          roomId,
          proposalId: resolved.proposalId,
          revision: getQueueRevision(db, roomId),
          detail: queueItemId,
        });
      }
      return;
    }

    if (resolved.type === "REORDER_QUEUE") {
      // resolved.payload.type === "REORDER_QUEUE" is guaranteed here for the
      // same reason as the SEEK narrowing above.
      const queueItemId = resolved.payload.type === "REORDER_QUEUE" ? resolved.payload.queueItemId : "";
      const beforeQueueItemId = resolved.payload.type === "REORDER_QUEUE" ? resolved.payload.beforeQueueItemId : null;
      const result = reorderQueueItem(db, roomId, queueItemId, beforeQueueItemId);
      this.broadcast(io, roomId, resolved, result.reordered);
      if (result.reordered) {
        io.to(roomId).emit("queue:reordered", { queue: result.queue });
        // "successful reorder" is meaningful activity (CLAUDE.md's Rooms
        // section) — only a genuine reorder, never a stale/no-op attempt.
        touchRoomActivity(db, roomId);
        logAction(db, {
          action: "QUEUE_REORDER",
          result: "ok",
          roomId,
          proposalId: resolved.proposalId,
          revision: getQueueRevision(db, roomId),
          detail: queueItemId,
        });
      }
      return;
    }

    const status = resolved.type === "PLAY" ? "PLAYING" : "PAUSED";
    const updated = setPlaybackStatus(db, roomId, status);
    this.broadcast(io, roomId, resolved, updated !== null);
    if (updated) {
      io.to(roomId).emit("playback:update", updated);
      // "successful shared playback action" is meaningful activity.
      touchRoomActivity(db, roomId);
      logAction(db, {
        action: "PLAYBACK_CHANGE",
        result: "ok",
        roomId,
        proposalId: resolved.proposalId,
        playbackId: updated.playbackId,
        revision: updated.revision,
        detail: resolved.type,
      });
    }
  }

  // Returns a *current* reference of the same kind as `reference` — playback
  // for a playback-kind reference, queue for a queue-kind one — so the
  // staleness comparison in resolveRoom always compares like with like (see
  // the comment at that call site for why a kind mismatch would otherwise be
  // fatal to every REMOVE_QUEUE_ITEM proposal).
  private currentReferenceFor(db: DatabaseSync, roomId: string, reference: ProposalReference): ProposalReference | null {
    if (reference.kind === "queue") {
      return { kind: "queue", queueRevision: getQueueRevision(db, roomId) };
    }
    const playback = getCurrentPlayback(db, roomId);
    if (!playback) return null;
    return { kind: "playback", playbackId: playback.playbackId, revision: playback.revision };
  }

  private broadcast(io: Server, roomId: string, proposal: Proposal, applied: boolean): void {
    const payload: ProposalBroadcast = { proposal, applied };
    io.to(roomId).emit("proposal:update", payload);
  }
}
