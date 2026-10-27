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
  expect(OperatorHome.upstreamTemporaryPrefix()).toBe(path.join(tmpdir(), "operator-matt-"));
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
});
