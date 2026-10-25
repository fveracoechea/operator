import { designs, type Execute } from "./model.mts";
// Bun has no directory creation API.
import { mkdir } from "node:fs/promises";

await mkdir("bundles", { recursive: true });
const bundles = [];
for (const design of designs) {
  const built = await Bun.build({
    entrypoints: [`${import.meta.dir}/${design}.mts`],
    target: "bun",
    format: "esm",
    minify: true,
  });
  if (!built.success || built.outputs.length !== 1) throw new Error(`Build failed: ${design}`);
  const output = built.outputs[0]!;
  const path = `${process.cwd()}/bundles/${design}.mjs`;
  await Bun.write(path, output);
  const { execute }: { execute: Execute } = await import(path);
  const result = await execute({
    invoke: () =>
      Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: '{"status":"applied","reference":"bundle-smoke"}',
      }),
    signal: new AbortController().signal,
    project: (receipt) => receipt,
  });
  if (!result.ok || result.value.reference !== "bundle-smoke")
    throw new Error(`Bundle execution failed: ${design}`);
  const bytes = new Uint8Array(await output.arrayBuffer());
  bundles.push({ design, bytes: bytes.length, gzipBytes: Bun.gzipSync(bytes).length });
}
console.log(JSON.stringify({ bun: Bun.version, bundles }));
