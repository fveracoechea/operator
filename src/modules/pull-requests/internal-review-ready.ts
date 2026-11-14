import {
  ErrAsync,
  OkAsync,
  fromPromise,
  fromThrowable,
  type AsyncOkOf,
  type AsyncResult,
} from "unthrown";
import { z } from "zod";
import { DeviceSettings } from "../device-settings/main.ts";
import { DeviceState } from "../device-state/main.ts";
import { Projects } from "../projects/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { markReady, postComment, readyFacts, updateComment } from "./github.ts";
import { decideInternalReview } from "./internal-review-machine.ts";
import { worktreeFacts } from "./internal-review.ts";
import { qualify, resolveOwner, type Paths } from "./owner.ts";
import type { ResultContext } from "../../lib/cli-result.ts";

type Failure = ResultContext & { reason: string; detail: string };
type Source = NonNullable<AsyncOkOf<ReturnType<typeof WorkSources.show>>>;
type Finding = Source["internalReviewRounds"][number]["findings"][number];
type Disposition = z.infer<typeof dispositionSchema>;

const place = { round: z.number().int().positive(), finding: z.number().int().positive() };
const dispositionSchema = z.discriminatedUnion("disposition", [
  z.strictObject({ ...place, disposition: z.literal("applied") }),
  z.strictObject({
    ...place,
    disposition: z.literal("declined"),
    reason: z.string().trim().min(1),
  }),
]);
const summarySchema = z.strictObject({
  overview: z.string().trim().min(1),
  dispositions: z.array(dispositionSchema),
});

/** Validates the reviewer's summary: a short overview and one disposition for each finding. */
function parseSummary(text: string) {
  return fromThrowable(
    () => summarySchema.parse(JSON.parse(text)),
    (cause, defect) =>
      cause instanceof z.ZodError || cause instanceof SyntaxError
        ? {
            reason: "internal_review_summary_invalid",
            detail: `The summary file must hold JSON {"overview": "...", "dispositions": [...]}, where each disposition has round, finding, and disposition applied, or disposition declined with a reason. ${cause instanceof z.ZodError ? z.prettifyError(cause).replaceAll("\n", " ") : cause.message} Nothing was changed.`,
          }
        : defect(cause),
  )();
}

/** The hidden line that finds this review's comment again after a lost answer. */
function commentMarker(sourceId: string, assignment: string) {
  return `<!-- operator-internal-review ${sourceId}/${assignment} -->`;
}

function oneLine(text: string) {
  return text.trim().replaceAll(/\s*\n\s*/g, " ");
}

function findingLine(finding: Finding, disposition: Disposition) {
  const line = `- **${finding.axis}**, ${finding.severity}, \`${oneLine(finding.location)}\`: ${oneLine(finding.claim)}`;
  return disposition.disposition === "declined"
    ? `${line}\n  Declined: ${oneLine(disposition.reason)}`
    : line;
}

/**
 * The one summary comment. The reviewer writes the overview, and the CLI renders one line for
 * each recorded finding with its axis, severity, and disposition, so none can drop out.
 */
function renderSummary(input: {
  marker: string;
  head: string;
  overview: string;
  rounds: { findings: Finding[] }[];
  dispositions: Disposition[];
}) {
  const decided = input.rounds.flatMap((round, index) =>
    round.findings.flatMap((finding, position) =>
      input.dispositions
        .filter((item) => item.round === index + 1 && item.finding === position + 1)
        .map((item) => ({ finding, item })),
    ),
  );
  function section(kind: Disposition["disposition"]) {
    const lines = decided
      .filter(({ item }) => item.disposition === kind)
      .map(({ finding, item }) => findingLine(finding, item));
    return lines.length === 0 ? "- None." : lines.join("\n");
  }
  const count = input.rounds.length === 1 ? "1 round" : `${input.rounds.length} rounds`;
  return `**Internal review**: ${count}, at \`${input.head}\`.

${input.overview.trim()}

**Applied**

${section("applied")}

**Declined**

${section("declined")}

${input.marker}
`;
}

function readSummary(file: string) {
  return fromPromise(() => Bun.file(file).text(), qualify).flatMap((text) =>
    parseSummary(text).toAsync(),
  );
}

function reviewOf(source: Source | undefined, assignment: string) {
  const review = source?.internalReviews.find((row) => row.assignment === assignment);
  const rounds =
    source?.internalReviewRounds.filter((round) => round.assignment === assignment) ?? [];
  return { review, rounds };
}

function refusal(decision: ReturnType<typeof decideInternalReview>, event: string): Failure {
  return decision.result === "refused"
    ? {
        reason: decision.reason,
        detail: decision.detail,
        next: decision.next,
        state: decision.state,
      }
    : { reason: "internal_review_defect", detail: `The ${event} event decided nothing.` };
}

/** The assignment reviewer starts at the ready transition when device settings enable it. */
function queueReview(paths: Paths) {
  return DeviceSettings.show(paths).map(
    (settings) => settings.data.config.review?.assignments === true,
  );
}

/**
 * The reviewer's ready step. It checks the rounds and the dispositions, posts one summary
 * comment, marks the PR ready, and records the ready head. A retry finds an earlier comment by
 * its marker and a PR that already left draft, so it repeats neither effect.
 */
export function ready(input: { paths: Paths; cwd: string; file: string }) {
  return resolveOwner(input).flatMap((owner) =>
    readSummary(input.file).flatMap((summary) =>
      WorkSources.show({ paths: input.paths, cwd: owner.checkout, sourceId: owner.sourceId })
        .map((source) => reviewOf(source, owner.assignment))
        .flatMap(({ review, rounds }): AsyncResult<{ reason: string; data: object }, Failure> => {
          const number = owner.pullRequest;
          if (review === undefined || number === null)
            return ErrAsync({
              reason: "internal_review_not_recorded",
              detail: `Assignment ${owner.assignment} has no internal review. Nothing was changed.`,
            });
          const marker = commentMarker(owner.sourceId, owner.assignment);
          return worktreeFacts(owner.worktreePath).flatMap(({ changed, localHead }) =>
            readyFacts(owner.repository, number, marker).flatMap((pr) => {
              const body = renderSummary({
                marker,
                head: pr.head,
                overview: summary.overview,
                rounds,
                dispositions: summary.dispositions,
              });
              const decision = decideInternalReview({
                event: "ready",
                review: { state: review.state, rounds },
                implementer: owner.implementerLaunchId === owner.launchId,
                dispositions: summary.dispositions,
                changed,
                localHead,
                pr,
                posted: pr.posted === null ? "none" : pr.posted.body === body ? "current" : "stale",
              });
              if (decision.result !== "ready") return ErrAsync(refusal(decision, "ready"));
              const earlier = pr.posted;
              const comment =
                decision.comment === "post" || earlier === null
                  ? postComment(owner.repository, number, body)
                  : (decision.comment === "update"
                      ? updateComment(earlier.id, body)
                      : OkAsync(undefined)
                    ).map(() => ({ id: earlier.id, url: earlier.url }));
              return comment.flatMap((posted) =>
                (decision.markReady ? markReady(pr.id) : OkAsync(undefined)).flatMap(() =>
                  queueReview(input.paths).flatMap((queue) =>
                    DeviceState.endInternalReview(
                      input.paths,
                      {
                        sourceId: owner.sourceId,
                        assignment: owner.assignment,
                        launchId: owner.launchId,
                      },
                      {
                        state: "ready",
                        readyHead: decision.head,
                        commentId: posted.id,
                        commentUrl: posted.url,
                      },
                      queue,
                    ).map(({ changed: recorded }) => ({
                      reason: recorded ? "pr_ready" : "pr_ready_unchanged",
                      data: {
                        sourceId: owner.sourceId,
                        assignment: owner.assignment,
                        number,
                        head: decision.head,
                        internalReview: { state: "ready", rounds: rounds.length },
                        comment: posted,
                        assignmentReview: queue ? "queued" : null,
                      },
                    })),
                  ),
                ),
              );
            }),
          );
        }),
    ),
  );
}

/**
 * Ends a running internal review on the person's instruction, which the SuperAgent attests from
 * the controlling checkout. It marks a draft ready and posts no comment. The running reviewer
 * keeps the PR as its owner.
 */
export function skip(input: {
  paths: Paths;
  cwd: string;
  sourceId: string;
  assignment: string;
  personInstructed: boolean;
}) {
  return Projects.current(input).flatMap(({ data: project }) =>
    WorkSources.show({
      paths: input.paths,
      cwd: project.checkout,
      sourceId: input.sourceId,
    }).flatMap((source): AsyncResult<{ reason: string; data: object }, Failure> => {
      if (source === undefined)
        return ErrAsync({
          reason: "source_not_found",
          next: {
            command: "operator next",
            why: "Read the available sources before choosing a source.",
          },
          state: { sourceExists: false },
          detail: `Source ${input.sourceId} does not exist in this project. Nothing was changed.`,
        });
      const { review } = reviewOf(source, input.assignment);
      const recorded = source.pullRequests.find((row) => row.assignment === input.assignment);
      // GitHub is read only for a skip that the local facts permit.
      const pr =
        input.personInstructed && review?.state === "reviewing" && recorded !== undefined
          ? readyFacts(
              project.repository,
              recorded.number,
              commentMarker(input.sourceId, input.assignment),
            )
          : OkAsync(null);
      return pr.flatMap((facts) => {
        const decision = decideInternalReview({
          event: "skip",
          personInstructed: input.personInstructed,
          review: review?.state ?? null,
          pr: facts,
        });
        if (decision.result !== "skip" || facts === null || recorded === undefined)
          return ErrAsync(refusal(decision, "skip"));
        return (decision.markReady ? markReady(facts.id) : OkAsync(undefined)).flatMap(() =>
          queueReview(input.paths).flatMap((queue) =>
            DeviceState.endInternalReview(
              input.paths,
              { sourceId: input.sourceId, assignment: input.assignment, launchId: null },
              { state: "skipped", readyHead: decision.head, commentId: null, commentUrl: null },
              queue,
            ).map(({ changed }) => ({
              reason: changed ? "internal_review_skipped" : "internal_review_unchanged",
              data: {
                sourceId: input.sourceId,
                assignment: input.assignment,
                number: recorded.number,
                head: decision.head,
                internalReview: { state: "skipped" },
                assignmentReview: queue ? "queued" : null,
              },
            })),
          ),
        );
      });
    }),
  );
}
