import { GithubTracker } from "../github-tracker/main.ts";
import { TrackerUpdate } from "../tracker-update/main.ts";
import { failed, passed, type Staged, skipped } from "./stage.ts";

export type Fixture = { repository: string; issue: number; mapIssue?: number | undefined };

export const TRACKER_CHECKS = [
  "github-comment",
  "github-pagination",
  "github-amendment",
  "github-dependencies",
  "github-sub-issues",
  "github-events",
  "github-closure",
];

const PROVIDER = "github";

/** Every fixture check reads and writes only these targets, and the record names them. */
function targetsOf(fixture: Fixture): string[] {
  const map = fixture.mapIssue ?? fixture.issue;
  return [
    `github:${fixture.repository}#${fixture.issue}`,
    ...(map === fixture.issue ? [] : [`github:${fixture.repository}#${map}`]),
  ];
}

type Written =
  | { status: "written"; operationId: string; resourceId: string; expectedActor: string }
  | { status: "unwritten"; detail: string };

/**
 * Writes one comment through the supported path, exactly as the workflow writes it.
 * The probe fixes the content before the write and reads the effect back afterwards, so a lost
 * answer is settled by reading rather than by sending the comment again.
 */
async function writeComment(
  fixture: Fixture,
  request: {
    issue: number;
    intent:
      | { step: "resolution"; body: string }
      | {
          step: "map_amendment";
          decisionLink: string;
          baselineIdentity: string;
          sections: string[];
          supersedes: string[];
          body: string;
        };
  },
): Promise<Written> {
  const operationId = crypto.randomUUID();
  const target = { repository: fixture.repository, issue: request.issue };
  const planned = await TrackerUpdate.plan({
    provider: PROVIDER,
    operationId,
    intent: { ...request.intent, target },
  });
  if (planned.status !== "planned" || planned.content === null) {
    return { status: "unwritten", detail: `The write could not be planned: ${planned.status}` };
  }

  const written = await TrackerUpdate.write({
    provider: PROVIDER,
    target,
    step: request.intent.step,
    content: planned.content,
  });
  if (written.status !== "succeeded") {
    return {
      status: "unwritten",
      detail: `The write did not land: ${written.status}${"detail" in written ? ` (${written.detail})` : ""}`,
    };
  }

  return {
    status: "written",
    operationId,
    resourceId: written.resourceId,
    expectedActor: planned.expectedActor,
  };
}

async function baselineIdentityOf(
  fixture: Fixture,
  mapIssue: number,
): Promise<string | { detail: string }> {
  const read = await TrackerUpdate.readMap({
    provider: PROVIDER,
    target: { repository: fixture.repository, issue: mapIssue },
  });
  return read.status === "read" ? read.reading.baselineIdentity : { detail: read.status };
}

/**
 * Runs every GitHub fixture check against the configured fixture and nothing else.
 * The probe closes the fixture issue and puts it back as it found it, so a rerun starts from the
 * same state and no project issue is ever named.
 */
export async function runTrackerChecks(request: {
  fixture: Fixture | null;
  probeId: string;
}): Promise<{ staged: Staged[]; resources: string[] }> {
  const staged: Staged[] = [];
  if (request.fixture === null) {
    for (const name of TRACKER_CHECKS) {
      staged.push(
        skipped(
          name,
          "No probe fixture is configured, so this check reached no tracker. Set `probe.githubFixture` in `.operator/config.json`.",
        ),
      );
    }
    return { staged, resources: [] };
  }

  const fixture = request.fixture;
  const mapIssue = fixture.mapIssue ?? fixture.issue;
  const target = { repository: fixture.repository, issue: fixture.issue };
  const resources: string[] = [];
  const targets = targetsOf(fixture);

  const comment = await writeComment(fixture, {
    issue: fixture.issue,
    intent: {
      step: "resolution",
      body: `## Resolution\n\nOperator live probe ${request.probeId} wrote this synthetic comment.`,
    },
  });
  if (comment.status !== "written") {
    staged.push(failed("github-comment", comment.detail));
    staged.push(skipped("github-pagination", "No probe comment was written to look for."));
  } else {
    resources.push(`github comment ${fixture.repository}#${fixture.issue}/${comment.resourceId}`);
    const known = await TrackerUpdate.read({
      provider: PROVIDER,
      step: "resolution",
      target,
      operationId: comment.operationId,
      expectedActor: comment.expectedActor,
      contentIdentity: null,
      resourceId: comment.resourceId,
      intendedReason: "completed",
      writes: ["succeeded"],
      now: new Date().toISOString(),
    });
    staged.push(
      known.observation.kind === "comment" && known.observation.lookup === "known-id"
        ? passed(
            "github-comment",
            `Comment ${comment.resourceId} was written by ${comment.expectedActor} and read back by its own identifier.`,
            {
              outputs: [`comment ${comment.resourceId}`, `verdict ${known.verdict.reason}`],
              evidence: [
                { label: "fixture comment", path: null, identity: comment.operationId },
                { label: "fixture targets", path: null, identity: targets.join(" ") },
              ],
              cleanup: {
                state: "retained",
                detail: "The synthetic comment stays on the fixture issue as evidence.",
              },
            },
          )
        : failed(
            "github-comment",
            `The written comment was not read back: ${known.verdict.reason}`,
          ),
    );

    const scanned = await TrackerUpdate.read({
      provider: PROVIDER,
      step: "resolution",
      target,
      operationId: comment.operationId,
      expectedActor: comment.expectedActor,
      contentIdentity: null,
      // No identifier, so the read scans every accessible page instead of asking for one comment.
      resourceId: null,
      intendedReason: "completed",
      writes: ["succeeded"],
      now: new Date().toISOString(),
    });
    const coverage =
      scanned.observation.kind === "comment" ? scanned.observation.coverage : undefined;
    staged.push(
      coverage?.complete === true
        ? passed(
            "github-pagination",
            `The comment scan covered ${coverage.pages} pages and ${coverage.count} comments of the fixture issue.`,
            { outputs: [`pages ${coverage.pages}`, `comments ${coverage.count}`] },
          )
        : failed(
            "github-pagination",
            `The comment scan did not cover every page: ${coverage?.detail ?? "it answered no coverage"}`,
          ),
    );
  }

  const baseline = await baselineIdentityOf(fixture, mapIssue);
  if (typeof baseline !== "string") {
    staged.push(
      failed("github-amendment", `The fixture map could not be read: ${baseline.detail}`),
    );
  } else {
    const amendment = await writeComment(fixture, {
      issue: mapIssue,
      intent: {
        step: "map_amendment",
        decisionLink: `https://github.com/${fixture.repository}/issues/${fixture.issue}`,
        baselineIdentity: baseline,
        sections: [`Live probe ${request.probeId}`],
        supersedes: [],
        body: "- The live probe wrote this synthetic amendment.",
      },
    });
    if (amendment.status !== "written") {
      staged.push(failed("github-amendment", amendment.detail));
    } else {
      resources.push(`github comment ${fixture.repository}#${mapIssue}/${amendment.resourceId}`);
      const read = await TrackerUpdate.readMap({
        provider: PROVIDER,
        target: { repository: fixture.repository, issue: mapIssue },
      });
      const effective =
        read.status === "read"
          ? read.reading.effective.some((one) => one.operationId === amendment.operationId)
          : false;
      staged.push(
        read.status === "read" && effective && read.reading.problems.length === 0
          ? passed(
              "github-amendment",
              `The amendment stands on the fixture map, beside ${read.reading.ordinaryComments} ordinary comments that are not amendments.`,
              {
                outputs: [
                  `amendments ${read.reading.amendments.length}`,
                  `ordinary comments ${read.reading.ordinaryComments}`,
                ],
                evidence: [
                  { label: "map baseline", path: null, identity: read.reading.baselineIdentity },
                ],
                cleanup: {
                  state: "retained",
                  detail: "The synthetic amendment stays on the fixture map as evidence.",
                },
              },
            )
          : failed(
              "github-amendment",
              read.status === "read"
                ? `The amendment did not read back as one: ${read.reading.problems.map((one) => one.detail).join(" ") || "it is not effective"}`
                : `The fixture map could not be read: ${read.status}`,
            ),
      );
    }
  }

  const blocked = await GithubTracker.readBlockedBy(target);
  staged.push(
    blocked.coverage.complete
      ? passed(
          "github-dependencies",
          `The fixture issue reports ${blocked.issues.length} issues that block it.`,
          { outputs: blocked.issues.map((one) => `#${one.number} ${one.state}`) },
        )
      : failed(
          "github-dependencies",
          `The dependency read did not cover every page: ${blocked.coverage.detail ?? "it answered no coverage"}`,
        ),
  );

  const subIssues = await GithubTracker.readSubIssues(target);
  staged.push(
    subIssues.coverage.complete
      ? passed(
          "github-sub-issues",
          `The fixture issue reports ${subIssues.issues.length} sub-issues.`,
          {
            outputs: subIssues.issues.map((one) => `#${one.number} ${one.state}`),
          },
        )
      : failed(
          "github-sub-issues",
          `The sub-issue read did not cover every page: ${subIssues.coverage.detail ?? "it answered no coverage"}`,
        ),
  );

  const closure = await closeAndRestore(fixture, request.probeId);
  staged.push(closure.closure, closure.events);

  return { staged, resources };
}

/**
 * Closes the fixture issue with an explicit reason, reads the history back, and reopens it.
 * The reopen is the probe putting the fixture back as it found it, and it also makes the
 * reopen event the history check reads.
 */
async function closeAndRestore(
  fixture: Fixture,
  probeId: string,
): Promise<{ closure: Staged; events: Staged }> {
  const target = { repository: fixture.repository, issue: fixture.issue };
  const operationId = crypto.randomUUID();
  const planned = await TrackerUpdate.plan({
    provider: PROVIDER,
    operationId,
    intent: { step: "completion", target, reason: "completed" },
  });
  if (planned.status !== "planned") {
    const detail = `The closure could not be planned: ${planned.status}`;
    return { closure: failed("github-closure", detail), events: skipped("github-events", detail) };
  }

  const written = await TrackerUpdate.write({
    provider: PROVIDER,
    target,
    step: "completion",
    closeReason: "completed",
  });
  if (written.status !== "succeeded") {
    const detail = `The fixture issue did not close: ${written.status}`;
    return { closure: failed("github-closure", detail), events: skipped("github-events", detail) };
  }

  const read = await TrackerUpdate.read({
    provider: PROVIDER,
    step: "completion",
    target,
    operationId,
    expectedActor: planned.expectedActor,
    contentIdentity: null,
    resourceId: written.resourceId,
    intendedReason: "completed",
    writes: ["succeeded"],
    now: new Date().toISOString(),
  });
  const observed = read.observation.kind === "closure" ? read.observation : null;
  const closedRight = observed?.state === "closed" && observed.stateReason === "completed";

  const reopened = await GithubTracker.reopenIssue(target);
  const restored =
    reopened.status === "succeeded"
      ? {
          state: "removed" as const,
          detail: `Issue #${fixture.issue} was reopened as it was found.`,
        }
      : {
          state: "failed" as const,
          detail: `Issue #${fixture.issue} is still closed: the reopen answered ${reopened.status}.`,
        };

  const closure = closedRight
    ? passed(
        "github-closure",
        `The fixture issue closed as ${observed?.stateReason} by ${observed?.closedBy ?? "an unnamed account"}, and the reason was read back.`,
        {
          outputs: [`state ${observed?.state}`, `reason ${observed?.stateReason}`],
          evidence: [{ label: "closure operation", path: null, identity: operationId }],
          cleanup: restored,
        },
      )
    : failed(
        "github-closure",
        `The fixture issue did not close with the intended reason: ${read.verdict.reason}`,
        { cleanup: restored },
      );

  const history = await GithubTracker.readEvents(target);
  const names = history.events.map((one) => one.event);
  const events = !history.coverage.complete
    ? failed(
        "github-events",
        `The event read did not cover every page: ${history.coverage.detail ?? "it answered no coverage"}`,
      )
    : names.includes("closed") && names.includes("reopened")
      ? passed(
          "github-events",
          `The fixture history holds ${history.events.length} events, including the close and the reopen probe ${probeId} made.`,
          { outputs: names },
        )
      : failed(
          "github-events",
          `The fixture history does not hold both a close and a reopen: it holds ${names.join(", ") || "no events"}.`,
        );

  return { closure, events };
}
