import { afterEach, expect, test } from "bun:test";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { beginRun } from "./recovery.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("a lifecycle-only run does not record a configured fixture without a baseline", async () => {
  const root = `/tmp/opencode/probe-recovery-${crypto.randomUUID()}`;
  roots.push(root);
  const runId = crypto.randomUUID();
  await beginRun(root, {
    runId,
    probeId: "approved-probe",
    fixture: { repository: "someone/probe-fixture", issue: 7 },
    fixtureState: null,
    writes: [],
  });

  const record = await Bun.file(`${root}/.operator/local/probe/${runId}/run.json`).json();
  expect(record.fixture).toBeNull();
  expect(record.fixtureState).toBeNull();
});
