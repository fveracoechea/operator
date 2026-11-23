import { defineRule, type ESTree, type SourceCode, type Variable } from "@oxlint/plugins";
import { z } from "zod";
import { normalizeProjectConfig, type ProjectConfig } from "./configuration.ts";
import { applicationEntry, bindingOf, memberName, unwrapExpression } from "./project.ts";

const guidance = new URL("../docs/module-interface.md", import.meta.url).href;

function localMember(
  source: SourceCode,
  node: ESTree.MemberExpression,
  seen: Set<Variable>,
): ESTree.Node {
  const name = memberName(node);
  if (name === undefined) return node;
  const object = resolved(source, node.object, seen);
  if (object.type !== "ObjectExpression") return node;
  // Later members override earlier ones. Unknown spreads, keys and getters stay opaque.
  for (const property of object.properties.toReversed()) {
    if (property.type !== "Property") return node;
    const candidate = memberName(property);
    if (candidate === undefined) return node;
    if (candidate === name)
      return property.kind === "init" ? resolved(source, property.value, seen) : node;
  }
  return node;
}

function resolved(source: SourceCode, input: ESTree.Node, seen = new Set<Variable>()): ESTree.Node {
  const node = unwrapExpression(input);
  if (node.type === "MemberExpression") return localMember(source, node, seen);
  if (node.type !== "Identifier") return node;
  const binding = bindingOf(source, node);
  if (!binding || seen.has(binding)) return node;
  seen.add(binding);
  for (const definition of binding.defs) {
    if (definition.type === "FunctionName") return definition.node;
    if (definition.node.type === "VariableDeclarator" && definition.node.init)
      return resolved(source, definition.node.init, seen);
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
  if (node.type === "UnaryExpression" && (node.operator === "-" || node.operator === "+")) {
    const argument = resolved(source, node.argument);
    return (
      argument.type === "Literal" &&
      z.union([z.number(), z.bigint()]).safeParse(argument.value).success
    );
  }
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
