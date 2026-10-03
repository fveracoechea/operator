import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode, Variable } from "@oxlint/plugins";

import {
  arrayMethodTarget,
  constInitializer,
  isKnownArrayExpression,
  resolveArrayBinding,
  unwrapArrayExpression,
} from "./array-method.ts";

type ReducerCallback = ESTree.ArrowFunctionExpression | ESTree.Function;

/** Find the `reduce` or `reduceRight` call that takes this function as its only callback. */
function reducerCall(callback: ReducerCallback): ESTree.CallExpression | null {
  let owner: ESTree.Node | null = callback.parent;
  while (owner !== null && unwrapArrayExpression(owner) === callback) owner = owner.parent;
  if (owner?.type !== "CallExpression") return null;
  const method = arrayMethodTarget(owner.callee);
  const firstArgument = owner.arguments[0];
  if (
    method === null ||
    (method.name !== "reduce" && method.name !== "reduceRight") ||
    owner.arguments.length > 2 ||
    firstArgument === undefined ||
    unwrapArrayExpression(firstArgument) !== callback
  )
    return null;
  return owner;
}

function enclosingReducer(node: ESTree.Node) {
  let parent = node.parent;
  while (parent !== null) {
    if (parent.type === "FunctionDeclaration") return null;
    if (parent.type === "ArrowFunctionExpression" || parent.type === "FunctionExpression") {
      const callback = parent;
      const owner = reducerCall(callback);
      if (owner === null) return null;
      const firstParameter = callback.params[0];
      const accumulator =
        firstParameter?.type === "AssignmentPattern" ? firstParameter.left : firstParameter;
      if (accumulator?.type !== "Identifier") return null;
      return { callback, accumulator, initialValue: owner.arguments[1] };
    }
    parent = parent.parent;
  }
  return null;
}

function referencesAccumulator(
  sourceCode: SourceCode,
  node: ESTree.Node,
  accumulator: Variable,
  visited = new Set<Variable>(),
): boolean {
  const variable = resolveArrayBinding(sourceCode, node);
  if (variable === null || visited.has(variable)) return false;
  if (variable === accumulator) return true;
  visited.add(variable);
  const initializer = constInitializer(variable);
  return (
    initializer !== null && referencesAccumulator(sourceCode, initializer, accumulator, visited)
  );
}

function isGlobalCopyOwner(sourceCode: SourceCode, node: ESTree.Node, name: string): boolean {
  node = unwrapArrayExpression(node);
  if (node.type !== "Identifier" || node.name !== name) return false;
  const variable = resolveArrayBinding(sourceCode, node);
  return variable === null || variable.defs.length === 0;
}

/** Reject non-spread copies of reducer accumulators; pair with oxc/no-accumulating-spread. */
export const noReduceAccumulatorCopyRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow copying growing reducer accumulators with Object.assign, Array.from, or array copy methods.",
    },
    messages: {
      accumulatorCopy:
        "Do not copy the reducer accumulator on every iteration; growing copies can cause quadratic work. Mutate a fresh, locally owned accumulator and return it, or use an iterator pipeline/flatMap.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const method = arrayMethodTarget(node.callee);
        if (method === null) return;
        const reducer = enclosingReducer(node);
        if (reducer === null) return;
        const accumulator = context.sourceCode
          .getDeclaredVariables(reducer.callback)
          .find((variable) =>
            variable.identifiers.some(
              (identifier) => identifier.start === reducer.accumulator.start,
            ),
          );
        if (accumulator === undefined) return;
        const isAccumulator = (expression: ESTree.Node) =>
          referencesAccumulator(context.sourceCode, expression, accumulator);
        let copiesAccumulator = false;
        if (
          method.name === "assign" &&
          isGlobalCopyOwner(context.sourceCode, method.object, "Object")
        ) {
          const target = node.arguments[0];
          copiesAccumulator =
            target !== undefined &&
            unwrapArrayExpression(target).type === "ObjectExpression" &&
            node.arguments.slice(1).some(isAccumulator);
        } else if (
          method.name === "from" &&
          isGlobalCopyOwner(context.sourceCode, method.object, "Array")
        ) {
          const source = node.arguments[0];
          copiesAccumulator = source !== undefined && isAccumulator(source);
        } else if (
          ["concat", "slice", "toSpliced", "toSorted", "toReversed", "with"].includes(method.name)
        ) {
          const initialValue = reducer.initialValue;
          const arrayAccumulator =
            initialValue !== undefined && isKnownArrayExpression(context.sourceCode, initialValue);
          copiesAccumulator = arrayAccumulator && isAccumulator(method.object);
        }
        if (copiesAccumulator) context.report({ node, messageId: "accumulatorCopy" });
      },
    };
  },
});
