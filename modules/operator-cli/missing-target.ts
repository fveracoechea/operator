import type { ParsedArguments } from "./arguments.ts";
import { report } from "./result.ts";
import { usage } from "./usage.ts";

/** Operator never infers a target from the agents it finds, so the caller must name one. */
export function reportMissingTarget(
  parsed: ParsedArguments,
  operation:
    | "install"
    | "update_plan"
    | "update_apply"
    | "setup_plan"
    | "setup_apply"
    | "setup_readiness"
    | "setup_probe_plan"
    | "setup_probe_apply"
    | "crew_next",
): void {
  console.error(usage);
  report({
    json: parsed.json,
    result: {
      outcome: "invalid",
      reason: "missing_target",
      blockers: [{ reason: "missing_target", required: ["--opencode", "--claude"] }],
      operation,
    },
    lines: [],
  });
}
