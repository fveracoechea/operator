import { z } from "zod";
import { readStored } from "./stored.ts";

export type AssignmentKind = "production" | "review" | "planning";

/** A prototype answers a design question, so it stays planning work like research and grilling. */
const kindByWayfinderType = {
  research: "planning",
  grilling: "planning",
  prototype: "planning",
  task: "production",
} as const satisfies Record<string, AssignmentKind>;

const dependency = z.strictObject({
  sourceId: z.string().min(1).optional(),
  key: z.string().min(1),
});

const fixedInput = z
  .strictObject({
    name: z.string().min(1),
    kind: z.enum(["value", "path"]),
    value: z.string().min(1),
    contentIdentity: z.string().min(1).nullable(),
  })
  // A large artifact stays outside the state, so its path is only fixed by its content identity.
  .refine((input) => input.kind === "value" || input.contentIdentity !== null, {
    error: "a path input requires its content identity",
    path: ["contentIdentity"],
  });

const permissions = z.strictObject({
  writePaths: z.array(z.string().min(1)),
  allowedCommands: z.array(z.string().min(1)),
  network: z.boolean(),
});

const itemFields = {
  key: z.string().min(1),
  title: z.string().min(1),
  // The ticket this item came from. Work registered without one records no tracker reference,
  // and its tracker updates are refused rather than sent to a guessed ticket.
  trackerIssue: z.int().positive().optional(),
  approvedScope: z.string().min(1),
  acceptanceRequirements: z.array(z.string().min(1)).min(1),
  permissions,
  fixedInputs: z.array(fixedInput),
  dependsOn: z.array(dependency),
};

const declaredItem = z.strictObject({
  ...itemFields,
  kind: z.enum(["production", "review", "planning"]),
});

const wayfinderItem = z.strictObject({
  ...itemFields,
  wayfinderType: z.enum(["research", "grilling", "prototype", "task"]),
});

/** Where one source lives in its tracker. The map issue is what an amendment is written to. */
const trackerLocation = z.strictObject({
  repository: z.string().min(1),
  mapIssue: z.int().positive().nullable(),
});

const source = z.strictObject({
  id: z.string().min(1),
  revision: z.string().min(1),
  // GitHub is the only tracker this release supports.
  tracker: z.literal("github"),
  location: trackerLocation.optional(),
});

export type TrackerSourceLocation = z.infer<typeof trackerLocation>;

/** The recorded tracker location of one source, read back through the schema that wrote it. */
export function storedTrackerLocation(stored: string): TrackerSourceLocation {
  return readStored("tracker location", trackerLocation, stored);
}

/** The recorded binding of one assignment, read back through the schema that wrote it. */
export function storedTrackerBinding(stored: string): { issue: number } {
  return readStored("tracker binding", z.strictObject({ issue: z.int().positive() }), stored);
}

export const workInputSchema = z.discriminatedUnion("sourceKind", [
  z.strictObject({
    sourceKind: z.literal("specification"),
    source,
    items: z.array(declaredItem).min(1),
  }),
  z.strictObject({
    sourceKind: z.literal("ticket"),
    source,
    items: z.array(declaredItem).min(1),
  }),
  z.strictObject({
    sourceKind: z.literal("wayfinder"),
    source,
    items: z.array(wayfinderItem).min(1),
  }),
]);

export type WorkInput = z.infer<typeof workInputSchema>;
export type WorkItem = WorkInput["items"][number];

/** The planning boundary of one item, taken from the vocabulary its own source uses. */
export function kindOf(item: WorkItem): AssignmentKind {
  return "kind" in item ? item.kind : kindByWayfinderType[item.wayfinderType];
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

export function storedPermissions(stored: string): z.infer<typeof permissions> {
  return readStored("permission record", permissions, stored);
}

export function storedFixedInputs(stored: string): Array<z.infer<typeof fixedInput>> {
  return readStored("fixed input list", z.array(fixedInput), stored);
}
