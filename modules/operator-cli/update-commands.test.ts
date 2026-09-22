import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ownCrew, requestId, runJson, type Workspace, workspaces } from "./workspace-fixture.ts";

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
  sqlite.query("update state_meta set state_version = 1").run();
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

  test("writes the exact registry alias for the selected package version", async () => {
    const { applied } = await apply(["--delivery", "jsr", "--package-version", "1.2.3"]);

    expect(applied.exitCode).toBe(0);
    const manifest = await Bun.file(`${workspace.repo}/.operator/install/package.json`).json();
    expect(manifest.dependencies["@fveracoechea/operator"]).toBe(
      "npm:@jsr/fveracoechea__operator@1.2.3",
    );
  });

  test("names the launcher that keeps the project working directory", async () => {
    const { applied } = await apply(["--delivery", "jsr", "--package-version", "1.2.3"]);

    expect(applied.json.data.commands.run).toContain("Bun.resolveSync");
    expect(applied.json.data.commands.run).toContain(".operator/install");
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
    expect(stateVersion()).toBe(2);
    expect(recordedRelease()).toBe(applied.json.data.selection.releaseIdentity);
    expect((await runJson(workspace, ["work", "frontier"])).exitCode).toBe(0);
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
});
