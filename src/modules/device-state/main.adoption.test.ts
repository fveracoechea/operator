import { afterAll, expect, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { WorkerKinds } from "../worker-kinds/main.ts";
import { DeviceState } from "./main.ts";

const root = await mkdtemp(path.join(tmpdir(), "operator-adoption-state-"));
afterAll(() => rm(root, { recursive: true, force: true }));

function fixture(kind: "review" | "pr-feedback") {
  const paths = OperatorHome.resolve(
    Environment.parse({ HOME: `${root}/${crypto.randomUUID()}`, NODE_ENV: "test" }),
  );
  expect(
    DeviceState.registerProject(paths, {
      repository: "owner/one",
      checkout: "/isolated/adoption",
      registeredAt: "now",
    }).tag,
  ).toBe("Ok");
  expect(
    DeviceState.registerSource(
      paths,
      "/isolated/adoption",
      {
        id: "source",
        repository: "owner/one",
        trackerKey: "adopt-41",
        state: "open",
        registeredAt: "now",
        endedAt: null,
        plan: "{}",
      },
      [{ sourceId: "source", key: "adopted", kind, completion: "pr", state: "ready" }],
    ).tag,
  ).toBe("Ok");
  const launch = {
    id: "incoming",
    sourceId: "source",
    assignment: "adopted",
    state: "starting",
    name: "adopt-incoming",
    resources: "worktree",
    branch: "feature/own",
    host: "opencode",
    model: "test/model",
    requestedModel: "test/model",
    reasoningEffort: "medium",
    profile: null,
    release: "{}",
    skills: "[]",
    kind: JSON.stringify(WorkerKinds.resolve(kind)),
    herdrSocket: "/isolated/herdr.sock",
    workspaceId: null,
    tabId: null,
    paneId: null,
    worktreePath: null,
    worktreeWorkspaceId: null,
    startedAt: "now",
    endedAt: null,
    failureReason: null,
    failureDetail: null,
    activity: null,
    activityAt: null,
  };
  expect(DeviceState.reserveLaunch(paths, "/isolated/adoption", "owner/one", launch).tag).toBe(
    "Ok",
  );
  return paths;
}

const pr = {
  number: 41,
  url: "https://github.com/owner/one/pull/41",
  branch: "feature/own",
  relay: null,
};

test("ready adoption records readiness and the optional assignment review without a handoff", () => {
  const paths = fixture("pr-feedback");
  const readiness = { head: "observed-head", at: "now", note: null, dispositions: [] };
  expect(
    DeviceState.adoptPullRequest(
      paths,
      "incoming",
      { ...pr, readiness },
      { internalReview: false, assignmentReview: true },
    ),
  ).toMatchObject({ tag: "Ok" });
  expect(DeviceState.readSources(paths, "owner/one").getOr([])[0]).toMatchObject({
    assignments: [{ state: "pr-open" }],
    pullRequests: [{ number: 41, readiness: JSON.stringify(readiness) }],
    internalReviews: [],
    handoffs: [],
  });
  expect(DeviceState.readReviewRequests(paths).getOr([])).toMatchObject([
    { request: { number: 41, origin: "assignment" } },
  ]);
  expect(
    DeviceState.checkAdoption(paths, {
      repository: "owner/one",
      sourceId: "other",
      assignment: "other",
      branch: "different",
      number: 41,
    }),
  ).toMatchObject({ error: { reason: "adopt_assignment_owned" } });
});

test("direct draft review adoption records its audit but no readiness or optional assignment review", () => {
  const paths = fixture("review");
  expect(
    DeviceState.adoptPullRequest(paths, "incoming", pr, {
      internalReview: true,
      assignmentReview: true,
    }).tag,
  ).toBe("Ok");
  expect(DeviceState.readSources(paths, "owner/one").getOr([])[0]).toMatchObject({
    pullRequests: [{ readiness: null }],
    internalReviews: [{ state: "reviewing" }],
    handoffs: [],
  });
  expect(DeviceState.readReviewRequests(paths).getOr([])).toEqual([]);
});
