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
    member.object.type !== "Identifier" ||
    member.object.name !== "Reflect"
  )
    return false;
  const variable = resolveArrayBinding(source, member.object);
  return variable === null || variable.defs.length === 0;
}
