import { describe, expect, test } from "bun:test";

const WORKFLOW_ROOT = new URL("../.github/workflows/", import.meta.url).pathname;

/**
 * The step bodies of one workflow, paired with the shell each one declares.
 * A step is read from its `- name:`/`- run:` marker to the next one, so a `shell:` written
 * before or after the `run:` belongs to the same step either way.
 */
function steps(workflow: string): Array<{ text: string; line: number }> {
  const lines = workflow.split("\n");
  const found: Array<{ text: string; line: number }> = [];
  let current: { text: string; line: number } | null = null;

  for (const [index, line] of lines.entries()) {
    if (/^\s*- (name|run|uses):/.test(line)) {
      if (current !== null) {
        found.push(current);
      }
      current = { text: line, line: index + 1 };
      continue;
    }
    if (current !== null) {
      current.text += `\n${line}`;
    }
  }
  if (current !== null) {
    found.push(current);
  }

  return found;
}

/**
 * The shell text one step runs.
 * The `|` that opens a YAML block is the block marker, not a pipe, and a comment is not a
 * command, so neither of them can make a step look piped when it is not.
 */
function command(step: string): string {
  const lines = step.split("\n");
  const index = lines.findIndex((line) => /^\s*run:/.test(line));
  if (index === -1) {
    return "";
  }

  const first = (lines[index] ?? "").replace(/^\s*run:[ \t]*/, "");
  const opening = /^[|>][-+]?$/.test(first.trim()) ? "" : first;
  return [opening, ...lines.slice(index + 1)].filter((line) => !/^\s*#/.test(line)).join("\n");
}

/** True when a step really pipes. A shell `||` is a choice, not a pipe, so it is not one. */
function isPiped(step: string): boolean {
  return command(step).replaceAll("||", "").includes("|");
}

async function workflows(): Promise<string[]> {
  return (await Array.fromAsync(new Bun.Glob("*.yml").scan({ cwd: WORKFLOW_ROOT }))).toSorted();
}

describe("every workflow", () => {
  test("gives every piped step a shell that fails on the left of the pipe", async () => {
    // GitHub runs a step with `bash -e` and no `pipefail`, so `tee` would answer for the
    // command it copies and a failing test run would score as a pass. `shell: bash` sets it.
    const unguarded: string[] = [];

    for (const name of await workflows()) {
      const text = await Bun.file(`${WORKFLOW_ROOT}${name}`).text();
      unguarded.push(
        ...steps(text)
          .filter((step) => isPiped(step.text) && !/^\s*shell: bash$/m.test(step.text))
          .map((step) => `${name} line ${step.line}`),
      );
    }

    expect(unguarded).toEqual([]);
  });

  test("still finds the piped steps it is meant to guard", async () => {
    // A rule that matches nothing passes on every workflow, including one that needs it.
    const piped: string[] = [];
    for (const name of await workflows()) {
      const text = await Bun.file(`${WORKFLOW_ROOT}${name}`).text();
      piped.push(
        ...steps(text)
          .filter((step) => isPiped(step.text))
          .map(() => name),
      );
    }

    expect(piped.length).toBeGreaterThan(0);
    expect([...new Set(piped)].toSorted()).toEqual(["quality.yml", "release-smoke.yml"]);
  });
});
