import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { OkAsync } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { prDevice } from "./device-fixture.ts";
import { ready, skip } from "./internal-review-ready.ts";

afterEach(() => mock.restore());

test("ready reports a concurrently recorded review without inventing a PR in its earlier owner snapshot", async () => {
  await using device = await prDevice();
  const started = device.start("parent");
  const file = `${device.root}/summary.json`;
  await Bun.write(file, "## Overview\nReviewed.\n## Dispositions\n");
  const show = WorkSources.show;
  spyOn(WorkSources, "show").mockImplementation((input) => {
    expect(
      DeviceState.associatePullRequest(
        device.paths,
        started.launchId,
        {
          number: 7,
          url: "https://github.com/example/one/pull/7",
          branch: "task/parent",
          relay: null,
        },
        false,
        true,
      ).tag,
    ).toBe("Ok");
    return show(input);
  });
  expect(await ready({ paths: device.paths, cwd: started.worktree, file })).toMatchObject({
    tag: "Err",
    error: {
      reason: "internal_review_not_recorded",
      next: {
        command: "operator next",
        why: "Read the assignment's recorded review state before continuing.",
      },
      state: { internalReview: "reviewing", pullRequest: null },
    },
  });
  expect(device.calls).toEqual([]);
  expect(DeviceState.readSources(device.paths, "example/one", device.sourceId)).toMatchObject({
    tag: "Ok",
    value: [{ internalReviews: [{ state: "reviewing" }] }],
  });
});

test("ready refuses malformed summaries and missing review records before GitHub effects", async () => {
  await using device = await prDevice();
  const started = device.start("parent");
  expect(
    DeviceState.associatePullRequest(
      device.paths,
      started.launchId,
      {
        number: 7,
        url: "https://github.com/example/one/pull/7",
        branch: "task/parent",
        relay: null,
      },
      false,
      false,
    ).tag,
  ).toBe("Ok");
  const before = await Bun.file(device.paths.database).arrayBuffer();
  const file = `${device.root}/summary.json`;
  for (const text of ["{bad", "{}"]) {
    await Bun.write(file, text);
    expect(await ready({ paths: device.paths, cwd: started.worktree, file })).toMatchObject({
      tag: "Err",
      error: {
        reason: "internal_review_summary_invalid",
        next: {
          command: "operator pr ready --file <path|->",
          why: "Correct the markdown summary and try ready again.",
        },
      },
    });
  }
  await Bun.write(file, "## Overview\nReviewed.\n## Dispositions\n");
  expect(await ready({ paths: device.paths, cwd: started.worktree, file })).toMatchObject({
    tag: "Err",
    error: {
      reason: "internal_review_not_recorded",
      next: {
        command: "operator next",
        why: "Read the assignment's recorded review state before continuing.",
      },
      state: { internalReview: null, pullRequest: 7 },
    },
  });
  expect(await Bun.file(device.paths.database).arrayBuffer()).toEqual(before);
  expect(device.calls).toEqual([]);
});

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
