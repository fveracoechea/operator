import { defineRule } from "@oxlint/plugins";
import { normalizeProjectConfig, type ProjectConfig } from "./configuration.ts";
import {
  contains,
  discoverOwners,
  excluded,
  importVisitors,
  privateImport,
  resolveProjectImport,
} from "./project.ts";

const guidance = new URL("../docs/module-imports.md", import.meta.url).href;

export const moduleImportsRule = defineRule({
  meta: {
    schema: [],
    docs: { url: guidance },
    messages: {
      private: `Import the owning module's public entry, not private implementation or a private child. See ${guidance}.`,
      configuration: `Invalid deep-modules configuration: {{detail}}. See ${guidance}.`,
    },
  },
  createOnce(context) {
    let config: ProjectConfig | undefined;
    let owners = new Set<string>();
    // One invocation analyzes a fixed consumer tree. Include all normalized settings in the key
    // so a second project or configuration cannot reuse the first project's ownership.
    let ownershipKey: string | undefined;
    return {
      Program(node) {
        config = undefined;
        try {
          config = normalizeProjectConfig(context.settings, context.cwd);
          const key = JSON.stringify(config);
          if (key !== ownershipKey) {
            owners = discoverOwners(config);
            ownershipKey = key;
          }
        } catch (error) {
          config = undefined;
          context.report({
            node,
            messageId: "configuration",
            data: { detail: error instanceof Error ? error.message : "Invalid settings" },
          });
        }
      },
      ...importVisitors(context, (node, specifier) => {
        if (!config || excluded(context.filename, config)) return;
        if (config.libraryRoots.some((root) => contains(root, context.filename))) return;
        const target = resolveProjectImport(context.filename, specifier, config);
        if (target && privateImport(context.filename, target, config, owners))
          context.report({ node, messageId: "private" });
      }),
    };
  },
});
