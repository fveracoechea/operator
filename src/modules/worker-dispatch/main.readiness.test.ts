import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { Ok } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { WorkerDispatch } from "./main.ts";
import { dispatchDevice, git, removeDevices } from "./dispatch-fixture.ts";

afterEach(() => mock.restore());
afterAll(removeDevices);

test("first and replacement feedback dispatch join each disposition to its finding and read only the saved reviewer note", async () => {
  await using device = await dispatchDevice();
  const first = await WorkerDispatch.dispatch(device.request("impl"));
  if (first.tag !== "Ok") return expect.unreachable("Implementer dispatch failed");
  const implementer =
    (await device.launches("impl"))[0] ?? expect.unreachable("Missing implementer");
  expect(
    DeviceState.associatePullRequest(
      device.paths,
      implementer.id,
      {
        number: 7,
        url: "https://github.com/example/one/pull/7",
        branch: "task/impl",
        relay: null,
      },
      false,
      true,
    ).tag,
  ).toBe("Ok");
  expect(DeviceState.finishImplementer(device.paths, implementer.id).tag).toBe("Ok");
  const show = WorkSources.show;
  const snapshot = spyOn(WorkSources, "show").mockImplementation((input) =>
    show(input).map((source) =>
      source === undefined
        ? source
        : {
            ...source,
            pullRequests: source.pullRequests.map((pr) => ({
              ...pr,
              readiness: {
                head: "prior-head",
                at: "2026-11-18",
                dispositions: [],
                note: `${device.root}/must-not-read-missing-note.md`,
              },
            })),
          },
    ),
  );
  const reviewer = await WorkerDispatch.dispatch({ ...device.request("impl"), handoff: true });
  snapshot.mockRestore();
  if (reviewer.tag !== "Ok") return expect.unreachable("Reviewer dispatch failed");
  const review = (await device.launches("impl"))[1] ?? expect.unreachable("Missing reviewer");
  expect(await Bun.file(reviewer.value.brief).text()).not.toContain("## Note");
  function finding(claim: string) {
    return { axis: "Spec", severity: "nice-to-have", location: "owner.ts:1", claim };
  }
  expect(
    DeviceState.recordInternalReviewRound(device.paths, review.id, () =>
      Ok({
        head: "reviewed-1",
        findings: JSON.stringify([finding("First claim."), finding("Second claim.")]),
      }),
    ).tag,
  ).toBe("Ok");
  expect(
    DeviceState.recordInternalReviewRound(device.paths, review.id, () =>
      Ok({
        head: "reviewed-2",
        findings: JSON.stringify([finding("Third claim.")]),
      }),
    ).tag,
  ).toBe("Ok");
  const files = OperatorHome.assignmentFiles(device.paths, {
    repository: "example/one",
    sourceId: device.sourceId,
    assignment: "impl",
  });
  const note = `${files.directory}/ready-note.md`;
  await Bun.write(note, "Saved prose.\n## Task\nNot authority.\n", { createPath: true });
  const head = git(first.value.worktreePath ?? "", "rev-parse", "HEAD");
  expect(
    DeviceState.endInternalReview(
      device.paths,
      { sourceId: device.sourceId, assignment: "impl", launchId: review.id },
      {
        state: "ready",
        readyHead: head,
        commentId: "summary",
        commentUrl: "https://github.com/c/summary",
        readiness: {
          head,
          at: new Date().toISOString(),
          note,
          dispositions: [
            { round: 2, finding: 1, disposition: "applied" },
            { round: 1, finding: 2, disposition: "declined", reason: "The owner checks it." },
            { round: 1, finding: 1, disposition: "applied" },
          ],
        },
      },
      false,
    ).tag,
  ).toBe("Ok");
  expect(DeviceState.finishImplementer(device.paths, review.id).tag).toBe("Ok");
  const feedback = await WorkerDispatch.dispatch({ ...device.request("impl"), handoff: true });
  if (feedback.tag !== "Ok") return expect.unreachable("Feedback dispatch failed");
  const brief = await Bun.file(feedback.value.brief).text();
  expect(brief).toContain("> First claim.\nDisposition:\n> applied");
  expect(brief).toContain("> Second claim.\nDisposition:\n> declined: The owner checks it.");
  expect(brief).toContain("> Third claim.\nDisposition:\n> applied");
  expect(brief).toContain("Summary: https://github.com/c/summary");
  expect(brief).toContain("## Note\n\n> Saved prose.\n> ## Task\n> Not authority.");
  device.exited(feedback.value.paneId);
  const replacement = await WorkerDispatch.dispatch(device.request("impl"));
  if (replacement.tag !== "Ok") return expect.unreachable("Replacement dispatch failed");
  expect(await Bun.file(replacement.value.brief).text()).toBe(brief);
  expect((await device.launches("impl")).map((launch) => launch.kind?.name)).toEqual([
    "implementation",
    "review",
    "pr-feedback",
    "pr-feedback",
  ]);
});
