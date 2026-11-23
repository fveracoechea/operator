import { defineRule, type ESTree, type SourceCode } from "@oxlint/plugins";
import { normalizeProjectConfig, type ProjectConfig } from "./configuration.ts";
import {
  applicationEntry,
  bindingOf,
  contains,
  discoverOwners,
  excluded,
  ownerOf,
  resolveLocalValue,
  resolveProjectImport,
} from "./project.ts";

const guidance = new URL("../docs/query-options-owner.md", import.meta.url).href;

function propertyName(
  node: ESTree.ObjectExpression["properties"][number] | ESTree.MemberExpression,
): string | undefined {
  if (node.type === "SpreadElement") return undefined;
  const key = node.type === "Property" ? node.key : node.property;
  if (!node.computed && key.type === "Identifier") return key.name;
  return key.type === "Literal" ? String(key.value) : undefined;
}

function importedOwner(
  source: SourceCode,
  node: ESTree.Node,
  filename: string,
  config: ProjectConfig,
  owners: Set<string>,
): string | undefined {
  if (node.type !== "Identifier") return undefined;
  for (const definition of bindingOf(source, node)?.defs ?? []) {
    const specifier = definition.node;
    if (
      (specifier.type === "ImportSpecifier" ||
        specifier.type === "ImportNamespaceSpecifier" ||
        specifier.type === "ImportDefaultSpecifier") &&
      specifier.parent.type === "ImportDeclaration"
    ) {
      const target = resolveProjectImport(filename, String(specifier.parent.source.value), config);
      if (!target || excluded(target, config)) return undefined;
      if (config.libraryRoots.some((root) => contains(root, target))) return undefined;
      return ownerOf(target, owners);
    }
  }
  return undefined;
}

function groupOwner(
  source: SourceCode,
  input: ESTree.Node,
  filename: string,
  config: ProjectConfig,
  owners: Set<string>,
  seen = new Set<ESTree.Node>(),
): string | undefined {
  const node = resolveLocalValue(source, input);
  if (seen.has(node)) return undefined;
  seen.add(node);
  if (node.type === "ObjectExpression") return ownerOf(filename, owners);
  if (node.type !== "MemberExpression")
    return importedOwner(source, node, filename, config, owners);
  const name = propertyName(node);
  if (name === undefined) return undefined;
  const object = resolveLocalValue(source, node.object);
  if (object.type !== "ObjectExpression")
    return groupOwner(source, object, filename, config, owners, seen);
  const value = exposedGroups(object).get(name);
  return value ? groupOwner(source, value, filename, config, owners, seen) : undefined;
}

function exposedGroups(object: ESTree.ObjectExpression): Map<string, ESTree.Node> {
  const groups = new Map<string, ESTree.Node>();
  for (const item of object.properties) {
    if (item.type !== "Property") {
      groups.clear();
      continue;
    }
    const name = propertyName(item);
    if (name === undefined) groups.clear();
    else groups.set(name, item.value);
  }
  return groups;
}

function checkObject(
  source: SourceCode,
  input: ESTree.Node,
  filename: string,
  config: ProjectConfig,
  owners: Set<string>,
): ESTree.Node | undefined {
  const object = resolveLocalValue(source, input);
  if (object.type !== "ObjectExpression") return undefined;
  const groups = exposedGroups(object);
  const queries = groups.get("queryOptions");
  const mutations = groups.get("mutationOptions");
  if (!queries || !mutations) return undefined;
  const queryOwner = groupOwner(source, queries, filename, config, owners);
  const mutationOwner = groupOwner(source, mutations, filename, config, owners);
  const parent = ownerOf(filename, owners);
  if (parent && (queryOwner === parent || mutationOwner === parent)) return object;
  if (
    queryOwner &&
    mutationOwner &&
    (queryOwner !== mutationOwner || !parent || !contains(parent, queryOwner))
  )
    return object;
  return undefined;
}

function interfaceValues(program: ESTree.Program): ESTree.Node[] {
  const values: ESTree.Node[] = [];
  for (const statement of program.body) {
    if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue;
    if (statement.declaration?.type === "VariableDeclaration")
      for (const declaration of statement.declaration.declarations)
        if (declaration.init) values.push(declaration.init);
    if (!statement.source)
      for (const specifier of statement.specifiers)
        if (specifier.exportKind !== "type") values.push(specifier.local);
  }
  return values;
}

export const queryOptionsOwnerRule = defineRule({
  meta: {
    schema: [],
    docs: { url: guidance },
    messages: {
      ownership: `Expose queryOptions and mutationOptions from the same owning internal sub-module. See ${guidance}.`,
      configuration: `Invalid deep-modules configuration: {{detail}}. See ${guidance}.`,
    },
  },
  createOnce(context) {
    return {
      Program(node) {
        let config: ProjectConfig;
        try {
          config = normalizeProjectConfig(context.settings, context.cwd);
        } catch (error) {
          context.report({
            node,
            messageId: "configuration",
            data: { detail: error instanceof Error ? error.message : "Invalid settings" },
          });
          return;
        }
        if (!applicationEntry(context.filename, config)) return;
        const owners = discoverOwners(config);
        function inspect(input: ESTree.Node) {
          const invalid = checkObject(context.sourceCode, input, context.filename, config, owners);
          if (invalid) context.report({ node: invalid, messageId: "ownership" });
        }

        for (const value of interfaceValues(node)) inspect(value);
      },
    };
  },
});
