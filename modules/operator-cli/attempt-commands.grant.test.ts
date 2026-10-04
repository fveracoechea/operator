import { afterEach, describe, expect, test as bunTest } from "bun:test";
import {
  acceptReview,
  commitArtifact,
  delegateRework,
  disposeFindings,
  makeReviewWorkspace,
  type Producer,
  reportBody,
  reportReview,
  startProducer,
  startRework,
  startReviewer,
  submissionBody,
  submit,
  type Workspace,
  writeInput,
} from "./review-cycle-fixture.ts";
import { requestId as request, runJson, workspaces } from "./workspace-fixture.ts";

// Each test runs a producer, and one runs a full review and rework cycle, as CLI processes.
// Each test states its own bound, because a process-wide default would set the bound of every
// file in the bun test process (#179).
function test(name: string, run: () => Promise<void> | void, timeoutMs = 60_000) {
  bunTest(name, run, timeoutMs);
}

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

/** Asks the CLI for the exact request, then records the person's grant of those paths. */
async function grantPaths(workspace: Workspace, producer: Producer, paths: string[]) {
  const asked = await runJson(workspace, [
    "work",
    "write-paths",
    "--assignment",
    producer.assignmentId,
    "--input",
    await writeInput(workspace, { paths }),
  ]);
  return runJson(workspace, [
    "approval",
    "grant",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--input",
    await writeInput(workspace, {
      ...asked.json.data.grant.approval,
      exactText: `Yes, it may also write ${paths.join(" and ")}.`,
      grantedBy: "human",
    }),
  ]);
}

/** Commits more files into the result, beside its artifact. */
async function commitWith(producer: Producer, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    await Bun.write(`${producer.worktreePath}/${path}`, text);
    await Bun.$`git -C ${producer.worktreePath} add ${path}`.quiet();
  }
}

describe("operator attempt submit reads the effective write paths", () => {
  test("accepts a file inside a granted path and refuses one outside every path", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    await commitWith(producer, { "notes/granted.md": "granted\n", "src/other.ts": "other\n" });
    const artifact = await commitArtifact(workspace, producer, "# Result\n");

    const before = await submit(workspace, producer, submissionBody(producer, artifact));
    expect(before.json.blockers).toEqual([
      {
        reason: "outside_write_paths",
        paths: ["notes/granted.md", "src/other.ts"],
        writePaths: ["docs/"],
      },
    ]);

    const granted = await grantPaths(workspace, producer, ["notes/"]);
    expect(granted.json.reason).toBe("approval_granted");

    const after = await submit(workspace, producer, submissionBody(producer, artifact));
    expect(after.exitCode).toBe(4);
    expect(after.json.blockers).toEqual([
      { reason: "outside_write_paths", paths: ["src/other.ts"], writePaths: ["docs/", "notes/"] },
    ]);
  });

  test("a revoked grant and a grant bound to other write paths widen nothing", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    await commitWith(producer, { "notes/granted.md": "granted\n" });
    const artifact = await commitArtifact(workspace, producer, "# Result\n");

    const granted = await grantPaths(workspace, producer, ["notes/"]);
    await runJson(workspace, [
      "approval",
      "revoke",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--approval",
      granted.json.data.approvalId,
      "--revision",
      "1",
    ]);
    // The same grant, bound to another list of registered paths than the one this assignment holds.
    await runJson(workspace, [
      "approval",
      "grant",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--input",
      await writeInput(workspace, {
        action: "write-paths-grant",
        targets: ["notes/"],
        scope: producer.assignmentId,
        requestRevision: "another-list-of-write-paths",
        exactText: "Yes.",
        grantedBy: "human",
      }),
    ]);

    const refused = await submit(workspace, producer, submissionBody(producer, artifact));

    expect(refused.json.blockers).toEqual([
      { reason: "outside_write_paths", paths: ["notes/granted.md"], writePaths: ["docs/"] },
    ]);
  });

  test("a change to the registered write paths makes the grant stop applying", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    await commitWith(producer, { "notes/granted.md": "granted\n" });
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    await grantPaths(workspace, producer, ["notes/"]);

    // Registration keeps the paths it first recorded, so the state is changed here directly.
    await Bun.$`bun -e ${`
      const { Database } = require("bun:sqlite");
      const db = new Database(${JSON.stringify(`${workspace.repo}/.operator/local/crew-state.sqlite`)});
      db.query("update assignments set permissions = ? where id = ?").run(
        JSON.stringify({ writePaths: ["docs/", "skills/"], allowedCommands: ["bun test"], network: false }),
        ${JSON.stringify(producer.assignmentId)},
      );
      db.close();
    `}`.quiet();

    const refused = await submit(workspace, producer, submissionBody(producer, artifact));

    expect(refused.json.blockers).toEqual([
      {
        reason: "outside_write_paths",
        paths: ["notes/granted.md"],
        writePaths: ["docs/", "skills/"],
      },
    ]);
  });
});

describe("a write-paths grant across a rework cycle", () => {
  test("covers the rework attempt, and its brief states the effective write paths", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const first = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, first));
    const reviewer = await startReviewer(workspace, producer, submitted.json, first.commit);
    const reported = await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      reportBody({
        submissionIdentity: submitted.json.data.identity,
        host: workspace.host,
        standardsFindings: [
          {
            key: "missing-note",
            severity: "blocker",
            summary: "The result needs its note.",
            evidence: "docs/result.md:1",
          },
        ],
        specFindings: [],
      }),
    );
    await disposeFindings(workspace, producer, submitted.json.data.reviewId, [
      {
        findingId: reported.json.data.findings[0].findingId,
        disposition: "corrected",
        reason: "The note belongs to the result.",
      },
    ]);
    await acceptReview(workspace, producer, {
      reviewAssignmentId: submitted.json.data.reviewAssignmentId,
      attemptId: reviewer.attemptId,
      revision: reviewer.revision,
    });

    // The grant is given while the first result waits, and it is bound to the registered paths.
    const granted = await grantPaths(workspace, producer, ["notes/note.md"]);
    expect(granted.json.reason).toBe("approval_granted");

    const delegated = await delegateRework(workspace, producer, {
      revision: submitted.json.data.revision,
      body: {
        reason: "findings",
        reviewId: submitted.json.data.reviewId,
        conflicts: [],
      },
    });
    const reworked = await startRework(workspace, producer, {
      revision: delegated.json.data.revision,
      commit: first.commit,
      worktreePath: `${workspace.root}/rework`,
    });

    const brief = await Bun.file(`${reworked.worktreePath}/.operator/local/brief.md`).text();
    expect(brief).toContain("Write only inside these paths:\n- docs/\n- notes/note.md\n");

    await commitWith(reworked, { "notes/note.md": "the note\n" });
    const artifact = await commitArtifact(workspace, reworked, "# Result with its note\n");
    const resubmitted = await submit(
      workspace,
      reworked,
      submissionBody(reworked, artifact, { assignmentRevision: reworked.assignmentRevision }),
    );
    expect(resubmitted.json.reason).toBe("result_submitted");
  });
});
