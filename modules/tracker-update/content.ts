import type { GithubTracker } from "../github-tracker/main.ts";
import type { TrackerTarget } from "./provider.ts";

/**
 * The lookup convention that names one logical operation inside a comment.
 * It is a marker, not authentication and not a server-enforced unique key, so a match is
 * evidence that the intended comment exists now, never proof of exactly-once creation.
 */
const MARKER_PREFIX = "<!-- operator:tracker-operation:v1 ";

/** The heading that separates an explicit map amendment from an ordinary discussion comment. */
export const AMENDMENT_HEADING = "## Map amendment";

/**
 * The words an amendment is written with and read back by.
 * One rendering writes them and one reader parses them, so a change to either is a change to
 * both rather than a silent disagreement about what an amendment says.
 */
const CHANGES_HEADING = "### Changes";
const DETAIL_HEADING = "### Detail";
const SECTION_ENTRY = "- section: ";
const SUPERSEDES_ENTRY = "- supersedes: ";
const BASELINE_SENTENCE = (identity: string) =>
  `The unchanged baseline body has SHA256 \`${identity}\`.`;

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

/** One comment, taken from the boundary that reads it, so both cannot drift apart. */
export type TrackerComment = Awaited<
  ReturnType<typeof GithubTracker.scanComments>
>["comments"][number];

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
    ...intent.sections.map((section) => `${SECTION_ENTRY}${section}`),
    ...intent.supersedes.map((operationId) => `${SUPERSEDES_ENTRY}${operationId}`),
  ];

  return [
    marker,
    "",
    AMENDMENT_HEADING,
    "",
    `Authorized by ${intent.decisionLink}.`,
    "This is an explicit amendment, not an ordinary discussion comment.",
    BASELINE_SENTENCE(intent.baselineIdentity),
    "The hash identifies the baseline; it is not a server-side write guard.",
    "",
    CHANGES_HEADING,
    "",
    ...changes,
    "",
    DETAIL_HEADING,
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

// The reader finds exactly what the sentence above writes, so neither can move without the
// other. Only the full stop needs escaping; the digest pattern carries no other metacharacter.
const BASELINE_PATTERN = new RegExp(BASELINE_SENTENCE("([0-9a-f]{64})").replaceAll(".", "\\."));

/** Reads the structured claim of one amendment body. Free prose outside it is left alone. */
export function readAmendmentClaim(body: string): AmendmentClaim {
  const sections: string[] = [];
  const supersedes: string[] = [];
  let inChanges = false;

  for (const line of body.split("\n")) {
    if (line.startsWith("### ")) {
      inChanges = line.trim() === CHANGES_HEADING;
      continue;
    }
    if (!inChanges) {
      continue;
    }

    if (line.startsWith(SECTION_ENTRY)) {
      sections.push(line.slice(SECTION_ENTRY.length).trim());
    }
    if (line.startsWith(SUPERSEDES_ENTRY)) {
      supersedes.push(line.slice(SUPERSEDES_ENTRY.length).trim());
    }
  }

  return {
    sections,
    supersedes,
    baselineIdentity: BASELINE_PATTERN.exec(body)?.[1] ?? null,
  };
}
