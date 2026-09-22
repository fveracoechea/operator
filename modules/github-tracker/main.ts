import { ToolInvocation } from "../tool-invocation/main.ts";
import { callGithub, type GithubOutcome } from "./invoke.ts";

/**
 * Every call is bounded, because an unbounded one would hold a tracker step open with no answer.
 * A write gets more room than a read, so a slow answer is a real outcome, not an uncertain one.
 */
const WRITE_TIMEOUT_MS = 60_000;
const READ_TIMEOUT_MS = 30_000;

/** One scan reads whole pages, and this cap bounds it. A capped scan reports incomplete. */
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

/** A read that answers definitely, so `absent` is evidence and `unknown` is not. */
type Lookup<Value> =
  | { status: "found"; value: Value }
  | { status: "absent" }
  | { status: "unknown"; detail: string };

type Comment = {
  commentId: string;
  url: string;
  actor: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

type Issue = {
  number: number;
  state: string;
  stateReason: string | null;
  closedBy: string | null;
  closedAt: string | null;
  updatedAt: string;
  title: string;
  body: string;
};

type IssueEvent = {
  event: string;
  actor: string | null;
  stateReason: string | null;
  createdAt: string;
};

/** What one comment scan actually covered, so an incomplete read is never read as absence. */
type ScanCoverage = {
  complete: boolean;
  pages: number;
  count: number;
  detail: string | null;
};

function readComment(source: unknown): Comment | null {
  const commentId = ToolInvocation.number(source, "id");
  const body = ToolInvocation.text(source, "body");
  if (commentId === null || body === null) {
    return null;
  }

  return {
    commentId: String(commentId),
    url: ToolInvocation.text(source, "html_url") ?? "",
    actor: ToolInvocation.text(ToolInvocation.record(source, "user"), "login") ?? "",
    body,
    createdAt: ToolInvocation.text(source, "created_at") ?? "",
    updatedAt: ToolInvocation.text(source, "updated_at") ?? "",
  };
}

function readIssue(source: unknown): Issue | null {
  const number = ToolInvocation.number(source, "number");
  const state = ToolInvocation.text(source, "state");
  if (number === null || state === null) {
    return null;
  }

  return {
    number,
    state,
    stateReason: ToolInvocation.text(source, "state_reason"),
    closedBy: ToolInvocation.text(ToolInvocation.record(source, "closed_by"), "login"),
    closedAt: ToolInvocation.text(source, "closed_at"),
    updatedAt: ToolInvocation.text(source, "updated_at") ?? "",
    title: ToolInvocation.text(source, "title") ?? "",
    body: ToolInvocation.text(source, "body") ?? "",
  };
}

function readEvent(source: unknown): IssueEvent | null {
  const event = ToolInvocation.text(source, "event");
  return event === null
    ? null
    : {
        event,
        actor: ToolInvocation.text(ToolInvocation.record(source, "actor"), "login"),
        stateReason: ToolInvocation.text(source, "state_reason"),
        createdAt: ToolInvocation.text(source, "created_at") ?? "",
      };
}

function lookupFrom<Value>(
  outcome: GithubOutcome<{ body: unknown }>,
  read: (body: unknown) => Value | null,
): Lookup<Value> {
  if (outcome.status === "uncertain") {
    return { status: "unknown", detail: outcome.detail };
  }
  if (outcome.status === "failed") {
    // Only "not found" is evidence of absence. Every other refusal leaves the answer unknown.
    return outcome.httpStatus === 404
      ? { status: "absent" }
      : { status: "unknown", detail: `${outcome.code}: ${outcome.detail}` };
  }

  const value = read(outcome.value.body);
  return value === null
    ? { status: "unknown", detail: "GitHub answered in a shape this release cannot read." }
    : { status: "found", value };
}

function listOf(body: unknown): unknown[] {
  return Array.isArray(body) ? body : [];
}

/**
 * Reads every accessible page of one list and states what it covered.
 * A page that failed, and a read that reached its cap, both end as incomplete coverage, because
 * a partial read of a list proves nothing about what is not in it.
 */
async function readPages<Value>(request: {
  path: string;
  read: (source: unknown) => Value | null;
  name: string;
}): Promise<{ coverage: ScanCoverage; items: Value[] }> {
  const items: Value[] = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const outcome = await callGithub({
      args: [`${request.path}?per_page=${PAGE_SIZE}&page=${page}`],
      timeoutMs: READ_TIMEOUT_MS,
    });
    if (outcome.status !== "succeeded") {
      const detail =
        outcome.status === "failed" ? `${outcome.code}: ${outcome.detail}` : outcome.detail;
      return { coverage: { complete: false, pages: page - 1, count: items.length, detail }, items };
    }

    const rows = listOf(outcome.value.body);
    const read = rows.map(request.read);
    if (read.some((one) => one === null)) {
      return {
        coverage: {
          complete: false,
          pages: page - 1,
          count: items.length,
          detail: `GitHub answered with a ${request.name} this release cannot read.`,
        },
        items,
      };
    }

    items.push(...read.filter((one) => one !== null));
    if (rows.length < PAGE_SIZE) {
      return {
        coverage: { complete: true, pages: page, count: items.length, detail: null },
        items,
      };
    }
  }

  return {
    coverage: {
      complete: false,
      pages: MAX_PAGES,
      count: items.length,
      detail: `The read stopped at its ${MAX_PAGES} page limit.`,
    },
    items,
  };
}

export const GithubTracker = {
  /** The stable identifier of the account this machine writes as. */
  async viewer(): Promise<GithubOutcome<{ login: string }>> {
    const outcome = await callGithub({ args: ["user"], timeoutMs: READ_TIMEOUT_MS });
    if (outcome.status !== "succeeded") {
      return outcome;
    }

    const login = ToolInvocation.text(outcome.value.body, "login");
    return login === null
      ? { status: "uncertain", detail: "GitHub named no login for this token." }
      : { status: "succeeded", value: { login } };
  },

  /**
   * Adds one comment to an issue.
   * GitHub offers no retry key for this call, so a lost answer stays uncertain and is settled
   * by reading, never by sending the same comment again.
   */
  async createComment(request: {
    repository: string;
    issue: number;
    body: string;
  }): Promise<GithubOutcome<Comment>> {
    const outcome = await callGithub({
      args: [
        "--method",
        "POST",
        `repos/${request.repository}/issues/${request.issue}/comments`,
        "--input",
        "-",
      ],
      input: JSON.stringify({ body: request.body }),
      timeoutMs: WRITE_TIMEOUT_MS,
    });
    if (outcome.status !== "succeeded") {
      return outcome;
    }

    const comment = readComment(outcome.value.body);
    return comment === null
      ? { status: "uncertain", detail: "GitHub accepted a comment it did not describe." }
      : { status: "succeeded", value: comment };
  },

  /** Read-only. Reads one comment by the server identifier a write recorded. */
  async readComment(request: { repository: string; commentId: string }): Promise<Lookup<Comment>> {
    const outcome = await callGithub({
      args: [`repos/${request.repository}/issues/comments/${request.commentId}`],
      timeoutMs: READ_TIMEOUT_MS,
    });
    return lookupFrom(outcome, readComment);
  },

  /**
   * Read-only. Reads every accessible comment page of one issue and states what it covered.
   * A page that failed, and a scan that reached its cap, both end as incomplete coverage,
   * because a partial read of a comment list proves nothing about what is not in it.
   */
  async scanComments(request: {
    repository: string;
    issue: number;
  }): Promise<{ coverage: ScanCoverage; comments: Comment[] }> {
    return readPages({
      path: `repos/${request.repository}/issues/${request.issue}/comments`,
      read: readComment,
      name: "comment",
    }).then((page) => ({ coverage: page.coverage, comments: page.items }));
  },

  /** Read-only. Reads the state, close reason, and times one issue currently shows. */
  async readIssue(request: { repository: string; issue: number }): Promise<Lookup<Issue>> {
    const outcome = await callGithub({
      args: [`repos/${request.repository}/issues/${request.issue}`],
      timeoutMs: READ_TIMEOUT_MS,
    });
    return lookupFrom(outcome, readIssue);
  },

  /** Read-only. Reads the closure and reopen history of one issue. */
  async readEvents(request: {
    repository: string;
    issue: number;
  }): Promise<{ coverage: ScanCoverage; events: IssueEvent[] }> {
    return readPages({
      path: `repos/${request.repository}/issues/${request.issue}/events`,
      read: readEvent,
      name: "event",
    }).then((page) => ({ coverage: page.coverage, events: page.items }));
  },

  /**
   * Read-only. Reads the issues published under one issue as its sub-issues.
   * A partial read is reported as incomplete coverage, because it proves nothing about what is
   * not in the list.
   */
  async readSubIssues(request: {
    repository: string;
    issue: number;
  }): Promise<{ coverage: ScanCoverage; issues: Issue[] }> {
    return readPages({
      path: `repos/${request.repository}/issues/${request.issue}/sub_issues`,
      read: readIssue,
      name: "sub-issue",
    }).then((page) => ({ coverage: page.coverage, issues: page.items }));
  },

  /** Read-only. Reads the issues one issue is blocked by. */
  async readBlockedBy(request: {
    repository: string;
    issue: number;
  }): Promise<{ coverage: ScanCoverage; issues: Issue[] }> {
    return readPages({
      path: `repos/${request.repository}/issues/${request.issue}/dependencies/blocked_by`,
      read: readIssue,
      name: "dependency",
    }).then((page) => ({ coverage: page.coverage, issues: page.items }));
  },

  /**
   * Reopens one issue.
   * Only the live probe uses it, to put the fixture issue it closed back as it found it. The
   * workflow itself never reopens a ticket.
   */
  async reopenIssue(request: { repository: string; issue: number }): Promise<GithubOutcome<Issue>> {
    const outcome = await callGithub({
      args: [
        "--method",
        "PATCH",
        `repos/${request.repository}/issues/${request.issue}`,
        "--input",
        "-",
      ],
      input: JSON.stringify({ state: "open" }),
      timeoutMs: WRITE_TIMEOUT_MS,
    });
    if (outcome.status !== "succeeded") {
      return outcome;
    }

    const issue = readIssue(outcome.value.body);
    return issue === null
      ? { status: "uncertain", detail: "GitHub reopened an issue it did not describe." }
      : { status: "succeeded", value: issue };
  },

  /** Closes one issue with an explicit reason. The reason is part of the intended effect. */
  async closeIssue(request: {
    repository: string;
    issue: number;
    reason: string;
  }): Promise<GithubOutcome<Issue>> {
    const outcome = await callGithub({
      args: [
        "--method",
        "PATCH",
        `repos/${request.repository}/issues/${request.issue}`,
        "--input",
        "-",
      ],
      input: JSON.stringify({ state: "closed", state_reason: request.reason }),
      timeoutMs: WRITE_TIMEOUT_MS,
    });
    if (outcome.status !== "succeeded") {
      return outcome;
    }

    const issue = readIssue(outcome.value.body);
    return issue === null
      ? { status: "uncertain", detail: "GitHub closed an issue it did not describe." }
      : { status: "succeeded", value: issue };
  },
};
