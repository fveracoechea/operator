import { Database } from "bun:sqlite";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { ContentIdentity } from "../content-identity/main.ts";
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
} from "./review-cycle-fixture.ts";
import {
  planSource,
  registerSource,
  seedSource,
  sourceIdOf,
  sourceInput,
  workspaceTarget,
  writeInput as writeSourceInput,
} from "./source-fixture.ts";
import {
  FIXTURE_GATE,
  headCommit,
  nextActions,
  ownCrew,
  passBaseGate,
  requestId as request,
  runJson,
  workspaces,
} from "./workspace-fixture.ts";

// Each test drives real dispatches, a real gate run, and real Git through separate CLI processes.
setDefaultTimeout(120_000);

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

const SOURCE = sourceIdOf(15);
const BRANCH = "operator/integration/fveracoechea-operator-15";

/** The commit a local branch holds, or null when it does not exist. */
async function branchTip(workspace: Workspace, name = BRANCH): Promise<string | null> {
  const read = await Bun.$`git -C ${workspace.repo} rev-parse --verify --quiet refs/heads/${name}`
    .quiet()
    .nothrow();
  return read.exitCode === 0 ? read.stdout.toString().trim() : null;
}

type BranchRow = {
  name: string;
  base_commit: string;
  recorded_tip: string;
  gate_identity: string;
  gate_commands: string;
};

function statePath(workspace: Workspace): string {
  return `${workspace.repo}/.operator/local/crew-state.sqlite`;
}

function branchRow(workspace: Workspace): BranchRow | null {
  const sqlite = new Database(statePath(workspace), { readonly: true });
  const row = sqlite
    .query("select * from integration_branches where source_id = ?")
    .get(SOURCE) as BranchRow | null;
  sqlite.close();
  return row;
}

/** A producer with a second item of the same source that needs nothing and writes elsewhere. */
async function producerWithSibling(workspace: Workspace) {
  return startProducer(workspace, undefined, {
    dependents: [
      {
        key: "22.2",
        title: "Build the sibling result",
        kind: "production",
        dependsOn: [],
        writePaths: ["notes/"],
      },
    ],
  });
}

async function claimSibling(workspace: Workspace, producer: Producer) {
  const claimed = await runJson(workspace, [
    "work",
    "claim",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--assignment",
    producer.dependents.get("22.2") ?? "",
    "--revision",
    "1",
  ]);
  return claimed.json.data.attemptId as string;
}

async function dispatch(
  workspace: Workspace,
  producer: Producer,
  attemptId: string,
  commit: string | null,
) {
  return runJson(workspace, [
    "attempt",
    "dispatch",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--attempt",
    attemptId,
    ...(commit === null ? [] : ["--commit", commit]),
    "--worktree",
    `${workspace.root}/sibling`,
  ]);
}

/** Registers one ticket of a repository and dispatches it, the first code dispatch of its source. */
async function firstDispatch(
  workspace: Workspace,
  ownerToken: string,
  ticket: { repository: string; number: number },
) {
  const registered = await registerSource(workspaceTarget(workspace), ownerToken, {
    sourceKind: "ticket",
    parent: ticket.number,
    repository: ticket.repository,
    items: [
      {
        key: "ticket",
        permissions: {
          writePaths: [`notes/${ticket.number}/`],
          allowedCommands: ["bun test"],
          network: false,
        },
      },
    ],
  });
  const claimed = await runJson(workspace, [
    "work",
    "claim",
    "--request",
    request(),
    "--owner-token",
    ownerToken,
    "--assignment",
    registered.keys.get("ticket") ?? "",
    "--revision",
    "1",
  ]);
  const attemptId: string = claimed.json.data.attemptId;
  const commit = await headCommit(workspace);
  await passBaseGate(workspace, { ownerToken, attemptId, commit });
  return runJson(workspace, [
    "attempt",
    "dispatch",
    "--request",
    request(),
    "--owner-token",
    ownerToken,
    "--attempt",
    attemptId,
    "--commit",
    commit,
    "--worktree",
    `${workspace.root}/ticket-${crypto.randomUUID()}`,
  ]);
}

/** A person commits on the main checkout, as work outside Operator would. */
async function commitOnMain(workspace: Workspace, path: string, text: string): Promise<string> {
  await Bun.write(`${workspace.repo}/${path}`, text);
  await Bun.$`git -C ${workspace.repo} add ${path}`.quiet();
  await Bun.$`git -C ${workspace.repo} -c user.email=p@example.com -c user.name=Person commit -m ${`change ${path}`}`.quiet();
  return headCommit(workspace);
}

describe("the integration branch of a source", () => {
  test("the first code dispatch creates the branch at the gated base, and nothing pushes it", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const remote = `${workspace.root}/remote.git`;
    await Bun.$`git init --quiet --bare ${remote}`.quiet();
    await Bun.$`git -C ${workspace.repo} remote add origin ${remote}`.quiet();

    expect(await branchTip(workspace)).toBeNull();
    const producer = await startProducer(workspace);
    expect(producer.dispatched.outcome).toBe("pending");

    expect(await branchTip(workspace)).toBe(producer.baseCommit);
    const row = branchRow(workspace);
    expect(row).toMatchObject({
      name: BRANCH,
      base_commit: producer.baseCommit,
      recorded_tip: producer.baseCommit,
      gate_identity: ContentIdentity.of(FIXTURE_GATE.commands),
    });
    expect(JSON.parse(row?.gate_commands ?? "null")).toEqual(FIXTURE_GATE.commands);

    // Nothing pushes before publish, so the remote holds no branch at all.
    const remoteRefs = await Bun.$`git -C ${workspace.repo} ls-remote origin`.quiet().text();
    expect(remoteRefs).toBe("");
  });

  test("a later production dispatch starts from the recorded tip and refuses another commit", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await producerWithSibling(workspace);
    const elsewhere = await commitOnMain(workspace, "notes/person.md", "# Person\n");
    const attemptId = await claimSibling(workspace, producer);

    const next = await nextActions(workspace);
    expect(next.of("dispatch_attempt")?.detail).toContain(
      `It starts from ${producer.baseCommit}, the recorded tip of ${BRANCH}`,
    );

    const refused = await dispatch(workspace, producer, attemptId, elsewhere);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.json).toMatchObject({
      outcome: "conflict",
      reason: "dispatch_base_not_tip",
      blockers: [{ branch: BRANCH, recordedTip: producer.baseCommit, requested: elsewhere }],
    });
    expect(await Bun.file(`${workspace.root}/sibling/.git`).exists()).toBe(false);

    const started = await dispatch(workspace, producer, attemptId, null);
    expect(started.json.outcome).toBe("pending");
    expect(started.json.data.baseCommit).toBe(producer.baseCommit);
    expect(await headCommit(workspace, `${workspace.root}/sibling`)).toBe(producer.baseCommit);
  });

  test("a branch that a person moved stops dispatch, names both tips, and stays where it is", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await producerWithSibling(workspace);
    const moved = await commitOnMain(workspace, "notes/person.md", "# Person\n");
    await Bun.$`git -C ${workspace.repo} branch --force ${BRANCH} ${moved}`.quiet();
    const holder = `${workspace.root}/holder`;
    await Bun.$`git -C ${workspace.repo} worktree add --quiet ${holder} ${BRANCH}`.quiet();
    const attemptId = await claimSibling(workspace, producer);

    const refused = await dispatch(workspace, producer, attemptId, null);
    expect(refused.json).toMatchObject({
      outcome: "conflict",
      reason: "integration_branch_moved",
      blockers: [{ branch: BRANCH, recordedTip: producer.baseCommit, found: moved }],
    });
    const realHolder = (await Bun.$`realpath ${holder}`.quiet().text()).trim();
    expect(refused.json.blockers[0].checkedOut).toEqual([realHolder]);
    expect(await Bun.file(`${workspace.root}/sibling/.git`).exists()).toBe(false);

    // Operator never resets the branch and never adopts the tip it found.
    expect(await branchTip(workspace)).toBe(moved);
    expect(branchRow(workspace)?.recorded_tip).toBe(producer.baseCommit);
    const again = await dispatch(workspace, producer, attemptId, moved);
    expect(again.json.reason).toBe("integration_branch_moved");
    expect(await branchTip(workspace)).toBe(moved);

    // A person puts it back, and the dispatch starts from the recorded tip.
    await Bun.$`git -C ${workspace.repo} worktree remove --force ${holder}`.quiet();
    await Bun.$`git -C ${workspace.repo} branch --force ${BRANCH} ${producer.baseCommit}`.quiet();
    const started = await dispatch(workspace, producer, attemptId, null);
    expect(started.json.outcome).toBe("pending");
  });

  test("a branch that already exists at another commit is never taken over", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const base = await headCommit(workspace);
    const person = await commitOnMain(workspace, "notes/person.md", "# Person\n");
    await Bun.$`git -C ${workspace.repo} reset --quiet --hard ${base}`.quiet();
    await Bun.$`git -C ${workspace.repo} branch ${BRANCH} ${person}`.quiet();

    const producer = await startProducer(workspace, undefined, { acknowledge: false });
    expect(producer.dispatched).toMatchObject({
      outcome: "conflict",
      reason: "integration_branch_exists",
      blockers: [{ branch: BRANCH, base, found: person }],
    });
    expect(await branchTip(workspace)).toBe(person);
    expect(branchRow(workspace)).toBeNull();
  });

  test("two sources whose ids share a long prefix each record their own branch", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const ownerToken = await ownCrew(workspace);
    // The first 40 characters of both ids are the same.
    const repository = "org-with-long-name/long-repository-name";

    for (const number of [101, 102]) {
      const dispatched = await firstDispatch(workspace, ownerToken, { repository, number });
      expect(dispatched.json.outcome).toBe("pending");
    }

    const sqlite = new Database(statePath(workspace), { readonly: true });
    const rows = sqlite
      .query("select source_id, name from integration_branches order by source_id")
      .all() as Array<{ source_id: string; name: string }>;
    sqlite.close();
    expect(rows.map((one) => one.source_id)).toEqual([
      sourceIdOf(101, repository),
      sourceIdOf(102, repository),
    ]);
    expect(new Set(rows.map((one) => one.name)).size).toBe(2);
    for (const one of rows) {
      expect(await branchTip(workspace, one.name)).not.toBeNull();
    }
  });

  test("two sources whose ids differ only in punctuation each record their own branch", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const ownerToken = await ownCrew(workspace);

    for (const repository of ["fveracoechea/tools.x", "fveracoechea/tools-x"]) {
      const dispatched = await firstDispatch(workspace, ownerToken, { repository, number: 7 });
      expect(dispatched.json.outcome).toBe("pending");
    }

    const sqlite = new Database(statePath(workspace), { readonly: true });
    const names = sqlite.query("select name from integration_branches").all() as Array<{
      name: string;
    }>;
    sqlite.close();
    expect(new Set(names.map((one) => one.name)).size).toBe(2);
  });

  test("a branch name that another source records stops the dispatch and drops no record", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const ownerToken = await ownCrew(workspace);
    const other = await registerSource(workspaceTarget(workspace), ownerToken, {
      sourceKind: "ticket",
      parent: 40,
      items: [{ key: "ticket" }],
    });
    expect(other.exitCode).toBe(0);
    // The record that an earlier release could leave: the other source holds this name.
    const base = await headCommit(workspace);
    const sqlite = new Database(statePath(workspace));
    sqlite
      .query(
        "insert into integration_branches (source_id, name, base_commit, recorded_tip, gate_identity, gate_commands, fixed_at, updated_at) values (?, ?, ?, ?, 'gate', '[]', 'now', 'now')",
      )
      .run(sourceIdOf(40), BRANCH, base, base);
    sqlite.close();

    const dispatched = await firstDispatch(workspace, ownerToken, {
      repository: "fveracoechea/operator",
      number: 15,
    });
    expect(dispatched.json).toMatchObject({
      outcome: "conflict",
      reason: "integration_branch_held",
      blockers: [{ branch: BRANCH, heldBy: sourceIdOf(40) }],
    });
    expect(branchRow(workspace)).toBeNull();
    expect(await branchTip(workspace)).toBeNull();
  });

  test("a rework brief states the gate fixed on the source, not the gate at its own base", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact));
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
            key: "missing-gate",
            severity: "blocker",
            summary: "The result does not state the gate it passed.",
            evidence: "docs/result.md:1",
          },
        ],
      }),
    );
    const findingId: string = reported.json.data.findings[0].findingId;
    await disposeFindings(workspace, producer, submitted.json.data.reviewId, [
      { findingId, disposition: "corrected", reason: "The result must state its gate." },
    ]);
    await acceptReview(workspace, producer, {
      reviewAssignmentId: submitted.json.data.reviewAssignmentId,
      attemptId: reviewer.attemptId,
      revision: reviewer.revision,
    });
    const delegated = await delegateRework(workspace, producer, {
      revision: submitted.json.data.revision,
      body: { reason: "findings", reviewId: submitted.json.data.reviewId, conflicts: [] },
    });

    // A later commit declares another gate. It counts only for a later source.
    const changed = await commitOnMain(
      workspace,
      "operator-gate.json",
      `${JSON.stringify({ ...FIXTURE_GATE, commands: [{ name: "later-source-gate", argv: ["true"], timeoutSeconds: 60 }] })}\n`,
    );
    const reworked = await startRework(workspace, producer, {
      revision: delegated.json.data.revision,
      commit: changed,
      worktreePath: `${workspace.root}/rework`,
    });

    expect(reworked.dispatched.json.outcome).toBe("pending");
    const brief = await Bun.file(`${reworked.worktreePath}/.operator/local/brief.md`).text();
    expect(brief).toContain(`project gate at commit ${producer.baseCommit}, in this order`);
    expect(brief).toContain("- `quality`: `true`");
    expect(brief).not.toContain("later-source-gate");

    // The submit check reads the same fixed gate, so a pass of the later gate is not enough.
    const result = await commitArtifact(workspace, reworked, "# Result with its gate\n");
    const refused = await submit(
      workspace,
      reworked,
      submissionBody(reworked, result, {
        checks: [{ name: "later-source-gate", command: "true", outcome: "passed", detail: "" }],
      }),
    );
    expect(refused.json.blockers).toContainEqual(
      expect.objectContaining({
        reason: "project_gate_not_passed",
        gateCommit: producer.baseCommit,
        commands: [{ name: "quality", recorded: [] }],
      }),
    );
  });
});

/**
 * Records that one assignment completed at one time, as its tracker completion step does. The
 * registration check reads only this crew state, never the tracker.
 */
function recordCompletion(workspace: Workspace, assignmentId: string, at: string): void {
  const sqlite = new Database(statePath(workspace), { readwrite: true });
  sqlite
    .query(
      `insert into tracker_operations (id, assignment_id, step, provider, target, expected_actor,
         intent, intent_identity, close_reason, state, reason, problems, revision, created_at,
         updated_at)
       values (?, ?, 'completion', 'github', '{}', 'operator-bot', '{}', 'intent', 'completed',
         'succeeded', 'tracker.completed', '[]', 1, ?, ?)
       on conflict (assignment_id, step) do update set updated_at = excluded.updated_at`,
    )
    .run(crypto.randomUUID(), assignmentId, at, at);
  sqlite.close();
}

function baseFixedAt(workspace: Workspace): string {
  const sqlite = new Database(statePath(workspace), { readonly: true });
  const row = sqlite
    .query("select fixed_at from integration_branches where source_id = ?")
    .get(SOURCE) as { fixed_at: string };
  sqlite.close();
  return row.fixed_at;
}

describe("a blocker in another source", () => {
  test("a new item refuses a production blocker of another source that completed after the base was fixed", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const target = workspaceTarget(workspace);
    // The first code dispatch of source 15 fixes its integration base.
    const producer = await startProducer(workspace);
    const other = await registerSource(target, producer.ownerToken, {
      sourceKind: "specification",
      parent: 30,
      items: [{ key: "30.1" }],
    });
    const blockerId = other.keys.get("30.1") ?? "";
    // The other item completed, and the tracker shows it closed, which alone gates nothing.
    await seedSource(workspace.github, {
      sourceKind: "specification",
      parent: 30,
      items: [{ key: "30.1", state: "closed" }],
    });

    // A new sub-issue of source 15 is blocked by that item.
    const grown = {
      sourceKind: "specification" as const,
      parent: 15,
      items: [
        { key: "22.1", inInput: false },
        { key: "22.3", dependsOn: [{ key: "30.1", sourceId: sourceIdOf(30) }] },
      ],
    };
    const numbers = await seedSource(workspace.github, grown);
    const inputPath = await writeSourceInput(workspace.root, sourceInput(grown, numbers));
    const refusalsOf = async () => {
      const planned = await planSource(target, inputPath);
      const plan = await Bun.file(`${workspace.repo}/${planned.json.data.planPath}`).json();
      return plan.refusals as Array<{ reason: string; key: string; assignmentId?: string }>;
    };

    const fixedAt = baseFixedAt(workspace);
    recordCompletion(workspace, blockerId, new Date(Date.parse(fixedAt) - 60_000).toISOString());
    // Completed before the base was fixed, so the base holds its commit.
    expect((await refusalsOf()).map((one) => one.reason)).not.toContain(
      "blocker_completed_after_base",
    );

    recordCompletion(workspace, blockerId, new Date(Date.parse(fixedAt) + 60_000).toISOString());
    expect(await refusalsOf()).toContainEqual(
      expect.objectContaining({
        reason: "blocker_completed_after_base",
        key: `fveracoechea/operator#${numbers.get("22.3")}`,
        sourceId: sourceIdOf(30),
        assignmentId: blockerId,
        baseFixedAt: fixedAt,
      }),
    );
  });
});
