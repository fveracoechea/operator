import { defineRule, type ESTree, type SourceCode, type Variable } from "@oxlint/plugins";
import { resolveArrayBinding } from "./array-method.ts";
import { withSkillTopic } from "../skill-topic.ts";

function hidesUnknown(
  source: SourceCode,
  type: ESTree.TSType,
  visited = new Set<Variable>(),
): boolean {
  if (type.type === "TSUnknownKeyword") return true;
  if (type.type === "TSParenthesizedType")
    return hidesUnknown(source, type.typeAnnotation, visited);
  if (type.type === "TSUnionType")
    return type.types.some((part) => hidesUnknown(source, part, visited));
  if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return false;
  const variable = resolveArrayBinding(source, type.typeName);
  if (!variable || visited.has(variable)) return false;
  visited.add(variable);
  return variable.defs.some(
    (definition) =>
      definition.node.type === "TSTypeAliasDeclaration" &&
      hidesUnknown(source, definition.node.typeAnnotation, visited),
  );
}

export const noUnknownTypeAliasesRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Keep unknown visible at parse boundaries." },
    messages: {
      alias: withSkillTopic(
        "This type alias hides unknown. Keep unknown explicit at the parse boundary.",
        "lint-fixes/parse-at-the-boundary.md",
      ),
    },
  },
  createOnce(context) {
    return {
      TSTypeAliasDeclaration(node) {
        if (hidesUnknown(context.sourceCode, node.typeAnnotation))
          context.report({ node: node.id, messageId: "alias" });
      },
    };
  },
});
