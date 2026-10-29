import type { ESTree, Scope, SourceCode } from "@oxlint/plugins";
import { resolveArrayBinding } from "./array-method.ts";
import { resolvedTypeMatches } from "./type-alias-resolution.ts";

type RuntimeFunction = ESTree.ArrowFunctionExpression | ESTree.Function;

function isRuntimeFunction(node: ESTree.Node): node is RuntimeFunction {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression"
  );
}

function isGlobalType(source: SourceCode, type: ESTree.TSTypeReference, name: string): boolean {
  // A global has no definition: a built-in value such as Object resolves to a binding without one,
  // and a library type such as Record resolves to none. A qualified name never has a global's text.
  return (
    source.getText(type.typeName) === name &&
    !resolveArrayBinding(source, type.typeName)?.defs.length
  );
}

// A target that claims nothing about the value would turn the exemption into a cast.
function isBroadTarget(source: SourceCode, type: ESTree.TSType): boolean {
  return resolvedTypeMatches(source, type, (resolved, matches) => {
    if (["TSAnyKeyword", "TSUnknownKeyword", "TSObjectKeyword"].includes(resolved.type))
      return true;
    if (resolved.type === "TSTypeLiteral") return resolved.members.length === 0;
    if (resolved.type === "TSUnionType") return resolved.types.some(matches);
    if (resolved.type === "TSIntersectionType") return resolved.types.every(matches);
    // Stryker disable next-line ConditionalExpression: equivalent: another type has no type name, so the name checks below refuse it; this check narrows the type
    if (resolved.type !== "TSTypeReference") return false;
    // A dictionary of unknown values is an unparsed payload under another name.
    const values = resolved.typeArguments?.params[1];
    if (isGlobalType(source, resolved, "Record") && values) return matches(values);
    return isGlobalType(source, resolved, "Object");
  });
}

// A type parameter of an enclosing function, class, or type makes the predicate generic.
function usesTypeParameter(source: SourceCode, node: RuntimeFunction, type: ESTree.TSType) {
  for (let scope: Scope | null = source.getScope(node); scope; scope = scope.upper) {
    for (const variable of scope.variables) {
      if (!variable.defs.some((definition) => definition.node.type === "TSTypeParameter")) continue;
      const inside = variable.references.some(
        ({ identifier }) => identifier.start >= type.start && identifier.end <= type.end,
      );
      if (inside) return true;
    }
  }
  return false;
}

// Only a non-generic `value is T` predicate with a specific target names a subject.
function predicateSubjectName(source: SourceCode, node: RuntimeFunction): string | null {
  if (node.typeParameters) return null;
  const predicate = node.returnType?.typeAnnotation;
  if (predicate?.type !== "TSTypePredicate" || predicate.asserts) return null;
  // Stryker disable next-line ConditionalExpression, LogicalOperator: equivalent: a `this` predicate names no parameter and a non-asserts predicate always has a type; these checks narrow the types
  if (predicate.parameterName.type !== "Identifier" || !predicate.typeAnnotation) return null;
  const target = predicate.typeAnnotation.typeAnnotation;
  return isBroadTarget(source, target) || usesTypeParameter(source, node, target)
    ? null
    : predicate.parameterName.name;
}

/**
 * Return the subject of an explicit, non-generic `value is T` validator.
 * Only a plain parameter annotated exactly `unknown` qualifies. Eligibility is not proof that the predicate is true.
 */
export function validatorSubject(
  source: SourceCode,
  node: ESTree.Node,
): ESTree.BindingIdentifier | null {
  if (!isRuntimeFunction(node)) return null;
  // A null name matches no parameter.
  const name = predicateSubjectName(source, node);
  for (const parameter of node.params) {
    // Stryker disable next-line ConditionalExpression: equivalent: only an identifier parameter has a name, so the name check alone refuses the others; this check narrows the type
    if (parameter.type !== "Identifier") continue;
    if (
      parameter.name === name &&
      parameter.typeAnnotation?.typeAnnotation.type === "TSUnknownKeyword"
    )
      return parameter;
  }
  return null;
}

function memberRoot(node: ESTree.Node): ESTree.Node {
  if (node.type === "ChainExpression") return memberRoot(node.expression);
  return node.type === "MemberExpression" ? memberRoot(node.object) : node;
}

function nearestRuntimeFunction(node: ESTree.Node): RuntimeFunction | null {
  for (let current = node.parent; current; current = current.parent) {
    if (isRuntimeFunction(current)) return current;
  }
  return null;
}

/** Return whether an expression is the validator subject, or a member chain rooted in its binding. */
export function readsValidatorSubject(source: SourceCode, expression: ESTree.Node): boolean {
  const owner = nearestRuntimeFunction(expression);
  const subject = owner && validatorSubject(source, owner);
  // Without a subject, or with a root that is no identifier, no definition matches.
  const root = memberRoot(expression);
  // A parameter definition names its binding identifier, so an alias or a shadowing binding never matches.
  return resolveArrayBinding(source, root)?.defs.some((def) => def.name === subject) ?? false;
}
