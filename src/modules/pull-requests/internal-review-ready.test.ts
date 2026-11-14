import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { OkAsync } from "unthrown";
import { WorkSources } from "../work-sources/main.ts";
import { prDevice } from "./device-fixture.ts";
import { skip } from "./internal-review-ready.ts";

afterEach(() => mock.restore());

test("skip names the missing optional source result before GitHub or state effects", async () => {
  await using device = await prDevice();
  spyOn(WorkSources, "show").mockReturnValue(OkAsync(undefined));
  const before = await Bun.file(device.paths.database).arrayBuffer();
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
      reason: "source_not_found",
      next: {
        command: "operator next",
        why: "Read the available sources before choosing a source.",
      },
      state: { sourceExists: false },
    },
  });
  expect(device.calls).toEqual([]);
  expect(await Bun.file(device.paths.database).arrayBuffer()).toEqual(before);
});

test("skip preserves the decision's checked state and person authority without reading GitHub or changing state", async () => {
  await using device = await prDevice();
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
  expect(device.calls).toEqual([]);
  expect(await Bun.file(device.paths.database).arrayBuffer()).toEqual(before);
});
