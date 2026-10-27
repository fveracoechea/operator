import { defineRule } from "@oxlint/plugins";
import { withSkillTopic } from "../skill-topic.ts";
import {
  containsUnknownType,
  parameterBindingName,
  parameterOwnerVisitor,
  parameterTypeAnnotation,
  type ParameterOwner,
} from "./function-parameters.ts";
import { validatorSubject } from "./validator-subject.ts";

export const noUnknownParametersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow unknown function parameters, except the subject of an explicit non-generic validator.",
    },
    messages: {
      unknownParameter: withSkillTopic(
        "Parameter `{{parameter}}` leaves input unparsed. Accept a named domain type, and run the schema at the I/O boundary before the call.",
        "lint-fixes/parse-at-the-boundary.md",
      ),
    },
  },
  createOnce(context) {
    function check(node: ParameterOwner) {
      const subject = validatorSubject(context.sourceCode, node);
      for (const parameter of node.params) {
        const annotation = parameterTypeAnnotation(parameter)?.typeAnnotation;
        if (!annotation || !containsUnknownType(annotation) || parameter === subject) continue;
        context.report({
          node: annotation,
          messageId: "unknownParameter",
          data: { parameter: parameterBindingName(parameter, context.sourceCode) },
        });
      }
    }
    return parameterOwnerVisitor(check);
  },
});
