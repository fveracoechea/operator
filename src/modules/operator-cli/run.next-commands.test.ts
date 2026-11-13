import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no recursive removal API.
import { rm } from "node:fs/promises";
import { z } from "zod";
import { workerDevice } from "./worker-fixture.ts";
import { Database } from "bun:sqlite";

let device: Awaited<ReturnType<typeof workerDevice>>;
beforeEach(async () => {
  device = await workerDevice();
});
afterEach(async () => {
  await rm(device.root, { recursive: true, force: true });
});

test.each(["read docs", "read 'docs'; touch injected; $(touch injected); `touch injected`"])(
  "next emits a runnable command preserving assignment key %s",
  async (key) => {
    const source = await device.register({
      trackerKey: "github:example/one#20",
      assignments: [
        {
          key,
          trackerKey: "github:example/one#21",
          instructions: "Report the gaps.",
          completion: "report",
          resources: "pane",
          dependencies: [],
        },
      ],
    });
    const row = z
      .object({ command: z.string(), next: z.object({ command: z.string() }) })
      .parse((await device.next(key))[0]);
    expect(row.next.command).toBe(row.command);
    const launched = await device.exec(["sh", "-c", `${row.next.command} --json`], device.main);
    expect(launched.code, launched.stderr).toBe(0);
    expect(JSON.parse(launched.stdout)).toMatchObject({
      reason: "worker_launched",
      data: { sourceId: source, assignment: key },
    });
    expect(await Bun.file(`${device.main}/injected`).exists()).toBe(false);
  },
);

test("the prune row command runs through the supported CLI and prunes the ended source", async () => {
  const source = await device.register({ trackerKey: "github:example/one#20", assignments: [] });
  {
    using db = new Database(`${device.root}/state/operator/operator.sqlite`);
    db.exec("UPDATE sources SET ended_at = '2020-01-01T00:00:00.000Z'");
  }
  const next = await device.run(["next", "--all"]);
  const row = z
    .object({
      data: z.object({
        sources: z.array(
          z.object({
            actions: z.array(
              z.object({ action: z.string(), next: z.object({ command: z.string().optional() }) }),
            ),
          }),
        ),
      }),
    })
    .parse(next.output)
    .data.sources[0]?.actions.find((action) => action.action === "prune_source");
  const pruned = await device.exec(["sh", "-c", `${row?.next.command} --json`], device.main);
  expect(pruned.code, pruned.stderr).toBe(0);
  expect(row?.next.command).toBe("operator source prune");
  expect(JSON.parse(pruned.stdout)).toMatchObject({ reason: "sources_pruned" });
  expect(await device.run(["source", "show", "--source", source])).toMatchObject({
    code: 3,
    output: { reason: "source_not_found" },
  });
});
