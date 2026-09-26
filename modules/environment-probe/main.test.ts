import { afterEach, describe, expect, test } from "bun:test";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { EnvironmentProbe } from "./main.ts";

const originalPath = process.env.PATH;
const binDirectories: string[] = [];

afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(
    binDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function usePath(executables: Record<string, string>): Promise<string> {
  const directory = `${Bun.env.TMPDIR ?? "/tmp"}/operator-probe-${crypto.randomUUID()}`;
  binDirectories.push(directory);
  for (const [name, script] of Object.entries(executables)) {
    await Bun.write(`${directory}/${name}`, `#!/bin/sh\n${script}\n`, { createPath: true });
    await Bun.$`chmod +x ${directory}/${name}`.quiet();
  }
  process.env.PATH = directory;
  return directory;
}

describe("Environment observation", () => {
  test("records the operating system it observed", async () => {
    await usePath({});

    const observed = await EnvironmentProbe.observe({ tools: [] });

    expect(observed.platform).toBe(process.platform);
    expect(["linux", "darwin"]).toContain(observed.platform);
  });

  test("reports an installed tool with its version and path", async () => {
    const directory = await usePath({ herdr: 'echo "herdr 0.12.3"' });

    const observed = await EnvironmentProbe.observe({ tools: ["herdr"] });

    expect(observed.tools).toEqual([
      {
        tool: "herdr",
        command: "herdr",
        state: "installed",
        version: "0.12.3",
        path: `${directory}/herdr`,
        detail: "herdr 0.12.3",
      },
    ]);
  });

  test("reports a tool that is not on the path as missing", async () => {
    await usePath({});

    const observed = await EnvironmentProbe.observe({ tools: ["git"] });

    expect(observed.tools[0]).toMatchObject({ tool: "git", state: "missing", version: null });
  });

  test("reports a tool that cannot answer as unreadable rather than installed", async () => {
    await usePath({ opencode: "echo boom >&2; exit 3" });

    const observed = await EnvironmentProbe.observe({ tools: ["opencode"] });

    expect(observed.tools[0]).toMatchObject({ tool: "opencode", state: "unreadable" });
    expect(observed.tools[0]?.version).toBe(null);
  });

  test("uses the executable each supported host installs", async () => {
    const directory = await usePath({ claude: 'echo "2.0.1 (Claude Code)"' });

    const observed = await EnvironmentProbe.observe({ tools: ["claude-code"] });

    expect(observed.tools[0]).toEqual({
      tool: "claude-code",
      command: "claude",
      state: "installed",
      version: "2.0.1",
      path: `${directory}/claude`,
      detail: "2.0.1 (Claude Code)",
    });
  });

  test("observes the running Bun without searching the path for it", async () => {
    await usePath({});

    const observed = await EnvironmentProbe.observe({ tools: ["bun"] });

    expect(observed.tools[0]).toMatchObject({
      tool: "bun",
      state: "installed",
      version: Bun.version,
    });
  });
});
