// Bun has no lstat or file removal API.
import { lstat, rm } from "node:fs/promises";
import { z } from "zod";
import { ContentIdentity } from "../content-identity/main.ts";
import { readBundledSkills, sameBytes, scanFiles, type SkillAsset } from "./assets.ts";
import { skillTargets, type SkillTarget } from "./targets.ts";

const invalidResponse = "Invalid Matt skills response or ledger";
const invalidSha = "Invalid Matt skills commit or blob SHA";

const shaSchema = z.string({ error: invalidSha }).regex(/^[a-f0-9]{40}$/, { error: invalidSha });
const commitSchema = z.object({ sha: z.unknown() }, { error: invalidResponse });
const treeSchema = z.object(
  {
    truncated: z.literal(false, { error: "Incomplete Matt skills tree" }),
    tree: z.array(
      z.object(
        { type: z.unknown(), path: z.unknown(), sha: z.unknown() },
        { error: invalidResponse },
      ),
      { error: "Incomplete Matt skills tree" },
    ),
  },
  { error: invalidResponse },
);
const ledgerFileSchema = z.object(
  { version: z.unknown(), skills: z.record(z.string(), z.unknown(), { error: invalidResponse }) },
  { error: invalidResponse },
);
const entrySchema = z.object({ path: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/) });
type Entry = z.infer<typeof entrySchema>;
// A custom check keeps each recorded entry as written, so its bytes return unchanged in the next ledger.
const ledgerSkillsSchema = z.record(
  z.string(),
  z.custom<Entry>((value) => entrySchema.safeParse(value).success, {
    error: (issue) =>
      z.object({}).safeParse(issue.input).success ? "Invalid Matt skills ledger" : invalidResponse,
  }),
);

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
type Plan = {
  changes: Change[];
  conflicts: Conflict[];
  writes: Write[];
  ledgers: Array<{ path: string; before: string | null; after: string }>;
};
type Copy = { paths: string[]; hash: string };
type Verdict = "conflict" | "adopt" | "write" | "unchanged";

const source = "mattpocock/skills";

function hash(assets: SkillAsset[]): string {
  const digest = new Bun.CryptoHasher("sha256");
  for (const asset of assets.toSorted((a, b) => a.path.localeCompare(b.path))) {
    digest.update(asset.path);
    digest.update(asset.bytes);
  }
  return digest.digest("hex");
}

async function json(path: string): Promise<unknown> {
  // The upstream override is read on each call, so one process can point at a local server.
  const api = process.env.OPERATOR_MATT_SKILLS_API;
  if (api === undefined) {
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

/** Parses a value at the boundary. A refusal carries the message of its first issue. */
function parse<Schema extends z.ZodType>(schema: Schema, value: unknown): z.output<Schema> {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(result.error.issues[0]?.message);
  return result.data;
}

/** Refuses a symbolic link at a path. Returns false when nothing is at the path. */
async function present(path: string, refusal: string): Promise<boolean> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(refusal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function revision(): Promise<string> {
  return parse(shaSchema, parse(commitSchema, await json("commits/main")).sha);
}

async function fetchAssets(
  commit: string,
  directory: string,
  files: Array<{ path: string; sha: unknown }>,
) {
  return Promise.all(
    files
      .filter((file) => file.path.startsWith(`${directory}/`))
      .map(async (file) => {
        const raw = process.env.OPERATOR_MATT_SKILLS_API ?? "https://raw.githubusercontent.com";
        const response = await fetch(`${raw}/${source}/${commit}/${file.path}`);
        if (!response.ok)
          throw new Error(`Matt skill fetch failed (${response.status}): ${file.path}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const digest = new Bun.CryptoHasher("sha1");
        digest.update(`blob ${bytes.length}\0`);
        digest.update(bytes);
        if (digest.digest("hex") !== file.sha)
          throw new Error(`Matt skill blob changed: ${file.path}`);
        return { path: file.path.slice(directory.length + 1), bytes };
      }),
  );
}

async function sourceSkills(commit: string): Promise<SourceSkill[]> {
  const files = parse(treeSchema, await json(`git/trees/${commit}?recursive=1`)).tree.flatMap(
    (file) =>
      file.type === "blob" && typeof file.path === "string"
        ? [{ path: file.path, sha: file.sha }]
        : [],
  );
  const owned = new Set((await readBundledSkills()).map((skill) => skill.name));
  const skills: SourceSkill[] = [];
  const skillFiles = files.filter((file) =>
    /^skills\/[a-z-]+\/[a-z0-9-]+\/SKILL\.md$/.test(file.path),
  );
  for (const skillFile of skillFiles.toSorted((a, b) => a.path.localeCompare(b.path))) {
    const directory = skillFile.path.slice(0, -"/SKILL.md".length);
    const name = directory.slice(directory.lastIndexOf("/") + 1);
    if (name === "unslop" || name === "cursor" || owned.has(name)) continue;
    if (skills.some((skill) => skill.name === name))
      throw new Error(`Duplicate Matt skill name: ${name}`);
    skills.push({ name, source: directory, assets: await fetchAssets(commit, directory, files) });
  }
  if (!skills.some((skill) => skill.name === "code-review")) {
    throw new Error("Matt code-review skill is missing from the roster");
  }
  return skills;
}

async function safeFiles(root: string): Promise<string[]> {
  if (!(await present(root, `Symbolic link in skill path: ${root}`))) return [];
  const paths = await scanFiles(root);
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      await present(
        `${root}/${parts.slice(0, i).join("/")}`,
        `Symbolic link in skill path: ${root}/${path}`,
      );
    }
  }
  return paths;
}

async function ledger(root: string): Promise<Ledger> {
  const path = `${root}/.operator-matt-skills.json`;
  if (!(await present(path, `Symbolic link in Matt skills ledger: ${path}`))) {
    return { version: 1, skills: {} };
  }
  const parsed = parse(ledgerFileSchema, JSON.parse(await Bun.file(path).text()));
  if (parsed.version !== 1) throw new Error("Unsupported Matt skills ledger");
  return { version: 1, skills: parse(ledgerSkillsSchema, parsed.skills) };
}

/** Decides what one skill copy needs. Only a copy that matches the desired bytes, an empty path, or the last recorded write may change. */
function copyVerdict(skill: SourceSkill, current: Copy, prior: Entry | undefined): Verdict {
  const desired = hash(skill.assets);
  if (current.hash === desired) return prior?.hash === desired ? "unchanged" : "adopt";
  if (prior === undefined && current.paths.length === 0) return "write";
  if (prior?.path === skill.source && prior.hash === current.hash) return "write";
  return "conflict";
}

async function readCopy(root: string): Promise<Copy> {
  const paths = await safeFiles(root);
  const assets = await Promise.all(
    paths.map(async (assetPath) => ({
      path: assetPath,
      bytes: new Uint8Array(await Bun.file(`${root}/${assetPath}`).arrayBuffer()),
    })),
  );
  return { paths, hash: hash(assets) };
}

async function inspectTarget(
  projectRoot: string,
  target: SkillTarget,
  skills: SourceSkill[],
  fingerprint: Bun.CryptoHasher,
  plan: Plan,
) {
  fingerprint.update(target);
  const targetRoot = `${projectRoot}/${skillTargets[target]}`;
  const targetFolder = `${projectRoot}/${skillTargets[target].split("/")[0]}`;
  for (const folder of [targetFolder, targetRoot]) {
    await present(folder, `Symbol link in skill path: ${folder}`);
  }
  const ledgerPath = `${targetRoot}/.operator-matt-skills.json`;
  const record = await ledger(targetRoot);
  const before = (await Bun.file(ledgerPath).exists()) ? await Bun.file(ledgerPath).text() : null;
  fingerprint.update(before ?? "missing");
  const next: Ledger = { version: 1, skills: { ...record.skills } };
  for (const skill of skills) {
    const path = `${skillTargets[target]}/${skill.name}`;
    const root = `${projectRoot}/${path}`;
    const current = await readCopy(root);
    const desiredHash = hash(skill.assets);
    fingerprint.update(`${path}\n${current.hash}\n${desiredHash}`);
    const verdict = copyVerdict(skill, current, record.skills[skill.name]);
    if (verdict === "conflict") {
      const missing = skill.assets
        .filter((asset) => !current.paths.includes(asset.path))
        .map((asset) => asset.path);
      plan.conflicts.push({
        skill: skill.name,
        target,
        paths: [...new Set([...current.paths, ...missing])]
          .map((one) => `${path}/${one}`)
          .toSorted(),
      });
      continue;
    }
    next.skills[skill.name] = { path: skill.source, hash: desiredHash };
    if (verdict === "adopt") {
      plan.changes.push({ skill: skill.name, target, path, kind: "adopt", files: [], removed: [] });
    }
    if (verdict === "write") {
      const removed = current.paths.filter(
        (one) => !skill.assets.some((asset) => asset.path === one),
      );
      plan.changes.push({
        skill: skill.name,
        target,
        path,
        kind: current.paths.length === 0 ? "install" : "update",
        files: skill.assets.map((asset) => ({
          path: `${path}/${asset.path}`,
          sha256: ContentIdentity.ofBytes(asset.bytes),
        })),
        removed: removed.map((one) => `${path}/${one}`),
      });
      plan.writes.push({ root, assets: skill.assets, removed });
    }
  }
  const after = `${JSON.stringify(next, null, 2)}\n`;
  if (before !== after) plan.ledgers.push({ path: ledgerPath, before, after });
}

async function inspect(projectRoot: string, targets: SkillTarget[], commit: string) {
  const skills = await sourceSkills(commit);
  const plan: Plan = { changes: [], conflicts: [], writes: [], ledgers: [] };
  const fingerprint = new Bun.CryptoHasher("sha256");
  fingerprint.update(commit);
  for (const target of targets.toSorted()) {
    await inspectTarget(projectRoot, target, skills, fingerprint, plan);
  }
  const planId = fingerprint.digest("hex");
  return { commit, planId, targets, ...plan };
}

export const MattSkills = {
  async plan(request: { projectRoot: string; targets: SkillTarget[]; commit?: string }) {
    const commit = request.commit ?? (await revision());
    parse(shaSchema, commit);
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
    parse(shaSchema, request.commit);
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
