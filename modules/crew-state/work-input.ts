import { z } from "zod";
import { readStored } from "./stored.ts";
import { writePathRefusal } from "./write-paths.ts";

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

// A crew state can hold work registered before the write-path grammar existed, so a stored
// record is read back in the shape it was written, not refused at dispatch.
const permissionRecord = z.strictObject({
  writePaths: z.array(z.string().min(1)),
  allowedCommands: z.array(z.string().min(1)),
  network: z.boolean(),
});

const permissions = permissionRecord.extend({ writePaths: z.array(writePath) });

const itemFields = {
  key: z.string().min(1),
  title: z.string().min(1),
  // The ticket this item came from. Work registered without one records no tracker reference,
  // and its tracker updates are refused rather than sent to a guessed ticket.
  trackerIssue: z.int().positive().optional(),
  approvedScope: z.string().min(1),
  acceptanceRequirements: z.array(z.string().min(1)).min(1),
  permissions,
  fixedInputs: z.array(registeredFixedInput),
  dependsOn: z.array(dependency),
};

/** The fields the write-path check reads. It runs only when each of them was read as valid. */
function readsWritePaths(issue: z.core.$ZodRawIssue): boolean {
  const [field, inner] = issue.path ?? [];
  // An unknown key beside the write paths leaves the write paths themselves readable.
  const whole = issue.code !== "unrecognized_keys";
  if (field === undefined) {
    return whole;
  }
  if (field !== "permissions") {
    return false;
  }
  return inner === "writePaths" || (inner === undefined && whole);
}

/**
 * Production work changes the repository, so it must name where. The check also runs when
 * another field of the item is refused, so one request reports every refusal at once.
 */
const writePathsRequired = {
  message: "a production item names at least one write path",
  path: ["permissions", "writePaths"],
  when: (payload: z.core.ParsePayload) => !payload.issues.some(readsWritePaths),
};

function hasWritePaths(item: KindedItem & { permissions: { writePaths: string[] } }): boolean {
  return kindOf(item) !== "production" || item.permissions.writePaths.length > 0;
}

const declaredItem = z
  .strictObject({
    ...itemFields,
    kind: z.enum(["production", "review", "planning"]),
  })
  .refine(hasWritePaths, writePathsRequired);

const wayfinderItem = z
  .strictObject({
    ...itemFields,
    wayfinderType: z.enum(["research", "grilling", "prototype", "task"]),
  })
  .refine(hasWritePaths, writePathsRequired);

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

// The item type is inferred from the schemas whose check calls kindOf, so it states its own shape.
type KindedItem = { kind: AssignmentKind } | { wayfinderType: keyof typeof kindByWayfinderType };

/** The planning boundary of one item, taken from the vocabulary its own source uses. */
export function kindOf(item: KindedItem): AssignmentKind {
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

export function storedPermissions(stored: string): z.infer<typeof permissionRecord> {
  return readStored("permission record", permissionRecord, stored);
}

export function storedFixedInputs(stored: string): Array<z.infer<typeof fixedInput>> {
  return readStored("fixed input list", z.array(fixedInput), stored);
}
