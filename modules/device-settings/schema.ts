import { z } from "zod";

export const selectionSchema = z.strictObject({
  host: z.enum(["opencode", "claude-code"]).optional(),
  model: z.string().trim().min(1).optional(),
  reasoningEffort: z.string().trim().min(1).optional(),
});
export const profileNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/)
  .refine((name) => name !== "constructor" && name !== "prototype");
export const settingsSchema = z.strictObject({
  $schema: z.literal("./config.schema.json").default("./config.schema.json"),
  superAgent: selectionSchema.default({}),
  workerAgent: selectionSchema.default({}),
  profiles: z
    .preprocess(
      (input, context) => {
        // Zod records omit __proto__, so reject it before the record parser can discard it.
        if (input !== null && typeof input === "object" && Object.hasOwn(input, "__proto__"))
          context.addIssue({ code: "custom", message: "Unsupported profile name: __proto__." });
        return input;
      },
      z.record(profileNameSchema, selectionSchema),
    )
    .optional(),
  // The optional reviewer of each associated PR assignment is off by default.
  review: z.strictObject({ assignments: z.boolean().optional() }).optional(),
});
export type DeviceConfig = z.infer<typeof settingsSchema>;

/** The one rendering of the editor schema, shared by the release artifact and settings edits. */
export function editorSchemaText(): string {
  return `${JSON.stringify(z.toJSONSchema(settingsSchema), null, 2)}\n`;
}
