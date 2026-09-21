import {
  DEFAULT_TIMEOUT_MS,
  type HerdrOutcome,
  invokeHerdr,
  readRecords,
  readString,
} from "./invoke.ts";

type Worktree = { path: string; branch: string | null; workspaceId: string | null };

type Agent = { name: string | null; paneId: string; cwd: string | null; status: string };

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
    timeoutMs?: number;
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
      timeoutMs: request.timeoutMs,
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
    timeoutMs?: number;
  }): Promise<HerdrOutcome<Agent>> {
    const outcome = await invokeHerdr({
      args: ["agent", "start", request.name, "--kind", request.kind, "--pane", request.paneId],
      timeoutMs: request.timeoutMs,
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
  async submitPrompt(request: {
    target: string;
    text: string;
    timeoutMs?: number;
  }): Promise<HerdrOutcome<Agent>> {
    const outcome = await invokeHerdr({
      args: ["agent", "prompt", request.target, request.text],
      timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
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
    const outcome = await invokeHerdr({ args: ["agent", "get", request.name] });
    return lookupFrom(outcome, ["agent_not_found", "pane_not_found"], (result) =>
      readAgent(record(result, "agent")),
    );
  },

  /** Read-only. Reports whether the recorded checkout exists in this repository. */
  async findWorktree(request: { repoRoot: string; path: string }): Promise<Lookup<Worktree>> {
    const outcome = await invokeHerdr({
      args: ["worktree", "list", "--cwd", request.repoRoot],
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
