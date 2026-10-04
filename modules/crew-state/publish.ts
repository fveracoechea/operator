import { eq } from "drizzle-orm";
import { z } from "zod";
import { PullRequestStack } from "../pull-request-stack/main.ts";
import { approvedPlan, PUBLISH_ACTION } from "./approvals.ts";
import type { CrewReader, CrewWriter } from "./database.ts";
import { identityOf } from "./identity.ts";
import { mapIssueOf } from "./map-amendment.ts";
import { mutate, readState, type RequestFailure, type StateFailure } from "./operations.ts";
import { Publication } from "./publication-machine.ts";
import { type PublishRecords, publishRecordsOf, type RecordRefusal } from "./publish-gate.ts";
import { conflictSettled, conflictSettlementOf } from "./stack-parts.ts";
import { publishEffects, stackPublications, stackPullRequests } from "./schema.ts";
import {
  appendEffects,
  effectsOf,
  type EffectRow,
  type PublicationRow,
  publicationsOf,
  pullsOf,
  type StoredEffect,
  storedEffect,
} from "./stack-records.ts";
import { readStored } from "./stored.ts";

type ModulePlan = Extract<Awaited<ReturnType<typeof PullRequestStack.plan>>, { status: "planned" }>;
type Ships = NonNullable<ModulePlan["ships"]>;
type WriteOutcome = Awaited<ReturnType<typeof PullRequestStack.write>>;

/** One refusal of a publish plan, from the records or from the module, in the order found. */
export type PublishRefusal = RecordRefusal | ModulePlan["refusals"][number];

export type ApprovalRequest = {
  action: string;
  targets: string[];
  scope: string;
  requestRevision: string;
};

/**
 * What one plan ships: nothing, or the parts with the revision and the approval that binds them.
 * A plan that ships is ready to apply once it has no refusal.
 */
type PlannedShips =
  | { planRevision: null; ships: null; approval: null }
  | { planRevision: string; ships: Ships; approval: ApprovalRequest };

type UnwrittenPreview = PlannedShips & {
  status: "planned";
  sourceId: string;
  repository: string | null;
  publication: number;
  info: ModulePlan["info"] | null;
  refusals: PublishRefusal[];
  /** The open pull requests of an ended publication that this one replaces and closes. */
  closes: ReplacedPull[];
  /** The replaced pull requests whose head a person moved, which get no write (decision 21). */
  headMoved: ReplacedPull[];
};

export type PublishPreview = UnwrittenPreview & { planPath: string };

/** One open pull request of an ended publication, which the next publication closes. */
export type ReplacedPull = { number: number; url: string | null; head: string };

/** The approval target of the close of one replaced pull request (decisions 9 and 23). */
export function closeTarget(repository: string, number: number): string {
  return `${repository}#${number}`;
}

const PLAN_STORE = ".operator/local/publish-plans";

/**
 * The writes of one publication that are not done, in order. A conflict that a person settled is
 * done for Operator: it stands as GitHub shows it, and nothing repeats it (#120).
 */
export function openEffectsOf(db: CrewReader, publication: PublicationRow): EffectRow[] {
  return effectsOf(db, publication.id).filter(
    (one) => one.state !== "done" && !conflictSettled(db, publication.sourceId, one),
  );
}

/** The publication of one source whose writes are not all done, which only a settle finishes. */
export function openPublicationOf(
  db: CrewReader,
  sourceId: string,
): { publication: PublicationRow; open: EffectRow[] } | null {
  for (const publication of publicationsOf(db, sourceId)) {
    const open = openEffectsOf(db, publication);
    if (open.length > 0) {
      return { publication, open };
    }
  }
  return null;
}

/** The approval target of one tracker step after the merge, named in the publish approval. */
export function trackerStepTarget(
  closes: string,
  step: "resolution" | "completion" | "map_amendment",
): string {
  return `github:${closes}:${step}`;
}

/**
 * The approval request one plan revision needs. It names each new remote name, the target, and
 * each tracker step after the merge, whose text the plan already rendered (D2).
 */
export function approvalRequestOf(
  sourceId: string,
  revision: string,
  ships: Ships,
  closes: { repository: string; pulls: ReplacedPull[] },
): ApprovalRequest {
  return {
    action: PUBLISH_ACTION,
    targets: [
      ...ships.parts.map((one) => one.name),
      ships.target,
      ...ships.trackerSteps.flatMap((one) => [
        trackerStepTarget(one.closes, "resolution"),
        trackerStepTarget(one.closes, "completion"),
      ]),
      ...closes.pulls.map((one) => closeTarget(closes.repository, one.number)),
    ],
    scope: sourceId,
    requestRevision: revision,
  };
}

/** One section of the preview: its head, its items, and its tail. With no item, it is left out. */
function section(head: string[], items: string[], tail: string[] = []): string[] {
  return items.length === 0 ? [] : [...head, ...items, ...tail];
}

/** The lines that name what the module read of the target, or nothing before a read. */
function infoLines(info: UnwrittenPreview["info"]): string[] {
  if (info === null) {
    return [];
  }
  const merges = info.mergesCleanly === null ? "unread" : info.mergesCleanly ? "yes" : "no";
  return [
    `- Target tip: ${info.targetTip ?? "unread"}`,
    `- Commits on the target since the base: ${info.commitsBehind ?? "unread"}`,
    `- The head merges cleanly onto the tip: ${merges}`,
    `- Other merge methods the repository allows: ${info.otherMethodsAllowed.join(", ") || "none"}`,
    ...info.unverifiedRules.map((one) => `- Unverified: ${one}`),
  ];
}

/** The tracker steps after the merge, each with its resolution text verbatim (D2). */
function trackerStepLines(preview: UnwrittenPreview): string[] {
  const steps = preview.ships?.trackerSteps ?? [];
  const approved = preview.approval?.targets ?? [];
  return steps.flatMap((step) => [
    `### ${trackerStepTarget(step.closes, "resolution")} and ${trackerStepTarget(step.closes, "completion")}`,
    "",
    "<!-- resolution start -->",
    step.resolution.trimEnd(),
    "<!-- resolution end -->",
    "",
    ...(approved.includes(trackerStepTarget(step.closes, "map_amendment"))
      ? [
          `### ${trackerStepTarget(step.closes, "map_amendment")}`,
          "",
          "The map amendment of this item runs after the merge, and only after a second approval, `map-amendment`, binds the exact text that the CLI renders then.",
          "",
        ]
      : []),
  ]);
}

/** Each pull request the plan creates, with its title and its body verbatim. */
function partLines(ships: Ships | null): string[] {
  const parts = ships?.parts ?? [];
  return parts.flatMap((part, index) => [
    `## Pull request ${index + 1} of ${parts.length}: ${part.name} into ${part.base}`,
    "",
    ...(part.cut === null ? [] : [`Cut after ${part.cut.after}: ${part.cut.reason}`, ""]),
    `Title: ${part.title}`,
    "",
    "The body, exactly as it is created:",
    "",
    "<!-- body start -->",
    part.body.trimEnd(),
    "<!-- body end -->",
    "",
  ]);
}

/**
 * The full preview, written to a local file. The person approves the exact text, so every title
 * and body is there verbatim, while the command report stays a summary that points here.
 */
export function previewText(preview: UnwrittenPreview): string {
  const { ships } = preview;
  return [
    `# Publish plan ${preview.planRevision ?? "(refused)"}`,
    "",
    `- Source: ${preview.sourceId}`,
    `- Stack publication: ${preview.publication}`,
    ...(ships === null
      ? []
      : [
          `- Remote: ${ships.remote.name} (${ships.remote.url})`,
          `- Target branch: ${ships.target}`,
          `- Integration base: ${ships.base}`,
          `- Head: ${ships.head}`,
          `- New remote branches: ${ships.parts.map((one) => one.name).join(", ")}`,
        ]),
    ...infoLines(preview.info),
    "",
    ...section(
      [
        "## Pull requests this publication closes",
        "",
        "Each one gets one comment that names its replacement, then it is closed with no merge. Its branch stays.",
        "",
      ],
      preview.closes.map((one) => `- #${one.number}${one.url === null ? "" : ` ${one.url}`}`),
      [""],
    ),
    ...section(
      [
        "## Replaced pull requests that get no write",
        "",
        "A person moved the head of each one, so Operator writes nothing more to it, no comment and no close (decision 21). A person closes it.",
        "",
      ],
      preview.headMoved.map(
        (one) => `- #${one.number} gets no write${one.url === null ? "" : `: ${one.url}`}`,
      ),
      [""],
    ),
    "## Refusals",
    "",
    ...(preview.refusals.length === 0
      ? ["None."]
      : preview.refusals.map((one) => `- ${one.reason}: ${one.detail}`)),
    "",
    ...section(
      [
        "## Tracker steps after the merge",
        "",
        "Each step runs only after its pull request merged into the target, under this approval.",
        `The completion step closes the ticket as completed, or observes the close that its closing keyword made.`,
        "The resolution is this text, with the number GitHub gives the pull request.",
        "After a merge that is not a merge commit, it names the commit that landed and the method instead.",
        "",
      ],
      trackerStepLines(preview),
    ),
    ...partLines(ships),
  ].join("\n");
}

/**
 * Plans one stack publication of one source and changes nothing: no crew state, no ref, and
 * nothing on GitHub. Every refusal is reported at once, in the fixed order of decision 10.
 */
export async function planPublish(request: {
  projectRoot: string;
  sourceId: string;
  /** The open pull requests of an ended publication, read by the caller (decision 23). */
  replaces: ReplacedPull[];
  /** The replaced pull requests whose head a person moved, which get no write (decision 21). */
  headMoved: ReplacedPull[];
}): Promise<
  | PublishPreview
  | StateFailure
  | { status: "unknown-source"; sourceId: string }
  | { status: "unread"; detail: string }
> {
  const read = await readState(request.projectRoot, (db) => ({
    records: publishRecordsOf(db, request.sourceId),
    publication: publicationsOf(db, request.sourceId).length + 1,
    mapIssue: mapIssueOf(db, request.sourceId) !== null,
  }));
  if ("status" in read) {
    return read;
  }
  const { records } = read;
  if (records.repository === null && records.base === null) {
    return { status: "unknown-source", sourceId: request.sourceId };
  }
  const stack = await stackPlanOf(request.projectRoot, records, read.publication);
  if ("status" in stack) {
    return stack;
  }

  const plan = plannedShipsOf(request.sourceId, stack.planned?.ships ?? null, {
    repository: records.repository ?? "",
    pulls: request.replaces,
  });
  const shown: UnwrittenPreview = {
    status: "planned",
    sourceId: request.sourceId,
    repository: records.repository,
    publication: read.publication,
    ...(read.mapIssue ? withMapAmendments(plan) : plan),
    info: stack.planned?.info ?? null,
    refusals: stack.refusals,
    closes: request.replaces,
    headMoved: request.headMoved,
  };
  const name = plan.planRevision ?? `refused-${identityOf(shown).slice(0, 16)}`;
  const planPath = `${PLAN_STORE}/${name}.md`;
  await Bun.write(`${request.projectRoot}/${planPath}`, `${previewText(shown)}\n`, {
    createPath: true,
  });
  return { ...shown, planPath };
}

/**
 * The module step of one plan: the refusals of the records, then the plan of the stack when the
 * records name a repository, a base, a head, and a commit to publish.
 */
async function stackPlanOf(
  projectRoot: string,
  records: PublishRecords,
  publication: number,
): Promise<
  { planned: ModulePlan | null; refusals: PublishRefusal[] } | { status: "unread"; detail: string }
> {
  if (records.repository === null) {
    const unread = {
      reason: "repository_unread" as const,
      detail: `Source ${records.sourceId} records no tracker repository.`,
    };
    return { planned: null, refusals: [...records.refusals, unread] };
  }
  if (records.base === null || records.head === null || records.commits.length === 0) {
    return { planned: null, refusals: [...records.refusals] };
  }
  const planned = await PullRequestStack.plan({
    repoRoot: projectRoot,
    repository: records.repository,
    sourceSlug: records.slug,
    publication,
    branch: { base: records.publishBase ?? records.base, head: records.head },
    commits: records.commits.map((one) => ({
      commit: one.commit,
      closes: one.closes,
      behaviorChanges: one.behaviorChanges,
      concerns: one.concerns,
    })),
    text: records.text,
    verified: records.verified,
    rejected: records.rejected,
    deferred: records.deferred,
  });
  if (planned.status === "unread") {
    return planned;
  }
  // A missing review already names its missing text, so the text is not refused twice.
  const reviewed = !records.refusals.some((one) => one.reason === "branch_review_missing");
  return {
    planned,
    refusals: [
      ...records.refusals,
      ...planned.refusals.filter((one) => reviewed || one.reason !== "section_missing"),
    ],
  };
}

/** What one plan ships, with the revision and the approval that bind it, or nothing. */
function plannedShipsOf(
  sourceId: string,
  ships: Ships | null,
  closes: { repository: string; pulls: ReplacedPull[] },
): PlannedShips {
  if (ships === null) {
    return { planRevision: null, ships: null, approval: null };
  }
  // A close is part of what ships, so the approval binds it. With none, the revision is unchanged.
  const planRevision =
    closes.pulls.length === 0 ? identityOf(ships) : identityOf({ ships, closes: closes.pulls });
  return {
    planRevision,
    ships,
    approval: approvalRequestOf(sourceId, planRevision, ships, closes),
  };
}

/**
 * The preview of a source that has a map issue. Its approval also names the map amendment of
 * each item, which waits after the merge for a second approval of its own text (D2).
 */
function withMapAmendments(plan: PlannedShips): PlannedShips {
  return plan.approval === null
    ? plan
    : {
        ...plan,
        approval: {
          ...plan.approval,
          targets: [
            ...plan.approval.targets,
            ...plan.ships.trackerSteps.map((one) => trackerStepTarget(one.closes, "map_amendment")),
          ],
        },
      };
}

/** Records the publication and every write of it as an intent, before the first write. */
function recordPublication(
  db: CrewWriter,
  request: {
    preview: Extract<PublishPreview, { planRevision: string }>;
    repository: string;
    approvalId: string;
    now: string;
  },
): { status: "recorded"; publicationId: string } {
  const { preview } = request;
  const publicationId = crypto.randomUUID();
  db.insert(stackPublications)
    .values({
      id: publicationId,
      sourceId: preview.sourceId,
      number: preview.publication,
      planRevision: preview.planRevision,
      approvalId: request.approvalId,
      remote: preview.ships.remote.name,
      target: preview.ships.target,
      baseCommit: preview.ships.base,
      headCommit: preview.ships.head,
      createdAt: request.now,
      trackerSteps: JSON.stringify(preview.ships.trackerSteps),
    })
    .run();
  const effects: StoredEffect[] = [
    {
      kind: "push",
      remote: preview.ships.remote.name,
      refs: preview.ships.parts.map((one) => ({ name: one.name, commit: one.commit })),
    },
    // Bottom up, so each higher part can name the number of the one below it.
    ...preview.ships.parts.map((one) => ({
      kind: "create" as const,
      repository: request.repository,
      head: one.name,
      base: one.base,
      title: one.title,
      body: one.body,
    })),
    // After every create, so the comment of each close names the replacement.
    ...preview.closes.map((one) => ({
      kind: "close" as const,
      repository: request.repository,
      number: one.number,
      publication: preview.publication,
      head: one.head,
    })),
  ];
  appendEffects(db, { publicationId, effects, now: request.now });
  preview.ships.parts.forEach((one, index) => {
    db.insert(stackPullRequests)
      .values({
        publicationId,
        part: index + 1,
        headName: one.name,
        publishedCommit: one.commit,
        plannedBase: one.base,
        number: null,
        url: null,
      })
      .run();
  });
  return { status: "recorded", publicationId };
}

/** Records the outcome of one write, and the number GitHub gave a created pull request. */
function recordOutcome(
  db: CrewWriter,
  request: { effect: EffectRow; outcome: WriteOutcome; now: string },
): { status: "recorded" } {
  db.update(publishEffects)
    .set({
      state: request.outcome.status,
      outcome: JSON.stringify(request.outcome),
      settledAt: request.now,
    })
    .where(eq(publishEffects.id, request.effect.id))
    .run();
  const intent = storedEffect(request.effect.intent);
  if (request.outcome.status === "done" && intent.kind === "create") {
    db.update(stackPullRequests)
      .set({ number: request.outcome.number, url: request.outcome.url })
      .where(eq(stackPullRequests.headName, intent.head))
      .run();
  }
  return { status: "recorded" };
}

export type ApplyResult =
  | { status: "refused"; preview: PublishPreview }
  | {
      status: "plan-revision-changed";
      stated: string;
      planned: string | null;
      planPath: string | null;
    }
  | { status: "approval-required"; approval: ApprovalRequest; planPath: string }
  | {
      status: "published";
      publication: number;
      pullRequests: Array<{
        part: number;
        headName: string;
        number: number | null;
        url: string | null;
      }>;
    }
  | {
      status: "effect-stopped";
      publication: number;
      effect: { id: string; kind: string; position: number };
      outcome: Exclude<WriteOutcome, { status: "done" }>;
      /** The approval by which a person settles a conflict on an existing pull request. */
      settlement: ApprovalRequest | null;
    }
  | StateFailure
  | RequestFailure
  | { status: "unknown-source"; sourceId: string }
  | { status: "unread"; detail: string };

/** The recorded number of the lowest part of one publication, which a replaced one points to. */
async function firstPartOf(projectRoot: string, publicationId: string): Promise<number | null> {
  const read = await readState(projectRoot, (db) => ({
    first: pullsOf(db, publicationId)[0] ?? null,
  }));
  return "status" in read ? null : (read.first?.number ?? null);
}

/**
 * The recorded number of the part whose remote branch is this base, or null for the lowest part.
 * The creates run bottom up, so the part below is created and numbered by then.
 */
async function belowOf(
  projectRoot: string,
  publicationId: string,
  base: string,
): Promise<number | null> {
  const read = await readState(projectRoot, (db) =>
    pullsOf(db, publicationId).find((one) => one.headName === base),
  );
  return read === undefined || "status" in read ? null : read.number;
}

type ModuleEffect = Parameters<typeof PullRequestStack.write>[0]["effect"];

/** One recorded intent as the module runs it, with each slot it learns at run time. */
async function runnable(
  projectRoot: string,
  publicationId: string,
  intent: StoredEffect,
): Promise<ModuleEffect> {
  switch (intent.kind) {
    case "create":
      return { ...intent, below: await belowOf(projectRoot, publicationId, intent.base) };
    case "recall": {
      const { recall: _recall, ...effect } = intent;
      return effect;
    }
    case "close": {
      const { recall: _recall, ...effect } = intent;
      return {
        ...effect,
        head: effect.head ?? null,
        replacement:
          effect.publication === null ? null : await firstPartOf(projectRoot, publicationId),
      };
    }
    default:
      return intent;
  }
}

/** Runs each write of one publication that is not done, in order, and records each outcome. */
export async function runEffects(
  request: { projectRoot: string; requestId: string; ownerToken: string },
  publicationId: string,
): Promise<ApplyResult> {
  const read = await readState(request.projectRoot, (db) => {
    const publication = db
      .select()
      .from(stackPublications)
      .where(eq(stackPublications.id, publicationId))
      .all()[0];
    const effects = publication === undefined ? [] : openEffectsOf(db, publication);
    return {
      publication,
      effects,
      settlements: new Map(
        effects.map((one) => [one.id, conflictSettlementOf(db, publication?.sourceId ?? "", one)]),
      ),
    };
  });
  if ("status" in read) {
    return read;
  }
  const number = read.publication?.number ?? 0;
  for (const effect of read.effects) {
    const subject = { id: effect.id, kind: effect.kind, position: effect.position };
    // A conflict is something a person settles, so a repeat never writes over it.
    if (effect.state === "conflict") {
      const outcome = readStored(
        "publish effect outcome",
        z.strictObject({ status: z.literal("conflict"), found: z.string() }),
        effect.outcome ?? "{}",
      );
      return {
        status: "effect-stopped",
        publication: number,
        effect: subject,
        outcome,
        settlement: read.settlements.get(effect.id) ?? null,
      };
    }
    const outcome = await PullRequestStack.write({
      repoRoot: request.projectRoot,
      effect: await runnable(request.projectRoot, publicationId, storedEffect(effect.intent)),
    });
    const recorded = await mutate(
      {
        projectRoot: request.projectRoot,
        requestId: `${request.requestId}:${effect.id}`,
        ownerToken: request.ownerToken,
        now: new Date().toISOString(),
        operation: "publish_effect",
        input: { effectId: effect.id, outcome },
      },
      ({ tx, now }) => ({ commit: true, outcome: recordOutcome(tx, { effect, outcome, now }) }),
    );
    if (recorded.result.status !== "recorded") {
      return recorded.result;
    }
    if (outcome.status !== "done") {
      const settlement =
        outcome.status === "conflict"
          ? await readState(request.projectRoot, (db) =>
              conflictSettlementOf(db, read.publication?.sourceId ?? "", {
                ...effect,
                state: outcome.status,
                outcome: JSON.stringify(outcome),
              }),
            )
          : null;
      return {
        status: "effect-stopped",
        publication: number,
        effect: subject,
        outcome,
        settlement: settlement !== null && "status" in settlement ? null : settlement,
      };
    }
  }
  const pullRequests = await readState(request.projectRoot, (db) =>
    pullsOf(db, publicationId).map((one) => ({
      part: one.part,
      headName: one.headName,
      number: one.number,
      url: one.url,
    })),
  );
  if ("status" in pullRequests) {
    return pullRequests;
  }
  return { status: "published", publication: number, pullRequests };
}

/**
 * Publishes exactly the plan that `planPublish` previewed, behind one approval of its revision.
 * A publication with a write that is not done is settled first: each write reads GitHub before
 * it writes, so a repeat after a crash finishes it and never writes twice (`settle_publish`).
 */
export async function applyPublish(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  sourceId: string;
  planRevision: string;
  replaces: ReplacedPull[];
  headMoved: ReplacedPull[];
}): Promise<ApplyResult> {
  const open = await readState(request.projectRoot, (db) =>
    openPublicationOf(db, request.sourceId),
  );
  if (open !== null && "status" in open) {
    return open;
  }
  const stage = Publication.decide("apply", {
    stated: request.planRevision,
    open: open?.publication ?? null,
  });
  if ("refused" in stage) {
    return stage.refused;
  }
  if (stage.next.kind === "settle") {
    return runEffects(request, stage.next.publicationId);
  }

  const planned = await planPublish(request);
  if (planned.status !== "planned") {
    return planned;
  }
  const decided = await approvedPlan(request.projectRoot, planned, request.planRevision);
  if (decided.status === "refused") {
    return { status: "refused", preview: planned };
  }
  if (decided.status !== "approved") {
    return decided;
  }

  const { preview, approvalId } = decided;
  const repository = preview.repository ?? "";
  const recorded = await mutate<
    { status: "recorded"; publicationId: string } | { status: "publication-open" }
  >(
    {
      projectRoot: request.projectRoot,
      requestId: request.requestId,
      ownerToken: request.ownerToken,
      now: new Date().toISOString(),
      operation: "publish_apply",
      input: { sourceId: request.sourceId, planRevision: preview.planRevision },
    },
    ({ tx, now }) => {
      // A publication that another apply recorded since the plan is settled, not recorded twice.
      if (openPublicationOf(tx, request.sourceId) !== null) {
        return { commit: false, outcome: { status: "publication-open" as const } };
      }
      return {
        commit: true,
        outcome: recordPublication(tx, { preview, repository, approvalId, now }),
      };
    },
  );
  if (recorded.result.status === "publication-open") {
    return applyPublish(request);
  }
  if (recorded.result.status !== "recorded") {
    return recorded.result;
  }
  return runEffects(request, recorded.result.publicationId);
}
