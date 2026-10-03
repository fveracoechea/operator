import {
  BELOW_SLOT,
  BODY_LIMIT,
  commentMarker,
  type RecallCause,
  renderRecall,
  type DeferredFinding,
  type Landed,
  type PublishCommit,
  type PublishedText,
  type RejectedFinding,
  renderBody,
  renderResolution,
  type Verified,
} from "./body.ts";
import {
  commitsBetween,
  fetchTarget,
  isAncestor,
  mergesCleanly,
  pushNew,
  type Remote,
  remoteBranches,
  remoteOf,
  subjectOf,
} from "./git.ts";
import {
  convertToDraft,
  createPull,
  pullsByHead,
  readParents,
  readPullState,
  closePull,
  commentOn,
  commentsOf,
  readRepository,
  readRules,
  type MergeSettings,
  type PullState,
  retargetPull,
} from "./github.ts";

/** Why one plan cannot publish, in the fixed order of decision 10 that this module checks. */
type Refusal = { reason: PlanRefusal; detail: string };

type PlanRefusal =
  | "cut_not_between_commits"
  | "section_missing"
  | "body_too_long"
  | "repository_unread"
  | "merge_commit_not_allowed"
  | "signatures_required"
  | "remote_missing"
  | "remote_ambiguous"
  | "remote_unread"
  | "remote_name_taken"
  | "base_not_on_target";

/** One cut point of the stack: the commit that ends the part below, and why the cut is there. */
type CutPoint = { after: string; reason: string };

/** The reviewer text of the lowest part, and each cut point with the text of the part above it. */
type StackText = PublishedText & { cuts: Array<PublishedText & CutPoint> };

/**
 * One pull request of the stack, exactly as it is pushed and created. Its remote branch ends at
 * its last commit, and the cut below it is null for the lowest part.
 */
type Part = {
  name: string;
  commit: string;
  base: string;
  title: string;
  body: string;
  cut: CutPoint | null;
};

/**
 * The tracker steps of one item after its pull request merged, with the resolution already
 * rendered but for the pull request slot. The publish approval names each one as a target, so no
 * tracker write after the merge happens without it (D2).
 */
type TrackerStep = {
  part: number;
  commit: string;
  closes: string;
  resolution: string;
  behaviorChanges: PublishCommit["behaviorChanges"];
};

/** Everything that ships, which is what the plan revision names (decision 8). */
type Ships = {
  remote: Remote;
  target: string;
  base: string;
  head: string;
  parts: Part[];
  trackerSteps: TrackerStep[];
};

/** A GitHub outcome that no stack publication planned (decision 21). Operator adopts nothing. */
type StackFault = "closed_unmerged" | "base_not_target" | "head_moved" | "not_merge_commit";

/** What GitHub shows of one published pull request, read when a person reports a merge. */
type Seen = {
  part: number;
  number: number;
  state: "open" | "merged" | "closed";
  head: string;
  base: string;
  draft: boolean;
  mergeCommit: string | null;
  method: "merge" | "squash or rebase" | null;
  fault: StackFault | null;
  detail: string | null;
};

/** What the preview reports and the revision does not cover (decision 8). */
type Info = {
  targetTip: string | null;
  commitsBehind: number | null;
  mergesCleanly: boolean | null;
  otherMethodsAllowed: string[];
  unverifiedRules: string[];
};

/** One staged write. Each one reads first and writes only what is still missing. */
type Effect =
  | { kind: "push"; remote: string; refs: Array<{ name: string; commit: string }> }
  | {
      kind: "create";
      repository: string;
      head: string;
      base: string;
      title: string;
      body: string;
      /** The recorded number of the part below, which fills the one slot of the body. */
      below: number | null;
    }
  | { kind: "retarget"; repository: string; number: number; from: string; base: string }
  | { kind: "recall"; repository: string; number: number; comment: string; marker: string }
  | {
      /**
       * The close of one pull request that a later stack publication replaces, with one comment
       * that points to the replacement, whose number fills the one slot at the write. A recall
       * with no replacement names no publication: its own comment already names the withdrawal.
       */
      kind: "close";
      repository: string;
      number: number;
      publication: number | null;
      replacement: number | null;
      /** The published commit of the pull request, or null for an intent recorded without it. */
      head: string | null;
    };

type WriteOutcome =
  | { status: "done"; how: "observed" | "written"; number: number | null; url: string | null }
  | { status: "conflict"; found: string }
  | { status: "failed"; message: string }
  | { status: "uncertain"; detail: string };

/** The namespace of every remote branch a stack publication creates (decision 13). */
function nameOf(sourceSlug: string, publication: number, part: number): string {
  return `operator/${sourceSlug}/${publication}/${part}`;
}

/** The commits of the head with their subjects, read from Git, in landing order. */
async function withSubjects(
  repoRoot: string,
  commits: Array<Omit<PublishCommit, "subject">>,
): Promise<PublishCommit[] | string> {
  const read: PublishCommit[] = [];
  for (const one of commits) {
    const subject = await subjectOf(repoRoot, one.commit);
    if (subject.status !== "read") {
      return subject.detail;
    }
    read.push({ ...one, subject: subject.value });
  }
  return read;
}

/** The merge method and signature checks of the target branch (decisions 20 and 26). */
async function targetChecks(repository: string, target: string, refusals: Refusal[], info: Info) {
  const rules = await readRules(repository, target);
  info.unverifiedRules.push(
    "classic branch protection: the rules endpoint does not return it, and reading it needs admin rights",
  );
  if (rules.status !== "read") {
    info.unverifiedRules.push(`branch rules of ${target}: ${rules.detail}`);
    return;
  }
  if (rules.value.linearHistory) {
    refusals.push({
      reason: "merge_commit_not_allowed",
      detail: `A rule of ${target} requires a linear history, so no merge commit can merge.`,
    });
  }
  if (rules.value.allowedMethods !== null && !rules.value.allowedMethods.includes("merge")) {
    refusals.push({
      reason: "merge_commit_not_allowed",
      detail: `A ruleset of ${target} allows only ${rules.value.allowedMethods.join(", ")}.`,
    });
  }
  if (rules.value.signaturesRequired) {
    refusals.push({
      reason: "signatures_required",
      detail: `A rule of ${target} requires signed commits, and Operator publishes the unsigned landed commits.`,
    });
  }
}

/**
 * The last position of each part below the top, or the cuts that fall inside no gap between two
 * neighbouring commits: a commit the head does not hold, the last commit, or a cut out of order.
 */
function cutEnds(
  commits: string[],
  cuts: CutPoint[],
): { status: "cut"; ends: number[] } | { status: "refused"; cuts: string[] } {
  const ends: number[] = [];
  const refused: string[] = [];
  for (const cut of cuts) {
    const at = commits.indexOf(cut.after);
    const previous = ends.at(-1) ?? -1;
    if (at === -1 || at === commits.length - 1 || at <= previous) {
      refused.push(cut.after);
    } else {
      ends.push(at);
    }
  }
  return refused.length === 0 ? { status: "cut", ends } : { status: "refused", cuts: refused };
}

/** The refusal of the cuts that fall inside no gap, worded once for the report and for the plan. */
function cutsRefused(cuts: string[]): Refusal & { cuts: string[] } {
  return {
    reason: "cut_not_between_commits",
    cuts,
    detail: `A cut falls only between two neighbouring commits of the head, and these do not: ${cuts.join(", ")}.`,
  };
}

/** The refusal of the cuts of one head, or null when each cut falls between two commits. */
function cutRefusal(commits: string[], cuts: CutPoint[]): (Refusal & { cuts: string[] }) | null {
  const split = cutEnds(commits, cuts);
  return split.status === "cut" ? null : cutsRefused(split.cuts);
}

type PlanRequest = {
  repoRoot: string;
  repository: string;
  sourceSlug: string;
  publication: number;
  branch: { base: string; head: string };
  commits: Array<Omit<PublishCommit, "subject">>;
  text: StackText | null;
  verified: Verified;
  rejected: RejectedFinding[];
  deferred: DeferredFinding[];
};

/** One part of the stack before it has a name: its commits, its reviewer text, and its body. */
type Piece = { range: PublishCommit[]; text: PublishedText; cut: CutPoint | null; body: string };

/**
 * Cuts the head into parts and renders the body of each. It refuses, in the order of decision
 * 10, a cut inside no gap, a review with no published text, and a body over the GitHub limit.
 * The pieces are null after one of the first two, and the count is the number of names to check.
 */
function partsOf(
  request: PlanRequest,
  commits: PublishCommit[],
): { count: number; pieces: Piece[] | null; refusals: Refusal[] } {
  const cuts = request.text?.cuts ?? [];
  const split = cutEnds(
    commits.map((one) => one.commit),
    cuts,
  );
  if (split.status === "refused") {
    return { count: 1, pieces: null, refusals: [cutsRefused(split.cuts)] };
  }
  if (request.text === null) {
    const detail = "The review that gates this publish recorded no published text.";
    return { count: 1, pieces: null, refusals: [{ reason: "section_missing", detail }] };
  }
  // Each part is a contiguous range of the landing order, from the cut below it to the next one.
  const starts = [0, ...split.ends.map((end) => end + 1)];
  const placed = [
    { text: request.text, cut: null },
    ...cuts.map((cut) => ({ text: cut, cut: { after: cut.after, reason: cut.reason } })),
  ].map((section, index) => ({
    ...section,
    range: commits.slice(starts[index], starts[index + 1]),
  }));
  const pieces = placed.map((piece, index): Piece => {
    const held = new Set(piece.range.map((one) => one.commit));
    const body = renderBody({
      repository: request.repository,
      text: piece.text,
      commits: piece.range,
      verified: {
        gateCommands: request.verified.gateCommands,
        gateRuns: request.verified.gateRuns.filter(
          (one) => one.at === "base" || held.has(one.commit),
        ),
        reviews: request.verified.reviews.filter(
          (one) => one.commit === null || held.has(one.commit),
        ),
      },
      rejected: request.rejected.filter(
        (one) => one.targets.length === 0 || one.targets.some((target) => held.has(target)),
      ),
      deferred: request.deferred,
      stack:
        placed.length === 1
          ? null
          : {
              part: index + 1,
              of: placed.length,
              others: placed.flatMap((other, at) =>
                at === index ? [] : [{ part: at + 1, commits: other.range.length }],
              ),
            },
    });
    return { ...piece, body };
  });
  const refusals = pieces.flatMap((piece, index): Refusal[] =>
    piece.body.length > BODY_LIMIT
      ? [
          {
            reason: "body_too_long",
            detail: `The body of part ${index + 1} holds ${piece.body.length} characters, over the GitHub limit of ${BODY_LIMIT}.`,
          },
        ]
      : [],
  );
  return { count: pieces.length, pieces, refusals };
}

type TargetRefusal = {
  reason: "repository_unread" | "remote_missing" | "remote_ambiguous" | "remote_unread";
  detail: string;
};

type Reading<Value> =
  | { status: "read"; value: Value }
  | { status: "refused"; refusal: TargetRefusal };

/**
 * The target of one repository: its settings, the one remote whose URL names it (decision 12),
 * and the tip of its default branch fetched by its commit. Each read gives its own refusal, so a
 * plan names each one at its place in the order of decision 10. The tip is fetched only after
 * the other two are read, and otherwise holds the first refusal with the stage that gave it.
 */
async function readTarget(
  repoRoot: string,
  repository: string,
): Promise<{
  settings: Reading<MergeSettings>;
  remote: Reading<Remote>;
  fetched:
    | { status: "read"; target: string; remote: Remote; tip: string }
    | { status: "refused"; stage: "settings" | "remote" | "fetch"; refusal: TargetRefusal };
}> {
  const read = await readRepository(repository);
  const settings: Reading<MergeSettings> =
    read.status === "read"
      ? read
      : { status: "refused", refusal: { reason: "repository_unread", detail: read.detail } };
  const found = await remoteOf(repoRoot, repository);
  const remote: Reading<Remote> =
    found.status === "found"
      ? { status: "read", value: found.remote }
      : {
          status: "refused",
          refusal:
            found.status === "missing"
              ? { reason: "remote_missing", detail: `No remote URL names ${repository}.` }
              : found.status === "ambiguous"
                ? {
                    reason: "remote_ambiguous",
                    detail: `Each of these remotes names ${repository}: ${found.remotes.map((one) => one.name).join(", ")}.`,
                  }
                : { reason: "remote_unread", detail: found.detail },
        };
  if (settings.status === "refused") {
    return { settings, remote, fetched: { ...settings, stage: "settings" } };
  }
  if (remote.status === "refused") {
    return { settings, remote, fetched: { ...remote, stage: "remote" } };
  }
  const target = settings.value.target;
  const tip = await fetchTarget(repoRoot, remote.value.name, target);
  const fetched =
    tip.status === "read"
      ? { status: "read" as const, target, remote: remote.value, tip: tip.value }
      : {
          status: "refused" as const,
          stage: "fetch" as const,
          refusal: { reason: "remote_unread" as const, detail: tip.detail },
        };
  return { settings, remote, fetched };
}

/** The repository settings checks, and the merge method and signature checks of the target. */
async function settingsChecks(
  repository: string,
  settings: MergeSettings,
  refusals: Refusal[],
  info: Info,
) {
  info.otherMethodsAllowed = settings.otherMethods;
  if (!settings.allowMergeCommit) {
    refusals.push({
      reason: "merge_commit_not_allowed",
      detail: `${repository} does not allow a merge commit.`,
    });
  }
  await targetChecks(repository, settings.target, refusals, info);
}

/** Whether the integration base is on the fetched target tip, and how the head merges into it. */
async function baseChecks(
  repoRoot: string,
  branch: { base: string; head: string },
  fetched: { target: string; tip: string },
  refusals: Refusal[],
  info: Info,
) {
  info.targetTip = fetched.tip;
  const ancestor = await isAncestor(repoRoot, branch.base, fetched.tip);
  if (ancestor.status !== "read" || !ancestor.value) {
    refusals.push({
      reason: "base_not_on_target",
      detail:
        ancestor.status === "read"
          ? `The integration base ${branch.base} is not an ancestor of ${fetched.target} at ${fetched.tip}.`
          : ancestor.detail,
    });
  }
  const behind = await commitsBetween(repoRoot, branch.base, fetched.tip);
  info.commitsBehind = behind.status === "read" ? behind.value : null;
  const clean = await mergesCleanly(repoRoot, fetched.tip, branch.head);
  info.mergesCleanly = clean.status === "read" ? clean.value : null;
}

/** Everything that ships, built only once the remote, the target, and every body are known. */
function shipsOf(
  request: PlanRequest,
  commits: PublishCommit[],
  pieces: Piece[],
  remote: Remote,
  target: string,
): Ships {
  const name = (index: number) => nameOf(request.sourceSlug, request.publication, index + 1);
  const partOf = new Map(
    pieces.flatMap((piece, index) => piece.range.map((one) => [one.commit, index + 1] as const)),
  );
  return {
    remote,
    target,
    base: request.branch.base,
    head: request.branch.head,
    parts: pieces.map((piece, index) => ({
      name: name(index),
      commit: piece.range.at(-1)?.commit ?? request.branch.head,
      // The lowest part targets the target, and each higher one the branch below it.
      base: index === 0 ? target : name(index - 1),
      title: piece.text.title,
      body: piece.body,
      cut: piece.cut,
    })),
    trackerSteps: commits.flatMap((one) =>
      one.closes === null
        ? []
        : [
            {
              part: partOf.get(one.commit) ?? 1,
              commit: one.commit,
              closes: one.closes,
              behaviorChanges: one.behaviorChanges,
              resolution: renderResolution({
                repository: request.repository,
                target,
                commit: one.commit,
                behaviorChanges: one.behaviorChanges,
                pullRequest: null,
                landed: null,
              }),
            },
          ],
    ),
  };
}

/**
 * Publishes the integration branch of one source as a pull request stack (ADR 0022). It is the
 * only module that pushes or writes a pull request. It never merges, never asks for auto-merge,
 * never pushes with force, and never deletes a branch: a person merges.
 */
export const PullRequestStack = {
  /**
   * Plans one stack publication and writes nothing that others read: it selects the remote,
   * fetches the target tip by its commit, checks the names, the target settings, and the rules,
   * and renders each title and body. Every refusal it finds is reported at once, in order.
   */
  async plan(
    request: PlanRequest,
  ): Promise<
    | { status: "planned"; ships: Ships | null; info: Info; refusals: Refusal[] }
    | { status: "unread"; detail: string }
  > {
    const commits = await withSubjects(request.repoRoot, request.commits);
    if (typeof commits === "string") {
      return { status: "unread", detail: commits };
    }
    const parts = partsOf(request, commits);
    const refusals: Refusal[] = [...parts.refusals];
    const info: Info = {
      targetTip: null,
      commitsBehind: null,
      mergesCleanly: null,
      otherMethodsAllowed: [],
      unverifiedRules: [],
    };

    const { settings, remote, fetched } = await readTarget(request.repoRoot, request.repository);
    if (settings.status === "refused") {
      refusals.push(settings.refusal);
    } else {
      await settingsChecks(request.repository, settings.value, refusals, info);
    }
    if (remote.status === "refused") {
      refusals.push(remote.refusal);
    } else {
      const names = Array.from({ length: parts.count }, (_none, index) =>
        nameOf(request.sourceSlug, request.publication, index + 1),
      );
      const taken = await remoteBranches(request.repoRoot, remote.value.name, names);
      refusals.push(
        ...(taken.status === "read"
          ? [...taken.value].map(([name, commit]): Refusal => ({
              reason: "remote_name_taken",
              detail: `The remote ${remote.value.name} already holds ${name} at ${commit}.`,
            }))
          : [{ reason: "remote_unread" as const, detail: taken.detail }]),
      );
    }
    if (fetched.status === "read") {
      await baseChecks(request.repoRoot, request.branch, fetched, refusals, info);
    } else if (fetched.stage === "fetch") {
      refusals.push(fetched.refusal);
    }

    const ships =
      settings.status === "read" && remote.status === "read" && parts.pieces !== null
        ? shipsOf(request, commits, parts.pieces, remote.value, settings.value.target)
        : null;
    return { status: "planned", ships, info, refusals };
  },

  /**
   * Reads the target branch of one repository, fetches its tip by its commit, and answers
   * whether one commit is on it, for the new base of a rebase (ADR 0022). The target is the
   * default branch, and the remote is the one whose URL names the repository, as for a plan. It
   * moves no ref of the project and writes nothing that others read.
   */
  async target(request: { repoRoot: string; repository: string; commit: string }): Promise<
    | { status: "read"; target: string; tip: string; onTarget: boolean }
    | {
        status: "unread";
        reason: "repository_unread" | "remote_missing" | "remote_ambiguous" | "remote_unread";
        detail: string;
      }
  > {
    const { fetched } = await readTarget(request.repoRoot, request.repository);
    if (fetched.status === "refused") {
      return { status: "unread", ...fetched.refusal };
    }
    const on = await isAncestor(request.repoRoot, request.commit, fetched.tip);
    return on.status === "read"
      ? { status: "read", target: fetched.target, tip: fetched.tip, onTarget: on.value }
      : { status: "unread", reason: "remote_unread", detail: on.detail };
  },

  /**
   * Performs one staged effect. It reads first and writes only when the read shows that the
   * effect is still needed, so a repeat after a lost answer is safe (ADR 0005).
   */
  async write(request: { repoRoot: string; effect: Effect }): Promise<WriteOutcome> {
    const { effect } = request;
    switch (effect.kind) {
      case "push":
        return writePush(request.repoRoot, effect);
      case "create":
        return writeCreate(effect);
      case "retarget":
        return writeRetarget(effect);
      case "recall":
        return writeRecall(effect);
      default:
        return writeClose(effect);
    }
  },

  /**
   * Renders the one comment of a recall from its causes, with the marker by which a repeat finds
   * it. The text holds no free words: the causes come from the records (D1).
   */
  recallComment(request: { id: string; causes: RecallCause[]; replaced: boolean }): {
    comment: string;
    marker: string;
  } {
    const marker = commentMarker(request.id);
    return { marker, comment: renderRecall({ marker, ...request }) };
  },

  /**
   * Refuses the cut points of a branch review that fall inside no gap between neighbouring
   * commits of its head. The report and the plan both ask here, so the rule is written once.
   */
  cutRefusal(request: {
    commits: string[];
    cuts: CutPoint[];
  }): (Refusal & { cuts: string[] }) | null {
    return cutRefusal(request.commits, request.cuts);
  },

  /**
   * Renders the resolution of one code item from what the merge observation recorded. With no
   * pull request number it is the text the plan shows and the publish approval binds.
   */
  resolution(request: {
    repository: string;
    target: string;
    commit: string;
    behaviorChanges: PublishCommit["behaviorChanges"];
    pullRequest: number | null;
    landed: Landed | null;
  }): string {
    return renderResolution(request);
  },

  /**
   * Reads each published pull request from GitHub and writes nothing. It records its state,
   * head, base, merge commit, and merge method, and names a fault when the head, the base, or
   * the method is not what the publication planned (decisions 19 to 21).
   */
  async observe(request: {
    repository: string;
    target: string;
    pullRequests: Array<{ part: number; number: number; publishedCommit: string }>;
  }): Promise<{ status: "read"; seen: Seen[] } | { status: "unread"; detail: string }> {
    const seen: Seen[] = [];
    for (const one of request.pullRequests) {
      const read = await observeOne(request.repository, request.target, one);
      if (read.status !== "read") {
        return read;
      }
      seen.push(read.value);
    }
    return { status: "read", seen };
  },
};

/** The one fault of a pull request, in the order a person settles them, or none. */
function faultOf(
  pull: { state: string; merged: boolean; head: string; base: string },
  planned: { publishedCommit: string; target: string },
  method: Seen["method"],
): { fault: StackFault; detail: string } | null {
  if (pull.state === "closed" && !pull.merged) {
    return { fault: "closed_unmerged", detail: "It was closed with no merge." };
  }
  if (pull.merged && pull.base !== planned.target) {
    return {
      fault: "base_not_target",
      detail: `It merged into ${pull.base}, not into the target ${planned.target}.`,
    };
  }
  if (pull.head !== planned.publishedCommit) {
    return {
      fault: "head_moved",
      detail: `Its head is ${pull.head}, not the published commit ${planned.publishedCommit}, so it holds a commit that no review read.`,
    };
  }
  if (pull.merged && method !== "merge") {
    return {
      fault: "not_merge_commit",
      detail: `It merged by a ${method ?? "unknown"} merge, not by a merge commit.`,
    };
  }
  return null;
}

/**
 * Reads one pull request. A merge commit has two parents, and its second parent is the
 * published head, so the reviewed commits reach the target with their identity. One parent is a
 * squash or a rebase merge, which GitHub does not tell apart.
 */
async function observeOne(
  repository: string,
  target: string,
  planned: { part: number; number: number; publishedCommit: string },
): Promise<{ status: "read"; value: Seen } | { status: "unread"; detail: string }> {
  const pull = await readPullState(repository, planned.number);
  if (pull.status !== "read") {
    return pull;
  }
  let method: Seen["method"] = null;
  if (pull.value.merged) {
    if (pull.value.mergeCommit === null) {
      return {
        status: "unread",
        detail: `GitHub shows pull request #${planned.number} merged with no merge commit.`,
      };
    }
    const parents = await readParents(repository, pull.value.mergeCommit);
    if (parents.status !== "read") {
      return parents;
    }
    method =
      parents.value.length === 2 && parents.value[1] === pull.value.head
        ? "merge"
        : "squash or rebase";
  }
  const found = faultOf(pull.value, { publishedCommit: planned.publishedCommit, target }, method);
  return {
    status: "read",
    value: {
      part: planned.part,
      number: planned.number,
      state: pull.value.merged ? "merged" : pull.value.state === "closed" ? "closed" : "open",
      head: pull.value.head,
      base: pull.value.base,
      draft: pull.value.draft,
      mergeCommit: pull.value.merged ? pull.value.mergeCommit : null,
      method,
      fault: found?.fault ?? null,
      detail: found?.detail ?? null,
    },
  };
}

/** What the remote holds against the planned names: all, none, or a mix a person settles. */
async function readPushed(
  repoRoot: string,
  effect: Extract<Effect, { kind: "push" }>,
): Promise<"all" | "none" | { conflict: string } | { unread: string }> {
  const found = await remoteBranches(
    repoRoot,
    effect.remote,
    effect.refs.map((one) => one.name),
  );
  if (found.status !== "read") {
    return { unread: found.detail };
  }
  if (found.value.size === 0) {
    return "none";
  }
  const atPlan = effect.refs.every((one) => found.value.get(one.name) === one.commit);
  return atPlan
    ? "all"
    : {
        conflict: [...found.value].map(([name, commit]) => `${name} at ${commit}`).join(", "),
      };
}

/**
 * Recovery reads the remote once: every name at its planned commit is done, no name pushes
 * again, and anything else is a conflict for a person, never pushed over (decision 13).
 */
async function writePush(
  repoRoot: string,
  effect: Extract<Effect, { kind: "push" }>,
): Promise<WriteOutcome> {
  const before = await readPushed(repoRoot, effect);
  if (before === "all") {
    return { status: "done", how: "observed", number: null, url: null };
  }
  if (typeof before === "object") {
    return "conflict" in before
      ? { status: "conflict", found: before.conflict }
      : { status: "uncertain", detail: before.unread };
  }
  const pushed = await pushNew(repoRoot, effect.remote, effect.refs);
  const after = await readPushed(repoRoot, effect);
  if (after === "all") {
    return { status: "done", how: "written", number: null, url: null };
  }
  if (typeof after === "object" && "conflict" in after) {
    return { status: "conflict", found: after.conflict };
  }
  // A push that the remote rejected lands nothing, and its message is the record (decision 26).
  if (pushed.status === "rejected" && after === "none") {
    return { status: "failed", message: pushed.message };
  }
  return {
    status: "uncertain",
    detail:
      pushed.status === "no-answer"
        ? pushed.detail
        : typeof after === "object"
          ? after.unread
          : "The push answered, and the remote does not show its names.",
  };
}

/**
 * Recovery lists the pull requests whose head is the new name, in every state: one is the
 * created pull request, none creates it, and more than one is a conflict (decision 14).
 */
async function writeCreate(effect: Extract<Effect, { kind: "create" }>): Promise<WriteOutcome> {
  const found = await pullsByHead(effect.repository, effect.head);
  if (found.status !== "read") {
    return { status: "uncertain", detail: found.detail };
  }
  const [only] = found.value;
  if (only !== undefined) {
    return found.value.length === 1
      ? { status: "done", how: "observed", number: only.number, url: only.url }
      : {
          status: "conflict",
          found: found.value.map((one) => `#${one.number} (${one.state})`).join(", "),
        };
  }
  // The body is final at its create: its one slot is the number of the part below.
  const created = await createPull(effect.repository, {
    ...effect,
    body:
      effect.below === null
        ? effect.body
        : effect.body.replaceAll(BELOW_SLOT, String(effect.below)),
  });
  if (created.status === "created") {
    return {
      status: "done",
      how: "written",
      number: created.value.number,
      url: created.value.url,
    };
  }
  return created.status === "failed"
    ? { status: "failed", message: created.message }
    : { status: "uncertain", detail: created.detail };
}

/** The answer of one pull request write, or the outcome that stops the routine before it. */
type PullAnswer =
  | { status: "changed" | "closed" | "written" }
  | { status: "failed"; message: string }
  | { status: "uncertain"; detail: string }
  | { status: "stopped"; outcome: Exclude<WriteOutcome, { status: "done" }> };

/**
 * The one recovery rule of a pull request write (ADR 0005). It reads first, and a read that
 * settles the effect ends it with no write. Otherwise it writes and reads again: the write is
 * done only when that read shows it, and a lost answer stays uncertain, never assumed.
 */
async function pullWrite(
  repository: string,
  number: number,
  step: {
    /** The outcome that the first read already gives, or null when the write is still needed. */
    settled(before: PullState): WriteOutcome | null;
    write(before: PullState): Promise<PullAnswer>;
    /** Null when the second read shows the effect, or else what that read shows. */
    confirmed(after: PullState): string | null;
  },
): Promise<WriteOutcome> {
  const before = await readPullState(repository, number);
  if (before.status !== "read") {
    return { status: "uncertain", detail: before.detail };
  }
  const settled = step.settled(before.value);
  if (settled !== null) {
    return settled;
  }
  const answer = await step.write(before.value);
  if (answer.status === "failed") {
    return { status: "failed", message: answer.message };
  }
  if (answer.status === "stopped") {
    return answer.outcome;
  }
  const after = await readPullState(repository, number);
  if (after.status === "read") {
    const missing = step.confirmed(after.value);
    return missing === null
      ? { status: "done", how: "written", number, url: null }
      : { status: "uncertain", detail: missing };
  }
  return {
    status: "uncertain",
    detail: answer.status === "uncertain" ? answer.detail : after.detail,
  };
}

/** A pull request that merged or is no longer open, which a person settles. */
function notOpen(pull: PullState): WriteOutcome {
  return {
    status: "conflict",
    found: `#${pull.number} is ${pull.merged ? "merged" : pull.state} into ${pull.base}`,
  };
}

/**
 * Changes the base of one part to the target after the part below merged by a merge commit
 * (decision 15). It reads first: a base GitHub already changed is done with no write, and a pull
 * request that is no longer open, or whose base is neither, is a conflict for a person.
 */
async function writeRetarget(effect: Extract<Effect, { kind: "retarget" }>): Promise<WriteOutcome> {
  return pullWrite(effect.repository, effect.number, {
    settled: (before) =>
      before.base === effect.base
        ? { status: "done", how: "observed", number: effect.number, url: null }
        : before.state !== "open" || before.base !== effect.from
          ? notOpen(before)
          : null,
    write: async () => retargetPull(effect.repository, effect.number, effect.base),
    confirmed: (after) =>
      after.base === effect.base ? null : `#${effect.number} still targets ${after.base}.`,
  });
}

/** The comment that a replaced pull request gets once, with a marker that finds it again. */
function replacedComment(effect: { publication: number; replacement: number | null }): string {
  return [
    `<!-- operator:replaced-by-publication:${effect.publication} -->`,
    `Stack publication ${effect.publication} replaces this pull request${effect.replacement === null ? "" : `: it starts at #${effect.replacement}`}.`,
    "Its commits changed on the integration branch and were reviewed again, so this pull request is closed with no merge. Its branch stays.",
  ].join("\n");
}

type Ensured =
  | { status: "found" }
  | { status: "written" }
  | Exclude<WriteOutcome, { status: "done" }>;

/** Adds one marked comment unless a read finds it, so a repeat never writes it twice. */
async function ensureComment(
  repository: string,
  number: number,
  comment: { body: string; marker: string },
): Promise<Ensured> {
  const held = await commentsOf(repository, number);
  if (held.status !== "read") {
    return { status: "uncertain", detail: held.detail };
  }
  if (held.value.some((one) => one.includes(comment.marker))) {
    return { status: "found" };
  }
  const posted = await commentOn(repository, number, comment.body);
  if (posted.status === "written") {
    return { status: "written" };
  }
  return posted.status === "failed"
    ? { status: "failed", message: posted.message }
    : { status: "uncertain", detail: posted.detail };
}

/**
 * Turns one open pull request into a draft and adds the one comment with the reason (decision
 * 23). It reads first: a draft that holds the comment is done with no write. A pull request that
 * merged or closed first is a conflict for a person, because a merge before the recall ends the
 * change (decision 24). The comment comes only after a read shows the draft. It never merges and
 * never closes.
 */
async function writeRecall(effect: Extract<Effect, { kind: "recall" }>): Promise<WriteOutcome> {
  const drafted = await pullWrite(effect.repository, effect.number, {
    settled: (before) =>
      before.merged || before.state !== "open"
        ? notOpen(before)
        : before.draft
          ? { status: "done", how: "observed", number: effect.number, url: null }
          : null,
    write: async (before) =>
      before.nodeId === null
        ? {
            status: "stopped",
            outcome: {
              status: "uncertain",
              detail: `GitHub answered #${effect.number} with no node id.`,
            },
          }
        : convertToDraft(before.nodeId).then((drafted) =>
            // A recall names what the second read saw, never the lost answer of the draft.
            drafted.status === "uncertain" ? { status: "written" } : drafted,
          ),
    confirmed: (after) => (after.draft ? null : `#${effect.number} is not a draft yet.`),
  });
  if (drafted.status !== "done") {
    return drafted;
  }
  const commented = await ensureComment(effect.repository, effect.number, {
    body: effect.comment,
    marker: effect.marker,
  });
  if (commented.status !== "found" && commented.status !== "written") {
    return commented;
  }
  return commented.status === "written" ? { ...drafted, how: "written" } : drafted;
}

/**
 * Closes one pull request with no merge (decisions 23 and 30). A later publication first adds one
 * comment that points to the replacement; a recall with no replacement adds none, because its
 * own comment named the withdrawal. It reads first: a closed pull request is done, a merged one or
 * one whose head is not the published commit is a conflict for a person, and the comment is
 * written only when no comment holds its marker, so a repeat writes nothing twice. It never
 * merges and deletes no branch.
 */
async function writeClose(effect: Extract<Effect, { kind: "close" }>): Promise<WriteOutcome> {
  return pullWrite(effect.repository, effect.number, {
    settled: (before) =>
      before.merged
        ? notOpen(before)
        : before.state === "closed"
          ? { status: "done", how: "observed", number: effect.number, url: null }
          : // A person moved its head, so Operator writes nothing more to it (decision 21).
            effect.head !== null && before.head !== effect.head
            ? {
                status: "conflict",
                found: `#${effect.number} has head ${before.head}, not the published commit ${effect.head}`,
              }
            : null,
    write: async () => {
      if (effect.publication !== null) {
        const comment = replacedComment({ ...effect, publication: effect.publication });
        const commented = await ensureComment(effect.repository, effect.number, {
          body: comment,
          marker: comment.split("\n")[0] ?? "",
        });
        if (commented.status !== "found" && commented.status !== "written") {
          return { status: "stopped", outcome: commented };
        }
      }
      return closePull(effect.repository, effect.number);
    },
    confirmed: (after) =>
      after.state === "closed" && !after.merged
        ? null
        : `#${effect.number} is still ${after.state}.`,
  });
}
