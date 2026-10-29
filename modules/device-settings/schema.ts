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
/** A Slack conversation id, such as C0123ABCD. */
const slackChannelSchema = z.string().regex(/^[CGD][A-Z0-9]{2,30}$/);
/** A GitHub repository as owner/repository, in lowercase, the way a registration records it. */
const repositorySchema = z.string().regex(/^[a-z\d][a-z\d-]{0,38}\/[a-z\d._-]{1,100}$/);
/** A GitHub login, as `gh pr view` reports the PR author. Never a Slack name. */
const loginSchema = z.string().regex(/^[a-z\d](?:[a-z\d-]{0,38})(?:\[bot\])?$/i);
export const settingsSchema = z.strictObject({
  $schema: z.literal("./config.schema.json").default("./config.schema.json"),
  superAgent: selectionSchema.default({}),
  workerAgent: selectionSchema.default({}),
  profiles: z
    .preprocess(
      (input, context) => {
        // Zod records omit __proto__, so reject it before the record parser can discard it.
        if (input instanceof Object && Object.hasOwn(input, "__proto__"))
          context.addIssue({ code: "custom", message: "Unsupported profile name: __proto__." });
        return input;
      },
      z.record(profileNameSchema, selectionSchema),
    )
    .optional(),
  review: z
    .strictObject({
      // The optional reviewer of each associated PR assignment is off by default.
      assignments: z.boolean().optional(),
      // The author policy of the watched Slack channel. Without a channel, Operator reads no Slack.
      channel: slackChannelSchema.optional(),
      repos: z.array(repositorySchema).optional(),
      authors: z.array(loginSchema).optional(),
    })
    .optional(),
});
export type DeviceConfig = z.infer<typeof settingsSchema>;

/** The one rendering of the editor schema, shared by the release artifact and settings edits. */
export function editorSchemaText(): string {
  return `${JSON.stringify(z.toJSONSchema(settingsSchema), null, 2)}\n`;
}
