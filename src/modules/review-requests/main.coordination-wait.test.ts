import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Err, Ok, OkAsync } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { Projects } from "../projects/main.ts";
import { GithubApi } from "../github-api/main.ts";
import { Herdr } from "../herdr/main.ts";
import { ReviewRequests } from "./main.ts";
import { WorkSources } from "../work-sources/main.ts";
import {
  reviewHome,
  seedRequest,
  readRequest,
  answered,
  prAnswer,
  target,
  h1,
  h2,
  h3,
} from "./home-fixture.ts";

const homes: Awaited<ReturnType<typeof reviewHome>>[] = [];
afterEach(async () => {
  mock.restore();
  for (const home of homes) await home.remove();
  homes.length = 0;
});

function posted(number: number, head: string) {
  return {
    requestId: "r1",
    number,
    trigger: "commits",
    reviewedCommit: head,
    draft: "{}",
    event: "COMMENT",
    body: "Synthetic posted review",
    marker: `synthetic-${number}`,
    outcome: "posted",
    reviewId: `id-${number}`,
    reviewUrl: `https://github.com/example/one/pull/7#pullrequestreview-${number}`,
    postedAt: new Date().toISOString(),
    warning: null,
    blockers: null,
  };
}

async function waitingReview() {
  const home = await reviewHome();
  homes.push(home);
  spyOn(Environment, "read").mockReturnValue({
    ...Environment.read(),
    OPENCODE_SESSION_ID: undefined,
    CLAUDE_CODE_SESSION_ID: undefined,
    HERDR_SOCKET_PATH: "/synthetic.sock",
  });
  spyOn(Projects, "current").mockReturnValue(
    OkAsync({
      reason: "project_resolved",
      data: { repository: target.repository, checkout: home.checkout, registeredAt: "now" },
    }),
  );
  const sources = spyOn(DeviceState, "readSources").mockReturnValue(Ok([]));
  spyOn(Herdr, "agentNames").mockReturnValue(OkAsync(["rev"]));
  spyOn(Herdr, "prompt").mockReturnValue(OkAsync(null));
  const github = spyOn(GithubApi, "call").mockResolvedValue(answered(prAnswer({ headRefOid: h2 })));
  function wait() {
    return WorkSources.wait({
      paths: home.paths,
      cwd: home.checkout,
      timeoutSeconds: 0,
      reviewUpkeep: (scope) => ReviewRequests.upkeep({ paths: home.paths, ...scope }),
    });
  }

  return { home, sources, github, wait };
}

test("distinct commits rounds wake coordination without an intervening quiet read", async () => {
  const { home, github, wait } = await waitingReview();
  seedRequest(home.paths, {
    state: "watching",
    head: h1,
    launchState: "running",
    herdrSocket: "/synthetic.sock",
    name: "rev",
    activityAt: new Date().toISOString(),
  });
  expect(
    DeviceState.changeReviewRequest(home.paths, target, () => Ok({ round: posted(1, h1) })).tag,
  ).toBe("Ok");
  expect(await wait()).toMatchObject({
    tag: "Ok",
    value: {
      reason: "next_actions_changed",
      data: { events: [{ kind: "round_started", trigger: "commits" }] },
    },
  });
  expect(
    DeviceState.changeReviewRequest(home.paths, target, () =>
      Ok({
        update: { state: "watching", activityAt: new Date().toISOString() },
        round: posted(2, h2),
      }),
    ).tag,
  ).toBe("Ok");
  github.mockResolvedValue(answered(prAnswer({ headRefOid: h3 })));
  expect(await wait()).toMatchObject({
    tag: "Ok",
    value: {
      reason: "next_actions_changed",
      data: { events: [{ kind: "round_started" }] },
    },
  });
  expect(readRequest(home.paths).request).toMatchObject({
    state: "reviewing",
    head: h3,
    sync: null,
  });
  expect(await wait()).toMatchObject({
    tag: "Ok",
    value: {
      reason: "next_wait_timed_out",
      data: { events: [], requests: [] },
    },
  });
});

test("a failed source read leaves the review close available to the next successful wait", async () => {
  const { home, sources, github, wait } = await waitingReview();
  seedRequest(home.paths, { state: "watching", head: h1, activityAt: new Date().toISOString() });
  github.mockResolvedValue(answered(prAnswer({ state: "CLOSED" })));
  sources.mockReturnValueOnce(
    Err({
      reason: "state_busy",
      detail: "Synthetic source read failure",
      next: { command: "operator next --wait", why: "Retry" },
    }),
  );
  expect(await wait()).toMatchObject({ tag: "Err", error: { reason: "state_busy" } });
  expect(await wait()).toMatchObject({
    tag: "Ok",
    value: {
      reason: "next_actions_changed",
      data: { events: [{ kind: "review_closed" }] },
    },
  });
  expect(readRequest(home.paths).request).toMatchObject({ state: "closed", cleanupState: "done" });
});
