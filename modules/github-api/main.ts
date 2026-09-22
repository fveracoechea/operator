import { callGithub } from "./call.ts";

export const GithubApi = {
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
