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

export type GithubFakeState = {
  viewer: string;
  nextCommentId: number;
  issues: Record<string, FakeIssue>;
  comments: Record<string, FakeComment[]>;
  events: Record<string, FakeEvent[]>;
};

/** One injected fault, and how many more calls of its operation it applies to. */
export type FakeFault = { kind: string; remaining: number };
