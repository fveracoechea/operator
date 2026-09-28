import { callGithub } from "./call.ts";

export const GithubApi = {
  /** A read-only authentication check. It says nothing about permission to write a fixture. */
  async connection(fixture: { repository: string; issue: number } | null) {
    const result = await callGithub({ args: ["user"], timeoutMs: 5_000 });
    if (result.status === "succeeded") {
      const login = result.value.body;
      if (
        login !== null &&
        typeof login === "object" &&
        "login" in login &&
        typeof login.login === "string"
      ) {
        if (fixture === null) {
          return {
            state: "passed" as const,
            detail: `GitHub authenticated as ${login.login}. Fixture read and write access are not proven without a configured fixture.`,
            nextAction: null,
          };
        }
        const issue = await callGithub({
          args: [`repos/${fixture.repository}/issues/${fixture.issue}`],
          timeoutMs: 5_000,
        });
        if (issue.status === "succeeded") {
          return {
            state: "passed" as const,
            detail: `GitHub authenticated as ${login.login} and read fixture ${fixture.repository}#${fixture.issue}. Write access remains unproven.`,
            nextAction: null,
          };
        }
        return {
          state: "failed" as const,
          detail: `Cannot read fixture ${fixture.repository}#${fixture.issue}: ${issue.detail}`,
          nextAction:
            "Check the fixture repository, issue, and GitHub token permissions, then check again.",
        };
      }
    }
    return {
      state: "failed" as const,
      detail: result.status === "succeeded" ? "GitHub returned no user login." : result.detail,
      nextAction: "Run `gh auth login`, then check GitHub access again.",
    };
  },
  /**
   * Runs one `gh api` call and classifies its answer by the HTTP status GitHub returned.
   * A request GitHub refused is a definite failure, because the server answered. A call that
   * never answered, or answered with a server fault, stays uncertain: a timeout does not prove
   * that the effect did not happen.
   */
  async call(request: { args: string[]; input?: string; timeoutMs: number }) {
    return callGithub(request);
  },
};
