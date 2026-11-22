import { expect, test } from "bun:test";
import { DeviceState } from "../device-state/main.ts";
import { commitEvent, commitPhase, worktreeEvent } from "./commit-context.ts";

function evidence(stage = "build", implementer: string | null = null) {
  const head = "b".repeat(40);
  const tree = "c".repeat(40);
  const base = "a".repeat(40);
  const policy = { checks: [["git", "diff"]], review: "required", publication: "local-and-origin" };
  return JSON.stringify({
    repository: "o/r",
    ticket: "#411",
    checkout: "/repo",
    localRef: "refs/heads/main",
    remoteRef: "refs/heads/main",
    remote: "https://github.com/o/r.git",
    base,
    policy,
    stage,
    candidate: { path: "/candidate", branch: "candidate", head, tree },
    history: [head],
    implementer,
    rounds: [{ head, tree, findings: [] }],
    dispositions: [],
    ownerPid: null,
    leaseAt: null,
    publishedHead: head,
    checks: {
      candidate: head,
      tree,
      base,
      policy: JSON.stringify(policy),
      results: [{ argv: ["git", "diff"], exitCode: 0 }],
    },
    journal: [
      "candidate_creation",
      "checkout_index",
      "local_ref",
      "remote_publication",
      "database_finalization",
    ].map((effect) => ({ effect, state: "verified", at: "now" })),
  });
}

test("only commit review, round and deliver commands select commit phase events", () => {
  expect(commitEvent(["commit", "review"])).toBe("commit-review");
  expect(commitEvent(["commit", "round", "--file", "findings"])).toBe("commit-round");
  expect(commitEvent(["commit", "deliver", "--file", "dispositions"])).toBe("commit-deliver");
  for (const args of [
    [],
    ["commit"],
    ["commit", "other"],
    ["pr", "review"],
    ["report", "round"],
    ["pr", "deliver"],
  ])
    expect(commitEvent(args)).toBeUndefined();
});

test("commit commands stay pane-owned while PR commands select their worktree", () => {
  for (const event of [
    undefined,
    "submit",
    "resume",
    "commit-review",
    "commit-round",
    "commit-deliver",
  ] as const)
    expect(worktreeEvent(event), String(event)).toBe(false);
  for (const event of ["associate", "round", "ready", "wait", "observe-merge"] as const)
    expect(worktreeEvent(event), event).toBe(true);
});

test("phase facts select only this assignment and distinguish publication from completion", () => {
  expect(commitPhase({}, "ticket")).toBeUndefined();
  expect(commitPhase({ commitDeliveries: [] }, "ticket")).toBeUndefined();
  const row = { assignment: "other", revision: 1, data: evidence(), sourceId: "source" };
  expect(commitPhase({ commitDeliveries: [row] }, "ticket")).toBeUndefined();
  expect(
    commitPhase({ commitDeliveries: [row, { ...row, assignment: "ticket" }] }, "ticket"),
  ).toEqual({
    reviewing: false,
    rounds: 1,
    delivered: false,
  });
  for (const stage of ["review", "checkout", "local", "remote", "finalize"])
    expect(
      commitPhase(
        {
          commitDeliveries: [
            { ...row, assignment: "ticket", data: evidence(stage, "implementer") },
          ],
        },
        "ticket",
      ),
    ).toEqual({
      reviewing: true,
      rounds: 1,
      delivered: false,
    });
  expect(
    commitPhase(
      {
        commitDeliveries: [
          { ...row, assignment: "ticket", data: evidence("complete", "implementer") },
        ],
      },
      "ticket",
    ),
  ).toEqual({
    reviewing: true,
    rounds: 1,
    delivered: true,
  });
  const noRounds = DeviceState.commitDeliverySchema().parse(JSON.parse(evidence()));
  noRounds.rounds = [];
  expect(
    commitPhase(
      { commitDeliveries: [{ ...row, assignment: "ticket", data: JSON.stringify(noRounds) }] },
      "ticket",
    )?.rounds,
  ).toBe(0);
});

test("corrupt persisted commit facts are not fabricated as phase readiness", () => {
  for (const data of ["{", "{}"])
    expect(() =>
      commitPhase(
        { commitDeliveries: [{ assignment: "ticket", sourceId: "s", revision: 1, data }] },
        "ticket",
      ),
    ).toThrow();
});
