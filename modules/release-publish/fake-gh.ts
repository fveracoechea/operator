/**
 * A stand-in for the `gh` CLI, answering only the endpoints a release reads and writes.
 * It answers in the shape `gh api --include` produces, so the publication reaches it through
 * the real external interface instead of a module replaced by path.
 *
 * Its state lives in `$RELEASE_GH_DIR/state.json` and the faults it injects in `faults.json`.
 */

import type { ReleaseFakeFault, ReleaseFakeState } from "./fake-publish-state.ts";

const directory = process.env.RELEASE_GH_DIR ?? "";
const statePath = `${directory}/state.json`;
const faultsPath = `${directory}/faults.json`;

async function readState(): Promise<ReleaseFakeState> {
  const file = Bun.file(statePath);
  return (await file.exists())
    ? ((await file.json()) as ReleaseFakeState)
    : { compare: {}, checkRuns: {}, tags: {}, releases: {} };
}

async function writeState(state: ReleaseFakeState): Promise<void> {
  await Bun.write(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function takeFault(name: string): Promise<string | null> {
  const file = Bun.file(faultsPath);
  if (!(await file.exists())) {
    return null;
  }

  const faults: Record<string, ReleaseFakeFault | undefined> = await file.json();
  const fault = faults[name];
  if (fault === undefined || fault.remaining <= 0) {
    return null;
  }

  fault.remaining -= 1;
  await Bun.write(faultsPath, `${JSON.stringify(faults, null, 2)}\n`);
  return fault.kind;
}

function answer(status: number, body: unknown): void {
  process.stdout.write(
    [
      `HTTP/2.0 ${status} ${status < 300 ? "OK" : "Error"}`,
      "content-type: application/json; charset=utf-8",
      "",
      body === null ? "" : JSON.stringify(body),
    ].join("\r\n"),
  );
}

async function readInput(args: string[]): Promise<unknown> {
  return args.includes("--input") ? JSON.parse(await Bun.stdin.text()) : null;
}

const args = Bun.argv.slice(2);
const log = Bun.file(`${directory}/calls.log`);
const before = (await log.exists()) ? await log.text() : "";
await Bun.write(log, `${before}${args.join(" ")}\n`, { createPath: true });

const [command, , endpoint] = args;
if (command !== "api" || endpoint === undefined) {
  process.stderr.write("the release fake answers only `gh api`\n");
  process.exit(2);
}

const state = await readState();

const compare = /^repos\/[^/]+\/[^/]+\/compare\/([^.]+)\.\.\.(.+)$/.exec(endpoint);
if (compare?.[2] !== undefined) {
  answer(200, { status: state.compare[compare[2]] ?? "diverged" });
  process.exit(0);
}

const checks = /^repos\/[^/]+\/[^/]+\/commits\/([^/]+)\/check-runs$/.exec(endpoint);
if (checks?.[1] !== undefined) {
  const runs = state.checkRuns[checks[1]] ?? [];
  answer(200, { total_count: runs.length, check_runs: runs });
  process.exit(0);
}

const tagRef = /^repos\/[^/]+\/[^/]+\/git\/ref\/tags\/(.+)$/.exec(endpoint);
if (tagRef?.[1] !== undefined) {
  const sha = state.tags[tagRef[1]];
  if (sha === undefined) {
    answer(404, { message: "Not Found" });
  } else {
    answer(200, { ref: `refs/tags/${tagRef[1]}`, object: { sha, type: "commit" } });
  }
  process.exit(0);
}

const releaseByTag = /^repos\/[^/]+\/[^/]+\/releases\/tags\/(.+)$/.exec(endpoint);
if (releaseByTag?.[1] !== undefined) {
  const url = state.releases[releaseByTag[1]];
  if (url === undefined) {
    answer(404, { message: "Not Found" });
  } else {
    answer(200, { html_url: url, tag_name: releaseByTag[1] });
  }
  process.exit(0);
}

if (/^repos\/[^/]+\/[^/]+\/git\/refs$/.test(endpoint)) {
  const fault = await takeFault("create_tag");
  const body = await readInput(args);
  const ref = String((body as { ref: string }).ref);
  const sha = String((body as { sha: string }).sha);
  const tag = ref.replace("refs/tags/", "");
  if (fault === "server_error") {
    answer(500, { message: "the tag may or may not exist" });
    process.exit(0);
  }
  if (state.tags[tag] !== undefined) {
    answer(422, { message: "Reference already exists" });
    process.exit(0);
  }

  state.tags[tag] = sha;
  await writeState(state);
  answer(201, { ref, object: { sha } });
  process.exit(0);
}

if (/^repos\/[^/]+\/[^/]+\/releases$/.test(endpoint)) {
  const fault = await takeFault("create_release");
  const body = (await readInput(args)) as { tag_name: string };
  if (fault === "server_error") {
    answer(500, { message: "the release may or may not exist" });
    process.exit(0);
  }

  const url = `https://github.test/releases/${body.tag_name}`;
  state.releases[body.tag_name] = url;
  await writeState(state);
  answer(201, { html_url: url, tag_name: body.tag_name });
  process.exit(0);
}

answer(404, { message: `the release fake does not answer ${endpoint}` });
