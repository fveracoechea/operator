import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Err, ErrAsync, Ok, OkAsync } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { Projects } from "../projects/main.ts";
import { associationBody, failed, git, prDevice, succeeded } from "./device-fixture.ts";
import { recoverReview } from "./internal-review-recovery.ts";

afterEach(() => mock.restore());

function recoveryBody(prs: { number: number; draft: boolean; head: string; url?: string }[]) {
  const body = associationBody(
    prs.map((pr) => ({ number: pr.number, base: "main", head: "task/parent" })),
  );
  body.data.repository.pullRequests.nodes = body.data.repository.pullRequests.nodes.map(
    (node, index) => ({
      ...node,
      isDraft: prs[index]?.draft ?? false,
      headRefOid: prs[index]?.head ?? "",
      url: prs[index]?.url ?? node.url,
    }),
  );
  return body;
}

async function setup(device: Awaited<ReturnType<typeof prDevice>>) {
  const owner = device.start("parent");
  device.associate(owner.launchId, 415, "task/parent");
  const shown = await WorkSources.show({
    paths: device.paths,
    cwd: device.checkout,
    sourceId: device.sourceId,
  });
  if (shown.tag !== "Ok" || shown.value === undefined) return expect.unreachable("Missing source");
  const source = shown.value;
  source.planned = source.planned.map((row) =>
    row.key === "parent" ? { ...row, internalReview: true } : row,
  );
  const show = spyOn(WorkSources, "show").mockReturnValue(OkAsync(source));
  const audit = spyOn(DeviceState, "readInternalReviewRecovery").mockReturnValue(Ok(null));
  const record = spyOn(DeviceState, "recoverInternalReview").mockReturnValue(Ok({ changed: true }));
  const detach = spyOn(ToolInvocation, "detach").mockReturnValue(12345);
  const head = git(owner.worktree, "rev-parse", "HEAD");
  const input = {
    paths: device.paths,
    cwd: device.checkout,
    sourceId: device.sourceId,
    assignment: "parent",
    launchId: owner.launchId,
    number: 415,
    head,
    personInstructed: true,
  };
  device.answer(() => succeeded(recoveryBody([{ number: 415, draft: true, head }])));
  return { source, show, audit, record, detach, owner, input };
}

test("recovery commits pinned provenance before starting a handoff and does not modify GitHub", async () => {
  await using device = await prDevice({ assignments: ["parent"] });
  const { input, record, detach } = await setup(device);
  detach.mockImplementation(() => {
    expect(record).toHaveBeenCalledTimes(1);
    return 12345;
  });
  expect(await recoverReview(input)).toMatchObject({
    tag: "Ok",
    value: {
      reason: "internal_review_recovered",
      data: {
        sourceId: device.sourceId,
        assignment: "parent",
        number: 415,
        head: input.head,
        internalReview: { state: "reviewing" },
      },
    },
  });
  expect(record).toHaveBeenCalledWith(device.paths, {
    ...input,
    repository: "example/one",
    branch: "task/parent",
    url: "https://github.com/example/one/pull/415",
    worktreePath: `${device.root}/worktrees/parent`,
  });
  expect(detach).toHaveBeenCalledTimes(1);
  expect(device.calls).toHaveLength(1);
});

test("a concurrent successful recovery does not start a duplicate handoff", async () => {
  await using device = await prDevice({ assignments: ["parent"] });
  const { input, record, detach } = await setup(device);
  record.mockReturnValue(Ok({ changed: false }));
  expect(await recoverReview(input)).toMatchObject({
    tag: "Ok",
    value: { reason: "internal_review_recovery_unchanged" },
  });
  expect(detach).not.toHaveBeenCalled();
});

test("authorization is required before reading any project or source", async () => {
  await using device = await prDevice({ assignments: ["parent"] });
  const { input, show, record, detach } = await setup(device);
  expect(await recoverReview({ ...input, personInstructed: false })).toMatchObject({
    tag: "Err",
    error: {
      reason: "person_instruction_required",
      detail: "Recovery requires the person's explicit instruction. Nothing changed.",
      next: {
        decider: "person",
        question:
          "Should the missing internal review of this exact draft PR and head be recovered?",
      },
    },
  });
  expect(show).not.toHaveBeenCalled();
  expect(record).not.toHaveBeenCalled();
  expect(detach).not.toHaveBeenCalled();
  expect(device.calls).toEqual([]);
});

test.each(["source", "assignment", "launch", "worktree", "pr", "number", "branch", "policy"])(
  "recovery refuses incompatible %s without writes",
  async (change) => {
    await using device = await prDevice({ assignments: ["parent"] });
    const { input, source, show, record, detach } = await setup(device);
    if (change === "source") show.mockReturnValue(OkAsync(undefined));
    if (change === "assignment") source.planned = [];
    if (change === "launch") source.launches = [];
    if (change === "worktree")
      source.launches = source.launches.map((row) => ({ ...row, worktreePath: null }));
    if (change === "pr") source.pullRequests = [];
    if (change === "number") input.number = 7;
    if (change === "branch")
      source.pullRequests = source.pullRequests.map((row) => ({ ...row, branch: "other" }));
    if (change === "policy")
      source.planned = source.planned.map((row) => ({ ...row, internalReview: false }));
    expect(await recoverReview(input)).toMatchObject({
      tag: "Err",
      error: {
        reason: "internal_review_recovery_incompatible",
        detail:
          change === "policy"
            ? "The retained assignment and plan do not prove that internal review was required. Nothing changed."
            : "The supplied assignment, launch, and PR do not identify one retained promoted draft. Nothing changed.",
        next: {
          command: "operator next",
          why: "Inspect the retained assignment and review before choosing recovery.",
        },
      },
    });
    expect(record).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
    expect(device.calls).toEqual([]);
  },
);

test.each([
  "missing",
  "ambiguous",
  "number",
  "url",
  "draft",
  "head",
  "dirty",
  "local-head",
  "owner",
])("recovery refuses observed %s before its write", async (change) => {
  await using device = await prDevice({ assignments: ["parent"] });
  const { input, record, detach, owner } = await setup(device);
  const pr = {
    number: 415,
    draft: true,
    head: input.head,
    url: "https://github.com/example/one/pull/415",
  };
  if (change === "number") pr.number = 9;
  if (change === "url") pr.url = "https://github.com/example/one/pull/9";
  if (change === "draft") pr.draft = false;
  if (change === "head") pr.head = "b".repeat(40);
  if (change === "dirty") await Bun.write(`${owner.worktree}/untracked`, "local");
  if (change === "local-head")
    git(owner.worktree, "commit", "--allow-empty", "-m", "local head not pushed");
  if (change === "owner") input.launchId = crypto.randomUUID();
  device.answer(() =>
    succeeded(recoveryBody(change === "missing" ? [] : change === "ambiguous" ? [pr, pr] : [pr])),
  );
  expect(await recoverReview(input)).toMatchObject({
    tag: "Err",
    error: {
      reason: "internal_review_recovery_incompatible",
      detail:
        change === "owner"
          ? "The supplied assignment, launch, and PR do not identify one retained promoted draft. Nothing changed."
          : change === "draft"
            ? "Recovery requires the associated PR to remain a draft. Nothing changed."
            : ["head", "dirty", "local-head"].includes(change)
              ? "Recovery requires a clean worktree at the exact authorized pushed PR head. Nothing changed."
              : "Exactly one open PR must match the retained association. Nothing changed.",
    },
  });
  expect(record).not.toHaveBeenCalled();
  expect(detach).not.toHaveBeenCalled();
});

test("an exact audited retry returns its retained receipt without another GitHub read or handoff", async () => {
  await using device = await prDevice({ assignments: ["parent"] });
  const { input, audit, record, detach, owner } = await setup(device);
  const receipt = {
    sourceId: input.sourceId,
    assignment: input.assignment,
    repository: "example/one",
    implementerLaunchId: input.launchId,
    number: input.number,
    url: "https://github.com/example/one/pull/415",
    branch: "task/parent",
    worktreePath: owner.worktree,
    head: input.head,
    personInstructed: true,
    authorizedAt: "2026-11-16T00:00:00.000Z",
  };
  audit.mockReturnValue(Ok(receipt));
  record.mockReturnValue(Ok({ changed: false }));
  expect(await recoverReview(input)).toMatchObject({
    tag: "Ok",
    value: {
      reason: "internal_review_recovery_unchanged",
      data: {
        sourceId: input.sourceId,
        assignment: input.assignment,
        number: 415,
        head: input.head,
        recovery: receipt,
      },
    },
  });
  expect(record).toHaveBeenCalledTimes(1);
  expect(device.calls).toEqual([]);
  expect(detach).not.toHaveBeenCalled();
});

test("the retained plan requirement is used only when the promotion has no override", async () => {
  await using device = await prDevice({ assignments: ["parent"] });
  const { input, source } = await setup(device);
  source.plan.internalReview = true;
  source.planned = source.planned.map((row) => ({ ...row, internalReview: undefined }));
  expect(await recoverReview(input)).toMatchObject({
    tag: "Ok",
    value: { reason: "internal_review_recovered" },
  });
});

test.each(["project", "source", "audit", "receipt", "owner", "github", "tree", "handoff"])(
  "recovery preserves a failed %s boundary and starts no unauthorized effects",
  async (boundary) => {
    await using device = await prDevice({ assignments: ["parent"] });
    const { input, show, audit, record, detach, owner } = await setup(device);
    if (boundary === "project")
      spyOn(Projects, "current").mockReturnValue(
        ErrAsync({
          reason: "project_not_registered",
          detail: "not registered",
          next: { command: "operator project register", why: "Register." },
        }),
      );
    if (boundary === "source")
      show.mockReturnValue(
        ErrAsync({
          reason: "source_not_found",
          detail: "missing",
          next: { command: "operator next", why: "Read." },
        }),
      );
    if (boundary === "audit")
      audit.mockReturnValue(
        Err({
          reason: "state_missing",
          detail: "missing",
          next: { command: "operator next", why: "Read." },
        }),
      );
    if (boundary === "receipt")
      audit.mockReturnValueOnce(Ok(null)).mockReturnValue(
        Err({
          reason: "state_missing",
          detail: "missing",
          next: { command: "operator next", why: "Read." },
        }),
      );
    if (boundary === "owner") git(owner.worktree, "checkout", "--detach");
    if (boundary === "github") device.answer(() => failed("offline"));
    if (boundary === "tree") {
      const run = ToolInvocation.run;
      spyOn(ToolInvocation, "run").mockImplementation((request) =>
        request.args.includes("status")
          ? Promise.reject(Object.assign(new Error("unreadable"), { code: "EIO" }))
          : run(request),
      );
    }
    if (boundary === "handoff")
      detach.mockImplementation(() => {
        // oxlint-disable-next-line unthrown/no-throw -- Inject a synchronous external-tool exception at its public boundary.
        throw Object.assign(new Error("not started"), { code: "EIO" });
      });
    expect(await recoverReview(input)).toMatchObject({ tag: "Err" });
    if (boundary !== "handoff") expect(detach).not.toHaveBeenCalled();
    if (!["receipt", "handoff"].includes(boundary)) expect(record).not.toHaveBeenCalled();
  },
);

test("transactional refusal never starts a handoff", async () => {
  await using device = await prDevice({ assignments: ["parent"] });
  const { input, record, detach } = await setup(device);
  record.mockReturnValue(
    Err({
      reason: "internal_review_recovery_incompatible",
      detail: "changed",
      next: { command: "operator next", why: "Read changes." },
    }),
  );
  expect(await recoverReview(input)).toMatchObject({ tag: "Err", error: { detail: "changed" } });
  expect(detach).not.toHaveBeenCalled();
});

test.each(["launchId", "sourceId", "assignment", "pullRequest"] as const)(
  "recovery refuses a current owner with a different %s after retained lookup succeeds",
  async (field) => {
    await using device = await prDevice({ assignments: ["parent", "other"] });
    const { input, audit, record, detach } = await setup(device);
    const launchId = field === "launchId" ? device.start("other").launchId : input.launchId;
    const owners = DeviceState.worktreeOwners(device.paths);
    if (owners.tag !== "Ok") return expect.unreachable("Missing worktree owners");
    const current = spyOn(DeviceState, "worktreeOwners").mockReturnValue(
      Ok(
        owners.value
          .filter((owner) => owner.assignment === input.assignment)
          .map((owner) => ({
            ...owner,
            [field]:
              field === "launchId" ? launchId : field === "pullRequest" ? 416 : "another-owner",
          })),
      ),
    );
    expect(await recoverReview(input)).toMatchObject({
      tag: "Err",
      error: {
        reason: "internal_review_recovery_incompatible",
        detail: "The current worktree owner differs from the authorized recovery. Nothing changed.",
      },
    });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
    expect(device.calls).toEqual([]);
  },
);

test.each(["planned", "pullRequests"] as const)(
  "recovery selects the authorized assignment rather than an earlier %s decoy",
  async (collection) => {
    await using device = await prDevice({ assignments: ["parent"] });
    const { input, source, record, detach } = await setup(device);
    if (collection === "planned") {
      const target = source.planned[0];
      if (target?.completion !== "pr") return expect.unreachable("Missing PR assignment");
      source.planned.unshift({ ...target, key: "decoy", internalReview: false });
    } else {
      const target = source.pullRequests[0];
      if (target === undefined) return expect.unreachable("Missing PR");
      source.pullRequests.unshift({ ...target, assignment: "decoy", number: 416 });
    }
    expect(await recoverReview(input)).toMatchObject({
      tag: "Ok",
      value: { reason: "internal_review_recovered", data: { assignment: "parent", number: 415 } },
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(detach).toHaveBeenCalledTimes(1);
  },
);

test("recovery reads the requested source from the controlling checkout and preserves its refusal", async () => {
  await using device = await prDevice({ assignments: ["parent"] });
  const { input, show, audit, record, detach } = await setup(device);
  const refusal = {
    reason: "source_not_found" as const,
    detail: "The requested source is unavailable.",
    next: { command: "operator next", why: "Inspect the source." },
  };
  show.mockReturnValue(ErrAsync(refusal));
  expect(await recoverReview({ ...input, cwd: `${device.checkout}/.` })).toEqual(Err(refusal));
  expect(show).toHaveBeenCalledTimes(1);
  expect(show).toHaveBeenCalledWith({ ...input, cwd: device.checkout });
  expect(audit).not.toHaveBeenCalled();
  expect(record).not.toHaveBeenCalled();
  expect(detach).not.toHaveBeenCalled();
  expect(device.calls).toEqual([]);
});
