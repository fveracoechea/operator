import { expect, spyOn, test } from "bun:test";
// Bun has no recursive removal API.
import { rm } from "node:fs/promises";
import path from "node:path";
import { workerDevice } from "./worker-fixture.ts";

test("a failed fixture dispatch retains sanitized topology without weakening its assertion", async () => {
  const device = await workerDevice();
  const errors = spyOn(console, "error").mockImplementation(() => {});
  let retained: string | undefined;
  try {
    const source = await device.register({
      trackerKey: "github:example/one#20",
      assignments: [
        {
          key: "child",
          trackerKey: "github:example/one#21",
          instructions: "PRIVATE_TASK",
          kind: "research",
          resources: "pane",
          dependencies: [],
        },
      ],
    });
    await device.setHerdr({ fail: { "tab rename": "controlled refusal" } });
    await expect(device.dispatch(source, "child")).rejects.toThrow();
    const output = errors.mock.calls.flat().join("\n");
    retained = /Controlled Herdr failure evidence: ([^\n]+)/.exec(output)?.[1];
    expect(retained).toBeDefined();
    if (retained === undefined) return;
    const trace = await Bun.file(retained).text();
    expect(output).toContain(`"fixture":"${device.root}"`);
    expect(output).toContain('"command":"tab rename"');
    expect(trace).toContain('"target":"w1:t2"');
    expect(trace).not.toContain("PRIVATE_TASK");
    await rm(device.root, { recursive: true, force: true });
    expect(await Bun.file(retained).text()).toBe(trace);
  } finally {
    errors.mockRestore();
    await rm(device.root, { recursive: true, force: true });
    if (retained !== undefined) await rm(path.dirname(retained), { recursive: true, force: true });
  }
});
