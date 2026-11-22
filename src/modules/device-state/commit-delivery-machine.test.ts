import { expect, test } from "bun:test";
import type { z } from "zod";
import type { commitDeliverySchema } from "./commit-deliveries.ts";
import { decideCommitDelivery } from "./commit-delivery-machine.ts";

type Data = z.infer<typeof commitDeliverySchema>;
const stages: Data["stage"][] = [
  "build",
  "review",
  "checkout",
  "local",
  "remote",
  "finalize",
  "complete",
];
function data(stage: Data["stage"] = "review"): Data {
  return {
    repository: "o/r",
    ticket: "#411",
    checkout: "/repo",
    localRef: "refs/heads/main",
    remoteRef: "refs/heads/main",
    remote: "https://github.com/o/r.git",
    base: "a".repeat(40),
    publishedHead: null,
    policy: { checks: [["git", "diff"]], review: "required", publication: "local-and-origin" },
    candidate: {
      path: "/candidate",
      branch: "candidate",
      tree: "b".repeat(40),
      head: "c".repeat(40),
    },
    history: ["c".repeat(40)],
    implementer: "implementer",
    rounds: [{ head: "c".repeat(40), tree: "b".repeat(40), findings: [] }],
    dispositions: [{ round: 1, finding: 1, disposition: "applied" }],
    checks: {
      candidate: "c".repeat(40),
      base: "a".repeat(40),
      tree: "b".repeat(40),
      policy: "policy",
      results: [],
    },
    journal: [{ effect: "candidate_creation", state: "intent", at: "now" }],
    stage,
    ownerPid: null,
    leaseAt: null,
  };
}

test("only initialization, same-stage observations and each next lifecycle event are allowed", () => {
  for (const stage of stages)
    expect(decideCommitDelivery(null, data(stage)), stage).toBe(stage === "build");
  for (const [from, stage] of stages.entries())
    for (const [to, next] of stages.entries())
      expect(decideCommitDelivery(data(stage), data(next)), `${stage} -> ${next}`).toBe(
        to === from || to === from + 1,
      );
});

test("history, journal, review rounds and dispositions remain append-only", () => {
  const before = data();
  for (const change of [
    { history: [] },
    { history: ["different"] },
    { journal: [] },
    { journal: [{ effect: "candidate_creation", state: "verified" as const, at: "now" }] },
    { rounds: [] },
    { rounds: [{ head: "d".repeat(40), tree: "b".repeat(40), findings: [] }] },
    { dispositions: [] },
    { dispositions: [{ round: 1, finding: 1, disposition: "declined" as const, reason: "No." }] },
    { implementer: null },
    { implementer: "replacement" },
  ])
    expect(decideCommitDelivery(before, { ...before, ...change }), JSON.stringify(change)).toBe(
      false,
    );
  expect(
    decideCommitDelivery(before, {
      ...before,
      history: [...before.history, "d".repeat(40)],
      journal: [
        ...before.journal,
        { effect: "candidate_creation", state: "verified", at: "later" },
      ],
      rounds: [...before.rounds, { head: "d".repeat(40), tree: "e".repeat(40), findings: [] }],
      dispositions: [...before.dispositions, { round: 2, finding: 1, disposition: "applied" }],
    }),
  ).toBe(true);
  expect(decideCommitDelivery({ ...before, implementer: null }, before)).toBe(true);
});

test("a publication observation cannot be removed or replaced", () => {
  const before = { ...data("finalize"), publishedHead: "c".repeat(40) };
  expect(decideCommitDelivery(before, { ...before })).toBe(true);
  expect(decideCommitDelivery(before, { ...before, publishedHead: null })).toBe(false);
  expect(decideCommitDelivery(before, { ...before, publishedHead: "d".repeat(40) })).toBe(false);
  expect(
    decideCommitDelivery(data("remote"), {
      ...data("remote"),
      publishedHead: before.publishedHead,
    }),
  ).toBe(true);
});

test("candidate creation may fill its head, but cannot forget or replace an existing pinned object", () => {
  const before = data();
  const candidate = before.candidate ?? expect.unreachable();
  expect(decideCommitDelivery({ ...before, candidate: null }, before)).toBe(true);
  expect(decideCommitDelivery({ ...before, candidate: { ...candidate, head: null } }, before)).toBe(
    true,
  );
  expect(decideCommitDelivery(before, { ...before, candidate: null })).toBe(false);
  expect(decideCommitDelivery(before, { ...before, candidate: { ...candidate, head: null } })).toBe(
    false,
  );
  expect(
    decideCommitDelivery(before, { ...before, candidate: { ...candidate, head: "d".repeat(40) } }),
  ).toBe(false);
  const newer = { path: "/new", branch: "new", tree: "d".repeat(40), head: null };
  for (const stage of ["build", "review"] as const) {
    const previous = { ...before, stage };
    expect(decideCommitDelivery(previous, { ...previous, candidate: newer, checks: null })).toBe(
      true,
    );
    for (const changed of [
      { ...newer, path: candidate.path },
      { ...newer, branch: candidate.branch },
      { ...newer, tree: candidate.tree },
      { ...newer, head: candidate.head },
    ])
      expect(decideCommitDelivery(previous, { ...previous, candidate: changed })).toBe(false);
  }
  for (const stage of ["checkout", "local", "remote", "finalize", "complete"] as const) {
    const previous = { ...before, stage };
    for (const change of [
      { candidate: newer },
      { candidate: { ...candidate, path: "/new" } },
      { candidate: { ...candidate, branch: "new" } },
      { candidate: { ...candidate, tree: "d".repeat(40) } },
      { checks: null },
      { rounds: [...previous.rounds, ...previous.rounds] },
      { dispositions: [...previous.dispositions, ...previous.dispositions] },
    ])
      expect(decideCommitDelivery(previous, { ...previous, ...change })).toBe(false);
  }
  expect(decideCommitDelivery(before, { ...before, checks: null })).toBe(true);
});
