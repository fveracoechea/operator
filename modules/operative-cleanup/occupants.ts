import { HerdrControl } from "../herdr-control/main.ts";

/** One tool the Operative host started inside its own pane. */
export type ChildTool = { pid: number; name: string; command: string };

export type Occupancy =
  | { status: "read"; occupants: string[]; childTools: ChildTool[] }
  | { status: "unknown"; detail: string };

/** The agents Herdr holds in one workspace, named by the pane they occupy. */
async function occupantsOf(workspaceId: string): Promise<string[] | { detail: string }> {
  const listed = await HerdrControl.listAgents();
  if (listed.status === "unknown") {
    return { detail: listed.detail };
  }
  if (listed.status === "absent") {
    return [];
  }

  return listed.value
    .filter((agent) => agent.paneId.startsWith(`${workspaceId}:`))
    .map((agent) => agent.name ?? agent.paneId)
    .toSorted();
}

/** The processes one pane runs beside its own shell. */
async function childToolsOf(paneId: string): Promise<ChildTool[] | { detail: string }> {
  const read = await HerdrControl.readPaneProcesses({ paneId });
  if (read.status === "unknown") {
    return { detail: read.detail };
  }
  if (read.status === "absent") {
    return [];
  }

  const shellPid = read.value.shellPid;
  return read.value.foreground
    .filter((process) => process.pid !== shellPid)
    .map((process) => ({ pid: process.pid, name: process.name, command: process.command }));
}

/**
 * Reads who occupies one Operative workspace and what its pane runs.
 * A review runs its two axes as sub-agents of one host, so they hold no Herdr agent and no
 * pane of their own. Whatever else is here was never launched by this attempt.
 */
export async function readOccupancy(request: {
  workspaceId: string;
  paneId: string;
}): Promise<Occupancy> {
  const [occupants, childTools] = await Promise.all([
    occupantsOf(request.workspaceId),
    childToolsOf(request.paneId),
  ]);

  if (!Array.isArray(occupants)) {
    return { status: "unknown", detail: occupants.detail };
  }
  if (!Array.isArray(childTools)) {
    return { status: "unknown", detail: childTools.detail };
  }

  return { status: "read", occupants, childTools };
}
