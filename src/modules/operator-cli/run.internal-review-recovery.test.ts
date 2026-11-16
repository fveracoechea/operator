import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
// Bun has no recursive removal API.
import { rm } from "node:fs/promises";
import { z } from "zod";
import { workerDevice } from "./worker-fixture.ts";

let device: Awaited<ReturnType<typeof workerDevice>>;
afterEach(async () => {
  await rm(device.root, { recursive: true, force: true });
});

async function affectedDraft() {
  device = await workerDevice({ github: true });
  const source = await device.register({
    trackerKey: "github:example/one#414",
    assignments: [
      {
        key: "read",
        kind: "research",
        resources: "worktree",
        branch: "report/read",
        trackerKey: "github:example/one#414",
        instructions: "Investigate.",
        dependencies: [],
      },
    ],
  });
  const worker = await device.dispatch(source, "read");
  const worktree = worker.worktreePath ?? expect.unreachable("Missing worktree");
  const report = await device.writeReport("report.md", {
    conclusion: "Build it.",
    evidence: ["a.ts:1"],
    unresolved: [],
  });
  expect(
    (await device.run(["report", "submit", "--file", report], { pane: worker.paneId })).code,
  ).toBe(0);
  const promotion = await device.writeJson("promotion.json", {
    key: "build",
    trackerKey: "github:example/one#414",
    instructions: "Build it.",
    branch: "task/build",
    internalReview: true,
  });
  const promoted = await device.run([
    "report",
    "accept",
    "--source",
    source,
    "--assignment",
    "read",
    "--promote",
    promotion,
  ]);
  expect(promoted.code, promoted.stderr).toBe(0);
  const db = new Database(`${device.root}/state/operator/operator.sqlite`);
  // Model the retained 2.3.2 launch, not a newly promoted launch after the fix.
  db.run(
    "UPDATE launches SET internal_review = NULL WHERE source_id = ? AND assignment = 'build'",
    [source],
  );
  const launch = z
    .object({ id: z.string() })
    .parse(
      db.query("SELECT id FROM launches WHERE source_id = ? AND assignment = 'build'").get(source),
    ).id;
  db.close();
  const head = (await device.exec(["git", "rev-parse", "HEAD"], worktree)).stdout.trim();
  await Bun.write(
    `${device.root}/github.json`,
    JSON.stringify({
      pulls: [
        {
          number: 415,
          url: "https://github.com/example/one/pull/415",
          headRefName: "task/build",
          headRepository: "example/one",
          state: "OPEN",
          isDraft: true,
          head,
        },
      ],
    }),
  );
  expect(
    (await device.run(["pr", "associate"], { cwd: worktree, pane: worker.paneId })).output,
  ).toMatchObject({ reason: "pr_associated", data: { internalReview: null } });
  const args = [
    "internal-review",
    "recover",
    "--source",
    source,
    "--assignment",
    "build",
    "--launch",
    launch,
    "--pr",
    "415",
    "--head",
    head,
  ];
  return { source, worker, worktree, launch, head, args };
}

test("an already-associated promoted draft needs explicit recovery, then gets one genuine handoff", async () => {
  const { source, args, worktree, worker, head, launch } = await affectedDraft();
  // Neither a fixed promotion implementation nor repeated association repairs retained state.
  expect(
    (await device.run(["pr", "associate"], { cwd: worktree, pane: worker.paneId })).output.reason,
  ).toBe("pr_unchanged");
  const missing = await device.run(["handoff", "--source", source, "--assignment", "build"]);
  expect(missing.output.reason).toBe("handoff_not_found");
  const database = Bun.file(`${device.root}/state/operator/operator.sqlite`);
  const before = await database.arrayBuffer();
  const unauthorized = await device.run(args);
  expect(unauthorized.output.reason).toBe("person_instruction_required");
  expect(await database.arrayBuffer()).toEqual(before);
  // Keep the handoff pending so two concurrent callers observe the same historical owner.
  await device.setHerdr({ fail: { "pane close": "controlled refusal" } });
  const results = await Promise.all([
    device.run([...args, "--person-instructed"]),
    device.run([...args, "--person-instructed"]),
  ]);
  expect(results.map((result) => result.output.reason).toSorted(), JSON.stringify(results)).toEqual(
    ["internal_review_recovered", "internal_review_recovery_unchanged"],
  );
  for (const result of results)
    expect(result.output).toMatchObject({
      data: {
        recovery: {
          sourceId: source,
          assignment: "build",
          repository: "example/one",
          implementerLaunchId: launch,
          number: 415,
          head,
          personInstructed: true,
          worktreePath: worktree,
        },
      },
    });
  for (const result of results)
    expect(
      z
        .object({ data: z.object({ recovery: z.object({ authorizedAt: z.string() }) }) })
        .parse(result.output).data.recovery.authorizedAt,
    ).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  const shown = await device.run(["source", "show", "--source", source]);
  expect(shown.output).toMatchObject({
    data: {
      internalReviews: [{ assignment: "build", state: "reviewing", readyHead: null }],
      internalReviewRounds: [],
    },
  });
  const github = z.looseObject({}).parse(await Bun.file(`${device.root}/github.json`).json());
  expect(github).not.toHaveProperty("readied");
  expect(github).not.toHaveProperty("commented");
  // The recorded failure remains retryable through the ordinary handoff workflow.
  let failed = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = await device.run(["source", "show", "--source", source]);
    const facts = z
      .object({
        data: z.object({ internalReviews: z.array(z.object({ handoffState: z.string() })) }),
      })
      .parse(current.output);
    if (facts.data.internalReviews[0]?.handoffState === "failed") {
      failed = true;
      break;
    }
    await Bun.sleep(20);
  }
  expect(failed).toBe(true);
  await Bun.write(`${worktree}/local-after-recovery`, "unlanded correction");
  const unsafeRetry = await device.run(["handoff", "--source", source, "--assignment", "build"]);
  expect(unsafeRetry.output.reason).toBe("pr_worktree_unclean");
  expect(await Bun.file(`${worktree}/local-after-recovery`).text()).toBe("unlanded correction");
  await rm(`${worktree}/local-after-recovery`);
  await device.setHerdr({ fail: {} });
  const handed = await device.run(["handoff", "--source", source, "--assignment", "build"]);
  expect(handed.code, handed.stderr).toBe(0);
  const reviewed = await device.run(["source", "show", "--source", source]);
  expect(reviewed.output).toMatchObject({
    data: {
      internalReviews: [{ state: "reviewing", handoffState: "done", implementerLaunchId: launch }],
      internalReviewRounds: [],
    },
  });
  const retry = await device.run([...args, "--person-instructed"]);
  expect(retry.output.reason).toBe("internal_review_recovery_unchanged");
});

test.each(["ready", "dirty", "head", "owner", "ambiguous"])(
  "recovery refuses a %s retained draft without changing records or starting a handoff",
  async (change) => {
    const { args, worktree } = await affectedDraft();
    const pulls = z
      .object({ pulls: z.array(z.looseObject({ number: z.number(), isDraft: z.boolean() })) })
      .parse(await Bun.file(`${device.root}/github.json`).json());
    if (change === "ready") pulls.pulls = pulls.pulls.map((row) => ({ ...row, isDraft: false }));
    if (change === "dirty") await Bun.write(`${worktree}/untracked`, "local changes");
    if (change === "head") args[args.indexOf("--head") + 1] = "b".repeat(40);
    if (change === "owner") args[args.indexOf("--launch") + 1] = crypto.randomUUID();
    if (change === "ambiguous") pulls.pulls.push({ ...pulls.pulls[0], number: 416, isDraft: true });
    await Bun.write(`${device.root}/github.json`, JSON.stringify(pulls));
    const database = Bun.file(`${device.root}/state/operator/operator.sqlite`);
    const before = await database.arrayBuffer();
    const calls = await device.herdrCalls();
    const result = await device.run([...args, "--person-instructed"]);
    expect(result.code, result.stderr).toBe(4);
    expect(result.output.reason).toBe("internal_review_recovery_incompatible");
    expect(await database.arrayBuffer()).toEqual(before);
    expect(await device.herdrCalls()).toEqual(calls);
  },
);
