import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { WorkSources } from "../work-sources/main.ts";
import { dispatchDevice, removeDevices } from "./dispatch-fixture.ts";
import { WorkerDispatch } from "./main.ts";

afterEach(() => mock.restore());
afterAll(removeDevices);

async function customSource(device: Awaited<ReturnType<typeof dispatchDevice>>) {
  const definition = {
    completion: "report",
    resources: "pane",
    guide: "audit-guide/SKILL.md",
    skillsToRead: ["evidence"],
    nextKind: "research",
    workPhases: [{ name: "audit", goal: "Check evidence." }],
  };
  await Bun.write(device.paths.config, JSON.stringify({ kinds: { audit: definition } }));
  await Bun.write(`${device.paths.skillHosts["claude-code"]}/audit-guide/SKILL.md`, "Audit.", {
    createPath: true,
  });
  const file = `${device.root}/custom-plan.json`;
  await Bun.write(
    file,
    JSON.stringify({
      trackerKey: "APP-audit",
      assignments: [
        {
          key: "audit",
          trackerKey: "APP-2",
          kind: "audit",
          instructions: "Audit.",
          dependencies: [],
        },
      ],
    }),
  );
  const result = await WorkSources.register({ paths: device.paths, cwd: device.checkout, file });
  expect(result).toMatchObject({ tag: "Ok" });
  return { sourceId: result.tag === "Ok" ? result.value.id : "missing", definition };
}

test("custom dispatch records resolved host policy and later settings edits cannot rewrite the launch", async () => {
  await using device = await dispatchDevice();
  const { sourceId, definition } = await customSource(device);
  const request = { ...device.request("audit"), sourceId };
  const result = await WorkerDispatch.dispatch(request);
  expect(result).toMatchObject({ tag: "Ok" });
  const shown = await WorkSources.show(request);
  expect(shown).toMatchObject({
    tag: "Ok",
    value: {
      launches: [
        {
          kind: {
            name: "audit",
            completion: "report",
            resources: "pane",
            profile: "careful",
            nextKind: "research",
            guide: `${device.paths.skillHosts["claude-code"]}/audit-guide/SKILL.md`,
            skillsToRead: [`${device.paths.upstreamSkills["claude-code"]}/evidence/SKILL.md`],
            workPhases: [{ name: "audit", goal: "Check evidence." }],
          },
        },
      ],
    },
  });
  await Bun.write(
    device.paths.config,
    JSON.stringify({
      kinds: { audit: { ...definition, workPhases: [{ name: "changed", goal: "New goal." }] } },
    }),
  );
  expect(await WorkSources.show(request)).toMatchObject({
    tag: "Ok",
    value: {
      launches: [
        {
          kind: {
            workPhases: [{ name: "audit", goal: "Check evidence." }],
          },
        },
      ],
    },
  });
});

test("a changed completion type refuses dispatch before creating resources or recording a launch", async () => {
  await using device = await dispatchDevice();
  const { sourceId, definition } = await customSource(device);
  await Bun.write(
    device.paths.config,
    JSON.stringify({ kinds: { audit: { ...definition, completion: "pr", nextKind: null } } }),
  );
  const request = { ...device.request("audit"), sourceId };
  expect(await WorkerDispatch.dispatch(request)).toMatchObject({
    tag: "Err",
    error: {
      reason: "kind_completion_changed",
      detail: "Kind audit no longer matches the registered completion type. Nothing was launched.",
      next: {
        decider: "super-agent",
        question:
          "Should the kind's original completion type be restored, or should this work use a new plan?",
      },
      state: { kind: "audit", registeredCompletion: "report", configuredCompletion: "pr" },
    },
  });
  expect(device.herdr.createTab).not.toHaveBeenCalled();
  expect(device.herdr.createWorktree).not.toHaveBeenCalled();
  expect(device.herdr.startAgent).not.toHaveBeenCalled();
  expect(await WorkSources.show(request)).toMatchObject({ tag: "Ok", value: { launches: [] } });
});
