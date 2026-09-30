// Pure, framework-free proposal/voting engine shared between server and
// client. This file only models the *voting mechanism itself* — creating a
// proposal, casting ballots, tallying, and deciding whether one may execute.
// It knows nothing about Socket.IO, the database, or how a PASSED proposal
// actually mutates playback/queue state — server/src/proposals.ts wires real
// PLAY/PAUSE/SKIP/SEEK/REMOVE_QUEUE_ITEM/REORDER_QUEUE side effects to a
// passed proposal (see CLAUDE.md's Voting section for the rules this encodes).
//
// All timestamps are epoch milliseconds (like playbackSync.ts's
// anchorServerTimeMs), not ISO strings — every function here does ms
// arithmetic against a caller-supplied `nowMs`, never reads the clock
// itself, so the whole engine stays a pure state machine and trivially
// testable without fake timers.

import { isStaleReference } from "./playbackSync.ts";

export type ProposalType = "PLAY" | "PAUSE" | "SKIP" | "SEEK" | "REMOVE_QUEUE_ITEM" | "REORDER_QUEUE";

export type ProposalState = "OPEN" | "PASSED" | "FAILED";

export type VoteChoice = "YES" | "NO";

// Type-specific data a proposal carries. `type` here is what a Proposal's own
// `type` field is derived from (see createProposal) — the two can never
// disagree, because the payload is the only place the type is chosen.
export type ProposalPayload =
  | { type: "PLAY" }
  | { type: "PAUSE" }
  | { type: "SKIP" }
  | { type: "SEEK"; positionMs: number }
  | { type: "REMOVE_QUEUE_ITEM"; queueItemId: string }
  | { type: "REORDER_QUEUE"; queueItemId: string; beforeQueueItemId: string | null };

// The playbackId/revision or queueRevision this proposal was opened against
// (CLAUDE.md: "Proposals must reference relevant playbackId or queue
// revision so stale proposals cannot affect later state"). Every proposal
// type maps to exactly one kind — see referenceKindForType — so execution-
// time code can always tell what "current" shape to compare against.
export type ProposalReference = { kind: "playback"; playbackId: string; revision: number } | { kind: "queue"; queueRevision: number };

const REFERENCE_KIND_BY_TYPE: Record<ProposalType, ProposalReference["kind"]> = {
  PLAY: "playback",
  PAUSE: "playback",
  SKIP: "playback",
  SEEK: "playback",
  REMOVE_QUEUE_ITEM: "queue",
  REORDER_QUEUE: "queue",
};

export interface Proposal {
  proposalId: string;
  type: ProposalType;
  proposer: string; // accountId
  roomId: string;
  createdAt: number;
  expiresAt: number;
  payload: ProposalPayload;
  reference: ProposalReference;
  state: ProposalState;
  votes: Record<string, VoteChoice>; // accountId -> vote; absent entirely = abstain
}

// The server's proposal:update payload (see server/src/proposals.ts) —
// `proposal.state` is the engine's honest verdict (OPEN/PASSED/FAILED), while
// `applied` says whether a PASSED verdict actually got to mutate playback/
// queue state (it may not, if the reference went stale before it closed).
export interface ProposalBroadcast {
  proposal: Proposal;
  applied: boolean;
}

export const VOTING_WINDOW_MS = 15_000;

export const MIN_NON_ABSTAIN_VOTES = 2;

export interface CreateProposalParams {
  proposalId: string;
  proposer: string;
  roomId: string;
  createdAt: number;
  payload: ProposalPayload;
  reference: ProposalReference;
  votingWindowMs?: number;
}

// Builds a fresh, OPEN proposal with no votes cast yet. `reference.kind` must
// match the payload's type (e.g. a SEEK proposal must carry a "playback"
// reference, never a "queue" one) — a mismatch is a programmer error in the
// caller wiring proposals up to real actions, not a runtime/user-input
// failure, so it throws rather than silently accepting an inconsistent
// proposal.
export function createProposal(params: CreateProposalParams): Proposal {
  const expectedKind = REFERENCE_KIND_BY_TYPE[params.payload.type];
  if (params.reference.kind !== expectedKind) {
    throw new Error(
      `proposal type ${params.payload.type} requires a "${expectedKind}" reference, got "${params.reference.kind}"`,
    );
  }

  const votingWindowMs = params.votingWindowMs ?? VOTING_WINDOW_MS;
  return {
    proposalId: params.proposalId,
    type: params.payload.type,
    proposer: params.proposer,
    roomId: params.roomId,
    createdAt: params.createdAt,
    expiresAt: params.createdAt + votingWindowMs,
    payload: params.payload,
    reference: params.reference,
    state: "OPEN",
    votes: {},
  };
}

export type CastVoteResult = { ok: true; proposal: Proposal } | { ok: false; reason: "not-open" | "expired" };

// Records `accountId`'s ballot. A second call from the same account replaces
// their earlier vote rather than adding a second one — "one account gets one
// vote" means one vote counts per account, not that an account's first vote
// is locked in forever. Rejects outright once the 15-second window has
// elapsed, even if resolveProposal hasn't been called yet to flip the state
// to PASSED/FAILED — the deadline is enforced here independently of that.
export function castVote(proposal: Proposal, accountId: string, vote: VoteChoice, nowMs: number): CastVoteResult {
  if (proposal.state !== "OPEN") {
    return { ok: false, reason: "not-open" };
  }
  if (nowMs >= proposal.expiresAt) {
    return { ok: false, reason: "expired" };
  }
  return {
    ok: true,
    proposal: { ...proposal, votes: { ...proposal.votes, [accountId]: vote } },
  };
}

export interface VoteTally {
  yes: number;
  no: number;
  validVotes: number; // yes + no; accounts that never voted are abstains and are excluded entirely
  requiredYes: number;
  passed: boolean;
}

// ABSTAIN is modelled as "no entry in votes", so accounts who never respond
// are simply absent here — there's nothing to exclude, they were never
// counted in the first place. floor(validVotes / 2) + 1 is a strict
// majority of non-abstain votes, so an exact tie (e.g. 2 YES / 2 NO) always
// fails without needing a separate tie-check.
export function tallyVotes(votes: Record<string, VoteChoice>): VoteTally {
  let yes = 0;
  let no = 0;
  for (const choice of Object.values(votes)) {
    if (choice === "YES") yes++;
    else no++;
  }
  const validVotes = yes + no;
  const requiredYes = Math.floor(validVotes / 2) + 1;
  const passed = validVotes >= MIN_NON_ABSTAIN_VOTES && yes >= requiredYes;
  return { yes, no, validVotes, requiredYes, passed };
}

// Closes voting once the window has elapsed, deciding PASSED/FAILED from the
// votes cast so far. A no-op (returns the same proposal unchanged) both
// before expiresAt (too early — the full 15 seconds must run) and once
// already resolved (idempotent — safe to call repeatedly, e.g. from a
// periodic sweep, without double-deciding a proposal).
export function resolveProposal(proposal: Proposal, nowMs: number): Proposal {
  if (proposal.state !== "OPEN") return proposal;
  if (nowMs < proposal.expiresAt) return proposal;

  const tally = tallyVotes(proposal.votes);
  return { ...proposal, state: tally.passed ? "PASSED" : "FAILED" };
}

// A proposal may execute only once resolved to PASSED. Since resolveProposal
// only ever produces PASSED after the voting window has actually closed with
// a strict non-abstain majority, this single check is what makes "an expired
// proposal cannot execute" automatic: a proposal that expired without ever
// being resolved is still OPEN (not PASSED), and one resolved to FAILED
// (whether from too few votes or a tie) is not PASSED either.
export function canExecute(proposal: Proposal): boolean {
  return proposal.state === "PASSED";
}

// True if `current` (the authoritative state at the moment a PASSED
// proposal would actually execute) no longer matches what the proposal was
// opened against — a track transition, another anchor rebase, or a queue
// mutation landed first. A stale proposal must be rejected outright, never
// partially applied. Mismatched kinds (e.g. comparing a "queue" reference
// against a "playback" current state) are treated as stale defensively;
// this should never happen if callers pair reference kinds with proposal
// types via REFERENCE_KIND_BY_TYPE (enforced in createProposal).
export function isProposalReferenceStale(reference: ProposalReference, current: ProposalReference): boolean {
  if (reference.kind === "playback" && current.kind === "playback") {
    return isStaleReference(current, reference);
  }
  if (reference.kind === "queue" && current.kind === "queue") {
    return current.queueRevision !== reference.queueRevision;
  }
  return true;
}
