import { describe, expect, it } from "vitest";
import {
  canExecute,
  castVote,
  createProposal,
  isProposalReferenceStale,
  resolveProposal,
  tallyVotes,
  VOTING_WINDOW_MS,
  type Proposal,
} from "../../shared/src/voting.ts";

const CREATED_AT = 1_000_000;

function playbackProposal(overrides: Partial<Parameters<typeof createProposal>[0]> = {}): Proposal {
  return createProposal({
    proposalId: "prop-1",
    proposer: "acct-proposer",
    roomId: "room-1",
    createdAt: CREATED_AT,
    payload: { type: "PLAY" },
    reference: { kind: "playback", playbackId: "pb-1", revision: 3 },
    ...overrides,
  });
}

describe("createProposal", () => {
  it("derives type from the payload rather than taking it as a separate input", () => {
    const proposal = playbackProposal({ payload: { type: "SEEK", positionMs: 12_000 } });
    expect(proposal.type).toBe("SEEK");
    expect(proposal.payload).toEqual({ type: "SEEK", positionMs: 12_000 });
  });

  it("sets expiresAt to createdAt plus the default 15-second voting window", () => {
    const proposal = playbackProposal();
    expect(proposal.expiresAt - proposal.createdAt).toBe(VOTING_WINDOW_MS);
    expect(proposal.expiresAt).toBe(CREATED_AT + 15_000);
  });

  it("honors an explicit votingWindowMs override", () => {
    const proposal = playbackProposal({ votingWindowMs: 5_000 });
    expect(proposal.expiresAt).toBe(CREATED_AT + 5_000);
  });

  it("starts OPEN with no votes cast", () => {
    const proposal = playbackProposal();
    expect(proposal.state).toBe("OPEN");
    expect(proposal.votes).toEqual({});
  });

  it("carries the reference through unchanged", () => {
    const proposal = playbackProposal({ reference: { kind: "playback", playbackId: "pb-9", revision: 7 } });
    expect(proposal.reference).toEqual({ kind: "playback", playbackId: "pb-9", revision: 7 });
  });

  it("accepts a queue reference for REMOVE_QUEUE_ITEM and REORDER_QUEUE", () => {
    const remove = playbackProposal({
      payload: { type: "REMOVE_QUEUE_ITEM", queueItemId: "qi-1" },
      reference: { kind: "queue", queueRevision: 2 },
    });
    expect(remove.type).toBe("REMOVE_QUEUE_ITEM");

    const reorder = playbackProposal({
      payload: { type: "REORDER_QUEUE", queueItemId: "qi-1", beforeQueueItemId: "qi-2" },
      reference: { kind: "queue", queueRevision: 2 },
    });
    expect(reorder.type).toBe("REORDER_QUEUE");
  });

  it("throws when a playback-family proposal carries a queue reference", () => {
    expect(() =>
      playbackProposal({ payload: { type: "PAUSE" }, reference: { kind: "queue", queueRevision: 1 } }),
    ).toThrow(/requires a "playback" reference/);
  });

  it("throws when a queue-family proposal carries a playback reference", () => {
    expect(() =>
      playbackProposal({
        payload: { type: "REMOVE_QUEUE_ITEM", queueItemId: "qi-1" },
        reference: { kind: "playback", playbackId: "pb-1", revision: 1 },
      }),
    ).toThrow(/requires a "queue" reference/);
  });
});

describe("castVote", () => {
  it("records a YES vote before the window closes", () => {
    const proposal = playbackProposal();
    const result = castVote(proposal, "acct-a", "YES", CREATED_AT + 1_000);
    expect(result).toEqual({ ok: true, proposal: { ...proposal, votes: { "acct-a": "YES" } } });
  });

  it("records a NO vote before the window closes", () => {
    const proposal = playbackProposal();
    const result = castVote(proposal, "acct-a", "NO", CREATED_AT + 1_000);
    expect(result.ok).toBe(true);
    expect(result.ok && result.proposal.votes).toEqual({ "acct-a": "NO" });
  });

  it("lets an account change its mind — a second vote replaces the first rather than adding a second one", () => {
    const proposal = playbackProposal();
    const first = castVote(proposal, "acct-a", "YES", CREATED_AT + 1_000);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    const second = castVote(first.proposal, "acct-a", "NO", CREATED_AT + 2_000);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    expect(second.proposal.votes).toEqual({ "acct-a": "NO" });
    expect(Object.keys(second.proposal.votes)).toHaveLength(1);
  });

  it("tracks independent accounts separately", () => {
    const proposal = playbackProposal();
    const afterA = castVote(proposal, "acct-a", "YES", CREATED_AT + 1_000);
    if (!afterA.ok) throw new Error("unreachable");
    const afterB = castVote(afterA.proposal, "acct-b", "NO", CREATED_AT + 1_500);
    if (!afterB.ok) throw new Error("unreachable");
    expect(afterB.proposal.votes).toEqual({ "acct-a": "YES", "acct-b": "NO" });
  });

  it("rejects a vote once the 15-second window has elapsed, even if the proposal is still marked OPEN", () => {
    const proposal = playbackProposal();
    expect(proposal.state).toBe("OPEN");
    const result = castVote(proposal, "acct-a", "YES", proposal.expiresAt);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a vote at the exact expiry boundary (expiresAt itself is already closed)", () => {
    const proposal = playbackProposal();
    const result = castVote(proposal, "acct-a", "YES", proposal.expiresAt);
    expect(result.ok).toBe(false);
  });

  it("accepts a vote one millisecond before expiry", () => {
    const proposal = playbackProposal();
    const result = castVote(proposal, "acct-a", "YES", proposal.expiresAt - 1);
    expect(result.ok).toBe(true);
  });

  it("rejects a vote on a proposal that has already been resolved", () => {
    let proposal = playbackProposal();
    const afterA = castVote(proposal, "acct-a", "YES", CREATED_AT + 1_000);
    const afterB = castVote((afterA as { ok: true; proposal: Proposal }).proposal, "acct-b", "YES", CREATED_AT + 1_000);
    proposal = (afterB as { ok: true; proposal: Proposal }).proposal;
    proposal = resolveProposal(proposal, proposal.expiresAt);
    expect(proposal.state).toBe("PASSED");

    const late = castVote(proposal, "acct-c", "NO", proposal.expiresAt + 1);
    expect(late).toEqual({ ok: false, reason: "not-open" });
  });
});

describe("tallyVotes", () => {
  it("no votes at all: fails, nothing counted", () => {
    expect(tallyVotes({})).toEqual({ yes: 0, no: 0, validVotes: 0, requiredYes: 1, passed: false });
  });

  it("a single YES vote passes when everyone else abstains", () => {
    const tally = tallyVotes({ "acct-a": "YES" });
    expect(tally.validVotes).toBe(1);
    expect(tally.passed).toBe(true);
  });

  it("2 YES / 0 NO passes (meets the minimum and is a strict majority)", () => {
    expect(tallyVotes({ "acct-a": "YES", "acct-b": "YES" })).toEqual({
      yes: 2,
      no: 0,
      validVotes: 2,
      requiredYes: 2,
      passed: true,
    });
  });

  it("an exact tie (1 YES / 1 NO) fails", () => {
    const tally = tallyVotes({ "acct-a": "YES", "acct-b": "NO" });
    expect(tally.requiredYes).toBe(2);
    expect(tally.yes).toBe(1);
    expect(tally.passed).toBe(false);
  });

  it("a larger exact tie (2 YES / 2 NO) also fails", () => {
    const tally = tallyVotes({ a: "YES", b: "YES", c: "NO", d: "NO" });
    expect(tally.requiredYes).toBe(3);
    expect(tally.passed).toBe(false);
  });

  it("2 YES / 1 NO passes (strict majority of 3 valid votes)", () => {
    const tally = tallyVotes({ a: "YES", b: "YES", c: "NO" });
    expect(tally.requiredYes).toBe(2);
    expect(tally.passed).toBe(true);
  });

  it("1 YES / 2 NO fails", () => {
    const tally = tallyVotes({ a: "YES", b: "NO", c: "NO" });
    expect(tally.passed).toBe(false);
  });

  it("accounts that never voted are simply absent — not represented as ABSTAIN entries, and never affect the denominator", () => {
    // A 12-person room where only two people ever respond looks identical
    // to tallyVotes as a 2-person room where both respond — the other ten
    // are abstains purely by never appearing as keys.
    expect(tallyVotes({ a: "YES", b: "YES" })).toEqual(tallyVotes({ a: "YES", b: "YES" }));
    expect(tallyVotes({ a: "YES", b: "YES" }).passed).toBe(true);
  });

  it("a sole NO vote fails", () => {
    expect(tallyVotes({ "acct-a": "NO" }).passed).toBe(false);
  });

});

describe("resolveProposal", () => {
  it("is a no-op before the voting window closes, regardless of votes cast so far", () => {
    const proposal = playbackProposal();
    const afterA = castVote(proposal, "acct-a", "YES", CREATED_AT + 1_000);
    const afterB = castVote((afterA as { ok: true; proposal: Proposal }).proposal, "acct-b", "YES", CREATED_AT + 1_000);
    const open = (afterB as { ok: true; proposal: Proposal }).proposal;

    const resolved = resolveProposal(open, open.expiresAt - 1);
    expect(resolved).toEqual(open);
    expect(resolved.state).toBe("OPEN");
  });

  it("resolves to PASSED at exactly expiresAt when the tally passes", () => {
    const proposal = playbackProposal();
    const afterA = castVote(proposal, "acct-a", "YES", CREATED_AT + 1_000);
    const afterB = castVote((afterA as { ok: true; proposal: Proposal }).proposal, "acct-b", "YES", CREATED_AT + 1_000);
    const open = (afterB as { ok: true; proposal: Proposal }).proposal;

    const resolved = resolveProposal(open, open.expiresAt);
    expect(resolved.state).toBe("PASSED");
  });

  it("resolves to PASSED when only one YES remains at the deadline", () => {
    const proposal = playbackProposal();
    const afterA = castVote(proposal, "acct-a", "YES", CREATED_AT + 1_000);
    const open = (afterA as { ok: true; proposal: Proposal }).proposal;

    const resolved = resolveProposal(open, open.expiresAt + 500);
    expect(resolved.state).toBe("PASSED");
  });

  it("resolves an exact tie to FAILED", () => {
    const proposal = playbackProposal();
    const afterA = castVote(proposal, "acct-a", "YES", CREATED_AT + 1_000);
    const afterB = castVote((afterA as { ok: true; proposal: Proposal }).proposal, "acct-b", "NO", CREATED_AT + 1_000);
    const open = (afterB as { ok: true; proposal: Proposal }).proposal;

    const resolved = resolveProposal(open, open.expiresAt);
    expect(resolved.state).toBe("FAILED");
  });

  it("is idempotent — resolving an already-resolved proposal again returns it unchanged", () => {
    const proposal = playbackProposal();
    const afterA = castVote(proposal, "acct-a", "YES", CREATED_AT + 1_000);
    const afterB = castVote((afterA as { ok: true; proposal: Proposal }).proposal, "acct-b", "YES", CREATED_AT + 1_000);
    const open = (afterB as { ok: true; proposal: Proposal }).proposal;

    const resolvedOnce = resolveProposal(open, open.expiresAt);
    const resolvedTwice = resolveProposal(resolvedOnce, open.expiresAt + 10_000);
    expect(resolvedTwice).toEqual(resolvedOnce);
  });

  it("keeps one YES open until the exact deadline, then passes", () => {
    const proposal = playbackProposal();
    const result = castVote(proposal, "acct-a", "YES", CREATED_AT + 1_000);
    if (!result.ok) throw new Error("unexpected rejection");
    expect(resolveProposal(result.proposal, proposal.expiresAt - 1).state).toBe("OPEN");
    expect(resolveProposal(result.proposal, proposal.expiresAt).state).toBe("PASSED");
  });

});

describe("canExecute", () => {
  it("is false for a still-OPEN proposal", () => {
    expect(canExecute(playbackProposal())).toBe(false);
  });

  it("is false for a FAILED proposal", () => {
    const proposal = playbackProposal();
    const resolved = resolveProposal(proposal, proposal.expiresAt);
    expect(resolved.state).toBe("FAILED");
    expect(canExecute(resolved)).toBe(false);
  });

  it("is true only once a proposal has resolved to PASSED", () => {
    const proposal = playbackProposal();
    const afterA = castVote(proposal, "acct-a", "YES", CREATED_AT + 1_000);
    const afterB = castVote((afterA as { ok: true; proposal: Proposal }).proposal, "acct-b", "YES", CREATED_AT + 1_000);
    const open = (afterB as { ok: true; proposal: Proposal }).proposal;
    const resolved = resolveProposal(open, open.expiresAt);
    expect(resolved.state).toBe("PASSED");
    expect(canExecute(resolved)).toBe(true);
  });

  it("an expired-but-never-resolved proposal cannot execute", () => {
    const proposal = playbackProposal();
    const afterA = castVote(proposal, "acct-a", "YES", CREATED_AT + 1_000);
    const afterB = castVote((afterA as { ok: true; proposal: Proposal }).proposal, "acct-b", "YES", CREATED_AT + 1_000);
    const open = (afterB as { ok: true; proposal: Proposal }).proposal;
    // Note: resolveProposal was never called, so even though this proposal
    // would have passed, it is still sitting OPEN — and OPEN can never execute.
    expect(open.state).toBe("OPEN");
    expect(canExecute(open)).toBe(false);
  });
});

describe("isProposalReferenceStale", () => {
  it("playback reference: not stale when playbackId and revision both still match", () => {
    const ref = { kind: "playback" as const, playbackId: "pb-1", revision: 3 };
    expect(isProposalReferenceStale(ref, { kind: "playback", playbackId: "pb-1", revision: 3 })).toBe(false);
  });

  it("playback reference: stale when playbackId changed (track transition)", () => {
    const ref = { kind: "playback" as const, playbackId: "pb-1", revision: 3 };
    expect(isProposalReferenceStale(ref, { kind: "playback", playbackId: "pb-2", revision: 3 })).toBe(true);
  });

  it("playback reference: stale when revision changed (another rebase landed first)", () => {
    const ref = { kind: "playback" as const, playbackId: "pb-1", revision: 3 };
    expect(isProposalReferenceStale(ref, { kind: "playback", playbackId: "pb-1", revision: 4 })).toBe(true);
  });

  it("queue reference: not stale when queueRevision still matches", () => {
    const ref = { kind: "queue" as const, queueRevision: 5 };
    expect(isProposalReferenceStale(ref, { kind: "queue", queueRevision: 5 })).toBe(false);
  });

  it("queue reference: stale when queueRevision changed (a queue mutation landed first)", () => {
    const ref = { kind: "queue" as const, queueRevision: 5 };
    expect(isProposalReferenceStale(ref, { kind: "queue", queueRevision: 6 })).toBe(true);
  });

  it("treats a mismatched reference kind as stale defensively", () => {
    const ref = { kind: "playback" as const, playbackId: "pb-1", revision: 3 };
    expect(isProposalReferenceStale(ref, { kind: "queue", queueRevision: 3 })).toBe(true);
  });
});
