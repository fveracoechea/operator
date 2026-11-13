import { expect, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { registerTestDevice } from "./device-fixture.ts";

test("the command fixture registers isolated state through the public CLI before observation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "operator-device-fixture-"));
  try {
    const bytes = await registerTestDevice(root);
    expect(bytes.byteLength).toBeGreaterThan(0);
    using database = new Database(`${root}/state/operator/operator.sqlite`, { readonly: true });
    expect(database.query("SELECT repository FROM projects").values()).toEqual([
      ["fixture/registered"],
    ]);
    expect(database.query("PRAGMA integrity_check").values()).toEqual([["ok"]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
