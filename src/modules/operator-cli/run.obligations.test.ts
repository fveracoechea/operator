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
  const file = `${device.root}/share.txt`;
  await Bun.write(file, "Share PR #12 in the team review thread.");
  const add = [
    "obligation",
    "add",
    "--source",
    source,
    "--key",
    "share-12",
    "--kind",
    "pr-share",
    "--reference",
    "https://github.com/example/one/pull/12",
    "--file",
    file,
  ];
  const added = await device.run(add);
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
  expect(await device.run(add)).toMatchObject({ code: 4, output: { reason: "obligation_exists" } });

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
    await device.run([
      "obligation",
      "add",
      "--source",
      source,
      "--key",
      "rule",
      "--kind",
      "standing-rule",
      "--file",
      invalid,
    ]),
  ).toMatchObject({ code: 2, output: { outcome: "invalid", reason: "invalid_obligation_input" } });
  expect(
    await device.run([
      "obligation",
      "add",
      "--source",
      source,
      "--key",
      "rule",
      "--kind",
      "standing-rule",
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

test("obligation add reads plain text from stdin and refuses JSON without writing", async () => {
  const source = await device.register(plan);
  const add = [
    "obligation",
    "add",
    "--source",
    source,
    "--key",
    "hold",
    "--kind",
    "merge-hold",
    "--file",
    "-",
  ];
  const invalid = await device.run(add, { stdin: '{"summary":"Hold it."}' });
  expect(invalid).toMatchObject({
    code: 2,
    output: {
      reason: "invalid_obligation_input",
      next: {
        command: "operator obligation add --source <id> --key <key> --kind <kind> --file <path|->",
      },
    },
  });
  expect(await owed()).toEqual([]);
  for (const stdin of [
    "  \n",
    "x".repeat(2001),
    "[]",
    '"Hold it."',
    "123",
    "true",
    "false",
    "null",
    '  ["hold"]\n',
    '{"hold":true}',
  ]) {
    expect(await device.run(add, { stdin })).toMatchObject({
      code: 2,
      output: { reason: "invalid_obligation_input" },
    });
  }
  expect(await owed()).toEqual([]);
  const added = await device.run(add, {
    stdin: "  Keep `main` on hold.\nUntil the person answers.\n",
  });
  expect(added).toMatchObject({
    code: 0,
    output: {
      data: {
        key: "hold",
        kind: "merge-hold",
        summary: "Keep `main` on hold.\nUntil the person answers.",
        reference: null,
      },
    },
  });
});

test("obligation summaries can begin with brackets or braces when they are prose, not JSON documents", async () => {
  const source = await device.register(plan);
  for (const [index, summary] of [
    "[Hold] Do not merge until approval.",
    "{Reminder} Ask the person first.",
  ].entries()) {
    expect(
      await device.run(
        [
          "obligation",
          "add",
          "--source",
          source,
          "--key",
          `hold-${index}`,
          "--kind",
          "merge-hold",
          "--file",
          "-",
        ],
        { stdin: summary },
      ),
    ).toMatchObject({
      code: 0,
      output: { data: { key: `hold-${index}`, summary } },
    });
  }
  expect(await owed()).toMatchObject([
    { key: "hold-0", summary: "[Hold] Do not merge until approval." },
    { key: "hold-1", summary: "{Reminder} Ask the person first." },
  ]);
});

test("the README obligation stdin example runs on an isolated device", async () => {
  const source = await device.register(plan);
  const readme = await Bun.file(new URL("../../../README.md", import.meta.url)).text();
  const example = /operator obligation add [^\n]+<<'EOF'\n[\s\S]*?\nEOF/.exec(readme)?.[0] ?? "";
  expect(example).toContain("--key share-12 --kind pr-share --reference");
  const added = await device.exec(
    ["bash", "-c", example.replace("<source-id>", source)],
    device.main,
  );
  expect(added.code, added.stderr).toBe(0);
  expect(JSON.parse(added.stdout) as unknown).toMatchObject({
    reason: "obligation_added",
    data: {
      key: "share-12",
      kind: "pr-share",
      summary: "Share PR #12 in the team review thread.",
      reference: "https://github.com/example/one/pull/12",
    },
  });
});
