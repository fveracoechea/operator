import { CrewState } from "../crew-state/main.ts";
import { type ParsedArguments, readRevision } from "./arguments.ts";
import { readStructuredInput, reportInvalidInput, reportSharedFailure } from "./crew-result.ts";
import { type Handled, report } from "./result.ts";

// The record belongs to the crew state, so this command reads its shape from that interface.
type ApprovalRecord = Extract<
  Awaited<ReturnType<typeof CrewState.grantApproval>>["result"],
  { approval: unknown }
>["approval"];

function approvalLines(approval: ApprovalRecord): string[] {
  return [
    `Approval ${approval.approvalId} is ${approval.state} at revision ${approval.revision}.`,
    `Action ${approval.action} on ${approval.targets.join(", ")}.`,
    `Scope ${approval.scope}, request revision ${approval.requestRevision}.`,
  ];
}

async function runGrant(parsed: ParsedArguments): Promise<Handled> {
  const { requestId, ownerToken } = parsed.crew;
  if (requestId === undefined || ownerToken === undefined) {
    return "invalid-arguments";
  }

  const inputPath = parsed.crew.inputPath;
  if (inputPath === undefined) {
    return "invalid-arguments";
  }

  const input = await readStructuredInput({
    parsed,
    operation: "approval_grant",
    reason: "invalid_approval_input",
    path: inputPath,
  });
  if (input.status !== "read") {
    return "reported";
  }

  const { repeated, result } = await CrewState.grantApproval({
    projectRoot: process.cwd(),
    requestId,
    ownerToken,
    input: input.value,
  });

  if (reportSharedFailure(parsed, "approval_grant", result)) {
    return "reported";
  }
  if (result.status === "invalid-input") {
    return reportInvalidInput({
      parsed,
      operation: "approval_grant",
      reason: "invalid_approval_input",
      issues: result.issues,
    });
  }

  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "approval_granted",
      blockers: [],
      operation: "approval_grant",
      data: { ...result.approval, repeated },
    },
    lines: approvalLines(result.approval),
  });
  return "reported";
}

async function runRevoke(parsed: ParsedArguments): Promise<Handled> {
  const { requestId, ownerToken, approvalId } = parsed.crew;
  const revision = readRevision(parsed);
  if (
    requestId === undefined ||
    ownerToken === undefined ||
    approvalId === undefined ||
    revision === null
  ) {
    return "invalid-arguments";
  }

  const { repeated, result } = await CrewState.revokeApproval({
    projectRoot: process.cwd(),
    requestId,
    ownerToken,
    approvalId,
    revision,
  });

  if (reportSharedFailure(parsed, "approval_revoke", result)) {
    return "reported";
  }

  if (result.status === "unknown-approval") {
    report({
      json: parsed.json,
      result: {
        outcome: "invalid",
        reason: "unknown_approval",
        blockers: [{ reason: "unknown_approval", approvalId: result.approvalId }],
        operation: "approval_revoke",
      },
      lines: [`No approval is recorded as ${result.approvalId}.`],
    });
    return "reported";
  }

  if (result.status === "already-revoked") {
    report({
      json: parsed.json,
      result: {
        outcome: "completed",
        reason: "approval_already_revoked",
        blockers: [],
        operation: "approval_revoke",
        data: result.approval,
      },
      lines: approvalLines(result.approval),
    });
    return "reported";
  }

  if (result.status === "stale-revision") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "stale_revision",
        blockers: [
          {
            reason: "stale_revision",
            approvalId: result.approvalId,
            recordedRevision: result.recordedRevision,
          },
        ],
        operation: "approval_revoke",
      },
      lines: [`Approval ${result.approvalId} is at revision ${result.recordedRevision}.`],
    });
    return "reported";
  }

  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "approval_revoked",
      blockers: [],
      operation: "approval_revoke",
      data: { ...result.approval, repeated },
    },
    lines: [...approvalLines(result.approval), "It authorizes nothing from now on."],
  });
  return "reported";
}

async function runCheck(parsed: ParsedArguments): Promise<Handled> {
  const inputPath = parsed.crew.inputPath;
  if (inputPath === undefined) {
    return "invalid-arguments";
  }

  const input = await readStructuredInput({
    parsed,
    operation: "approval_check",
    reason: "invalid_approval_input",
    path: inputPath,
  });
  if (input.status !== "read") {
    return "reported";
  }

  const { result } = await CrewState.checkApproval({
    projectRoot: process.cwd(),
    input: input.value,
  });

  if (reportSharedFailure(parsed, "approval_check", result)) {
    return "reported";
  }
  if (result.status === "invalid-input") {
    return reportInvalidInput({
      parsed,
      operation: "approval_check",
      reason: "invalid_approval_input",
      issues: result.issues,
    });
  }

  if (result.status === "matched") {
    report({
      json: parsed.json,
      result: {
        outcome: "completed",
        reason: "approval_matched",
        blockers: [],
        operation: "approval_check",
        data: result.approval,
      },
      lines: approvalLines(result.approval),
    });
    return "reported";
  }

  const revoked = result.status === "revoked";
  report({
    json: parsed.json,
    result: {
      outcome: "missing-condition",
      reason: revoked ? "approval_revoked" : "approval_missing",
      blockers: [
        revoked
          ? { reason: "approval_revoked" as const, approvalId: result.approval.approvalId }
          : { reason: "approval_missing" as const },
      ],
      operation: "approval_check",
      ...(revoked ? { data: result.approval } : {}),
    },
    lines: revoked
      ? [`Approval ${result.approval.approvalId} covered this action and is revoked.`]
      : [
          "No approval covers this exact action, target, scope, and request revision.",
          "Silence, a timeout, a direction to finish, and an Operative report grant nothing.",
        ],
  });
  return "reported";
}

export async function runApproval(words: string[], parsed: ParsedArguments): Promise<Handled> {
  if (words.length !== 1) {
    return "invalid-arguments";
  }

  const [subcommand] = words;
  if (subcommand === "grant") {
    return runGrant(parsed);
  }
  if (subcommand === "revoke") {
    return runRevoke(parsed);
  }
  if (subcommand === "check") {
    return runCheck(parsed);
  }

  return "invalid-arguments";
}
