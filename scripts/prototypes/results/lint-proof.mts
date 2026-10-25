// Bun has no directory creation API.
import { mkdir } from "node:fs/promises";

// These are assessment settings in scratch, not a selection of production lint policy.
const config = {
  categories: { correctness: "off" },
  options: { typeAware: true },
  rules: {
    "typescript/no-floating-promises": ["error", { checkThenables: true, ignoreVoid: false }],
    "no-restricted-properties": [
      "error",
      { property: "_unsafeUnwrap", message: "Unchecked extraction bypasses Result handling." },
      { property: "_unsafeUnwrapErr", message: "Unchecked extraction bypasses Result handling." },
      { property: "getOrThrow", message: "Unchecked extraction bypasses Result handling." },
    ],
  },
};
await mkdir("lint-fixtures", { recursive: true });
await Bun.write("lint-assessment.json", JSON.stringify(config));
await Bun.write(
  "lint-fixtures/tsconfig.json",
  JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "Bundler",
      types: ["bun"],
    },
    include: ["*.ts"],
  }),
);
const cases = [
  {
    name: "floating-promise",
    reject: true,
    source: 'import { ok } from "neverthrow"; async function run() { return ok(1); } run();',
  },
  {
    name: "floating-thenable",
    reject: true,
    source: 'import { okAsync } from "neverthrow"; okAsync(1);',
  },
  { name: "ignored-sync-result", reject: false, source: 'import { ok } from "neverthrow"; ok(1);' },
  {
    name: "ignored-awaited-result",
    reject: false,
    source: 'import { okAsync } from "neverthrow"; await okAsync(1);',
  },
  {
    name: "unsafe-neverthrow",
    reject: true,
    source: 'import { ok } from "neverthrow"; ok(1)._unsafeUnwrap();',
  },
  {
    name: "unsafe-effect",
    reject: true,
    source: 'import * as Result from "effect/Result"; Result.getOrThrow(Result.succeed(1));',
  },
  {
    name: "handled-result",
    reject: false,
    source:
      'import { okAsync } from "neverthrow"; (await okAsync(1)).match(console.log, console.error);',
  },
];
for (const example of cases) {
  const path = `lint-fixtures/${example.name}.ts`;
  await Bun.write(path, example.source);
  const check = Bun.spawnSync(
    [
      process.execPath,
      "node_modules/oxlint/bin/oxlint",
      "--type-aware",
      "--deny-warnings",
      "--config",
      "lint-assessment.json",
      path,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const output = check.stdout.toString() + check.stderr.toString();
  if (example.reject ? check.exitCode !== 1 || !output.includes("error") : check.exitCode !== 0) {
    throw new Error(`Unexpected lint assessment for ${example.name}: ${check.exitCode}\n${output}`);
  }
}
console.log(
  JSON.stringify({ lintAssessment: cases.map(({ name, reject }) => ({ name, rejected: reject })) }),
);
