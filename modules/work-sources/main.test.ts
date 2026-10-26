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
