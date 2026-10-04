import { CrewState } from "../crew-state/main.ts";
import { type ParsedArguments, readMutation } from "./arguments.ts";
import { approvalRequired, planPreview, planRevisionChanged } from "./plan-preview.ts";
import { answer, type Handled, type Refusal } from "./result.ts";

type Planned = Awaited<ReturnType<typeof CrewState.planRebase>>["result"];
type Preview = Extract<Planned, { status: "planned" }>;
type Rebased = Awaited<ReturnType<typeof CrewState.rebase>>["result"];

/**
 * One rebase plan as a summary and the path of the full plan. The Operator reads this report, so
 * it names the counts, the gate, the approval, and the path, and never lists every commit (R5).
 */
function rebasePreview(preview: Preview): Refusal {
  const refused = preview.refusals.length > 0;
  const { record, gate, from, to } = preview;
  return planPreview({
    planned: "rebase_planned",
    summary: [
      `Rebase plan ${preview.planRevision ?? "(no revision)"} for ${preview.sourceId}:`,
      ...(from === null || to === null
        ? []
        : [`  ${preview.branch ?? ""} moves from base ${from.base} to ${to.base}.`]),
      ...(record === null
        ? []
        : [
            `  ${record.merged.length} landing(s) leave the branch because their pull request merged, ${record.relanded.length} land again, and ${record.takenOut.length} are taken out.`,
          ]),
      ...(gate === null || gate.status === "passed"
        ? []
        : [`  The project gate is ${gate.status} at ${gate.commit}, the next place to gate.`]),
    ],
    refusals: {
      reason: preview.refusals[0]?.reason ?? "rebase_planned",
      count: preview.refusals.length,
      list: preview.refusals.map((one) => one.reason).join(", "),
      blockers: preview.refusals.map((one) => ({ reason: one.reason, detail: one.detail })),
      nothing: "rebased",
    },
    ask: "Ask the person to read the plan and to approve this exact plan revision.",
    apply: {
      label: "Rebase with",
      command:
        preview.planRevision === null || to === null
          ? null
          : `operator work rebase --request <id> --owner-token <token> --source ${preview.sourceId} --base ${to.base} --plan-revision ${preview.planRevision}`,
    },
    path: { label: "Every commit and refusal", planPath: preview.planPath },
    data: {
      sourceId: preview.sourceId,
      branch: preview.branch,
      planRevision: preview.planRevision,
      planPath: preview.planPath,
      from,
      to,
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
    },
  });
}

const unknownSource = {
  "unknown-source": (result: { sourceId: string }): Refusal => ({
    outcome: "invalid",
    reason: "unknown_source",
    detail: { sourceId: result.sourceId },
    lines: [`No source ${result.sourceId} is recorded.`],
  }),
};

async function runPlan(parsed: ParsedArguments, sourceId: string, newBase: string) {
  // A plan changes nothing that others read, so it needs no request and no ownership.
  const { result } = await CrewState.planRebase({ projectRoot: process.cwd(), sourceId, newBase });
  return answer(parsed, "work_rebase_plan", result, { planned: rebasePreview, ...unknownSource })
    ? "reported"
    : "invalid-arguments";
}

type Request = { sourceId: string; newBase: string; planRevision: string };

/** The project gate has not passed at the new base or at a commit that lands again. */
function gateNotPassed(
  request: Request,
  { gate, preview }: Extract<Rebased, { status: "gate-not-passed" }>,
): Refusal {
  const place = gate.parent === null ? "the new base" : `commit ${gate.commit} on ${gate.parent}`;
  const next =
    gate.status === "pending"
      ? `Run \`operator gate run --source ${request.sourceId} --base ${preview.to?.base ?? request.newBase}\` first.`
      : gate.status === "running"
        ? `Gate run ${gate.runIds.join(", ")} still runs. Wait for its outcome.`
        : `It is ${gate.status} in gate run ${gate.runIds.join(", ")}. Read it with \`operator gate show --run <id>\`.${gate.parent === null ? " Only the person clears a failing base: by a fixed target and a new base, or a fresh series." : ""}`;
  return {
    outcome: gate.status === "pending" || gate.status === "running" ? "pending" : "conflict",
    reason: `gate_${gate.status}`,
    detail: { commit: gate.commit, parent: gate.parent, key: gate.key, runIds: gate.runIds },
    lines: [
      `The project gate has not passed at ${place}, so nothing was recorded and the branch did not move.`,
      next,
    ],
  };
}

/** The rebase record: what left the branch, what landed again, and the new branch review. */
function rebased(result: Extract<Rebased, { status: "rebased" }>): Refusal {
  const { record } = result;
  return {
    outcome: "completed",
    reason: "rebased",
    data: {
      rebaseId: result.rebaseId,
      branch: result.branch,
      from: result.from,
      to: result.to,
      record,
      branchReview: result.branchReview,
    },
    lines: [
      `${result.branch} is rebased from base ${result.from.base} to ${result.to.base}, tip ${result.to.tip}.`,
      `  ${record.merged.length} landing(s) left the branch, ${record.relanded.length} landed again, and ${record.takenOut.length} were taken out and wait for an integration cycle.`,
      ...(result.branchReview === null
        ? []
        : [`  Branch review ${result.branchReview.reviewId} is registered on the new head.`]),
      "Run `operator crew next` for what follows.",
    ],
  };
}

async function runApply(parsed: ParsedArguments, request: Request): Promise<Handled> {
  const mutation = readMutation(parsed);
  if (mutation === null) {
    return "invalid-arguments";
  }
  const { result } = await CrewState.rebase({
    projectRoot: process.cwd(),
    ...mutation,
    ...request,
  });
  return answer(parsed, "work_rebase", result, {
    ...unknownSource,
    refused: ({ preview }) => rebasePreview(preview),
    "plan-revision-changed": planRevisionChanged("rebased"),
    "approval-required": approvalRequired("rebased"),
    "gate-not-passed": (one) => gateNotPassed(request, one),
    "rebase-pending": (one) => ({
      outcome: "pending",
      reason: "rebase_pending",
      detail: { rebaseId: one.rebaseId, planRevision: one.planRevision },
      lines: [
        `Rebase ${one.rebaseId} of this source has no recorded outcome. Repeat it with plan revision ${one.planRevision} first.`,
      ],
    }),
    "rebase-stopped": (one) => ({
      outcome: one.reason === "integration_branch_unread" ? "uncertain" : "conflict",
      reason: one.reason,
      detail: { rebaseId: one.rebaseId, detail: one.detail },
      lines: [
        `Rebase ${one.rebaseId} is recorded, and the branch did not move: ${one.detail}`,
        "Repeat the same command when it is settled. Operator never resets or adopts a moved branch.",
      ],
    }),
    rebased,
  })
    ? "reported"
    : "invalid-arguments";
}

/**
 * `operator work rebase`: with no plan revision it plans, and with one it rebases behind the
 * approval of that revision.
 */
export async function runRebase(parsed: ParsedArguments<"--source" | "--base">): Promise<Handled> {
  const { sourceId, newBase, planRevision, requestId, ownerToken } = parsed.crew;
  if (planRevision === undefined) {
    return requestId === undefined && ownerToken === undefined
      ? runPlan(parsed, sourceId, newBase)
      : "invalid-arguments";
  }
  return runApply(parsed, { sourceId, newBase, planRevision });
}
