import { CrewState } from "../crew-state/main.ts";
import { ProjectReadiness } from "../project-readiness/main.ts";
import type { ParsedArguments } from "./arguments.ts";
import { reportSharedFailure } from "./crew-result.ts";
import { blockerData } from "./readiness-command.ts";
import { reportMissingTarget } from "./missing-target.ts";
import { type Handled, type Reason, report } from "./result.ts";

type Next = Extract<Awaited<ReturnType<typeof CrewState.next>>["result"], { status: "reported" }>;
type NextAction = Next["actions"][number];
type Readiness = Awaited<ReturnType<typeof ProjectReadiness.check>>;

/**
 * What a person has to settle before one action can run.
 * An action that needs nobody carries no blocker, so the reported blockers are exactly the
 * decisions the Operator brings to the user.
 */
const userBlockers: Partial<Record<NextAction["action"], Reason>> = {
  prove_readiness: "readiness_blocked",
  answer_question: "escalation_required",
  direct_limit: "direction_required",
  record_tracker: "approval_required",
  recover_tracker: "approval_required",
  remove_worktree: "approval_required",
};

function actionLines(actions: NextAction[]): string[] {
  return actions.length === 0
    ? ["Nothing is waiting on this session."]
    : [
        "Next actions, in order:",
        ...actions.map(
          (one) =>
            `  ${one.action}${one.needsUser ? " (needs the user)" : ""}: ${one.command}` +
            `${one.assignmentId === null ? "" : ` ${one.assignmentId}`}` +
            `${one.attemptId === null ? "" : ` attempt ${one.attemptId}`}` +
            `\n    ${one.detail}`,
        ),
      ];
}

function waitLines(waits: Next["waits"]): string[] {
  return waits.length === 0
    ? []
    : [
        "Waiting:",
        ...waits.map(
          (one) =>
            `  ${one.wait} on ${one.assignmentId}${one.agentName === null ? "" : ` (${one.agentName})`}` +
            `\n    ${one.detail}`,
        ),
      ];
}

/** The readiness verdict as the next-actions order reads it: ready, or the reason it is not. */
function readinessInput(readiness: Readiness): { ready: boolean; detail: string } {
  const unmet = readiness.state === "blocked" ? readiness.blockers : readiness.unproven;
  return {
    ready: readiness.state === "ready",
    detail:
      unmet.length === 0
        ? `Readiness is ${readiness.state}.`
        : `Readiness is ${readiness.state}: ${unmet.map((one) => one.name).join(", ")}.`,
  };
}

/**
 * What this session may do on its own, which is what the exit meaning reports.
 * An action that waits on a person is a blocker, so a session that holds only those does not
 * read the result as work it can start.
 */
function verdict(actions: NextAction[], waits: Next["waits"]) {
  if (actions.some((one) => !one.needsUser)) {
    return { outcome: "completed" as const, reason: "next_actions_reported" as const };
  }
  if (waits.length > 0) {
    return { outcome: "pending" as const, reason: "next_actions_waiting" as const };
  }
  if (actions.length > 0) {
    return { outcome: "missing-condition" as const, reason: "next_actions_blocked" as const };
  }

  return { outcome: "completed" as const, reason: "next_actions_none" as const };
}

function blockersOf(readiness: Readiness, actions: NextAction[]) {
  return [
    ...(readiness.state === "ready"
      ? []
      : [
          ...readiness.blockers.map((check) => blockerData(check, "readiness_blocked")),
          ...readiness.unproven.map((check) => blockerData(check, "readiness_unverified")),
        ]),
    ...actions.flatMap((one) => {
      const reason = one.needsUser ? userBlockers[one.action] : undefined;
      return reason === undefined || one.action === "prove_readiness"
        ? []
        : [
            {
              reason,
              action: one.action,
              assignmentId: one.assignmentId,
              attemptId: one.attemptId,
              questionId: one.questionId,
              reviewId: one.reviewId,
              detail: one.detail,
            },
          ];
    }),
  ];
}

/**
 * Reports everything this session may do next, in one order, and writes nothing.
 * It is the only schedule: readiness, the frontier order, dependency gates, review priority,
 * capacity, pending acknowledgements, and every recovery a restart owes are answered here.
 */
export async function runCrewNext(parsed: ParsedArguments): Promise<Handled> {
  if (parsed.targets.length === 0) {
    reportMissingTarget(parsed, "crew_next");
    return "reported";
  }

  const readiness = await ProjectReadiness.check({
    projectRoot: process.cwd(),
    targets: parsed.targets,
    overrides: parsed.overrides,
  });
  const { result } = await CrewState.next({
    projectRoot: process.cwd(),
    readiness: readinessInput(readiness),
  });

  // A project with no crew state has one crew action, so this is an answer, not a failure.
  if (result.status === "state-missing") {
    const readinessDetail = readinessInput(readiness);
    const actions: NextAction[] = [
      ...(readinessDetail.ready
        ? []
        : [
            {
              action: "prove_readiness" as const,
              rank: 10,
              assignmentId: null,
              attemptId: null,
              questionId: null,
              reviewId: null,
              revision: null,
              needsUser: true,
              detail: readinessDetail.detail,
              command: "operator setup readiness",
            },
          ]),
      {
        action: "own_crew" as const,
        rank: 20,
        assignmentId: null,
        attemptId: null,
        questionId: null,
        reviewId: null,
        revision: null,
        needsUser: false,
        detail: "This project holds no crew state, so nothing is registered yet.",
        command: "operator crew own",
      },
    ];
    report({
      json: parsed.json,
      result: {
        ...verdict(actions, []),
        blockers: blockersOf(readiness, actions),
        operation: "crew_next",
        data: { readiness, ownership: null, actions, waits: [] },
      },
      lines: actionLines(actions),
    });
    return "reported";
  }

  if (reportSharedFailure(parsed, "crew_next", result)) {
    return "reported";
  }

  const { actions, waits } = result;
  report({
    json: parsed.json,
    result: {
      ...verdict(actions, waits),
      blockers: blockersOf(readiness, actions),
      operation: "crew_next",
      data: { ...result, readiness },
    },
    lines: [
      `Crew limit ${result.capacity.limit} (${result.capacity.limitSource}), review reserve ${result.capacity.reviewReserve}.`,
      `Active ${result.capacity.active.total}: ${result.capacity.active.production} production, ${result.capacity.active.review} review.`,
      ...actionLines(actions),
      ...waitLines(waits),
    ],
  });
  return "reported";
}
