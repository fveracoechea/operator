import type { NextStep } from "../../lib/cli-result.ts";

export type PhaseGuard =
  | "report_submitted"
  | "pr_associated"
  | "round_recorded"
  | "pr_ready"
  | "worktree_clean"
  | "pr_merged";
export type PhaseEvent = "submit" | "resume" | "associate" | "round" | "ready" | "wait" | "merge";
export type PhaseFacts = {
  kind: {
    name: string;
    completion: "report" | "pr";
    workPhases: { name: string; goal?: string; guard?: PhaseGuard }[];
  };
  report: { returned: boolean; accepted: boolean; resumed?: boolean } | null;
  pr: { associated: boolean; rounds: number; ready: boolean; merged: boolean; parked: boolean };
  internalReview: boolean;
  reviewEnded?: boolean;
  handedOff?: boolean;
  worktreeClean: boolean;
};
type Phase = { phase: string; next: NextStep };
type Rule = { when: (facts: PhaseFacts) => boolean; phase: (facts: PhaseFacts) => Phase };

const report: Phase = {
  phase: "report",
  next: { command: "operator report submit --file <file>", why: "Submit the completed report." },
};
const review: Phase = {
  phase: "review",
  next: { command: "operator pr round --file <file>", why: "Record the review findings." },
};
const ready: Phase = {
  phase: "ready",
  next: {
    command: "operator pr ready --file <file>",
    why: "Resolve the recorded findings and mark the PR ready.",
  },
};
const pr: Phase = {
  phase: "pr",
  next: { command: "operator pr associate", why: "Associate the pushed PR." },
};
const complete: Phase = {
  phase: "complete",
  next: { why: "The assignment is complete. Nothing remains for this worker." },
};

// Ordered facts, not kind names, select both tails. A return reopens only submission;
// it never rewinds investigation/build. The PR review loop cannot exceed two rounds.
const reportTail: Rule[] = [
  { when: (facts) => facts.report?.accepted === true, phase: () => complete },
  {
    when: (facts) => facts.report?.returned === true,
    phase: (facts) =>
      // Stryker disable next-line OptionalChaining: equivalent: this rule is selected only when a returned report exists
      facts.report?.resumed === true
        ? report
        : {
            phase: "report",
            next: {
              command: "operator report resume",
              why: "Read the returned report's follow-up before submitting again.",
            },
          },
  },
  {
    when: (facts) => facts.report !== null,
    phase: () => ({
      phase: "acceptance",
      next: { decider: "super-agent", question: "Accept or return the submitted report?" },
    }),
  },
];
const prTail: Rule[] = [
  { when: (facts) => facts.pr.merged, phase: () => complete },
  {
    when: (facts) => facts.handedOff === true,
    phase: () => ({
      phase: "handoff",
      next: { why: "This launch handed the PR to its reviewer. Stop here." },
    }),
  },
  {
    when: (facts) => facts.pr.parked,
    phase: () => ({
      phase: "park",
      next: { why: "The PR is parked until a recorded event wakes it." },
    }),
  },
  {
    when: (facts) => facts.pr.ready || facts.reviewEnded === true,
    phase: () => ({
      phase: "feedback",
      next: { command: "operator pr wait", why: "Wait for PR feedback or merge eligibility." },
    }),
  },
  {
    when: (facts) => facts.pr.associated && facts.internalReview,
    phase: (facts) => (facts.pr.rounds === 0 ? review : ready),
  },
  {
    when: (facts) => facts.pr.associated,
    phase: () => ({
      phase: "feedback",
      next: { command: "operator pr wait", why: "Wait for PR feedback or merge eligibility." },
    }),
  },
];

const exits: Record<PhaseEvent, PhaseGuard[]> = {
  submit: [],
  resume: ["report_submitted"],
  associate: ["worktree_clean"],
  round: ["pr_associated"],
  ready: ["pr_associated", "round_recorded", "worktree_clean"],
  wait: ["pr_associated"],
  merge: ["pr_associated", "pr_ready", "worktree_clean"],
};
const reasons: Record<PhaseGuard, string> = {
  report_submitted: "report_not_submitted",
  pr_associated: "pr_not_associated",
  round_recorded: "internal_review_round_missing",
  pr_ready: "pr_not_ready",
  worktree_clean: "pr_worktree_unclean",
  pr_merged: "pr_not_merged",
};
const recovery: Record<PhaseGuard, NextStep> = {
  report_submitted: report.next,
  pr_associated: pr.next,
  round_recorded: review.next,
  pr_ready: { command: "operator pr wait", why: "Wait for current-head readiness evidence." },
  worktree_clean: {
    command: "git status --short",
    why: "Inspect the local changes before committing or removing them.",
  },
  pr_merged: { command: "operator pr wait", why: "Wait for a verified merge." },
};

function requiredGuards(facts: PhaseFacts, event: PhaseEvent | undefined) {
  if (event === undefined) return [];
  const completion = event === "submit" || event === "resume" ? "report" : "pr";
  // The completion lifecycle owns a wrong-command refusal, before phase-specific guards.
  if (facts.kind.completion !== completion) return [];
  // An ended review owns its refusal; phase prerequisites cannot reopen its round/ready loop.
  if (facts.reviewEnded && (event === "round" || event === "ready")) return [];
  const work =
    event === "submit" || event === "associate"
      ? facts.kind.workPhases.flatMap((phase) => (phase.guard === undefined ? [] : [phase.guard]))
      : [];
  return [
    ...work,
    ...exits[event].filter((guard) => guard !== "round_recorded" || facts.internalReview),
  ];
}

/** One worker lifecycle. Callers gather facts and perform effects; this table does neither. */
export function decidePhase(facts: PhaseFacts, event?: PhaseEvent) {
  const tail = facts.kind.completion === "report" ? reportTail : prTail;
  const work = facts.kind.workPhases.at(-1);
  const closing = facts.kind.completion === "report" ? report : pr;
  const current = tail.find((rule) => rule.when(facts))?.phase(facts) ?? {
    ...closing,
    phase: work?.name ?? closing.phase,
  };
  if (event !== undefined && facts.handedOff === true)
    return {
      kind: facts.kind.name,
      ...current,
      refusal: {
        reason: "pr_handed_off",
        detail: "This launch no longer owns the PR.",
        state: { handedOff: true },
      },
    };
  const guards: Record<PhaseGuard, boolean> = {
    report_submitted: facts.report !== null,
    pr_associated: facts.pr.associated,
    round_recorded: facts.pr.rounds > 0,
    pr_ready: facts.pr.ready,
    worktree_clean: facts.worktreeClean,
    pr_merged: facts.pr.merged,
  };
  const missing = requiredGuards(facts, event).find((guard) => !guards[guard]);
  if (missing !== undefined)
    return {
      kind: facts.kind.name,
      phase: current.phase,
      next: recovery[missing],
      refusal: {
        reason: reasons[missing],
        detail: `The phase exit requires ${missing}.`,
        state: { [missing]: false },
      },
    };
  if (event === "round" && !facts.reviewEnded && facts.pr.rounds >= 2)
    return {
      kind: facts.kind.name,
      phase: current.phase,
      next: ready.next,
      refusal: {
        reason: "internal_review_round_limit",
        detail: "The PR review loop is limited to two rounds.",
        state: { rounds: facts.pr.rounds },
      },
    };
  return { kind: facts.kind.name, ...current, refusal: undefined };
}
