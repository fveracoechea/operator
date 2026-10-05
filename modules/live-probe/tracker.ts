import { GithubTracker } from "../github-tracker/main.ts";
import { TrackerUpdate } from "../tracker-update/main.ts";
import type { Fixture, Write } from "./recovery.ts";
import { failed, passed, type Staged, skipped } from "./stage.ts";

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

type BeforeWrite = (write: Write) => Promise<void>;

type StepIntent =
  | { step: "resolution"; body: string }
  | {
      step: "map_amendment";
      decisionLink: string;
      baselineIdentity: string;
      sections: string[];
      supersedes: string[];
      body: string;
    }
  | { step: "completion"; reason: "completed" };

type WriteAnswer = Awaited<ReturnType<typeof TrackerUpdate.write>>;

type Stepped =
  | { status: "unplanned"; planned: string }
  | { status: "unwritten"; written: Exclude<WriteAnswer, { status: "succeeded" }> }
  | { status: "written"; operationId: string; resourceId: string; expectedActor: string };

/**
 * Writes one fixture step through the supported path, exactly as the workflow writes it.
 * The journal holds the intent before the request and the outcome after it, so recovery settles
 * a lost answer by reading rather than by sending the write again.
 */
async function writeStep(
  fixture: Fixture,
  beforeWrite: BeforeWrite,
  request: { issue: number; intent: StepIntent },
): Promise<Stepped> {
  const operationId = crypto.randomUUID();
  const target = { repository: fixture.repository, issue: request.issue };
  const step = request.intent;
  const planned = await TrackerUpdate.plan({
    provider: PROVIDER,
    operationId,
    intent: { ...step, target },
  });
  if (planned.status !== "planned") return { status: "unplanned", planned: planned.status };
  const send =
    step.step === "completion"
      ? { provider: PROVIDER, target, step: step.step, closeReason: step.reason }
      : planned.content === null
        ? null
        : { provider: PROVIDER, target, step: step.step, content: planned.content };
  if (send === null) return { status: "unplanned", planned: planned.status };

  const intent = {
    operationId,
    step: step.step,
    issue: request.issue,
    expectedActor: planned.expectedActor,
    contentIdentity: planned.contentIdentity,
  };
  await beforeWrite(intent);
  const written = await TrackerUpdate.write(send);
  await beforeWrite({ ...intent, outcome: written.status });
  if (written.status !== "succeeded") return { status: "unwritten", written };

  return {
    status: "written",
    operationId,
    resourceId: written.resourceId,
    expectedActor: planned.expectedActor,
  };
}

type Written =
  | { status: "written"; operationId: string; resourceId: string; expectedActor: string }
  | { status: "unwritten"; detail: string };

/** Writes one comment, and names why it did not land in the words every comment check uses. */
async function writeComment(
  fixture: Fixture,
  beforeWrite: BeforeWrite,
  request: { issue: number; intent: Exclude<StepIntent, { step: "completion" }> },
): Promise<Written> {
  const stepped = await writeStep(fixture, beforeWrite, request);
  if (stepped.status === "unplanned") {
    return { status: "unwritten", detail: `The write could not be planned: ${stepped.planned}` };
  }
  if (stepped.status === "unwritten") {
    const written = stepped.written;
    return {
      status: "unwritten",
      detail: `The write did not land: ${written.status}${"detail" in written ? ` (${written.detail})` : ""}`,
    };
  }
  return stepped;
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

type Linked = {
  coverage: { complete: boolean; detail: string | null };
  issues: Array<{ number: number; state: string }>;
};

/** One read of the issues linked to the fixture. An empty answer leaves the check unproven. */
function linkCheck(name: string, noun: string, read: Linked, endpoint: string): Staged {
  if (!read.coverage.complete) {
    return failed(
      name,
      `The ${noun} read did not cover every page: ${read.coverage.detail ?? "it answered no coverage"}`,
    );
  }
  if (read.issues.length === 0) {
    return skipped(
      name,
      `The fixture issue reports no ${noun}, so nothing proved that \`${endpoint}\` is read correctly. Give the probe fixture at least one.`,
    );
  }

  return passed(name, `The fixture issue reports ${read.issues.length} ${noun}.`, {
    outputs: read.issues.map((one) => `#${one.number} ${one.state}`),
  });
}

type CheckRequest = { probeId: string; runId: string; beforeWrite: BeforeWrite };
type Checked = { staged: Staged[]; resources: string[] };

/** Writes a comment on the fixture issue and reads it back by identifier and by a full scan. */
async function commentChecks(fixture: Fixture, request: CheckRequest): Promise<Checked> {
  const target = { repository: fixture.repository, issue: fixture.issue };
  const comment = await writeComment(fixture, request.beforeWrite, {
    issue: fixture.issue,
    intent: {
      step: "resolution",
      body: `## Resolution\n\nOperator live probe ${request.probeId} wrote this synthetic comment.`,
    },
  });
  if (comment.status !== "written") {
    return {
      staged: [
        failed("github-comment", comment.detail),
        skipped("github-pagination", "No probe comment was written to look for."),
      ],
      resources: [],
    };
  }

  const resources = [`github comment ${fixture.repository}#${fixture.issue}/${comment.resourceId}`];
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
  const readBack =
    known.observation.kind === "comment" && known.observation.lookup === "known-id"
      ? passed(
          "github-comment",
          `Comment ${comment.resourceId} was written by ${comment.expectedActor} and read back by its own identifier.`,
          {
            outputs: [`comment ${comment.resourceId}`, `verdict ${known.verdict.reason}`],
            evidence: [
              { label: "fixture comment", path: null, identity: comment.operationId },
              { label: "fixture targets", path: null, identity: targetsOf(fixture).join(" ") },
            ],
            cleanup: {
              state: "retained",
              detail: "The synthetic comment stays on the fixture issue as evidence.",
            },
          },
        )
      : failed("github-comment", `The written comment was not read back: ${known.verdict.reason}`);

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
  const pagination =
    coverage?.complete === true
      ? passed(
          "github-pagination",
          `The comment scan covered ${coverage.pages} pages and ${coverage.count} comments of the fixture issue.`,
          { outputs: [`pages ${coverage.pages}`, `comments ${coverage.count}`] },
        )
      : failed(
          "github-pagination",
          `The comment scan did not cover every page: ${coverage?.detail ?? "it answered no coverage"}`,
        );
  return { staged: [readBack, pagination], resources };
}

/** Reads the fixture map back and proves the amendment stands apart from the ordinary comment. */
async function amendmentRead(fixture: Fixture, mapIssue: number, operationId: string) {
  const read = await TrackerUpdate.readMap({
    provider: PROVIDER,
    target: { repository: fixture.repository, issue: mapIssue },
  });
  if (read.status !== "read") {
    return failed("github-amendment", `The fixture map could not be read: ${read.status}`);
  }
  const reading = read.reading;
  if (reading.ordinaryComments === 0) {
    return failed(
      "github-amendment",
      "The map reader counted the ordinary comment as an amendment, so it does not tell the two apart.",
    );
  }
  const effective = reading.effective.some((one) => one.operationId === operationId);
  if (!effective || reading.problems.length > 0) {
    return failed(
      "github-amendment",
      `The amendment did not read back as one: ${reading.problems.map((one) => one.detail).join(" ") || "it is not effective"}`,
    );
  }
  return passed(
    "github-amendment",
    `The amendment stands on the fixture map, beside ${reading.ordinaryComments} ordinary comments that are not amendments.`,
    {
      outputs: [
        `amendments ${reading.amendments.length}`,
        `ordinary comments ${reading.ordinaryComments}`,
      ],
      evidence: [{ label: "map baseline", path: null, identity: reading.baselineIdentity }],
      cleanup: {
        state: "retained",
        detail: "The synthetic amendment stays on the fixture map as evidence.",
      },
    },
  );
}

/** Writes an ordinary comment and then an amendment on the fixture map, and reads both back. */
async function amendmentCheck(fixture: Fixture, request: CheckRequest): Promise<Checked> {
  const mapIssue = fixture.mapIssue ?? fixture.issue;
  const baseline = await baselineIdentityOf(fixture, mapIssue);
  if (typeof baseline !== "string") {
    return {
      staged: [failed("github-amendment", `The fixture map could not be read: ${baseline.detail}`)],
      resources: [],
    };
  }

  // An ordinary comment goes on the map first, so the check proves the reader tells the two
  // apart instead of only proving that an amendment is found.
  const discussion = await writeComment(fixture, request.beforeWrite, {
    issue: mapIssue,
    intent: {
      step: "resolution",
      body: `## Resolution\n\nOperator live probe ${request.probeId} wrote this ordinary comment, and it is not an amendment.`,
    },
  });
  const amendment = await writeComment(fixture, request.beforeWrite, {
    issue: mapIssue,
    intent: {
      step: "map_amendment",
      decisionLink: `https://github.com/${fixture.repository}/issues/${fixture.issue}`,
      baselineIdentity: baseline,
      sections: [`Live probe ${request.runId}`],
      supersedes: [],
      body: "- The live probe wrote this synthetic amendment.",
    },
  });
  if (discussion.status !== "written") {
    return {
      staged: [
        failed("github-amendment", `The ordinary map comment did not land: ${discussion.detail}`),
      ],
      resources: [],
    };
  }
  const resources = [`github comment ${fixture.repository}#${mapIssue}/${discussion.resourceId}`];
  if (amendment.status !== "written") {
    return { staged: [failed("github-amendment", amendment.detail)], resources };
  }
  resources.push(`github comment ${fixture.repository}#${mapIssue}/${amendment.resourceId}`);
  return {
    staged: [await amendmentRead(fixture, mapIssue, amendment.operationId)],
    resources,
  };
}

/**
 * Reads the issues linked to the fixture.
 * An empty list reads the same whether the API works or answers nothing, so a read that
 * returns none proves nothing about the behaviour and the fixture has to hold one.
 */
async function linkChecks(fixture: Fixture): Promise<Checked> {
  const target = { repository: fixture.repository, issue: fixture.issue };
  const blocked = await GithubTracker.readBlockedBy(target);
  const dependencies = linkCheck(
    "github-dependencies",
    "issues that block it",
    blocked,
    "blockedBy",
  );
  const subIssues = await GithubTracker.readSubIssues(target);
  return {
    staged: [dependencies, linkCheck("github-sub-issues", "sub-issues", subIssues, "sub_issues")],
    resources: [],
  };
}

type Closed =
  | { status: "stopped"; closure: Staged; events: Staged }
  | {
      status: "closed";
      operationId: string;
      expectedActor: string;
      observed: ClosureObservation | null;
      reason: string;
    };
type ClosureObservation = Extract<
  Awaited<ReturnType<typeof TrackerUpdate.read>>["observation"],
  { kind: "closure" }
>;

/**
 * Closes the fixture issue with an explicit reason and reads the closure back.
 * A fixture that is not open already is left exactly as it is, because reopening it would
 * change a state the probe never set and the probe restores nothing it did not do.
 */
async function closeFixture(fixture: Fixture, beforeWrite: BeforeWrite): Promise<Closed> {
  const target = { repository: fixture.repository, issue: fixture.issue };
  const before = await GithubTracker.readIssue(target);
  if (before.status !== "found" || before.value.state !== "open") {
    const detail =
      before.status === "found"
        ? `The probe fixture issue #${fixture.issue} is ${before.value.state}, and the closure check needs an open one. Nothing was written.`
        : `The state of the probe fixture issue could not be read, so nothing was written: ${before.status === "absent" ? "it is not there" : before.detail}`;
    const skip = {
      closure: skipped("github-closure", detail),
      events: skipped("github-events", detail),
    };
    return { status: "stopped", ...skip };
  }

  const stepped = await writeStep(fixture, beforeWrite, {
    issue: fixture.issue,
    intent: { step: "completion", reason: "completed" },
  });
  if (stepped.status !== "written") {
    const detail =
      stepped.status === "unplanned"
        ? `The closure could not be planned: ${stepped.planned}`
        : `The fixture issue did not close: ${stepped.written.status}`;
    return {
      status: "stopped",
      closure: failed("github-closure", detail),
      events: skipped("github-events", detail),
    };
  }

  const read = await TrackerUpdate.read({
    provider: PROVIDER,
    step: "completion",
    target,
    operationId: stepped.operationId,
    expectedActor: stepped.expectedActor,
    contentIdentity: null,
    resourceId: stepped.resourceId,
    intendedReason: "completed",
    writes: ["succeeded"],
    now: new Date().toISOString(),
  });
  return {
    status: "closed",
    operationId: stepped.operationId,
    expectedActor: stepped.expectedActor,
    observed: read.observation.kind === "closure" ? read.observation : null,
    reason: read.verdict.reason,
  };
}

/**
 * Reopens the fixture issue the probe closed, so it is back as the probe found it.
 * The reopen also makes the reopen event the history check reads.
 */
async function restoreFixture(
  fixture: Fixture,
  beforeWrite: BeforeWrite,
  closed: Extract<Closed, { status: "closed" }>,
): Promise<Staged["cleanup"]> {
  const target = { repository: fixture.repository, issue: fixture.issue };
  const reopenIntent = {
    operationId: crypto.randomUUID(),
    step: "reopen" as const,
    issue: fixture.issue,
    expectedActor: closed.expectedActor,
    contentIdentity: null,
    eventCount: closed.observed?.eventCoverage.complete ? closed.observed.events.length : null,
  };
  await beforeWrite(reopenIntent);
  const reopened = await GithubTracker.reopenIssue(target);
  await beforeWrite({ ...reopenIntent, outcome: reopened.status });
  return reopened.status === "succeeded"
    ? { state: "removed", detail: `Issue #${fixture.issue} was reopened as it was found.` }
    : {
        state: "failed",
        detail: `Issue #${fixture.issue} is still closed: the reopen answered ${reopened.status}.`,
      };
}

/** Reads the fixture history and proves it holds both the close and the reopen. */
async function eventsCheck(fixture: Fixture, probeId: string): Promise<Staged> {
  const history = await GithubTracker.readEvents({
    repository: fixture.repository,
    issue: fixture.issue,
  });
  const names = history.events.map((one) => one.event);
  if (!history.coverage.complete) {
    return failed(
      "github-events",
      `The event read did not cover every page: ${history.coverage.detail ?? "it answered no coverage"}`,
    );
  }
  return names.includes("closed") && names.includes("reopened")
    ? passed(
        "github-events",
        `The fixture history holds ${history.events.length} events, including the close and the reopen probe ${probeId} made.`,
        { outputs: names },
      )
    : failed(
        "github-events",
        `The fixture history does not hold both a close and a reopen: it holds ${names.join(", ") || "no events"}.`,
      );
}

/** Closes the fixture, puts it back as it was found, and reads the history of both. */
async function closureChecks(fixture: Fixture, request: CheckRequest): Promise<Checked> {
  const closed = await closeFixture(fixture, request.beforeWrite);
  if (closed.status === "stopped")
    return { staged: [closed.closure, closed.events], resources: [] };

  const restored = await restoreFixture(fixture, request.beforeWrite, closed);
  const observed = closed.observed;
  const closure =
    observed?.state === "closed" && observed.stateReason === "completed"
      ? passed(
          "github-closure",
          `The fixture issue closed as ${observed.stateReason} by ${observed.closedBy ?? "an unnamed account"}, and the reason was read back.`,
          {
            outputs: [`state ${observed.state}`, `reason ${observed.stateReason}`],
            evidence: [{ label: "closure operation", path: null, identity: closed.operationId }],
            cleanup: restored,
          },
        )
      : failed(
          "github-closure",
          `The fixture issue did not close with the intended reason: ${closed.reason}`,
          { cleanup: restored },
        );
  return { staged: [closure, await eventsCheck(fixture, request.probeId)], resources: [] };
}

/** The fixture checks in the one order their evidence allows. */
const FIXTURE_CHECKS = [commentChecks, amendmentCheck, linkChecks, closureChecks];

/**
 * Runs every GitHub fixture check against the configured fixture and nothing else.
 * The probe closes the fixture issue and puts it back as it found it, so a rerun starts from the
 * same state and no project issue is ever named.
 */
export async function runTrackerChecks(request: {
  fixture: Fixture | null;
  probeId: string;
  runId: string;
  beforeWrite: BeforeWrite;
}): Promise<Checked> {
  const fixture = request.fixture;
  if (fixture === null) {
    return {
      staged: TRACKER_CHECKS.map((name) =>
        skipped(
          name,
          "No probe fixture is configured, so this check reached no tracker. Plan the fixture with `operator config plan --set probe.githubFixture.repository=<owner/repo> --set probe.githubFixture.issue=<number>`. Add `--set probe.githubFixture.mapIssue=<number>` when the map issue is a different issue. Apply the plan with `operator config apply`, the same `--set` flags, and `--approved-plan <planId>`.",
        ),
      ),
      resources: [],
    };
  }

  const staged: Staged[] = [];
  const resources: string[] = [];
  for (const check of FIXTURE_CHECKS) {
    const checked = await check(fixture, request);
    staged.push(...checked.staged);
    resources.push(...checked.resources);
  }
  return { staged, resources };
}
