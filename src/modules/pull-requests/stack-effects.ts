type Observation = "requested" | "original" | "other" | "unknown";

/** An uncertain stack write is observed, never repeated from an original or unreadable value. */
export function stackEffect(attempted: boolean, observed: Observation) {
  if (observed === "requested") return "verified" as const;
  if (attempted || observed !== "original") return "blocked" as const;
  return "write" as const;
}

export function unchangedIntegration(input: {
  head: string;
  candidate: string | null;
  base: string;
  targetBranch: string;
}) {
  return input.head === input.candidate && input.base === input.targetBranch;
}
