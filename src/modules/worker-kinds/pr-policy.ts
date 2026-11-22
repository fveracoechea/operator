type PrGuard =
  | { guard: "ownership"; handedOff: boolean }
  | { guard: "round"; rounds: number }
  | { guard: "worktree_clean"; changed: boolean };

/** Phase output and imperative owners use the same PR safety policy. */
export function refusesPrGuard(facts: PrGuard): boolean {
  switch (facts.guard) {
    case "ownership": {
      return facts.handedOff;
    }
    case "round": {
      return facts.rounds >= 2;
    }
    case "worktree_clean": {
      return facts.changed;
    }
  }
}
