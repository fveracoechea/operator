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
