import { afterAll, afterEach, describe, expect, expectTypeOf, spyOn, test } from "bun:test";
// Bun has no temporary-directory, chmod, or recursive removal API.
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ErrAsync, fromPromise, Ok, OkAsync } from "unthrown";
import { ClaudeHook } from "../claude-hook/main.ts";
import { DeviceSettings } from "../device-settings/main.ts";
import { Environment } from "../environment/main.ts";
import { GlobalLauncher } from "../global-launcher/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { OwnedSkills } from "../owned-skills/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { UpstreamSkills } from "../upstream-skills/main.ts";
import { Readiness } from "./main.ts";

const root = await mkdtemp(path.join(tmpdir(), "readiness-api-"));
const tools = spyOn(ToolInvocation, "run").mockResolvedValue({
  status: "completed",
  exitCode: 0,
  stdout: "",
  stderr: "",
});
afterAll(async () => {
  tools.mockRestore();
  await rm(root, { recursive: true, force: true });
});
const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));

test("the public failure reasons form a closed union", () => {
  type Failure = Extract<Awaited<ReturnType<typeof Readiness.check>>, { tag: "Err" }>["error"];
  expectTypeOf<Failure["reason"]>().not.toEqualTypeOf<string>();
});

test("settings failures remain static blockers without repairing the document", async () => {
  await Bun.write(paths.config, "{broken", { createPath: true });
  const result = await Readiness.check(paths);
  expect(result.tag).toBe("Ok");
  if (result.tag === "Ok")
    expect(result.value.blockers.map((blocker) => blocker.reason)).toContain("invalid_settings");
  expect(await Bun.file(paths.config).text()).toBe("{broken");
});
test("a settings defect does not become a readiness claim", async () => {
  const spy = spyOn(DeviceSettings, "show").mockImplementation(() =>
    fromPromise(
      async () => {
        // oxlint-disable-next-line unthrown/no-throw -- Inject a defect at the settings interface.
        throw new TypeError("defect");
      },
      (cause, defect) => defect(cause),
    ),
  );
  try {
    expect(await Readiness.check(paths)).toMatchObject({ tag: "Defect" });
  } finally {
    spy.mockRestore();
  }
});

const ambient = Environment.read();
const restorable: { mockRestore(): void }[] = [];
function stub<T extends object, K extends keyof T>(object: T, key: K) {
  const spy = spyOn(object, key);
  restorable.push(spy);
  return spy;
}
let scenarios = 0;
async function scenario(input: { host?: string; tools: string[] }) {
  scenarios += 1;
  tools.mockClear();
  const home = `${root}/scenario-${scenarios}`;
  const device = OperatorHome.resolve(Environment.parse({ HOME: home, NODE_ENV: "test" }));
  const config = input.host === undefined ? {} : { superAgent: { host: input.host } };
  await Bun.write(device.config, JSON.stringify(config), { createPath: true });
  for (const tool of input.tools) {
    await Bun.write(`${home}/bin/${tool}`, "#!/bin/sh\nexit 0\n", { createPath: true });
    await chmod(`${home}/bin/${tool}`, 0o755);
  }
  stub(Environment, "read").mockReturnValue({ ...ambient, PATH: `${home}/bin` });
  return device;
}

const injected = new TypeError("defect");
function defect() {
  return fromPromise(
    async () => {
      // oxlint-disable-next-line unthrown/no-throw -- Inject a defect at a module interface.
      throw injected;
    },
    (cause, fail) => fail(cause),
  );
}

async function expectInjectedDefect(device: ReturnType<typeof OperatorHome.resolve>) {
  const result = await Readiness.check(device);
  expect(result.tag).toBe("Defect");
  if (result.tag === "Defect") expect(result.cause).toBe(injected);
}

const launcherBlocker = {
  reason: "executable_missing",
  tool: "operator",
  detail: "Install operator.",
} as const;

describe("static blockers", () => {
  afterEach(() => {
    tools.mockClear();
    tools.mockResolvedValue({ status: "completed", exitCode: 0, stdout: "", stderr: "" });
    for (const spy of restorable.splice(0)) spy.mockRestore();
  });

  test("reports missing tools, skips authentication without gh, and names the OpenCode host", async () => {
    const device = await scenario({ host: "opencode", tools: [] });
    stub(GlobalLauncher, "check").mockReturnValue(OkAsync([launcherBlocker]));
    const owned = stub(OwnedSkills, "install").mockReturnValue(
      ErrAsync({ reason: "skill_copy_conflict" as const, detail: "Copies differ." }),
    );
    const upstream = stub(UpstreamSkills, "check").mockReturnValue(
      OkAsync(["/one/SKILL.md", "/two/SKILL.md"]),
    );
    const hook = stub(ClaudeHook, "install");
    expect(await Readiness.check(device)).toEqual(
      Ok({
        blockers: [
          { reason: "executable_missing", tool: "gh", detail: "Install gh on PATH." },
          { reason: "executable_missing", tool: "herdr", detail: "Install herdr on PATH." },
          launcherBlocker,
          { reason: "executable_missing", tool: "opencode", detail: "Install opencode on PATH." },
          {
            reason: "skill_copy_conflict",
            detail:
              "Copies differ. Run operator install --opencode, or update consumer-owned Nix links.",
          },
          {
            reason: "upstream_skills_missing",
            detail:
              "Run operator install --opencode. Missing required skill files: /one/SKILL.md, /two/SKILL.md",
          },
        ],
      }),
    );
    expect(tools).not.toHaveBeenCalled();
    expect(owned).toHaveBeenCalledWith({ paths: device, hosts: ["opencode"], check: true });
    expect(upstream).toHaveBeenCalledWith(device, "opencode");
    expect(hook).not.toHaveBeenCalled();
  });

  test("checks authentication when gh exists and names the Claude Code host", async () => {
    const device = await scenario({ host: "claude-code", tools: ["gh", "herdr", "claude"] });
    stub(GlobalLauncher, "check").mockReturnValue(
      ErrAsync({ reason: "launcher_io_failed" as const, detail: "denied" }),
    );
    stub(OwnedSkills, "install").mockReturnValue(
      ErrAsync({ reason: "skills_io_failed" as const, detail: "Unreadable." }),
    );
    stub(UpstreamSkills, "check").mockReturnValue(
      ErrAsync({ reason: "upstream_io_failed" as const, detail: "denied" }),
    );
    const hook = stub(ClaudeHook, "install").mockReturnValue(
      ErrAsync({ reason: "claude_hook_missing" as const, detail: "Add the hook." }),
    );
    tools.mockResolvedValueOnce({ status: "completed", exitCode: 1, stdout: "", stderr: "" });
    expect(await Readiness.check(device)).toEqual(
      Ok({
        blockers: [
          { reason: "launcher_io_failed", detail: "denied" },
          { reason: "github_auth_failed", detail: "Run gh auth login for github.com." },
          {
            reason: "skills_io_failed",
            detail:
              "Unreadable. Run operator install --claude, or update consumer-owned Nix links.",
          },
          { reason: "upstream_io_failed", detail: "denied" },
          { reason: "claude_hook_missing", detail: "Add the hook." },
        ],
      }),
    );
    expect(hook).toHaveBeenCalledWith({ paths: device, check: true });
    expect(tools).toHaveBeenCalledWith({
      tool: "gh",
      args: ["auth", "status", "--hostname", "github.com"],
      timeoutMs: 10000,
    });
    tools.mockResolvedValueOnce({ status: "no-answer", detail: "interrupted" });
    stub(OwnedSkills, "install").mockReturnValue(
      OkAsync({ reason: "skills_checked" as const, data: { hosts: [], checkOnly: true } }),
    );
    stub(UpstreamSkills, "check").mockReturnValue(OkAsync([]));
    stub(GlobalLauncher, "check").mockReturnValue(OkAsync([]));
    hook.mockReturnValue(OkAsync("already_installed" as const));
    expect(await Readiness.check(device)).toEqual(
      Ok({
        blockers: [{ reason: "github_auth_failed", detail: "Run gh auth login for github.com." }],
      }),
    );
    expect(await Readiness.check(device)).toEqual(Ok({ blockers: [] }));
  });

  test("an unconfigured host is one blocker without skill checks", async () => {
    const device = await scenario({ tools: ["gh", "herdr"] });
    stub(GlobalLauncher, "check").mockReturnValue(OkAsync([]));
    const owned = stub(OwnedSkills, "install");
    expect(await Readiness.check(device)).toEqual(
      Ok({
        blockers: [
          { reason: "host_unconfigured", detail: "Set superAgent.host in device settings." },
        ],
      }),
    );
    expect(owned).not.toHaveBeenCalled();
  });

  test("a defect at any checked interface is not a readiness claim", async () => {
    const device = await scenario({ host: "opencode", tools: ["gh", "herdr", "opencode"] });
    const settings = stub(DeviceSettings, "show").mockReturnValue(defect());
    await expectInjectedDefect(device);
    settings.mockRestore();
    tools.mockClear();
    const launcher = stub(GlobalLauncher, "check").mockReturnValue(defect());
    await expectInjectedDefect(device);
    expect(tools).not.toHaveBeenCalled();
    launcher.mockReturnValue(OkAsync([]));
    const owned = stub(OwnedSkills, "install").mockReturnValue(defect());
    const upstream = stub(UpstreamSkills, "check").mockReturnValue(OkAsync([]));
    await expectInjectedDefect(device);
    expect(upstream).not.toHaveBeenCalled();
    owned.mockReturnValue(
      OkAsync({ reason: "skills_checked" as const, data: { hosts: [], checkOnly: true } }),
    );
    upstream.mockReturnValue(defect());
    await expectInjectedDefect(device);
    const claude = await scenario({ host: "claude-code", tools: ["gh", "herdr", "claude"] });
    stub(GlobalLauncher, "check").mockReturnValue(OkAsync([]));
    stub(OwnedSkills, "install").mockReturnValue(
      OkAsync({ reason: "skills_checked" as const, data: { hosts: [], checkOnly: true } }),
    );
    stub(UpstreamSkills, "check").mockReturnValue(OkAsync([]));
    stub(ClaudeHook, "install").mockReturnValue(defect());
    await expectInjectedDefect(claude);
  });

  test("a throw from a checked interface is a defect with its cause", async () => {
    const device = await scenario({ host: "opencode", tools: ["gh", "herdr", "opencode"] });
    const launcher = stub(GlobalLauncher, "check").mockImplementation(() => {
      // oxlint-disable-next-line unthrown/no-throw -- Inject a throw at a module interface.
      throw injected;
    });
    await expectInjectedDefect(device);
    launcher.mockReturnValue(OkAsync([]));
    stub(DeviceSettings, "show").mockImplementation(() => {
      // oxlint-disable-next-line unthrown/no-throw -- Inject a throw at a module interface.
      throw injected;
    });
    await expectInjectedDefect(device);
  });

  test("authentication runs when only herdr is missing and refuses an unfinished answer", async () => {
    const device = await scenario({ host: "claude-code", tools: ["gh", "claude"] });
    stub(GlobalLauncher, "check").mockReturnValue(OkAsync([]));
    stub(OwnedSkills, "install").mockReturnValue(
      OkAsync({ reason: "skills_checked" as const, data: { hosts: [], checkOnly: true } }),
    );
    stub(UpstreamSkills, "check").mockReturnValue(OkAsync(["/claude/SKILL.md"]));
    stub(ClaudeHook, "install").mockReturnValue(OkAsync("installed" as const));
    // An unfinished answer is refused even when it carries an exit code.
    const unfinished = { status: "no-answer" as const, detail: "interrupted", exitCode: 0 };
    tools.mockResolvedValueOnce(unfinished);
    expect(await Readiness.check(device)).toEqual(
      Ok({
        blockers: [
          { reason: "executable_missing", tool: "herdr", detail: "Install herdr on PATH." },
          { reason: "github_auth_failed", detail: "Run gh auth login for github.com." },
          {
            reason: "upstream_skills_missing",
            detail: "Run operator install --claude. Missing required skill files: /claude/SKILL.md",
          },
        ],
      }),
    );
    expect(tools).toHaveBeenCalledTimes(1);
  });
});
