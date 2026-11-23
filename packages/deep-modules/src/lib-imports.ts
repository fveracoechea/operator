import { defineRule } from "@oxlint/plugins";
import { normalizeProjectConfig, type ProjectConfig } from "./configuration.ts";
import { contains, excluded, importVisitors, resolveProjectImport } from "./project.ts";

const guidance = new URL("../docs/lib-imports.md", import.meta.url).href;

export const libImportsRule = defineRule({
  meta: {
    schema: [],
    docs: { url: guidance },
    messages: {
      dependency: `Library code must not import project application or tooling code, including types. See ${guidance}.`,
      configuration: `Invalid deep-modules configuration: {{detail}}. See ${guidance}.`,
    },
  },
  createOnce(context) {
    let config: ProjectConfig | undefined;
    return {
      Program(node) {
        config = undefined;
        try {
          config = normalizeProjectConfig(context.settings, context.cwd);
        } catch (error) {
          context.report({
            node,
            messageId: "configuration",
            data: { detail: error instanceof Error ? error.message : "Invalid settings" },
          });
        }
      },
      ...importVisitors(context, (node, specifier) => {
        if (!config || excluded(context.filename, config)) return;
        if (!config.libraryRoots.some((root) => contains(root, context.filename))) return;
        const target = resolveProjectImport(context.filename, specifier, config);
        if (target && !config.libraryRoots.some((root) => contains(root, target)))
          context.report({ node, messageId: "dependency" });
      }),
    };
  },
});
