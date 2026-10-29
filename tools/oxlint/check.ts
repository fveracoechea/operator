import { afterAll, beforeAll } from "bun:test";
// Bun has no recursive copy, temporary directory, or directory removal API.
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

const sourceRoot = new URL("../../", import.meta.url).pathname;
const oxlint = `${sourceRoot}node_modules/oxlint/bin/oxlint`;
const diagnosticSchema = z.object({
  diagnostics: z.array(
    z.object({
      code: z.string(),
      filename: z.string(),
      labels: z.array(z.object({ span: z.object({ line: z.number() }) })),
    }),
  ),
});

function finding(diagnostic: z.infer<typeof diagnosticSchema>["diagnostics"][number]): string {
  // Stryker disable next-line OptionalChaining: no rule: a diagnostic without a label is reported on line 0, and no probe produces one
  return `${diagnostic.labels[0]?.span.line ?? 0} ${diagnostic.code}`;
}

// Each test file owns a checkout. No deliberate violation enters the working tree.
export function lintProject() {
  let root: string;
  // Puts back the file the previous probe replaced, or removes the probe it added.
  let restore: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "operator-lint-"));
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
    await rm(root, { recursive: true });
  });
  return async function check(
    source: string,
    options: { path?: string; files?: Record<string, string> } = {},
  ) {
    await restore?.();
    const probe = options.path ?? "lib/lint-probe.ts";
    const file = Bun.file(`${root}/${probe}`);
    const original = (await file.exists()) ? await file.text() : null;
    restore = async () => {
      await (original === null ? file.delete() : Bun.write(file, original));
    };
    // One-line examples need the policy's blank line after imports, with no behavior fixes.
    const spaced = source.replaceAll(/(from ["'][^"']+["'];)\s*/gu, "$1\n\n");
    await Bun.write(file, spaced);
    for (const [path, text] of Object.entries(options.files ?? {})) {
      await Bun.write(`${root}/${path}`, text);
    }
    // Only the probe files are linted with the repository policy. The rest of the copy is
    // context for imports and types, so a mutation sandbox's instrumented source is not a finding.
    const linted = [probe, ...Object.keys(options.files ?? {})];
    const flags = ["--deny-warnings", "--format", "json"];
    // One process runs the pinned Oxlint, so the time limit stops a rule that never returns.
    const child = Bun.spawn([process.execPath, oxlint, ...flags, ...linted], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
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
      // Each finding names the probe line, so one lint run can prove many cases.
      findings: parsed.diagnostics
        .filter((diagnostic) => diagnostic.filename === probe)
        .map(finding),
      stderr,
      stdout,
    };
  };
}
