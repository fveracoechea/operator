import { afterEach, expect, test } from "bun:test";
// Bun has no recursive removal API.
import { rm } from "node:fs/promises";
import { z } from "zod";
import { workerDevice } from "./worker-fixture.ts";

let device: Awaited<ReturnType<typeof workerDevice>>;
afterEach(async () => {
  await rm(device.root, { recursive: true, force: true });
});

test("a live promoted worker records the default internal review policy", async () => {
  device = await workerDevice({ github: true });
  await Bun.write(
    `${device.root}/config/operator/config.json`,
    JSON.stringify({ superAgent: { host: "opencode", model: "test/reasoner" } }),
  );
  const source = await device.register({
    trackerKey: "github:example/one#10",
    assignments: [
      {
        key: "probe",
        trackerKey: "github:example/one#11",
        instructions: "Investigate in the worktree.",
        kind: "prototype",
        resources: "worktree",
        branch: "report/probe",
        dependencies: [],
      },
    ],
  });
  const worker = await device.dispatch(source, "probe");
  const report = await device.writeReport("report.md", {
    conclusion: "Build it.",
    evidence: ["README.md:1"],
    unresolved: [],
  });
  expect(
    await device.run(["report", "submit", "--file", report], { pane: worker.paneId }),
  ).toMatchObject({ code: 0 });
  const file = await device.writeJson("promotion.json", {
    key: "build",
    branch: "task/build",
    trackerKey: "github:example/one#12",
    instructions: "Build it.",
  });
  expect(
    await device.run([
      "report",
      "accept",
      "--source",
      source,
      "--assignment",
      "probe",
      "--promote",
      file,
    ]),
  ).toMatchObject({ code: 0, output: { data: { promoted: { state: "running" } } } });
  const shown = await device.run(["source", "show", "--source", source]);
  expect(shown.code).toBe(0);
  const { launches } = z
    .object({
      data: z.object({
        launches: z.array(
          z.looseObject({
            assignment: z.string(),
            internalReview: z.boolean().nullable(),
          }),
        ),
      }),
    })
    .parse(shown.output).data;
  expect(launches.find((row) => row.assignment === "probe")).toMatchObject({
    internalReview: null,
  });
  expect(launches.find((row) => row.assignment === "build")).toMatchObject({
    internalReview: true,
    paneId: worker.paneId,
    worktreePath: worker.worktreePath,
  });
  const head = await device.exec(["git", "rev-parse", "HEAD"], worker.worktreePath ?? "");
  expect(head.code).toBe(0);
  await Bun.write(
    `${device.root}/github.json`,
    JSON.stringify({
      pulls: [
        {
          number: 7,
          url: "https://github.com/example/one/pull/7",
          state: "OPEN",
          headRefName: "task/build",
          headRepository: "example/one",
          head: head.stdout.trim(),
          isDraft: false,
        },
      ],
    }),
  );
  expect(
    await device.run(["pr", "associate"], { cwd: worker.worktreePath ?? "", pane: worker.paneId }),
  ).toMatchObject({ output: { reason: "pr_draft_required" } });
}, 60000);
