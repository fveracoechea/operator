import { expect, test } from "bun:test";
import { z } from "zod";
import plugin from "./index.ts";

const configSchema = z.object({
  jsPlugins: z.array(z.object({ name: z.string(), specifier: z.string() })),
  rules: z.record(z.string(), z.unknown()),
});

test("registers under its configured name every rule the lint policy enables", async () => {
  const config = configSchema.parse(
    await Bun.file(new URL("../../../.oxlintrc.json", import.meta.url)).json(),
  );
  const name = config.jsPlugins.find(
    (entry) => entry.specifier === "./tools/oxlint/anti-slop/index.ts",
  )?.name;
  const enabled = Object.keys(config.rules)
    .filter((rule) => rule.startsWith("anti-slop/"))
    .map((rule) => rule.slice("anti-slop/".length));

  expect(name).toBe("anti-slop");
  expect(plugin.meta?.name).toBe("anti-slop");
  expect(Object.keys(plugin.rules).toSorted()).toEqual(enabled.toSorted());
});
