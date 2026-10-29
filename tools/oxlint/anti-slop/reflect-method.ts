import type { ESTree, SourceCode } from "@oxlint/plugins";
import { arrayMethodTarget, resolveArrayBinding } from "./array-method.ts";

export function isGlobalReflectMethod(
  source: SourceCode,
  node: ESTree.Node,
  name: string,
): boolean {
  const member = arrayMethodTarget(node);
  if (
    member?.name !== name ||
    // Stryker disable next-line ConditionalExpression: equivalent: only an identifier has a name, so the name check alone refuses other objects; this check narrows the type
    member.object.type !== "Identifier" ||
    member.object.name !== "Reflect"
  )
    return false;
  const variable = resolveArrayBinding(source, member.object);
  // A global has no definition. The scope manager always declares the built-in Reflect global.
  // Stryker disable next-line OptionalChaining: equivalent: the built-in Reflect global always resolves, so the binding is never null
  return !variable?.defs.length;
}
