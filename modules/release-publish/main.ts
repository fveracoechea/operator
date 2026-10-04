import { ContentIdentity } from "../content-identity/main.ts";
import { OperatorRelease } from "../operator-release/main.ts";
import { createRelease, createTag } from "./github-release.ts";
import { DeliveryPath, type DeliveryPathEvent } from "./delivery.ts";
import { type PublicationJournal, readJournal, writeJournal } from "./journal.ts";
import { publishWithClient, readVersion } from "./jsr-registry.ts";
import { scanArtifact } from "./pack.ts";
import {
  computeReleasePlan,
  jsrSettings,
  pathFacts,
  type PlanRequest,
  type ReleasePlan,
} from "./plan.ts";
import { packTarball } from "./tar.ts";

type PublishRequest = PlanRequest & { now?: string };

/** What one attempt on one path reports, as the event the delivery path machine takes. */
type DeliveryOutcome = {
  event: Exclude<DeliveryPathEvent, "plan">;
  detail: string;
  reference: string | null;
  at: string;
};

/** A send that did not succeed is uncertain only when the tool could not say what happened. */
function unsent(
  status: "failed" | "uncertain",
  detail: string,
  reference: string | null,
  at: string,
): DeliveryOutcome {
  return {
    event: status === "uncertain" ? "send-uncertain" : "send-failed",
    detail,
    reference,
    at,
  };
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
   * Packs one built artifact into the gzipped tarball a registry serves.
   * The bytes are fixed by the artifact alone, so the smoke test installs exactly what a
   * registry would hold.
   */
  async pack(request: { artifactRoot: string; prefix?: string }) {
    const entries = await scanArtifact(request.artifactRoot, request.prefix ?? "");
    const bytes = packTarball(entries);

    return { bytes, entries: entries.length, identity: ContentIdentity.ofBytes(bytes) };
  },

  /**
   * Delivers only the paths this release has not delivered yet.
   * A published tag is never moved and a published version is never replaced, so a retry of a
   * partial publication carries the same artifact to the missing path and nothing else. A
   * version both paths already hold is released, and nothing is sent.
   */
  async publish(request: PublishRequest) {
    const plan = await computeReleasePlan(request);
    if (plan.blockers.length > 0) {
      return { status: "blocked" as const, plan };
    }
    if (plan.state === "released") {
      return { status: "released" as const, plan };
    }

    const now = request.now ?? new Date().toISOString();
    const held = await readJournal(request.journalPath);
    const journal = merged(plan, held.state === "read" ? held.journal : null);

    for (const path of plan.paths) {
      const recorded = DeliveryPath.state(journal.paths[path.path]);
      const planned = DeliveryPath.decide(recorded, "plan", pathFacts(plan, path));
      // A path this release already recorded as delivered has nothing left to deliver.
      const deliver = "refused" in planned ? undefined : planned.effects[0];
      if (deliver?.kind !== "deliver") {
        continue;
      }

      const outcome: DeliveryOutcome = deliver.observed
        ? { event: "observed-published", detail: path.detail, reference: null, at: now }
        : path.path === "github-source"
          ? await publishSource(plan)
          : await publishRegistry(plan, request, now);
      const delivered = DeliveryPath.decide(recorded, outcome.event, outcome);
      for (const effect of "refused" in delivered ? [] : delivered.effects) {
        if (effect.kind === "record") {
          journal.paths[path.path] = effect.record;
        }
      }
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

  /** Reports what one release has already delivered. Writes nothing. */
  async delivered(request: { journalPath: string }) {
    return readJournal(request.journalPath);
  },

  /** The artifact this release would publish, identified by every byte it holds. */
  async artifact(request: { artifactRoot: string }) {
    return OperatorRelease.inspect(request);
  },
};

async function publishSource(plan: ReleasePlan): Promise<DeliveryOutcome> {
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
    return unsent(tagged.status, tagged.detail, null, now);
  }

  const released = await createRelease({
    repository: plan.repository,
    tag: plan.tag,
    name: `Operator ${plan.version}`,
    body: plan.notes ?? "",
  });

  if (released.status !== "succeeded") {
    return unsent(released.status, released.detail, plan.tag, now);
  }

  return {
    event: "send-succeeded",
    detail: alreadyTagged
      ? `The release of the existing tag ${plan.tag} was created.`
      : `The tag ${plan.tag} and its release were created.`,
    reference: released.value.url,
    at: now,
  };
}

async function publishRegistry(
  plan: ReleasePlan,
  request: PublishRequest,
  now: string,
): Promise<DeliveryOutcome> {
  const sent = await publishWithClient({ artifactRoot: plan.artifact.root });
  if (sent.status === "succeeded") {
    return {
      event: "send-succeeded",
      detail: `JSR published version ${plan.version}.`,
      reference: null,
      at: now,
    };
  }

  // The client may have sent the version before it failed, so the registry answers what landed.
  const landed = await readVersion({ ...jsrSettings(request), version: plan.version });
  if (landed.status === "succeeded" && landed.value.published) {
    return {
      event: "observed-published",
      detail: `JSR holds version ${plan.version}, although the client reported: ${sent.detail}`,
      reference: null,
      at: now,
    };
  }

  return unsent(sent.status, sent.detail, null, now);
}
