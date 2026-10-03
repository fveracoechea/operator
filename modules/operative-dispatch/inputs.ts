import { ContentIdentity } from "../content-identity/main.ts";
import { ReleaseInstall } from "../release-install/main.ts";
import { SkillInstall } from "../skill-install/main.ts";
import {
  type DispatchPlan,
  opencodeFiles,
  RELEASE_PATH,
  REFERENCE_PATH,
  type Snapshot,
} from "./plan.ts";

export type PreparedInput = { path: string; identity: string };

export type PrepareOutcome =
  | { status: "prepared"; inputs: PreparedInput[] }
  | { status: "failed"; reason: PrepareFailure; detail: string };

export type PrepareFailure =
  | "lock_data_missing"
  | "configuration_missing"
  | "skill_copy_conflict"
  | "review_skill_missing"
  | "input_verification_failed";

type Write = { path: string; bytes: Uint8Array };

const encoder = new TextEncoder();

async function readBytes(path: string): Promise<Uint8Array | null> {
  const file = Bun.file(path);
  return (await file.exists()) ? new Uint8Array(await file.arrayBuffer()) : null;
}

/** The exact bytes one commit holds at one path, or null when it holds no such file. */
async function committedBytes(
  worktreePath: string,
  commit: string,
  path: string,
): Promise<Uint8Array | null> {
  const child = Bun.spawn(["git", "-C", worktreePath, "cat-file", "blob", `${commit}:${path}`], {
    stdout: "pipe",
    stderr: "ignore",
    timeout: 30_000,
  });
  const [exitCode, bytes] = await Promise.all([child.exited, new Response(child.stdout).bytes()]);
  return exitCode === 0 ? bytes : null;
}

type Request = { projectRoot: string; plan: DispatchPlan; snapshot: Snapshot };

type Failure = { failure: PrepareFailure; detail: string };

type Read = { writes: Write[] } | Failure;

/** One input reader. It sees the writes of the readers before it, and it writes nothing. */
type Reader = (request: Request, earlier: Write[]) => Promise<Read>;

function lockPath(name: string): string {
  return `.operator/local/${name}`;
}

/** The bytes one fixed input holds, refused when they are gone or no longer match its identity. */
function verifiedBytes(
  bytes: Uint8Array | null,
  identity: string,
  missing: string,
  changed: string,
): { bytes: Uint8Array } | Failure {
  if (bytes === null) return { failure: "input_verification_failed", detail: missing };
  return ContentIdentity.ofBytes(bytes) === identity
    ? { bytes }
    : { failure: "input_verification_failed", detail: changed };
}

async function configuration({ projectRoot }: Request): Promise<Read> {
  const bytes = await readBytes(`${projectRoot}/.operator/config.json`);
  if (bytes === null) {
    return {
      failure: "configuration_missing",
      detail: "The controlling checkout holds no .operator/config.json to copy.",
    };
  }

  const schema = await readBytes(`${projectRoot}/.operator/config.schema.json`);
  return {
    writes: [
      { path: ".operator/config.json", bytes },
      ...(schema === null ? [] : [{ path: ".operator/config.schema.json", bytes: schema }]),
    ],
  };
}

async function lock({ snapshot }: Request): Promise<Read> {
  if (snapshot.lock.path === null || snapshot.lock.name === null) {
    return {
      failure: "lock_data_missing",
      detail: "The recorded release has no lock data, so the installation cannot be reproduced.",
    };
  }

  const bytes = await readBytes(snapshot.lock.path);
  return bytes === null
    ? {
        failure: "lock_data_missing",
        detail: `The recorded lock data is gone from ${snapshot.lock.path}.`,
      }
    : { writes: [{ path: lockPath(snapshot.lock.name), bytes }] };
}

/** A jsr installation carries its selected release record, and the worktree must match the lock. */
async function jsrSelection(
  { projectRoot, plan, snapshot }: Request,
  earlier: Write[],
): Promise<Read> {
  if (snapshot.installation?.delivery !== "jsr") return { writes: [] };

  const selectionPath = ReleaseInstall.paths().selection;
  const selection = await readBytes(`${projectRoot}/${selectionPath}`);
  if (selection === null) {
    return {
      failure: "input_verification_failed",
      detail: `The selected release record at ${selectionPath} is missing.`,
    };
  }

  // The lock reader runs first, so a missing lock here is a reader order mistake. It still refuses.
  const lockName = snapshot.lock.name;
  const lockWrite = earlier.find((one) => lockName !== null && one.path === lockPath(lockName));
  if (lockName === null || lockWrite === undefined) {
    return {
      failure: "lock_data_missing",
      detail: "The recorded release has no lock data, so the installation cannot be reproduced.",
    };
  }

  const mismatch = await ReleaseInstall.worktree({
    worktreeRoot: plan.worktreePath,
    version: snapshot.installation.packageVersion ?? snapshot.release.version,
    lockName,
    lockBytes: lockWrite.bytes,
  });
  return mismatch === null
    ? { writes: [{ path: selectionPath, bytes: selection }] }
    : { failure: "input_verification_failed", detail: mismatch };
}

/** An OpenCode launch with a reasoning effort never replaces a different file at its paths. */
async function opencode({ plan }: Request): Promise<Read> {
  if (plan.agentHost !== "opencode" || plan.agentReasoningEffort === null) return { writes: [] };

  const writes = opencodeFiles(plan.agentReasoningEffort).map((file) => ({
    path: file.path,
    bytes: encoder.encode(file.text),
  }));
  for (const input of writes) {
    const existing = await readBytes(`${plan.worktreePath}/${input.path}`);
    if (
      existing !== null &&
      ContentIdentity.ofBytes(existing) !== ContentIdentity.ofBytes(input.bytes)
    ) {
      return {
        failure: "input_verification_failed",
        detail: `${input.path} already exists with different contents.`,
      };
    }
  }
  return { writes };
}

// A path fixed input is not copied: the Operative reads it at the base commit, so that commit
// must hold the exact bytes registration fixed. It is read from Git, not from the disk, because
// a replacement keeps the former worktree and the partial work in it. Nothing is repaired.
async function fixedPaths({ plan }: Request): Promise<Read> {
  for (const input of plan.fixedPaths) {
    const verified = verifiedBytes(
      await committedBytes(plan.worktreePath, plan.baseCommit, input.path),
      input.identity,
      `The fixed input ${input.path} is not in the base commit.`,
      `The fixed input ${input.path} at the base commit no longer matches the identity registration fixed.`,
    );
    if ("failure" in verified) return verified;
  }
  return { writes: [] };
}

// A review carries fixed copies of the submitted artifacts, so the reviewer never reads the
// producer worktree, which another attempt may still change.
async function fixedCopies({ plan }: Request): Promise<Read> {
  const writes: Write[] = [];
  for (const input of plan.extraInputs) {
    const verified = verifiedBytes(
      await readBytes(input.sourcePath),
      input.identity,
      `The fixed copy at ${input.sourcePath} is gone.`,
      `${input.path} no longer matches the identity the submission fixed.`,
    );
    if ("failure" in verified) return verified;
    writes.push({ path: input.path, bytes: verified.bytes });
  }
  return { writes };
}

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
}

/** The records a launch renders from the plan and the snapshot. They cannot fail. */
function records({ projectRoot, plan, snapshot }: Request): Write[] {
  return [
    {
      path: RELEASE_PATH,
      bytes: jsonBytes({
        version: snapshot.release.version,
        identity: snapshot.release.identity,
        installation: snapshot.installation ?? null,
        lock: { name: snapshot.lock.name, identity: snapshot.lock.identity },
        skills: snapshot.skills,
      }),
    },
    {
      path: REFERENCE_PATH,
      bytes: jsonBytes({
        controllingCheckout: projectRoot,
        assignmentId: plan.assignmentId,
        attemptId: plan.attemptId,
        branch: plan.branch,
        baseCommit: plan.baseCommit,
        worktreePath: plan.worktreePath,
      }),
    },
    { path: plan.briefPath, bytes: encoder.encode(plan.briefText) },
  ];
}

/**
 * The exact files an Operative worktree receives.
 * Credentials are never in this list: the host credential store stays where it is, and no file
 * outside these paths is copied out of the controlling checkout.
 */
async function intendedWrites(request: Request): Promise<Read> {
  // The readers run in this order, and the first failure stops the run.
  const readers: Reader[] = [configuration, lock, jsrSelection, opencode, fixedPaths, fixedCopies];
  const writes: Write[] = [];
  for (const reader of readers) {
    const read = await reader(request, writes);
    if ("failure" in read) return read;
    writes.push(...read.writes);
  }
  return { writes: [...writes, ...records(request)] };
}

/**
 * Copies the configuration, release record, lock data, control reference, brief, and skills into
 * one Operative worktree, then reads every copy back. An unverified copy blocks the launch.
 */
export async function prepareInputs(request: Request): Promise<PrepareOutcome> {
  const intended = await intendedWrites(request);
  if ("failure" in intended) {
    return { status: "failed", reason: intended.failure, detail: intended.detail };
  }

  const inputs: PreparedInput[] = [];
  for (const write of intended.writes) {
    const path = `${request.plan.worktreePath}/${write.path}`;
    let written: Uint8Array | null = null;
    try {
      await Bun.write(path, write.bytes, { createPath: true });
      written = await readBytes(path);
    } catch (error) {
      return {
        status: "failed",
        reason: "input_verification_failed",
        detail: `${write.path} could not be written: ${String(error)}`,
      };
    }

    const identity = ContentIdentity.ofBytes(write.bytes);
    if (written === null || ContentIdentity.ofBytes(written) !== identity) {
      return {
        status: "failed",
        reason: "input_verification_failed",
        detail: `${write.path} does not match what this dispatch meant to copy.`,
      };
    }

    inputs.push({ path: write.path, identity });
  }

  const target = request.plan.agentHost;
  if (target !== "opencode" && target !== "claude-code") {
    return {
      status: "failed",
      reason: "input_verification_failed",
      detail: `${target} is not a host this release installs skills for.`,
    };
  }

  const copied = await SkillInstall.run({
    projectRoot: request.plan.worktreePath,
    targets: [target],
  });
  if (copied.conflicts.length > 0) {
    return {
      status: "failed",
      reason: "skill_copy_conflict",
      detail: `The worktree holds changed skill copies: ${copied.conflicts
        .flatMap((one) => one.paths)
        .join(", ")}`,
    };
  }

  const verified = await SkillInstall.inspect({
    projectRoot: request.plan.worktreePath,
    targets: [target],
  });
  if (verified.missing.length > 0 || verified.conflicts.length > 0) {
    return {
      status: "failed",
      reason: "input_verification_failed",
      detail: "The copied skills do not match this release.",
    };
  }

  // Operator installs its own skills. The review skill is not one of them, so a checkout that
  // does not already hold it blocks the launch instead of receiving a copy Operator maintains.
  const required = request.plan.requiredSkill;
  if (required !== null) {
    const found = await SkillInstall.locate({
      projectRoot: request.plan.worktreePath,
      target,
      skill: required,
    });
    if (found.status !== "found") {
      return {
        status: "failed",
        reason: "review_skill_missing",
        detail: `This checkout holds no ${required} skill at ${found.path}.`,
      };
    }
  }

  return {
    status: "prepared",
    inputs: [...inputs, { path: target, identity: request.snapshot.skills.identity }],
  };
}
