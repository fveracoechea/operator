import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
// Bun has no synchronous directory creation or recursive removal API.
import { mkdirSync, rmSync } from "node:fs";
import { Err, Ok, OkAsync, fromPromise } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { git, prDevice, repository, succeeded } from "./device-fixture.ts";
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

async function reviewer() {
  const device = await prDevice();
  const implementer = device.start("parent");
  expect(
    DeviceState.associatePullRequest(
      device.paths,
      implementer.launchId,
      {
        number: 7,
        url: `https://github.com/${repository}/pull/7`,
        branch: "task/parent",
        relay: null,
      },
      false,
      true,
    ).tag,
  ).toBe("Ok");
  expect(DeviceState.finishImplementer(device.paths, implementer.launchId).tag).toBe("Ok");
  const worker = device.start("parent", { worktree: implementer.worktree, add: false });
  const head = git(worker.worktree, "rev-parse", "HEAD");
  expect(
    DeviceState.recordInternalReviewRound(device.paths, worker.launchId, () =>
      Ok({ head, findings: "[]" }),
    ).tag,
  ).toBe("Ok");
  const file = `${device.root}/summary.md`;
  const note = `${device.root}/note.md`;
  await Bun.write(file, "## Overview\nNo findings.\n## Dispositions\n");
  await Bun.write(note, "Check the boundary.\n");
  device.answer((args) => {
    if (args.some((arg) => arg.includes("ReadyFacts")))
      return succeeded({
        data: {
          viewer: { login: "owner" },
          repository: {
            pullRequest: {
              id: "PR7",
              state: "OPEN",
              isDraft: true,
              headRefOid: head,
              comments: { nodes: [] },
            },
          },
        },
      });
    if (args.includes("POST"))
      return succeeded({ node_id: "comment", html_url: "https://github.com/c/1" });
    return succeeded({
      data: { markPullRequestReadyForReview: { pullRequest: { id: "PR7", isDraft: false } } },
    });
  });
  spyOn(ToolInvocation, "detach").mockReturnValue(process.pid);
  const files = OperatorHome.assignmentFiles(device.paths, {
    repository,
    sourceId: device.sourceId,
    assignment: "parent",
  });
  return {
    device,
    worker,
    head,
    files,
    input: { paths: device.paths, cwd: worker.worktree, file, note },
  };
}

test("ready stages its copied note before publishing and removes an actual partial write", async () => {
  const { device, input, files } = await reviewer();
  await using _ = device;
  const original = Bun.write;
  const cause = Object.assign(new Error("partial IO write"), { code: "EIO" });
  let saved = "";
  spyOn(Bun, "write").mockImplementation(async (destination, data, options) => {
    const file = z.string().parse(destination);
    const text = z.string().parse(data);
    if (file.startsWith(files.directory + "/ready-")) {
      saved = file;
      await original(file, "partial", options);
      return Promise.reject(cause);
    }
    return original(file, text, options);
  });
  expect(await ready(input)).toMatchObject({ tag: "Err", error: { reason: "pr_io_failed" } });
  expect(saved).not.toBe("");
  expect(await Bun.file(saved).exists()).toBe(false);
  expect(device.calls).toHaveLength(1);
  expect(device.pullRequestRow("parent")?.readiness).toBeNull();
});

test("a partial note write retains its primary IO failure when deleting the partial file also fails", async () => {
  const { device, input, files } = await reviewer();
  await using _ = device;
  const original = Bun.write;
  const cause = Object.assign(new Error("original partial write"), { code: "EIO" });
  spyOn(Bun, "write").mockImplementation(async (destination, data, options) => {
    const file = z.string().parse(destination);
    const text = z.string().parse(data);
    if (file.startsWith(files.directory + "/ready-")) {
      await original(file, "partial", options);
      rmSync(file);
      mkdirSync(file);
      return Promise.reject(cause);
    }
    return original(file, text, options);
  });
  const secondary = spyOn(console, "error").mockImplementation(() => undefined);
  expect(await ready(input)).toMatchObject({
    tag: "Err",
    error: {
      reason: "pr_io_failed",
      detail: "Error: original partial write",
      state: { code: "EIO" },
    },
  });
  expect(secondary).toHaveBeenCalledTimes(1);
  expect(secondary.mock.calls[0]).toMatchObject([
    "pr_note_cleanup_failed",
    { secondary: { code: "EISDIR" } },
  ]);
  expect(device.calls).toHaveLength(1);
});

test("a real SQLite state-write Defect keeps its original cause through a failing filesystem cleanup", async () => {
  const { device, input } = await reviewer();
  await using _ = device;
  using db = new Database(device.paths.database);
  db.exec(
    "CREATE TRIGGER fail_ready BEFORE UPDATE OF readiness ON pull_requests BEGIN SELECT RAISE(FAIL, 'original readiness write fault'); END",
  );
  const original = DeviceState.endInternalReview;
  let primary: unknown;
  spyOn(DeviceState, "endInternalReview").mockImplementation((...args) => {
    const result = original(...args);
    expect(result.tag).toBe("Defect");
    if (result.tag === "Defect") primary = result.cause;
    const saved = args[2].readiness?.note ?? expect.unreachable("Missing staged note");
    rmSync(saved);
    mkdirSync(saved);
    return result;
  });
  const secondary = spyOn(console, "error").mockImplementation(() => undefined);
  const result = await ready(input);
  expect(result.tag).toBe("Defect");
  expect(result.tag === "Defect" ? result.cause : undefined).toBe(primary);
  expect(String(primary)).toContain("original readiness write fault");
  expect(secondary.mock.calls[0]).toMatchObject([
    "pr_note_cleanup_failed",
    { secondary: { code: "EISDIR" } },
  ]);
  expect(device.pullRequestRow("parent")?.readiness).toBeNull();
});

test.each(["operational", "defect", "unchanged"] as const)(
  "ready preserves the primary %s outcome when cleanup also fails",
  async (mode) => {
    const { device, input } = await reviewer();
    await using _ = device;
    const cause = new Error("original state defect", { cause: { original: true } });
    const defect = await fromPromise(Promise.reject(cause), (cause, unexpected) =>
      unexpected(cause),
    );
    const operational = Err({
      reason: "state_busy" as const,
      detail: "original state failure",
      next: { command: "operator next", why: "Retry when idle." },
    });
    const before = DeviceState.readSources(device.paths, repository, device.sourceId);
    if (before.tag !== "Ok") return expect.unreachable("Missing review state");
    const review = before.value[0]?.internalReviews[0] ?? expect.unreachable("Missing review");
    let saved = "";
    spyOn(DeviceState, "endInternalReview").mockImplementation((...args) => {
      saved = args[2].readiness?.note ?? "";
      rmSync(saved);
      mkdirSync(saved);
      if (mode === "defect") return defect;
      if (mode === "operational") return operational;
      return Ok({ changed: false, review });
    });
    const secondary = spyOn(console, "error").mockImplementation(() => undefined);
    const result = await ready(input);
    if (mode === "defect") {
      expect(result.tag).toBe("Defect");
      expect(result.tag === "Defect" ? result.cause : null).toBe(cause);
    } else if (mode === "operational") expect(result).toBe(operational);
    else expect(result).toMatchObject({ tag: "Ok", value: { reason: "pr_ready_unchanged" } });
    expect(secondary).toHaveBeenCalledTimes(1);
    expect(secondary.mock.calls[0]).toMatchObject([
      "pr_note_cleanup_failed",
      { file: saved, secondary: { code: "EISDIR" } },
    ]);
  },
);

test("successful ready persists the copied note, receipt and pending handoff through its owning operation", async () => {
  const { device, input, head, worker } = await reviewer();
  await using _ = device;
  expect(await ready(input)).toMatchObject({
    tag: "Ok",
    value: { reason: "pr_ready", data: { head } },
  });
  const source = DeviceState.readSources(device.paths, repository, device.sourceId);
  expect(source).toMatchObject({
    tag: "Ok",
    value: [
      {
        internalReviews: [
          { state: "ready", readyHead: head, commentUrl: "https://github.com/c/1" },
        ],
        handoffs: [
          { outgoingLaunchId: worker.launchId, nextKind: "pr-feedback", handoffState: "pending" },
        ],
      },
    ],
  });
  const receipt = device.pullRequestRow("parent")?.readiness;
  expect(receipt).not.toBeNull();
  const decoded: unknown = JSON.parse(receipt ?? "null");
  expect(decoded).toMatchObject({ head, dispositions: [] });
  if (source.tag !== "Ok") return expect.unreachable("The ready record is missing.");
  const { note } = z.object({ note: z.string() }).parse(decoded);
  expect(await Bun.file(note).text()).toBe("Check the boundary.\n");
  expect(device.calls).toHaveLength(3);
});

test.each(["refused", "unchanged"] as const)(
  "a %s state write removes the copied note and starts no handoff",
  async (mode) => {
    const { device, input } = await reviewer();
    await using _ = device;
    const before = DeviceState.readSources(device.paths, repository, device.sourceId);
    if (before.tag !== "Ok") return expect.unreachable("Missing review state");
    const review = before.value[0]?.internalReviews[0] ?? expect.unreachable("Missing review");
    let saved = "";
    spyOn(DeviceState, "endInternalReview").mockImplementation((...args) => {
      saved = args[2].readiness?.note ?? "";
      return mode === "unchanged"
        ? Ok({ changed: false, review })
        : Err({
            reason: "internal_review_ended" as const,
            detail: "Concurrent end.",
            next: { why: "No ready transition remains." },
          });
    });
    const detached = spyOn(ToolInvocation, "detach");
    const result = await ready(input);
    expect(result.tag).toBe(mode === "unchanged" ? "Ok" : "Err");
    expect(await Bun.file(saved).exists()).toBe(false);
    expect(detached).not.toHaveBeenCalled();
    expect(DeviceState.readSources(device.paths, repository, device.sourceId)).toEqual(before);
  },
);
