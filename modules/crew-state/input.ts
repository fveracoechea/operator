import type { z } from "zod";
import { OperatorConfig } from "../operator-config/main.ts";

export type InvalidInput = { status: "invalid-input"; issues: string[] };

export type Parsed<Value> = { status: "parsed"; value: Value } | InvalidInput;

/**
 * Reads one structured request against its schema.
 * Every mutation that takes structured input reports a refusal the same way, so a caller reads
 * one shape whichever request it sent.
 */
export function parseInput<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): Parsed<z.infer<Schema>> {
  const parsed = schema.safeParse(input);
  return parsed.success
    ? { status: "parsed", value: parsed.data }
    : { status: "invalid-input", issues: parsed.error.issues.map(OperatorConfig.describeIssue) };
}
