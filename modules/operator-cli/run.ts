import type { OperatorHome } from "../operator-home/main.ts";
import { runProfiles } from "./profiles.ts";
import { runSkills } from "./skills.ts";
import { runLauncher } from "./launcher.ts";
import { runReadiness } from "./readiness.ts";
import { runSources } from "./sources.ts";
import { runDispatch } from "./dispatch.ts";
import { runPullRequests } from "./pull-requests.ts";
import { runReports } from "./reports.ts";
import { runReviews } from "./reviews.ts";
import { runProject } from "./projects.ts";
import { runSettings } from "./settings.ts";
import { startup } from "./startup.ts";
import { invalidArguments, runUsage } from "./usage.ts";

type OperatorPaths = ReturnType<typeof OperatorHome.resolve>;

export async function run(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const started = await startup(args, json);
  if (started === null) return;
  if (runUsage(args, started.release, json)) return;
  for (const handler of [
    async (input: string[], _paths: OperatorPaths, flag: boolean) => runLauncher(input, flag),
    runSkills,
    runReadiness,
    runProfiles,
    runSettings,
    runProject,
    runSources,
    runDispatch,
    runPullRequests,
    runReports,
    runReviews,
  ]) {
    if (await handler(args, started.paths, json)) return;
  }
  invalidArguments(json);
}
