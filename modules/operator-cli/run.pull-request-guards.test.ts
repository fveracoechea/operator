import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no recursive copy, temporary-directory, or symlink API.
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";

const source = Bun.fileURLToPath(new URL("../../", import.meta.url));
let root = "";
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-pr-guards-"));
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
    name: "running owner",
    file: "pull-requests/owner.ts",
    replacements: [['owner.launchState === "running" &&', "true &&"]],
    testFile: "operator-cli/run.pull-requests.test.ts",
    pattern: "an interrupted owner needs replacement",
  },
  {
    name: "running owner in the write transaction",
    file: "device-state/pull-requests.ts",
    replacements: [['launch?.state !== "running" ||', ""]],
    testFile: "device-state/pull-requests.test.ts",
    pattern: "a replacement keeps PR open",
  },
  {
    name: "shared Git repository",
    file: "pull-requests/owner.ts",
    replacements: [["(await realOrNull(common)) === (await realOrNull(controller)) &&", ""]],
    testFile: "operator-cli/run.pull-requests.test.ts",
    pattern: "PR commands resolve only the recorded worktree",
  },
  {
    name: "controller identity",
    file: "pull-requests/owner.ts",
    replacements: [
      ['project.tag === "Ok" &&', ""],
      ["project.value.data.repository === owner.repository", "true"],
    ],
    testFile: "operator-cli/run.pull-requests.test.ts",
    pattern: "PR commands resolve only the recorded worktree",
  },
  {
    name: "recorded branch",
    file: "pull-requests/owner.ts",
    replacements: [["return head === owner.branch", "return true"]],
    testFile: "operator-cli/run.pull-requests.test.ts",
    pattern: "PR commands resolve only the recorded worktree",
  },
  {
    name: "no selector flags",
    file: "operator-cli/pull-requests.ts",
    replacements: [["} else return null;", "}"]],
    testFile: "operator-cli/run.pull-requests.test.ts",
    pattern: "PR commands resolve only the recorded worktree",
  },
  {
    name: "project repository head",
    file: "pull-requests/github.ts",
    replacements: [["pr.headRepository?.nameWithOwner.toLowerCase() === repository", "true"]],
    testFile: "operator-cli/run.pull-requests.test.ts",
    pattern: "PR commands resolve only the recorded worktree",
  },
  {
    name: "one owner for each PR",
    file: "device-state/pull-requests.ts",
    replacements: [["if (owned !== undefined)", "if (false)"]],
    testFile: "device-state/pull-requests.test.ts",
    pattern: "one PR belongs to one open assignment",
  },
  {
    name: "reported feedback",
    file: "pull-requests/wait-machine.ts",
    replacements: [["!progress.seen.includes(item.id) &&", ""]],
    testFile: "operator-cli/run.pull-requests.test.ts",
    pattern: "opencode: the owner associates",
  },
  {
    name: "reported check failures",
    file: "pull-requests/wait-machine.ts",
    replacements: [
      ['check.state === "failing" && !progress.failures', 'check.state === "failing" && ![]'],
    ],
    testFile: "operator-cli/run.pull-requests.test.ts",
    pattern: "opencode: the owner associates",
  },
  {
    name: "reported eligibility",
    file: "pull-requests/wait-machine.ts",
    replacements: [["progress.eligibleHead !== observed.head", "true"]],
    testFile: "operator-cli/run.pull-requests.test.ts",
    pattern: "opencode: the owner associates",
  },
  {
    name: "timeout attention",
    file: "work-sources/assignment-machine.ts",
    replacements: [['assignment.state === "pr-open" && pullRequest === "timed_out"', "false"]],
    testFile: "operator-cli/run.pull-requests.test.ts",
    pattern: "opencode: the owner associates",
  },
  {
    name: "PR open replacement",
    file: "device-state/launches.ts",
    replacements: [['      assignment === "pr-open" ||\n', ""]],
    testFile: "operator-cli/run.pull-requests.test.ts",
    pattern: "an interrupted owner needs replacement",
  },
  {
    name: "replacement keeps PR open",
    file: "device-state/launches.ts",
    replacements: [['inArray(assignments.state, ["ready", "reported"]),', ""]],
    testFile: "operator-cli/run.pull-requests.test.ts",
    pattern: "an interrupted owner needs replacement",
  },
  {
    name: "PR worktree for a replacement",
    file: "worker-dispatch/main.ts",
    replacements: [["(pullRequest === null ||", "(true ||"]],
    testFile: "operator-cli/run.pull-requests.test.ts",
    pattern: "a replacement after a failed replacement start",
  },
  {
    name: "missing PR worktree",
    file: "worker-dispatch/main.ts",
    replacements: [["facts.pullRequest !== null && reuse === null", "false"]],
    testFile: "operator-cli/run.pull-requests.test.ts",
    pattern: "a replacement after a failed replacement start",
  },
  {
    name: "PR branch of the waiting launch",
    file: "device-state/pull-requests.ts",
    replacements: [["if (launch.branch !== row.branch)", "if (false)"]],
    testFile: "device-state/pull-requests.test.ts",
    pattern: "a wait from a launch on another branch",
  },
  {
    name: "reported checks before eligibility",
    file: "pull-requests/wait-machine.ts",
    replacements: [["observed.checks.length > 0 &&", ""]],
    testFile: "pull-requests/wait-machine.test.ts",
    pattern: "eligibility needs all four merge conditions",
  },
  {
    name: "own replies never end a wait",
    file: "pull-requests/wait-machine.ts",
    replacements: [
      [
        "unseenFeedback(facts).some((item) => !item.fromViewer)",
        "unseenFeedback(facts).length > 0",
      ],
    ],
    testFile: "pull-requests/wait-machine.test.ts",
    pattern: "the owner's own items never end a wait alone",
  },
  {
    name: "stopped wait attention",
    file: "work-sources/assignment-machine.ts",
    replacements: [['assignment.state === "pr-open" && pullRequest === "stopped"', "false"]],
    testFile: "operator-cli/run.pull-requests.test.ts",
    pattern: "a killed wait and an idle owner",
  },
  {
    name: "stopped wait lease",
    file: "device-state/sources.ts",
    replacements: [
      ["ownerGone({ ownerPid: pr.waitOwnerPid, leaseAt: pr.waitLeaseAt }, now)", "false"],
    ],
    testFile: "operator-cli/run.pull-requests.test.ts",
    pattern: "a killed wait and an idle owner",
  },
  {
    name: "idle owner attention",
    file: "work-sources/assignment-machine.ts",
    replacements: [['(activity === "idle" || activity === "done")', "false"]],
    testFile: "operator-cli/run.pull-requests.test.ts",
    pattern: "a killed wait and an idle owner",
  },
  {
    name: "PR open blocks migration",
    file: "device-state/migration-policy.ts",
    replacements: [["'running', 'pr-open', 'reported'", "'running', 'reported'"]],
    testFile: "device-state/migration-policy.test.ts",
    pattern: "idle guards cover active assignments",
  },
])(
  "a deliberate break of PR guard $name makes its behavior test fail",
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
