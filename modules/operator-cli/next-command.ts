import { CrewState } from "../crew-state/main.ts";
import { ProjectReadiness } from "../project-readiness/main.ts";
import { ReleaseInstall } from "../release-install/main.ts";
import type { ParsedArguments } from "./arguments.ts";
import { reportSharedFailure } from "./crew-result.ts";
import { blockerData } from "./readiness-command.ts";
import { type Handled, report } from "./result.ts";

type Next = Extract<Awaited<ReturnType<typeof CrewState.next>>["result"], { status: "reported" }>;
type NextAction = Next["actions"][number];
type Readiness = Awaited<ReturnType<typeof ProjectReadiness.check>>;

function actionLines(actions: NextAction[]): string[] {
  return actions.length === 0
    ? ["Nothing is waiting on this session."]
    : [
        "Next actions:",
        ...actions.map(
          (one, index) =>
            `  ${index + 1}. ${one.detail}` +
            `${one.blocker === null ? "" : " This needs a decision from the user."}` +
            `\n     Run: ${one.command}`,
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
            `  ${one.detail}${one.agentName === null ? "" : `\n    Agent: ${one.agentName}`}` +
            `${one.command === null ? "" : `\n    Run when the user reports it: ${one.command}`}`,
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

/** Every readiness check that failed, as the user has to settle it. */
function readinessBlockers(readiness: Readiness) {
  return readiness.state === "ready"
    ? []
    : [
        ...readiness.blockers.map((check) => blockerData(check, "readiness_blocked")),
        ...readiness.unproven.map((check) => blockerData(check, "readiness_unverified")),
      ];
}

/**
 * Reports everything this session may do next, in one order, and writes nothing.
 * It is the only schedule: readiness, the frontier order, dependency gates, review priority,
 * capacity, pending acknowledgements, and every recovery a restart owes are answered here.
 */
export async function runCrewNext(parsed: ParsedArguments): Promise<Handled> {
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

  const selection = await ReleaseInstall.selection({ projectRoot: process.cwd() });
  const invocation =
    selection.state === "selected" && selection.selection.delivery === "jsr"
      ? "bun run operator"
      : "operator";
  const command = (text: string) => text.replace(/^operator(?=\s|$)/, invocation);
  const { verdict, blockers, ...schedule } = result;
  const actions = schedule.actions.map((action) => ({
    ...action,
    command: command(action.command),
    planningRecords:
      action.planningRecords?.map((one) => ({ ...one, command: command(one.command) })) ?? null,
  }));
  const { waits } = schedule;
  report({
    json: parsed.json,
    result: {
      outcome: verdict.outcome,
      reason: verdict.reason,
      blockers: [...readinessBlockers(readiness), ...blockers],
      operation: "crew_next",
      data: { ...schedule, actions, readiness },
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
