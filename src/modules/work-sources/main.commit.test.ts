import { afterEach, expect, jest, setSystemTime, spyOn, test } from "bun:test";
import { OkAsync } from "unthrown";
import { CommitDelivery } from "../commit-delivery/main.ts";
import { commitFixture } from "../../../tools/commit-delivery-fixture.ts";
import { DeviceState } from "../device-state/main.ts";
import { WorkSources } from "./main.ts";
import { Herdr } from "../herdr/main.ts";

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

test("an exhausted commit review wakes a person decision once, without any PR observation", async () => {
  fixture = await commitFixture();
  spyOn(Herdr, "agentNames").mockReturnValue(OkAsync(["reviewer"]));
  spyOn(Herdr, "pane").mockReturnValue(OkAsync(null));
  await fixture.change();
  await fixture.review();
  const text = "## Findings\n- blocker, Spec, feature: The behavior is incomplete.";
  expect((await CommitDelivery.round({ ...fixture.input, text })).tag).toBe("Ok");
  await fixture.change("fixed feature\n");
  expect((await CommitDelivery.round({ ...fixture.input, text })).tag).toBe("Ok");
  const input = {
    paths: fixture.paths,
    cwd: fixture.checkout,
    sourceId: "source",
    timeoutSeconds: 0,
  };
  expect(await WorkSources.wait(input)).toMatchObject({
    tag: "Ok",
    value: { reason: "next_wait_timed_out" },
  });
  expect(
    await CommitDelivery.deliver({
      ...fixture.input,
      text: "## Dispositions\n- 1.1 applied\n- 2.1 applied",
    }),
  ).toMatchObject({ error: { reason: "commit_review_limit", next: { decider: "person" } } });
  expect(await WorkSources.wait(input)).toMatchObject({
    tag: "Ok",
    value: {
      reason: "next_actions_changed",
      data: {
        sources: [
          {
            actions: [
              { assignment: "ticket", action: "person_decision", reason: "commit_review_limit" },
            ],
          },
        ],
      },
    },
  });
  expect(await WorkSources.wait(input)).toMatchObject({
    tag: "Ok",
    value: { reason: "next_wait_timed_out" },
  });
  expect(fixture.git(fixture.checkout, "rev-parse", "main")).toBe(fixture.base);
});
