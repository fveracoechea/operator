import { z } from "zod";
import { Environment } from "../modules/environment/main.ts";

// Live contracts run the installed Herdr, OpenCode, and Claude Code. Bun discovers only
// `*.test.ts`, so `bun run test` never finds a `*.contract.ts` file, and readiness never runs one
// (ADR-0009). This runner records the versions each run met, so a vendor change that breaks a
// contract fails a named test beside the version that broke it.
const root = process.cwd();
const recordPath = `${root}/docs/live-contracts.json`;
const sdk = "@anthropic-ai/claude-agent-sdk";

function version(tool: string) {
  const path = Bun.which(tool, { PATH: Environment.read().PATH });
  if (path === null) return null;
  const result = Bun.spawnSync([path, "--version"], { env: Environment.child(), stderr: "ignore" });
  return result.exitCode === 0 ? (result.stdout.toString().trim().split("\n")[0] ?? null) : null;
}

const files = (
  await Array.fromAsync(new Bun.Glob("modules/**/*.contract.ts").scan({ cwd: root }))
).toSorted();
if (files.length === 0) {
  console.error("live-contracts: no modules/**/*.contract.ts file to run.");
  process.exit(2);
}
const manifest = z
  .object({ dependencies: z.record(z.string(), z.string()) })
  .parse(await Bun.file(new URL("../package.json", import.meta.url)).json());
const versions = {
  bun: Bun.version,
  herdr: version("herdr"),
  opencode: version("opencode"),
  claude: version("claude"),
  [sdk]: manifest.dependencies[sdk] ?? null,
};
console.error(`live-contracts: running against ${JSON.stringify(versions)}`);

const child = Bun.spawn(
  [process.execPath, "test", "--timeout=60000", ...files.map((file) => `./${file}`)],
  { cwd: root, env: Environment.child(), stdio: ["ignore", "inherit", "inherit"] },
);
const code = await child.exited;
if (code !== 0) {
  console.error(`live-contracts: a contract failed against ${JSON.stringify(versions)}.`);
  process.exit(code);
}
await Bun.write(
  recordPath,
  `${JSON.stringify({ verifiedOn: new Date().toISOString().slice(0, 10), versions, files }, null, 2)}\n`,
);
console.error(`live-contracts: every contract passed. Recorded the versions in ${recordPath}.`);
