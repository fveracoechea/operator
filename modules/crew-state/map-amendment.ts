import { eq } from "drizzle-orm";
import type { ApprovalCheck } from "./approval-input.ts";
import { matchApproval } from "./approvals.ts";
import type { CrewReader } from "./database.ts";
import { workSources } from "./schema.ts";
import { type TrackerOperationRow, writeAttemptsOf } from "./tracker.ts";
import { storedTarget } from "./tracker-input.ts";
import { storedTrackerLocation } from "./work-input.ts";

/**
 * The approval action that binds the exact text of the map amendment of a code result (D2). The
 * publish approval names the step, and this second approval binds the text that the CLI renders
 * after the merge, because the plan cannot know it.
 */
export const MAP_AMENDMENT_ACTION = "map-amendment";

const PLAN_STORE = ".operator/local/publish-plans";

/** The map issue of one source, or null when it has none and so owes no map amendment. */
export function mapIssueOf(db: CrewReader, sourceId: string): number | null {
  const source = db.select().from(workSources).where(eq(workSources.id, sourceId)).all()[0];
  return source?.trackerLocation == null
    ? null
    : storedTrackerLocation(source.trackerLocation).mapIssue;
}

/** The local file that holds the rendered text of one planned map amendment, verbatim. */
export function mapAmendmentPath(contentIdentity: string): string {
  return `${PLAN_STORE}/map-amendment-${contentIdentity}.md`;
}

/** The approval that binds the rendered text of one planned map amendment. */
export function mapAmendmentApproval(operation: TrackerOperationRow): ApprovalCheck {
  const target = storedTarget(operation.target);
  return {
    action: MAP_AMENDMENT_ACTION,
    targets: [`github:${target.repository}#${target.issue}:map_amendment`],
    scope: operation.assignmentId,
    requestRevision: operation.contentIdentity ?? operation.intentIdentity,
  };
}

/**
 * Whether one planned map amendment of a code result still waits for the approval of its text.
 * A step that already sent a write passed this check before its first write.
 */
export function mapAmendmentWaits(
  db: CrewReader,
  operation: TrackerOperationRow,
  sent: boolean,
): boolean {
  return !sent && matchApproval(db, mapAmendmentApproval(operation)).status !== "matched";
}

/**
 * What `crew next` shows of one planned map amendment of a code result. A step that sent
 * nothing runs the record again, so nothing is recovered first. Its text is the wait: the
 * request a person grants to bind the rendered text, or null when an approval binds it.
 */
export function mapAmendmentOffer(
  db: CrewReader,
  operation: TrackerOperationRow,
): { unsent: boolean; text: string | null } {
  if (writeAttemptsOf(db, operation.id).length > 0) {
    return { unsent: false, text: null };
  }
  if (!mapAmendmentWaits(db, operation, false)) {
    return { unsent: true, text: null };
  }
  const approval = mapAmendmentApproval(operation);
  return {
    unsent: true,
    text: `The map_amendment step is rendered in ${mapAmendmentPath(approval.requestRevision)} and waits for a person to grant ${approval.action} for ${approval.targets.join(", ")} in scope ${approval.scope} at request revision ${approval.requestRevision}, which binds that exact text. Then run the record again.`,
  };
}

/** The rendered text of one planned map amendment, as the person approves it. */
export function mapAmendmentText(operation: TrackerOperationRow): string {
  const target = storedTarget(operation.target);
  return [
    `# Map amendment ${operation.contentIdentity ?? operation.intentIdentity}`,
    "",
    `- Assignment: ${operation.assignmentId}`,
    `- Map issue: ${target.repository}#${target.issue}`,
    "",
    "The comment, exactly as it is created:",
    "",
    "<!-- comment start -->",
    (operation.content ?? "").trimEnd(),
    "<!-- comment end -->",
    "",
  ].join("\n");
}
