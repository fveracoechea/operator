import { afterAll, expect, test } from "bun:test";
// Bun has no temporary directory, symlink, or account-home API.
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "./main.ts";

const root = await mkdtemp(path.join(tmpdir(), "operator-home-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("uses the same home defaults on Linux and macOS without creating them", async () => {
  const paths = OperatorHome.resolve(Environment.parse({ HOME: `${root}/home`, NODE_ENV: "test" }));
  expect(paths.config).toBe(`${root}/home/.config/operator/config.json`);
  expect(paths.stateRoot).toBe(`${root}/home/.local/state/operator`);
  expect(paths.skillHosts.opencode).toBe(`${root}/home/.config/opencode/skills`);
  expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root }))).toEqual([]);
});

test("owns separate XDG settings, receipts, and lock paths", () => {
  const paths = OperatorHome.resolve(
    Environment.parse({
      HOME: `${root}/home`,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
      NODE_ENV: "test",
    }),
  );
  expect(paths.config).toBe(`${root}/config/operator/config.json`);
  expect(paths.schema).toBe(`${root}/config/operator/config.schema.json`);
  expect(paths.receipt).toBe(`${root}/state/operator/config/apply.json`);
  expect(paths.writeLock).toBe(`${root}/state/operator/config/write.sqlite`);
  expect(paths.configState).toBe(`${root}/state/operator/config`);
  expect(paths.receiptTemporaryPrefix).toBe(`${root}/state/operator/config/apply.json.tmp-`);
  expect(paths.configTemporaryPrefix).toBe(`${root}/config/operator/config.json.tmp-`);
  expect(paths.herdrPlugin).toBe(`${root}/state/operator/herdr-plugin`);
  expect(OperatorHome.reviewFiles(paths, { repository: "o/r", requestId: "a/b" })).toEqual({
    directory: `${root}/state/operator/projects/o/r/reviews/a%2Fb`,
    brief: `${root}/state/operator/projects/o/r/reviews/a%2Fb/brief.md`,
    draft: `${root}/state/operator/projects/o/r/reviews/a%2Fb/draft.json`,
    rounds: `${root}/state/operator/projects/o/r/reviews/a%2Fb/rounds`,
  });
  expect(paths.database).toBe(`${root}/state/operator/operator.sqlite`);
  expect(paths.backups).toBe(`${root}/state/operator/backups`);
  expect(OperatorHome.migrationBackup(paths, "update-id")).toEqual({
    directory: `${root}/state/operator/backups/update-id`,
    database: `${root}/state/operator/backups/update-id/operator.sqlite`,
    receipt: `${root}/state/operator/backups/update-id/verified.json`,
  });
  expect(paths.projects).toBe(`${root}/state/operator/projects`);
  expect(paths.skillHosts).toEqual({
    opencode: `${root}/config/opencode/skills`,
    "claude-code": `${root}/home/.claude/skills`,
  });
  expect(paths.ownedSkills).toBe(`${root}/state/operator/owned-skills.json`);
  expect(paths.skillsLock).toBe(`${root}/state/operator/owned-skills-lock.sqlite`);
  expect(paths.upstreamSkills).toEqual({
    opencode: `${root}/home/.agents/skills`,
    "claude-code": `${root}/home/.claude/skills`,
  });
  expect(OperatorHome.registrationDatabase(paths, "test-nonce")).toBe(
    `${root}/state/operator/.registration-test-nonce.sqlite`,
  );
  expect(OperatorHome.projectDirectory(paths, "owner/repo")).toBe(
    `${root}/state/operator/projects/owner/repo`,
  );
});

test("skill and launcher test roots must remain in temporary storage without probing real contents", () => {
  const environment = Environment.parse({ HOME: root, NODE_ENV: "test" });
  expect(() => OperatorHome.guardTemporaryTests(environment, [root])).not.toThrow();
  expect(() => OperatorHome.guardTemporaryTests(environment, [tmpdir()])).not.toThrow();
  expect(() =>
    OperatorHome.guardTemporaryTests(environment, [`${root}/missing/child`]),
  ).not.toThrow();
  expect(() =>
    OperatorHome.guardTemporaryTests(environment, ["/non-temporary-skill-test"]),
  ).toThrow("Tests cannot access non-temporary install roots");
});

test("refuses the real default roots, descendants, and aliases without opening state", async () => {
  const home = userInfo().homedir;
  await symlink(home, `${root}/alias`);
  for (const candidate of [home, `${root}/alias`]) {
    expect(() =>
      OperatorHome.resolve(Environment.parse({ HOME: candidate, NODE_ENV: "test" })),
    ).toThrow("Tests cannot access");
  }
  expect(() =>
    OperatorHome.resolve(
      Environment.parse({
        HOME: `${root}/fake`,
        XDG_CONFIG_HOME: `${home}/.config/operator/child`,
        NODE_ENV: "test",
      }),
    ),
  ).toThrow("Tests cannot access");
  expect(() =>
    OperatorHome.resolve(
      Environment.parse({
        HOME: `${root}/fake`,
        XDG_STATE_HOME: `${home}/.local/state`,
        NODE_ENV: "test",
      }),
    ),
  ).toThrow(new Error(`Tests cannot access the real Operator root: ${home}/.local/state/operator`));
  await symlink(`${home}/.config`, `${root}/config-alias`);
  expect(() =>
    OperatorHome.resolve(
      Environment.parse({
        HOME: `${root}/fake`,
        XDG_CONFIG_HOME: `${root}/config-alias`,
        NODE_ENV: "test",
      }),
    ),
  ).toThrow(new Error(`Tests cannot access the real Operator root: ${home}/.config/operator`));
});

test("allows a sibling of a real root and leaves resolution unguarded outside tests", () => {
  const home = userInfo().homedir;
  expect(
    OperatorHome.resolve(
      Environment.parse({
        HOME: `${root}/fake`,
        XDG_CONFIG_HOME: `${home}/.config/operator-sibling`,
        NODE_ENV: "test",
      }),
    ).configRoot,
  ).toBe(`${home}/.config/operator-sibling/operator`);
  expect(OperatorHome.resolve(Environment.parse({ HOME: home })).stateRoot).toBe(
    `${home}/.local/state/operator`,
  );
  expect(() =>
    OperatorHome.guardTemporaryTests(Environment.parse({ HOME: home }), [
      "/non-temporary-skill-test",
    ]),
  ).not.toThrow();
});

test("assignment files stay in one encoded directory under the project state", () => {
  const paths = { projects: "/state/projects" };
  expect(
    OperatorHome.assignmentFiles(paths, { repository: "o/r", sourceId: "s", assignment: "read" }),
  ).toEqual({
    directory: "/state/projects/o/r/sources/s/assignments/read",
    brief: "/state/projects/o/r/sources/s/assignments/read/brief.md",
    reports: "/state/projects/o/r/sources/s/assignments/read/reports",
    followUps: "/state/projects/o/r/sources/s/assignments/read/follow-ups",
  });
  for (const assignment of ["..", ".", "a/../../b", "a/b"])
    expect(
      OperatorHome.assignmentFiles(paths, { repository: "o/r", sourceId: "s", assignment })
        .directory,
    ).toMatch(/^\/state\/projects\/o\/r\/sources\/s\/assignments\/[^/.]+$/);
  // Prune deletes exactly the folder that holds every assignment file of the source.
  expect(OperatorHome.sourceDirectory(paths, { repository: "o/r", sourceId: "s/../x" })).toBe(
    "/state/projects/o/r/sources/s%2F..%2Fx",
  );
});
