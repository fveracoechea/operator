import { PullRequestStack } from "../pull-request-stack/main.ts";
import { matchApproval } from "./approvals.ts";
import type { CrewReader } from "./database.ts";
import { identityOf } from "./identity.ts";
import { mutate, readState, type RequestFailure, type StateFailure } from "./operations.ts";
import {
  type ApplyResult,
  type ApprovalRequest,
  effectsOf,
  openEffectsOf,
  publicationsOf,
  runEffects,
  type StoredEffect,
  storedEffect,
} from "./publish.ts";
import { publishEffects, workSources } from "./schema.ts";
import { RECALL_ACTION, recallOf } from "./stack-parts.ts";
import { eq } from "drizzle-orm";

const PLAN_STORE = ".operator/local/publish-plans";

export type RecallPreview = {
  status: "planned";
  sourceId: string;
  publication: number;
  planRevision: string;
  parts: Array<{ part: number; number: number; head: string; comment: string; marker: string }>;
  /** False when the recall also closes each pull request, because nothing will replace it. */
  replaced: boolean;
  approval: ApprovalRequest;
  planPath: string;
};

type Planned = {
  publicationId: string;
  repository: string;
  preview: Omit<RecallPreview, "planPath">;
};

/** The recall one source owes now, rendered: each comment and the revision that binds them. */
function plannedRecall(db: CrewReader, sourceId: string): Planned | null {
  const { due } = recallOf(db, sourceId);
  if (due === null) {
    return null;
  }
  const parts = due.parts.map((one) => ({
    ...one,
    ...PullRequestStack.recallComment({
      id: `recall:${due.publication.id}:${one.number}`,
      causes: due.causes,
      replaced: due.replaced,
    }),
  }));
  const planRevision = identityOf({
    sourceId,
    publicationId: due.publication.id,
    parts,
    replaced: due.replaced,
  });
  return {
    publicationId: due.publication.id,
    repository: due.repository,
    preview: {
      status: "planned",
      sourceId,
      publication: due.publication.number,
      planRevision,
      parts,
      replaced: due.replaced,
      approval: {
        action: RECALL_ACTION,
        targets: parts.map((one) => `${due.repository}#${one.number}`),
        scope: sourceId,
        requestRevision: planRevision,
      },
    },
  };
}

/** The full recall plan, written to a local file: the person approves every comment verbatim. */
function planText(preview: Omit<RecallPreview, "planPath">): string {
  return [
    `# Recall plan ${preview.planRevision}`,
    "",
    `- Source: ${preview.sourceId}`,
    `- Stack publication: ${preview.publication}`,
    `- Pull requests: ${preview.parts.map((one) => `#${one.number} (part ${one.part})`).join(", ")}`,
    "",
    preview.replaced
      ? "Each pull request becomes a draft and gets this one comment. The parts below stay open. The change runs on the integration branch after the recall, and a new stack publication closes each one with a pointer to its replacement."
      : "Each pull request becomes a draft, gets this one comment, and is closed with no merge, because every code item of the source above it is withdrawn and no new stack publication will close it. No branch is deleted.",
    "",
    ...preview.parts.flatMap((one) => [
      `## #${one.number}, part ${one.part}`,
      "",
      "<!-- comment start -->",
      one.comment.trimEnd(),
      "<!-- comment end -->",
      "",
    ]),
  ].join("\n");
}

/**
 * Plans the recall of one source and changes nothing. The reason is rendered from the defect or
 * the withdrawal record, so the Operator writes no text into it (D1).
 */
export async function planRecall(request: {
  projectRoot: string;
  sourceId: string;
}): Promise<
  | RecallPreview
  | { status: "nothing-to-recall"; sourceId: string }
  | { status: "unknown-source"; sourceId: string }
  | StateFailure
> {
  const read = await readState(request.projectRoot, (db) => ({
    known: db.select().from(workSources).where(eq(workSources.id, request.sourceId)).all().length,
    planned: plannedRecall(db, request.sourceId),
  }));
  if ("status" in read) {
    return read;
  }
  if (read.known === 0) {
    return { status: "unknown-source", sourceId: request.sourceId };
  }
  if (read.planned === null) {
    return { status: "nothing-to-recall", sourceId: request.sourceId };
  }
  const { preview } = read.planned;
  const planPath = `${PLAN_STORE}/recall-${preview.planRevision}.md`;
  await Bun.write(`${request.projectRoot}/${planPath}`, `${planText(preview)}\n`, {
    createPath: true,
  });
  return { ...preview, planPath };
}

export type RecallResult =
  | RecallPreview
  | { status: "nothing-to-recall"; sourceId: string }
  | { status: "unknown-source"; sourceId: string }
  | { status: "plan-revision-changed"; stated: string; planned: string | null }
  | { status: "approval-required"; approval: ApprovalRequest; planPath: string }
  | {
      status: "recalled";
      publication: number;
      pullRequests: number[];
      closed: boolean;
    }
  | Exclude<ApplyResult, { status: "published" }>
  | StateFailure
  | RequestFailure;

/** The publication whose open writes carry one recall plan revision, if a repeat must settle it. */
function openRecallOf(db: CrewReader, sourceId: string, planRevision: string): string | null {
  for (const publication of publicationsOf(db, sourceId)) {
    const open = openEffectsOf(db, publication).some((one) => {
      const intent = storedEffect(one.intent);
      return (
        (intent.kind === "recall" || intent.kind === "close") && intent.recall === planRevision
      );
    });
    if (open) {
      return publication.id;
    }
  }
  return null;
}

/** Runs the writes of one recall and reports the pull requests it reached. */
async function runRecall(
  request: { projectRoot: string; requestId: string; ownerToken: string; planRevision: string },
  publicationId: string,
): Promise<RecallResult> {
  const ran = await runEffects(request, publicationId);
  if (ran.status !== "published") {
    return ran;
  }
  const read = await readState(request.projectRoot, (db) =>
    effectsOf(db, publicationId)
      .map((one) => storedEffect(one.intent))
      .filter(
        (one): one is Extract<StoredEffect, { kind: "recall" | "close" }> =>
          (one.kind === "recall" || one.kind === "close") && one.recall === request.planRevision,
      ),
  );
  if ("status" in read) {
    return read;
  }
  return {
    status: "recalled",
    publication: ran.publication,
    pullRequests: read.filter((one) => one.kind === "recall").map((one) => one.number),
    closed: read.some((one) => one.kind === "close"),
  };
}

/**
 * Recalls exactly the plan that `planRecall` previewed, behind one `stack-recall` approval of
 * its revision (decision 23): each open pull request from the affected part up becomes a draft
 * and gets one comment with the reason, and with no replacement it is also closed (decision
 * 30). Each write reads GitHub first, so a repeat finishes an interrupted recall. It never merges.
 */
export async function applyRecall(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  sourceId: string;
  planRevision: string;
}): Promise<RecallResult> {
  const open = await readState(request.projectRoot, (db) =>
    openRecallOf(db, request.sourceId, request.planRevision),
  );
  if (open !== null && typeof open !== "string") {
    return open;
  }
  if (open !== null) {
    return runRecall(request, open);
  }

  const preview = await planRecall(request);
  if (preview.status !== "planned") {
    return preview;
  }
  if (preview.planRevision !== request.planRevision) {
    return {
      status: "plan-revision-changed",
      stated: request.planRevision,
      planned: preview.planRevision,
    };
  }
  const matched = await readState(request.projectRoot, (db) => matchApproval(db, preview.approval));
  if (matched.status !== "matched") {
    return { status: "approval-required", approval: preview.approval, planPath: preview.planPath };
  }

  const recorded = await mutate<
    { status: "recorded"; publicationId: string } | { status: "plan-revision-changed" }
  >(
    {
      projectRoot: request.projectRoot,
      requestId: request.requestId,
      ownerToken: request.ownerToken,
      now: new Date().toISOString(),
      operation: "publish_recall",
      input: { sourceId: request.sourceId, planRevision: request.planRevision },
    },
    ({ tx, now }) => {
      const planned = plannedRecall(tx, request.sourceId);
      if (planned === null || planned.preview.planRevision !== request.planRevision) {
        return { commit: false, outcome: { status: "plan-revision-changed" as const } };
      }
      const effects: StoredEffect[] = [
        ...planned.preview.parts.map((one) => ({
          kind: "recall" as const,
          repository: planned.repository,
          number: one.number,
          comment: one.comment,
          marker: one.marker,
          recall: request.planRevision,
        })),
        // With no replacement, the same approval covers the close of each one (decision 30).
        ...(planned.preview.replaced
          ? []
          : planned.preview.parts.map((one) => ({
              kind: "close" as const,
              repository: planned.repository,
              number: one.number,
              publication: null,
              recall: request.planRevision,
              head: one.head,
            }))),
      ];
      const start = effectsOf(tx, planned.publicationId).length;
      effects.forEach((effect, index) => {
        tx.insert(publishEffects)
          .values({
            id: crypto.randomUUID(),
            publicationId: planned.publicationId,
            position: start + index,
            kind: effect.kind,
            intent: JSON.stringify(effect),
            state: "intended",
            outcome: null,
            createdAt: now,
            settledAt: null,
          })
          .run();
      });
      return {
        commit: true,
        outcome: { status: "recorded" as const, publicationId: planned.publicationId },
      };
    },
  );
  if (recorded.result.status === "plan-revision-changed") {
    return { status: "plan-revision-changed", stated: request.planRevision, planned: null };
  }
  if (recorded.result.status !== "recorded") {
    return recorded.result;
  }
  return runRecall(request, recorded.result.publicationId);
}

/**
 * The recall `crew next` offers for one source, read from the records only (ADR 0016), and
 * whether a `stack-recall` approval already binds its plan revision.
 */
export function recallOffer(
  db: CrewReader,
  sourceId: string,
): {
  publication: number;
  numbers: number[];
  replaced: boolean;
  approved: boolean;
  planRevision: string;
} | null {
  const planned = plannedRecall(db, sourceId);
  if (planned === null) {
    return null;
  }
  const { preview } = planned;
  return {
    publication: preview.publication,
    numbers: preview.parts.map((one) => one.number),
    replaced: preview.replaced,
    approved: matchApproval(db, preview.approval).status === "matched",
    planRevision: preview.planRevision,
  };
}
