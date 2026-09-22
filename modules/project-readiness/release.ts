import { OperatorRelease } from "../operator-release/main.ts";

export type Release = Awaited<ReturnType<typeof OperatorRelease.identify>>;

/** Identifies the running release by its version, the skills it installs, and its lock data. */
export async function identifyRelease(): Promise<Release> {
  return OperatorRelease.identify();
}
