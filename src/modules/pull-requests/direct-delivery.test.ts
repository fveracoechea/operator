import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { Result } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import {
  git,
  prDevice,
  mergeRequest,
  pullRequestBody,
  requestKind,
  succeeded,
  failed,
} from "./device-fixture.ts";
import { resolveOwner } from "./owner.ts";
import { directDelivery } from "./direct-delivery.ts";

afterEach(() => mock.restore());

test("known-UUID readback retains its primary Err even when later observation proves merge", async () => {
  const { device, head, launchId, input } = await intent("original-request");
  await using _ = device;
  device.answer((args) =>
    requestKind(args) === "merge_read"
      ? failed("original read failure", 404)
      : succeeded(pullRequestBody({ state: "MERGED", head, mergeCommit: "merged-7" })),
  );
  expect<unknown>(await directDelivery(input)).toMatchObject({
    tag: "Err",
    error: { reason: "github_failed", detail: "github_refused: original read failure" },
  });
  expect(value(DeviceState.readDelivery(device.paths, launchId))).toBeNull();
  expect(device.calls.map(requestKind)).toEqual(["merge_read", "pull_request"]);
});
function value<T, E>(result: Result<T, E>): T {
  expect(result.tag).toBe("Ok");
  // oxlint-disable-next-line unthrown/no-throw -- A failed fixture operation must stop the test.
  if (result.tag !== "Ok") throw new Error("Fixture operation failed.");
  return result.value;
}

async function intent(uuid: string | null) {
  const device = await prDevice();
  const outgoing = device.start("other");
  const head = git(outgoing.worktree, "rev-parse", "HEAD");
  device.associate(outgoing.launchId, 7, "task/other", null, {
    head,
    at: "ready-at",
    note: null,
    dispositions: [],
  });
  value(DeviceState.finishImplementer(device.paths, outgoing.launchId));
  const launch = device.start("other", { worktree: outgoing.worktree, add: false });
  const owner = value(await resolveOwner({ paths: device.paths, cwd: launch.worktree }));
  const delivery = value(
    DeviceState.admitDelivery(device.paths, {
      launchId: launch.launchId,
      head,
      selected: false,
      session: null,
    }),
  );
  // oxlint-disable-next-line unthrown/no-throw -- A direct admission must return the fixture intent.
  if (delivery === null) throw new Error("No intent.");
  if (uuid !== null) value(DeviceState.changeDelivery(device.paths, delivery.id, { uuid }));
  return {
    device,
    head,
    launchId: launch.launchId,
    input: { paths: device.paths, owner, number: 7, delivery: { ...delivery, requestUuid: uuid } },
  };
}

test("an uncertain request without a UUID only observes, never blindly resubmits", async () => {
  const { device, head, launchId, input } = await intent(null);
  await using _ = device;
  device.answer(() => succeeded(pullRequestBody({ head })));
  expect<unknown>(await directDelivery(input)).toMatchObject({
    tag: "Err",
    error: { reason: "pr_merge_unverified" },
  });
  expect(device.calls.map(requestKind)).toEqual(["pull_request"]);
  expect(value(DeviceState.readDelivery(device.paths, launchId))).toMatchObject({
    requestUuid: null,
    ownerPid: null,
    endedAt: null,
  });
});

test("a known UUID is read, retained after a failed read, then reconciled once at its exact head", async () => {
  const { device, head, launchId, input } = await intent("original-request");
  await using _ = device;
  const cause = new Error("read transport defect");
  const secondary = spyOn(console, "error").mockImplementation(() => {});
  device.answer(() => Promise.reject(cause));
  const read = await directDelivery(input);
  expect(read.tag).toBe("Defect");
  if (read.tag === "Defect") expect(read.cause).toBe(cause);
  expect(secondary.mock.calls).toMatchObject([
    ["delivery_verification", { secondary: { tag: "Defect", cause } }],
  ]);
  expect(value(DeviceState.readDelivery(device.paths, launchId))).toMatchObject({
    requestUuid: "original-request",
    endedAt: null,
    ownerPid: null,
  });
  value(
    DeviceState.recoverDelivery(
      device.paths,
      { launchId, head, selected: false, session: null },
      input.delivery.id,
    ),
  );
  device.answer((args) =>
    requestKind(args) === "merge_read"
      ? mergeRequest("merged", "original-request")
      : succeeded(pullRequestBody({ state: "MERGED", head, mergeCommit: "merged-7" })),
  );
  expect<unknown>(await directDelivery(input)).toMatchObject({
    tag: "Ok",
    value: { head, mergeCommit: "merged-7" },
  });
  expect(value(DeviceState.readDelivery(device.paths, launchId))).toBeNull();
  expect(device.calls.some((args) => requestKind(args) === "merge")).toBe(false);
});
