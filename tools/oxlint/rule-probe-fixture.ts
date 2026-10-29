import { afterAll, beforeAll } from "bun:test";
// Bun has no temporary directory, directory removal, or path manipulation API.
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

const sourceRoot = path.join(import.meta.dir, "../..");
const oxlint = path.join(sourceRoot, "node_modules/oxlint/bin/oxlint");
const diagnosticSchema = z.object({
  diagnostics: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      labels: z.array(z.object({ span: z.object({ line: z.number() }) })),
    }),
  ),
});

/**
 * Runs Oxlint on one probe file with a probe plugin that calls lint helpers directly.
 * `imports` names the helpers by absolute path. `visitor` is an object literal whose handlers
 * call `report(node, value)`. Each report comes back as `line value`, with the value as JSON.
 */
export function ruleProbe() {
  let root = "";
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "operator-rule-probe-"));
    await symlink(path.join(sourceRoot, "node_modules"), path.join(root, "node_modules"));
    await Bun.write(
      path.join(root, ".oxlintrc.json"),
      JSON.stringify({
        plugins: [],
        categories: { correctness: "off" },
        jsPlugins: [{ name: "probe", specifier: "./plugin.ts" }],
        rules: { "probe/probe": "error" },
      }),
    );
  });
  afterAll(async () => {
    if (root) await rm(root, { force: true, recursive: true });
  });
  return async function probe(probe: {
    imports: string;
    visitor: string;
    code: string;
  }): Promise<string[]> {
    await Bun.write(
      path.join(root, "plugin.ts"),
      `import { defineRule, eslintCompatPlugin } from "@oxlint/plugins";
${probe.imports}
export default eslintCompatPlugin({
  meta: { name: "probe" },
  rules: {
    probe: defineRule({
      meta: { messages: { value: "{{value}}" } },
      createOnce(context) {
        const report = (node, value) =>
          context.report({ node, messageId: "value", data: { value: JSON.stringify(value) } });
        return ${probe.visitor};
      },
    }),
  },
});
`,
    );
    await Bun.write(path.join(root, "probe.ts"), probe.code);
    const child = Bun.spawn(
      [process.execPath, oxlint, "-c", ".oxlintrc.json", "--format", "json", "probe.ts"],
      { cwd: root, stdout: "pipe", stderr: "inherit" },
    );
    // A plugin that fails to load leaves no JSON report, so the parse fails the probe.
    const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return diagnosticSchema
      .parse(JSON.parse(stdout))
      .diagnostics.filter((diagnostic) => diagnostic.code === "probe(probe)")
      .map((diagnostic) => `${diagnostic.labels[0]?.span.line ?? 0} ${diagnostic.message}`);
  };
}
