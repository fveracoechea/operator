import { expect, spyOn } from "bun:test";
import { ErrAsync, OkAsync } from "unthrown";
// Bun has no temporary-directory or folder creation API.
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { Herdr } from "../herdr/main.ts";
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

/**
 * An isolated device with a real Git checkout, a registered project, and real SQLite state.
 * A launch is recorded through device state, so no Herdr or host runs.
 */
export async function questionDevice() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "operator-question-module-")));
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
  /** Each doorbell that a command typed, and whether the next one fails. */
  const doorbells: { name: string; text: string }[] = [];
  const herdr = { fails: false };

  /**
   * The command runs in this Herdr pane, or outside Herdr when the pane is null. Herdr records
   * each doorbell instead of typing it.
   */
  function inPane(paneId: string | null) {
    spyOn(Herdr, "prompt").mockImplementation((input) => {
      doorbells.push(input);
      return herdr.fails
        ? ErrAsync({ reason: "herdr_failed" as const, detail: "herdr agent exited 1: gone" })
        : OkAsync(null);
    });
    return spyOn(Environment, "read").mockReturnValue({
      ...real,
      HERDR_PANE_ID: paneId ?? undefined,
      HERDR_SOCKET_PATH: paneId === null ? undefined : socket,
    });
  }

  /** A source with report assignments `read` and `later`. */
  async function source() {
    const file = `${root}/plan-${crypto.randomUUID()}.json`;
    await Bun.write(
      file,
      JSON.stringify({
        trackerKey: "github:example/one#1",
        assignments: ["read", "later"].map((key) => ({
          key,
          trackerKey: `github:example/one#${key.length}`,
          instructions: `Do ${key}.`,
          kind: "research",
          resources: "pane",
          dependencies: [],
        })),
      }),
    );
    return okValue(await WorkSources.register({ paths, cwd: checkout, file })).id;
  }

  /** The Herdr agent name of a launch that `launch` recorded. */
  function launchName(id: string) {
    return `report-read-${id.slice(0, 8)}`;
  }

  /** Record a running launch of `read` in the worker pane. */
  function launch(sourceId: string) {
    const id = crypto.randomUUID();
    expect(
      DeviceState.reserveLaunch(paths, checkout, "example/one", {
        id,
        sourceId,
        assignment: "read",
        state: "starting",
        name: launchName(id),
        resources: "pane",
        branch: null,
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
        worktreePath: null,
        worktreeWorkspaceId: null,
        startedAt: new Date().toISOString(),
        endedAt: null,
        failureReason: null,
        failureDetail: null,
        activity: null,
        activityAt: null,
      }).tag,
    ).toBe("Ok");
    expect(DeviceState.updateLaunch(paths, id, { state: "running", paneId: workerPane }).tag).toBe(
      "Ok",
    );
    return id;
  }

  /** The Herdr plugin reports the worker's pane, as idle after a turn that ended or as exited. */
  function observe(observation: { exited: true } | { exited: false; activity: string }) {
    expect(
      DeviceState.observePane(paths, { socket, paneId: workerPane, workspaceId: "w1", observation })
        .tag,
    ).toBe("Ok");
  }

  async function write(name: string, content: string) {
    const file = `${root}/drafts/${name}`;
    await Bun.write(file, content, { createPath: true });
    return file;
  }

  /** The actions of the one source, as the SuperAgent reads them. */
  async function actions() {
    const next = okValue(await WorkSources.next({ paths, cwd: checkout, all: true }));
    return next.sources[0]?.actions ?? expect.unreachable("The source is missing.");
  }

  return {
    root,
    paths,
    checkout,
    inPane,
    source,
    launch,
    launchName,
    observe,
    write,
    actions,
    doorbells,
    herdr,
  };
}
