import { ContentIdentity } from "../content-identity/main.ts";
import { type BundledSkill, readBundledSkills, sameBytes, scanFiles } from "./assets.ts";
import { type CommittedCopy, committedCopies, committedCopiesSchema } from "./committed.ts";
import { isSkillTarget, type SkillTarget, skillTargets } from "./targets.ts";
import { MattSkills } from "./upstream.ts";

type Placement = { skill: string; target: SkillTarget; path: string };
type Conflict = { skill: string; target: SkillTarget; paths: string[] };

type Inspection = {
  install: Placement[];
  adopt: Placement[];
  conflicts: Conflict[];
  writes: Array<{ path: string; bytes: Uint8Array }>;
};

/** True when the checkout holds exactly the committed copy at its path, or no file for none. */
async function holdsCommitted(projectRoot: string, copy: CommittedCopy): Promise<boolean> {
  const file = Bun.file(`${projectRoot}/${copy.path}`);
  if (!(await file.exists())) return copy.identity === null;
  return ContentIdentity.ofBytes(new Uint8Array(await file.arrayBuffer())) === copy.identity;
}

async function inspectCopy(
  projectRoot: string,
  skill: BundledSkill,
  target: SkillTarget,
  committed: CommittedCopy[],
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
  // A skill directory that crew work removed is a committed change like any other, so the
  // checkout keeps it removed instead of installing it again.
  const committedHere = committed.some((one) => one.path.startsWith(`${relativeRoot}/`));

  if (existing.length === 0 && !committedHere) {
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

  // A committed copy that the checkout still holds exactly is not a conflict, and is not written.
  const conflictPaths: string[] = [];
  for (const path of differing.map((one) => `${relativeRoot}/${one}`)) {
    const copy = committed.find((one) => one.path === path);
    if (copy === undefined || !(await holdsCommitted(projectRoot, copy))) {
      conflictPaths.push(path);
    }
  }

  return { placement, state: "adopt", writes: [], conflictPaths: conflictPaths.toSorted() };
}

async function inspectProject(
  projectRoot: string,
  targets: SkillTarget[],
  committed: CommittedCopy[] = [],
): Promise<Inspection> {
  const inspection: Inspection = { install: [], adopt: [], conflicts: [], writes: [] };

  for (const skill of await readBundledSkills()) {
    for (const target of targets) {
      const copy = await inspectCopy(projectRoot, skill, target, committed);
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
  /** Plans pinned upstream Matt skill copies for the selected project hosts. */
  async mattPlan(request: { projectRoot: string; targets: SkillTarget[]; commit?: string }) {
    return MattSkills.plan(request);
  },
  /** Applies an approved upstream plan after fetching and checking its pinned bytes again. */
  async mattApply(request: {
    projectRoot: string;
    targets: SkillTarget[];
    commit: string;
    approvedPlanId: string | undefined;
  }) {
    return MattSkills.apply(request);
  },
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

  /**
   * Names the skill copies one commit holds in place of this release, where the base commit
   * still held what this release writes. Work after the base commit changed each of them.
   * A copy that already differs at the base is not named, so it stays a conflict. A host this
   * release installs no skills for has none.
   */
  async committedCopies(request: {
    projectRoot: string;
    target: string | null;
    base: string;
    commit: string;
  }): Promise<CommittedCopy[]> {
    const { target } = request;
    if (!isSkillTarget(target) || request.base === request.commit) {
      return [];
    }
    return committedCopies({
      repoRoot: request.projectRoot,
      root: skillTargets[target],
      skills: await readBundledSkills(),
      base: request.base,
      commit: request.commit,
    });
  },

  /** The shape of the committed copies a launch records, so its reader parses this one shape. */
  committedCopiesSchema() {
    return committedCopiesSchema;
  },

  /**
   * Reports which skill copies differ from this release. Writes nothing.
   * A named committed copy that the checkout holds exactly is not a conflict.
   */
  async inspect(request: {
    projectRoot: string;
    targets: SkillTarget[];
    committed?: CommittedCopy[];
  }) {
    const inspection = await inspectProject(
      request.projectRoot,
      request.targets,
      request.committed,
    );
    return { conflicts: inspection.conflicts, missing: inspection.install };
  },

  /**
   * Copies the Operator-owned skills bundled with this release into the selected targets.
   * A complete matching copy is adopted. Any changed copy blocks every write, except a named
   * committed copy that the checkout holds exactly, which is kept as it is.
   */
  async run(request: { projectRoot: string; targets: SkillTarget[]; committed?: CommittedCopy[] }) {
    const inspection = await inspectProject(
      request.projectRoot,
      request.targets,
      request.committed,
    );

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
