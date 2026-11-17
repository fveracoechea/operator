import { expect, test } from "bun:test";
import { Environment } from "../environment/main.ts";

test("brief record facts through the isolated CLI seam", async () => {
  const root = Bun.fileURLToPath(new URL("../../../", import.meta.url));
  const child = Bun.spawn(
    [
      process.execPath,
      `${root}/tools/test-watchdog.ts`,
      `${root}/src/modules/operator-cli/run.dispatch.test.ts`,
      `${root}/src/modules/operator-cli/run.pr-relay.test.ts`,
      `${root}/src/modules/operator-cli/run.pull-requests.test.ts`,
      `${root}/src/modules/operator-cli/run.questions.test.ts`,
      `${root}/src/modules/operator-cli/run.internal-review.test.ts`,
      `${root}/src/modules/operator-cli/run.internal-review-ready.test.ts`,
      `${root}/src/modules/operator-cli/run.reports.test.ts`,
      "--test-name-pattern",
      "a launch keeps its kind snapshot|an existing assignment and its new launch|a replacement preserves the recorded|an interrupted owner needs replacement|a worker question stays|associate hands a clean draft|the reviewer records at most two rounds|the reviewer ends the review with one rendered comment|a person-instructed skip ends|returned work resumes",
    ],
    {
      cwd: root,
      env: Environment.child({ BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, `${stdout}\n${stderr}`).toBe(0);
  expect(`${stdout}\n${stderr}`).toContain("11 pass");
}, 120000);
