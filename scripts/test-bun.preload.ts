/*
 * Preloaded into every test file by `bunfig.toml`.
 * The tests spawn the real CLI, the fakes, and the gate runner as `bun` from PATH, thousands of
 * times. A version manager such as Volta puts a shim there that starts a second process to pick
 * the Bun binary, and that doubles the cost of each spawn. This puts the Bun that runs the tests
 * first on PATH, so every child runs the same Bun without the shim. Where `bun` on PATH is
 * already this Bun, as on CI, nothing changes.
 */
// Bun has no synchronous directory, symlink, or real-path API.
import { mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";

const onPath = Bun.which("bun");

if (onPath !== null && realpathSync(onPath) !== realpathSync(process.execPath)) {
  const directory = `${Bun.env.TMPDIR ?? "/tmp"}/operator-bun-${crypto.randomUUID()}`;
  mkdirSync(directory, { recursive: true });
  symlinkSync(process.execPath, `${directory}/bun`);
  process.env.PATH = `${directory}:${process.env.PATH ?? ""}`;
  process.on("exit", () => rmSync(directory, { force: true, recursive: true }));
}
