import { describeIssue, operatorConfigJsonSchema, operatorConfigSchema } from "./schema.ts";

const SCHEMA_FILE_REFERENCE = "./config.schema.json";

export const OperatorConfig = {
  /** Validates untrusted configuration input and reports every issue with its field. */
  parse(input: unknown) {
    const result = operatorConfigSchema.safeParse(input);
    if (!result.success) {
      return { ok: false as const, issues: result.error.issues.map(describeIssue) };
    }

    return { ok: true as const, config: result.data };
  },

  jsonSchemaText(): string {
    return `${JSON.stringify(operatorConfigJsonSchema(), null, 2)}\n`;
  },

  // Host and model stay unset so the agreed host user defaults apply.
  defaultFileText(): string {
    return `${JSON.stringify({ $schema: SCHEMA_FILE_REFERENCE, operator: {}, crew: {} }, null, 2)}\n`;
  },

  schemaFileReference(): string {
    return SCHEMA_FILE_REFERENCE;
  },
};
