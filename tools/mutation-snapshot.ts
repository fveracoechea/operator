// Bun has no directory metadata, file-mode, or symbolic-link creation API.
import { chmod, lstat, mkdir, readdir, symlink } from "node:fs/promises";
import path from "node:path";

function excluded(name: string): boolean {
  return name
    .split("/")
    .some(
      (part) =>
        [".git", "node_modules", ".operator", ".agents", ".claude"].includes(part) ||
        part.startsWith(".mutation-"),
    );
}

async function inputNames(root: string): Promise<string[]> {
  const git = Bun.spawnSync(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (git.exitCode === 0)
    return [
      ...new Set(
        git.stdout
          .toString()
          .split("\0")
          .filter((name) => name && !excluded(name)),
      ),
    ];
  const names = new Set<string>();
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const name = path.join(directory, entry.name);
      if (excluded(name)) continue;
      if (entry.isDirectory()) await walk(name);
      else names.add(name);
    }
  }

  await walk("");
  return [...names];
}

async function inputs(root: string, destination?: string): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256");
  for (const name of (await inputNames(root)).toSorted()) {
    const file = path.join(root, name);
    const stat = await lstat(file).catch(() => undefined);
    // A tracked deletion contributes no executable input.
    if (!stat) continue;
    if (!stat.isFile()) return Promise.reject(new Error(`Unsupported snapshot input: ${name}`));
    const bytes = await Bun.file(file).bytes();
    hash.update(JSON.stringify([name, stat.mode, bytes.byteLength]));
    hash.update(bytes);
    if (destination) {
      const copied = path.join(destination, name);
      await Bun.write(copied, bytes);
      await chmod(copied, stat.mode);
    }
  }
  return hash.digest("hex");
}

export async function mutationInputIdentity(root: string): Promise<string> {
  return inputs(root);
}

export async function admitMutationSnapshot(
  root: string,
  directory: string,
): Promise<{ directory: string; identity: string }> {
  await mkdir(directory, { recursive: true });
  const identity = await inputs(root, directory);
  if ((await mutationInputIdentity(root)) !== identity)
    return Promise.reject(new Error("Mutation inputs changed during snapshot admission."));
  const dependencies = path.join(root, "node_modules");
  if (await lstat(dependencies).catch(() => undefined)) {
    await symlink(dependencies, path.join(directory, "node_modules"));
  }
  return { directory, identity };
}
