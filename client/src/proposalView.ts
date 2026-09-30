import type { Proposal, ProposalBroadcast } from "../../shared/src/voting.ts";

// What the vote panel shows, derived only from the server's proposal:update
// broadcasts: the room's single OPEN proposal (the only thing that should
// ever stand in for the Play/Pause/Skip/Seek controls), and, kept apart from
// it, the most recent resolved verdict — shown as a result next to the
// controls, never in place of them. A resolved proposal used to be stored as
// the "active" one, which hid the controls for good after the first vote.
export interface ProposalView {
  active: Proposal | null;
  lastResult: ProposalBroadcast | null;
}

export const EMPTY_PROPOSAL_VIEW: ProposalView = { active: null, lastResult: null };

// A room:snapshot's activeProposal is always OPEN (the server only ever holds
// open proposals as active), so it seeds `active` directly.
export function proposalViewFromSnapshot(activeProposal: Proposal | null): ProposalView {
  return { active: activeProposal, lastResult: null };
}

export function applyProposalUpdate(view: ProposalView, update: ProposalBroadcast): ProposalView {
  if (update.proposal.state === "OPEN") {
    return { active: update.proposal, lastResult: view.lastResult };
  }
  // Only the proposal that just resolved stops being active — a verdict about
  // any other proposal id never clears an unrelated open vote.
  const stillOpen = view.active && view.active.proposalId !== update.proposal.proposalId ? view.active : null;
  return { active: stillOpen, lastResult: update };
}
