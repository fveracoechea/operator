// Bun has no directory creation, lstat, or directory removal API.
import { mkdir, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import type { OperatorHome } from "../operator-home/main.ts";
import { contents, info, same, verdict, writable, type Contents } from "./content.ts";
import { writeFile } from "../../lib/write-file.ts";

export type Paths = ReturnType<typeof OperatorHome.resolve>;
export type Host = keyof Paths["skillHosts"];
export type Request = { paths: Paths; hosts: Host[]; check: boolean; source: string };
function isText(value: unknown): value is string {
  return typeof value === "string";
}

// Zod's record parser drops __proto__, but every own filename belongs in the ledger.
function isContents(value: unknown): value is Contents {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(isText)
  );
}

const contentsSchema = z.custom<Contents>(isContents);
const ledgerSchema = z.strictObject({
  version: z.literal(1),
  entries: z.record(z.string(), contentsSchema),
});
type Ledger = z.infer<typeof ledgerSchema>;
type Copy = {
  name: string;
  host: Host;
  root: string;
  destination: string;
  source: string;
  released: Contents | null;
  current: Contents | null;
  action: ReturnType<typeof verdict>;
};
type Refusal = {
  reason: "skills_release_invalid" | "skill_copy_conflict" | "skills_missing";
  detail: string;
};
const retired = ["operator", "operative"];

export function checkOnly(source: string, requested: boolean) {
  return requested || source.startsWith("/nix/store/");
}

async function ledger(file: string): Promise<Ledger> {
  if ((await info(file)) === null) return { version: 1, entries: {} };
  return ledgerSchema.parse(await Bun.file(file).json());
}

/** Each release skill is a folder with a SKILL.md. */
export async function releaseNames(source: string) {
  const names = [];
  for await (const file of new Bun.Glob("*/SKILL.md").scan({ cwd: source }))
    names.push(path.dirname(file));
  return names.toSorted();
}

async function inspect(request: Request, recorded: Ledger): Promise<{ copies: Copy[] } | Refusal> {
  const names = await releaseNames(request.source);
  if (names.length === 0)
    return {
      reason: "skills_release_invalid" as const,
      detail: "The running release has no owned skills.",
    };
  const copies: Copy[] = [];
  for (const host of request.hosts) {
    for (const name of [...names, ...retired]) {
      const root = request.paths.skillHosts[host];
      const destination = path.join(root, name);
      const source = path.join(request.source, name);
      const released = retired.includes(name) ? null : await contents(source, true);
      const current = await contents(destination, request.check);
      let action = verdict(
        current,
        released,
        Object.hasOwn(recorded.entries, destination)
          ? (recorded.entries[destination] ?? null)
          : null,
      );
      if (!request.check && !(await copyWritable(root, destination, current))) action = "conflict";
      copies.push({ name, host, root, destination, source, released, current, action });
    }
  }
  const conflicts = copies.filter((copy) =>
    request.check
      ? copy.released !== null && copy.current !== null && !same(copy.current, copy.released)
      : copy.action === "conflict",
  );
  if (conflicts.length)
    return {
      reason: "skill_copy_conflict" as const,
      detail: `Preserve these skill paths and resolve their contents or external wiring: ${conflicts.map((copy) => copy.destination).join(", ")}`,
    };
  // Only check mode refuses a missing copy, because copy mode installs it.
  const missing = copies.filter(
    (copy) => request.check && copy.released !== null && copy.current === null,
  );
  if (missing.length)
    return {
      reason: "skills_missing" as const,
      detail: `These skill paths are missing: ${missing.map((copy) => copy.destination).join(", ")}`,
    };
  return { copies };
}

async function copyWritable(root: string, destination: string, current: Contents | null) {
  for (const file of ["", ...Object.keys(current ?? {})])
    if (!(await writable(root, path.join(destination, file)))) return false;
  return true;
}

async function removeFiles(copy: Copy, retained: Contents = {}) {
  if (copy.current === null) return;
  const files = Object.keys(copy.current).filter((file) => !Object.hasOwn(retained, file));
  for (const file of files.filter((file) => !file.endsWith("/")))
    await unlink(path.join(copy.destination, file));
  for (const directory of files
    .filter((file) => file.endsWith("/"))
    .toSorted((a, b) => b.length - a.length))
    await rmdir(path.join(copy.destination, directory));
}

async function changeCopy(copy: Copy) {
  if (copy.action === "matching") return true;
  if (
    !(await copyWritable(copy.root, copy.destination, copy.current)) ||
    !same(await contents(copy.destination), copy.current)
  )
    return false;
  if (copy.action === "remove") {
    await removeFiles(copy);
    return true;
  }
  // Only the remove action has no released contents.
  const released = copy.released ?? {};
  await removeFiles(copy, released);
  for (const file of Object.keys(released).filter((file) => file.endsWith("/")))
    await mkdir(path.join(copy.destination, file), { recursive: true });
  for (const file of Object.keys(released).filter((file) => !file.endsWith("/"))) {
    if (copy.current?.[file] === released[file]) continue;
    if (!(await writable(copy.root, path.join(copy.destination, file)))) return false;
    await writeFile(
      path.join(copy.destination, file),
      await Bun.file(path.join(copy.source, file)).bytes(),
      // A linked release file gets its target's mode, as the copied bytes are the target's.
      (await stat(path.join(copy.source, file))).mode % 0o1000,
    );
  }
  return same(await contents(copy.destination), released);
}

export async function install(request: Request) {
  if (
    !request.check &&
    (!(await writable(request.paths.stateRoot, request.paths.ownedSkills)) ||
      !(await writable(request.paths.stateRoot, request.paths.skillsLock)))
  )
    return {
      reason: "skill_copy_conflict" as const,
      detail: "The device owned-content ledger or lock is externally managed.",
    };
  if (request.check) {
    const initial = await inspect(request, { version: 1, entries: {} });
    if (!("copies" in initial)) return initial;
    return { reason: "skills_checked" as const, data: { hosts: request.hosts, checkOnly: true } };
  }
  await mkdir(request.paths.stateRoot, { recursive: true });
  // Closing the lock at the end of this scope rolls back its transaction and releases it.
  using lock = new Database(request.paths.skillsLock);
  lock.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
  // A participating installer can expose a partial copy until it releases this lock.
  const recorded = await ledger(request.paths.ownedSkills);
  const inspected = await inspect(request, recorded);
  if (!("copies" in inspected)) return inspected;
  for (const copy of inspected.copies) {
    if (!(await changeCopy(copy)))
      return {
        reason: "skill_copy_conflict" as const,
        detail: `Skill contents changed during installation: ${copy.destination}`,
      };
    if (copy.released === null) delete recorded.entries[copy.destination];
    else recorded.entries[copy.destination] = copy.released;
  }
  const text = `${JSON.stringify(recorded, null, 2)}\n`;
  if (
    (await info(request.paths.ownedSkills)) === null ||
    (await Bun.file(request.paths.ownedSkills).text()) !== text
  )
    await writeFile(request.paths.ownedSkills, new TextEncoder().encode(text));
  return {
    reason: inspected.copies.some((copy) => copy.action !== "matching")
      ? ("skills_installed" as const)
      : ("skills_already_installed" as const),
    data: { hosts: request.hosts, checkOnly: false },
  };
}
