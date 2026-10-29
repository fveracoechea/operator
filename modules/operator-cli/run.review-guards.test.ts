import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no recursive copy, temporary-directory, or symlink API.
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";

const source = Bun.fileURLToPath(new URL("../../", import.meta.url));
let root = "";
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-review-guards-"));
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

test.each([
  {
    name: "live head",
    file: "review-requests/draft.ts",
    replacements: [["draft.reviewedCommit === commit", "true"]],
    testFile: "operator-cli/run.reviews.test.ts",
    pattern: "draft refusals post nothing",
  },
  {
    name: "guard break evidence",
    file: "review-requests/draft.ts",
    replacements: [['check.kind === "guard-break" && check.exitCode === 0', "false"]],
    testFile: "operator-cli/run.reviews.test.ts",
    pattern: "draft refusals post nothing",
  },
  {
    name: "finding on a changed file",
    file: "review-requests/draft.ts",
    replacements: [["pr.filesComplete && !pr.files.includes(finding.path)", "false"]],
    testFile: "operator-cli/run.reviews.test.ts",
    pattern: "draft refusals post nothing",
  },
  {
    name: "noise on a changed file",
    file: "review-requests/draft.ts",
    replacements: [[".find((file) => pr.files.includes(file));", ".find(() => false);"]],
    testFile: "operator-cli/run.reviews.test.ts",
    pattern: "required CI failures are blockers",
  },
  {
    name: "required CI failure as blocker",
    file: "review-requests/draft.ts",
    replacements: [['check.state === "failing" && !noise.has(check.name)', "false"]],
    testFile: "operator-cli/run.reviews.test.ts",
    pattern: "required CI failures are blockers",
  },
  {
    name: "own PR and assignment comment",
    file: "review-requests/review-body.ts",
    replacements: [['facts.ownPullRequest || facts.origin === "assignment"', "false"]],
    testFile: "operator-cli/run.reviews.test.ts",
    pattern: "except on the posting account's own PR",
  },
  {
    name: "approval with a blocker",
    file: "review-requests/review-body.ts",
    replacements: [
      ['return event === "APPROVE" && countBlockers(facts.accepted) > 0;', "return false;"],
    ],
    testFile: "review-requests/review-body.test.ts",
    pattern: "approval with an open blocker is refused",
  },
  {
    name: "registered repository",
    file: "review-requests/review-machine.ts",
    replacements: [["when: (facts) => !facts.registered,", "when: () => false,"]],
    testFile: "operator-cli/run.reviews.test.ts",
    pattern: "an unregistered or closed PR is refused",
  },
  {
    name: "concurrent post",
    file: "review-requests/review-machine.ts",
    replacements: [['facts.request?.state === "posting" && facts.ownerActive', "false"]],
    testFile: "operator-cli/run.reviews.test.ts",
    pattern: "two simultaneous posts reach GitHub once",
  },
  {
    name: "repeated post",
    file: "review-requests/review-machine.ts",
    replacements: [
      ['["queued", "reviewing"].includes', '["queued", "reviewing", "watching"].includes'],
    ],
    testFile: "operator-cli/run.reviews.test.ts",
    pattern: "the event follows blockers",
  },
  {
    name: "live reviewer start",
    file: "review-requests/review-machine.ts",
    replacements: [['return request?.launchState === "starting" && ownerActive;', "return false;"]],
    testFile: "review-requests/review-machine.test.ts",
    pattern: "a start holds the request",
  },
  {
    name: "lost answer reconciliation",
    file: "review-requests/post.ts",
    replacements: [["if (found !== undefined)", "if (false)"]],
    testFile: "operator-cli/run.reviews.test.ts",
    pattern: "a lost answer is found",
  },
  {
    name: "recorded round on retry",
    file: "review-requests/post.ts",
    replacements: [["decided.value.retry === true", "false"]],
    testFile: "operator-cli/run.reviews.test.ts",
    pattern: "records the review on GitHub, not an edited draft",
  },
  {
    name: "no stale resend after a lost post",
    file: "review-requests/post.ts",
    replacements: [['pr.state !== "OPEN" || pr.head !== round.reviewedCommit', "false"]],
    testFile: "operator-cli/run.reviews.test.ts",
    pattern: "a lost post on a moved head returns to the reviewer",
  },
  {
    name: "one path spelling",
    file: "review-requests/draft.ts",
    replacements: [
      ['.transform((value) => path.posix.normalize(value).replace(/^\\.\\//, ""));', ";"],
    ],
    testFile: "operator-cli/run.reviews.test.ts",
    pattern: "cannot hide a changed file behind another spelling",
  },
  {
    name: "approval waits for required CI",
    file: "review-requests/review-body.ts",
    replacements: [
      ["(facts.accepted.pendingChecks.length > 0 || !facts.accepted.checksComplete)", "false"],
    ],
    testFile: "operator-cli/run.reviews.test.ts",
    pattern: "a pending required check or an incomplete check list does not approve",
  },
  {
    name: "remote with the GitHub identity",
    file: "worker-dispatch/reviewer.ts",
    replacements: [["          remote,\n", '          "origin",\n']],
    testFile: "operator-cli/run.reviews.test.ts",
    pattern: "fetches from the remote that has the GitHub identity",
  },
  {
    name: "reused worktree at the PR head",
    file: "worker-dispatch/reviewer.ts",
    replacements: [
      [
        'if ((await git(path, ["rev-parse", "HEAD"])) === input.head) return Ok(path);',
        "return Ok(path);",
      ],
    ],
    testFile: "operator-cli/run.reviews.test.ts",
    pattern: "a start retry moves a clean recorded worktree",
  },
  {
    name: "reviewer worktree at the PR head",
    file: "worker-dispatch/reviewer.ts",
    replacements: [["label: name, base: input.head }", "label: name }"]],
    testFile: "operator-cli/run.reviews.test.ts",
    pattern: "a manual request reviews the PR repository",
  },
  {
    name: "assignment reviewer off by default",
    file: "pull-requests/main.ts",
    replacements: [["settings.data.config.review?.assignments === true", "true"]],
    testFile: "operator-cli/run.reviews.test.ts",
    pattern: "an enabled assignment reviewer is queued",
  },
  {
    name: "active reviewer blocks migration",
    file: "device-state/migration-policy.ts",
    replacements: [["WHERE state = 'reviewing' LIMIT 1", "WHERE state = 'none' LIMIT 1"]],
    testFile: "device-state/migration-policy.test.ts",
    pattern: "active reviewers, live reviewer starts",
  },
])(
  "a deliberate break of review guard $name makes its behavior test fail",
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
  120000,
);
