import { defineRule, type ESTree } from "@oxlint/plugins";
import { withSkillTopic } from "../skill-topic.ts";
import { parameterOwnerVisitor, type ParameterOwner } from "./function-parameters.ts";
import { resolvedTypeMatches } from "./type-alias-resolution.ts";

function isPromiseReference(type: ESTree.TSType): type is ESTree.TSTypeReference {
  return (
    type.type === "TSTypeReference" &&
    type.typeName.type === "Identifier" &&
    ["Promise", "PromiseLike"].includes(type.typeName.name)
  );
}

export const noUnknownReturnsRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Disallow an explicit unknown or Promise<unknown> return contract." },
    messages: {
      unknownReturn: withSkillTopic(
        "This function gives `unknown` to its caller. Parse the value at its boundary and return a named domain type.",
        "lint-fixes/parse-at-the-boundary.md",
      ),
    },
  },
  createOnce(context) {
    function check(node: ParameterOwner) {
      const annotation = node.returnType?.typeAnnotation;
      if (!annotation) return;
      const unknown = resolvedTypeMatches(context.sourceCode, annotation, (resolved, matches) => {
        if (resolved.type === "TSUnknownKeyword") return true;
        if (resolved.type === "TSParenthesizedType") return matches(resolved.typeAnnotation);
        if (resolved.type === "TSUnionType") return resolved.types.some(matches);
        const value = isPromiseReference(resolved) ? resolved.typeArguments?.params[0] : undefined;
        return value !== undefined && matches(value);
      });
      if (unknown) context.report({ node: annotation, messageId: "unknownReturn" });
    }
    return parameterOwnerVisitor(check);
  },
});
