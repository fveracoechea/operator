import { callGithub, type GithubOutcome, readNumber, readRecord, readString } from "./invoke.ts";

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
  const commentId = readNumber(source, "id");
  const body = readString(source, "body");
  if (commentId === null || body === null) {
    return null;
  }

  return {
    commentId: String(commentId),
    url: readString(source, "html_url") ?? "",
    actor: readString(readRecord(source, "user"), "login") ?? "",
    body,
    createdAt: readString(source, "created_at") ?? "",
    updatedAt: readString(source, "updated_at") ?? "",
  };
}

function readIssue(source: unknown): Issue | null {
  const number = readNumber(source, "number");
  const state = readString(source, "state");
  if (number === null || state === null) {
    return null;
  }

  return {
    number,
    state,
    stateReason: readString(source, "state_reason"),
    closedBy: readString(readRecord(source, "closed_by"), "login"),
    closedAt: readString(source, "closed_at"),
    updatedAt: readString(source, "updated_at") ?? "",
    title: readString(source, "title") ?? "",
    body: readString(source, "body") ?? "",
  };
}

function readEvent(source: unknown): IssueEvent | null {
  const event = readString(source, "event");
  return event === null
    ? null
    : {
        event,
        actor: readString(readRecord(source, "actor"), "login"),
        stateReason: readString(source, "state_reason"),
        createdAt: readString(source, "created_at") ?? "",
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

export const GithubTracker = {
  /** The stable identifier of the account this machine writes as. */
  async viewer(): Promise<GithubOutcome<{ login: string }>> {
    const outcome = await callGithub({ args: ["user"], timeoutMs: READ_TIMEOUT_MS });
    if (outcome.status !== "succeeded") {
      return outcome;
    }

    const login = readString(outcome.value.body, "login");
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
    const comments: Comment[] = [];

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const outcome = await callGithub({
        args: [
          `repos/${request.repository}/issues/${request.issue}/comments?per_page=${PAGE_SIZE}&page=${page}`,
        ],
        timeoutMs: READ_TIMEOUT_MS,
      });
      if (outcome.status !== "succeeded") {
        const detail =
          outcome.status === "failed" ? `${outcome.code}: ${outcome.detail}` : outcome.detail;
        return {
          coverage: { complete: false, pages: page - 1, count: comments.length, detail },
          comments,
        };
      }

      const rows = listOf(outcome.value.body);
      const read = rows.map(readComment);
      if (read.some((one) => one === null)) {
        return {
          coverage: {
            complete: false,
            pages: page - 1,
            count: comments.length,
            detail: "GitHub answered with a comment this release cannot read.",
          },
          comments,
        };
      }

      comments.push(...read.filter((one) => one !== null));
      if (rows.length < PAGE_SIZE) {
        return {
          coverage: { complete: true, pages: page, count: comments.length, detail: null },
          comments,
        };
      }
    }

    return {
      coverage: {
        complete: false,
        pages: MAX_PAGES,
        count: comments.length,
        detail: `The scan stopped at its ${MAX_PAGES} page limit.`,
      },
      comments,
    };
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
  async readEvents(request: { repository: string; issue: number }): Promise<Lookup<IssueEvent[]>> {
    const outcome = await callGithub({
      args: [`repos/${request.repository}/issues/${request.issue}/events?per_page=${PAGE_SIZE}`],
      timeoutMs: READ_TIMEOUT_MS,
    });
    return lookupFrom(outcome, (body) => {
      const read = listOf(body).map(readEvent);
      return read.some((one) => one === null) ? null : read.filter((one) => one !== null);
    });
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
