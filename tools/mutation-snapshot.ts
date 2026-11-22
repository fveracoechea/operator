// Bun has no directory metadata, file-mode, or symbolic-link creation API.
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readlink,
  symlink,
  stat as installedStat,
  realpath,
} from "node:fs/promises";
import path from "node:path";

type InstalledLink = { raw: string; target: string };

async function installedLink(
  physicalRoot: string,
  file: string,
  ancestors: Set<string>,
): Promise<InstalledLink> {
  const raw = await readlink(file);
  const target = await realpath(file);
  const metadata = await installedStat(file);
  const kind = metadata.isDirectory() ? "directory" : "file";
  const relative = path.relative(physicalRoot, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return Promise.reject(new Error(`Unsupported installed ${kind} link: ${file}`));
  if (metadata.isDirectory() && ancestors.has(target))
    return Promise.reject(new Error(`Cyclic installed input: ${file}`));
  return { raw, target: path.join("node_modules", relative) };
}

async function installedNames(
  root: string,
  signal?: AbortSignal,
): Promise<{
  names: string[];
  links: Map<string, InstalledLink>;
  identity?: string;
}> {
  const names: string[] = [];
  const links = new Map<string, InstalledLink>();
  const directory = path.join(root, "node_modules");
  if (!(await lstat(directory).catch(() => undefined))) return { names, links };
  const physicalRoot = await realpath(directory);
  if (path.basename(physicalRoot) !== "node_modules")
    return Promise.reject(new Error(`Unsupported installed root: ${directory}`));
  const identity = JSON.stringify([physicalRoot, await readlink(directory).catch(() => undefined)]);
  async function walk(directory: string, ancestors: Set<string>): Promise<void> {
    signal?.throwIfAborted();
    const physical = path.join(
      physicalRoot,
      path.relative(path.join(root, "node_modules"), directory),
    );
    const parents = new Set([...ancestors, physical]);
    names.push(path.relative(root, directory));
    for (const entry of await readdir(directory)) {
      const file = path.join(directory, entry);
      const name = path.relative(root, file);
      const metadata = await lstat(file);
      if (metadata.isSymbolicLink()) {
        links.set(name, await installedLink(physicalRoot, file, parents));
        names.push(name);
      } else if (metadata.isDirectory()) await walk(file, parents);
      else if (metadata.isFile()) names.push(name);
      else return Promise.reject(new Error(`Unsupported installed input: ${file}`));
    }
  }

  await walk(directory, new Set());
  return { names, links, identity };
}

function excluded(name: string): boolean {
  return name
    .split("/")
    .some(
      (part) =>
        [".git", "node_modules", ".operator", ".agents", ".claude"].includes(part) ||
        part.startsWith(".mutation-"),
    );
}

async function inputNames(root: string, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
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
      signal?.throwIfAborted();
      const name = path.join(directory, entry.name);
      if (excluded(name)) continue;
      if (entry.isDirectory()) await walk(name);
      else names.add(name);
    }
  }

  await walk("");
  return [...names];
}

async function snapshotFile(
  file: string,
  copied: string | undefined,
  mode: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const bytes = await Bun.file(file).bytes();
  signal?.throwIfAborted();
  if (copied) {
    await Bun.write(copied, bytes);
    await chmod(copied, mode);
  }
  return bytes;
}

async function sourceMetadata(root: string, name: string) {
  let parent = root;
  for (const part of name.split(path.sep).slice(0, -1)) {
    parent = path.join(parent, part);
    const metadata = await lstat(parent).catch(() => undefined);
    if (!metadata) return undefined;
    if (!metadata.isDirectory())
      return Promise.reject(new Error(`Unsupported source ancestor: ${name}`));
  }
  return lstat(path.join(root, name)).catch(() => undefined);
}

async function sourceLink(root: string, name: string, names: Set<string>): Promise<InstalledLink> {
  const raw = await readlink(path.join(root, name));
  const physicalRoot = await realpath(root);
  const absolute = path.resolve(physicalRoot, path.dirname(name), raw);
  const target = path.relative(physicalRoot, absolute);
  // Reject cancelled path components before following a link through an unadmitted ancestor.
  const spelling = raw
    .split(path.sep)
    .filter((part) => part !== ".")
    .join(path.sep);
  if (spelling !== path.normalize(raw) || !names.has(target))
    return Promise.reject(new Error(`Unsupported snapshot input: ${name}`));
  const metadata = await sourceMetadata(physicalRoot, target);
  if (!metadata?.isFile()) return Promise.reject(new Error(`Unsupported snapshot input: ${name}`));
  return { raw, target };
}

async function snapshotInput(
  root: string,
  name: string,
  source: Set<string>,
  installedLinks: Map<string, InstalledLink>,
) {
  const isSource = source.has(name);
  const metadata = isSource
    ? await sourceMetadata(root, name)
    : await lstat(path.join(root, name)).catch(() => undefined);
  // A tracked deletion contributes no executable input.
  if (!metadata) return undefined;
  const link =
    installedLinks.get(name) ??
    (isSource && metadata.isSymbolicLink() ? await sourceLink(root, name, source) : undefined);
  return { metadata, link };
}

async function inputs(root: string, destination?: string, signal?: AbortSignal): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256");
  const installed = await installedNames(root, signal);
  hash.update(JSON.stringify(installed.identity ?? null));
  const source = new Set(await inputNames(root, signal));
  const names = [...source, ...installed.names];
  const installedInputs = new Set(installed.names);
  const directories: { file: string; mode: number }[] = [];
  for (const name of names.toSorted()) {
    signal?.throwIfAborted();
    const file = path.join(root, name);
    const input = await snapshotInput(root, name, source, installed.links);
    if (!input) continue;
    const { metadata, link } = input;
    const copied = destination ? path.join(destination, name) : undefined;
    if (link) {
      hash.update(JSON.stringify([name, metadata.mode, link]));
      if (copied) {
        await mkdir(path.dirname(copied), { recursive: true });
        await symlink(path.relative(path.dirname(name), link.target), copied);
      }
      continue;
    }
    const stat = await installedStat(file);
    if (stat.isDirectory() && installedInputs.has(name)) {
      hash.update(JSON.stringify([name, stat.mode]));
      if (copied) {
        await mkdir(copied);
        directories.push({ file: copied, mode: stat.mode });
      }
      continue;
    }
    if (!stat.isFile()) return Promise.reject(new Error(`Unsupported snapshot input: ${name}`));
    const bytes = await snapshotFile(file, copied, stat.mode, signal);
    hash.update(JSON.stringify([name, stat.mode, bytes.byteLength]));
    hash.update(bytes);
  }
  for (const directory of directories.toReversed()) await chmod(directory.file, directory.mode);
  return hash.digest("hex");
}

export async function mutationInputIdentity(root: string, signal?: AbortSignal): Promise<string> {
  return inputs(root, undefined, signal);
}

export async function admitMutationSnapshot(
  root: string,
  directory: string,
  signal?: AbortSignal,
): Promise<{ directory: string; identity: string }> {
  await mkdir(directory, { recursive: true });
  const identity = await inputs(root, directory, signal);
  if ((await mutationInputIdentity(root, signal)) !== identity)
    return Promise.reject(
      new Error("Mutation inputs changed during snapshot admission.", { cause: "inputs-changed" }),
    );
  return { directory, identity };
}
