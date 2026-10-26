import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { Environment } from "../environment/main.ts";
import { discoverOpenCode, discoverClaude } from "./catalog.ts";

afterEach(() => {
  mock.restore();
});

test("uses directory-scoped OpenCode metadata and omits disabled models", async () => {
  const run = spyOn(ToolInvocation, "run").mockResolvedValue({
    status: "completed",
    exitCode: 0,
    stderr: "",
    stdout: JSON.stringify({
      location: { directory: "/isolated dir" },
      data: [
        { providerID: "provider", id: "selected", enabled: true, variants: [{ id: "medium" }] },
        { providerID: "provider", id: "disabled", enabled: false, variants: [] },
      ],
    }),
  });
  expect(await discoverOpenCode("/isolated dir")).toEqual([
    { model: "provider/selected", efforts: ["medium"] },
  ]);
  expect(run.mock.calls[0]?.[0].args).toEqual([
    "api",
    "get",
    "/api/model?location%5Bdirectory%5D=%2Fisolated%20dir",
  ]);
});

test("refuses unavailable, failed, timed out, and wrong-directory metadata", async () => {
  const run = spyOn(ToolInvocation, "run");
  run.mockResolvedValue({ status: "unavailable", tool: "opencode", detail: "missing" });
  expect(await discoverOpenCode("/isolated")).toMatchObject({ reason: "host_unavailable" });
  run.mockResolvedValue({ status: "no-answer", detail: "timeout" });
  expect(await discoverOpenCode("/isolated")).toMatchObject({ reason: "host_metadata_failed" });
  run.mockResolvedValue({
    status: "completed",
    exitCode: 1,
    stdout: "",
    stderr: "secret must not leak",
  });
  expect(await discoverOpenCode("/isolated")).toEqual({
    reason: "host_metadata_failed",
    detail: "OpenCode could not read its model catalog.",
  });
  run.mockResolvedValue({
    status: "completed",
    exitCode: 0,
    stdout: JSON.stringify({ location: { directory: "/different" }, data: [] }),
    stderr: "",
  });
  expect(await discoverOpenCode("/isolated")).toMatchObject({ reason: "host_metadata_failed" });
});

test("does not substitute a bundled Claude executable when the installed host is missing", async () => {
  spyOn(Environment, "read").mockReturnValue({ ...Environment.read(), PATH: "" });
  expect(await discoverClaude("/isolated")).toMatchObject({ reason: "host_unavailable" });
});
