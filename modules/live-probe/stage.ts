/** One finished check, before the run adds what every check shares. */
export type Staged = {
  name: string;
  state: "passed" | "failed" | "skipped";
  detail: string;
  outputs: string[];
  evidence: Array<{ label: string; path: string | null; identity: string | null }>;
  cleanup: { state: "removed" | "retained" | "failed" | "not-applicable"; detail: string };
};

const NOTHING_CREATED = {
  state: "not-applicable" as const,
  detail: "This check creates no resource of its own.",
};

export function passed(
  name: string,
  detail: string,
  extra: Partial<Omit<Staged, "name" | "state" | "detail">> = {},
): Staged {
  return {
    name,
    state: "passed",
    detail,
    outputs: extra.outputs ?? [],
    evidence: extra.evidence ?? [],
    cleanup: extra.cleanup ?? NOTHING_CREATED,
  };
}

export function failed(
  name: string,
  detail: string,
  extra: Partial<Omit<Staged, "name" | "state" | "detail">> = {},
): Staged {
  return {
    name,
    state: "failed",
    detail,
    outputs: extra.outputs ?? [],
    evidence: extra.evidence ?? [],
    cleanup: extra.cleanup ?? NOTHING_CREATED,
  };
}

/** A check that was attempted and could not run. It proves nothing, exactly like a failure. */
export function skipped(name: string, detail: string): Staged {
  return { name, state: "skipped", detail, outputs: [], evidence: [], cleanup: NOTHING_CREATED };
}

/** True when every named check already passed, so the work that depends on them may run. */
export function passedAll(staged: Staged[], names: string[]): boolean {
  return names.every((name) => staged.find((one) => one.name === name)?.state === "passed");
}

/**
 * Records every named check that never ran as skipped.
 * A check whose ground was never reached names the check that stopped it, so a reader sees why
 * it proves nothing rather than finding it silently absent.
 */
export function skipRest(staged: Staged[], names: string[], detail: string): void {
  for (const name of names) {
    if (!staged.some((one) => one.name === name)) {
      staged.push(skipped(name, detail));
    }
  }
}
