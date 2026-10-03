import { z } from "zod";

export const GATE_PATH = "operator-gate.json";

/** The path an installed release keeps its generated gate schema at, from the repository root. */
export const GATE_SCHEMA_REFERENCE = "./node_modules/@fveracoechea/operator/gate.schema.json";

// A command is an argument list with no shell, so no quoting fault or second command can hide in it.
const gateCommand = z.strictObject({
  name: z.string().min(1),
  argv: z.array(z.string().min(1)).min(1),
  timeoutSeconds: z.int().positive(),
});

export const gateDeclarationSchema = z
  .strictObject({
    $schema: z.string().min(1),
    commands: z.array(gateCommand).min(1),
  })
  .superRefine((declaration, context) => {
    // A recorded check names its gate command, so two commands with one name cannot both be shown.
    const seen = new Set<string>();
    for (const [index, command] of declaration.commands.entries()) {
      if (seen.has(command.name)) {
        context.addIssue({
          code: "custom",
          message: `the name ${command.name} is already used by an earlier command`,
          path: ["commands", index, "name"],
        });
      }
      seen.add(command.name);
    }
  });

export type GateCommand = z.infer<typeof gateCommand>;

export function describeIssue(issue: z.core.$ZodIssue): string {
  const field = issue.path.join(".");
  return field ? `${field}: ${issue.message}` : issue.message;
}

/**
 * One command as a person types it. An argument that a shell would split or expand is quoted, so
 * the line names the same arguments that the gate passes with no shell.
 */
export function commandLine(argv: string[]): string {
  return argv
    .map((one) => (/^[\w./:=@+%,-]+$/.test(one) ? one : `'${one.replaceAll("'", `'\\''`)}'`))
    .join(" ");
}
