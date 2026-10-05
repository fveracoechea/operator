import { z } from "zod";

export const INSTALL_ROOT = ".operator/install";
export const SELECTION_PATH = `${INSTALL_ROOT}/selection.json`;
export const PACKAGE_NAME = "@fveracoechea/operator";
export const PROJECT_COMMAND = "bun run operator";
export const PROJECT_SCRIPT = "bun node_modules/@fveracoechea/operator/cli.js";

// JSR serves its npm-compatible package under a flattened scope name.
export const JSR_PACKAGE_NAME = "@jsr/fveracoechea__operator";

const fullCommit = z.string().regex(/^[0-9a-f]{40}$/);

/**
 * The exact release one project coordinates with.
 * Both delivery paths name the same commit, because they carry the same release; only the
 * registry path also names a package version, because only it resolves through a registry.
 */
export const selectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  delivery: z.enum(["github-source", "jsr"]),
  version: z.string().min(1),
  commit: fullCommit,
  releaseIdentity: z.string().regex(/^[0-9a-f]{64}$/),
  skillsIdentity: z.string().regex(/^[0-9a-f]{64}$/),
  packageVersion: z.string().min(1).nullable(),
  upstreamSkills: z.array(
    z.strictObject({
      name: z.string().min(1),
      source: z.string().min(1),
      revision: z.string().min(1),
    }),
  ),
  selectedAt: z.string().min(1),
});

export type ReleaseSelection = z.infer<typeof selectionSchema>;

/** The reasons a recorded or proposed selection was refused, one readable line each. */
export function issueLines(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

export type SelectionRead =
  | { state: "missing" }
  | { state: "unreadable"; detail: string }
  | { state: "selected"; selection: ReleaseSelection };

export async function readSelection(projectRoot: string): Promise<SelectionRead> {
  const file = Bun.file(`${projectRoot}/${SELECTION_PATH}`);
  if (!(await file.exists())) {
    return { state: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch (error) {
    return { state: "unreadable", detail: String(error) };
  }

  const result = selectionSchema.safeParse(parsed);
  return result.success
    ? { state: "selected", selection: result.data }
    : { state: "unreadable", detail: issueLines(result.error).join("; ") };
}

export function selectionText(selection: ReleaseSelection): string {
  return `${JSON.stringify(selection, null, 2)}\n`;
}

/** The devDependency specifier that installs one JSR version under the project package name. */
export function releaseSpecifier(version: string): string {
  return `npm:${JSR_PACKAGE_NAME}@${version}`;
}

/**
 * A project declares the JSR release when its devDependency names that exact version and its
 * operator script runs the installed command. Each caller parses package.json with its own schema.
 */
export function declaresRelease(
  manifest: { devDependencies?: Record<string, string>; scripts: { operator?: string } },
  version: string,
): boolean {
  return (
    manifest.devDependencies?.[PACKAGE_NAME] === releaseSpecifier(version) &&
    manifest.scripts.operator === PROJECT_SCRIPT
  );
}
