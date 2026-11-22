import { afterEach, expect, jest, setSystemTime, test } from "bun:test";
import { CommitDelivery } from "../commit-delivery/main.ts";
import { commitFixture } from "../../../tools/commit-delivery-fixture.ts";
import { DeviceState } from "../device-state/main.ts";
import { WorkSources } from "./main.ts";

let fixture: Awaited<ReturnType<typeof commitFixture>> | undefined;
afterEach(async () => {
  setSystemTime();
  await fixture?.dispose();
  fixture = undefined;
  jest.restoreAllMocks();
});

test("completed commit sources retain delivery and intermediate-history evidence beyond normal pruning", async () => {
  fixture = await commitFixture();
  await fixture.change();
  await fixture.review();
  expect((await CommitDelivery.round({ ...fixture.input, text: "## Findings" })).tag).toBe("Ok");
  expect((await CommitDelivery.deliver({ ...fixture.input, text: "## Dispositions" })).tag).toBe(
    "Ok",
  );
  expect(DeviceState.finishImplementer(fixture.paths, "reviewer").tag).toBe("Ok");
  setSystemTime(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
  const input = { paths: fixture.paths, cwd: fixture.checkout };
  expect(await WorkSources.prune(input)).toMatchObject({
    tag: "Ok",
    value: { pruned: [], kept: [{ id: "source", reason: "cleanup_open" }] },
  });
  const read = await WorkSources.show({ ...input, sourceId: "source" });
  expect(read).toMatchObject({
    tag: "Ok",
    value: {
      state: "finished",
      assignments: [{ completion: "commit", state: "completed" }],
    },
  });
  expect(fixture.git(fixture.checkout, "show", "ticket/411:feature")).toBe("feature");
});
