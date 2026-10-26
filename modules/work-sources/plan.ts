import { z } from "zod";

const key = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value, "Use a nonempty key without surrounding spaces.");
const branch = z.string().min(1).max(200).refine(validBranch, "Use a valid Git branch name.");

function validBranch(value: string) {
  if (
    value.startsWith("-") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("@{") ||
    value === "HEAD"
  )
    return false;
  for (const char of value)
    if (char.charCodeAt(0) < 33 || char.charCodeAt(0) === 127 || "~^:?*[\\".includes(char))
      return false;
  return value
    .split("/")
    .every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}
const shared = {
  key,
  trackerKey: key,
  instructions: z.string().trim().min(1),
  profile: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .optional(),
  dependencies: z.array(key),
};
export const planSchema = z
  .strictObject({
    trackerKey: key,
    assignments: z.array(
      z.union([
        z.strictObject({
          ...shared,
          completion: z.literal("pr"),
          resources: z.literal("worktree"),
          branch,
        }),
        z.strictObject({
          ...shared,
          completion: z.literal("report"),
          resources: z.literal("pane"),
        }),
        z.strictObject({
          ...shared,
          completion: z.literal("report"),
          resources: z.literal("worktree"),
          branch,
        }),
      ]),
    ),
  })
  .superRefine((plan, context) => {
    const keys = new Set(plan.assignments.map((assignment) => assignment.key));
    if (keys.size !== plan.assignments.length)
      context.addIssue({ code: "custom", message: "Assignment keys must be unique." });
    for (const assignment of plan.assignments) {
      if (new Set(assignment.dependencies).size !== assignment.dependencies.length)
        context.addIssue({
          code: "custom",
          message: `Duplicate dependency for ${assignment.key}.`,
        });
      for (const dependency of assignment.dependencies) {
        if (!keys.has(dependency) || dependency === assignment.key)
          context.addIssue({
            code: "custom",
            message: `Invalid dependency ${dependency} for ${assignment.key}.`,
          });
      }
    }
    const pending = new Map(
      plan.assignments.map((assignment) => [assignment.key, new Set(assignment.dependencies)]),
    );
    while (pending.size > 0) {
      const ready = [...pending]
        .filter(([, dependencies]) => dependencies.size === 0)
        .map(([name]) => name);
      if (ready.length === 0) {
        context.addIssue({
          code: "custom",
          message: "Dependencies must form an acyclic plan within this source.",
        });
        break;
      }
      for (const name of ready) pending.delete(name);
      for (const dependencies of pending.values())
        for (const name of ready) dependencies.delete(name);
    }
  });
export type SourcePlan = z.infer<typeof planSchema>;
