import { afterEach, expect, test } from "bun:test";
// Bun has no temporary folder API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentIdentity } from "../content-identity/main.ts";
import { OperativeDispatch } from "./main.ts";
import type { PrepareFailure } from "./inputs.ts";
import { type Brief, type DispatchPlan, planDispatch, type Snapshot } from "./plan.ts";

const folders: string[] = [];

afterEach(async () => {
  await Promise.all(folders.splice(0).map((one) => rm(one, { recursive: true, force: true })));
});

const brief: Brief = {
  assignmentId: "assignment-stable",
  assignmentRevision: 1,
  attemptId: "abcdef12-3456-7890-abcd-ef1234567890",
  sourceId: "github",
  sourceKey: "59",
  sourceRevision: "revision",
  title: "Migrate customers",
  kind: "production",
  approvedScope: "Migrate customers.",
  acceptanceRequirements: [],
  requirementsIdentity: "requirements",
  permissions: { writePaths: [], allowedCommands: [], network: false },
  fixedInputs: [],
  planningRecords: [],
  rules: { submit: [], report: [] },
  gate: null,
  role: { kind: "production" },
};

/**
 * A controlling checkout with a configuration and lock data, and an Operative worktree whose base
 * commit holds one fixed input at `spec.md`.
 */
async function launch() {
  const root = await mkdtemp(join(tmpdir(), "operator-prepare-"));
  folders.push(root);
  const projectRoot = join(root, "project");
  const worktreePath = join(root, "worktree");
  await Bun.write(join(projectRoot, ".operator/config.json"), "{}\n");
  await Bun.write(join(projectRoot, ".operator/local/operator.lock"), "lock\n");
  await Bun.write(join(worktreePath, "spec.md"), "spec\n");
  await Bun.write(join(root, "copy.md"), "copy\n");
  const git = (args: string[]) =>
    Bun.$`git -C ${worktreePath} -c user.email=t@example.com -c user.name=Test ${args}`.quiet();
  await git(["init", "-q"]);
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "base"]);
  const baseCommit = (await Bun.$`git -C ${worktreePath} rev-parse HEAD`.text()).trim();

  const snapshot: Snapshot = {
    selection: { crew: { host: "claude-code", model: null } },
    release: { version: "0.4.0", identity: "release" },
    lock: {
      name: "operator.lock",
      state: "ready",
      identity: "lock",
      path: join(projectRoot, ".operator/local/operator.lock"),
    },
    skills: { identity: "skills" },
  };
  const plan: DispatchPlan = planDispatch({
    projectRoot,
    brief,
    snapshot,
    baseCommit,
    branch: null,
    worktreePath,
    agentHost: "claude-code",
    agentKind: "claude",
  });
  return { root, projectRoot, worktreePath, snapshot, plan };
}

type Launch = Awaited<ReturnType<typeof launch>>;

const spec = { path: "spec.md", identity: ContentIdentity.ofText("spec\n") };

// Each case breaks one input and keeps the inputs before it intact, so the reason names the
// first reader that refuses.
const refusals: Array<{
  name: string;
  arrange: (one: Launch) => Promise<{ plan?: Partial<DispatchPlan>; snapshot?: Partial<Snapshot> }>;
  reason: PrepareFailure;
  detail: string;
}> = [
  {
    name: "a missing configuration before missing lock data",
    arrange: async (one) => {
      await rm(join(one.projectRoot, ".operator/config.json"));
      return { snapshot: { lock: { ...one.snapshot.lock, name: null, path: null } } };
    },
    reason: "configuration_missing",
    detail: "The controlling checkout holds no .operator/config.json to copy.",
  },
  {
    name: "a release with no lock data",
    arrange: async (one) => ({ snapshot: { lock: { ...one.snapshot.lock, path: null } } }),
    reason: "lock_data_missing",
    detail: "The recorded release has no lock data, so the installation cannot be reproduced.",
  },
  {
    name: "lock data that is gone",
    arrange: async (one) => {
      await rm(one.snapshot.lock.path ?? "");
      return {};
    },
    reason: "lock_data_missing",
    detail: "The recorded lock data is gone from",
  },
  {
    name: "a jsr installation with no selected release record",
    arrange: async () => ({
      snapshot: { installation: { delivery: "jsr", commit: null, packageVersion: "0.4.0" } },
    }),
    reason: "input_verification_failed",
    detail: "The selected release record at",
  },
  {
    name: "a different OpenCode agent file in the worktree",
    arrange: async (one) => {
      await Bun.write(join(one.worktreePath, ".opencode/agents/operator-crew.md"), "mine\n");
      return { plan: { agentHost: "opencode", agentReasoningEffort: "high" } };
    },
    reason: "input_verification_failed",
    detail: ".opencode/agents/operator-crew.md already exists with different contents.",
  },
  {
    name: "a fixed input that the base commit does not hold",
    arrange: async () => ({ plan: { fixedPaths: [{ path: "absent.md", identity: "any" }] } }),
    reason: "input_verification_failed",
    detail: "The fixed input absent.md is not in the base commit.",
  },
  {
    name: "a fixed input that changed at the base commit",
    arrange: async () => ({ plan: { fixedPaths: [{ ...spec, identity: "other" }] } }),
    reason: "input_verification_failed",
    detail:
      "The fixed input spec.md at the base commit no longer matches the identity registration fixed.",
  },
  {
    name: "a fixed copy that is gone",
    arrange: async (one) => ({
      plan: {
        fixedPaths: [spec],
        extraInputs: [{ path: "copy.md", sourcePath: join(one.root, "gone.md"), identity: "any" }],
      },
    }),
    reason: "input_verification_failed",
    detail: "The fixed copy at",
  },
  {
    name: "a fixed copy that changed",
    arrange: async (one) => ({
      plan: {
        extraInputs: [
          { path: "copy.md", sourcePath: join(one.root, "copy.md"), identity: "other" },
        ],
      },
    }),
    reason: "input_verification_failed",
    detail: "copy.md no longer matches the identity the submission fixed.",
  },
];

for (const refusal of refusals) {
  test(`prepare refuses ${refusal.name} and writes nothing`, async () => {
    const one = await launch();
    const changed = await refusal.arrange(one);
    const outcome = await OperativeDispatch.perform({
      kind: "input_preparation",
      projectRoot: one.projectRoot,
      plan: { ...one.plan, ...changed.plan },
      snapshot: { ...one.snapshot, ...changed.snapshot },
      workspaceId: null,
    });

    expect(outcome).toEqual({
      status: "failed",
      detail: expect.stringMatching(new RegExp(`^${refusal.reason}: `)),
    });
    expect(outcome.detail).toContain(refusal.detail);
    expect(await Bun.file(join(one.worktreePath, one.plan.briefPath)).exists()).toBe(false);
  });
}

// The copies go first, then the configuration, then the lock data. The detail of a failed write
// names the first path in that order, and crew state records it.
const unwritable = [
  {
    blocked: ["copy.md", ".operator/config.json", ".operator/local/operator.lock"],
    first: "copy.md",
  },
  {
    blocked: [".operator/config.json", ".operator/local/operator.lock"],
    first: ".operator/config.json",
  },
  { blocked: [".operator/local/operator.lock"], first: ".operator/local/operator.lock" },
];

for (const { blocked, first } of unwritable) {
  test(`prepare names ${first} when it is the first input it cannot write`, async () => {
    const one = await launch();
    for (const path of blocked) {
      await Bun.write(join(one.worktreePath, path, "held"), "held\n");
    }
    const outcome = await OperativeDispatch.perform({
      kind: "input_preparation",
      projectRoot: one.projectRoot,
      plan: {
        ...one.plan,
        extraInputs: [
          {
            path: "copy.md",
            sourcePath: join(one.root, "copy.md"),
            identity: ContentIdentity.ofText("copy\n"),
          },
        ],
      },
      snapshot: one.snapshot,
      workspaceId: null,
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toStartWith(
      `input_verification_failed: ${first} could not be written: `,
    );
  });
}

test("prepare copies and verifies each input and names their count", async () => {
  const one = await launch();

  const outcome = await OperativeDispatch.perform({
    kind: "input_preparation",
    projectRoot: one.projectRoot,
    plan: one.plan,
    snapshot: one.snapshot,
    workspaceId: null,
  });

  expect(outcome).toEqual({ status: "succeeded", detail: "Copied and verified 6 input(s)." });
});
