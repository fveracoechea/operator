// Bun has no recursive directory copy API.
import { copyFile, lstat, mkdir } from "node:fs/promises";
import { firstSymlink } from "./filesystem.ts";

const skillSource = new URL("../../skills/operator/", import.meta.url).pathname;

export const targetDirectories = {
  claude: ".claude/skills/operator",
  opencode: ".agents/skills/operator",
} as const;

export async function getSkillAssets(): Promise<Array<{ path: string; content: string }>> {
  const paths = await Array.fromAsync(
    new Bun.Glob("**/*").scan({ cwd: skillSource, dot: true, onlyFiles: true }),
  );
  return Promise.all(
    paths
      .toSorted()
      .map(async (path) => ({ path, content: await Bun.file(`${skillSource}/${path}`).text() })),
  );
}

async function pathsIn(directory: string): Promise<string[]> {
  return Array.fromAsync(
    new Bun.Glob("**/*").scan({ cwd: directory, dot: true, onlyFiles: false }),
  );
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return false;
      }
      throw error;
    },
  );
}

async function directoriesMatch(source: string, destination: string): Promise<boolean> {
  if (!(await pathExists(destination))) {
    return false;
  }
  if ((await lstat(destination)).isSymbolicLink()) {
    return false;
  }

  const [sourcePaths, destinationPaths] = await Promise.all([
    pathsIn(source),
    pathsIn(destination),
  ]);
  if (sourcePaths.toSorted().join("\n") !== destinationPaths.toSorted().join("\n")) {
    return false;
  }

  for (const path of destinationPaths) {
    if ((await lstat(`${destination}/${path}`)).isSymbolicLink()) {
      return false;
    }
  }

  for (const path of sourcePaths) {
    const sourceFile = Bun.file(`${source}/${path}`);
    if (sourceFile.type === "application/octet-stream" && !(await sourceFile.exists())) {
      continue;
    }

    const destinationFile = Bun.file(`${destination}/${path}`);
    if (
      (await sourceFile.arrayBuffer()).byteLength !==
      (await destinationFile.arrayBuffer()).byteLength
    ) {
      return false;
    }
    if ((await sourceFile.bytes()).toString() !== (await destinationFile.bytes()).toString()) {
      return false;
    }
  }

  return true;
}

export async function inspectSkillTarget(input: {
  projectRoot: string;
  target: "claude" | "opencode";
}) {
  const relative = targetDirectories[input.target];
  const absolute = `${input.projectRoot}/${relative}`;
  if (await firstSymlink(input.projectRoot, relative)) {
    return { target: input.target, relative, absolute, state: "conflict" as const };
  }
  if (!(await pathExists(absolute))) {
    return { target: input.target, relative, absolute, state: "missing" as const };
  }
  return {
    target: input.target,
    relative,
    absolute,
    state: (await directoriesMatch(skillSource, absolute))
      ? ("matching" as const)
      : ("conflict" as const),
  };
}

export async function installSkills(input: {
  projectRoot: string;
  targets: Array<"claude" | "opencode">;
}) {
  const sourcePaths = await pathsIn(skillSource);
  const states = await Promise.all(
    input.targets.map((target) => inspectSkillTarget({ projectRoot: input.projectRoot, target })),
  );
  const conflicts = states.filter((state) => state.state === "conflict");
  if (conflicts.length > 0) {
    return {
      outcome: "conflict" as const,
      reason: "skill_copy_conflict" as const,
      changed: [],
      blockers: conflicts.map(({ relative, target }) => ({
        reason: "skill_copy_conflict" as const,
        path: relative,
        target,
      })),
    };
  }

  const changed: string[] = [];
  for (const destination of states) {
    if (destination.state === "matching") {
      continue;
    }
    for (const path of sourcePaths) {
      const sourcePath = `${skillSource}/${path}`;
      const destinationPath = `${destination.absolute}/${path}`;
      const sourceFile = Bun.file(sourcePath);
      if (await sourceFile.exists()) {
        await mkdir(new URL(".", Bun.pathToFileURL(destinationPath)), { recursive: true });
        await copyFile(sourcePath, destinationPath);
      } else {
        await mkdir(destinationPath, { recursive: true });
      }
    }
    changed.push(destination.relative);
  }

  return {
    outcome: "completed" as const,
    reason:
      changed.length === 0 ? ("skills_already_installed" as const) : ("skills_installed" as const),
    changed,
    blockers: [],
  };
}
