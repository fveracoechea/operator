import { CrewState } from "../crew-state/main.ts";
import type { ParsedArguments } from "./arguments.ts";
import { reportSharedFailure } from "./crew-result.ts";
import { report } from "./result.ts";

export async function runCrewOwn(
  parsed: ParsedArguments,
): Promise<"reported" | "invalid-arguments"> {
  const { requestId, ownerLabel, ownershipRevision } = parsed.crew;
  if (requestId === undefined || ownerLabel === undefined) {
    return "invalid-arguments";
  }

  // A takeover names the ownership revision it saw; a first claim has none to name.
  if (parsed.takeover === (ownershipRevision === undefined)) {
    return "invalid-arguments";
  }
  if (ownershipRevision !== undefined && !/^\d+$/.test(ownershipRevision)) {
    return "invalid-arguments";
  }

  const { repeated, result } = await CrewState.own({
    projectRoot: process.cwd(),
    requestId,
    ownerLabel,
    takeover: parsed.takeover,
    ownershipRevision: ownershipRevision === undefined ? null : Number(ownershipRevision),
  });

  if (reportSharedFailure(parsed, "crew_own", result)) {
    return "reported";
  }

  if (result.status === "stale-ownership-revision") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "stale_revision",
        blockers: [
          {
            reason: "stale_revision",
            ownerLabel: result.ownership.ownerLabel,
            recordedRevision: result.ownership.revision,
          },
        ],
        operation: "crew_own",
      },
      lines: [
        `This crew is at ownership revision ${result.ownership.revision}.`,
        "Read the ownership again, then take over from the revision you inspected.",
      ],
    });
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
