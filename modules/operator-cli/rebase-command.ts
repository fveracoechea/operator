import { CrewState } from "../crew-state/main.ts";
import { type ParsedArguments, readMutation } from "./arguments.ts";
import { reportSharedFailure } from "./crew-result.ts";
import { type Handled, type Operation, refuse, report } from "./result.ts";

type Planned = Awaited<ReturnType<typeof CrewState.planRebase>>["result"];
type Preview = Extract<Planned, { status: "planned" }>;

/**
 * Reports one rebase plan as a summary and the path of the full plan. The Operator reads this
 * report, so it names the counts, the gate, the approval, and the path, and never lists every
 * commit (R5).
 */
function reportPreview(parsed: ParsedArguments, operation: Operation, preview: Preview): Handled {
  const refused = preview.refusals.length > 0;
  const { record, gate } = preview;
  const command =
    preview.planRevision === null || preview.to === null
      ? null
      : `operator work rebase --request <id> --owner-token <token> --source ${preview.sourceId} --base ${preview.to.base} --plan-revision ${preview.planRevision}`;
  report({
    json: parsed.json,
    result: {
      outcome: refused ? "invalid" : "completed",
      reason: refused ? (preview.refusals[0]?.reason ?? "rebase_planned") : "rebase_planned",
      blockers: preview.refusals.map((one) => ({ reason: one.reason, detail: one.detail })),
      operation,
      data: {
        sourceId: preview.sourceId,
        branch: preview.branch,
        planRevision: preview.planRevision,
        planPath: preview.planPath,
        from: preview.from,
        to: preview.to,
        target: preview.target,
        counts:
          record === null
            ? null
            : {
                merged: record.merged.length,
                relanded: record.relanded.length,
                takenOut: record.takenOut.length,
              },
        gate,
        approval: refused ? null : preview.approval,
        command: refused ? null : command,
      },
    },
    lines: [
      `Rebase plan ${preview.planRevision ?? "(no revision)"} for ${preview.sourceId}:`,
      ...(preview.from === null || preview.to === null
        ? []
        : [
            `  ${preview.branch ?? ""} moves from base ${preview.from.base} to ${preview.to.base}.`,
          ]),
      ...(record === null
        ? []
        : [
            `  ${record.merged.length} landing(s) leave the branch because their pull request merged, ${record.relanded.length} land again, and ${record.takenOut.length} are taken out.`,
          ]),
      ...(gate === null || gate.status === "passed"
        ? []
        : [`  The project gate is ${gate.status} at ${gate.commit}, the next place to gate.`]),
      ...(refused
        ? [
            `  ${preview.refusals.length} refusal(s): ${preview.refusals.map((one) => one.reason).join(", ")}.`,
            "Nothing can be rebased until each refusal is settled.",
          ]
        : [
            "Ask the person to read the plan and to approve this exact plan revision.",
            `Rebase with: ${command ?? ""}`,
          ]),
      `Every commit and refusal: ${preview.planPath}`,
    ],
  });
  return "reported";
}

function reportUnknown(parsed: ParsedArguments, operation: Operation, sourceId: string): Handled {
  return refuse({
    json: parsed.json,
    operation,
    outcome: "invalid",
    reason: "unknown_source",
    detail: { sourceId },
    lines: [`No source ${sourceId} is recorded.`],
  });
}

async function runPlan(parsed: ParsedArguments, sourceId: string, newBase: string) {
  // A plan changes nothing that others read, so it needs no request and no ownership.
  const operation = "work_rebase_plan";
  const { result } = await CrewState.planRebase({ projectRoot: process.cwd(), sourceId, newBase });
  if (reportSharedFailure(parsed, operation, result)) {
    return "reported";
  }
  return result.status === "planned"
    ? reportPreview(parsed, operation, result)
    : reportUnknown(parsed, operation, result.sourceId);
}

// oxlint-disable-next-line complexity -- Each outcome of a rebase keeps its own reason.
async function runApply(
  parsed: ParsedArguments,
  request: { sourceId: string; newBase: string; planRevision: string },
): Promise<Handled> {
  const mutation = readMutation(parsed);
  if (mutation === null) {
    return "invalid-arguments";
  }
  const operation = "work_rebase";
  const { result } = await CrewState.rebase({
    projectRoot: process.cwd(),
    ...mutation,
    ...request,
  });
  if (reportSharedFailure(parsed, operation, result)) {
    return "reported";
  }
  switch (result.status) {
    case "unknown-source":
      return reportUnknown(parsed, operation, result.sourceId);
    case "refused":
      return reportPreview(parsed, operation, result.preview);
    case "plan-revision-changed":
      return refuse({
        json: parsed.json,
        operation,
        outcome: "conflict",
        reason: "plan_revision_changed",
        detail: { ...result },
        lines: [
          `The plan is now ${result.planned ?? "refused"}, not ${result.stated}. Nothing was rebased.`,
          ...(result.planPath === null ? [] : [`Read the new plan: ${result.planPath}`]),
        ],
      });
    case "approval-required":
      return refuse({
        json: parsed.json,
        operation,
        outcome: "missing-condition",
        reason: "approval_required",
        detail: { approval: result.approval, planPath: result.planPath },
        lines: [
          "Nothing was rebased. Ask the person to read the plan and approve this exact request:",
          `  action ${result.approval.action}, scope ${result.approval.scope}, targets ${result.approval.targets.join(", ")}, request revision ${result.approval.requestRevision}.`,
          `The plan: ${result.planPath}`,
        ],
      });
    case "gate-not-passed": {
      const { gate } = result;
      const place =
        gate.parent === null ? "the new base" : `commit ${gate.commit} on ${gate.parent}`;
      return refuse({
        json: parsed.json,
        operation,
        outcome: gate.status === "pending" || gate.status === "running" ? "pending" : "conflict",
        reason: `gate_${gate.status}`,
        detail: { commit: gate.commit, parent: gate.parent, key: gate.key, runIds: gate.runIds },
        lines: [
          `The project gate has not passed at ${place}, so nothing was recorded and the branch did not move.`,
          gate.status === "pending"
            ? `Run \`operator gate run --source ${request.sourceId} --base ${result.preview.to?.base ?? request.newBase}\` first.`
            : gate.status === "running"
              ? `Gate run ${gate.runIds.join(", ")} still runs. Wait for its outcome.`
              : `It is ${gate.status} in gate run ${gate.runIds.join(", ")}. Read it with \`operator gate show --run <id>\`.${gate.parent === null ? " Only the person clears a failing base: by a fixed target and a new base, or a fresh series." : ""}`,
        ],
      });
    }
    case "rebase-pending":
      return refuse({
        json: parsed.json,
        operation,
        outcome: "pending",
        reason: "rebase_pending",
        detail: { rebaseId: result.rebaseId, planRevision: result.planRevision },
        lines: [
          `Rebase ${result.rebaseId} of this source has no recorded outcome. Repeat it with plan revision ${result.planRevision} first.`,
        ],
      });
    case "rebase-stopped":
      return refuse({
        json: parsed.json,
        operation,
        outcome: result.reason === "integration_branch_unread" ? "uncertain" : "conflict",
        reason: result.reason,
        detail: { rebaseId: result.rebaseId, detail: result.detail },
        lines: [
          `Rebase ${result.rebaseId} is recorded, and the branch did not move: ${result.detail}`,
          "Repeat the same command when it is settled. Operator never resets or adopts a moved branch.",
        ],
      });
    default: {
      const { record } = result;
      report({
        json: parsed.json,
        result: {
          outcome: "completed",
          reason: "rebased",
          blockers: [],
          operation,
          data: {
            rebaseId: result.rebaseId,
            branch: result.branch,
            from: result.from,
            to: result.to,
            record,
            branchReview: result.branchReview,
          },
        },
        lines: [
          `${result.branch} is rebased from base ${result.from.base} to ${result.to.base}, tip ${result.to.tip}.`,
          `  ${record.merged.length} landing(s) left the branch, ${record.relanded.length} landed again, and ${record.takenOut.length} were taken out and wait for an integration cycle.`,
          ...(result.branchReview === null
            ? []
            : [`  Branch review ${result.branchReview.reviewId} is registered on the new head.`]),
          "Run `operator crew next` for what follows.",
        ],
      });
      return "reported";
    }
  }
}

/**
 * `operator work rebase`: with no plan revision it plans, and with one it rebases behind the
 * approval of that revision.
 */
export async function runRebase(parsed: ParsedArguments): Promise<Handled> {
  const { sourceId, newBase, planRevision, requestId, ownerToken, ...other } = parsed.crew;
  if (sourceId === undefined || newBase === undefined || Object.keys(other).length > 0) {
    return "invalid-arguments";
  }
  if (planRevision === undefined) {
    return requestId === undefined && ownerToken === undefined
      ? runPlan(parsed, sourceId, newBase)
      : "invalid-arguments";
  }
  return runApply(parsed, { sourceId, newBase, planRevision });
}
