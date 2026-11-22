import { expect, test } from "bun:test";
import { commitDeliverySchema } from "./commit-deliveries.ts";
import type { z } from "zod";

type Data = z.infer<typeof commitDeliverySchema>;
const head = "b".repeat(40);
const tree = "c".repeat(40);
const base = "a".repeat(40);
const finding = {
  axis: "Spec" as const,
  severity: "nice-to-have" as const,
  location: "feature:12",
  claim: "Clarify the behavior.",
};
const policy = {
  checks: [
    ["bun", "run", "lint"],
    ["bun", "run", "test"],
  ],
  review: "required" as const,
  publication: "local-and-origin" as const,
};

function complete(): Data {
  return {
    repository: "o/r",
    ticket: "#411",
    checkout: "/repo",
    localRef: "refs/heads/main",
    remoteRef: "refs/heads/main",
    remote: "https://github.com/o/r.git",
    base,
    publishedHead: head,
    policy,
    candidate: { path: "/candidate", branch: "candidate/411", tree, head },
    history: [head],
    implementer: "implementer",
    stage: "complete",
    ownerPid: null,
    leaseAt: null,
    rounds: [{ head, tree, findings: [finding] }],
    dispositions: [{ round: 1, finding: 1, disposition: "applied" }],
    checks: {
      candidate: head,
      base,
      tree,
      policy: JSON.stringify(policy),
      results: policy.checks.map((argv) => ({ argv, exitCode: 0 })),
    },
    journal: [
      "candidate_creation",
      "checkout_index",
      "local_ref",
      "remote_publication",
      "database_finalization",
    ].map((effect) => ({ effect, state: "verified", at: "now" })),
  };
}

test("late commit evidence validates the exact review, candidate, checks and policy together", () => {
  const data = complete();
  expect(commitDeliverySchema.parse(data)).toEqual(data);
  for (const stage of ["checkout", "local", "remote", "finalize"] as const)
    expect(commitDeliverySchema.parse({ ...data, stage }).stage).toBe(stage);
  expect(commitDeliverySchema.parse({ ...data, stage: "review", checks: null }).stage).toBe(
    "review",
  );
  expect(
    commitDeliverySchema.safeParse({ ...data, stage: "review", implementer: null }).success,
  ).toBe(false);
  expect(
    commitDeliverySchema.safeParse({ ...data, stage: "review", candidate: null }).success,
  ).toBe(false);
  expect(
    commitDeliverySchema.parse({
      ...data,
      dispositions: [
        { round: 1, finding: 1, disposition: "declined", reason: "The contract requires this." },
      ],
    }).dispositions,
  ).toEqual([
    { round: 1, finding: 1, disposition: "declined", reason: "The contract requires this." },
  ]);
});

test.each([`z${base}`, `${base}z`])("object IDs reject surrounding non-hex text: %s", (invalid) => {
  const data = complete();
  expect(
    commitDeliverySchema.safeParse({
      ...data,
      base: invalid,
      checks: { ...data.checks, base: invalid },
    }).success,
  ).toBe(false);
});

test("a shape-valid record with missing publication evidence explains its corruption", () => {
  const result = commitDeliverySchema.safeParse({ ...complete(), publishedHead: null });
  expect(result.success).toBe(false);
  if (!result.success)
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "Commit completion needs exact-candidate review, checks and verified delivery evidence.",
    );
});

test("malformed or stale review evidence cannot claim completed commit work", () => {
  const data = complete();
  const invalid: object[] = [
    { candidate: null },
    { implementer: null },
    { history: [] },
    { history: [base] },
    { rounds: [] },
    { candidate: { ...data.candidate, head: null } },
    { candidate: { ...data.candidate, head: `z${head}` } },
    { candidate: { ...data.candidate, head: `${head}z` } },
    { rounds: [{ head: base, tree, findings: [finding] }] },
    { rounds: [{ head, tree: base, findings: [finding] }] },
    { rounds: [{ head, tree, findings: [{ ...finding, axis: "unknown" }] }] },
    { rounds: [{ head, tree, findings: [{ ...finding, severity: "unknown" }] }] },
    { rounds: [{ head, tree, findings: [{ ...finding, location: "" }] }] },
    { rounds: [{ head, tree, findings: [{ ...finding, claim: "" }] }] },
    { rounds: [{ head, tree, findings: [{ ...finding, severity: "blocker" }] }] },
    { dispositions: [] },
    { dispositions: [{ round: 2, finding: 1, disposition: "applied" }] },
    { dispositions: [{ round: 1, finding: 2, disposition: "applied" }] },
    { dispositions: [{ round: 1, finding: 1, disposition: "unknown" }] },
    { dispositions: [{ round: 1, finding: 1, disposition: "declined" }] },
    { dispositions: [{ round: 1, finding: 1, disposition: "declined", reason: "  " }] },
    { dispositions: [...data.dispositions, ...data.dispositions] },
    { checks: null },
    { checks: { ...data.checks, candidate: base } },
    { checks: { ...data.checks, base: head } },
    { checks: { ...data.checks, tree: base } },
    { checks: { ...data.checks, policy: "different-policy" } },
    { checks: { ...data.checks, results: [] } },
    { checks: { ...data.checks, results: [{ argv: policy.checks[0], exitCode: 0 }] } },
    {
      checks: {
        ...data.checks,
        results: [
          { argv: policy.checks[0], exitCode: 0 },
          { argv: policy.checks[1], exitCode: 1 },
        ],
      },
    },
    {
      checks: {
        ...data.checks,
        results: [
          { argv: ["wrong"], exitCode: 0 },
          { argv: policy.checks[1], exitCode: 0 },
        ],
      },
    },
    { journal: [] },
    { publishedHead: null },
  ];
  for (const change of invalid)
    expect(
      commitDeliverySchema.safeParse({ ...data, ...change }).success,
      JSON.stringify(change),
    ).toBe(false);
  for (const missing of [
    "candidate_creation",
    "checkout_index",
    "local_ref",
    "remote_publication",
    "database_finalization",
  ]) {
    expect(
      commitDeliverySchema.safeParse({
        ...data,
        journal: data.journal.filter((row) => row.effect !== missing),
      }).success,
    ).toBe(false);
    expect(
      commitDeliverySchema.safeParse({
        ...data,
        journal: data.journal.map((row) =>
          row.effect === missing ? { ...row, state: "intent" } : row,
        ),
      }).success,
    ).toBe(false);
  }
});

test("two review rounds require complete unique dispositions, but a declined final blocker can be disproved", () => {
  const data = complete();
  const rounds = [
    {
      head: base,
      tree: base,
      findings: [
        { ...finding, axis: "Standards", severity: "blocker" },
        { ...finding, axis: "Skills" },
      ],
    },
    { head, tree, findings: [{ ...finding, severity: "blocker" }] },
  ];
  const dispositions = [
    { round: 1, finding: 1, disposition: "applied" },
    { round: 1, finding: 2, disposition: "declined", reason: "Not applicable." },
    { round: 2, finding: 1, disposition: "declined", reason: "Disproved by a contract test." },
  ];
  expect(commitDeliverySchema.safeParse({ ...data, rounds, dispositions }).success).toBe(true);
  expect(
    commitDeliverySchema.safeParse({
      ...data,
      rounds,
      dispositions: [dispositions[0], dispositions[0], dispositions[2]],
    }).success,
  ).toBe(false);
  expect(
    commitDeliverySchema.safeParse({ ...data, rounds, dispositions: dispositions.slice(1) })
      .success,
  ).toBe(false);
  expect(
    commitDeliverySchema.safeParse({ ...data, rounds: [...rounds, ...rounds], dispositions })
      .success,
  ).toBe(false);
});
