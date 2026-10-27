import { defineRule } from "@oxlint/plugins";
import { isGlobalReflectMethod } from "./reflect-method.ts";
import { withSkillTopic } from "../skill-topic.ts";

export const noReflectApplyRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Require typed calls instead of Reflect.apply." },
    messages: {
      reflect: withSkillTopic(
        "Call the typed function directly instead of Reflect.apply.",
        "lint-fixes/parse-at-the-boundary.md",
      ),
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (isGlobalReflectMethod(context.sourceCode, node.callee, "apply"))
          context.report({ node, messageId: "reflect" });
      },
    };
  },
});
