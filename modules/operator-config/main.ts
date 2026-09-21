import { z } from "zod";
import { describeIssue, operatorConfigJsonSchema, operatorConfigSchema } from "./schema.ts";

const SCHEMA_FILE_REFERENCE = "./config.schema.json";
const CONFIG_PATH = ".operator/config.json";
const SCHEMA_PATH = ".operator/config.schema.json";

export const OperatorConfig = {
  /** Validates untrusted configuration input and reports every issue with its field. */
  parse(input: unknown) {
    const result = operatorConfigSchema.safeParse(input);
    if (!result.success) {
      return { ok: false as const, issues: result.error.issues.map(describeIssue) };
    }

    return { ok: true as const, config: result.data };
  },

  /** Names one validation problem with the field it belongs to. */
  describeIssue(issue: z.core.$ZodIssue): string {
    return describeIssue(issue);
  },

  /** The project-relative path of the configuration file and its generated schema. */
  configPath(): string {
    return CONFIG_PATH;
  },

  schemaPath(): string {
    return SCHEMA_PATH;
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
