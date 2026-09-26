import { OperatorRelease } from "../operator-release/main.ts";
import { readMerged, readRelease, readTag } from "./github-release.ts";
import { type JournalRead, type PathRecord, readJournal } from "./journal.ts";
import { readVersion } from "./jsr-registry.ts";

export const REPOSITORY = "fveracoechea/operator";
export const JSR_SCOPE = "fveracoechea";
export const JSR_PACKAGE = "operator";
export const JSR_API = "https://api.jsr.io";

export type DeliveryPath = "github-source" | "jsr";

export type ReleaseBlocker = {
  reason:
    | "artifact_incomplete"
    | "artifact_changed"
    | "commit_not_merged"
    | "tag_moved"
    | "version_published"
    | "unreadable_journal";
  detail: string;
  nextAction: string;
};

export type PathState = {
  path: DeliveryPath;
  state: "missing" | "published" | "blocked";
  detail: string;
};

function blocker(
  reason: ReleaseBlocker["reason"],
  detail: string,
  nextAction: string,
): ReleaseBlocker {
  return { reason, detail, nextAction };
}

export type PlanRequest = {
  artifactRoot: string;
  commit: string;
  base: string;
  repository?: string;
  jsr?: { api: string; scope: string; package: string; fetch: typeof fetch };
  journalPath: string;
};

export function jsrSettings(request: PlanRequest) {
  return (
    request.jsr ?? { api: JSR_API, scope: JSR_SCOPE, package: JSR_PACKAGE, fetch: globalThis.fetch }
  );
}

async function readPublishedVersion(request: PlanRequest, version: string) {
  return readVersion({ ...jsrSettings(request), version });
}

/**
 * Inspects the exact artifact, commit, and published state one release would act on.
 * The identity covers the version, the commit, and every published byte, so a retry never sends
 * a changed artifact under a version it already delivered, and changed content needs a new
 * version. The workflow runs this only after the commit passed its checks.
 */
export async function computeReleasePlan(request: PlanRequest) {
  const repository = request.repository ?? REPOSITORY;
  const inspection = await OperatorRelease.inspect({ artifactRoot: request.artifactRoot });
  const manifest: { version?: string; commit?: string } = (await Bun.file(
    `${request.artifactRoot}/release.json`,
  ).exists())
    ? await Bun.file(`${request.artifactRoot}/release.json`).json()
    : {};
  const version = manifest.version ?? "0.0.0";
  const tag = `v${version}`;

  const blockers: ReleaseBlocker[] = [];
  if (inspection.status === "incomplete") {
    blockers.push(
      blocker(
        "artifact_incomplete",
        `The artifact is missing ${inspection.missing.join(", ")}.`,
        "Build the release artifact again from the release commit.",
      ),
    );
  }
  if (manifest.commit !== undefined && manifest.commit !== request.commit) {
    blockers.push(
      blocker(
        "artifact_changed",
        `The artifact was built from commit ${manifest.commit}, and this release names ${request.commit}.`,
        "Build the artifact from the commit this release names.",
      ),
    );
  }

  const journal: JournalRead = await readJournal(request.journalPath);
  if (journal.state === "unreadable") {
    blockers.push(
      blocker(
        "unreadable_journal",
        `The publication record cannot be read: ${journal.detail}`,
        "Decide what the publication record should be, then plan the release again.",
      ),
    );
  }
  if (
    journal.state === "read" &&
    journal.journal.artifactIdentity !== inspection.artifactIdentity
  ) {
    blockers.push(
      blocker(
        "artifact_changed",
        "The artifact differs from the one the recorded publication delivered, so a retry would send different content under the same version.",
        "Restore the artifact the recorded publication delivered, or publish changed content as a new version.",
      ),
    );
  }

  const [merged, tagState, releaseState, publishedVersion] = await Promise.all([
    readMerged({ repository, base: request.base, commit: request.commit }),
    readTag({ repository, tag }),
    readRelease({ repository, tag }),
    readPublishedVersion(request, version),
  ]);

  if (merged.status === "not-merged") {
    blockers.push(
      blocker(
        "commit_not_merged",
        `Commit ${request.commit} is ${merged.comparison} ${request.base}, so it is not a merged commit.`,
        "Publish only a commit that is merged into the release branch.",
      ),
    );
  }
  if (merged.status === "unknown") {
    blockers.push(
      blocker(
        "commit_not_merged",
        `Whether ${request.commit} is merged could not be established: ${merged.detail}`,
        "Establish that the commit is merged, then plan the release again.",
      ),
    );
  }
  const recorded: Partial<Record<DeliveryPath, PathRecord>> =
    journal.state === "read" ? journal.journal.paths : {};
  const sourceDone =
    tagState.status === "present" && releaseState.status === "present"
      ? `The tag ${tag} and its release already exist.`
      : null;

  const jsrPublished = publishedVersion.status === "succeeded" && publishedVersion.value.published;
  // Every push to the release branch carries the version of the last release until the next
  // version pull request merges. Both paths already hold that version, so nothing is due.
  const state: "due" | "released" =
    tagState.status === "present" && releaseState.status === "present" && jsrPublished
      ? "released"
      : "due";

  if (state === "due" && tagState.status === "present" && tagState.sha !== request.commit) {
    blockers.push(
      blocker(
        "tag_moved",
        `The tag ${tag} already names commit ${tagState.sha}, and that release is not complete. A published tag is never moved.`,
        `Run the publication of commit ${tagState.sha} again, so the missing path receives the artifact built there.`,
      ),
    );
  }

  // A version this release tried to send may have landed after the client failed, so only a
  // version with no record of this release at all belongs to someone else.
  if (state === "due" && jsrPublished && recorded.jsr === undefined) {
    blockers.push(
      blocker(
        "version_published",
        `JSR already holds ${JSR_SCOPE}/${JSR_PACKAGE}@${version}, and this release has no record of publishing it.`,
        "Publish the changed content as a new version.",
      ),
    );
  }

  const paths: PathState[] = [
    {
      path: "github-source",
      state: sourceDone === null ? "missing" : "published",
      detail: sourceDone ?? `The tag ${tag} and its release still have to be created.`,
    },
    {
      path: "jsr",
      state: jsrPublished ? "published" : "missing",
      detail: jsrPublished
        ? `JSR already holds version ${version}.`
        : `JSR does not hold version ${version} yet.`,
    },
  ];

  const body = {
    repository,
    version,
    tag,
    commit: request.commit,
    artifactIdentity: inspection.artifactIdentity,
    artifact: { root: inspection.artifactRoot, missing: inspection.missing },
    state,
    merged,
    // What the source path already holds, so a retry creates only the half that is still missing.
    source: { tag: tagState, release: releaseState },
    paths,
    recorded,
    blockers,
  };

  return {
    ...body,
    // The identity binds the delivery record to this exact version, commit, and published content.
    releaseId: new Bun.CryptoHasher("sha256")
      .update(
        JSON.stringify({
          repository,
          version,
          commit: request.commit,
          artifactIdentity: inspection.artifactIdentity,
        }),
      )
      .digest("hex"),
  };
}

export type ReleasePlan = Awaited<ReturnType<typeof computeReleasePlan>>;
