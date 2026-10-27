import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no recursive copy, temporary-directory, or symlink API.
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";

const source = Bun.fileURLToPath(new URL("../../", import.meta.url));
let root = "";
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-dispatch-guards-"));
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
    name: "single reservation",
    file: "device-state/launches.ts",
    replacements: [["!dispatchable(assignment?.state, latest?.state, abandoned)", "false"]],
    testFile: "device-state/launches.test.ts",
    pattern: "a reservation starts the assignment once",
  },
  {
    name: "approved environment file names",
    file: "worktree-preparation/env-files.ts",
    replacements: [["/^\\.env(?:\\.[^/]+)?\\.local$/", "/^\\.env/"]],
    testFile: "worktree-preparation/env-files.test.ts",
    pattern: "only local environment overrides",
  },
  {
    name: "approved environment file selection",
    file: "worktree-preparation/env-files.ts",
    replacements: [["/^\\.env(?:\\.[^/]+)?\\.local$/", "/^\\.env/"]],
    extra: {
      file: "worktree-preparation/main.ts",
      before: '":(glob)**/.env*.local"',
      after: '":(glob)**/.env*"',
    },
    testFile: "operator-cli/run.dispatch.test.ts",
    pattern: "worktree work prepares",
  },
  {
    name: "existing destinations",
    file: "worktree-preparation/env-files.ts",
    replacements: [
      ["if ((await entry(destination)) !== null) {", "if (false) {"],
      ["constants.COPYFILE_EXCL", "0"],
    ],
    testFile: "operator-cli/run.dispatch.test.ts",
    pattern: "preparation preserves existing files",
  },
  {
    name: "linked environment files",
    file: "worktree-preparation/env-files.ts",
    replacements: [["source === null || !source.isFile()", "source === null"]],
    testFile: "operator-cli/run.dispatch.test.ts",
    pattern: "preparation preserves existing files",
  },
  {
    name: "installed plugin",
    file: "worker-dispatch/main.ts",
    replacements: [["reason === null\n        ? Ok(undefined)", "true\n        ? Ok(undefined)"]],
    testFile: "operator-cli/run.dispatch.test.ts",
    pattern: "refusals before reservation",
  },
  {
    name: "preparation before start",
    file: "worker-dispatch/main.ts",
    replacements: [
      ["if (placement.worktreePath === null) return OkAsync(null);", "return OkAsync(null);"],
    ],
    testFile: "operator-cli/run.dispatch.test.ts",
    pattern: "worktree work prepares",
  },
  {
    name: "recorded launch failure",
    file: "worker-dispatch/main.ts",
    replacements: [['    state: "failed",\n    failureReason', "    failureReason"]],
    testFile: "operator-cli/run.dispatch.test.ts",
    pattern: "a failed launch stays visible",
  },
  {
    name: "collision suffix",
    file: "worker-dispatch/names.ts",
    replacements: [["!input.takenNames.has(name) &&", ""]],
    testFile: "operator-cli/run.dispatch.test.ts",
    pattern: "collisions get a suffix",
  },
  {
    name: "unrecorded plugin",
    file: "worker-dispatch/hooks.ts",
    replacements: [["linked !== null && linked !== wanted", "false"]],
    testFile: "operator-cli/run.dispatch.test.ts",
    pattern: "never replaces an unrecorded plugin",
  },
  {
    name: "pane end interruption",
    file: "worker-dispatch/hooks.ts",
    replacements: [['name === "pane.exited" || name === "pane.closed"', "false"]],
    testFile: "operator-cli/run.dispatch.test.ts",
    pattern: "a pane exit interrupts",
  },
  {
    name: "Herdr server scope",
    file: "device-state/launches.ts",
    replacements: [
      [
        "input.socket === null ? isNull(launches.herdrSocket) : eq(launches.herdrSocket, input.socket),",
        "isNull(launches.endedAt),",
      ],
    ],
    testFile: "operator-cli/run.dispatch.test.ts",
    pattern: "a pane exit interrupts",
  },
  {
    name: "shipped plugin manifest",
    file: "operator-release/build.ts",
    replacements: [
      [
        "// Herdr links this manifest from device state, and its hooks call the global command.\n  await Bun.write(",
        "// The manifest is not shipped.\n  await (async (..._ignored: unknown[]) => {})(",
      ],
    ],
    testFile: "operator-release/main.test.ts",
    pattern: "ships runnable ESM",
  },
  {
    name: "active launch migration guard",
    file: "device-state/migration-policy.ts",
    replacements: [["WHERE state = 'running' LIMIT 1", "WHERE state = 'none' LIMIT 1"]],
    testFile: "device-state/migration-policy.test.ts",
    pattern: "live launches and running preparations",
  },
  {
    name: "abandoned start",
    file: "device-state/sources.ts",
    replacements: [
      ['abandoned: launch.state === "starting" && ownerGone(launch, now),', "abandoned: false,"],
    ],
    testFile: "operator-cli/run.dispatch.test.ts",
    pattern: "a killed dispatch is abandoned",
  },
  {
    name: "stop signal record",
    file: "worker-dispatch/main.ts",
    replacements: [["process.once(signal, handler);", ""]],
    testFile: "operator-cli/run.dispatch.test.ts",
    pattern: "a stop signal during dispatch",
  },
  {
    name: "start window pane exit",
    file: "device-state/launches.ts",
    replacements: [
      ['inArray(launches.state, ["starting", "running"]),', 'eq(launches.state, "running"),'],
    ],
    testFile: "operator-cli/run.dispatch.test.ts",
    pattern: "a pane that ends during the start",
  },
  {
    name: "reopened worktree preparation",
    file: "worker-dispatch/main.ts",
    replacements: [
      ['if (read.value?.state === "prepared") return Ok(read.value.detail);', 'return Ok("");'],
    ],
    testFile: "operator-cli/run.dispatch.test.ts",
    pattern: "a replacement prepares a reopened worktree",
  },
  {
    name: "Herdr session",
    file: "worker-dispatch/main.ts",
    replacements: [["return socket === undefined", "return false"]],
    testFile: "operator-cli/run.dispatch.test.ts",
    pattern: "dispatch outside a Herdr session",
  },
  {
    name: "current plugin manifest",
    file: "worker-dispatch/main.ts",
    replacements: [["(await linked.text()) === released", "true"]],
    testFile: "operator-cli/run.dispatch.test.ts",
    pattern: "dispatch outside a Herdr session",
  },
  {
    name: "event without state",
    file: "operator-cli/run.ts",
    replacements: [["if (await herdrEventWithoutState(args, paths, json)) return false;", ""]],
    testFile: "operator-cli/run.dispatch.test.ts",
    pattern: "a Herdr event on a device without state",
  },
  {
    name: "dependency folder exclusion",
    file: "worktree-preparation/main.ts",
    replacements: [['":(exclude,glob)**/node_modules/**",', ""]],
    testFile: "operator-cli/run.dispatch.test.ts",
    pattern: "worktree work prepares",
  },
])(
  "a deliberate break of dispatch guard $name makes its behavior test fail",
  async (change) => {
    const file = `${root}/modules/${change.file}`;
    const original = await Bun.file(file).text();
    let changed = original;
    for (const [before, after] of change.replacements) {
      expect(original).toContain(before);
      changed = changed.replace(before, after);
    }
    const extra = "extra" in change ? change.extra : undefined;
    const extraFile = extra === undefined ? null : `${root}/modules/${extra.file}`;
    const extraOriginal = extraFile === null ? "" : await Bun.file(extraFile).text();
    if (extra !== undefined) expect(extraOriginal).toContain(extra.before);
    try {
      await Bun.write(file, changed);
      if (extraFile !== null && extra !== undefined)
        await Bun.write(extraFile, extraOriginal.replace(extra.before, extra.after));
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
      if (extraFile !== null) await Bun.write(extraFile, extraOriginal);
    }
  },
  120000,
);
