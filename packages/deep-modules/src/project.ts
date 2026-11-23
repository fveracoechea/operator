// Consumer analysis must also run in Node, without Bun filesystem APIs.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { ProjectConfig } from "./configuration.ts";
import type { Context, ESTree, SourceCode, Variable } from "@oxlint/plugins";
import { z } from "zod";

export function contains(root: string, filename: string): boolean {
  return filename === root || filename.startsWith(`${root}${path.sep}`);
}

export function excluded(filename: string, config: ProjectConfig): boolean {
  return config.exclusions.some((root) => contains(root, filename));
}

export function productionFile(filename: string): boolean {
  return /\.tsx?$/.test(filename) && !/(\.d|\.test|\.spec)(\.|$)/.test(filename);
}

/** A per-file view, never a process-global cache of another consumer's filesystem. */
export function discoverOwners(config: ProjectConfig): Set<string> {
  const owners = new Set<string>();
  function visit(directory: string, root: string) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, item.name);
      if (
        excluded(filename, config) ||
        config.libraryRoots.some((root) => contains(root, filename))
      )
        continue;
      if (item.isDirectory()) visit(filename, root);
      if (!item.isFile() || !productionFile(item.name)) continue;
      let owner = directory;
      while (owner !== root && contains(root, owner)) {
        owners.add(owner);
        owner = path.dirname(owner);
      }
    }
  }

  for (const root of config.moduleRoots) {
    // A root that is absent in a consumer is not a malformed configuration.
    if (statSync(root, { throwIfNoEntry: false })?.isDirectory()) visit(root, root);
  }
  return owners;
}

export function ownerOf(filename: string, owners: Set<string>): string | undefined {
  let directory = path.dirname(filename);
  while (directory !== path.dirname(directory)) {
    if (owners.has(directory)) return directory;
    directory = path.dirname(directory);
  }
  return undefined;
}

function projectPath(
  importer: string,
  specifier: string,
  config: ProjectConfig,
): string | undefined {
  if (specifier.startsWith(".")) return path.resolve(path.dirname(importer), specifier);
  if (path.isAbsolute(specifier)) return specifier;
  const aliases = Object.entries(config.aliases).toSorted(([a], [b]) => b.length - a.length);
  for (const [alias, target] of aliases) {
    if (specifier === alias || specifier.startsWith(`${alias}/`))
      return path.resolve(target, specifier.slice(alias.length).replace(/^\//, ""));
  }
  const manifest = path.join(config.projectRoot, "package.json");
  if (!statSync(manifest, { throwIfNoEntry: false })?.isFile()) return undefined;
  const { name } = z
    .object({ name: z.string().optional() })
    .parse(JSON.parse(readFileSync(manifest, "utf8")));
  if (name && specifier.startsWith(`${name}/`))
    return path.resolve(config.projectRoot, specifier.slice(name.length + 1));
  return undefined;
}

function existingFile(filename: string): boolean {
  try {
    return statSync(filename, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    // Broken or cyclic filesystem aliases cannot be traversed as a source file.
    return false;
  }
}

export function resolveProjectImport(
  importer: string,
  specifier: string,
  config: ProjectConfig,
): string | undefined {
  const target = projectPath(importer, specifier, config);
  if (!target) return undefined;
  const stem = target.replace(/\.[jt]sx?$/, "");
  const candidates = [target, `${stem}.ts`, `${stem}.tsx`];
  return candidates.find(existingFile) ?? (path.extname(target) ? target : `${target}.ts`);
}

export function privateImport(
  importer: string,
  target: string,
  config: ProjectConfig,
  owners: Set<string>,
): boolean {
  const to = ownerOf(target, owners);
  const from = ownerOf(importer, owners);
  if (!to || from === to || excluded(target, config)) return false;
  if (config.libraryRoots.some((root) => contains(root, target))) return false;
  const ancestor = from !== undefined && contains(to, from);
  if (ancestor && config.schemaEntries.includes(path.basename(target))) return false;
  if (ancestor) return true;
  const entry = [
    ...config.objectEntries,
    ...config.schemaEntries,
    ...config.frameworkEntries,
  ].includes(path.basename(target));
  if (!entry) return true;
  // A top-level feature entry is public. A child's entry belongs to its parent.
  const parent = ownerOf(to, owners);
  return (
    parent !== undefined && from !== parent && (from === undefined || path.dirname(from) !== parent)
  );
}

export function bindingOf(source: SourceCode, node: ESTree.Node): Variable | undefined {
  if (node.type !== "Identifier") return undefined;
  let scope = source.getScope(node);
  while (scope) {
    const binding = scope.set.get(node.name);
    if (binding) return binding;
    if (!scope.upper) break;
    scope = scope.upper;
  }
  return undefined;
}

export function unwrapExpression(node: ESTree.Node): ESTree.Node {
  while (
    node.type === "ParenthesizedExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSTypeAssertion" ||
    node.type === "TSNonNullExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "ChainExpression"
  )
    node = node.expression;
  return node;
}

/** Immutable aliases only. Cyclic bindings stop at the last known node. */
export function resolveLocalValue(
  source: SourceCode,
  input: ESTree.Node,
  seen = new Set<Variable>(),
): ESTree.Node {
  const node = unwrapExpression(input);
  if (node.type !== "Identifier") return node;
  const binding = bindingOf(source, node);
  if (!binding || seen.has(binding)) return node;
  seen.add(binding);
  for (const definition of binding.defs) {
    const declaration = definition.node;
    if (
      declaration.type === "VariableDeclarator" &&
      declaration.parent.type === "VariableDeclaration" &&
      declaration.parent.kind === "const" &&
      declaration.init
    )
      return resolveLocalValue(source, declaration.init, seen);
  }
  return node;
}

function globalName(source: SourceCode, node: ESTree.Node, name: string): boolean {
  return (
    node.type === "Identifier" &&
    node.name === name &&
    (bindingOf(source, node)?.defs.length ?? 0) === 0
  );
}

function memberName(node: ESTree.MemberExpression): string | undefined {
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  const name = z.string().safeParse(node.property.type === "Literal" ? node.property.value : null);
  return name.success ? name.data : undefined;
}

function createRequireBinding(source: SourceCode, node: ESTree.Node): boolean {
  const value = resolveLocalValue(source, node);
  const namespace = value.type === "MemberExpression" && memberName(value) === "createRequire";
  const identifier = namespace ? value.object : value;
  if (identifier.type !== "Identifier") return false;
  return (
    bindingOf(source, identifier)?.defs.some((definition) => {
      const specifier = definition.node;
      if (specifier.type !== "ImportSpecifier" && specifier.type !== "ImportNamespaceSpecifier")
        return false;
      if (
        specifier.parent.type !== "ImportDeclaration" ||
        !["node:module", "module"].includes(String(specifier.parent.source.value))
      )
        return false;
      return namespace
        ? specifier.type === "ImportNamespaceSpecifier"
        : specifier.type === "ImportSpecifier" &&
            (specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : specifier.imported.value) === "createRequire";
    }) === true
  );
}

function requireBinding(source: SourceCode, input: ESTree.Node): boolean {
  const node = resolveLocalValue(source, input);
  if (globalName(source, node, "require")) return true;
  if (node.type === "MemberExpression")
    return memberName(node) === "require" && globalName(source, node.object, "module");
  return node.type === "CallExpression" && createRequireBinding(source, node.callee);
}

/** Literal static-loading syntax shared by ownership policies. Computed targets are opaque. */
export function importVisitors(
  context: Context,
  inspect: (node: ESTree.Node, specifier: string) => void,
) {
  function literal(node: ESTree.Node | null | undefined) {
    if (node?.type !== "Literal") return;
    const value = z.string().safeParse(node.value);
    if (value.success) inspect(node, value.data);
  }

  return {
    ImportDeclaration(node: ESTree.ImportDeclaration) {
      literal(node.source);
    },
    ExportNamedDeclaration(node: ESTree.ExportNamedDeclaration) {
      literal(node.source);
    },
    ExportAllDeclaration(node: ESTree.ExportAllDeclaration) {
      literal(node.source);
    },
    ImportExpression(node: ESTree.ImportExpression) {
      literal(node.source);
    },
    TSImportType(node: ESTree.TSImportType) {
      literal(node.source);
    },
    TSExternalModuleReference(node: ESTree.TSExternalModuleReference) {
      literal(node.expression);
    },
    CallExpression(node: ESTree.CallExpression) {
      const callee = node.callee;
      const resolvedRequire =
        callee.type === "MemberExpression" &&
        memberName(callee) === "resolve" &&
        requireBinding(context.sourceCode, callee.object);
      if (requireBinding(context.sourceCode, callee) || resolvedRequire) literal(node.arguments[0]);
    },
  };
}
