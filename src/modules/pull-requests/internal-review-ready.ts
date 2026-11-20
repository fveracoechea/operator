import { ErrAsync, OkAsync, fromPromise, type AsyncOkOf, type AsyncResult } from "unthrown";
import { DeviceSettings } from "../device-settings/main.ts";
import { DeviceState } from "../device-state/main.ts";
import { Projects } from "../projects/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { markReady, postComment, readyFacts, updateComment } from "./github.ts";
import { decideInternalReview } from "./internal-review-machine.ts";
import { startHandoff, worktreeFacts } from "./internal-review.ts";
import type { ResultContext } from "../../lib/cli-result.ts";
import { readSummary, type Disposition } from "./internal-review-summary.ts";
import { qualify, resolveOwner, type Owner, type Paths } from "./owner.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { readTextInput } from "../../lib/read-text-input.ts";

type Failure = ResultContext & { reason: string; detail: string };
type Source = NonNullable<AsyncOkOf<ReturnType<typeof WorkSources.show>>>;
type Finding = Source["internalReviewRounds"][number]["findings"][number];

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
    : // Stryker disable next-line ObjectLiteral: equivalent: refusal is called only after fixed ready event did not return ready, or fixed skip event did not return skip OR missing snapshot/facts. ready event returns ready or refused exhaustively. skip event returns skip only when review is recorded and open facts exist, so the additional missing-record/facts guards cannot send skip to refusal. The unexpected decision fallback cannot occur under these fixed event rules.
      {
        // Stryker disable next-line StringLiteral: equivalent: refusal is called only after fixed ready event did not return ready, or fixed skip event did not return skip OR missing snapshot/facts. ready event returns ready or refused exhaustively. skip event returns skip only when review is recorded and open facts exist, so the additional missing-record/facts guards cannot send skip to refusal. The unexpected decision fallback cannot occur under these fixed event rules.
        reason: "internal_review_defect",
        // Stryker disable next-line StringLiteral: equivalent: refusal is called only after fixed ready event did not return ready, or fixed skip event did not return skip OR missing snapshot/facts. ready event returns ready or refused exhaustively. skip event returns skip only when review is recorded and open facts exist, so the additional missing-record/facts guards cannot send skip to refusal. The unexpected decision fallback cannot occur under these fixed event rules.
        detail: `The ${event} event decided nothing.`,
        // Stryker disable next-line ObjectLiteral: equivalent: refusal is called only after fixed ready event did not return ready, or fixed skip event did not return skip OR missing snapshot/facts. ready event returns ready or refused exhaustively. skip event returns skip only when review is recorded and open facts exist, so the additional missing-record/facts guards cannot send skip to refusal. The unexpected decision fallback cannot occur under these fixed event rules.
        next: {
          // Stryker disable next-line StringLiteral: equivalent: refusal is called only after fixed ready event did not return ready, or fixed skip event did not return skip OR missing snapshot/facts. ready event returns ready or refused exhaustively. skip event returns skip only when review is recorded and open facts exist, so the additional missing-record/facts guards cannot send skip to refusal. The unexpected decision fallback cannot occur under these fixed event rules.
          decider: "super-agent",
          // Stryker disable next-line StringLiteral: equivalent: refusal is called only after fixed ready event did not return ready, or fixed skip event did not return skip OR missing snapshot/facts. ready event returns ready or refused exhaustively. skip event returns skip only when review is recorded and open facts exist, so the additional missing-record/facts guards cannot send skip to refusal. The unexpected decision fallback cannot occur under these fixed event rules.
          question: "How should the unexpected ready decision be investigated?",
        },
      };
}

/** The assignment reviewer starts at the ready transition when device settings enable it. */
function queueReview(paths: Paths) {
  return DeviceSettings.show(paths).map(
    (settings) => settings.data.config.review?.assignments === true,
  );
}

function readNote(file: string | undefined) {
  return fromPromise(
    () => (file === undefined ? Promise.resolve(null) : readTextInput(file)),
    qualify,
  ).flatMap((note) =>
    note !== null && note.trimEnd().split(/\r\n?|\n/).length > 60
      ? ErrAsync({
          reason: "pr_note_invalid",
          detail: "A reviewer note has at most 60 lines. Nothing was changed.",
          next: { command: "operator pr ready --note <file|->", why: "Shorten the handoff note." },
        })
      : OkAsync(note),
  );
}

function readySummary(file: string | undefined, skipped: boolean) {
  if (skipped) return OkAsync({ overview: "", dispositions: [] as Disposition[] });
  return file === undefined
    ? ErrAsync({
        reason: "internal_review_summary_invalid",
        detail: "A reviewed PR needs --file <path|->. Nothing was changed.",
        next: {
          command: "operator pr ready --file <path|->",
          why: "Supply the review overview and complete dispositions.",
        },
      })
    : readSummary(file);
}

async function removeNote(saved: string) {
  const cleanup = await fromPromise(() => Bun.file(saved).delete(), qualify);
  if (cleanup.tag !== "Ok")
    console.error("pr_note_cleanup_failed", {
      file: saved,
      secondary: cleanup.tag === "Err" ? cleanup.error : cleanup.cause,
    });
}

/** Stage before public effects; filesystem cleanup never replaces the primary outcome. */
function withReadyNote(
  paths: Paths,
  owner: Owner,
  note: string | null,
  effect: (saved: string | null) => AsyncResult<AsyncOkOf<ReturnType<typeof recordReady>>, Failure>,
) {
  return fromPromise(async () => {
    const files = OperatorHome.assignmentFiles(paths, {
      repository: owner.repository,
      sourceId: owner.sourceId,
      assignment: owner.assignment,
    });
    const saved = note === null ? null : `${files.directory}/ready-${crypto.randomUUID()}.md`;
    const copied = await fromPromise(
      () =>
        saved === null ? Promise.resolve(0) : Bun.write(saved, note ?? "", { createPath: true }),
      qualify,
    );
    const result = await copied
      .toAsync()
      .flatMap(() =>
        fromPromise(async () => await effect(saved), qualify).flatMap((result) => result),
      );
    if (saved !== null && (result.tag !== "Ok" || !result.value.changed)) await removeNote(saved);
    return result;
  }, qualify).flatMap((result) => result);
}

function recordReady(
  input: { paths: Paths },
  owner: Owner,
  saved: string | null,
  end: {
    state: "ready" | "skipped";
    readyHead: string;
    commentId: string | null;
    commentUrl: string | null;
  },
  dispositions: Disposition[],
  queue: boolean,
) {
  return DeviceState.endInternalReview(
    input.paths,
    { sourceId: owner.sourceId, assignment: owner.assignment, launchId: owner.launchId },
    {
      ...end,
      readiness: { head: end.readyHead, at: new Date().toISOString(), note: saved, dispositions },
    },
    queue,
  )
    .map((recorded) => ({
      ...recorded,
      comment: end.commentId === null ? null : { id: end.commentId, url: end.commentUrl },
      assignmentReview: queue ? "queued" : null,
    }))
    .toAsync();
}

/** A retry finds earlier outward effects; only a new durable transition starts a handoff. */
export function ready(input: { paths: Paths; cwd: string; file?: string; note?: string }) {
  return resolveOwner(input).flatMap((owner) =>
    readNote(input.note)
      .flatMap((note) =>
        (input.file === undefined ? OkAsync(null) : readSummary(input.file)).map((summary) => ({
          note,
          summary,
        })),
      )
      .flatMap(({ note, summary: parsedSummary }) =>
        WorkSources.show({ paths: input.paths, cwd: owner.checkout, sourceId: owner.sourceId })
          .map((source) => reviewOf(source, owner.assignment))
          .flatMap(({ review, rounds }): AsyncResult<{ reason: string; data: object }, Failure> => {
            const number = owner.pullRequest;
            if (review === undefined || number === null)
              return ErrAsync({
                reason: "internal_review_not_recorded",
                next: {
                  command: "operator next",
                  why: "Read the assignment's recorded review state before continuing.",
                },
                state: {
                  internalReview: review === undefined ? null : review.state,
                  pullRequest: number,
                },
                detail: `Assignment ${owner.assignment} has no internal review. Nothing was changed.`,
              });
            const marker = commentMarker(owner.sourceId, owner.assignment);
            return (
              review.state === "skipped"
                ? readySummary(undefined, true)
                : parsedSummary === null
                  ? readySummary(undefined, false)
                  : OkAsync(parsedSummary)
            ).flatMap((summary) =>
              worktreeFacts(owner.worktreePath).flatMap(({ changed, localHead }) =>
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
                    readyRecorded: owner.readiness !== null,
                    review: { state: review.state, rounds },
                    implementer: owner.implementerLaunchId === owner.launchId,
                    dispositions: summary.dispositions,
                    changed,
                    localHead,
                    pr,
                    posted:
                      pr.posted === null ? "none" : pr.posted.body === body ? "current" : "stale",
                  });
                  if (decision.result !== "ready") return ErrAsync(refusal(decision, "ready"));
                  return withReadyNote(input.paths, owner, note, (saved) => {
                    const earlier = pr.posted;
                    const comment =
                      decision.comment === "none"
                        ? OkAsync(null)
                        : decision.comment === "post" || earlier === null
                          ? postComment(owner.repository, number, body)
                          : (decision.comment === "update"
                              ? updateComment(earlier.id, body)
                              : OkAsync(undefined)
                            ).map(() => ({ id: earlier.id, url: earlier.url }));
                    return comment.flatMap((posted) =>
                      (decision.markReady ? markReady(pr.id) : OkAsync(undefined)).flatMap(() =>
                        queueReview(input.paths).flatMap((queue) =>
                          recordReady(
                            input,
                            owner,
                            saved,
                            {
                              state: review.state === "skipped" ? "skipped" : "ready",
                              readyHead: decision.head,
                              commentId: posted?.id ?? null,
                              commentUrl: posted?.url ?? null,
                            },
                            summary.dispositions,
                            queue,
                          ),
                        ),
                      ),
                    );
                  })
                    .flatMap((recorded) =>
                      (recorded.changed ? startHandoff(input.paths, owner) : OkAsync(null)).map(
                        () => recorded,
                      ),
                    )
                    .map((recorded) => ({
                      reason: recorded.changed ? "pr_ready" : "pr_ready_unchanged",
                      data: {
                        sourceId: owner.sourceId,
                        assignment: owner.assignment,
                        number,
                        head: decision.head,
                        internalReview: {
                          state: review.state === "skipped" ? "skipped" : "ready",
                          rounds: rounds.length,
                        },
                        comment: recorded.comment,
                        assignmentReview: recorded.assignmentReview,
                      },
                    }));
                }),
              ),
            );
          }),
      ),
  );
}

/**
 * Ends a running internal review on the person's instruction, which the SuperAgent attests from
 * the controlling checkout. It leaves readiness and ownership to the reviewer's guarded ready.
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
        return DeviceState.endInternalReview(
          input.paths,
          { sourceId: input.sourceId, assignment: input.assignment, launchId: null },
          { state: "skipped", readyHead: null, commentId: null, commentUrl: null },
          false,
        ).map(({ changed }) => ({
          reason: changed ? "internal_review_skipped" : "internal_review_unchanged",
          next: {
            command: "operator pr ready",
            why: "The live reviewer must run the guarded ready transition.",
          },
          data: {
            sourceId: input.sourceId,
            assignment: input.assignment,
            number: recorded.number,
            head: decision.head,
            internalReview: { state: "skipped" },
            assignmentReview: null,
          },
        }));
      });
    }),
  );
}
