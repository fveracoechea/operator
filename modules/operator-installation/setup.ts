import packageJson from "../../package.json" with { type: "json" };
// Bun has no recursive directory creation, removal, atomic rename, or path manipulation API.
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import * as z from "zod";
import { ConfigSchema, configJsonSchema } from "./config.ts";
import { firstSymlink } from "./filesystem.ts";
import { getSkillAssets, inspectSkillTarget, targetDirectories } from "./skills.ts";

type Target = "claude" | "opencode";

const RelativePathSchema = z
  .string()
  .refine(
    (path) =>
      !path.startsWith("/") &&
      path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
  );

const ChangeSchema = z.strictObject({
  action: z.enum(["create", "update"]),
  path: RelativePathSchema,
  previousHash: z.string().nullable(),
  content: z.string(),
});

type Change = z.infer<typeof ChangeSchema>;

type SetupBlocker =
  | { reason: "configuration_schema_conflict"; path: string }
  | { reason: "instruction_conflict"; path: string }
  | { reason: "invalid_configuration"; path: string; issues: unknown }
  | { reason: "operator_state_tracked"; paths: string[] }
  | { reason: "setup_recovery_damaged"; path: string }
  | { reason: "setup_recovery_required"; path: string; planId: string }
  | { reason: "setup_path_symlink"; path: string }
  | { reason: "skill_copy_conflict"; path: string; target: Target };

const recoveryPath = ".operator/local/setup-recovery.json";

const RecoverySchema = z.strictObject({
  schemaVersion: z.literal(1),
  planId: z.string(),
  plan: z.strictObject({
    operatorVersion: z.string(),
    targets: z.array(z.enum(["claude", "opencode"])),
    changes: z.array(ChangeSchema),
    blockers: z.array(z.never()).max(0),
  }),
  state: z.enum(["applying", "interrupted"]),
  writes: z.array(
    z.strictObject({
      path: RelativePathSchema,
      previousContent: z.string().nullable(),
      contentHash: z.string(),
      status: z.enum(["pending", "completed", "restored", "conflict"]),
    }),
  ),
});

type Recovery = z.infer<typeof RecoverySchema>;

const operatorInstructions = `<!-- operator:start -->
## Operator

Use the \`operator\` skill for Operator setup and crew coordination.
<!-- operator:end -->
`;

function hash(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

function recoveryMatchesApprovedPlan(recovery: Recovery): boolean {
  if (hash(JSON.stringify(recovery.plan)) !== recovery.planId) {
    return false;
  }

  const changes = new Map(recovery.plan.changes.map((change) => [change.path, change]));
  if (changes.size !== recovery.plan.changes.length) {
    return false;
  }

  const writtenPaths = new Set<string>();
  for (const write of recovery.writes) {
    const change = changes.get(write.path);
    if (!change || writtenPaths.has(write.path)) {
      return false;
    }
    writtenPaths.add(write.path);
    const previousHash = write.previousContent === null ? null : hash(write.previousContent);
    if (previousHash !== change.previousHash || write.contentHash !== hash(change.content)) {
      return false;
    }
  }
  return true;
}

async function writeRecovery(projectRoot: string, recovery: Recovery): Promise<void> {
  const destination = `${projectRoot}/${recoveryPath}`;
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  await Bun.write(temporary, `${JSON.stringify(recovery, null, 2)}\n`);
  await rename(temporary, destination);
}

async function proposedChange(
  projectRoot: string,
  path: string,
  content: string,
): Promise<Change | undefined> {
  const file = Bun.file(`${projectRoot}/${path}`);
  if (!(await file.exists())) {
    return { action: "create", path, previousHash: null, content };
  }

  const previous = await file.text();
  if (previous === content) {
    return undefined;
  }
  return { action: "update", path, previousHash: hash(previous), content };
}

function appendLine(content: string, line: string): string {
  const withNewline = content.length === 0 || content.endsWith("\n") ? content : `${content}\n`;
  return `${withNewline}${line}\n`;
}

function appendSection(content: string, section: string): string {
  const withNewline = content.length === 0 || content.endsWith("\n") ? content : `${content}\n`;
  const separator = withNewline.length === 0 || withNewline.endsWith("\n\n") ? "" : "\n";
  return `${withNewline}${separator}${section}`;
}

export async function planSetup(input: { projectRoot: string; targets: Target[] }) {
  const changes: Change[] = [];
  const blockers: SetupBlocker[] = [];
  const assets = await getSkillAssets();
  const candidatePaths = [
    recoveryPath,
    ".gitignore",
    ".operator/config.json",
    ".operator/config.schema.json",
    "AGENTS.md",
    ...(input.targets.includes("claude") ? ["CLAUDE.md"] : []),
    ...input.targets.flatMap((target) =>
      assets.map((asset) => `${targetDirectories[target]}/${asset.path}`),
    ),
  ];
  const symlinkPaths = new Set<string>();
  for (const path of candidatePaths) {
    const symlink = await firstSymlink(input.projectRoot, path);
    if (symlink) {
      symlinkPaths.add(symlink);
    }
  }
  for (const path of [...symlinkPaths].toSorted()) {
    blockers.push({ reason: "setup_path_symlink", path });
  }
  const pathBlocked = (path: string) =>
    [...symlinkPaths].some((symlink) => path === symlink || path.startsWith(`${symlink}/`));

  if (!pathBlocked(recoveryPath)) {
    const recoveryFile = Bun.file(`${input.projectRoot}/${recoveryPath}`);
    if (await recoveryFile.exists()) {
      const recovery = RecoverySchema.safeParse(await recoveryFile.json().catch(() => undefined));
      if (recovery.success) {
        blockers.push({
          reason: "setup_recovery_required",
          path: recoveryPath,
          planId: recovery.data.planId,
        });
      } else {
        blockers.push({ reason: "setup_recovery_damaged", path: recoveryPath });
      }
    }
  }
  const git = Bun.spawn(["git", "ls-files", "--", ".operator"], {
    cwd: input.projectRoot,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [gitExitCode, trackedOutput] = await Promise.all([
    git.exited,
    new Response(git.stdout).text(),
    new Response(git.stderr).text(),
  ]).then(([exitCode, stdout]) => [exitCode, stdout] as const);
  if (gitExitCode === 0) {
    const trackedPaths = trackedOutput.split("\n").filter(Boolean).toSorted();
    if (trackedPaths.length > 0) {
      blockers.push({ reason: "operator_state_tracked", paths: trackedPaths });
    }
  }

  for (const target of input.targets) {
    if (assets.some((asset) => pathBlocked(`${targetDirectories[target]}/${asset.path}`))) {
      continue;
    }
    const skill = await inspectSkillTarget({ projectRoot: input.projectRoot, target });
    if (skill.state === "matching") {
      continue;
    }
    if (skill.state === "conflict") {
      blockers.push({ reason: "skill_copy_conflict", path: skill.relative, target });
      continue;
    }
    for (const asset of assets) {
      const path = `${targetDirectories[target]}/${asset.path}`;
      const change = await proposedChange(input.projectRoot, path, asset.content);
      if (change) {
        changes.push(change);
      }
    }
  }

  const gitignore = Bun.file(`${input.projectRoot}/.gitignore`);
  if (!pathBlocked(".gitignore")) {
    const gitignoreContent = (await gitignore.exists()) ? await gitignore.text() : "";
    if (!gitignoreContent.split(/\r?\n/u).includes("/.operator/")) {
      const change = await proposedChange(
        input.projectRoot,
        ".gitignore",
        appendLine(gitignoreContent, "/.operator/"),
      );
      if (change) {
        changes.push(change);
      }
    }
  }

  const configPath = ".operator/config.json";
  const configFile = Bun.file(`${input.projectRoot}/${configPath}`);
  if (!pathBlocked(configPath)) {
    if (await configFile.exists()) {
      const parsed = ConfigSchema.safeParse(await configFile.json().catch(() => undefined));
      if (!parsed.success) {
        blockers.push({
          reason: "invalid_configuration",
          path: configPath,
          issues: parsed.error.issues,
        });
      }
    } else {
      const change = await proposedChange(
        input.projectRoot,
        configPath,
        `${JSON.stringify({ $schema: "./config.schema.json" }, null, 2)}\n`,
      );
      if (change) {
        changes.push(change);
      }
    }
  }

  const schemaContent = `${JSON.stringify(configJsonSchema(), null, 2)}\n`;
  const schemaPath = ".operator/config.schema.json";
  const schemaFile = Bun.file(`${input.projectRoot}/${schemaPath}`);
  if (!pathBlocked(schemaPath)) {
    if (await schemaFile.exists()) {
      if ((await schemaFile.text()) !== schemaContent) {
        blockers.push({ reason: "configuration_schema_conflict", path: schemaPath });
      }
    } else {
      const schemaChange = await proposedChange(input.projectRoot, schemaPath, schemaContent);
      if (schemaChange) {
        changes.push(schemaChange);
      }
    }
  }

  const agents = Bun.file(`${input.projectRoot}/AGENTS.md`);
  if (!pathBlocked("AGENTS.md")) {
    const agentsContent = (await agents.exists()) ? await agents.text() : "";
    if (!agentsContent.includes(operatorInstructions)) {
      if (
        agentsContent.includes("<!-- operator:start -->") ||
        agentsContent.includes("<!-- operator:end -->") ||
        /^#{1,6}\s+Operator\s*$/imu.test(agentsContent)
      ) {
        blockers.push({ reason: "instruction_conflict", path: "AGENTS.md" });
      } else {
        const change = await proposedChange(
          input.projectRoot,
          "AGENTS.md",
          appendSection(agentsContent, operatorInstructions),
        );
        if (change) {
          changes.push(change);
        }
      }
    }
  }

  if (input.targets.includes("claude") && !pathBlocked("CLAUDE.md")) {
    const claude = Bun.file(`${input.projectRoot}/CLAUDE.md`);
    const claudeContent = (await claude.exists()) ? await claude.text() : "";
    if (!claudeContent.split(/\r?\n/u).includes("@AGENTS.md")) {
      if (/^@.*AGENTS\.md\s*$/imu.test(claudeContent)) {
        blockers.push({ reason: "instruction_conflict", path: "CLAUDE.md" });
      } else {
        const change = await proposedChange(
          input.projectRoot,
          "CLAUDE.md",
          appendLine(claudeContent, "@AGENTS.md"),
        );
        if (change) {
          changes.push(change);
        }
      }
    }
  }

  changes.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const planInput = {
    operatorVersion: packageJson.version,
    targets: input.targets,
    changes,
    blockers,
  };
  return {
    id: hash(JSON.stringify(planInput)),
    operatorVersion: packageJson.version,
    targets: input.targets,
    changes,
    blockers,
    recovery: {
      path: recoveryPath,
      lifecycle: "created during apply and removed after completion",
    },
  };
}

export async function inspectSetup(input: { projectRoot: string; targets: Target[] }) {
  const plan = await planSetup(input);
  if (plan.blockers.length > 0) {
    return {
      outcome: "conflict" as const,
      reason: plan.blockers[0]?.reason ?? ("setup_plan_changed" as const),
      blockers: plan.blockers,
      plan,
    };
  }
  if (plan.changes.length > 0) {
    return {
      outcome: "missing-condition" as const,
      reason: "setup_approval_required" as const,
      blockers: [{ reason: "setup_approval_required" as const }],
      plan,
    };
  }
  return {
    outcome: "completed" as const,
    reason: "setup_configured" as const,
    blockers: [],
    plan,
  };
}

export async function applySetup(input: {
  projectRoot: string;
  targets: Target[];
  approvedPlanId: string;
}) {
  const plan = await planSetup(input);
  if (plan.blockers.length > 0) {
    return {
      outcome: "conflict" as const,
      reason: plan.blockers[0]?.reason ?? ("setup_plan_changed" as const),
      blockers: plan.blockers,
      plan,
      changed: [],
    };
  }
  if (plan.id !== input.approvedPlanId) {
    return {
      outcome: "conflict" as const,
      reason: "setup_plan_changed" as const,
      blockers: [
        {
          reason: "setup_plan_changed" as const,
          approvedPlanId: input.approvedPlanId,
          currentPlanId: plan.id,
        },
      ],
      plan,
      changed: [],
    };
  }

  const recoverySymlink = await firstSymlink(input.projectRoot, recoveryPath);
  if (recoverySymlink) {
    return {
      outcome: "conflict" as const,
      reason: "setup_path_symlink" as const,
      blockers: [{ reason: "setup_path_symlink" as const, path: recoverySymlink }],
      plan,
      changed: [],
    };
  }
  await mkdir(dirname(`${input.projectRoot}/${recoveryPath}`), { recursive: true });
  const recovery: Recovery = {
    schemaVersion: 1,
    planId: plan.id,
    plan: {
      operatorVersion: plan.operatorVersion,
      targets: plan.targets,
      changes: plan.changes,
      blockers: [],
    },
    state: "applying",
    writes: [],
  };
  await writeRecovery(input.projectRoot, recovery);

  const changed: string[] = [];
  for (const change of plan.changes) {
    const symlink = await firstSymlink(input.projectRoot, change.path);
    if (symlink) {
      if (changed.length === 0) {
        await rm(`${input.projectRoot}/${recoveryPath}`);
      } else {
        recovery.state = "interrupted";
        await writeRecovery(input.projectRoot, recovery);
      }
      return {
        outcome: "conflict" as const,
        reason: "setup_path_symlink" as const,
        blockers: [{ reason: "setup_path_symlink" as const, path: symlink }],
        plan,
        changed,
        ...(changed.length > 0 ? { recoveryPath } : {}),
      };
    }
    const current = Bun.file(`${input.projectRoot}/${change.path}`);
    const currentExists = await current.exists();
    const previousContent = currentExists ? await current.text() : null;
    const currentHash = previousContent === null ? null : hash(previousContent);
    if (currentHash !== change.previousHash) {
      const currentPlan = await planSetup(input);
      if (changed.length === 0) {
        await rm(`${input.projectRoot}/${recoveryPath}`);
      } else {
        recovery.state = "interrupted";
        await writeRecovery(input.projectRoot, recovery);
      }
      return {
        outcome: "conflict" as const,
        reason: "setup_plan_changed" as const,
        blockers: [
          {
            reason: "setup_plan_changed" as const,
            approvedPlanId: input.approvedPlanId,
            currentPlanId: currentPlan.id,
            path: change.path,
          },
        ],
        plan,
        changed,
        ...(changed.length > 0 ? { recoveryPath } : {}),
      };
    }
    const write: Recovery["writes"][number] = {
      path: change.path,
      previousContent,
      contentHash: hash(change.content),
      status: "pending",
    };
    recovery.writes.push(write);
    await writeRecovery(input.projectRoot, recovery);
    try {
      await mkdir(dirname(`${input.projectRoot}/${change.path}`), { recursive: true });
      await Bun.write(`${input.projectRoot}/${change.path}`, change.content);
      write.status = "completed";
      changed.push(change.path);
      await writeRecovery(input.projectRoot, recovery);
    } catch {
      recovery.state = "interrupted";
      await writeRecovery(input.projectRoot, recovery);
      return {
        outcome: "failed" as const,
        reason: "setup_interrupted" as const,
        blockers: [
          {
            reason: "setup_interrupted" as const,
            path: change.path,
            recoveryPath,
          },
        ],
        plan,
        changed,
        recoveryPath,
      };
    }
  }
  await rm(`${input.projectRoot}/${recoveryPath}`);

  return {
    outcome: "completed" as const,
    reason: "setup_applied" as const,
    blockers: [],
    plan,
    changed,
  };
}

type RecoveryBlocker = {
  reason: "setup_path_symlink" | "setup_recovery_conflict";
  path: string;
};

async function buildRecoveryPlan(projectRoot: string, recovery: Recovery) {
  const actions: Array<{
    action: "delete" | "restore";
    path: string;
    content: string | null;
  }> = [];
  const blockers: RecoveryBlocker[] = [];
  for (const write of recovery.writes.toReversed()) {
    if (write.status === "restored") {
      continue;
    }
    const symlink = await firstSymlink(projectRoot, write.path);
    if (symlink) {
      blockers.push({ reason: "setup_path_symlink", path: symlink });
      continue;
    }
    const target = Bun.file(`${projectRoot}/${write.path}`);
    const currentContent = (await target.exists()) ? await target.text() : null;
    if (currentContent === write.previousContent) {
      continue;
    }
    if (currentContent === null || hash(currentContent) !== write.contentHash) {
      blockers.push({ reason: "setup_recovery_conflict", path: write.path });
      continue;
    }
    actions.push({
      action: write.previousContent === null ? "delete" : "restore",
      path: write.path,
      content: write.previousContent,
    });
  }

  const identity = { setupPlanId: recovery.planId, actions, blockers };
  return { id: hash(JSON.stringify(identity)), ...identity };
}

export async function recoverSetup(input: {
  projectRoot: string;
  planId: string;
  approvedRecoveryId?: string;
}) {
  const recoverySymlink = await firstSymlink(input.projectRoot, recoveryPath);
  if (recoverySymlink) {
    return {
      outcome: "conflict" as const,
      reason: "setup_path_symlink" as const,
      blockers: [{ reason: "setup_path_symlink" as const, path: recoverySymlink }],
      planId: input.planId,
      restored: [],
      recoveryPath,
      recoveryPlan: undefined,
    };
  }
  const file = Bun.file(`${input.projectRoot}/${recoveryPath}`);
  if (!(await file.exists())) {
    return {
      outcome: "missing-condition" as const,
      reason: "setup_recovery_not_found" as const,
      blockers: [{ reason: "setup_recovery_not_found" as const, planId: input.planId }],
      planId: input.planId,
      restored: [],
      recoveryPath,
    };
  }

  const parsed = RecoverySchema.safeParse(await file.json().catch(() => undefined));
  if (
    !parsed.success ||
    parsed.data.planId !== input.planId ||
    !recoveryMatchesApprovedPlan(parsed.data)
  ) {
    return {
      outcome: "conflict" as const,
      reason: "setup_recovery_conflict" as const,
      blockers: [
        {
          reason: "setup_recovery_conflict" as const,
          planId: input.planId,
          recoveryPlanId: parsed.success ? parsed.data.planId : undefined,
          path: recoveryPath,
        },
      ],
      planId: input.planId,
      restored: [],
      recoveryPath,
      recoveryPlan: undefined,
    };
  }

  const recovery = parsed.data;
  const recoveryPlan = await buildRecoveryPlan(input.projectRoot, recovery);
  if (recoveryPlan.actions.length === 0 && recoveryPlan.blockers.length > 0) {
    return {
      outcome: "conflict" as const,
      reason: "setup_recovery_conflict" as const,
      blockers: recoveryPlan.blockers,
      planId: input.planId,
      restored: [],
      recoveryPath,
      recoveryPlan,
    };
  }
  if (!input.approvedRecoveryId) {
    return {
      outcome: "missing-condition" as const,
      reason: "setup_recovery_approval_required" as const,
      blockers: [
        {
          reason: "setup_recovery_approval_required" as const,
          recoveryPlanId: recoveryPlan.id,
        },
        ...recoveryPlan.blockers,
      ],
      planId: input.planId,
      restored: [],
      recoveryPath,
      recoveryPlan,
    };
  }
  if (input.approvedRecoveryId !== recoveryPlan.id) {
    return {
      outcome: "conflict" as const,
      reason: "setup_recovery_plan_changed" as const,
      blockers: [
        {
          reason: "setup_recovery_plan_changed" as const,
          approvedRecoveryId: input.approvedRecoveryId,
          currentRecoveryId: recoveryPlan.id,
        },
      ],
      planId: input.planId,
      restored: [],
      recoveryPath,
      recoveryPlan,
    };
  }

  const restored: string[] = [];
  for (const action of recoveryPlan.actions) {
    const write = recovery.writes.find((candidate) => candidate.path === action.path);
    if (!write) {
      throw new Error(`Recovery action has no recorded write for ${action.path}`);
    }
    const symlink = await firstSymlink(input.projectRoot, action.path);
    const target = Bun.file(`${input.projectRoot}/${action.path}`);
    const currentContent = symlink || !(await target.exists()) ? null : await target.text();
    if (symlink || currentContent === null || hash(currentContent) !== write.contentHash) {
      return {
        outcome: "conflict" as const,
        reason: "setup_recovery_plan_changed" as const,
        blockers: [
          {
            reason: "setup_recovery_plan_changed" as const,
            approvedRecoveryId: input.approvedRecoveryId,
            path: action.path,
          },
        ],
        planId: input.planId,
        restored,
        recoveryPath,
        recoveryPlan: await buildRecoveryPlan(input.projectRoot, recovery),
      };
    }
    if (action.action === "delete") {
      await rm(`${input.projectRoot}/${action.path}`);
    } else {
      await Bun.write(`${input.projectRoot}/${action.path}`, action.content ?? "");
    }
    write.status = "restored";
    restored.push(action.path);
    await writeRecovery(input.projectRoot, recovery);
  }

  if (recoveryPlan.blockers.length > 0) {
    return {
      outcome: "conflict" as const,
      reason: "setup_recovery_conflict" as const,
      blockers: recoveryPlan.blockers,
      planId: input.planId,
      restored,
      recoveryPath,
      recoveryPlan: await buildRecoveryPlan(input.projectRoot, recovery),
    };
  }

  await rm(`${input.projectRoot}/${recoveryPath}`);
  return {
    outcome: "completed" as const,
    reason: "setup_recovered" as const,
    blockers: [],
    planId: input.planId,
    restored,
    recoveryPath,
    recoveryPlan,
  };
}
