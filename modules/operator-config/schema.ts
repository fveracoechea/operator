import { z } from "zod";

// Only the Operator and Crew roles are configurable; task-specific agent settings are out of scope.
const agentSelection = z.strictObject({
  host: z.enum(["opencode", "claude-code"]).optional(),
  model: z.string().min(1).optional(),
});

export const operatorConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  operator: agentSelection.optional(),
  crew: agentSelection.optional(),
});

export function operatorConfigJsonSchema(): unknown {
  return z.toJSONSchema(operatorConfigSchema, { io: "input" });
}

export function describeIssue(issue: z.core.$ZodIssue): string {
  const field = issue.path.join(".");
  return field ? `${field}: ${issue.message}` : issue.message;
}
