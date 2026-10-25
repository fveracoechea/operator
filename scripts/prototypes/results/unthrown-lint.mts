// Scratch assessment only. These settings do not select Operator lint policy.
import plugin from "@unthrown/oxlint";
// Bun has no directory creation API.
import { mkdir } from "node:fs/promises";

await mkdir("unthrown-lint", { recursive: true });
await Bun.write(
  "unthrown-lint/producer.ts",
  'import { Ok, type Result } from "unthrown"; export function produce(): Result<number, never> { return Ok(1); }',
);
await Bun.write(
  "unthrown-lint/tsconfig.json",
  JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "Bundler",
    },
    include: ["*.ts"],
  }),
);

const cases = [
  {
    name: "ambiguous-error",
    rule: "no-ambiguous-error-type",
    source: 'import type { Result } from "unthrown"; type R = Result<number, Error>;',
  },
  {
    name: "prefer-async",
    rule: "prefer-async-result",
    source: 'import type { Result } from "unthrown"; type R = Promise<Result<number, never>>;',
  },
  {
    name: "ignored-sync",
    rule: "no-unhandled-result",
    source: 'import { Ok } from "unthrown"; Ok(1);',
  },
  {
    name: "ignored-awaited",
    rule: "no-unhandled-result",
    source: 'import { OkAsync } from "unthrown"; await OkAsync(1);',
  },
  {
    name: "renamed-producer",
    rule: "no-unhandled-result",
    source: 'import { Ok as success } from "unthrown"; success(1);',
  },
  {
    name: "local-annotated",
    rule: "no-unhandled-result",
    source:
      'import { Ok, type Result } from "unthrown"; function produce(): Result<number, never> { return Ok(1); } produce();',
  },
  {
    name: "eager-race",
    rule: "no-async-result-race",
    source:
      'import { OkAsync } from "unthrown"; const first = OkAsync(1); const second = OkAsync(2); export const combined = first.flatMap(() => second);',
  },
  {
    name: "catch-all",
    rule: "no-catch-all-pattern",
    source:
      'import { Err, P } from "unthrown"; export const result = Err({ type: "refused" }).mapErrCases(m => m.with(P._, () => ({ type: "other" })));',
  },
  {
    name: "unused-matcher",
    rule: "no-unused-matcher",
    source:
      'import { Err, match } from "unthrown"; export const result = Err({ type: "refused" }).mapErrCases(m => match({ type: "other" }).with({ type: "other" }, () => ({ type: "wrong" })));',
  },
  {
    name: "unsafe-get",
    rule: "no-get-or-throw",
    source:
      'import { Err } from "unthrown"; export const result = Err({ type: "refused" }).getOrThrow();',
  },
  { name: "raw-throw", rule: "no-throw", source: 'throw new TypeError("defect");' },
  {
    name: "fresh-to-async",
    rule: "prefer-pre-lifted",
    source: 'import { Ok } from "unthrown"; export const result = Ok(1).toAsync();',
  },
];
const gaps = [
  { name: "imported-result", source: 'import { produce } from "./producer"; produce();' },
  {
    name: "dropped-chain",
    source: 'import { Ok } from "unthrown"; const result = Ok(1); result.map(x => x + 1);',
  },
  {
    name: "bound-but-never-handled",
    source: 'import { Err } from "unthrown"; const result = Err({ type: "refused" });',
  },
  {
    name: "unannotated-local",
    source: 'import { Ok } from "unthrown"; function produce() { return Ok(1); } produce();',
  },
  {
    name: "aliased-broad-error",
    source:
      'import type { Result } from "unthrown"; type Failure = Error; type R = Result<number, Failure>;',
  },
  {
    name: "native-promise-rule-misses-chain",
    source:
      'import { OkAsync } from "unthrown"; const result = OkAsync(1); result.map(x => x + 1);',
  },
];
const valid =
  'import { Ok, type Result } from "unthrown"; export function produce(): Result<number, { type: "refused" }> { return Ok(1); } export const result = produce().match({ ok: x => x, errCases: m => m.with({ type: "refused" }, () => 0), defect: () => -1 });';
const observations = [];
for (const version of ["oxlint", "oxlint-operator"]) {
  async function run(path: string, rules: Record<string, unknown>, typeAware = false) {
    const config = "unthrown-lint/config.json";
    const fullRules = Object.fromEntries(
      Object.keys(plugin.rules!).map((name) => [`unthrown/${name}`, "off"]),
    );
    await Bun.write(
      config,
      JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: plugin.recommended.jsPlugins,
        rules: { ...fullRules, ...rules },
      }),
    );
    const child = Bun.spawnSync(
      [
        process.execPath,
        `node_modules/${version}/bin/oxlint`,
        "--deny-warnings",
        ...(typeAware ? ["--type-aware"] : []),
        "--config",
        config,
        path,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    return { code: child.exitCode, output: child.stdout.toString() + child.stderr.toString() };
  }
  for (const example of cases) {
    const path = `unthrown-lint/${example.name}.ts`;
    await Bun.write(path, example.source);
    const rule = `unthrown/${example.rule}`;
    const rejected = await run(path, { [rule]: "error" });
    if (rejected.code !== 1 || !rejected.output.includes(example.rule))
      throw new Error(`${version} did not diagnose ${example.name}\n${rejected.output}`);
    const disabled = await run(path, {});
    if (disabled.code !== 0)
      throw new Error(
        `Disabled rule did not admit deliberate break ${example.name}\n${disabled.output}`,
      );
    observations.push({
      version,
      name: example.name,
      rule,
      rejected: true,
      disabledAdmits: true,
      diagnostic: rejected.output,
    });
  }
  await Bun.write("unthrown-lint/valid.ts", valid);
  const accepted = await run("unthrown-lint/valid.ts", plugin.recommended.rules!);
  if (accepted.code !== 0) throw new Error(`Valid exhaustive handler rejected\n${accepted.output}`);
  for (const example of gaps) {
    const path = `unthrown-lint/${example.name}.ts`;
    await Bun.write(path, example.source);
    const rules: Record<string, unknown> = { ...plugin.recommended.rules };
    const typeAware = example.name === "native-promise-rule-misses-chain";
    if (typeAware)
      rules["typescript/no-floating-promises"] = [
        "error",
        { checkThenables: true, ignoreVoid: false },
      ];
    const result = await run(path, rules, typeAware);
    if (result.code !== 0)
      throw new Error(`Documented gap changed for ${example.name}\n${result.output}`);
    observations.push({ version, name: example.name, rejected: false });
  }
}
console.log(JSON.stringify({ unthrownLint: observations }));
