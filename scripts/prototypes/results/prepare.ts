// Bun has no recursive copy or temporary directory API.
import { cp, mkdtemp } from "node:fs/promises";

export async function prepare(): Promise<string> {
  const root = await mkdtemp("/tmp/opencode/operator-261-comparison-");
  await cp(import.meta.dir, `${root}/results`, { recursive: true });
  await cp(`${import.meta.dir}/../state-machines`, `${root}/state-machines`, { recursive: true });
  await Bun.write(`${root}/package.json`, Bun.file(`${import.meta.dir}/package.json`));
  if (await Bun.file(`${import.meta.dir}/bun.lock`).exists()) {
    await Bun.write(`${root}/bun.lock`, Bun.file(`${import.meta.dir}/bun.lock`));
  }
  const install = Bun.spawnSync(
    [process.execPath, "install", "--ignore-scripts", "--frozen-lockfile"],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (install.exitCode !== 0) throw new Error(install.stderr.toString());
  await Bun.write(`${root}/results/cases.test.ts`, Bun.file(`${root}/results/cli.cases.mts`));
  await Bun.write(
    `${root}/results/operations.test.ts`,
    Bun.file(`${root}/results/operations.cases.mts`),
  );
  await Bun.write(`${root}/results/store.test.ts`, Bun.file(`${root}/results/store.cases.mts`));
  await Bun.write(
    `${root}/tsconfig.json`,
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noUncheckedIndexedAccess: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        module: "ESNext",
        moduleResolution: "Bundler",
        target: "ESNext",
        types: ["bun"],
        allowImportingTsExtensions: true,
        noEmit: true,
        skipLibCheck: false,
      },
      include: ["results/*.mts", "results/*/*.mts"],
    }),
  );
  return root;
}

if (import.meta.main) console.log(await prepare());
