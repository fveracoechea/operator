export type TrackedPaths =
  | { state: "checked"; paths: string[] }
  | { state: "unavailable"; detail: string };

/** Reads which .operator paths Git already tracks. Setup never writes to the Git index. */
export async function trackedOperatorPaths(projectRoot: string): Promise<TrackedPaths> {
  let child: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    child = Bun.spawn(["git", "ls-files", "-z", "--", ".operator"], {
      cwd: projectRoot,
      stderr: "ignore",
      stdout: "pipe",
    });
  } catch (error) {
    return { state: "unavailable", detail: String(error) };
  }

  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (exitCode !== 0) {
    // The project is not a Git repository, so it has no index and tracks nothing.
    return { state: "checked", paths: [] };
  }

  return { state: "checked", paths: stdout.split("\0").filter(Boolean).toSorted() };
}
