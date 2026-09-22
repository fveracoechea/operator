import { CrewState } from "../crew-state/main.ts";
import { HerdrControl } from "../herdr-control/main.ts";
import type { Launched } from "./agents.ts";
import type { Scratch } from "./scratch.ts";
import { failed, passed, type Staged } from "./stage.ts";

/**
 * Proves the crew ownership takeover while a writer is live.
 * The probe takes ownership of its own scratch crew state, replaces it, and shows that the
 * replaced token can no longer write. It never touches the crew state of the project.
 */
export async function proveTakeover(scratch: Scratch, agent: Launched): Promise<Staged> {
  const name = "explicit-takeover";
  const live = await HerdrControl.findAgent({ name: agent.name });
  if (live.status !== "found") {
    return failed(name, "The takeover needs a live writer, and Herdr reported none.");
  }

  const first = await CrewState.own({
    projectRoot: scratch.repo,
    requestId: crypto.randomUUID(),
    ownerLabel: "operator-probe-first",
    takeover: false,
    ownershipRevision: null,
  });
  if (first.result.status !== "acquired") {
    return failed(name, `The scratch crew could not be owned: ${first.result.status}`);
  }

  const second = await CrewState.own({
    projectRoot: scratch.repo,
    requestId: crypto.randomUUID(),
    ownerLabel: "operator-probe-second",
    takeover: true,
    ownershipRevision: first.result.ownership.revision,
  });
  if (second.result.status !== "acquired") {
    return failed(name, `The takeover was refused: ${second.result.status}`);
  }

  const refused = await CrewState.grantApproval({
    projectRoot: scratch.repo,
    requestId: crypto.randomUUID(),
    ownerToken: first.result.ownership.token,
    input: {
      action: "probe.replaced_token",
      targets: [`agent:${agent.name}`],
      scope: "A write the replaced Operator must no longer be able to make.",
      requestRevision: "1",
      exactText: "This write must not land.",
      grantedBy: "human",
    },
  });
  if (refused.result.status !== "ownership-stale") {
    return failed(
      name,
      `The replaced ownership token still wrote: the state answered ${refused.result.status}.`,
    );
  }

  return passed(
    name,
    `Ownership moved from revision ${first.result.ownership.revision} while ${agent.name} was live, and the replaced token was refused.`,
    {
      outputs: [`ownership revision ${second.result.ownership.revision}`],
      evidence: [
        { label: "scratch crew state", path: `${scratch.repo}/.operator/local`, identity: null },
      ],
    },
  );
}
