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
  "--question": "questionId",
  "--answer": "answerId",
  "--approval": "approvalId",
  "--submission": "submissionId",
  "--review": "reviewId",
  "--operation": "operationId",
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
  delivery: "github-source" | "jsr" | undefined;
  packageVersion: string | undefined;
  approvedUpdate: string | undefined;
  approvedPlan: string | undefined;
  approvedProbe: string | undefined;
  approvedCleanup: string | undefined;
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
    delivery: undefined,
    packageVersion: undefined,
    approvedUpdate: undefined,
    approvedPlan: undefined,
    approvedProbe: undefined,
    approvedCleanup: undefined,
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
    } else if (argument === "--delivery") {
      const value = valueOf(args, index + 1);
      if (value !== "github-source" && value !== "jsr") {
        parsed.unsupported.push(argument);
        continue;
      }

      index += 1;
      parsed.delivery = value;
    } else if (argument === "--package-version" || argument === "--approved-update") {
      const value = valueOf(args, index + 1);
      if (value === undefined) {
        parsed.unsupported.push(argument);
        continue;
      }

      index += 1;
      if (argument === "--package-version") {
        parsed.packageVersion = value;
      } else {
        parsed.approvedUpdate = value;
      }
    } else if (
      argument === "--approved-plan" ||
      argument === "--approved-probe" ||
      argument === "--approved-cleanup"
    ) {
      // A flag with no value of its own never swallows the flag that follows it.
      const value = valueOf(args, index + 1);
      if (value === undefined) {
        parsed.unsupported.push(argument);
        continue;
      }

      index += 1;
      if (argument === "--approved-plan") {
        parsed.approvedPlan = value;
      } else if (argument === "--approved-probe") {
        parsed.approvedProbe = value;
      } else {
        parsed.approvedCleanup = value;
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

/** What every mutation carries: the caller's name for it, and the ownership it acts under. */
export type Mutation = { requestId: string; ownerToken: string };

export function readMutation(parsed: ParsedArguments): Mutation | null {
  const { requestId, ownerToken } = parsed.crew;
  return requestId === undefined || ownerToken === undefined ? null : { requestId, ownerToken };
}

/**
 * What a mutation of one inspected assignment carries.
 * The revision is the one the caller read, so a state that moved under it is refused rather
 * than written over.
 */
export type AssignmentRequest = Mutation & {
  assignmentId: string;
  revision: number;
  inputPath: string;
};

export function readAssignmentRequest(parsed: ParsedArguments): AssignmentRequest | null {
  const mutation = readMutation(parsed);
  const { assignmentId, inputPath } = parsed.crew;
  const revision = readRevision(parsed);
  return mutation === null ||
    assignmentId === undefined ||
    inputPath === undefined ||
    revision === null
    ? null
    : { ...mutation, assignmentId, revision, inputPath };
}

/** Reads a record revision the caller states. A revision is a whole number or it is not one. */
export function readRevision(parsed: ParsedArguments): number | null {
  const raw = parsed.crew.revision;
  return raw === undefined || !/^\d+$/.test(raw) ? null : Number(raw);
}

/** True when the request carries a selection override or a probe approval it has no use for. */
export function hasSelectionOrProbeArguments(parsed: ParsedArguments): boolean {
  return (
    parsed.approvedProbe !== undefined ||
    parsed.approvedCleanup !== undefined ||
    parsed.overrides.operator !== undefined ||
    parsed.overrides.crew !== undefined
  );
}

/** True when the request carries a crew-state flag the addressed command has no use for. */
export function hasCrewArguments(parsed: ParsedArguments): boolean {
  return parsed.takeover || Object.keys(parsed.crew).length > 0;
}

/** True when the request carries a release selector only the update path reads. */
export function hasUpdateArguments(parsed: ParsedArguments): boolean {
  return (
    parsed.delivery !== undefined ||
    parsed.packageVersion !== undefined ||
    parsed.approvedUpdate !== undefined
  );
}
