import { describe, expect, it } from "vitest";
import { createProposal, type Proposal, type ProposalState } from "../../shared/src/voting.ts";
import { applyProposalUpdate, EMPTY_PROPOSAL_VIEW, proposalViewFromSnapshot } from "./proposalView.ts";

function proposal(proposalId: string, state: ProposalState = "OPEN"): Proposal {
  const open = createProposal({
    proposalId,
    proposer: "account-a",
    roomId: "room-1",
    createdAt: 0,
    payload: { type: "PAUSE" },
    reference: { kind: "playback", playbackId: "playback-1", revision: 1 },
  });
  return { ...open, state };
}

describe("applyProposalUpdate", () => {
  it("treats an OPEN broadcast as the active proposal", () => {
    const view = applyProposalUpdate(EMPTY_PROPOSAL_VIEW, { proposal: proposal("p1"), applied: false });
    expect(view.active?.proposalId).toBe("p1");
    expect(view.lastResult).toBeNull();
  });

  // Regression: a resolved proposal used to stay "active", so the vote panel
  // kept showing it instead of the Play/Pause/Skip/Seek controls — and no
  // further playback vote could ever be requested without reconnecting.
  it("clears the active proposal once it resolves, keeping the verdict as the last result", () => {
    const opened = applyProposalUpdate(EMPTY_PROPOSAL_VIEW, { proposal: proposal("p1"), applied: false });
    for (const state of ["PASSED", "FAILED"] as const) {
      const resolved = applyProposalUpdate(opened, { proposal: proposal("p1", state), applied: state === "PASSED" });
      expect(resolved.active).toBeNull();
      expect(resolved.lastResult?.proposal.state).toBe(state);
    }
  });

  it("keeps the last result visible while a new vote opens", () => {
    let view = applyProposalUpdate(EMPTY_PROPOSAL_VIEW, { proposal: proposal("p1"), applied: false });
    view = applyProposalUpdate(view, { proposal: proposal("p1", "FAILED"), applied: false });
    view = applyProposalUpdate(view, { proposal: proposal("p2"), applied: false });
    expect(view.active?.proposalId).toBe("p2");
    expect(view.lastResult?.proposal.proposalId).toBe("p1");
  });

  it("never lets a verdict about a different proposal clear the open one", () => {
    const opened = applyProposalUpdate(EMPTY_PROPOSAL_VIEW, { proposal: proposal("p2"), applied: false });
    const view = applyProposalUpdate(opened, { proposal: proposal("p1", "FAILED"), applied: false });
    expect(view.active?.proposalId).toBe("p2");
  });

  it("seeds from a snapshot's open proposal with no stale result", () => {
    const view = proposalViewFromSnapshot(proposal("p3"));
    expect(view.active?.proposalId).toBe("p3");
    expect(view.lastResult).toBeNull();
  });
});
