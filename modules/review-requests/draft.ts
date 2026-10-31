// Bun has no path API.
import path from "node:path";
import { Err, Ok, type Result } from "unthrown";
import { z } from "zod";
import type { PullRequestFacts, RequiredCheck } from "./github.ts";

function text(max: number) {
  return z.string().trim().min(1).max(max);
}
/** One spelling of a repository path, so a changed file cannot pass under another one. */
function repositoryPath() {
  return text(500)
    .refine(
      (value) => !value.startsWith("/") && !value.split("/").includes(".."),
      "Give a path relative to the repository root, without ..",
    )
    .transform((value) => path.posix.normalize(value).replace(/^\.\//, ""));
}
const location = {
  path: repositoryPath().optional(),
  line: z.number().int().positive().optional(),
};
const finding = {
  short: text(80).refine(
    (value) => value.split(/\s+/).length <= 6,
    "A finding's short description has at most six words.",
  ),
  detail: text(2000),
  ...location,
  /** Where the finding comes from: a skill, the project code style, an ADR, or best practice. */
  source: text(100).optional(),
};
const blocker = z.strictObject({
  ...finding,
  /** Only a defect that breaks the app or a security issue requests changes. */
  impact: z.enum(["breaking", "security"]).optional(),
});
const niceToHave = z.strictObject(finding);

/** The reviewer's draft. The CLI computes the review event, so the draft names none. */
export const draftSchema = z
  .strictObject({
    reviewedCommit: z.string().regex(/^[0-9a-f]{40}$/, "Use the full 40-character commit."),
    summary: text(500).refine((value) => !value.includes("\n"), "Write the summary on one line."),
    blockers: z.array(blocker).max(3).default([]),
    niceToHaves: z.array(niceToHave).max(3).default([]),
    // `acknowledge` accepts valid pushback. `explain` keeps a defect open, and a resolved thread reopens.
    threadReplies: z
      .array(
        z.strictObject({
          threadId: text(200),
          kind: z.enum(["acknowledge", "explain"]),
          body: text(2000),
        }),
      )
      .default([]),
    checks: z
      .array(
        z.strictObject({
          kind: z.enum(["test", "lint", "typecheck", "guard-break", "other"]),
          command: text(500),
          exitCode: z.number().int(),
          summary: text(300).optional(),
        }),
      )
      .default([]),
    noise: z
      .array(
        z.strictObject({
          check: text(200),
          files: z.array(repositoryPath()).min(1),
          reason: text(300),
        }),
      )
      .default([]),
  })
  .superRefine((draft, context) => {
    for (const finding of [...draft.blockers, ...draft.niceToHaves])
      if ((finding.path === undefined) !== (finding.line === undefined))
        context.addIssue({
          code: "custom",
          message: "Give a finding both path and line, or neither.",
        });
  });
export type Draft = z.infer<typeof draftSchema>;

/**
 * The findings of a stored round draft, which a later round reads again. A draft from an earlier
 * release can have a blocker `breach` and a nice to have with no `short`, so this shape drops
 * unknown fields and does not require a nice-to-have short.
 */
export const storedFindingsSchema = z.object({
  blockers: z.array(z.object(blocker.shape)).default([]),
  niceToHaves: z.array(z.object(niceToHave.shape).partial({ short: true })).default([]),
});
export type Findings = z.infer<typeof storedFindingsSchema>;
export type AcceptedDraft = {
  draft: Draft;
  /** Failing required CI checks that no valid noise claim covers. They are blocker facts. */
  failingChecks: RequiredCheck[];
  pendingChecks: RequiredCheck[];
  /** False when the PR has more check contexts than one read returns. */
  checksComplete: boolean;
};
type Refusal = { reason: string; detail: string };

function refuse(reason: string, detail: string) {
  return Err<Refusal>({ reason, detail: `${detail} Nothing was posted.` });
}

const rules: ((draft: Draft, pr: PullRequestFacts, commit: string) => Refusal | null)[] = [
  (draft, pr, commit) =>
    draft.reviewedCommit === commit
      ? null
      : {
          reason: "review_head_moved",
          detail: `The draft reviews ${draft.reviewedCommit}, but this round reviews ${commit} and the PR head is ${pr.head}. A stale draft is not posted.`,
        },
  (draft) =>
    draft.checks.some((check) => check.kind === "guard-break" && check.exitCode === 0)
      ? {
          reason: "review_draft_invalid",
          detail: "A deliberate guard break that exited 0 did not prove its guard.",
        }
      : null,
  (draft, pr) => {
    const outside = [...draft.blockers, ...draft.niceToHaves].find(
      (finding) =>
        finding.path !== undefined && pr.filesComplete && !pr.files.includes(finding.path),
    );
    return outside === undefined
      ? null
      : {
          reason: "review_draft_invalid",
          detail: `The finding at ${outside.path} is not on a file that this PR changes.`,
        };
  },
  (draft, pr) => {
    if (draft.noise.length > 0 && !pr.filesComplete)
      return {
        reason: "review_noise_unverifiable",
        detail:
          "This PR changes more files than one read returns, so a noise claim cannot be checked.",
      };
    const unknown = draft.noise.find(
      (claim) =>
        !pr.requiredChecks.some((check) => check.name === claim.check && check.state === "failing"),
    );
    return unknown === undefined
      ? null
      : {
          reason: "review_noise_unknown_check",
          detail: `No failing required check is named ${unknown.check}.`,
        };
  },
  (draft, pr) => {
    const cited = draft.noise
      .flatMap((claim) => claim.files)
      .find((file) => pr.files.includes(file));
    return cited === undefined
      ? null
      : {
          reason: "review_noise_changed_file",
          detail: `The noise claim cites ${cited}, which this PR changes. A failure in a changed file is a blocker.`,
        };
  },
  (draft, pr) => {
    const ids = draft.threadReplies.map((reply) => reply.threadId);
    const unknown = ids.find(
      (id) => !pr.threads.some((thread) => thread.id === id && thread.startedByViewer),
    );
    if (unknown !== undefined)
      return {
        reason: "review_thread_unknown",
        detail: `Thread ${unknown} is not a review thread that this account started on the PR.`,
      };
    return new Set(ids).size === ids.length
      ? null
      : { reason: "review_draft_invalid", detail: "Reply to each thread at most once." };
  },
];

/**
 * Checks a parsed draft against the live PR and the commit that this round reviews, which is the
 * live head unless the head-move limit holds the round at the last reviewed commit. Reported
 * local checks stay claims. Required CI results are observed facts, and a failing one is a
 * blocker unless a valid noise claim covers it.
 */
export function checkDraft(
  draft: Draft,
  pr: PullRequestFacts,
  commit = pr.head,
): Result<AcceptedDraft, Refusal> {
  for (const rule of rules) {
    const refusal = rule(draft, pr, commit);
    if (refusal !== null) return refuse(refusal.reason, refusal.detail);
  }
  const noise = new Set(draft.noise.map((claim) => claim.check));
  return Ok({
    draft,
    failingChecks: pr.requiredChecks.filter(
      (check) => check.state === "failing" && !noise.has(check.name),
    ),
    pendingChecks: pr.requiredChecks.filter((check) => check.state === "pending"),
    checksComplete: pr.checksComplete,
  });
}
