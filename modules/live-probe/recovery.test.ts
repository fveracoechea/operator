import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no temporary directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginRun } from "./recovery.ts";

// This file writes only in its own directory, so no other test file can see or remove its files.
let scratch = "";
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "operator-probe-recovery-"));
});
afterAll(async () => {
  await rm(scratch, { force: true, recursive: true });
});

test("a lifecycle-only run does not record a configured fixture without a baseline", async () => {
  const root = `${scratch}/${crypto.randomUUID()}`;
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
