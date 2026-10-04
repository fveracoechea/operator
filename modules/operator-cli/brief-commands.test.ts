import { afterEach, describe, expect, test as bunTest } from "bun:test";
import { rm } from "node:fs/promises";
import {
  commitArtifact,
  makeReviewWorkspace,
  type Producer,
  reportBody,
  reportReview,
  REQUIREMENTS,
  REQUIREMENTS_IDENTITY,
  startProducer,
  startReviewer,
  submissionBody,
  submit,
  type Workspace,
} from "./review-cycle-fixture.ts";
import type { Reason } from "./result.ts";
import { headCommit, requestId as request, runJson, workspaces } from "./workspace-fixture.ts";

// These tests create Git worktrees and run several CLI processes under the parallel CI gate.
// Each test states its own bound, because a process-wide default would set the bound of every
// file in the bun test process (#179).
function test(name: string, run: () => Promise<void> | void, timeoutMs = 120_000) {
  bunTest(name, run, timeoutMs);
}

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

const COMMANDS = ["attempt acknowledge", "attempt submit", "review report"] as const;
type Command = (typeof COMMANDS)[number];

const HEADER = "This command refuses, with the named reason, when you break one of its rules:";

/**
 * The refusal block a brief writes beside each command: the header and one line per rule.
 * The block follows the code block of its command, so it belongs to that command.
 */
function blocksByCommand(brief: string): Record<Command, string[]> {
  const found: Record<Command, string[]> = {
    "attempt acknowledge": [],
    "attempt submit": [],
    "review report": [],
  };
  const parts = brief.split("```");
  for (let index = 1; index < parts.length; index += 2) {
    const command = COMMANDS.find((one) => parts[index]?.includes(` ${one} --request`));
    if (command === undefined) continue;
    const lines = (parts[index + 1] ?? "").replace(/^\n+/, "").split("\n");
    if (lines[0] !== HEADER) continue;
    const rules = lines.slice(2);
    const end = rules.findIndex((line) => !line.startsWith("- `"));
    found[command].push(HEADER, ...rules.slice(0, end === -1 ? undefined : end));
  }
  return found;
}

type Scenario = () => Promise<{ json: { reason: string } }>;

// The refusal is typed against the CLI's own union, so a renamed reason is a compile error here.
type Rule = { refusal: Reason; rule: string; breaks: Scenario };

/**
 * Each scenario breaks exactly one rule of the brief, through the real CLI.
 * The brief must carry exactly these lines in this order, and the command must refuse each
 * broken rule with the name its line gives.
 */
async function expectParity(brief: string, rules: Record<Command, Rule[]>): Promise<void> {
  const written = blocksByCommand(brief);
  for (const command of COMMANDS) {
    const expected = rules[command].map((one) => `- \`${one.refusal}\`: ${one.rule}`);
    expect({ command, block: written[command] }).toEqual({
      command,
      block: expected.length === 0 ? [] : [HEADER, ...expected],
    });
    for (const one of rules[command]) {
      const reported = await one.breaks();
      expect({ command, refusal: one.refusal, reported: reported.json.reason }).toEqual({
        command,
        refusal: one.refusal,
        reported: one.refusal,
      });
    }
  }
}

async function acknowledge(workspace: Workspace, attemptId: string, cwd: string) {
  return runJson(
    workspace,
    ["attempt", "acknowledge", "--request", request(), "--attempt", attemptId],
    cwd,
  );
}

/**
 * The rules of the control reference, which every acknowledge command states.
 * Each scenario restores the reference it changed, so the next rule still reaches its check.
 */
function referenceRules(
  workspace: Workspace,
  operative: { attemptId: string; worktreePath: string },
): Rule[] {
  const path = `${operative.worktreePath}/.operator/local/attempt.json`;
  return [
    {
      refusal: "attempt_reference_missing",
      rule: "Run this and every later command of this brief from this worktree.",
      breaks: () => acknowledge(workspace, operative.attemptId, workspace.root),
    },
    {
      refusal: "attempt_reference_malformed",
      rule: "Never change a file that the Operator wrote under `.operator/local/`.",
      breaks: async () => {
        const written = await Bun.file(path).text();
        await Bun.write(path, "{}\n");
        const reported = await acknowledge(workspace, operative.attemptId, operative.worktreePath);
        await Bun.write(path, written);
        return reported;
      },
    },
    {
      refusal: "attempt_reference_mismatch",
      rule: "`--attempt` is the attempt in the Identity section.",
      breaks: () => acknowledge(workspace, crypto.randomUUID(), operative.worktreePath),
    },
  ];
}

async function submittedResult(workspace: Workspace, producer: Producer) {
  const base = await headCommit(workspace);
  const artifact = await commitArtifact(workspace, producer, "# Result\n");
  const body = submissionBody(producer, artifact);
  return { base, artifact, body };
}

describe("the brief states each refusal beside its command", () => {
  test("the producer brief and the refusals of acknowledge and submit agree", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace, undefined, { acknowledge: false });
    const brief = await Bun.file(`${producer.worktreePath}/.operator/local/brief.md`).text();
    const { body } = await submittedResult(workspace, producer);
    // The submit rules point at the revision in the Identity section, so it must be the one
    // that submit compares.
    expect(brief).toContain(`- Assignment revision: ${producer.assignmentRevision}`);
    expect(brief).toContain(`- Requirements identity: ${REQUIREMENTS_IDENTITY}`);

    await expectParity(brief, {
      "attempt acknowledge": [...referenceRules(workspace, producer)],
      "attempt submit": [
        {
          refusal: "attempt_not_acknowledged",
          rule: "Run this only after the acknowledgement above succeeded.",
          // This scenario runs first, while the attempt is still unacknowledged.
          breaks: () => submit(workspace, producer, body),
        },
        {
          refusal: "result_not_one_commit",
          rule: "A code result is exactly one commit, its parent is the base commit in the Identity section, and `code.baseCommit` and `code.resultCommit` name those two commits.",
          breaks: async () => {
            await acknowledge(workspace, producer.attemptId, producer.worktreePath);
            return submit(workspace, producer, {
              ...body,
              code: { ...body.code, resultCommit: producer.baseCommit },
            });
          },
        },
        {
          refusal: "artifact_unreadable",
          rule: "Each path artifact is a file at its stated path in this worktree.",
          breaks: async () => {
            await acknowledge(workspace, producer.attemptId, producer.worktreePath);
            return submit(workspace, producer, {
              ...body,
              artifacts: [{ ...body.artifacts[0], value: "docs/missing.md" }],
            });
          },
        },
        {
          refusal: "artifact_identity_changed",
          rule: "Each path artifact states the content identity of that file.",
          breaks: () =>
            submit(workspace, producer, {
              ...body,
              artifacts: [{ ...body.artifacts[0], contentIdentity: "0".repeat(64) }],
            }),
        },
        {
          refusal: "stale_revision",
          rule: "`assignmentRevision` is the assignment revision in the Identity section.",
          breaks: () =>
            submit(workspace, producer, {
              ...body,
              assignmentRevision: producer.assignmentRevision + 1,
            }),
        },
        {
          refusal: "source_revision_changed",
          rule: "`sourceRevision` is the source revision in the Identity section.",
          breaks: () => submit(workspace, producer, { ...body, sourceRevision: "rev-2" }),
        },
        {
          refusal: "requirements_changed",
          rule: "`requirementsIdentity` is the requirements identity under Acceptance requirements.",
          breaks: () =>
            submit(workspace, producer, { ...body, requirementsIdentity: "0".repeat(64) }),
        },
        {
          refusal: "behavior_change_basis_missing",
          rule: 'Each entry of `behaviorChanges` names its basis: `{ "kind": "approved-scope" }`, `{ "kind": "requirement", "position": <n> }` for acceptance requirement n above, or `{ "kind": "question", "questionId": "<id>" }` for a question of this assignment whose answer is a requirement or a human answer. An Operator decision is never a basis. `[]` states that there is no behavior change.',
          breaks: () =>
            submit(workspace, producer, {
              ...body,
              behaviorChanges: [
                { statement: "The gate changes.", basis: { kind: "requirement", position: 2 } },
              ],
            }),
        },
        {
          refusal: "project_gate_not_passed",
          rule: "A code result records one check for each project gate command, with the command name as its `name`, and every check with that name has the outcome `passed`.",
          breaks: () =>
            submit(workspace, producer, {
              ...body,
              checks: [
                { name: "quality", command: "bun run quality", outcome: "failed", detail: "" },
              ],
            }),
        },
      ],
      "review report": [],
    });
    // Every refusal left the attempt running, so the result that keeps every rule submits.
    expect((await submit(workspace, producer, body)).json.reason).toBe("result_submitted");
  });

  test("the review brief and the refusals of acknowledge and report agree", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const { artifact, body } = await submittedResult(workspace, producer);
    const submitted = await submit(workspace, producer, body);
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit, {
      acknowledge: false,
    });
    const brief = await Bun.file(`${reviewer.worktreePath}/.operator/local/brief.md`).text();
    const reviewId = submitted.json.data.reviewId;
    const report = (overrides: object = {}) =>
      reportReview(workspace, reviewer, reviewId, {
        ...reportBody({ submissionIdentity: submitted.json.data.identity, host: workspace.host }),
        ...overrides,
      });
    const reportWith = (options: Partial<Parameters<typeof reportBody>[0]>) =>
      reportReview(
        workspace,
        reviewer,
        reviewId,
        reportBody({
          submissionIdentity: submitted.json.data.identity,
          host: workspace.host,
          ...options,
        }),
      );

    await expectParity(brief, {
      "attempt acknowledge": [...referenceRules(workspace, reviewer)],
      // The reviewer receives none of the producer's rules.
      "attempt submit": [],
      "review report": [
        {
          refusal: "attempt_not_acknowledged",
          rule: "Run this only after the acknowledgement above succeeded.",
          // This scenario runs first, while the attempt is still unacknowledged.
          breaks: () => report(),
        },
        {
          refusal: "review_worktree_changed",
          rule: "Never edit a file or commit in this checkout.",
          breaks: async () => {
            await acknowledge(workspace, reviewer.attemptId, reviewer.worktreePath);
            const edit = `${reviewer.worktreePath}/modules/edit.ts`;
            await Bun.write(edit, "export {};\n");
            const reported = await report();
            await rm(edit);
            return reported;
          },
        },
        {
          refusal: "submission_drift",
          rule: "`submissionIdentity` is the identity of the submission above.",
          breaks: () => reportWith({ submissionIdentity: "0".repeat(64) }),
        },
        {
          refusal: "review_host_mismatch",
          rule: "`host` is the crew host under Effective configuration.",
          breaks: () => reportWith({ statedHost: "opencode" }),
        },
        {
          refusal: "review_axes_incomplete",
          rule: "`reports` and `subAgents` each name every axis exactly once.",
          breaks: () => {
            const full = reportBody({
              submissionIdentity: submitted.json.data.identity,
              host: workspace.host,
            });
            // Two reports of one axis keep the shape and leave the other axis unreported.
            return report({ reports: [full.reports[0], full.reports[0]] });
          },
        },
        {
          refusal: "review_sub_agent_host_mismatch",
          rule: "Every sub-agent runs on that same host.",
          breaks: () => reportWith({ subAgentHost: "opencode" }),
        },
        {
          refusal: "review_sub_agent_failed",
          rule: "Every sub-agent completed. If one could not, record the blocker below instead.",
          breaks: () => reportWith({ failedAxis: "spec" }),
        },
        {
          refusal: "review_axes_not_parallel",
          rule: "The two sub-agent windows overlap, because the two axes run at the same time.",
          breaks: () => reportWith({ sequential: true }),
        },
        {
          refusal: "review_coverage_incomplete",
          rule: "Each axis states in `checked` every reading that this result kind requires.",
          breaks: () => reportWith({ checked: ["diff"] }),
        },
        {
          refusal: "review_published_text_missing",
          rule: "`published` holds the pull request text when the brief asks for it.",
          // This result is the only code result of its source, so its brief asks for the text.
          breaks: () => reportWith({ published: null }),
        },
      ],
    });
    // A producer launch rule written as prose is still a producer rule, so none appears at all.
    for (const producerRule of [
      "attempt submit",
      "artifact_unreadable",
      "stale_revision",
      "requirements_changed",
      "A code result is exactly one commit",
    ]) {
      expect(brief).not.toContain(producerRule);
    }
    expect(brief).toContain("Never push, and never perform rework.");

    // Every refusal left the review open, so the report that keeps every rule records.
    expect((await report()).json.reason).toBe("review_reported");
  });
});

describe("the review brief", () => {
  test("names a fixed copy of the spec, its fixed point, and the read commands", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const { base, artifact, body } = await submittedResult(workspace, producer);
    const submitted = await submit(workspace, producer, body);
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);

    const brief = await Bun.file(`${reviewer.worktreePath}/.operator/local/brief.md`).text();
    expect(brief).toContain(
      `- Spec: .operator/local/review/spec.md (requirements ${REQUIREMENTS_IDENTITY}).`,
    );
    expect(brief).toContain(`- Fixed point: ${base}`);
    // The read commands are authorized, not only named, so the reviewer can follow its skill.
    expect(brief).toContain(
      [
        "Run only these commands:",
        "- operator attempt acknowledge",
        "- operator review report",
        `- git rev-parse ${base}`,
        `- git diff ${base}...HEAD`,
        `- git log ${base}..HEAD --oneline`,
        "- true",
        "- bun run quality",
      ].join("\n"),
    );
    expect(brief).toContain(`  - git diff ${base}...HEAD`);

    // The copy is bound by the requirements identity that the submission recorded.
    const spec = await Bun.file(`${reviewer.worktreePath}/.operator/local/review/spec.md`).text();
    expect(spec).toContain("## Approved scope\n\nBuild the reviewed result path.");
    expect(spec).toContain(`- ${REQUIREMENTS.join("\n- ")}`);
    expect(spec).toContain(`Requirements identity: ${body.requirementsIdentity}`);
    expect(spec).toContain("- brief (value): the brief");
  });

  test("names no fixed point and no read command for a result that is not code", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const { artifact, body } = await submittedResult(workspace, producer);
    const submitted = await submit(workspace, producer, {
      ...body,
      resultKind: "non-code",
      checks: [],
      code: null,
    });
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);

    const brief = await Bun.file(`${reviewer.worktreePath}/.operator/local/brief.md`).text();
    expect(brief).toContain("- Fixed point: none, because this result is not code.");
    expect(brief).not.toContain("git diff");
    expect(brief).toContain("- Spec: .operator/local/review/spec.md");
    expect(brief).toContain("Do not create a commit merely to obtain a diff.");
  });
});

describe("every brief", () => {
  test("tells the producer and the reviewer never to address the person", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const { artifact, body } = await submittedResult(workspace, producer);
    const submitted = await submit(workspace, producer, body);
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);

    const rule = "Never address the person yourself.\nOnly the Operator talks to the person";
    for (const worktree of [producer.worktreePath, reviewer.worktreePath]) {
      expect(await Bun.file(`${worktree}/.operator/local/brief.md`).text()).toContain(rule);
    }
  });
});

/** The one value a brief line states after its label, or a failure that names the label. */
function stated(brief: string, pattern: RegExp): string[] {
  const found = brief.match(pattern);
  if (found === null) throw new Error(`The brief states no ${pattern}.`);
  return found.slice(1);
}

/**
 * The arguments of one command the brief writes, with its placeholders filled.
 * The test runs the command as the brief words it, so a brief that names the wrong attempt or
 * the wrong flag fails here.
 */
function briefCommand(brief: string, command: string, input: string | null): string[] {
  const block = brief.split("```").find((part) => part.includes(` ${command} --request`));
  if (block === undefined) throw new Error(`The brief writes no ${command} command.`);
  const line = block.trim();
  const words = line
    .slice(line.indexOf(command))
    .replace("<a new identity you generate>", request())
    .replace("<path>", input ?? "<path>")
    .split(" ");
  // The runner adds the JSON flag itself.
  return words.filter((word) => word !== "--json");
}

describe("an Operative works from its brief", () => {
  test("acknowledges, asks, and submits through the CLI with only the brief", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace, undefined, { acknowledge: false });
    const worktree = producer.worktreePath;
    const brief = await Bun.file(`${worktree}/.operator/local/brief.md`).text();

    // The shipped workflow never sends the Operative to the control reference.
    const skill = await Bun.file(`${worktree}/.claude/skills/operative/SKILL.md`).text();
    for (const text of [brief, skill]) {
      expect(text).not.toContain("attempt.json");
      expect(text).not.toContain("control reference");
    }

    const [attemptId] = stated(brief, /^- Attempt: (\S+)$/m);
    const [revision] = stated(brief, /^- Assignment revision: (\d+)$/m);
    const [sourceRevision] = stated(brief, /^- Source: .* at revision (\S+)$/m);
    const [branch, baseCommit] = stated(brief, /^- Branch: (\S+) from commit (\S+)$/m);
    const [requirementsIdentity] = stated(brief, /^- Requirements identity: (\S+)$/m);
    const gate = [...brief.matchAll(/^- `([^`]+)`: `([^`]+)` \(time limit \d+ seconds\)$/gm)];
    expect(gate.length).toBeGreaterThan(0);
    const outbox = `${worktree}/.operator/local/outbox`;
    const run = async (command: string, body: unknown = null) => {
      let input: string | null = null;
      if (body !== null) {
        input = `${outbox}/${crypto.randomUUID()}.json`;
        await Bun.write(input, JSON.stringify(body));
      }
      return runJson(workspace, briefCommand(brief, command, input), worktree);
    };

    expect((await run("attempt acknowledge")).json.reason).toBe("attempt_acknowledged");

    const raised = await run("question raise", {
      question: "Does the result keep the old heading?",
      evidence: [{ label: "scope", detail: "The scope names no heading." }],
      options: [
        { name: "keep", detail: "Keep the heading.", risk: "None." },
        { name: "drop", detail: "Drop the heading.", risk: "Readers lose it." },
      ],
      recommendation: "Keep the heading.",
      affectedScope: ["docs/result.md"],
      independentWork: ["The result text continues."],
      escalationTriggers: [],
    });
    expect(raised.json.reason).toBe("question_raised");

    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await run("attempt submit", {
      resultKind: "code",
      assignmentRevision: Number(revision),
      sourceRevision,
      requirementsIdentity,
      artifacts: [
        { name: "result", kind: "path", value: artifact.path, contentIdentity: artifact.identity },
      ],
      checks: gate.map(([, name, command]) => ({ name, command, outcome: "passed", detail: "" })),
      concerns: [],
      decisions: [],
      behaviorChanges: [],
      code: { baseCommit, resultCommit: artifact.commit, mergeBase: baseCommit, branch },
    });
    expect({ attemptId, reason: submitted.json.reason }).toEqual({
      attemptId: producer.attemptId,
      reason: "result_submitted",
    });
  });
});
