import { z } from "zod";
import { ConfigApply } from "./apply.ts";
import { apply, CONFIG_PATH, plan, recover, show } from "./change.ts";
import { describeIssue, operatorConfigJsonSchema, operatorConfigSchema } from "./schema.ts";

const SCHEMA_PATH = ".operator/config.schema.json";

export const OperatorConfig = {
  /** Reads validated project settings and the effective agent selection. */
  async show(projectRoot: string) {
    return show(projectRoot);
  },

  /** Shows the exact bytes a configuration change would write before it is approved. */
  async planChange(request: Parameters<typeof plan>[0]) {
    return plan(request);
  },

  /** Applies the approved change only while its inspected inputs still match. */
  async applyChange(request: Parameters<typeof apply>[0]) {
    return apply(request);
  },

  /** Reconciles an interrupted config apply without changing the configuration file. */
  async recoverChange(projectRoot: string) {
    return recover(projectRoot);
  },

  /**
   * Pure. The config apply machine over the apply record: `absent | pending | complete | aborted
   * | unreadable`, moved by `apply`, `write-verified`, `write-mismatch`, `config-stale`, and
   * `recover`. It gives the next state and whether to record it, or a refusal.
   */
  decideApply(...request: Parameters<typeof ConfigApply.decide>) {
    return ConfigApply.decide(...request);
  },

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
    return `${JSON.stringify({ $schema: "./config.schema.json", operator: {}, crew: {} }, null, 2)}\n`;
  },
};
