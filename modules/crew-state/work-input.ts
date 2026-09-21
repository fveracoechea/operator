import { z } from "zod";

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

const source = z.strictObject({
  id: z.string().min(1),
  revision: z.string().min(1),
  // GitHub is the only tracker this release supports.
  tracker: z.literal("github"),
});

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

/** Planning work is registered so dependencies resolve, but it is never dispatched. */
export function isExecutable(kind: string): boolean {
  return kind !== "planning";
}

export function describeIssue(issue: z.core.$ZodIssue): string {
  const field = issue.path.join(".");
  return field ? `${field}: ${issue.message}` : issue.message;
}
