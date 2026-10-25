import { defineRule } from "@oxlint/plugins";
import { isGlobalReflectMethod } from "./reflect-method.ts";

export const noReflectGetRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Require typed property access instead of Reflect.get." },
    messages: {
      reflect: "Use typed property access. Parse external data before reading its fields.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (isGlobalReflectMethod(context.sourceCode, node.callee, "get"))
          context.report({ node, messageId: "reflect" });
      },
    };
  },
});
