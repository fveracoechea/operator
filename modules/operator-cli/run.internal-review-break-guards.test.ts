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
const ready = "operator-cli/run.internal-review-ready.test.ts";

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
    file: "pull-requests/internal-review-machine.ts",
    replacements: [["return facts.implementer", "return false"]],
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
      ["facts.review.rounds.some((round) => round.head === facts.localHead)", "false"],
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
    name: "association holds its handoff",
    file: "device-state/pull-requests.ts",
    replacements: [["ownerPid: process.pid,", "ownerPid: null,"]],
    testFile: "device-state/pull-requests.test.ts",
    pattern: "holds its handoff",
  },
  {
    name: "handoff takes over the association's hold",
    file: "device-state/internal-reviews.ts",
    replacements: [["review.ownerPid !== afterPid", "true"]],
    testFile: "device-state/pull-requests.test.ts",
    pattern: "takes over its hold",
  },
  {
    name: "handoff blocks migration",
    file: "device-state/migration-policy.ts",
    replacements: [["applied: 13,", "applied: 99,"]],
    testFile: "device-state/migration-policy.test.ts",
    pattern: "a live internal review handoff blocks an upgrade",
  },
  {
    name: "a second round after an applied blocker",
    file: "pull-requests/internal-review-machine.ts",
    replacements: [["facts.review.rounds.length === 1 &&", "false &&"]],
    testFile: ready,
    pattern: "rendered comment",
  },
  {
    name: "a ready step refuses an unclean worktree",
    file: "pull-requests/internal-review-machine.ts",
    replacements: [["when: (facts) => facts.changed,", "when: () => false,"]],
    testFile: ready,
    pattern: "rendered comment",
  },
  {
    name: "a ready step refuses a worktree away from the PR head",
    file: "pull-requests/internal-review-machine.ts",
    replacements: [["when: (facts) => facts.localHead !== facts.pr.head,", "when: () => false,"]],
    testFile: ready,
    pattern: "rendered comment",
  },
  {
    name: "a summary names only recorded findings",
    file: "pull-requests/internal-review-machine.ts",
    replacements: [["when: (facts) => unknown(facts).length > 0,", "when: () => false,"]],
    testFile: "pull-requests/internal-review-machine.test.ts",
    pattern: "refuses the ready step",
  },
  {
    name: "a summary decides each finding once",
    file: "pull-requests/internal-review-machine.ts",
    replacements: [["when: (facts) => repeated(facts).length > 0,", "when: () => false,"]],
    testFile: "pull-requests/internal-review-machine.test.ts",
    pattern: "refuses the ready step",
  },
  {
    name: "every finding has a disposition",
    file: "pull-requests/internal-review-machine.ts",
    replacements: [["when: (facts) => undecided(facts).length > 0,", "when: () => false,"]],
    testFile: ready,
    pattern: "rendered comment",
  },
  {
    name: "a comment found again after a lost answer",
    file: "pull-requests/internal-review-machine.ts",
    replacements: [['current: "keep"', 'current: "post"']],
    testFile: ready,
    pattern: "lost comment",
  },
  {
    name: "a comment from an older head is updated",
    file: "pull-requests/internal-review-machine.ts",
    replacements: [['stale: "update"', 'stale: "keep"']],
    testFile: ready,
    pattern: "later push",
  },
  {
    name: "a skip needs the person's instruction",
    file: "pull-requests/internal-review-machine.ts",
    replacements: [["when: (facts) => !facts.personInstructed,", "when: () => false,"]],
    testFile: ready,
    pattern: "person-instructed skip",
  },
  {
    name: "merge waits for the end of the review",
    file: "pull-requests/internal-review.ts",
    replacements: [["return owner.reviewState === null ||", "return true ||"]],
    testFile: ready,
    pattern: "rendered comment",
  },
  {
    name: "the assignment reviewer waits for the end of the review",
    file: "pull-requests/main.ts",
    replacements: [
      [
        "settings.data.config.review?.assignments === true && !review,",
        "settings.data.config.review?.assignments === true,",
      ],
    ],
    testFile: ready,
    pattern: "rendered comment",
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
