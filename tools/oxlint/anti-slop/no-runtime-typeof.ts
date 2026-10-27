import { defineRule, type ESTree } from "@oxlint/plugins";
import { withSkillTopic } from "../skill-topic.ts";
import { readsValidatorSubject } from "./validator-subject.ts";

// Comparing against "undefined" probes whether a binding exists. It grants no validator exemption.
function isExistenceProbe(node: ESTree.UnaryExpression): boolean {
  const parent = node.parent;
  if (parent.type !== "BinaryExpression") return false;
  if (!["===", "!==", "==", "!="].includes(parent.operator)) return false;
  const other = parent.left === node ? parent.right : parent.left;
  return other.type === "Literal" && other.value === "undefined";
}

export const noRuntimeTypeofRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow runtime typeof outside existence probes and the subject of an explicit validator.",
    },
    messages: {
      runtimeTypeof: withSkillTopic(
        "A `typeof` check narrows a representation without its contract. Parse input at its I/O boundary, then branch on the domain value.",
        "lint-fixes/parse-at-the-boundary.md",
      ),
    },
  },
  createOnce(context) {
    return {
      UnaryExpression(node) {
        if (node.operator !== "typeof" || isExistenceProbe(node)) return;
        if (readsValidatorSubject(context.sourceCode, node.argument)) return;
        context.report({ node, messageId: "runtimeTypeof" });
      },
    };
  },
});
