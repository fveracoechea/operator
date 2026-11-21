import { afterEach, expect, mock, test } from "bun:test";
import { DeviceState } from "../device-state/main.ts";
import { WorkerKinds } from "../worker-kinds/main.ts";
import { git, prDevice, pullRequestBody, requestKind, succeeded } from "./device-fixture.ts";
import { validate } from "./validation.ts";

afterEach(() => mock.restore());

async function feedback() {
  const device = await prDevice();
  const outgoing = device.start("other");
  const readyHead = git(outgoing.worktree, "rev-parse", "HEAD");
  device.associate(outgoing.launchId, 7, "task/other", null, {
    head: readyHead,
    at: "ready-at",
    note: null,
    dispositions: [],
  });
  expect(DeviceState.finishImplementer(device.paths, outgoing.launchId).tag).toBe("Ok");
  const owner = device.start("other", {
    worktree: outgoing.worktree,
    add: false,
    kind: JSON.stringify(WorkerKinds.resolve("pr-feedback")),
  });
  return {
    device,
    ...owner,
    readyHead,
    input: { paths: device.paths, cwd: owner.worktree, file: `${device.root}/evidence.txt` },
  };
}

test("the fresh review-off feedback owner records exact-head evidence without rewriting readiness", async () => {
  const { device, worktree, readyHead, input } = await feedback();
  await using _ = device;
  git(worktree, "commit", "--allow-empty", "-qm", "bounded correction");
  const head = git(worktree, "rev-parse", "HEAD");
  const before = device.pullRequestRow("other");
  await Bun.write(
    input.file,
    "Scope: bounded correction. Evidence: targeted tests passed, receipt /evidence/test.",
  );
  device.answer((args) =>
    requestKind(args) === "branch"
      ? succeeded({ object: { sha: head } })
      : succeeded(pullRequestBody({ head })),
  );
  expect<unknown>(await validate(input)).toMatchObject({
    tag: "Ok",
    value: { reason: "pr_validated", data: { head, readyHead } },
  });
  expect(device.pullRequestRow("other")).toEqual(before);
  expect(device.calls.map(requestKind)).toEqual(["pull_request", "branch"]);
});

test.each(["dirty", "remote-head", "checks", "empty", "json"])(
  "validation refuses %s with no evidence write or remote mutation",
  async (scenario) => {
    const { device, worktree, input } = await feedback();
    await using _ = device;
    const head = git(worktree, "rev-parse", "HEAD");
    await Bun.write(
      input.file,
      scenario === "empty" ? " " : scenario === "json" ? "{}" : "Scoped evidence.",
    );
    if (scenario === "dirty") await Bun.write(`${worktree}/untracked`, "Keep.");
    device.answer((args) =>
      requestKind(args) === "branch"
        ? succeeded({ object: { sha: scenario === "remote-head" ? "moved" : head } })
        : succeeded(
            pullRequestBody({ head, checks: scenario === "checks" ? ["FAILURE"] : ["SUCCESS"] }),
          ),
    );
    const before = await Bun.file(device.paths.database).arrayBuffer();
    expect<unknown>(await validate(input)).toMatchObject({
      tag: "Err",
      error: { reason: "pr_validation_blocked" },
    });
    expect(await Bun.file(device.paths.database).arrayBuffer()).toEqual(before);
    expect(device.calls.some((args) => requestKind(args) === "merge")).toBe(false);
  },
);
