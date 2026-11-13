import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { prDevice } from "./device-fixture.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { skip } from "./internal-review-ready.ts";

afterEach(() => mock.restore());

test("skip preserves the decision's checked state and person authority without reading GitHub or changing state", async () => {
  await using device = await prDevice();
  const calls = spyOn(ToolInvocation, "run");
  const before = await Bun.file(device.paths.database).arrayBuffer();
  expect(
    await skip({
      paths: device.paths,
      cwd: device.checkout,
      sourceId: device.sourceId,
      assignment: "parent",
      personInstructed: false,
    }),
  ).toMatchObject({
    tag: "Err",
    error: {
      reason: "person_instruction_required",
      next: { decider: "person", question: "May this command run on your explicit instruction?" },
      state: { personInstructed: false },
    },
  });
  expect(
    await skip({
      paths: device.paths,
      cwd: device.checkout,
      sourceId: device.sourceId,
      assignment: "parent",
      personInstructed: true,
    }),
  ).toMatchObject({
    tag: "Err",
    error: {
      reason: "internal_review_not_recorded",
      next: { why: "No internal review exists to skip." },
      state: { review: null },
    },
  });
  expect(calls.mock.calls.filter(([input]) => input.tool === "gh")).toEqual([]);
  expect(await Bun.file(device.paths.database).arrayBuffer()).toEqual(before);
});
