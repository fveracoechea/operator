import { INSTALL_ROOT, PACKAGE_NAME, type ReleaseSelection, readSelection } from "./selection.ts";

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
  lock: { state: "present" | "missing" };
};

const SELECT_ACTION = "Run `operator update plan`, then apply the approved update.";

function unmet(
  reason: InstallationReason,
  selection: ReleaseSelection | null,
  detail: string,
  nextAction: string,
  paths: string[] = [],
): Installation {
  return { status: "unmet", reason, selection, detail, nextAction, paths };
}

async function hasLockData(projectRoot: string): Promise<boolean> {
  for (const name of LOCK_NAMES) {
    if (await Bun.file(`${projectRoot}/${INSTALL_ROOT}/${name}`).exists()) {
      return true;
    }
  }

  return false;
}

/**
 * Reports whether the recorded release selection is the one actually installed and running.
 * A missing or mismatched installation, and missing lock data, stop the work that depends on
 * them. Operator never adopts a nearby dependency and never resolves a replacement of its own.
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

  if (selection.delivery === "jsr") {
    const installed = await Bun.file(
      `${request.projectRoot}/${INSTALL_ROOT}/node_modules/${PACKAGE_NAME}/package.json`,
    ).exists();
    if (!installed) {
      return unmet(
        "install_missing",
        selection,
        `The isolated installation holds no ${PACKAGE_NAME}, so the selected release is not present.`,
        `Install ${PACKAGE_NAME}@${selection.packageVersion ?? selection.version} in ${INSTALL_ROOT} yourself, then check again.`,
        [INSTALL_ROOT],
      );
    }

    if (!(await hasLockData(request.projectRoot))) {
      return unmet(
        "lock_data_missing",
        selection,
        "The isolated installation holds no lock data, so a reinstall would resolve its dependencies again instead of repeating them.",
        `Restore the lock data in ${INSTALL_ROOT}, then reinstall with \`bun install --frozen-lockfile\` there.`,
        [INSTALL_ROOT],
      );
    }
  }

  if (request.running.lock.state === "missing") {
    return unmet(
      "lock_data_missing",
      selection,
      "The running Operator installation holds no lock data, so its dependencies are not frozen.",
      "Reinstall Operator so the installation keeps its own lock data.",
    );
  }

  if (request.running.identity !== selection.releaseIdentity) {
    return unmet(
      "release_mismatch",
      selection,
      `This project selected Operator ${selection.version}, and the running release is ${request.running.version}.`,
      SELECT_ACTION,
    );
  }

  return {
    status: "installed",
    selection,
    detail: `Operator ${selection.version} from ${selection.delivery} at commit ${selection.commit} is selected and running.`,
  };
}
