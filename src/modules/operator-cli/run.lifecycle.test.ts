import { expect, test } from "bun:test";
// Bun has no recursive removal API.
import { rm } from "node:fs/promises";
import { workerDevice } from "./worker-fixture.ts";

test("activity reaches next at once, and an idle flip does not wake next --wait in its grace", async () => {
  const device = await workerDevice();
  try {
    const source = await device.register({
      trackerKey: "github:example/one#332",
      assignments: [
        {
          key: "smoke",
          trackerKey: "github:example/one#332",
          instructions: "Run the lifecycle test.",
          kind: "research",
          resources: "pane",
          dependencies: [],
        },
      ],
    });
    const worker = await device.dispatch(source, "smoke");
    async function activity(agent_status: string) {
      expect(
        (
          await device.event("pane.agent_status_changed", {
            pane_id: worker.paneId,
            agent_status,
          })
        ).code,
      ).toBe(0);
    }
    function wait() {
      return device.run(["next", "--source", source, "--wait", "--timeout", "0"]);
    }
    // The first wait of the scope returns every action, and the next one has nothing new.
    expect(await wait()).toMatchObject({ code: 0, output: { reason: "next_actions_changed" } });
    for (const state of ["idle", "working", "done", "working"]) {
      await activity(state);
      const idle = state !== "working";
      expect(await device.next("smoke")).toMatchObject([
        {
          assignment: "smoke",
          action: idle ? "worker_attention" : "wait",
          reason: idle ? "worker_idle" : "assignment_active",
        },
      ]);
      expect(await wait()).toMatchObject({
        code: 0,
        output: { reason: "next_wait_timed_out", data: { sources: [] } },
      });
    }
    const waiting = device.run(["next", "--source", source, "--wait", "--timeout", "5"]);
    await Bun.sleep(500);
    await activity("idle");
    expect(await waiting).toMatchObject({
      code: 0,
      output: { reason: "next_wait_timed_out", data: { sources: [] } },
    });
  } finally {
    await rm(device.root, { recursive: true, force: true });
  }
}, 60000);
