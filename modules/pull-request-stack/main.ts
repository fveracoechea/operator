import {
  BODY_LIMIT,
  type DeferredFinding,
  type PublishCommit,
  type PublishedText,
  type RejectedFinding,
  renderBody,
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
import { createPull, pullsByHead, readRepository, readRules } from "./github.ts";

/** Why one plan cannot publish, in the fixed order of decision 10 that this module checks. */
type Refusal = { reason: PlanRefusal; detail: string };

type PlanRefusal =
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

/** One pull request of the stack, exactly as it is pushed and created. */
type Part = { name: string; commit: string; base: string; title: string; body: string };

/** Everything that ships, which is what the plan revision names (decision 8). */
type Ships = {
  remote: Remote;
  target: string;
  base: string;
  head: string;
  parts: Part[];
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
  async plan(request: {
    repoRoot: string;
    repository: string;
    sourceSlug: string;
    publication: number;
    branch: { base: string; head: string };
    commits: Array<Omit<PublishCommit, "subject">>;
    text: PublishedText | null;
    verified: Verified;
    rejected: RejectedFinding[];
    deferred: DeferredFinding[];
  }): Promise<
    | { status: "planned"; ships: Ships | null; info: Info; refusals: Refusal[] }
    | { status: "unread"; detail: string }
  > {
    const refusals: Refusal[] = [];
    const info: Info = {
      targetTip: null,
      commitsBehind: null,
      mergesCleanly: null,
      otherMethodsAllowed: [],
      unverifiedRules: [],
    };

    const commits = await withSubjects(request.repoRoot, request.commits);
    if (typeof commits === "string") {
      return { status: "unread", detail: commits };
    }
    let body: string | null = null;
    if (request.text === null) {
      refusals.push({
        reason: "section_missing",
        detail: "The review that gates this publish recorded no published text.",
      });
    } else {
      body = renderBody({
        repository: request.repository,
        text: request.text,
        commits,
        verified: request.verified,
        rejected: request.rejected,
        deferred: request.deferred,
      });
      if (body.length > BODY_LIMIT) {
        refusals.push({
          reason: "body_too_long",
          detail: `The body of part 1 holds ${body.length} characters, over the GitHub limit of ${BODY_LIMIT}.`,
        });
      }
    }

    const settings = await readRepository(request.repository);
    if (settings.status !== "read") {
      refusals.push({ reason: "repository_unread", detail: settings.detail });
    } else {
      info.otherMethodsAllowed = settings.value.otherMethods;
      if (!settings.value.allowMergeCommit) {
        refusals.push({
          reason: "merge_commit_not_allowed",
          detail: `${request.repository} does not allow a merge commit.`,
        });
      }
      await targetChecks(request.repository, settings.value.target, refusals, info);
    }

    const remote = await remoteOf(request.repoRoot, request.repository);
    if (remote.status === "missing") {
      refusals.push({
        reason: "remote_missing",
        detail: `No remote URL names ${request.repository}.`,
      });
    } else if (remote.status === "ambiguous") {
      refusals.push({
        reason: "remote_ambiguous",
        detail: `Each of these remotes names ${request.repository}: ${remote.remotes.map((one) => one.name).join(", ")}.`,
      });
    } else if (remote.status === "unread") {
      refusals.push({ reason: "remote_unread", detail: remote.detail });
    }

    const names = [nameOf(request.sourceSlug, request.publication, 1)];
    if (remote.status === "found") {
      const taken = await remoteBranches(request.repoRoot, remote.remote.name, names);
      if (taken.status !== "read") {
        refusals.push({ reason: "remote_unread", detail: taken.detail });
      } else {
        for (const [name, commit] of taken.value) {
          refusals.push({
            reason: "remote_name_taken",
            detail: `The remote ${remote.remote.name} already holds ${name} at ${commit}.`,
          });
        }
      }
    }

    if (remote.status === "found" && settings.status === "read") {
      const target = settings.value.target;
      const tip = await fetchTarget(request.repoRoot, remote.remote.name, target);
      if (tip.status !== "read") {
        refusals.push({ reason: "remote_unread", detail: tip.detail });
      } else {
        info.targetTip = tip.value;
        const ancestor = await isAncestor(request.repoRoot, request.branch.base, tip.value);
        if (ancestor.status !== "read" || !ancestor.value) {
          refusals.push({
            reason: "base_not_on_target",
            detail:
              ancestor.status === "read"
                ? `The integration base ${request.branch.base} is not an ancestor of ${target} at ${tip.value}.`
                : ancestor.detail,
          });
        }
        const behind = await commitsBetween(request.repoRoot, request.branch.base, tip.value);
        info.commitsBehind = behind.status === "read" ? behind.value : null;
        const clean = await mergesCleanly(request.repoRoot, tip.value, request.branch.head);
        info.mergesCleanly = clean.status === "read" ? clean.value : null;
      }
    }

    const ships =
      remote.status === "found" &&
      settings.status === "read" &&
      body !== null &&
      request.text !== null
        ? {
            remote: remote.remote,
            target: settings.value.target,
            base: request.branch.base,
            head: request.branch.head,
            parts: names.map((name) => ({
              name,
              commit: request.branch.head,
              base: settings.value.target,
              title: request.text?.title ?? "",
              body: body ?? "",
            })),
          }
        : null;
    return { status: "planned", ships, info, refusals };
  },

  /**
   * Performs one staged effect. It reads first and writes only when the read shows that the
   * effect is still needed, so a repeat after a lost answer is safe (ADR 0005).
   */
  async write(request: { repoRoot: string; effect: Effect }): Promise<WriteOutcome> {
    const { effect } = request;
    if (effect.kind === "push") {
      return writePush(request.repoRoot, effect);
    }
    return writeCreate(effect);
  },
};

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
  const created = await createPull(effect.repository, effect);
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
