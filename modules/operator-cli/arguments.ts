export type AgentTarget = "opencode" | "claude-code";

export type SelectionOverrides = {
  operator?: { host?: AgentTarget; model?: string };
  crew?: { host?: AgentTarget; model?: string };
};

// Crew and work commands share these value flags; the keys map each spelling to its field.
const crewFieldByFlag = {
  "--request": "requestId",
  "--owner-token": "ownerToken",
  "--owner-label": "ownerLabel",
  "--ownership-revision": "ownershipRevision",
  "--assignment": "assignmentId",
  "--attempt": "attemptId",
  "--revision": "revision",
  "--input": "inputPath",
  "--commit": "baseCommit",
  "--branch": "branch",
  "--worktree": "worktreePath",
  "--inspection": "inspectionIdentity",
  "--submission": "submissionId",
  "--review": "reviewId",
  "--pr-head": "prHead",
} as const;

type CrewFlag = keyof typeof crewFieldByFlag;

export type CrewArguments = Partial<Record<(typeof crewFieldByFlag)[CrewFlag], string>>;

function isCrewFlag(value: string): value is CrewFlag {
  return Object.hasOwn(crewFieldByFlag, value);
}

export type ParsedArguments = {
  json: boolean;
  targets: AgentTarget[];
  approvedPlan: string | undefined;
  approvedProbe: string | undefined;
  overrides: SelectionOverrides;
  takeover: boolean;
  crew: CrewArguments;
  unsupported: string[];
};

// Operator uses its own short flags; the recorded host identifiers stay the full host names.
const targetByFlag = { "--opencode": "opencode", "--claude": "claude-code" } as const;
const flagByTarget = { opencode: "--opencode", "claude-code": "--claude" } as const;

type SelectionFlag = { role: "operator" | "crew"; field: "host" | "model" };

const selectionFlags = new Map<string, SelectionFlag>([
  ["--operator-host", { role: "operator", field: "host" }],
  ["--operator-model", { role: "operator", field: "model" }],
  ["--crew-host", { role: "crew", field: "host" }],
  ["--crew-model", { role: "crew", field: "model" }],
]);

export function targetFlag(target: AgentTarget): string {
  return flagByTarget[target];
}

function isHost(value: string): value is AgentTarget {
  return value === "opencode" || value === "claude-code";
}

/** Reads the value of a flag that takes one, refusing a missing value or another flag. */
function valueOf(args: string[], index: number): string | undefined {
  const value = args[index];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

export function parseArguments(args: string[]): ParsedArguments {
  const parsed: ParsedArguments = {
    json: false,
    targets: [],
    approvedPlan: undefined,
    approvedProbe: undefined,
    overrides: {},
    takeover: false,
    crew: {},
    unsupported: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const selection = argument === undefined ? undefined : selectionFlags.get(argument);

    if (argument === "--json") {
      parsed.json = true;
    } else if (argument === "--takeover") {
      parsed.takeover = true;
    } else if (argument !== undefined && isCrewFlag(argument)) {
      const value = valueOf(args, index + 1);
      if (value === undefined) {
        parsed.unsupported.push(argument);
        continue;
      }

      index += 1;
      parsed.crew[crewFieldByFlag[argument]] = value;
    } else if (argument === "--opencode" || argument === "--claude") {
      const target = targetByFlag[argument];
      if (!parsed.targets.includes(target)) {
        parsed.targets.push(target);
      }
    } else if (argument === "--approved-plan" || argument === "--approved-probe") {
      // A flag with no value of its own never swallows the flag that follows it.
      const value = valueOf(args, index + 1);
      if (value === undefined) {
        parsed.unsupported.push(argument);
        continue;
      }

      index += 1;
      if (argument === "--approved-plan") {
        parsed.approvedPlan = value;
      } else {
        parsed.approvedProbe = value;
      }
    } else if (argument !== undefined && selection !== undefined) {
      const value = valueOf(args, index + 1);
      if (value === undefined) {
        parsed.unsupported.push(argument);
        continue;
      }

      index += 1;
      // An unknown host is refused rather than replaced with an available one.
      if (selection.field === "model") {
        (parsed.overrides[selection.role] ??= {}).model = value;
      } else if (isHost(value)) {
        (parsed.overrides[selection.role] ??= {}).host = value;
      } else {
        parsed.unsupported.push(argument);
      }
    } else if (argument !== undefined) {
      parsed.unsupported.push(argument);
    }
  }

  return parsed;
}

/** True when the request carries a selection override or a probe approval it has no use for. */
export function hasSelectionOrProbeArguments(parsed: ParsedArguments): boolean {
  return (
    parsed.approvedProbe !== undefined ||
    parsed.overrides.operator !== undefined ||
    parsed.overrides.crew !== undefined
  );
}

/** True when the request carries a crew-state flag the addressed command has no use for. */
export function hasCrewArguments(parsed: ParsedArguments): boolean {
  return parsed.takeover || Object.keys(parsed.crew).length > 0;
}
