import { expect, test } from "bun:test";
import { pluginId, pluginManifestFile } from "./plugin.ts";

test("every hook forwards to the global operator command, never a release path", async () => {
  const text = await Bun.file(pluginManifestFile).text();
  const manifest = Bun.TOML.parse(text);
  expect(manifest).toMatchObject({ id: pluginId, min_herdr_version: "0.9.1" });
  expect(manifest).toHaveProperty("events", [
    { on: "worktree.created", command: ["operator", "herdr", "event", "--json"] },
    { on: "pane.exited", command: ["operator", "herdr", "event", "--json"] },
    { on: "pane.closed", command: ["operator", "herdr", "event", "--json"] },
    { on: "pane.agent_status_changed", command: ["operator", "herdr", "event", "--json"] },
  ]);
  expect(manifest).not.toHaveProperty("startup");
  expect(text).not.toMatch(/\.ts|\.js|bun |\//);
});
