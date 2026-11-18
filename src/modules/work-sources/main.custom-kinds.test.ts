import { afterAll, expect, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Projects } from "../projects/main.ts";
import { WorkSources } from "./main.ts";

const root = await mkdtemp(path.join(tmpdir(), "pr424-kind-sources-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
const definition = {
  completion: "report",
  resources: "pane",
  profile: "careful",
  guide: "audit-guide/SKILL.md",
  workPhases: [{ name: "audit", goal: "Check evidence." }],
};

test("registration uses configured kind defaults, validates their profile and preserves the registered plan", async () => {
  const git = Bun.spawnSync(["git", "init", "-q", "-b", "main", `${root}/checkout`]);
  expect(git.exitCode).toBe(0);
  expect(
    Bun.spawnSync(["git", "remote", "add", "origin", "https://github.com/example/one.git"], {
      cwd: `${root}/checkout`,
    }).exitCode,
  ).toBe(0);
  expect(await Projects.register({ paths, cwd: `${root}/checkout` })).toMatchObject({ tag: "Ok" });
  await Bun.write(`${paths.skillHosts.opencode}/audit-guide/SKILL.md`, "Audit.", {
    createPath: true,
  });
  await Bun.write(paths.config, JSON.stringify({ kinds: { audit: definition } }), {
    createPath: true,
  });
  const plan = {
    trackerKey: "APP-1",
    assignments: [
      { key: "read", trackerKey: "APP-2", kind: "audit", instructions: "Audit.", dependencies: [] },
    ],
  };
  const file = `${root}/plan.json`;
  await Bun.write(file, JSON.stringify(plan));
  const request = { paths, cwd: `${root}/checkout`, file };
  expect(await WorkSources.register(request)).toMatchObject({
    tag: "Err",
    error: { reason: "source_profile_missing", state: { profile: "careful" } },
  });
  expect(await WorkSources.next(request)).toMatchObject({ tag: "Ok", value: { sources: [] } });
  await Bun.write(
    paths.config,
    JSON.stringify({ kinds: { audit: definition }, profiles: { careful: {} } }),
  );
  const registered = await WorkSources.register(request);
  expect(registered).toMatchObject({
    tag: "Ok",
    value: {
      plan: {
        assignments: [
          { kind: "audit", completion: "report", resources: "pane", profile: "careful" },
        ],
      },
    },
  });
  if (registered.tag !== "Ok") return;
  await Bun.write(paths.config, "{}");
  expect(await WorkSources.show({ ...request, sourceId: registered.value.id })).toMatchObject({
    tag: "Ok",
    value: {
      planned: [{ kind: "audit", completion: "report", resources: "pane", profile: "careful" }],
    },
  });
  expect(await WorkSources.next(request)).toMatchObject({
    tag: "Ok",
    value: {
      sources: [
        {
          actions: [
            {
              action: "ready_assignment",
              assignment: "read",
              blockers: [],
              reason: "assignment_ready",
            },
          ],
        },
      ],
    },
  });
  expect(await WorkSources.register(request)).toMatchObject({
    tag: "Err",
    error: { reason: "invalid_source_plan" },
  });
});
