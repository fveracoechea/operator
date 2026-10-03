import { z } from "zod";
import {
  declaresRelease,
  INSTALL_ROOT,
  PACKAGE_NAME,
  PROJECT_COMMAND,
  PROJECT_SCRIPT,
  SELECTION_PATH,
  type ReleaseSelection,
  readSelection,
  releaseSpecifier,
} from "./selection.ts";

export type InstallationReason =
  | "release_unselected"
  | "unreadable_selection"
  | "install_missing"
  | "lock_data_missing"
  | "release_mismatch";

export type Installation =
  | { status: "installed"; selection: ReleaseSelection; detail: string }
  | {
      status: "unmet";
      reason: InstallationReason;
      selection: ReleaseSelection | null;
      detail: string;
      nextAction: string;
      paths: string[];
    };

// Bun writes a text lock by default and a binary lock on request, so both count as lock data.
const LOCK_NAMES = ["bun.lock", "bun.lockb"];

/** What the running release must match for a recorded selection to still stand. */
export type RunningRelease = {
  version: string;
  identity: string;
  commit?: string | null;
  lock: { state: "present" | "missing" };
};

const SELECT_ACTION = "Run `bun run operator update plan`, then apply the approved update.";

function unmet(
  reason: InstallationReason,
  selection: ReleaseSelection | null,
  detail: string,
  nextAction: string,
  paths: string[] = [],
): Installation {
  return { status: "unmet", reason, selection, detail, nextAction, paths };
}

/** The version the project installed, read from the manifest JSR generated. */
async function readInstalledVersion(
  path: string,
): Promise<{ state: "absent" } | { state: "present"; version: string | null }> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return { state: "absent" };
  }

  const parsed = z
    .object({ version: z.string().min(1).optional() })
    .safeParse(await file.json().catch(() => null));
  return { state: "present", version: parsed.success ? (parsed.data.version ?? null) : null };
}

async function hasLockData(projectRoot: string): Promise<boolean> {
  for (const name of LOCK_NAMES) {
    if (await Bun.file(`${projectRoot}/${name}`).exists()) {
      return true;
    }
  }

  return false;
}

// The project check reads every script as text and needs devDependencies, unlike the worktree check.
const projectManifestSchema = z.object({
  devDependencies: z.record(z.string(), z.string()),
  scripts: z.record(z.string(), z.string()),
});

/**
 * The verdict on a JSR selection: the project declares it, holds that exact version installed,
 * and keeps lock data. Returns null when all three hold.
 */
async function checkJsrInstall(
  projectRoot: string,
  selection: ReleaseSelection,
): Promise<Installation | null> {
  const wanted = selection.packageVersion ?? selection.version;
  const manifest = `node_modules/${PACKAGE_NAME}/package.json`;
  const project = projectManifestSchema.safeParse(
    await Bun.file(`${projectRoot}/package.json`)
      .json()
      .catch(() => null),
  );
  if (!project.success || !declaresRelease(project.data, wanted)) {
    return unmet(
      "install_missing",
      selection,
      `The project must declare ${PACKAGE_NAME} as the exact JSR devDependency ${releaseSpecifier(wanted)} and set scripts.operator to ${PROJECT_SCRIPT}.`,
      `Add the selected JSR devDependency and Operator script to package.json, then run \`bun install --frozen-lockfile\` from the project root.`,
      ["package.json"],
    );
  }
  const installed = await readInstalledVersion(`${projectRoot}/${manifest}`);
  if (installed.state === "absent") {
    return unmet(
      "install_missing",
      selection,
      `The project holds no installed ${PACKAGE_NAME}, so the selected release is not present.`,
      "Run `bun install --frozen-lockfile` from the project root, then check again.",
      [manifest],
    );
  }
  // The selection names one exact published version, so any other one is a different release.
  if (installed.version !== wanted) {
    return unmet(
      "release_mismatch",
      selection,
      `This project selected ${PACKAGE_NAME}@${wanted}, and the installation holds ${installed.version ?? "a package that names no version"}.`,
      `Install ${PACKAGE_NAME}@${wanted} from JSR in the project root, then check again.`,
      [manifest],
    );
  }

  if (!(await hasLockData(projectRoot))) {
    return unmet(
      "lock_data_missing",
      selection,
      "The project holds no lock data, so a reinstall would resolve its dependencies again instead of repeating them.",
      "Restore the project bun.lock, then run `bun install --frozen-lockfile` from the project root.",
      ["bun.lock"],
    );
  }
  return null;
}

/**
 * Reports whether the recorded release selection is the one actually installed and running.
 * A missing or mismatched devDependency, and missing lock data, stop coordinated work.
 */
export async function inspectInstallation(request: {
  projectRoot: string;
  running: RunningRelease;
}): Promise<Installation> {
  const read = await readSelection(request.projectRoot);
  if (read.state === "missing") {
    return unmet(
      "release_unselected",
      null,
      "This project has selected no exact Operator release, so coordinated work has no recorded identity to run against.",
      SELECT_ACTION,
    );
  }
  if (read.state === "unreadable") {
    return unmet(
      "unreadable_selection",
      null,
      `The recorded release selection cannot be read: ${read.detail}`,
      "Decide what the recorded selection should be, then check again.",
      [`${INSTALL_ROOT}/selection.json`],
    );
  }

  const selection = read.selection;

  // Compare the selected code and skills before inspecting tools or planning a live probe.
  if (
    request.running.identity !== selection.releaseIdentity ||
    (request.running.commit !== null &&
      request.running.commit !== undefined &&
      request.running.commit !== selection.commit)
  ) {
    return unmet(
      "release_mismatch",
      selection,
      `This project selected Operator ${selection.version} at ${selection.commit}, but the running release is ${request.running.version}.`,
      selection.delivery === "jsr"
        ? `Run the selected release with \`${PROJECT_COMMAND} <operation>\` from the project root.`
        : `Run the selected source release at commit ${selection.commit}.`,
      [SELECTION_PATH],
    );
  }

  if (selection.delivery === "jsr") {
    const refusal = await checkJsrInstall(request.projectRoot, selection);
    if (refusal !== null) return refusal;
  }

  if (request.running.lock.state === "missing") {
    return unmet(
      "lock_data_missing",
      selection,
      "The running Operator installation holds no lock data, so its dependencies are not frozen.",
      "Reinstall Operator so the installation keeps its own lock data.",
    );
  }

  return {
    status: "installed",
    selection,
    detail: `Operator ${selection.version} from ${selection.delivery} at commit ${selection.commit} is selected and running.`,
  };
}
