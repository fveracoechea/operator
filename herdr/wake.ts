type Runner = { root: string; binary: string };

function isRunner(value: unknown): value is Runner {
  return (
    value !== null &&
    typeof value === "object" &&
    "root" in value &&
    typeof value.root === "string" &&
    "binary" in value &&
    typeof value.binary === "string"
  );
}

const dir = process.env.HERDR_PLUGIN_CONFIG_DIR;
if (!dir) throw new Error("Herdr did not provide the Operator wake config directory");
if (process.argv[2] !== "event" && process.argv[2] !== "startup") {
  throw new Error("Expected a Herdr event or startup hook");
}
for await (const path of new Bun.Glob("runners/*.json").scan({ cwd: dir })) {
  const record: unknown = await Bun.file(`${dir}/${path}`).json();
  if (!isRunner(record)) throw new Error(`Operator wake runner is unreadable: ${path}`);
  const runner = record;
  const event = process.argv[2] === "event" ? ["--event"] : [];
  const child = Bun.spawn(
    ["bun", runner.binary, "wake", "check", "--root", runner.root, ...event, "--json"],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) {
    console.error(`${runner.root}: ${stderr.trim() || stdout.trim()}`);
    process.exitCode = 1;
    continue;
  }
  const result: unknown = JSON.parse(stdout);
  if (
    result !== null &&
    typeof result === "object" &&
    "data" in result &&
    result.data !== null &&
    typeof result.data === "object" &&
    "message" in result.data &&
    result.data.message === "Woke Operator."
  ) {
    console.log(`Woke Operator for ${runner.root}.`);
  }
}

export {};
