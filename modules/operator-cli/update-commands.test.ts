import { registerSource, workspaceTarget, writeInput } from "./source-fixture.ts";
import { afterAll, beforeEach, describe, expect, test as bunTest } from "bun:test";
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
  startRework,
  startProducer,
  submissionBody,
  submit,
} from "./review-cycle-fixture.ts";

// Update tests run separate CLI processes against project and crew state.
// Each test states its own bound, because a process-wide default would set the bound of every
// file in the bun test process (#179).
function test(name: string, run: () => Promise<void> | void, timeoutMs = 60_000) {
  bunTest(name, run, timeoutMs);
}

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
  dropVersionEighteen(sqlite);
  dropVersionSeventeen(sqlite);
  dropVersionSixteen(sqlite);
  dropVersionFifteen(sqlite);
  dropVersionFourteen(sqlite);
  dropVersionThirteen(sqlite);
  dropVersionTwelve(sqlite);
  dropVersionEleven(sqlite);
  dropVersionTen(sqlite);
  dropVersionNine(sqlite);
  dropVersionEight(sqlite);
  dropVersionSeven(sqlite);
  dropVersionSix(sqlite);
  dropVersionFive(sqlite);
  sqlite.query("update state_meta set state_version = 1").run();
  sqlite.close();
}

/**
 * Puts one registered source back in the shape version 8 wrote: a location with no parent
 * issue, and bindings that name only an issue number.
 */
function makeSourceEarlier(options: { location: boolean }): void {
  const sqlite = new Database(statePath(), { create: false, readwrite: true });
  dropVersionEighteen(sqlite);
  dropVersionSeventeen(sqlite);
  dropVersionSixteen(sqlite);
  dropVersionFifteen(sqlite);
  dropVersionFourteen(sqlite);
  dropVersionThirteen(sqlite);
  dropVersionTwelve(sqlite);
  dropVersionEleven(sqlite);
  dropVersionTen(sqlite);
  dropVersionNine(sqlite);
  // An earlier release named a source by the id its input stated, not by its parent issue.
  sqlite.exec("update work_sources set id = 'github:operator#28'");
  sqlite.exec("update assignments set source_id = 'github:operator#28'");
  sqlite
    .query("update work_sources set tracker_location = ?")
    .run(
      options.location
        ? JSON.stringify({ repository: "fveracoechea/operator", mapIssue: 28 })
        : null,
    );
  sqlite.exec(
    "update assignments set tracker_binding = json_object('issue', json_extract(tracker_binding, '$.issue'))",
  );
  sqlite.query("update state_meta set state_version = 8").run();
  sqlite.close();
}

function recordedRows(): {
  sources: Array<{ id: string; tracker_location: string | null }>;
  bindings: Array<string | null>;
} {
  const sqlite = new Database(statePath(), { create: false, readonly: true });
  const sources = sqlite.query("select id, tracker_location from work_sources").all() as Array<{
    id: string;
    tracker_location: string | null;
  }>;
  const bindings = (
    sqlite.query("select tracker_binding from assignments").all() as Array<{
      tracker_binding: string | null;
    }>
  ).map((one) => one.tracker_binding);
  sqlite.close();
  return { sources, bindings };
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

/** Writes one planning acceptance the way an earlier release recorded it, with no record. */
function recordEarlierPlanning(): void {
  const sqlite = new Database(statePath(), { create: false, readwrite: true });
  sqlite.exec(
    `insert into work_sources (id, kind, revision, tracker, order_index, registered_at)
     values ('github:operator#1', 'wayfinder', 'rev-1', 'github', 0, 'now')`,
  );
  sqlite.exec(
    `insert into assignments (id, source_id, source_key, source_revision, title, kind,
     order_index, approved_scope, acceptance_requirements, permissions, fixed_inputs,
     fixed_inputs_identity, state, revision, registered_at, updated_at)
     values ('earlier-plan', 'github:operator#1', '1', 'rev-1', 'Decide', 'planning', 0,
     'Decide.', '[]', '{}', '[]', 'i', 'accepted', 2, 'now', 'now')`,
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

/** Removes what version 16 added, so a later migration step can add it again. */
function dropVersionSixteen(sqlite: Database): void {
  sqlite.exec("drop table stack_observations");
  sqlite.exec("alter table stack_publications drop column tracker_steps");
}

/** Removes what version 15 added, so a later migration step can add it again. */
function dropVersionFifteen(sqlite: Database): void {
  sqlite.exec("drop table stack_pull_requests");
  sqlite.exec("drop table publish_effects");
  sqlite.exec("drop table stack_publications");
  sqlite.exec("alter table reviews drop column published_text");
}

/** Removes what version 18 added, so a later migration step can add it again. */
function dropVersionEighteen(sqlite: Database): void {
  sqlite.exec("drop table integration_rebases");
}

/** Removes what version 17 added, so a later migration step can add it again. */
function dropVersionSeventeen(sqlite: Database): void {
  sqlite.exec("alter table landings drop column rewrite");
}

/**
 * Removes what version 14 added, so a later migration step can add it again. The review table
 * goes back to the shape where every review names a submission.
 */
function dropVersionFourteen(sqlite: Database): void {
  sqlite.exec("alter table review_findings drop column targets");
  sqlite.exec("alter table review_findings drop column correction_target");
  sqlite.exec(`create table reviews_earlier (
    id text primary key,
    submission_id text not null references submissions(id),
    assignment_id text not null references assignments(id),
    axes text not null,
    state text not null,
    host text,
    sub_agents text,
    blocker text,
    reported_at text,
    revision integer not null,
    created_at text not null,
    updated_at text not null,
    unique (assignment_id)
  ) strict`);
  sqlite.exec(`insert into reviews_earlier select id, submission_id, assignment_id, axes, state,
    host, sub_agents, blocker, reported_at, revision, created_at, updated_at from reviews`);
  sqlite.exec("drop table reviews");
  sqlite.exec("alter table reviews_earlier rename to reviews");
  sqlite.exec("drop table branch_snapshots");
}

/** Removes what version 13 added, so a later migration step can add it again. */
function dropVersionThirteen(sqlite: Database): void {
  sqlite.exec("drop table landings");
}

/** Removes what version 12 added, so a later migration step can add it again. */
function dropVersionTwelve(sqlite: Database): void {
  sqlite.exec("drop table integration_branches");
}

/** Removes what version 11 added, so a later migration step can add it again. */
function dropVersionEleven(sqlite: Database): void {
  sqlite.exec("alter table assignments drop column withdrawn_under");
}

/** Removes what version 10 added, so a later migration step can add it again. */
function dropVersionTen(sqlite: Database): void {
  sqlite.exec("drop table gate_run_commands");
  sqlite.exec("drop table gate_runs");
  sqlite.exec("drop table gate_checkouts");
}

/** Removes what version 7 added, so a later migration step can add it again. */
function dropVersionSeven(sqlite: Database): void {
  sqlite.exec("drop table planning_records");
  sqlite.exec("alter table assignments drop column planning_type");
}

/** Removes what version 8 added, so a later migration step can add it again. */
function dropVersionEight(sqlite: Database): void {
  sqlite.exec("alter table attempt_dispatch drop column planning_record_ids");
}

/** Removes what version 9 added, so a later migration step can add it again. */
function dropVersionNine(sqlite: Database): void {
  sqlite.exec("alter table assignments drop column scope_identity");
}

/** Moves the recorded version back, and removes what each later version added. */
function setStateVersion(version: number): void {
  const sqlite = new Database(statePath(), { create: false, readwrite: true });
  if (version < 18) {
    dropVersionEighteen(sqlite);
  }
  if (version < 17) {
    dropVersionSeventeen(sqlite);
  }
  if (version < 16) {
    dropVersionSixteen(sqlite);
  }
  if (version < 15) {
    dropVersionFifteen(sqlite);
  }
  if (version < 14) {
    dropVersionFourteen(sqlite);
  }
  if (version < 13) {
    dropVersionThirteen(sqlite);
  }
  if (version < 12) {
    dropVersionTwelve(sqlite);
  }
  if (version < 11) {
    dropVersionEleven(sqlite);
  }
  if (version < 10) {
    dropVersionTen(sqlite);
  }
  if (version < 9) {
    dropVersionNine(sqlite);
  }
  if (version < 8) {
    dropVersionEight(sqlite);
  }
  if (version < 7) {
    dropVersionSeven(sqlite);
  }
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
    expect(result.stdout).toStartWith(
      `{"schemaVersion":1,"outcome":"missing-condition","reason":"approval_required","blockers":[{"reason":"approval_required","currentUpdateId":"${result.json.data.updateId}","approvedUpdateId":null}],"operation":"update_apply","data":{"updateId":`,
    );
    const plan = await runOperator(workspace, ["update", "plan", "--claude", "--commit", commit]);
    const text = await runOperator(workspace, ["update", "apply", "--claude", "--commit", commit]);
    expect(text.stdout).toBe(
      `The update needs an approved plan. Nothing was written.\n${plan.stdout.slice(0, plan.stdout.indexOf("\nApprove with: "))}`,
    );
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
    expect(result.stdout).toStartWith(
      `{"schemaVersion":1,"outcome":"missing-condition","reason":"approval_stale","blockers":[{"reason":"approval_stale","currentUpdateId":"${result.json.data.updateId}","approvedUpdateId":"${"0".repeat(64)}"}],"operation":"update_apply","data":{"updateId":`,
    );
    const text = await runOperator(workspace, [
      "update",
      "apply",
      "--claude",
      "--commit",
      commit,
      "--approved-update",
      "0".repeat(64),
    ]);
    expect(text.stdout).toStartWith(
      "The approved update no longer matches this project or this release. Nothing was written.\nOperator update plan\n",
    );
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
    const registered = await registerSource(workspaceTarget(workspace), ownerToken, {
      sourceKind: "ticket",
      parent: 28,
      items: [{ key: "one", title: "One", body: "One" }],
    });
    const assignmentId = registered.assignments[0]?.assignmentId ?? "";
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

describe("operator --version", () => {
  test("reports the selected source release and its invocation through the version read", async () => {
    const before = await runJson(workspace, ["--version"]);
    const { applied } = await apply();
    const after = await runJson(workspace, ["--version"]);

    expect(before.json.data.selection).toEqual({ state: "missing" });
    expect(after.exitCode).toBe(0);
    expect(after.json.data.selection).toEqual({
      state: "selected",
      delivery: "github-source",
      version: applied.json.data.selection.version,
      commit,
      packageVersion: null,
      invocation: `bunx "github:fveracoechea/operator#${commit}"`,
    });
  });

  test("reports the project script as the invocation of a registry release", async () => {
    await apply(["--delivery", "jsr", "--package-version", "1.2.3"]);

    const result = await runJson(workspace, ["--version"]);

    expect(result.json.data.selection).toMatchObject({
      state: "selected",
      delivery: "jsr",
      packageVersion: "1.2.3",
      invocation: "bun run operator",
    });
  });

  test("shows a person the selected release and the command that runs it", async () => {
    const before = await runOperator(workspace, ["--version"]);
    const { applied } = await apply();
    const after = await runOperator(workspace, ["--version"]);

    expect(before.stdout).toContain("\nSelection: missing. This project selected no release.\n");
    expect(after.exitCode).toBe(0);
    expect(after.stdout.split("\n").slice(1)).toEqual([
      "Selection: selected.",
      "  Delivery: github-source",
      `  Version: ${applied.json.data.selection.version}`,
      `  Commit: ${commit}`,
      `  Invocation: bunx "github:fveracoechea/operator#${commit}"`,
      "",
    ]);
  });

  test("shows a person the package version and the project script of a registry release", async () => {
    const { applied } = await apply(["--delivery", "jsr", "--package-version", "1.2.3"]);

    const result = await runOperator(workspace, ["--version"]);

    expect(result.stdout).toContain(
      `\n  Delivery: jsr\n  Version: ${applied.json.data.selection.version} (package 1.2.3)\n`,
    );
    expect(result.stdout).toContain("\n  Invocation: bun run operator\n");
  });

  test("reports an unreadable selection through the version read", async () => {
    await Bun.write(`${workspace.repo}/.operator/install/selection.json`, "{", {
      createPath: true,
    });

    const result = await runJson(workspace, ["--version"]);

    expect(result.exitCode).toBe(0);
    expect(result.json.data.selection).toMatchObject({ state: "unreadable" });
    const shown = await runOperator(workspace, ["--version"]);
    expect(shown.stdout).toContain("\nSelection: unreadable. ");
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
    expect(stateVersion()).toBe(18);
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

  test("adds the reading of each published pull request and the tracker steps of each approval", async () => {
    await ownCrew(workspace);
    setStateVersion(15);

    const { applied } = await apply();

    expect(applied.json.data.migration.steps).toEqual([
      expect.objectContaining({ from: 15, to: 16 }),
      expect.objectContaining({ from: 16, to: 17 }),
      expect.objectContaining({ from: 17, to: 18 }),
    ]);
    const sqlite = new Database(statePath(), { create: false, readonly: true });
    const columns = sqlite.query("pragma table_info(stack_publications)").all() as Array<{
      name: string;
    }>;
    const table = sqlite
      .query("select name from sqlite_master where type = 'table' and name = 'stack_observations'")
      .all();
    sqlite.close();
    expect(columns.map((one) => one.name)).toContain("tracker_steps");
    expect(table).toHaveLength(1);
    expect(stateVersion()).toBe(18);
  });

  test("adds the record of each rebase onto a new base", async () => {
    await ownCrew(workspace);
    setStateVersion(17);

    const { applied } = await apply();

    expect(applied.json.data.migration.steps).toEqual([
      expect.objectContaining({ from: 17, to: 18 }),
    ]);
    const sqlite = new Database(statePath(), { create: false, readonly: true });
    const table = sqlite
      .query("select name from sqlite_master where type = 'table' and name = 'integration_rebases'")
      .all();
    sqlite.close();
    expect(table).toHaveLength(1);
    expect(stateVersion()).toBe(18);
  });

  test("adds the withdrawal plan revision of each assignment", async () => {
    await ownCrew(workspace);
    setStateVersion(10);

    const { applied } = await apply();

    expect(applied.json.data.migration.steps).toEqual([
      expect.objectContaining({ from: 10, to: 11 }),
      expect.objectContaining({ from: 11, to: 12 }),
      expect.objectContaining({ from: 12, to: 13 }),
      expect.objectContaining({ from: 13, to: 14 }),
      expect.objectContaining({ from: 14, to: 15 }),
      expect.objectContaining({ from: 15, to: 16 }),
      expect.objectContaining({ from: 16, to: 17 }),
      expect.objectContaining({ from: 17, to: 18 }),
    ]);
    const sqlite = new Database(statePath(), { create: false, readonly: true });
    const columns = sqlite.query("pragma table_info(assignments)").all() as Array<{ name: string }>;
    sqlite.close();
    expect(columns.map((one) => one.name)).toContain("withdrawn_under");
    expect(stateVersion()).toBe(18);
  });

  test("adds the gate run tables and the gate checkout of each source", async () => {
    await ownCrew(workspace);
    setStateVersion(9);

    const { applied } = await apply();

    expect(applied.json.data.migration.steps).toEqual([
      expect.objectContaining({ from: 9, to: 10 }),
      expect.objectContaining({ from: 10, to: 11 }),
      expect.objectContaining({ from: 11, to: 12 }),
      expect.objectContaining({ from: 12, to: 13 }),
      expect.objectContaining({ from: 13, to: 14 }),
      expect.objectContaining({ from: 14, to: 15 }),
      expect.objectContaining({ from: 15, to: 16 }),
      expect.objectContaining({ from: 16, to: 17 }),
      expect.objectContaining({ from: 17, to: 18 }),
    ]);
    const sqlite = new Database(statePath(), { create: false, readonly: true });
    const tables = sqlite
      .query("select name from sqlite_master where type = 'table' and name like 'gate_%'")
      .all() as Array<{ name: string }>;
    sqlite.close();
    expect(tables.map((one) => one.name).toSorted()).toEqual([
      "gate_checkouts",
      "gate_run_commands",
      "gate_runs",
    ]);
    expect(stateVersion()).toBe(18);
  });

  test("adds the integration branch of each source and gives none to an earlier source", async () => {
    await ownCrew(workspace);
    setStateVersion(11);

    const { applied } = await apply();

    expect(applied.json.data.migration.steps).toEqual([
      expect.objectContaining({ from: 11, to: 12 }),
      expect.objectContaining({ from: 12, to: 13 }),
      expect.objectContaining({ from: 13, to: 14 }),
      expect.objectContaining({ from: 14, to: 15 }),
      expect.objectContaining({ from: 15, to: 16 }),
      expect.objectContaining({ from: 16, to: 17 }),
      expect.objectContaining({ from: 17, to: 18 }),
    ]);
    const sqlite = new Database(statePath(), { create: false, readonly: true });
    const rows = sqlite.query("select count(*) as count from integration_branches").get() as {
      count: number;
    };
    sqlite.close();
    expect(rows.count).toBe(0);
    expect(stateVersion()).toBe(18);
  });

  test("adds the landing record and records no landing for an earlier result", async () => {
    await ownCrew(workspace);
    setStateVersion(12);

    const { applied } = await apply();

    expect(applied.json.data.migration.steps).toEqual([
      expect.objectContaining({ from: 12, to: 13 }),
      expect.objectContaining({ from: 13, to: 14 }),
      expect.objectContaining({ from: 14, to: 15 }),
      expect.objectContaining({ from: 15, to: 16 }),
      expect.objectContaining({ from: 16, to: 17 }),
      expect.objectContaining({ from: 17, to: 18 }),
    ]);
    const sqlite = new Database(statePath(), { create: false, readonly: true });
    const rows = sqlite.query("select count(*) as count from landings").get() as {
      count: number;
    };
    sqlite.close();
    expect(rows.count).toBe(0);
    expect(stateVersion()).toBe(18);
  });

  test("keeps each earlier review on its submission and adds the branch snapshot of a review", async () => {
    await ownCrew(workspace);
    setStateVersion(13);
    // The connection of this test checks no foreign key, so the review needs no other row.
    const earlier = new Database(statePath(), { create: false, readwrite: true });
    earlier.exec(
      `insert into reviews values ('r1', 's1', 'a1', '["standards","spec"]', 'reported', 'claude-code',
       null, null, 'now', 2, 'now', 'now')`,
    );
    earlier.exec(
      `insert into review_findings (id, review_id, axis, finding_key, severity, summary, evidence,
       recorded_at) values ('f1', 'r1', 'spec', 'k', 'blocker', 'It is wrong.', 'here', 'now')`,
    );
    earlier.close();

    const { applied } = await apply();

    expect(applied.json.data.migration.steps).toEqual([
      expect.objectContaining({ from: 13, to: 14 }),
      expect.objectContaining({ from: 14, to: 15 }),
      expect.objectContaining({ from: 15, to: 16 }),
      expect.objectContaining({ from: 16, to: 17 }),
      expect.objectContaining({ from: 17, to: 18 }),
    ]);
    const sqlite = new Database(statePath(), { create: false, readonly: true });
    const reviews = sqlite.query("select id, submission_id, snapshot_id, state from reviews").all();
    const findings = sqlite
      .query("select id, targets, correction_target from review_findings")
      .all();
    const snapshots = sqlite.query("select count(*) as count from branch_snapshots").get() as {
      count: number;
    };
    sqlite.close();
    expect(reviews).toEqual([
      { id: "r1", submission_id: "s1", snapshot_id: null, state: "reported" },
    ]);
    expect(findings).toEqual([{ id: "f1", targets: null, correction_target: null }]);
    expect(snapshots.count).toBe(0);
    expect(stateVersion()).toBe(18);
  });

  test("adds the rewrite plan of each landing, null for every earlier one", async () => {
    await ownCrew(workspace);
    setStateVersion(16);

    const { applied } = await apply();

    expect(applied.json.data.migration.steps).toEqual([
      expect.objectContaining({ from: 16, to: 17 }),
      expect.objectContaining({ from: 17, to: 18 }),
    ]);
    const sqlite = new Database(statePath(), { create: false, readonly: true });
    const columns = sqlite.query("pragma table_info(landings)").all() as Array<{ name: string }>;
    sqlite.close();
    expect(columns.map((one) => one.name)).toContain("rewrite");
    expect(stateVersion()).toBe(18);
  });

  test("adds the behavior change list of each submission", async () => {
    await ownCrew(workspace);
    setStateVersion(5);

    const { applied } = await apply();

    expect(applied.json.data.migration.steps).toEqual([
      expect.objectContaining({ from: 5, to: 6 }),
      expect.objectContaining({ from: 6, to: 7 }),
      expect.objectContaining({ from: 7, to: 8 }),
      expect.objectContaining({ from: 8, to: 9 }),
      expect.objectContaining({ from: 9, to: 10 }),
      expect.objectContaining({ from: 10, to: 11 }),
      expect.objectContaining({ from: 11, to: 12 }),
      expect.objectContaining({ from: 12, to: 13 }),
      expect.objectContaining({ from: 13, to: 14 }),
      expect.objectContaining({ from: 14, to: 15 }),
      expect.objectContaining({ from: 15, to: 16 }),
      expect.objectContaining({ from: 16, to: 17 }),
      expect.objectContaining({ from: 17, to: 18 }),
    ]);
    const sqlite = new Database(statePath(), { create: false, readonly: true });
    const columns = sqlite.query("pragma table_info(submissions)").all() as Array<{
      name: string;
    }>;
    sqlite.close();
    expect(columns.map((one) => one.name)).toContain("behavior_changes");
    expect(stateVersion()).toBe(18);
  });

  test("adds the planning record list of each launch and fixes none for an earlier launch", async () => {
    const reviewing = await makeReviewWorkspace(fixtures);
    workspace = reviewing;
    const producer = await startProducer(reviewing);
    const artifact = await commitArtifact(reviewing, producer, "# Result\n");
    await submit(reviewing, producer, submissionBody(producer, artifact));
    // An update waits for the work in flight, so that launch has finished before the update.
    const accepted = new Database(statePath(), { create: false, readwrite: true });
    accepted.query("update assignments set state = 'accepted' where kind = 'production'").run();
    accepted.query("update assignments set state = 'invalidated' where kind = 'review'").run();
    accepted.close();
    setStateVersion(7);

    const { applied } = await apply();

    expect(applied.json.data.migration.steps).toEqual([
      expect.objectContaining({ from: 7, to: 8 }),
      expect.objectContaining({ from: 8, to: 9 }),
      expect.objectContaining({ from: 9, to: 10 }),
      expect.objectContaining({ from: 10, to: 11 }),
      expect.objectContaining({ from: 11, to: 12 }),
      expect.objectContaining({ from: 12, to: 13 }),
      expect.objectContaining({ from: 13, to: 14 }),
      expect.objectContaining({ from: 14, to: 15 }),
      expect.objectContaining({ from: 15, to: 16 }),
      expect.objectContaining({ from: 16, to: 17 }),
      expect.objectContaining({ from: 17, to: 18 }),
    ]);
    expect(stateVersion()).toBe(18);
    const sqlite = new Database(statePath(), { create: false, readonly: true });
    const row = sqlite
      .query("select planning_record_ids from attempt_dispatch where attempt_id = ?")
      .get(producer.attemptId) as { planning_record_ids: string | null };
    sqlite.close();
    // That launch carried no planning records, so the migration claims no list for it.
    expect(row.planning_record_ids).toBeNull();
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

  test("keeps an earlier planning acceptance with no record and no planning type", async () => {
    await ownCrew(workspace);
    makeStateOutdated();
    recordEarlierPlanning();

    const { applied } = await apply();

    // Nobody made the claim that a record would state, so the migration adds none.
    expect(applied.exitCode).toBe(0);
    const sqlite = new Database(statePath(), { create: false, readonly: true });
    const records = sqlite.query("select count(*) as count from planning_records").get() as {
      count: number;
    };
    const planning = sqlite
      .query("select planning_type from assignments where id = 'earlier-plan'")
      .get() as { planning_type: string | null };
    sqlite.close();
    expect(records.count).toBe(0);
    expect(planning.planning_type).toBeNull();
  });

  test("keeps an earlier source and adds its repository to each binding", async () => {
    const ownerToken = await ownCrew(workspace);
    await registerSource(workspaceTarget(workspace), ownerToken, {
      sourceKind: "ticket",
      parent: 28,
      items: [{ key: "one" }],
    });
    makeSourceEarlier({ location: true });
    const before = recordedRows();

    const { applied } = await apply();

    expect(applied.exitCode).toBe(0);
    expect(stateVersion()).toBe(18);
    const after = recordedRows();
    expect(after.sources).toEqual(before.sources);
    expect(after.bindings.map((one) => JSON.parse(one ?? "null"))).toEqual([
      { repository: "fveracoechea/operator", issue: 28 },
    ]);

    // The source has no parent issue, so a new read of it is refused.
    const plan = await runJson(workspace, [
      "work",
      "register",
      "--plan",
      "--input",
      await writeInput(workspace.root, {
        sourceKind: "wayfinder",
        source: "fveracoechea/operator#28",
        items: [],
      }),
    ]);
    expect(plan.json.blockers[0]).toEqual({ reason: "source_recorded_without_parent", count: 1 });
  });

  test("keeps a binding unbound when its earlier source records no location", async () => {
    const ownerToken = await ownCrew(workspace);
    await registerSource(workspaceTarget(workspace), ownerToken, {
      sourceKind: "ticket",
      parent: 28,
      items: [{ key: "one" }],
    });
    makeSourceEarlier({ location: false });

    const { applied } = await apply();

    // An earlier release refused every tracker update of such an item, and it still does.
    expect(applied.exitCode).toBe(0);
    expect(recordedRows().bindings).toEqual([null]);
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
    const producer = await startProducer(reviewing, undefined, {
      dependents: [
        {
          key: "22.4",
          kind: "production",
          title: "The other result",
          dependsOn: [],
          writePaths: ["notes/"],
        },
      ],
    });
    // A gate command must pass at submit, so the flaky check is another one.
    const flaky = [
      { name: "quality", command: "bun run quality", outcome: "passed", detail: "" },
      { name: "integration", command: "bun test", outcome: "flaky", detail: "" },
    ];
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
        checks: ["integration"],
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
    const registered = producer.dependents;
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
    // A gate command must pass at submit, so the flaky check is another one.
    const flaky = [
      { name: "quality", command: "bun run quality", outcome: "passed", detail: "" },
      { name: "integration", command: "bun test", outcome: "flaky", detail: "" },
    ];
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
        checks: ["integration"],
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
    expect(stateVersion()).toBe(18);
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
