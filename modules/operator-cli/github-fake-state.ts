/**
 * The state the GitHub fake answers from.
 * The fake and the fixture that seeds it read this one declaration, so a test cannot describe a
 * tracker the fake would not answer as.
 */

export type FakeComment = {
  id: number;
  html_url: string;
  user: { login: string };
  body: string;
  created_at: string;
  updated_at: string;
};

export type FakeIssue = {
  /** The database id. A source read needs it, and a tracker step reads by number alone. */
  id?: number;
  /** Where the issue lives, as `https://api.github.com/repos/<owner>/<repo>`. */
  repository_url?: string;
  labels?: Array<{ name: string }>;
  number: number;
  state: string;
  state_reason: string | null;
  closed_by: { login: string } | null;
  closed_at: string | null;
  updated_at: string;
  title: string;
  body: string;
};

export type FakeEvent = {
  event: string;
  actor: { login: string } | null;
  state_reason: string | null;
  created_at: string;
};

/** One pull request the fake holds, in the fields the publish reads. */
export type FakePull = {
  number: number;
  html_url: string;
  state: string;
  draft: boolean;
  title: string;
  body: string;
  head: { ref: string; label: string; sha?: string };
  base: { ref: string };
  /** Set when a person merged it on GitHub, with the commit GitHub made. */
  merged?: boolean;
  merge_commit_sha?: string | null;
};

/** One commit as the commits endpoint answers it, in the fields the merge observation reads. */
export type FakeCommit = { sha: string; parents: Array<{ sha: string }> };

/** The settings of one repository that the publish reads. */
export type FakeRepository = {
  default_branch: string;
  allow_merge_commit: boolean;
  allow_squash_merge: boolean;
  allow_rebase_merge: boolean;
};

export type GithubFakeState = {
  viewer: string;
  nextCommentId: number;
  issues: Record<string, FakeIssue>;
  comments: Record<string, FakeComment[]>;
  events: Record<string, FakeEvent[]>;
  /** The issues published under one issue, as `sub_issues` answers them. */
  subIssues?: Record<string, FakeIssue[]>;
  /** The issues one issue is blocked by, as `dependencies/blocked_by` answers them. */
  blockedBy?: Record<string, FakeIssue[]>;
  /**
   * The settings of each repository by `<owner>/<repo>`. A repository with none answers as one
   * whose default branch is `main` and that allows every merge method.
   */
  repositories?: Record<string, FakeRepository>;
  /** The active rules of one branch, by `<owner>/<repo>:<branch>`, as the rules endpoint answers. */
  rules?: Record<string, unknown[]>;
  /** The pull requests of each repository, by `<owner>/<repo>`. */
  pulls?: Record<string, FakePull[]>;
  /** The commits GitHub made on a merge, by their identity. */
  commits?: Record<string, FakeCommit>;
};

/** One injected fault, and how many more calls of its operation it applies to. */
export type FakeFault = { kind: string; remaining: number };
