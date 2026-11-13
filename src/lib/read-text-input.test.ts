import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no temporary directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { readTextInput } from "./read-text-input.ts";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp("/tmp/opencode/read-text-input-");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("a file preserves UTF-8 text and shell punctuation without trimming", async () => {
  const file = `${directory}/input.md`;
  await Bun.write(file, "  café `a.ts` $HOME 'quoted'\nsecond line\n");
  expect(await readTextInput(file)).toBe("  café `a.ts` $HOME 'quoted'\nsecond line\n");
  await expect(readTextInput(`${directory}/missing.md`)).rejects.toThrow();
});

test("a dash reads stdin instead of a file named dash", async () => {
  await Bun.write(`${directory}/-`, "Not stdin.");
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import { readTextInput } from ${JSON.stringify(import.meta.resolve("./read-text-input.ts"))}; await Bun.write(Bun.stdout, await readTextInput("-"));`,
    ],
    {
      cwd: directory,
      stdin: new Blob(["  stdin café `file` $HOME\nsecond line\n"]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, stdout, stderr }).toEqual({
    code: 0,
    stdout: "  stdin café `file` $HOME\nsecond line\n",
    stderr: "",
  });
});
