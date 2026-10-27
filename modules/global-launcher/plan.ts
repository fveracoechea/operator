/** The name Bun installs the alias under, so the global package folder never changes on update. */
export const PACKAGE_ALIAS = "@fveracoechea/operator";
/** The name the JSR npm registry serves the release under. */
export const REGISTRY_PACKAGE = "@jsr/fveracoechea__operator";

export type Destination = { kind: "absent" } | { kind: "file"; text: string } | { kind: "other" };

export type LauncherFacts = {
  /** The real path of the running package. */
  packageRoot: string;
  version: string;
  /** Only a built release carries the cli.js that the launcher runs. */
  built: boolean;
  /** Bun's global install folder as Bun reports it, and its real path. */
  globalRoot: { reported: string; real: string } | null;
  /** The dependency specifier in Bun's global manifest for the alias. */
  specifier: string | null;
  command: string;
  destination: Destination;
};

export type LauncherDecision =
  | { action: "write" | "unchanged"; command: string; text: string; runs: string }
  | {
      action: "refuse";
      reason: "launcher_unsupported" | "launcher_version_unpinned" | "launcher_conflict";
      detail: string;
    };

/** The supported install command for one exact release. */
export function exactInstall(version: string): string {
  return `bun add -g "${PACKAGE_ALIAS}@npm:${REGISTRY_PACKAGE}@${version}"`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The launcher names Bun's stable global package folder and no version, so a Bun update of the
 * global package changes what runs while the launcher and every hook that calls it stay valid.
 */
export function launcherText(globalRoot: string): string {
  return `#!/bin/sh
# Operator launcher written by operator install launcher.
# It runs the global JSR package in place, so it names no release and survives updates.
exec bun ${shellQuote(`${globalRoot}/node_modules/${PACKAGE_ALIAS}/cli.js`)} "$@"
`;
}

/** Decides one launcher installation from facts that the caller gathered first. */
export function decideLauncher(facts: LauncherFacts): LauncherDecision {
  const install = exactInstall(facts.version);
  if (!facts.built)
    return {
      action: "refuse",
      reason: "launcher_unsupported",
      detail: `The running Operator at ${facts.packageRoot} is not a built release. A source installation from bun add -g at a full commit gets its operator command from Bun.`,
    };
  const expected =
    facts.globalRoot === null ? null : `${facts.globalRoot.real}/node_modules/${PACKAGE_ALIAS}`;
  if (facts.globalRoot === null || facts.packageRoot !== expected)
    return {
      action: "refuse",
      reason: "launcher_unsupported",
      detail: `The running Operator at ${facts.packageRoot} is not Bun's global package${expected === null ? "" : ` at ${expected}`}. Run ${install}, then run this command from that package.`,
    };
  if (facts.specifier !== `npm:${REGISTRY_PACKAGE}@${facts.version}`)
    return {
      action: "refuse",
      reason: "launcher_version_unpinned",
      detail: `Bun's global manifest names ${facts.specifier ?? "no specifier"} for ${PACKAGE_ALIAS}, not the exact running version. Run ${install}.`,
    };
  const text = launcherText(facts.globalRoot.reported);
  const runs = `${facts.globalRoot.reported}/node_modules/${PACKAGE_ALIAS}/cli.js`;
  if (facts.destination.kind === "absent")
    return { action: "write", command: facts.command, text, runs };
  if (facts.destination.kind === "file" && facts.destination.text === text)
    return { action: "unchanged", command: facts.command, text, runs };
  return {
    action: "refuse",
    reason: "launcher_conflict",
    detail: `${facts.command} already exists with other content. It was not changed. Remove it yourself if it is not needed, then install the launcher again.`,
  };
}

/** The package path a launcher runs, read only from the exact text this module writes. */
export function launcherTarget(text: string): string | null {
  const quoted = /^exec bun '((?:[^']|'\\'')*)' "\$@"$/m.exec(text)?.[1];
  if (quoted === undefined) return null;
  const target = quoted.replaceAll(`'\\''`, "'");
  const suffix = `/node_modules/${PACKAGE_ALIAS}/cli.js`;
  if (!target.endsWith(suffix)) return null;
  return launcherText(target.slice(0, -suffix.length)) === text ? target : null;
}

/**
 * An installation is pinned when Bun's manifest names the exact running JSR version or a full
 * source commit, so a later Bun update cannot move the device release.
 */
export function pinnedSpecifier(specifier: string, version: string): boolean {
  if (specifier.startsWith("npm:")) return specifier === `npm:${REGISTRY_PACKAGE}@${version}`;
  return /#[0-9a-f]{40}$/.test(specifier) && /^(git\+|git:|github:)/.test(specifier);
}
