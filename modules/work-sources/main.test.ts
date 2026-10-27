import { afterAll, expect, expectTypeOf, spyOn, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fromPromise, Ok } from "unthrown";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Projects } from "../projects/main.ts";
import { DeviceState } from "../device-state/main.ts";
import { WorkSources } from "./main.ts";
import { decodeSource } from "./snapshot.ts";

const root = await mkdtemp(path.join(tmpdir(), "operator-source-api-"));
const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("failure reasons remain a closed union", () => {
  type Failure = Extract<Awaited<ReturnType<typeof WorkSources.register>>, { tag: "Err" }>["error"];
  expectTypeOf<Failure["reason"]>().not.toEqualTypeOf<string>();
});
test("missing files and invalid plans are failures without project lookup or implicit database creation", async () => {
  const spy = spyOn(Projects, "current");
  try {
    expect(await WorkSources.register({ paths, cwd: root, file: `${root}/missing` })).toMatchObject(
      { tag: "Err", error: { reason: "source_io_failed" } },
    );
    await Bun.write(`${root}/bad.json`, "{broken");
    expect(
      await WorkSources.register({ paths, cwd: root, file: `${root}/bad.json` }),
    ).toMatchObject({ tag: "Err", error: { reason: "invalid_source_plan" } });
    expect(spy).not.toHaveBeenCalled();
    expect(await Bun.file(paths.database).exists()).toBe(false);
  } finally {
    spy.mockRestore();
  }
});
test("a collaborator defect remains a defect rather than permission to register", async () => {
  await Bun.write(`${root}/empty.json`, JSON.stringify({ trackerKey: "APP-1", assignments: [] }));
  const spy = spyOn(Projects, "current").mockImplementation(() =>
    fromPromise(
      async () => {
        // oxlint-disable-next-line unthrown/no-throw -- Inject a defect at the project interface.
        throw new TypeError("project defect");
      },
      (cause, defect) => defect(cause),
    ),
  );
  try {
    expect(
      await WorkSources.register({ paths, cwd: root, file: `${root}/empty.json` }),
    ).toMatchObject({ tag: "Defect" });
    expect(await Bun.file(paths.database).exists()).toBe(false);
  } finally {
    spy.mockRestore();
  }
});
test("the module reads one snapshot and reports ended reset sources without dispatch", async () => {
  const project = spyOn(Projects, "current").mockImplementation(() =>
    fromPromise(
      async () => ({
        reason: "project_resolved" as const,
        data: { repository: "example/one", checkout: root, registeredAt: "now" },
      }),
      (cause, defect) => defect(cause),
    ),
  );
  const storage = spyOn(DeviceState, "readSources").mockReturnValue(
    Ok([
      {
        source: {
          id: "one",
          repository: "example/one",
          trackerKey: "APP-1",
          state: "reset",
          registeredAt: "now",
          endedAt: "later",
          plan: JSON.stringify({ trackerKey: "APP-1", assignments: [] }),
        },
        assignments: [],
        launches: [],
        pullRequests: [],
        reports: [],
        cleanups: [],
      },
    ]),
  );
  try {
    expect(await WorkSources.next({ paths, cwd: root })).toMatchObject({
      tag: "Ok",
      value: { sources: [{ id: "one", state: "reset", actions: [{ action: "source_ended" }] }] },
    });
    expect(storage).toHaveBeenCalledTimes(1);
  } finally {
    project.mockRestore();
    storage.mockRestore();
  }
});

test("a dependent carries the latest accepted report of each direct dependency", () => {
  function assignment(key: string, dependencies: string[]) {
    return {
      key,
      trackerKey: `APP-${key}`,
      instructions: "Work.",
      completion: "report",
      resources: "pane",
      dependencies,
    };
  }
  function launch(assignment: string) {
    return {
      id: `l-${assignment}`,
      sourceId: "one",
      assignment,
      attempt: 1,
      state: "running",
      name: `report-${assignment}`,
      resources: "pane",
      branch: null,
      host: "opencode",
      model: "test/model",
      requestedModel: "test/model",
      reasoningEffort: "medium",
      profile: null,
      release: JSON.stringify({ version: "1.0.0" }),
      skills: "[]",
      herdrSocket: "/herdr.sock",
      workspaceId: "w1",
      tabId: "w1:t1",
      paneId: "w1:p1",
      worktreePath: null,
      worktreeWorkspaceId: null,
      startedAt: "now",
      endedAt: null,
      failureReason: null,
      failureDetail: null,
      activity: null,
      activityAt: null,
      ownerPid: null,
      leaseAt: null,
      abandoned: false,
    };
  }
  function report(assignment: string, number: number, decision: string | null) {
    return {
      sourceId: "one",
      assignment,
      number,
      launchId: `l-${assignment}`,
      submittedAt: "now",
      conclusion: `${assignment} ${number}.`,
      evidence: JSON.stringify(["a.ts:1"]),
      unresolved: JSON.stringify([`Gap ${number}.`]),
      decisions: "[]",
      files: "[]",
      decision,
      decidedAt: decision === null ? null : "later",
      followUp: decision === "returned" ? "Again." : null,
      cleanupState: decision === "accepted" ? "done" : null,
      cleanupDetail: null,
    };
  }
  function state(key: string, value: string) {
    return {
      sourceId: "one",
      key,
      completion: "report",
      state: value,
    };
  }
  const source = decodeSource({
    source: {
      id: "one",
      repository: "example/one",
      trackerKey: "APP-1",
      state: "open",
      registeredAt: "now",
      endedAt: null,
      plan: JSON.stringify({
        trackerKey: "APP-1",
        assignments: [
          assignment("read", []),
          assignment("survey", []),
          assignment("use", ["read", "survey"]),
          assignment("later", ["use"]),
        ],
      }),
    },
    assignments: [
      state("read", "completed"),
      state("survey", "reported"),
      state("use", "ready"),
      state("later", "ready"),
    ],
    launches: [launch("read"), launch("survey")],
    pullRequests: [],
    reports: [
      report("read", 1, "returned"),
      report("read", 2, "accepted"),
      report("survey", 1, null),
    ],
    cleanups: [],
  });
  // An undecided or returned report is not accepted content, and gaps do not skip a level.
  expect(WorkSources.dependencyReports(source, "use")).toEqual([
    {
      assignment: "read",
      report: 2,
      conclusion: "read 2.",
      unresolved: ["Gap 2."],
      reference: "operator:example/one/sources/one/assignments/read/reports/2",
    },
  ]);
  expect(WorkSources.dependencyReports(source, "later")).toEqual([]);
});
