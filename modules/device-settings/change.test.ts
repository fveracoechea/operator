import { afterAll, expect, test } from "bun:test";
// Bun has no temporary directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { apply, plan, recover } from "./change.ts";

const root = await mkdtemp(path.join(tmpdir(), "operator-settings-change-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("binds plans to both device locations and receipts so old plans cannot replay after another edit", async () => {
  const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
  const request = { paths, sets: ["superAgent.host=opencode"], unsets: [] };
  const schema = z.object({ data: z.object({ planId: z.string() }) });
  const first = schema.parse(await plan(request)).data.planId;
  const other = schema.parse(
    await plan({ ...request, paths: { ...paths, receipt: `${root}/different-receipt` } }),
  ).data.planId;
  expect(other).not.toBe(first);
  expect(await apply({ ...request, planId: first })).toMatchObject({ reason: "settings_applied" });
  const unset = { ...request, sets: [], unsets: ["superAgent.host"] };
  const second = schema.parse(await plan(unset)).data.planId;
  expect(await apply({ ...unset, planId: second })).toMatchObject({ reason: "settings_applied" });
  expect(await apply({ ...request, planId: first })).toMatchObject({
    reason: "settings_plan_stale",
  });
  expect(JSON.parse(await Bun.file(paths.config).text())).toMatchObject({ superAgent: {} });
  expect(await recover(paths)).toMatchObject({
    reason: "settings_recovered",
    data: { state: "complete" },
  });
});
