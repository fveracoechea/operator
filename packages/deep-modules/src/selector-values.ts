import { parse } from "@babel/parser";
import type { ESTree, SourceCode } from "@oxlint/plugins";
// The installed plugin also runs under Node.
import { readFileSync, statSync } from "node:fs";
import type { ProjectConfig } from "./configuration.ts";
import {
  bindingOf,
  excluded,
  memberName,
  productionFile,
  resolveLocalValue,
  resolveProjectImport,
  unwrapExpression,
} from "./project.ts";

export function astNode(value: unknown): value is ESTree.Node {
  return (
    typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
  );
}

export function walk(node: ESTree.Node, inspect: (node: ESTree.Node) => boolean): void {
  if (!inspect(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    if (astNode(value)) walk(value, inspect);
    if (Array.isArray(value)) for (const child of value) if (astNode(child)) walk(child, inspect);
  }
}

type Export = Extract<ESTree.Node, { type: "ExportNamedDeclaration" }>;
type FunctionNode = Extract<
  ESTree.Node,
  {
    type: "FunctionDeclaration" | "FunctionExpression" | "ArrowFunctionExpression";
  }
>;

export function functionNode(node: ESTree.Node): node is FunctionNode {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

function exportName(node: ESTree.Node): string {
  return node.type === "Identifier" ? node.name : node.type === "Literal" ? String(node.value) : "";
}

function namedBinding(node: ESTree.Node, name: string): ESTree.Node | undefined {
  if (node.type === "FunctionDeclaration" && node.id?.name === name) return node;
  if (node.type === "VariableDeclaration")
    return node.declarations.find(
      (binding) => binding.id.type === "Identifier" && binding.id.name === name,
    );
  if (node.type === "ImportDeclaration")
    return node.specifiers.find((binding) => binding.local.name === name);
  return undefined;
}

function scopeBinding(scope: ESTree.Node, name: string): ESTree.Node | undefined {
  if (scope.type !== "Program" && scope.type !== "BlockStatement") return undefined;
  for (const item of scope.body) {
    const declaration = item.type === "ExportNamedDeclaration" ? item.declaration : item;
    if (!declaration) continue;
    const binding = namedBinding(declaration, name);
    if (binding) return binding;
  }
  return undefined;
}

export type SelectorValue = { node: ESTree.Node; filename: string };

function declaredExports(value: SelectorValue, name?: string): SelectorValue[] {
  const node = value.node;
  if (node.type === "FunctionDeclaration") return !name || node.id?.name === name ? [value] : [];
  if (node.type !== "VariableDeclaration") return [];
  return node.declarations.reduce<SelectorValue[]>((found, binding) => {
    if (binding.init && binding.id.type === "Identifier" && (!name || binding.id.name === name))
      found.push({ ...value, node: binding.init });
    return found;
  }, []);
}

function annotation(node: ESTree.Node): ESTree.Node | undefined {
  if (
    node.type === "TSAsExpression" ||
    node.type === "TSTypeAssertion" ||
    node.type === "TSSatisfiesExpression"
  )
    return node.typeAnnotation;
  if (node.type === "VariableDeclarator" && node.id.type === "Identifier")
    return node.id.typeAnnotation ?? undefined;
  return undefined;
}

function parseProgram(filename: string): ESTree.Program | undefined {
  try {
    const parsed: unknown = parse(readFileSync(filename, "utf8"), {
      sourceType: "module",
      plugins: ["typescript", "jsx", "estree"],
    }).program;
    return astNode(parsed) && parsed.type === "Program" ? parsed : undefined;
  } catch {
    // An unreadable or unsupported dependency is opaque, never evidence of async behavior.
    return undefined;
  }
}

/** One rule invocation owns parsed sources. Opaque imports and computed values stop tracing. */
export function selectorValues(
  source: SourceCode | undefined,
  filename: string,
  config: ProjectConfig,
) {
  const programs = new Map<string, ESTree.Program>();
  const parents = new WeakMap<ESTree.Node, ESTree.Node>();

  function load(target: string): ESTree.Program | undefined {
    if (
      !productionFile(target) ||
      excluded(target, config) ||
      !statSync(target, { throwIfNoEntry: false })?.isFile()
    )
      return undefined;
    const cached = programs.get(target);
    if (cached) return cached;
    const parsed = parseProgram(target);
    if (!parsed) return undefined;
    walk(parsed, (node) => {
      for (const [key, value] of Object.entries(node)) {
        if (key === "parent") continue;
        if (astNode(value)) parents.set(value, node);
        if (Array.isArray(value))
          for (const child of value) if (astNode(child)) parents.set(child, node);
      }
      return true;
    });
    programs.set(target, parsed);
    return parsed;
  }

  function parent(value: SelectorValue): ESTree.Node | undefined {
    return value.filename === filename && source
      ? (value.node.parent ?? undefined)
      : parents.get(value.node);
  }

  function definition(value: SelectorValue): ESTree.Node | undefined {
    if (value.node.type !== "Identifier") return undefined;
    if (value.filename === filename && source) return bindingOf(source, value.node)?.defs[0]?.node;
    const name = value.node.name;
    let ancestor = parents.get(value.node);
    while (ancestor) {
      if (
        functionNode(ancestor) &&
        ancestor.params.some((param) => param.type === "Identifier" && param.name === name)
      )
        return undefined;
      const binding = scopeBinding(ancestor, name);
      if (binding) return binding;
      ancestor = parents.get(ancestor);
    }
    return undefined;
  }

  function reexported(
    value: SelectorValue,
    declaration: Export,
    name: string,
    seen: Set<string>,
  ): SelectorValue[] {
    if (!declaration.source) return [];
    const target = resolveProjectImport(value.filename, String(declaration.source.value), config);
    const program = target ? load(target) : undefined;
    return target && program ? exported({ node: program, filename: target }, name, seen) : [];
  }

  function exported(
    value: SelectorValue,
    name?: string,
    seen = new Set<string>(),
  ): SelectorValue[] {
    const key = `${value.filename}:${name ?? "*"}`;
    if (value.node.type !== "Program" || seen.has(key)) return [];
    seen.add(key);
    const found: SelectorValue[] = [];
    for (const item of value.node.body) {
      if (item.type === "ExportAllDeclaration") {
        found.push(...namespaceExports(value, item, name, new Set(seen)));
        continue;
      }
      if (item.type === "ExportNamedDeclaration")
        found.push(...namedExports(value, item, name, seen));
    }
    return found;
  }

  function namedExports(
    value: SelectorValue,
    declaration: Export,
    name: string | undefined,
    seen: Set<string>,
  ): SelectorValue[] {
    if (declaration.exportKind === "type") return [];
    const found = declaration.declaration
      ? declaredExports({ ...value, node: declaration.declaration }, name)
      : [];
    for (const specifier of declaration.specifiers) {
      if (specifier.exportKind === "type" || (name && name !== exportName(specifier.exported)))
        continue;
      if (!declaration.source) found.push({ ...value, node: specifier.local });
      else
        found.push(...reexported(value, declaration, exportName(specifier.local), new Set(seen)));
    }
    return found;
  }

  function namespaceExports(
    value: SelectorValue,
    declaration: ESTree.ExportAllDeclaration,
    name: string | undefined,
    seen: Set<string>,
  ): SelectorValue[] {
    if (declaration.exportKind === "type") return [];
    if (declaration.exported && name && name !== exportName(declaration.exported)) return [];
    const target = resolveProjectImport(value.filename, String(declaration.source.value), config);
    const program = target ? load(target) : undefined;
    if (!target || !program) return [];
    const namespace = { node: program, filename: target };
    return declaration.exported ? [namespace] : exported(namespace, name, seen);
  }

  function imported(
    value: SelectorValue,
    binding: ESTree.Node,
    seen: Set<ESTree.Node>,
  ): SelectorValue[] {
    if (binding.type !== "ImportSpecifier" && binding.type !== "ImportNamespaceSpecifier")
      return [];
    const declaration = parent({ ...value, node: binding });
    if (declaration?.type !== "ImportDeclaration" || declaration.importKind === "type") return [];
    if (binding.type === "ImportSpecifier" && binding.importKind === "type") return [];
    const target = resolveProjectImport(value.filename, String(declaration.source.value), config);
    const program = target ? load(target) : undefined;
    if (!target || !program) return [];
    const namespace = { node: program, filename: target };
    return binding.type === "ImportSpecifier"
      ? exported(namespace, exportName(binding.imported)).flatMap((item) =>
          resolve(item, new Set(seen)),
        )
      : [namespace];
  }

  function identifier(value: SelectorValue, seen: Set<ESTree.Node>): SelectorValue[] {
    const binding = definition(value);
    if (!binding) return [value];
    if (binding.type === "FunctionDeclaration") return [{ ...value, node: binding }];
    if (binding.type !== "VariableDeclarator" || !binding.init)
      return imported(value, binding, seen);
    const declaration = parent({ ...value, node: binding });
    return declaration?.type === "VariableDeclaration" && declaration.kind === "const"
      ? resolve({ ...value, node: binding.init }, seen)
      : [];
  }

  function member(
    value: SelectorValue,
    node: ESTree.MemberExpression,
    seen: Set<ESTree.Node>,
  ): SelectorValue[] {
    const name = memberName(node);
    if (!name) return [];
    return resolve({ ...value, node: node.object }, seen).flatMap((object) => {
      if (object.node.type === "Program")
        return exported(object, name).flatMap((item) => resolve(item, new Set(seen)));
      if (object.node.type !== "ObjectExpression") return [];
      const property = object.node.properties.find(
        (item) => item.type === "Property" && memberName(item) === name,
      );
      return property?.type === "Property"
        ? resolve({ ...object, node: property.value }, new Set(seen))
        : [];
    });
  }

  function resolve(input: SelectorValue, seen = new Set<ESTree.Node>()): SelectorValue[] {
    if (seen.has(input.node)) return [];
    seen.add(input.node);
    const node =
      input.filename === filename && source
        ? resolveLocalValue(source, input.node)
        : unwrapExpression(input.node);
    const value = { ...input, node };
    if (node.type === "Identifier") return identifier(value, seen);
    if (node.type === "MemberExpression") return member(value, node, seen);
    if (node.type === "ConditionalExpression")
      return [node.consequent, node.alternate].flatMap((branch) =>
        resolve({ ...value, node: branch }, new Set(seen)),
      );
    if (node.type === "LogicalExpression")
      return [node.left, node.right].flatMap((branch) =>
        resolve({ ...value, node: branch }, new Set(seen)),
      );
    if (node.type === "SequenceExpression") {
      const last = node.expressions.at(-1);
      return last ? resolve({ ...value, node: last }, seen) : [];
    }
    return [value];
  }

  function annotations(value: SelectorValue): ESTree.Node[] {
    const found: ESTree.Node[] = [];
    if (value.node.type === "Identifier") {
      const binding = definition(value);
      const type = binding ? annotation(binding) : undefined;
      if (type) found.push(type);
    }
    let node: ESTree.Node | undefined = value.node;
    while (node) {
      const type = annotation(node);
      if (type) found.push(type);
      const ancestor = parent({ ...value, node });
      if (ancestor?.type === "VariableDeclarator") {
        const type = annotation(ancestor);
        if (type) found.push(type);
        break;
      }
      if (!ancestor || unwrapExpression(ancestor) === ancestor) break;
      node = ancestor;
    }
    return found;
  }

  return { resolve, exported, annotations, load };
}
