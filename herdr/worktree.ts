/**
 * Installs the dependencies of a new Herdr worktree, so an agent that starts in it can run the
 * project's own tools. A fresh checkout has no node_modules, and an agent hook that runs a
 * package bin fails on every tool call until one exists.
 * The lockfile names the package manager. A frozen install never rewrites the lockfile, because a
 * dirty checkout is one Herdr refuses to remove.
 */
const INSTALLS = [
  { lockfiles: ["bun.lock", "bun.lockb"], command: ["bun", "install", "--frozen-lockfile"] },
  { lockfiles: ["package-lock.json", "npm-shrinkwrap.json"], command: ["npm", "ci"] },
];

function worktreePath(event: unknown): string | null {
  const data = event !== null && typeof event === "object" && "data" in event ? event.data : null;
  const worktree =
    data !== null && typeof data === "object" && "worktree" in data ? data.worktree : null;
  return worktree !== null &&
    typeof worktree === "object" &&
    "path" in worktree &&
    typeof worktree.path === "string"
    ? worktree.path
    : null;
}

const path = worktreePath(JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON ?? "null"));
if (path === null) throw new Error("Herdr did not describe the created worktree");

const locked = await Promise.all(
  INSTALLS.map(async (one) =>
    (await Promise.all(one.lockfiles.map((name) => Bun.file(`${path}/${name}`).exists()))).includes(
      true,
    ),
  ),
);
const install = INSTALLS[locked.indexOf(true)];

if (install === undefined) {
  console.log(`No lockfile in ${path}. Skipped the dependency install.`);
} else {
  const child = Bun.spawn(install.command, {
    cwd: path,
    env: process.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exit = await child.exited;
  if (exit === 0) {
    console.log(`Installed dependencies in ${path} with ${install.command[0]}.`);
  } else {
    console.error(`${install.command.join(" ")} exited ${exit} in ${path}.`);
    process.exitCode = exit;
  }
}

export {};
