/** Draft association with internal review defaults only an absent successor to review. */
export function reviewHandoffTarget(outgoing: { nextKind: string | null } | null) {
  return outgoing?.nextKind ?? "review";
}
