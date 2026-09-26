import { eq } from "drizzle-orm";
import type { CrewReader, CrewWriter } from "./database.ts";
import { operatorOwnership } from "./schema.ts";

export type Ownership = {
  token: string;
  ownerLabel: string;
  acquiredAt: string;
  revision: number;
};

export type OwnershipCheck =
  | { status: "ok"; ownership: Ownership }
  | { status: "unowned" }
  | { status: "stale"; ownership: Ownership };

export function currentOwnership(db: CrewReader): Ownership | null {
  const rows = db.select().from(operatorOwnership).where(eq(operatorOwnership.id, 1)).all();
  return rows[0] ?? null;
}

/** One active token per crew. A token that a takeover replaced can no longer change state. */
export function requireOwnership(db: CrewReader, token: string): OwnershipCheck {
  const ownership = currentOwnership(db);
  if (ownership === null) {
    return { status: "unowned" };
  }

  return ownership.token === token ? { status: "ok", ownership } : { status: "stale", ownership };
}

export type ClaimOwnershipResult =
  | { status: "acquired"; ownership: Ownership; replaced: Ownership | null }
  | { status: "held"; ownership: Ownership }
  | { status: "stale-ownership-revision"; ownership: Ownership };

export function claimOwnership(
  db: CrewWriter,
  request: {
    ownerLabel: string;
    takeover: boolean;
    ownershipRevision: number | null;
    token: string;
    now: string;
  },
): ClaimOwnershipResult {
  const held = currentOwnership(db);
  if (held !== null && !request.takeover) {
    return { status: "held", ownership: held };
  }

  // A takeover states the ownership it inspected, so two takeovers cannot both believe they won.
  if (held !== null && request.ownershipRevision !== held.revision) {
    return { status: "stale-ownership-revision", ownership: held };
  }

  const ownership: Ownership = {
    token: request.token,
    ownerLabel: request.ownerLabel,
    acquiredAt: request.now,
    revision: (held?.revision ?? 0) + 1,
  };

  db.insert(operatorOwnership)
    .values({ id: 1, ...ownership })
    .onConflictDoUpdate({ target: operatorOwnership.id, set: ownership })
    .run();

  return { status: "acquired", ownership, replaced: held };
}
