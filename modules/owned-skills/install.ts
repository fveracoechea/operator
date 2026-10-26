// Bun has no directory creation, atomic rename, or directory removal API.
import { mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import type { OperatorHome } from "../operator-home/main.ts";
import { contents, info, same, verdict, writable, type Contents } from "./content.ts";

export type Paths = ReturnType<typeof OperatorHome.resolve>;
export type Host = keyof Paths["skillHosts"];
export type Request = { paths: Paths; hosts: Host[]; check: boolean; source: string };
const ledgerSchema = z.strictObject({
  version: z.literal(1),
  entries: z.record(z.string(), z.record(z.string(), z.string())),
});
type Ledger = z.infer<typeof ledgerSchema>;
type Copy = {
  name: string;
  host: Host;
  destination: string;
  source: string;
  released: Contents | null;
  current: Contents | null;
  action: ReturnType<typeof verdict>;
};
type Refusal = { reason: "skills_release_invalid" | "skill_copy_conflict"; detail: string };
const retired = ["operator", "operative"];

export function checkOnly(source: string, requested: boolean) {
  return requested || source.startsWith("/nix/store/");
}

async function ledger(file: string): Promise<Ledger> {
  if ((await info(file)) === null) return { version: 1, entries: {} };
  return ledgerSchema.parse(await Bun.file(file).json());
}

async function inspect(request: Request, recorded: Ledger): Promise<{ copies: Copy[] } | Refusal> {
  const names = [];
  for await (const file of new Bun.Glob("*/SKILL.md").scan({ cwd: request.source }))
    names.push(file.split("/")[0] ?? "");
  if (names.length === 0)
    return {
      reason: "skills_release_invalid" as const,
      detail: "The running release has no owned skills.",
    };
  const copies: Copy[] = [];
  for (const host of request.hosts) {
    for (const name of [...names.toSorted(), ...retired]) {
      const destination = path.join(request.paths.skillHosts[host], name);
      const source = path.join(request.source, name);
      const released = retired.includes(name) ? null : await contents(source, true);
      const current = await contents(destination, request.check);
      let action = verdict(current, released, recorded.entries[destination] ?? null);
      if (!request.check && !(await copyWritable(destination, current))) action = "conflict";
      copies.push({ name, host, destination, source, released, current, action });
    }
  }
  const conflicts = copies.filter((copy) =>
    request.check
      ? copy.released !== null && !same(copy.current, copy.released)
      : copy.action === "conflict",
  );
  if (conflicts.length)
    return {
      reason: "skill_copy_conflict" as const,
      detail: `Preserve these skill paths and resolve their contents or external wiring: ${conflicts.map((copy) => copy.destination).join(", ")}`,
    };
  return { copies };
}

async function copyWritable(destination: string, current: Contents | null) {
  for (const file of ["", ...Object.keys(current ?? {})])
    if (!(await writable(path.join(destination, file)))) return false;
  return true;
}

async function writeFile(file: string, bytes: Uint8Array, mode = 0o600) {
  const temporary = `${file}.operator-${crypto.randomUUID()}`;
  const handle = await open(temporary, "wx", mode);
  try {
    await Bun.write(Bun.file(handle.fd), bytes);
    await handle.sync();
    await rename(temporary, file);
  } finally {
    await handle.close();
    if ((await info(temporary)) !== null) await unlink(temporary);
  }
}

async function removeFiles(copy: Copy, retained: Contents = {}) {
  if (copy.current === null) return;
  const files = Object.keys(copy.current).filter((file) => retained[file] === undefined);
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
    !(await copyWritable(copy.destination, copy.current)) ||
    !same(await contents(copy.destination, false), copy.current)
  )
    return false;
  if (copy.action === "remove") {
    await removeFiles(copy);
    return true;
  }
  const released = copy.released;
  if (released === null) return false;
  await removeFiles(copy, released);
  for (const file of Object.keys(released).filter((file) => file.endsWith("/")))
    await mkdir(path.join(copy.destination, file), { recursive: true });
  for (const file of Object.keys(released).filter((file) => !file.endsWith("/"))) {
    if (copy.current?.[file] === released[file]) continue;
    if (!(await writable(path.join(copy.destination, file)))) return false;
    await writeFile(
      path.join(copy.destination, file),
      await Bun.file(path.join(copy.source, file)).bytes(),
      Number.parseInt(
        (await info(path.join(copy.source, file)))?.mode.toString(8).slice(-3) ?? "644",
        8,
      ),
    );
  }
  return same(await contents(copy.destination, false), released);
}

export async function install(request: Request) {
  if (
    !request.check &&
    (!(await writable(request.paths.ownedSkills)) || !(await writable(request.paths.skillsLock)))
  )
    return {
      reason: "skill_copy_conflict" as const,
      detail: "The device owned-content ledger or lock is externally managed.",
    };
  const initial = await inspect(
    request,
    request.check ? { version: 1, entries: {} } : await ledger(request.paths.ownedSkills),
  );
  if (!("copies" in initial)) return initial;
  if (request.check)
    return { reason: "skills_checked" as const, data: { hosts: request.hosts, checkOnly: true } };
  await mkdir(request.paths.stateRoot, { recursive: true });
  using lock = new Database(request.paths.skillsLock);
  lock.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
  try {
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
  } finally {
    lock.exec("ROLLBACK");
  }
}
