import { afterAll, beforeAll } from "bun:test";
// Bun has no recursive copy, temporary directory, or directory removal API.
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { z } from "zod";

const sourceRoot = new URL("../../", import.meta.url).pathname;
const diagnosticSchema = z.object({
  diagnostics: z.array(z.object({ code: z.string() })),
});

// Each test file owns a checkout. No deliberate violation enters the working tree.
export function lintProject() {
  let root = "";
  let previous = "";
  beforeAll(async () => {
    root = await mkdtemp("/tmp/opencode/operator-lint-");
    for (const entry of [
      "cli.ts",
      "modules",
      "lib",
      "scripts",
      "tools",
      "package.json",
      "tsconfig.json",
      ".oxlintrc.json",
    ]) {
      await cp(`${sourceRoot}${entry}`, `${root}/${entry}`, { recursive: true });
    }
    await symlink(`${sourceRoot}node_modules`, `${root}/node_modules`);
  });
  afterAll(async () => {
    if (root) await rm(root, { force: true, recursive: true });
  });
  return async function check(
    source: string,
    options: { path?: string; files?: Record<string, string> } = {},
  ) {
    if (previous) await rm(`${root}/${previous}`, { force: true });
    previous = options.path ?? "lib/lint-probe.ts";
    // One-line examples need the policy's blank line after imports, with no behavior fixes.
    const spaced = source.replaceAll(/(from ["'][^"']+["'];)\s*/gu, "$1\n\n");
    await Bun.write(`${root}/${previous}`, spaced, { createPath: true });
    for (const [path, text] of Object.entries(options.files ?? {})) {
      await Bun.write(`${root}/${path}`, text, { createPath: true });
    }
    const child = Bun.spawn([process.execPath, "run", "lint", "--format", "json"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const parsed = diagnosticSchema.parse(JSON.parse(stdout));
    return {
      exitCode,
      codes: parsed.diagnostics.map((diagnostic) => diagnostic.code),
      stderr,
      stdout,
    };
  };
}
