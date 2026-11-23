import { afterAll, expect, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { resumeMutationSelection } from "./mutation-resume.ts";

const root = await mkdtemp(path.join(tmpdir(), "mutation-resume-"));
afterAll(() => rm(root, { recursive: true, force: true }));

test("resume selects current complete units instead of stale changed-line ranges", async () => {
  const runId = crypto.randomUUID();
  await Bun.write(`${root}/unit.ts`, "export const value = 2;\n");
  await Bun.write(`${root}/unit.test.ts`, 'import { value } from "./unit.ts";');
  await Bun.write(
    `${root}/.mutation-runs/${runId}.json`,
    JSON.stringify({
      version: 1,
      runId,
      state: { units: [{ name: "unit.ts", patterns: ["unit.ts:9:0-9:1"], status: "interrupted" }] },
    }),
  );
  const selected = await resumeMutationSelection(root, runId);
  expect(selected).toEqual({
    skipped: 0,
    units: [
      {
        name: "unit.ts",
        source: "export const value = 2;\n",
        tests: ["./unit.test.ts"],
        patterns: ["unit.ts"],
      },
    ],
  });
});

test("resume refuses unsafe IDs and absent, partial, mismatched or invalid selected evidence", async () => {
  expect(await resumeMutationSelection(root, "../outside")).toEqual({
    error: "Invalid mutation resume run ID.",
  });
  for (const invalid of [`prefix${crypto.randomUUID()}`, `${crypto.randomUUID()}suffix`])
    expect(await resumeMutationSelection(root, invalid)).toEqual({
      error: "Invalid mutation resume run ID.",
    });
  const runId = crypto.randomUUID();
  expect(await resumeMutationSelection(root, runId)).toEqual({
    error: "Mutation resume evidence is missing or incomplete.",
  });
  const file = `${root}/.mutation-runs/${runId}.json`;
  for (const evidence of [
    '{"version":1,',
    '{"version":1}',
    JSON.stringify({ version: 1, runId, state: { units: [] } }),
  ]) {
    await Bun.write(file, evidence);
    expect(await resumeMutationSelection(root, runId)).toEqual({
      error: "Mutation resume evidence is missing or incomplete.",
    });
  }
  await Bun.write(
    file,
    JSON.stringify({ version: 1, runId: "different", state: { units: [{ name: "unit.ts" }] } }),
  );
  expect(await resumeMutationSelection(root, runId)).toEqual({
    error: "Mutation resume run ID does not match evidence.",
  });
  await Bun.write(
    file,
    JSON.stringify({ version: 1, runId, state: { units: [{ name: "deleted.ts" }] } }),
  );
  expect(await resumeMutationSelection(root, runId)).toEqual({
    error: "Target file does not exist: deleted.ts",
  });
  await Bun.write(
    file,
    JSON.stringify({
      version: 1,
      runId,
      mode: "preflight",
      state: { units: [{ name: "unit.ts" }] },
    }),
  );
  expect(await resumeMutationSelection(root, runId)).toEqual({
    error: "Preflight evidence cannot resume mutation qualification.",
  });
});

test("resume retains a prior eligible identity for current-input comparison", async () => {
  const runId = crypto.randomUUID();
  await Bun.write(`${root}/owned.ts`, "export const value = 2;\n");
  await Bun.write(`${root}/owned.test.ts`, 'import "./owned.ts";');
  await Bun.write(
    `${root}/.mutation-runs/${runId}.json`,
    JSON.stringify({
      version: 1,
      runId,
      state: {
        units: [
          {
            name: "owned.ts",
            reuse: { eligible: true, identity: "prior-inputs", lookup: "miss" },
          },
        ],
      },
    }),
  );
  const selected = await resumeMutationSelection(root, runId);
  expect(selected).toMatchObject({
    units: [{ name: "owned.ts", previousIdentity: "prior-inputs" }],
  });
});
