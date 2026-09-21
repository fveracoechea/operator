// Bundled assets sit beside the installed module, never beside the caller's working directory.
const bundledSkillsRoot = new URL("../../skills/", import.meta.url).pathname;

export type SkillAsset = { path: string; bytes: Uint8Array };

export type BundledSkill = { name: string; assets: SkillAsset[] };

function isMissingDirectory(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Lists every file under a directory, treating a missing directory as empty. */
export async function scanFiles(directory: string): Promise<string[]> {
  try {
    return (
      await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: directory, dot: true }))
    ).toSorted();
  } catch (error) {
    if (isMissingDirectory(error)) {
      return [];
    }
    throw error;
  }
}

async function readAssets(directory: string): Promise<SkillAsset[]> {
  const paths = await scanFiles(directory);

  return Promise.all(
    paths.map(async (path) => ({
      path,
      bytes: new Uint8Array(await Bun.file(`${directory}/${path}`).arrayBuffer()),
    })),
  );
}

/** A bundled skill is a directory holding a SKILL.md, together with its supporting files. */
export async function readBundledSkills(): Promise<BundledSkill[]> {
  const names = (await Array.fromAsync(new Bun.Glob("*/SKILL.md").scan({ cwd: bundledSkillsRoot })))
    .map((path) => path.slice(0, path.indexOf("/")))
    .toSorted();

  return Promise.all(
    names.map(async (name) => ({
      name,
      assets: await readAssets(`${bundledSkillsRoot}${name}`),
    })),
  );
}

export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
