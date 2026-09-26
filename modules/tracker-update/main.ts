import { GithubTracker } from "../github-tracker/main.ts";
import { ContentIdentity } from "../content-identity/main.ts";
import {
  type ClosureEvent,
  type ClosureObservation,
  type CommentMark,
  type CommentObservation,
  decide,
  judge,
  TRACKER_REASONS,
  type TrackerReason,
  type Verdict,
  type Observation,
  type Problem,
  type WriteAttemptState,
} from "./classify.ts";
import { markerOf, renderComment, type TrackerComment, type TrackerIntent } from "./content.ts";
import { readMap } from "./map.ts";
import { capabilitiesOf, TRACKER_STEPS, type TrackerStep, type TrackerTarget } from "./provider.ts";

function markOf(comment: TrackerComment): CommentMark {
  return {
    commentId: comment.commentId,
    url: comment.url,
    actor: comment.actor,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    contentIdentity: ContentIdentity.ofText(comment.body),
  };
}

/** Sorts the comments that carry one operation marker into what each one is evidence of. */
function classifyComments(request: {
  operationId: string;
  expectedActor: string;
  contentIdentity: string;
  comments: TrackerComment[];
}): Pick<CommentObservation, "exactMatches" | "editedMatches" | "actorMismatches"> {
  const exactMatches: CommentMark[] = [];
  const editedMatches: CommentMark[] = [];
  const actorMismatches: CommentMark[] = [];

  for (const comment of request.comments) {
    if (markerOf(comment.body) !== request.operationId) {
      continue;
    }

    const mark = markOf(comment);
    if (comment.actor !== request.expectedActor) {
      actorMismatches.push(mark);
    } else if (mark.contentIdentity === request.contentIdentity) {
      exactMatches.push(mark);
    } else {
      editedMatches.push(mark);
    }
  }

  return { exactMatches, editedMatches, actorMismatches };
}

/** Whether a reopen followed the most recent close, as far as the read actually saw. */
function reopenedAfterClose(request: {
  events: ClosureEvent[];
  complete: boolean;
}): "yes" | "no" | "unknown" {
  const relevant = request.events.filter(
    (one) => one.event === "closed" || one.event === "reopened",
  );
  if (relevant[relevant.length - 1]?.event === "reopened") {
    return "yes";
  }

  // What was not read cannot be reported as absent.
  return request.complete ? "no" : "unknown";
}

/** Gathers what the tracker actually shows about one step right now. */
async function observeStep(request: {
  provider: string;
  step: TrackerStep;
  target: TrackerTarget;
  operationId: string;
  expectedActor: string;
  contentIdentity: string | null;
  resourceId: string | null;
  sentWrites: number;
  now: string;
}): Promise<Observation> {
  if (request.step === "completion") {
    const issue = await GithubTracker.readIssue(request.target);
    const history = await GithubTracker.readEvents(request.target);

    const closure: ClosureObservation = {
      kind: "closure",
      read: issue.status === "found" ? "found" : issue.status === "absent" ? "absent" : "unknown",
      detail: issue.status === "unknown" ? issue.detail : null,
      state: issue.status === "found" ? issue.value.state : null,
      stateReason: issue.status === "found" ? issue.value.stateReason : null,
      closedBy: issue.status === "found" ? issue.value.closedBy : null,
      closedAt: issue.status === "found" ? issue.value.closedAt : null,
      updatedAt: issue.status === "found" ? issue.value.updatedAt : null,
      events: history.events,
      eventCoverage: history.coverage,
      reopened: reopenedAfterClose({
        events: history.events,
        complete: history.coverage.complete,
      }),
      observedAt: request.now,
    };
    return closure;
  }

  // An identity this release cannot read matches nothing, which keeps the step unverified.
  const contentIdentity = request.contentIdentity ?? "";
  const known = request.resourceId;
  // A provider with no exactly-once write can hold a second comment under one operation, so a
  // step that sent more than one write is always scanned rather than read by identifier.
  const repeatable = capabilitiesOf(request.provider)?.exactlyOnceWrites !== true;
  if (known !== null && !(repeatable && request.sentWrites > 1)) {
    const comment = await GithubTracker.readComment({
      repository: request.target.repository,
      commentId: known,
    });
    const comments = comment.status === "found" ? [comment.value] : [];
    return {
      kind: "comment",
      lookup: "known-id",
      coverage: {
        complete: comment.status !== "unknown",
        pages: comment.status === "unknown" ? 0 : 1,
        count: comments.length,
        detail: comment.status === "unknown" ? comment.detail : null,
      },
      ...classifyComments({
        operationId: request.operationId,
        expectedActor: request.expectedActor,
        contentIdentity,
        comments,
      }),
      observedAt: request.now,
    };
  }

  const scan = await GithubTracker.scanComments(request.target);
  return {
    kind: "comment",
    lookup: "scan",
    coverage: scan.coverage,
    ...classifyComments({
      operationId: request.operationId,
      expectedActor: request.expectedActor,
      contentIdentity,
      comments: scan.comments,
    }),
    observedAt: request.now,
  };
}

export const TrackerUpdate = {
  /** The steps of one tracker update, in the order the contract records them. */
  steps(): readonly TrackerStep[] {
    return TRACKER_STEPS;
  },

  /** Every reason a tracker step reports. A stored reason is read back against this list. */
  reasons(): readonly TrackerReason[] {
    return TRACKER_REASONS;
  },

  /** Whether this release implements a tracker integration for one provider. */
  supports(request: { provider: string }): boolean {
    return capabilitiesOf(request.provider) !== null;
  },

  /**
   * Fixes everything one step will write before it writes anything.
   * The expected actor is read from the provider, so a later recovery compares the recorded
   * author against the account that actually wrote, not against a name the caller supplied.
   */
  async plan(request: { provider: string; operationId: string; intent: TrackerIntent }): Promise<
    | {
        status: "planned";
        expectedActor: string;
        content: string | null;
        contentIdentity: string | null;
        closeReason: string | null;
      }
    | { status: "unsupported-provider"; provider: string }
    | { status: "capability-unavailable"; capability: string; detail: string }
    | { status: "actor-unknown"; detail: string }
  > {
    const capabilities = capabilitiesOf(request.provider);
    if (capabilities === null) {
      return { status: "unsupported-provider", provider: request.provider };
    }

    const intent = request.intent;
    if (intent.step !== "completion" && !capabilities.comments) {
      return {
        status: "capability-unavailable",
        capability: "comments",
        detail: `${request.provider} cannot add a comment that carries an operation marker.`,
      };
    }

    if (intent.step === "completion" && !capabilities.completion) {
      return {
        status: "capability-unavailable",
        capability: "completion",
        detail: `${request.provider} cannot complete a ticket with an explicit reason.`,
      };
    }

    // The account this machine writes as is recorded for every step, so a later reading compares
    // the observed author or closer against it rather than against a name the caller supplied.
    const viewer = await GithubTracker.viewer();
    if (viewer.status === "failed" && viewer.code === "github_unavailable") {
      return { status: "capability-unavailable", capability: "tracker_cli", detail: viewer.detail };
    }
    if (viewer.status !== "succeeded") {
      return {
        status: "actor-unknown",
        detail: viewer.status === "failed" ? `${viewer.code}: ${viewer.detail}` : viewer.detail,
      };
    }

    if (intent.step === "completion") {
      return {
        status: "planned",
        expectedActor: viewer.value.login,
        content: null,
        contentIdentity: null,
        closeReason: intent.reason,
      };
    }

    const content = renderComment({ operationId: request.operationId, intent });
    return {
      status: "planned",
      expectedActor: viewer.value.login,
      content,
      contentIdentity: ContentIdentity.ofText(content),
      closeReason: null,
    };
  },

  /**
   * Performs the one external effect of this step.
   * A refused request is a definite failure because the provider answered. A lost answer stays
   * uncertain: the effect may have applied, so it is settled by reading, never by writing again.
   * A tool this machine does not have requested nothing, so it is an absent capability.
   */
  async write(
    request: { provider: string; target: TrackerTarget } & (
      | { step: "completion"; closeReason: string }
      | { step: "resolution" | "map_amendment"; content: string }
    ),
  ): Promise<
    | { status: "succeeded"; resourceId: string; resourceUrl: string; response: unknown }
    | { status: "unavailable"; capability: string; detail: string }
    | { status: "failed"; code: string; detail: string }
    | { status: "uncertain"; detail: string }
  > {
    if (request.step === "completion") {
      const outcome = await GithubTracker.closeIssue({
        repository: request.target.repository,
        issue: request.target.issue,
        reason: request.closeReason,
      });
      if (outcome.status === "failed" && outcome.code === "github_unavailable") {
        return { status: "unavailable", capability: "tracker_cli", detail: outcome.detail };
      }
      return outcome.status === "succeeded"
        ? {
            status: "succeeded",
            resourceId: String(outcome.value.number),
            resourceUrl: `https://github.com/${request.target.repository}/issues/${outcome.value.number}`,
            response: outcome.value,
          }
        : outcome;
    }

    const outcome = await GithubTracker.createComment({
      repository: request.target.repository,
      issue: request.target.issue,
      body: request.content,
    });
    if (outcome.status === "failed" && outcome.code === "github_unavailable") {
      return { status: "unavailable", capability: "tracker_cli", detail: outcome.detail };
    }
    return outcome.status === "succeeded"
      ? {
          status: "succeeded",
          resourceId: outcome.value.commentId,
          resourceUrl: outcome.value.url,
          response: outcome.value,
        }
      : outcome;
  },

  /**
   * Gathers what the tracker actually shows about one step right now.
   * A known server identifier is read directly. Every other case reads every accessible comment
   * page and records its coverage, because a partial read is never evidence of absence.
   * A step with more than one sent write is always scanned, since only then can it duplicate.
   */
  async observe(request: {
    provider: string;
    step: TrackerStep;
    target: TrackerTarget;
    operationId: string;
    expectedActor: string;
    contentIdentity: string | null;
    resourceId: string | null;
    sentWrites: number;
    now: string;
  }): Promise<Observation> {
    if (request.step === "completion") {
      const issue = await GithubTracker.readIssue(request.target);
      const history = await GithubTracker.readEvents(request.target);

      const closure: ClosureObservation = {
        kind: "closure",
        read: issue.status === "found" ? "found" : issue.status === "absent" ? "absent" : "unknown",
        detail: issue.status === "unknown" ? issue.detail : null,
        state: issue.status === "found" ? issue.value.state : null,
        stateReason: issue.status === "found" ? issue.value.stateReason : null,
        closedBy: issue.status === "found" ? issue.value.closedBy : null,
        closedAt: issue.status === "found" ? issue.value.closedAt : null,
        updatedAt: issue.status === "found" ? issue.value.updatedAt : null,
        events: history.events,
        eventCoverage: history.coverage,
        reopened: reopenedAfterClose({
          events: history.events,
          complete: history.coverage.complete,
        }),
        observedAt: request.now,
      };
      return closure;
    }

    // An identity this release cannot read matches nothing, which keeps the step unverified.
    const contentIdentity = request.contentIdentity ?? "";
    const known = request.resourceId;
    // A provider with no exactly-once write can hold a second comment under one operation, so a
    // step that sent more than one write is always scanned rather than read by identifier.
    const repeatable = capabilitiesOf(request.provider)?.exactlyOnceWrites !== true;
    if (known !== null && !(repeatable && request.sentWrites > 1)) {
      const comment = await GithubTracker.readComment({
        repository: request.target.repository,
        commentId: known,
      });
      const comments = comment.status === "found" ? [comment.value] : [];
      return {
        kind: "comment",
        lookup: "known-id",
        coverage: {
          complete: comment.status !== "unknown",
          pages: comment.status === "unknown" ? 0 : 1,
          count: comments.length,
          detail: comment.status === "unknown" ? comment.detail : null,
        },
        ...classifyComments({
          operationId: request.operationId,
          expectedActor: request.expectedActor,
          contentIdentity,
          comments,
        }),
        observedAt: request.now,
      };
    }

    const scan = await GithubTracker.scanComments(request.target);
    return {
      kind: "comment",
      lookup: "scan",
      coverage: scan.coverage,
      ...classifyComments({
        operationId: request.operationId,
        expectedActor: request.expectedActor,
        contentIdentity,
        comments: scan.comments,
      }),
      observedAt: request.now,
    };
  },

  /**
   * Reads what the tracker shows about one step right now and says what that evidence means.
   * The reading and the verdict are one answer, so no caller can record an observation and
   * then decide about it under a different rule.
   * A known server identifier is read directly. Every other case reads every accessible comment
   * page and records its coverage, because a partial read is never evidence of absence.
   * A step with more than one sent write is always scanned, since only then can it duplicate.
   */
  async read(request: {
    provider: string;
    step: TrackerStep;
    target: TrackerTarget;
    operationId: string;
    expectedActor: string;
    contentIdentity: string | null;
    resourceId: string | null;
    intendedReason: string;
    writes: WriteAttemptState[];
    extra?: Problem[];
    now: string;
  }): Promise<{ observation: Observation; verdict: Verdict }> {
    const observation = await observeStep({
      ...request,
      sentWrites: request.writes.filter((state) => state !== "intended").length,
    });
    return {
      observation,
      verdict: judge({
        step: request.step,
        observation,
        intendedReason: request.intendedReason,
        writes: request.writes,
        extra: request.extra,
      }),
    };
  },
  /**
   * Reads one map as its baseline body plus every explicit amendment.
   * A session reads this before it selects map-dependent work, so an incomplete read and a
   * conflict both arrive as reasons to stop rather than as a shorter list of amendments.
   */
  async readMap(request: {
    provider: string;
    target: TrackerTarget;
  }): Promise<
    | { status: "read"; reading: ReturnType<typeof readMap>; verdict: Verdict }
    | { status: "unsupported-provider"; provider: string }
    | { status: "unreadable"; detail: string }
  > {
    if (capabilitiesOf(request.provider) === null) {
      return { status: "unsupported-provider", provider: request.provider };
    }

    const issue = await GithubTracker.readIssue(request.target);
    if (issue.status !== "found") {
      return {
        status: "unreadable",
        detail: issue.status === "absent" ? "The tracker holds no such map issue." : issue.detail,
      };
    }

    const scan = await GithubTracker.scanComments(request.target);
    const reading = readMap({
      baselineBody: issue.value.body,
      coverage: scan.coverage,
      comments: scan.comments,
    });
    return { status: "read", reading, verdict: decide(reading.problems) };
  },
};
