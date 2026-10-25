import { defineRule, type ESTree, type SourceCode } from "@oxlint/plugins";
import { arrayMethodTarget, resolveArrayBinding } from "./array-method.ts";

function isBunMock(source: SourceCode, node: ESTree.Node): boolean {
  const variable = resolveArrayBinding(source, node);
  return (
    variable?.defs.some(
      (definition) =>
        definition.type === "ImportBinding" &&
        definition.parent?.type === "ImportDeclaration" &&
        definition.parent.source.value === "bun:test" &&
        definition.node.type === "ImportSpecifier" &&
        (definition.node.imported.type === "Identifier"
          ? definition.node.imported.name === "mock"
          : definition.node.imported.value === "mock"),
    ) ?? false
  );
}

function isBunNamespaceMock(source: SourceCode, node: ESTree.Node): boolean {
  const member = arrayMethodTarget(node);
  if (member?.name !== "mock") return false;
  const variable = resolveArrayBinding(source, member.object);
  return (
    variable?.defs.some(
      (definition) =>
        definition.type === "ImportBinding" &&
        definition.parent?.type === "ImportDeclaration" &&
        definition.parent.source.value === "bun:test" &&
        definition.node.type === "ImportNamespaceSpecifier",
    ) ?? false
  );
}

export const noModuleMockingRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Reject Bun module replacement by import path." },
    messages: {
      moduleMock:
        "Replace dependencies at their public interface or external tool boundary, not with mock.module.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const member = arrayMethodTarget(node.callee);
        if (
          member?.name === "module" &&
          (isBunMock(context.sourceCode, member.object) ||
            isBunNamespaceMock(context.sourceCode, member.object))
        ) {
          context.report({ node, messageId: "moduleMock" });
        }
      },
    };
  },
});
