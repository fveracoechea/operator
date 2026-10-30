import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no recursive copy, temporary-directory, or symlink API.
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";

const source = Bun.fileURLToPath(new URL("../../", import.meta.url));
let root = "";
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-round-guards-"));
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

const rounds = "operator-cli/run.review-rounds.test.ts";

test.each([
  {
    name: "head-move limit",
    file: "review-requests/review-machine.ts",
    replacements: [["(request.headMoves ?? 0) < headMoveLimit &&", "true &&"]],
    testFile: "review-requests/review-machine.test.ts",
    pattern: "a head move counts once per observed head",
  },
  {
    name: "post at the last reviewed commit",
    file: "review-requests/post.ts",
    replacements: [
      [
        'if (request.state === "reviewing" && request.headMoves < headMoveLimit)',
        'if (request.state === "reviewing")',
      ],
    ],
    testFile: rounds,
    pattern: "the fourth move posts at the last reviewed commit",
  },
  {
    name: "one round per observation",
    file: "review-requests/review-machine.ts",
    replacements: [['facts.request?.state === "watching" ||', "true ||"]],
    testFile: rounds,
    pattern: "two simultaneous waits start one round",
  },
  {
    name: "stale flag reported once",
    file: "review-requests/watch.ts",
    replacements: [
      [
        'changed.stale = current.request?.state === "watching" && current.request.staleAt === null;',
        'changed.stale = current.request?.state === "watching";',
      ],
    ],
    testFile: rounds,
    pattern: "goes stale after seven days",
  },
  {
    name: "stale flag set once by a wait",
    file: "review-requests/rounds.ts",
    replacements: [["return facts.staleAt === null && facts.now", "return facts.now"]],
    testFile: "review-requests/rounds.test.ts",
    pattern: "goes stale at exactly seven quiet days, once",
  },
  {
    name: "stale boundary",
    file: "review-requests/rounds.ts",
    replacements: [[">= staleAfterMs", "> staleAfterMs"]],
    testFile: "review-requests/rounds.test.ts",
    pattern: "goes stale at exactly seven quiet days",
  },
  {
    name: "approved request ignores commits",
    file: "review-requests/rounds.ts",
    replacements: [['if (facts.state === "approved")', 'if (facts.state === "none")']],
    testFile: "operator-cli/run.review-approval.test.ts",
    pattern: "an approval releases the reviewer",
  },
  {
    name: "lost reply found by its marker",
    file: "review-requests/post.ts",
    replacements: [['comment.body.includes(operation.marker ?? "\\0")', "false"]],
    testFile: rounds,
    pattern: "a lost reply is found after a restart",
  },
  {
    name: "unresolve only a resolved explained thread",
    file: "review-requests/post.ts",
    replacements: [['reply.kind === "explain" && resolved', 'reply.kind === "explain"']],
    testFile: "review-requests/post.test.ts",
    pattern: "only an explanation in a resolved thread reopens it",
  },
  {
    name: "pane exit interrupts the reviewer",
    file: "device-state/launches.ts",
    replacements: [['.set({ launchState: "interrupted" })', '.set({ launchState: "running" })']],
    testFile: rounds,
    pattern: "a replacement reviewer reuses the worktree",
  },
  {
    name: "replacement keeps the reviewed head",
    file: "review-requests/main.ts",
    replacements: [["(current.request?.head ?? pr.head)", "pr.head"]],
    testFile: rounds,
    pattern: "a replacement of a watching reviewer keeps the reviewed head",
  },
  {
    name: "Operator review ends the owner's wait",
    file: "pull-requests/wait-machine.ts",
    replacements: [["!item.fromViewer || item.operatorReview", "!item.fromViewer"]],
    testFile: "operator-cli/run.reviews.test.ts",
    pattern: "an enabled assignment reviewer is queued",
  },
  {
    name: "reviewer move blocks migration",
    file: "device-state/migration-policy.ts",
    replacements: [["applied: 10,", "applied: 99,"]],
    testFile: "device-state/migration-policy.test.ts",
    pattern: "a live reviewer move or reviewer cleanup blocks an upgrade",
  },
  {
    name: "failed move retried",
    file: "review-requests/watch.ts",
    replacements: [
      [
        "if (request.sync !== null) {",
        "if (request.sync !== null && request.failureReason === null) {",
      ],
    ],
    testFile: rounds,
    pattern: "a later wait finishes it after the person cleans up",
  },
  {
    name: "renewed request answered by a later post",
    file: "review-requests/rounds.ts",
    replacements: [["after(request.createdAt, answered)", "after(request.createdAt, since)"]],
    testFile: "review-requests/rounds.test.ts",
    pattern: "a renewed request that a later post already answered",
  },
  {
    name: "no end during a live move",
    file: "review-requests/review-machine.ts",
    replacements: [["facts.ownerActive && (facts.request?.sync ?? null) !== null", "false"]],
    testFile: rounds,
    pattern: "a skip waits while a wait prompts the reviewer",
  },
  {
    name: "waits do not spin on person rows",
    file: "review-requests/watch.ts",
    replacements: [
      ['"action" in row && row.action !== "wait_reviews"', '"action" in row || "attention" in row'],
    ],
    testFile: rounds,
    pattern: "keeps unlanded reviewer work until the person removes it",
  },
  {
    name: "conversation comment must mention the reviewer",
    file: "review-requests/rounds.ts",
    replacements: [["mention.test(comment.body)", "true"]],
    testFile: rounds,
    pattern: "only author comments that mention the posting account",
  },
])(
  "a deliberate break of round guard $name makes its behavior test fail",
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
