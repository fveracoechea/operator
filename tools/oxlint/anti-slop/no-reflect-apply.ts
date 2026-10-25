import { defineRule } from "@oxlint/plugins";
import { isGlobalReflectMethod } from "./reflect-method.ts";

export const noReflectApplyRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Require typed calls instead of Reflect.apply." },
    messages: { reflect: "Call the typed function directly instead of Reflect.apply." },
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
