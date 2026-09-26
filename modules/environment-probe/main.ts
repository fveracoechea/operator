import { type ToolName, readVersion, toolCommands } from "./tools.ts";

type Observation = {
  tool: ToolName;
  command: string;
  state: "installed" | "missing" | "unreadable";
  version: string | null;
  path: string | null;
  detail: string;
};

// Bun.which caches the startup path, so the current PATH is read on every lookup.
function whichNow(command: string): string | null {
  return Bun.which(command, { PATH: process.env.PATH ?? "" });
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}

async function observeTool(tool: ToolName): Promise<Observation> {
  const command = toolCommands[tool];

  // Operator runs on Bun, so the running runtime answers for itself instead of through the path.
  if (tool === "bun") {
    return {
      tool,
      command,
      state: "installed",
      version: Bun.version,
      path: whichNow(command),
      detail: Bun.version,
    };
  }

  const path = whichNow(command);
  if (path === null) {
    return {
      tool,
      command,
      state: "missing",
      version: null,
      path: null,
      detail: `${command} is not on the path.`,
    };
  }

  const child = Bun.spawn([path, "--version"], { stderr: "pipe", stdout: "pipe" });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);

  if (exitCode !== 0) {
    return {
      tool,
      command,
      state: "unreadable",
      version: null,
      path,
      detail: `${command} --version exited ${exitCode}: ${firstLine(stderr) || firstLine(stdout)}`,
    };
  }

  const detail = firstLine(stdout);
  const version = readVersion(detail);
  if (version === null) {
    return {
      tool,
      command,
      state: "unreadable",
      version: null,
      path,
      detail: `${command} --version reported no version: ${detail}`,
    };
  }

  return { tool, command, state: "installed", version, path, detail };
}

export const EnvironmentProbe = {
  /** Observes the tools Operator runs. It reads versions and installs nothing. */
  async observe(request: { tools: ToolName[] }) {
    return {
      platform: process.platform,
      architecture: process.arch,
      tools: await Promise.all(request.tools.map(observeTool)),
    };
  },
};
