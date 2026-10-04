import type { Reason, Refusal } from "./result.ts";

/** The refusals of one plan as its preview reports them. */
type PlanRefusals = {
  /** The reason of the report when the plan holds at least one refusal. */
  reason: Reason;
  count: number;
  /** The refusal reasons as one list, such as "a, b" or "a x2, b x1". */
  list: string;
  blockers: NonNullable<Refusal["blockers"]>;
  /** What nothing can be until each refusal is settled, such as "published". */
  nothing: string;
};

/**
 * One plan preview: the summary lines that only its caller knows, and the words of the tail that
 * every plan of publish, rebase, recall, and registration shares.
 */
export type PlanPreview = {
  planned: Reason;
  summary: string[];
  /** A plan that is never refused, such as a recall, names no refusals. */
  refusals?: PlanRefusals;
  /** The line that asks the person to approve this exact plan revision, if the plan needs one. */
  ask: string | null;
  /** The apply line, such as "Publish it with", and its command. */
  apply: { label: string; command: string | null };
  /** The path line, such as "Every comment", and the plan file. */
  path: { label: string; planPath: string };
  /** The data of the report. The preview adds the command last, or null when refused. */
  data: Record<string, unknown>;
};

/**
 * The answer to one plan preview. The Operator reads it, so it names the summary, the refusals or
 * the approval, and the path of the full plan, and never prints the plan itself (R5).
 */
export function planPreview(preview: PlanPreview): Refusal {
  const refused = (preview.refusals?.count ?? 0) > 0 ? preview.refusals : undefined;
  const { apply, path } = preview;
  const tail =
    refused === undefined
      ? [...(preview.ask === null ? [] : [preview.ask]), `${apply.label}: ${apply.command ?? ""}`]
      : [
          `  ${refused.count} refusal(s): ${refused.list}.`,
          `Nothing can be ${refused.nothing} until each refusal is settled.`,
        ];
  return {
    outcome: refused === undefined ? "completed" : "invalid",
    reason: refused?.reason ?? preview.planned,
    blockers: preview.refusals?.blockers ?? [],
    data: { ...preview.data, command: refused === undefined ? apply.command : null },
    lines: [...preview.summary, ...tail, `${path.label}: ${path.planPath}`],
  };
}

type ApprovalRequest = {
  action: string;
  scope: string;
  targets: string[];
  requestRevision: string;
};

/** The words that name the exact request a person approves. */
export function approvalText(approval: ApprovalRequest): string {
  return `action ${approval.action}, scope ${approval.scope}, targets ${approval.targets.join(", ")}, request revision ${approval.requestRevision}.`;
}

/** The refusal of an apply whose plan revision has no approval yet. Nothing was `done`. */
export function approvalRequired(done: string) {
  return (result: { approval: ApprovalRequest; planPath: string }): Refusal => ({
    outcome: "missing-condition",
    reason: "approval_required",
    detail: { approval: result.approval, planPath: result.planPath },
    lines: [
      `Nothing was ${done}. Ask the person to read the plan and approve this exact request:`,
      `  ${approvalText(result.approval)}`,
      `The plan: ${result.planPath}`,
    ],
  });
}

/** The refusal of an apply whose stated plan revision is no longer the plan. Nothing was `done`. */
export function planRevisionChanged(done: string) {
  return (result: {
    status: string;
    stated: string;
    planned: string | null;
    planPath: string | null;
  }): Refusal => ({
    outcome: "conflict",
    reason: "plan_revision_changed",
    detail: { ...result },
    lines: [
      `The plan is now ${result.planned ?? "refused"}, not ${result.stated}. Nothing was ${done}.`,
      ...(result.planPath === null ? [] : [`Read the new plan: ${result.planPath}`]),
    ],
  });
}
