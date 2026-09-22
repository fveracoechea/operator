import { OperatorRelease } from "../operator-release/main.ts";
import { createRelease, createTag } from "./github-release.ts";
import { type PathRecord, type PublicationJournal, readJournal, writeJournal } from "./journal.ts";
import { awaitTask, createVersion, readOidcCredential } from "./jsr-client.ts";
import { scanArtifact } from "./pack.ts";
import {
  computeReleasePlan,
  JSR_CONFIG,
  jsrSettings,
  type PlanRequest,
  type ReleasePlan,
} from "./plan.ts";
import { packTarball } from "./tar.ts";

type PublishRequest = PlanRequest & {
  approvedReleaseId: string | undefined;
  environment?: Record<string, string | undefined>;
  attempts?: number;
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: string;
};

function record(
  state: PathRecord["state"],
  detail: string,
  reference: string | null,
  now: string,
): PathRecord {
  return { state, detail, reference, at: now };
}

/** Keeps what already happened, and replaces only the path this attempt acted on. */
function merged(plan: ReleasePlan, existing: PublicationJournal | null): PublicationJournal {
  return {
    schemaVersion: 1,
    releaseId: plan.releaseId,
    version: plan.version,
    commit: plan.commit,
    artifactIdentity: plan.artifactIdentity,
    paths: existing?.releaseId === plan.releaseId ? existing.paths : {},
  };
}

export const ReleasePublish = {
  /** Inspects the artifact, the commit, and what is already published. Writes nothing. */
  async plan(request: PlanRequest) {
    return computeReleasePlan(request);
  },

  /**
   * Packs one built artifact into the gzipped tarball a registry receives.
   * The bytes are fixed by the artifact alone, so a retry sends exactly what the approval was
   * granted against.
   */
  async pack(request: { artifactRoot: string; prefix?: string }) {
    const entries = await scanArtifact(request.artifactRoot, request.prefix ?? "");
    const bytes = packTarball(entries);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);

    return { bytes, entries: entries.length, identity: hasher.digest("hex") };
  },

  /**
   * Delivers only the paths this approved release has not delivered yet.
   * A published tag is never moved and a published version is never replaced, so a retry of a
   * partial publication carries the same artifact to the missing path and nothing else.
   */
  async publish(request: PublishRequest) {
    const plan = await computeReleasePlan(request);
    if (plan.blockers.length > 0) {
      return { status: "blocked" as const, plan };
    }
    if (request.approvedReleaseId === undefined) {
      return { status: "approval-required" as const, plan };
    }
    if (request.approvedReleaseId !== plan.releaseId) {
      return { status: "approval-stale" as const, plan };
    }

    const now = request.now ?? new Date().toISOString();
    const held = await readJournal(request.journalPath);
    const journal = merged(plan, held.state === "read" ? held.journal : null);

    for (const path of plan.paths) {
      // A delivery this release already recorded is never sent again and never written over,
      // whatever the registry or the repository answers now.
      if (journal.paths[path.path]?.state === "published") {
        continue;
      }
      if (path.state === "published") {
        journal.paths[path.path] = record("published", path.detail, null, now);
        continue;
      }

      const outcome =
        path.path === "github-source"
          ? await publishSource(plan)
          : await publishRegistry(plan, request, now);
      journal.paths[path.path] = outcome;
    }

    await writeJournal(request.journalPath, journal);

    const delivered = Object.values(journal.paths).filter((one) => one.state === "published");
    const complete = delivered.length === plan.paths.length;
    return {
      status: complete ? ("published" as const) : ("partial" as const),
      plan,
      journal,
      journalPath: request.journalPath,
    };
  },

  /** Reports what one approved release has already delivered. Writes nothing. */
  async delivered(request: { journalPath: string }) {
    return readJournal(request.journalPath);
  },

  /** The artifact this release would publish, identified by every byte it holds. */
  async artifact(request: { artifactRoot: string }) {
    return OperatorRelease.inspect(request);
  },
};

async function publishSource(plan: ReleasePlan): Promise<PathRecord> {
  const now = new Date().toISOString();
  // A tag an earlier attempt already landed on this commit is left exactly as it is, so the
  // retry creates only the release that is still missing instead of writing the tag again.
  const alreadyTagged = plan.source.tag.status === "present" && plan.source.tag.sha === plan.commit;
  const tagged = alreadyTagged
    ? ({ status: "succeeded" } as const)
    : await createTag({
        repository: plan.repository,
        tag: plan.tag,
        commit: plan.commit,
      });
  if (tagged.status !== "succeeded") {
    return record(tagged.status === "uncertain" ? "uncertain" : "failed", tagged.detail, null, now);
  }

  const released = await createRelease({
    repository: plan.repository,
    tag: plan.tag,
    name: `Operator ${plan.version}`,
    body: `Operator ${plan.version} from commit ${plan.commit}.`,
  });

  return released.status === "succeeded"
    ? record(
        "published",
        alreadyTagged
          ? `The release of the existing tag ${plan.tag} was created.`
          : `The tag ${plan.tag} and its release were created.`,
        released.value.url,
        now,
      )
    : record(
        released.status === "uncertain" ? "uncertain" : "failed",
        released.detail,
        plan.tag,
        now,
      );
}

async function publishRegistry(
  plan: ReleasePlan,
  request: PublishRequest,
  now: string,
): Promise<PathRecord> {
  const jsr = jsrSettings(request);
  const credential = await readOidcCredential({
    environment: request.environment ?? process.env,
    fetch: jsr.fetch,
  });
  if (credential.status === "unavailable") {
    return record("failed", credential.detail, null, now);
  }

  const packed = await ReleasePublish.pack({ artifactRoot: plan.artifact.root });
  const created = await createVersion({
    ...jsr,
    version: plan.version,
    credential: credential.header,
    tarball: packed.bytes,
    config: JSR_CONFIG,
  });
  if (created.status !== "succeeded") {
    return record(
      created.status === "uncertain" ? "uncertain" : "failed",
      created.detail,
      null,
      now,
    );
  }

  const settled = await awaitTask({
    api: jsr.api,
    fetch: jsr.fetch,
    taskId: created.value.id,
    attempts: request.attempts ?? 30,
    waitMs: request.waitMs ?? 1000,
    sleep: request.sleep,
  });

  return settled.status === "succeeded"
    ? record("published", `JSR published version ${plan.version}.`, created.value.id, now)
    : record(
        settled.status === "uncertain" ? "uncertain" : "failed",
        settled.detail,
        created.value.id,
        now,
      );
}
