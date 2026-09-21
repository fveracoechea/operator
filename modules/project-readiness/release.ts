import packageJson from "../../package.json" with { type: "json" };
import { SkillInstall } from "../skill-install/main.ts";

// The Operator installation sits beside this module, never beside the caller's working directory.
const installationRoot = new URL("../../", import.meta.url).pathname;

// Bun writes a text lock by default and a binary lock on request, so both count as lock data.
const LOCK_NAMES = ["bun.lock", "bun.lockb"];

export type Release = {
  version: string;
  identity: string;
  // The lock path lets a launch copy the frozen lock data it recorded, never a fresh resolution.
  lock: {
    name: string | null;
    state: "present" | "missing";
    identity: string | null;
    path: string | null;
  };
};

async function readLock(): Promise<Release["lock"]> {
  for (const name of LOCK_NAMES) {
    const file = Bun.file(`${installationRoot}${name}`);
    if (await file.exists()) {
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(new Uint8Array(await file.arrayBuffer()));
      return {
        name,
        state: "present",
        identity: hasher.digest("hex"),
        path: `${installationRoot}${name}`,
      };
    }
  }

  return { name: null, state: "missing", identity: null, path: null };
}

/** Identifies the running release by its version and the exact skills it installs. */
export async function identifyRelease(): Promise<Release> {
  const skills = await SkillInstall.identity();

  return {
    version: packageJson.version,
    identity: new Bun.CryptoHasher("sha256")
      .update(`${packageJson.version}\n${skills}`)
      .digest("hex"),
    lock: await readLock(),
  };
}

export const supportedBunRange = packageJson.engines.bun;
