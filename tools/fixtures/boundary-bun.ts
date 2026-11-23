// Bun has no recursive directory copy, directory listing or mkdir API.
import { cp, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const diagnostics = [
  "deep-modules(module-imports)",
  "every module requires one public interface",
  "requires a corresponding behavior beside-test",
  "child/main.ts: every module requires one public interface",
  "deep-modules(module-interface)",
  "production files must be inside a feature module",
  "production TypeScript must live",
  "deep-modules(lib-imports)",
  "deep-modules(public-collaborator-mocks)",
  "deep-modules(query-options-owner)",
  "deep-modules(synchronous-selectors)",
  "import(no-cycle)",
  "is not assignable to type 'number'",
  "anti-slop(no-reflect-get)",
];
const [log, wrongRun, faultText, action, check] = process.argv.slice(2);
if (!log || !faultText || action !== "run" || !check) process.exit(9);
const fault = z
  .object({
    files: z.array(z.string()).optional(),
    rule: z.string().optional(),
    kind: z.string().optional(),
  })
  .parse(JSON.parse(faultText));
const n = (await readdir(log)).length + 1;
const call = path.join(log, String(n));
await mkdir(call);
await Bun.write(path.join(call, "check"), check);
await Bun.write(path.join(call, "root"), path.basename(process.cwd()) + "\n");
await cp(".", path.join(call, "tree"), { recursive: true });
if (String(n) === wrongRun) {
  console.log(`fake ${check} output`);
  console.error("unrelated diagnostic");
  process.exit(1);
}
const probes = [];
for await (const filename of new Bun.Glob("**/*").scan({ dot: true })) {
  if (
    !filename.startsWith("node_modules/") &&
    filename.includes("probe") &&
    !filename.includes("-valid-")
  )
    probes.push(filename);
}
if (probes.length === 0) {
  console.log(`fake ${check} output`);
  process.exit(0);
}
if (check === "lint") {
  const findings = [];
  for (const filename of probes) {
    for (const rule of diagnostics.filter((item) => item.includes("("))) {
      const finding = {
        code: rule,
        filename,
        labels: [{ span: { line: 1 } }, { span: { line: 2 } }],
      };
      const normalized = filename.replaceAll(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
        "ID",
      );
      if (fault.files?.includes(normalized) && rule === fault.rule) {
        if (fault.kind === "file") finding.filename = "unrelated.test.ts";
        else if (fault.kind === "line") finding.labels = [{ span: { line: 999 } }];
        else finding.code = "unrelated(rule)";
      }
      findings.push(finding);
    }
  }
  console.log(JSON.stringify({ diagnostics: findings }));
} else {
  console.log(`fake ${check} output`);
  console.error([...diagnostics, ...probes].join("\n"));
}
process.exit(1);
