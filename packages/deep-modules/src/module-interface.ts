import { defineRule, type ESTree, type SourceCode, type Variable } from "@oxlint/plugins";
// Portable plugin loading runs under Node as well as Bun.
import path from "node:path";
import { normalizeProjectConfig, type ProjectConfig } from "./configuration.ts";

const guidance = new URL("../docs/module-interface.md", import.meta.url).href;

function applicationEntry(filename: string, config: ProjectConfig): boolean {
  if (
    config.exclusions.some(
      (excluded) => filename === excluded || filename.startsWith(`${excluded}${path.sep}`),
    )
  )
    return false;
  if (config.libraryRoots.some((root) => filename.startsWith(`${root}${path.sep}`))) return false;
  return config.moduleRoots.some((root) => {
    const parts = path.relative(root, filename).split(path.sep);
    return parts.length === 2 && parts[0] !== ".." && config.objectEntries.includes(parts[1] ?? "");
  });
}

function unwrap(node: ESTree.Node): ESTree.Node {
  while (
    node.type === "ParenthesizedExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSTypeAssertion" ||
    node.type === "TSNonNullExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "ChainExpression"
  )
    node = node.expression;
  return node;
}

function resolved(source: SourceCode, input: ESTree.Node, seen = new Set<Variable>()): ESTree.Node {
  const node = unwrap(input);
  if (node.type !== "Identifier") return node;
  let scope = source.getScope(node);
  while (scope) {
    const binding = scope.set.get(node.name);
    if (!binding) {
      if (!scope.upper) return node;
      scope = scope.upper;
      continue;
    }
    if (seen.has(binding)) return node;
    seen.add(binding);
    for (const definition of binding.defs) {
      if (definition.type === "FunctionName") return definition.node;
      if (definition.node.type === "VariableDeclarator" && definition.node.init)
        return resolved(source, definition.node.init, seen);
    }
    return node;
  }
  return node;
}

function callable(node: ESTree.Node): boolean {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "TSDeclareFunction" ||
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression"
  );
}

function dataValue(source: SourceCode, input: ESTree.Node, seen = new Set<ESTree.Node>()): boolean {
  const node = resolved(source, input);
  if (seen.has(node)) return false;
  seen.add(node);
  if (node.type === "Literal") return true;
  if (node.type === "ArrayExpression")
    return node.elements.every((item) => item === null || dataValue(source, item, new Set(seen)));
  if (node.type === "ObjectExpression")
    return node.properties.every(
      (item) =>
        item.type === "Property" &&
        item.kind === "init" &&
        !item.method &&
        dataValue(source, item.value, new Set(seen)),
    );
  return false;
}

function exportedValues(
  node: ESTree.ExportNamedDeclaration,
): { name: string; value: ESTree.Node }[] {
  const declaration = node.declaration;
  if (declaration?.type === "VariableDeclaration")
    return declaration.declarations.flatMap((item) =>
      item.id.type === "Identifier" && item.init ? [{ name: item.id.name, value: item.init }] : [],
    );
  if (declaration?.type === "FunctionDeclaration" || declaration?.type === "TSDeclareFunction")
    return [{ name: declaration.id?.name ?? "", value: declaration }];
  if (node.exportKind === "type" || node.source) return [];
  return node.specifiers
    .filter((item) => item.exportKind !== "type")
    .map((item) => ({
      name: item.exported.type === "Identifier" ? item.exported.name : String(item.exported.value),
      value: item.local,
    }));
}

export const moduleInterfaceRule = defineRule({
  meta: {
    schema: [],
    docs: { url: guidance },
    messages: {
      operation: `Expose application operations on one named PascalCase interface object. See ${guidance}.`,
      interface: `Export one named PascalCase application interface object, with constants and caller-facing types alongside it. See ${guidance}.`,
      configuration: `Invalid deep-modules configuration: {{detail}}. See ${guidance}.`,
    },
  },
  createOnce(context) {
    return {
      Program(node) {
        let config: ProjectConfig;
        try {
          config = normalizeProjectConfig(context.settings, context.cwd);
        } catch (error) {
          context.report({
            node,
            messageId: "configuration",
            data: { detail: error instanceof Error ? error.message : "Invalid settings" },
          });
          return;
        }
        if (!applicationEntry(context.filename, config)) return;
        let interfaces = 0;
        let dataObjects = 0;
        function checkValue(name: string, input: ESTree.Node) {
          if (name === "default") context.report({ node: input, messageId: "interface" });
          const value = resolved(context.sourceCode, input);
          if (callable(value)) context.report({ node: input, messageId: "operation" });
          if (value.type !== "ObjectExpression") return;
          const named = /^[A-Z][A-Za-z0-9]*$/.test(name);
          const data = dataValue(context.sourceCode, value);
          if (data) {
            if (named && value.properties.length > 0) dataObjects++;
          } else interfaces++;
          if (!named && !data) context.report({ node: input, messageId: "interface" });
        }

        for (const statement of node.body) {
          if (
            statement.type === "ExportDefaultDeclaration" ||
            statement.type === "ExportAllDeclaration"
          )
            context.report({ node: statement, messageId: "interface" });
          if (statement.type !== "ExportNamedDeclaration") continue;
          for (const item of exportedValues(statement)) checkValue(item.name, item.value);
        }
        if (interfaces > 1 || (interfaces === 0 && dataObjects === 0))
          context.report({ node, messageId: "interface" });
      },
    };
  },
});
