// Bun has no chmod API.
import { chmod } from "node:fs/promises";
import { z } from "zod";

/** The full commit that the fake Git reports for every upstream repository. */
export const upstreamCommit = "a".repeat(40);

/**
 * Writes fake `git` and `bun` commands to `<root>/tools`, so a command test that puts only that
 * folder on PATH reaches no network and no real upstream installer. Each clone holds the skill
 * folders that the matching upstream repository has, with the owned `bun` among Matt's skills,
 * and the fake installer confirms every selected skill. Each installer call appends its
 * arguments as one JSON line to `<root>/upstream-calls.jsonl`.
 */
export async function writeUpstreamTools(root: string) {
  const folders = {
    "https://github.com/mattpocock/skills.git": ["skills/code-review", "skills/bun", "skills/tdd"],
    "https://github.com/cursor/plugins.git": ["pstack/skills/unslop"],
    "https://github.com/humanlayer/skills.git": ["plugins/show-me/skills/show-me"],
  };
  const tools = {
    git: `const a = process.argv.slice(2);
if (a[0] === "clone") {
  for (const folder of ${JSON.stringify(folders)}[a.at(-2)] ?? [])
    await Bun.write(a.at(-1) + "/" + folder + "/SKILL.md", "---\\nname: " + folder.split("/").at(-1) + "\\n---\\n", { createPath: true });
} else console.log(${JSON.stringify(upstreamCommit)});`,
    bun: `const a = process.argv.slice(2);
const calls = Bun.file(${JSON.stringify(`${root}/upstream-calls.jsonl`)});
await Bun.write(calls, ((await calls.exists()) ? await calls.text() : "") + JSON.stringify(a) + "\\n");
console.log(JSON.stringify(a.slice(a.indexOf("--skill") + 1, -2).map((name) => ({ name, status: "installed" }))));`,
  };
  for (const [name, source] of Object.entries(tools)) {
    await Bun.write(`${root}/tools/${name}`, `#!${process.execPath}\n${source}\n`, {
      createPath: true,
    });
    await chmod(`${root}/tools/${name}`, 0o755);
  }
}

/** The installer calls that the fake `bun` recorded, in order. */
export async function upstreamCalls(root: string) {
  const file = Bun.file(`${root}/upstream-calls.jsonl`);
  if (!(await file.exists())) return [];
  return (await file.text())
    .trim()
    .split("\n")
    .map((line): string[] => z.array(z.string()).parse(JSON.parse(line)));
}
