import { prepare } from "./prepare.ts";

const breaks = [
  {
    file: "store.mts",
    search: "if (!result.ok) throw rollback;",
    replacement: "if (false) throw rollback;",
    test: "store.test.ts",
    filter: "adapter rolls back",
  },
  {
    file: "model.mts",
    search: 'evidence: "unknown", exitCode: wire.exitCode',
    replacement: 'evidence: "not-applied", exitCode: wire.exitCode',
    test: "operations.test.ts",
    filter: "boundary",
  },
  {
    file: "model.mts",
    search: "wire.exitCode !== 0",
    replacement: "false",
    test: "operations.test.ts",
    filter: "boundary",
  },
  {
    file: "cli.mts",
    search: 'if (input.action === "recover") return report("assignment", planned);',
    replacement: "",
    test: "cases.test.ts",
    filter: "plain assignment reconciles partial",
  },
  {
    file: "cli.mts",
    search: '      : "unknown";\n}',
    replacement: '      : "not-done";\n}',
    test: "cases.test.ts",
    filter: "plain assignment recovers before-effect",
  },
  {
    file: "effect-runtime.mts",
    search: "Effect.uninterruptible(Effect.sync(() => input.project(receipt)))",
    replacement: "Effect.sync(() => input.project(receipt))",
    test: "operations.test.ts",
    filter: "hide a defect",
  },
  {
    file: "neverthrow-async.mts",
    search: "transportError(cause, input.signal)",
    replacement: '({ type: "cancelled", evidence: "unknown" })',
    test: "operations.test.ts",
    filter: "neverthrow-async translates throw",
  },
];
for (const file of ["assignment.mts", "review.mts"]) {
  breaks.push(
    {
      file,
      search: "record.revision !== input.revision",
      replacement: "false",
      test: "cases.test.ts",
      filter: "stale revision",
    },
    {
      file,
      search: 'input.result.error.evidence === "not-applied"',
      replacement: "true",
      test: "cases.test.ts",
      filter: `plain ${file === "assignment.mts" ? "assignment" : "review"} CLI preserves evidence after tool`,
    },
  );
}

const root = await prepare();
for (const broken of breaks) {
  const file = `${root}/results/${broken.file}`;
  const original = await Bun.file(file).text();
  if (!original.includes(broken.search))
    throw new Error(`Missing deliberate-break target: ${broken.file} ${broken.search}`);
  await Bun.write(file, original.replace(broken.search, broken.replacement));
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        `./results/${broken.test}`,
        "--test-name-pattern",
        broken.filter,
        "--timeout=30000",
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code === 0 || !stderr.includes("expect(received)"))
      throw new Error(
        `Break was not rejected by an assertion: ${broken.file} ${broken.search}\n${stdout}\n${stderr}`,
      );
  } finally {
    await Bun.write(file, original);
  }
}
console.log(
  `Rejected ${breaks.length} deliberate breaks in scratch copies. Delivery source was not mutated.`,
);
