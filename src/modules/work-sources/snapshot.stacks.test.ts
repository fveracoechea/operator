import { expect, test } from "bun:test";
import { decodeSource } from "./snapshot.ts";
import { storedSource, storedLaunch, storedPullRequest } from "./source-fixture.ts";
import type { PrStacks } from "../pr-stacks/main.ts";

const plan = {
  id: "operation",
  repository: "example/one",
  sourceId: "one",
  assignment: "child",
  launchId: "l-child",
  previousOwners: [],
  number: 8,
  branch: "task/child",
  head: "child-old",
  base: "task/parent",
  cut: "parent-old",
  remote: "origin",
  parents: [
    { assignment: "parent", number: 6, branch: "task/parent", head: "parent-new", base: "main" },
  ],
  target: "parent-new",
  targetBranch: "task/parent",
  managed: false,
  retargetAttempted: false,
  pushAttempted: false,
  relayToMain: false,
  candidate: null,
  step: "planned",
  blocker: null,
  failures: [],
} satisfies ReturnType<typeof PrStacks.operation>;

test("stack snapshots expose pinned provenance and refuse records that name another owner or source", () => {
  const source = storedSource(
    [
      { key: "parent", completion: "pr", state: "pr-open" },
      { key: "child", completion: "pr", state: "pr-open", dependencies: ["parent"] },
    ],
    {
      launches: [
        storedLaunch("parent", { branch: "task/parent" }),
        storedLaunch("child", { branch: "task/child" }),
      ],
      pullRequests: [
        storedPullRequest("parent", { number: 6 }),
        storedPullRequest("child", { number: 8 }),
      ],
    },
  );
  const operation = {
    id: "operation",
    sourceId: "one",
    assignment: "child",
    launchId: "l-child",
    revision: 1,
    state: "planned",
    data: JSON.stringify(plan),
    reviewHistory: null,
    ownerPid: null,
    leaseAt: null,
  };
  expect(
    decodeSource({ ...source, stackOperations: [operation] }).stackOperations[0]?.data,
  ).toEqual(plan);
  for (const change of [
    { sourceId: "other" },
    { assignment: "other" },
    { launchId: "l-parent" },
    { data: JSON.stringify({ ...plan, sourceId: "other" }) },
    { data: JSON.stringify({ ...plan, branch: "task/other" }) },
    { state: "complete" },
    { revision: 0 },
  ])
    expect(() =>
      decodeSource({ ...source, stackOperations: [{ ...operation, ...change }] }),
    ).toThrow();
});
