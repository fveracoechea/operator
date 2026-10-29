import type { ESTree, SourceCode } from "@oxlint/plugins";
import { resolveArrayBinding } from "./array-method.ts";

type Substitution = { readonly type: ESTree.TSType; readonly substitutions: Substitutions };
type Substitutions = ReadonlyMap<string, Substitution>;

export type ResolvedTypeMatcher = (
  type: ESTree.TSType,
  matches: (child: ESTree.TSType) => boolean,
) => boolean;

// The scope manager resolves the name, so a type parameter or a nested declaration shadows a module alias.
function visibleAlias(
  source: SourceCode,
  reference: ESTree.TSTypeReference,
): ESTree.TSTypeAliasDeclaration | null {
  const variable = resolveArrayBinding(source, reference.typeName);
  const definition = variable?.defs.find((def) => def.node.type === "TSTypeAliasDeclaration");
  return definition?.node.type === "TSTypeAliasDeclaration" ? definition.node : null;
}

function aliasSubstitutions(
  alias: ESTree.TSTypeAliasDeclaration,
  reference: ESTree.TSTypeReference,
  base: Substitutions,
): Substitutions | null {
  const next = new Map(base);
  for (const [index, parameter] of (alias.typeParameters?.params ?? []).entries()) {
    const explicit = reference.typeArguments?.params[index];
    const argument = explicit ?? parameter.default;
    if (!argument) return null;
    next.set(parameter.name.name, {
      type: argument,
      substitutions: new Map(explicit ? base : next),
    });
  }
  return next;
}

/** Match a type after resolving visible local aliases and substituting their type arguments. */
export function resolvedTypeMatches(
  source: SourceCode,
  type: ESTree.TSType,
  matcher: ResolvedTypeMatcher,
): boolean {
  function evaluate(
    current: ESTree.TSType,
    substitutions: Substitutions,
    resolving: ReadonlySet<ESTree.TSTypeAliasDeclaration>,
  ): boolean {
    if (current.type === "TSTypeReference") {
      // Only an identifier's text can name a type parameter. A qualified name never matches.
      const substitution = substitutions.get(source.getText(current.typeName));
      if (substitution && !current.typeArguments)
        return evaluate(substitution.type, substitution.substitutions, resolving);
      const alias = visibleAlias(source, current);
      const next =
        alias && !resolving.has(alias) && aliasSubstitutions(alias, current, substitutions);
      if (alias && next)
        return evaluate(alias.typeAnnotation, next, new Set([...resolving, alias]));
    }
    return matcher(current, (child) => evaluate(child, substitutions, resolving));
  }
  return evaluate(type, new Map(), new Set());
}
