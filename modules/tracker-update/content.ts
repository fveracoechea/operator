import type { TrackerTarget } from "./provider.ts";

/**
 * The lookup convention that names one logical operation inside a comment.
 * It is a marker, not authentication and not a server-enforced unique key, so a match is
 * evidence that the intended comment exists now, never proof of exactly-once creation.
 */
const MARKER_PREFIX = "<!-- operator:tracker-operation:v1 ";

/** The heading that separates an explicit map amendment from an ordinary discussion comment. */
export const AMENDMENT_HEADING = "## Map amendment";

export function markerFor(operationId: string): string {
  return `${MARKER_PREFIX}${operationId} -->`;
}

/** The logical operation one comment body claims, or null when it carries no marker. */
export function markerOf(body: string): string | null {
  const start = body.indexOf(MARKER_PREFIX);
  if (start !== 0) {
    return null;
  }

  const end = body.indexOf(" -->", MARKER_PREFIX.length);
  return end === -1 ? null : body.slice(MARKER_PREFIX.length, end).trim();
}

export type ResolutionIntent = {
  step: "resolution";
  target: TrackerTarget;
  body: string;
};

export type AmendmentIntent = {
  step: "map_amendment";
  target: TrackerTarget;
  mode: "amendment" | "replace-body";
  decisionLink: string;
  baselineIdentity: string;
  sections: string[];
  supersedes: string[];
  body: string;
};

export type CompletionIntent = {
  step: "completion";
  target: TrackerTarget;
  reason: string;
};

export type TrackerIntent = ResolutionIntent | AmendmentIntent | CompletionIntent;

/** One comment as a provider reports it. Every reader of a comment in this module reads this. */
export type TrackerComment = {
  commentId: string;
  url: string;
  actor: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Renders the exact comment one operation intends to write.
 * The rendering is fixed by the operation identity and the intent, so a recovery read rebuilds
 * the same bytes and compares them against what the tracker actually holds.
 */
export function renderComment(request: {
  operationId: string;
  intent: ResolutionIntent | AmendmentIntent;
}): string {
  const marker = markerFor(request.operationId);
  const intent = request.intent;
  if (intent.step === "resolution") {
    return `${marker}\n\n${intent.body.trimEnd()}\n`;
  }

  const changes = [
    ...intent.sections.map((section) => `- section: ${section}`),
    ...intent.supersedes.map((operationId) => `- supersedes: ${operationId}`),
  ];

  return [
    marker,
    "",
    AMENDMENT_HEADING,
    "",
    `Authorized by ${intent.decisionLink}.`,
    "This is an explicit amendment, not an ordinary discussion comment.",
    `The unchanged baseline body has SHA256 \`${intent.baselineIdentity}\`.`,
    "The hash identifies the baseline; it is not a server-side write guard.",
    "",
    "### Changes",
    "",
    ...changes,
    "",
    "### Detail",
    "",
    intent.body.trimEnd(),
    "",
  ].join("\n");
}

/** What one amendment comment states it changes, read back from the rendering that wrote it. */
export type AmendmentClaim = {
  sections: string[];
  supersedes: string[];
  baselineIdentity: string | null;
};

const BASELINE_PATTERN = /baseline body has SHA256 `([0-9a-f]{64})`/;

/** Reads the structured claim of one amendment body. Free prose outside it is left alone. */
export function readAmendmentClaim(body: string): AmendmentClaim {
  const sections: string[] = [];
  const supersedes: string[] = [];
  let inChanges = false;

  for (const line of body.split("\n")) {
    if (line.startsWith("### ")) {
      inChanges = line.trim() === "### Changes";
      continue;
    }
    if (!inChanges) {
      continue;
    }

    const section = /^-\s+section:\s*(.+?)\s*$/.exec(line);
    if (section?.[1] !== undefined) {
      sections.push(section[1]);
    }
    const superseded = /^-\s+supersedes:\s*(.+?)\s*$/.exec(line);
    if (superseded?.[1] !== undefined) {
      supersedes.push(superseded[1]);
    }
  }

  return {
    sections,
    supersedes,
    baselineIdentity: BASELINE_PATTERN.exec(body)?.[1] ?? null,
  };
}
