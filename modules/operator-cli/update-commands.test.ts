import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ProjectReadiness } from "../project-readiness/main.ts";
import {
  ownCrew,
  requestId,
  runJson,
  runOperator,
  type Workspace,
  workspaces,
} from "./workspace-fixture.ts";
import {
  commitArtifact,
  delegateRework,
  makeReviewWorkspace,
  registerDependents,
  startRework,
  startProducer,
  submissionBody,
  submit,
} from "./review-cycle-fixture.ts";

// Update tests run separate CLI processes against project and crew state.
setDefaultTimeout(60_000);

const fixtures = workspaces();
let workspace: Workspace;

beforeEach(async () => {
  workspace = await fixtures.make();
});

afterAll(async () => {
  await fixtures.removeAll();
});

const commit = "c".repeat(40);

function statePath(): string {
  return `${workspace.repo}/.operator/local/crew-state.sqlite`;
}

/** Puts the crew state back at the format an earlier Operator release wrote. */
function makeStateOutdated(): void {
  const sqlite = new Database(statePath(), { create: false, readwrite: true });
  sqlite.exec("alter table state_meta drop column release_identity");
  sqlite.exec("alter table answers drop column source_kind");
  dropVersionSix(sqlite);
  dropVersionFive(sqlite);
  sqlite.query("update state_meta set state_version = 1").run();
  sqlite.close();
}

/** Writes one requirement answer the way an earlier release recorded it, with no checked quote. */
function recordEarlierRequirement(): void {
  const sqlite = new Database(statePath(), { create: false, readwrite: true });
  sqlite.exec(
    `insert into answers (id, question_id, question_revision, target_identity, authority,
     exact_text, interpretation, source_id, source_revision, recorded_at)
     values ('earlier', 'q1', 1, 't', 'requirement', 'words', '{}', 'github:operator#21',
     'rev-1', 'now')`,
  );
  sqlite.close();
}

function sourceKindOf(answerId: string): string | null {
  const sqlite = new Database(statePath(), { create: false, readonly: true });
  const row = sqlite.query("select source_kind from answers where id = ?").get(answerId) as {
    source_kind: string | null;
  };
  sqlite.close();
  return row.source_kind;
}

/** Removes what version 5 added, so a later migration step can add it again. */
function dropVersionFive(sqlite: Database): void {
  sqlite.exec("alter table attempt_dispatch drop column outside_scan");
  sqlite.exec("drop table outside_changes");
}

/** Removes what version 6 added, so a later migration step can add it again. */
function dropVersionSix(sqlite: Database): void {
  sqlite.exec("alter table submissions drop column behavior_changes");
}

/** Moves the recorded version back, and removes what each later version added. */
function setStateVersion(version: number): void {
  const sqlite = new Database(statePath(), { create: false, readwrite: true });
  if (version < 6) {
    dropVersionSix(sqlite);
  }
  if (version < 5) {
    dropVersionFive(sqlite);
  }
  sqlite.query("update state_meta set state_version = ?").run(version);
  sqlite.close();
}

function stateVersion(): number {
  const sqlite = new Database(statePath(), { create: false, readonly: true });
  const row = sqlite.query("select state_version from state_meta").get() as {
    state_version: number;
  };
  sqlite.close();
  return row.state_version;
}

function recordedRelease(): string | null {
  const sqlite = new Database(statePath(), { create: false, readonly: true });
  const row = sqlite.query("select release_identity from state_meta").get() as {
    release_identity: string | null;
  };
  sqlite.close();
  return row.release_identity;
}

async function plan(extra: string[] = []) {
  return runJson(workspace, ["update", "plan", "--claude", "--commit", commit, ...extra]);
}

async function apply(extra: string[] = []) {
  const planned = await plan(extra);
  return {
    planned,
    applied: await runJson(workspace, [
      "update",
      "apply",
      "--claude",
      "--commit",
      commit,
      ...extra,
      "--approved-update",
      planned.json.data.updateId,
    ]),
  };
}

describe("operator update plan", () => {
  test("refuses to guess a target", async () => {
    const result = await runJson(workspace, ["update", "plan", "--commit", commit]);

    expect(result.exitCode).toBe(2);
    expect(result.json.reason).toBe("missing_target");
  });

  test("refuses a request that names no full commit", async () => {
    const result = await runJson(workspace, ["update", "plan", "--claude"]);

    expect(result.exitCode).toBe(2);
    expect(result.json.reason).toBe("invalid_arguments");
  });

  test("refuses a registry selection with no exact package version", async () => {
    const result = await plan(["--delivery", "jsr"]);

    expect(result.exitCode).toBe(4);
    expect(result.json.reason).toBe("update_blocked");
    expect(result.json.blockers.map((one: { reason: string }) => one.reason)).toContain(
      "package_version_required",
    );
  });

  test("includes the JSR selectors in the runnable approval command", async () => {
    const result = await runOperator(workspace, [
      "update",
      "plan",
      "--claude",
      "--commit",
      commit,
      "--delivery",
      "jsr",
      "--package-version",
      "1.2.3",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `Approve with: bun run operator update apply --claude --commit ${commit} --delivery jsr --package-version 1.2.3 --approved-update `,
    );
  });

  test("shows the release it would select and writes nothing", async () => {
    const result = await plan();

    expect(result.exitCode).toBe(0);
    expect(result.json.reason).toBe("update_plan_ready");
    expect(result.json.data.from).toBeNull();
    expect(result.json.data.to.commit).toBe(commit);
    expect(result.json.data.updateId).toMatch(/^[0-9a-f]{64}$/);
    expect(await Bun.file(`${workspace.repo}/.operator/install/selection.json`).exists()).toBe(
      false,
    );
  });
});

describe("operator update apply", () => {
  test("refuses to write without an approved update", async () => {
    const result = await runJson(workspace, ["update", "apply", "--claude", "--commit", commit]);

    expect(result.exitCode).toBe(3);
    expect(result.json.reason).toBe("approval_required");
  });

  test("refuses an approval that does not match the current plan", async () => {
    const result = await runJson(workspace, [
      "update",
      "apply",
      "--claude",
      "--commit",
      commit,
      "--approved-update",
      "0".repeat(64),
    ]);

    expect(result.exitCode).toBe(3);
    expect(result.json.reason).toBe("approval_stale");
    expect(await Bun.file(`${workspace.repo}/.operator/install/selection.json`).exists()).toBe(
      false,
    );
  });

  test("records the exact release and installs the owned skills together", async () => {
    const { applied } = await apply();

    expect(applied.exitCode).toBe(0);
    expect(applied.json.reason).toBe("update_applied");
    expect(applied.json.data.selection).toMatchObject({
      delivery: "github-source",
      commit,
      packageVersion: null,
    });
    const recorded = await Bun.file(`${workspace.repo}/.operator/install/selection.json`).json();
    expect(recorded.commit).toBe(commit);
    expect(await Bun.file(`${workspace.repo}/.claude/skills/operator/SKILL.md`).exists()).toBe(
      true,
    );
  });

  test("records the selected version without changing the project's manifest", async () => {
    const { applied } = await apply(["--delivery", "jsr", "--package-version", "1.2.3"]);

    expect(applied.exitCode).toBe(0);
    expect(applied.json.data.selection.packageVersion).toBe("1.2.3");
    expect(await Bun.file(`${workspace.repo}/.operator/install/package.json`).exists()).toBe(false);
  });

  test("puts the exact release and dependency identities into what a launch fixes", async () => {
    await apply(["--delivery", "jsr", "--package-version", "1.2.3"]);

    const snapshot = await ProjectReadiness.snapshot({
      projectRoot: workspace.repo,
      overrides: {},
    });

    expect(snapshot.installation).toEqual({
      delivery: "jsr",
      commit,
      packageVersion: "1.2.3",
    });
    expect(snapshot.lock.state).toBe("present");
    expect(snapshot.release.identity).toMatch(/^[0-9a-f]{64}$/);
  });

  test("names the launcher that keeps the project working directory", async () => {
    const { applied } = await apply(["--delivery", "jsr", "--package-version", "1.2.3"]);

    expect(applied.json.data.commands.run).toBe("bun run operator <operation>");
    expect(applied.json.data.commands.install).toContain("--frozen-lockfile");
  });

  test("backs the durable records up and reads every copy back", async () => {
    await ownCrew(workspace);

    const { applied } = await apply();

    const backupRoot = applied.json.data.backup.root;
    expect(applied.json.data.backup.targets).toContain(".operator/local/crew-state.sqlite");
    expect(
      await Bun.file(`${workspace.repo}/${backupRoot}/.operator/local/crew-state.sqlite`).exists(),
    ).toBe(true);
  });

  test("refuses while an assignment is still in flight", async () => {
    const ownerToken = await ownCrew(workspace);
    await Bun.write(
      `${workspace.root}/work.json`,
      JSON.stringify({
        sourceKind: "ticket",
        source: { id: "github:operator#28", revision: "rev-1", tracker: "github" },
        items: [
          {
            key: "one",
            title: "One",
            kind: "production",
            approvedScope: "One",
            acceptanceRequirements: ["The tests pass."],
            permissions: {
              writePaths: ["modules/"],
              allowedCommands: ["bun test"],
              network: false,
            },
            fixedInputs: [],
            dependsOn: [],
          },
        ],
      }),
    );
    const registered = await runJson(workspace, [
      "work",
      "register",
      "--request",
      requestId(),
      "--owner-token",
      ownerToken,
      "--input",
      `${workspace.root}/work.json`,
    ]);
    const assignmentId = registered.json.data.registered[0].assignmentId;
    await runJson(workspace, [
      "work",
      "claim",
      "--request",
      requestId(),
      "--owner-token",
      ownerToken,
      "--assignment",
      assignmentId,
      "--revision",
      "1",
    ]);

    const result = await plan();

    expect(result.exitCode).toBe(3);
    expect(result.json.reason).toBe("update_blocked");
    expect(result.json.blockers[0].reason).toBe("assignments_active");
  });
});

describe("recorded formats", () => {
  test("stops every crew command while the recorded state is older than this release", async () => {
    await ownCrew(workspace);
    makeStateOutdated();

    const result = await runJson(workspace, ["work", "frontier"]);

    expect(result.exitCode).toBe(3);
    expect(result.json.reason).toBe("state_version_outdated");
  });

  test("migrates a compatible earlier format and records the release it moved to", async () => {
    await ownCrew(workspace);
    makeStateOutdated();
    expect(stateVersion()).toBe(1);

    const { applied } = await apply();

    expect(applied.exitCode).toBe(0);
    expect(applied.json.data.migration.status).toBe("migrated");
    expect(stateVersion()).toBe(6);
    expect(recordedRelease()).toBe(applied.json.data.selection.releaseIdentity);
    expect((await runJson(workspace, ["work", "frontier"])).exitCode).toBe(0);
  });

  test("adds the scan of each attempt and the record of each outside change", async () => {
    await ownCrew(workspace);
    setStateVersion(4);

    const { applied } = await apply();

    expect(applied.json.data.migration.steps).toContainEqual(
      expect.objectContaining({ from: 4, to: 5 }),
    );
    const sqlite = new Database(statePath(), { create: false, readonly: true });
    const columns = sqlite.query("pragma table_info(attempt_dispatch)").all() as Array<{
      name: string;
    }>;
    const table = sqlite
      .query("select name from sqlite_master where type = 'table' and name = 'outside_changes'")
      .all();
    sqlite.close();
    expect(columns.map((one) => one.name)).toContain("outside_scan");
    expect(table).toHaveLength(1);
  });

  test("adds the behavior change list of each submission", async () => {
    await ownCrew(workspace);
    setStateVersion(5);

    const { applied } = await apply();

    expect(applied.json.data.migration.steps).toEqual([
      expect.objectContaining({ from: 5, to: 6 }),
    ]);
    const sqlite = new Database(statePath(), { create: false, readonly: true });
    const columns = sqlite.query("pragma table_info(submissions)").all() as Array<{
      name: string;
    }>;
    sqlite.close();
    expect(columns.map((one) => one.name)).toContain("behavior_changes");
    expect(stateVersion()).toBe(6);
  });

  test("marks a requirement that an earlier release recorded as unchecked", async () => {
    await ownCrew(workspace);
    makeStateOutdated();
    recordEarlierRequirement();

    const { applied } = await apply();

    // No copy stands behind that quote, so the record must not claim a check it never had.
    expect(applied.exitCode).toBe(0);
    expect(sourceKindOf("earlier")).toBe("unchecked");
  });

  test("puts the backed-up records back when a migration step cannot finish", async () => {
    await ownCrew(workspace);
    makeStateOutdated();
    // A column of that name already exists, so the recorded step cannot add it.
    const sqlite = new Database(statePath(), { create: false, readwrite: true });
    sqlite.exec("alter table state_meta add column release_identity text");
    sqlite.query("update state_meta set state_version = 1").run();
    sqlite.close();
    const before = new Uint8Array(await Bun.file(statePath()).arrayBuffer());

    const { applied } = await apply();

    expect(applied.exitCode).toBe(1);
    expect(applied.json.reason).toBe("migration_failed");
    expect(applied.json.blockers[0].restored).toContain(".operator/local/crew-state.sqlite");
    expect(stateVersion()).toBe(1);
    expect(new Uint8Array(await Bun.file(statePath()).arrayBuffer())).toEqual(before);
  });

  test("refuses to migrate while a code submission waits, and names each one", async () => {
    const reviewing = await makeReviewWorkspace(fixtures);
    workspace = reviewing;
    const producer = await startProducer(reviewing);
    const artifact = await commitArtifact(reviewing, producer, "# Result\n");
    const submitted = await submit(reviewing, producer, submissionBody(producer, artifact));
    setStateVersion(3);

    const planned = await plan();

    expect(planned.json.reason).toBe("update_blocked");
    const waiting = planned.json.blockers.find(
      (one: { reason: string }) => one.reason === "code_submission_waiting",
    );
    expect(waiting.detail).toContain(
      `Code submission ${submitted.json.data.submissionId} of assignment ${producer.assignmentId} waits for review or acceptance.`,
    );
    expect(planned.json.data.migration.status).toBe("held");
    expect(stateVersion()).toBe(3);
  });

  test("names every waiting code submission, and not the one a rework replaced", async () => {
    const reviewing = await makeReviewWorkspace(fixtures);
    workspace = reviewing;
    const producer = await startProducer(reviewing);
    const flaky = [{ name: "quality", command: "bun run quality", outcome: "flaky", detail: "" }];
    const first = await commitArtifact(reviewing, producer, "# Result 0\n");
    const replaced = await submit(
      reviewing,
      producer,
      submissionBody(producer, first, { checks: flaky }),
    );
    const delegated = await delegateRework(reviewing, producer, {
      revision: replaced.json.data.revision,
      body: {
        reason: "diagnostic",
        checks: ["quality"],
        instruction: "Run the quality gate again.",
        conflicts: [],
      },
    });
    const reworked = await startRework(reviewing, producer, {
      revision: delegated.json.data.revision,
      commit: first.commit,
      worktreePath: `${reviewing.root}/rework`,
    });
    const revision = await commitArtifact(reviewing, reworked, "# Result 1\n");
    const waiting = await submit(
      reviewing,
      reworked,
      submissionBody(reworked, revision, { assignmentRevision: reworked.assignmentRevision }),
    );
    const registered = await registerDependents(reviewing, producer, [
      {
        key: "22.4",
        kind: "production",
        title: "The other result",
        dependsOn: [],
        writePaths: ["notes/"],
      },
    ]);
    const other = await startRework(reviewing, producer, {
      revision: 1,
      commit: producer.baseCommit,
      worktreePath: `${reviewing.root}/other`,
      assignmentId: registered.get("22.4") ?? "",
    });
    const otherArtifact = await commitArtifact(reviewing, other, "# Other\n", "notes/other.md");
    const alsoWaiting = await submit(
      reviewing,
      other,
      submissionBody(other, otherArtifact, { assignmentRevision: other.assignmentRevision }),
    );
    expect(waiting.json.reason).toBe("result_submitted");
    expect(alsoWaiting.json.reason).toBe("result_submitted");
    setStateVersion(3);

    const planned = await plan();

    expect(planned.json.data.migration.holds).toEqual([
      `Code submission ${waiting.json.data.submissionId} of assignment ${producer.assignmentId} waits for review or acceptance.`,
      `Code submission ${alsoWaiting.json.data.submissionId} of assignment ${other.assignmentId} waits for review or acceptance.`,
    ]);
    expect(planned.json.data.migration.holds.join(" ")).not.toContain(
      replaced.json.data.submissionId,
    );
  });

  test("does not hold for a code assignment in rework, whose newest row still waits", async () => {
    const reviewing = await makeReviewWorkspace(fixtures);
    workspace = reviewing;
    const producer = await startProducer(reviewing);
    const flaky = [{ name: "quality", command: "bun run quality", outcome: "flaky", detail: "" }];
    const artifact = await commitArtifact(reviewing, producer, "# Result\n");
    const submitted = await submit(
      reviewing,
      producer,
      submissionBody(producer, artifact, { checks: flaky }),
    );
    const delegated = await delegateRework(reviewing, producer, {
      revision: submitted.json.data.revision,
      body: {
        reason: "diagnostic",
        checks: ["quality"],
        instruction: "Run the quality gate again.",
        conflicts: [],
      },
    });
    expect(delegated.json.reason).toBe("rework_delegated");
    setStateVersion(3);

    const planned = await plan();

    // The rework submits a new result under the new release, so nothing waits on the old one.
    expect(planned.json.data.migration.holds).toEqual([]);
  });

  test("migrates an accepted code submission and keeps its pull request as history", async () => {
    const reviewing = await makeReviewWorkspace(fixtures);
    workspace = reviewing;
    const producer = await startProducer(reviewing);
    const artifact = await commitArtifact(reviewing, producer, "# Result\n");
    const submitted = await submit(reviewing, producer, submissionBody(producer, artifact));
    const submissionId = submitted.json.data.submissionId;
    // An earlier release recorded a pull request on the result, and the user accepted it there.
    const history = { status: "open", number: 41, headCommit: artifact.commit };
    const sqlite = new Database(statePath(), { create: false, readwrite: true });
    const code = JSON.parse(
      (
        sqlite.query("select code from submissions where id = ?").get(submissionId) as {
          code: string;
        }
      ).code,
    );
    sqlite
      .query("update submissions set state = 'accepted', code = ? where id = ?")
      .run(JSON.stringify({ ...code, pullRequest: history }), submissionId);
    sqlite.query("update assignments set state = 'accepted' where kind = 'production'").run();
    sqlite.query("update assignments set state = 'invalidated' where kind = 'review'").run();
    sqlite.close();
    setStateVersion(3);

    const { applied } = await apply();

    expect(applied.json.data.migration.status).toBe("migrated");
    expect(stateVersion()).toBe(6);
    const stored = new Database(statePath(), { create: false, readonly: true });
    const kept = stored.query("select code from submissions where id = ?").get(submissionId) as {
      code: string;
    };
    stored.close();
    expect(JSON.parse(kept.code).pullRequest).toEqual(history);
    const shown = await runJson(workspace, [
      "review",
      "show",
      "--review",
      submitted.json.data.reviewId,
    ]);
    expect(shown.exitCode).toBe(0);
    // An earlier release listed no behavior change, so the record keeps no list, not "none".
    expect(shown.json.data.submission.behaviorChanges).toBeNull();
  });
});
