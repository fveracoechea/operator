import { type HerdrOutcome, invokeHerdr, readRecords, readString } from "./invoke.ts";

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

function record(source: unknown, key: string): unknown {
  return source !== null && typeof source === "object" ? Reflect.get(source, key) : undefined;
}

function readWorktree(source: unknown): Worktree | null {
  const path = readString(source, "path");
  return path === null
    ? null
    : {
        path,
        branch: readString(source, "branch"),
        workspaceId: readString(source, "open_workspace_id"),
      };
}

function readNumber(source: unknown, key: string): number | null {
  if (source === null || typeof source !== "object") {
    return null;
  }

  const value = Reflect.get(source, key);
  return typeof value === "number" ? value : null;
}

function readAgent(source: unknown): Agent | null {
  const paneId = readString(source, "pane_id");
  return paneId === null
    ? null
    : {
        name: readString(source, "name"),
        paneId,
        cwd: readString(source, "cwd"),
        status: readString(source, "agent_status") ?? "unknown",
      };
}

function readPaneProcess(source: unknown): PaneProcess | null {
  const pid = readNumber(source, "pid");
  return pid === null
    ? null
    : {
        pid,
        name: readString(source, "name") ?? "unknown",
        command: readString(source, "cmdline") ?? "",
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
  /** Creates the isolated checkout one Operative writes in, on an explicit branch and commit. */
  async createWorktree(request: {
    repoRoot: string;
    path: string;
    branch: string;
    baseCommit: string;
    label: string;
  }): Promise<HerdrOutcome<{ workspaceId: string; worktree: Worktree }>> {
    const outcome = await invokeHerdr({
      args: [
        "worktree",
        "create",
        "--cwd",
        request.repoRoot,
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

    const workspaceId = readString(record(outcome.value, "workspace"), "workspace_id");
    const worktree = readWorktree(record(outcome.value, "worktree"));
    if (workspaceId === null || worktree === null) {
      return { status: "uncertain", detail: "herdr created a worktree it did not describe." };
    }

    return { status: "succeeded", value: { workspaceId, worktree } };
  },

  /** Reads the pane a new worktree workspace opened, so the launch names a real target. */
  async findRootPane(request: { workspaceId: string }): Promise<Lookup<{ paneId: string }>> {
    const outcome = await invokeHerdr({
      args: ["pane", "list", "--workspace", request.workspaceId],
      timeoutMs: READ_TIMEOUT_MS,
    });

    return lookupFrom(outcome, ["workspace_not_found"], (result) => {
      const panes = readRecords(result, "panes");
      const paneId = panes.length === 0 ? null : readString(panes[0], "pane_id");
      return paneId === null ? null : { paneId };
    });
  },

  /** Starts the agent host in a prepared pane. Success means that host owns that terminal. */
  async startAgent(request: {
    name: string;
    kind: string;
    paneId: string;
  }): Promise<HerdrOutcome<Agent>> {
    const outcome = await invokeHerdr({
      args: ["agent", "start", request.name, "--kind", request.kind, "--pane", request.paneId],
      timeoutMs: LAUNCH_TIMEOUT_MS,
    });
    if (outcome.status !== "succeeded") {
      return outcome;
    }

    const agent = readAgent(record(outcome.value, "agent"));
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

    const agent = readAgent(record(outcome.value, "agent"));
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
      readAgent(record(result, "agent")),
    );
  },

  /** Read-only. Names every agent Herdr holds, so the occupants of a workspace can be counted. */
  async listAgents(): Promise<Lookup<Agent[]>> {
    const outcome = await invokeHerdr({ args: ["agent", "list"], timeoutMs: READ_TIMEOUT_MS });
    return lookupFrom(outcome, [], (result) => {
      const records = readRecords(result, "agents");
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
      const info = record(result, "process_info");
      if (info === undefined || info === null) {
        return null;
      }

      const records = readRecords(info, "foreground_processes");
      const foreground = records.flatMap((one) => {
        const process = readPaneProcess(one);
        return process === null ? [] : [process];
      });
      return foreground.length === records.length
        ? { shellPid: readNumber(info, "shell_pid"), foreground }
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
    const found = readRecords(outcome.value, "worktrees")
      .map(readWorktree)
      .find((one) => one !== null && one.path === request.path);
    return found === undefined || found === null
      ? { status: "absent" }
      : { status: "found", value: found };
  },
};
