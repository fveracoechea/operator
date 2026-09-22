import { CrewState } from "../crew-state/main.ts";
import { ProjectReadiness } from "../project-readiness/main.ts";
import type { ParsedArguments } from "./arguments.ts";
import { reportSharedFailure } from "./crew-result.ts";
import { blockerData } from "./readiness-command.ts";
import { reportMissingTarget } from "./missing-target.ts";
import { type Handled, type Reason, report } from "./result.ts";

type Next = Extract<Awaited<ReturnType<typeof CrewState.next>>["result"], { status: "reported" }>;
type NextAction = Next["actions"][number];
type NextBlocker = NonNullable<NextAction["blocker"]>;
type Readiness = Awaited<ReturnType<typeof ProjectReadiness.check>>;

/**
 * The CLI promise about each blocker the crew state names.
 * The record is total, so a blocker this release cannot report is a compile error rather than
 * an exit 3 that carries nothing for the user.
 */
const reasonOfBlocker = {
  readiness_blocked: "readiness_blocked",
  escalation_required: "escalation_required",
  direction_required: "direction_required",
  approval_required: "approval_required",
  cleanup_blocked: "cleanup_blocked",
  cleanup_failed: "cleanup_failed",
  cleanup_uncertain: "cleanup_uncertain",
} as const satisfies Record<NextBlocker, Reason>;

function actionLines(actions: NextAction[]): string[] {
  return actions.length === 0
    ? ["Nothing is waiting on this session."]
    : [
        "Next actions, in order:",
        ...actions.map(
          (one) =>
            `  ${one.action}${one.blocker === null ? "" : ` (the user settles ${one.blocker})`}: ${one.command}` +
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
 * A crew action that waits on a person outranks a wait, because waiting settles nothing a
 * person holds and a session would read exit 6 as permission to do nothing about it.
 */
function verdict(actions: NextAction[], waits: Next["waits"]) {
  // A standing precondition is reported and is never the reason the crew cannot advance.
  const owed = actions.filter((one) => !CrewState.isStandingAction({ action: one.action }));

  if (owed.some((one) => one.blocker === null)) {
    return { outcome: "completed" as const, reason: "next_actions_reported" as const };
  }
  if (owed.length > 0) {
    return { outcome: "missing-condition" as const, reason: "next_actions_blocked" as const };
  }
  if (waits.length > 0) {
    return { outcome: "pending" as const, reason: "next_actions_waiting" as const };
  }
  if (actions.length > 0) {
    return { outcome: "missing-condition" as const, reason: "next_actions_blocked" as const };
  }

  return { outcome: "completed" as const, reason: "next_actions_none" as const };
}

/**
 * What the user has to settle: every readiness check that failed, and every action that names a
 * blocker. An exit that says a person must decide therefore always names what to decide.
 */
function blockersOf(readiness: Readiness, actions: NextAction[]) {
  return [
    ...(readiness.state === "ready"
      ? []
      : [
          ...readiness.blockers.map((check) => blockerData(check, "readiness_blocked")),
          ...readiness.unproven.map((check) => blockerData(check, "readiness_unverified")),
        ]),
    ...actions.flatMap((one) =>
      one.blocker === null
        ? []
        : [
            {
              reason: reasonOfBlocker[one.blocker],
              action: one.action,
              assignmentId: one.assignmentId,
              attemptId: one.attemptId,
              questionId: one.questionId,
              reviewId: one.reviewId,
              detail: one.detail,
            },
          ],
    ),
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
