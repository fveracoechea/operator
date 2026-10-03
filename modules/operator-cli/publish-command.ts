import { CrewState } from "../crew-state/main.ts";
import { type ParsedArguments, readMutation } from "./arguments.ts";
import { reportSharedFailure } from "./crew-result.ts";
import { type Handled, type Operation, type Reason, refuse, report } from "./result.ts";

type Planned = Awaited<ReturnType<typeof CrewState.planPublish>>["result"];
type Preview = Extract<Planned, { status: "planned" }>;
type Applied = Awaited<ReturnType<typeof CrewState.publish>>["result"];

/**
 * Reports one publish plan as a summary and the path of the full text. The Operator reads this
 * report, so it names the counts, the approval, and the path, and never prints a body.
 */
function reportPreview(parsed: ParsedArguments, operation: Operation, preview: Preview): Handled {
  const refused = preview.refusals.length > 0;
  const command =
    preview.planRevision === null
      ? null
      : `operator publish apply --request <id> --owner-token <token> --source ${preview.sourceId} --plan-revision ${preview.planRevision}`;
  const info = preview.info;
  report({
    json: parsed.json,
    result: {
      outcome: refused ? "invalid" : "completed",
      reason: refused ? "publish_refused" : "publish_planned",
      blockers: preview.refusals.map((one) => ({ reason: one.reason, detail: one.detail })),
      operation,
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
        info,
        approval: refused ? null : preview.approval,
        command: refused ? null : command,
      },
    },
    lines: [
      `Publish plan ${preview.planRevision ?? "(no revision)"} for ${preview.sourceId}, stack publication ${preview.publication}:`,
      ...(preview.ships === null
        ? []
        : [
            `  ${preview.ships.parts.length} pull request(s) from ${preview.ships.parts.map((one) => one.name).join(", ")} into ${preview.ships.target} through ${preview.ships.remote.name}.`,
          ]),
      ...(preview.closes.length === 0
        ? []
        : [
            `  It closes ${preview.closes.map((one) => `#${one.number}`).join(", ")}, which it replaces, each with one comment that names the replacement.`,
          ]),
      ...(preview.headMoved.length === 0
        ? []
        : [
            `  It writes nothing to ${preview.headMoved.map((one) => `#${one.number}`).join(", ")}: a person moved its head (decision 21). A person closes it.`,
          ]),
      ...(info === null
        ? []
        : [
            `  The target is at ${info.targetTip ?? "an unread tip"}, ${info.commitsBehind ?? "an unread number of"} commit(s) past the base; the head ${info.mergesCleanly === null ? "has no clean-merge reading" : info.mergesCleanly ? "merges cleanly" : "does not merge cleanly"}.`,
            ...(info.unverifiedRules.length === 0
              ? []
              : [`  ${info.unverifiedRules.length} rule reading(s) are unverified, not passed.`]),
          ]),
      ...(refused
        ? [
            `  ${preview.refusals.length} refusal(s): ${preview.refusals.map((one) => one.reason).join(", ")}.`,
            "Nothing can be published until each refusal is settled.",
          ]
        : [
            "Ask the person to read every title and body in the file below and to approve this exact plan revision.",
            `Publish it with: ${command ?? ""}`,
          ]),
      `Every title, body, and refusal: ${preview.planPath}`,
    ],
  });
  return "reported";
}

async function runPlan(parsed: ParsedArguments): Promise<Handled> {
  // A preview changes nothing, and the Operator writes no text into it (ADR 0022, D1).
  const { sourceId, ...otherCrewFlags } = parsed.crew;
  if (sourceId === undefined || Object.keys(otherCrewFlags).length > 0) {
    return "invalid-arguments";
  }
  const { result } = await CrewState.planPublish({ projectRoot: process.cwd(), sourceId });
  return reportPlanned(parsed, "publish_plan", result);
}

function reportPlanned(
  parsed: ParsedArguments,
  operation: Operation,
  result: Planned | Applied,
): Handled {
  if (reportSharedFailure(parsed, operation, result)) {
    return "reported";
  }
  if (result.status === "planned") {
    return reportPreview(parsed, operation, result);
  }
  if (result.status === "unknown-source") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "invalid",
      reason: "unknown_source",
      detail: { sourceId: result.sourceId },
      lines: [`No source ${result.sourceId} is recorded.`],
    });
  }
  if (result.status === "unread") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "uncertain",
      reason: "integration_branch_unread",
      detail: { detail: result.detail },
      lines: [`Git cannot read the integration branch: ${result.detail}`],
    });
  }
  return "invalid-arguments";
}

const stopReasons: Record<string, Reason> = {
  conflict: "publish_conflict",
  failed: "publish_failed",
  uncertain: "publish_uncertain",
};

// oxlint-disable-next-line complexity -- Each outcome of an apply keeps its own reason.
async function runApply(parsed: ParsedArguments): Promise<Handled> {
  const mutation = readMutation(parsed);
  const { sourceId, planRevision } = parsed.crew;
  if (mutation === null || sourceId === undefined || planRevision === undefined) {
    return "invalid-arguments";
  }
  const operation = "publish_apply";
  const { result } = await CrewState.publish({
    projectRoot: process.cwd(),
    ...mutation,
    sourceId,
    planRevision,
  });
  if (result.status === "refused") {
    return reportPreview(parsed, operation, result.preview);
  }
  if (result.status === "plan-revision-changed") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "conflict",
      reason: "plan_revision_changed",
      detail: { ...result },
      lines: [
        `The plan is now ${result.planned ?? "refused"}, not ${result.stated}. Nothing was published.`,
        ...(result.planPath === null ? [] : [`Read the new plan: ${result.planPath}`]),
      ],
    });
  }
  if (result.status === "approval-required") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "missing-condition",
      reason: "approval_required",
      detail: { approval: result.approval, planPath: result.planPath },
      lines: [
        "Nothing was published. Ask the person to read the plan and approve this exact request:",
        `  action ${result.approval.action}, scope ${result.approval.scope}, targets ${result.approval.targets.join(", ")}, request revision ${result.approval.requestRevision}.`,
        `The plan: ${result.planPath}`,
      ],
    });
  }
  if (result.status === "effect-stopped") {
    return reportStopped(parsed, operation, result);
  }
  if (result.status === "published") {
    report({
      json: parsed.json,
      result: {
        outcome: "completed",
        reason: "published",
        blockers: [],
        operation,
        data: { publication: result.publication, pullRequests: result.pullRequests },
      },
      lines: [
        `Stack publication ${result.publication} is published, ready for review:`,
        ...result.pullRequests.map(
          (one) => `  part ${one.part}: ${one.url ?? `#${one.number ?? "?"}`} from ${one.headName}`,
        ),
        "A person merges it on GitHub with a merge commit. Operator never merges.",
      ],
    });
    return "reported";
  }
  return reportPlanned(parsed, operation, result);
}

type Status = Awaited<ReturnType<typeof CrewState.publishStatus>>["result"];
type Finish = Extract<Status, { status: "observed" }>["finish"];

function finishLine(finish: Finish): string {
  if (finish.status === "not-finished") {
    return `The source is not finished: ${finish.detail}`;
  }
  return finish.gateCheckout === "kept"
    ? `The source is finished. Its gate checkout stays: ${finish.detail ?? "Herdr did not remove it."}`
    : "The source is finished, and its gate checkout is removed. Every branch stays.";
}

/**
 * Reports one merge observation as one line for each pull request. The Operator reads this, so
 * it names states and faults and points to `crew next` for what follows (R5).
 */
async function runStatus(parsed: ParsedArguments): Promise<Handled> {
  const mutation = readMutation(parsed);
  const { sourceId, requestId: _request, ownerToken: _owner, ...otherCrewFlags } = parsed.crew;
  if (mutation === null || sourceId === undefined || Object.keys(otherCrewFlags).length > 0) {
    return "invalid-arguments";
  }
  const operation = "publish_status";
  const { result } = await CrewState.publishStatus({
    projectRoot: process.cwd(),
    ...mutation,
    sourceId,
  });
  if (reportSharedFailure(parsed, operation, result)) {
    return "reported";
  }
  if (result.status === "unknown-source") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "invalid",
      reason: "unknown_source",
      detail: { sourceId: result.sourceId },
      lines: [`No source ${result.sourceId} is recorded.`],
    });
  }
  if (result.status === "nothing-published") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "missing-condition",
      reason: "nothing_published",
      detail: { sourceId: result.sourceId },
      lines: [`Source ${result.sourceId} has no stack publication to read.`],
    });
  }
  if (result.status === "publish-unsettled") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "missing-condition",
      reason: "publish_unsettled",
      detail: { sourceId: result.sourceId, publication: result.publication },
      lines: [
        `Stack publication ${result.publication} has a write with no done outcome. Settle it first, as \`crew next\` names.`,
      ],
    });
  }
  if (result.status === "unread") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "uncertain",
      reason: "publish_unread",
      detail: { detail: result.detail },
      lines: [`GitHub could not be read, so nothing was recorded: ${result.detail}`],
    });
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
              (one) =>
                `  part ${one.part}, ${one.fault}: action ${one.approval.action}, scope ${one.approval.scope}, targets ${one.approval.targets.join(", ")}, request revision ${one.approval.requestRevision}.`,
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
// oxlint-disable-next-line complexity -- Each outcome of a retarget keeps its own reason.
async function runRetarget(parsed: ParsedArguments): Promise<Handled> {
  const mutation = readMutation(parsed);
  const {
    sourceId,
    part,
    requestId: _request,
    ownerToken: _owner,
    ...otherCrewFlags
  } = parsed.crew;
  const number = Number(part);
  if (
    mutation === null ||
    sourceId === undefined ||
    !Number.isInteger(number) ||
    number < 2 ||
    Object.keys(otherCrewFlags).length > 0
  ) {
    return "invalid-arguments";
  }
  const operation = "publish_retarget";
  const { result } = await CrewState.retargetPublish({
    projectRoot: process.cwd(),
    ...mutation,
    sourceId,
    part: number,
  });
  if (reportSharedFailure(parsed, operation, result)) {
    return "reported";
  }
  if (result.status === "retargeted") {
    report({
      json: parsed.json,
      result: {
        outcome: "completed",
        reason: "pull_request_retargeted",
        blockers: [],
        operation,
        data: { part: result.part, number: result.number, how: result.how },
      },
      lines: [
        `Part ${result.part} (#${result.number}) now targets the target branch${result.how === "observed" ? ", as GitHub already showed; nothing was written" : ""}.`,
        "A person merges it on GitHub with a merge commit. Operator never merges.",
      ],
    });
    return "reported";
  }
  if (result.status === "not-due" || result.status === "stack-fault") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: result.status === "stack-fault" ? "conflict" : "missing-condition",
      reason: result.status === "stack-fault" ? "stack_fault" : "retarget_not_due",
      detail: { part: result.part, detail: result.detail },
      lines: [`${result.detail} Nothing was written.`],
    });
  }
  if (result.status === "approval-required") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "missing-condition",
      reason: "approval_required",
      detail: { approval: result.approval },
      lines: [
        "The publish approval of this stack no longer covers the retarget. Nothing was written.",
      ],
    });
  }
  if (result.status === "publish-unsettled") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "missing-condition",
      reason: "publish_unsettled",
      detail: { sourceId: result.sourceId },
      lines: ["The stack publication has a write with no done outcome. Settle it first."],
    });
  }
  if (result.status === "effect-stopped") {
    return reportStopped(parsed, operation, result);
  }
  return reportPlanned(parsed, operation, result);
}

type Recalled = Awaited<ReturnType<typeof CrewState.recall>>["result"];

/**
 * Reports one recall plan as a summary and the path of every comment. The Operator reads this,
 * so it names the pull requests, the approval, and the path, and never prints a comment (R5).
 */
function reportRecallPlan(
  parsed: ParsedArguments,
  preview: Extract<Recalled, { status: "planned" }>,
): Handled {
  const command = `operator publish recall --request <id> --owner-token <token> --source ${preview.sourceId} --plan-revision ${preview.planRevision}`;
  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "recall_planned",
      blockers: [],
      operation: "publish_recall",
      data: {
        sourceId: preview.sourceId,
        publication: preview.publication,
        planRevision: preview.planRevision,
        planPath: preview.planPath,
        pullRequests: preview.parts.map((one) => one.number),
        replaced: preview.replaced,
        approval: preview.approval,
        command,
      },
    },
    lines: [
      `Recall plan ${preview.planRevision} for ${preview.sourceId}, stack publication ${preview.publication}:`,
      `  ${preview.parts.map((one) => `#${one.number}`).join(", ")} become drafts with one comment each${preview.replaced ? "" : ", and close, because no new stack publication will replace them"}.`,
      "Ask the person to read every comment in the file below and to approve this exact plan revision.",
      `Recall with: ${command}`,
      `Every comment: ${preview.planPath}`,
    ],
  });
  return "reported";
}

/**
 * Plans or applies the recall of the open published range of one source (decision 23). With no
 * plan revision it changes nothing. It never merges and never closes a pull request that a new
 * publication will replace.
 */
// oxlint-disable-next-line complexity -- Each outcome of a recall keeps its own reason.
async function runRecall(parsed: ParsedArguments): Promise<Handled> {
  const {
    sourceId,
    planRevision,
    requestId: _request,
    ownerToken: _owner,
    ...otherCrewFlags
  } = parsed.crew;
  if (sourceId === undefined || Object.keys(otherCrewFlags).length > 0) {
    return "invalid-arguments";
  }
  const operation = "publish_recall";
  let result: Recalled;
  if (planRevision === undefined) {
    result = (await CrewState.planRecall({ projectRoot: process.cwd(), sourceId })).result;
  } else {
    const mutation = readMutation(parsed);
    if (mutation === null) {
      return "invalid-arguments";
    }
    result = (
      await CrewState.recall({ projectRoot: process.cwd(), ...mutation, sourceId, planRevision })
    ).result;
  }
  if (reportSharedFailure(parsed, operation, result)) {
    return "reported";
  }
  switch (result.status) {
    case "planned":
      return reportRecallPlan(parsed, result);
    case "nothing-to-recall":
      return refuse({
        json: parsed.json,
        operation,
        outcome: "missing-condition",
        reason: "nothing_to_recall",
        detail: { sourceId: result.sourceId },
        lines: [`No commit to change is inside an open pull request of ${result.sourceId}.`],
      });
    case "unknown-source":
      return refuse({
        json: parsed.json,
        operation,
        outcome: "invalid",
        reason: "unknown_source",
        detail: { sourceId: result.sourceId },
        lines: [`No source ${result.sourceId} is recorded.`],
      });
    case "plan-revision-changed":
      return refuse({
        json: parsed.json,
        operation,
        outcome: "conflict",
        reason: "plan_revision_changed",
        detail: { ...result },
        lines: [
          `The recall plan is now ${result.planned ?? "different"}, not ${result.stated}. Nothing was recalled. Plan it again.`,
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
          "Nothing was recalled. Ask the person to read the plan and approve this exact request:",
          `  action ${result.approval.action}, scope ${result.approval.scope}, targets ${result.approval.targets.join(", ")}, request revision ${result.approval.requestRevision}.`,
          `The plan: ${result.planPath}`,
        ],
      });
    case "recalled":
      report({
        json: parsed.json,
        result: {
          outcome: "completed",
          reason: "stack_recalled",
          blockers: [],
          operation,
          data: { ...result },
        },
        lines: [
          `Stack publication ${result.publication}: ${result.pullRequests.map((one) => `#${one}`).join(", ")} ${result.closed ? "are drafts with the reason, and closed" : "are drafts with the reason"}.`,
          result.closed
            ? "No new stack publication replaces them. No branch is deleted."
            : "The change can run on the integration branch now. Run `operator crew next`.",
        ],
      });
      return "reported";
    case "effect-stopped":
      return reportStopped(parsed, operation, result);
    default:
      return reportPlanned(parsed, operation, result);
  }
}

/** Reports a write that stopped, with the settlement a person grants for a conflict (#120). */
function reportStopped(
  parsed: ParsedArguments,
  operation: Operation,
  result: Extract<Applied, { status: "effect-stopped" }>,
): Handled {
  const { settlement } = result;
  return refuse({
    json: parsed.json,
    operation,
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
            `  action ${settlement.action}, scope ${settlement.scope}, targets ${settlement.targets.join(", ")}, request revision ${settlement.requestRevision}.`,
          ]),
    ],
  });
}

/** `operator publish`: the plan, the apply that also settles a publication, and the status. */
export async function runPublish(words: string[], parsed: ParsedArguments): Promise<Handled> {
  if (words.length !== 1) {
    return "invalid-arguments";
  }
  if (words[0] === "plan") {
    return runPlan(parsed);
  }
  if (words[0] === "status") {
    return runStatus(parsed);
  }
  if (words[0] === "retarget") {
    return runRetarget(parsed);
  }
  if (words[0] === "recall") {
    return runRecall(parsed);
  }
  return words[0] === "apply" ? runApply(parsed) : "invalid-arguments";
}
