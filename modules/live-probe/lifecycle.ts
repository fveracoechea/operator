import { ContentIdentity } from "../content-identity/main.ts";
import { HerdrControl } from "../herdr-control/main.ts";
// Bun has no path manipulation API.
import { basename } from "node:path";
import {
  ask,
  LIFECYCLE_CHECKS,
  type Lifecycle,
  isIdleShell,
  type Launched,
  reportEvidence,
  startAgent,
  stopAgent,
} from "./agents.ts";
import { ranInParallel } from "./protocol.ts";
import { commitProbeWork, makeScratch, type Scratch } from "./scratch.ts";
import { failed, passed, passedAll, type Staged, skipped, skipRest } from "./stage.ts";
import { proveTakeover } from "./takeover.ts";

/** What the run has recorded so far. Each stage adds to it in the order the checks ran. */
type Progress = { staged: Staged[]; resources: string[] };

/** The probe's own worktree and the Operator host launched in it. */
type Opened = { scratch: Scratch; workspaceId: string; operator: Launched };

/**
 * Builds the scratch repository, has Herdr create its worktree, and launches the Operator host.
 * A step that fails skips every lifecycle check that has not run, because each one needs it.
 */
async function openWorkspace(lifecycle: Lifecycle, progress: Progress): Promise<Opened | null> {
  const { staged, resources } = progress;
  let scratch: Awaited<ReturnType<typeof makeScratch>>;
  try {
    scratch = await makeScratch({
      projectRoot: lifecycle.projectRoot,
      runId: lifecycle.runId,
      targets: lifecycle.targets,
    });
  } catch (error) {
    staged.push(
      failed("herdr-worktree", `The scratch repository could not be built: ${String(error)}`),
    );
    skipRest(staged, LIFECYCLE_CHECKS, "The scratch repository was never built.");
    return null;
  }
  resources.push(`scratch repository ${scratch.repo}`);

  const project = basename(lifecycle.projectRoot);
  const probe = lifecycle.runId.slice(0, 8);
  const created = await HerdrControl.createWorktree({
    repoRoot: scratch.repo,
    path: scratch.worktreePath,
    branch: scratch.branch,
    baseCommit: scratch.baseCommit,
    label: `${project} probe ${probe} worktree`,
    tabLabel: `${project} probe ${probe} Operator and Crew`,
    sourceLabel: `${project} probe ${probe} repository`,
  });
  if (created.status !== "succeeded") {
    staged.push(
      failed(
        "herdr-worktree",
        `Herdr created no test worktree: ${created.status === "failed" ? `${created.code}: ${created.detail}` : created.detail}`,
      ),
    );
    skipRest(staged, LIFECYCLE_CHECKS, "Herdr created no test worktree.");
    return null;
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
    return null;
  }

  const operator = await startAgent(lifecycle, {
    role: "operator",
    workspaceId,
    worktreePath: scratch.worktreePath,
  });
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
    return null;
  }
  resources.push(`herdr agent ${operator.agent.name}`);
  return { scratch, workspaceId, operator: operator.agent };
}

/** Asks the Operator host which instruction files and skills it loaded, inside the window. */
async function loadingChecks(lifecycle: Lifecycle, opened: Opened, staged: Staged[]) {
  const { scratch } = opened;
  const loading = await ask(lifecycle, {
    agent: opened.operator,
    step: "loading",
    scratch,
    instructions: [
      "Name every instruction file you loaded and every skill whose contents you loaded.",
    ],
  });
  if (loading.status !== "answered") {
    staged.push(failed("instruction-and-skill-loading", loading.detail));
    staged.push(
      failed(
        "bounded-observation",
        `${loading.detail} The read stopped at its ${lifecycle.observationMs} ms window rather than waiting on.`,
      ),
    );
    return loading;
  }

  // The checkout holds this project's own instruction files and this release's own skills, so
  // the check reads those exact names back instead of accepting any non-empty list.
  const missed = [
    ...scratch.instructions.filter((one) => !loading.report.instructions.includes(one)),
    ...scratch.skills.filter((one) => !loading.report.skills.includes(one)),
  ];
  const wrongHost = loading.report.host !== lifecycle.operator.host;
  staged.push(
    wrongHost
      ? failed(
          "instruction-and-skill-loading",
          `The agent reported host ${loading.report.host}, and Herdr launched ${lifecycle.operator.host}.`,
        )
      : missed.length > 0
        ? failed(
            "instruction-and-skill-loading",
            `The agent did not report loading ${missed.join(", ")}, and the checkout holds ${[...scratch.instructions, ...scratch.skills].join(", ")}.`,
          )
        : passed(
            "instruction-and-skill-loading",
            `The agent loaded ${scratch.instructions.join(", ")} and the ${scratch.skills.join(", ")} skill contents this project holds.`,
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
  return loading;
}

/** Asks the synthetic question, then for a result, each only after the brief before it. */
async function exchangeChecks(
  lifecycle: Lifecycle,
  opened: Opened,
  staged: Staged[],
  loaded: boolean,
) {
  const { scratch } = opened;
  const question = loaded
    ? await ask(lifecycle, {
        agent: opened.operator,
        step: "question",
        scratch,
        instructions: [
          "Answer the synthetic question `what is the probe identity?` and acknowledge that you received it.",
        ],
      })
    : null;
  staged.push(
    question === null
      ? skipped("question-and-answer", "The Operator host never answered the loading brief.")
      : question.status === "answered"
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

  const result =
    question?.status === "answered"
      ? await ask(lifecycle, {
          agent: opened.operator,
          step: "result",
          scratch,
          instructions: ["Submit a synthetic result naming the artifacts it fixes."],
        })
      : null;
  staged.push(
    result === null
      ? skipped("result-reporting", "The Operator host did not answer the preceding brief.")
      : result.status === "answered"
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
  return result?.status === "answered";
}

/** Launches the Crew host and proves it runs both review axes at the same time. */
async function reviewChecks(
  lifecycle: Lifecycle,
  opened: Opened,
  progress: Progress,
  loaded: boolean,
): Promise<Launched | null> {
  const { staged } = progress;
  const reviewer = await startAgent(lifecycle, {
    role: "crew",
    workspaceId: opened.workspaceId,
    worktreePath: opened.scratch.worktreePath,
  });
  if (reviewer.status !== "started") {
    staged.push(failed("review-sub-agents", reviewer.detail));
    staged.push(skipped("mixed-host-operation", "The Crew host was never launched."));
    return null;
  }
  progress.resources.push(`herdr agent ${reviewer.agent.name}`);
  const review = await ask(lifecycle, {
    agent: reviewer.agent,
    step: "review",
    scratch: opened.scratch,
    instructions: [
      "Run your own Standards and Spec review sub-agents at the same time inside this host.",
      "Report the start and finish time of each axis separately. Do not merge them.",
    ],
  });
  if (review.status !== "answered") {
    staged.push(failed("review-sub-agents", review.detail));
    staged.push(skipped("mixed-host-operation", "The Crew host reported nothing."));
    return reviewer.agent;
  }

  staged.push(
    ranInParallel(review.report.axes)
      ? passed(
          "review-sub-agents",
          `The reviewer ran its ${review.report.axes.map((one) => one.axis).join(" and ")} sub-agents at the same time.`,
          {
            outputs: review.report.axes.map(
              (one) => `${one.axis} ${one.startedAt} to ${one.finishedAt}`,
            ),
            evidence: reportEvidence("review", opened.scratch, review.identity),
          },
        )
      : failed(
          "review-sub-agents",
          "The two axis reports did not overlap in time, so they did not run in parallel.",
        ),
  );
  staged.push(
    review.report.host === lifecycle.crew.host && loaded
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
  return reviewer.agent;
}

/** Stops the Operator host during long work and proves its partial work stays in the checkout. */
async function interruptionCheck(
  lifecycle: Lifecycle,
  opened: Opened,
  resulted: boolean,
): Promise<Staged> {
  const { scratch } = opened;
  const interruption = resulted
    ? await ask(lifecycle, {
        agent: opened.operator,
        step: "interruption",
        scratch,
        instructions: ["Start long work, and write what you finished before you are stopped."],
      })
    : null;
  if (interruption === null) {
    return skipped("interruption", "The Operator host did not answer the preceding brief.");
  }
  if (interruption.status !== "answered") return failed("interruption", interruption.detail);

  const stopped = await stopAgent(opened.operator);
  const partial = Bun.file(`${scratch.worktreePath}/${interruption.report.wrote}`);
  const kept = await partial.exists();
  return stopped.status === "stopped" && kept
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
      );
}

/** Stops one launched host and names what, if anything, it left running in its pane. */
async function terminate(agent: Launched): Promise<{ stopped: boolean; line: string }> {
  const stopped = await stopAgent(agent);
  if (stopped.status !== "stopped") {
    return { stopped: false, line: `${agent.name}: ${stopped.detail}` };
  }
  const processes = await HerdrControl.readPaneProcesses({ paneId: agent.paneId });
  if (processes.status === "unknown") {
    return { stopped: false, line: `${agent.name}: ${processes.detail}` };
  }
  const remaining =
    processes.status === "found"
      ? processes.value.foreground.filter((one) => !isIdleShell(one, processes.value.shellPid))
      : [];
  return remaining.length > 0
    ? {
        stopped: false,
        line: `${agent.name} left ${remaining.map((one) => one.name).join(", ")} running in its pane.`,
      }
    : { stopped: true, line: `${agent.name} stopped and left no foreground process.` };
}

/** Commits the synthetic files, has Herdr remove the worktree, and proves it is gone. */
async function removalCheck(opened: Opened): Promise<Staged> {
  const { scratch, workspaceId } = opened;
  // Herdr refuses to remove a checkout that still holds uncommitted work, and it is never
  // forced. The probe commits its own synthetic files first, so the removal is a real removal.
  const committed = await commitProbeWork(scratch.worktreePath);
  const removed = await HerdrControl.removeWorktree({ workspaceId });
  if (removed.status !== "succeeded") {
    return failed(
      "worktree-removal",
      `Herdr did not remove the test worktree: ${removed.status === "failed" ? `${removed.code}: ${removed.detail}` : removed.detail}`,
      {
        cleanup: {
          state: "failed",
          detail: `The test worktree at ${scratch.worktreePath} is still there.`,
        },
      },
    );
  }

  const after = await HerdrControl.findWorktree({
    repoRoot: scratch.repo,
    path: scratch.worktreePath,
  });
  return after.status === "absent"
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
      );
}

/** Runs every lifecycle and project-readiness check, in the one order their evidence allows. */
export async function runLifecycle(lifecycle: Lifecycle): Promise<Progress> {
  const progress: Progress = { staged: [], resources: [] };
  const { staged } = progress;
  const opened = await openWorkspace(lifecycle, progress);
  if (opened === null) return progress;

  const loading = await loadingChecks(lifecycle, opened, staged);
  const loaded = loading.status === "answered";
  const resulted = await exchangeChecks(lifecycle, opened, staged, loaded);
  const reviewer = await reviewChecks(lifecycle, opened, progress, loaded);
  staged.push(await proveTakeover(opened.scratch, opened.operator));
  staged.push(await interruptionCheck(lifecycle, opened, resulted));

  const termination: Array<{ stopped: boolean; line: string }> = [];
  for (const agent of [opened.operator, ...(reviewer === null ? [] : [reviewer])]) {
    termination.push(await terminate(agent));
  }
  const lines = termination.map((one) => one.line);
  if (termination.some((one) => !one.stopped)) {
    staged.push(failed("host-termination", lines.join(" ")));
    staged.push(
      failed(
        "worktree-removal",
        "The probe worktree remains because a host or its child process is still live.",
      ),
    );
    return progress;
  }
  staged.push(
    passed("host-termination", lines.join(" "), {
      outputs: lines,
      cleanup: { state: "removed", detail: "Every launched host was stopped." },
    }),
  );
  staged.push(await removalCheck(opened));
  return progress;
}
