import { ContentIdentity } from "../content-identity/main.ts";
import { HerdrControl } from "../herdr-control/main.ts";
import {
  ask,
  LIFECYCLE_CHECKS,
  type Lifecycle,
  reportEvidence,
  startAgent,
  stopAgent,
} from "./agents.ts";
import { ranInParallel } from "./protocol.ts";
import { makeScratch, type Scratch } from "./scratch.ts";
import { failed, passed, passedAll, type Staged, skipped, skipRest } from "./stage.ts";
import { proveTakeover } from "./takeover.ts";

export type { Host, Lifecycle } from "./agents.ts";
export { LIFECYCLE_CHECKS } from "./agents.ts";

/** Commits the synthetic files one probe wrote, so its checkout is clean before removal. */
async function commitProbeWork(scratch: Scratch): Promise<string | null> {
  try {
    await Bun.$`git -C ${scratch.worktreePath} add -A`.quiet();
    await Bun.$`git -C ${scratch.worktreePath} -c user.email=probe@operator.invalid -c user.name=Operator commit -q --allow-empty -m "probe evidence"`.quiet();
    return (await Bun.$`git -C ${scratch.worktreePath} rev-parse HEAD`.quiet()).stdout
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/** Runs every lifecycle and project-readiness check, in the one order their evidence allows. */
export async function runLifecycle(lifecycle: Lifecycle): Promise<{
  staged: Staged[];
  resources: string[];
}> {
  const staged: Staged[] = [];
  const resources: string[] = [];

  let scratch: Scratch;
  try {
    scratch = await makeScratch({ projectRoot: lifecycle.projectRoot, runId: lifecycle.runId });
  } catch (error) {
    staged.push(
      failed("herdr-worktree", `The scratch repository could not be built: ${String(error)}`),
    );
    skipRest(staged, LIFECYCLE_CHECKS, "The scratch repository was never built.");
    return { staged, resources };
  }
  resources.push(`scratch repository ${scratch.repo}`);

  const created = await HerdrControl.createWorktree({
    repoRoot: scratch.repo,
    path: scratch.worktreePath,
    branch: scratch.branch,
    baseCommit: scratch.baseCommit,
    label: `operator-probe-${lifecycle.runId}`,
  });
  if (created.status !== "succeeded") {
    staged.push(
      failed(
        "herdr-worktree",
        `Herdr created no test worktree: ${created.status === "failed" ? `${created.code}: ${created.detail}` : created.detail}`,
      ),
    );
    skipRest(staged, LIFECYCLE_CHECKS, "Herdr created no test worktree.");
    return { staged, resources };
  }

  const workspaceId = created.value.workspaceId;
  resources.push(`herdr workspace ${workspaceId}`, `herdr worktree ${scratch.worktreePath}`);
  const listed = await HerdrControl.findWorktree({
    repoRoot: scratch.repo,
    path: scratch.worktreePath,
  });
  staged.push(
    listed.status === "found"
      ? passed("herdr-worktree", `Herdr holds the test worktree on branch ${scratch.branch}.`, {
          outputs: [`workspace ${workspaceId}`, `branch ${scratch.branch}`],
          evidence: [
            { label: "test worktree", path: scratch.worktreePath, identity: null },
            { label: "base commit", path: null, identity: scratch.baseCommit },
          ],
          cleanup: {
            state: "retained",
            detail: "The worktree-removal check disposes of it at the end of this run.",
          },
        })
      : failed(
          "herdr-worktree",
          `Herdr created a worktree it does not report: ${listed.status === "absent" ? "it is not listed" : listed.detail}`,
        ),
  );

  if (!passedAll(staged, ["herdr-worktree"])) {
    skipRest(staged, LIFECYCLE_CHECKS, "Herdr does not report the test worktree.");
    return { staged, resources };
  }

  const operator = await startAgent(lifecycle, { role: "operator", workspaceId });
  staged.push(
    operator.status === "started"
      ? passed(
          "agent-launch",
          `Herdr started ${lifecycle.operator.host} as ${operator.agent.name} in pane ${operator.agent.paneId}.`,
          { outputs: [`agent ${operator.agent.name}`, `pane ${operator.agent.paneId}`] },
        )
      : failed("agent-launch", operator.detail),
  );
  if (operator.status !== "started") {
    skipRest(staged, LIFECYCLE_CHECKS, "No host was launched.");
    return { staged, resources };
  }
  resources.push(`herdr agent ${operator.agent.name}`);

  const loading = await ask(lifecycle, {
    agent: operator.agent,
    step: "loading",
    scratch,
    instructions: [
      "Name every instruction file you loaded and every skill whose contents you loaded.",
    ],
  });
  if (loading.status === "answered") {
    const wrongHost = loading.report.host !== lifecycle.operator.host;
    staged.push(
      wrongHost
        ? failed(
            "instruction-and-skill-loading",
            `The agent reported host ${loading.report.host}, and Herdr launched ${lifecycle.operator.host}.`,
          )
        : passed(
            "instruction-and-skill-loading",
            `The agent loaded ${loading.report.instructions.length} instruction files and ${loading.report.skills.length} skills.`,
            {
              outputs: [...loading.report.instructions, ...loading.report.skills],
              evidence: reportEvidence("loading", scratch, loading.identity),
            },
          ),
    );
    staged.push(
      passed(
        "bounded-observation",
        `The bounded read answered after ${loading.waitedMs} ms inside its ${lifecycle.observationMs} ms window.`,
        { outputs: [`waited ${loading.waitedMs} ms of ${lifecycle.observationMs} ms`] },
      ),
    );
  } else {
    staged.push(failed("instruction-and-skill-loading", loading.detail));
    staged.push(
      failed(
        "bounded-observation",
        `${loading.detail} The read stopped at its ${lifecycle.observationMs} ms window rather than waiting on.`,
      ),
    );
  }

  const question = await ask(lifecycle, {
    agent: operator.agent,
    step: "question",
    scratch,
    instructions: [
      "Answer the synthetic question `what is the probe identity?` and acknowledge that you received it.",
    ],
  });
  staged.push(
    question.status === "answered"
      ? passed(
          "question-and-answer",
          `The agent acknowledged question ${question.report.questionId} at ${question.report.acknowledgedAt}.`,
          {
            outputs: [question.report.answer],
            evidence: reportEvidence("question", scratch, question.identity),
          },
        )
      : failed("question-and-answer", question.detail),
  );

  const result = await ask(lifecycle, {
    agent: operator.agent,
    step: "result",
    scratch,
    instructions: ["Submit a synthetic result naming the artifacts it fixes."],
  });
  staged.push(
    result.status === "answered"
      ? passed(
          "result-reporting",
          `The agent submitted result ${result.report.submissionId} with ${result.report.artifacts.length} artifacts.`,
          {
            outputs: result.report.artifacts,
            evidence: reportEvidence("result", scratch, result.identity),
          },
        )
      : failed("result-reporting", result.detail),
  );

  const reviewer = await startAgent(lifecycle, { role: "crew", workspaceId });
  if (reviewer.status !== "started") {
    staged.push(failed("review-sub-agents", reviewer.detail));
    staged.push(skipped("mixed-host-operation", "The Crew host was never launched."));
  } else {
    resources.push(`herdr agent ${reviewer.agent.name}`);
    const review = await ask(lifecycle, {
      agent: reviewer.agent,
      step: "review",
      scratch,
      instructions: [
        "Run your own Standards and Spec review sub-agents at the same time inside this host.",
        "Report the start and finish time of each axis separately. Do not merge them.",
      ],
    });
    if (review.status !== "answered") {
      staged.push(failed("review-sub-agents", review.detail));
      staged.push(skipped("mixed-host-operation", "The Crew host reported nothing."));
    } else {
      const parallel = ranInParallel(review.report.axes);
      staged.push(
        parallel
          ? passed(
              "review-sub-agents",
              `The reviewer ran its ${review.report.axes.map((one) => one.axis).join(" and ")} sub-agents at the same time.`,
              {
                outputs: review.report.axes.map(
                  (one) => `${one.axis} ${one.startedAt} to ${one.finishedAt}`,
                ),
                evidence: reportEvidence("review", scratch, review.identity),
              },
            )
          : failed(
              "review-sub-agents",
              "The two axis reports did not overlap in time, so they did not run in parallel.",
            ),
      );
      staged.push(
        review.report.host === lifecycle.crew.host && loading.status === "answered"
          ? passed(
              "mixed-host-operation",
              `The Operator host ${lifecycle.operator.host} and the Crew host ${lifecycle.crew.host} both ran in this probe.`,
              { outputs: [`operator ${lifecycle.operator.host}`, `crew ${lifecycle.crew.host}`] },
            )
          : failed(
              "mixed-host-operation",
              `The Crew host reported ${review.report.host}, and Herdr launched ${lifecycle.crew.host}.`,
            ),
      );
    }
  }

  staged.push(await proveTakeover(scratch, operator.agent));

  const interruption = await ask(lifecycle, {
    agent: operator.agent,
    step: "interruption",
    scratch,
    instructions: ["Start long work, and write what you finished before you are stopped."],
  });
  if (interruption.status !== "answered") {
    staged.push(failed("interruption", interruption.detail));
  } else {
    const stopped = await stopAgent(operator.agent);
    const partial = Bun.file(`${scratch.worktreePath}/${interruption.report.wrote}`);
    const kept = await partial.exists();
    staged.push(
      stopped.status === "stopped" && kept
        ? passed(
            "interruption",
            `The stopped host left ${interruption.report.wrote} in the checkout and is no longer reported as live.`,
            {
              outputs: [interruption.report.wrote],
              evidence: [
                {
                  label: "partial work",
                  path: `${scratch.worktreePath}/${interruption.report.wrote}`,
                  identity: kept ? ContentIdentity.ofText(await partial.text()) : null,
                },
              ],
            },
          )
        : failed(
            "interruption",
            stopped.status === "stopped"
              ? `The stopped host left no ${interruption.report.wrote} behind.`
              : stopped.detail,
          ),
    );
  }

  const remaining = reviewer.status === "started" ? [reviewer.agent] : [];
  const termination: string[] = [];
  let terminated = true;
  for (const agent of [operator.agent, ...remaining]) {
    const stopped = await stopAgent(agent);
    if (stopped.status !== "stopped") {
      terminated = false;
      termination.push(`${agent.name}: ${stopped.detail}`);
      continue;
    }

    const processes = await HerdrControl.readPaneProcesses({ paneId: agent.paneId });
    if (processes.status === "found" && processes.value.foreground.length > 0) {
      terminated = false;
      termination.push(
        `${agent.name} left ${processes.value.foreground.map((one) => one.name).join(", ")} running in its pane.`,
      );
      continue;
    }
    termination.push(`${agent.name} stopped and left no foreground process.`);
  }
  staged.push(
    terminated
      ? passed("host-termination", termination.join(" "), {
          outputs: termination,
          cleanup: { state: "removed", detail: "Every launched host was stopped." },
        })
      : failed("host-termination", termination.join(" ")),
  );

  // Herdr refuses to remove a checkout that still holds uncommitted work, and it is never
  // forced. The probe commits its own synthetic files first, so the removal is a real removal.
  const committed = await commitProbeWork(scratch);
  const removed = await HerdrControl.removeWorktree({ workspaceId });
  if (removed.status !== "succeeded") {
    staged.push(
      failed(
        "worktree-removal",
        `Herdr did not remove the test worktree: ${removed.status === "failed" ? `${removed.code}: ${removed.detail}` : removed.detail}`,
        {
          cleanup: {
            state: "failed",
            detail: `The test worktree at ${scratch.worktreePath} is still there.`,
          },
        },
      ),
    );
    return { staged, resources };
  }

  const after = await HerdrControl.findWorktree({
    repoRoot: scratch.repo,
    path: scratch.worktreePath,
  });
  staged.push(
    after.status === "absent"
      ? passed("worktree-removal", "Herdr removed the test worktree and no longer reports it.", {
          outputs: [`workspace ${workspaceId}`, `synthetic commit ${committed ?? "none"}`],
          cleanup: { state: "removed", detail: `${scratch.worktreePath} is gone.` },
        })
      : failed(
          "worktree-removal",
          after.status === "found"
            ? "Herdr answered that it removed the test worktree and still reports it."
            : `Herdr cannot say whether the test worktree is gone: ${after.detail}`,
          {
            cleanup: {
              state: "failed",
              detail: `The state of ${scratch.worktreePath} is not known.`,
            },
          },
        ),
  );

  return { staged, resources };
}
