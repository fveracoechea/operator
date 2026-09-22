import { HerdrControl } from "../herdr-control/main.ts";
import { briefFor, type ProbeStep, readReport, type ReportOf } from "./protocol.ts";
import type { Scratch } from "./scratch.ts";
import { waitForFile } from "./scratch.ts";

export type Host = "opencode" | "claude-code";

export type Lifecycle = {
  runId: string;
  probeId: string;
  projectRoot: string;
  operator: { host: Host; model: string | null };
  crew: { host: Host; model: string | null };
  /** The window one bounded read waits in. A window that runs out is a failure, never a wait. */
  observationMs: number;
};

export const LIFECYCLE_CHECKS = [
  "herdr-worktree",
  "agent-launch",
  "instruction-and-skill-loading",
  "bounded-observation",
  "question-and-answer",
  "result-reporting",
  "review-sub-agents",
  "mixed-host-operation",
  "interruption",
  "explicit-takeover",
  "host-termination",
  "worktree-removal",
];

export type Launched = { name: string; paneId: string };

type Answer<Step extends ProbeStep> =
  | { status: "answered"; report: ReportOf<Step>; identity: string; waitedMs: number }
  | { status: "unanswered"; detail: string };

/**
 * Sends one synthetic brief and reads the answer the agent wrote back.
 * Herdr acknowledges the submission and never a turn, so the written report is the only proof
 * that the agent received the brief and acted on it.
 */
export async function ask<Step extends ProbeStep>(
  lifecycle: Lifecycle,
  request: { agent: Launched; step: Step; scratch: Scratch; instructions: string[] },
): Promise<Answer<Step>> {
  const reportPath = `${request.scratch.worktreePath}/.operator/probe/${request.step}.json`;
  const brief = briefFor({
    probeId: lifecycle.probeId,
    step: request.step,
    reportPath,
    instructions: request.instructions,
  });

  const submitted = await HerdrControl.submitPrompt({ target: request.agent.name, text: brief });
  if (submitted.status !== "succeeded") {
    return {
      status: "unanswered",
      detail: `Herdr did not accept the ${request.step} brief: ${submitted.status === "failed" ? `${submitted.code}: ${submitted.detail}` : submitted.detail}`,
    };
  }

  const waited = await waitForFile({ path: reportPath, windowMs: lifecycle.observationMs });
  if (waited.status === "timed-out") {
    return {
      status: "unanswered",
      detail: `The agent wrote no ${request.step} report inside its ${lifecycle.observationMs} ms window.`,
    };
  }

  const read = readReport(request.step, waited.text);
  return read.status === "read"
    ? {
        status: "answered",
        report: read.report,
        identity: read.identity,
        waitedMs: waited.waitedMs,
      }
    : { status: "unanswered", detail: `The ${request.step} report cannot be read: ${read.detail}` };
}

export function reportEvidence(step: ProbeStep, scratch: Scratch, identity: string) {
  return [
    {
      label: `${step} report`,
      path: `${scratch.worktreePath}/.operator/probe/${step}.json`,
      identity,
    },
  ];
}

export async function startAgent(
  lifecycle: Lifecycle,
  request: { role: "operator" | "crew"; workspaceId: string },
): Promise<{ status: "started"; agent: Launched } | { status: "failed"; detail: string }> {
  const pane = await HerdrControl.findRootPane({ workspaceId: request.workspaceId });
  if (pane.status !== "found") {
    return {
      status: "failed",
      detail: `Herdr named no pane for workspace ${request.workspaceId}: ${pane.status === "absent" ? "the workspace is gone" : pane.detail}`,
    };
  }

  const name = `operator-probe-${lifecycle.runId}-${request.role}`;
  const started = await HerdrControl.startAgent({
    name,
    kind: lifecycle[request.role].host,
    paneId: pane.value.paneId,
  });
  if (started.status !== "succeeded") {
    return {
      status: "failed",
      detail: `Herdr did not start the ${request.role} host: ${started.status === "failed" ? `${started.code}: ${started.detail}` : started.detail}`,
    };
  }

  return { status: "started", agent: { name, paneId: started.value.paneId } };
}

/** Stops one host with its own keys and proves Herdr stopped reporting it. */
export async function stopAgent(
  agent: Launched,
): Promise<{ status: "stopped" } | { status: "failed"; detail: string }> {
  const stopped = await HerdrControl.stopAgent({ target: agent.name, keys: ["Escape", "C-c"] });
  if (stopped.status === "uncertain") {
    return { status: "failed", detail: `The stop left no answer: ${stopped.detail}` };
  }

  const found = await HerdrControl.findAgent({ name: agent.name });
  if (found.status === "found") {
    return { status: "failed", detail: `Herdr still reports ${agent.name} as live.` };
  }
  if (found.status === "unknown") {
    return {
      status: "failed",
      detail: `Herdr cannot say whether ${agent.name} stopped: ${found.detail}`,
    };
  }

  return { status: "stopped" };
}
