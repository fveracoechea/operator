import { afterAll, afterEach, expect, mock, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Ok } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { dispatchDevice, removeDevices } from "./dispatch-fixture.ts";
import { WorkerDispatch } from "./main.ts";

afterEach(() => {
  mock.restore();
  setSystemTime();
});
afterAll(removeDevices);

test("a dispatch persists its resolved kind and absolute host guide", async () => {
  await using device = await dispatchDevice();
  const kind = {
    name: "research",
    completion: "report",
    resources: "pane",
    profile: "careful",
    nextKind: null,
    readsNote: false,
    guide: `${device.paths.skillHosts["claude-code"]}/worker-agent/kinds/research.md`,
    dispatchable: true,
    workPhases: [{ name: "investigate", goal: "Investigate the assigned question." }],
  };
  expect(await WorkerDispatch.dispatch(device.request("read"))).toMatchObject({
    tag: "Ok",
    value: { kind },
  });
  expect(await device.launches("read")).toMatchObject([{ kind }]);
});

test("a legacy assignment keeps a null kind in its new launch and brief", async () => {
  await using device = await dispatchDevice();
  const source = await device.source();
  if (source === undefined) expect.unreachable("The registered source is missing.");
  using db = new Database(device.paths.database);
  const assignments = source.plan.assignments.map(({ kind: _kind, ...assignment }) => assignment);
  db.query("UPDATE sources SET plan = ? WHERE id = ?").run(
    JSON.stringify({ ...source.plan, assignments }),
    device.sourceId,
  );
  db.query("UPDATE assignments SET kind = NULL WHERE source_id = ?").run(device.sourceId);
  const result = await WorkerDispatch.dispatch(device.request("read"));
  expect(result).toMatchObject({ tag: "Ok", value: { kind: null } });
  expect(await device.launches("read")).toMatchObject([{ kind: null }]);
  if (result.tag !== "Ok") expect.unreachable("The legacy launch failed.");
  expect(await Bun.file(result.value.brief).text()).not.toContain("Worker kind:");
});

test.each(["review", "pr-feedback"])(
  "%s refuses plain dispatch with its checked kind and a decision owner",
  async (kind) => {
    await using device = await dispatchDevice();
    const file = `${device.root}/transition.json`;
    await Bun.write(
      file,
      JSON.stringify({
        trackerKey: `kind:${kind}`,
        assignments: [
          {
            key: "work",
            trackerKey: "APP-2",
            instructions: "Handle the PR.",
            kind,
            branch: "task/transition",
            dependencies: [],
          },
        ],
      }),
    );
    const registered = await WorkSources.register({
      paths: device.paths,
      cwd: device.checkout,
      file,
    });
    if (registered.tag !== "Ok") expect.unreachable("The transition plan was refused.");
    const before = await Bun.file(device.paths.database).arrayBuffer();
    expect(
      await WorkerDispatch.dispatch({ ...device.request("work"), sourceId: registered.value.id }),
    ).toMatchObject({
      tag: "Err",
      error: {
        reason: "kind_not_dispatchable",
        detail: expect.stringContaining(kind) as unknown,
        next: { decider: "super-agent", question: expect.stringMatching(/\S/) as unknown },
        state: { kind },
      },
    });
    expect(await Bun.file(device.paths.database).arrayBuffer()).toEqual(before);
    expect(device.herdr.startAgent).not.toHaveBeenCalled();
  },
);

test("the handoff launch records the review kind rather than the implementation kind", async () => {
  await using device = await dispatchDevice();
  expect(await WorkerDispatch.dispatch(device.request("impl"))).toMatchObject({ tag: "Ok" });
  const launch = (await device.launches("impl"))[0];
  if (launch === undefined) expect.unreachable("The implementer launch is missing.");
  expect(
    DeviceState.associatePullRequest(
      device.paths,
      launch.id,
      { number: 7, url: "https://github.com/example/one/pull/7", branch: "task/impl", relay: null },
      false,
      true,
    ).tag,
  ).toBe("Ok");
  expect(DeviceState.finishImplementer(device.paths, launch.id).tag).toBe("Ok");
  expect(await WorkerDispatch.dispatch({ ...device.request("impl"), handoff: true })).toMatchObject(
    {
      tag: "Ok",
      value: {
        kind: {
          name: "review",
          readsNote: false,
          nextKind: "pr-feedback",
          guide: `${device.paths.skillHosts["claude-code"]}/worker-agent/kinds/review.md`,
        },
      },
    },
  );
  expect((await device.launches("impl"))[1]).toMatchObject({ kind: { name: "review" } });
});

test("refreshing a promoted brief keeps its recorded kind and profile", async () => {
  await using device = await dispatchDevice();
  expect(await WorkerDispatch.dispatch(device.request("survey"))).toMatchObject({ tag: "Ok" });
  const launch = (await device.launches("survey"))[0];
  if (launch === undefined) expect.unreachable("The report launch is missing.");
  const id = crypto.randomUUID();
  expect(
    DeviceState.changeReport(
      device.paths,
      {
        by: "key",
        repository: "example/one",
        checkout: device.checkout,
        sourceId: device.sourceId,
        assignment: "survey",
      },
      (facts) => {
        if (facts.launch === null) expect.unreachable("The report launch is missing.");
        return Ok({
          assignmentState: "completed",
          finishLaunch: launch.id,
          insert: {
            sourceId: device.sourceId,
            assignment: "survey",
            number: 1,
            launchId: launch.id,
            submittedAt: "2026-01-01",
            conclusion: "Build it.",
            evidence: "[]",
            unresolved: "[]",
            decisions: "[]",
            files: "[]",
            decision: "accepted",
            decidedAt: "2026-01-01",
            followUp: null,
            cleanupState: "done",
            cleanupDetail: "Promoted.",
          },
          promote: {
            assignment: {
              sourceId: device.sourceId,
              key: "build",
              completion: "pr",
              state: "running",
            },
            promotion: {
              sourceId: device.sourceId,
              assignment: "build",
              report: "survey",
              reportNumber: 1,
              trackerKey: "APP-9",
              instructions: "Build it.",
              branch: "task/survey",
              internalReview: false,
              worktreePath: launch.worktreePath ?? "",
              handoverLaunchId: id,
              promotedAt: "2026-01-01",
            },
            launch: { ...facts.launch, id, name: "pr-one-build", assignment: "build", attempt: 1 },
          },
        });
      },
    ).tag,
  ).toBe("Ok");
  const refreshed = await WorkerDispatch.refreshBrief(device.request("build"));
  expect(refreshed.tag).toBe("Ok");
  const brief = await Bun.file(
    OperatorHome.assignmentFiles(device.paths, {
      repository: "example/one",
      sourceId: device.sourceId,
      assignment: "build",
    }).brief,
  ).text();
  expect(brief).toContain("Worker kind: `research`");
  expect(brief).toContain("Start profile: `careful`");
  expect(brief).toContain("Completion type: a merged pull request.");
});
