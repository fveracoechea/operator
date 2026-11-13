/** The declared cleanup order after a verified merge. */
export const cleanupSteps = ["remote_branch", "pane", "worktree"] as const;
export type CleanupStep = (typeof cleanupSteps)[number];

export function nextStep(step: CleanupStep): CleanupStep | null {
  return cleanupSteps[cleanupSteps.indexOf(step) + 1] ?? null;
}

export type StepDecision =
  | { action: "dispose"; force: boolean }
  | { action: "skip"; outcome: "absent" | "not_recorded" | "replaced" }
  | {
      action: "blocked";
      reason: "cleanup_unlanded_work" | "cleanup_resource_mismatch";
      detail: string;
    };

const person =
  "Only the person can authorize its deletion: repeat operator cleanup with --person-instructed on the person's instruction.";

/** A remote branch that moved after the merge holds commits that did not land. */
export function decideRemoteBranch(facts: {
  branch: string;
  sha: string | null;
  mergedHead: string;
  personInstructed: boolean;
}): StepDecision {
  if (facts.sha === null) return { action: "skip", outcome: "absent" };
  if (facts.sha === facts.mergedHead || facts.personInstructed)
    return { action: "dispose", force: facts.sha !== facts.mergedHead };
  return {
    action: "blocked",
    reason: "cleanup_unlanded_work",
    detail: `The remote branch ${facts.branch} is at ${facts.sha}, not at the merged head ${facts.mergedHead}. ${person}`,
  };
}

/** Herdr can give a closed pane's identifier to a new pane, so a pane in another tab is not ours. */
export function decidePane(facts: {
  recorded: { paneId: string | null; tabId: string | null };
  observed: { tabId: string } | null;
}): StepDecision {
  if (facts.recorded.paneId === null) return { action: "skip", outcome: "not_recorded" };
  if (facts.observed === null) return { action: "skip", outcome: "absent" };
  if (facts.observed.tabId !== facts.recorded.tabId) return { action: "skip", outcome: "replaced" };
  return { action: "dispose", force: false };
}

export type WorktreeFacts = {
  path: string | null;
  exists: boolean;
  sameRepository: boolean;
  branch: string | null;
  expectedBranch: string;
  // The worktree head is the merged head or one of its ancestors.
  landed: boolean;
  changed: string[];
  unknownIgnored: string[];
  personInstructed: boolean;
};

function listed(paths: string[]) {
  const shown = paths.slice(0, 20).join(", ");
  return paths.length > 20 ? `${shown}, and ${paths.length - 20} more` : shown;
}

/**
 * The worktree goes only when inspection proves it is the recorded checkout and that it holds
 * nothing but landed commits and preparation output. A foreign checkout is never removed.
 */
export function decideWorktree(facts: WorktreeFacts): StepDecision {
  if (facts.path === null) return { action: "skip", outcome: "not_recorded" };
  if (!facts.exists) return { action: "skip", outcome: "absent" };
  if (!facts.sameRepository || facts.branch !== facts.expectedBranch)
    return {
      action: "blocked",
      reason: "cleanup_resource_mismatch",
      detail: `${facts.path} is no longer the recorded worktree on ${facts.expectedBranch}. Operator never removes another checkout. Move it away, then repeat operator cleanup.`,
    };
  const work = [
    ...(facts.landed ? [] : ["commits that are not in the merged head"]),
    ...(facts.changed.length > 0 ? [`changed or untracked ${listed(facts.changed)}`] : []),
    ...(facts.unknownIgnored.length > 0
      ? [`ignored content that preparation did not write: ${listed(facts.unknownIgnored)}`]
      : []),
  ];
  if (work.length === 0) return { action: "dispose", force: false };
  if (facts.personInstructed) return { action: "dispose", force: true };
  return {
    action: "blocked",
    reason: "cleanup_unlanded_work",
    detail: `${facts.path} holds ${work.join("; ")}. ${person}`,
  };
}
