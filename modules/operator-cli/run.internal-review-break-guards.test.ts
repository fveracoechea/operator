import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no recursive copy, temporary-directory, or symlink API.
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";

const source = Bun.fileURLToPath(new URL("../../", import.meta.url));
let root = "";
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-internal-review-guards-"));
  for (const file of [
    "modules",
    "lib",
    "scripts",
    "tools",
    "skills",
    "cli.ts",
    "package.json",
    "bunfig.toml",
    "tsconfig.json",
  ])
    await cp(`${source}/${file}`, `${root}/${file}`, { recursive: true });
  await symlink(`${source}/node_modules`, `${root}/node_modules`);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const flow = "operator-cli/run.internal-review.test.ts";
const guards = "operator-cli/run.internal-review-guards.test.ts";

test.each([
  {
    name: "draft required",
    file: "pull-requests/internal-review-machine.ts",
    replacements: [
      ["when: (facts) => facts.internalReview && !facts.draft,", "when: () => false,"],
    ],
    testFile: guards,
    pattern: "associate refuses a ready PR",
  },
  {
    name: "clean worktree",
    file: "pull-requests/internal-review-machine.ts",
    replacements: [
      ["when: (facts) => facts.internalReview && facts.changed,", "when: () => false,"],
    ],
    testFile: guards,
    pattern: "associate refuses a ready PR",
  },
  {
    name: "implementer pane closed",
    file: "pull-requests/internal-review-machine.ts",
    replacements: [["closePane: !facts.reviewerStarted && live", "closePane: false && live"]],
    testFile: flow,
    pattern: "hands a clean draft",
  },
  {
    name: "handed-off launch refused",
    file: "pull-requests/internal-review.ts",
    replacements: [["return owner.implementerLaunchId === owner.launchId", "return false"]],
    testFile: guards,
    pattern: "cannot close the implementer",
  },
  {
    name: "two rounds",
    file: "pull-requests/internal-review-machine.ts",
    replacements: [["facts.review.rounds.length >= 2", "facts.review.rounds.length >= 3"]],
    testFile: flow,
    pattern: "at most two rounds",
  },
  {
    name: "newer head for round two",
    file: "pull-requests/internal-review-machine.ts",
    replacements: [
      ["facts.review.rounds.some((round) => round.head === facts.localHead) === true", "false"],
    ],
    testFile: flow,
    pattern: "at most two rounds",
  },
  {
    name: "reviewer start after a stopped handoff",
    file: "device-state/internal-reviews.ts",
    replacements: [['review.handoffState !== "done" &&', 'review.handoffState === "done" &&']],
    testFile: flow,
    pattern: "hands a clean draft",
  },
  {
    name: "handoff blocks migration",
    file: "device-state/migration-policy.ts",
    replacements: [["applied: 12,", "applied: 99,"]],
    testFile: "device-state/migration-policy.test.ts",
    pattern: "a live internal review handoff blocks an upgrade",
  },
])(
  "a deliberate break of internal review guard $name makes its behavior test fail",
  async (change) => {
    const file = `${root}/modules/${change.file}`;
    const original = await Bun.file(file).text();
    let changed = original;
    for (const [before, after] of change.replacements) {
      expect(original).toContain(before);
      changed = changed.replace(before, after);
    }
    try {
      await Bun.write(file, changed);
      const child = Bun.spawn(
        [
          process.execPath,
          "run",
          "test",
          `modules/${change.testFile}`,
          "--test-name-pattern",
          change.pattern,
        ],
        {
          cwd: root,
          env: Environment.child({ BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, `${stdout}${stderr}`).toBe(1);
      expect(`${stdout}${stderr}`).toContain("(fail)");
      expect(`${stdout}${stderr}`).toContain(change.pattern);
    } finally {
      await Bun.write(file, original);
    }
  },
  180000,
);
