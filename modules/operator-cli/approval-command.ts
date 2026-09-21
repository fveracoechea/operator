import { CrewState } from "../crew-state/main.ts";
import type { ParsedArguments } from "./arguments.ts";
import { readStructuredInput, reportSharedFailure } from "./crew-result.ts";
import { type Operation, report } from "./result.ts";

type Handled = "reported" | "invalid-arguments";

type ApprovalRecord = {
  approvalId: string;
  action: string;
  targets: string[];
  scope: string;
  requestRevision: string;
  state: string;
  revision: number;
};

function approvalLines(approval: ApprovalRecord): string[] {
  return [
    `Approval ${approval.approvalId} is ${approval.state} at revision ${approval.revision}.`,
    `Action ${approval.action} on ${approval.targets.join(", ")}.`,
    `Scope ${approval.scope}, request revision ${approval.requestRevision}.`,
  ];
}

async function readInput(
  parsed: ParsedArguments,
  operation: Operation,
): Promise<{ status: "read"; value: unknown } | { status: "reported" } | "invalid-arguments"> {
  const inputPath = parsed.crew.inputPath;
  if (inputPath === undefined) {
    return "invalid-arguments";
  }

  const input = await readStructuredInput(inputPath);
  if (input.ok) {
    return { status: "read", value: input.value };
  }

  report({
    json: parsed.json,
    result: {
      outcome: "invalid",
      reason: "invalid_approval_input",
      blockers: [{ reason: "invalid_approval_input", detail: input.detail }],
      operation,
    },
    lines: [`The approval request cannot be read: ${input.detail}`],
  });
  return { status: "reported" };
}

function reportIssues(parsed: ParsedArguments, operation: Operation, issues: string[]): Handled {
  report({
    json: parsed.json,
    result: {
      outcome: "invalid",
      reason: "invalid_approval_input",
      blockers: issues.map((issue) => ({ reason: "invalid_approval_input" as const, issue })),
      operation,
    },
    lines: ["The approval request is not valid:", ...issues.map((one) => `  ${one}`)],
  });
  return "reported";
}

async function runGrant(parsed: ParsedArguments): Promise<Handled> {
  const { requestId, ownerToken } = parsed.crew;
  if (requestId === undefined || ownerToken === undefined) {
    return "invalid-arguments";
  }

  const input = await readInput(parsed, "approval_grant");
  if (input === "invalid-arguments") {
    return input;
  }
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
    return reportIssues(parsed, "approval_grant", result.issues);
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
  const { requestId, ownerToken, approvalId, revision } = parsed.crew;
  if (
    requestId === undefined ||
    ownerToken === undefined ||
    approvalId === undefined ||
    revision === undefined ||
    !/^\d+$/.test(revision)
  ) {
    return "invalid-arguments";
  }

  const { repeated, result } = await CrewState.revokeApproval({
    projectRoot: process.cwd(),
    requestId,
    ownerToken,
    approvalId,
    revision: Number(revision),
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
  const input = await readInput(parsed, "approval_check");
  if (input === "invalid-arguments") {
    return input;
  }
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
    return reportIssues(parsed, "approval_check", result.issues);
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
