import { Err, Ok, fromPromise, type Result, type AsyncResult } from "unthrown";
import { z } from "zod";
import { GithubApi } from "../github-api/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import type { Refusal } from "../../lib/cli-result.ts";

const parentSchema = z.strictObject({
  assignment: z.string(),
  number: z.number().int().positive(),
  branch: z.string(),
  head: z.string(),
  base: z.string(),
  state: z.enum(["OPEN", "MERGED"]).optional(),
});
type StackParent = z.infer<typeof parentSchema>;
const baseSchema = z.strictObject({
  head: z.string(),
  branch: z.string(),
  managed: z.boolean(),
  remote: z.string().min(1).optional(),
  remoteUrl: z.string().min(1).optional(),
  parents: z.array(parentSchema),
  publication: z
    .object({
      remote: z.string().min(1),
      state: z.enum(["intent", "verified"]),
      at: z.string().optional(),
      expected: z.literal("absent").optional(),
    })
    .strict()
    .optional(),
});
const failureSchema = z.object({ at: z.string(), reason: z.string(), detail: z.string() });
const operationSchema = z.strictObject({
  id: z.string(),
  repository: z.string(),
  sourceId: z.string(),
  assignment: z.string(),
  launchId: z.string(),
  previousOwners: z.array(z.string()),
  number: z.number().int().positive(),
  branch: z.string(),
  head: z.string(),
  base: z.string(),
  cut: z.string(),
  remote: z.string(),
  remoteUrl: z.string().min(1).optional(),
  worktree: z.string().min(1).optional(),
  originalRef: z.string().min(1).optional(),
  parents: z.array(parentSchema),
  target: z.string(),
  targetBranch: z.string(),
  managed: z.boolean(),
  retargetAttempted: z.boolean(),
  pushAttempted: z.boolean(),
  relayToMain: z.boolean(),
  candidate: z.string().nullable(),
  step: z.enum(["planned", "prepared", "installed", "pushed", "complete", "cancelled"]),
  blocker: failureSchema.nullable(),
  failures: z.array(failureSchema),
  attempts: z
    .array(
      z
        .object({
          effect: z.enum(["base", "draft", "install", "push", "retarget"]),
          at: z.string(),
          outcome: z.enum(["intent", "verified", "uncertain"]),
          detail: z.string().optional(),
        })
        .strict(),
    )
    .default([]),
});
type StackPlan = z.infer<typeof operationSchema>;
type Parent = Pick<StackParent, "assignment" | "number" | "branch"> & {
  head?: string;
  base?: string;
};
type StackBase = z.infer<typeof baseSchema>;

function refuse(detail: string): Result<never, Refusal> {
  return Err({
    reason: "stack_parent",
    detail,
    next: {
      command: "operator next",
      why: "Inspect the prerequisite branches before trying a new pinned integration.",
    },
  });
}

async function git(cwd: string, args: string[], input?: string) {
  const answer = await ToolInvocation.run({ tool: "git", cwd, args, input, timeoutMs: 120000 });
  return answer.status === "completed" && answer.exitCode === 0 ? answer.stdout.trim() : null;
}

function pin(repository: string, parent: Parent): AsyncResult<StackParent, Refusal> {
  return fromPromise(
    async () => {
      const [owner = "", name = ""] = repository.split("/");
      const answer = await GithubApi.call({
        args: [
          "graphql",
          "-f",
          "query=query RelayParent($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { state baseRefName headRefOid headRefName headRepository { nameWithOwner } } } }",
          "-f",
          `owner=${owner}`,
          "-f",
          `name=${name}`,
          "-F",
          `number=${parent.number}`,
        ],
        timeoutMs: 60000,
      });
      if (answer.status !== "succeeded")
        return refuse("The prerequisite's OPEN state could not be established.");
      const parsed = z
        .object({
          data: z.object({
            repository: z.object({
              pullRequest: z.object({
                state: z.literal("OPEN"),
                headRefName: z.string(),
                headRepository: z.object({ nameWithOwner: z.string() }),
                baseRefName: z.string(),
                headRefOid: z.string().regex(/^[0-9a-f]{40,64}$/),
              }),
            }),
          }),
        })
        .safeParse(answer.value.body);
      if (!parsed.success)
        return refuse("A prerequisite is no longer OPEN or GitHub did not provide its exact head.");
      if (
        (parent.head !== undefined &&
          parent.head !== parsed.data.data.repository.pullRequest.headRefOid) ||
        (parent.base !== undefined &&
          parent.base !== parsed.data.data.repository.pullRequest.baseRefName)
      )
        return refuse("A pinned prerequisite changed before integration preparation.");
      if (
        parsed.data.data.repository.pullRequest.headRefName !== parent.branch ||
        parsed.data.data.repository.pullRequest.headRepository.nameWithOwner.toLowerCase() !==
          repository.toLowerCase()
      )
        return refuse("A prerequisite's branch or repository differs from its recorded identity.");
      return Ok({
        ...parent,
        head: parsed.data.data.repository.pullRequest.headRefOid,
        base: parsed.data.data.repository.pullRequest.baseRefName,
      });
    },
    (cause, defect) => defect(cause),
  ).flatMap((result): Result<StackParent, Refusal> => result);
}

async function commit(cwd: string, tree: string, parents: string[]) {
  return git(
    cwd,
    ["hash-object", "-t", "commit", "-w", "--stdin"],
    [
      `tree ${tree}`,
      ...parents.map((head) => `parent ${head}`),
      "author Operator stack <operator-stack@localhost> 1 +0000",
      "committer Operator stack <operator-stack@localhost> 1 +0000",
      "",
      "Integrate pinned prerequisites",
      "",
    ].join("\n"),
  );
}

async function containing(cwd: string, parents: StackParent[]) {
  for (const candidate of parents) {
    let contains = true;
    for (const parent of parents)
      if ((await git(cwd, ["merge-base", "--is-ancestor", parent.head, candidate.head])) === null)
        contains = false;
    if (contains) return candidate;
  }
  return null;
}

function integrate(cwd: string, parents: StackParent[]): AsyncResult<string, Refusal> {
  return fromPromise(
    async () => {
      let head = parents[0]?.head;
      if (head === undefined) return refuse("An integration requires at least one prerequisite.");
      for (const parent of parents.slice(1)) {
        const tree = await git(cwd, ["merge-tree", "--write-tree", head, parent.head]);
        if (tree === null)
          return refuse("The prerequisites conflict. No branch or worktree changed.");
        const merged = await commit(cwd, tree.split("\n")[0] ?? "", [head, parent.head]);
        if (merged === null)
          return refuse("Git could not preserve the dependency integration object.");
        head = merged;
      }
      return Ok(head);
    },
    (cause, defect) => defect(cause),
  ).flatMap((result): Result<string, Refusal> => result);
}

function prepare(input: {
  cwd: string;
  repository: string;
  remote: string;
  parents: Parent[];
  namespace: string;
}): AsyncResult<StackBase, Refusal> {
  return fromPromise(
    async () => {
      const remoteUrl = await git(input.cwd, ["remote", "get-url", input.remote]);
      if (remoteUrl === null || remoteUrl === "")
        return refuse("The dependency remote URL could not be pinned.");
      const parents: StackParent[] = [];
      for (const parent of input.parents.toSorted((a, b) =>
        a.assignment.localeCompare(b.assignment),
      )) {
        const observed = await pin(input.repository, parent);
        if (observed.tag !== "Ok")
          return observed.flatMap(() => refuse("The prerequisite could not be pinned."));
        const fetched = await git(input.cwd, [
          "fetch",
          "--quiet",
          input.remote,
          `refs/heads/${parent.branch}`,
        ]);
        const head = await git(input.cwd, ["rev-parse", "FETCH_HEAD"]);
        if (fetched === null || head !== observed.value.head)
          return refuse("A prerequisite's pushed head differs from its observed head.");
        parents.push(observed.value);
      }
      const existing = await containing(input.cwd, parents);
      if (existing !== null)
        return Ok({
          head: existing.head,
          branch: existing.branch,
          parents,
          managed: false,
          remoteUrl,
        });
      return (await integrate(input.cwd, parents)).map((head) => ({
        head,
        branch: `operator/stacks/${input.namespace}/${head}`,
        parents,
        managed: true,
        remoteUrl,
      }));
    },
    (cause, defect) => defect(cause),
  ).flatMap((result): Result<StackBase, Refusal> => result);
}

/** Shared dependency-only graph preparation; this capability never changes a prerequisite ref or worktree. */
export const PrStacks = {
  operation(text: string): StackPlan {
    return operationSchema.parse(JSON.parse(text));
  },
  start(input: {
    cwd: string;
    repository: string;
    parents: Parent[];
    namespace: string;
    previous?: StackBase;
  }): AsyncResult<StackBase, Refusal> {
    return fromPromise(
      async () => {
        const first = input.parents[0];
        if (first === undefined)
          return refuse("A stacked start needs an implemented prerequisite.");
        const remote = await git(input.cwd, ["config", `branch.${first.branch}.remote`]);
        if (remote === null || remote === "")
          return refuse("The prerequisite has no pushed upstream remote.");
        const prepared = await prepare({
          ...input,
          remote,
          parents: input.previous?.parents ?? input.parents,
        });
        if (prepared.tag !== "Ok") return prepared;
        if (input.previous !== undefined)
          return input.previous.head === prepared.value.head &&
            input.previous.branch === prepared.value.branch &&
            input.previous.remote === remote &&
            input.previous.remoteUrl === prepared.value.remoteUrl
            ? Ok(input.previous)
            : refuse(
                "The interrupted start's pinned dependency inputs changed. Preserve its publication record.",
              );
        return prepared.map((base) => ({ ...base, remote }));
      },
      (cause, defect) => defect(cause),
    ).flatMap((result): Result<StackBase, Refusal> => result);
  },
  decode(text: string): StackBase {
    return baseSchema.parse(JSON.parse(text));
  },
  publish(input: {
    cwd: string;
    remote: string;
    base: StackBase;
    attempted: boolean;
    beforePush: () => Result<void, Refusal>;
  }): AsyncResult<void, Refusal> {
    return fromPromise(
      async () => {
        if (!input.base.managed) return Ok(undefined);
        if (!input.base.branch.startsWith("operator/stacks/"))
          return refuse("A managed base must use the Operator-owned namespace.");
        const remoteUrl = await git(input.cwd, ["remote", "get-url", input.remote]);
        if (input.base.remoteUrl === undefined || remoteUrl !== input.base.remoteUrl)
          return refuse("The managed base's pinned remote URL is unknown or changed.");
        const ref = `refs/heads/${input.base.branch}`;
        const observed = await git(input.cwd, ["ls-remote", input.remote, ref]);
        if (observed === null) return refuse("The managed base remote identity is unknown.");
        const head = observed.split("\t")[0];
        if (head === input.base.head) return Ok(undefined);
        if (head !== "") return refuse("A different head already owns the managed base name.");
        if (input.attempted)
          return refuse(
            "The previous base publication is unresolved. An absent ref does not authorize another write.",
          );
        const intent = input.beforePush();
        if (intent.tag !== "Ok") return intent;
        const sent = await git(input.cwd, [
          "push",
          `--force-with-lease=${ref}:`,
          input.remote,
          `${input.base.head}:${ref}`,
        ]);
        const verified = await git(input.cwd, ["ls-remote", input.remote, ref]);
        return sent === null || verified === null || verified.split("\t")[0] !== input.base.head
          ? refuse("The managed base push is incomplete or uncertain. Inspect it before resuming.")
          : Ok(undefined);
      },
      (cause, defect) => defect(cause),
    ).flatMap((result): Result<void, Refusal> => result);
  },
  prepare(input: Parameters<typeof prepare>[0]) {
    return prepare(input);
  },
};
