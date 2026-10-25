import { prepare } from "./prepare.ts";

export async function verify() {
  const root = await prepare();
  const results = [];
  for (const args of [
    ["node_modules/typescript/bin/tsc", "--noEmit", "-p", "tsconfig.json"],
    [
      "node_modules/typescript/bin/tsc",
      "--noEmit",
      "false",
      "--declaration",
      "--emitDeclarationOnly",
      "--outDir",
      "declarations",
      "-p",
      "tsconfig.json",
    ],
    [
      "test",
      "--isolate",
      "--timeout=30000",
      "./results/operations.test.ts",
      "./results/store.test.ts",
      "./results/cases.test.ts",
      "./results/unthrown.test.ts",
      "./results/drizzle.test.mjs",
    ],
    ["results/compatibility.mts"],
    ["results/lint-proof.mts"],
    ["results/unthrown-lint.mts"],
  ]) {
    const child = Bun.spawn([process.execPath, ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`${args.join(" ")} exited ${code}\n${stdout}\n${stderr}`);
    results.push({ args, stdout, stderr });
  }
  return { root, results };
}
if (import.meta.main) console.log(JSON.stringify(await verify(), null, 2));
