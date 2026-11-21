import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Err, Ok, fromPromise } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { WorkerKinds } from "../worker-kinds/main.ts";
import { Environment } from "../environment/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import {
  failed,
  git,
  mergeRequest,
  prDevice,
  pullRequestBody,
  repository,
  requestKind,
  succeeded,
  uncertain,
} from "./device-fixture.ts";
import { merge } from "./merge.ts";
import { stacked } from "./relay.ts";

afterEach(() => {
  mock.restore();
});

const cli = Bun.fileURLToPath(new URL("../../cli.ts", import.meta.url));
const parent = { assignment: "parent", number: 6, branch: "task/parent" };
const passingConditions = {
  approved: true,
  checksPassing: true,
  threadsResolved: true,
  defaultBase: true,
  notDraft: true,
  stackRelayed: true,
  reviewEnded: true,
};
const effectRecovery = {
  decider: "super-agent",
  question:
    "How should GitHub's current state be inspected before repeating the unconfirmed request?",
};
const refusedRecovery = {
  decider: "person",
  question: "Which GitHub merge restriction must be resolved before this PR can merge?",
};
const verifyRecovery = {
  command: "operator pr merge",
  why: "Verify whether the earlier merge request landed.",
};

/** A running owner of `other` with PR #7 recorded, and a cleanup start that never runs. */
async function owner(
  relay: string | null = null,
  assignments?: string[],
  typed = false,
  ready = true,
  reviewState?: "ready" | "skipped",
) {
  const device = await prDevice({ assignments });
  const outgoing = device.start("other", {
    kind: typed ? JSON.stringify(WorkerKinds.resolve("implementation")) : null,
  });
  const head = git(outgoing.worktree, "rev-parse", "HEAD");
  const readiness = {
    head,
    at: new Date().toISOString(),
    note: null,
    dispositions: [],
  };
  let started = outgoing;
  if (reviewState === undefined)
    device.associate(outgoing.launchId, 7, "task/other", relay, ready ? readiness : undefined);
  else {
    expect(
      DeviceState.associatePullRequest(
        device.paths,
        outgoing.launchId,
        {
          number: 7,
          url: "https://github.com/example/one/pull/7",
          branch: "task/other",
          relay,
        },
        false,
        true,
      ).tag,
    ).toBe("Ok");
    expect(DeviceState.finishImplementer(device.paths, outgoing.launchId).tag).toBe("Ok");
    started = device.start("other", {
      worktree: outgoing.worktree,
      add: false,
      kind: JSON.stringify(WorkerKinds.resolve("review")),
    });
    if (reviewState === "skipped")
      expect(
        DeviceState.endInternalReview(
          device.paths,
          {
            sourceId: device.sourceId,
            assignment: "other",
            launchId: null,
          },
          { state: "skipped", readyHead: null, commentId: null, commentUrl: null },
          false,
        ).tag,
      ).toBe("Ok");
    expect(
      DeviceState.endInternalReview(
        device.paths,
        {
          sourceId: device.sourceId,
          assignment: "other",
          launchId: started.launchId,
        },
        { state: reviewState, readyHead: head, commentId: null, commentUrl: null, readiness },
        false,
      ).tag,
    ).toBe("Ok");
  }
  if (ready) {
    expect(DeviceState.finishImplementer(device.paths, started.launchId).tag).toBe("Ok");
    started = device.start("other", {
      worktree: outgoing.worktree,
      add: false,
      kind: typed ? JSON.stringify(WorkerKinds.resolve("pr-feedback")) : null,
    });
  }
  // A live process that is not this one, so the recorded cleanup stays visibly running.
  const detach = spyOn(ToolInvocation, "detach").mockReturnValue(process.ppid);
  // A background merge request is read once each second, which the units skip.
  const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined);
  return {
    device,
    ...started,
    head,
    detach,
    sleep,
    input: { paths: device.paths, cwd: started.worktree },
  };
}

test("a typed merge owner refuses hidden untracked work before requesting a merge", async () => {
  const { device, head, input, launchId, worktree, detach } = await owner(null, undefined, true);
  await using _ = device;
  expect(
    DeviceState.recordPullRequestWait(device.paths, launchId, () => ({
      progress: JSON.stringify({ seen: [], failures: [], eligibleHead: head }),
      waitState: "idle",
    })).tag,
  ).toBe("Ok");
  git(worktree, "config", "status.showUntrackedFiles", "no");
  await Bun.write(`${worktree}/pending.txt`, "Keep.");
  device.answer(() => succeeded(pullRequestBody({ head })));
  expect<unknown>(await merge(input)).toMatchObject({
    tag: "Err",
    error: { reason: "pr_worktree_unclean", state: { worktree_clean: false } },
  });
  expect(device.calls.map(requestKind)).toEqual(["pull_request"]);
  expect(detach).not.toHaveBeenCalled();
  expect(assignmentState(device)).toBe("pr-open");
  expect(await Bun.file(`${worktree}/pending.txt`).text()).toBe("Keep.");
});

test("a queue-enabled merge pins the enqueue and parks without recording completion", async () => {
  const { device, input, head, detach } = await owner(null, undefined, true);
  await using _ = device;
  let queued = false;
  device.answer((args) => {
    if (requestKind(args) === "enqueue") {
      expect(args).toContain(`head=${head}`);
      expect(args).toContain("id=PR_7");
      expect(JSON.parse(device.pullRequestRow("other")?.parking ?? "null")).toMatchObject({
        queueHead: head,
      });
      queued = true;
      return uncertain("lost enqueue response");
    }
    return succeeded(
      pullRequestBody({ head, queueEnabled: true, queueEntry: queued ? "Q7" : null }),
    );
  });
  expect<unknown>(await merge(input)).toMatchObject({
    tag: "Ok",
    value: {
      reason: "pr_enqueued",
      data: { state: "pr-open", queueEntry: "Q7" },
      next: { command: `operator next --source ${device.sourceId} --wait` },
    },
  });
  expect(device.calls.map(requestKind)).toEqual([
    "pull_request",
    "merge_queue",
    "enqueue",
    "merge_queue",
  ]);
  expect(assignmentState(device)).toBe("pr-open");
  expect(detach).toHaveBeenCalledTimes(1);
  expect(device.calls.some((args) => args.includes("PUT"))).toBe(false);
});

test("a scoped parked merge checks the gate, enqueues once, and never starts early cleanup", async () => {
  const { device, input, head, launchId, detach } = await owner(null, undefined, true);
  await using _ = device;
  spyOn(Environment, "caller").mockReturnValue({ pane: "supervisor", session: "session" });
  expect(
    DeviceState.takeOverSource(device.paths, repository, device.sourceId, {
      pane: "supervisor",
      session: "session",
    }).tag,
  ).toBe("Ok");
  expect(DeviceState.parkPullRequest(device.paths, launchId, { head, note: null }).tag).toBe("Ok");
  expect(DeviceState.finishImplementer(device.paths, launchId).tag).toBe("Ok");
  expect(
    DeviceState.claimHandoff(device.paths, repository, device.sourceId, "other", null).tag,
  ).toBe("Ok");
  expect(
    DeviceState.completeParking(device.paths, {
      repository,
      sourceId: device.sourceId,
      assignment: "other",
    }).tag,
  ).toBe("Ok");
  const scoped = { ...input, cwd: device.checkout, sourceId: device.sourceId, assignment: "other" };
  let queued = false;
  let approved = false;
  let landed = false;
  device.answer((args) => {
    if (requestKind(args) === "enqueue") {
      queued = true;
      return succeeded({ data: { enqueuePullRequest: { mergeQueueEntry: { id: "Q7" } } } });
    }
    return succeeded(
      pullRequestBody({
        head,
        approved,
        state: landed ? "MERGED" : "OPEN",
        mergeCommit: landed ? "m1" : null,
        queueEnabled: !landed,
        queueEntry: queued ? "Q7" : null,
      }),
    );
  });
  const before = device.pullRequestRow("other");
  expect<unknown>(await merge(scoped)).toMatchObject({
    tag: "Err",
    error: {
      reason: "pr_merge_blocked",
      next: { command: `operator next --source ${device.sourceId} --wait` },
    },
  });
  expect(device.pullRequestRow("other")).toEqual(before);
  expect(device.calls.map(requestKind)).toEqual(["pull_request"]);
  approved = true;
  for (let attempt = 0; attempt < 2; attempt++)
    expect<unknown>(await merge(scoped)).toMatchObject({
      tag: "Ok",
      value: {
        reason: "pr_enqueued",
        data: { head, state: "pr-open" },
        next: { command: `operator next --source ${device.sourceId} --wait` },
      },
    });
  expect(device.calls.filter((args) => requestKind(args) === "enqueue")).toHaveLength(1);
  expect(device.calls.some((args) => args.includes("PUT"))).toBe(false);
  const receipt = device.pullRequestRow("other");
  expect<unknown>(receipt).toEqual({ ...before, parking: receipt?.parking });
  expect(JSON.parse(receipt?.parking ?? "null")).toMatchObject({
    head,
    queueHead: head,
    state: "parked",
  });
  expect(detach).not.toHaveBeenCalled();
  landed = true;
  expect<unknown>(await merge(scoped)).toMatchObject({
    tag: "Ok",
    value: {
      reason: "pr_merge_awaiting_batch",
      data: { state: "pr-open" },
      next: { command: `operator next --source ${device.sourceId} --wait` },
    },
  });
  expect(device.pullRequestRow("other")).toEqual(receipt);
  expect(detach).not.toHaveBeenCalled();
});

test.each(["both", "local", "remote"])(
  "a scoped merge binds the parked head when %s heads change",
  async (change) => {
    const { device, head, input, launchId, worktree, detach } = await owner(null, undefined, true);
    await using _ = device;
    expect(DeviceState.parkPullRequest(device.paths, launchId, { head, note: null }).tag).toBe(
      "Ok",
    );
    expect(DeviceState.finishImplementer(device.paths, launchId).tag).toBe("Ok");
    expect(
      DeviceState.claimHandoff(device.paths, repository, device.sourceId, "other", null).tag,
    ).toBe("Ok");
    expect(
      DeviceState.completeParking(device.paths, {
        repository,
        sourceId: device.sourceId,
        assignment: "other",
      }).tag,
    ).toBe("Ok");
    if (change !== "remote") git(worktree, "commit", "--allow-empty", "-qm", "Changed head");
    const remote =
      change === "local"
        ? head
        : change === "both"
          ? git(worktree, "rev-parse", "HEAD")
          : "new-remote-head";
    device.answer(() => succeeded(pullRequestBody({ head: remote, queueEnabled: true })));
    const before = device.pullRequestRow("other");
    expect(
      await merge({
        ...input,
        cwd: device.checkout,
        sourceId: device.sourceId,
        assignment: "other",
      }),
    ).toMatchObject({ tag: "Err", error: { reason: "pr_head_mismatch" } });
    expect(device.calls.map(requestKind)).toEqual(["pull_request"]);
    expect(device.pullRequestRow("other")).toEqual(before);
    expect(detach).not.toHaveBeenCalled();
  },
);

test("an enqueue refusal keeps the assignment active and names a safe retry", async () => {
  const { device, input, head, detach } = await owner(null, undefined, true);
  await using _ = device;
  device.answer((args) =>
    requestKind(args) === "enqueue"
      ? succeeded({ data: null, errors: [{ message: "Queue rejected the head." }] })
      : succeeded(pullRequestBody({ head, queueEnabled: true })),
  );
  expect<unknown>(await merge(input)).toMatchObject({
    tag: "Err",
    error: { reason: "pr_enqueue_refused", next: { decider: "person" } },
  });
  expect(device.calls.map(requestKind)).toEqual([
    "pull_request",
    "merge_queue",
    "enqueue",
    "merge_queue",
  ]);
  expect(assignmentState(device)).toBe("pr-open");
  expect(detach).not.toHaveBeenCalled();
});

test("a proven enqueue refusal releases only its attempt and permits fresh guarded admission", async () => {
  const { device, input, head } = await owner(null, undefined, true);
  await using _ = device;
  let enqueues = 0;
  device.answer((args) => {
    if (requestKind(args) === "enqueue") {
      enqueues += 1;
      return enqueues === 1
        ? succeeded({
            data: null,
            errors: [
              {
                type: "UNPROCESSABLE",
                path: ["enqueuePullRequest"],
                message: "Queue admission refused.",
              },
            ],
          })
        : succeeded({ data: { enqueuePullRequest: { mergeQueueEntry: { id: "Q8" } } } });
    }
    return succeeded(
      pullRequestBody({ head, queueEnabled: true, queueEntry: enqueues > 1 ? "Q8" : null }),
    );
  });
  expect(await merge(input)).toMatchObject({ tag: "Err", error: { reason: "pr_enqueue_refused" } });
  expect(JSON.parse(device.pullRequestRow("other")?.parking ?? "null")).toMatchObject({
    queueHead: null,
  });
  expect(await merge(input)).toMatchObject({ tag: "Ok", value: { reason: "pr_enqueued" } });
  expect(enqueues).toBe(2);
  expect(device.calls.filter((args) => requestKind(args) === "pull_request")).toHaveLength(2);
  expect(device.calls.some((args) => args.includes("PUT"))).toBe(false);
});

test.each(["lost", "defect"] as const)(
  "a typed enqueue refusal survives %s verification and remains durably recoverable",
  async (verification) => {
    const { device, input, head } = await owner(null, undefined, true);
    await using _ = device;
    const secondary = new TypeError("Secondary membership failure.");
    const log = spyOn(process.stderr, "write").mockImplementation(() => true);
    let submitted = false;
    device.answer((args) => {
      if (requestKind(args) === "enqueue") {
        submitted = true;
        return succeeded({
          data: { enqueuePullRequest: null },
          errors: [
            {
              type: "UNPROCESSABLE",
              path: ["enqueuePullRequest"],
              message: "Primary typed refusal.",
            },
          ],
        });
      }
      if (submitted && requestKind(args) === "merge_queue")
        return verification === "defect"
          ? Promise.reject(secondary)
          : uncertain("Secondary membership answer lost.");
      return succeeded(pullRequestBody({ head, queueEnabled: true }));
    });
    expect(await merge(input)).toMatchObject({
      tag: "Err",
      error: {
        reason: "pr_enqueue_refused",
        detail: "Primary typed refusal.",
        state: { notApplied: true },
      },
    });
    const receipt = DeviceState.prParkingSchema().parse(
      JSON.parse(device.pullRequestRow("other")?.parking ?? "null"),
    );
    expect(receipt).toMatchObject({
      queueHead: head,
      queueRefusal: { head, attempt: receipt.queueAttempt, detail: "Primary typed refusal." },
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        verification === "defect"
          ? "Secondary membership failure."
          : "Secondary membership answer lost.",
      ),
    );
    device.answer(() => succeeded(pullRequestBody({ head, queueEnabled: true })));
    expect(await merge(input)).toMatchObject({
      tag: "Err",
      error: { reason: "pr_enqueue_refused", next: { command: "operator pr merge" } },
    });
    expect(
      DeviceState.prParkingSchema().parse(
        JSON.parse(device.pullRequestRow("other")?.parking ?? "null"),
      ).queueHead,
    ).toBeNull();
    expect(device.calls.filter((args) => requestKind(args) === "enqueue")).toHaveLength(1);
  },
);

test.each(["changed-head", "closed", "merged", "partial", "lost", "member"] as const)(
  "durable typed refusal stays pending after unsafe %s verification on a later call",
  async (verification) => {
    const { device, input, head } = await owner(null, undefined, true);
    await using _ = device;
    spyOn(process.stderr, "write").mockImplementation(() => true);
    let submitted = false;
    device.answer((args) => {
      if (requestKind(args) === "enqueue") {
        submitted = true;
        return succeeded({
          data: { enqueuePullRequest: null },
          errors: [
            { type: "UNPROCESSABLE", path: ["enqueuePullRequest"], message: "Typed refusal." },
          ],
        });
      }
      return submitted && requestKind(args) === "merge_queue"
        ? uncertain("First verification lost.")
        : succeeded(pullRequestBody({ head, queueEnabled: true }));
    });
    expect(await merge(input)).toMatchObject({
      tag: "Err",
      error: { reason: "pr_enqueue_refused" },
    });
    const attempt = DeviceState.prParkingSchema().parse(
      JSON.parse(device.pullRequestRow("other")?.parking ?? "null"),
    ).queueAttempt;
    device.answer((args) => {
      if (requestKind(args) !== "merge_queue")
        return succeeded(pullRequestBody({ head, queueEnabled: true }));
      if (verification === "lost") return uncertain("Still lost.");
      const body = pullRequestBody({
        head: verification === "changed-head" ? "changed" : head,
        state: verification === "closed" ? "CLOSED" : verification === "merged" ? "MERGED" : "OPEN",
        queueEnabled: true,
        queueEntry: verification === "member" ? "Q7" : null,
      });
      return succeeded(
        verification === "partial"
          ? { ...body, errors: [{ message: "Partial observation." }] }
          : body,
      );
    });
    await merge(input);
    expect(
      DeviceState.prParkingSchema().parse(
        JSON.parse(device.pullRequestRow("other")?.parking ?? "null"),
      ),
    ).toMatchObject({
      queueHead: head,
      queueAttempt: attempt,
    });
    expect(device.calls.filter((args) => requestKind(args) === "enqueue")).toHaveLength(1);
  },
);

test.each(["absent", "lost", "defect"] as const)(
  "initial external membership without a local receipt survives later %s without enqueue",
  async (later) => {
    const { device, input, head } = await owner(null, undefined, true);
    await using _ = device;
    const cause = new TypeError("Queue facts failed.");
    device.answer((args) => {
      const kind = requestKind(args);
      if (kind === "merge_queue") {
        if (later === "lost") return uncertain("Queue facts lost.");
        if (later === "defect") return Promise.reject(cause);
      }
      if (kind === "enqueue")
        return succeeded({ data: { enqueuePullRequest: { mergeQueueEntry: { id: "Q_NEW" } } } });
      return succeeded(
        pullRequestBody({
          head,
          queueEnabled: true,
          queueEntry: kind === "pull_request" ? "Q_EXTERNAL" : null,
        }),
      );
    });
    const result = await merge(input);
    const accepted = DeviceState.prParkingSchema().parse(
      JSON.parse(device.pullRequestRow("other")?.parking ?? "null"),
    );
    if (later === "lost")
      expect(result).toMatchObject({ tag: "Err", error: { reason: "github_uncertain" } });
    if (later === "defect") {
      expect(result.tag).toBe("Defect");
      if (result.tag === "Defect") expect(result.cause).toBe(cause);
    }
    device.answer(() => succeeded(pullRequestBody({ head, queueEnabled: true })));
    await merge(input);
    await merge(input);
    expect(accepted).toMatchObject({
      queueHead: head,
      queueAttempt: null,
      queueConfirmed: true,
      queueObservation: { head, entry: "Q_EXTERNAL" },
    });
    expect(
      DeviceState.prParkingSchema().parse(
        JSON.parse(device.pullRequestRow("other")?.parking ?? "null"),
      ),
    ).toMatchObject({
      queueHead: head,
      queueAttempt: null,
      queueConfirmed: true,
      queueObservation: { head, entry: "Q_EXTERNAL" },
    });
    expect(device.pullRequestRow("other")).toMatchObject({
      sourceId: device.sourceId,
      assignment: "other",
    });
    expect(device.calls.filter((args) => requestKind(args) === "enqueue")).toHaveLength(0);
    expect(device.calls.some((args) => args.includes("PUT"))).toBe(false);
  },
);

test("external membership reports batch observation rather than a local enqueue", async () => {
  const { device, input, head } = await owner(null, undefined, true);
  await using _ = device;
  device.answer(() =>
    succeeded(pullRequestBody({ head, queueEnabled: true, queueEntry: "Q_EXTERNAL" })),
  );
  expect(await merge(input)).toMatchObject({
    tag: "Ok",
    value: { reason: "pr_merge_awaiting_batch" },
  });
  expect(
    DeviceState.prParkingSchema().parse(
      JSON.parse(device.pullRequestRow("other")?.parking ?? "null"),
    ),
  ).toMatchObject({
    queueHead: head,
    queueAttempt: null,
    queueObservation: { head, entry: "Q_EXTERNAL" },
  });
  expect(device.calls.filter((args) => requestKind(args) === "enqueue")).toHaveLength(0);
});

test.each([
  ["pull_request", "err"],
  ["pull_request", "defect"],
  ["merge_queue", "err"],
  ["merge_queue", "defect"],
] as const)(
  "external membership from %s persistence %s stops before another read or admission",
  async (membershipRead, failure) => {
    const { device, input, head } = await owner(null, undefined, true);
    await using _ = device;
    const before = device.pullRequestRow("other");
    const cause = new TypeError("External membership persistence failed.");
    const defect = await fromPromise(
      () => Promise.reject(cause),
      (_cause, unexpected) => unexpected(cause),
    );
    const refusal = {
      reason: "pr_resume_refused" as const,
      detail: "Observation write refused.",
      next: { command: "operator next", why: "Read the owner." },
    };
    spyOn(DeviceState, "recordPullRequestQueueObservation").mockReturnValue(
      failure === "err"
        ? Err(refusal)
        : defect.map(() => ({
            launchId: "unused",
            head,
            at: "unused",
            note: null,
            state: "active" as const,
            events: [],
            parentSeen: false,
          })),
    );
    device.answer((args) =>
      succeeded(
        pullRequestBody({
          head,
          queueEnabled: true,
          queueEntry: requestKind(args) === membershipRead ? "Q_EXTERNAL" : null,
        }),
      ),
    );
    const result = await merge(input);
    if (failure === "err") expect(result).toMatchObject({ tag: "Err", error: refusal });
    else {
      expect(result.tag).toBe("Defect");
      if (result.tag === "Defect") expect(result.cause).toBe(cause);
    }
    expect(device.calls.map(requestKind)).toEqual(
      membershipRead === "pull_request" ? ["pull_request"] : ["pull_request", "merge_queue"],
    );
    expect(device.pullRequestRow("other")).toEqual(before);
  },
);

test("initial external membership at a different head creates no receipt or effect", async () => {
  const { device, input } = await owner(null, undefined, true);
  await using _ = device;
  const before = device.pullRequestRow("other");
  const write = spyOn(DeviceState, "recordPullRequestQueueObservation");
  device.answer(() =>
    succeeded(pullRequestBody({ head: "other", queueEnabled: true, queueEntry: "Q_OTHER" })),
  );
  expect(await merge(input)).toMatchObject({ tag: "Err", error: { reason: "pr_head_mismatch" } });
  expect(write).not.toHaveBeenCalled();
  expect(device.calls.map(requestKind)).toEqual(["pull_request"]);
  expect(device.pullRequestRow("other")).toEqual(before);
});

async function pendingQueueRefusal() {
  const fixture = await owner(null, undefined, true);
  const { device, input, head } = fixture;
  spyOn(process.stderr, "write").mockImplementation(() => true);
  let submitted = false;
  device.answer((args) => {
    if (requestKind(args) === "enqueue") {
      submitted = true;
      return succeeded({
        data: { enqueuePullRequest: null },
        errors: [
          { type: "UNPROCESSABLE", path: ["enqueuePullRequest"], message: "Typed refusal." },
        ],
      });
    }
    return submitted && requestKind(args) === "merge_queue"
      ? uncertain("First verification lost.")
      : succeeded(pullRequestBody({ head, queueEnabled: true }));
  });
  expect(await merge(input)).toMatchObject({ tag: "Err", error: { reason: "pr_enqueue_refused" } });
  function parking() {
    return DeviceState.prParkingSchema().parse(
      JSON.parse(device.pullRequestRow("other")?.parking ?? "null"),
    );
  }
  expect(parking().queueRefusal).toMatchObject({ head, attempt: parking().queueAttempt });
  return { ...fixture, parking };
}

test("external first queue membership records observation, not submission identity, before a lost second read", async () => {
  const { device, input, head } = await owner(null, undefined, true);
  await using _ = device;
  let queueReads = 0;
  device.answer((args) => {
    if (requestKind(args) === "merge_queue" && ++queueReads > 1)
      return uncertain("Second membership read lost.");
    return succeeded(
      pullRequestBody({
        head,
        queueEnabled: true,
        queueEntry: requestKind(args) === "merge_queue" ? "Q7" : null,
      }),
    );
  });
  expect(await merge(input)).toMatchObject({ tag: "Err", error: { reason: "github_uncertain" } });
  const accepted = DeviceState.prParkingSchema().parse(
    JSON.parse(device.pullRequestRow("other")?.parking ?? "null"),
  );
  expect(accepted).toMatchObject({
    queueHead: head,
    queueConfirmed: true,
    queueRefusal: null,
  });
  expect(accepted.queueAttempt).toBeNull();
  expect(accepted.queueObservation).toEqual({ head, entry: "Q7" });
  device.answer(() => succeeded(pullRequestBody({ head, queueEnabled: true })));
  await merge(input);
  expect(device.calls.filter((args) => requestKind(args) === "enqueue")).toHaveLength(0);
  expect(
    DeviceState.prParkingSchema().parse(
      JSON.parse(device.pullRequestRow("other")?.parking ?? "null"),
    ),
  ).toMatchObject({ queueHead: head, queueAttempt: accepted.queueAttempt, queueConfirmed: true });
});

test.each([
  ["pull_request", "absent"],
  ["pull_request", "lost"],
  ["pull_request", "defect"],
  ["merge_queue", "absent"],
  ["merge_queue", "lost"],
  ["merge_queue", "defect"],
] as const)(
  "membership in %s persists before a later %s read can release the attempt",
  async (membershipRead, laterRead) => {
    const { device, input, head, parking } = await pendingQueueRefusal();
    await using _ = device;
    const attempt = parking().queueAttempt;
    const cause = new TypeError("Later membership read failed.");
    let queueReads = 0;
    device.answer((args) => {
      const kind = requestKind(args);
      if (kind === "merge_queue") queueReads++;
      const member =
        membershipRead === "pull_request"
          ? kind === "pull_request"
          : kind === "merge_queue" && queueReads === 1;
      if (kind === "merge_queue" && !member) {
        if (laterRead === "lost") return uncertain("Later membership read lost.");
        if (laterRead === "defect") return Promise.reject(cause);
      }
      return succeeded(
        pullRequestBody({ head, queueEnabled: true, queueEntry: member ? "Q7" : null }),
      );
    });
    const result = await merge(input);
    const accepted = parking();
    if (laterRead === "defect") {
      expect(result.tag).toBe("Defect");
      if (result.tag === "Defect") expect(result.cause).toBe(cause);
    }
    if (laterRead === "lost")
      expect(result).toMatchObject({ tag: "Err", error: { reason: "github_uncertain" } });
    device.answer(() => succeeded(pullRequestBody({ head, queueEnabled: true })));
    await merge(input);
    await merge(input);
    expect(accepted).toMatchObject({
      queueHead: head,
      queueAttempt: attempt,
      queueConfirmed: true,
      queueRefusal: null,
    });
    expect(parking()).toMatchObject({
      queueHead: head,
      queueAttempt: attempt,
      queueConfirmed: true,
      queueRefusal: null,
    });
    expect(device.pullRequestRow("other")).toMatchObject({
      sourceId: device.sourceId,
      assignment: "other",
    });
    expect(assignmentState(device)).toBe("pr-open");
    expect(device.calls.filter((args) => requestKind(args) === "enqueue")).toHaveLength(1);
  },
);

test.each([
  ["pull_request", "err"],
  ["pull_request", "defect"],
  ["merge_queue", "err"],
  ["merge_queue", "defect"],
] as const)(
  "failed %s membership persistence stops before another read or admission: %s",
  async (membershipRead, failure) => {
    const { device, input, head, parking } = await pendingQueueRefusal();
    await using _ = device;
    const before = parking();
    const cause = new TypeError("Membership persistence failed.");
    const defect = await fromPromise(
      () => Promise.reject(cause),
      (_cause, unexpected) => unexpected(cause),
    );
    const refusal = {
      reason: "pr_resume_refused" as const,
      detail: "Membership persistence refused.",
      next: { command: "operator next", why: "Read the owner." },
    };
    spyOn(DeviceState, "refusePullRequestQueue").mockReturnValue(
      failure === "err" ? Err(refusal) : defect.map(() => false),
    );
    const start = device.calls.length;
    device.answer((args) =>
      succeeded(
        pullRequestBody({
          head,
          queueEnabled: true,
          queueEntry: requestKind(args) === membershipRead ? "Q7" : null,
        }),
      ),
    );
    const result = await merge(input);
    if (failure === "err") expect(result).toMatchObject({ tag: "Err", error: refusal });
    else {
      expect(result.tag).toBe("Defect");
      if (result.tag === "Defect") expect(result.cause).toBe(cause);
    }
    expect(device.calls.slice(start).map(requestKind)).toEqual(
      membershipRead === "pull_request" ? ["pull_request"] : ["pull_request", "merge_queue"],
    );
    expect(parking()).toEqual(before);
  },
);

test.each(["err", "defect"] as const)(
  "final membership persistence failure cannot report enqueue success: %s",
  async (failure) => {
    const { device, input, head } = await owner(null, undefined, true);
    await using _ = device;
    const cause = new TypeError("Final membership persistence failed.");
    const defect = await fromPromise(
      () => Promise.reject(cause),
      (_cause, unexpected) => unexpected(cause),
    );
    const refusal = {
      reason: "pr_resume_refused" as const,
      detail: "Final membership persistence refused.",
      next: { command: "operator next", why: "Read the owner." },
    };
    spyOn(DeviceState, "refusePullRequestQueue").mockReturnValue(
      failure === "err" ? Err(refusal) : defect.map(() => false),
    );
    let submitted = false;
    device.answer((args) => {
      if (requestKind(args) === "enqueue") {
        submitted = true;
        return succeeded({ data: { enqueuePullRequest: { mergeQueueEntry: { id: "Q7" } } } });
      }
      return succeeded(
        pullRequestBody({ head, queueEnabled: true, queueEntry: submitted ? "Q7" : null }),
      );
    });
    const result = await merge(input);
    if (failure === "err") expect(result).toMatchObject({ tag: "Err", error: refusal });
    else {
      expect(result.tag).toBe("Defect");
      if (result.tag === "Defect") expect(result.cause).toBe(cause);
    }
    device.answer(() => succeeded(pullRequestBody({ head, queueEnabled: true })));
    await merge(input);
    expect(device.calls.filter((args) => requestKind(args) === "enqueue")).toHaveLength(1);
  },
);

test.each(["record", "release"] as const)(
  "a queue refusal retains its primary Err through a %s Defect",
  async (failure) => {
    const { device, input, head } = await owner(null, undefined, true);
    await using _ = device;
    const cause = new TypeError(`Secondary ${failure} failure.`);
    const defect = await fromPromise(
      () => Promise.reject(cause),
      (_cause, unexpected) => unexpected(cause),
    );
    const log = spyOn(process.stderr, "write").mockImplementation(() => true);
    if (failure === "record")
      spyOn(DeviceState, "recordPullRequestQueueRefusal").mockReturnValue(
        defect.map(() => undefined),
      );
    else spyOn(DeviceState, "refusePullRequestQueue").mockReturnValue(defect.map(() => false));
    device.answer((args) =>
      requestKind(args) === "enqueue"
        ? succeeded({
            data: { enqueuePullRequest: null },
            errors: [
              { type: "UNPROCESSABLE", path: ["enqueuePullRequest"], message: "Primary refusal." },
            ],
          })
        : succeeded(pullRequestBody({ head, queueEnabled: true })),
    );
    expect(await merge(input)).toMatchObject({
      tag: "Err",
      error: { reason: "pr_enqueue_refused", detail: "Primary refusal." },
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining(cause.message));
    expect(
      DeviceState.prParkingSchema().parse(
        JSON.parse(device.pullRequestRow("other")?.parking ?? "null"),
      ).queueHead,
    ).toBe(head);
  },
);

test.each([
  uncertain("lost response"),
  failed("generic API failure"),
  succeeded({ data: null, errors: [{ message: "Internal server error" }] }),
  succeeded({
    data: { enqueuePullRequest: { mergeQueueEntry: { id: "Q7" } } },
    errors: [{ type: "UNPROCESSABLE", message: "Partial response failure" }],
  }),
])("ambiguous enqueue answers retain the receipt despite absent membership: %j", async (answer) => {
  const { device, input, head } = await owner(null, undefined, true);
  await using _ = device;
  device.answer((args) =>
    requestKind(args) === "enqueue"
      ? answer
      : succeeded(pullRequestBody({ head, queueEnabled: true })),
  );
  expect((await merge(input)).tag).toBe("Err");
  const receipt = DeviceState.prParkingSchema().parse(
    JSON.parse(device.pullRequestRow("other")?.parking ?? "null"),
  );
  expect(receipt).toMatchObject({ queueHead: head });
  expect(await merge(input)).toMatchObject({
    tag: "Ok",
    value: { reason: "pr_merge_awaiting_batch" },
  });
  expect(device.calls.filter((args) => requestKind(args) === "enqueue")).toHaveLength(1);
  expect(
    DeviceState.prParkingSchema().parse(
      JSON.parse(device.pullRequestRow("other")?.parking ?? "null"),
    ).queueHead,
  ).toBe(head);
});

test.each([false, true])(
  "an enqueue Defect keeps its cause when verification fails: %s",
  async (fails) => {
    const { device, input, head } = await owner(null, undefined, true);
    await using _ = device;
    const cause = new TypeError("original enqueue defect");
    const secondary = new TypeError("secondary membership defect");
    const log = spyOn(process.stderr, "write").mockImplementation(() => true);
    let requested = false;
    device.answer((args) => {
      if (requestKind(args) === "enqueue") {
        requested = true;
        return Promise.reject(cause);
      }
      if (requested && requestKind(args) === "merge_queue" && fails)
        return Promise.reject(secondary);
      return succeeded(
        pullRequestBody({ head, queueEnabled: true, queueEntry: requested ? "Q7" : null }),
      );
    });
    const result = await merge(input);
    expect(result.tag).toBe("Defect");
    if (result.tag === "Defect") expect(result.cause).toBe(cause);
    if (fails) expect(log).toHaveBeenCalledWith(expect.stringContaining(secondary.message));
    expect(assignmentState(device)).toBe("pr-open");
  },
);

test("a lost enqueue and failed membership read retain batch completion on a later retry", async () => {
  const { device, input, head, detach } = await owner(null, undefined, true);
  await using _ = device;
  let requested = false;
  device.answer((args) => {
    if (requestKind(args) === "enqueue") {
      requested = true;
      return uncertain("Lost enqueue");
    }
    if (requested && requestKind(args) === "merge_queue") return uncertain("Lost verification");
    return succeeded(pullRequestBody({ head, queueEnabled: true }));
  });
  expect(await merge(input)).toMatchObject({ tag: "Err", error: { reason: "github_uncertain" } });
  expect(detach).not.toHaveBeenCalled();
  device.answer(() =>
    succeeded(pullRequestBody({ head, queueEnabled: false, state: "MERGED", mergeCommit: "m1" })),
  );
  expect(await merge(input)).toMatchObject({
    tag: "Ok",
    value: { reason: "pr_merge_awaiting_batch" },
  });
  expect(device.pullRequestRow("other")?.mergedAt).toBeNull();
  expect(assignmentState(device)).toBe("pr-open");
  expect(JSON.parse(device.pullRequestRow("other")?.parking ?? "null")).toMatchObject({
    queueHead: head,
    state: "parking",
  });
});

test("a changed queue head refuses before enqueue and leaves work intact", async () => {
  const { device, input, head, detach } = await owner(null, undefined, true);
  await using _ = device;
  device.answer((args) =>
    succeeded(
      pullRequestBody({
        head: requestKind(args) === "merge_queue" ? "changed" : head,
        queueEnabled: true,
      }),
    ),
  );
  expect<unknown>(await merge(input)).toMatchObject({
    tag: "Err",
    error: { reason: "pr_head_mismatch", state: { expectedHead: head, observedHead: "changed" } },
  });
  expect(device.calls.map(requestKind)).toEqual(["pull_request", "merge_queue"]);
  expect(assignmentState(device)).toBe("pr-open");
  expect(detach).not.toHaveBeenCalled();
});

test("unknown queue policy never falls back to a direct merge", async () => {
  const { device, input, head, detach } = await owner(null, undefined, true);
  await using _ = device;
  const before = device.pullRequestRow("other");
  for (const answer of [
    failed("No queue policy"),
    uncertain("Policy read timed out"),
    succeeded({ data: null }),
  ]) {
    device.answer((args) =>
      requestKind(args) === "merge_queue" ? answer : succeeded(pullRequestBody({ head })),
    );
    expect((await merge(input)).tag).toBe("Err");
  }
  expect(device.calls.map(requestKind)).toEqual([
    "pull_request",
    "merge_queue",
    "pull_request",
    "merge_queue",
    "pull_request",
    "merge_queue",
  ]);
  expect(device.pullRequestRow("other")).toEqual(before);
  expect(detach).not.toHaveBeenCalled();
});

test("a typed merge owner without a ready frontier refuses without side effects", async () => {
  const { device, head, input, detach } = await owner(null, undefined, true, false);
  await using _ = device;
  device.answer(() => succeeded(pullRequestBody({ head })));
  expect<unknown>(await merge(input)).toMatchObject({
    tag: "Err",
    error: {
      reason: "pr_merge_blocked",
      conditions: { reviewEnded: false },
      state: { conditions: { reviewEnded: false } },
    },
  });
  expect(device.calls.map(requestKind)).toEqual(["pull_request"]);
  expect(detach).not.toHaveBeenCalled();
  expect(assignmentState(device)).toBe("pr-open");
});

test.each(["ready", "skipped"] as const)(
  "a typed %s review frontier still requires a fresh gate before merging",
  async (reviewState) => {
    const { device, head, input, detach } = await owner(null, undefined, true, true, reviewState);
    await using _ = device;
    device.answer(() => succeeded(pullRequestBody({ head, approved: false })));
    expect<unknown>(await merge(input)).toMatchObject({
      tag: "Err",
      error: { reason: "pr_merge_blocked" },
    });
    expect(device.calls.map(requestKind)).toEqual(["pull_request"]);
    expect(detach).not.toHaveBeenCalled();
    let landed = false;
    device.answer((args) => {
      if (requestKind(args) === "merge") {
        landed = true;
        return mergeRequest("merged");
      }
      return succeeded(
        pullRequestBody(landed ? { state: "MERGED", head, mergeCommit: "m1" } : { head }),
      );
    });
    expect<unknown>(await merge(input)).toMatchObject({
      tag: "Ok",
      value: { reason: "pr_merged" },
    });
    expect(device.calls.map(requestKind)).toEqual([
      "pull_request",
      "pull_request",
      "merge_queue",
      "merge",
      "pull_request",
    ]);
    expect(detach).toHaveBeenCalledTimes(1);
  },
);

test("a typed already merged owner verifies and starts cleanup even with hidden untracked work", async () => {
  const { device, input, worktree, detach } = await owner(null, undefined, true);
  await using _ = device;
  git(worktree, "config", "status.showUntrackedFiles", "no");
  await Bun.write(`${worktree}/pending.txt`, "Keep.");
  device.answer(() =>
    succeeded(pullRequestBody({ state: "MERGED", head: "landed", mergeCommit: "m2" })),
  );
  expect<unknown>(await merge(input)).toMatchObject({ tag: "Ok", value: { reason: "pr_merged" } });
  expect(device.calls.map(requestKind)).toEqual(["pull_request", "pull_request"]);
  expect(detach).toHaveBeenCalledTimes(1);
  expect(await Bun.file(`${worktree}/pending.txt`).text()).toBe("Keep.");
});

function assignmentState(device: Awaited<ReturnType<typeof prDevice>>) {
  const owners = DeviceState.worktreeOwners(device.paths);
  return owners.tag === "Ok"
    ? owners.value.find((row) => row.assignment === "other")?.assignmentState
    : null;
}

function cleanupClaim(device: Awaited<ReturnType<typeof prDevice>>) {
  return DeviceState.claimCleanup(device.paths, repository, device.sourceId, "other");
}

function merged(head: string, mergeCommit = "m1") {
  return {
    sourceId: expect.any(String) as unknown,
    assignment: "other",
    branch: "task/other",
    number: 7,
    head,
    mergeCommit,
    state: "merged",
    cleanup: "started",
  };
}

test("an eligible PR at the worktree head merges once and starts its cleanup", async () => {
  const { device, head, detach, sleep, input } = await owner();
  await using _ = device;
  let landed = false;
  device.answer((args) => {
    const kind = requestKind(args);
    if (kind === "merge") return mergeRequest("pending", "u1");
    if (kind === "merge_read") {
      landed = true;
      return mergeRequest("merged");
    }
    return succeeded(
      pullRequestBody(landed ? { state: "MERGED", head, mergeCommit: "m1" } : { head }),
    );
  });
  expect<unknown>(await merge(input)).toEqual({
    tag: "Ok",
    value: { reason: "pr_merged", data: { ...merged(head), sourceId: device.sourceId } },
  });
  expect(device.calls.map(requestKind)).toEqual([
    "pull_request",
    "merge_queue",
    "merge",
    "merge_read",
    "pull_request",
  ]);
  expect(device.calls[2]).toEqual([
    "-X",
    "PUT",
    `repos/${repository}/pulls/7/merge-async`,
    "-f",
    `sha=${head}`,
    "-f",
    "merge_method=squash",
    "-f",
    "merge_action=direct_merge",
  ]);
  expect(device.calls[3]).toEqual([`repos/${repository}/pulls/7/merge-async/u1`]);
  expect(sleep.mock.calls).toEqual([[1000]]);
  expect(detach.mock.calls).toEqual([
    [
      {
        tool: process.execPath,
        args: [cli, "cleanup", "--source", device.sourceId, "--assignment", "other", "--json"],
        cwd: device.checkout,
      },
    ],
  ]);
  expect(assignmentState(device)).toBe("merged");
  expect<unknown>(cleanupClaim(device)).toMatchObject({
    tag: "Err",
    error: {
      reason: "cleanup_running",
      detail: expect.stringContaining(`${process.ppid}`) as unknown,
    },
  });
});

test("a PR that GitHub already merged is verified and recorded without a merge request", async () => {
  const { device, head, input } = await owner();
  await using _ = device;
  device.answer(() =>
    succeeded(pullRequestBody({ state: "MERGED", head: "landed", mergeCommit: "m2" })),
  );
  expect<unknown>(await merge(input)).toEqual({
    tag: "Ok",
    value: { reason: "pr_merged", data: merged("landed", "m2") },
  });
  expect(device.calls.map(requestKind)).toEqual(["pull_request", "pull_request"]);
  expect(head).not.toBe("landed");
  expect(assignmentState(device)).toBe("merged");
});

test("a merged PR without a merge commit is not recorded", async () => {
  const { device, detach, input } = await owner();
  await using _ = device;
  device.answer(() => succeeded(pullRequestBody({ state: "MERGED", head: "landed" })));
  expect<unknown>(await merge(input)).toEqual({
    tag: "Err",
    error: {
      reason: "pr_merge_unverified",
      detail:
        "GitHub does not report PR #7 merged at landed. Nothing was recorded. Repeat operator pr merge.",
      next: verifyRecovery,
      state: {
        pullRequest: 7,
        expectedHead: null,
        observedState: "MERGED",
        observedHead: "landed",
      },
    },
  });
  expect(detach).not.toHaveBeenCalled();
  expect(assignmentState(device)).toBe("pr-open");
});

test("an owner without a recorded PR reads nothing from GitHub", async () => {
  await using device = await prDevice();
  const { worktree } = device.start("other");
  expect<unknown>(await merge({ paths: device.paths, cwd: worktree })).toEqual({
    tag: "Err",
    error: {
      reason: "pr_not_associated",
      detail: "Run operator pr associate after you open the PR. Nothing was merged or changed.",
      next: {
        command: "operator pr associate",
        why: "Associate the assignment's open PR before merging.",
      },
      state: { pullRequest: null },
    },
  });
  expect(device.calls).toEqual([]);
});

test("a refused gate sends no merge request and writes nothing", async () => {
  const { device, head, detach, input } = await owner();
  await using _ = device;
  const nothing = "Nothing was merged or changed.";
  for (const [facts, error] of [
    [
      { state: "CLOSED", head },
      {
        reason: "pr_not_open",
        detail: `The PR is closed without a merge. Ask the SuperAgent. ${nothing}`,
        result: "refused",
        conditions: passingConditions,
        next: {
          decider: "super-agent",
          question: "How should the closed PR assignment be resolved?",
        },
        state: { pullRequest: "CLOSED" },
      },
    ],
    [
      { head, approved: false },
      {
        reason: "pr_merge_blocked",
        detail: `The PR needs an approving review decision. ${nothing}`,
        result: "refused",
        conditions: { ...passingConditions, approved: false },
        next: {
          command: "operator pr wait",
          why: `The PR needs an approving review decision. ${nothing}`,
        },
        state: { conditions: { ...passingConditions, approved: false } },
      },
    ],
    [
      { head: "elsewhere" },
      {
        reason: "pr_head_mismatch",
        detail: `The PR head is elsewhere, but the worktree is at ${head}. Push or reconcile first. ${nothing}`,
        result: "refused",
        conditions: passingConditions,
        next: {
          decider: "super-agent",
          question: "How should the worktree and PR heads be reconciled without losing commits?",
        },
        state: { localHead: head, prHead: "elsewhere" },
      },
    ],
  ] as const) {
    device.answer(() => succeeded(pullRequestBody(facts)));
    expect<unknown>(await merge(input)).toEqual({ tag: "Err", error });
  }
  expect(device.calls.map(requestKind)).toEqual(["pull_request", "pull_request", "pull_request"]);
  expect(detach).not.toHaveBeenCalled();
  expect(assignmentState(device)).toBe("pr-open");
});

test("a worktree whose head Git cannot read never merges", async () => {
  const { device, input } = await owner();
  await using _ = device;
  device.answer(() => succeeded(pullRequestBody()));
  const run = ToolInvocation.run;
  const answers = [
    { status: "completed" as const, exitCode: 128, stdout: "h1\n", stderr: "fatal" },
    { status: "no-answer" as const, detail: "git ended" },
  ];
  for (const answer of answers) {
    spyOn(ToolInvocation, "run").mockImplementation(async (request) =>
      request.args[0] === "-C" ? answer : run(request),
    );
    expect<unknown>(await merge(input)).toMatchObject({
      tag: "Err",
      error: {
        reason: "pr_head_mismatch",
        detail: expect.stringContaining("but the worktree is at no commit.") as unknown,
      },
    });
  }
});

test("a stacked PR merges only after its relay finished", async () => {
  const relay = stacked(parent);
  const blocked = await owner(JSON.stringify(relay));
  await using _ = blocked.device;
  blocked.device.answer(() => succeeded(pullRequestBody({ head: blocked.head })));
  expect<unknown>(await merge(blocked.input)).toEqual({
    tag: "Err",
    error: {
      reason: "pr_merge_blocked",
      detail: "The PR needs a finished parent-merge relay. Nothing was merged or changed.",
      result: "refused",
      conditions: { ...passingConditions, stackRelayed: false },
      next: {
        command: "operator pr wait",
        why: "The PR needs a finished parent-merge relay. Nothing was merged or changed.",
      },
      state: { conditions: { ...passingConditions, stackRelayed: false } },
    },
  });
  mock.restore();
  const relayed = await owner(JSON.stringify({ ...relay, state: "relayed" }));
  await using __ = relayed.device;
  let landed = false;
  relayed.device.answer((args) => {
    if (requestKind(args) === "merge") {
      landed = true;
      return mergeRequest("merged");
    }
    return succeeded(
      pullRequestBody(
        landed
          ? { state: "MERGED", head: relayed.head, mergeCommit: "m1" }
          : { head: relayed.head },
      ),
    );
  });
  expect<unknown>(await merge(relayed.input)).toMatchObject({
    tag: "Ok",
    value: { reason: "pr_merged" },
  });
});

test("every merge answer is verified against GitHub's state", async () => {
  const cases = [
    {
      answer: failed("Head branch was modified"),
      error: {
        reason: "github_failed",
        detail: "github_refused: Head branch was modified",
        next: effectRecovery,
      },
    },
    {
      answer: uncertain("gh ended on SIGTERM"),
      error: { reason: "github_uncertain", detail: "gh ended on SIGTERM", next: effectRecovery },
    },
    {
      answer: mergeRequest("merged"),
      error: {
        reason: "pr_merge_unverified",
      },
    },
    {
      answer: mergeRequest("failed"),
      error: { reason: "pr_merge_refused", detail: "Request failed.", next: refusedRecovery },
    },
    {
      answer: mergeRequest("enqueued"),
      error: {
        reason: "pr_merge_unverified",
        detail:
          "GitHub put the PR in a merge queue: Request enqueued. Nothing was recorded. Repeat operator pr merge after it merges.",
        next: {
          command: "operator pr merge",
          why: "Verify the queued merge after GitHub reports it merged.",
        },
        state: { mergeRequest: "enqueued" },
      },
    },
    {
      answer: succeeded({ merged: true }),
      error: {
        reason: "github_uncertain",
        detail: "GitHub did not describe the merge request in the expected form.",
        next: effectRecovery,
      },
    },
  ];
  for (const { answer, error } of cases) {
    const { device, head, input } = await owner();
    await using _ = device;
    device.calls.length = 0;
    device.answer((args) =>
      requestKind(args) === "merge" ? answer : succeeded(pullRequestBody({ head })),
    );
    expect<unknown>(await merge(input)).toMatchObject({ tag: "Err", error });
  }
  // A merge of a newer head is not the guarded merge.
  const { device, head, input } = await owner();
  await using _ = device;
  device.answer((args) =>
    requestKind(args) === "merge"
      ? mergeRequest("merged")
      : succeeded(
          pullRequestBody(
            device.calls.length > 1
              ? { state: "MERGED", head: "newer", mergeCommit: "m3" }
              : { head },
          ),
        ),
  );
  device.calls.length = 0;
  expect<unknown>(await merge(input)).toMatchObject({
    tag: "Err",
    error: { reason: "pr_merge_unverified" },
  });
  expect(assignmentState(device)).toBe("pr-open");
});

test("a background merge is read until it ends, and pr_merged waits for GitHub's merged PR", async () => {
  const { device, head, input } = await owner();
  await using _ = device;
  device.answer((args) => {
    const kind = requestKind(args);
    return kind === "merge" || kind === "merge_read"
      ? mergeRequest("pending", "u1")
      : succeeded(pullRequestBody({ head }));
  });
  expect<unknown>(await merge(input)).toEqual({
    tag: "Err",
    error: {
      reason: "pr_merge_unverified",
      detail:
        "GitHub still runs the merge request: Request pending. Nothing was recorded. Repeat operator pr merge.",
      next: {
        command: "operator pr merge",
        why: "Verify whether the background merge request landed.",
      },
      state: { mergeRequest: "pending" },
    },
  });
  expect(device.calls.filter((args) => requestKind(args) === "merge_read")).toHaveLength(120);
  expect(assignmentState(device)).toBe("pr-open");

  // A read that GitHub refuses or loses ends the reads, and the PR state still decides.
  for (const [read, error] of [
    [
      failed("Not Found", 404),
      {
        reason: "github_failed",
        detail: "github_refused: Not Found",
        next: effectRecovery,
      },
    ],
    [
      uncertain("gh ended on SIGTERM"),
      { reason: "github_uncertain", detail: "gh ended on SIGTERM", next: effectRecovery },
    ],
  ] as const) {
    device.calls.length = 0;
    device.answer((args) => {
      const kind = requestKind(args);
      if (kind === "merge") return mergeRequest("pending", "u1");
      return kind === "merge_read" ? read : succeeded(pullRequestBody({ head }));
    });
    expect<unknown>(await merge(input)).toEqual({ tag: "Err", error });
    expect(device.calls.map(requestKind)).toEqual(["merge_read", "pull_request"]);
  }

  // A request that GitHub already runs for this PR is not a refusal, and the PR state decides.
  device.calls.length = 0;
  device.answer((args) =>
    requestKind(args) === "merge_read"
      ? mergeRequest("failed", "u1")
      : succeeded(pullRequestBody({ head })),
  );
  expect<unknown>(await merge(input)).toEqual({
    tag: "Err",
    error: {
      reason: "pr_merge_refused",
      detail: "Request failed.",
      next: refusedRecovery,
    },
  });
  expect(device.calls.map(requestKind)).toEqual(["merge_read", "pull_request"]);
  expect(assignmentState(device)).toBe("pr-open");
});

test("a refused or lost merge answer still records a merge that landed", async () => {
  const { device, head, input } = await owner();
  await using _ = device;
  let landed = false;
  device.answer((args) => {
    if (requestKind(args) === "merge") {
      landed = true;
      return uncertain("gh ended on SIGTERM");
    }
    return succeeded(
      pullRequestBody(landed ? { state: "MERGED", head, mergeCommit: "m1" } : { head }),
    );
  });
  expect<unknown>(await merge(input)).toMatchObject({ tag: "Ok", value: { reason: "pr_merged" } });
});

test("a merge request that throws retains the original defect", async () => {
  const { device, head, input } = await owner();
  await using _ = device;
  const call = device.answer;
  const cause = new Error("boom");
  call((args) => {
    if (requestKind(args) === "merge") return Promise.reject(cause);
    return succeeded(pullRequestBody({ head }));
  });
  expect<unknown>(await merge(input)).toEqual({
    tag: "Defect",
    cause,
  });
});

test("a cleanup that cannot start fails after the merge is recorded", async () => {
  const { device, head, detach, input } = await owner();
  await using _ = device;
  device.answer(() => succeeded(pullRequestBody({ state: "MERGED", head, mergeCommit: "m1" })));
  detach.mockImplementation(() => {
    // oxlint-disable-next-line unthrown/no-throw -- The detached start throws like a failed spawn.
    throw Object.assign(new Error("ENOENT: no bun"), { code: "ENOENT" });
  });
  expect<unknown>(await merge(input)).toEqual({
    tag: "Err",
    error: {
      reason: "pr_io_failed",
      detail: "Error: ENOENT: no bun",
      next: {
        decider: "super-agent",
        question: "How should the PR worktree IO failure be corrected without losing work?",
      },
      state: { code: "ENOENT" },
    },
  });
  expect(assignmentState(device)).toBe("merged");
});

test("the merge of the last open assignment finishes its source", async () => {
  const { device, head, input } = await owner(null, ["other"]);
  await using _ = device;
  device.answer(() => succeeded(pullRequestBody({ state: "MERGED", head, mergeCommit: "m1" })));
  expect<unknown>(await merge(input)).toMatchObject({ tag: "Ok", value: { reason: "pr_merged" } });
  expect<unknown>(DeviceState.readSources(device.paths, repository, device.sourceId)).toMatchObject(
    {
      tag: "Ok",
      value: [{ source: { state: "finished" } }],
    },
  );
});

test("a merge that another process recorded first is unchanged", async () => {
  const { device, head, input } = await owner();
  await using _ = device;
  device.answer(() => succeeded(pullRequestBody({ state: "MERGED", head, mergeCommit: "m1" })));
  spyOn(DeviceState, "recordPullRequestMerge").mockReturnValue(Ok({ changed: false }));
  expect<unknown>(await merge(input)).toEqual({
    tag: "Ok",
    value: { reason: "pr_merge_unchanged", data: { ...merged(head), sourceId: device.sourceId } },
  });
});
