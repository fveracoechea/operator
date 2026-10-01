import { GithubTracker } from "../github-tracker/main.ts";
import { identityOf } from "./identity.ts";
import type { WorkInput } from "./work-input.ts";

/** One issue as a registration reads it, with its key in the one canonical spelling. */
export type ReadIssue = {
  key: string;
  repository: string;
  number: number;
  issueId: number;
  state: "open" | "closed";
  title: string;
  body: string;
  // Only the labels that state a wayfinder type, because no other label changes a registration.
  labels: string[];
};

export type ReadItem = ReadIssue & {
  /** The stored sub-issue position. It only breaks ties in the frontier. */
  position: number;
  /** The issues that block this one, as a set sorted by key. An item that is closed reads none. */
  blockers: ReadIssue[];
};

/** A list the read could not cover, so it is a gap and not a proof that nothing is in it. */
export type ReadGap = { key: string; list: "issue" | "sub-issues" | "blockers"; detail: string };

export type SourceRead =
  | { status: "read"; parent: ReadIssue; items: ReadItem[]; gaps: ReadGap[] }
  | { status: "source-missing"; key: string }
  | { status: "source-unreadable"; gap: ReadGap };

type TrackerIssue = NonNullable<
  Extract<Awaited<ReturnType<typeof GithubTracker.readIssue>>, { status: "found" }>["value"]
>;

const WAYFINDER_LABEL = "wayfinder:";

/** A carriage return before a line feed is removed, so a line-ending change is no new text. */
function normalized(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

/** The content identity of one issue's title and body. Its state and comments are outside it. */
export function textIdentity(issue: { title: string; body: string }): string {
  return identityOf({ title: normalized(issue.title), body: normalized(issue.body) });
}

export function keyOf(repository: string, number: number): string {
  return `${repository.toLowerCase()}#${number}`;
}

function splitKey(key: string): { repository: string; number: number } {
  const [repository = "", number = "0"] = key.split("#");
  return { repository, number: Number(number) };
}

function readOne(issue: TrackerIssue, fallbackRepository: string | null): ReadIssue | null {
  const repository = issue.repository ?? fallbackRepository;
  if (issue.id === null || repository === null) {
    return null;
  }

  return {
    key: keyOf(repository, issue.number),
    repository,
    number: issue.number,
    issueId: issue.id,
    state: issue.state === "closed" ? "closed" : "open",
    title: issue.title,
    body: issue.body,
    labels: issue.labels.filter((one) => one.startsWith(WAYFINDER_LABEL)).toSorted(),
  };
}

const UNREADABLE = "GitHub answered with an issue that names no database id or repository.";

async function readBlockers(
  item: ReadIssue,
): Promise<{ blockers: ReadIssue[]; gap: ReadGap | null }> {
  const read = await GithubTracker.readBlockedBy({
    repository: item.repository,
    issue: item.number,
  });
  const blockers = read.issues.map((one) => readOne(one, null));
  const gap: ReadGap | null = !read.coverage.complete
    ? {
        key: item.key,
        list: "blockers",
        detail: read.coverage.detail ?? "The read was not complete.",
      }
    : blockers.some((one) => one === null)
      ? { key: item.key, list: "blockers", detail: UNREADABLE }
      : null;
  return {
    blockers: blockers
      .filter((one) => one !== null)
      .toSorted((one, other) => one.key.localeCompare(other.key)),
    gap,
  };
}

/**
 * Reads the structure of one source from GitHub. It never writes.
 * A specification and a wayfinder map are the parent issue and its sub-issues, and a ticket is
 * one issue that is its own item. Only an open item has its blockers read, because a closed
 * sub-issue is not registered.
 */
export async function readSource(input: WorkInput): Promise<SourceRead> {
  const { repository, number } = splitKey(input.source);
  const found = await GithubTracker.readIssue({ repository, issue: number });
  if (found.status === "absent") {
    return { status: "source-missing", key: input.source };
  }
  if (found.status === "unknown") {
    return {
      status: "source-unreadable",
      gap: { key: input.source, list: "issue", detail: found.detail },
    };
  }

  const parent = readOne(found.value, repository);
  if (parent === null) {
    return {
      status: "source-unreadable",
      gap: { key: input.source, list: "issue", detail: UNREADABLE },
    };
  }

  const gaps: ReadGap[] = [];
  let listed: ReadIssue[] = [parent];
  if (input.sourceKind !== "ticket") {
    const read = await GithubTracker.readSubIssues({ repository, issue: number });
    const issues = read.issues.map((one) => readOne(one, null));
    if (!read.coverage.complete) {
      gaps.push({
        key: parent.key,
        list: "sub-issues",
        detail: read.coverage.detail ?? "The read was not complete.",
      });
    } else if (issues.some((one) => one === null)) {
      gaps.push({ key: parent.key, list: "sub-issues", detail: UNREADABLE });
    }
    listed = issues.filter((one) => one !== null);
  }

  const items: ReadItem[] = [];
  for (const [position, issue] of listed.entries()) {
    if (issue.state === "closed") {
      items.push({ ...issue, position, blockers: [] });
      continue;
    }
    const { blockers, gap } = await readBlockers(issue);
    if (gap !== null) {
      gaps.push(gap);
    }
    items.push({ ...issue, position, blockers });
  }

  return { status: "read", parent, items, gaps };
}

/**
 * What the registration plan revision covers of a read: the exact text, the order, the states,
 * and the blocker sets. A gap counts by its list, not its detail, because a detail such as a
 * timeout message is not tracker content.
 */
export type CanonicalRead = {
  status: SourceRead["status"];
  parent?: Record<string, unknown> & { key: string };
  items?: Array<Record<string, unknown> & { key: string }>;
  gaps?: Array<{ key: string; list: string }>;
  key?: string;
  gap?: { key: string; list: string };
};

export function canonicalRead(read: SourceRead): CanonicalRead {
  if (read.status !== "read") {
    return read.status === "source-missing"
      ? { status: read.status, key: read.key }
      : { status: read.status, gap: { key: read.gap.key, list: read.gap.list } };
  }

  const issue = (one: ReadIssue) => ({
    key: one.key,
    issueId: one.issueId,
    state: one.state,
    title: normalized(one.title),
    body: normalized(one.body),
    labels: one.labels,
  });
  return {
    status: read.status,
    parent: issue(read.parent),
    items: read.items.map((one) => ({
      ...issue(one),
      position: one.position,
      blockers: one.blockers.map((blocker) => ({
        key: blocker.key,
        issueId: blocker.issueId,
        state: blocker.state,
      })),
    })),
    gaps: read.gaps.map((gap) => ({ key: gap.key, list: gap.list })),
  };
}
