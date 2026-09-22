// Bun has no path manipulation API.
import { basename, dirname } from "node:path";
import { ContentIdentity } from "../content-identity/main.ts";
import {
  type ReviewBrief,
  reviewInputPath,
  reviewProtocolSection,
  submittedResultSection,
} from "./review-brief.ts";

export type Brief = {
  assignmentId: string;
  attemptId: string;
  sourceId: string;
  sourceKey: string;
  sourceRevision: string;
  title: string;
  kind: string;
  approvedScope: string;
  acceptanceRequirements: string[];
  permissions: { writePaths: string[]; allowedCommands: string[]; network: boolean };
  fixedInputs: Array<{
    name: string;
    kind: string;
    value: string;
    contentIdentity: string | null;
  }>;
  // Present only on a review assignment, which reads a fixed result instead of producing one.
  review: ReviewBrief | null;
};

export type Snapshot = {
  selection: {
    crew: { host: string | null; model: string | null };
  };
  release: { version: string; identity: string };
  lock: { name: string | null; state: string; identity: string | null; path: string | null };
  skills: { identity: string };
};

export type DispatchPlan = {
  assignmentId: string;
  attemptId: string;
  baseCommit: string;
  branch: string;
  worktreePath: string;
  agentName: string;
  agentKind: string;
  agentHost: string;
  briefPath: string;
  briefText: string;
  briefIdentity: string;
  promptText: string;
  promptIdentity: string;
  snapshotIdentity: string;
  // The fixed copies this launch carries into the worktree, beyond the common release inputs.
  extraInputs: Array<{ path: string; sourcePath: string; identity: string }>;
  // A skill this launch needs the checkout to already hold, which Operator does not install.
  requiredSkill: string | null;
};

// The recorded host names stay full; Herdr names the executable it starts.
const agentKindByHost = { "claude-code": "claude", opencode: "opencode" } as const;

/** Everything a launch writes into a worktree lives under this root. */
export const LOCAL_ROOT = ".operator/";

/** The upstream skill a reviewer loads. Operator does not own it, so it is located, not copied. */
export const REVIEW_SKILL = "code-review";

export const BRIEF_PATH = ".operator/local/brief.md";
export const REFERENCE_PATH = ".operator/local/attempt.json";
export const RELEASE_PATH = ".operator/local/release.json";

/** True when this release knows which executable Herdr starts for that host. */
export function hasAgentKind(host: string | null): host is keyof typeof agentKindByHost {
  return host !== null && Object.hasOwn(agentKindByHost, host);
}

/** Herdr names an agent `[a-z][a-z0-9_-]{0,31}`, so the attempt contributes a short suffix. */
function shortId(attemptId: string): string {
  return attemptId.replaceAll(/[^a-z0-9]/g, "").slice(0, 8);
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-+|-+$/g, "")
      .slice(0, 24) || "work"
  );
}

/**
 * How any launched agent raises a question.
 * Work it cannot do inside its authority limits is a question, never its own decision, so this
 * reaches a producer and a reviewer alike.
 */
function questionSection(brief: Brief): string[] {
  return [
    "## Questions",
    "",
    "Work you cannot do inside these limits is a question, never your own decision:",
    "",
    "```",
    `operator question raise --request <a new identity you generate> --attempt ${brief.attemptId} --input <path> --json`,
    "```",
    "",
    "The report states the question, its evidence, its options, your recommendation, the scope that waits, and the work you continue meanwhile.",
    "Only that scope waits, so keep the independent work moving.",
    "Acknowledge the answer you receive before you act on it:",
    "",
    "```",
    "operator question acknowledge --request <a new identity you generate> --question <id> --json",
    "```",
    "",
    "An answer never widens the authority limits above.",
    "",
  ];
}

/** The reporting protocol of an Operative that produces a result. */
function productionProtocolSection(brief: Brief): string[] {
  return [
    "## Reporting protocol",
    "",
    "Acknowledge this assignment before you change any file:",
    "",
    "```",
    `operator attempt acknowledge --request <a new identity you generate> --attempt ${brief.attemptId} --json`,
    "```",
    "",
    "Run it from this worktree.",
    "The Operator treats you as started only after that acknowledgement.",
    "Report progress, questions, and results through the Operator CLI, never through terminal text alone.",
    "",
    "Hand over your finished result for review:",
    "",
    "```",
    `operator attempt submit --request <a new identity you generate> --attempt ${brief.attemptId} --input <path> --json`,
    "```",
    "",
    "A submission is a handoff to a separate review, never accepted completion.",
    "",
    ...questionSection(brief),
  ];
}

/** The sections that differ between producing a result and reviewing one. */
function roleSections(brief: Brief): { result: string[]; protocol: string[] } {
  return brief.review === null
    ? { result: [], protocol: productionProtocolSection(brief) }
    : {
        result: submittedResultSection(brief.review),
        protocol: [...reviewProtocolSection(brief.review), ...questionSection(brief)],
      };
}

function briefDocument(request: {
  brief: Brief;
  snapshot: Snapshot;
  worktreePath: string;
  branch: string;
  baseCommit: string;
  controllingCheckout: string;
}): string {
  const { brief, snapshot } = request;
  const role = roleSections(brief);

  return [
    `# Operative brief for attempt ${brief.attemptId}`,
    "",
    "## Identity",
    "",
    `- Assignment: ${brief.assignmentId}`,
    `- Attempt: ${brief.attemptId}`,
    `- Source: ${brief.sourceId} item ${brief.sourceKey} at revision ${brief.sourceRevision}`,
    `- Assignment kind: ${brief.kind}`,
    `- Controlling checkout: ${request.controllingCheckout}`,
    `- Worktree: ${request.worktreePath}`,
    `- Branch: ${request.branch} from commit ${request.baseCommit}`,
    "",
    "## Approved scope",
    "",
    brief.title,
    "",
    brief.approvedScope,
    "",
    "## Acceptance requirements",
    "",
    ...brief.acceptanceRequirements.map((one) => `- ${one}`),
    "",
    "## Authority limits",
    "",
    "Write only inside these paths:",
    ...brief.permissions.writePaths.map((one) => `- ${one}`),
    "",
    "Run only these commands:",
    ...brief.permissions.allowedCommands.map((one) => `- ${one}`),
    "",
    `Network access: ${brief.permissions.network ? "permitted" : "not permitted"}.`,
    "",
    "Work outside these limits needs a question to the Operator, never your own decision.",
    "",
    ...role.result,
    "## Fixed inputs",
    "",
    ...(brief.fixedInputs.length === 0
      ? ["This assignment fixes no inputs."]
      : brief.fixedInputs.map(
          (one) =>
            `- ${one.name} (${one.kind}): ${one.value}${
              one.contentIdentity === null ? "" : ` [${one.contentIdentity}]`
            }`,
        )),
    "",
    "These inputs are fixed at dispatch. A later change to their source does not change them.",
    "",
    "## Effective configuration",
    "",
    `- Crew host: ${snapshot.selection.crew.host ?? "unnamed"}`,
    `- Crew model: ${snapshot.selection.crew.model ?? "host default"}`,
    `- Operator release: ${snapshot.release.version} (${snapshot.release.identity})`,
    `- Lock data: ${snapshot.lock.name ?? "none"} (${snapshot.lock.identity ?? "none"})`,
    `- Skills: ${snapshot.skills.identity}`,
    "",
    ...role.protocol,
  ].join("\n");
}

function promptDocument(brief: Brief): string {
  const read = `Read ${BRIEF_PATH} in this worktree first. It carries your scope, authority limits, and reporting protocol.`;
  const acknowledge = `Then acknowledge the assignment with: operator attempt acknowledge --request <a new identity you generate> --attempt ${brief.attemptId} --json`;

  return (
    brief.review === null
      ? [
          `You are the Operative on Operator attempt ${brief.attemptId} for assignment ${brief.assignmentId}.`,
          read,
          acknowledge,
          "Do not change any file before that acknowledgement succeeds.",
        ]
      : [
          `You are the reviewer on Operator attempt ${brief.attemptId} for review ${brief.review.reviewId}.`,
          read,
          "Load the `code-review` skill and run its Standards and Spec axes as parallel sub-agents of this host.",
          acknowledge,
          "Never edit, commit, or rework the result you review.",
        ]
  ).join("\n");
}

/**
 * Names every input of one launch before any external effect happens.
 * The plan is a pure function of the assignment, the snapshot, and the named commit, so an
 * interrupted dispatch recomputes the same branch, checkout, agent, brief, and prompt.
 */
export function planDispatch(request: {
  projectRoot: string;
  brief: Brief;
  snapshot: Snapshot;
  baseCommit: string;
  branch: string | null;
  worktreePath: string | null;
  agentHost: string;
  agentKind: string;
}): DispatchPlan {
  const short = shortId(request.brief.attemptId);
  const branch = request.branch ?? `operator/${slug(request.brief.sourceKey)}-${short}`;
  const worktreePath =
    request.worktreePath ??
    `${dirname(request.projectRoot)}/${basename(request.projectRoot)}-operative-${short}`;

  const briefText = briefDocument({
    brief: request.brief,
    snapshot: request.snapshot,
    worktreePath,
    branch,
    baseCommit: request.baseCommit,
    controllingCheckout: request.projectRoot,
  });
  const briefIdentity = ContentIdentity.ofText(briefText);
  const promptText = promptDocument(request.brief);

  const review = request.brief.review;
  const extraInputs = (review?.artifacts ?? []).flatMap((artifact) => {
    const path = reviewInputPath(artifact);
    return artifact.storedPath === null || path === null
      ? []
      : [
          {
            path,
            sourcePath: `${request.projectRoot}/${artifact.storedPath}`,
            identity: artifact.contentIdentity,
          },
        ];
  });

  return {
    assignmentId: request.brief.assignmentId,
    attemptId: request.brief.attemptId,
    baseCommit: request.baseCommit,
    branch,
    worktreePath,
    agentName: `operative-${short}`,
    agentKind: request.agentKind,
    agentHost: request.agentHost,
    briefPath: BRIEF_PATH,
    briefText,
    briefIdentity,
    promptText,
    // Delivery identity covers the brief the prompt points at, so a changed brief is a new prompt.
    promptIdentity: ContentIdentity.of({ promptText, briefIdentity }),
    snapshotIdentity: ContentIdentity.of(request.snapshot),
    extraInputs,
    // A reviewer that cannot load the review skill is blocked before any agent starts.
    requiredSkill: review === null ? null : REVIEW_SKILL,
  };
}

export function agentKindFor(host: string): string {
  return hasAgentKind(host) ? agentKindByHost[host] : host;
}
