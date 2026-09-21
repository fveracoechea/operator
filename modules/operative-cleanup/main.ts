import { HerdrControl } from "../herdr-control/main.ts";
import { type CheckoutInspection, inspectCheckout } from "./inspect.ts";
import { type Occupancy, readOccupancy } from "./occupants.ts";
import { type EvidenceItem, preserveEvidence, verifyEvidence } from "./preserve.ts";
import { removeCheckout, type RemoveOutcome } from "./remove.ts";
import { stopHost, type TerminationProof } from "./stop.ts";

export const OperativeCleanup = {
  /**
   * Reads one Operative checkout as a disposal decision needs it: the work it holds, the files
   * nobody registered, and the commits no remote keeps. Every call here is a read.
   */
  async inspect(request: {
    worktreePath: string;
    baseCommit: string;
    allowedPrefixes: string[];
  }): Promise<CheckoutInspection> {
    return inspectCheckout(request);
  },

  /**
   * Reads the Herdr record of one checkout.
   * A checkout Herdr does not hold is not a Herdr-managed worktree, and this release removes
   * nothing else, so the answer decides whether a removal may even be attempted.
   */
  async findCheckout(request: { repoRoot: string; path: string }) {
    return HerdrControl.findWorktree(request);
  },

  /** Reads who occupies one Operative workspace and which child tools its pane still runs. */
  async occupancy(request: { workspaceId: string; paneId: string }): Promise<Occupancy> {
    return readOccupancy(request);
  },

  /**
   * Stops one Operative through its own host's stop keys and proves what became of it.
   * Herdr closes no pane and no workspace here, so a host that refuses to stop stays live and
   * reports itself rather than being taken apart.
   */
  async stop(request: { agentName: string; agentHost: string }): Promise<TerminationProof> {
    return stopHost(request);
  },

  /** Copies the named evidence out of one worktree and verifies every copy it made. */
  async preserve(request: {
    projectRoot: string;
    worktreePath: string;
    attemptId: string;
    copies: Array<{ name: string; path: string }>;
    held: Array<{ name: string; storedPath: string; contentIdentity: string }>;
  }) {
    return preserveEvidence(request);
  },

  /** Reads every preserved copy back, which is the last gate before a checkout is removed. */
  async verify(request: { projectRoot: string; items: EvidenceItem[] }) {
    return verifyEvidence(request);
  },

  /**
   * Removes one Herdr-managed checkout and reads back whether it is gone.
   * Removal is never forced, deletes no branch, closes no workspace group, and runs no Git or
   * filesystem deletion of its own, so an unsafe checkout survives the request.
   */
  async remove(request: {
    repoRoot: string;
    workspaceId: string;
    worktreePath: string;
  }): Promise<RemoveOutcome> {
    return removeCheckout(request);
  },
};
