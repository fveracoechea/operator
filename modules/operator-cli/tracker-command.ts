import { CrewState } from "../crew-state/main.ts";
import { type ParsedArguments, readRevision } from "./arguments.ts";
import { invalidInputRefusals, readStructuredInput, reportSharedFailure } from "./crew-result.ts";
import { finishLine } from "./source-finish.ts";
import {
  answer,
  type Handled,
  type Operation,
  type Outcome,
  type Reason,
  type Refusals,
  refuse,
  report,
  type TrackerReason,
} from "./result.ts";

type StepResult = Awaited<ReturnType<typeof CrewState.recordTracker>>["result"];
type StepsResult = Awaited<ReturnType<typeof CrewState.trackerSteps>>["result"];
type MapResult = Awaited<ReturnType<typeof CrewState.trackerMap>>["result"];
type StepReport = Extract<StepResult, { status: "reported" }>["report"];
type ApprovalBlocker = Extract<StepResult, { status: "write-blocked" }>["approval"];

/** Every tracker command shares these refusals, because every one reads the same binding. */
type AnyTrackerResult = StepResult | StepsResult | MapResult;

/**
 * The exit meaning of every tracker reason.
 * An unproven external effect is uncertain, a definite refusal is a failure, and a read that
 * failed never becomes proof that a write did not apply.
 */
const outcomeByTrackerReason = {
  "tracker.completed": "completed",
  "tracker.read_failed": "failed",
  "tracker.write_rejected": "failed",
  "tracker.invalid_request": "invalid",
  "tracker.capability_unavailable": "missing-condition",
  "tracker.approval_required": "missing-condition",
  "tracker.evidence_incomplete": "missing-condition",
  "tracker.resolution_conflict": "conflict",
  "tracker.completion_conflict": "conflict",
  "tracker.map_conflict": "conflict",
  "tracker.resolution_outcome_unknown": "uncertain",
  "tracker.completion_outcome_unknown": "uncertain",
  "tracker.map_outcome_unknown": "uncertain",
  "tracker.pending": "pending",
} as const satisfies Record<TrackerReason, Outcome>;

/** The blocker that names why another write is not permitted, and the line that explains it. */
function approvalBlocker(approval: ApprovalBlocker): {
  blocker: { reason: Reason; [key: string]: unknown };
  lines: string[];
} {
  if (approval.reason === "approval-required") {
    const { reason: _reason, ...detail } = approval;
    return {
      blocker: { reason: "tracker.approval_required", ...detail },
      lines: [
        `Another write needs a person's approval: grant ${approval.action} for ${approval.targets.join(", ")}`,
        `in scope ${approval.scope} at request revision ${approval.requestRevision}.`,
        "Elapsed time, an empty scan, and an agent inference authorize nothing.",
      ],
    };
  }
  if (approval.reason === "unknown-approval") {
    return {
      blocker: { reason: "unknown_approval", approvalId: approval.approvalId },
      lines: [`No approval is recorded as ${approval.approvalId}.`],
    };
  }
  if (approval.reason === "approval-revoked") {
    return {
      blocker: { reason: "approval_revoked", approvalId: approval.approvalId },
      lines: [`Approval ${approval.approvalId} was revoked, so it authorizes nothing.`],
    };
  }

  return {
    blocker: {
      reason: "approval_mismatch",
      approvalId: approval.approvalId,
      field: approval.field,
    },
    lines: [
      `Approval ${approval.approvalId} was granted for a different ${approval.field}.`,
      "An approval binds one exact action, its targets, its scope, and its request revision.",
    ],
  };
}

/**
 * Reports one step outcome. Every recorded problem is kept; only the ranking picks the reason.
 * A problem that blocks another write is recorded beside them, never in place of them, so an
 * unproven effect stays the overall result of the step it belongs to.
 */
function reportStep(request: {
  parsed: ParsedArguments;
  operation: Operation;
  report: StepReport;
  repeated: boolean;
  approval?: ApprovalBlocker;
  /** Whether the step finished its source, when it was the last one a publication owed. */
  finish?: Extract<StepResult, { status: "reported" }>["finish"];
}): Handled {
  const { report: step } = request;
  const { reason } = step;
  const blocked = request.approval === undefined ? null : approvalBlocker(request.approval);
  report({
    json: request.parsed.json,
    result: {
      outcome: outcomeByTrackerReason[reason],
      reason,
      blockers: [
        ...step.problems.map((problem) => ({
          reason: problem.reason,
          detail: problem.detail,
        })),
        ...(blocked === null ? [] : [blocked.blocker]),
      ],
      operation: request.operation,
      data: { ...step, repeated: request.repeated, finish: request.finish ?? null },
    },
    lines: [
      `Step ${step.step} of assignment ${step.assignmentId} is ${step.state} (${step.reason}).`,
      `Operation ${step.operationId} on ${step.provider}:${step.target.repository}#${step.target.issue}.`,
      ...(step.resourceUrl === null ? [] : [`Recorded resource ${step.resourceUrl}.`]),
      `${step.writeAttempts.length} write attempt(s), ${step.observations.length} observation(s).`,
      // The reading proves what the tracker shows now. It never proves who caused it.
      ...(step.step === "completion"
        ? ["The observed state is evidence of completion, not proof that Operator caused it."]
        : []),
      ...step.problems.map((problem) => `  ${problem.reason}: ${problem.detail}`),
      ...(blocked === null ? [] : blocked.lines),
      ...(request.finish?.status === "finished" ? [finishLine(request.finish)] : []),
    ],
  });
  return "reported";
}

/** The refusals both tracker mutations share, each under the contract reason that names it. */
function reportStepFailure(request: {
  parsed: ParsedArguments;
  operation: Operation;
  result: AnyTrackerResult;
}): Handled | null {
  const { parsed, operation, result } = request;

  if (result.status === "unknown-assignment") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "invalid",
      reason: "unknown_assignment",
      detail: { assignmentId: result.assignmentId },
      lines: [`No assignment is recorded as ${result.assignmentId}.`],
    });
  }

  if (result.status === "unknown-operation") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "invalid",
      reason: "tracker.invalid_request",
      detail: { operationId: result.operationId },
      lines: [`No tracker operation is recorded as ${result.operationId}.`],
    });
  }

  if (result.status === "tracker-unbound") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "invalid",
      reason: "tracker.invalid_request",
      detail: { assignmentId: result.assignmentId, detail: result.detail },
      lines: [
        result.detail,
        "Tracker updates go to the ticket the work was registered from, never to a guessed one.",
      ],
    });
  }

  if (result.status === "unsupported-provider") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "missing-condition",
      reason: "tracker.capability_unavailable",
      detail: { provider: result.provider },
      lines: [
        `This release implements no tracker integration for ${result.provider}.`,
        "GitHub is the only provider of the first release.",
      ],
    });
  }

  if (result.status === "stale-revision") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "conflict",
      reason: "stale_revision",
      detail: { assignmentId: result.assignmentId, recordedRevision: result.recordedRevision },
      lines: [`Assignment ${result.assignmentId} is at revision ${result.recordedRevision}.`],
    });
  }

  if (result.status === "target-mismatch") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "invalid",
      reason: "tracker.invalid_request",
      detail: { recorded: result.recorded, stated: result.stated },
      lines: [
        `This assignment is bound to ${result.recorded.repository}#${result.recorded.issue}.`,
        `The request names ${result.stated.repository}#${result.stated.issue}.`,
      ],
    });
  }

  if (result.status === "map-target-missing") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "invalid",
      reason: "tracker.invalid_request",
      detail: { assignmentId: result.assignmentId, sourceId: result.sourceId },
      lines: [`Source ${result.sourceId} records no map issue, so it holds no map to amend.`],
    });
  }

  if (result.status === "capability-unavailable") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "missing-condition",
      reason: "tracker.capability_unavailable",
      detail: { capability: result.capability, detail: result.detail },
      lines: [result.detail],
    });
  }

  if (result.status === "actor-unknown") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "failed",
      reason: "tracker.read_failed",
      detail: { detail: result.detail },
      lines: [
        "The account this machine writes as could not be read, so no comment was written.",
        result.detail,
      ],
    });
  }

  if (result.status === "content-changed") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "invalid",
      reason: "tracker.invalid_request",
      detail: { operationId: result.operationId, recorded: result.recorded, stated: result.stated },
      lines: [
        `Operation ${result.operationId} was recorded with different content.`,
        "Changed content is not a retry of the same operation. A correction is a new operation",
        "that identifies what it supersedes, and it needs its own approval.",
      ],
    });
  }

  return null;
}

/** The refusals of a resolution body: who writes it, and whether the tracker accepts its size. */
const resolutionRefusals = {
  "planning-body-not-allowed": (result) => ({
    outcome: "invalid",
    reason: "planning_body_not_allowed",
    detail: { assignmentId: result.assignmentId },
    lines: [
      `Assignment ${result.assignmentId} is planning work, so its resolution is rendered from its planning record.`,
      "Send the resolution step with no body. Prose belongs in a text artifact of the record.",
    ],
  }),
  "planning-record-missing": (result) => ({
    outcome: "missing-condition",
    reason: "planning_record_missing",
    detail: { assignmentId: result.assignmentId },
    lines: [
      `Assignment ${result.assignmentId} was accepted with no planning record, so no resolution can be rendered.`,
    ],
  }),
  "merge-not-observed": (result) => ({
    outcome: "missing-condition",
    reason: "merge_not_observed",
    detail: { assignmentId: result.assignmentId, detail: result.detail },
    lines: [
      `The tracker steps of ${result.assignmentId} run only after its pull request merged into the target. Nothing was written.`,
      result.detail,
    ],
  }),
  "code-resolution-body-not-allowed": (result) => ({
    outcome: "invalid",
    reason: "code_resolution_body_not_allowed",
    detail: { assignmentId: result.assignmentId },
    lines: [
      `Assignment ${result.assignmentId} is a code result, so its resolution is rendered from the recorded merge.`,
      "Send the resolution step with no body.",
    ],
  }),
  "completion-reason-not-approved": (result) => ({
    outcome: "invalid",
    reason: "completion_reason_not_approved",
    detail: { assignmentId: result.assignmentId, reason: result.reason },
    lines: [
      `The publish approval completes the ticket of ${result.assignmentId} as completed, not as ${result.reason}.`,
    ],
  }),
  "publish-approval-missing": (result) => ({
    outcome: "missing-condition",
    reason: "publish_approval_missing",
    detail: { ...result },
    lines: [
      `Publish approval ${result.approvalId} no longer names the ${result.step} step of ${result.assignmentId} with this text. Nothing was written.`,
      "A person settles it: no tracker write after the merge happens without that approval.",
    ],
  }),
  "map-amendment-approval-required": (result) => {
    const { approval } = result;
    return {
      outcome: "missing-condition",
      reason: "map_amendment_approval_required",
      detail: { ...result },
      lines: [
        `The map amendment of ${result.assignmentId} is rendered in ${result.planPath}. Nothing was written.`,
        `Show the person that text. It is written only after they grant ${approval.action} for ${approval.targets.join(", ")}`,
        `in scope ${approval.scope} at request revision ${approval.requestRevision}, which binds that exact text.`,
      ],
    };
  },
  "resolution-body-required": (result) => ({
    outcome: "invalid",
    reason: "resolution_body_required",
    detail: { assignmentId: result.assignmentId },
    lines: [`The resolution of ${result.assignmentId} states its body.`],
  }),
  "comment-too-long": (result) => ({
    outcome: "invalid",
    reason: "comment_too_long",
    detail: { size: result.size, limit: result.limit },
    lines: [
      `The comment is ${result.size} characters, and the tracker accepts at most ${result.limit}.`,
      "Nothing was written.",
    ],
  }),
  "artifact-unreadable": (result) => ({
    outcome: "missing-condition",
    reason: "artifact_unreadable",
    detail: { name: result.name, path: result.path },
    lines: [
      `The stored artifact ${result.name} is missing at ${result.path}.`,
      "Nothing was written.",
    ],
  }),
  "artifact-identity-changed": (result) => ({
    outcome: "conflict",
    reason: "artifact_identity_changed",
    detail: { name: result.name, path: result.path, found: result.found },
    lines: [
      `The stored artifact ${result.name} at ${result.path} no longer matches its record.`,
      "Nothing was written.",
    ],
  }),
} satisfies Refusals<StepResult>;

async function runRecord(parsed: ParsedArguments): Promise<Handled> {
  const { requestId, ownerToken, assignmentId, inputPath } = parsed.crew;
  const revision = readRevision(parsed);
  if (
    requestId === undefined ||
    ownerToken === undefined ||
    assignmentId === undefined ||
    inputPath === undefined ||
    revision === null
  ) {
    return "invalid-arguments";
  }

  const read = await readStructuredInput({
    parsed,
    operation: "tracker_record",
    reason: "tracker.invalid_request",
    path: inputPath,
  });
  if (read.status !== "read") {
    return "reported";
  }

  const { repeated, result } = await CrewState.recordTracker({
    projectRoot: process.cwd(),
    requestId,
    ownerToken,
    assignmentId,
    revision,
    approvalId: parsed.crew.approvalId ?? null,
    input: read.value,
  });

  if (
    answer(parsed, "tracker_record", result, {
      ...invalidInputRefusals("tracker.invalid_request"),
      ...resolutionRefusals,
    })
  ) {
    return "reported";
  }

  const refused = reportStepFailure({ parsed, operation: "tracker_record", result });
  if (refused !== null) {
    return refused;
  }

  if (result.status === "write-blocked") {
    return reportStep({
      parsed,
      operation: "tracker_record",
      report: result.report,
      repeated,
      approval: result.approval,
    });
  }

  return result.status === "reported"
    ? reportStep({
        parsed,
        operation: "tracker_record",
        report: result.report,
        repeated,
        finish: result.finish,
      })
    : "invalid-arguments";
}

async function runRecover(parsed: ParsedArguments): Promise<Handled> {
  const { requestId, ownerToken, operationId } = parsed.crew;
  if (requestId === undefined || ownerToken === undefined || operationId === undefined) {
    return "invalid-arguments";
  }

  const { repeated, result } = await CrewState.recoverTracker({
    projectRoot: process.cwd(),
    requestId,
    ownerToken,
    operationId,
  });

  if (reportSharedFailure(parsed, "tracker_recover", result)) {
    return "reported";
  }

  const refused = reportStepFailure({ parsed, operation: "tracker_recover", result });
  if (refused !== null) {
    return refused;
  }

  return result.status === "reported"
    ? reportStep({
        parsed,
        operation: "tracker_recover",
        report: result.report,
        repeated,
        finish: result.finish,
      })
    : "invalid-arguments";
}

async function runShow(parsed: ParsedArguments): Promise<Handled> {
  const assignmentId = parsed.crew.assignmentId;
  if (assignmentId === undefined) {
    return "invalid-arguments";
  }

  const { result } = await CrewState.trackerSteps({ projectRoot: process.cwd(), assignmentId });
  if (reportSharedFailure(parsed, "tracker_show", result)) {
    return "reported";
  }

  const refused = reportStepFailure({ parsed, operation: "tracker_show", result });
  if (refused !== null) {
    return refused;
  }

  if (result.status !== "reported") {
    return "invalid-arguments";
  }

  const { report: steps } = result;
  // A successful status query answers 0 even when it reports an incomplete tracker operation.
  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "tracker_steps_reported",
      blockers: [],
      operation: "tracker_show",
      data: steps,
    },
    lines: [
      `Assignment ${steps.assignmentId} on ${steps.provider}:${steps.repository}#${steps.issue}.`,
      ...steps.steps.map(
        (one) =>
          `  ${one.step}: ${one.applicable ? `${one.state} (${one.reason})` : "not applicable"}`,
      ),
      steps.complete
        ? "Every applicable step is verified."
        : `These steps are not verified: ${steps.incomplete.join(", ")}.`,
    ],
  });
  return "reported";
}

async function runMap(parsed: ParsedArguments): Promise<Handled> {
  const assignmentId = parsed.crew.assignmentId;
  if (assignmentId === undefined) {
    return "invalid-arguments";
  }

  const { result } = await CrewState.trackerMap({ projectRoot: process.cwd(), assignmentId });
  if (reportSharedFailure(parsed, "tracker_map", result)) {
    return "reported";
  }

  if (result.status === "unreadable") {
    return refuse({
      json: parsed.json,
      operation: "tracker_map",
      outcome: "failed",
      reason: "tracker.read_failed",
      detail: { detail: result.detail },
      lines: ["The map could not be read:", result.detail],
    });
  }

  const refused = reportStepFailure({ parsed, operation: "tracker_map", result });
  if (refused !== null) {
    return refused;
  }

  if (result.status !== "read") {
    return "invalid-arguments";
  }

  const { reading, verdict } = result;
  const reason = verdict.reason;

  report({
    json: parsed.json,
    result: {
      outcome: outcomeByTrackerReason[reason],
      reason,
      blockers: reading.problems.map((problem) => ({
        reason: problem.reason,
        detail: problem.detail,
      })),
      operation: "tracker_map",
      data: {
        repository: result.repository,
        issue: result.issue,
        ...reading,
      },
    },
    lines: [
      `Map ${result.repository}#${result.issue} holds ${reading.amendments.length} amendment(s) and ${reading.ordinaryComments} ordinary comment(s).`,
      `The baseline body has SHA256 ${reading.baselineIdentity}.`,
      `The scan read ${reading.coverage.pages} page(s) and is ${reading.coverage.complete ? "complete" : "incomplete"}.`,
      ...reading.effective.map((one) => `  effective ${one.operationId} ${one.url}`),
      ...reading.problems.map((problem) => `  ${problem.reason}: ${problem.detail}`),
    ],
  });
  return "reported";
}

export async function runTracker(words: string[], parsed: ParsedArguments): Promise<Handled> {
  if (words.length !== 1) {
    return "invalid-arguments";
  }

  const [subcommand] = words;
  if (subcommand === "record") {
    return runRecord(parsed);
  }
  if (subcommand === "recover") {
    return runRecover(parsed);
  }
  if (subcommand === "show") {
    return runShow(parsed);
  }
  if (subcommand === "map") {
    return runMap(parsed);
  }

  return "invalid-arguments";
}
