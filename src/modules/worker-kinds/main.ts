import { z } from "zod";

const nameSchema = z.enum([
  "research",
  "answer",
  "prototype",
  "implementation",
  "review",
  "pr-feedback",
]);
const definitionSchema = z.object({
  name: nameSchema,
  completion: z.enum(["report", "pr"]),
  resources: z.enum(["pane", "worktree"]),
  profile: z.string().nullable(),
  nextKind: nameSchema.nullable(),
  readsNote: z.union([z.boolean(), z.literal("promotion")]),
  guide: z.string(),
  skillsToRead: z.array(z.string()).default([]),
  dispatchable: z.boolean(),
  workPhases: z.array(z.object({ name: z.string(), goal: z.string() })),
});
type WorkerKind = z.infer<typeof definitionSchema>;

const kinds: Record<z.infer<typeof nameSchema>, WorkerKind> = {
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
  names() {
    return nameSchema.options;
  },
  snapshotSchema() {
    return definitionSchema;
  },
  resolve(name: z.infer<typeof nameSchema>): WorkerKind {
    return definitionSchema.parse(kinds[name]);
  },
};
