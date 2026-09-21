import { CrewState } from "../crew-state/main.ts";
import type { ParsedArguments } from "./arguments.ts";
import { reportSharedFailure } from "./crew-result.ts";
import { report } from "./result.ts";

export async function runCrewOwn(
  parsed: ParsedArguments,
): Promise<"reported" | "invalid-arguments"> {
  const requestId = parsed.crew["--request"];
  const ownerLabel = parsed.crew["--owner-label"];
  if (requestId === undefined || ownerLabel === undefined) {
    return "invalid-arguments";
  }

  const { repeated, result } = await CrewState.own({
    projectRoot: process.cwd(),
    requestId,
    ownerLabel,
    takeover: parsed.takeover,
  });

  if (reportSharedFailure(parsed, "crew_own", result)) {
    return "reported";
  }

  if (result.status === "held") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "ownership_held",
        blockers: [
          {
            reason: "ownership_held",
            ownerLabel: result.ownership.ownerLabel,
            acquiredAt: result.ownership.acquiredAt,
            revision: result.ownership.revision,
          },
        ],
        operation: "crew_own",
      },
      lines: [
        `${result.ownership.ownerLabel} owns this crew since ${result.ownership.acquiredAt}.`,
        "Add --takeover to invalidate that ownership and take the crew.",
      ],
    });
    return "reported";
  }

  if (result.status !== "acquired") {
    return "invalid-arguments";
  }

  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "ownership_acquired",
      blockers: [],
      operation: "crew_own",
      data: {
        ownerToken: result.ownership.token,
        ownerLabel: result.ownership.ownerLabel,
        acquiredAt: result.ownership.acquiredAt,
        revision: result.ownership.revision,
        replaced: result.replaced === null ? null : result.replaced.ownerLabel,
        repeated,
      },
    },
    lines: [
      result.replaced === null
        ? `${result.ownership.ownerLabel} owns this crew.`
        : `${result.ownership.ownerLabel} took this crew from ${result.replaced.ownerLabel}.`,
      `Owner token: ${result.ownership.token}`,
    ],
  });
  return "reported";
}
