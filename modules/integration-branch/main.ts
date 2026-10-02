import { ToolInvocation } from "../tool-invocation/main.ts";

/** The namespace of every integration branch, so no branch of a person or an Operative is one. */
const NAMESPACE = "operator/integration";

async function git(
  repoRoot: string,
  args: string[],
): Promise<{ status: "read"; value: string } | { status: "unread"; detail: string }> {
  const invoked = await ToolInvocation.run({
    tool: "git",
    args: ["-C", repoRoot, ...args],
    timeoutMs: 30_000,
  });
  return invoked.status === "completed" && invoked.exitCode === 0
    ? { status: "read", value: invoked.stdout.trim() }
    : {
        status: "unread",
        detail:
          invoked.status === "completed"
            ? `git ${args[0] ?? ""} exited ${invoked.exitCode}: ${invoked.stderr.trim()}`
            : invoked.detail,
      };
}

/** One Git call whose output is kept byte for byte, as a commit object must be. */
async function gitRaw(
  repoRoot: string,
  args: string[],
  input?: string,
): Promise<
  | { status: "completed"; exitCode: number; stdout: string; stderr: string }
  | { status: "unread"; detail: string }
> {
  const call: Parameters<typeof ToolInvocation.run>[0] = {
    tool: "git",
    args: ["-C", repoRoot, ...args],
    timeoutMs: 120_000,
  };
  if (input !== undefined) {
    call.input = input;
  }
  const invoked = await ToolInvocation.run(call);
  return invoked.status === "completed" ? invoked : { status: "unread", detail: invoked.detail };
}

/** The headers and the message of one commit object, as Git stores them. */
type CommitObject = { headers: string[]; message: string; parents: string[]; tree: string };

async function readCommit(
  repoRoot: string,
  commit: string,
): Promise<{ status: "read"; value: CommitObject } | { status: "unread"; detail: string }> {
  const read = await gitRaw(repoRoot, ["cat-file", "commit", commit]);
  if (read.status !== "completed" || read.exitCode !== 0) {
    return {
      status: "unread",
      detail: read.status === "completed" ? read.stderr.trim() : read.detail,
    };
  }
  const split = read.stdout.indexOf("\n\n");
  const head = split === -1 ? read.stdout : read.stdout.slice(0, split);
  const message = split === -1 ? "" : read.stdout.slice(split + 2);
  // A continued header line starts with a space and belongs to the header above it.
  const headers: string[] = [];
  for (const line of head.split("\n")) {
    if (line.startsWith(" ") && headers.length > 0) {
      headers[headers.length - 1] += `\n${line}`;
    } else {
      headers.push(line);
    }
  }
  const field = (name: string) =>
    headers.filter((one) => one.startsWith(`${name} `)).map((one) => one.slice(name.length + 1));
  return {
    status: "read",
    value: { headers, message, parents: field("parent"), tree: field("tree")[0] ?? "" },
  };
}

/**
 * The patch identity of one commit against one parent (ADR 0020): `git patch-id --verbatim` over
 * one canonical diff. The diff is plumbing, so no user setting changes it: three lines of
 * context, whitespace kept, no rename detection, and full binary content.
 */
async function patchBetween(
  repoRoot: string,
  parent: string,
  commit: string,
): Promise<{ status: "read"; patch: string } | { status: "unread"; detail: string }> {
  const diff = await gitRaw(repoRoot, [
    "diff-tree",
    "-p",
    "--no-renames",
    "--unified=3",
    "--binary",
    "--full-index",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    parent,
    commit,
  ]);
  if (diff.status !== "completed" || diff.exitCode !== 0) {
    return {
      status: "unread",
      detail: diff.status === "completed" ? diff.stderr.trim() : diff.detail,
    };
  }
  if (diff.stdout === "") {
    return { status: "read", patch: "empty" };
  }
  const id = await gitRaw(repoRoot, ["patch-id", "--verbatim"], diff.stdout);
  if (id.status !== "completed" || id.exitCode !== 0) {
    return { status: "unread", detail: id.status === "completed" ? id.stderr.trim() : id.detail };
  }
  return { status: "read", patch: id.stdout.trim().split(" ")[0] ?? "" };
}

/** The commits from the base to the tip, oldest first. The branch is one linear history. */
async function commitsOf(
  repoRoot: string,
  base: string,
  tip: string,
): Promise<{ status: "read"; commits: string[] } | { status: "unread"; detail: string }> {
  const listed = await git(repoRoot, [
    "rev-list",
    "--reverse",
    "--first-parent",
    `${base}..${tip}`,
  ]);
  return listed.status === "read"
    ? { status: "read", commits: listed.value === "" ? [] : listed.value.split("\n") }
    : listed;
}

/**
 * The landed commit of a merge landing: the merged tree on the tip, with every header of the
 * reviewed commit except its tree, its parents, and its signature, and the same message. So the
 * author, the committer, and both dates are copied, the commit is unsigned, and a repeat gives
 * the same commit.
 */
function landedObject(reviewed: CommitObject, tree: string, tip: string): string {
  const kept = reviewed.headers.filter(
    (one) =>
      !one.startsWith("tree ") &&
      !one.startsWith("parent ") &&
      !one.startsWith("gpgsig ") &&
      !one.startsWith("gpgsig-sha256 ") &&
      !one.startsWith("mergetag "),
  );
  return [`tree ${tree}`, `parent ${tip}`, ...kept].join("\n") + `\n\n${reviewed.message}`;
}

/** Why one landing cannot be planned or made. Each one lands nothing. */
type LandingRefusal =
  | { status: "tip-moved"; found: string | null; checkedOut: string[] }
  | { status: "checked-out"; worktrees: string[] }
  | { status: "conflict"; paths: string[] }
  | { status: "patch-changed"; reviewed: string; planned: string }
  | { status: "unread"; detail: string };

type LandingPlan = {
  status: "ready";
  name: string;
  /** The recorded tip the branch moves from. */
  from: string;
  /** The commit the branch moves to. It equals `from` when nothing lands. */
  to: string;
  /** The commit on the branch that carries the result, and its parent there. */
  landed: string;
  landedParent: string;
  kind: "fast-forward" | "merge" | "held";
  /** The tree of `to`, which keys its gate run (ADR 0021). */
  tree: string;
  /** The patch identity of the reviewed commit, which the landed commit carries. */
  patch: string;
};

type Tip =
  | { status: "found"; commit: string }
  | { status: "absent" }
  | { status: "unread"; detail: string };

/** The commit one local branch holds, or `absent` when the branch does not exist. */
async function tipOf(repoRoot: string, name: string): Promise<Tip> {
  const invoked = await ToolInvocation.run({
    tool: "git",
    args: ["-C", repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${name}^{commit}`],
    timeoutMs: 30_000,
  });
  if (invoked.status !== "completed") {
    return { status: "unread", detail: invoked.detail };
  }
  // `--verify --quiet` exits 1 with no output when the ref does not exist.
  return invoked.exitCode === 0
    ? { status: "found", commit: invoked.stdout.trim() }
    : { status: "absent" };
}

/** Every worktree of the shared repository that has the branch checked out. */
async function checkedOut(
  repoRoot: string,
  name: string,
): Promise<{ status: "read"; paths: string[] } | { status: "unread"; detail: string }> {
  const listed = await git(repoRoot, ["worktree", "list", "--porcelain"]);
  if (listed.status !== "read") {
    return listed;
  }
  const paths: string[] = [];
  let path: string | null = null;
  for (const line of listed.value.split("\n")) {
    if (line.startsWith("worktree ")) {
      path = line.slice("worktree ".length);
    } else if (line === `branch refs/heads/${name}` && path !== null) {
      paths.push(path);
    }
  }
  return { status: "read", paths };
}

/**
 * The integration branch of one source (ADR 0020). This module is the only writer of it: a plain
 * local branch that it creates once at the integration base and moves only from its recorded
 * tip. It never resets a branch, never adopts a tip that it did not record, and never pushes.
 */
export const IntegrationBranch = {
  /** The name of the integration branch of one source, from the slug of the source. */
  nameOf(request: { sourceSlug: string }): string {
    return `${NAMESPACE}/${request.sourceSlug}`;
  },

  /**
   * Resolves one commit name to its full commit, so a recorded tip compares with what a caller
   * names.
   */
  async resolve(request: {
    repoRoot: string;
    commit: string;
  }): Promise<{ status: "resolved"; commit: string } | { status: "unresolved"; detail: string }> {
    const read = await git(request.repoRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${request.commit}^{commit}`,
    ]);
    return read.status === "read"
      ? { status: "resolved", commit: read.value }
      : { status: "unresolved", detail: `Git names no commit ${request.commit}.` };
  },

  /**
   * Creates the branch at the integration base. The ref is written only if it does not exist, so
   * a branch that a person made is never taken over. A repeat that finds the branch at the same
   * commit answers `created`, because an interrupted first dispatch may have made it already.
   */
  async create(request: {
    repoRoot: string;
    name: string;
    commit: string;
  }): Promise<
    | { status: "created"; name: string; commit: string }
    | { status: "exists"; name: string; found: string }
    | { status: "failed"; detail: string }
  > {
    const found = await tipOf(request.repoRoot, request.name);
    if (found.status === "unread") {
      return { status: "failed", detail: found.detail };
    }
    if (found.status === "found") {
      return found.commit === request.commit
        ? { status: "created", name: request.name, commit: request.commit }
        : { status: "exists", name: request.name, found: found.commit };
    }

    // An empty old value makes Git refuse when the ref appeared since the read above.
    const written = await git(request.repoRoot, [
      "update-ref",
      "-m",
      "operator: create the integration branch at its base",
      `refs/heads/${request.name}`,
      request.commit,
      "",
    ]);
    if (written.status === "read") {
      return { status: "created", name: request.name, commit: request.commit };
    }
    const after = await tipOf(request.repoRoot, request.name);
    if (after.status !== "found") {
      return { status: "failed", detail: written.detail };
    }
    return after.commit === request.commit
      ? { status: "created", name: request.name, commit: request.commit }
      : { status: "exists", name: request.name, found: after.commit };
  },

  /**
   * Reads the branch against its recorded tip. A branch that holds any other commit, or that is
   * gone, moved outside this protocol, and only a person puts it back. Each worktree that has the
   * branch checked out is named in both answers.
   */
  async read(request: {
    repoRoot: string;
    name: string;
    recordedTip: string;
  }): Promise<
    | { status: "at-tip"; checkedOut: string[] }
    | { status: "tip-moved"; found: string | null; checkedOut: string[] }
    | { status: "unread"; detail: string }
  > {
    const found = await tipOf(request.repoRoot, request.name);
    if (found.status === "unread") {
      return found;
    }
    const worktrees = await checkedOut(request.repoRoot, request.name);
    if (worktrees.status === "unread") {
      return worktrees;
    }
    const commit = found.status === "found" ? found.commit : null;
    return commit === request.recordedTip
      ? { status: "at-tip", checkedOut: worktrees.paths }
      : { status: "tip-moved", found: commit, checkedOut: worktrees.paths };
  },
  /** The patch identity of one commit against its parent (ADR 0020). */
  async patchOf(request: {
    repoRoot: string;
    commit: string;
  }): Promise<{ status: "read"; patch: string } | { status: "unread"; detail: string }> {
    const reviewed = await readCommit(request.repoRoot, request.commit);
    if (reviewed.status !== "read") {
      return reviewed;
    }
    const [parent] = reviewed.value.parents;
    if (parent === undefined || reviewed.value.parents.length > 1) {
      return { status: "unread", detail: `Commit ${request.commit} does not have one parent.` };
    }
    return patchBetween(request.repoRoot, parent, request.commit);
  },

  /**
   * Plans the landing of one reviewed commit on the recorded tip, and moves no ref (ADR 0020).
   * When the parent of the commit is the tip, the branch moves to the commit itself. When the
   * branch already holds a commit with an equal patch, nothing lands. Otherwise the change is
   * merged onto the tip with the reviewed base as the merge base, with no worktree, and
   * the new commit must carry the same patch. Only Git objects are written, never a ref.
   */
  async plan(request: {
    repoRoot: string;
    name: string;
    base: string;
    recordedTip: string;
    commit: string;
    /**
     * The commit the reviewed change starts from. It is the parent of the commit, or, for a
     * result that a rework cycle stacked on an earlier submission, the base of the first one.
     */
    reviewedBase: string;
  }): Promise<LandingPlan | LandingRefusal> {
    const read = await IntegrationBranch.read(request);
    if (read.status === "unread") {
      return read;
    }
    if (read.status === "tip-moved") {
      return read;
    }
    if (read.checkedOut.length > 0) {
      return { status: "checked-out", worktrees: read.checkedOut };
    }

    const reviewed = await readCommit(request.repoRoot, request.commit);
    if (reviewed.status !== "read") {
      return reviewed;
    }
    const [parent] = reviewed.value.parents;
    if (parent === undefined || reviewed.value.parents.length > 1) {
      return { status: "unread", detail: `Commit ${request.commit} does not have one parent.` };
    }
    const patch = await patchBetween(request.repoRoot, request.reviewedBase, request.commit);
    if (patch.status !== "read") {
      return patch;
    }
    const ready = (
      fields: Pick<LandingPlan, "to" | "landed" | "landedParent" | "kind" | "tree">,
    ) => ({
      status: "ready" as const,
      name: request.name,
      from: request.recordedTip,
      patch: patch.patch,
      ...fields,
    });

    if (parent === request.recordedTip) {
      return ready({
        to: request.commit,
        landed: request.commit,
        landedParent: parent,
        kind: "fast-forward",
        tree: reviewed.value.tree,
      });
    }

    // A commit that the branch already holds with an equal patch lands nothing.
    const held = await commitsOf(request.repoRoot, request.base, request.recordedTip);
    if (held.status !== "read") {
      return held;
    }
    let below = request.base;
    for (const one of held.commits) {
      const onBranch = await patchBetween(request.repoRoot, below, one);
      if (onBranch.status !== "read") {
        return onBranch;
      }
      if (onBranch.patch === patch.patch) {
        const tip = await readCommit(request.repoRoot, request.recordedTip);
        if (tip.status !== "read") {
          return tip;
        }
        return ready({
          to: request.recordedTip,
          landed: one,
          landedParent: below,
          kind: "held",
          tree: tip.value.tree,
        });
      }
      below = one;
    }

    const merged = await gitRaw(request.repoRoot, [
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--no-messages",
      `--merge-base=${request.reviewedBase}`,
      request.recordedTip,
      request.commit,
    ]);
    if (merged.status !== "completed") {
      return merged;
    }
    const lines = merged.stdout.split("\n").filter((one) => one !== "");
    // Exit 1 is a merge with conflicts, and its paths follow the tree line.
    if (merged.exitCode === 1) {
      return { status: "conflict", paths: [...new Set(lines.slice(1))] };
    }
    if (merged.exitCode !== 0 || lines[0] === undefined) {
      return {
        status: "unread",
        detail: `git merge-tree exited ${merged.exitCode}: ${merged.stderr.trim()}`,
      };
    }

    const written = await gitRaw(
      request.repoRoot,
      ["hash-object", "-t", "commit", "-w", "--stdin"],
      landedObject(reviewed.value, lines[0], request.recordedTip),
    );
    if (written.status !== "completed" || written.exitCode !== 0) {
      return {
        status: "unread",
        detail: written.status === "completed" ? written.stderr.trim() : written.detail,
      };
    }
    const landed = written.stdout.trim();
    const planned = await patchBetween(request.repoRoot, request.recordedTip, landed);
    if (planned.status !== "read") {
      return planned;
    }
    if (planned.patch !== patch.patch) {
      return { status: "patch-changed", reviewed: patch.patch, planned: planned.patch };
    }
    return ready({
      to: landed,
      landed,
      landedParent: request.recordedTip,
      kind: "merge",
      tree: lines[0],
    });
  },

  /**
   * Moves the branch from one tip to one planned commit, as a compare-and-swap. A branch that
   * already holds the planned commit answers `moved`, so a recovery is a repeat. A branch that
   * holds anything else moved outside this protocol, and a branch that a worktree has checked
   * out is never moved under it.
   */
  async move(request: {
    repoRoot: string;
    name: string;
    from: string;
    to: string;
  }): Promise<
    | { status: "moved" }
    | { status: "tip-moved"; found: string | null; checkedOut: string[] }
    | { status: "checked-out"; worktrees: string[] }
    | { status: "unread"; detail: string }
  > {
    const read = await IntegrationBranch.read({ ...request, recordedTip: request.to });
    if (read.status === "unread") {
      return read;
    }
    if (read.status === "at-tip") {
      return { status: "moved" };
    }
    if (read.found !== request.from) {
      return read;
    }
    if (read.checkedOut.length > 0) {
      return { status: "checked-out", worktrees: read.checkedOut };
    }
    const written = await git(request.repoRoot, [
      "update-ref",
      "-m",
      "operator: land an accepted commit",
      `refs/heads/${request.name}`,
      request.to,
      request.from,
    ]);
    const after = await IntegrationBranch.read({ ...request, recordedTip: request.to });
    if (after.status === "at-tip") {
      return { status: "moved" };
    }
    // A write that Git refused at the old tip moved nothing, so a repeat may land it again.
    if (after.status === "unread" || (after.found === request.from && written.status !== "read")) {
      return {
        status: "unread",
        detail: written.status === "read" ? "The branch did not move." : written.detail,
      };
    }
    return after;
  },
};
