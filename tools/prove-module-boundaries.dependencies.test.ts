import { afterAll, expect, test } from "bun:test";
// Bun has no recursive copy, temporary directory, symlink or directory removal API.
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

const checkout = path.resolve(import.meta.dir, "..");
const root = await mkdtemp(path.join(tmpdir(), "operator-boundary-dependencies-"));
afterAll(() => rm(root, { recursive: true, force: true }));

test("the copied actual lint command ignores linked dependencies but still checks every probe location", async () => {
  const copy = path.join(root, "copy");
  for (const entry of [
    "src",
    "tools",
    "packages",
    "package.json",
    "tsconfig.json",
    ".oxlintrc.json",
    ...(await Array.fromAsync(new Bun.Glob("*.ts").scan({ cwd: checkout }))),
  ])
    await cp(path.join(checkout, entry), path.join(copy, entry), { recursive: true });
  await symlink(path.join(checkout, "node_modules"), path.join(copy, "node_modules"));
  const dependency = path.join(root, "dependency");
  await Bun.write(path.join(dependency, "broken.ts"), "this is not valid TypeScript !!!");
  await Bun.write(path.join(copy, "vendor/keep.txt"), "");
  await symlink(dependency, path.join(copy, "vendor/node_modules"));
  const probes = {
    "module-boundary-probe-dependencies.config.ts":
      'export const rootValue: unknown = Reflect.get({}, "root");\n',
    "packages/deep-modules/src/module-boundary-probe-dependencies.ts":
      'export const packageValue: unknown = Reflect.get({}, "package");\n',
    "src/modules/module-boundary-probe-dependencies/main.ts":
      'export const Probe = { run() { const value: unknown = Reflect.get({}, "module"); return String(value); } };\n',
  };
  for (const [filename, text] of Object.entries(probes))
    await Bun.write(path.join(copy, filename), text);
  expect(await Bun.file(path.join(copy, ".gitignore")).exists()).toBe(false);
  const child = Bun.spawn([process.execPath, "run", "lint", "--format", "json"], {
    cwd: copy,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, timedOut: child.signalCode, stderr }).toMatchObject({
    code: 1,
    timedOut: null,
  });
  const report = z
    .object({
      diagnostics: z.array(
        z.object({
          filename: z.string(),
          code: z.string(),
          labels: z.array(z.object({ span: z.object({ line: z.number() }) })),
        }),
      ),
    })
    .parse(JSON.parse(stdout));
  expect(report.diagnostics.some((finding) => finding.filename.includes("node_modules"))).toBe(
    false,
  );
  const findings = report.diagnostics.flatMap((finding) =>
    finding.labels.map((label) => `${finding.filename}:${label.span.line} ${finding.code}`),
  );
  expect(findings.toSorted()).toEqual(
    Object.keys(probes)
      .map((filename) => `${filename}:1 anti-slop(no-reflect-get)`)
      .sort(),
  );
}, 40_000);
