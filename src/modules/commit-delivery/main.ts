import { Err, Ok, OkAsync, fromPromise, type Result, type AsyncResult } from "unthrown";
import { z } from "zod";
// Bun has no directory metadata API.
import { mkdir, stat } from "node:fs/promises";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Projects } from "../projects/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { WorkerKinds } from "../worker-kinds/main.ts";
import type { Refusal } from "../../lib/cli-result.ts";
import { CommitReview } from "../commit-review/main.ts";
import { isCodedError, type CodedError } from "../../lib/coded-error.ts";

type Paths = ReturnType<typeof OperatorHome.resolve>;
type Data = z.infer<ReturnType<typeof DeviceState.commitDeliverySchema>>;
type Input = { paths: Paths; cwd: string };
type Target = { sourceId: string; assignment: string };
type Context = Input &
  Target & { launchId: string; nextKind: string; worktree: string; data: Data; revision: number };

function refuse(reason: string, detail: string): Result<never, Refusal> {
  return Err({
    reason: `commit_${reason}`,
    detail,
    next:
      reason === "review_limit"
        ? {
            decider: "person",
            question: "How should this ticket continue after its two review rounds are exhausted?",
          }
        : reason === "blocker_requires_review"
          ? {
              command: "operator commit round --file <file>",
              why: "Commit the blocker fixes, then review the newer candidate.",
            }
          : {
              command: "operator next",
              why: "Read the recorded commit-delivery state. Preserve partial effects and retained history.",
            },
  });
}

/** Preserve the defect channel while narrowing an unused success type. */
function stopped<T>(result: Result<T, Refusal>): Result<never, Refusal> {
  return result.flatMap(() =>
    refuse("state_changed", "The operation no longer matches its recorded state."),
  );
}

function qualify<T>(cause: Error, defect: (cause: Error) => T) {
  if (cause instanceof z.ZodError || cause instanceof SyntaxError)
    return {
      reason: "commit_input_invalid",
      detail: String(cause),
      next: {
        command: "operator --help",
        why: "Correct the supplied commit-delivery input.",
      },
    };
  return defect(cause);
}

const ioCodes = new Set([
  "EACCES",
  "ENOENT",
  "ENOTDIR",
  "EEXIST",
  "EPERM",
  "EROFS",
  "ENOSPC",
  "EIO",
  "EMFILE",
  "ENFILE",
  "EPIPE",
]);

function isIoError(cause: unknown): cause is CodedError {
  return isCodedError(cause) && ioCodes.has(cause.code);
}

function ioFailure(cause: Error): Refusal {
  return {
    reason: "commit_io_failed",
    detail: String(cause),
    next: {
      decider: "person" as const,
      question:
        "How should the filesystem failure be recovered without discarding partial effects?",
    },
  };
}

function invoke(
  input: Parameters<typeof ToolInvocation.run>[0],
): AsyncResult<Awaited<ReturnType<typeof ToolInvocation.run>>, Refusal> {
  return fromPromise(
    () => ToolInvocation.run(input),
    (cause, defect) => (isIoError(cause) ? ioFailure(cause) : defect(cause)),
  );
}

function git(
  cwd: string,
  args: string[],
  options: { input?: string; raw?: boolean } = {},
): AsyncResult<string, Refusal> {
  return invoke({
    tool: "git",
    args,
    cwd,
    input: options.input,
    timeoutMs: 120000,
  }).flatMap((observed) =>
    observed.status === "completed" && observed.exitCode === 0
      ? Ok(options.raw ? observed.stdout : observed.stdout.trim())
      : refuse(
          "git_failed",
          `git ${args[0]} did not succeed: ${JSON.stringify(observed)}. Earlier journaled effects may remain.`,
        ),
  );
}

function clean(cwd: string): AsyncResult<undefined, Refusal> {
  return fromPromise(
    async () => {
      const result = await git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
      return result.flatMap((text) =>
        text === ""
          ? Ok(undefined)
          : refuse(
              "worktree_unclean",
              "Tracked or untracked work is present. Nothing was discarded.",
            ),
      );
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

function remote(data: Pick<Data, "checkout" | "remote">): AsyncResult<string, Refusal> {
  return fromPromise(
    async () => {
      const fetch = await git(data.checkout, ["remote", "get-url", "--all", "origin"]);
      if (fetch.tag !== "Ok") return fetch;
      const push = await git(data.checkout, ["remote", "get-url", "--push", "--all", "origin"]);
      if (push.tag !== "Ok") return push;
      if (fetch.value !== data.remote || push.value !== data.remote)
        return refuse(
          "remote_changed",
          "origin fetch/push identity differs from the pinned delivery target.",
        );
      const result = await git(data.checkout, [
        "ls-remote",
        "--exit-code",
        "origin",
        "refs/heads/main",
      ]);
      return result.flatMap((text) => {
        const match = /^([a-f0-9]{40,64})\s+refs\/heads\/main$/.exec(text);
        return match?.[1] === undefined
          ? refuse("remote_invalid", "origin/main has no unambiguous observed head.")
          : Ok(match[1]);
      });
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

function save(context: Context, data: Data, extra: { handoff?: string; complete?: boolean } = {}) {
  return DeviceState.changeCommitDelivery(context.paths, context, {
    revision: context.revision,
    data: JSON.stringify(data),
    launchId: context.launchId,
    ...extra,
  }).map((revision) => {
    context.revision = revision;
    context.data = data;
    return undefined;
  });
}

function receipt(
  context: Context,
  effect: string,
  state: "intent" | "verified",
  stage: Data["stage"],
) {
  return save(context, {
    ...context.data,
    stage,
    journal: [...context.data.journal, { effect, state, at: new Date().toISOString() }],
  });
}

function worker(paths: Paths) {
  const env = Environment.read();
  return DeviceState.readReport(paths, {
    by: "pane",
    socket: env.HERDR_SOCKET_PATH ?? "",
    paneId: env.HERDR_PANE_ID ?? "",
  }).flatMap(({ source, assignment, launch }) => {
    const kind =
      launch?.kind === null || launch === null
        ? null
        : WorkerKinds.snapshotSchema().parse(JSON.parse(launch.kind));
    if (
      assignment.completion !== "commit" ||
      kind?.completion !== "commit" ||
      launch?.state !== "running" ||
      launch.worktreePath === null
    )
      return refuse(
        "owner_inactive",
        "Run this command from the current commit assignment's isolated worker.",
      );
    return Ok({ source, assignment, launch, nextKind: kind.nextKind ?? "commit-review" });
  });
}

function context(input: Input): AsyncResult<Context, Refusal> {
  return fromPromise(
    async () => {
      const target = worker(input.paths);
      if (target.tag !== "Ok") return stopped(target);
      const { source, assignment, launch, nextKind } = target.value;
      const cwd = await git(input.cwd, ["rev-parse", "--show-toplevel"]);
      if (cwd.tag !== "Ok") return stopped(cwd);
      if (cwd.value !== launch.worktreePath)
        return refuse("foreign_worktree", "The caller is not in its recorded ticket worktree.");
      const rows = DeviceState.readSources(input.paths, source.repository, source.id);
      if (rows.tag !== "Ok") return stopped(rows);
      const row = rows.value[0]?.commitDeliveries?.find(
        (item) => item.assignment === assignment.key,
      );
      if (row === undefined)
        return refuse("target_missing", "This assignment has no recorded commit-delivery target.");
      return Ok({
        ...input,
        sourceId: source.id,
        assignment: assignment.key,
        launchId: launch.id,
        nextKind,
        worktree: launch.worktreePath,
        data: DeviceState.commitDeliverySchema().parse(JSON.parse(row.data)),
        revision: row.revision,
      });
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

function initialize(
  input: Input &
    Target & {
      repository: string;
      ticket: string;
      checkout: string;
      checks: string[][];
    },
): AsyncResult<Data, Refusal> {
  return fromPromise(
    async () => {
      const existing = DeviceState.readSources(input.paths, input.repository, input.sourceId);
      if (existing.tag !== "Ok") return stopped(existing);
      const previous = existing.value[0]?.commitDeliveries?.find(
        (row) => row.assignment === input.assignment,
      );
      if (previous !== undefined)
        return Ok(DeviceState.commitDeliverySchema().parse(JSON.parse(previous.data)));
      const identity = await Projects.githubRemote(input);
      if (identity.tag !== "Ok") return stopped(identity);
      if (identity.value !== "origin")
        return refuse(
          "remote_invalid",
          "Commit delivery requires the registered GitHub identity on origin.",
        );
      const url = await git(input.checkout, ["remote", "get-url", "--all", "origin"]);
      if (url.tag !== "Ok") return stopped(url);
      const base = await git(input.checkout, ["rev-parse", "--verify", "refs/heads/main"]);
      if (base.tag !== "Ok") return stopped(base);
      const observed = await remote({ checkout: input.checkout, remote: url.value });
      if (observed.tag !== "Ok") return stopped(observed);
      if (observed.value !== base.value)
        return refuse(
          "base_diverged",
          "Local main and origin/main must agree before new commit work starts.",
        );
      const data: Data = {
        repository: input.repository,
        ticket: input.ticket,
        checkout: input.checkout,
        localRef: "refs/heads/main",
        remoteRef: "refs/heads/main",
        remote: url.value,
        base: base.value,
        publishedHead: null,
        policy: { checks: input.checks, review: "required", publication: "local-and-origin" },
        candidate: null,
        history: [],
        implementer: null,
        rounds: [],
        dispositions: [],
        checks: null,
        journal: [],
        stage: "build",
        ownerPid: null,
        leaseAt: null,
      };
      return DeviceState.changeCommitDelivery(input.paths, input, {
        revision: null,
        data: JSON.stringify(data),
      }).map(() => data);
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

function prepareCandidate(ctx: Context): AsyncResult<string, Refusal> {
  return fromPromise(
    async () => {
      const status = await clean(ctx.worktree);
      if (status.tag !== "Ok") return stopped(status);
      const tree = await git(ctx.worktree, ["rev-parse", "HEAD^{tree}"]);
      if (tree.tag !== "Ok") return tree;
      const baseTree = await git(ctx.worktree, ["rev-parse", `${ctx.data.base}^{tree}`]);
      if (baseTree.tag !== "Ok") return baseTree;
      if (tree.value === baseTree.value)
        return refuse("empty", "A ticket must produce a nonempty target commit.");
      if (ctx.data.candidate?.tree !== tree.value) {
        if (!["build", "review"].includes(ctx.data.stage))
          return refuse("candidate_pinned", "Delivery started. Retry the same pinned candidate.");
        const id = crypto.randomUUID();
        const candidate = {
          path: OperatorHome.commitCandidate(ctx.paths, id),
          branch: `operator/commit-candidate/${id}`,
          tree: tree.value,
          head: null,
        };
        const recorded = save(ctx, { ...ctx.data, candidate, checks: null });
        if (recorded.tag !== "Ok") return stopped(recorded);
      }
      const candidate = ctx.data.candidate;
      if (candidate === null) return refuse("candidate_missing", "Candidate intent is missing.");
      const pinned = candidate.head;
      if (pinned !== null) return reconcileCandidateReceipt(ctx, candidate).map(() => pinned);
      const intent = receipt(ctx, "candidate_creation", "intent", ctx.data.stage);
      if (intent.tag !== "Ok") return stopped(intent);
      return await createCandidate(ctx, candidate);
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

function createCandidate(
  ctx: Context,
  candidate: NonNullable<Data["candidate"]>,
): AsyncResult<string, Refusal> {
  return fromPromise(
    async () => {
      const directory = await fromPromise(
        () => mkdir(OperatorHome.commitCandidateRoot(ctx.paths), { recursive: true }),
        (cause, defect) => (isIoError(cause) ? ioFailure(cause) : defect(cause)),
      );
      if (directory.tag !== "Ok") return stopped(directory);
      const exists = await pathExists(`${candidate.path}/.git`);
      if (exists.tag !== "Ok") return stopped(exists);
      if (!exists.value) {
        const added = await git(ctx.data.checkout, [
          "worktree",
          "add",
          "-b",
          candidate.branch,
          candidate.path,
          ctx.data.base,
        ]);
        if (added.tag !== "Ok") return added;
      }
      const head = await git(candidate.path, ["rev-parse", "HEAD"]);
      if (head.tag !== "Ok") return head;
      if (head.value === ctx.data.base) {
        const installed = await candidateIndex(ctx, candidate);
        if (installed.tag !== "Ok") return stopped(installed);
        const committed = await git(candidate.path, [
          "commit",
          "-m",
          `Ticket ${ctx.data.ticket}\n\nOperator-Ticket: ${ctx.sourceId}/${ctx.assignment}`,
        ]);
        if (committed.tag !== "Ok") return committed;
      }
      const verified = await verifyCandidate(ctx, candidate);
      if (verified.tag !== "Ok") return verified;
      return save(ctx, {
        ...ctx.data,
        candidate: { ...candidate, head: verified.value },
        history: [...ctx.data.history, verified.value],
        journal: [
          ...ctx.data.journal,
          { effect: "candidate_creation", state: "verified", at: new Date().toISOString() },
        ],
      }).map(() => verified.value);
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

function reconcileCandidateReceipt(
  ctx: Context,
  candidate: NonNullable<Data["candidate"]>,
): AsyncResult<undefined, Refusal> {
  const last = ctx.data.journal.findLast((entry) => entry.effect === "candidate_creation");
  if (last?.state === "verified") return OkAsync(undefined);
  return verifyCandidate(ctx, candidate).flatMap((head) =>
    head === candidate.head
      ? receipt(ctx, "candidate_creation", "verified", ctx.data.stage)
      : refuse("candidate_changed", "The pinned candidate no longer matches its creation intent."),
  );
}

function candidateIndex(
  ctx: Context,
  candidate: NonNullable<Data["candidate"]>,
): AsyncResult<undefined, Refusal> {
  return fromPromise(
    async () => {
      const installed = await matchesTree(candidate.path, candidate.tree);
      if (installed.tag !== "Ok") return stopped(installed);
      const ownIntent = ctx.data.journal.some(
        (entry) =>
          entry.effect === `candidate_index:${candidate.branch}` && entry.state === "intent",
      );
      if (installed.value) {
        return ownIntent
          ? receipt(ctx, `candidate_index:${candidate.branch}`, "verified", ctx.data.stage)
          : refuse("worktree_unclean", "Candidate index has no matching installation intent.");
      }
      const status = await clean(candidate.path);
      if (status.tag !== "Ok") return status;
      const intent = receipt(ctx, `candidate_index:${candidate.branch}`, "intent", ctx.data.stage);
      if (intent.tag !== "Ok") return intent;
      const applied = await installTree(ctx, candidate.path);
      if (applied.tag !== "Ok") return stopped(applied);
      const checked = await matchesTree(candidate.path, candidate.tree);
      if (checked.tag !== "Ok") return stopped(checked);
      return checked.value
        ? receipt(ctx, `candidate_index:${candidate.branch}`, "verified", ctx.data.stage)
        : refuse(
            "checkout_changed",
            "The candidate checkout/index changed during installation. Nothing was committed.",
          );
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

function verifyCandidate(
  ctx: Context,
  candidate: NonNullable<Data["candidate"]>,
): AsyncResult<string, Refusal> {
  return fromPromise(
    async () => {
      const facts = await git(candidate.path, ["show", "-s", "--format=%H%n%P%n%T%n%B", "HEAD"]);
      if (facts.tag !== "Ok") return facts;
      const [head, parent, tree, ...message] = facts.value.split("\n");
      if (
        head === undefined ||
        parent !== ctx.data.base ||
        tree !== candidate.tree ||
        !message.join("\n").includes(`Operator-Ticket: ${ctx.sourceId}/${ctx.assignment}`) ||
        /^co-authored-by:/im.test(message.join("\n"))
      )
        return refuse(
          "candidate_invalid",
          "Candidate differs from its single-parent reviewed tree or ticket identity. No refs advanced.",
        );
      const status = await clean(candidate.path);
      return status.map(() => head);
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

function startReview(input: Input): AsyncResult<Target & { checkout: string }, Refusal> {
  return fromPromise(
    async () => {
      const read = await context(input);
      if (read.tag !== "Ok") return stopped(read);
      const ctx = read.value;
      if (ctx.data.stage !== "build")
        return refuse("review_started", "A fresh reviewer is already recorded.");
      const head = await prepareCandidate(ctx);
      if (head.tag !== "Ok") return stopped(head);
      return save(
        ctx,
        { ...ctx.data, stage: "review", implementer: ctx.launchId },
        { handoff: ctx.nextKind },
      ).map(() => ({
        sourceId: ctx.sourceId,
        assignment: ctx.assignment,
        checkout: ctx.data.checkout,
      }));
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

function recordRound(input: Input & { text: string }): AsyncResult<Data, Refusal> {
  return fromPromise(
    async () => {
      const read = await context(input);
      if (read.tag !== "Ok") return stopped(read);
      const ctx = read.value;
      if (
        ctx.data.implementer === null ||
        ctx.data.implementer === ctx.launchId ||
        ctx.data.stage !== "review"
      )
        return refuse("reviewer_required", "A fresh reviewer must record each review round.");
      if (ctx.data.rounds.length === 2)
        return refuse("review_limit", "Two review rounds are exhausted. Automatic delivery stops.");
      const findings = WorkSources.parseFindings(input.text);
      if (findings.tag === "Err")
        return Err<Refusal>({
          ...findings.error,
          next: { ...findings.error.next, command: "operator commit round --file <path|->" },
        });
      if (findings.tag !== "Ok") return stopped(findings);
      const head = await prepareCandidate(ctx);
      if (head.tag !== "Ok") return stopped(head);
      if (ctx.data.rounds.at(-1)?.head === head.value)
        return refuse("round_head_unchanged", "A second review requires a newer candidate.");
      const data = {
        ...ctx.data,
        rounds: [
          ...ctx.data.rounds,
          { head: head.value, tree: ctx.data.candidate?.tree ?? "", findings: findings.value },
        ],
      };
      return save(ctx, data).map(() => data);
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

function dispositions(text: string): Result<Data["dispositions"], Refusal> {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.shift() !== "## Dispositions")
    return refuse(
      "input_invalid",
      "Expected ## Dispositions and '- <round>.<finding> applied' or 'declined: <reason>'.",
    );
  const rows: Data["dispositions"] = [];
  for (const line of lines) {
    const match = /^- (\d+)\.(\d+) (applied|declined: (.+))$/.exec(line);
    if (match === null)
      return refuse("input_invalid", "A disposition is invalid. No evidence changed.");
    const row: Data["dispositions"][number] = {
      round: Number(match[1]),
      finding: Number(match[2]),
      disposition: match[3] === "applied" ? "applied" : "declined",
    };
    if (match[4] !== undefined) row.reason = match[4];
    rows.push(row);
  }
  return Ok(rows);
}

function runChecks(ctx: Context): AsyncResult<undefined, Refusal> {
  return fromPromise(
    async () => {
      const candidate = ctx.data.candidate;
      if (candidate?.head === null || candidate === null)
        return refuse("candidate_missing", "No pinned candidate exists.");
      const results: NonNullable<Data["checks"]>["results"] = [];
      for (const argv of ctx.data.policy.checks) {
        const before = await checkedCandidate(candidate);
        if (before.tag !== "Ok") return before;
        const [tool, ...args] = argv;
        const invoked = await invoke({
          tool: tool ?? "",
          args,
          cwd: candidate.path,
          timeoutMs: 120000,
        });
        const after = await checkedCandidate(candidate);
        if (invoked.tag === "Defect") return stopped(invoked);
        if (after.tag !== "Ok") return after;
        if (invoked.tag !== "Ok") return stopped(invoked);
        const result = invoked.value;
        if (result.status !== "completed")
          return refuse(
            "checks_failed",
            `Configured check did not complete: ${JSON.stringify(result)}`,
          );
        results.push({ argv, exitCode: result.exitCode });
        if (result.exitCode !== 0)
          return refuse(
            "checks_failed",
            `Configured check failed: ${JSON.stringify({ argv, result })}`,
          );
      }
      return save(ctx, {
        ...ctx.data,
        checks: {
          candidate: candidate.head,
          base: ctx.data.base,
          tree: candidate.tree,
          policy: JSON.stringify(ctx.data.policy),
          results,
        },
      });
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

function checkedCandidate(
  candidate: NonNullable<Data["candidate"]>,
): AsyncResult<undefined, Refusal> {
  return git(candidate.path, ["rev-parse", "HEAD"]).flatMap((head) =>
    head !== candidate.head
      ? refuse("candidate_changed", "A configured check changed the candidate.")
      : matchesTree(candidate.path, candidate.tree).flatMap((matches) =>
          matches
            ? Ok(undefined)
            : refuse(
                "worktree_unclean",
                "Tracked or untracked work is present. Nothing was discarded.",
              ),
        ),
  );
}

function targetCheckout(ctx: Context): AsyncResult<undefined, Refusal> {
  return fromPromise(
    async () => {
      const identity = await sameRepository(ctx);
      if (identity.tag !== "Ok") return identity;
      const root = await git(ctx.data.checkout, ["rev-parse", "--show-toplevel"]);
      if (root.tag !== "Ok") return stopped(root);
      if (root.value !== ctx.data.checkout)
        return refuse("foreign_checkout", "The controlling checkout moved or is foreign.");
      const branch = await git(ctx.data.checkout, ["symbolic-ref", "HEAD"]);
      if (branch.tag !== "Ok") return stopped(branch);
      if (branch.value !== ctx.data.localRef)
        return refuse("unsupported_checkout", "The controlling checkout must be on main.");
      const worktrees = await git(ctx.data.checkout, ["worktree", "list", "--porcelain"]);
      if (worktrees.tag !== "Ok") return stopped(worktrees);
      const targets = worktrees.value
        .split("\n\n")
        .filter((entry) => entry.includes(`\nbranch ${ctx.data.localRef}`));
      if (targets.length !== 1 || !targets[0]?.startsWith(`worktree ${ctx.data.checkout}\n`))
        return refuse(
          "unsupported_checkout",
          "An unsupported additional target checkout holds main.",
        );
      return await busyCheckout(ctx);
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

function sameRepository(ctx: Context): AsyncResult<undefined, Refusal> {
  return git(ctx.worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).flatMap(
    (ticket) =>
      git(ctx.data.checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).flatMap(
        (checkout) =>
          ticket === checkout
            ? Ok(undefined)
            : refuse(
                "foreign_checkout",
                "The controlling path no longer belongs to the ticket's repository. Nothing was overwritten.",
              ),
      ),
  );
}

function pathExists(path: string): AsyncResult<boolean, Refusal> {
  return fromPromise(
    async () => {
      try {
        await stat(path);
        return true;
      } catch (cause) {
        if (isCodedError(cause) && cause.code === "ENOENT") return false;
        // oxlint-disable-next-line unthrown/no-throw -- The adjacent filesystem boundary qualifies only known I/O failures.
        throw cause;
      }
    },
    (cause, defect) => (isIoError(cause) ? ioFailure(cause) : defect(cause)),
  );
}

function busyCheckout(ctx: Context): AsyncResult<undefined, Refusal> {
  return fromPromise(
    async () => {
      for (const name of [
        "index.lock",
        "HEAD.lock",
        "refs/heads/main.lock",
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge",
        "rebase-apply",
        "sequencer",
      ]) {
        const file = await git(ctx.data.checkout, ["rev-parse", "--git-path", name]);
        if (file.tag !== "Ok") return stopped(file);
        const absolute = file.value.startsWith("/")
          ? file.value
          : `${ctx.data.checkout}/${file.value}`;
        const found = await pathExists(absolute);
        if (found.tag !== "Ok") return stopped(found);
        if (found.value)
          return refuse(
            "checkout_busy",
            `The controlling checkout is busy at ${name}. Nothing was overwritten.`,
          );
      }
      return Ok(undefined);
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

function matchesTree(cwd: string, tree: string): AsyncResult<boolean, Refusal> {
  return fromPromise(
    async () => {
      const index = await git(cwd, ["write-tree"]);
      if (index.tag !== "Ok") return stopped(index);
      const diff = await git(cwd, ["diff", "--name-only", tree, "--"]);
      if (diff.tag !== "Ok") return stopped(diff);
      const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard"]);
      return untracked.map((text) => text === "" && diff.value === "" && index.value === tree);
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

// Unlike read-tree, apply --index refuses obstructing ignored files and changed index/worktree contents.
function installTree(ctx: Context, cwd: string): AsyncResult<string, Refusal> {
  return git(
    cwd,
    [
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      ctx.data.base,
      ctx.data.candidate?.tree ?? "",
      "--",
    ],
    { raw: true },
  ).flatMap((patch) => git(cwd, ["apply", "--index", "--whitespace=nowarn"], { input: patch }));
}

function transitionCheckout(ctx: Context): AsyncResult<undefined, Refusal> {
  return fromPromise(
    async () => {
      const ownIntent = ctx.data.journal.some(
        (entry) => entry.effect === "checkout_index" && entry.state === "intent",
      );
      if (!ownIntent) {
        const status = await clean(ctx.data.checkout);
        if (status.tag !== "Ok") return status;
      }
      const installed = await matchesTree(ctx.data.checkout, ctx.data.candidate?.tree ?? "");
      if (installed.tag !== "Ok") return stopped(installed);
      if (!installed.value) {
        const status = await clean(ctx.data.checkout);
        if (status.tag !== "Ok") return status;
        const intent = receipt(ctx, "checkout_index", "intent", "checkout");
        if (intent.tag !== "Ok") return intent;
        const transitioned = await installTree(ctx, ctx.data.checkout);
        if (transitioned.tag !== "Ok") return stopped(transitioned);
      }
      const checked = await matchesTree(ctx.data.checkout, ctx.data.candidate?.tree ?? "");
      if (checked.tag !== "Ok") return stopped(checked);
      return checked.value
        ? receipt(ctx, "checkout_index", "verified", "local")
        : refuse(
            "checkout_changed",
            "The checkout/index no longer matches the pinned candidate. No ref was overwritten.",
          );
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

function advanceLocal(ctx: Context): AsyncResult<undefined, Refusal> {
  return fromPromise(
    async () => {
      const supported = await targetCheckout(ctx);
      if (supported.tag !== "Ok") return supported;
      const candidate = ctx.data.candidate?.head ?? "";
      const head = await git(ctx.data.checkout, ["rev-parse", ctx.data.localRef]);
      if (head.tag !== "Ok") return stopped(head);
      if (head.value === candidate) {
        const status = await clean(ctx.data.checkout);
        return status.flatMap(() =>
          receipt(
            ctx,
            "local_ref",
            "verified",
            ctx.data.stage === "finalize" ? "finalize" : "remote",
          ),
        );
      }
      if (head.value !== ctx.data.base)
        return refuse(
          "local_advanced",
          "Local main advanced concurrently. The pinned candidate and partial effects stay.",
        );
      const transitioned = await transitionCheckout(ctx);
      if (transitioned.tag !== "Ok") return transitioned;
      const receiptSaved = receipt(ctx, "local_ref", "intent", "local");
      if (receiptSaved.tag !== "Ok") return receiptSaved;
      const advanced = await git(ctx.data.checkout, [
        "update-ref",
        "-m",
        `Operator ticket ${ctx.assignment}`,
        ctx.data.localRef,
        candidate,
        ctx.data.base,
      ]);
      if (advanced.tag !== "Ok") return stopped(advanced);
      return receipt(ctx, "local_ref", "verified", "remote");
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

function remoteContains(ctx: Context, observed: string): AsyncResult<boolean, Refusal> {
  if (observed === ctx.data.candidate?.head) return OkAsync(true);
  return git(ctx.data.checkout, ["fetch", "--no-tags", "origin", observed]).flatMap(() =>
    fromPromise(
      async () => {
        const invoked = await invoke({
          tool: "git",
          args: ["merge-base", "--is-ancestor", ctx.data.candidate?.head ?? "", observed],
          cwd: ctx.data.checkout,
          timeoutMs: 10000,
        });
        if (invoked.tag !== "Ok") return stopped(invoked);
        const result = invoked.value;
        return result.status === "completed" && (result.exitCode === 0 || result.exitCode === 1)
          ? Ok(result.exitCode === 0)
          : refuse(
              "remote_uncertain",
              "Remote ancestry could not be verified. Local effects may remain.",
            );
      },
      (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
    ).flatMap((result) => result),
  );
}

function publish(ctx: Context): AsyncResult<undefined, Refusal> {
  return fromPromise(
    async () => {
      const candidate = ctx.data.candidate?.head ?? "";
      const observed = await remote(ctx.data);
      if (observed.tag !== "Ok") return stopped(observed);
      const contains = await remoteContains(ctx, observed.value);
      if (contains.tag !== "Ok") return stopped(contains);
      if (!contains.value) {
        const intent = receipt(ctx, "remote_publication", "intent", "remote");
        if (intent.tag !== "Ok") return intent;
        // A retry publishes the same object without force. A failed response proves no non-application.
        const pushed = await git(ctx.data.checkout, [
          "push",
          "origin",
          `${candidate}:${ctx.data.remoteRef}`,
        ]);
        const reconciled = await observePublication(ctx);
        if (pushed.tag === "Defect") return stopped(pushed);
        if (reconciled.tag === "Err" && pushed.tag === "Err") return stopped(pushed);
        return reconciled;
      }
      return publicationReceipt(ctx, observed.value);
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

function publicationReceipt(ctx: Context, head: string): Result<undefined, Refusal> {
  return save(ctx, { ...ctx.data, publishedHead: ctx.data.publishedHead ?? head }).flatMap(() =>
    receipt(ctx, "remote_publication", "verified", "finalize"),
  );
}

function observePublication(ctx: Context): AsyncResult<undefined, Refusal> {
  return remote(ctx.data).flatMap((head) =>
    remoteContains(ctx, head).flatMap((contains) =>
      contains
        ? publicationReceipt(ctx, head)
        : refuse(
            "remote_uncertain",
            "Push returned, but origin/main does not verify the pinned candidate. Local delivery may have succeeded.",
          ),
    ),
  );
}

function qualifyReview(
  ctx: Context,
  dispositions: Data["dispositions"],
  candidate: string,
): Result<undefined, Refusal> {
  const gate = CommitReview.decide(ctx.data.rounds, dispositions, candidate);
  if (gate === null) return Ok(undefined);
  const recorded =
    gate === "review_limit" || gate === "blocker_requires_review"
      ? save(ctx, { ...ctx.data, dispositions })
      : Ok(undefined);
  return recorded.flatMap(() =>
    refuse(
      gate,
      "Automatic delivery requires complete dispositions and a clean final round on the exact candidate. Preserve work and ask the person when two rounds are exhausted.",
    ),
  );
}

function deliver(input: Input & { text: string }): AsyncResult<Data, Refusal> {
  return fromPromise(
    async () => {
      const read = await context(input);
      if (read.tag !== "Ok") return stopped(read);
      const ctx = read.value;
      if (ctx.data.stage === "complete") return Ok(ctx.data);
      const parsed = dispositions(input.text);
      if (parsed.tag !== "Ok") return stopped(parsed);
      if (ctx.launchId === ctx.data.implementer || ctx.data.implementer === null)
        return refuse("reviewer_required", "Only a fresh reviewer may deliver commit work.");
      const candidate = ctx.data.candidate;
      if (candidate?.head === null || candidate === null)
        return refuse("candidate_missing", "No pinned candidate exists.");
      const reconciled = await reconcileCandidateReceipt(ctx, candidate);
      if (reconciled.tag !== "Ok") return stopped(reconciled);
      const qualified = qualifyReview(ctx, parsed.value, candidate.head);
      if (qualified.tag !== "Ok") return stopped(qualified);
      const claimed = save(ctx, {
        ...ctx.data,
        dispositions: parsed.value,
        ownerPid: process.pid,
        leaseAt: new Date().toISOString(),
      });
      if (claimed.tag !== "Ok") return stopped(claimed);
      const renew = setInterval(() => {
        save(ctx, { ...ctx.data, leaseAt: new Date().toISOString() }).getOr(undefined);
      }, 1000);
      renew.unref();
      try {
        return await deliveryEffects(ctx);
      } finally {
        clearInterval(renew);
        if (ctx.data.ownerPid === process.pid)
          save(ctx, { ...ctx.data, ownerPid: null, leaseAt: null }).getOr(undefined);
      }
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

function admit(ctx: Context): AsyncResult<undefined, Refusal> {
  return clean(ctx.worktree)
    .flatMap(() => git(ctx.worktree, ["rev-parse", "HEAD^{tree}"]))
    .flatMap((tree) =>
      tree === ctx.data.candidate?.tree
        ? Ok(undefined)
        : refuse(
            "candidate_changed",
            "Ticket changes after the last round require a newer candidate and review.",
          ),
    )
    .flatMap(() => runChecks(ctx))
    .flatMap(() => remote(ctx.data))
    .flatMap((head) =>
      head === ctx.data.base
        ? Ok(undefined)
        : refuse(
            "remote_advanced",
            "origin/main advanced since the recorded base. No automatic rebase or forced publication is authorized.",
          ),
    )
    .flatMap(() => receipt(ctx, "delivery_admission", "intent", "checkout"));
}

function deliveryEffects(ctx: Context): AsyncResult<Data, Refusal> {
  return fromPromise(
    async () => {
      if (ctx.data.stage === "review") {
        const admitted = await admit(ctx);
        if (admitted.tag !== "Ok") return stopped(admitted);
      }
      const local = await advanceLocal(ctx);
      if (local.tag !== "Ok") return stopped(local);
      const published = await publish(ctx);
      if (published.tag !== "Ok") return stopped(published);
      const intent = receipt(ctx, "database_finalization", "intent", "finalize");
      if (intent.tag !== "Ok") return stopped(intent);
      const data: Data = {
        ...ctx.data,
        stage: "complete",
        ownerPid: null,
        leaseAt: null,
        journal: [
          ...ctx.data.journal,
          { effect: "database_finalization", state: "verified", at: new Date().toISOString() },
        ],
      };
      return save(ctx, data, { complete: true }).map(() => data);
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

/** The module owns the complete no-PR completion workflow, not a PR approval exception. */
export const CommitDelivery = {
  initialize(input: Parameters<typeof initialize>[0]) {
    return initialize(input);
  },
  review(input: Input) {
    return startReview(input);
  },
  round(input: Parameters<typeof recordRound>[0]) {
    return recordRound(input);
  },
  deliver(input: Parameters<typeof deliver>[0]) {
    return deliver(input);
  },
};
