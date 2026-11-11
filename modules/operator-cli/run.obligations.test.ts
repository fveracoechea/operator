import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no recursive removal API.
import { rm } from "node:fs/promises";
import { z } from "zod";
import { workerDevice } from "./worker-fixture.ts";

let device: Awaited<ReturnType<typeof workerDevice>>;
beforeEach(async () => {
  device = await workerDevice();
});
afterEach(async () => {
  await rm(device.root, { recursive: true, force: true });
});

const plan = {
  trackerKey: "github:example/one#10",
  assignments: [
    {
      key: "change",
      trackerKey: "github:example/one#11",
      instructions: "Change the module.",
      completion: "report",
      resources: "pane",
      dependencies: [],
    },
  ],
};

async function owed() {
  const read = await device.run(["next"]);
  expect(read.code, read.stderr).toBe(0);
  return z
    .object({ data: z.object({ sources: z.array(z.object({ owed: z.array(z.unknown()) })) }) })
    .parse(read.output).data.sources[0]?.owed;
}

test("an obligation stays in next until the SuperAgent closes it", async () => {
  const source = await device.register(plan);
  const file = await device.writeJson("share.json", {
    key: "share-12",
    kind: "pr-share",
    summary: "Share PR #12 in the team review thread.",
    reference: "https://github.com/example/one/pull/12",
  });
  const added = await device.run(["obligation", "add", "--source", source, "--file", file]);
  expect(added.code, added.stderr).toBe(0);
  expect(added.output).toMatchObject({
    operation: "obligation_add",
    reason: "obligation_added",
    data: { sourceId: source, key: "share-12", kind: "pr-share", state: "open", closedAt: null },
  });
  const openedAt = z.object({ data: z.object({ openedAt: z.string() }) }).parse(added.output)
    .data.openedAt;
  expect(await owed()).toEqual([
    {
      key: "share-12",
      kind: "pr-share",
      summary: "Share PR #12 in the team review thread.",
      reference: "https://github.com/example/one/pull/12",
      openedAt,
    },
  ]);

  // A retry of the same key adds nothing.
  expect(await device.run(["obligation", "add", "--source", source, "--file", file])).toMatchObject(
    { code: 4, output: { reason: "obligation_exists" } },
  );

  const closed = await device.run(["obligation", "close", "--source", source, "--key", "share-12"]);
  expect(closed.code, closed.stderr).toBe(0);
  expect(closed.output).toMatchObject({
    reason: "obligation_closed",
    data: { key: "share-12", state: "closed" },
  });
  const closedAt = z.object({ data: z.object({ closedAt: z.string() }) }).parse(closed.output)
    .data.closedAt;
  expect(Date.parse(closedAt)).toBeGreaterThanOrEqual(Date.parse(openedAt));
  expect(await owed()).toEqual([]);
  expect(
    await device.run(["obligation", "close", "--source", source, "--key", "share-12"]),
  ).toMatchObject({ code: 4, output: { reason: "obligation_not_open" } });

  // The ledger keeps what was closed.
  const listed = await device.run(["obligation", "list", "--source", source]);
  expect(listed.code, listed.stderr).toBe(0);
  expect(listed.output).toMatchObject({
    operation: "obligation_list",
    reason: "obligations_listed",
    data: { sourceId: source, obligations: [{ key: "share-12", state: "closed" }] },
  });
});

test("the ledger refuses invalid input, unknown keys, and unknown sources", async () => {
  const source = await device.register(plan);
  const invalid = await device.writeJson("invalid.json", {
    key: "Rule",
    kind: "promise",
    summary: "",
  });
  expect(
    await device.run(["obligation", "add", "--source", source, "--file", invalid]),
  ).toMatchObject({ code: 2, output: { outcome: "invalid", reason: "invalid_obligation_input" } });
  expect(
    await device.run([
      "obligation",
      "add",
      "--source",
      source,
      "--file",
      `${device.root}/drafts/missing.json`,
    ]),
  ).toMatchObject({ code: 1, output: { reason: "obligation_io_failed" } });
  expect(
    await device.run(["obligation", "close", "--source", source, "--key", "missing"]),
  ).toMatchObject({ code: 4, output: { reason: "obligation_not_found" } });
  expect(await device.run(["obligation", "list", "--source", "missing"])).toMatchObject({
    code: 4,
    output: { reason: "source_not_found" },
  });
  expect(await device.run(["obligation", "list"])).toMatchObject({
    code: 2,
    output: { reason: "invalid_arguments" },
  });
  expect(await device.run(["obligation", "list", "--source", source])).toMatchObject({
    output: { data: { obligations: [] } },
  });
});
