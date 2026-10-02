import { ToolInvocation } from "../tool-invocation/main.ts";
import { type HerdrOutcome, invokeHerdr } from "./invoke.ts";

/**
 * Every call is bounded, because an unbounded one would hold a launch open with no answer.
 * A creation and a launch get room beyond Herdr's own startup timeout, so a slow machine
 * reports a real outcome instead of an uncertain one.
 */
const CREATE_TIMEOUT_MS = 180_000;
const LAUNCH_TIMEOUT_MS = 120_000;
const READ_TIMEOUT_MS = 30_000;

type Worktree = { path: string; branch: string | null; workspaceId: string | null };

type Agent = { name: string | null; paneId: string; cwd: string | null; status: string };

/** One process a pane still runs. The shell itself is named apart from what it started. */
type PaneProcess = { pid: number; name: string; command: string };

type PaneProcesses = { shellPid: number | null; foreground: PaneProcess[] };

/** A read that answers definitely, so `absent` is evidence and `unknown` is not. */
type Lookup<Value> =
  | { status: "found"; value: Value }
  | { status: "absent" }
  | { status: "unknown"; detail: string };

function readWorktree(source: unknown): Worktree | null {
  const path = ToolInvocation.text(source, "path");
  return path === null
    ? null
    : {
        path,
        branch: ToolInvocation.text(source, "branch"),
        workspaceId: ToolInvocation.text(source, "open_workspace_id"),
      };
}

function readAgent(source: unknown): Agent | null {
  const paneId = ToolInvocation.text(source, "pane_id");
  return paneId === null
    ? null
    : {
        name: ToolInvocation.text(source, "name"),
        paneId,
        cwd: ToolInvocation.text(source, "cwd"),
        status: ToolInvocation.text(source, "agent_status") ?? "unknown",
      };
}

function readPaneProcess(source: unknown): PaneProcess | null {
  const pid = ToolInvocation.number(source, "pid");
  return pid === null
    ? null
    : {
        pid,
        name: ToolInvocation.text(source, "name") ?? "unknown",
        command: ToolInvocation.text(source, "cmdline") ?? "",
      };
}

function lookupFrom<Value>(
  outcome: HerdrOutcome<unknown>,
  absentCodes: string[],
  read: (result: unknown) => Value | null,
): Lookup<Value> {
  if (outcome.status === "uncertain") {
    return { status: "unknown", detail: outcome.detail };
  }
  if (outcome.status === "failed") {
    return absentCodes.includes(outcome.code)
      ? { status: "absent" }
      : { status: "unknown", detail: `${outcome.code}: ${outcome.detail}` };
  }

  const value = read(outcome.value);
  return value === null
    ? { status: "unknown", detail: "herdr answered in a shape this release cannot read." }
    : { status: "found", value };
}

export const HerdrControl = {
  /** Checks the enabled wake plugin against the release that runs this CLI. */
  async wakePlugin(herdrVersion: string) {
    const invoked = await ToolInvocation.run({
      tool: "herdr",
      args: ["plugin", "list", "--json"],
      timeoutMs: 5_000,
    });
    const nextAction =
      'Run `herdr plugin link "$(operator wake plugin-path)"` and `herdr plugin enable operator.wake`, then check again. Unlink an earlier copy first.';
    if (invoked.status !== "completed" || invoked.exitCode !== 0) {
      return {
        state: "failed" as const,
        detail:
          invoked.status === "completed"
            ? `Herdr plugin list exited ${invoked.exitCode}.`
            : invoked.detail,
        nextAction,
      };
    }
    let answer: unknown;
    try {
      answer = JSON.parse(invoked.stdout);
    } catch {
      return {
        state: "failed" as const,
        detail: "Herdr plugin list returned invalid JSON.",
        nextAction,
      };
    }
    const plugins = ToolInvocation.list(ToolInvocation.record(answer, "result"), "plugins");
    const plugin = plugins.find((one) => ToolInvocation.text(one, "plugin_id") === "operator.wake");
    if (plugin === undefined) {
      return {
        state: "failed" as const,
        detail: "The Operator wake plugin is not installed.",
        nextAction,
      };
    }
    const expected = new URL("../../herdr/herdr-plugin.toml", import.meta.url).pathname;
    const actual = ToolInvocation.text(plugin, "manifest_path");
    const minimum = ToolInvocation.text(plugin, "min_herdr_version");
    const compatible = minimum !== null && Bun.semver.satisfies(herdrVersion, `>=${minimum}`);
    const enabled = ToolInvocation.record(plugin, "enabled") === true;
    const warnings = ToolInvocation.record(plugin, "warnings");
    if (
      actual !== expected ||
      !enabled ||
      !compatible ||
      (Array.isArray(warnings) && warnings.length > 0)
    ) {
      return {
        state: "failed" as const,
        detail: `The Operator wake plugin is ${enabled ? "enabled" : "disabled"} at ${actual ?? "an unknown path"}; expected ${expected}. Herdr ${herdrVersion} must meet the plugin minimum ${minimum ?? "unknown"}.${Array.isArray(warnings) && warnings.length > 0 ? " Herdr reports plugin warnings." : ""}`,
        nextAction:
          !compatible && minimum !== null
            ? `Upgrade Herdr to ${minimum} or later, then check again.`
            : nextAction,
      };
    }
    return {
      state: "passed" as const,
      detail: "The enabled Operator wake plugin matches this CLI release.",
      nextAction: null,
    };
  },
  /** A read-only server request. A version string alone cannot prove a server connection. */
  async connection(request: { repoRoot: string }) {
    const result = await invokeHerdr({
      args: ["worktree", "list", "--cwd", request.repoRoot],
      timeoutMs: READ_TIMEOUT_MS,
    });
    if (
      result.status === "succeeded" &&
      result.value !== null &&
      typeof result.value === "object" &&
      "worktrees" in result.value &&
      Array.isArray(result.value.worktrees)
    ) {
      return {
        state: "passed" as const,
        detail: "Herdr answered a worktree list request.",
        nextAction: null,
      };
    }
    return {
      state: "failed" as const,
      detail: result.status === "succeeded" ? "Herdr returned no worktree list." : result.detail,
      nextAction: "Start or connect to the Herdr server, then check again.",
    };
  },
  /** Reads the pane's current workspace, which may differ from its launch-time environment. */
  async findPaneWorkspace(request: { paneId: string }): Promise<Lookup<{ workspaceId: string }>> {
    const outcome = await invokeHerdr({
      args: ["pane", "get", request.paneId],
      timeoutMs: READ_TIMEOUT_MS,
    });
    return lookupFrom(outcome, ["pane_not_found"], (result) => {
      const workspaceId = ToolInvocation.text(
        ToolInvocation.record(result, "pane"),
        "workspace_id",
      );
      return workspaceId === null ? null : { workspaceId };
    });
  },

  /** Creates the isolated checkout one Operative writes in, on an explicit branch and commit. */
  async createWorktree(request: {
    repoRoot: string;
    parentWorkspaceId?: string;
    path: string;
    branch: string;
    baseCommit: string;
    label: string;
    tabLabel?: string;
    sourceLabel?: string;
  }): Promise<HerdrOutcome<{ workspaceId: string; worktree: Worktree }>> {
    let sourceWorkspaceId = request.parentWorkspaceId;
    if (request.sourceLabel !== undefined) {
      const opened = await invokeHerdr({
        args: [
          "workspace",
          "create",
          "--cwd",
          request.repoRoot,
          "--label",
          request.sourceLabel,
          "--no-focus",
        ],
        timeoutMs: CREATE_TIMEOUT_MS,
      });
      if (opened.status !== "succeeded") return opened;
      sourceWorkspaceId =
        ToolInvocation.text(ToolInvocation.record(opened.value, "workspace"), "workspace_id") ??
        undefined;
      if (sourceWorkspaceId === undefined) {
        return {
          status: "uncertain",
          detail: "herdr opened a probe repository workspace it did not describe.",
        };
      }
    }
    const outcome = await invokeHerdr({
      args: [
        "worktree",
        "create",
        ...(sourceWorkspaceId === undefined
          ? ["--cwd", request.repoRoot]
          : ["--workspace", sourceWorkspaceId]),
        "--path",
        request.path,
        "--branch",
        request.branch,
        "--base",
        request.baseCommit,
        "--label",
        request.label,
        "--no-focus",
      ],
      timeoutMs: CREATE_TIMEOUT_MS,
    });
    if (outcome.status !== "succeeded") {
      return outcome;
    }

    const workspaceId = ToolInvocation.text(
      ToolInvocation.record(outcome.value, "workspace"),
      "workspace_id",
    );
    const worktree = readWorktree(ToolInvocation.record(outcome.value, "worktree"));
    if (workspaceId === null || worktree === null) {
      return { status: "uncertain", detail: "herdr created a worktree it did not describe." };
    }

    if (request.tabLabel !== undefined) {
      const listed = await invokeHerdr({
        args: ["tab", "list", "--workspace", workspaceId],
        timeoutMs: READ_TIMEOUT_MS,
      });
      if (listed.status !== "succeeded") return listed;
      const first = ToolInvocation.list(listed.value, "tabs")[0];
      const tabId = ToolInvocation.text(first, "tab_id");
      if (tabId === null) {
        return { status: "uncertain", detail: "herdr did not identify the worktree tab." };
      }
      const renamed = await invokeHerdr({
        args: ["tab", "rename", tabId, request.tabLabel],
        timeoutMs: READ_TIMEOUT_MS,
      });
      if (renamed.status !== "succeeded") return renamed;
    }

    return { status: "succeeded", value: { workspaceId, worktree } };
  },

  /** Adds a readable agent label without changing the stable name used by prompts and recovery. */
  async labelAgent(request: {
    paneId: string;
    agentName: string;
    label: string;
  }): Promise<HerdrOutcome<null>> {
    const outcome = await invokeHerdr({
      args: [
        "pane",
        "report-metadata",
        request.paneId,
        "--source",
        "operator",
        "--agent",
        request.agentName,
        "--display-agent",
        request.label,
      ],
      timeoutMs: READ_TIMEOUT_MS,
    });
    return outcome.status === "succeeded" ? { status: "succeeded", value: null } : outcome;
  },

  /** Reads the pane a new worktree workspace opened, so the launch names a real target. */
  async findRootPane(request: { workspaceId: string }): Promise<Lookup<{ paneId: string }>> {
    const outcome = await invokeHerdr({
      args: ["pane", "list", "--workspace", request.workspaceId],
      timeoutMs: READ_TIMEOUT_MS,
    });

    return lookupFrom(outcome, ["workspace_not_found"], (result) => {
      const panes = ToolInvocation.list(result, "panes");
      const paneId = panes.length === 0 ? null : ToolInvocation.text(panes[0], "pane_id");
      return paneId === null ? null : { paneId };
    });
  },

  /** Opens a shell pane beside a live agent so a second agent has its own terminal. */
  async splitPane(request: {
    paneId: string;
    cwd: string;
  }): Promise<HerdrOutcome<{ paneId: string }>> {
    const outcome = await invokeHerdr({
      args: [
        "pane",
        "split",
        "--pane",
        request.paneId,
        "--direction",
        "right",
        "--cwd",
        request.cwd,
        "--no-focus",
      ],
      timeoutMs: LAUNCH_TIMEOUT_MS,
    });
    if (outcome.status !== "succeeded") return outcome;
    const paneId = ToolInvocation.text(ToolInvocation.record(outcome.value, "pane"), "pane_id");
    return paneId === null
      ? { status: "uncertain", detail: "herdr opened a pane it did not describe." }
      : { status: "succeeded", value: { paneId } };
  },

  /** Starts the agent host in a prepared pane. An allow list makes Claude Code never ask (ADR 0006). */
  async startAgent(request: {
    name: string;
    kind: string;
    paneId: string;
    model?: string | null;
    reasoningEffort?: string | null;
    allowedTools?: string[] | null;
  }): Promise<HerdrOutcome<Agent>> {
    const effort = request.reasoningEffort ?? null;
    const allowed = request.allowedTools ?? null;
    // `--allowedTools` takes every argument after it, so it closes the list.
    const hostArgs =
      request.kind === "claude"
        ? [
            ...(effort === null ? [] : ["--effort", effort]),
            ...(allowed === null ? [] : ["--permission-mode", "dontAsk"]),
            ...(allowed === null || allowed.length === 0 ? [] : ["--allowedTools", ...allowed]),
          ]
        : effort === null
          ? []
          : ["--agent", "operator-crew"];
    const agentArgs = [
      ...(request.model === null || request.model === undefined ? [] : ["--model", request.model]),
      ...hostArgs,
    ];
    const outcome = await invokeHerdr({
      args: [
        "agent",
        "start",
        request.name,
        "--kind",
        request.kind,
        "--pane",
        request.paneId,
        ...(agentArgs.length === 0 ? [] : ["--", ...agentArgs]),
      ],
      timeoutMs: LAUNCH_TIMEOUT_MS,
    });
    if (outcome.status !== "succeeded") {
      return outcome;
    }

    const agent = readAgent(ToolInvocation.record(outcome.value, "agent"));
    return agent === null
      ? { status: "uncertain", detail: "herdr started an agent it did not describe." }
      : { status: "succeeded", value: agent };
  },

  /**
   * Submits the brief to a launched Operative.
   * Herdr acknowledges the submission, never a turn, so acknowledgement stays the Operative's job.
   */
  async submitPrompt(request: { target: string; text: string }): Promise<HerdrOutcome<Agent>> {
    const outcome = await invokeHerdr({
      args: ["agent", "prompt", request.target, request.text],
      timeoutMs: LAUNCH_TIMEOUT_MS,
    });
    if (outcome.status !== "succeeded") {
      return outcome;
    }

    const agent = readAgent(ToolInvocation.record(outcome.value, "agent"));
    return agent === null
      ? { status: "uncertain", detail: "herdr accepted a prompt it did not describe." }
      : { status: "succeeded", value: agent };
  },

  /** Read-only. Reports whether a named writer is still live. */
  async findAgent(request: { name: string }): Promise<Lookup<Agent>> {
    const outcome = await invokeHerdr({
      args: ["agent", "get", request.name],
      timeoutMs: READ_TIMEOUT_MS,
    });
    return lookupFrom(outcome, ["agent_not_found", "pane_not_found"], (result) =>
      readAgent(ToolInvocation.record(result, "agent")),
    );
  },

  /**
   * Types one line into a pane shell. Herdr joins its words with no quoting, so the caller passes
   * the whole line as one argument, already quoted for the shell. It reports no exit status.
   */
  async runInPane(request: { paneId: string; line: string }): Promise<HerdrOutcome<null>> {
    const outcome = await invokeHerdr({
      args: ["pane", "run", request.paneId, request.line],
      timeoutMs: READ_TIMEOUT_MS,
    });
    return outcome.status === "succeeded" ? { status: "succeeded", value: null } : outcome;
  },

  /** Read-only. Names every agent Herdr holds, so the occupants of a workspace can be counted. */
  async listAgents(): Promise<Lookup<Agent[]>> {
    const outcome = await invokeHerdr({ args: ["agent", "list"], timeoutMs: READ_TIMEOUT_MS });
    return lookupFrom(outcome, [], (result) => {
      const records = ToolInvocation.list(result, "agents");
      const agents = records.flatMap((one) => {
        const agent = readAgent(one);
        return agent === null ? [] : [agent];
      });
      return agents.length === records.length ? agents : null;
    });
  },

  /**
   * Read-only. Reports what one pane still runs.
   * The shell is named apart from what it started, so a tool left behind by a stopped host is
   * visible instead of being counted as the pane itself.
   */
  async readPaneProcesses(request: { paneId: string }): Promise<Lookup<PaneProcesses>> {
    const outcome = await invokeHerdr({
      args: ["pane", "process-info", "--pane", request.paneId],
      timeoutMs: READ_TIMEOUT_MS,
    });

    return lookupFrom(outcome, ["pane_not_found"], (result) => {
      const info = ToolInvocation.record(result, "process_info");
      if (info === undefined || info === null) {
        return null;
      }

      const records = ToolInvocation.list(info, "foreground_processes");
      const foreground = records.flatMap((one) => {
        const process = readPaneProcess(one);
        return process === null ? [] : [process];
      });
      return foreground.length === records.length
        ? { shellPid: ToolInvocation.number(info, "shell_pid"), foreground }
        : null;
    });
  },

  /**
   * Sends one host its own stop keys.
   * Herdr validates every key before it writes any byte, and an agent that is already gone is
   * reported as a failure the caller reads as a stop that has nothing left to do.
   */
  async stopAgent(request: { target: string; keys: string[] }): Promise<HerdrOutcome<null>> {
    const outcome = await invokeHerdr({
      args: ["agent", "send-keys", request.target, ...request.keys],
      timeoutMs: READ_TIMEOUT_MS,
    });
    return outcome.status === "succeeded" ? { status: "succeeded", value: null } : outcome;
  },

  /**
   * Removes one Herdr-managed checkout.
   * It is never forced and never closes a workspace group, so an occupied or dirty checkout is
   * refused by Herdr rather than taken apart by Operator.
   */
  async removeWorktree(request: { workspaceId: string }): Promise<HerdrOutcome<null>> {
    const outcome = await invokeHerdr({
      args: ["worktree", "remove", "--workspace", request.workspaceId],
      timeoutMs: CREATE_TIMEOUT_MS,
    });
    return outcome.status === "succeeded" ? { status: "succeeded", value: null } : outcome;
  },

  /** Read-only. Reports whether the recorded checkout exists in this repository. */
  async findWorktree(request: { repoRoot: string; path: string }): Promise<Lookup<Worktree>> {
    const outcome = await invokeHerdr({
      args: ["worktree", "list", "--cwd", request.repoRoot],
      timeoutMs: READ_TIMEOUT_MS,
    });
    if (outcome.status === "uncertain") {
      return { status: "unknown", detail: outcome.detail };
    }
    if (outcome.status === "failed") {
      return { status: "unknown", detail: `${outcome.code}: ${outcome.detail}` };
    }

    // A listed repository that does not hold the path is evidence of absence, not an unknown.
    const found = ToolInvocation.list(outcome.value, "worktrees")
      .map(readWorktree)
      .find((one) => one !== null && one.path === request.path);
    return found === undefined || found === null
      ? { status: "absent" }
      : { status: "found", value: found };
  },
};
