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

function guardTestRoots(roots: string[]) {
  const home = userInfo().homedir;
  const forbidden = [path.join(home, ".config/operator"), path.join(home, ".local/state/operator")];
  for (const root of roots) {
    const parts = path.resolve(root).split("/").filter(Boolean);
    let resolved = "/";
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
      projects: path.join(stateRoot, "projects"),
      config: path.join(configRoot, "config.json"),
      schema: path.join(configRoot, "config.schema.json"),
      configState: path.join(stateRoot, "config"),
      receipt: path.join(stateRoot, "config/apply.json"),
      receiptTemporary: path.join(stateRoot, "config/apply.json.tmp"),
      writeLock: path.join(stateRoot, "config/write.sqlite"),
      configTemporary: path.join(configRoot, "config.json.tmp"),
      skillHosts,
      ownedSkills: path.join(stateRoot, "owned-skills.json"),
      skillsLock: path.join(stateRoot, "owned-skills-lock.sqlite"),
    };
  },
  registrationDatabase(paths: { stateRoot: string }, nonce: string) {
    return path.join(paths.stateRoot, `.registration-${nonce}.sqlite`);
  },
  projectDirectory(paths: { projects: string }, repository: string) {
    return path.join(paths.projects, repository);
  },
  guardSkillTests(environment: ReturnType<typeof Environment.read>, roots: string[]) {
    if (environment.NODE_ENV !== "test") return;
    const temporary = realpathSync(tmpdir());
    for (const root of roots) {
      let resolved = root;
      while (!existsSync(resolved)) resolved = path.dirname(resolved);
      const real = realpathSync(resolved);
      if (real !== temporary && !real.startsWith(`${temporary}/`)) {
        // oxlint-disable-next-line unthrown/no-throw -- Tests may inspect personal skills only inside isolated temporary roots.
        throw new Error(`Tests cannot access non-temporary skill roots: ${root}`);
      }
    }
  },
};
