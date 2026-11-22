import { afterEach, expect, jest, test } from "bun:test";
import { CommitDelivery } from "./main.ts";
import { commitFixture } from "../../../tools/commit-delivery-fixture.ts";

let fixture: Awaited<ReturnType<typeof commitFixture>> | undefined;
afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
  jest.restoreAllMocks();
});

test("delivery returns the exact reviewed single-parent commit, checks, dispositions, and separate verified effects", async () => {
  fixture = await commitFixture([
    ["git", "diff", "--exit-code"],
    ["git", "status", "--porcelain"],
  ]);
  const initial = fixture.data();
  expect(initial.data).toEqual({
    repository: "example/one",
    ticket: "#411",
    checkout: fixture.checkout,
    localRef: "refs/heads/main",
    remoteRef: "refs/heads/main",
    remote: "https://github.com/example/one.git",
    base: fixture.base,
    publishedHead: null,
    policy: {
      checks: [
        ["git", "diff", "--exit-code"],
        ["git", "status", "--porcelain"],
      ],
      review: "required",
      publication: "local-and-origin",
    },
    candidate: null,
    history: [],
    implementer: null,
    rounds: [],
    dispositions: [],
    checks: null,
    journal: [],
    stage: "build",
    ownerPid: null,
    leaseAt: null,
  });
  await fixture.change();
  const tree = fixture.git(fixture.worktree, "rev-parse", "HEAD^{tree}");
  await fixture.review();
  const candidate = fixture.data().data.candidate ?? expect.unreachable("No candidate.");
  const head = candidate.head ?? expect.unreachable("No candidate head.");
  expect(fixture.git(candidate.path, "show", "-s", "--format=%P")).toBe(fixture.base);
  expect(fixture.git(candidate.path, "show", "-s", "--format=%T")).toBe(tree);
  expect(fixture.git(candidate.path, "show", "-s", "--format=%B")).toBe(
    "Ticket #411\n\nOperator-Ticket: source/ticket",
  );
  expect(fixture.git(candidate.path, "show", "-s", "--format=%an <%ae>")).toBe(
    "Fixture <fixture@example.com>",
  );
  const round = await CommitDelivery.round({
    ...fixture.input,
    text: "## Findings\r\n- nice-to-have, Spec, feature: Explain the behavior.\r\n",
  });
  expect(round).toMatchObject({
    tag: "Ok",
    value: {
      candidate: { head, tree },
      history: [head],
      implementer: "implementer",
      rounds: [
        {
          head,
          tree,
          findings: [
            {
              severity: "nice-to-have",
              axis: "Spec",
              location: "feature",
              claim: "Explain the behavior.",
            },
          ],
        },
      ],
    },
  });
  const delivered = await CommitDelivery.deliver({
    ...fixture.input,
    text: "  ## Dispositions\r\n  - 1.1 declined: This behavior is already documented.\r\n",
  });
  expect(delivered).toMatchObject({
    tag: "Ok",
    value: {
      stage: "complete",
      candidate: { head, tree },
      history: [head],
      publishedHead: head,
      ownerPid: null,
      leaseAt: null,
      dispositions: [
        {
          round: 1,
          finding: 1,
          disposition: "declined",
          reason: "This behavior is already documented.",
        },
      ],
      checks: {
        candidate: head,
        base: fixture.base,
        tree,
        policy: JSON.stringify(initial.data.policy),
        results: [
          { argv: ["git", "diff", "--exit-code"], exitCode: 0 },
          { argv: ["git", "status", "--porcelain"], exitCode: 0 },
        ],
      },
    },
  });
  expect(fixture.data().data.journal.map(({ effect, state }) => [effect, state])).toEqual([
    ["candidate_creation", "intent"],
    ["candidate_creation", "verified"],
    ["delivery_admission", "intent"],
    ["checkout_index", "intent"],
    ["checkout_index", "verified"],
    ["local_ref", "intent"],
    ["local_ref", "verified"],
    ["remote_publication", "intent"],
    ["remote_publication", "verified"],
    ["database_finalization", "intent"],
    ["database_finalization", "verified"],
  ]);
  expect(fixture.git(fixture.checkout, "status", "--porcelain")).toBe("");
  expect(fixture.git(fixture.checkout, "rev-parse", "main")).toBe(head);
  expect(fixture.git(fixture.root, "--git-dir", fixture.origin, "rev-parse", "main")).toBe(head);
  expect(fixture.git(fixture.checkout, "rev-list", "--count", `${fixture.base}..main`)).toBe("1");
  expect(fixture.git(fixture.checkout, "show", "ticket/411:feature")).toBe("feature");
});

test("invalid disposition documents refuse without changing delivery evidence or either target", async () => {
  fixture = await commitFixture();
  await fixture.change();
  await fixture.review();
  expect((await CommitDelivery.round({ ...fixture.input, text: "## Findings" })).tag).toBe("Ok");
  const before = fixture.data();
  for (const text of [
    "",
    "## Disposition",
    "## Dispositions\n- 1.1 applied suffix",
    "## Dispositions\n- 1x1 applied",
    "## Dispositions\n- 1.1 declined:",
  ]) {
    expect(await CommitDelivery.deliver({ ...fixture.input, text })).toMatchObject({
      tag: "Err",
      error: {
        reason: "commit_input_invalid",
        detail: expect.stringMatching(/\S/) as string,
        next: { command: "operator next", why: expect.stringMatching(/\S/) as string },
      },
    });
    expect(fixture.data()).toEqual(before);
  }
  expect(fixture.git(fixture.checkout, "rev-parse", "main")).toBe(fixture.base);
  expect(fixture.git(fixture.root, "--git-dir", fixture.origin, "rev-parse", "main")).toBe(
    fixture.base,
  );
});

test("invalid commit findings return the commit round command without recording a round", async () => {
  fixture = await commitFixture();
  await fixture.change();
  await fixture.review();
  const before = fixture.data();
  expect(await CommitDelivery.round({ ...fixture.input, text: "not findings" })).toMatchObject({
    tag: "Err",
    error: {
      reason: "internal_review_findings_invalid",
      next: { command: "operator commit round --file <path|->" },
    },
  });
  expect(fixture.data()).toEqual(before);
});

test("an empty ticket and an implementer's own review cannot advance any completion state", async () => {
  fixture = await commitFixture();
  expect(await CommitDelivery.review(fixture.input)).toMatchObject({
    tag: "Err",
    error: {
      reason: "commit_empty",
      detail: "A ticket must produce a nonempty target commit.",
    },
  });
  expect(await CommitDelivery.round({ ...fixture.input, text: "## Findings" })).toMatchObject({
    tag: "Err",
    error: {
      reason: "commit_reviewer_required",
      detail: "A fresh reviewer must record each review round.",
    },
  });
  expect(await CommitDelivery.deliver({ ...fixture.input, text: "## Dispositions" })).toMatchObject(
    {
      tag: "Err",
      error: {
        reason: "commit_reviewer_required",
        detail: "Only a fresh reviewer may deliver commit work.",
      },
    },
  );
  await fixture.change();
  expect(await CommitDelivery.review(fixture.input)).toMatchObject({
    tag: "Ok",
    value: {
      sourceId: "source",
      assignment: "ticket",
      checkout: fixture.checkout,
    },
  });
  expect(await CommitDelivery.review(fixture.input)).toMatchObject({
    tag: "Err",
    error: {
      reason: "commit_review_started",
      detail: "A fresh reviewer is already recorded.",
    },
  });
  expect(await CommitDelivery.round({ ...fixture.input, text: "## Findings" })).toMatchObject({
    tag: "Err",
    error: {
      reason: "commit_reviewer_required",
    },
  });
  expect(await CommitDelivery.deliver({ ...fixture.input, text: "## Dispositions" })).toMatchObject(
    {
      tag: "Err",
      error: {
        reason: "commit_reviewer_required",
      },
    },
  );
  expect(fixture.data().data.stage).toBe("review");
  expect(fixture.data().data.rounds).toEqual([]);
  expect(fixture.git(fixture.checkout, "rev-parse", "main")).toBe(fixture.base);
});
