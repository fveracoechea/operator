import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
// Bun has no temporary-directory, folder, symlink, mode, or recursive removal API.
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { createDatabase, databaseExists } from "./creation.ts";

const root = await mkdtemp(path.join(tmpdir(), "operator-creation-"));
afterEach(() => {
  mock.restore();
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("publishes one complete migrated database and never replaces an existing winner", async () => {
  const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
  const one = { repository: "owner/one", checkout: "/isolated/one", registeredAt: "now" };
  const two = { repository: "owner/two", checkout: "/isolated/two", registeredAt: "now" };
  expect(databaseExists(paths.database)).toBe(false);
  expect(createDatabase(paths, one)).toMatchObject({ tag: "Ok" });
  expect(databaseExists(paths.database)).toBe(true);
  expect(createDatabase(paths, two)).toMatchObject({ tag: "Ok" });
  using db = new Database(paths.database, { readonly: true });
  expect(db.query("SELECT repository FROM projects ORDER BY repository").all()).toEqual([
    { repository: "owner/one" },
    { repository: "owner/two" },
  ]);
  expect(db.query("SELECT * FROM __drizzle_migrations").all()).toHaveLength(11);
  expect((await stat(paths.stateRoot)).mode.toString(8)).toEndWith("700");
  expect((await stat(paths.database)).mode.toString(8)).toEndWith("600");
  expect(
    await Array.fromAsync(
      new Bun.Glob(".registration-*").scan({ cwd: paths.stateRoot, dot: true }),
    ),
  ).toEqual([]);
});

test("only a regular file counts as the device database", async () => {
  const paths = OperatorHome.resolve(
    Environment.parse({ HOME: `${root}/shapes`, NODE_ENV: "test" }),
  );
  await mkdir(paths.database, { recursive: true });
  const unsupported = {
    code: "STATE_UNSUPPORTED",
    message: "The device database must be a regular file, not a link or directory.",
  };
  expect(() => databaseExists(paths.database)).toThrow(expect.objectContaining(unsupported));
  await rm(paths.database, { recursive: true });
  await Bun.write(`${paths.stateRoot}/target`, "");
  await symlink(`${paths.stateRoot}/target`, paths.database);
  expect(() => databaseExists(paths.database)).toThrow(expect.objectContaining(unsupported));
  expect(() => databaseExists(`${paths.stateRoot}/target/operator.sqlite`)).toThrow(
    expect.objectContaining({ code: "ENOTDIR" }),
  );
});

test("a pre-existing non-database file remains byte-for-byte unchanged", async () => {
  const paths = OperatorHome.resolve(
    Environment.parse({ HOME: `${root}/invalid`, NODE_ENV: "test" }),
  );
  await Bun.write(paths.database, "unowned state\n", { createPath: true });
  expect(
    createDatabase(paths, {
      repository: "owner/repo",
      checkout: "/isolated/repo",
      registeredAt: "now",
    }),
  ).toMatchObject({ tag: "Err", error: { reason: "state_corrupt" } });
  expect(await Bun.file(paths.database).text()).toBe("unowned state\n");
  expect(
    await Array.fromAsync(
      new Bun.Glob(".registration-*").scan({ cwd: paths.stateRoot, dot: true }),
    ),
  ).toEqual([]);
});

test("a registration file that already exists is never reused or replaced", async () => {
  const paths = OperatorHome.resolve(
    Environment.parse({ HOME: `${root}/taken`, NODE_ENV: "test" }),
  );
  const nonce = "00000000-0000-4000-8000-000000000000";
  const taken = OperatorHome.registrationDatabase(paths, nonce);
  await Bun.write(taken, "another writer", { createPath: true });
  spyOn(crypto, "randomUUID").mockReturnValue(nonce);
  expect(
    createDatabase(paths, {
      repository: "owner/repo",
      checkout: "/isolated/repo",
      registeredAt: "now",
    }),
  ).toMatchObject({ tag: "Err", error: { reason: "state_io_failed" } });
  expect(await Bun.file(taken).text()).toBe("another writer");
  expect(await Bun.file(paths.database).exists()).toBe(false);
});
