import { z } from "zod";

export const INSTALL_ROOT = ".operator/install";
export const SELECTION_PATH = `${INSTALL_ROOT}/selection.json`;
export const MANIFEST_PATH = `${INSTALL_ROOT}/package.json`;
export const PACKAGE_NAME = "@fveracoechea/operator";

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
  | { state: "read"; selection: ReleaseSelection };

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
    ? { state: "read", selection: result.data }
    : { state: "unreadable", detail: issueLines(result.error).join("; ") };
}

export function selectionText(selection: ReleaseSelection): string {
  return `${JSON.stringify(selection, null, 2)}\n`;
}

/**
 * The isolated installation manifest.
 * The alias is exact, never a range, so a reinstall resolves the same published version and
 * never a replacement the registry decided on.
 */
export function manifestText(request: { packageVersion: string }): string {
  return `${JSON.stringify(
    {
      name: "operator-installation",
      private: true,
      dependencies: {
        [PACKAGE_NAME]: `npm:${JSR_PACKAGE_NAME}@${request.packageVersion}`,
      },
    },
    null,
    2,
  )}\n`;
}
