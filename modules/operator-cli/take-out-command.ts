import { CrewState } from "../crew-state/main.ts";
import type { ParsedArguments } from "./arguments.ts";
import { landingRefusals } from "./crew-result.ts";
import { answer, type Handled, type Refusals, report } from "./result.ts";

type TakeOutResult = Awaited<ReturnType<typeof CrewState.takeOut>>["result"];

/** Every take-out that does nothing now. Nothing moved and nothing was recorded. */
const takeOutRefusals = {
  "unknown-source": (result) => ({
    outcome: "invalid",
    reason: "unknown_source",
    detail: { sourceId: result.sourceId },
    lines: [`No source is registered as ${result.sourceId}.`],
  }),
  "nothing-to-take-out": (result) => ({
    outcome: "conflict",
    reason: "nothing_to_take_out",
    detail: { sourceId: result.sourceId },
    lines: [`The integration branch of ${result.sourceId} holds no withdrawn commit.`],
  }),
  "take-out-plan-changed": (result) => ({
    outcome: "conflict",
    reason: "take_out_plan_changed",
    detail: { sourceId: result.sourceId, stated: result.stated, recorded: result.recorded },
    lines: [
      `The withdrawals of ${result.sourceId} were recorded under plan revision ${result.recorded.join(", ")}, not ${result.stated}.`,
      "Run the command that `operator crew next` offers, which names that revision.",
    ],
  }),
  ...landingRefusals({
    retry: "accept",
    gateCommand: "operator gate run --source <id>",
    nothing: "Nothing was taken out.",
  }),
} satisfies Refusals<TakeOutResult>;

/**
 * Takes out every withdrawn commit that the integration branch of one source still holds (ADR
 * 0020). The Operator only runs it: the CLI builds the rebuilt branch from reviewed patches and
 * moves it once, bound to the plan revision that recorded the withdrawals (D5). The report gives
 * a summary, and the commits travel in the JSON data.
 */
export async function runTakeOut(
  parsed: ParsedArguments<"--request" | "--owner-token" | "--source" | "--plan-revision">,
): Promise<Handled> {
  const { requestId, ownerToken, sourceId, planRevision } = parsed.crew;
  const { repeated, result } = await CrewState.takeOut({
    projectRoot: process.cwd(),
    requestId,
    ownerToken,
    sourceId,
    planRevision,
  });
  if (answer(parsed, "work_take_out", result, takeOutRefusals)) {
    return "reported";
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
