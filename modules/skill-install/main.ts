import { type BundledSkill, readBundledSkills, sameBytes, scanFiles } from "./assets.ts";
import { type SkillTarget, skillTargets } from "./targets.ts";

type Placement = { skill: string; target: SkillTarget; path: string };
type Conflict = { skill: string; target: SkillTarget; paths: string[] };

type Inspection = {
  install: Placement[];
  adopt: Placement[];
  conflicts: Conflict[];
  writes: Array<{ path: string; bytes: Uint8Array }>;
};

async function inspectCopy(
  projectRoot: string,
  skill: BundledSkill,
  target: SkillTarget,
): Promise<{
  placement: Placement;
  state: "install" | "adopt";
  writes: Array<{ path: string; bytes: Uint8Array }>;
  conflictPaths: string[];
}> {
  const relativeRoot = `${skillTargets[target]}/${skill.name}`;
  const absoluteRoot = `${projectRoot}/${relativeRoot}`;
  const placement = { skill: skill.name, target, path: relativeRoot };
  const existing = await scanFiles(absoluteRoot);

  if (existing.length === 0) {
    return {
      placement,
      state: "install",
      conflictPaths: [],
      writes: skill.assets.map((asset) => ({
        path: `${absoluteRoot}/${asset.path}`,
        bytes: asset.bytes,
      })),
    };
  }

  const bundledPaths = new Set(skill.assets.map((asset) => asset.path));
  const differing = existing.filter((path) => !bundledPaths.has(path));

  for (const asset of skill.assets) {
    const copy = Bun.file(`${absoluteRoot}/${asset.path}`);
    const matches =
      (await copy.exists()) && sameBytes(new Uint8Array(await copy.arrayBuffer()), asset.bytes);
    if (!matches) {
      differing.push(asset.path);
    }
  }

  return {
    placement,
    state: "adopt",
    writes: [],
    conflictPaths: differing.map((path) => `${relativeRoot}/${path}`).toSorted(),
  };
}

async function inspectProject(projectRoot: string, targets: SkillTarget[]): Promise<Inspection> {
  const inspection: Inspection = { install: [], adopt: [], conflicts: [], writes: [] };

  for (const skill of await readBundledSkills()) {
    for (const target of targets) {
      const copy = await inspectCopy(projectRoot, skill, target);
      if (copy.conflictPaths.length > 0) {
        inspection.conflicts.push({ skill: skill.name, target, paths: copy.conflictPaths });
      } else if (copy.state === "install") {
        inspection.install.push(copy.placement);
        inspection.writes.push(...copy.writes);
      } else {
        inspection.adopt.push(copy.placement);
      }
    }
  }

  return inspection;
}

export const SkillInstall = {
  /** Identifies the exact skill contents this release installs, for release and evidence matching. */
  async identity(): Promise<string> {
    const hasher = new Bun.CryptoHasher("sha256");
    for (const skill of await readBundledSkills()) {
      for (const asset of skill.assets) {
        hasher.update(`${skill.name}/${asset.path}\n`);
        hasher.update(asset.bytes);
      }
    }

    return hasher.digest("hex");
  },

  /** The directory one target keeps its skills in, relative to a project root. */
  targetRoot(request: { target: SkillTarget }): string {
    return skillTargets[request.target];
  },

  /**
   * Reports whether one checkout already holds a named skill for one target.
   * Operator installs only the skills it owns, so a skill it requires but does not ship, such
   * as the review skill, is located rather than copied.
   */
  async locate(request: { projectRoot: string; target: SkillTarget; skill: string }) {
    const path = `${skillTargets[request.target]}/${request.skill}/SKILL.md`;
    const found = await Bun.file(`${request.projectRoot}/${path}`).exists();
    return { status: found ? ("found" as const) : ("absent" as const), path };
  },

  /** Reports which skill copies differ from this release. Writes nothing. */
  async inspect(request: { projectRoot: string; targets: SkillTarget[] }) {
    const inspection = await inspectProject(request.projectRoot, request.targets);
    return { conflicts: inspection.conflicts, missing: inspection.install };
  },

  /**
   * Copies the Operator-owned skills bundled with this release into the selected targets.
   * A complete matching copy is adopted. Any changed copy blocks every write.
   */
  async run(request: { projectRoot: string; targets: SkillTarget[] }) {
    const inspection = await inspectProject(request.projectRoot, request.targets);

    if (inspection.conflicts.length > 0) {
      return { installed: [], adopted: [], conflicts: inspection.conflicts };
    }

    for (const write of inspection.writes) {
      await Bun.write(write.path, write.bytes, { createPath: true });
    }

    return {
      installed: inspection.install,
      adopted: inspection.adopt,
      conflicts: [] as Conflict[],
    };
  },
};
