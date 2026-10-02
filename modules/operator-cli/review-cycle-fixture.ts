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
  options: {
    host?: Host;
    maxActiveAgents?: number;
    reviewSkill?: boolean;
    files?: Record<string, string>;
    gate?: unknown;
  } = {},
): Promise<Workspace> {
  const host = options.host ?? "claude-code";
  const crew: { host: Host; maxActiveAgents?: number } = { host };
  if (options.maxActiveAgents !== undefined) crew.maxActiveAgents = options.maxActiveAgents;
  const files: Record<string, string> = { ...options.files };
  if (options.reviewSkill !== false) files[SKILL_PATH[host]] = "---\nname: code-review\n---\n";
  const fixture = await fixtures.make({ config: { crew }, files, gate: options.gate });

  return { ...fixture, host };
}

export async function writeInput(workspace: Workspace, value: unknown): Promise<string> {
  const path = `${workspace.root}/inputs/input-${crypto.randomUUID()}.json`;
  await Bun.write(path, JSON.stringify(value));
  return path;
}

/** One production assignment, claimed, dispatched into its own worktree, and acknowledged. */
export async function startProducer(
  workspace: Workspace,
  fixedInputs: unknown[] = [
    { name: "brief", kind: "value", value: "the brief", contentIdentity: null },
  ],
  options: { acknowledge?: boolean; env?: Record<string, string> } = {},
) {
  const env = options.env ?? {};
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
        permissions: { writePaths: ["docs/"], allowedCommands: ["bun test"], network: false },
        fixedInputs,
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
  const baseCommit = await headCommit(workspace);

  const dispatched = await runJson(
    workspace,
    [
      "attempt",
      "dispatch",
      "--request",
      request(),
      "--owner-token",
      ownerToken,
      "--attempt",
      attemptId,
      "--commit",
      baseCommit,
      "--worktree",
      worktreePath,
    ],
    workspace.repo,
    env,
  );
  if (options.acknowledge !== false) {
    await runJson(
      workspace,
      ["attempt", "acknowledge", "--request", request(), "--attempt", attemptId],
      worktreePath,
    );
  }

  return {
    ownerToken,
    assignmentId,
    attemptId,
    worktreePath,
    baseCommit,
    assignmentRevision: claimed.json.data.revision as number,
    dispatched: dispatched.json,
  };
}

export type Producer = Awaited<ReturnType<typeof startProducer>>;

/** Writes one artifact into the Operative worktree and commits it, as a real result would. */
export async function commitArtifact(
  workspace: Workspace,
  producer: Producer,
  text: string,
  relative = "docs/result.md",
) {
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
  code?: unknown;
  behaviorChanges?: unknown[];
};

/** A result body that states the dispatch base of its producer, as a real Operative does. */
export function submissionBody(
  producer: Producer,
  artifact: { path: string; identity: string; commit: string },
  overrides: SubmissionOverrides = {},
) {
  const code = {
    baseCommit: producer.baseCommit,
    resultCommit: artifact.commit,
    mergeBase: producer.baseCommit,
    branch: `operator/22-1`,
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
    behaviorChanges: overrides.behaviorChanges ?? [],
    ...(overrides.code === undefined ? { code } : { code: overrides.code }),
  };
}

export async function submit(
  workspace: Workspace,
  producer: Producer,
  body: unknown,
  attemptId = producer.attemptId,
  env: Record<string, string> = {},
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
    env,
  );
}

/** Claims and launches the review assignment the submission registered. */
export async function startReviewer(
  workspace: Workspace,
  producer: Producer,
  submitted: { data: { reviewAssignmentId: string; reviewId: string } },
  commit: string,
  options: { revision?: number; worktreePath?: string; acknowledge?: boolean } = {},
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
    String(options.revision ?? 1),
  ]);
  const attemptId = claimed.json.data.attemptId;
  // Each round has its own reviewer, so each one reads and writes in its own checkout.
  const worktreePath =
    options.worktreePath ??
    `${workspace.root}/reviewer-${submitted.data.reviewAssignmentId.slice(0, 8)}`;

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
  if (options.acknowledge !== false) {
    await runJson(
      workspace,
      ["attempt", "acknowledge", "--request", request(), "--attempt", attemptId],
      worktreePath,
    );
  }

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
  const checked = options.checked ?? ["diff", "requirements", "checks", "behavior-changes"];
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

/** Records what the Operator decided about each finding of one review. */
export async function disposeFindings(
  workspace: Workspace,
  producer: Producer,
  reviewId: string,
  dispositions: unknown[],
) {
  return runJson(workspace, [
    "review",
    "dispose",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--review",
    reviewId,
    "--input",
    await writeInput(workspace, { dispositions }),
  ]);
}

/** Delegates one rework cycle on the submitted result of one assignment. */
export async function delegateRework(
  workspace: Workspace,
  producer: Producer,
  options: { revision: number; body: unknown },
) {
  return runJson(workspace, [
    "work",
    "rework",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--assignment",
    producer.assignmentId,
    "--revision",
    String(options.revision),
    "--input",
    await writeInput(workspace, options.body),
  ]);
}

/** Claims and launches one assignment again, as the fresh Operative a rework cycle needs. */
export async function startRework(
  workspace: Workspace,
  producer: Producer,
  options: { revision: number; commit: string; worktreePath: string; assignmentId?: string },
) {
  const assignmentId = options.assignmentId ?? producer.assignmentId;
  const claimed = await runJson(workspace, [
    "work",
    "claim",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--assignment",
    assignmentId,
    "--revision",
    String(options.revision),
  ]);
  const attemptId = claimed.json.data.attemptId;

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
    options.commit,
    "--worktree",
    options.worktreePath,
  ]);
  await runJson(
    workspace,
    ["attempt", "acknowledge", "--request", request(), "--attempt", attemptId],
    options.worktreePath,
  );

  return {
    ...producer,
    assignmentId,
    attemptId,
    worktreePath: options.worktreePath,
    baseCommit: options.commit,
    assignmentRevision: claimed.json.data.revision as number,
    dispatched,
  };
}

/** Accepts one review assignment, which frees the crew slot its reviewer held. */
export async function acceptReview(
  workspace: Workspace,
  producer: Producer,
  options: { reviewAssignmentId: string; attemptId: string; revision: number },
) {
  return runJson(workspace, [
    "work",
    "accept",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--assignment",
    options.reviewAssignmentId,
    "--attempt",
    options.attemptId,
    "--revision",
    String(options.revision),
  ]);
}

/** Records the user's exact direction past one reached limit, as the approval it must be. */
export async function grantDirection(
  workspace: Workspace,
  producer: Producer,
  direction: {
    approval: { action: string; targets: string[]; scope: string; requestRevision: string };
  },
  exactText: string,
) {
  return runJson(workspace, [
    "approval",
    "grant",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--input",
    await writeInput(workspace, { ...direction.approval, exactText, grantedBy: "human" }),
  ]);
}

/** Registers more items in the same source, each one naming the items it depends on. */
export async function registerDependents(
  workspace: Workspace,
  producer: Producer,
  items: Array<{
    key: string;
    kind: "production" | "planning";
    title: string;
    dependsOn?: string[];
    writePaths?: string[];
  }>,
) {
  const registered = await runJson(workspace, [
    "work",
    "register",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--input",
    await writeInput(workspace, {
      sourceKind: "specification",
      source: { id: "github:operator#15", revision: "rev-1", tracker: "github" },
      items: items.map((item) => ({
        key: item.key,
        title: item.title,
        kind: item.kind,
        approvedScope: item.title,
        acceptanceRequirements: REQUIREMENTS,
        permissions: {
          writePaths: item.writePaths ?? ["docs/"],
          allowedCommands: ["bun test"],
          network: false,
        },
        fixedInputs: [],
        dependsOn: (item.dependsOn ?? ["22.1"]).map((key) => ({ key })),
      })),
    }),
  ]);

  return new Map<string, string>(
    registered.json.data.registered.map((one: { sourceKey: string; assignmentId: string }) => [
      one.sourceKey,
      one.assignmentId,
    ]),
  );
}

/** Records a defect found in one accepted result. */
export async function invalidateResult(
  workspace: Workspace,
  producer: Producer,
  options: { assignmentId: string; revision: number; defect: unknown },
) {
  return runJson(workspace, [
    "work",
    "invalidate",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--assignment",
    options.assignmentId,
    "--revision",
    String(options.revision),
    "--input",
    await writeInput(workspace, options.defect),
  ]);
}

/** A planning record with one human answer, which is the least a planning acceptance records. */
export const PLANNING_RECORD = {
  entries: [
    {
      question: "Do we go ahead as planned?",
      escalationTriggers: [],
      authority: "human-answer",
      exactText: "Yes.",
      interpretation: {
        summary: "Go ahead as planned.",
        directives: ["Build the planned work."],
        appliesTo: ["The work that depends on this decision."],
      },
    },
  ],
  artifacts: [],
};

/** Accepts planning work with its planning record, which is how planning work is resolved. */
export async function acceptAssignment(
  workspace: Workspace,
  producer: Producer,
  options: { assignmentId: string; revision: number; record?: unknown },
) {
  return runJson(workspace, [
    "work",
    "accept",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--assignment",
    options.assignmentId,
    "--revision",
    String(options.revision),
    "--input",
    await writeInput(workspace, options.record ?? PLANNING_RECORD),
  ]);
}

/** The frontier entry of one assignment, wherever the frontier put it. */
export async function frontierEntry(workspace: Workspace, assignmentId: string) {
  const frontier = await runJson(workspace, ["work", "frontier"]);
  const groups = ["dispatchable", "blocked", "active", "planning", "accepted"] as const;

  for (const group of groups) {
    const found = frontier.json.data[group].find(
      (one: { assignmentId: string }) => one.assignmentId === assignmentId,
    );
    if (found !== undefined) {
      return { group, entry: found };
    }
  }

  throw new Error(`the frontier does not carry ${assignmentId}`);
}

/** Raises one question from the producer worktree and records its answer. */
export async function answeredQuestion(
  workspace: Workspace,
  producer: Producer,
  authority: "human-answer" | "operator-decision",
): Promise<string> {
  const raised = await runJson(
    workspace,
    [
      "question",
      "raise",
      "--request",
      request(),
      "--attempt",
      producer.attemptId,
      "--input",
      await writeInput(workspace, {
        question: "Does the result keep the old heading?",
        evidence: [{ label: "ticket", detail: "The ticket names a new heading." }],
        options: [
          { name: "keep", detail: "Keep the old heading.", risk: "The ticket is not met." },
          { name: "change", detail: "Use the new heading.", risk: "Links break." },
        ],
        recommendation: "Use the new heading.",
        affectedScope: ["docs/"],
        independentWork: ["The rest of the result continues."],
        escalationTriggers: [],
      }),
    ],
    producer.worktreePath,
  );
  const questionId = raised.json.data.questionId;
  const interpretation = {
    summary: "Use the new heading.",
    directives: ["Write the new heading."],
    appliesTo: ["docs/"],
  };
  const answered = await runJson(workspace, [
    "question",
    "answer",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--question",
    questionId,
    "--revision",
    "1",
    "--input",
    await writeInput(
      workspace,
      authority === "human-answer"
        ? { authority, exactText: "use the new heading", interpretation }
        : { authority, interpretation },
    ),
  ]);
  if (answered.json.reason !== "answer_recorded") {
    throw new Error(`the answer was not recorded: ${answered.json.reason}`);
  }

  return questionId;
}
