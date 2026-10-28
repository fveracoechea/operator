import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { createDatabase, databaseExists } from "./creation.ts";

const root = await mkdtemp(path.join(tmpdir(), "operator-creation-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("publishes one complete migrated database and never replaces an existing winner", () => {
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
    await Array.fromAsync(new Bun.Glob(".registration-*").scan({ cwd: paths.stateRoot })),
  ).toEqual([]);
});
