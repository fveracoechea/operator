import { z } from "zod";
// Bun has no invariant assertion API outside its test runner.
import assert from "node:assert/strict";
import { RELEASE_MANIFEST_PATH } from "./inventory.ts";

/** What the running Operator release says about itself, wherever it was retrieved from. */
export type ReleaseManifest = {
  version: string;
  commit: string | null;
  supportedBun: string;
  builtAt: string | null;
  artifactIdentity: string | null;
};

// The running package sits beside this module, never beside the caller's working directory.
const packageRoot = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

const record = z.record(z.string(), z.unknown());

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return null;
  }

  try {
    const parsed = record.safeParse(await file.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The runtime range a package manifest declares, read without trusting its shape. */
function packagedBunRange(packaged: Record<string, unknown> | null): string | null {
  const engines = z.object({ bun: z.string() }).safeParse(packaged?.engines);
  return engines.success ? text(engines.data.bun) : null;
}

/**
 * Reads what one release says about itself.
 * A built artifact carries its own record, because the registry rewrites the package manifest
 * and drops the fields a published copy would otherwise be read from.
 */
export async function readReleaseManifest(root = packageRoot): Promise<ReleaseManifest> {
  const recorded = await readJson(`${root}/${RELEASE_MANIFEST_PATH}`);
  const packaged = await readJson(`${root}/package.json`);
  return {
    version: text(recorded?.version) ?? text(packaged?.version) ?? "0.0.0",
    commit: text(recorded?.commit),
    supportedBun: text(recorded?.supportedBun) ?? packagedBunRange(packaged) ?? "*",
    builtAt: text(recorded?.builtAt),
    artifactIdentity: text(recorded?.artifactIdentity),
  };
}

/** The fields of an artifact's release record that a publication acts on. */
const artifactRecord = z.looseObject({
  version: z.string().optional(),
  commit: z.string().optional(),
});

/**
 * Reads the version and the commit one built artifact names, from its own release record only.
 * The package manifest is not read, because a publication names exactly the version the
 * artifact was built as. An artifact with no record names version 0.0.0 and no commit. A record
 * that names either one as something other than text is refused, because only a hand edit
 * writes it so and no release may be published from a guess.
 */
export async function readArtifactRelease(
  artifactRoot: string,
): Promise<{ version: string; commit: string | null }> {
  const path = `${artifactRoot}/${RELEASE_MANIFEST_PATH}`;
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return { version: "0.0.0", commit: null };
  }

  const parsed = artifactRecord.safeParse(await file.json());
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    assert.fail(
      `The release record ${path} names ${fields.join(" and ")} as something other than text.`,
    );
  }
  return { version: parsed.data.version ?? "0.0.0", commit: parsed.data.commit ?? null };
}
