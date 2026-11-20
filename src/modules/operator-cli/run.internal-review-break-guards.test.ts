import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no recursive copy, temporary-directory, or symlink API.
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";

const source = Bun.fileURLToPath(new URL("../../../", import.meta.url));
let root = "";
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-internal-review-guards-"));
  for (const file of [
    "src",

    "tools",
    "skills",

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
    file: "worker-kinds/pr-policy.ts",
    replacements: [["return facts.changed;", "return false;"]],
    testFile: guards,
    pattern: "associate refuses a ready PR",
    assertion: "pr_worktree_unclean",
  },
  {
    name: "review-local clean worktree",
    file: "pull-requests/internal-review-machine.ts",
    replacements: [
      [
        'when: (facts) =>\n      (facts.internalReview || !facts.draft) &&\n      WorkerKinds.refusesPrGuard({ guard: "worktree_clean", changed: facts.changed }),',
        "when: () => false,",
      ],
    ],
    testFile: "pull-requests/internal-review-machine.test.ts",
    pattern: "with internal review on, each unready PR",
  },
  {
    name: "implementer pane closed",
    file: "pull-requests/internal-review-machine.ts",
    replacements: [["closePane: !facts.reviewerStarted && live", "closePane: false && live"]],
    testFile: flow,
    pattern: "hands implementation to review",
  },
  {
    name: "handed-off launch refused",
    file: "worker-kinds/pr-policy.ts",
    replacements: [
      [
        'if (facts.guard === "ownership") return facts.handedOff;',
        'if (facts.guard === "ownership") return false;',
      ],
    ],
    testFile: guards,
    pattern: "a failed handoff shows",
    assertion: "pr_handed_off",
  },
  {
    name: "shared ownership policy",
    file: "worker-kinds/pr-policy.ts",
    replacements: [
      [
        'if (facts.guard === "ownership") return facts.handedOff;',
        'if (facts.guard === "ownership") return false;',
      ],
    ],
    testFile: "worker-kinds/pr-policy.test.ts",
    pattern: "PR ownership remains with a launch only before handoff",
    behaviorFailure: true,
  },
  {
    name: "review-local handed-off launch refused",
    file: "pull-requests/internal-review-machine.ts",
    replacements: [
      [
        'return WorkerKinds.refusesPrGuard({ guard: "ownership", handedOff: facts.implementer })',
        "return false",
      ],
    ],
    testFile: "pull-requests/internal-review-machine.test.ts",
    pattern: "each round refusal names its reason",
    consumerFailure: [
      "expect(received).toMatchObject(expected)",
      '"result": "refused"',
      '"result": "round"',
      "pr_handed_off",
      "internal-review-machine.test.ts:",
    ],
  },
  {
    name: "shared round policy",
    file: "worker-kinds/pr-policy.ts",
    replacements: [
      [
        'if (facts.guard === "round") return facts.rounds >= 2;',
        'if (facts.guard === "round") return facts.rounds >= 3;',
      ],
    ],
    testFile: "worker-kinds/pr-policy.test.ts",
    pattern: "the PR round policy refuses round count 2: true",
    behaviorFailure: true,
  },
  {
    name: "two rounds",
    file: "worker-kinds/pr-policy.ts",
    replacements: [
      [
        'if (facts.guard === "round") return facts.rounds >= 2;',
        'if (facts.guard === "round") return facts.rounds >= 3;',
      ],
    ],
    testFile: flow,
    pattern: "at most two rounds",
    assertion: "internal_review_round_limit",
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
    replacements: [['handoff.handoffState !== "done" &&', 'handoff.handoffState === "done" &&']],
    testFile: flow,
    pattern: "hands implementation to review",
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
    replacements: [["handoff.ownerPid !== afterPid", "true"]],
    testFile: "device-state/pull-requests.test.ts",
    pattern: "takes over its hold",
  },
  {
    name: "handoff blocks migration",
    file: "device-state/migration-policy.ts",
    replacements: [["applied: 16,", "applied: 99,"]],
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
    file: "worker-kinds/pr-policy.ts",
    replacements: [["return facts.changed;", "return false;"]],
    testFile: ready,
    pattern: "rendered comment",
    assertion: "pr_worktree_unclean",
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
    replacements: [
      [
        'when: (facts) => facts.review.state !== "skipped" && unknown(facts).length > 0,',
        "when: () => false,",
      ],
    ],
    testFile: "pull-requests/internal-review-machine.test.ts",
    pattern: "refuses the ready step",
  },
  {
    name: "a summary decides each finding once",
    file: "pull-requests/internal-review-machine.ts",
    replacements: [
      [
        'when: (facts) => facts.review.state !== "skipped" && repeated(facts).length > 0,',
        "when: () => false,",
      ],
    ],
    testFile: "pull-requests/internal-review-machine.test.ts",
    pattern: "refuses the ready step",
  },
  {
    name: "every finding has a disposition",
    file: "pull-requests/internal-review-machine.ts",
    replacements: [
      [
        'when: (facts) => facts.review.state !== "skipped" && undecided(facts).length > 0,',
        "when: () => false,",
      ],
    ],
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
    name: "merge waits for the ready transition",
    file: "pull-requests/internal-review.ts",
    replacements: [["return owner.readiness !== null;", "return true;"]],
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
    const file = `${root}/src/modules/${change.file}`;
    const original = await Bun.file(file).text();
    let changed = original;
    for (const [before, after] of change.replacements) {
      expect(original).toContain(before);
      if (change.behaviorFailure || change.assertion !== undefined)
        expect(original.split(before)).toHaveLength(2);
      if (change.consumerFailure) expect(original.split(before)).toHaveLength(2);
      changed = changed.replace(before, after);
    }
    expect(changed).not.toBe(original);
    async function story() {
      const child = Bun.spawn(
        [
          process.execPath,
          "run",
          "test",
          `src/modules/${change.testFile}`,
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
      return { code, stdout, stderr };
    }
    try {
      if (change.assertion !== undefined) {
        const intact = await story();
        const output = `${intact.stdout}${intact.stderr}`;
        console.info(`${change.name} with intact consumer:\n${output}`);
        expect(intact.code, output).toBe(0);
        expect(output).toContain(change.pattern);
        expect(output).toContain(`src/modules/${change.testFile}`);
        expect(output).toContain("1 pass");
        expect(output).toContain("0 fail");
        expect(output).toContain("Ran 1 test across 1 file.");
        expect(output).not.toContain("(fail)");
        expect(output).not.toContain("Unhandled error");
      }
      await Bun.write(file, changed);
      const { code, stdout, stderr } = await story();
      expect(code, `${stdout}${stderr}`).toBe(1);
      expect(`${stdout}${stderr}`).toContain("(fail)");
      expect(`${stdout}${stderr}`).toContain(change.pattern);
      if (change.consumerFailure) {
        const output = `${stdout}${stderr}`;
        expect(output).toContain(`(fail) ${change.pattern}`);
        expect(output).toContain("0 pass");
        expect(output).toContain("1 fail");
        for (const evidence of change.consumerFailure) expect(output).toContain(evidence);
      }
      if (change.behaviorFailure) {
        const output = `${stdout}${stderr}`;
        console.info(`${change.name}:\n${output}`);
        expect(output).toContain(`(fail) ${change.pattern}`);
        expect(output).toContain("expect(received).toBe(expected)");
        expect(output).toContain("Expected: true");
        expect(output).toContain("Received: false");
        expect(output).toContain("pr-policy.test.ts:");
        expect(output).toContain("0 pass");
        expect(output).toContain("1 fail");
        expect(output).not.toContain("Unhandled error");
      }
      if (change.assertion !== undefined) {
        const output = `${stdout}${stderr}`;
        console.info(`${change.name}:\n${output}`);
        expect(output).toContain("1 fail");
        expect(output).toContain("error: expect(received).toMatchObject(expected)");
        expect(output).toMatch(new RegExp(`-\\s+"reason": "${change.assertion}"`));
        expect(output).toMatch(
          new RegExp(`at .*\\(.*${change.testFile.replaceAll(".", "\\.")}:\\d+:\\d+\\)`),
        );
        expect(output).not.toContain("Unhandled error");
      }
    } finally {
      await Bun.write(file, original);
    }
  },
  180000,
);
