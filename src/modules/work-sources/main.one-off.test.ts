import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Projects } from "../projects/main.ts";
import { WorkSources } from "./main.ts";

let root: string;
let paths: ReturnType<typeof OperatorHome.resolve>;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-one-off-owner-"));
  paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
});
afterEach(async () => {
  mock.restore();
  await rm(root, { recursive: true, force: true });
});

test.each(["file", "stdin"])(
  "oneOff registers and reads one immutable assignment from %s",
  async (reader) => {
    expect(Bun.spawnSync(["git", "init", "-q", "-b", "main", `${root}/checkout`]).exitCode).toBe(0);
    const cwd = `${root}/checkout`;
    expect(
      Bun.spawnSync(["git", "remote", "add", "origin", "https://github.com/example/one.git"], {
        cwd,
      }).exitCode,
    ).toBe(0);
    expect(await Projects.register({ paths, cwd })).toMatchObject({ tag: "Ok" });
    await Bun.write(paths.config, JSON.stringify({ profiles: { careful: {} } }), {
      createPath: true,
    });
    const file = `${root}/task.md`;
    await Bun.write(file, "Build the queue.");
    const stdin = spyOn(Bun.stdin, "text").mockResolvedValue("Build the queue.");
    const request = {
      paths,
      cwd,
      kind: "prototype",
      brief: reader === "stdin" ? "-" : file,
      trackerKey: "queue:42",
      intent: "Keep ordering.",
      profile: "careful",
    };
    const registered = await WorkSources.oneOff(request);
    expect(registered).toMatchObject({
      tag: "Ok",
      value: {
        trackerKey: "queue:42",
        plan: {
          assignments: [
            {
              key: "build-the-queue",
              kind: "prototype",
              completion: "report",
              resources: "worktree",
              branch: "build-the-queue",
              instructions: "Build the queue.",
              intent: "Keep ordering.",
              profile: "careful",
              dependencies: [],
            },
          ],
        },
        assignments: [{ key: "build-the-queue", completion: "report", state: "ready" }],
      },
    });
    expect(stdin).toHaveBeenCalledTimes(reader === "stdin" ? 1 : 0);
    if (registered.tag !== "Ok") return;
    await Bun.write(file, "Changed task.");
    const shown = await WorkSources.show({ paths, cwd, sourceId: registered.value.id });
    expect(shown).toMatchObject({
      tag: "Ok",
      value: { plan: registered.value.plan, launches: [] },
    });
    expect(registered.value.plan.assignments).toHaveLength(1);
    const before = await Bun.file(paths.database).arrayBuffer();
    expect(await WorkSources.oneOff(request)).toMatchObject({
      tag: "Err",
      error: { reason: "source_parent_open" },
    });
    expect(await Bun.file(paths.database).arrayBuffer()).toEqual(before);
  },
);

test.each([
  { kind: "missing", text: "Read.", profile: undefined, reason: "invalid_source_plan" },
  { kind: "answer", text: "  ", profile: undefined, reason: "invalid_source_plan" },
  { kind: "answer", text: "Read.", profile: "missing", reason: "source_profile_missing" },
])(
  "oneOff refuses $reason before project lookup or database creation",
  async ({ kind, text, profile, reason }) => {
    const project = spyOn(Projects, "current");
    const brief = `${root}/brief.md`;
    await Bun.write(brief, text);
    expect(await WorkSources.oneOff({ paths, cwd: root, kind, brief, profile })).toMatchObject({
      tag: "Err",
      error: { reason },
    });
    expect(project).not.toHaveBeenCalled();
    expect(await Bun.file(paths.database).exists()).toBe(false);
  },
);
