import { afterEach, expect, mock, test } from "bun:test";
import { prDevice } from "./device-fixture.ts";
import { resolveOwner } from "./owner.ts";
import { stackParents } from "./stack-parents.ts";

afterEach(() => mock.restore());

test("supplemental prerequisites must belong to the source and cannot depend on the child", async () => {
  await using device = await prDevice();
  const parent = device.start("parent");
  device.associate(parent.launchId, 6, "task/parent");
  const child = device.start("child");
  device.associate(child.launchId, 8, "task/child");
  const resolved = await resolveOwner({ paths: device.paths, cwd: parent.worktree });
  expect(resolved.tag).toBe("Ok");
  if (resolved.tag !== "Ok") return;
  const input = { paths: device.paths, owner: resolved.value };
  expect(await stackParents({ ...input, additional: ["child"] })).toMatchObject({
    tag: "Err",
    error: {
      reason: "stack_parent",
      detail: "The proposed prerequisites create an assignment cycle.",
    },
  });
  expect(await stackParents({ ...input, additional: ["external"] })).toMatchObject({
    tag: "Err",
    error: {
      reason: "stack_parent",
      detail: "Prerequisite external does not belong to this source.",
    },
  });
  expect(await stackParents({ ...input, additional: ["parent"] })).toMatchObject({
    tag: "Err",
    error: { reason: "stack_parent" },
  });
  expect(device.calls).toEqual([]);
});
