import * as z from "zod";

const AgentSelectionSchema = z.strictObject({
  host: z.enum(["opencode", "claude"]).optional(),
  model: z.string().min(1).optional(),
});

export const ConfigSchema = z.strictObject({
  $schema: z.literal("./config.schema.json"),
  operator: AgentSelectionSchema.optional(),
  crew: AgentSelectionSchema.optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function configJsonSchema(): object {
  return z.toJSONSchema(ConfigSchema, {
    target: "draft-7",
    unrepresentable: "throw",
  });
}
