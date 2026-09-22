import { describe, expect, test } from "bun:test";

const WORKFLOW = new URL("../.github/workflows/quality.yml", import.meta.url).pathname;

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

describe("the quality workflow", () => {
  test("gives every piped step a shell that fails on the left of the pipe", async () => {
    const workflow = await Bun.file(WORKFLOW).text();
    // GitHub runs a step with `bash -e` and no `pipefail`, so `tee` would answer for the
    // command it copies and a failing test run would score as a pass. `shell: bash` sets it.
    const unguarded = steps(workflow).filter(
      (step) => /^\s*run:.*\|/m.test(step.text) && !/^\s*shell: bash$/m.test(step.text),
    );

    expect(unguarded.map((step) => `line ${step.line}`)).toEqual([]);
  });
});
