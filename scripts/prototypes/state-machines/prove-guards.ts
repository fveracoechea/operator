// Bun has no recursive copy, temporary directory, symlink, or directory removal API.
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";

type Break = { file: string; search: string; replacement: string; test: string; filter?: string };
const breaks: Break[] = [];

for (const design of ["reducer", "table"]) {
  for (const [search, replacement] of [
    ['state.operation.status !== "idle"', "false"],
    ["!facts.approved", "false"],
    ['facts.checks !== "pass"', "false"],
    ["!facts.threadsResolved", "false"],
    ["!facts.defaultBase", "false"],
    ['state.phase !== "ready"', "false"],
    ["!facts.dependenciesReady", "false"],
    ['state.completion !== "pr" || state.phase !== "running"', "false"],
    ['facts.actor !== "superagent"', "false"],
    ["state.followUp !== null", "false"],
    ['state.phase !== "reported" || state.followUp === null', "false"],
    ['facts.observation === "unknown"', "false"],
    ['facts.observation === "done"', "false"],
    ["!facts.safeToRemove", "false"],
  ]) {
    const pendingTable = design === "table" && search === 'state.operation.status !== "idle"';
    breaks.push({
      file: `assignment/${design}.ts`,
      search: pendingTable ? 'input.state.operation.status === "idle"' : search!,
      replacement: pendingTable ? "true" : replacement!,
      test: `assignment/${design}.test.ts`,
    });
  }
  for (const workflow of ["assignment", "review"]) {
    const key =
      workflow === "assignment"
        ? design === "reducer"
          ? "op.key"
          : "state.operation.key"
        : design === "reducer"
          ? "op.effect.key"
          : "state.operation.effect.key";
    const op = design === "reducer" || workflow === "assignment" ? "op" : "state.operation";
    for (const search of [
      `event.key !== ${key}`,
      `${op}.status !== "pending"`,
      `${op}.status !== "failed"`,
    ]) {
      // The table's assignment retry uses a local op, while its result row narrows state directly.
      let target =
        workflow === "assignment" && design === "table" && search === 'op.status !== "pending"'
          ? 'state.operation.status !== "pending"'
          : search;
      if (
        workflow === "review" &&
        design === "table" &&
        search === 'state.operation.status !== "failed"'
      )
        target = 'op.status !== "failed"';
      breaks.push({
        file: `${workflow}/${design}.ts`,
        search: target,
        replacement: "false",
        test: `${workflow}/${design}.test.ts`,
      });
    }
  }
  for (const search of [
    'state.operation.status !== "idle"',
    'state.phase !== "reviewing"',
    "!facts.draftValid",
    'facts.origin === "assignment"',
    "facts.ownPr",
    "event.strongBreach",
    "event.blockers > 0",
    "facts.failingCI",
    'state.phase !== "queued"',
    'facts.activity === "none"',
    'state.phase === "approved" && facts.activity !== "renewed"',
    '["closed", "skipped"].includes(state.phase)',
    'facts.observation === "unknown"',
    'facts.observation === "done"',
  ]) {
    const pendingTable = design === "table" && search === 'state.operation.status !== "idle"';
    breaks.push({
      file: `review/${design}.ts`,
      search: pendingTable ? 'input.state.operation.status === "idle"' : search,
      replacement: pendingTable ? "true" : "false",
      test: `review/${design}.test.ts`,
    });
  }
  breaks.push({
    file: `review/${design}.ts`,
    search: design === "reducer" ? "state.headMoves < 3" : "state.headMoves >= 3",
    replacement: design === "reducer" ? "false" : "true",
    test: `review/${design}.test.ts`,
  });
  breaks.push({
    file: `assignment/${design}.ts`,
    search: 'gate.status === "refused"',
    replacement: "false",
    test: `assignment/${design}.test.ts`,
  });
  breaks.push({
    file: `review/${design}.ts`,
    search: 'next.status === "refused"',
    replacement: "false",
    test: `review/${design}.test.ts`,
  });
  breaks.push({
    file: `review/${design}.ts`,
    search: "`review:${state.round}:${state.headMoves}:${event.head}`",
    replacement: "`review:${state.round}`",
    test: `review/${design}.test.ts`,
  });
}

breaks.push(
  {
    file: "state-machine.ts",
    search: "for (const rule of rules)",
    replacement: "for (const rule of rules.toReversed())",
    test: "state-machine.test.ts",
  },
  {
    file: "state-machine.ts",
    search: "result !== undefined",
    replacement: "Boolean(result)",
    test: "state-machine.test.ts",
  },
  {
    file: "assignment/model.ts",
    search: "if (facts.safeToRemove)",
    replacement: "if (true)",
    test: "assignment/table.test.ts",
  },
  {
    file: "assignment/model.ts",
    search: '"reported", "completed", "abandoned"',
    replacement: '"reported", "completed", "abandoned", "merged"',
    test: "assignment/model.test.ts",
  },
  {
    file: "review/model.ts",
    search: '"skipped"',
    replacement: '"skipped", "stale"',
    test: "review/model.test.ts",
  },
  {
    file: "assignment/main.ts",
    search: "record.revision === revision",
    replacement: "true",
    test: "assignment/main.test.ts",
  },
  {
    file: "review/main.ts",
    search: "record.revision === revision",
    replacement: "true",
    test: "review/main.test.ts",
  },
  {
    file: "cli.ts",
    search: "if (!request.success)",
    replacement: "if (false)",
    test: "cli.test.ts",
    filter: "closed events",
  },
  {
    file: "cli.ts",
    search: "!/^\\/tmp\\/opencode\\/operator-236-[^/]+$/.test(root)",
    replacement: "false",
    test: "cli.test.ts",
    filter: "named scratch root",
  },
);

const root = await mkdtemp("/tmp/opencode/operator-236-guard-proof-");
const experiment = `${root}/repo/scripts/prototypes/state-machines`;
try {
  await mkdir(`${root}/repo`, { recursive: true });
  await cp(import.meta.dir, experiment, { recursive: true });
  const sourceRoot = new URL("../../../", import.meta.url).pathname;
  await symlink(`${sourceRoot}/node_modules`, `${root}/repo/node_modules`);
  await symlink(`${sourceRoot}/modules`, `${root}/repo/modules`);
  let killed = 0;
  for (const mutation of breaks) {
    const path = `${experiment}/${mutation.file}`;
    const original = await Bun.file(path).text();
    if (!original.includes(mutation.search))
      throw new Error(`Stale deliberate break: ${mutation.file}: ${mutation.search}`);
    await Bun.write(path, original.replaceAll(mutation.search, mutation.replacement));
    try {
      const args = [
        process.execPath,
        "test",
        "--isolate",
        "--timeout=30000",
        `${experiment}/${mutation.test}`,
      ];
      if (mutation.filter) args.push("--test-name-pattern", mutation.filter);
      const child = Bun.spawn(args, { cwd: `${root}/repo`, stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (code !== 1 || !`${stdout}${stderr}`.includes("error: expect(")) {
        throw new Error(
          `Break survived or failed without an assertion: ${mutation.file}: ${mutation.search}\n${stdout}${stderr}`,
        );
      }
      killed++;
      console.log(`Rejected ${mutation.file}: ${mutation.search}`);
    } finally {
      await Bun.write(path, original);
    }
  }
  console.log(
    `${killed}/${breaks.length} deliberate breaks rejected by assertions. The delivery checkout was not mutated.`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
