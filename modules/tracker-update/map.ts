import type { Problem, ScanCoverage } from "./classify.ts";
import { AMENDMENT_HEADING, identityOfText, markerOf, readAmendmentClaim } from "./content.ts";

/** One explicit map amendment. An ordinary discussion comment never becomes one of these. */
export type MapAmendment = {
  operationId: string;
  commentId: string;
  url: string;
  actor: string;
  createdAt: string;
  updatedAt: string;
  /** A comment whose stored update time moved after it was written. It needs review. */
  edited: boolean;
  sections: string[];
  supersedes: string[];
  statedBaselineIdentity: string | null;
};

export type MapReading = {
  baselineIdentity: string;
  coverage: ScanCoverage;
  amendments: MapAmendment[];
  /** The amendments that stand once superseding is applied, in the order they were written. */
  effective: MapAmendment[];
  ordinaryComments: number;
  problems: Problem[];
};

type Comment = {
  commentId: string;
  url: string;
  actor: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

function amendmentOf(comment: Comment): MapAmendment | null {
  const operationId = markerOf(comment.body);
  if (operationId === null || !comment.body.includes(AMENDMENT_HEADING)) {
    return null;
  }

  const claim = readAmendmentClaim(comment.body);
  return {
    operationId,
    commentId: comment.commentId,
    url: comment.url,
    actor: comment.actor,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    edited: comment.updatedAt !== "" && comment.updatedAt !== comment.createdAt,
    sections: claim.sections,
    supersedes: claim.supersedes,
    statedBaselineIdentity: claim.baselineIdentity,
  };
}

/**
 * Reads one map as its baseline body plus every explicit amendment.
 * Independent additions combine, and every reason the reading cannot be trusted is reported:
 * an incomplete scan, an edited amendment, a baseline that moved under an amendment, a repeated
 * operation, and two amendments that change one section with no stated resolution.
 */
export function readMap(request: {
  baselineBody: string;
  coverage: ScanCoverage;
  comments: Comment[];
}): MapReading {
  const baselineIdentity = identityOfText(request.baselineBody);
  const amendments = request.comments.flatMap((comment) => amendmentOf(comment) ?? []);
  const superseded = new Set(amendments.flatMap((one) => one.supersedes));
  const effective = amendments.filter((one) => !superseded.has(one.operationId));
  const problems: Problem[] = [];

  if (!request.coverage.complete) {
    problems.push({
      reason: "tracker.evidence_incomplete",
      detail:
        request.coverage.detail ??
        "The map scan did not cover every accessible comment page, so the amendments read are not known to be all of them.",
    });
  }

  for (const amendment of amendments) {
    if (amendment.edited) {
      problems.push({
        reason: "tracker.map_conflict",
        detail: `Amendment ${amendment.url} was edited after it was written. An edited amendment is reviewed, never restored automatically.`,
      });
    }
    if (
      amendment.statedBaselineIdentity !== null &&
      amendment.statedBaselineIdentity !== baselineIdentity
    ) {
      problems.push({
        reason: "tracker.map_conflict",
        detail: `Amendment ${amendment.url} was written against another baseline body. The baseline changed, which requires review rather than restoration.`,
      });
    }
  }

  const byOperation = new Map<string, MapAmendment[]>();
  for (const amendment of amendments) {
    byOperation.set(amendment.operationId, [
      ...(byOperation.get(amendment.operationId) ?? []),
      amendment,
    ]);
  }
  for (const [operationId, held] of byOperation) {
    if (held.length > 1) {
      problems.push({
        reason: "tracker.map_conflict",
        detail: `Operation ${operationId} appears in ${held.length} amendments. A person selects the authoritative one.`,
      });
    }
  }

  const bySection = new Map<string, MapAmendment[]>();
  for (const amendment of effective) {
    for (const section of amendment.sections) {
      bySection.set(section, [...(bySection.get(section) ?? []), amendment]);
    }
  }
  for (const [section, held] of bySection) {
    if (held.length > 1) {
      problems.push({
        reason: "tracker.map_conflict",
        detail: `Section "${section}" is changed by ${held.length} amendments and none supersedes the others. Comment order does not select a winner.`,
      });
    }
  }

  return {
    baselineIdentity,
    coverage: request.coverage,
    amendments,
    effective,
    ordinaryComments: request.comments.length - amendments.length,
    problems,
  };
}
