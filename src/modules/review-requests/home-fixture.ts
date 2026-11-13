// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "bun:test";
import { Ok } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import type { Paths, Row } from "./request.ts";

export const url = "https://github.com/example/one/pull/7";
export const target = { repository: "example/one", number: 7, url };
/** Another PR of the same project, for a second open request. */
export function otherPr(number: number) {
  return {
    repository: "example/one",
    number,
    url: `https://github.com/example/one/pull/${number}`,
  };
}
export const h1 = "1".repeat(40);
export const h2 = "2".repeat(40);
export const h3 = "3".repeat(40);

/**
 * An isolated device with the registered project `example/one`. Real SQLite under a temporary
 * root. The checkout folder is not created, because these units never run Git themselves.
 */
export async function reviewHome() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "operator-review-module-")));
  const paths: Paths = OperatorHome.resolve(
    Environment.parse({ HOME: `${root}/home`, NODE_ENV: "test" }),
  );
  const checkout = `${root}/checkout`;
  const registered = DeviceState.registerProject(paths, {
    repository: target.repository,
    checkout,
    registeredAt: "2026-01-01T00:00:00.000Z",
  });
  expect(registered.tag).toBe("Ok");
  return {
    root,
    paths,
    checkout,
    async remove() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Records PR #7's open request, then sets the given fields in a second write. */
export function seedRequest(
  paths: Paths,
  change: Partial<Omit<Row, "id">> = {},
  id = "r1",
  pr = target,
) {
  const inserted = DeviceState.changeReviewRequest(paths, pr, () =>
    Ok({
      insert: {
        id,
        repository: pr.repository,
        number: pr.number,
        url: pr.url,
        origin: "slack",
        state: "queued",
      },
    }),
  );
  expect(inserted.tag).toBe("Ok");
  const updated = DeviceState.changeReviewRequest(paths, { ...pr, id }, () =>
    Ok({ update: change }),
  );
  return updated.tag === "Ok" ? updated.value : expect.unreachable("The request was not updated.");
}

/** The recorded request of PR #7 with the given id. */
export function readRequest(paths: Paths, id = "r1", pr = target) {
  const read = DeviceState.readReviewRequest(paths, { ...pr, id });
  return read.tag === "Ok" ? read.value : expect.unreachable("The request was not read.");
}

/** One GitHub GraphQL answer for PR #7. */
export function prAnswer(change: Record<string, unknown> = {}, viewer = "me") {
  return {
    data: {
      viewer: { login: viewer },
      repository: {
        pullRequest: {
          state: "OPEN",
          headRefOid: h2,
          author: { login: "author" },
          files: { totalCount: 1, nodes: [{ path: "feature.ts" }] },
          reviewThreads: { nodes: [] },
          reviews: { nodes: [] },
          comments: { nodes: [] },
          timelineItems: { nodes: [] },
          commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
          ...change,
        },
      },
    },
  };
}

/** A successful `gh api` outcome with the given body. */
export function answered<T>(body: T) {
  return { status: "succeeded" as const, value: { httpStatus: 200, body } };
}
