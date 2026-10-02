import { Database } from "bun:sqlite";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  headCommit,
  requestId as request,
  runJson,
  runOperator,
  workspaces,
} from "./workspace-fixture.ts";
import {
  commitArtifact,
  makeReviewWorkspace,
  type Producer,
  reportBody,
  reportReview,
  startProducer,
  startReviewer,
  submissionBody,
  submit,
  type Workspace,
  writeInput,
} from "./review-cycle-fixture.ts";

// Each test creates a Git worktree and runs several CLI processes under the parallel CI gate.
setDefaultTimeout(60_000);

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

function reasons(result: { json: { blockers: Array<{ reason: string }> } }): string[] {
  return result.json.blockers.map((one) => one.reason);
}

/** Raises one question from the producer worktree and records its answer. */
async function answeredQuestion(
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
  expect(answered.json.reason).toBe("answer_recorded");

  return questionId;
}

describe("operator attempt submit reads the behavior changes", () => {
  test("refuses a submission with no behaviorChanges field", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const { behaviorChanges: _none, ...body } = submissionBody(producer, artifact);

    const refused = await submit(workspace, producer, body);

    expect(refused.exitCode).toBe(2);
    expect(refused.json.reason).toBe("invalid_submission_input");
  });

  test("refuses a basis of the kind Operator decision as invalid input", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");

    const refused = await submit(
      workspace,
      producer,
      submissionBody(producer, artifact, {
        behaviorChanges: [
          { statement: "The heading changes.", basis: { kind: "operator-decision" } },
        ],
      }),
    );

    expect(refused.exitCode).toBe(2);
    expect(refused.json.reason).toBe("invalid_submission_input");
  });

  test("refuses an unknown requirement position and an unknown question, and names each one", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");

    const body = submissionBody(producer, artifact, {
      behaviorChanges: [
        { statement: "The gate runs once.", basis: { kind: "requirement", position: 1 } },
        { statement: "The heading changes.", basis: { kind: "requirement", position: 2 } },
        { statement: "The footer goes.", basis: { kind: "question", questionId: "nope" } },
      ],
    });
    const refused = await submit(workspace, producer, body);

    expect(refused.exitCode).toBe(4);
    expect(refused.json.reason).toBe("behavior_change_basis_missing");
    expect(refused.json.blockers).toEqual([
      {
        reason: "behavior_change_basis_missing",
        entries: [
          {
            position: 2,
            statement: "The heading changes.",
            basis: { kind: "requirement", position: 2 },
            detail: "This assignment holds 1 acceptance requirement(s).",
          },
          {
            position: 3,
            statement: "The footer goes.",
            basis: { kind: "question", questionId: "nope" },
            detail: "No question of this assignment has this id.",
          },
        ],
      },
    ]);
    const plain = await runOperator(
      workspace,
      [
        "attempt",
        "submit",
        "--request",
        request(),
        "--attempt",
        producer.attemptId,
        "--input",
        await writeInput(workspace, body),
      ],
      producer.worktreePath,
    );
    expect(plain.stdout).toContain(
      "behavior_change_basis_missing: entry 2 (This assignment holds 1 acceptance requirement(s).), entry 3",
    );

    // A refusal records nothing, so the attempt keeps running.
    const shown = await runJson(workspace, ["attempt", "show", "--attempt", producer.attemptId]);
    expect(shown.json.data.current).toBe(true);
  });

  test("refuses a question of another assignment, even with a human answer", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const questionId = await answeredQuestion(workspace, producer, "human-answer");
    // The question now belongs to another assignment, as a question of a sibling item does.
    const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`);
    sqlite
      .query("update questions set assignment_id = 'another-assignment' where id = ?")
      .run(questionId);
    sqlite.close();
    const artifact = await commitArtifact(workspace, producer, "# Result\n");

    const refused = await submit(
      workspace,
      producer,
      submissionBody(producer, artifact, {
        behaviorChanges: [
          { statement: "The heading changes.", basis: { kind: "question", questionId } },
        ],
      }),
    );

    expect(refused.exitCode).toBe(4);
    expect(refused.json.blockers).toEqual([
      {
        reason: "behavior_change_basis_missing",
        entries: [
          expect.objectContaining({
            position: 1,
            detail: "No question of this assignment has this id.",
          }),
        ],
      },
    ]);
  });

  test("refuses a question whose answer is an Operator decision", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const questionId = await answeredQuestion(workspace, producer, "operator-decision");
    const artifact = await commitArtifact(workspace, producer, "# Result\n");

    const refused = await submit(
      workspace,
      producer,
      submissionBody(producer, artifact, {
        behaviorChanges: [
          { statement: "The heading changes.", basis: { kind: "question", questionId } },
        ],
      }),
    );

    expect(refused.exitCode).toBe(4);
    expect(refused.json.blockers).toEqual([
      expect.objectContaining({
        reason: "behavior_change_basis_missing",
        entries: [
          expect.objectContaining({
            position: 1,
            detail: "The answer of this question is an Operator decision, which is never a basis.",
          }),
        ],
      }),
    ]);
  });

  test("checks the basis last, after the commit shape and the write paths", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);

    const refused = await submit(
      workspace,
      producer,
      submissionBody(
        producer,
        { path: "docs/result.md", identity: "none", commit: base },
        {
          behaviorChanges: [
            { statement: "The heading changes.", basis: { kind: "requirement", position: 9 } },
          ],
        },
      ),
    );

    expect(reasons(refused)).toEqual([
      "result_not_one_commit",
      "result_check_not_run",
      "behavior_change_basis_missing",
    ]);
  });

  test("records an empty list as none, and the review brief and record show it", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");

    const submitted = await submit(
      workspace,
      producer,
      submissionBody(producer, artifact, { behaviorChanges: [] }),
    );
    expect(submitted.json.reason).toBe("result_submitted");

    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);
    const brief = await Bun.file(`${reviewer.worktreePath}/.operator/local/brief.md`).text();
    expect(brief).toContain(
      "### Behavior changes\n\nThe producer states that this result has no behavior change.\n",
    );

    const shown = await runJson(workspace, [
      "review",
      "show",
      "--review",
      submitted.json.data.reviewId,
    ]);
    expect(shown.json.data.submission.behaviorChanges).toEqual([]);
  });

  test("records each basis kind, and the review brief lists each entry with its basis", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const questionId = await answeredQuestion(workspace, producer, "human-answer");
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const behaviorChanges = [
      { statement: "The path reports a review.", basis: { kind: "approved-scope" } },
      { statement: "The gate refuses a red run.", basis: { kind: "requirement", position: 1 } },
      { statement: "The heading changes.", basis: { kind: "question", questionId } },
    ];

    const submitted = await submit(
      workspace,
      producer,
      submissionBody(producer, artifact, { behaviorChanges }),
    );
    expect(submitted.json.reason).toBe("result_submitted");

    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);
    const brief = await Bun.file(`${reviewer.worktreePath}/.operator/local/brief.md`).text();
    expect(brief).toContain(
      [
        "- The path reports a review. (basis: the approved scope)",
        "- The gate refuses a red run. (basis: acceptance requirement 1)",
        `- The heading changes. (basis: question ${questionId})`,
      ].join("\n"),
    );
    expect(brief).toContain("A behavior change is a difference, compared with the base,");

    const shown = await runJson(workspace, [
      "review",
      "show",
      "--review",
      submitted.json.data.reviewId,
    ]);
    expect(shown.json.data.submission.behaviorChanges).toEqual(behaviorChanges);
  });
});

describe("operator review report reads the behavior-changes coverage token", () => {
  test("refuses an axis that does not state behavior-changes, for both result kinds", async () => {
    for (const resultKind of ["code", "non-code"] as const) {
      const workspace = await makeReviewWorkspace(fixtures);
      const producer = await startProducer(workspace);
      const artifact = await commitArtifact(workspace, producer, "# Result\n");
      const submitted = await submit(
        workspace,
        producer,
        submissionBody(
          producer,
          artifact,
          resultKind === "code" ? {} : { resultKind, checks: [], code: null },
        ),
      );
      const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);
      const brief = await Bun.file(`${reviewer.worktreePath}/.operator/local/brief.md`).text();
      expect(brief).toContain("behavior-changes in `checked`");

      const tokens =
        resultKind === "code"
          ? ["diff", "requirements", "checks"]
          : ["artifacts", "requirements", "citations", "provenance"];
      const refused = await reportReview(
        workspace,
        reviewer,
        submitted.json.data.reviewId,
        reportBody({
          submissionIdentity: submitted.json.data.identity,
          host: workspace.host,
          checked: tokens,
        }),
      );
      expect(refused.json.reason).toBe("review_coverage_incomplete");
      expect(refused.json.blockers[0].missing).toEqual(["behavior-changes"]);

      const reported = await reportReview(
        workspace,
        reviewer,
        submitted.json.data.reviewId,
        reportBody({
          submissionIdentity: submitted.json.data.identity,
          host: workspace.host,
          checked: [...tokens, "behavior-changes"],
        }),
      );
      expect(reported.json.reason).toBe("review_reported");
    }
  });

  test("a submission recorded before the list existed needs no behavior-changes token", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact));
    // An earlier release recorded no list, and the migration keeps none (ADR 0018).
    const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`);
    sqlite.query("update submissions set behavior_changes = null").run();
    sqlite.close();
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);

    const reported = await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      reportBody({
        submissionIdentity: submitted.json.data.identity,
        host: workspace.host,
        checked: ["diff", "requirements", "checks"],
      }),
    );

    expect(reported.json.reason).toBe("review_reported");
  });
});
