import { afterAll, expect, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { DeviceState } from "./main.ts";

const root = await mkdtemp(path.join(tmpdir(), "operator-state-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("only registration creates state and lookup remains project-scoped", async () => {
  const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
  expect(DeviceState.checkCompatibility(paths)).toMatchObject({
    tag: "Err",
    error: { reason: "state_missing" },
  });
  expect(DeviceState.checkCompatibility(paths, true).tag).toBe("Ok");
  expect(DeviceState.readSources(paths, "owner/one")).toMatchObject({
    tag: "Err",
    error: { reason: "state_missing" },
  });
  expect(
    DeviceState.registerSource(
      paths,
      "/isolated/one",
      {
        id: "one",
        repository: "owner/one",
        trackerKey: "APP-1",
        state: "open",
        registeredAt: "now",
        endedAt: null,
        plan: "{}",
      },
      [],
    ),
  ).toMatchObject({ tag: "Err", error: { reason: "state_missing" } });
  expect(DeviceState.lookupProject(paths, "/isolated/one", [])).toMatchObject({
    tag: "Err",
    error: { reason: "state_missing" },
  });
  expect(await Bun.file(paths.database).exists()).toBe(false);
  for (const name of ["one", "two"])
    expect(
      DeviceState.registerProject(paths, {
        repository: `owner/${name}`,
        checkout: `/isolated/${name}`,
        registeredAt: "now",
      }).tag,
    ).toBe("Ok");
  expect(DeviceState.lookupProject(paths, "/isolated/one", ["owner/one"])).toMatchObject({
    tag: "Ok",
    value: { controller: { repository: "owner/one" }, matches: [{ repository: "owner/one" }] },
  });
  expect(DeviceState.checkCompatibility(paths).tag).toBe("Ok");
  expect(
    DeviceState.registerSource(
      paths,
      "/isolated/one",
      {
        id: "one",
        repository: "owner/one",
        trackerKey: "APP-1",
        state: "finished",
        registeredAt: "now",
        endedAt: "now",
        plan: "{}",
      },
      [],
    ).tag,
  ).toBe("Ok");
  expect(DeviceState.readSources(paths, "owner/one", "one")).toMatchObject({
    tag: "Ok",
    value: [{ source: { id: "one" }, assignments: [] }],
  });
  expect(DeviceState.listProjects(paths)).toMatchObject({
    tag: "Ok",
    value: {
      projects: [
        { repository: "owner/one", openSources: 0 },
        { repository: "owner/two", openSources: 0 },
      ],
    },
  });
  expect(DeviceState.moveProject(paths, "owner/one", "/isolated/moved")).toMatchObject({
    tag: "Ok",
    value: { data: { checkout: "/isolated/moved" } },
  });
  expect(DeviceState.removeProject(paths, "owner/one")).toMatchObject({
    tag: "Ok",
    value: { reason: "project_removed" },
  });
  expect(DeviceState.listProjects(paths)).toMatchObject({
    tag: "Ok",
    value: { projects: [{ repository: "owner/two" }], pendingRemovals: [] },
  });
  await rm(paths.database);
  expect(DeviceState.lookupProject(paths, "/isolated/one", ["owner/one"])).toMatchObject({
    tag: "Err",
    error: { reason: "state_missing" },
  });
  expect(await Bun.file(paths.database).exists()).toBe(false);
});
