import type { ESTree, SourceCode } from "@oxlint/plugins";

export type ParameterOwner =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

/** Visit every function and signature that declares parameters or a return type. */
export function parameterOwnerVisitor(check: (node: ParameterOwner) => void) {
  return {
    ArrowFunctionExpression: check,
    FunctionDeclaration: check,
    FunctionExpression: check,
    TSCallSignatureDeclaration: check,
    TSConstructSignatureDeclaration: check,
    TSConstructorType: check,
    TSDeclareFunction: check,
    TSEmptyBodyFunctionExpression: check,
    TSFunctionType: check,
    TSMethodSignature: check,
  };
}

/** Return whether a type is or contains TypeScript's absorbing unknown top type. */
export function containsUnknownType(type: ESTree.TSType): boolean {
  if (type.type === "TSUnknownKeyword") return true;
  return type.type === "TSUnionType" && type.types.some(containsUnknownType);
}

/** Return the annotation on a parameter or on the binding it wraps. */
export function parameterTypeAnnotation(
  parameter: ESTree.ParamPattern,
): ESTree.TSTypeAnnotation | null | undefined {
  if (parameter.type === "TSParameterProperty") return parameterTypeAnnotation(parameter.parameter);
  if (parameter.type === "AssignmentPattern")
    return parameter.typeAnnotation ?? parameterTypeAnnotation(parameter.left);
  return parameter.typeAnnotation;
}

/** Return the local binding text of a parameter, without its annotation or default. */
export function parameterBindingName(parameter: ESTree.ParamPattern, source: SourceCode): string {
  if (parameter.type === "TSParameterProperty")
    return parameterBindingName(parameter.parameter, source);
  if (parameter.type === "AssignmentPattern") return parameterBindingName(parameter.left, source);
  if (parameter.type === "RestElement") return parameterBindingName(parameter.argument, source);
  const text = source.getText(parameter);
  const annotation = parameter.typeAnnotation;
  return annotation ? text.slice(0, annotation.start - parameter.start).trimEnd() : text;
}
