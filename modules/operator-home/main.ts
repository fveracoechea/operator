// Bun has no path, account-home, or synchronous real-path API.
import path from "node:path";
import { tmpdir, userInfo } from "node:os";
import { existsSync, realpathSync } from "node:fs";
import type { Environment } from "../environment/main.ts";

function refuseRealRoot(candidate: string, forbidden: string[]) {
  if (forbidden.some((root) => candidate === root || candidate.startsWith(`${root}/`))) {
    // oxlint-disable-next-line unthrown/no-throw -- A test reaching real device state is a defect.
    throw new Error(`Tests cannot access the real Operator root: ${candidate}`);
  }
}

function existingAncestor(file: string): string {
  return existsSync(file) ? file : existingAncestor(path.dirname(file));
}

function guardTestRoots(roots: string[]) {
  const home = userInfo().homedir;
  const forbidden = [path.join(home, ".config/operator"), path.join(home, ".local/state/operator")];
  for (const root of roots) {
    const parts = path.resolve(root).split("/");
    let resolved = "/";
    // Stryker disable next-line EqualityOperator: no rule: the last pass differs only for a final link into an existing real Operator root, and tests must not create or inspect real Operator state
    for (let index = 0; index <= parts.length; index++) {
      // Check the remaining path before following a link into a real settings or state folder.
      refuseRealRoot(path.join(resolved, ...parts.slice(index)), forbidden);
      const part = parts[index];
      if (part === undefined) break;
      const next = path.join(resolved, part);
      resolved = existsSync(next) ? realpathSync(next) : next;
    }
  }
}

/** Owns every Operator path. Resolution creates no directories or project records. */
export const OperatorHome = {
  resolve(environment: ReturnType<typeof Environment.read>) {
    const configRoot = path.join(
      environment.XDG_CONFIG_HOME ?? path.join(environment.HOME, ".config"),
      "operator",
    );
    const stateRoot = path.join(
      environment.XDG_STATE_HOME ?? path.join(environment.HOME, ".local/state"),
      "operator",
    );
    const skillHosts = {
      opencode: path.join(
        environment.XDG_CONFIG_HOME ?? path.join(environment.HOME, ".config"),
        "opencode/skills",
      ),
      "claude-code": path.join(environment.HOME, ".claude/skills"),
    };
    if (environment.NODE_ENV === "test") guardTestRoots([configRoot, stateRoot]);
    return {
      configRoot,
      stateRoot,
      database: path.join(stateRoot, "operator.sqlite"),
      backups: path.join(stateRoot, "backups"),
      projects: path.join(stateRoot, "projects"),
      config: path.join(configRoot, "config.json"),
      schema: path.join(configRoot, "config.schema.json"),
      configState: path.join(stateRoot, "config"),
      receipt: path.join(stateRoot, "config/apply.json"),
      // Each write adds a random suffix, so a file left by a stopped write never blocks the next.
      receiptTemporaryPrefix: path.join(stateRoot, "config/apply.json.tmp-"),
      writeLock: path.join(stateRoot, "config/write.sqlite"),
      configTemporaryPrefix: path.join(configRoot, "config.json.tmp-"),
      skillHosts,
      upstreamSkills: {
        opencode: path.join(environment.HOME, ".agents/skills"),
        "claude-code": skillHosts["claude-code"],
      },
      ownedSkills: path.join(stateRoot, "owned-skills.json"),
      skillsLock: path.join(stateRoot, "owned-skills-lock.sqlite"),
      herdrPlugin: path.join(stateRoot, "herdr-plugin"),
    };
  },
  registrationDatabase(paths: { stateRoot: string }, nonce: string) {
    return path.join(paths.stateRoot, `.registration-${nonce}.sqlite`);
  },
  migrationBackup(paths: { backups: string }, identity: string) {
    const directory = path.join(paths.backups, identity);
    return {
      directory,
      database: path.join(directory, "operator.sqlite"),
      receipt: path.join(directory, "verified.json"),
    };
  },
  projectDirectory(paths: { projects: string }, repository: string) {
    return path.join(paths.projects, repository);
  },
  /** Every brief, report, and supporting file of one source. Prune deletes this folder. */
  sourceDirectory(paths: { projects: string }, input: { repository: string; sourceId: string }) {
    return path.join(
      paths.projects,
      input.repository,
      "sources",
      encodeURIComponent(input.sourceId),
    );
  },
  /** Assignment keys are supplied text, so each one maps to a single safe path segment. */
  assignmentFiles(
    paths: { projects: string },
    input: { repository: string; sourceId: string; assignment: string },
  ) {
    const segment = encodeURIComponent(input.assignment).replaceAll(".", "%2E");
    const directory = path.join(OperatorHome.sourceDirectory(paths, input), "assignments", segment);
    return {
      directory,
      brief: path.join(directory, "brief.md"),
      reports: path.join(directory, "reports"),
      followUps: path.join(directory, "follow-ups"),
    };
  },
  /** A review request keeps its brief and draft in device state, never in the reviewer worktree. */
  reviewFiles(paths: { projects: string }, input: { repository: string; requestId: string }) {
    const directory = path.join(
      paths.projects,
      input.repository,
      "reviews",
      encodeURIComponent(input.requestId),
    );
    return {
      directory,
      brief: path.join(directory, "brief.md"),
      draft: path.join(directory, "draft.json"),
      // The posted draft of each round, for the reviewer and its replacement.
      rounds: path.join(directory, "rounds"),
    };
  },
  guardTemporaryTests(environment: ReturnType<typeof Environment.read>, roots: string[]) {
    if (environment.NODE_ENV !== "test") return;
    const temporary = realpathSync(tmpdir());
    for (const root of roots) {
      const real = realpathSync(existingAncestor(root));
      if (real !== temporary && !real.startsWith(`${temporary}/`)) {
        // oxlint-disable-next-line unthrown/no-throw -- Tests may inspect personal skills and global commands only inside isolated temporary roots.
        throw new Error(`Tests cannot access non-temporary install roots: ${root}`);
      }
    }
  },
};
