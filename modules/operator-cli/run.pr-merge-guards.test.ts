import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no recursive copy, temporary-directory, or symlink API.
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";

const source = Bun.fileURLToPath(new URL("../../", import.meta.url));
let root = "";
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-merge-guards-"));
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
    name: "approval is observed again before merge",
    file: "pull-requests/wait-machine.ts",
    replacements: [["approved: observed.approved,", "approved: true,"]],
    testFile: "operator-cli/run.pr-merge.test.ts",
    pattern: "every merge refusal",
  },
  {
    name: "local head before merge",
    file: "pull-requests/merge-machine.ts",
    replacements: [
      ["when: ({ observed, localHead }) => localHead !== observed.head,", "when: () => false,"],
    ],
    testFile: "operator-cli/run.pr-merge.test.ts",
    pattern: "every merge refusal",
  },
  {
    name: "closed PR",
    file: "pull-requests/merge-machine.ts",
    replacements: [['when: ({ observed }) => observed.state === "CLOSED",', "when: () => false,"]],
    testFile: "operator-cli/run.pr-merge.test.ts",
    pattern: "every merge refusal",
  },
  {
    name: "verified merged state",
    file: "pull-requests/merge-machine.ts",
    replacements: [['return observed.state === "MERGED" &&', "return true &&"]],
    testFile: "pull-requests/merge-machine.test.ts",
    pattern: "verification needs",
  },
  {
    name: "declared cleanup order",
    file: "pull-requests/cleanup-machine.ts",
    replacements: [
      [
        '["remote_branch", "pane", "worktree"] as const',
        '["pane", "remote_branch", "worktree"] as const',
      ],
    ],
    testFile: "operator-cli/run.pr-merge.test.ts",
    pattern: "failed steps stop the declared order",
  },
  {
    name: "lockfile dependency folders are preparation output",
    file: "worktree-preparation/generated.ts",
    replacements: [["installed && folder !== undefined &&", "false && folder !== undefined &&"]],
    testFile: "operator-cli/run.pr-merge.test.ts",
    pattern: "opencode: a verified merge",
  },
  {
    name: "changed environment copies are unlanded",
    file: "worktree-preparation/generated.ts",
    replacements: [
      ["approvedEnvFile(entry) && input.copiedUnchanged.has(entry)", "approvedEnvFile(entry)"],
    ],
    testFile: "operator-cli/run.pr-merge.test.ts",
    pattern: "unlanded work and unknown ignored content",
  },
  {
    name: "unknown ignored content",
    file: "pull-requests/cleanup.ts",
    replacements: [['classified.tag === "Ok" ? classified.value.unknown : ignored', "[]"]],
    testFile: "operator-cli/run.pr-merge.test.ts",
    pattern: "unlanded work and unknown ignored content",
  },
  {
    name: "landed commits",
    file: "pull-requests/cleanup.ts",
    replacements: [["landed: head !== null && ancestor?.exitCode === 0,", "landed: true,"]],
    testFile: "operator-cli/run.pr-merge.test.ts",
    pattern: "unlanded work and unknown ignored content",
  },
  {
    name: "remote branch at the merged head",
    file: "pull-requests/cleanup-machine.ts",
    replacements: [["if (facts.sha === facts.mergedHead || facts.personInstructed)", "if (true)"]],
    testFile: "operator-cli/run.pr-merge.test.ts",
    pattern: "a moved remote branch",
  },
  {
    name: "recorded checkout identity",
    file: "pull-requests/cleanup-machine.ts",
    replacements: [
      ["if (!facts.sameRepository || facts.branch !== facts.expectedBranch)", "if (false)"],
    ],
    testFile: "operator-cli/run.pr-merge.test.ts",
    pattern: "a moved remote branch",
  },
  {
    name: "recorded pane tab",
    file: "pull-requests/cleanup-machine.ts",
    replacements: [["if (facts.observed.tabId !== facts.recorded.tabId)", "if (false)"]],
    testFile: "pull-requests/cleanup-machine.test.ts",
    pattern: "only the recorded pane",
  },
  {
    name: "one cleanup process",
    file: "device-state/cleanups.ts",
    replacements: [
      ["cleanup.ownerPid !== process.pid &&\n        !ownerGone(cleanup, Date.now())", "false"],
    ],
    testFile: "device-state/cleanups.test.ts",
    pattern: "one process claims a cleanup",
  },
  {
    name: "failed cleanup in an ended source",
    file: "work-sources/main.ts",
    replacements: [
      [
        'decision.action === "retry_cleanup" || decision.action === "person_decision",',
        'decision.action === "replace_worker",',
      ],
    ],
    testFile: "operator-cli/run.pr-merge.test.ts",
    pattern: "failed steps stop the declared order",
  },
  {
    name: "unlanded work needs the person",
    file: "work-sources/assignment-machine.ts",
    replacements: [['when: ({ cleanup }) => cleanup === "unlanded_work",', "when: () => false,"]],
    testFile: "operator-cli/run.pr-merge.test.ts",
    pattern: "unlanded work and unknown ignored content",
  },
  {
    name: "merge records its cleanup",
    file: "work-sources/snapshot.ts",
    replacements: [
      ['return row.state === "merged" ? merged && cleanup : !merged && !cleanup;', "return true;"],
    ],
    testFile: "work-sources/snapshot.test.ts",
    pattern: "a merged PR assignment needs its verified merge",
  },
  {
    name: "project removal keeps an open cleanup",
    file: "device-state/projects.ts",
    replacements: [
      [
        `          detail: "End every open source before removing this project.",
        });
      if (openCleanup(db, repository)) return Err(cleanupOpen);`,
        `          detail: "End every open source before removing this project.",
        });`,
      ],
    ],
    testFile: "device-state/cleanups.test.ts",
    pattern: "an open cleanup keeps the project registered",
  },
  {
    name: "person instruction covers only the blocked step",
    file: "pull-requests/cleanup.ts",
    replacements: [
      ["request.personInstructed && step === authorized,", "request.personInstructed,"],
    ],
    testFile: "operator-cli/run.pr-merge.test.ts",
    pattern: "covers only the blocked step",
  },
  {
    name: "children of a dependency folder",
    file: "worktree-preparation/generated.ts",
    replacements: [["node_modules\\//.exec(entry)", "node_modules\\/$/.exec(entry)"]],
    testFile: "operator-cli/run.pr-merge.test.ts",
    pattern: "ignore pattern still marks dependency folders",
  },
  {
    name: "absent worktree registration and branch",
    file: "pull-requests/cleanup.ts",
    replacements: [["outcome: await forgetWorktree(facts) };", 'outcome: "absent" };']],
    testFile: "operator-cli/run.pr-merge.test.ts",
    pattern: "a moved remote branch",
  },
  {
    name: "running cleanup blocks migration",
    file: "device-state/migration-policy.ts",
    replacements: [["applied >= 7 &&", "false &&"]],
    testFile: "device-state/migration-policy.test.ts",
    pattern: "a running cleanup blocks an upgrade",
  },
])(
  "a deliberate break of merge or cleanup guard $name makes its behavior test fail",
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
