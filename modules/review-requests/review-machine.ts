import { Err, Ok, type Result } from "unthrown";

export type ReviewState =
  | "queued"
  | "reviewing"
  | "posting"
  | "watching"
  | "approved"
  | "closed"
  | "skipped";
export type ReviewCommand =
  | "add"
  | "start"
  | "started"
  | "start_failed"
  | "post"
  | "posted"
  | "post_failed"
  | "post_uncertain";
type Request = { state: string; launchState: string | null };
export type ReviewFacts = {
  command: ReviewCommand;
  registered: boolean;
  request: Request | null;
  /** The process that started the reviewer or posts the review still runs. */
  ownerActive: boolean;
  event?: string;
};
/** The state part of a transition. The operation adds the recorded resources and round. */
export type ReviewTransition = {
  insert?: true;
  state?: ReviewState;
  launchState?: "starting" | "running" | "failed";
  lease?: "hold" | "release";
  ended?: true;
  /** A repeated add or a retried post of a request that is already in that step. */
  unchanged?: true;
  retry?: true;
};
type Refusal = { reason: string; detail: string };
type Rule = {
  when: (facts: ReviewFacts) => boolean;
  decide: (facts: ReviewFacts) => Result<ReviewTransition, Refusal>;
};

function refuse(reason: string, detail: string) {
  return Err<Refusal>({ reason, detail: `${detail} Nothing changed.` });
}

function starting({ request, ownerActive }: ReviewFacts) {
  return request?.launchState === "starting" && ownerActive;
}

const shared: Rule[] = [
  {
    when: (facts) => !facts.registered,
    decide: () =>
      refuse(
        "review_repository_unregistered",
        "The PR repository is not a registered project on this device. Register its controlling checkout first.",
      ),
  },
];

/** Each command's ordered rows. The first matching row decides. */
const tables: Record<ReviewCommand, Rule[]> = {
  add: [
    ...shared,
    { when: (facts) => facts.request !== null, decide: () => Ok({ unchanged: true }) },
    { when: () => true, decide: () => Ok({ insert: true, state: "queued" }) },
  ],
  start: [
    ...shared,
    {
      when: (facts) => facts.request === null,
      decide: () => refuse("review_request_missing", "Add the review request first."),
    },
    {
      when: starting,
      decide: () => refuse("review_start_in_progress", "Another process starts this reviewer."),
    },
    {
      when: (facts) => facts.request?.state !== "queued",
      decide: () =>
        refuse("review_reviewer_started", "This review request already has its reviewer."),
    },
    {
      when: () => true,
      decide: () => Ok({ launchState: "starting", lease: "hold" }),
    },
  ],
  started: [
    {
      when: (facts) => facts.request?.launchState === "starting",
      decide: () => Ok({ state: "reviewing", launchState: "running", lease: "release" }),
    },
    {
      when: () => true,
      decide: () =>
        refuse("review_start_interrupted", "The reviewer start is no longer recorded as running."),
    },
  ],
  start_failed: [
    { when: () => true, decide: () => Ok({ launchState: "failed", lease: "release" }) },
  ],
  post: [
    ...shared,
    {
      when: (facts) => facts.request === null,
      decide: () => refuse("review_request_missing", "Add the review request first."),
    },
    {
      when: starting,
      decide: () => refuse("review_start_in_progress", "Wait until the reviewer start ends."),
    },
    {
      when: (facts) => facts.request?.state === "posting" && facts.ownerActive,
      decide: () =>
        refuse(
          "review_post_in_progress",
          "Another process posts this review now. Do not repeat it.",
        ),
    },
    // A post whose process stopped can have reached GitHub. The retry looks for it first.
    {
      when: (facts) => facts.request?.state === "posting",
      decide: () => Ok({ lease: "hold", retry: true }),
    },
    {
      when: (facts) => ["queued", "reviewing"].includes(facts.request?.state ?? ""),
      decide: () => Ok({ state: "posting", lease: "hold" }),
    },
    {
      when: () => true,
      decide: (facts) =>
        refuse(
          "review_already_posted",
          `This review request is ${facts.request?.state ?? "missing"}, so its review is already posted.`,
        ),
    },
  ],
  posted: [
    {
      when: (facts) => facts.request?.state === "posting" && facts.event === "APPROVE",
      decide: () => Ok({ state: "approved", ended: true, lease: "release" }),
    },
    {
      when: (facts) => facts.request?.state === "posting",
      decide: () => Ok({ state: "watching", lease: "release" }),
    },
    {
      when: () => true,
      decide: () => refuse("review_post_interrupted", "The post is no longer recorded."),
    },
  ],
  // A definite refusal returns the request to its reviewer, or to the queue when none runs.
  post_failed: [
    {
      when: (facts) => facts.request?.launchState === "running",
      decide: () => Ok({ state: "reviewing", lease: "release" }),
    },
    { when: () => true, decide: () => Ok({ state: "queued", lease: "release" }) },
  ],
  post_uncertain: [{ when: () => true, decide: () => Ok({ lease: "release" }) }],
};

/** One review-request transition from recorded and observed facts, with no effect. */
export function decideReview(facts: ReviewFacts): Result<ReviewTransition, Refusal> {
  const rule = tables[facts.command].find((row) => row.when(facts));
  return rule === undefined ? refuse("review_defect", "No rule matched.") : rule.decide(facts);
}

export type ReviewAction =
  | { kind: "action"; action: "start_reviewer" | "post_review"; reason: string }
  | { kind: "wait"; reason: string };

/** The applicable next step of one active request, from its recorded state alone. */
export function reviewAction(request: Request, ownerActive: boolean): ReviewAction {
  if (request.state === "queued") {
    if (request.launchState === "starting")
      return ownerActive
        ? { kind: "wait", reason: "reviewer_starting" }
        : { kind: "action", action: "start_reviewer", reason: "launch_abandoned" };
    return {
      kind: "action",
      action: "start_reviewer",
      reason: request.launchState === "failed" ? "launch_failed" : "review_queued",
    };
  }
  if (request.state === "posting")
    return ownerActive
      ? { kind: "wait", reason: "review_posting" }
      : { kind: "action", action: "post_review", reason: "review_post_uncertain" };
  return {
    kind: "wait",
    reason: request.state === "reviewing" ? "review_draft" : "review_watching",
  };
}
