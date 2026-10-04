export type AgentTarget = "opencode" | "claude-code";

export type SelectionOverrides = {
  operator?: { host?: AgentTarget; model?: string };
  crew?: { host?: AgentTarget; model?: string };
};

// Crew and work commands share these value flags; each spelling maps to its field and the
// placeholder the usage text shows for its value.
const crewFlags = {
  "--request": { field: "requestId", shows: "<id>" },
  "--owner-token": { field: "ownerToken", shows: "<token>" },
  "--owner-label": { field: "ownerLabel", shows: "<label>" },
  "--ownership-revision": { field: "ownershipRevision", shows: "<n>" },
  "--assignment": { field: "assignmentId", shows: "<id>" },
  "--attempt": { field: "attemptId", shows: "<id>" },
  "--revision": { field: "revision", shows: "<n>" },
  "--input": { field: "inputPath", shows: "<path|->" },
  "--commit": { field: "baseCommit", shows: "<sha>" },
  "--base": { field: "newBase", shows: "<sha>" },
  "--branch": { field: "branch", shows: "<name>" },
  "--worktree": { field: "worktreePath", shows: "<path>" },
  "--inspection": { field: "inspectionIdentity", shows: "<identity>" },
  "--question": { field: "questionId", shows: "<id>" },
  "--answer": { field: "answerId", shows: "<id>" },
  "--approval": { field: "approvalId", shows: "<id>" },
  "--submission": { field: "submissionId", shows: "<id>" },
  "--review": { field: "reviewId", shows: "<id>" },
  "--operation": { field: "operationId", shows: "<id>" },
  "--source": { field: "sourceId", shows: "<id>" },
  "--record": { field: "recordId", shows: "<id>" },
  "--plan-revision": { field: "planRevision", shows: "<revision>" },
  "--part": { field: "part", shows: "<k>" },
  "--run": { field: "runId", shows: "<id>" },
  "--root": { field: "projectRoot", shows: "<path>" },
} as const;

export type CrewFlag = keyof typeof crewFlags;
type CrewField<F extends CrewFlag> = (typeof crewFlags)[F]["field"];

export type CrewArguments = { [F in CrewFlag as CrewField<F>]?: string };

function isCrewFlag(value: string): value is CrewFlag {
  return Object.hasOwn(crewFlags, value);
}

/**
 * One parsed request. `Required` names the crew flags the operation table already proved
 * present, so a handler reads them with no guard of its own.
 */
export type ParsedArguments<Required extends CrewFlag = never> = {
  json: boolean;
  targets: AgentTarget[];
  delivery: "github-source" | "jsr" | undefined;
  packageVersion: string | undefined;
  approvedUpdate: string | undefined;
  approvedPlan: string | undefined;
  approvedProbe: string | undefined;
  staleOnly: boolean;
  approvedCleanup: string | undefined;
  configSets: string[];
  configUnsets: string[];
  overrides: SelectionOverrides;
  takeover: boolean;
  plan: boolean;
  event: boolean;
  operatorBin: string | undefined;
  crew: CrewArguments & { [F in Required as CrewField<F>]: string };
  /** Each flag the request gave, in order, with its value. */
  given: { flag: FlagName; value: string | null }[];
  unsupported: string[];
};

/** True when the request gave every one of these crew flags. */
export function hasFlags<R extends CrewFlag>(
  parsed: ParsedArguments,
  required: readonly R[],
): parsed is ParsedArguments<R> {
  return required.every((flag) => parsed.crew[crewFlags[flag].field] !== undefined);
}

// Operator uses its own short flags; the recorded host identifiers stay the full host names.
const flagByTarget = { opencode: "--opencode", "claude-code": "--claude" } as const;

export function targetFlag(target: AgentTarget): string {
  return flagByTarget[target];
}

/**
 * How one flag reads. A switch takes no value. A flag that takes a value shows a placeholder
 * in the usage text, and its reader refuses a value outside its choices by returning false.
 */
type FlagSpec =
  | { shows: null; read: (parsed: ParsedArguments) => void }
  | { shows: string; read: (parsed: ParsedArguments, value: string) => boolean };

function switchFlag(read: (parsed: ParsedArguments) => void): FlagSpec {
  return { shows: null, read };
}

function valueFlag(
  shows: string,
  read: (parsed: ParsedArguments, value: string) => void,
): FlagSpec {
  return {
    shows,
    read: (parsed, value) => {
      read(parsed, value);
      return true;
    },
  };
}

function choiceFlag<V extends string>(
  shows: string,
  choices: readonly V[],
  read: (parsed: ParsedArguments, value: V) => void,
): FlagSpec {
  return {
    shows,
    read: (parsed, value) => {
      const choice = choices.find((one) => one === value);
      if (choice !== undefined) read(parsed, choice);
      return choice !== undefined;
    },
  };
}

function addTarget(parsed: ParsedArguments, target: AgentTarget): void {
  if (!parsed.targets.includes(target)) parsed.targets.push(target);
}

const hosts = ["opencode", "claude-code"] as const;

// The flags that are not crew flags. An unknown host is refused rather than replaced with an
// available one.
const otherFlags = {
  "--json": switchFlag((parsed) => {
    parsed.json = true;
  }),
  "--takeover": switchFlag((parsed) => {
    parsed.takeover = true;
  }),
  "--plan": switchFlag((parsed) => {
    parsed.plan = true;
  }),
  "--stale-only": switchFlag((parsed) => {
    parsed.staleOnly = true;
  }),
  "--event": switchFlag((parsed) => {
    parsed.event = true;
  }),
  "--opencode": switchFlag((parsed) => addTarget(parsed, "opencode")),
  "--claude": switchFlag((parsed) => addTarget(parsed, "claude-code")),
  "--set": valueFlag("<path=value>", (parsed, value) => parsed.configSets.push(value)),
  "--unset": valueFlag("<path>", (parsed, value) => parsed.configUnsets.push(value)),
  "--delivery": choiceFlag("<path>", ["github-source", "jsr"], (parsed, value) => {
    parsed.delivery = value;
  }),
  "--package-version": valueFlag("<v>", (parsed, value) => {
    parsed.packageVersion = value;
  }),
  "--approved-update": valueFlag("<id>", (parsed, value) => {
    parsed.approvedUpdate = value;
  }),
  "--approved-plan": valueFlag("<planId>", (parsed, value) => {
    parsed.approvedPlan = value;
  }),
  "--approved-probe": valueFlag("<probeId>", (parsed, value) => {
    parsed.approvedProbe = value;
  }),
  "--approved-cleanup": valueFlag("<cleanupId>", (parsed, value) => {
    parsed.approvedCleanup = value;
  }),
  "--operator-bin": valueFlag("<path>", (parsed, value) => {
    parsed.operatorBin = value;
  }),
  "--operator-host": choiceFlag("<host>", hosts, (parsed, value) => {
    (parsed.overrides.operator ??= {}).host = value;
  }),
  "--operator-model": valueFlag("<model>", (parsed, value) => {
    (parsed.overrides.operator ??= {}).model = value;
  }),
  "--crew-host": choiceFlag("<host>", hosts, (parsed, value) => {
    (parsed.overrides.crew ??= {}).host = value;
  }),
  "--crew-model": valueFlag("<model>", (parsed, value) => {
    (parsed.overrides.crew ??= {}).model = value;
  }),
} satisfies Record<`--${string}`, FlagSpec>;

export type FlagName = CrewFlag | keyof typeof otherFlags;

function isFlag(value: string): value is FlagName {
  return isCrewFlag(value) || Object.hasOwn(otherFlags, value);
}

function flagSpec(flag: FlagName): FlagSpec {
  if (!isCrewFlag(flag)) return otherFlags[flag];
  const { field, shows } = crewFlags[flag];
  return valueFlag(shows, (parsed, value) => {
    parsed.crew[field] = value;
  });
}

/** The placeholder the usage text shows for the value of a flag, or null for a switch. */
export function flagPlaceholder(flag: string): string | null {
  return isFlag(flag) ? flagSpec(flag).shows : null;
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
    staleOnly: false,
    approvedCleanup: undefined,
    configSets: [],
    configUnsets: [],
    overrides: {},
    takeover: false,
    plan: false,
    event: false,
    operatorBin: undefined,
    crew: {},
    given: [],
    unsupported: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index] ?? "";
    if (!isFlag(flag)) {
      parsed.unsupported.push(flag);
      continue;
    }
    const spec = flagSpec(flag);
    if (spec.shows === null) {
      spec.read(parsed);
      parsed.given.push({ flag, value: null });
      continue;
    }
    // A flag with no value of its own never swallows the flag that follows it.
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      parsed.unsupported.push(flag);
      continue;
    }
    index += 1;
    if (spec.read(parsed, value)) parsed.given.push({ flag, value });
    else parsed.unsupported.push(flag);
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

/** Reads one assignment request, or null when its revision is not a whole number. */
export function readAssignmentRequest(
  parsed: ParsedArguments<
    "--request" | "--owner-token" | "--assignment" | "--input" | "--revision"
  >,
): AssignmentRequest | null {
  const { requestId, ownerToken, assignmentId, inputPath } = parsed.crew;
  const revision = readRevision(parsed);
  return revision === null ? null : { requestId, ownerToken, assignmentId, revision, inputPath };
}

/** Reads a record revision the caller states. A revision is a whole number or it is not one. */
export function readRevision(parsed: ParsedArguments): number | null {
  const raw = parsed.crew.revision;
  return raw === undefined || !/^\d+$/.test(raw) ? null : Number(raw);
}

/**
 * The leading operation words of a request, and the flags that follow them.
 * A request names its operation first, then carries only flags, so the first flag ends the words.
 */
export function splitRequest(rest: string[]): { words: string[]; parsed: ParsedArguments } {
  const firstFlag = rest.findIndex((word) => word.startsWith("--"));
  return firstFlag === -1
    ? { words: rest, parsed: parseArguments([]) }
    : { words: rest.slice(0, firstFlag), parsed: parseArguments(rest.slice(firstFlag)) };
}
