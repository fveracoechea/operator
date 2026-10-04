import { CrewState } from "../crew-state/main.ts";
import { type ParsedArguments, readMutation } from "./arguments.ts";
import {
  approvalText,
  approvalRequired,
  planPreview,
  planRevisionChanged,
} from "./plan-preview.ts";
import { answer, type Handled, type Reason, type Refusal, report } from "./result.ts";
import { finishLine } from "./source-finish.ts";

type Planned = Awaited<ReturnType<typeof CrewState.planPublish>>["result"];
type Preview = Extract<Planned, { status: "planned" }>;
type Applied = Awaited<ReturnType<typeof CrewState.publish>>["result"];
type Recalled = Awaited<ReturnType<typeof CrewState.recall>>["result"];

/** What the head of one publish plan reads on its target, or nothing when it was not read. */
function infoLines(info: Preview["info"]): string[] {
  if (info === null) {
    return [];
  }
  const merges =
    info.mergesCleanly === null
      ? "has no clean-merge reading"
      : info.mergesCleanly
        ? "merges cleanly"
        : "does not merge cleanly";
  return [
    `  The target is at ${info.targetTip ?? "an unread tip"}, ${info.commitsBehind ?? "an unread number of"} commit(s) past the base; the head ${merges}.`,
    ...(info.unverifiedRules.length === 0
      ? []
      : [`  ${info.unverifiedRules.length} rule reading(s) are unverified, not passed.`]),
  ];
}

/** What one publish plan ships, closes, and leaves to a person. */
function shipLines(preview: Preview): string[] {
  const { ships } = preview;
  const numbers = (pulls: { number: number }[]) => pulls.map((one) => `#${one.number}`).join(", ");
  return [
    ...(ships === null
      ? []
      : [
          `  ${ships.parts.length} pull request(s) from ${ships.parts.map((one) => one.name).join(", ")} into ${ships.target} through ${ships.remote.name}.`,
        ]),
    ...(preview.closes.length === 0
      ? []
      : [
          `  It closes ${numbers(preview.closes)}, which it replaces, each with one comment that names the replacement.`,
        ]),
    ...(preview.headMoved.length === 0
      ? []
      : [
          `  It writes nothing to ${numbers(preview.headMoved)}: a person moved its head (decision 21). A person closes it.`,
        ]),
  ];
}

/**
 * One publish plan as a summary and the path of the full text. The Operator reads this report,
 * so it names the counts, the approval, and the path, and never prints a body.
 */
function publishPreview(preview: Preview): Refusal {
  const refused = preview.refusals.length > 0;
  return planPreview({
    planned: "publish_planned",
    summary: [
      `Publish plan ${preview.planRevision ?? "(no revision)"} for ${preview.sourceId}, stack publication ${preview.publication}:`,
      ...shipLines(preview),
      ...infoLines(preview.info),
    ],
    refusals: {
      reason: "publish_refused",
      count: preview.refusals.length,
      list: preview.refusals.map((one) => one.reason).join(", "),
      blockers: preview.refusals.map((one) => ({ reason: one.reason, detail: one.detail })),
      nothing: "published",
    },
    ask: "Ask the person to read every title and body in the file below and to approve this exact plan revision.",
    apply: {
      label: "Publish it with",
      command:
        preview.planRevision === null
          ? null
          : `operator publish apply --request <id> --owner-token <token> --source ${preview.sourceId} --plan-revision ${preview.planRevision}`,
    },
    path: { label: "Every title, body, and refusal", planPath: preview.planPath },
    data: {
      sourceId: preview.sourceId,
      publication: preview.publication,
      planRevision: preview.planRevision,
      planPath: preview.planPath,
      remote: preview.ships?.remote ?? null,
      target: preview.ships?.target ?? null,
      names: preview.ships?.parts.map((one) => one.name) ?? [],
      closes: preview.closes.map((one) => one.number),
      headMoved: preview.headMoved.map((one) => one.number),
      info: preview.info,
      approval: refused ? null : preview.approval,
    },
  });
}

/** The answers of every publish operation to a source it cannot plan. */
const planRefusals = {
  "unknown-source": (result: { sourceId: string }): Refusal => ({
    outcome: "invalid",
    reason: "unknown_source",
    detail: { sourceId: result.sourceId },
    lines: [`No source ${result.sourceId} is recorded.`],
  }),
  unread: (result: { detail: string }): Refusal => ({
    outcome: "uncertain",
    reason: "integration_branch_unread",
    detail: { detail: result.detail },
    lines: [`Git cannot read the integration branch: ${result.detail}`],
  }),
};

const stopReasons: Record<string, Reason> = {
  conflict: "publish_conflict",
  failed: "publish_failed",
  uncertain: "publish_uncertain",
};

/** A write that stopped, with the settlement a person grants for a conflict (#120). */
function stopped(result: Extract<Applied, { status: "effect-stopped" }>): Refusal {
  const { settlement } = result;
  return {
    outcome: result.outcome.status === "uncertain" ? "uncertain" : "conflict",
    reason: stopReasons[result.outcome.status] ?? "publish_uncertain",
    detail: {
      publication: result.publication,
      effect: result.effect,
      outcome: result.outcome,
      settlement,
    },
    lines: [
      `Stack publication ${result.publication} stopped at its ${result.effect.kind} write: ${result.outcome.status}.`,
      result.outcome.status === "uncertain"
        ? "Run the same command again. It reads GitHub first and writes only what is missing."
        : "A person settles this. Operator writes nothing over it.",
      ...(settlement === null
        ? []
        : [
            "When the person accepts it as GitHub shows it, record their approval of this exact request:",
            `  ${approvalText(settlement)}`,
          ]),
    ],
  };
}

const MERGE_LINE = "A person merges it on GitHub with a merge commit. Operator never merges.";

export async function runPlan(parsed: ParsedArguments<"--source">): Promise<Handled> {
  // A preview changes nothing, and the Operator writes no text into it (ADR 0022, D1).
  const { sourceId } = parsed.crew;
  const { result } = await CrewState.planPublish({ projectRoot: process.cwd(), sourceId });
  return answer(parsed, "publish_plan", result, { planned: publishPreview, ...planRefusals })
    ? "reported"
    : "invalid-arguments";
}

export async function runApply(
  parsed: ParsedArguments<"--request" | "--owner-token" | "--source" | "--plan-revision">,
): Promise<Handled> {
  const { requestId, ownerToken, sourceId, planRevision } = parsed.crew;
  const { result } = await CrewState.publish({
    projectRoot: process.cwd(),
    requestId,
    ownerToken,
    sourceId,
    planRevision,
  });
  return answer(parsed, "publish_apply", result, {
    refused: ({ preview }) => publishPreview(preview),
    "plan-revision-changed": planRevisionChanged("published"),
    "approval-required": approvalRequired("published"),
    "effect-stopped": stopped,
    published: (published) => ({
      outcome: "completed",
      reason: "published",
      data: { publication: published.publication, pullRequests: published.pullRequests },
      lines: [
        `Stack publication ${published.publication} is published, ready for review:`,
        ...published.pullRequests.map(
          (one) => `  part ${one.part}: ${one.url ?? `#${one.number ?? "?"}`} from ${one.headName}`,
        ),
        MERGE_LINE,
      ],
    }),
    ...planRefusals,
  })
    ? "reported"
    : "invalid-arguments";
}

/**
 * Reports one merge observation as one line for each pull request. The Operator reads this, so
 * it names states and faults and points to `crew next` for what follows (R5).
 */
export async function runStatus(
  parsed: ParsedArguments<"--request" | "--owner-token" | "--source">,
): Promise<Handled> {
  const { requestId, ownerToken, sourceId } = parsed.crew;
  const mutation = { requestId, ownerToken };
  const operation = "publish_status";
  const { result } = await CrewState.publishStatus({
    projectRoot: process.cwd(),
    ...mutation,
    sourceId,
  });
  if (
    answer(parsed, operation, result, {
      "unknown-source": planRefusals["unknown-source"],
      "nothing-published": (one) => ({
        outcome: "missing-condition",
        reason: "nothing_published",
        detail: { sourceId: one.sourceId },
        lines: [`Source ${one.sourceId} has no stack publication to read.`],
      }),
      "publish-unsettled": (one) => ({
        outcome: "missing-condition",
        reason: "publish_unsettled",
        detail: { sourceId: one.sourceId, publication: one.publication },
        lines: [
          `Stack publication ${one.publication} has a write with no done outcome. Settle it first, as \`crew next\` names.`,
        ],
      }),
      unread: (one) => ({
        outcome: "uncertain",
        reason: "publish_unread",
        detail: { detail: one.detail },
        lines: [`GitHub could not be read, so nothing was recorded: ${one.detail}`],
      }),
    })
  ) {
    return "reported";
  }
  // A fault a person already settled stays in the reading, and it no longer blocks.
  const faults = result.settlements;
  report({
    json: parsed.json,
    result: {
      outcome: faults.length > 0 ? "conflict" : "completed",
      reason: faults.length > 0 ? "stack_fault" : "publish_observed",
      blockers: faults.map((one) => ({
        reason: "stack_fault",
        fault: one.fault,
        number: one.number,
        detail: one.detail,
        settlement: one.approval,
      })),
      operation,
      data: { publication: result.publication, seen: result.seen, finish: result.finish },
    },
    lines: [
      `Stack publication ${result.publication} as GitHub shows it now:`,
      ...result.seen.map(
        (one) =>
          `  part ${one.part}: #${one.number} is ${one.state}${one.method === null ? "" : ` by a ${one.method === "merge" ? "merge commit" : `${one.method} merge`}`}${one.fault === null ? "" : `, stack fault ${one.fault}: ${one.detail ?? ""}`}`,
      ),
      ...(faults.length > 0
        ? [
            "A person settles each stack fault. Operator adopts nothing from it.",
            "When the person accepts a fault as GitHub shows it, record their approval of its settlement:",
            ...faults.map(
              (one) => `  part ${one.part}, ${one.fault}: ${approvalText(one.approval)}`,
            ),
          ]
        : []),
      finishLine(result.finish),
      "Run `operator crew next` for what follows.",
    ],
  });
  return "reported";
}

/**
 * Changes the base of one part to the target after the part below merged by a merge commit. The
 * report names the part and whether GitHub needed the write, and nothing more (R5).
 */
export async function runRetarget(
  parsed: ParsedArguments<"--request" | "--owner-token" | "--source" | "--part">,
): Promise<Handled> {
  const { requestId, ownerToken, sourceId, part } = parsed.crew;
  const mutation = { requestId, ownerToken };
  const number = Number(part);
  if (!Number.isInteger(number) || number < 2) {
    return "invalid-arguments";
  }
  const { result } = await CrewState.retargetPublish({
    projectRoot: process.cwd(),
    ...mutation,
    sourceId,
    part: number,
  });
  // A refused or changed plan is not an outcome of a retarget, so it stays invalid arguments.
  return answer(parsed, "publish_retarget", result, {
    retargeted: (one) => ({
      outcome: "completed",
      reason: "pull_request_retargeted",
      data: { part: one.part, number: one.number, how: one.how },
      lines: [
        `Part ${one.part} (#${one.number}) now targets the target branch${one.how === "observed" ? ", as GitHub already showed; nothing was written" : ""}.`,
        MERGE_LINE,
      ],
    }),
    "not-due": (one) => ({
      outcome: "missing-condition",
      reason: "retarget_not_due",
      detail: { part: one.part, detail: one.detail },
      lines: [`${one.detail} Nothing was written.`],
    }),
    "stack-fault": (one) => ({
      outcome: "conflict",
      reason: "stack_fault",
      detail: { part: one.part, detail: one.detail },
      lines: [`${one.detail} Nothing was written.`],
    }),
    "approval-required": (one) => ({
      outcome: "missing-condition",
      reason: "approval_required",
      detail: { approval: one.approval },
      lines: [
        "The publish approval of this stack no longer covers the retarget. Nothing was written.",
      ],
    }),
    "publish-unsettled": (one) => ({
      outcome: "missing-condition",
      reason: "publish_unsettled",
      detail: { sourceId: one.sourceId },
      lines: ["The stack publication has a write with no done outcome. Settle it first."],
    }),
    "effect-stopped": stopped,
    ...planRefusals,
  })
    ? "reported"
    : "invalid-arguments";
}

/**
 * One recall plan as a summary and the path of every comment. The Operator reads this, so it
 * names the pull requests, the approval, and the path, and never prints a comment (R5).
 */
function recallPreview(preview: Extract<Recalled, { status: "planned" }>): Refusal {
  return planPreview({
    planned: "recall_planned",
    summary: [
      `Recall plan ${preview.planRevision} for ${preview.sourceId}, stack publication ${preview.publication}:`,
      `  ${preview.parts.map((one) => `#${one.number}`).join(", ")} become drafts with one comment each${preview.replaced ? "" : ", and close, because no new stack publication will replace them"}.`,
    ],
    ask: "Ask the person to read every comment in the file below and to approve this exact plan revision.",
    apply: {
      label: "Recall with",
      command: `operator publish recall --request <id> --owner-token <token> --source ${preview.sourceId} --plan-revision ${preview.planRevision}`,
    },
    path: { label: "Every comment", planPath: preview.planPath },
    data: {
      sourceId: preview.sourceId,
      publication: preview.publication,
      planRevision: preview.planRevision,
      planPath: preview.planPath,
      pullRequests: preview.parts.map((one) => one.number),
      replaced: preview.replaced,
      approval: preview.approval,
    },
  });
}

/** The answers of a recall plan and of a recall. A refused publish plan is not one of them. */
const recallAnswers = {
  planned: recallPreview,
  "nothing-to-recall": (result: { sourceId: string }): Refusal => ({
    outcome: "missing-condition",
    reason: "nothing_to_recall",
    detail: { sourceId: result.sourceId },
    lines: [`No commit to change is inside an open pull request of ${result.sourceId}.`],
  }),
  "plan-revision-changed": (
    result: Extract<Recalled, { status: "plan-revision-changed" }>,
  ): Refusal => ({
    outcome: "conflict",
    reason: "plan_revision_changed",
    detail: { ...result },
    lines: [
      `The recall plan is now ${result.planned ?? "different"}, not ${result.stated}. Nothing was recalled. Plan it again.`,
    ],
  }),
  "approval-required": approvalRequired("recalled"),
  recalled: (result: Extract<Recalled, { status: "recalled" }>): Refusal => ({
    outcome: "completed",
    reason: "stack_recalled",
    data: { ...result },
    lines: [
      `Stack publication ${result.publication}: ${result.pullRequests.map((one) => `#${one}`).join(", ")} ${result.closed ? "are drafts with the reason, and closed" : "are drafts with the reason"}.`,
      result.closed
        ? "No new stack publication replaces them. No branch is deleted."
        : "The change can run on the integration branch now. Run `operator crew next`.",
    ],
  }),
  "effect-stopped": stopped,
  ...planRefusals,
};

/**
 * Plans or applies the recall of the open published range of one source (decision 23). With no
 * plan revision it changes nothing. It never merges and never closes a pull request that a new
 * publication will replace.
 */
export async function runRecall(parsed: ParsedArguments<"--source">): Promise<Handled> {
  const { sourceId, planRevision } = parsed.crew;
  const mutation = readMutation(parsed);
  if (planRevision !== undefined && mutation === null) {
    return "invalid-arguments";
  }
  const projectRoot = process.cwd();
  const { result } =
    planRevision === undefined || mutation === null
      ? await CrewState.planRecall({ projectRoot, sourceId })
      : await CrewState.recall({ projectRoot, ...mutation, sourceId, planRevision });
  return answer(parsed, "publish_recall", result, recallAnswers) ? "reported" : "invalid-arguments";
}
