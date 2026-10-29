import { defineRule, type ESTree, type SourceCode } from "@oxlint/plugins";
import { withSkillTopic } from "../skill-topic.ts";
import { parameterOwnerVisitor, type ParameterOwner } from "./function-parameters.ts";
import { resolvedTypeMatches } from "./type-alias-resolution.ts";

// A qualified name never has the text of a promise name.
function isPromiseReference(
  source: SourceCode,
  type: ESTree.TSType,
): type is ESTree.TSTypeReference {
  return (
    // Stryker disable next-line ConditionalExpression: equivalent: another type has no type name, so the name check refuses it; this check narrows the type
    type.type === "TSTypeReference" &&
    ["Promise", "PromiseLike"].includes(source.getText(type.typeName))
  );
}

export const noUnknownReturnsRule = defineRule({
  meta: {
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
        if (resolved.type === "TSUnionType") return resolved.types.some(matches);
        const value = isPromiseReference(context.sourceCode, resolved)
          ? resolved.typeArguments?.params[0]
          : undefined;
        return value !== undefined && matches(value);
      });
      if (unknown) context.report({ node: annotation, messageId: "unknownReturn" });
    }
    return parameterOwnerVisitor(check);
  },
});
