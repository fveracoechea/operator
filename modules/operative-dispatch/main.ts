import { HerdrControl } from "../herdr-control/main.ts";
import { SkillInstall } from "../skill-install/main.ts";
import { type AnswerDelivery, answerDocument } from "./answer.ts";
import { type PrepareOutcome, prepareInputs } from "./inputs.ts";
import { inspectReviewWork, inspectWork, type WorkInspection } from "./inspect.ts";
import { readReference } from "./reference.ts";
import { BRIEF_PATH, LOCAL_ROOT, REFERENCE_PATH, RELEASE_PATH } from "./plan.ts";
import { readSnapshot } from "./snapshot.ts";
import {
  agentKindFor,
  type Brief,
  type DispatchPlan,
  isSupportedHost,
  planDispatch,
  type Snapshot,
} from "./plan.ts";

type LaunchOutcome<Value> =
  | { status: "succeeded"; value: Value }
  | { status: "failed"; code: string; detail: string }
  | { status: "uncertain"; detail: string };

type SnapshotDrift = { input: string; recorded: string; current: string };

function describe(value: string | null): string {
  return value ?? "none";
}

export const OperativeDispatch = {
  /**
   * Reads the control reference one Operative worktree carries.
   * It names the controlling checkout, so an Operative never searches nearby directories for
   * the crew state that governs it.
   */
  async readReference(request: { worktreePath: string }) {
    return readReference(request.worktreePath);
  },

  /**
   * Reads one recorded launch snapshot.
   * A record this release cannot read blocks its attempt instead of launching against a guess.
   */
  readSnapshot(request: { recorded: string }) {
    return readSnapshot(request.recorded);
  },

  /**
   * The files one launch writes into an Operative worktree.
   * A cleanup preserves exactly this list, so the launch and the disposal read one rendering
   * of what Operator put there.
   */
  launchInputs(): Array<{ name: string; path: string }> {
    return [
      { name: "brief", path: BRIEF_PATH },
      { name: "control-reference", path: REFERENCE_PATH },
      { name: "release", path: RELEASE_PATH },
    ];
  },

  /**
   * The path prefixes Operator itself writes inside an Operative worktree.
   * Anything outside them is the occupant's own work, whichever reader is asking.
   */
  writtenPrefixes(request: { agentHost: string }): string[] {
    const prefixes = [LOCAL_ROOT];
    if (isSupportedHost(request.agentHost)) {
      prefixes.push(`${SkillInstall.targetRoot({ target: request.agentHost })}/`);
    }
    return prefixes;
  },

  /** Names the branch, checkout, agent, brief, and prompt of one launch before any effect. */
  plan(request: {
    projectRoot: string;
    brief: Brief;
    snapshot: Snapshot;
    baseCommit: string;
    branch: string | null;
    worktreePath: string | null;
  }): { status: "planned"; plan: DispatchPlan } | { status: "host-unnamed" } {
    const host = request.snapshot.selection.crew.host;
    if (!isSupportedHost(host)) {
      return { status: "host-unnamed" };
    }

    return {
      status: "planned",
      plan: planDispatch({ ...request, agentHost: host, agentKind: agentKindFor(host) }),
    };
  },

  /**
   * Compares a recorded launch snapshot against the current installation.
   * Recovery restores what an attempt was launched with, so a drifted input is reported
   * instead of being replaced by the current default.
   */
  verifySnapshot(request: { recorded: Snapshot; current: Snapshot }): SnapshotDrift[] {
    const pairs: Array<[string, string | null, string | null]> = [
      ["release.version", request.recorded.release.version, request.current.release.version],
      ["release.identity", request.recorded.release.identity, request.current.release.identity],
      ["lock.identity", request.recorded.lock.identity, request.current.lock.identity],
      ["skills.identity", request.recorded.skills.identity, request.current.skills.identity],
      [
        "selection.crew.host",
        request.recorded.selection.crew.host,
        request.current.selection.crew.host,
      ],
      [
        "selection.crew.model",
        request.recorded.selection.crew.model,
        request.current.selection.crew.model,
      ],
    ];

    return pairs
      .filter(([, recorded, current]) => recorded !== current)
      .map(([input, recorded, current]) => ({
        input,
        recorded: describe(recorded),
        current: describe(current),
      }));
  },

  /** Copies and verifies the fixed inputs one Operative worktree needs, and no credential. */
  async prepare(request: {
    projectRoot: string;
    plan: DispatchPlan;
    snapshot: Snapshot;
  }): Promise<PrepareOutcome> {
    return prepareInputs(request);
  },

  /** Creates the isolated Herdr worktree and reports the pane a launch can use. */
  async createWorktree(request: {
    projectRoot: string;
    plan: DispatchPlan;
  }): Promise<LaunchOutcome<{ workspaceId: string; worktreePath: string }>> {
    const created = await HerdrControl.createWorktree({
      repoRoot: request.projectRoot,
      path: request.plan.worktreePath,
      branch: request.plan.branch,
      baseCommit: request.plan.baseCommit,
      label: request.plan.agentName,
    });
    if (created.status === "failed") {
      return { status: "failed", code: created.code, detail: created.detail };
    }
    if (created.status === "uncertain") {
      return created;
    }

    return {
      status: "succeeded",
      value: {
        workspaceId: created.value.workspaceId,
        worktreePath: created.value.worktree.path,
      },
    };
  },

  /** Starts the selected agent host in the checkout's own pane, read fresh from its workspace. */
  async launch(request: {
    plan: DispatchPlan;
    workspaceId: string;
  }): Promise<LaunchOutcome<{ paneId: string; status: string }>> {
    const pane = await HerdrControl.findRootPane({ workspaceId: request.workspaceId });
    if (pane.status === "absent") {
      return {
        status: "failed",
        code: "workspace_not_found",
        detail: `Herdr holds no workspace ${request.workspaceId} to launch in.`,
      };
    }
    if (pane.status === "unknown") {
      return { status: "uncertain", detail: pane.detail };
    }

    const started = await HerdrControl.startAgent({
      name: request.plan.agentName,
      kind: request.plan.agentKind,
      paneId: pane.value.paneId,
    });
    if (started.status !== "succeeded") {
      return started.status === "failed"
        ? { status: "failed", code: started.code, detail: started.detail }
        : started;
    }

    return {
      status: "succeeded",
      value: { paneId: started.value.paneId, status: started.value.status },
    };
  },

  /** Delivers the brief pointer. Success means Herdr accepted the submission, not a turn. */
  async deliver(request: { plan: DispatchPlan }): Promise<LaunchOutcome<{ status: string }>> {
    const submitted = await HerdrControl.submitPrompt({
      target: request.plan.agentName,
      text: request.plan.promptText,
    });
    if (submitted.status !== "succeeded") {
      return submitted.status === "failed"
        ? { status: "failed", code: submitted.code, detail: submitted.detail }
        : submitted;
    }

    return { status: "succeeded", value: { status: submitted.value.status } };
  },

  /**
   * Reads what a reviewer changed in its own checkout.
   * Operator writes the launch inputs and its own skills there, so those paths are excluded
   * and whatever remains is an edit a review was never authorized to make.
   */
  async inspectReviewWorktree(request: {
    worktreePath: string;
    baseCommit: string;
    agentHost: string;
  }) {
    return inspectReviewWork({
      worktreePath: request.worktreePath,
      baseCommit: request.baseCommit,
      allowedPrefixes: OperativeDispatch.writtenPrefixes({ agentHost: request.agentHost }),
    });
  },

  /**
   * Carries one recorded answer to the Operative that asked for it.
   * Success means Herdr accepted the submission, so the Operative's own acknowledgement stays
   * the only proof that the answer arrived.
   */
  async deliverAnswer(request: {
    agentName: string;
    answer: AnswerDelivery;
  }): Promise<LaunchOutcome<{ status: string }>> {
    const submitted = await HerdrControl.submitPrompt({
      target: request.agentName,
      text: answerDocument(request.answer),
    });
    if (submitted.status !== "succeeded") {
      return submitted.status === "failed"
        ? { status: "failed", code: submitted.code, detail: submitted.detail }
        : submitted;
    }

    return { status: "succeeded", value: { status: submitted.value.status } };
  },

  /**
   * Reads what one attempt actually left behind.
   * Every call here is a read, so reconciliation and replacement never create a second writer.
   */
  async inspect(request: {
    projectRoot: string;
    agentName: string;
    worktreePath: string;
    baseCommit: string;
  }): Promise<{
    writer:
      | { state: "live"; paneId: string; status: string }
      | { state: "stopped" }
      | {
          state: "unknown";
          detail: string;
        };
    checkout: { state: "present" | "absent" } | { state: "unknown"; detail: string };
    work: WorkInspection;
  }> {
    const [agent, worktree, work] = await Promise.all([
      HerdrControl.findAgent({ name: request.agentName }),
      HerdrControl.findWorktree({ repoRoot: request.projectRoot, path: request.worktreePath }),
      inspectWork({ worktreePath: request.worktreePath, baseCommit: request.baseCommit }),
    ]);

    return {
      writer:
        agent.status === "found"
          ? { state: "live", paneId: agent.value.paneId, status: agent.value.status }
          : agent.status === "absent"
            ? { state: "stopped" }
            : { state: "unknown", detail: agent.detail },
      checkout:
        worktree.status === "unknown"
          ? { state: "unknown", detail: worktree.detail }
          : { state: worktree.status === "found" ? "present" : "absent" },
      work,
    };
  },
};
