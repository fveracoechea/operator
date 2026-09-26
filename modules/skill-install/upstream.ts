// Bun has no lstat or file removal API.
import { lstat, rm } from "node:fs/promises";
import { readBundledSkills, sameBytes, scanFiles, type SkillAsset } from "./assets.ts";
import { skillTargets, type SkillTarget } from "./targets.ts";

type Entry = { path: string; hash: string };
type Ledger = { version: 1; skills: Record<string, Entry> };
type Change = {
  skill: string;
  target: SkillTarget;
  path: string;
  kind: "install" | "update" | "adopt";
  files: Array<{ path: string; sha256: string }>;
  removed: string[];
};
type Conflict = { skill: string; target: SkillTarget; paths: string[] };
type SourceSkill = { name: string; source: string; assets: SkillAsset[] };
type Write = { root: string; assets: SkillAsset[]; removed: string[] };

const source = "mattpocock/skills";
const api = process.env.OPERATOR_MATT_SKILLS_API ?? "https://api.github.com";
const raw = process.env.OPERATOR_MATT_SKILLS_API ?? "https://raw.githubusercontent.com";

function hash(assets: SkillAsset[]): string {
  const digest = new Bun.CryptoHasher("sha256");
  for (const asset of assets.toSorted((a, b) => a.path.localeCompare(b.path))) {
    digest.update(asset.path);
    digest.update(asset.bytes);
  }
  return digest.digest("hex");
}

function fileHash(bytes: Uint8Array): string {
  const digest = new Bun.CryptoHasher("sha256");
  digest.update(bytes);
  return digest.digest("hex");
}

async function json(path: string): Promise<unknown> {
  if (process.env.OPERATOR_MATT_SKILLS_API === undefined) {
    const command = Bun.spawn(["gh", "api", `repos/${source}/${path}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([
      command.exited,
      new Response(command.stdout).text(),
      new Response(command.stderr).text(),
    ]);
    if (status !== 0) throw new Error(`Matt skills fetch failed: ${stderr.trim()}`);
    return JSON.parse(stdout);
  }
  const response = await fetch(`${api}/repos/${source}/${path}`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`Matt skills fetch failed (${response.status}): ${path}`);
  return response.json();
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Matt skills response or ledger");
  }
  return value as Record<string, unknown>;
}

function sha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error("Invalid Matt skills commit or blob SHA");
  }
  return value;
}

async function revision(): Promise<string> {
  return sha(object(await json("commits/main")).sha);
}

async function sourceSkills(commit: string): Promise<SourceSkill[]> {
  const tree = object(await json(`git/trees/${commit}?recursive=1`));
  if (tree.truncated !== false || !Array.isArray(tree.tree)) {
    throw new Error("Incomplete Matt skills tree");
  }
  const files = tree.tree.map((item: unknown) => object(item));
  const owned = new Set((await readBundledSkills()).map((skill) => skill.name));
  const skills: SourceSkill[] = [];
  const skillFiles = files.filter(
    (file) =>
      file.type === "blob" &&
      typeof file.path === "string" &&
      /^skills\/[a-z-]+\/[a-z0-9-]+\/SKILL\.md$/.test(file.path),
  );
  for (const skillFile of skillFiles.toSorted((a, b) =>
    String(a.path).localeCompare(String(b.path)),
  )) {
    const skillPath = String(skillFile.path);
    const directory = skillPath.slice(0, -"/SKILL.md".length);
    const name = directory.slice(directory.lastIndexOf("/") + 1);
    if (name === "unslop" || name === "cursor" || owned.has(name)) continue;
    if (skills.some((skill) => skill.name === name))
      throw new Error(`Duplicate Matt skill name: ${name}`);
    const matches = files.filter(
      (file) =>
        file.type === "blob" &&
        typeof file.path === "string" &&
        file.path.startsWith(`${directory}/`),
    );
    const assets = await Promise.all(
      matches.map(async (file) => {
        const response = await fetch(`${raw}/${source}/${commit}/${file.path}`);
        if (!response.ok)
          throw new Error(`Matt skill fetch failed (${response.status}): ${file.path}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const digest = new Bun.CryptoHasher("sha1");
        digest.update(`blob ${bytes.length}\0`);
        digest.update(bytes);
        if (digest.digest("hex") !== file.sha)
          throw new Error(`Matt skill blob changed: ${file.path}`);
        return { path: (file.path as string).slice(directory.length + 1), bytes };
      }),
    );
    skills.push({ name, source: directory, assets });
  }
  if (!skills.some((skill) => skill.name === "code-review")) {
    throw new Error("Matt code-review skill is missing from the roster");
  }
  return skills;
}

async function safeFiles(root: string): Promise<string[]> {
  try {
    if ((await lstat(root)).isSymbolicLink())
      throw new Error(`Symbolic link in skill path: ${root}`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return [];
  }
  const paths = await scanFiles(root);
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      if ((await lstat(`${root}/${parts.slice(0, i).join("/")}`)).isSymbolicLink()) {
        throw new Error(`Symbolic link in skill path: ${root}/${path}`);
      }
    }
  }
  return paths;
}

async function ledger(root: string): Promise<Ledger> {
  const path = `${root}/.operator-matt-skills.json`;
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error(`Symbolic link in Matt skills ledger: ${path}`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { version: 1, skills: {} };
    throw error;
  }
  const file = Bun.file(path);
  const parsed = object(JSON.parse(await file.text()));
  const skills = object(parsed.skills);
  if (parsed.version !== 1) throw new Error("Unsupported Matt skills ledger");
  for (const entry of Object.values(skills)) {
    const value = object(entry);
    if (typeof value.path !== "string" || !/^[a-f0-9]{64}$/.test(String(value.hash))) {
      throw new Error("Invalid Matt skills ledger");
    }
  }
  return { version: 1, skills: skills as Record<string, Entry> };
}

async function inspect(projectRoot: string, targets: SkillTarget[], commit: string) {
  const skills = await sourceSkills(commit);
  const changes: Change[] = [];
  const conflicts: Conflict[] = [];
  const writes: Write[] = [];
  const ledgers: Array<{ path: string; before: string | null; after: string }> = [];
  const fingerprint = new Bun.CryptoHasher("sha256");
  fingerprint.update(commit);
  for (const target of targets.toSorted()) {
    fingerprint.update(target);
    const targetRoot = `${projectRoot}/${skillTargets[target]}`;
    const targetFolder = `${projectRoot}/${skillTargets[target].split("/")[0]}`;
    for (const folder of [targetFolder, targetRoot]) {
      try {
        if ((await lstat(folder)).isSymbolicLink())
          throw new Error(`Symbol link in skill path: ${folder}`);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    const ledgerPath = `${targetRoot}/.operator-matt-skills.json`;
    const record = await ledger(targetRoot);
    const before = (await Bun.file(ledgerPath).exists()) ? await Bun.file(ledgerPath).text() : null;
    fingerprint.update(before ?? "missing");
    const next: Ledger = { version: 1, skills: { ...record.skills } };
    for (const skill of skills) {
      const path = `${skillTargets[target]}/${skill.name}`;
      const root = `${projectRoot}/${path}`;
      const paths = await safeFiles(root);
      const current = await Promise.all(
        paths.map(async (assetPath) => ({
          path: assetPath,
          bytes: new Uint8Array(await Bun.file(`${root}/${assetPath}`).arrayBuffer()),
        })),
      );
      const desiredHash = hash(skill.assets);
      const currentHash = hash(current);
      const removed = paths.filter((one) => !skill.assets.some((asset) => asset.path === one));
      fingerprint.update(`${path}\n${currentHash}\n${desiredHash}`);
      const prior = record.skills[skill.name];
      const allowed =
        currentHash === desiredHash ||
        (prior === undefined && paths.length === 0) ||
        (prior?.path === skill.source && prior.hash === currentHash);
      if (!allowed) {
        conflicts.push({
          skill: skill.name,
          target,
          paths: [
            ...new Set([
              ...paths,
              ...skill.assets
                .filter((asset) => !paths.includes(asset.path))
                .map((asset) => asset.path),
            ]),
          ]
            .map((one) => `${path}/${one}`)
            .toSorted(),
        });
        continue;
      }
      next.skills[skill.name] = { path: skill.source, hash: desiredHash };
      if (currentHash === desiredHash) {
        if (prior?.hash !== desiredHash)
          changes.push({ skill: skill.name, target, path, kind: "adopt", files: [], removed: [] });
      } else {
        changes.push({
          skill: skill.name,
          target,
          path,
          kind: paths.length === 0 ? "install" : "update",
          files: skill.assets.map((asset) => ({
            path: `${path}/${asset.path}`,
            sha256: fileHash(asset.bytes),
          })),
          removed: removed.map((one) => `${path}/${one}`),
        });
        writes.push({ root, assets: skill.assets, removed });
      }
    }
    const after = `${JSON.stringify(next, null, 2)}\n`;
    if (before !== after) ledgers.push({ path: ledgerPath, before, after });
  }
  const planId = fingerprint.digest("hex");
  return { commit, planId, targets, changes, conflicts, writes, ledgers };
}

export const MattSkills = {
  async plan(request: { projectRoot: string; targets: SkillTarget[]; commit?: string }) {
    const commit = request.commit ?? (await revision());
    sha(commit);
    const {
      writes: _writes,
      ledgers: _ledgers,
      ...plan
    } = await inspect(request.projectRoot, request.targets, commit);
    return plan;
  },
  async apply(request: {
    projectRoot: string;
    targets: SkillTarget[];
    commit: string;
    approvedPlanId: string | undefined;
  }) {
    sha(request.commit);
    const plan = await inspect(request.projectRoot, request.targets, request.commit);
    if (plan.conflicts.length) return { status: "conflict" as const, plan };
    if (plan.planId !== request.approvedPlanId) return { status: "approval-stale" as const, plan };
    for (const write of plan.writes) {
      for (const asset of write.assets) {
        const file = `${write.root}/${asset.path}`;
        const current = Bun.file(file);
        if (
          !(await current.exists()) ||
          !sameBytes(new Uint8Array(await current.arrayBuffer()), asset.bytes)
        ) {
          await Bun.write(file, asset.bytes, { createPath: true });
        }
      }
      for (const path of write.removed) await rm(`${write.root}/${path}`);
    }
    for (const record of plan.ledgers)
      await Bun.write(record.path, record.after, { createPath: true });
    return { status: "applied" as const, plan };
  },
};
