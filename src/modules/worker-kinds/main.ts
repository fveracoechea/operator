import { z } from "zod";
import { decidePhase } from "./phase-machine.ts";
import { refusesPrGuard } from "./pr-policy.ts";

const nameSchema = z.enum([
  "research",
  "answer",
  "prototype",
  "implementation",
  "review",
  "pr-feedback",
  "commit-implementation",
  "commit-review",
]);
const kindNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const definitionSchema = z.object({
  name: kindNameSchema,
  completion: z.enum(["report", "pr", "commit"]),
  resources: z.enum(["pane", "worktree"]),
  profile: z.string().nullable(),
  nextKind: kindNameSchema.nullable(),
  readsNote: z.union([z.boolean(), z.literal("promotion")]),
  guide: z.string(),
  skillsToRead: z.array(z.string()).default([]),
  dispatchable: z.boolean(),
  workPhases: z.array(
    z.object({
      name: z.string().trim().min(1),
      goal: z.string().trim().min(1),
      guard: z
        .enum([
          "report_submitted",
          "pr_associated",
          "round_recorded",
          "pr_ready",
          "worktree_clean",
          "pr_merged",
          "commit_candidate",
          "commit_reviewed",
          "commit_delivered",
        ])
        .optional(),
    }),
  ),
});
type WorkerKind = z.infer<typeof definitionSchema>;

const customSchema = definitionSchema
  .omit({ name: true })
  .extend({
    profile: z.string().nullable().default(null),
    nextKind: definitionSchema.shape.nextKind.default(null),
    readsNote: definitionSchema.shape.readsNote.default(false),
    dispatchable: z.literal(true).default(true),
    guide: z
      .string()
      .regex(/^[a-z][a-z0-9-]*\/SKILL\.md$/, "Name an installed guide skill as <skill>/SKILL.md."),
    workPhases: definitionSchema.shape.workPhases.min(
      1,
      "A person-defined kind needs at least one work phase.",
    ),
  })
  .strict();
const customKindsSchema = z.preprocess(
  (input, context) => {
    // Zod records omit __proto__ before key validation.
    if (input instanceof Object && Object.hasOwn(input, "__proto__"))
      context.addIssue({ code: "custom", message: "Unsupported kind name: __proto__." });
    return input;
  },
  z.record(definitionSchema.shape.name, customSchema).superRefine((definitions, context) => {
    for (const [name, definition] of Object.entries(definitions)) {
      if (Object.hasOwn(kinds, name))
        context.addIssue({
          code: "custom",
          path: [name],
          message: `Built-in kind ${name} cannot be reused.`,
        });
      if (definition.nextKind !== null) {
        const builtin = nameSchema.safeParse(definition.nextKind);
        const next = Object.hasOwn(definitions, definition.nextKind)
          ? definitions[definition.nextKind]
          : builtin.success
            ? kinds[builtin.data]
            : undefined;
        if (next?.completion !== definition.completion)
          context.addIssue({
            code: "custom",
            path: [name, "nextKind"],
            message: "The next kind must exist and have the same completion type.",
          });
      }
    }
  }),
);

const kinds: Record<z.infer<typeof nameSchema>, WorkerKind> = {
  "commit-implementation": {
    name: "commit-implementation",
    completion: "commit",
    resources: "worktree",
    profile: null,
    nextKind: "commit-review",
    readsNote: false,
    guide: "worker-agent/kinds/commit-implementation.md",
    skillsToRead: [],
    dispatchable: true,
    workPhases: [{ name: "build", goal: "Implement the ticket without publishing a PR." }],
  },
  "commit-review": {
    name: "commit-review",
    completion: "commit",
    resources: "worktree",
    profile: null,
    nextKind: null,
    readsNote: false,
    guide: "worker-agent/kinds/commit-review.md",
    skillsToRead: [],
    dispatchable: false,
    workPhases: [],
  },
  research: {
    name: "research",
    completion: "report",
    resources: "pane",
    profile: null,
    nextKind: null,
    readsNote: false,
    guide: "worker-agent/kinds/research.md",
    skillsToRead: [],
    dispatchable: true,
    workPhases: [{ name: "investigate", goal: "Investigate the assigned question." }],
  },
  answer: {
    name: "answer",
    completion: "report",
    resources: "pane",
    profile: null,
    nextKind: null,
    readsNote: false,
    guide: "worker-agent/kinds/answer.md",
    skillsToRead: ["show-me"],
    dispatchable: true,
    workPhases: [{ name: "investigate", goal: "Answer the assigned question." }],
  },
  prototype: {
    name: "prototype",
    completion: "report",
    resources: "worktree",
    profile: null,
    nextKind: null,
    readsNote: false,
    guide: "worker-agent/kinds/prototype.md",
    skillsToRead: [],
    dispatchable: true,
    workPhases: [
      { name: "build", goal: "Build the assigned prototype." },
      { name: "react", goal: "Gather a reaction to the prototype." },
    ],
  },
  implementation: {
    name: "implementation",
    completion: "pr",
    resources: "worktree",
    profile: null,
    nextKind: "review",
    readsNote: "promotion",
    guide: "worker-agent/kinds/implementation.md",
    skillsToRead: [],
    dispatchable: true,
    workPhases: [{ name: "build", goal: "Implement the assigned change." }],
  },
  review: {
    name: "review",
    completion: "pr",
    resources: "worktree",
    profile: null,
    nextKind: "pr-feedback",
    readsNote: false,
    guide: "worker-agent/kinds/review.md",
    skillsToRead: [],
    dispatchable: false,
    workPhases: [],
  },
  "pr-feedback": {
    name: "pr-feedback",
    completion: "pr",
    resources: "worktree",
    profile: null,
    nextKind: null,
    readsNote: true,
    guide: "worker-agent/kinds/pr-feedback.md",
    skillsToRead: [],
    dispatchable: false,
    workPhases: [],
  },
};

/** Kind policy is shared by plan registration and launch snapshots. ADR-0029. */
export const WorkerKinds = {
  refusesPrGuard(facts: Parameters<typeof refusesPrGuard>[0]) {
    return refusesPrGuard(facts);
  },
  decidePhase(facts: Parameters<typeof decidePhase>[0], event?: Parameters<typeof decidePhase>[1]) {
    return decidePhase(facts, event);
  },
  names() {
    return nameSchema.options;
  },
  snapshotSchema() {
    return definitionSchema;
  },
  customSchema() {
    return customKindsSchema;
  },
  dispatchable(name: string | null) {
    const builtin = nameSchema.safeParse(name);
    return !builtin.success || kinds[builtin.data].dispatchable;
  },
  resolve(name: string, definitions: z.infer<typeof customKindsSchema> = {}): WorkerKind {
    if (Object.hasOwn(definitions, name))
      return definitionSchema.parse({ ...definitions[name], name });
    return definitionSchema.parse(kinds[nameSchema.parse(name)]);
  },
};
