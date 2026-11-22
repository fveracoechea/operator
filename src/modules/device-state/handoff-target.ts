/** Draft association with internal review defaults only an absent successor to review. */
export function reviewHandoffTarget(
  outgoing: { nextKind: string | null; completion?: string } | null,
) {
  return outgoing?.nextKind ?? (outgoing?.completion === "commit" ? "commit-review" : "review");
}
