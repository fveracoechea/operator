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
import { withSkillTopic } from "../skill-topic.ts";

function processImport(variable: Variable) {
  return variable.defs.some(
    (definition) =>
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
  // The only meta properties are import.meta and new.target.
  if (node.type === "MetaProperty") return node.meta.name === "import";
  const member = arrayMethodTarget(node);
  if (
    member !== null &&
    ["process", "Bun"].includes(member.name) &&
    source.getText(member.object) === "globalThis"
  )
    return true;
  // Only an identifier resolves to a binding, and only an identifier's text names a global.
  const variable = resolveArrayBinding(source, node);
  if (!variable?.defs.length) return ["process", "Bun"].includes(source.getText(node));
  if (processImport(variable)) return true;
  if (seen.has(variable)) return false;
  seen.add(variable);
  const initial = constInitializer(variable);
  return initial !== null && environmentHost(source, initial, seen);
}

const optionsSchema = z.object({ allowFiles: z.array(z.string()) });

export const envThroughSchemaRule = defineRule({
  meta: {
    schema: [
      {
        type: "object",
        properties: { allowFiles: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    ],
    // Stryker disable next-line ArrayDeclaration: equivalent: Oxlint lints only source files, and no source path equals the replacement text
    defaultOptions: [{ allowFiles: [] }],
    messages: {
      environment: withSkillTopic(
        "Read validated values from Environment. Supply child environments, never change the parent.",
        "deep-modules/server-state.md",
      ),
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
              : // Stryker disable next-line ConditionalExpression: equivalent: only a Literal key can have the value "env"
                property.key.type === "Literal" && property.key.value === "env"),
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
