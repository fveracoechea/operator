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
  | "post_uncertain"
  | "round"
  | "head_moved"
  | "sync"
  | "synced"
  | "close"
  | "skip";
export type RoundTrigger = "commits" | "reply" | "resolved" | "re-request";
type Request = {
  state: string;
  launchState: string | null;
  head?: string | null;
  headMoves?: number;
  sync?: string | null;
};
export type ReviewFacts = {
  command: ReviewCommand;
  registered: boolean;
  request: Request | null;
  /** The process that holds the request's lease still runs. */
  ownerActive: boolean;
  event?: string;
  /** For `round`, the observed trigger. */
  trigger?: RoundTrigger;
  /** For `head_moved`, the head that the observer compared with the live head. */
  observedFrom?: string;
  /** This process holds the request's lease. */
  ownLease?: boolean;
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
  /** A replacement reviewer for a request whose reviewer stopped. */
  replace?: true;
  /** A new round starts with this trigger. */
  round?: "first" | RoundTrigger;
  /** The running reviewer gets the new head or round. */
  sync?: true;
  /** The request records one more head move. */
  headMoved?: true;
  /** Reviewer cleanup starts. */
  cleanup?: true;
};
type Refusal = { reason: string; detail: string };
type Rule = {
  when: (facts: ReviewFacts) => boolean;
  decide: (facts: ReviewFacts) => Result<ReviewTransition, Refusal>;
};

/** After this many head moves in one round, the round posts against its last reviewed commit. */
export const headMoveLimit = 3;

function refuse(reason: string, detail: string) {
  return Err<Refusal>({ reason, detail: `${detail} Nothing changed.` });
}

function starting({ request, ownerActive }: ReviewFacts) {
  // Stryker disable next-line OptionalChaining: equivalent: a start is checked only after the missing-request rule, or for a listed request
  return request?.launchState === "starting" && ownerActive;
}

function stopped(request: Request | null) {
  // Stryker disable next-line OptionalChaining: equivalent: a stopped reviewer is checked only after the missing-request rule, or for a listed request
  return request?.launchState === "interrupted" || request?.launchState === "failed";
}

/**
 * A new round goes to the running reviewer, waits for a replacement of a stopped one, or queues
 * when no reviewer ever started.
 */
function startRound(facts: ReviewFacts, trigger: "first" | RoundTrigger): ReviewTransition {
  // Stryker disable next-line OptionalChaining: equivalent: a round starts only for a recorded request
  const launch = facts.request?.launchState ?? null;
  if (launch === "running")
    return { state: "reviewing", round: trigger, sync: true, lease: "hold" };
  if (launch === "interrupted") return { state: "reviewing", round: trigger };
  return { state: "queued", round: trigger };
}

/**
 * Only the observer that saw the recorded head moves it, below the limit, and not while a
 * reviewer start places the worktree at the recorded head.
 */
function movable({ request, observedFrom }: ReviewFacts) {
  return (
    // Stryker disable next-line OptionalChaining: equivalent: a head move is checked only after the missing-request rule
    request?.state === "reviewing" &&
    request.launchState !== "starting" &&
    request.head === observedFrom &&
    (request.headMoves ?? 0) < headMoveLimit &&
    (request.sync ?? null) === null
  );
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

const missing: Rule = {
  when: (facts) => facts.request === null,
  decide: () => refuse("review_request_missing", "Add the review request first."),
};

/** A live start or post holds external effects, so the request cannot end under it. */
function endRules(state: "closed" | "skipped"): Rule[] {
  return [
    missing,
    {
      when: starting,
      decide: () => refuse("review_start_in_progress", "Wait until the reviewer start ends."),
    },
    {
      // Stryker disable next-line OptionalChaining: equivalent: every rule after the missing-request rule reads a recorded request
      when: (facts) => facts.ownerActive && facts.request?.state === "posting",
      decide: () =>
        refuse("review_post_in_progress", "Another process posts this review now. Wait for it."),
    },
    // A wait that moves or prompts the reviewer holds its pane and worktree.
    {
      // Stryker disable next-line OptionalChaining: equivalent: every rule after the missing-request rule reads a recorded request
      when: (facts) => facts.ownerActive && (facts.request?.sync ?? null) !== null,
      decide: () =>
        refuse(
          "review_reviewer_moving",
          "A wait moves or prompts the reviewer now. End the request after it finishes.",
        ),
    },
    { when: () => true, decide: () => Ok({ state, ended: true, cleanup: true, lease: "hold" }) },
  ];
}

/** Each command's ordered rows. The first matching row decides. */
const tables: Record<ReviewCommand, Rule[]> = {
  add: [
    ...shared,
    {
      when: (facts) => facts.request === null,
      decide: () => Ok({ insert: true, state: "queued" }),
    },
    // A renewed request reopens a watching or approved request with the same reviewer.
    {
      when: (facts) =>
        ["watching", "approved"].includes(
          // Stryker disable next-line OptionalChaining,StringLiteral: equivalent: every rule after the missing-request rule reads a recorded request
          facts.request?.state ?? "",
        ),
      decide: (facts) => Ok(startRound(facts, "re-request")),
    },
    { when: () => true, decide: () => Ok({ unchanged: true }) },
  ],
  start: [
    ...shared,
    missing,
    {
      when: starting,
      decide: () => refuse("review_start_in_progress", "Another process starts this reviewer."),
    },
    {
      // Stryker disable next-line OptionalChaining: equivalent: every rule after the missing-request rule reads a recorded request
      when: (facts) => facts.request?.state === "queued",
      decide: () => Ok({ launchState: "starting", lease: "hold" }),
    },
    // The replacement reopens the request's worktree. Its brief names the earlier rounds.
    {
      when: (facts) =>
        ["reviewing", "watching", "approved"].includes(
          // Stryker disable next-line OptionalChaining,StringLiteral: equivalent: every rule after the missing-request rule reads a recorded request
          facts.request?.state ?? "",
        ) && stopped(facts.request),
      decide: () => Ok({ launchState: "starting", lease: "hold", replace: true }),
    },
    {
      when: () => true,
      decide: () =>
        refuse(
          "review_reviewer_started",
          "This review request already has its reviewer, and the reviewer has not stopped.",
        ),
    },
  ],
  started: [
    {
      when: (facts) =>
        facts.request?.launchState === "starting" && facts.request.state === "queued",
      decide: () => Ok({ state: "reviewing", launchState: "running", lease: "release" }),
    },
    // A replacement keeps the request's state, so a watching request keeps watching.
    {
      when: (facts) => facts.request?.launchState === "starting",
      decide: () => Ok({ launchState: "running", lease: "release" }),
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
    missing,
    {
      when: starting,
      decide: () => refuse("review_start_in_progress", "Wait until the reviewer start ends."),
    },
    {
      // Stryker disable next-line OptionalChaining: equivalent: every rule after the missing-request rule reads a recorded request
      when: (facts) => facts.request?.state === "posting" && facts.ownerActive,
      decide: () =>
        refuse(
          "review_post_in_progress",
          "Another process posts this review now. Do not repeat it.",
        ),
    },
    {
      // Stryker disable next-line OptionalChaining: equivalent: every rule after the missing-request rule reads a recorded request
      when: (facts) => (facts.request?.sync ?? null) !== null && facts.ownerActive,
      decide: () =>
        refuse(
          "review_reviewer_moving",
          "A wait moves the reviewer to the new PR head now. Post after the reviewer gets it.",
        ),
    },
    // A post whose process stopped can have reached GitHub. The retry looks for it first.
    {
      // Stryker disable next-line OptionalChaining: equivalent: every rule after the missing-request rule reads a recorded request
      when: (facts) => facts.request?.state === "posting",
      decide: () => Ok({ lease: "hold", retry: true }),
    },
    {
      when: (facts) =>
        ["queued", "reviewing"].includes(
          // Stryker disable next-line OptionalChaining,StringLiteral: equivalent: every rule after the missing-request rule reads a recorded request
          facts.request?.state ?? "",
        ),
      decide: () => Ok({ state: "posting", lease: "hold" }),
    },
    {
      when: () => true,
      decide: (facts) => {
        // Stryker disable next-line OptionalChaining,StringLiteral: equivalent: every rule after the missing-request rule reads a recorded request
        const state = facts.request?.state ?? "missing";
        return refuse(
          "review_already_posted",
          `This review request is ${state}, so its review is already posted.`,
        );
      },
    },
  ],
  posted: [
    {
      when: (facts) => facts.request?.state === "posting" && facts.event === "APPROVE",
      decide: () => Ok({ state: "approved", lease: "release" }),
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
      when: (facts) =>
        ["running", "interrupted"].includes(
          // Stryker disable next-line StringLiteral: equivalent: no recorded launch state is the empty text, so a missing request matches neither state
          facts.request?.launchState ?? "",
        ),
      decide: () => Ok({ state: "reviewing", lease: "release" }),
    },
    { when: () => true, decide: () => Ok({ state: "queued", lease: "release" }) },
  ],
  post_uncertain: [{ when: () => true, decide: () => Ok({ lease: "release" }) }],
  // Another wait that already started the round leaves this one with nothing to do.
  round: [
    missing,
    // A live start places the worktree at the recorded head. The next wait sees the change.
    { when: starting, decide: () => Ok({ unchanged: true }) },
    {
      when: (facts) =>
        // Stryker disable next-line OptionalChaining: equivalent: every rule after the missing-request rule reads a recorded request
        facts.request?.state === "watching" ||
        // Stryker disable next-line OptionalChaining: equivalent: every rule after the missing-request rule reads a recorded request
        (facts.request?.state === "approved" && facts.trigger === "re-request"),
      decide: (facts) => Ok(startRound(facts, facts.trigger ?? "commits")),
    },
    { when: () => true, decide: () => Ok({ unchanged: true }) },
  ],
  head_moved: [
    missing,
    {
      // Stryker disable next-line OptionalChaining: equivalent: every rule after the missing-request rule reads a recorded request
      when: (facts) => movable(facts) && facts.request?.launchState === "running",
      decide: () => Ok({ headMoved: true, sync: true, lease: "hold" }),
    },
    // A stopped reviewer's replacement starts at the recorded new head.
    { when: movable, decide: () => Ok({ headMoved: true }) },
    { when: () => true, decide: () => Ok({ unchanged: true }) },
  ],
  // A move or prompt whose process stopped is repeated by the next wait.
  sync: [
    {
      when: (facts) => (facts.request?.sync ?? null) !== null && !facts.ownerActive,
      decide: () => Ok({ lease: "hold" }),
    },
    { when: () => true, decide: () => Ok({ unchanged: true }) },
  ],
  // Only the move's own process finishes it, and never on a request that ended meanwhile.
  synced: [
    {
      when: (facts) =>
        facts.ownLease !== true ||
        (facts.request !== null && ["closed", "skipped"].includes(facts.request.state)),
      decide: () =>
        refuse("review_lease_lost", "Another process took this review request during the move."),
    },
    { when: () => true, decide: () => Ok({ lease: "release" }) },
  ],
  close: endRules("closed"),
  skip: [...shared, ...endRules("skipped")],
};

/** One review-request transition from recorded and observed facts, with no effect. */
export function decideReview(facts: ReviewFacts): Result<ReviewTransition, Refusal> {
  const rule = tables[facts.command].find((row) => row.when(facts));
  // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent: every table ends with a rule that always matches
  return rule === undefined ? refuse("review_defect", "No rule matched.") : rule.decide(facts);
}

export type ReviewAction =
  | {
      kind: "action";
      action:
        | "start_reviewer"
        | "replace_reviewer"
        | "post_review"
        | "wait_reviews"
        | "clean_reviewer";
      reason: string;
    }
  | { kind: "attention"; reason: string }
  | { kind: "wait"; reason: string };

type Listed = Request & { cleanupState?: string | null };

function ended(request: Listed, ownerActive: boolean): ReviewAction {
  if (request.cleanupState === "kept") return { kind: "attention", reason: "reviewer_work_kept" };
  if (request.cleanupState === "pending" && ownerActive)
    return { kind: "wait", reason: "reviewer_cleanup" };
  return {
    kind: "action",
    action: "clean_reviewer",
    reason: request.cleanupState === "failed" ? "cleanup_failed" : "cleanup_pending",
  };
}

function queued(request: Listed, ownerActive: boolean): ReviewAction {
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

function reviewing(request: Listed, ownerActive: boolean): ReviewAction {
  if (request.launchState === "starting")
    return ownerActive
      ? { kind: "wait", reason: "reviewer_starting" }
      : { kind: "action", action: "replace_reviewer", reason: "launch_abandoned" };
  if (stopped(request))
    return {
      kind: "action",
      action: "replace_reviewer",
      reason: request.launchState === "failed" ? "launch_failed" : "reviewer_interrupted",
    };
  if ((request.sync ?? null) === null) return { kind: "wait", reason: "review_draft" };
  return ownerActive
    ? { kind: "wait", reason: "reviewer_moving" }
    : { kind: "action", action: "wait_reviews", reason: "reviewer_move_unfinished" };
}

const steps: Record<string, (request: Listed, ownerActive: boolean) => ReviewAction> = {
  queued,
  reviewing,
  posting: (_request, ownerActive) =>
    ownerActive
      ? { kind: "wait", reason: "review_posting" }
      : { kind: "action", action: "post_review", reason: "review_post_uncertain" },
  watching: () => ({ kind: "wait", reason: "review_watching" }),
  approved: () => ({ kind: "wait", reason: "review_approved" }),
  closed: ended,
  skipped: ended,
};

/** The applicable next step of one listed request, from its recorded state alone. */
export function reviewAction(request: Listed, ownerActive: boolean): ReviewAction {
  const step = steps[request.state];
  return step === undefined
    ? { kind: "attention", reason: "review_state_unknown" }
    : step(request, ownerActive);
}
