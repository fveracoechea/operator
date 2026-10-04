import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  acceptProduction,
  acceptReview,
  commitArtifact,
  grantDirection,
  passCandidateGate,
  type Producer,
  reportBody,
  reportReview,
  startProducer,
  startReviewer,
  startRework,
  submissionBody,
  submit,
  type Workspace,
} from "./review-cycle-fixture.ts";
import type { FakePull } from "./github-fake-state.ts";
import { issueKey, readFake, writeFake } from "./source-fixture.ts";
import { requestId as request, runJson } from "./workspace-fixture.ts";

export const SOURCE = issueKey(15);
export const NAME = "operator/fveracoechea-operator-15/1/1";
export const REPOSITORY = "fveracoechea/operator";

export type ApprovalRequest = {
  action: string;
  targets: string[];
  scope: string;
  requestRevision: string;
};

/**
 * Gives the fixture a remote whose URL names the source repository. Git rewrites that URL to a
 * bare repository on disk, so a push reaches a real remote while the configured URL still names
 * the repository.
 */
export async function addRemote(workspace: Workspace): Promise<string> {
  const remotes = `${workspace.root}/remotes`;
  const bare = `${remotes}/fveracoechea/operator.git`;
  await Bun.$`mkdir -p ${remotes}/fveracoechea`.quiet();
  await Bun.$`git init -q --bare ${bare}`.quiet();
  await Bun.$`git -C ${workspace.repo} remote add origin https://github.com/fveracoechea/operator.git`.quiet();
  await Bun.$`git -C ${workspace.repo} config url.${remotes}/.insteadOf https://github.com/`.quiet();
  await Bun.$`git -C ${workspace.repo} push -q origin main`.quiet();
  return bare;
}

export async function remoteRefs(bare: string): Promise<string> {
  return (
    await Bun.$`git -C ${bare} for-each-ref --format=${"%(refname) %(objectname)"}`.quiet()
  ).stdout
    .toString()
    .trim();
}

export async function plan(workspace: Workspace) {
  return runJson(workspace, ["publish", "plan", "--source", SOURCE]);
}

export async function grant(
  workspace: Workspace,
  producer: Pick<Producer, "ownerToken">,
  approval: ApprovalRequest,
) {
  return grantDirection(workspace, producer, { approval }, "Publish exactly this plan.");
}

export async function apply(
  workspace: Workspace,
  producer: Pick<Producer, "ownerToken">,
  planRevision: string,
  env: Record<string, string> = {},
) {
  return runJson(
    workspace,
    [
      "publish",
      "apply",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--source",
      SOURCE,
      "--plan-revision",
      planRevision,
    ],
    workspace.repo,
    env,
  );
}

/** Plans, grants the approval the plan names, and applies it. */
export async function planAndApprove(workspace: Workspace, producer: Producer) {
  const planned = await plan(workspace);
  expect(planned.json.reason).toBe("publish_planned");
  const granted = await grant(workspace, producer, planned.json.data.approval);
  expect(granted.json.reason).toBe("approval_granted");
  return planned.json.data as {
    planRevision: string;
    planPath: string;
    approval: ApprovalRequest;
  };
}

/** The body of the one pull request, read back from the plan file the person approves. */
export async function plannedBody(workspace: Workspace, planPath: string): Promise<string> {
  const text = await Bun.file(`${workspace.repo}/${planPath}`).text();
  const marker = "<!-- body start -->\n";
  return `${text.slice(text.indexOf(marker) + marker.length, text.indexOf("\n<!-- body end -->"))}\n`;
}

/** A text with every identity that changes from run to run replaced by its kind. */
export function normalized(body: string): string {
  return body
    .replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
    .replaceAll(/\b[0-9a-f]{40}\b/g, "<commit>")
    .replaceAll(/\b[0-9a-f]{12}\b/g, "<short>");
}

export async function pullsOf(workspace: Workspace): Promise<FakePull[]> {
  return (await readFake(workspace.github)).pulls?.[REPOSITORY] ?? [];
}

/** Runs statements against the crew state, as an earlier release or a recorded failure left it. */
export function editState(workspace: Workspace, statements: string[]): void {
  const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`, {
    readwrite: true,
  });
  try {
    for (const statement of statements) {
      sqlite.exec(statement);
    }
  } finally {
    sqlite.close();
  }
}

/**
 * The environment of one CLI run whose crew state goes away right after it writes its plan file,
 * so the approval read of a publish or recall apply is the read that fails.
 */
export const STATE_LOST_AFTER_PLAN = {
  BUN_OPTIONS: `--preload ${import.meta.dir}/state-loss.preload.ts`,
};

/** Puts back the crew state that a run under `STATE_LOST_AFTER_PLAN` moved away. */
export async function restoreState(workspace: Workspace): Promise<void> {
  const local = `${workspace.repo}/.operator/local`;
  for (const name of new Bun.Glob("*").scanSync(`${local}/lost-state`)) {
    await Bun.$`mv ${local}/lost-state/${name} ${local}/`.quiet();
  }
  await Bun.$`rmdir ${local}/lost-state`.quiet();
}

export function reasons(result: { json: { blockers: Array<{ reason: string }> } }): string[] {
  return result.json.blockers.map((one) => one.reason);
}

/**
 * One source with one code result, reviewed and accepted through the real CLI, so its branch
 * holds one commit and its result review wrote the published text.
 */
export async function acceptedOneCommit(
  workspace: Workspace,
  options: Parameters<typeof startProducer>[2] = {},
) {
  const bare = await addRemote(workspace);
  const producer = await startProducer(workspace, undefined, options);
  const artifact = await commitArtifact(workspace, producer, "# Result\n");
  const submitted = await submit(workspace, producer, submissionBody(producer, artifact));
  expect(submitted.json.reason).toBe("result_submitted");
  const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);
  const reported = await reportReview(
    workspace,
    reviewer,
    submitted.json.data.reviewId,
    reportBody({ submissionIdentity: submitted.json.data.identity, host: workspace.host }),
  );
  expect(reported.json.reason).toBe("review_reported");
  await acceptReview(workspace, producer, {
    reviewAssignmentId: submitted.json.data.reviewAssignmentId,
    attemptId: reviewer.attemptId,
    revision: reviewer.revision,
  });
  const accepted = await acceptProduction(workspace, producer, {
    submissionId: submitted.json.data.submissionId,
    revision: submitted.json.data.revision,
  });
  expect(accepted.json.reason).toBe("assignment_accepted");
  return {
    bare,
    producer,
    commit: accepted.json.data.landing.to as string,
    revision: accepted.json.data.revision as number,
  };
}

/** Changes the one pull request of the fake, as a person or GitHub would change it. */
export async function editPull(workspace: Workspace, change: Partial<FakePull>): Promise<void> {
  const state = await readFake(workspace.github);
  const [pull] = state.pulls?.[REPOSITORY] ?? [];
  if (pull === undefined) {
    throw new Error("the fake holds no pull request");
  }
  state.pulls = { ...state.pulls, [REPOSITORY]: [{ ...pull, ...change }] };
  await writeFake(workspace.github, state);
}

/**
 * Merges the one pull request on the fake, as a person does on GitHub. A merge commit has the
 * target tip and the head as its parents. A squash or a rebase has one parent and a new commit.
 */
export async function mergeOnGithub(
  workspace: Workspace,
  options: { head: string; method: "merge" | "squash"; base?: string },
): Promise<string> {
  const mergeCommit = new Bun.CryptoHasher("sha1").update(crypto.randomUUID()).digest("hex");
  const tip = "1".repeat(40);
  const state = await readFake(workspace.github);
  state.commits = {
    ...state.commits,
    [mergeCommit]: {
      sha: mergeCommit,
      parents: options.method === "merge" ? [{ sha: tip }, { sha: options.head }] : [{ sha: tip }],
    },
  };
  await writeFake(workspace.github, state);
  const [pull] = state.pulls?.[REPOSITORY] ?? [];
  await editPull(workspace, {
    state: "closed",
    merged: true,
    merge_commit_sha: mergeCommit,
    head: {
      ...pull?.head,
      ref: pull?.head.ref ?? "",
      label: pull?.head.label ?? "",
      sha: options.head,
    },
    base: { ref: options.base ?? "main" },
  });
  return mergeCommit;
}

export async function publishStatus(workspace: Workspace, producer: Pick<Producer, "ownerToken">) {
  return runJson(workspace, [
    "publish",
    "status",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--source",
    SOURCE,
  ]);
}

export async function recordTracker(
  workspace: Workspace,
  producer: Pick<Producer, "ownerToken" | "assignmentId">,
  options: { revision: number; input: unknown },
) {
  const path = `${workspace.root}/inputs/tracker-${crypto.randomUUID()}.json`;
  await Bun.write(path, JSON.stringify(options.input));
  return runJson(workspace, [
    "tracker",
    "record",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--assignment",
    producer.assignmentId,
    "--revision",
    String(options.revision),
    "--input",
    path,
  ]);
}

/** Starts the correction of the invalidated result and has it reviewed, not yet accepted. */
export async function correction(
  workspace: Workspace,
  producer: Producer,
  revision: number,
  options: { path: string; text: string; worktree: string } = {
    path: "docs/result.md",
    text: "# Result\n\nEvery record.\n",
    worktree: "fix",
  },
) {
  const fixing = await startRework(workspace, producer, {
    revision,
    commit: null,
    worktreePath: `${workspace.root}/${options.worktree}`,
  });
  const artifact = await commitArtifact(workspace, fixing, options.text, options.path);
  const submitted = await submit(
    workspace,
    fixing,
    submissionBody(fixing, artifact, { assignmentRevision: fixing.assignmentRevision }),
  );
  expect(submitted.json.reason).toBe("result_submitted");
  const reviewer = await startReviewer(workspace, fixing, submitted.json, artifact.commit, {
    worktreePath: `${workspace.root}/reviewer-${crypto.randomUUID().slice(0, 8)}`,
  });
  await reportReview(
    workspace,
    reviewer,
    submitted.json.data.reviewId,
    reportBody({ submissionIdentity: submitted.json.data.identity, host: workspace.host }),
  );
  await acceptReview(workspace, fixing, {
    reviewAssignmentId: submitted.json.data.reviewAssignmentId,
    attemptId: reviewer.attemptId,
    revision: reviewer.revision,
  });
  await passCandidateGate(workspace, fixing);
  return {
    fixing,
    submissionId: submitted.json.data.submissionId as string,
    revision: submitted.json.data.revision as number,
  };
}

/** One recorded write of a publication, as the crew state holds it. */
export type EffectRecord = { position: number; kind: string; intent: string; state: string };

/** The recorded writes of one kind, in the order of their position. */
export function effectRowsOf(workspace: Workspace, kind: string): EffectRecord[] {
  const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`, {
    readonly: true,
  });
  try {
    return sqlite
      .query<EffectRecord, [string]>(
        "select position, kind, intent, state from publish_effects where kind = ? order by position",
      )
      .all(kind);
  } finally {
    sqlite.close();
  }
}
