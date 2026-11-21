import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Ok } from "unthrown";
import { z } from "zod";
import { migrationsFolder } from "./database.ts";
import { insertRow } from "./state-fixture.ts";
import {
  changeStack,
  readStack,
  restartStackReview,
  beginStackReview,
  finishStack,
  recordStackBase,
} from "./stacks.ts";
import { startHandoff } from "./internal-reviews.ts";
import { recordPullRequestQueue } from "./pr-parking.ts";
import { admitDelivery, recordDeliveryValidation } from "./deliveries.ts";
import { WorkerKinds } from "../worker-kinds/main.ts";
import { PrStacks } from "../pr-stacks/main.ts";

function stackPlan(
  launchId = "reviewer",
  change: Partial<ReturnType<typeof PrStacks.operation>> = {},
) {
  return JSON.stringify({
    id: "operation",
    sourceId: "source",
    repository: "owner/repo",
    assignment: "child",
    launchId,
    previousOwners: launchId === "reviewer" ? [] : ["reviewer"],
    number: 8,
    branch: "task/child",
    head: "head",
    base: "task/parent",
    cut: "cut",
    remote: "origin",
    parents: [],
    target: "target",
    targetBranch: "task/parent",
    managed: false,
    retargetAttempted: false,
    pushAttempted: false,
    relayToMain: false,
    candidate: null,
    step: "planned",
    blocker: null,
    failures: [],
    ...change,
  });
}

function stackDevice() {
  const client = new Database(":memory:");
  migrate(drizzle(client), { migrationsFolder });
  insertRow(client, "projects", { repository: "owner/repo", checkout: "/main" });
  insertRow(client, "sources", {
    id: "source",
    repository: "owner/repo",
    state: "open",
    plan: JSON.stringify({ assignments: [{ key: "child", dependencies: [] }] }),
  });
  insertRow(client, "assignments", {
    source_id: "source",
    key: "child",
    completion: "pr",
    state: "pr-open",
  });
  for (const [id, attempt, state] of [
    ["implementer", 1, "finished"],
    ["reviewer", 2, "running"],
  ] as const)
    insertRow(client, "launches", {
      id,
      source_id: "source",
      assignment: "child",
      attempt,
      state,
      branch: "task/child",
      worktree_path: "/child",
    });
  insertRow(client, "pull_requests", {
    source_id: "source",
    assignment: "child",
    repository: "owner/repo",
    number: 8,
    branch: "task/child",
  });
  return client;
}

test("a changed stack archives an exhausted review and requires a genuinely fresh handoff", () => {
  using client = stackDevice();
  insertRow(client, "internal_reviews", {
    source_id: "source",
    assignment: "child",
    state: "ready",
    implementer_launch_id: "implementer",
    handoff_state: "done",
    ready_head: "old-head",
  });
  for (const number of [1, 2])
    insertRow(client, "internal_review_rounds", {
      source_id: "source",
      assignment: "child",
      number,
      launch_id: "reviewer",
      head: `old-${number}`,
      findings: "[]",
    });
  const created = changeStack(client, "reviewer", "operation", null, () =>
    Ok({ state: "planned", data: stackPlan(), ownerPid: process.pid }),
  );
  expect(created).toMatchObject({ tag: "Ok", value: { revision: 1 } });
  expect(beginStackReview(client, "reviewer", "operation", 1).tag).toBe("Err");
  const restarted = restartStackReview(client, "reviewer", "operation", 1);
  expect(restarted).toMatchObject({ tag: "Ok", value: { revision: 2 } });
  const current = client
    .query("SELECT state, implementer_launch_id, ready_head FROM internal_reviews")
    .get();
  expect(current).toEqual({
    state: "reviewing",
    implementer_launch_id: "reviewer",
    ready_head: null,
  });
  expect(client.query("SELECT number FROM internal_review_rounds").all()).toEqual([]);
  const stored = readStack(client, "reviewer", "operation");
  expect(stored.tag).toBe("Ok");
  if (stored.tag !== "Ok") return;
  const history = z
    .object({
      review: z.object({ readyHead: z.string() }),
      rounds: z.array(z.object({ head: z.string() })),
    })
    .parse(JSON.parse(stored.value.reviewHistory ?? "null"));
  expect(history.review.readyHead).toBe("old-head");
  expect(history.rounds.map((row: { head: string }) => row.head)).toEqual(["old-1", "old-2"]);
  expect(restartStackReview(client, "reviewer", "operation", 2)).toMatchObject({
    tag: "Ok",
    value: { revision: 2 },
  });
});

test.each(["known", "unknown"] as const)(
  "stack invalidation archives %s readiness bytes before clearing active authority",
  (origin) => {
    using client = stackDevice();
    const receipt =
      origin === "known"
        ? {
            head: "reviewed-head",
            at: "original-at",
            note: "/original-note",
            dispositions: [
              { round: 2, finding: 1, disposition: "declined", reason: "Not applicable." },
            ],
          }
        : {
            origin: "migration-0026",
            head: null,
            at: "migration-at",
            note: null,
            dispositions: [],
          };
    const raw = JSON.stringify(receipt, null, 2);
    const progress = '{"seen":["original-comment"],"failures":[],"eligibleHead":"reviewed-head"}';
    client.query("UPDATE pull_requests SET readiness = ?, progress = ?").run(raw, progress);
    expect(
      changeStack(client, "reviewer", "operation", null, () =>
        Ok({ state: "planned", data: stackPlan(), ownerPid: process.pid }),
      ).tag,
    ).toBe("Ok");
    const result = restartStackReview(client, "reviewer", "operation", 1);
    expect(result.tag).toBe("Ok");
    if (result.tag !== "Ok") return;
    expect(JSON.parse(result.value.reviewHistory ?? "null")).toMatchObject({
      readinessRaw: raw,
      readiness: receipt,
      progress,
    });
    expect(client.query("SELECT readiness FROM pull_requests").get()).toEqual({ readiness: null });
    expect(client.query("SELECT next_kind FROM kind_handoffs").all()).toEqual([]);
  },
);

test("a null handoff claim cannot publish a successor or authorize competing stack effects", () => {
  using client = stackDevice();
  insertRow(client, "kind_handoffs", {
    source_id: "source",
    assignment: "child",
    outgoing_launch_id: "reviewer",
    next_kind: "review",
    handoff_state: "pending",
    owner_pid: null,
    lease_at: null,
  });
  expect(startHandoff(client, "source", "child", 1).tag).toBe("Ok");
  expect(client.query("SELECT owner_pid FROM kind_handoffs").get()).toEqual({ owner_pid: null });
  expect(
    changeStack(client, "reviewer", "operation", null, () =>
      Ok({ state: "planned", data: stackPlan(), ownerPid: process.pid }),
    ),
  ).toMatchObject({ tag: "Err", error: { reason: "stack_stale" } });
  expect(client.query("SELECT id FROM stack_operations").all()).toEqual([]);
});

test("a replacement launch can claim exact unfinished progress but the old launch cannot write it", () => {
  using client = stackDevice();
  expect(
    changeStack(client, "reviewer", "operation", null, () =>
      Ok({ state: "planned", data: stackPlan(), ownerPid: null }),
    ).tag,
  ).toBe("Ok");
  client.exec("UPDATE launches SET state = 'interrupted' WHERE id = 'reviewer'");
  client.exec("UPDATE launches SET worktree_path = '/child' WHERE id = 'reviewer'");
  insertRow(client, "launches", {
    id: "replacement",
    source_id: "source",
    assignment: "child",
    attempt: 3,
    state: "running",
    branch: "task/child",
    worktree_path: "/child",
  });
  expect(
    changeStack(client, "replacement", "operation", 1, () =>
      Ok({ state: "planned", data: stackPlan("replacement"), ownerPid: process.pid }),
    ),
  ).toMatchObject({ tag: "Ok", value: { launchId: "replacement", revision: 2 } });
  expect(
    changeStack(client, "reviewer", "operation", 2, () =>
      Ok({ state: "complete", data: "stale", ownerPid: null }),
    ).tag,
  ).toBe("Err");
  expect(readStack(client, "replacement", "operation")).toMatchObject({
    tag: "Ok",
    value: { data: stackPlan("replacement") },
  });
});

test("unresolved queue and stack effects exclude one another at transactional admission", () => {
  using client = stackDevice();
  client
    .query("UPDATE pull_requests SET parking = ?")
    .run(JSON.stringify({ queueHead: "guarded-head" }));
  expect(
    changeStack(client, "reviewer", "operation", null, () =>
      Ok({ state: "planned", data: stackPlan(), ownerPid: process.pid }),
    ),
  ).toMatchObject({
    tag: "Err",
    error: { reason: "pr_delivery_running" },
  });
  expect(client.query("SELECT id FROM stack_operations").all()).toEqual([]);
  client.exec("UPDATE pull_requests SET parking = NULL");
  expect(
    changeStack(client, "reviewer", "operation", null, () =>
      Ok({ state: "planned", data: stackPlan(), ownerPid: process.pid }),
    ).tag,
  ).toBe("Ok");
  expect(recordPullRequestQueue(client, "reviewer", "guarded-head")).toMatchObject({
    tag: "Err",
    error: { reason: "pr_stack_running" },
  });
  expect(client.query("SELECT parking FROM pull_requests").get()).toEqual({ parking: null });
});

test.each(["direct", "queue"] as const)(
  "%s recovery uncertainty excludes every stack write transaction without a live process",
  (effect) => {
    using client = stackDevice();
    expect(
      changeStack(client, "reviewer", "operation", null, () =>
        Ok({ state: "planned", data: stackPlan(), ownerPid: process.pid }),
      ).tag,
    ).toBe("Ok");
    if (effect === "direct") {
      insertRow(client, "deliveries", {
        id: "pending",
        source_id: "source",
        assignment: "child",
        launch_id: "reviewer",
        head: "original",
        selected: 0,
        started_at: "prior",
        owner_pid: null,
        lease_at: null,
      });
    } else {
      client
        .query("UPDATE pull_requests SET parking = ?")
        .run(
          JSON.stringify({ state: "parked", queueHead: "original", ownerPid: null, leaseAt: null }),
        );
    }
    const before = client.serialize();
    const operations = [
      () =>
        changeStack(client, "reviewer", "another", null, () =>
          Ok({ state: "planned", data: "new", ownerPid: process.pid }),
        ),
      () =>
        changeStack(client, "reviewer", "operation", 1, () =>
          Ok({ state: "blocked", data: "changed", ownerPid: null }),
        ),
      () => restartStackReview(client, "reviewer", "operation", 1),
      () =>
        finishStack(client, "reviewer", "operation", 1, {
          data: "changed",
          base: "{}",
          relay: "{}",
        }),
      () => recordStackBase(client, "reviewer", "task/child", "{}"),
      () => beginStackReview(client, "reviewer", "operation", 1),
    ];
    for (const operation of operations) {
      expect(operation()).toMatchObject({ tag: "Err", error: { reason: "pr_delivery_running" } });
      expect(client.serialize()).toEqual(before);
    }
    if (effect === "direct") client.exec("UPDATE deliveries SET ended_at = 'verified'");
    else
      client.exec(`UPDATE pull_requests SET parking = '{"state":"closed","queueHead":"original"}'`);
    expect(
      changeStack(client, "reviewer", "operation", 1, () =>
        Ok({ state: "planned", data: stackPlan(), ownerPid: null }),
      ).tag,
    ).toBe("Ok");
  },
);

test("same-worktree replacement keeps archived review bytes and becomes the explicit outgoing stack owner", () => {
  using client = stackDevice();
  client.exec("UPDATE launches SET worktree_path = '/child' WHERE id = 'reviewer'");
  expect(
    changeStack(client, "reviewer", "operation", null, () =>
      Ok({ state: "planned", data: stackPlan(), ownerPid: process.pid }),
    ).tag,
  ).toBe("Ok");
  const invalidated = restartStackReview(client, "reviewer", "operation", 1);
  expect(invalidated.tag).toBe("Ok");
  if (invalidated.tag !== "Ok") return;
  const archived = invalidated.value.reviewHistory;
  client.exec("UPDATE launches SET state = 'interrupted' WHERE id = 'reviewer'");
  insertRow(client, "launches", {
    id: "replacement",
    source_id: "source",
    assignment: "child",
    attempt: 3,
    state: "running",
    branch: "task/child",
    worktree_path: "/child",
  });
  expect(
    changeStack(client, "replacement", "operation", 2, () =>
      Ok({ state: "planned", data: stackPlan("replacement"), ownerPid: process.pid }),
    ),
  ).toMatchObject({
    tag: "Ok",
    value: { launchId: "replacement", reviewHistory: archived },
  });
  expect(client.query("SELECT implementer_launch_id FROM internal_reviews").get()).toEqual({
    implementer_launch_id: "replacement",
  });
  expect(client.query("SELECT next_kind FROM kind_handoffs").all()).toEqual([]);
});

test("a stack invalidates validation applicability without deleting evidence, even at a same-head fresh ready frontier", () => {
  using client = stackDevice();
  client
    .query("UPDATE launches SET kind = ? WHERE id = 'reviewer'")
    .run(JSON.stringify(WorkerKinds.resolve("pr-feedback")));
  const readiness = JSON.stringify({
    head: "baseline",
    at: "old-review",
    note: null,
    dispositions: [],
  });
  client.query("UPDATE pull_requests SET readiness = ?").run(readiness);
  expect(
    recordDeliveryValidation(client, {
      launchId: "reviewer",
      head: "corrected",
      readiness,
      summary: "Prior bounded correction.",
    }).tag,
  ).toBe("Ok");
  const validations = client.query("SELECT * FROM delivery_validations").all();
  const input = { launchId: "reviewer", head: "corrected", selected: false, session: null };
  expect(admitDelivery(client, input, false).tag).toBe("Ok");
  expect(
    changeStack(client, "reviewer", "operation", null, () =>
      Ok({ state: "planned", data: stackPlan(), ownerPid: process.pid }),
    ).tag,
  ).toBe("Ok");
  expect(restartStackReview(client, "reviewer", "operation", 1).tag).toBe("Ok");
  expect(client.query("SELECT readiness FROM pull_requests").get()).toEqual({ readiness: null });
  expect(client.query("SELECT * FROM delivery_validations").all()).toEqual(validations);
  expect(admitDelivery(client, input, false)).toMatchObject({
    tag: "Err",
    error: { reason: "pr_stack_running" },
  });
  expect(
    finishStack(client, "reviewer", "operation", 2, {
      data: stackPlan("reviewer", { step: "complete" }),
      base: JSON.stringify({ head: "target", branch: "task/parent", managed: false, parents: [] }),
      relay: "{}",
    }).tag,
  ).toBe("Ok");
  expect(
    recordDeliveryValidation(client, {
      launchId: "reviewer",
      head: "corrected",
      readiness,
      summary: "Cannot reuse old readiness.",
    }),
  ).toMatchObject({ tag: "Err", error: { reason: "stack_review_required" } });
  // The public base-only scenario covers the actual independent review and ready handoff.
  // This synthetic frontier keeps the same baseline head to isolate receipt applicability.
  const fresh = JSON.stringify({
    head: "baseline",
    at: "fresh-base-review",
    note: null,
    dispositions: [],
  });
  client.exec("UPDATE internal_reviews SET state = 'ready'");
  client.query("UPDATE pull_requests SET readiness = ?").run(fresh);
  const before = client.serialize();
  expect(admitDelivery(client, input, false)).toMatchObject({
    tag: "Err",
    error: { reason: "pr_validation_stale" },
  });
  expect(
    recordDeliveryValidation(client, {
      launchId: "reviewer",
      head: "corrected",
      readiness,
      summary: "Still old.",
    }),
  ).toMatchObject({ tag: "Err", error: { reason: "pr_validation_stale" } });
  expect(client.serialize()).toEqual(before);
  expect(client.query("SELECT * FROM delivery_validations").all()).toEqual(validations);
  expect(
    recordDeliveryValidation(client, {
      launchId: "reviewer",
      head: "corrected",
      readiness: fresh,
      summary: "Evidence against the fresh baseline.",
    }).tag,
  ).toBe("Ok");
  expect(admitDelivery(client, input, false).tag).toBe("Ok");
  expect(
    client.query("SELECT readiness FROM delivery_validations ORDER BY validated_at").all(),
  ).toEqual([{ readiness }, { readiness: fresh }]);
});

test.each([
  "worktree",
  "branch",
  "source",
  "assignment",
  "running-owner",
  "live-claim",
  "active-handoff",
  "handed-off",
] as const)(
  "completed review recovery refuses a %s mismatch without changing history or ownership",
  (mismatch) => {
    using client = stackDevice();
    expect(
      changeStack(client, "reviewer", "operation", null, () =>
        Ok({ state: "planned", data: stackPlan(), ownerPid: process.pid }),
      ).tag,
    ).toBe("Ok");
    const archived = restartStackReview(client, "reviewer", "operation", 1);
    expect(archived.tag).toBe("Ok");
    expect(
      finishStack(client, "reviewer", "operation", 2, {
        data: stackPlan("reviewer", { step: "complete" }),
        base: JSON.stringify({
          head: "target",
          branch: "task/parent",
          managed: false,
          parents: [],
        }),
        relay: "{}",
      }).tag,
    ).toBe("Ok");
    if (mismatch !== "running-owner")
      client.exec("UPDATE launches SET state = 'interrupted' WHERE id = 'reviewer'");
    if (mismatch === "source") {
      insertRow(client, "sources", { id: "other", repository: "owner/repo", state: "open" });
      insertRow(client, "assignments", {
        source_id: "other",
        key: "child",
        completion: "pr",
        state: "pr-open",
      });
    }
    if (mismatch === "assignment")
      insertRow(client, "assignments", {
        source_id: "source",
        key: "other",
        completion: "pr",
        state: "pr-open",
      });
    insertRow(client, "launches", {
      id: "replacement",
      source_id: mismatch === "source" ? "other" : "source",
      assignment: mismatch === "assignment" ? "other" : "child",
      attempt: 3,
      state: "running",
      branch: mismatch === "branch" ? "task/other" : "task/child",
      worktree_path: mismatch === "worktree" ? "/different" : "/child",
    });
    if (mismatch === "live-claim")
      client
        .query("UPDATE stack_operations SET owner_pid = 1, lease_at = ?")
        .run(new Date().toISOString());
    if (mismatch === "active-handoff" || mismatch === "handed-off")
      insertRow(client, "kind_handoffs", {
        source_id: "source",
        assignment: "child",
        outgoing_launch_id: "reviewer",
        next_kind: "review",
        handoff_state: mismatch === "active-handoff" ? "pending" : "done",
        owner_pid: process.pid,
        lease_at: new Date().toISOString(),
      });
    const before = client.serialize();
    expect(
      changeStack(client, "replacement", "operation", 3, () =>
        Ok({
          state: "complete",
          data: stackPlan("replacement", { step: "complete" }),
          ownerPid: null,
        }),
      ).tag,
    ).toBe("Err");
    expect(client.serialize()).toEqual(before);
  },
);

test("completed but unhanded review recovery transfers the exact owner and preserves archived bytes", () => {
  using client = stackDevice();
  expect(
    changeStack(client, "reviewer", "operation", null, () =>
      Ok({ state: "planned", data: stackPlan(), ownerPid: process.pid }),
    ).tag,
  ).toBe("Ok");
  const archived = restartStackReview(client, "reviewer", "operation", 1);
  expect(archived.tag).toBe("Ok");
  if (archived.tag !== "Ok") return;
  expect(
    finishStack(client, "reviewer", "operation", 2, {
      data: stackPlan("reviewer", { step: "complete" }),
      base: JSON.stringify({ head: "target", branch: "task/parent", managed: false, parents: [] }),
      relay: "{}",
    }).tag,
  ).toBe("Ok");
  client.exec("UPDATE launches SET state = 'interrupted' WHERE id = 'reviewer'");
  insertRow(client, "launches", {
    id: "replacement",
    source_id: "source",
    assignment: "child",
    attempt: 3,
    state: "running",
    branch: "task/child",
    worktree_path: "/child",
  });
  expect(
    changeStack(client, "replacement", "operation", 3, () =>
      Ok({
        state: "complete",
        data: stackPlan("replacement", { step: "complete" }),
        ownerPid: null,
      }),
    ),
  ).toMatchObject({
    tag: "Ok",
    value: { launchId: "replacement", reviewHistory: archived.value.reviewHistory },
  });
  expect(client.query("SELECT implementer_launch_id FROM internal_reviews").get()).toEqual({
    implementer_launch_id: "replacement",
  });
  expect(beginStackReview(client, "replacement", "operation", 4)).toMatchObject({
    tag: "Ok",
    value: true,
  });
  expect(client.query("SELECT outgoing_launch_id, next_kind FROM kind_handoffs").get()).toEqual({
    outgoing_launch_id: "replacement",
    next_kind: "review",
  });
  expect(client.query("SELECT review_history FROM stack_operations").get()).toEqual({
    review_history: archived.value.reviewHistory,
  });
});
