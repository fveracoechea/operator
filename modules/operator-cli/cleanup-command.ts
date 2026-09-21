import { CrewState } from "../crew-state/main.ts";
import type { ParsedArguments } from "./arguments.ts";
import { readRevision } from "./arguments.ts";
import { readStructuredInput, reportInvalidInput, reportSharedFailure } from "./crew-result.ts";
import { type Handled, type Operation, type Reason, refuse, report } from "./result.ts";

type CloseResult = Awaited<ReturnType<typeof CrewState.close>>["result"];
type CleanupReport = Extract<CloseResult, { report: unknown }>["report"];
type CleanupBlocker = Extract<CloseResult, { blockers: unknown }>["blockers"][number];

/** Every blocker reason this command reports is also a result reason, so the two cannot drift. */
function blockerOf(blocker: CleanupBlocker): { reason: Reason; [key: string]: unknown } {
  const { reason, ...detail } = blocker;
  return { reason, ...detail };
}

function cleanupLines(report: CleanupReport): string[] {
  return [
    `Cleanup ${report.kind} of attempt ${report.attemptId} is ${report.state}.`,
    `Checkout ${report.worktreePath} on ${report.branch}.`,
    `Operative ${report.agentName} runs on ${report.agentHost}.`,
    ...(report.detail === null ? [] : [`  ${report.detail}`]),
    ...report.evidence.map((one) => `  evidence ${one.name}: ${one.storedPath}`),
  ];
}

function mutationArguments(parsed: ParsedArguments) {
  const { requestId, ownerToken, attemptId } = parsed.crew;
  return requestId === undefined || ownerToken === undefined || attemptId === undefined
    ? null
    : { requestId, ownerToken, attemptId };
}

/**
 * Reports one cleanup that retained its resources.
 * Every blocker is listed, because the user decides what to settle first and a cleanup that
 * names only its first refusal sends them back for the rest one at a time.
 */
function reportBlocked(request: {
  parsed: ParsedArguments;
  operation: Operation;
  result: { report: CleanupReport; blockers: CleanupBlocker[] };
}): Handled {
  report({
    json: request.parsed.json,
    result: {
      outcome: "missing-condition",
      reason: "cleanup_blocked",
      blockers: request.result.blockers.map(blockerOf),
      operation: request.operation,
      data: request.result.report,
    },
    lines: [
      ...cleanupLines(request.result.report),
      "Nothing was stopped or removed. These blockers hold the resources:",
      ...request.result.blockers.map((one) => `  ${one.reason}`),
    ],
  });
  return "reported";
}

/** Reports an external effect that failed or never answered. An unproven effect keeps the row. */
function reportUnsettled(request: {
  parsed: ParsedArguments;
  operation: Operation;
  uncertain: boolean;
  result: { report: CleanupReport; detail: string };
}): Handled {
  const reason = request.uncertain ? "cleanup_uncertain" : "cleanup_failed";
  report({
    json: request.parsed.json,
    result: {
      outcome: request.uncertain ? "uncertain" : "failed",
      reason,
      blockers: [{ reason, detail: request.result.detail }],
      operation: request.operation,
      data: request.result.report,
    },
    lines: [
      ...cleanupLines(request.result.report),
      request.result.detail,
      request.uncertain
        ? "The effect may have landed. Run this cleanup again to settle it from what Herdr shows."
        : "The resources are retained.",
    ],
  });
  return "reported";
}

async function runClose(parsed: ParsedArguments): Promise<Handled> {
  const mutation = mutationArguments(parsed);
  if (mutation === null) {
    return "invalid-arguments";
  }

  const { repeated, result } = await CrewState.close({ projectRoot: process.cwd(), ...mutation });
  if (reportSharedFailure(parsed, "cleanup_close", result)) {
    return "reported";
  }

  if (result.status === "blocked") {
    return reportBlocked({ parsed, operation: "cleanup_close", result });
  }

  if (result.status === "uncertain" || result.status === "failed") {
    return reportUnsettled({
      parsed,
      operation: "cleanup_close",
      uncertain: result.status === "uncertain",
      result,
    });
  }

  const already = result.status === "already-closed";
  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: already ? "process_already_closed" : "process_closed",
      blockers: [],
      operation: "cleanup_close",
      data: { ...result.report, repeated },
    },
    lines: [
      ...cleanupLines(result.report),
      already
        ? "This process was already closed."
        : "The checkout is untouched. Removal is a separate approved outcome.",
    ],
  });
  return "reported";
}

async function runRemove(parsed: ParsedArguments): Promise<Handled> {
  const mutation = mutationArguments(parsed);
  if (mutation === null) {
    return "invalid-arguments";
  }

  const { repeated, result } = await CrewState.remove({ projectRoot: process.cwd(), ...mutation });
  if (reportSharedFailure(parsed, "cleanup_remove", result)) {
    return "reported";
  }

  if (result.status === "blocked") {
    return reportBlocked({ parsed, operation: "cleanup_remove", result });
  }

  if (result.status === "uncertain" || result.status === "failed") {
    return reportUnsettled({
      parsed,
      operation: "cleanup_remove",
      uncertain: result.status === "uncertain",
      result,
    });
  }

  const already = result.status === "already-removed";
  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: already ? "worktree_already_removed" : "worktree_removed",
      blockers: [],
      operation: "cleanup_remove",
      data: { ...result.report, repeated },
    },
    lines: [
      ...cleanupLines(result.report),
      already
        ? "This checkout was already removed."
        : "The preserved evidence stays readable in the controlling checkout.",
    ],
  });
  return "reported";
}

async function runHold(parsed: ParsedArguments): Promise<Handled> {
  const mutation = mutationArguments(parsed);
  const inputPath = parsed.crew.inputPath;
  if (mutation === null || inputPath === undefined) {
    return "invalid-arguments";
  }

  const read = await readStructuredInput({
    parsed,
    operation: "cleanup_hold",
    reason: "invalid_hold_input",
    path: inputPath,
  });
  if (read.status !== "read") {
    return "reported";
  }

  const { repeated, result } = await CrewState.holdResources({
    projectRoot: process.cwd(),
    ...mutation,
    input: read.value,
  });
  if (reportSharedFailure(parsed, "cleanup_hold", result)) {
    return "reported";
  }

  if (result.status === "invalid-input") {
    return reportInvalidInput({
      parsed,
      operation: "cleanup_hold",
      reason: "invalid_hold_input",
      issues: result.issues,
    });
  }

  const already = result.status === "already-held";
  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: already ? "resources_already_held" : "resources_held",
      blockers: [],
      operation: "cleanup_hold",
      data: { ...result.hold, repeated },
    },
    lines: [
      `Attempt ${result.hold.attemptId} is held: ${result.hold.reason}.`,
      result.hold.detail,
      "Every cleanup of this attempt waits until the hold is released.",
    ],
  });
  return "reported";
}

async function runRelease(parsed: ParsedArguments): Promise<Handled> {
  const mutation = mutationArguments(parsed);
  const revision = readRevision(parsed);
  if (mutation === null || revision === null) {
    return "invalid-arguments";
  }

  const { repeated, result } = await CrewState.releaseResources({
    projectRoot: process.cwd(),
    ...mutation,
    revision,
  });
  if (reportSharedFailure(parsed, "cleanup_release", result)) {
    return "reported";
  }

  if (result.status === "no-hold") {
    return refuse({
      json: parsed.json,
      operation: "cleanup_release",
      outcome: "missing-condition",
      reason: "no_retention_hold",
      detail: { attemptId: result.attemptId },
      lines: ["That attempt holds no retention hold to release."],
    });
  }

  if (result.status === "stale-revision") {
    return refuse({
      json: parsed.json,
      operation: "cleanup_release",
      outcome: "conflict",
      reason: "stale_revision",
      detail: { holdId: result.holdId, recordedRevision: result.recordedRevision },
      lines: [`That hold is at revision ${result.recordedRevision}.`],
    });
  }

  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "resources_released",
      blockers: [],
      operation: "cleanup_release",
      data: { ...result.hold, repeated },
    },
    lines: [
      `Attempt ${result.hold.attemptId} is released.`,
      "Every other cleanup gate still applies.",
    ],
  });
  return "reported";
}

async function runShow(parsed: ParsedArguments): Promise<Handled> {
  const { result } = await CrewState.cleanup({
    projectRoot: process.cwd(),
    attemptId: parsed.crew.attemptId ?? null,
  });
  if (reportSharedFailure(parsed, "cleanup_show", result)) {
    return "reported";
  }

  const unsettled = result.cleanups.filter((one) => one.state !== "done");
  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "cleanup_reported",
      blockers: [],
      operation: "cleanup_show",
      data: result,
    },
    lines: [
      `${result.cleanups.length} recorded cleanup(s), ${unsettled.length} still open.`,
      ...result.cleanups.map(
        (one) =>
          `  ${one.kind} ${one.attemptId}: ${one.state}${one.detail === null ? "" : ` (${one.detail})`}`,
      ),
      ...result.holds.map((one) => `  hold ${one.attemptId}: ${one.state} (${one.reason})`),
    ],
  });
  return "reported";
}

export async function runCleanup(words: string[], parsed: ParsedArguments): Promise<Handled> {
  if (words.length !== 1) {
    return "invalid-arguments";
  }

  const [subcommand] = words;
  if (subcommand === "close") {
    return runClose(parsed);
  }
  if (subcommand === "remove") {
    return runRemove(parsed);
  }
  if (subcommand === "hold") {
    return runHold(parsed);
  }
  if (subcommand === "release") {
    return runRelease(parsed);
  }
  if (subcommand === "show") {
    return runShow(parsed);
  }

  return "invalid-arguments";
}
