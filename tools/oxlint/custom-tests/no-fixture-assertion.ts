import { defineRule, type ESTree, type SourceCode, type Variable } from "@oxlint/plugins";
import {
  constInitializer,
  resolveArrayBinding,
  unwrapArrayExpression,
} from "../anti-slop/array-method.ts";
import { withSkillTopic } from "../skill-topic.ts";

function isFixture(source: SourceCode, input: ESTree.Node, visited = new Set<Variable>()): boolean {
  const node = unwrapArrayExpression(input);
  if (node.type === "Literal") return true;
  if (node.type === "ObjectExpression")
    return node.properties.every(
      (property) =>
        property.type === "Property" && isFixture(source, property.value, new Set(visited)),
    );
  if (node.type === "ArrayExpression")
    return node.elements.every(
      (element) => element !== null && isFixture(source, element, new Set(visited)),
    );
  if (node.type === "MemberExpression") return isFixture(source, node.object, visited);
  // A node that is not an identifier resolves to no binding.
  const variable = resolveArrayBinding(source, node);
  if (!variable || visited.has(variable)) return false;
  visited.add(variable);
  if (
    variable.references.some((reference) => {
      const parent = reference.identifier.parent;
      if (parent.type === "CallExpression") return !isBunExpect(source, parent.callee);
      return (
        parent.type === "MemberExpression" &&
        parent.parent.type === "CallExpression" &&
        parent.parent.callee === parent
      );
    })
  )
    return false;
  const initial = constInitializer(variable);
  return initial !== null && isFixture(source, initial, visited);
}

function isBunExpect(source: SourceCode, node: ESTree.Node): boolean {
  const variable = resolveArrayBinding(source, node);
  return (
    variable?.defs.some(
      (definition) =>
        definition.parent?.type === "ImportDeclaration" &&
        definition.parent.source.value === "bun:test" &&
        definition.node.type === "ImportSpecifier" &&
        (definition.node.imported.type === "Identifier"
          ? definition.node.imported.name === "expect"
          : definition.node.imported.value === "expect"),
    ) ?? false
  );
}

export const noFixtureAssertionRule = defineRule({
  meta: {
    messages: {
      fixture: withSkillTopic(
        "This assertion reads its own fixture. Call the code under test and assert on its result or effects.",
        "lint-fixes/test-doubles.md",
      ),
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const argument = node.arguments[0];
        if (
          argument &&
          isBunExpect(context.sourceCode, node.callee) &&
          isFixture(context.sourceCode, argument)
        ) {
          context.report({ node: argument, messageId: "fixture" });
        }
      },
    };
  },
});
