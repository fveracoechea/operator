import { expect, test } from "bun:test";
import { z } from "zod";
import { DeviceState } from "../device-state/main.ts";
import { WorkerKinds } from "../worker-kinds/main.ts";
import { decodeSource } from "./snapshot.ts";
import { storedPlanSchema } from "./plan.ts";
import { storedLaunch, storedSource } from "./source-fixture.ts";

const corrupt = new z.ZodError([
  { code: "custom", path: [], message: "Source rows do not match the supplied plan." },
]);

function fixture(stage: "build" | "review" | "complete" = "build") {
  const checks: [string, ...string[]][] = [["git", "diff", "--exit-code"]];
  const head = "b".repeat(40);
  const tree = "c".repeat(40);
  const base = "a".repeat(40);
  const policy = { checks, review: "required" as const, publication: "local-and-origin" as const };
  const data = DeviceState.commitDeliverySchema().parse({
    repository: "example/one",
    ticket: "#411",
    checkout: "/checkout",
    localRef: "refs/heads/main",
    remoteRef: "refs/heads/main",
    remote: "https://github.com/example/one.git",
    base,
    publishedHead: stage === "complete" ? head : null,
    policy,
    candidate:
      stage === "build" ? null : { path: "/candidate", branch: "candidate/411", head, tree },
    history: stage === "build" ? [] : [head],
    implementer: stage === "build" ? null : "implementer",
    rounds: stage === "complete" ? [{ head, tree, findings: [] }] : [],
    dispositions: [],
    checks:
      stage === "complete"
        ? {
            candidate: head,
            tree,
            base,
            policy: JSON.stringify(policy),
            results: [{ argv: checks[0], exitCode: 0 }],
          }
        : null,
    journal:
      stage === "complete"
        ? [
            "candidate_creation",
            "checkout_index",
            "local_ref",
            "remote_publication",
            "database_finalization",
          ].map((effect) => ({ effect, state: "verified", at: "now" }))
        : [],
    stage,
    ownerPid: null,
    leaseAt: null,
  });
  const input = storedSource([{ key: "other", completion: "report", state: "ready" }]);
  const plan = storedPlanSchema.parse(JSON.parse(input.source.plan));
  plan.assignments.push({
    key: "ticket",
    trackerKey: "#411",
    instructions: "Build.",
    kind: "commit-implementation",
    completion: "commit",
    resources: "worktree",
    branch: "ticket/411",
    dependencies: [],
    delivery: { checks },
  });
  input.source.plan = JSON.stringify(plan);
  input.assignments.push({
    sourceId: "one",
    key: "ticket",
    kind: "commit-implementation",
    completion: "commit",
    state: stage === "complete" ? "completed" : "running",
  });
  input.commitDeliveries = [
    { sourceId: "one", assignment: "ticket", revision: 1, data: JSON.stringify(data) },
  ];
  if (stage !== "build")
    input.launches = [
      storedLaunch("ticket", {
        id: "implementer",
        kind: JSON.stringify(WorkerKinds.resolve("commit-implementation")),
      }),
    ];
  function replace() {
    const row = input.commitDeliveries?.[0] ?? expect.unreachable();
    row.data = JSON.stringify(data);
  }

  return { input, data, replace };
}

test.each(["build", "review", "complete"] as const)(
  "valid %s commit facts decode with their exact owner and evidence",
  (stage) => {
    const f = fixture(stage);
    expect(decodeSource(f.input).commitDeliveries).toEqual([
      { sourceId: "one", assignment: "ticket", revision: 1, data: f.data },
    ]);
  },
);

test("every completed commit needs its own record even beside unrelated ready work", () => {
  const { input } = fixture("complete");
  input.commitDeliveries = [];
  expect(() => decodeSource(input)).toThrow(corrupt);
});

test("a record for another completed commit cannot witness the missing ticket", () => {
  const { input, data } = fixture("complete");
  const plan = storedPlanSchema.parse(JSON.parse(input.source.plan));
  plan.assignments.push({
    key: "second",
    trackerKey: "#412",
    instructions: "Build second.",
    kind: "commit-implementation",
    completion: "commit",
    resources: "worktree",
    branch: "ticket/412",
    dependencies: [],
    delivery: { checks: data.policy.checks },
  });
  input.source.plan = JSON.stringify(plan);
  input.assignments.push({
    sourceId: "one",
    key: "second",
    kind: "commit-implementation",
    completion: "commit",
    state: "completed",
  });
  input.commitDeliveries = [
    {
      sourceId: "one",
      assignment: "second",
      revision: 1,
      data: JSON.stringify({ ...data, ticket: "#412", implementer: "second-implementer" }),
    },
  ];
  input.launches.push(
    storedLaunch("second", {
      id: "second-implementer",
      kind: JSON.stringify(WorkerKinds.resolve("commit-implementation")),
    }),
  );
  expect(() => decodeSource(input)).toThrow(corrupt);
});

test.each(["unknown", "other"])(
  "a delivery for %s cannot borrow the first planned or stored assignment",
  (assignment) => {
    const { input } = fixture();
    const row = input.commitDeliveries?.[0] ?? expect.unreachable();
    row.assignment = assignment;
    expect(() => decodeSource(input)).toThrow(corrupt);
  },
);

test("published evidence cannot complete an assignment whose state is still running", () => {
  const { input } = fixture("complete");
  const row = input.assignments.find((row) => row.key === "ticket") ?? expect.unreachable();
  row.state = "running";
  expect(() => decodeSource(input)).toThrow(corrupt);
});

test.each(["missing", "wrong-id", "wrong-assignment", "wrong-kind", "null-kind"])(
  "an implementer with %s facts cannot own commit evidence",
  (kind) => {
    const { input } = fixture("review");
    const launch = input.launches[0] ?? expect.unreachable();
    if (kind === "missing") input.launches = [];
    if (kind === "wrong-id") launch.id = "another";
    if (kind === "wrong-assignment") {
      launch.assignment = "other";
      const other = input.assignments.find((row) => row.key === "other") ?? expect.unreachable();
      other.state = "running";
    }
    if (kind === "wrong-kind") launch.kind = JSON.stringify(WorkerKinds.resolve("implementation"));
    if (kind === "null-kind") launch.kind = null;
    expect(() => decodeSource(input)).toThrow(corrupt);
  },
);

test("an unrelated launch with the right completion cannot supply the implementer's identity", () => {
  const { input } = fixture("review");
  input.launches.unshift(
    storedLaunch("ticket", {
      id: "other-implementer",
      kind: JSON.stringify(WorkerKinds.resolve("commit-implementation")),
    }),
  );
  expect(decodeSource(input).commitDeliveries[0]?.data.implementer).toBe("implementer");
  input.launches.pop();
  expect(() => decodeSource(input)).toThrow(corrupt);
});
