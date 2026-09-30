/**
 * Installs the dependencies of a new Herdr worktree, so an agent that starts in it can run the
 * project's own tools. A fresh checkout has no node_modules, and an agent hook that runs a
 * package bin fails on every tool call until one exists.
 * The lockfile names the package manager, and bun wins when both are present. A frozen install
 * never rewrites the lockfile, because a dirty checkout is one Herdr refuses to remove.
 */
const INSTALLS = [
  {
    lockfiles: ["bun.lock", "bun.lockb"],
    // The Bun that runs this hook, so the install never depends on PATH.
    bin: process.execPath,
    command: ["bun", "install", "--frozen-lockfile"],
  },
  { lockfiles: ["package-lock.json", "npm-shrinkwrap.json"], bin: "npm", command: ["npm", "ci"] },
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
  const command = install.command.join(" ");
  console.log(`Running \`${command}\` in ${path}.`);
  let exit: number;
  try {
    exit = await Bun.spawn([install.bin, ...install.command.slice(1)], {
      cwd: path,
      env: process.env,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    }).exited;
  } catch (error) {
    console.error(`Could not run ${command} in ${path}: ${String(error)}`);
    exit = 1;
  }
  if (exit === 0) {
    console.log(`Installed dependencies in ${path}.`);
  } else {
    console.error(`${command} exited ${exit} in ${path}.`);
    process.exitCode = exit;
  }
}

export {};
