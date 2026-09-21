import { type Capacity, readCapacity } from "./capacity.ts";
import { acceptAssignment, claimAssignment } from "./claims.ts";
import { calculateFrontier } from "./frontier.ts";
import { mutate, readState } from "./operations.ts";
import { claimOwnership, currentOwnership } from "./ownership.ts";
import { registerWork } from "./registration.ts";
import { STATE_VERSION } from "./schema.ts";
import { describeIssue, workInputSchema } from "./work-input.ts";

type Located = { projectRoot: string };
type Mutation = Located & { requestId: string; ownerToken: string };

/** Only the named final status commits; every other status leaves the state unchanged. */
function commitOn<Outcome extends { status: string }>(
  outcome: Outcome,
  accepted: Outcome["status"],
): { commit: boolean; outcome: Outcome } {
  return { commit: outcome.status === accepted, outcome };
}

async function capacityOrFailure(
  projectRoot: string,
): Promise<Capacity | { status: "invalid-configuration"; issues: string[] }> {
  const read = await readCapacity(projectRoot);
  return read.status === "ok" ? read.capacity : read;
}

export const CrewState = {
  /**
   * Takes durable crew ownership, creating the crew state when this crew has none.
   * A takeover replaces the active token, so every later mutation under the old token fails.
   */
  async own(request: Located & { requestId: string; ownerLabel: string; takeover: boolean }) {
    return mutate(
      {
        projectRoot: request.projectRoot,
        requestId: request.requestId,
        ownerToken: null,
        now: new Date().toISOString(),
        operation: "crew_own",
        input: { ownerLabel: request.ownerLabel, takeover: request.takeover },
        create: true,
      },
      ({ tx, now }) =>
        commitOn(
          claimOwnership(tx, {
            ownerLabel: request.ownerLabel,
            takeover: request.takeover,
            token: crypto.randomUUID(),
            now,
          }),
          "acquired",
        ),
    );
  },

  /**
   * Registers approved work from one source, preserving its revision, scope, acceptance
   * requirements, permissions, fixed inputs, dependencies, and planning boundary.
   */
  async register(request: Mutation & { input: unknown }) {
    const parsed = workInputSchema.safeParse(request.input);
    if (!parsed.success) {
      return {
        repeated: false,
        result: {
          status: "invalid-input" as const,
          issues: parsed.error.issues.map(describeIssue),
        },
      };
    }

    const input = parsed.data;
    return mutate(
      {
        projectRoot: request.projectRoot,
        requestId: request.requestId,
        ownerToken: request.ownerToken,
        now: new Date().toISOString(),
        operation: "work_register",
        input,
      },
      ({ tx, now }) => commitOn(registerWork(tx, { input, now }), "registered"),
    );
  },

  /** Claims one dispatchable assignment. Exactly one concurrent claim wins. */
  async claim(request: Mutation & { assignmentId: string; revision: number }) {
    const capacity = await capacityOrFailure(request.projectRoot);
    if ("status" in capacity) {
      return { repeated: false, result: capacity };
    }

    return mutate(
      {
        projectRoot: request.projectRoot,
        requestId: request.requestId,
        ownerToken: request.ownerToken,
        now: new Date().toISOString(),
        operation: "work_claim",
        input: { assignmentId: request.assignmentId, revision: request.revision },
      },
      ({ tx, now }) =>
        commitOn(
          claimAssignment(tx, {
            assignmentId: request.assignmentId,
            revision: request.revision,
            ownerToken: request.ownerToken,
            attemptId: crypto.randomUUID(),
            capacity,
            now,
          }),
          "claimed",
        ),
    );
  },

  /** Records accepted completion, which is the only result that unblocks a dependent. */
  async accept(request: Mutation & { assignmentId: string; attemptId: string; revision: number }) {
    return mutate(
      {
        projectRoot: request.projectRoot,
        requestId: request.requestId,
        ownerToken: request.ownerToken,
        now: new Date().toISOString(),
        operation: "work_accept",
        input: {
          assignmentId: request.assignmentId,
          attemptId: request.attemptId,
          revision: request.revision,
        },
      },
      ({ tx, now }) =>
        commitOn(
          acceptAssignment(tx, {
            assignmentId: request.assignmentId,
            attemptId: request.attemptId,
            revision: request.revision,
            now,
          }),
          "accepted",
        ),
    );
  },

  /** Reports the work a crew of this size may start now, and why the rest waits. Writes nothing. */
  async frontier(request: Located) {
    const capacity = await capacityOrFailure(request.projectRoot);
    if ("status" in capacity) {
      return capacity;
    }

    return readState(request.projectRoot, (db) => {
      const ownership = currentOwnership(db);
      return {
        status: "reported" as const,
        stateVersion: STATE_VERSION,
        // The owner token stays out of a read anyone may run; only its identity is reported.
        ownership:
          ownership === null
            ? null
            : {
                ownerLabel: ownership.ownerLabel,
                acquiredAt: ownership.acquiredAt,
                revision: ownership.revision,
              },
        ...calculateFrontier(db, capacity),
      };
    });
  },
};
