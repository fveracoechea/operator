import { defineRule, type ESTree, type SourceCode, type Variable } from "@oxlint/plugins";
// Bun has no relative-path API.
import path from "node:path";
import { z } from "zod";
import {
  arrayMethodTarget,
  constInitializer,
  resolveArrayBinding,
  unwrapArrayExpression,
} from "../anti-slop/array-method.ts";

function processImport(variable: Variable) {
  return variable.defs.some(
    (definition) =>
      definition.type === "ImportBinding" &&
      definition.parent?.type === "ImportDeclaration" &&
      ["node:process", "process"].includes(String(definition.parent.source.value)),
  );
}

function environmentHost(
  source: SourceCode,
  input: ESTree.Node,
  seen = new Set<Variable>(),
): boolean {
  const node = unwrapArrayExpression(input);
  if (node.type === "MetaProperty")
    return node.meta.name === "import" && node.property.name === "meta";
  const member = arrayMethodTarget(node);
  if (
    member !== null &&
    ["process", "Bun"].includes(member.name) &&
    member.object.type === "Identifier" &&
    member.object.name === "globalThis"
  )
    return true;
  if (node.type !== "Identifier") return false;
  const variable = resolveArrayBinding(source, node);
  if (variable === null || variable.defs.length === 0)
    return ["process", "Bun"].includes(node.name);
  if (processImport(variable)) return true;
  if (seen.has(variable)) return false;
  seen.add(variable);
  const initial = constInitializer(variable);
  return initial !== null && environmentHost(source, initial, seen);
}

const optionsSchema = z.object({ allowFiles: z.array(z.string()) });

export const envThroughSchemaRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Read environment values through the validated owner." },
    schema: [
      {
        type: "object",
        properties: { allowFiles: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ allowFiles: [] }],
    messages: {
      environment:
        "Read validated values from Environment. Supply child environments, never change the parent. See deep-modules/server-state.md.",
    },
  },
  createOnce(context) {
    function allowed() {
      const options = optionsSchema.parse(context.options[0]);
      return options.allowFiles.includes(path.relative(context.cwd, context.filename));
    }
    function destructures(node: ESTree.Node, input: ESTree.Node | null) {
      if (
        allowed() ||
        input === null ||
        node.type !== "ObjectPattern" ||
        !environmentHost(context.sourceCode, input)
      )
        return;
      if (
        node.properties.some(
          (property) =>
            property.type === "Property" &&
            (property.key.type === "Identifier"
              ? property.key.name === "env"
              : property.key.type === "Literal" && property.key.value === "env"),
        )
      )
        context.report({ node, messageId: "environment" });
    }
    return {
      MemberExpression(node) {
        const member = arrayMethodTarget(node);
        if (
          !allowed() &&
          member?.name === "env" &&
          environmentHost(context.sourceCode, member.object)
        )
          context.report({ node, messageId: "environment" });
      },
      VariableDeclarator(node) {
        destructures(node.id, node.init);
      },
      AssignmentExpression(node) {
        destructures(node.left, node.right);
      },
      ImportDeclaration(node) {
        if (
          !allowed() &&
          ["node:process", "process"].includes(String(node.source.value)) &&
          node.specifiers.some(
            (specifier) =>
              specifier.type === "ImportSpecifier" &&
              (specifier.imported.type === "Identifier"
                ? specifier.imported.name
                : specifier.imported.value) === "env",
          )
        )
          context.report({ node, messageId: "environment" });
      },
    };
  },
});
