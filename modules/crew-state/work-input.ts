import { z } from "zod";
import { readStored } from "./stored.ts";
import { canonicalWritePath, writePathRefusal } from "./write-paths.ts";

export type AssignmentKind = "production" | "review" | "planning";

/** A prototype answers a design question, so it stays planning work like research and grilling. */
const kindByWayfinderType = {
  research: "planning",
  grilling: "planning",
  prototype: "planning",
  task: "production",
} as const satisfies Record<string, AssignmentKind>;

// A large artifact stays outside the state, so a path input is only fixed by its content identity.
const fixedInput = z.discriminatedUnion("kind", [
  z.strictObject({
    name: z.string().min(1),
    kind: z.literal("value"),
    value: z.string().min(1),
    contentIdentity: z.string().min(1).nullable(),
  }),
  z.strictObject({
    name: z.string().min(1),
    kind: z.literal("path"),
    value: z.string().min(1),
    contentIdentity: z.string({ error: "a path input requires its content identity" }).min(1),
  }),
]);

// A registered path input names a file of the project in the one spelling Git reads at the base
// commit of a launch, so an absolute path, an empty part, ".", and ".." are refused.
const registeredFixedInput = fixedInput.refine(
  (input) =>
    input.kind === "value" ||
    input.value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  {
    error:
      "a path input names a file inside the checkout, relative to its root, with no empty, '.', or '..' part",
    path: ["value"],
  },
);

const writePath = z.string().superRefine((path, context) => {
  const refusal = writePathRefusal(path);
  if (refusal !== null) {
    context.addIssue({ code: "custom", message: refusal });
  }
});

// A crew state can hold work registered before the write-path grammar existed. A stored path is
// read in its canonical form, so the frontier hold and submit compare it with the one matcher. A
// stored path with no canonical form fails loudly, because a hold that cannot read it could miss
// an overlap with no sign.
const storedWritePath = z.string().transform((path, context) => {
  const read = canonicalWritePath(path);
  if ("refusal" in read) {
    context.addIssue({ code: "custom", message: read.refusal });
    return z.NEVER;
  }
  return read.canonical;
});

const permissionRecord = z.strictObject({
  writePaths: z.array(storedWritePath),
  allowedCommands: z.array(z.string().min(1)),
  network: z.boolean(),
});

const permissions = permissionRecord.extend({ writePaths: z.array(writePath) });

/**
 * One issue named as `<owner>/<repo>#<number>`. GitHub names are case-insensitive, so the key is
 * lowercase and two spellings of one issue are one key.
 */
const issueKey = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/, {
    error: "an issue is named as <owner>/<repo>#<number>",
  })
  .transform((key) => key.toLowerCase());

/**
 * The fields the tracker does not hold. The tracker holds the structure, the order, the
 * dependencies, and the approved text, so this input has no field for any of them.
 */
const executionFields = {
  issue: issueKey,
  acceptanceRequirements: z.array(z.string().min(1)).min(1),
  permissions,
  fixedInputs: z.array(registeredFixedInput),
};

// A specification or ticket item states its planning boundary. Review work is never registered,
// because a submission starts it.
const declaredItem = z.strictObject({
  ...executionFields,
  kind: z.enum(["production", "planning"]),
});

// A wayfinder item takes its planning boundary from its type label. A stated kind is only
// checked against that label.
const wayfinderItem = z.strictObject({
  ...executionFields,
  kind: z.enum(["production", "planning"]).optional(),
});

/** Where one source lives in its tracker. The map issue is what an amendment is written to. */
const trackerLocation = z.strictObject({
  repository: z.string().min(1),
  mapIssue: z.int().positive().nullable(),
  // The parent issue the source was read from. A source an earlier release registered from a
  // hand-written structure has none, so a new read of it is refused.
  parent: z.strictObject({ issue: z.int().positive(), issueId: z.int().positive() }).optional(),
});

export type TrackerSourceLocation = z.infer<typeof trackerLocation>;

/** The recorded tracker location of one source, read back through the schema that wrote it. */
export function storedTrackerLocation(stored: string): TrackerSourceLocation {
  return readStored("tracker location", trackerLocation, stored);
}

const trackerBinding = z.strictObject({
  repository: z.string().min(1),
  issue: z.int().positive(),
  // An earlier release recorded no database id, so its bindings match by repository and number.
  issueId: z.int().positive().optional(),
});

export type TrackerBindingRecord = z.infer<typeof trackerBinding>;

/** The recorded binding of one assignment, read back through the schema that wrote it. */
export function storedTrackerBinding(stored: string): TrackerBindingRecord {
  return readStored("tracker binding", trackerBinding, stored);
}

/** Refuses an input that names one issue twice, because it would state two sets of fields. */
function namesEachIssueOnce(items: Array<{ issue: string }>, context: z.RefinementCtx): void {
  const seen = new Set<string>();
  items.forEach((one, index) => {
    if (seen.has(one.issue)) {
      context.addIssue({
        code: "custom",
        message: `${one.issue} is named more than once`,
        path: [index, "issue"],
      });
    }
    seen.add(one.issue);
  });
}

export const workInputSchema = z.discriminatedUnion("sourceKind", [
  z.strictObject({
    sourceKind: z.literal("specification"),
    source: issueKey,
    items: z.array(declaredItem).superRefine(namesEachIssueOnce),
  }),
  z.strictObject({
    sourceKind: z.literal("ticket"),
    source: issueKey,
    items: z.array(declaredItem).superRefine(namesEachIssueOnce),
  }),
  z.strictObject({
    sourceKind: z.literal("wayfinder"),
    source: issueKey,
    items: z.array(wayfinderItem).superRefine(namesEachIssueOnce),
  }),
]);

export type WorkInput = z.infer<typeof workInputSchema>;
export type WorkItem = WorkInput["items"][number];

/** The planning boundary a wayfinder type label gives, or null for a type this release does not know. */
export function kindOfWayfinderType(type: string): AssignmentKind | null {
  return Object.hasOwn(kindByWayfinderType, type)
    ? kindByWayfinderType[type as keyof typeof kindByWayfinderType]
    : null;
}

/** The wayfinder types whose work is planning. Only these record a planning type. */
export const PLANNING_TYPES = ["research", "grilling", "prototype"] as const;

export type PlanningType = (typeof PLANNING_TYPES)[number];

/**
 * The wayfinder type of one planning item, or null. A planning item of a specification or a
 * ticket has no type, because its recorded kind does not say which side of a decision it is.
 */
export function planningTypeOf(wayfinderType: string | null): PlanningType | null {
  return PLANNING_TYPES.find((one) => one === wayfinderType) ?? null;
}

/**
 * The two questions a recorded kind answers. Each is an allowlist, so a value this release does
 * not know is neither dispatched nor given review priority.
 */
export function isExecutable(kind: string): boolean {
  return kind === "production" || kind === "review";
}

export function isReview(kind: string): boolean {
  return kind === "review";
}

// An assignment row stores these columns, and every reader takes them back through the schema
// that wrote them rather than asserting the shape it expected.
export function storedRequirements(stored: string): string[] {
  return readStored("acceptance requirement list", z.array(z.string()), stored);
}

export function storedPermissions(stored: string): z.infer<typeof permissionRecord> {
  return readStored("permission record", permissionRecord, stored);
}

export function storedFixedInputs(stored: string): Array<z.infer<typeof fixedInput>> {
  return readStored("fixed input list", z.array(fixedInput), stored);
}
