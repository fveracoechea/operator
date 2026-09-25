/**
 * The fake `jsr` command. It records what it was asked to publish and from where, then answers
 * the way the test chose, through the state the fake registry reads its versions from.
 */
import type { JsrClientCall, JsrFakeState } from "./fake-jsr.ts";

const directory = Bun.env.FAKE_JSR_DIR;
if (directory === undefined) {
  console.error("fake jsr: FAKE_JSR_DIR is not set");
  process.exit(2);
}

const statePath = `${directory}/state.json`;
const state: JsrFakeState = await Bun.file(statePath).json();
const cwd = process.cwd();
const all = await Array.fromAsync(
  new Bun.Glob("**/*").scan({ cwd, dot: true, onlyFiles: true, followSymlinks: false }),
);
const version: string = (await Bun.file(`${cwd}/jsr.json`).json()).version;

const call: JsrClientCall = {
  args: Bun.argv.slice(2),
  cwd,
  version,
  files: all.filter((path) => !path.startsWith("node_modules/")).toSorted(),
  installed: (
    await Array.fromAsync(new Bun.Glob("node_modules/*/package.json").scan({ cwd, dot: true }))
  )
    .map((path) => path.split("/")[1] ?? "")
    .toSorted(),
};
const calls = Bun.file(`${directory}/calls.jsonl`);
await Bun.write(calls, `${await calls.text()}${JSON.stringify(call)}\n`);

if (state.client === "refuses") {
  console.error("error: the registry refused this version");
  process.exit(1);
}

await Bun.write(
  statePath,
  `${JSON.stringify({ ...state, published: [...state.published, version] })}\n`,
);

if (state.client === "publishes-then-fails") {
  console.error("error: the connection closed while the version was processed");
  process.exit(1);
}

console.log(`Successfully published @fveracoechea/operator@${version}`);
