import { afterAll, expect, expectTypeOf, spyOn, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fromPromise } from "unthrown";
import { DeviceSettings } from "../device-settings/main.ts";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
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
