import { afterEach, expect, test } from "bun:test";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { readJournal, writeJournal, type PublicationJournal } from "./journal.ts";

const root = `${Bun.env.TMPDIR ?? "/tmp"}/operator-journal-${crypto.randomUUID()}`;
const path = `${root}/publication.json`;
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("publication history distinguishes missing, invalid, and retained delivery records", async () => {
  expect(await readJournal(path)).toEqual({ state: "missing" });
  await Bun.write(path, "not JSON", { createPath: true });
  expect((await readJournal(path)).state).toBe("unreadable");
  await Bun.write(path, '{"schemaVersion":2}');
  expect((await readJournal(path)).state).toBe("unreadable");
  const journal: PublicationJournal = {
    schemaVersion: 1,
    releaseId: "release",
    version: "1.0.0",
    commit: "commit",
    artifactIdentity: "artifact",
    paths: { jsr: { state: "published", detail: "sent", reference: null, at: "time" } },
  };
  await writeJournal(path, journal);
  expect(await readJournal(path)).toEqual({ state: "read", journal });
});
