import { z } from "zod";

const selection = z.strictObject({
  host: z.enum(["opencode", "claude-code"]).optional(),
  model: z.string().trim().min(1).optional(),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
});
export const settingsSchema = z.strictObject({
  $schema: z.literal("./config.schema.json").default("./config.schema.json"),
  superAgent: selection.default({}),
  workerAgent: selection.default({}),
});
export type DeviceConfig = z.infer<typeof settingsSchema>;
