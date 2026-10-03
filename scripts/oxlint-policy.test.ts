import { afterEach, expect, test } from "bun:test";
// Bun has no API for creating and removing temporary directories.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
// Bun has no path manipulation API.
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function check(source: string) {
  const directory = await mkdtemp(join(tmpdir(), "operator-oxlint-"));
  directories.push(directory);
  const file = join(directory, "sample.ts");
  await Bun.write(file, source);
  const run = Bun.spawnSync(
    [
      "bunx",
      "--bun",
      "--no-install",
      "oxlint",
      "-c",
      join(root, ".oxlintrc.json"),
      "--format",
      "json",
      file,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  expect(run.stderr.toString()).toBe("");
  const result: { diagnostics: Array<{ code: string }> } = JSON.parse(run.stdout.toString());
  return { codes: result.diagnostics.map((one) => one.code), exitCode: run.exitCode };
}

test("the installed policy rejects each prohibited pattern through the real lint command", async () => {
  const result = await check(`
const asserted = (null as unknown) as { id: string };
const known = { id: "1" };
const widened: unknown = known;
const recovered = widened as { id: string };
const options = { ...(true ? { id: 1 } : {}) };
const copied = [1].reduce((acc, item) => acc.concat([item]), [] as number[]);
const spread = [1].reduce((acc, item) => [...acc, item], [] as number[]);
`);
  expect(result.exitCode).toBe(1);
  expect(result.codes).toContain("anti-slop(no-chained-type-assertions)");
  expect(result.codes).toContain("anti-slop(no-widen-then-assert)");
  expect(result.codes).toContain("anti-slop(no-conditional-empty-object-spread)");
  expect(result.codes).toContain("anti-slop(no-reduce-accumulator-copy)");
  expect(result.codes).toContain("oxc(no-accumulating-spread)");
});

test("the complexity limit is enforced and valid boundary parsing is allowed", async () => {
  const decisions = Array.from(
    { length: 31 },
    (_, index) => `if (input === ${index}) return ${index};`,
  ).join("\n");
  const excessive = await check(`function evaluate(input: number) { ${decisions} return -1; }`);
  expect(excessive.codes).toContain("eslint(complexity)");

  const valid = await check(`
export function read(value: unknown) { return typeof value === "object" ? value : null; }
export const names = [1, 2].filter((value) => value > 1).map(String);
export const item = { name: "a" } as const;
`);
  expect(valid.exitCode).toBe(0);
  expect(valid.codes).toEqual([]);
});

test("the anti-slop rules follow never-written const bindings and skip reassigned ones", async () => {
  const followed = await check(`
export const copied = [1].reduce((acc, item) => {
  const alias = acc;
  return alias.concat([item]);
}, [1].map(Number));
export function widen() {
  const { id } = { id: 1 };
  const widened: unknown = id;
  const indexed: { [key: string]: unknown } = { id: 1 };
  return [widened as number, indexed as Record<string, number>];
}
`);
  expect(followed.codes.filter((code) => code.startsWith("anti-slop"))).toEqual([
    "anti-slop(no-reduce-accumulator-copy)",
    "anti-slop(no-widen-then-assert)",
    "anti-slop(no-widen-then-assert)",
  ]);

  const reassigned = await check(`
let initial: number[] = [1];
initial = [2];
export const copied = [1].reduce((acc, item) => acc.concat([item]), initial);
export function widen() {
  let value = 1;
  value = 2;
  const widened: unknown = value;
  return widened as number;
}
`);
  expect(reassigned.codes.filter((code) => code.startsWith("anti-slop"))).toEqual([]);
});
