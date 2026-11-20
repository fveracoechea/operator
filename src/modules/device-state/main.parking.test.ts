import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OperatorHome } from "../operator-home/main.ts";
import { DeviceState } from "./main.ts";
import { insertRow } from "./state-fixture.ts";

const root = await mkdtemp(path.join(tmpdir(), "operator-parking-kind-"));
afterAll(async () => rm(root, { recursive: true, force: true }));

test.each(["kind", "supervisor"] as const)(
  "the resume interface forwards the %s precondition into its writer",
  (guard) => {
    const paths = OperatorHome.resolve({ HOME: `${root}/${guard}`, NODE_ENV: "test", PATH: "" });
    expect(
      DeviceState.registerProject(paths, {
        repository: "owner/repo",
        checkout: "/synthetic",
        registeredAt: "then",
      }),
    ).toMatchObject({ tag: "Ok" });
    using db = new Database(paths.database);
    insertRow(db, "sources", {
      id: "s",
      repository: "owner/repo",
      state: "open",
      supervising_session: "foreign",
    });
    insertRow(db, "assignments", {
      source_id: "s",
      key: "a",
      completion: "pr",
      state: "pr-open",
      kind: "pr-feedback",
    });
    insertRow(db, "pull_requests", {
      source_id: "s",
      assignment: "a",
      repository: "owner/repo",
      number: 7,
      parking:
        '{"launchId":"l","head":"h","at":"then","note":null,"state":"parked","events":["feedback"]}',
    });
    const before = db.serialize();
    expect(
      DeviceState.resumeParkedPullRequest(
        paths,
        { repository: "owner/repo", sourceId: "s", assignment: "a" },
        guard === "kind" ? "implementation" : undefined,
        { pane: "own:p", session: "own" },
      ),
    ).toMatchObject({
      tag: "Err",
      error: { reason: guard === "kind" ? "assignment_kind_set" : "source_supervised_elsewhere" },
    });
    expect(db.serialize()).toEqual(before);
  },
);
