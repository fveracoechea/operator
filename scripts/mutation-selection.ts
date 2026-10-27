// Bun has no path, directory listing, or real-path API.
import path from "node:path";
import { readdir, realpath } from "node:fs/promises";
import { excludedUnit, suppressionErrors } from "./mutation-policy.ts";

type Range = { start: number; end: number };
type Arguments = { paths: string[]; since?: string };
type Problem = { error: string };
export type MutationUnit = { name: string; source: string; tests: string[]; patterns: string[] };

export function parseMutationArgs(args: string[]): Arguments | Problem {
  const paths: string[] = [];
  let since: string | undefined;
  let positional = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (!positional && arg === "--") positional = true;
    else if (!positional && arg === "--since") {
      const ref = args[++index];
      if (since || !ref || ref.startsWith("-"))
        return { error: "--since needs one explicit Git ref." };
      since = ref;
    } else if (!positional && arg.startsWith("-")) return { error: `Unknown option: ${arg}` };
    else paths.push(arg);
  }
  return paths.length > 0 || since
    ? { paths, since }
    : { error: "Select a unit or --since <ref>." };
}

export function changedRanges(diff: string): Range[] {
  const ranges: Range[] = [];
  for (const [, line, count] of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const length = count === undefined ? 1 : Number(count);
    if (length > 0) ranges.push({ start: Number(line), end: Number(line) + length - 1 });
  }
  return ranges;
}

function unsafePath(name: string): boolean {
  return (
    name === ".." ||
    name.startsWith("../") ||
    /(?:^|\/)(?:\.operator|node_modules|\.git)(?:\/|$)/.test(name)
  );
}

async function checkedPath(root: string, selected: string): Promise<string | Problem> {
  const absolute = path.resolve(root, selected);
  const name = path.relative(root, absolute);
  if (unsafePath(name) || name.includes("\\"))
    return { error: `Target is outside eligible repository code: ${selected}` };
  if (!(await Bun.file(absolute).exists()))
    return { error: `Target file does not exist: ${selected}` };
  // A link above the repository root, such as the macOS /var link, is not part of the target.
  if ((await realpath(absolute)) !== path.join(await realpath(root), name))
    return { error: `Target must not use a symbolic link: ${selected}` };
  return name;
}

async function unitForTest(root: string, test: string): Promise<string | undefined> {
  let stem = test.slice(0, -".test.ts".length);
  while (true) {
    const unit = `${stem}.ts`;
    if (await Bun.file(path.join(root, unit)).exists()) return unit;
    if (!path.basename(stem).includes(".")) return undefined;
    stem = stem.slice(0, stem.lastIndexOf("."));
  }
}

async function besideTests(root: string, unit: string): Promise<string[] | Problem> {
  const directory = path.dirname(unit);
  const tests: string[] = [];
  for (const name of await readdir(path.join(root, directory))) {
    if (!name.endsWith(".test.ts")) continue;
    const test = path.join(directory, name);
    if ((await unitForTest(root, test)) !== unit) continue;
    const checked = await checkedPath(root, test);
    if (typeof checked !== "string") return checked;
    tests.push(`./${checked}`);
  }
  return tests.toSorted();
}

function git(root: string, args: string[]): string | Problem {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0
    ? result.stdout.toString()
    : { error: `Git selection failed: ${result.stderr.toString().trim()}` };
}

function changedFiles(root: string, ref: string): Map<string, Range[] | undefined> | Problem {
  const verified = git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  if (typeof verified !== "string") return verified;
  const commit = verified.trim();
  const names = git(root, [
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    commit,
    "--",
  ]);
  if (typeof names !== "string") return names;
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (typeof untracked !== "string") return untracked;
  const files = new Map<string, Range[] | undefined>();
  for (const name of names.split("\0").filter(Boolean)) {
    if (unsafePath(name) || excludedUnit(name)) continue;
    const diff = git(root, [
      "diff",
      "--unified=0",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      commit,
      "--",
      `:(literal)${name}`,
    ]);
    if (typeof diff !== "string") return diff;
    const ranges = changedRanges(diff);
    if (ranges.length > 0) files.set(name, ranges);
  }
  for (const name of untracked.split("\0").filter(Boolean)) {
    if (!unsafePath(name) && !excludedUnit(name)) files.set(name, undefined);
  }
  return files;
}

async function explicitFiles(root: string, paths: string[]): Promise<Set<string> | Problem> {
  const units = new Set<string>();
  for (const selected of paths) {
    const checked = await checkedPath(root, selected);
    if (typeof checked !== "string") return checked;
    const unit = checked.endsWith(".test.ts") ? await unitForTest(root, checked) : checked;
    if (!unit) return { error: `No unit for ${selected}` };
    units.add(unit);
  }
  return units;
}

export async function selectMutationUnits(
  args: Arguments,
  root: string,
): Promise<{ units: MutationUnit[]; skipped: number } | Problem> {
  const explicit = await explicitFiles(root, args.paths);
  if (!(explicit instanceof Set)) return explicit;
  const changed = args.since ? changedFiles(root, args.since) : undefined;
  if (changed && !(changed instanceof Map)) return changed;
  const candidates = changed ?? new Map([...explicit].map((name) => [name, undefined]));
  const units: MutationUnit[] = [];
  let skipped = 0;
  for (const [name, ranges] of candidates) {
    if (changed && explicit.size > 0 && !explicit.has(name)) continue;
    if (excludedUnit(name)) {
      skipped++;
      continue;
    }
    const checked = await checkedPath(root, name);
    if (typeof checked !== "string") return checked;
    const prepared = await prepareUnit(root, name, ranges);
    if (prepared === "skipped") {
      skipped++;
      continue;
    }
    if ("error" in prepared) return prepared;
    units.push(prepared);
  }
  return { units, skipped };
}

async function prepareUnit(
  root: string,
  name: string,
  ranges: Range[] | undefined,
): Promise<MutationUnit | Problem | "skipped"> {
  const source = await Bun.file(path.join(root, name)).text();
  const errors = suppressionErrors(source);
  if (errors.length > 0)
    return {
      error: errors
        .map(
          (line) =>
            `${name}:${line}: suppression requires equivalent: or no rule: with an explanation.`,
        )
        .join("\n"),
    };
  if (source.split(/\r?\n/, 1)[0] === "// Stryker disable all: no logic") return "skipped";
  const tests = await besideTests(root, name);
  if (!Array.isArray(tests)) return tests;
  // Stryker normalizes backslashes, so use character classes for literal glob characters.
  const escaped = name.replaceAll(/[*?[\]{}()!+@]/g, (character) => `[${character}]`);
  return {
    name,
    source,
    tests,
    patterns: ranges ? ranges.map(({ start, end }) => `${escaped}:${start}-${end}`) : [escaped],
  };
}
