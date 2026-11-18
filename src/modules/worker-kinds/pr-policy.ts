type PrGuard =
  | { guard: "ownership"; handedOff: boolean }
  | { guard: "round"; rounds: number }
  | { guard: "worktree_clean"; changed: boolean };

/** Phase output and imperative owners use the same PR safety policy. */
export function refusesPrGuard(facts: PrGuard): boolean {
  if (facts.guard === "ownership") return facts.handedOff;
  if (facts.guard === "round") return facts.rounds >= 2;
  return facts.changed;
}
