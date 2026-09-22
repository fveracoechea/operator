import { RELEASE_MANIFEST_PATH } from "./inventory.ts";

/** What the running Operator release says about itself, wherever it was retrieved from. */
export type ReleaseManifest = {
  version: string;
  commit: string | null;
  supportedBun: string;
  builtAt: string | null;
  artifactIdentity: string | null;
};

export type LockData = {
  name: string | null;
  state: "present" | "missing";
  identity: string | null;
  path: string | null;
};

// Bun writes a text lock by default and a binary lock on request, so both count as lock data.
const LOCK_NAMES = ["bun.lock", "bun.lockb"];

// The running package sits beside this module, never beside the caller's working directory.
export const packageRoot = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

/**
 * The directory whose lock data governs this installation.
 * An installed package is reached through one `node_modules`, so the installation is the
 * directory that holds it. A package that was never installed governs itself. The search never
 * walks further up, because an ancestor lock belongs to another project's dependencies.
 */
export function installationRoot(root = packageRoot): string {
  const segments = root.split("/");
  const nearest = segments.lastIndexOf("node_modules");
  return nearest === -1 ? root : segments.slice(0, nearest).join("/");
}

export async function readLockData(root = packageRoot): Promise<LockData> {
  const directory = installationRoot(root);
  for (const name of LOCK_NAMES) {
    const file = Bun.file(`${directory}/${name}`);
    if (await file.exists()) {
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(new Uint8Array(await file.arrayBuffer()));
      return {
        name,
        state: "present",
        identity: hasher.digest("hex"),
        path: `${directory}/${name}`,
      };
    }
  }

  return { name: null, state: "missing", identity: null, path: null };
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return null;
  }

  try {
    const parsed: unknown = await file.json();
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Reads what one release says about itself.
 * A built artifact carries its own record, because the registry rewrites the package manifest
 * and drops the fields a published copy would otherwise be read from.
 */
export async function readReleaseManifest(root = packageRoot): Promise<ReleaseManifest> {
  const recorded = await readJson(`${root}/${RELEASE_MANIFEST_PATH}`);
  const packaged = await readJson(`${root}/package.json`);
  const engines = packaged?.engines;
  const packagedRange =
    engines !== null && typeof engines === "object" && "bun" in engines
      ? text((engines as Record<string, unknown>).bun)
      : null;

  return {
    version: text(recorded?.version) ?? text(packaged?.version) ?? "0.0.0",
    commit: text(recorded?.commit),
    supportedBun: text(recorded?.supportedBun) ?? packagedRange ?? "*",
    builtAt: text(recorded?.builtAt),
    artifactIdentity: text(recorded?.artifactIdentity),
  };
}
