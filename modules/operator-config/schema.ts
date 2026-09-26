import { z } from "zod";

// Only the Operator and Crew roles are configurable; task-specific agent settings are out of scope.
const agentSelection = z.strictObject({
  host: z.enum(["opencode", "claude-code"]).optional(),
  model: z.string().min(1).optional(),
});

// The crew also carries its own concurrency, because the Operator agent is not one of the crew.
const crewSelection = agentSelection.extend({
  maxActiveAgents: z.number().int().min(1).optional(),
});

/**
 * The fixture one live probe writes to instead of a real project issue.
 * It is named in configuration, so the probe plan can show it before anything is written and a
 * probe can never reach an issue the project actually uses.
 */
const githubFixture = z.strictObject({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  issue: z.number().int().min(1),
  mapIssue: z.number().int().min(1).optional(),
});

const probeSelection = z.strictObject({
  githubFixture: githubFixture.optional(),
});

export const operatorConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  operator: agentSelection.optional(),
  crew: crewSelection.optional(),
  probe: probeSelection.optional(),
});

export function operatorConfigJsonSchema(): unknown {
  return z.toJSONSchema(operatorConfigSchema, { io: "input" });
}

export function describeIssue(issue: z.core.$ZodIssue): string {
  const field = issue.path.join(".");
  return field ? `${field}: ${issue.message}` : issue.message;
}
