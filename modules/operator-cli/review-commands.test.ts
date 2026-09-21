import { afterEach, describe, expect, test } from "bun:test";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { ContentIdentity } from "../content-identity/main.ts";
import {
  headCommit,
  herdrCalls,
  requestId as request,
  runJson,
  type Workspace as Fixture,
  workspaces,
} from "./fixtures/workspace.ts";

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

type Host = "claude-code" | "opencode";

type Workspace = Fixture & { host: Host };

const REQUIREMENTS = ["The quality gate passes."];
const REQUIREMENTS_IDENTITY = ContentIdentity.of(REQUIREMENTS);

// Operator installs only the skills it owns, so the review skill lives in the checkout itself.
const SKILL_PATH: Record<Host, string> = {
  "claude-code": ".claude/skills/code-review/SKILL.md",
  opencode: ".agents/skills/code-review/SKILL.md",
};

async function makeWorkspace(
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

async function writeInput(workspace: Workspace, value: unknown): Promise<string> {
  const path = `${workspace.root}/input-${crypto.randomUUID()}.json`;
  await Bun.write(path, JSON.stringify(value));
  return path;
}

/** One production assignment, claimed, dispatched into its own worktree, and acknowledged. */
async function startProducer(workspace: Workspace) {
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

type Producer = Awaited<ReturnType<typeof startProducer>>;

/** Writes one artifact into the Operative worktree and commits it, as a real result would. */
async function commitArtifact(workspace: Workspace, producer: Producer, text: string) {
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

type SubmissionOverrides = {
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

function submissionBody(
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

async function submit(
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
async function startReviewer(
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

function windowAt(offsetSeconds: number, durationSeconds: number) {
  const start = AXIS_WINDOW + offsetSeconds * 1000;
  return {
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(start + durationSeconds * 1000).toISOString(),
  };
}

type Finding = { key: string; severity: string; summary: string; evidence: string };

function reportBody(options: {
  submissionIdentity: string;
  host: Host;
  checked?: string[];
  standardsFindings?: Finding[];
  specFindings?: Finding[];
  sequential?: boolean;
  subAgentHost?: string;
  failedAxis?: string;
  observedChecks?: Array<{ name: string; outcome: string }>;
}) {
  const checked = options.checked ?? ["diff", "requirements", "checks"];
  const axes = ["standards", "spec"] as const;

  return {
    kind: "reported",
    submissionIdentity: options.submissionIdentity,
    host: options.host,
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

async function reportReview(
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

async function acceptProduction(
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
async function blockThenReplace(
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
  await rm(`${workspace.herdr}/agent-live`, { force: true });

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

async function relaunchReviewer(
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

describe("operator attempt submit", () => {
  test("hands a fixed result to a separate review instead of accepting it", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n\nThe finished work.\n");

    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));

    expect(submitted.exitCode).toBe(6);
    expect(submitted.json.reason).toBe("result_submitted");
    expect(submitted.json.blockers[0].reason).toBe("review_pending");

    const frontier = await runJson(workspace, ["work", "frontier"]);
    const producerEntry = frontier.json.data.blocked.find(
      (one: { assignmentId: string }) => one.assignmentId === producer.assignmentId,
    );
    expect(producerEntry.blockers[0]).toMatchObject({
      reason: "review_pending",
      reviewAssignmentId: submitted.json.data.reviewAssignmentId,
    });
    // The producer attempt ended, so the slot it held is free for the reviewer.
    expect(frontier.json.data.active).toEqual([]);
    expect(
      frontier.json.data.dispatchable.map((one: { assignmentId: string }) => one.assignmentId),
    ).toEqual([submitted.json.data.reviewAssignmentId]);
  });

  test("refuses an artifact whose content no longer matches its stated identity", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    await Bun.write(`${producer.worktreePath}/${artifact.path}`, "# Changed after the identity\n");

    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));

    expect(submitted.exitCode).toBe(4);
    expect(submitted.json.reason).toBe("artifact_identity_changed");
  });

  test("refuses an artifact that is not in the worktree", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");

    const submitted = await submit(
      workspace,
      producer,
      submissionBody(producer, artifact, base, { artifactPath: "docs/absent.md" }),
    );

    expect(submitted.exitCode).toBe(3);
    expect(submitted.json.reason).toBe("artifact_unreadable");
  });

  test("refuses a submission that states requirements the assignment does not hold", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");

    const submitted = await submit(
      workspace,
      producer,
      submissionBody(producer, artifact, base, {
        requirementsIdentity: ContentIdentity.of(["Something else."]),
      }),
    );

    expect(submitted.exitCode).toBe(4);
    expect(submitted.json.reason).toBe("requirements_changed");
  });

  test("refuses a submission that states a stale assignment revision", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");

    const submitted = await submit(
      workspace,
      producer,
      submissionBody(producer, artifact, base, { assignmentRevision: 1 }),
    );

    expect(submitted.exitCode).toBe(4);
    expect(submitted.json.reason).toBe("stale_revision");
  });

  test("a repeated submission reports the recorded one and creates no second review", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const body = submissionBody(producer, artifact, base);

    const first = await submit(workspace, producer, body);
    const second = await submit(workspace, producer, body);

    expect(second.exitCode).toBe(0);
    expect(second.json.reason).toBe("result_already_submitted");
    expect(second.json.data.submissionId).toBe(first.json.data.submissionId);

    const frontier = await runJson(workspace, ["work", "frontier"]);
    expect(
      frontier.json.data.dispatchable.filter((one: { kind: string }) => one.kind === "review")
        .length,
    ).toBe(1);
  });
});

describe("operator review report", () => {
  test("reviews a code result on both axes and then accepts it", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n\nThe finished work.\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const reviewId = submitted.json.data.reviewId;

    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);
    expect(reviewer.dispatched.json.reason).toBe("acknowledgement_pending");

    // The reviewer holds one Herdr slot, and its axes are native sub-agents of its own host.
    expect(
      (await herdrCalls(workspace)).filter((line) => line.startsWith("agent start ")),
    ).toHaveLength(2);

    const brief = await Bun.file(`${reviewer.worktreePath}/.operator/local/brief.md`).text();
    expect(brief).toContain("Load the `code-review` skill");
    expect(brief).toContain(submitted.json.data.identity);
    expect(brief).toContain("standards and spec");
    expect(brief).toContain("Never start a Herdr agent");
    expect(brief).toContain("They must never edit a file, commit, push, or perform rework.");
    // The reviewer writes its own report and nothing else, so rework cannot hide inside a review.
    expect(brief).toContain("Write only inside these paths:\n- .operator/local/");
    // The brief authorizes the commands the reviewer must run, not only the checks it may re-run.
    expect(brief).toContain(
      "Run only these commands:\n- operator attempt acknowledge\n- operator review report\n- bun run quality",
    );

    const copied = await Bun.file(
      `${reviewer.worktreePath}/.operator/local/review/0-result.md`,
    ).text();
    expect(copied).toBe("# Result\n\nThe finished work.\n");

    const reported = await reportReview(
      workspace,
      reviewer,
      reviewId,
      reportBody({
        submissionIdentity: submitted.json.data.identity,
        host: workspace.host,
        specFindings: [
          {
            key: "coverage-rule",
            severity: "improvement",
            summary: "The coverage tokens could be documented.",
            evidence: "docs/result.md",
          },
        ],
      }),
    );
    expect(reported.exitCode).toBe(0);
    expect(reported.json.reason).toBe("review_reported");
    expect(reported.json.data.findings).toHaveLength(1);

    const findingId = reported.json.data.findings[0].findingId;
    const blockedByFinding = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
      prHead: artifact.commit,
    });
    expect(blockedByFinding.exitCode).toBe(3);
    expect(blockedByFinding.json.reason).toBe("findings_undisposed");

    const disposed = await runJson(workspace, [
      "review",
      "dispose",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--review",
      reviewId,
      "--input",
      await writeInput(workspace, {
        dispositions: [
          {
            findingId,
            disposition: "deferred",
            reason: "The coverage rule is documented in the ADR instead.",
            followUp: "github:operator#23",
          },
        ],
      }),
    ]);
    expect(disposed.exitCode).toBe(0);
    expect(disposed.json.data.outstanding).toEqual([]);

    const accepted = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
      prHead: artifact.commit,
    });
    expect(accepted.exitCode).toBe(0);
    expect(accepted.json.reason).toBe("assignment_accepted");

    const shown = await runJson(workspace, ["review", "show", "--review", reviewId]);
    expect(shown.json.data.review.state).toBe("reported");
    expect(shown.json.data.reports.map((one: { axis: string }) => one.axis)).toEqual([
      "spec",
      "standards",
    ]);
    expect(shown.json.data.submission.state).toBe("accepted");
  });

  test("reviews a non-code result against citations and provenance on opencode", async () => {
    const workspace = await makeWorkspace({ host: "opencode" });
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Findings\n\nOne citation.\n");
    const submitted = await submit(
      workspace,
      producer,
      submissionBody(producer, artifact, base, {
        resultKind: "non-code",
        checks: [],
        code: null,
      }),
    );
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);

    const brief = await Bun.file(`${reviewer.worktreePath}/.operator/local/brief.md`).text();
    expect(brief).toContain("This result is not code.");
    expect(brief).toContain("supported by a citation you can follow");
    expect(brief).toContain("artifacts, requirements, citations, provenance");
    // A non-code result records no check, and the reviewer can still report what it read.
    expect(brief).toContain(
      "Run only these commands:\n- operator attempt acknowledge\n- operator review report\n",
    );

    const codeCoverage = await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      reportBody({
        submissionIdentity: submitted.json.data.identity,
        host: "opencode",
        checked: ["diff", "requirements", "checks"],
      }),
    );
    expect(codeCoverage.exitCode).toBe(3);
    expect(codeCoverage.json.reason).toBe("review_coverage_incomplete");
    expect(codeCoverage.json.blockers[0].missing).toEqual(["artifacts", "citations", "provenance"]);

    const reported = await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      reportBody({
        submissionIdentity: submitted.json.data.identity,
        host: "opencode",
        checked: ["artifacts", "requirements", "citations", "provenance"],
      }),
    );
    expect(reported.exitCode).toBe(0);
    expect(reported.json.reason).toBe("review_reported");

    const shown = await runJson(workspace, [
      "review",
      "show",
      "--review",
      submitted.json.data.reviewId,
    ]);
    expect(shown.json.data.review.host).toBe("opencode");
    expect(shown.json.data.review.subAgents.map((one: { host: string }) => one.host)).toEqual([
      "opencode",
      "opencode",
    ]);

    // A non-code result carries no pull request, so acceptance needs no head.
    const accepted = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
    });
    expect(accepted.exitCode).toBe(0);
    expect(accepted.json.reason).toBe("assignment_accepted");
  });

  test("refuses a report from a worktree the reviewer changed", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);

    // A reviewer may read and run checks. Repairing what it found is rework, and rework is a
    // separate assignment that a fresh Operative receives.
    await Bun.write(`${reviewer.worktreePath}/${artifact.path}`, "# Repaired by the reviewer\n");

    const reported = await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      reportBody({ submissionIdentity: submitted.json.data.identity, host: workspace.host }),
    );

    expect(reported.json.reason).toBe("review_worktree_changed");
    expect(reported.exitCode).toBe(4);
    expect(reported.json.blockers[0]).toMatchObject({ path: artifact.path });
  });

  test("refuses a report from a worktree the reviewer committed to", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);

    await Bun.write(`${reviewer.worktreePath}/${artifact.path}`, "# Repaired by the reviewer\n");
    await Bun.$`git -C ${reviewer.worktreePath} add ${artifact.path}`.quiet();
    await Bun.$`git -C ${reviewer.worktreePath} -c user.email=t@example.com -c user.name=Test commit -m rework`.quiet();

    const reported = await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      reportBody({ submissionIdentity: submitted.json.data.identity, host: workspace.host }),
    );

    expect(reported.json.reason).toBe("review_worktree_changed");
    expect(
      reported.json.blockers.some((one: { commit?: string }) => one.commit !== undefined),
    ).toBe(true);
  });

  test("refuses a report that names a host the launch did not use", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);

    const reported = await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      reportBody({ submissionIdentity: submitted.json.data.identity, host: "opencode" }),
    );

    expect(reported.json.reason).toBe("review_sub_agent_host_mismatch");
    expect(reported.exitCode).toBe(4);
    expect(reported.json.blockers[0]).toMatchObject({ host: "opencode", recorded: "claude-code" });
  });

  test("records a missing review input as a blocker, not as a verdict", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);

    const blocked = await reportReview(workspace, reviewer, submitted.json.data.reviewId, {
      kind: "blocked",
      submissionIdentity: submitted.json.data.identity,
      host: workspace.host,
      blocker: {
        reason: "inputs_missing",
        detail: "The spec the assignment names is not readable.",
      },
    });
    expect(blocked.json.reason).toBe("review_blocked");
    expect(blocked.exitCode).toBe(3);

    const shown = await runJson(workspace, [
      "review",
      "show",
      "--review",
      submitted.json.data.reviewId,
    ]);
    expect(shown.json.data.review.state).toBe("blocked");
    expect(shown.json.data.review.blocker.reason).toBe("inputs_missing");

    const accepted = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
      prHead: artifact.commit,
    });
    expect(accepted.json.reason).toBe("review_incomplete");
    expect(accepted.json.blockers[0].blocker.reason).toBe("inputs_missing");
  });

  test("refuses two axes that ran one after the other", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);

    const reported = await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      reportBody({
        submissionIdentity: submitted.json.data.identity,
        host: workspace.host,
        sequential: true,
      }),
    );

    expect(reported.exitCode).toBe(4);
    expect(reported.json.reason).toBe("review_axes_not_parallel");
  });

  test("refuses a sub-agent that did not run inside the reviewer host", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);

    const reported = await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      reportBody({
        submissionIdentity: submitted.json.data.identity,
        host: workspace.host,
        subAgentHost: "opencode",
      }),
    );

    expect(reported.exitCode).toBe(4);
    expect(reported.json.reason).toBe("review_sub_agent_host_mismatch");
  });

  test("refuses a report that names a different submission than the one under review", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);

    const reported = await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      reportBody({
        submissionIdentity: ContentIdentity.ofText("another result"),
        host: workspace.host,
      }),
    );

    expect(reported.exitCode).toBe(4);
    expect(reported.json.reason).toBe("submission_drift");
  });

  test("a review report is never a submitted result, so it starts no second review", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);

    const attempted = await runJson(
      workspace,
      [
        "attempt",
        "submit",
        "--request",
        request(),
        "--attempt",
        reviewer.attemptId,
        "--input",
        await writeInput(
          workspace,
          submissionBody(producer, artifact, base, { resultKind: "non-code" }),
        ),
      ],
      reviewer.worktreePath,
    );

    expect(attempted.exitCode).toBe(2);
    expect(attempted.json.reason).toBe("review_result_not_submitted");
  });
});

describe("operator work accept", () => {
  test("refuses acceptance while the review reports nothing", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));

    // The reviewer process exits with nothing recorded, which is not a review.
    await startReviewer(workspace, producer, submitted.json, artifact.commit);

    const accepted = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
      prHead: artifact.commit,
    });

    expect(accepted.exitCode).toBe(3);
    expect(accepted.json.reason).toBe("review_incomplete");
    expect(accepted.json.blockers[0].state).toBe("registered");
  });

  test("refuses acceptance when the review host cannot run the axes", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);

    const blocked = await reportReview(workspace, reviewer, submitted.json.data.reviewId, {
      kind: "blocked",
      submissionIdentity: submitted.json.data.identity,
      host: workspace.host,
      blocker: {
        reason: "review_capability_unavailable",
        detail: "This host cannot start two parallel sub-agents.",
      },
    });
    expect(blocked.exitCode).toBe(3);
    expect(blocked.json.reason).toBe("review_blocked");

    const accepted = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
      prHead: artifact.commit,
    });
    expect(accepted.exitCode).toBe(3);
    expect(accepted.json.reason).toBe("review_incomplete");
    expect(accepted.json.blockers[0].blocker.reason).toBe("review_capability_unavailable");

    // A blocked review never reaches accepted completion either.
    const reviewAccepted = await runJson(workspace, [
      "work",
      "accept",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--assignment",
      submitted.json.data.reviewAssignmentId,
      "--attempt",
      reviewer.attemptId,
      "--revision",
      String(reviewer.revision),
    ]);
    expect(reviewAccepted.exitCode).toBe(3);
    expect(reviewAccepted.json.reason).toBe("review_incomplete");
  });

  test("refuses acceptance when a review observed a check the producer called passed", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);

    const reported = await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      reportBody({
        submissionIdentity: submitted.json.data.identity,
        host: workspace.host,
        observedChecks: [{ name: "quality", outcome: "failed" }],
      }),
    );
    expect(reported.json.reason).toBe("review_reported");

    const accepted = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
      prHead: artifact.commit,
    });

    expect(accepted.json.reason).toBe("checks_contradicted");
    expect(accepted.exitCode).toBe(4);
    expect(accepted.json.blockers[0]).toMatchObject({
      name: "quality",
      recorded: "passed",
      observed: "failed",
      axis: "standards",
    });
  });

  test("accepts when the review observed the same outcomes the producer recorded", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);
    await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      reportBody({
        submissionIdentity: submitted.json.data.identity,
        host: workspace.host,
        observedChecks: [{ name: "quality", outcome: "passed" }],
      }),
    );

    const accepted = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
      prHead: artifact.commit,
    });

    expect(accepted.json.reason).toBe("assignment_accepted");
    expect(accepted.exitCode).toBe(0);
  });

  test("refuses acceptance while a check did not pass", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(
      workspace,
      producer,
      submissionBody(producer, artifact, base, {
        checks: [
          { name: "quality", command: "bun run quality", outcome: "passed", detail: "" },
          { name: "integration", command: "bun test", outcome: "flaky", detail: "One rerun." },
        ],
      }),
    );
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);
    await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      reportBody({ submissionIdentity: submitted.json.data.identity, host: workspace.host }),
    );

    const accepted = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
      prHead: artifact.commit,
    });

    expect(accepted.exitCode).toBe(3);
    expect(accepted.json.reason).toBe("checks_unproven");
    expect(accepted.json.blockers[0]).toMatchObject({ name: "integration", outcome: "flaky" });
  });

  test("refuses acceptance when the pull request head moved after the review", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);
    await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      reportBody({ submissionIdentity: submitted.json.data.identity, host: workspace.host }),
    );

    const missing = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
    });
    expect(missing.exitCode).toBe(3);
    expect(missing.json.reason).toBe("pr_head_required");

    const moved = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
      prHead: "0".repeat(40),
    });
    expect(moved.exitCode).toBe(4);
    expect(moved.json.reason).toBe("pr_head_changed");
  });

  test("refuses acceptance when the implementation carries no pull request authority", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(
      workspace,
      producer,
      submissionBody(producer, artifact, base, {
        pullRequest: { status: "authority-missing", detail: "No push approval was given." },
      }),
    );
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);
    await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      reportBody({ submissionIdentity: submitted.json.data.identity, host: workspace.host }),
    );

    const accepted = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
    });

    expect(accepted.exitCode).toBe(3);
    expect(accepted.json.reason).toBe("pr_authority_missing");
  });

  test("holds acceptance while an accepted correction waits for a fresh Operative", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);
    const reported = await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      reportBody({
        submissionIdentity: submitted.json.data.identity,
        host: workspace.host,
        standardsFindings: [
          {
            key: "missing-comment",
            severity: "blocker",
            summary: "The transition states no reason.",
            evidence: "modules/crew-state/acceptance.ts",
          },
        ],
      }),
    );
    const findingId = reported.json.data.findings[0].findingId;

    const deferred = await runJson(workspace, [
      "review",
      "dispose",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--review",
      submitted.json.data.reviewId,
      "--input",
      await writeInput(workspace, {
        dispositions: [
          { findingId, disposition: "deferred", reason: "Later.", followUp: "github:operator#23" },
        ],
      }),
    ]);
    expect(deferred.exitCode).toBe(2);
    expect(deferred.json.reason).toBe("blocker_not_deferrable");

    const corrected = await runJson(workspace, [
      "review",
      "dispose",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--review",
      submitted.json.data.reviewId,
      "--input",
      await writeInput(workspace, {
        dispositions: [{ findingId, disposition: "corrected", reason: "The comment is required." }],
      }),
    ]);
    expect(corrected.exitCode).toBe(6);
    expect(corrected.json.data.corrections).toEqual([findingId]);

    const accepted = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
      prHead: artifact.commit,
    });
    expect(accepted.exitCode).toBe(6);
    expect(accepted.json.reason).toBe("rework_pending");
  });

  test("a replacement reviewer reopens a blocked review, and the attempts are bounded", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const reviewId = submitted.json.data.reviewId;
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);

    // The writer must be proven stopped and its partial work inspected before a replacement.
    const replaced = await blockThenReplace(workspace, producer, {
      reviewId,
      submissionIdentity: submitted.json.data.identity,
      attemptId: reviewer.attemptId,
      worktreePath: reviewer.worktreePath,
    });
    expect(replaced.exitCode).toBe(0);

    const reopened = await runJson(workspace, ["review", "show", "--review", reviewId]);
    expect(reopened.json.data.review.state).toBe("registered");
    expect(reopened.json.data.review.blocker).toBeNull();

    // The replacement reviewer reads the same fixed submission and reports it itself.
    const second = { worktreePath: reviewer.worktreePath };
    await relaunchReviewer(workspace, producer, replaced.json.data.attemptId, second.worktreePath);
    const reported = await reportReview(
      workspace,
      second,
      reviewId,
      reportBody({ submissionIdentity: submitted.json.data.identity, host: workspace.host }),
    );
    expect(reported.json.reason).toBe("review_reported");
    expect(reported.exitCode).toBe(0);
  });

  test("a failing review host escalates instead of taking the crew", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const reviewId = submitted.json.data.reviewId;
    const first = await startReviewer(workspace, producer, submitted.json, artifact.commit);

    const shared = {
      reviewId,
      submissionIdentity: submitted.json.data.identity,
      worktreePath: first.worktreePath,
    };

    const second = await blockThenReplace(workspace, producer, {
      ...shared,
      attemptId: first.attemptId,
    });
    await relaunchReviewer(workspace, producer, second.json.data.attemptId, first.worktreePath);

    const third = await blockThenReplace(workspace, producer, {
      ...shared,
      attemptId: second.json.data.attemptId,
    });
    await relaunchReviewer(workspace, producer, third.json.data.attemptId, first.worktreePath);

    const refused = await blockThenReplace(workspace, producer, {
      ...shared,
      attemptId: third.json.data.attemptId,
    });
    expect(refused.json.reason).toBe("review_attempt_limit");
    expect(refused.exitCode).toBe(3);
    expect(refused.json.blockers[0]).toMatchObject({ reviewId, limit: 3 });

    // The limit is not a pass, so the result is still unaccepted.
    const accepted = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
      prHead: artifact.commit,
    });
    expect(accepted.json.reason).toBe("review_incomplete");
  });
});

describe("review capacity and fixed inputs", () => {
  test("a one-agent crew hands its only slot from the producer to the reviewer", async () => {
    const workspace = await makeWorkspace({ maxActiveAgents: 1 });
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");

    const busy = await runJson(workspace, ["work", "frontier"]);
    expect(busy.json.data.capacity.active.total).toBe(1);
    expect(busy.json.data.capacity.freeSlots).toBe(0);

    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const free = await runJson(workspace, ["work", "frontier"]);
    expect(free.json.data.capacity.active.total).toBe(0);
    expect(
      free.json.data.dispatchable.map((one: { assignmentId: string }) => one.assignmentId),
    ).toEqual([submitted.json.data.reviewAssignmentId]);

    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);
    const held = await runJson(workspace, ["work", "frontier"]);
    expect(held.json.data.capacity.active).toMatchObject({ total: 1, review: 1, production: 0 });
    expect(reviewer.dispatched.json.reason).toBe("acknowledgement_pending");
  });

  test("a review starts from the submitted commit, never a later one", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));

    const claimed = await runJson(workspace, [
      "work",
      "claim",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--assignment",
      submitted.json.data.reviewAssignmentId,
      "--revision",
      "1",
    ]);
    const drifted = await runJson(workspace, [
      "attempt",
      "dispatch",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--attempt",
      claimed.json.data.attemptId,
      "--commit",
      base,
      "--worktree",
      `${workspace.root}/reviewer`,
    ]);

    expect(drifted.exitCode).toBe(4);
    expect(drifted.json.reason).toBe("review_base_changed");
    expect(drifted.json.blockers[0]).toMatchObject({ recorded: artifact.commit, requested: base });
  });

  test("a checkout with no review skill blocks the reviewer before it starts", async () => {
    const workspace = await makeWorkspace({ reviewSkill: false });
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));

    const claimed = await runJson(workspace, [
      "work",
      "claim",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--assignment",
      submitted.json.data.reviewAssignmentId,
      "--revision",
      "1",
    ]);
    const dispatched = await runJson(workspace, [
      "attempt",
      "dispatch",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--attempt",
      claimed.json.data.attemptId,
      "--commit",
      artifact.commit,
      "--worktree",
      `${workspace.root}/reviewer`,
    ]);

    expect(dispatched.exitCode).toBe(1);
    expect(dispatched.json.reason).toBe("dispatch_stage_failed");
    expect(dispatched.json.blockers[0]).toMatchObject({ stage: "input_preparation" });
    expect(dispatched.json.blockers[0].detail).toContain("code-review");
    // The reviewer host never started, so no partial review exists to reconcile.
    const starts = (await herdrCalls(workspace)).filter((line) => line.startsWith("agent start "));
    expect(starts).toHaveLength(1);
  });
});
