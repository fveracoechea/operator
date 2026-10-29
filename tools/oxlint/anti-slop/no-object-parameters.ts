import { defineRule } from "@oxlint/plugins";
import { withSkillTopic } from "../skill-topic.ts";
import {
  parameterBindingName,
  parameterOwnerVisitor,
  parameterTypeAnnotation,
  type ParameterOwner,
} from "./function-parameters.ts";
import { resolvedTypeMatches } from "./type-alias-resolution.ts";

export const noObjectParametersRule = defineRule({
  meta: {
    messages: {
      objectParameter: withSkillTopic(
        "Parameter `{{parameter}}` uses the broad `object` type. Accept a named owner type, and parse external input at its boundary before the call.",
        "lint-fixes/parse-at-the-boundary.md",
      ),
    },
  },
  createOnce(context) {
    function check(node: ParameterOwner) {
      for (const parameter of node.params) {
        const annotation = parameterTypeAnnotation(parameter)?.typeAnnotation;
        if (!annotation) continue;
        const broad = resolvedTypeMatches(context.sourceCode, annotation, (resolved, matches) => {
          if (resolved.type === "TSObjectKeyword") return true;
          return resolved.type === "TSUnionType" && resolved.types.some(matches);
        });
        if (broad)
          context.report({
            node: annotation,
            messageId: "objectParameter",
            data: { parameter: parameterBindingName(parameter, context.sourceCode) },
          });
      }
    }
    return parameterOwnerVisitor(check);
  },
});
