import { expect, spyOn } from "bun:test";
// Bun has no temporary-directory, realpath, recursive copy, or recursive removal API.
import { cp, mkdtemp, realpath, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { GithubApi } from "../github-api/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Projects } from "../projects/main.ts";
import { WorkSources } from "../work-sources/main.ts";

export const repository = "example/one";

const gitEnv = Environment.child({
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
});

export function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv, stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

export async function commit(cwd: string, file: string, text: string) {
  await Bun.write(`${cwd}/${file}`, text, { createPath: true });
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", file);
  return git(cwd, "rev-parse", "HEAD");
}

type GithubCall = Parameters<typeof GithubApi.call>[0];
type GithubAnswer = Awaited<ReturnType<typeof GithubApi.call>>;
type Answer = (args: string[]) => GithubAnswer | Promise<GithubAnswer>;

function unanswered() {
  return failed("no answer is set");
}

export function succeeded<B>(body: B, httpStatus = 200): GithubAnswer {
  return { status: "succeeded", value: { httpStatus, body } };
}

export function failed(detail: string, httpStatus: number | null = 422): GithubAnswer {
  return { status: "failed", code: "github_refused", detail, httpStatus };
}

export function uncertain(detail: string): GithubAnswer {
  return { status: "uncertain", detail };
}

const plan = {
  trackerKey: "github:example/one#10",
  assignments: [
    {
      key: "parent",
      trackerKey: "github:example/one#11",
      instructions: "Implement the parent change.",
      completion: "pr",
      resources: "worktree",
      branch: "task/parent",
      dependencies: [],
    },
    {
      key: "child",
      trackerKey: "github:example/one#12",
      instructions: "Implement the child change.",
      completion: "pr",
      resources: "worktree",
      branch: "task/child",
      dependencies: ["parent", "second"],
    },
    {
      key: "second",
      trackerKey: "github:example/one#15",
      instructions: "Implement the second parent change.",
      completion: "pr",
      resources: "worktree",
      branch: "task/second",
      dependencies: [],
    },
    {
      key: "other",
      trackerKey: "github:example/one#13",
      instructions: "Implement another change.",
      completion: "pr",
      resources: "worktree",
      branch: "task/other",
      dependencies: [],
    },
    {
      key: "read",
      trackerKey: "github:example/one#14",
      instructions: "Report on the code.",
      completion: "report",
      resources: "worktree",
      branch: "task/read",
      dependencies: [],
    },
  ],
};

type Registered = {
  root: string;
  paths: ReturnType<typeof OperatorHome.resolve>;
  sourceId: string;
};

/** Registers the project and its source under `root`. */
async function register(root: string, keys: string[] | undefined): Promise<Registered> {
  const paths = OperatorHome.resolve({
    ...Environment.read(),
    HOME: `${root}/home`,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_STATE_HOME: `${root}/state`,
  });
  const checkout = `${root}/checkout`;
  await Bun.write(`${checkout}/README.md`, "fixture\n", { createPath: true });
  git(checkout, "init", "-q", "-b", "main");
  // The units run Git with the process environment, so the repository carries its identity.
  git(checkout, "config", "user.name", "Fixture");
  git(checkout, "config", "user.email", "fixture@example.com");
  git(checkout, "config", "commit.gpgsign", "false");
  git(checkout, "remote", "add", "origin", `https://github.com/${repository}.git`);
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "fixture");
  expect((await Projects.register({ paths, cwd: checkout })).tag).toBe("Ok");
  await Bun.write(
    `${root}/plan.json`,
    JSON.stringify({
      ...plan,
      assignments: plan.assignments.filter((row) => keys === undefined || keys.includes(row.key)),
    }),
  );
  const registered = await WorkSources.register({
    paths,
    cwd: checkout,
    file: `${root}/plan.json`,
  });
  expect(registered.tag).toBe("Ok");
  return { root, paths, sourceId: registered.tag === "Ok" ? registered.value.id : "" };
}

// Registration is the slow part of a device, so each process registers once at a fixed root and
// restores a copy for each later device. Absolute paths in Git and SQLite stay valid there.
const base = mkdtemp(path.join(tmpdir(), "operator-prs-")).then((folder) => realpath(folder));
let baseFolder = "";
void base.then((folder) => {
  baseFolder = folder;
});
process.on("exit", () => {
  if (baseFolder !== "") rmSync(baseFolder, { recursive: true, force: true });
});
const templates = new Map<string, { registered: Registered; copy: string }>();
let busy = false;

async function registered(keys: string[] | undefined): Promise<Registered> {
  // A second device alive at the same time gets its own root.
  if (busy)
    return register(await realpath(await mkdtemp(path.join(tmpdir(), "operator-prs-"))), keys);
  busy = true;
  const root = `${await base}/device`;
  await rm(root, { recursive: true, force: true });
  const key = JSON.stringify(keys ?? null);
  const known = templates.get(key);
  if (known !== undefined) {
    await cp(known.copy, root, { recursive: true, verbatimSymlinks: true });
    return known.registered;
  }
  const result = await register(root, keys);
  const copy = `${await base}/template-${templates.size}`;
  await cp(root, copy, { recursive: true, verbatimSymlinks: true });
  templates.set(key, { registered: result, copy });
  return result;
}

/**
 * An isolated device with real Git and SQLite. The project `example/one` is registered with a
 * source whose `child` assignment depends on `parent` and `second`. GitHub answers come from
 * `answer`.
 */
export async function prDevice(options: { assignments?: string[] } = {}) {
  const device = await registered(options.assignments);
  const { root, paths, sourceId } = device;
  const shared = root === `${await base}/device`;
  const checkout = `${root}/checkout`;

  const calls: string[][] = [];
  let answer: Answer = unanswered;
  spyOn(GithubApi, "call").mockImplementation(async (request: GithubCall) => {
    calls.push(request.args);
    // A unit that loops on GitHub fails fast instead of polling until a test timeout.
    if (calls.length > 12) return failed("too many GitHub calls");
    return answer(request.args);
  });

  /** A running launch of the assignment with its own worktree on the assignment branch. */
  function start(
    assignment: string,
    options: {
      worktree?: string | null;
      branch?: string | null;
      tabId?: string | null;
      paneId?: string | null;
      state?: "running" | "failed";
      add?: boolean;
      socket?: string | null;
    } = {},
  ) {
    const branch = options.branch === undefined ? `task/${assignment}` : options.branch;
    const worktree =
      options.worktree === undefined ? `${root}/worktrees/${assignment}` : options.worktree;
    if (worktree !== null && options.add !== false)
      git(
        checkout,
        "worktree",
        "add",
        "-q",
        ...(branch === null ? ["--detach"] : ["-b", branch]),
        worktree,
      );
    const id = crypto.randomUUID();
    const reserved = DeviceState.reserveLaunch(paths, checkout, repository, {
      id,
      sourceId,
      assignment,
      state: "starting",
      name: `launch-${assignment}-${id.slice(0, 8)}`,
      resources: "worktree",
      branch,
      host: "opencode",
      model: "test/model",
      requestedModel: "test/model",
      reasoningEffort: "medium",
      profile: null,
      release: JSON.stringify({ version: "0.0.0" }),
      skills: "[]",
      herdrSocket: options.socket === undefined ? `${root}/herdr.sock` : options.socket,
      workspaceId: null,
      tabId: null,
      paneId: null,
      worktreePath: null,
      worktreeWorkspaceId: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      failureReason: null,
      failureDetail: null,
      activity: null,
      activityAt: null,
    });
    expect(reserved.tag).toBe("Ok");
    expect(
      DeviceState.updateLaunch(paths, id, {
        state: options.state ?? "running",
        worktreePath: worktree,
        tabId: options.tabId === undefined ? "t1" : options.tabId,
        paneId: options.paneId === undefined ? "p1" : options.paneId,
      }).tag,
    ).toBe("Ok");
    return { launchId: id, worktree: worktree ?? "", branch };
  }

  /** Records the open PR of a running launch, as `operator pr associate` does. */
  function associate(
    launchId: string,
    number: number,
    branch: string,
    relay: string | null = null,
  ) {
    const url = `https://github.com/${repository}/pull/${number}`;
    expect(
      DeviceState.associatePullRequest(paths, launchId, { number, url, branch, relay }).tag,
    ).toBe("Ok");
  }

  /** Records a verified merge, which also records its pending cleanup. */
  function merged(launchId: string, number: number, head: string) {
    expect(
      DeviceState.recordPullRequestMerge(
        paths,
        launchId,
        { number, head, mergeCommit: `merge-${head}` },
        (rows) => WorkSources.stateAfter(rows),
      ).tag,
    ).toBe("Ok");
  }

  /** The recorded PR row of an assignment. */
  function pullRequestRow(assignment: string) {
    const read = DeviceState.readSources(paths, repository, sourceId);
    const rows = read.tag === "Ok" ? (read.value[0]?.pullRequests ?? []) : [];
    return rows.find((row) => row.assignment === assignment) ?? null;
  }

  return {
    root,
    paths,
    pullRequestRow,
    checkout,
    sourceId,
    calls,
    start,
    associate,
    merged,
    answer(next: Answer) {
      answer = next;
    },
    async [Symbol.asyncDispose]() {
      await rm(root, { recursive: true, force: true });
      if (shared) busy = false;
    },
  };
}

/** The field values of one `gh api graphql` call, such as `number` or `query`. */
export function field(args: string[], name: string) {
  const value = args.find((arg) => arg.startsWith(`${name}=`));
  return value?.slice(name.length + 1) ?? null;
}

/** Which GitHub request one `gh api` call makes. */
export function requestKind(args: string[]) {
  if (args[0] === "graphql") {
    const text = field(args, "query") ?? "";
    if (text.includes("RelayParent")) return "parent";
    return text.includes("pullRequests(headRefName") ? "association" : "pull_request";
  }
  if (args.includes("PUT")) return "merge";
  if (args.includes("PATCH")) return "retarget";
  return args.includes("DELETE") ? "delete_branch" : "branch";
}

type PullRequestFacts = {
  state?: "OPEN" | "MERGED" | "CLOSED";
  head?: string;
  base?: string;
  defaultBranch?: string | null;
  approved?: boolean;
  checks?: ("SUCCESS" | "FAILURE" | "PENDING")[];
  unresolved?: number;
  mergeCommit?: string | null;
  comments?: { id: string; body: string; author: string }[];
};

/** The GraphQL answer that `observePullRequest` reads, for an approved PR with one passing check. */
export function pullRequestBody(facts: PullRequestFacts = {}) {
  const checks = facts.checks ?? ["SUCCESS"];
  const unresolved = facts.unresolved ?? 0;
  return {
    data: {
      viewer: { login: "owner" },
      repository: {
        defaultBranchRef:
          facts.defaultBranch === null ? null : { name: facts.defaultBranch ?? "main" },
        viewerDefaultMergeMethod: "SQUASH",
        pullRequest: {
          state: facts.state ?? "OPEN",
          baseRefName: facts.base ?? "main",
          headRefName: "task/parent",
          headRefOid: facts.head ?? "h1",
          reviewDecision: facts.approved === false ? null : "APPROVED",
          mergeCommit:
            facts.mergeCommit === undefined || facts.mergeCommit === null
              ? null
              : { oid: facts.mergeCommit },
          reviews: { nodes: [] },
          comments: {
            nodes: (facts.comments ?? []).map((item) => ({
              id: item.id,
              body: item.body,
              url: `https://github.com/example/one/pull/7#${item.id}`,
              author: { login: item.author },
            })),
          },
          reviewThreads: {
            totalCount: unresolved,
            nodes: Array.from({ length: unresolved }, (_, index) => ({
              isResolved: false,
              path: `file-${index}.ts`,
              comments: { nodes: [] },
            })),
          },
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      totalCount: checks.length,
                      nodes: checks.map((state, index) => ({
                        __typename: "StatusContext",
                        context: `check-${index}`,
                        state,
                        targetUrl: null,
                      })),
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  };
}

/** The GraphQL answer that `openPullRequests` reads. */
export function associationBody(
  prs: { number: number; base: string; head?: string; owner?: string | null }[],
) {
  return {
    data: {
      repository: {
        defaultBranchRef: { name: "main" },
        pullRequests: {
          nodes: prs.map((pr) => ({
            number: pr.number,
            url: `https://github.com/${repository}/pull/${pr.number}`,
            baseRefName: pr.base,
            headRefName: pr.head ?? "task/other",
            headRepository: pr.owner === null ? null : { nameWithOwner: pr.owner ?? repository },
          })),
        },
      },
    },
  };
}

/** The GraphQL answer that `observeParent` reads. */
export function parentBody(state: "OPEN" | "MERGED" | "CLOSED", base: string, head: string) {
  return { data: { repository: { pullRequest: { state, baseRefName: base, headRefOid: head } } } };
}
