import { defineRule, type ESTree, type SourceCode, type Variable } from "@oxlint/plugins";
import path from "node:path";
import { z } from "zod";
import { normalizeProjectConfig, type ProjectConfig } from "./configuration.ts";
import {
  bindingOf,
  contains,
  discoverOwners,
  excluded,
  ownerOf,
  privateImport,
  resolveLocalValue,
  resolveProjectImport,
  unwrapExpression,
} from "./project.ts";

const guidance = new URL("../docs/public-collaborator-mocks.md", import.meta.url).href;

function member(node: ESTree.MemberExpression): string | undefined {
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  return z.string().safeParse(node.property.type === "Literal" ? node.property.value : null).data;
}

function importedBinding(node: ESTree.Node): string[] | undefined {
  if (node.type !== "ImportSpecifier" && node.type !== "ImportNamespaceSpecifier") return undefined;
  if (
    node.parent.type !== "ImportDeclaration" ||
    node.parent.source.value !== "bun:test" ||
    node.parent.importKind === "type"
  )
    return undefined;
  if (node.type === "ImportNamespaceSpecifier") return [];
  if (node.importKind === "type") return undefined;
  return [node.imported.type === "Identifier" ? node.imported.name : node.imported.value];
}

function destructuredKey(pattern: ESTree.Node, name: string): string | undefined {
  if (pattern.type !== "ObjectPattern") return undefined;
  for (const property of pattern.properties) {
    if (
      property.type !== "Property" ||
      property.value.type !== "Identifier" ||
      property.value.name !== name
    )
      continue;
    if (!property.computed && property.key.type === "Identifier") return property.key.name;
    return z.string().safeParse(property.key.type === "Literal" ? property.key.value : null).data;
  }
  return undefined;
}

function aliasBinding(
  source: SourceCode,
  declaration: ESTree.Node,
  name: string,
  seen: Set<Variable>,
): string[] | undefined {
  if (
    declaration.type !== "VariableDeclarator" ||
    declaration.parent.type !== "VariableDeclaration" ||
    declaration.parent.kind !== "const" ||
    !declaration.init
  )
    return undefined;
  const base = bunBinding(source, declaration.init, seen);
  if (declaration.id.type === "Identifier") return base;
  const key = destructuredKey(declaration.id, name);
  return key && base ? [...base, key] : undefined;
}

/** Trace only actual Bun imports and immutable aliases, never names alone. */
function bunBinding(
  source: SourceCode,
  input: ESTree.Node,
  seen = new Set<Variable>(),
): string[] | undefined {
  const node = unwrapExpression(input);
  if (node.type === "MemberExpression") {
    const name = member(node);
    const base = bunBinding(source, node.object, seen);
    return name && base ? [...base, name] : undefined;
  }
  if (node.type !== "Identifier") return undefined;
  const binding = bindingOf(source, node);
  if (!binding || seen.has(binding)) return undefined;
  seen.add(binding);
  for (const definition of binding.defs) {
    const result =
      importedBinding(definition.node) ?? aliasBinding(source, definition.node, node.name, seen);
    if (result) return result;
  }
  return undefined;
}

function moduleMock(source: SourceCode, node: ESTree.Node): boolean {
  const binding = bunBinding(source, node)?.join(".");
  return ["mock.module", "jest.mock", "jest.doMock", "vi.mock", "vi.doMock"].includes(
    binding ?? "",
  );
}

function forbidden(
  filename: string,
  target: string,
  config: ProjectConfig,
  owners: Set<string>,
): boolean {
  const association = Object.entries(config.testScopes)
    .filter(([scope]) => contains(scope, filename))
    .toSorted(([a], [b]) => b.length - a.length)[0]?.[1];
  const importer = association ? path.join(association, "__test__.test.ts") : filename;
  const from = ownerOf(importer, owners);
  const to = ownerOf(target, owners);
  if (from && to && contains(from, to)) return true;
  if (config.environmentEntries.includes(target)) return false;
  if (excluded(target, config)) return true;
  if (!to) return true;
  return (
    ![...config.objectEntries, ...config.schemaEntries, ...config.frameworkEntries].includes(
      path.basename(target),
    ) || privateImport(importer, target, config, owners)
  );
}

export const publicCollaboratorMocksRule = defineRule({
  meta: {
    schema: [],
    docs: { url: guidance },
    messages: {
      private: `Mock only an external collaborator's public entry. Keep the tested owner and its descendants real. See ${guidance}.`,
      scope: `Module mocks require a test file or an explicit testScopes owner association for shared setup. See ${guidance}.`,
      unsupported: `Unsupported mock target. Use a static string or immutable string alias so collaborator privacy can be checked. See ${guidance}.`,
      configuration: `Invalid deep-modules configuration: {{detail}}. See ${guidance}.`,
    },
  },
  createOnce(context) {
    let config: ProjectConfig | undefined;
    let owners = new Set<string>();
    let key: string | undefined;
    return {
      Program(node) {
        config = undefined;
        try {
          config = normalizeProjectConfig(context.settings, context.cwd);
          const next = JSON.stringify(config);
          if (next !== key) {
            owners = discoverOwners(config);
            key = next;
          }
        } catch (error) {
          config = undefined;
          context.report({
            node,
            messageId: "configuration",
            data: { detail: error instanceof Error ? error.message : "Invalid settings" },
          });
        }
      },
      CallExpression(node) {
        if (!config || !moduleMock(context.sourceCode, node.callee)) return;
        if (
          !/\.(test|spec)\.[cm]?[jt]sx?$/.test(context.filename) &&
          !Object.keys(config.testScopes).some((scope) => contains(scope, context.filename))
        ) {
          context.report({ node, messageId: "scope" });
          return;
        }
        const argument = node.arguments[0];
        const value = argument && resolveLocalValue(context.sourceCode, argument);
        const specifier = z.string().safeParse(value?.type === "Literal" ? value.value : null);
        if (!specifier.success) {
          context.report({ node: argument ?? node, messageId: "unsupported" });
          return;
        }
        const target = resolveProjectImport(context.filename, specifier.data, config);
        if (target && forbidden(context.filename, target, config, owners))
          context.report({ node: argument ?? node, messageId: "private" });
      },
    };
  },
});
