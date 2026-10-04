import { CrewState } from "../crew-state/main.ts";
import { type ParsedArguments, readMutation } from "./arguments.ts";
import { reportSharedFailure } from "./crew-result.ts";
import { landingRefusalOf } from "./landing-refusal.ts";
import { type Handled, refuse, report } from "./result.ts";

type TakeOutResult = Awaited<ReturnType<typeof CrewState.takeOut>>["result"];

/** Reports a take-out that does nothing now. Nothing moved and nothing was recorded. */
function reportRefusal(parsed: ParsedArguments, result: TakeOutResult): Handled | null {
  const operation = "work_take_out";
  switch (result.status) {
    case "unknown-source":
      return refuse({
        json: parsed.json,
        operation,
        outcome: "invalid",
        reason: "unknown_source",
        detail: { sourceId: result.sourceId },
        lines: [`No source is registered as ${result.sourceId}.`],
      });
    case "nothing-to-take-out":
      return refuse({
        json: parsed.json,
        operation,
        outcome: "conflict",
        reason: "nothing_to_take_out",
        detail: { sourceId: result.sourceId },
        lines: [`The integration branch of ${result.sourceId} holds no withdrawn commit.`],
      });
    case "take-out-plan-changed":
      return refuse({
        json: parsed.json,
        operation,
        outcome: "conflict",
        reason: "take_out_plan_changed",
        detail: { sourceId: result.sourceId, stated: result.stated, recorded: result.recorded },
        lines: [
          `The withdrawals of ${result.sourceId} were recorded under plan revision ${result.recorded.join(", ")}, not ${result.stated}.`,
          "Run the command that `operator crew next` offers, which names that revision.",
        ],
      });
    case "landing-refused": {
      const { refusal } = result;
      const { outcome, reason, lines } = landingRefusalOf(refusal, {
        retry: "accept",
        gateRun: "--source",
      });
      const { status: _status, ...detail } = refusal;
      return refuse({
        json: parsed.json,
        operation,
        outcome,
        reason,
        detail,
        lines: [...lines, "Nothing was taken out."],
      });
    }
    default:
      return null;
  }
}

/**
 * Takes out every withdrawn commit that the integration branch of one source still holds (ADR
 * 0020). The Operator only runs it: the CLI builds the rebuilt branch from reviewed patches and
 * moves it once, bound to the plan revision that recorded the withdrawals (D5). The report gives
 * a summary, and the commits travel in the JSON data.
 */
export async function runTakeOut(parsed: ParsedArguments): Promise<Handled> {
  const mutation = readMutation(parsed);
  const { sourceId, planRevision } = parsed.crew;
  if (mutation === null || sourceId === undefined || planRevision === undefined) {
    return "invalid-arguments";
  }

  const { repeated, result } = await CrewState.takeOut({
    projectRoot: process.cwd(),
    ...mutation,
    sourceId,
    planRevision,
  });
  if (reportSharedFailure(parsed, "work_take_out", result)) {
    return "reported";
  }
  const refused = reportRefusal(parsed, result);
  if (refused !== null) {
    return refused;
  }
  if (result.status !== "taken-out") {
    return "invalid-arguments";
  }

  const { status: _status, ...data } = result;
  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "commits_taken_out",
      blockers: [],
      operation: "work_take_out",
      data: { ...data, repeated },
    },
    lines: [
      `Took ${result.removed.length} withdrawn commit(s) out of ${result.branch}, which moved once from ${result.from} to ${result.to}.`,
      `${result.relanded.length} later commit(s) landed again with an equal patch.`,
      ...(result.takenOut.length === 0
        ? []
        : [
            `${result.takenOut.length} later result(s) did not land again and returned to awaiting review. \`operator crew next\` offers each landing again.`,
          ]),
      ...(result.branchReview === null
        ? []
        : [
            `The integration branch is final, so branch review ${result.branchReview.reviewId} is registered at head ${result.branchReview.headCommit}.`,
          ]),
    ],
  });
  return "reported";
}
