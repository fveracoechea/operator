import { ContentIdentity } from "../content-identity/main.ts";
import { SkillInstall } from "../skill-install/main.ts";
import { type DispatchPlan, RELEASE_PATH, REFERENCE_PATH, type Snapshot } from "./plan.ts";

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

/**
 * The exact files an Operative worktree receives.
 * Credentials are never in this list: the host credential store stays where it is, and no file
 * outside these paths is copied out of the controlling checkout.
 */
async function intendedWrites(request: {
  projectRoot: string;
  plan: DispatchPlan;
  snapshot: Snapshot;
}): Promise<{ writes: Write[] } | { failure: PrepareFailure; detail: string }> {
  const { plan, snapshot } = request;
  const configuration = await readBytes(`${request.projectRoot}/.operator/config.json`);
  if (configuration === null) {
    return {
      failure: "configuration_missing",
      detail: "The controlling checkout holds no .operator/config.json to copy.",
    };
  }

  if (snapshot.lock.path === null || snapshot.lock.name === null) {
    return {
      failure: "lock_data_missing",
      detail: "The recorded release has no lock data, so the installation cannot be reproduced.",
    };
  }

  const lock = await readBytes(snapshot.lock.path);
  if (lock === null) {
    return {
      failure: "lock_data_missing",
      detail: `The recorded lock data is gone from ${snapshot.lock.path}.`,
    };
  }

  const schema = await readBytes(`${request.projectRoot}/.operator/config.schema.json`);

  // A review carries fixed copies of the submitted artifacts, so the reviewer never reads the
  // producer worktree, which another attempt may still change.
  const copies: Write[] = [];
  for (const input of plan.extraInputs) {
    const bytes = await readBytes(input.sourcePath);
    if (bytes === null) {
      return {
        failure: "input_verification_failed",
        detail: `The fixed copy at ${input.sourcePath} is gone.`,
      };
    }
    if (ContentIdentity.ofBytes(bytes) !== input.identity) {
      return {
        failure: "input_verification_failed",
        detail: `${input.path} no longer matches the identity the submission fixed.`,
      };
    }
    copies.push({ path: input.path, bytes });
  }

  return {
    writes: [
      ...copies,
      { path: ".operator/config.json", bytes: configuration },
      ...(schema === null ? [] : [{ path: ".operator/config.schema.json", bytes: schema }]),
      { path: `.operator/local/${snapshot.lock.name}`, bytes: lock },
      {
        path: RELEASE_PATH,
        bytes: encoder.encode(
          `${JSON.stringify(
            {
              version: snapshot.release.version,
              identity: snapshot.release.identity,
              lock: { name: snapshot.lock.name, identity: snapshot.lock.identity },
              skills: snapshot.skills,
            },
            null,
            2,
          )}\n`,
        ),
      },
      {
        path: REFERENCE_PATH,
        bytes: encoder.encode(
          `${JSON.stringify(
            {
              controllingCheckout: request.projectRoot,
              assignmentId: plan.assignmentId,
              attemptId: plan.attemptId,
              branch: plan.branch,
              baseCommit: plan.baseCommit,
              worktreePath: plan.worktreePath,
            },
            null,
            2,
          )}\n`,
        ),
      },
      { path: plan.briefPath, bytes: encoder.encode(plan.briefText) },
    ],
  };
}

/**
 * Copies the configuration, release record, lock data, control reference, brief, and skills into
 * one Operative worktree, then reads every copy back. An unverified copy blocks the launch.
 */
export async function prepareInputs(request: {
  projectRoot: string;
  plan: DispatchPlan;
  snapshot: Snapshot;
}): Promise<PrepareOutcome> {
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

  // Operator installs its own skills. A skill it does not own, such as the review skill, must
  // already be in the checkout, so a missing one blocks the launch instead of a silent fallback.
  for (const skill of request.plan.requiredSkills) {
    const found = await SkillInstall.locate({
      projectRoot: request.plan.worktreePath,
      target,
      skill,
    });
    if (found.status !== "found") {
      return {
        status: "failed",
        reason: "review_skill_missing",
        detail: `This checkout holds no ${skill} skill at ${found.path}.`,
      };
    }
  }

  return {
    status: "prepared",
    inputs: [...inputs, { path: target, identity: request.snapshot.skills.identity }],
  };
}
