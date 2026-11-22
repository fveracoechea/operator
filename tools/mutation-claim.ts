// Bun has no atomic directory claim, rename, or real-path API.
import { mkdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

const ownerSchema = z.object({
  version: z.literal(1),
  token: z.uuid(),
  pid: z.number().int().positive(),
  group: z.number().int().positive().optional(),
});
const busy = { error: "Mutation worktree busy. Use --recover-claim only after its owner stops." };

export async function mutationStateDirectory(root: string): Promise<string> {
  const git = Bun.spawnSync(["git", "rev-parse", "--absolute-git-dir"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const canonical = await realpath(root);
  const key = new Bun.CryptoHasher("sha256").update(canonical).digest("hex");
  const directory =
    git.exitCode === 0
      ? path.join(await realpath(git.stdout.toString().trim()), "mutation-campaign")
      : path.join(tmpdir(), "operator-mutation", key);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

async function owner(directory: string) {
  return ownerSchema.safeParse(
    await Bun.file(path.join(directory, "owner.json"))
      .json()
      .catch(() => undefined),
  );
}

function absent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return z.object({ code: z.literal("ESRCH") }).safeParse(error).success;
  }
}

export async function acquireMutationClaim(state: string) {
  const directory = path.join(state, "claim");
  try {
    await mkdir(directory);
  } catch {
    return busy;
  }
  const record = { version: 1 as const, token: crypto.randomUUID(), pid: process.pid };
  await Bun.write(path.join(directory, "owner.json"), JSON.stringify(record));
  return {
    token: record.token,
    async setGroup(group: number): Promise<void> {
      await Bun.write(path.join(directory, "owner.json"), JSON.stringify({ ...record, group }));
    },
    async release(): Promise<void> {
      const current = await owner(directory);
      if (
        current.success &&
        current.data.token === record.token &&
        (current.data.group === undefined || absent(-current.data.group))
      )
        await rm(directory, { recursive: true });
    },
  };
}

export async function recoverMutationClaim(
  state: string,
): Promise<{ error: string } | { recovered: true }> {
  const recovery = path.join(state, "recovery");
  try {
    await mkdir(recovery);
  } catch {
    return busy;
  }
  try {
    const directory = path.join(state, "claim");
    const current = await owner(directory);
    if (
      !current.success ||
      !absent(current.data.pid) ||
      (current.data.group !== undefined && !absent(-current.data.group))
    )
      return {
        error: "Mutation claim is active or uncertain; recovery refused without changing it.",
      };
    await rename(directory, path.join(state, `recovered-${current.data.token}`));
    return { recovered: true };
  } finally {
    await rm(recovery, { recursive: true });
  }
}
