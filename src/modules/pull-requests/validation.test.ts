import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Err, Ok } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { commit, git, prDevice, pullRequestBody, succeeded } from "./device-fixture.ts";
import { validate } from "./validation.ts";

afterEach(() => mock.restore());

type Owner = Extract<ReturnType<typeof DeviceState.worktreeOwners>, { tag: "Ok" }>["value"][number];

function owners(paths: Parameters<typeof DeviceState.worktreeOwners>[0]) {
  const rows = DeviceState.worktreeOwners(paths);
  expect(rows.tag).toBe("Ok");
  return rows.tag === "Ok" ? rows.value : [];
}

async function correction(overrides: Partial<Owner> = {}) {
  const device = await prDevice();
  const owner = device.start("other");
  device.associate(owner.launchId, 7, "task/other");
  const readyHead = await commit(owner.worktree, "feature.txt", "ready\n");
  const head = await commit(owner.worktree, "fix.txt", "bounded correction\n");
  const rows = owners(device.paths);
  spyOn(DeviceState, "worktreeOwners").mockReturnValue(
    Ok(rows.map((row) => ({ ...row, reviewState: "ready", readyHead, ...overrides }))),
  );
  const recorded = spyOn(DeviceState, "recordDeliveryValidation").mockReturnValue(
    Ok({
      id: "00000000-0000-0000-0000-000000000001",
      launchId: owner.launchId,
      head,
      readyHead,
      summary: "Bounded correction passed local quality and CI.",
      validatedAt: "now",
    }),
  );
  const file = `${device.root}/evidence.txt`;
  await Bun.write(file, "Bounded correction passed local quality and CI.\n");
  device.answer(() => succeeded(pullRequestBody({ head })));
  return {
    ...device,
    owner,
    head,
    readyHead,
    recorded,
    input: { paths: device.paths, cwd: owner.worktree, file },
  };
}

function blocked(result: Awaited<ReturnType<typeof validate>>) {
  expect<unknown>(result).toMatchObject({
    tag: "Err",
    error: { reason: "pr_validation_blocked" },
  });
  if (result.tag !== "Err") return;
  expect(result.error.detail).toMatch(/\S/);
  expect(result.error).toHaveProperty("next");
  if ("next" in result.error) {
    expect(result.error.next.decider).toBe("super-agent");
    expect(result.error.next.question).toMatch(/\S/);
  }
}

test.each(["ready", "skipped"])(
  "correction validation after %s preserves reviewed provenance and returns delivery guidance",
  async (reviewState) => {
    await using device = await correction({ reviewState });
    const reviewWrite = spyOn(DeviceState, "recordInternalReviewRound");
    const result = await validate(device.input);
    expect<unknown>(result).toMatchObject({
      tag: "Ok",
      value: {
        reason: "pr_validated",
        data: {
          sourceId: device.sourceId,
          assignment: "other",
          number: 7,
          head: device.head,
          readyHead: device.readyHead,
        },
        next: { command: "operator pr wait --json" },
      },
    });
    if (result.tag === "Ok") expect(result.value.next.why).toMatch(/\S/);
    expect(device.recorded).toHaveBeenCalledTimes(1);
    expect(device.recorded).toHaveBeenCalledWith(device.paths, {
      launchId: device.owner.launchId,
      head: device.head,
      readyHead: device.readyHead,
      summary: "Bounded correction passed local quality and CI.",
    });
    expect(reviewWrite).not.toHaveBeenCalled();
  },
);

test.each([
  { pullRequest: null },
  { readyHead: null },
  { reviewState: null },
  { reviewState: "pending" },
  { reviewState: "round-one" },
])("validation requires an associated PR and ended review provenance: %j", async (overrides) => {
  await using device = await correction(overrides);
  blocked(await validate(device.input));
  expect(device.recorded).not.toHaveBeenCalled();
  expect(device.calls).toEqual([]);
});

test.each(["", " \n\t ", "x".repeat(4001)])(
  "validation rejects empty or oversized evidence (%#. case)",
  async (text) => {
    await using device = await correction();
    await Bun.write(device.input.file, text);
    blocked(await validate(device.input));
    expect(device.recorded).not.toHaveBeenCalled();
    expect(device.calls).toEqual([]);
  },
);

test.each(["x", "x".repeat(4000)])(
  "validation stores trimmed plain text, including inclusive length boundaries (%#. case)",
  async (summary) => {
    await using device = await correction();
    await Bun.write(device.input.file, ` \n${summary}\t `);
    expect<unknown>(await validate(device.input)).toMatchObject({
      tag: "Ok",
      value: { reason: "pr_validated" },
    });
    expect(device.recorded).toHaveBeenCalledTimes(1);
    expect(device.recorded).toHaveBeenCalledWith(device.paths, {
      launchId: device.owner.launchId,
      head: device.head,
      readyHead: device.readyHead,
      summary,
    });
  },
);

test.each(['{"correction":"passed"}', "[]", '"passed"', "0", "false", "null"])(
  "validation rejects a JSON document instead of accepting it as plain-text evidence: %s",
  async (document) => {
    await using device = await correction();
    await Bun.write(device.input.file, ` \n${document}\t `);
    blocked(await validate(device.input));
    expect(device.recorded).not.toHaveBeenCalled();
    expect(device.calls).toEqual([]);
  },
);

test("validation reads evidence from stdin only when the file is a dash", async () => {
  await using device = await correction();
  const stdin = spyOn(Bun.stdin, "text").mockResolvedValue("  stdin correction evidence\n");
  expect<unknown>(await validate({ ...device.input, file: "-" })).toMatchObject({
    tag: "Ok",
    value: { reason: "pr_validated" },
  });
  expect(stdin).toHaveBeenCalledTimes(1);
  expect(device.recorded).toHaveBeenCalledWith(device.paths, {
    launchId: device.owner.launchId,
    head: device.head,
    readyHead: device.readyHead,
    summary: "stdin correction evidence",
  });
});

test("unreadable evidence is an IO refusal without a validation write", async () => {
  await using device = await correction();
  const result = await validate({ ...device.input, file: `${device.root}/missing.txt` });
  expect<unknown>(result).toMatchObject({
    tag: "Err",
    error: { reason: "pr_io_failed" },
  });
  if (result.tag === "Err") expect(result.error.detail).toMatch(/\S/);
  expect(device.recorded).not.toHaveBeenCalled();
  expect(device.calls).toEqual([]);
});

test("dirty worktree evidence cannot validate even a pushed head with passing checks", async () => {
  await using device = await correction();
  await Bun.write(`${device.owner.worktree}/untracked.txt`, "retained work\n");
  blocked(await validate(device.input));
  expect(device.recorded).not.toHaveBeenCalled();
  expect(await Bun.file(`${device.owner.worktree}/untracked.txt`).text()).toBe("retained work\n");
});

test("a clean local correction must be pushed even when GitHub still has the reviewed ancestor", async () => {
  await using device = await correction();
  device.answer(() => succeeded(pullRequestBody({ head: device.readyHead })));
  blocked(await validate(device.input));
  expect(device.recorded).not.toHaveBeenCalled();
});

test.each([
  { head: "unpublished-head" },
  { state: "CLOSED" as const },
  { state: "MERGED" as const },
  { checks: [] },
  { checks: ["FAILURE" as const] },
  { checks: ["SUCCESS" as const, "PENDING" as const] },
  { checks: ["SUCCESS" as const, "FAILURE" as const] },
])(
  "validation refuses current PR facts that cannot prove a clean passing push: %j",
  async (facts) => {
    await using device = await correction();
    device.answer(() =>
      succeeded(
        pullRequestBody({
          head: device.head,
          ...facts,
          checks: [...(facts.checks ?? ["SUCCESS"])],
        }),
      ),
    );
    blocked(await validate(device.input));
    expect(device.recorded).not.toHaveBeenCalled();
  },
);

test("a truncated list of passing checks is not proof that all current checks pass", async () => {
  await using device = await correction();
  const body = pullRequestBody({ head: device.head });
  for (const node of body.data.repository.pullRequest.commits.nodes)
    node.commit.statusCheckRollup.contexts.totalCount = 2;
  device.answer(() => succeeded(body));
  blocked(await validate(device.input));
  expect(device.recorded).not.toHaveBeenCalled();
});

test("validation does not pretend to enforce the separate GitHub approval merge guard", async () => {
  await using device = await correction();
  device.answer(() =>
    succeeded(pullRequestBody({ head: device.head, approved: false, unresolved: 1 })),
  );
  expect<unknown>(await validate(device.input)).toMatchObject({
    tag: "Ok",
    value: { reason: "pr_validated", next: { command: "operator pr wait --json" } },
  });
  expect(device.recorded).toHaveBeenCalledTimes(1);
});

test("a reviewed commit on unrelated history is not the correction's ancestor", async () => {
  await using device = await correction();
  const tree = git(device.owner.worktree, "rev-parse", "HEAD^{tree}");
  const unrelated = git(device.owner.worktree, "commit-tree", tree, "-m", "unrelated review");
  const rows = owners(device.paths);
  spyOn(DeviceState, "worktreeOwners").mockReturnValue(
    Ok(rows.map((row) => ({ ...row, readyHead: unrelated }))),
  );
  blocked(await validate(device.input));
  expect(device.recorded).not.toHaveBeenCalled();
});

test("ancestry is requested with the original ready head and current observed head", async () => {
  await using device = await correction();
  const run = spyOn(ToolInvocation, "run");
  await validate(device.input);
  expect(run).toHaveBeenCalledWith({
    tool: "git",
    args: ["merge-base", "--is-ancestor", device.readyHead, device.head],
    cwd: device.owner.worktree,
    timeoutMs: 10000,
  });
});

test("an unanswered ancestry request cannot record validation", async () => {
  await using device = await correction();
  const run = ToolInvocation.run.bind(ToolInvocation);
  spyOn(ToolInvocation, "run").mockImplementation((input) =>
    input.args[0] === "merge-base"
      ? Promise.resolve({ status: "no-answer", detail: "ancestry timed out" })
      : run(input),
  );
  blocked(await validate(device.input));
  expect(device.recorded).not.toHaveBeenCalled();
});

test("a recording refusal is propagated instead of reporting successful validation", async () => {
  await using device = await correction();
  device.recorded.mockReturnValue(
    Err({
      reason: "pr_validation_stale",
      detail: "Review provenance changed before write.",
      next: { decider: "super-agent", question: "Which reviewed head is current?" },
    }),
  );
  expect<unknown>(await validate(device.input)).toEqual({
    tag: "Err",
    error: {
      reason: "pr_validation_stale",
      detail: "Review provenance changed before write.",
      next: { decider: "super-agent", question: "Which reviewed head is current?" },
    },
  });
});
