import { defineRule, type ESTree } from "@oxlint/plugins";
// Consumer paths use Node APIs so the distributed plugin needs no Bun runtime.
import path from "node:path";
import { normalizeProjectConfig } from "./configuration.ts";
import { contains, discoverOwners, excluded, ownerOf, productionFile } from "./project.ts";
import {
  selectorValues,
  walk,
  memberName,
  functionNode,
  type SelectorValue,
} from "./selector-values.ts";

const guidance = new URL("../docs/synchronous-selectors.md", import.meta.url).href;

function promiseReturn(node: ESTree.Node): boolean {
  if (node.type === "TSTypeReference") {
    const name = node.typeName;
    return (
      (name.type === "Identifier" && name.name === "Promise") ||
      (name.type === "TSQualifiedName" &&
        name.left.type === "Identifier" &&
        name.left.name === "globalThis" &&
        name.right.name === "Promise")
    );
  }
  if (node.type === "TSTypeAnnotation") return promiseReturn(node.typeAnnotation);
  if (node.type === "TSParenthesizedType") return promiseReturn(node.typeAnnotation);
  if (node.type === "TSUnionType" || node.type === "TSIntersectionType")
    return node.types.some(promiseReturn);
  if (node.type === "TSFunctionType") return promiseReturn(node.returnType);
  return false;
}

export const synchronousSelectorsRule = defineRule({
  meta: {
    schema: [],
    docs: { url: guidance },
    messages: {
      asynchronous: `Selector implementations must be synchronous. Remove explicit async, await or Promise return contracts, including returned predicates and projections. See ${guidance}.`,
      configuration: `Invalid deep-modules configuration: {{detail}}. See ${guidance}.`,
    },
  },
  createOnce(context) {
    return {
      Program(node) {
        try {
          const config = normalizeProjectConfig(context.settings, context.cwd);
          if (excluded(context.filename, config) || !productionFile(context.filename)) return;
          if (config.libraryRoots.some((root) => contains(root, context.filename))) return;
          const owner = ownerOf(context.filename, discoverOwners(config));
          if (!owner) return;
          const seen = new Set<ESTree.Node>();
          const values = selectorValues(context.sourceCode, context.filename, config);
          function reportAt(value: SelectorValue, fallback: ESTree.Node = node): ESTree.Node {
            return value.filename === context.filename ? value.node : fallback;
          }

          function inspectImplementation(value: SelectorValue, location: ESTree.Node) {
            const target = value.node;
            if (!functionNode(target)) return;
            if (target.async || (target.returnType && promiseReturn(target.returnType))) {
              context.report({ node: location, messageId: "asynchronous" });
              return;
            }
            if (target.body.type !== "BlockStatement") {
              inspectValue({ ...value, node: target.body }, location);
              return;
            }
            walk(target.body, (child) => {
              if (functionNode(child)) return false;
              if (child.type === "AwaitExpression")
                context.report({
                  node: value.filename === context.filename ? child : location,
                  messageId: "asynchronous",
                });
              if (child.type === "ReturnStatement" && child.argument)
                inspectValue({ ...value, node: child.argument }, location);
              return true;
            });
          }

          function inspectValue(input: SelectorValue, exposedAt?: ESTree.Node) {
            if (values.annotations(input).some(promiseReturn)) {
              context.report({
                node: reportAt(input, exposedAt),
                messageId: "asynchronous",
              });
              return;
            }
            for (const value of values.resolve(input)) {
              if (seen.has(value.node)) continue;
              seen.add(value.node);
              const target = value.node;
              const location = reportAt(value, exposedAt ?? input.node);
              if (target.type === "Program") {
                for (const item of values.exported(value)) inspectValue(item, location);
              }
              if (target.type === "ObjectExpression") {
                for (const item of target.properties)
                  if (item.type === "Property")
                    inspectValue({ ...value, node: item.value }, location);
              }
              const explicitContract = values.annotations(value).some(promiseReturn);
              if (target.type === "AwaitExpression" || explicitContract) {
                context.report({ node: location, messageId: "asynchronous" });
                continue;
              }
              inspectImplementation(value, location);
            }
          }

          const groups = new Set<ESTree.Node>();
          function inspectGroups(input: SelectorValue) {
            for (const value of values.resolve(input)) {
              if (groups.has(value.node)) continue;
              groups.add(value.node);
              if (value.node.type !== "ObjectExpression") continue;
              for (const property of value.node.properties) {
                if (property.type !== "Property") continue;
                const child = { ...value, node: property.value };
                if (["selector", "selectors"].includes(memberName(property) ?? ""))
                  inspectValue(child, input.node);
                else inspectGroups(child);
              }
            }
          }

          for (const item of values.exported({ node, filename: context.filename })) {
            if (config.selectorSubmodules.includes(path.basename(owner))) inspectValue(item);
            inspectGroups(item);
          }
        } catch (error) {
          context.report({
            node,
            messageId: "configuration",
            data: { detail: error instanceof Error ? error.message : "Invalid settings" },
          });
        }
      },
    };
  },
});
