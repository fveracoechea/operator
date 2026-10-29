import { expect, spyOn } from "bun:test";
// Bun has no temporary-directory or folder creation API.
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Projects } from "../projects/main.ts";
import { WorkSources } from "../work-sources/main.ts";

export const socket = "/fixture/herdr.sock";
export const workerPane = "w1:p1";
export const superPane = "super:p0";

/** The value of a result that the fixture expects to succeed. */
export function okValue<T>(result: { tag: string; value?: T }) {
  expect(result.tag).toBe("Ok");
  return result.value ?? expect.unreachable("The result has no value.");
}

function assignment(key: string, dependencies: string[] = []) {
  return {
    key,
    trackerKey: `github:example/one#${key.length}`,
    instructions: `Do ${key}.`,
    completion: "report",
    resources: "pane",
    dependencies,
  };
}

/**
 * An isolated device with a real Git checkout, a registered project, and real SQLite state.
 * A launch is recorded through device state, so no Herdr or host runs.
 */
export async function reportDevice() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "operator-report-module-")));
  const paths = OperatorHome.resolve(Environment.parse({ HOME: `${root}/home`, NODE_ENV: "test" }));
  const checkout = `${root}/checkout`;
  await mkdir(checkout);
  for (const args of [
    ["init", "-q"],
    ["remote", "add", "origin", "https://github.com/example/one.git"],
  ])
    expect(await Bun.spawn(["git", ...args], { cwd: checkout, stderr: "pipe" }).exited).toBe(0);
  expect((await Projects.register({ paths, cwd: checkout })).tag).toBe("Ok");
  const real = Environment.read();

  /** The command runs in this Herdr pane, or outside Herdr when a value is null. */
  function inPane(paneId: string | null, herdrSocket: string | null = socket) {
    return spyOn(Environment, "read").mockReturnValue({
      ...real,
      HERDR_PANE_ID: paneId ?? undefined,
      HERDR_SOCKET_PATH: herdrSocket ?? undefined,
    });
  }

  /** A source of report assignments. A second assignment keeps the source open. */
  async function source(keys: string[] = ["read", "later"]) {
    const file = `${root}/plan-${crypto.randomUUID()}.json`;
    await Bun.write(
      file,
      JSON.stringify({
        trackerKey: "github:example/one#1",
        assignments: keys.map((key) => assignment(key)),
      }),
    );
    return okValue(await WorkSources.register({ paths, cwd: checkout, file })).id;
  }

  /** Record a running launch in the worker pane. */
  async function launch(
    sourceId: string,
    key = "read",
    resources: { worktreePath?: string; branch?: string; paneId?: string | null } = {},
  ) {
    const id = crypto.randomUUID();
    const name = `report-${key}-${id.slice(0, 8)}`;
    const reserved = DeviceState.reserveLaunch(paths, checkout, "example/one", {
      id,
      sourceId,
      assignment: key,
      state: "starting",
      name,
      resources: "pane",
      branch: resources.branch ?? null,
      host: "opencode",
      model: "test/model",
      requestedModel: "test/model",
      reasoningEffort: "medium",
      profile: null,
      release: JSON.stringify({ version: "1.0.0" }),
      skills: "[]",
      herdrSocket: socket,
      workspaceId: "w1",
      tabId: "w1:t1",
      paneId: null,
      worktreePath: resources.worktreePath ?? null,
      worktreeWorkspaceId: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      failureReason: null,
      failureDetail: null,
      activity: null,
      activityAt: null,
    });
    expect(reserved.tag).toBe("Ok");
    const paneId = resources.paneId === undefined ? workerPane : resources.paneId;
    expect(DeviceState.updateLaunch(paths, id, { state: "running", paneId }).tag).toBe("Ok");
    return { id, name, paneId };
  }

  /** The recorded source as the module interface shows it. */
  async function show(sourceId: string) {
    return (
      okValue(await WorkSources.show({ paths, cwd: checkout, sourceId })) ??
      expect.unreachable("The source is missing.")
    );
  }

  async function writeJson(name: string, value: Record<string, unknown>) {
    const file = `${root}/drafts/${name}`;
    await Bun.write(file, JSON.stringify(value), { createPath: true });
    return file;
  }

  /** Every file below a folder, relative to it. */
  async function files(directory: string) {
    const found: string[] = [];
    for await (const file of new Bun.Glob("**").scan({ cwd: directory, onlyFiles: true }))
      found.push(file);
    return found.toSorted();
  }

  function assignmentFiles(sourceId: string, key = "read") {
    return OperatorHome.assignmentFiles(paths, {
      repository: "example/one",
      sourceId,
      assignment: key,
    });
  }

  const stateSchema = z.object({ key: z.string(), state: z.string() });
  async function states(sourceId: string) {
    return Object.fromEntries(
      z
        .array(stateSchema)
        .parse((await show(sourceId)).assignments)
        .map((row) => [row.key, row.state]),
    );
  }

  return {
    root,
    paths,
    checkout,
    inPane,
    source,
    launch,
    show,
    states,
    writeJson,
    files,
    assignmentFiles,
  };
}
