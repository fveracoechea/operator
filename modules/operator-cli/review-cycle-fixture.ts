import { ContentIdentity } from "../content-identity/main.ts";
import {
  headCommit,
  requestId as request,
  runJson,
  stopFakeAgents,
  type Workspace as Fixture,
  type Workspaces,
} from "./workspace-fixture.ts";

export type Host = "claude-code" | "opencode";

export type Workspace = Fixture & { host: Host };

export const REQUIREMENTS = ["The quality gate passes."];
export const REQUIREMENTS_IDENTITY = ContentIdentity.of(REQUIREMENTS);

// Operator installs only the skills it owns, so the review skill lives in the checkout itself.
const SKILL_PATH: Record<Host, string> = {
  "claude-code": ".claude/skills/code-review/SKILL.md",
  opencode: ".agents/skills/code-review/SKILL.md",
};

export async function makeReviewWorkspace(
  fixtures: Workspaces,
  options: { host?: Host; maxActiveAgents?: number; reviewSkill?: boolean } = {},
): Promise<Workspace> {
  const host = options.host ?? "claude-code";
  const fixture = await fixtures.make({
    config: {
      crew: {
        host,
        ...(options.maxActiveAgents === undefined
          ? {}
          : { maxActiveAgents: options.maxActiveAgents }),
      },
    },
    files:
      options.reviewSkill === false ? {} : { [SKILL_PATH[host]]: "---\nname: code-review\n---\n" },
  });

  return { ...fixture, host };
}

export async function writeInput(workspace: Workspace, value: unknown): Promise<string> {
  const path = `${workspace.root}/input-${crypto.randomUUID()}.json`;
  await Bun.write(path, JSON.stringify(value));
  return path;
}

/** One production assignment, claimed, dispatched into its own worktree, and acknowledged. */
export async function startProducer(workspace: Workspace) {
  const owned = await runJson(workspace, [
    "crew",
    "own",
    "--request",
    request(),
    "--owner-label",
    "operator-session",
  ]);
  const ownerToken = owned.json.data.ownerToken;

  const inputPath = await writeInput(workspace, {
    sourceKind: "specification",
    source: { id: "github:operator#15", revision: "rev-1", tracker: "github" },
    items: [
      {
        key: "22.1",
        title: "Build the reviewed result path",
        kind: "production",
        approvedScope: "Build the reviewed result path.",
        acceptanceRequirements: REQUIREMENTS,
        permissions: { writePaths: ["modules/"], allowedCommands: ["bun test"], network: false },
        fixedInputs: [{ name: "brief", kind: "value", value: "the brief", contentIdentity: null }],
        dependsOn: [],
      },
    ],
  });
  const registered = await runJson(workspace, [
    "work",
    "register",
    "--request",
    request(),
    "--owner-token",
    ownerToken,
    "--input",
    inputPath,
  ]);
  const assignmentId = registered.json.data.registered[0].assignmentId;

  const claimed = await runJson(workspace, [
    "work",
    "claim",
    "--request",
    request(),
    "--owner-token",
    ownerToken,
    "--assignment",
    assignmentId,
    "--revision",
    "1",
  ]);
  const attemptId = claimed.json.data.attemptId;
  const worktreePath = `${workspace.root}/operative`;

  await runJson(workspace, [
    "attempt",
    "dispatch",
    "--request",
    request(),
    "--owner-token",
    ownerToken,
    "--attempt",
    attemptId,
    "--commit",
    await headCommit(workspace),
    "--worktree",
    worktreePath,
  ]);
  await runJson(
    workspace,
    ["attempt", "acknowledge", "--request", request(), "--attempt", attemptId],
    worktreePath,
  );

  return {
    ownerToken,
    assignmentId,
    attemptId,
    worktreePath,
    assignmentRevision: claimed.json.data.revision as number,
  };
}

export type Producer = Awaited<ReturnType<typeof startProducer>>;

/** Writes one artifact into the Operative worktree and commits it, as a real result would. */
export async function commitArtifact(workspace: Workspace, producer: Producer, text: string) {
  const relative = "docs/result.md";
  await Bun.write(`${producer.worktreePath}/${relative}`, text);
  await Bun.$`git -C ${producer.worktreePath} add ${relative}`.quiet();
  await Bun.$`git -C ${producer.worktreePath} -c user.email=t@example.com -c user.name=Test commit -m result`.quiet();

  return {
    path: relative,
    identity: ContentIdentity.ofText(text),
    commit: await headCommit(workspace, producer.worktreePath),
  };
}

export type SubmissionOverrides = {
  resultKind?: "code" | "non-code";
  assignmentRevision?: number;
  sourceRevision?: string;
  requirementsIdentity?: string;
  artifactIdentity?: string;
  artifactPath?: string;
  checks?: Array<{ name: string; command: string; outcome: string; detail: string }>;
  pullRequest?: unknown;
  code?: unknown;
};

export function submissionBody(
  producer: Producer,
  artifact: { path: string; identity: string; commit: string },
  base: string,
  overrides: SubmissionOverrides = {},
) {
  const code = {
    baseCommit: base,
    resultCommit: artifact.commit,
    mergeBase: base,
    branch: `operator/22-1`,
    pullRequest: overrides.pullRequest ?? {
      status: "open",
      number: 41,
      headCommit: artifact.commit,
    },
  };

  return {
    resultKind: overrides.resultKind ?? "code",
    assignmentRevision: overrides.assignmentRevision ?? producer.assignmentRevision,
    sourceRevision: overrides.sourceRevision ?? "rev-1",
    requirementsIdentity: overrides.requirementsIdentity ?? REQUIREMENTS_IDENTITY,
    artifacts: [
      {
        name: "result",
        kind: "path",
        value: overrides.artifactPath ?? artifact.path,
        contentIdentity: overrides.artifactIdentity ?? artifact.identity,
      },
    ],
    checks: overrides.checks ?? [
      { name: "quality", command: "bun run quality", outcome: "passed", detail: "" },
    ],
    concerns: ["The reviewer decides whether the coverage rule is too strict."],
    decisions: [
      {
        statement: "The review base is the submitted commit.",
        authority: "operator-decision",
        reason: "A moving branch is not fixed evidence.",
      },
    ],
    ...(overrides.code === undefined ? { code } : { code: overrides.code }),
  };
}

export async function submit(
  workspace: Workspace,
  producer: Producer,
  body: unknown,
  attemptId = producer.attemptId,
) {
  return runJson(
    workspace,
    [
      "attempt",
      "submit",
      "--request",
      request(),
      "--attempt",
      attemptId,
      "--input",
      await writeInput(workspace, body),
    ],
    producer.worktreePath,
  );
}

/** Claims and launches the review assignment the submission registered. */
export async function startReviewer(
  workspace: Workspace,
  producer: Producer,
  submitted: { data: { reviewAssignmentId: string; reviewId: string } },
  commit: string,
  revision = 1,
) {
  const claimed = await runJson(workspace, [
    "work",
    "claim",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--assignment",
    submitted.data.reviewAssignmentId,
    "--revision",
    String(revision),
  ]);
  const attemptId = claimed.json.data.attemptId;
  const worktreePath = `${workspace.root}/reviewer`;

  const dispatched = await runJson(workspace, [
    "attempt",
    "dispatch",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--attempt",
    attemptId,
    "--commit",
    commit,
    "--worktree",
    worktreePath,
  ]);
  await runJson(
    workspace,
    ["attempt", "acknowledge", "--request", request(), "--attempt", attemptId],
    worktreePath,
  );

  return {
    attemptId,
    worktreePath,
    dispatched,
    revision: claimed.json.data.revision as number,
  };
}

const AXIS_WINDOW = Date.parse("2026-09-21T10:00:00.000Z");

export function windowAt(offsetSeconds: number, durationSeconds: number) {
  const start = AXIS_WINDOW + offsetSeconds * 1000;
  return {
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(start + durationSeconds * 1000).toISOString(),
  };
}

export type Finding = { key: string; severity: string; summary: string; evidence: string };

export function reportBody(options: {
  submissionIdentity: string;
  host: Host;
  checked?: string[];
  standardsFindings?: Finding[];
  specFindings?: Finding[];
  sequential?: boolean;
  subAgentHost?: string;
  statedHost?: string;
  failedAxis?: string;
  observedChecks?: Array<{ name: string; outcome: string }>;
}) {
  const checked = options.checked ?? ["diff", "requirements", "checks"];
  const axes = ["standards", "spec"] as const;

  return {
    kind: "reported",
    submissionIdentity: options.submissionIdentity,
    host: options.statedHost ?? options.host,
    subAgents: axes.map((axis, index) => ({
      axis,
      name: `${axis}-axis`,
      host: options.subAgentHost ?? options.host,
      ...(options.sequential === true ? windowAt(index * 10, 5) : windowAt(0, 30)),
      status: options.failedAxis === axis ? "failed" : "completed",
    })),
    reports: axes.map((axis) => ({
      axis,
      summary: `The ${axis} axis read the fixed inputs.`,
      checked,
      observedChecks: axis === "standards" ? (options.observedChecks ?? []) : [],
      findings:
        axis === "standards" ? (options.standardsFindings ?? []) : (options.specFindings ?? []),
    })),
  };
}

export async function reportReview(
  workspace: Workspace,
  reviewer: { worktreePath: string },
  reviewId: string,
  body: unknown,
) {
  return runJson(
    workspace,
    [
      "review",
      "report",
      "--request",
      request(),
      "--review",
      reviewId,
      "--input",
      await writeInput(workspace, body),
    ],
    reviewer.worktreePath,
  );
}

export async function acceptProduction(
  workspace: Workspace,
  producer: Producer,
  options: { submissionId: string; revision: number; prHead?: string },
) {
  return runJson(workspace, [
    "work",
    "accept",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--assignment",
    producer.assignmentId,
    "--attempt",
    producer.attemptId,
    "--revision",
    String(options.revision),
    "--submission",
    options.submissionId,
    ...(options.prHead === undefined ? [] : ["--pr-head", options.prHead]),
  ]);
}

/** Records a blocker on one review, then replaces its stopped reviewer with a new attempt. */
export async function blockThenReplace(
  workspace: Workspace,
  producer: Producer,
  request_: {
    reviewId: string;
    submissionIdentity: string;
    attemptId: string;
    worktreePath: string;
  },
) {
  await reportReview(workspace, request_, request_.reviewId, {
    kind: "blocked",
    submissionIdentity: request_.submissionIdentity,
    host: workspace.host,
    blocker: { reason: "credentials_missing", detail: "The host has no provider credential." },
  });
  await stopFakeAgents(workspace);

  const inspected = await runJson(workspace, [
    "attempt",
    "replace",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--attempt",
    request_.attemptId,
  ]);
  if (inspected.json.reason !== "inspection_required") {
    return inspected;
  }

  return runJson(workspace, [
    "attempt",
    "replace",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--attempt",
    request_.attemptId,
    "--inspection",
    inspected.json.data.identity,
  ]);
}

export async function relaunchReviewer(
  workspace: Workspace,
  producer: Producer,
  attemptId: string,
  worktreePath: string,
) {
  await runJson(workspace, [
    "attempt",
    "dispatch",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--attempt",
    attemptId,
  ]);
  await runJson(
    workspace,
    ["attempt", "acknowledge", "--request", request(), "--attempt", attemptId],
    worktreePath,
  );
}
