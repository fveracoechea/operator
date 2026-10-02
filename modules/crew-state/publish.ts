import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { PullRequestStack } from "../pull-request-stack/main.ts";
import { matchApproval } from "./approvals.ts";
import type { CrewReader, CrewWriter } from "./database.ts";
import { identityOf } from "./identity.ts";
import { mapIssueOf } from "./map-amendment.ts";
import { mutate, readState, type RequestFailure, type StateFailure } from "./operations.ts";
import { publishRecordsOf, type RecordRefusal } from "./publish-gate.ts";
import { publishEffects, stackPublications, stackPullRequests } from "./schema.ts";
import { readStored } from "./stored.ts";

/** The approval action that covers one stack publication (ADR 0022, decision 9). */
export const PUBLISH_ACTION = "publish";

type ModulePlan = Extract<Awaited<ReturnType<typeof PullRequestStack.plan>>, { status: "planned" }>;
type Ships = NonNullable<ModulePlan["ships"]>;
type Effect = Parameters<typeof PullRequestStack.write>[0]["effect"];
type WriteOutcome = Awaited<ReturnType<typeof PullRequestStack.write>>;

/** One refusal of a publish plan, from the records or from the module, in the order found. */
export type PublishRefusal = RecordRefusal | ModulePlan["refusals"][number];

export type ApprovalRequest = {
  action: string;
  targets: string[];
  scope: string;
  requestRevision: string;
};

export type PublishPreview = {
  status: "planned";
  sourceId: string;
  repository: string | null;
  publication: number;
  planRevision: string | null;
  ships: Ships | null;
  info: ModulePlan["info"] | null;
  refusals: PublishRefusal[];
  approval: ApprovalRequest | null;
  planPath: string;
};

const PLAN_STORE = ".operator/local/publish-plans";

const effectSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("push"),
    remote: z.string(),
    refs: z.array(z.strictObject({ name: z.string(), commit: z.string() })),
  }),
  z.strictObject({
    kind: z.literal("create"),
    repository: z.string(),
    head: z.string(),
    base: z.string(),
    title: z.string(),
    body: z.string(),
  }),
]);

type PublicationRow = typeof stackPublications.$inferSelect;
type EffectRow = typeof publishEffects.$inferSelect;

export function publicationsOf(db: CrewReader, sourceId: string): PublicationRow[] {
  return db
    .select()
    .from(stackPublications)
    .where(eq(stackPublications.sourceId, sourceId))
    .orderBy(asc(stackPublications.number))
    .all();
}

export function effectsOf(db: CrewReader, publicationId: string): EffectRow[] {
  return db
    .select()
    .from(publishEffects)
    .where(eq(publishEffects.publicationId, publicationId))
    .orderBy(asc(publishEffects.position))
    .all();
}

export function pullRequestsOf(db: CrewReader, publicationId: string) {
  return db
    .select()
    .from(stackPullRequests)
    .where(eq(stackPullRequests.publicationId, publicationId))
    .orderBy(asc(stackPullRequests.part))
    .all();
}

/** The publication of one source whose writes are not all done, which only a settle finishes. */
export function openPublicationOf(
  db: CrewReader,
  sourceId: string,
): { publication: PublicationRow; open: EffectRow[] } | null {
  for (const publication of publicationsOf(db, sourceId)) {
    const open = effectsOf(db, publication.id).filter((one) => one.state !== "done");
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
    ],
    scope: sourceId,
    requestRevision: revision,
  };
}

/**
 * The full preview, written to a local file. The person approves the exact text, so every title
 * and body is there verbatim, while the command report stays a summary that points here.
 */
function previewText(preview: Omit<PublishPreview, "planPath">): string {
  const { ships, info } = preview;
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
    ...(info === null
      ? []
      : [
          `- Target tip: ${info.targetTip ?? "unread"}`,
          `- Commits on the target since the base: ${info.commitsBehind ?? "unread"}`,
          `- The head merges cleanly onto the tip: ${info.mergesCleanly === null ? "unread" : info.mergesCleanly ? "yes" : "no"}`,
          `- Other merge methods the repository allows: ${info.otherMethodsAllowed.join(", ") || "none"}`,
          ...info.unverifiedRules.map((one) => `- Unverified: ${one}`),
        ]),
    "",
    "## Refusals",
    "",
    ...(preview.refusals.length === 0
      ? ["None."]
      : preview.refusals.map((one) => `- ${one.reason}: ${one.detail}`)),
    "",
    ...(ships === null || ships.trackerSteps.length === 0
      ? []
      : [
          "## Tracker steps after the merge",
          "",
          "Each step runs only after its pull request merged into the target, under this approval.",
          `The completion step closes the ticket as completed, or observes the close that its closing keyword made.`,
          "The resolution is this text, with the number GitHub gives the pull request.",
          "After a merge that is not a merge commit, it names the commit that landed and the method instead.",
          "",
          ...ships.trackerSteps.flatMap((step) => [
            `### ${trackerStepTarget(step.closes, "resolution")} and ${trackerStepTarget(step.closes, "completion")}`,
            "",
            "<!-- resolution start -->",
            step.resolution.trimEnd(),
            "<!-- resolution end -->",
            "",
            ...(preview.approval?.targets.includes(trackerStepTarget(step.closes, "map_amendment"))
              ? [
                  `### ${trackerStepTarget(step.closes, "map_amendment")}`,
                  "",
                  "The map amendment of this item runs after the merge, and only after a second approval, `map-amendment`, binds the exact text that the CLI renders then.",
                  "",
                ]
              : []),
          ]),
        ]),
    ...(ships?.parts ?? []).flatMap((part, index) => [
      `## Pull request ${index + 1} of ${ships?.parts.length ?? 1}: ${part.name} into ${part.base}`,
      "",
      `Title: ${part.title}`,
      "",
      "The body, exactly as it is created:",
      "",
      "<!-- body start -->",
      part.body.trimEnd(),
      "<!-- body end -->",
      "",
    ]),
  ].join("\n");
}

/**
 * Plans one stack publication of one source and changes nothing: no crew state, no ref, and
 * nothing on GitHub. Every refusal is reported at once, in the fixed order of decision 10.
 */
export async function planPublish(request: {
  projectRoot: string;
  sourceId: string;
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

  let planned: ModulePlan | null = null;
  const refusals: PublishRefusal[] = [...records.refusals];
  if (records.repository === null) {
    refusals.push({
      reason: "repository_unread",
      detail: `Source ${request.sourceId} records no tracker repository.`,
    });
  } else if (records.base !== null && records.head !== null && records.commits.length > 0) {
    const module = await PullRequestStack.plan({
      repoRoot: request.projectRoot,
      repository: records.repository,
      sourceSlug: records.slug,
      publication: read.publication,
      branch: { base: records.base, head: records.head },
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
    if (module.status === "unread") {
      return module;
    }
    planned = module;
    // A missing review already names its missing text, so the text is not refused twice.
    const reviewed = !records.refusals.some((one) => one.reason === "branch_review_missing");
    refusals.push(...module.refusals.filter((one) => reviewed || one.reason !== "section_missing"));
  }

  const ships = planned?.ships ?? null;
  const planRevision = ships === null ? null : identityOf(ships);
  const preview = {
    status: "planned" as const,
    sourceId: request.sourceId,
    repository: records.repository,
    publication: read.publication,
    planRevision,
    ships,
    info: planned?.info ?? null,
    refusals,
    approval:
      ships === null || planRevision === null
        ? null
        : approvalRequestOf(request.sourceId, planRevision, ships),
  };
  const shown = read.mapIssue ? withMapAmendments(preview) : preview;
  const name = planRevision ?? `refused-${identityOf(shown).slice(0, 16)}`;
  const planPath = `${PLAN_STORE}/${name}.md`;
  await Bun.write(`${request.projectRoot}/${planPath}`, `${previewText(shown)}\n`, {
    createPath: true,
  });
  return { ...shown, planPath };
}

/**
 * The preview of a source that has a map issue. Its approval also names the map amendment of
 * each item, which waits after the merge for a second approval of its own text (D2).
 */
function withMapAmendments<Preview extends Omit<PublishPreview, "planPath">>(
  preview: Preview,
): Preview {
  const { approval, ships } = preview;
  return approval === null || ships === null
    ? preview
    : {
        ...preview,
        approval: {
          ...approval,
          targets: [
            ...approval.targets,
            ...ships.trackerSteps.map((one) => trackerStepTarget(one.closes, "map_amendment")),
          ],
        },
      };
}

/** Records the publication and every write of it as an intent, before the first write. */
function recordPublication(
  db: CrewWriter,
  request: {
    preview: PublishPreview & { ships: Ships; planRevision: string };
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
  const effects: Effect[] = [
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
  ];
  effects.forEach((effect, position) => {
    db.insert(publishEffects)
      .values({
        id: crypto.randomUUID(),
        publicationId,
        position,
        kind: effect.kind,
        intent: JSON.stringify(effect),
        state: "intended",
        outcome: null,
        createdAt: request.now,
        settledAt: null,
      })
      .run();
  });
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
  const intent = readStored("publish effect", effectSchema, request.effect.intent);
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
    }
  | StateFailure
  | RequestFailure
  | { status: "unknown-source"; sourceId: string }
  | { status: "unread"; detail: string };

/** Runs each write of one publication that is not done, in order, and records each outcome. */
async function runEffects(
  request: { projectRoot: string; requestId: string; ownerToken: string },
  publicationId: string,
): Promise<ApplyResult> {
  const read = await readState(request.projectRoot, (db) => ({
    publication: db
      .select()
      .from(stackPublications)
      .where(eq(stackPublications.id, publicationId))
      .all()[0],
    effects: effectsOf(db, publicationId),
  }));
  if ("status" in read) {
    return read;
  }
  const number = read.publication?.number ?? 0;
  for (const effect of read.effects.filter((one) => one.state !== "done")) {
    const subject = { id: effect.id, kind: effect.kind, position: effect.position };
    // A conflict is something a person settles, so a repeat never writes over it.
    if (effect.state === "conflict") {
      const outcome = readStored(
        "publish effect outcome",
        z.strictObject({ status: z.literal("conflict"), found: z.string() }),
        effect.outcome ?? "{}",
      );
      return { status: "effect-stopped", publication: number, effect: subject, outcome };
    }
    const outcome = await PullRequestStack.write({
      repoRoot: request.projectRoot,
      effect: readStored("publish effect", effectSchema, effect.intent),
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
      return { status: "effect-stopped", publication: number, effect: subject, outcome };
    }
  }
  const pullRequests = await readState(request.projectRoot, (db) =>
    pullRequestsOf(db, publicationId).map((one) => ({
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
}): Promise<ApplyResult> {
  const open = await readState(request.projectRoot, (db) =>
    openPublicationOf(db, request.sourceId),
  );
  if (open !== null && "status" in open) {
    return open;
  }
  if (open !== null) {
    if (open.publication.planRevision !== request.planRevision) {
      return {
        status: "plan-revision-changed",
        stated: request.planRevision,
        planned: open.publication.planRevision,
        planPath: null,
      };
    }
    return runEffects(request, open.publication.id);
  }

  const preview = await planPublish(request);
  if (preview.status !== "planned") {
    return preview;
  }
  if (preview.refusals.length > 0) {
    return { status: "refused", preview };
  }
  if (
    preview.planRevision !== request.planRevision ||
    preview.ships === null ||
    preview.approval === null
  ) {
    return {
      status: "plan-revision-changed",
      stated: request.planRevision,
      planned: preview.planRevision,
      planPath: preview.planPath,
    };
  }
  const approval = preview.approval;
  const matched = await readState(request.projectRoot, (db) => matchApproval(db, approval));
  if (matched.status !== "matched") {
    return { status: "approval-required", approval, planPath: preview.planPath };
  }

  const ships = preview.ships;
  const planRevision = preview.planRevision;
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
      input: { sourceId: request.sourceId, planRevision },
    },
    ({ tx, now }) => {
      // A publication that another apply recorded since the plan is settled, not recorded twice.
      if (openPublicationOf(tx, request.sourceId) !== null) {
        return { commit: false, outcome: { status: "publication-open" as const } };
      }
      return {
        commit: true,
        outcome: recordPublication(tx, {
          preview: { ...preview, ships, planRevision },
          repository,
          approvalId: matched.approval.approvalId,
          now,
        }),
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
