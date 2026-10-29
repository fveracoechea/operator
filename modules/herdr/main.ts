import { Err, Ok, fromPromise, fromThrowable, type Result } from "unthrown";
import { z } from "zod";
import { ToolInvocation } from "../tool-invocation/main.ts";

type HerdrFailure = {
  reason: "herdr_unavailable" | "herdr_failed" | "herdr_no_answer" | "herdr_invalid_response";
  detail: string;
};

const pane = z.object({ pane_id: z.string(), tab_id: z.string(), workspace_id: z.string() });
const created = z.object({
  result: z.object({ root_pane: pane, workspace: z.object({ workspace_id: z.string() }) }),
});
const workspaceList = z.object({
  result: z.object({
    workspaces: z.array(
      z.object({
        workspace_id: z.string(),
        label: z.string(),
        worktree: z
          .object({ checkout_path: z.string(), is_linked_worktree: z.boolean() })
          .optional(),
      }),
    ),
  }),
});
const tabList = z.object({ result: z.object({ tabs: z.array(z.object({ label: z.string() })) }) });
const agentList = z.object({
  result: z.object({ agents: z.array(z.object({ name: z.string().nullish() })) }),
});
const worktreeCreated = z.object({
  result: z.object({
    root_pane: pane,
    workspace: z.object({ workspace_id: z.string() }),
    worktree: z.object({ path: z.string(), branch: z.string().optional() }),
  }),
});
const pluginList = z.object({
  result: z.object({
    plugins: z.array(z.object({ plugin_id: z.string(), plugin_root: z.string() })),
  }),
});

// Herdr owns this JSON input, so the schema runs where the text is read.
function parse<T>(text: string, schema: z.ZodType<T>): T | undefined {
  const value = fromThrowable(
    () => JSON.parse(text) as unknown,
    // Stryker disable next-line ArrowFunction: equivalent: JSON.parse of a string throws only a SyntaxError, and the caller reads only a parsed value
    (cause, defect) => (cause instanceof SyntaxError ? undefined : defect(cause)),
  )().getOr(undefined);
  return schema.safeParse(value).data;
}

const errorAnswer = z.object({ error: z.object({ code: z.string() }) });

/**
 * Every call is a bounded external effect. A missing answer does not prove that nothing changed.
 * A refusal with the `absent` error code answers null, so a caller can observe a gone resource.
 */
function call(args: string[], timeoutMs: number, absent?: string) {
  const command = `herdr ${args.slice(0, 2).join(" ")}`;
  return fromPromise(
    () => ToolInvocation.run({ tool: "herdr", args, timeoutMs }),
    (cause, defect) => defect(cause),
  ).flatMap((result): Result<string | null, HerdrFailure> => {
    if (result.status === "unavailable")
      return Err({ reason: "herdr_unavailable", detail: result.detail });
    if (result.status === "no-answer")
      return Err({
        reason: "herdr_no_answer",
        detail: `${result.detail} Inspect Herdr before a retry, because the effect can exist.`,
      });
    if (result.exitCode === 0) return Ok(result.stdout);
    const refused = parse(result.stdout, errorAnswer) ?? parse(result.stderr, errorAnswer);
    if (absent !== undefined && refused?.error.code === absent) return Ok(null);
    return Err({
      reason: "herdr_failed",
      detail: `${command} exited ${result.exitCode}: ${(result.stderr || result.stdout).trim()}`,
    });
  });
}

function answer<T>(args: string[], stdout: string, schema: z.ZodType<T>) {
  const parsed = parse(stdout, schema);
  return parsed !== undefined
    ? Ok(parsed)
    : Err<HerdrFailure>({
        reason: "herdr_invalid_response",
        detail: `herdr ${args.slice(0, 2).join(" ")} returned an unexpected response.`,
      });
}

function invoke<T>(args: string[], schema: z.ZodType<T>, timeoutMs = 60000) {
  return call(args, timeoutMs).flatMap((stdout) =>
    // Stryker disable next-line StringLiteral: equivalent: without an absent code, call never answers null
    answer(args, stdout ?? "", schema),
  );
}

/** Like invoke, but a refusal with the `absent` error code answers null. */
function lookup<T>(args: string[], schema: z.ZodType<T>, absent: string) {
  return call(args, 60000, absent).flatMap((stdout) =>
    stdout === null ? Ok(null) : answer(args, stdout, schema),
  );
}

function placed(value: z.infer<typeof created>) {
  return {
    workspaceId: value.result.workspace.workspace_id,
    tabId: value.result.root_pane.tab_id,
    paneId: value.result.root_pane.pane_id,
  };
}

/** The Herdr CLI adapter. Herdr chooses worktree paths, and Operator records what it returns. */
export const Herdr = {
  workspaces() {
    return invoke(["workspace", "list"], workspaceList).map((value) =>
      value.result.workspaces.map((workspace) => ({
        workspaceId: workspace.workspace_id,
        label: workspace.label,
        checkout: workspace.worktree?.checkout_path ?? null,
        linked: workspace.worktree?.is_linked_worktree ?? false,
      })),
    );
  },
  createWorkspace(input: { cwd: string; label: string }) {
    return invoke(
      ["workspace", "create", "--cwd", input.cwd, "--label", input.label, "--no-focus"],
      created,
    ).map(placed);
  },
  tabLabels(workspaceId: string) {
    return invoke(["tab", "list", "--workspace", workspaceId], tabList).map((value) =>
      value.result.tabs.map((tab) => tab.label),
    );
  },
  createTab(input: { workspaceId: string; cwd: string; label: string }) {
    return invoke(
      [
        "tab",
        "create",
        "--workspace",
        input.workspaceId,
        "--cwd",
        input.cwd,
        "--label",
        input.label,
        "--no-focus",
      ],
      z.object({ result: z.object({ root_pane: pane }) }),
    ).map((value) => ({
      tabId: value.result.root_pane.tab_id,
      paneId: value.result.root_pane.pane_id,
    }));
  },
  /** A `base` commit starts the new branch there, for example on a parent PR's branch. */
  createWorktree(input: { workspaceId: string; branch: string; label: string; base?: string }) {
    return invoke(
      [
        "worktree",
        "create",
        "--workspace",
        input.workspaceId,
        "--branch",
        input.branch,
        ...(input.base === undefined ? [] : ["--base", input.base]),
        "--label",
        input.label,
        "--no-focus",
      ],
      worktreeCreated,
      300000,
    ).map((value) => ({ ...placed(value), path: value.result.worktree.path }));
  },
  openWorktree(input: { workspaceId: string; path: string; label: string }) {
    return invoke(
      [
        "worktree",
        "open",
        "--workspace",
        input.workspaceId,
        "--path",
        input.path,
        "--label",
        input.label,
        "--no-focus",
      ],
      created,
    ).map(placed);
  },
  agentNames() {
    return invoke(["agent", "list"], agentList).map((value) =>
      value.result.agents.flatMap((agent) => (agent.name ? [agent.name] : [])),
    );
  },
  /** Herdr returns only after it detects the agent ready for input, or refuses. */
  startAgent(input: { name: string; kind: string; paneId: string; args: string[] }) {
    return invoke(
      [
        "agent",
        "start",
        input.name,
        "--kind",
        input.kind,
        "--pane",
        input.paneId,
        "--timeout",
        "120000",
        "--",
        ...input.args,
      ],
      z.unknown(),
      150000,
    );
  },
  /** Submission is not evidence that the agent started, submitted, or completed work. */
  prompt(input: { name: string; text: string }) {
    return invoke(["agent", "prompt", input.name, input.text], z.unknown());
  },
  /** The pane's placement, or null when Herdr no longer has a pane with this identifier. */
  pane(paneId: string) {
    return lookup(
      ["pane", "get", paneId],
      z.object({ result: z.object({ pane }) }),
      "pane_not_found",
    ).map((value) =>
      value === null
        ? null
        : { tabId: value.result.pane.tab_id, workspaceId: value.result.pane.workspace_id },
    );
  },
  /** Herdr closes the workspace too when the pane was its last one. A gone pane is absent. */
  closePane(paneId: string) {
    return lookup(["pane", "close", paneId], z.unknown(), "pane_not_found").map(
      (value): "closed" | "absent" => (value === null ? "absent" : "closed"),
    );
  },
  /** Herdr removes the checkout through Git and closes its workspace. */
  removeWorktree(input: { workspaceId: string; force: boolean }) {
    return invoke(
      ["worktree", "remove", "--workspace", input.workspaceId, ...(input.force ? ["--force"] : [])],
      z.unknown(),
    ).map(() => undefined);
  },
  plugins() {
    return invoke(["plugin", "list", "--json"], pluginList).map((value) =>
      value.result.plugins.map((plugin) => ({ id: plugin.plugin_id, root: plugin.plugin_root })),
    );
  },
  linkPlugin(directory: string) {
    return invoke(["plugin", "link", directory], z.unknown());
  },
  unlinkPlugin(id: string) {
    return invoke(["plugin", "unlink", id], z.unknown());
  },
};
