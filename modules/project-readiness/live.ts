import type { InputName } from "./fingerprints.ts";

/**
 * The revision of what a probe plan declares.
 * It is part of the plan identity, so a change to the checks, the resources, the credentials,
 * or the stated costs makes every earlier approval stale instead of silently covering more.
 */
export const LIVE_PLAN_REVISION = 2;

/** Which claim one live result feeds. A check that fails holds back exactly the claims it feeds. */
export type LiveClaim = "readiness" | "release";

export type LiveGroup = "lifecycle" | "project-readiness" | "tracker" | "provider";

export type LiveCheck = {
  name: string;
  summary: string;
  group: LiveGroup;
  inputs: InputName[];
  claims: LiveClaim[];
  /** The synthetic prompts this check sends to each launched host, which is what a provider bills. */
  prompts: { operator: number; crew: number };
};

const HERDR_INPUTS: InputName[] = ["platform", "tool:herdr", "tool:git"];
const HOST_INPUTS: InputName[] = ["platform", "selection", "tool:herdr"];
const AGENT_INPUTS: InputName[] = [
  "platform",
  "selection",
  "operator-release",
  "project-skills",
  "project-instructions",
  "tool:herdr",
];
const TRACKER_INPUTS: InputName[] = ["tool:github"];

const NO_PROMPT = { operator: 0, crew: 0 };

/**
 * The checks a static observation cannot prove. They launch agents and use the model provider, so
 * they run only under their own approval and their results are read back from recorded evidence.
 * Each check names the inputs it was proven against, so a change invalidates it alone.
 */
export const liveChecks: LiveCheck[] = [
  {
    name: "herdr-worktree",
    summary: "Herdr creates, reports, and holds one managed test worktree.",
    group: "lifecycle",
    inputs: HERDR_INPUTS,
    claims: ["readiness"],
    prompts: NO_PROMPT,
  },
  {
    name: "agent-launch",
    summary: "Herdr starts the selected host in the test worktree and names the pane it owns.",
    group: "lifecycle",
    inputs: HOST_INPUTS,
    claims: ["readiness"],
    prompts: NO_PROMPT,
  },
  {
    name: "instruction-and-skill-loading",
    summary: "The launched agent loads the project instructions and the selected skill contents.",
    group: "project-readiness",
    inputs: AGENT_INPUTS,
    claims: ["readiness"],
    prompts: { operator: 1, crew: 0 },
  },
  {
    name: "bounded-observation",
    summary:
      "A bounded read reports what the launched host did, and it never waits without a limit.",
    group: "lifecycle",
    inputs: HOST_INPUTS,
    claims: ["readiness"],
    prompts: NO_PROMPT,
  },
  {
    name: "question-and-answer",
    summary: "A test question reaches the Operative and its answer is acknowledged.",
    group: "project-readiness",
    inputs: HOST_INPUTS,
    claims: ["readiness"],
    prompts: { operator: 1, crew: 0 },
  },
  {
    name: "result-reporting",
    summary: "The Operative reports a synthetic result through the supported protocol.",
    group: "project-readiness",
    inputs: HOST_INPUTS,
    claims: ["readiness"],
    prompts: { operator: 1, crew: 0 },
  },
  {
    name: "review-sub-agents",
    summary: "One review agent runs its native Standards and Spec sub-agents in parallel.",
    group: "project-readiness",
    inputs: HOST_INPUTS,
    claims: ["readiness"],
    prompts: { operator: 0, crew: 1 },
  },
  {
    name: "mixed-host-operation",
    summary: "One crew runs the Operator host and the Crew host together in the same probe.",
    group: "lifecycle",
    inputs: HOST_INPUTS,
    claims: ["readiness", "release"],
    prompts: NO_PROMPT,
  },
  {
    name: "interruption",
    summary:
      "An interrupted host stops being reported as live and leaves its partial work in place.",
    group: "lifecycle",
    inputs: HOST_INPUTS,
    claims: ["readiness"],
    prompts: { operator: 1, crew: 0 },
  },
  {
    name: "explicit-takeover",
    summary:
      "A second Operator takes crew ownership while a writer is live, and the replaced token can no longer write.",
    group: "lifecycle",
    inputs: HOST_INPUTS,
    claims: ["readiness"],
    prompts: NO_PROMPT,
  },
  {
    name: "host-termination",
    summary: "Herdr stops the launched host process and reports it stopped, leaving no child tool.",
    group: "lifecycle",
    inputs: HOST_INPUTS,
    claims: ["readiness"],
    prompts: NO_PROMPT,
  },
  {
    name: "worktree-removal",
    summary: "Herdr removes the managed test worktree and stops reporting it.",
    group: "lifecycle",
    inputs: HERDR_INPUTS,
    claims: ["readiness"],
    prompts: NO_PROMPT,
  },
  {
    name: "github-comment",
    summary:
      "A marked comment is written on the fixture issue and read back by its own identifier.",
    group: "tracker",
    inputs: TRACKER_INPUTS,
    claims: ["readiness", "release"],
    prompts: NO_PROMPT,
  },
  {
    name: "github-pagination",
    summary:
      "A comment scan of the fixture issue reads every accessible page and states what it covered.",
    group: "tracker",
    inputs: TRACKER_INPUTS,
    claims: ["readiness", "release"],
    prompts: NO_PROMPT,
  },
  {
    name: "github-amendment",
    summary:
      "An explicit amendment on the fixture map reads as an amendment, and a discussion comment does not.",
    group: "tracker",
    inputs: TRACKER_INPUTS,
    claims: ["readiness", "release"],
    prompts: NO_PROMPT,
  },
  {
    name: "github-dependencies",
    summary: "The fixture issue reports the issues that block it.",
    group: "tracker",
    inputs: TRACKER_INPUTS,
    claims: ["readiness", "release"],
    prompts: NO_PROMPT,
  },
  {
    name: "github-sub-issues",
    summary: "The fixture issue reports the sub-issues published under it.",
    group: "tracker",
    inputs: TRACKER_INPUTS,
    claims: ["readiness", "release"],
    prompts: NO_PROMPT,
  },
  {
    name: "github-events",
    summary: "The closure history of the fixture issue is read, including a reopen after a close.",
    group: "tracker",
    inputs: TRACKER_INPUTS,
    claims: ["readiness", "release"],
    prompts: NO_PROMPT,
  },
  {
    name: "github-closure",
    summary: "The fixture issue closes with an explicit reason, and that reason is read back.",
    group: "tracker",
    inputs: TRACKER_INPUTS,
    claims: ["readiness", "release"],
    prompts: NO_PROMPT,
  },
  {
    name: "provider-compatibility",
    summary: "The selected models answer through their provider for each selected host.",
    group: "provider",
    inputs: ["selection"],
    claims: ["readiness", "release"],
    // It reads what the earlier checks already proved, so it sends no prompt of its own.
    prompts: NO_PROMPT,
  },
];

export const probeTemporaryResources = [
  "One scratch Git repository under `.operator/local/probe/`, holding synthetic files only.",
  "One Herdr-managed test worktree of that scratch repository.",
  "One Herdr crew agent on the Operator host.",
  "One Herdr crew agent on the Crew host, which runs the review sub-agents.",
  "One crew state database in the scratch repository, used by the takeover check alone.",
];

export const probeProviderUse = [
  "Each launched host sends synthetic prompts to its own model provider and is billed for them.",
  "No project work, commit, push, merge, publication, or project issue write is part of the probe.",
];

export const probeCredentials = [
  "Provider credentials for each selected host, read by that host from its own configuration. Operator never reads, copies, or records them.",
];

export const PROBE_FIXTURE_CREDENTIAL =
  "A GitHub token that may comment on and close the probe fixture issue, read by `gh` from its own configuration.";

export const PROBE_FIXTURE_MISSING =
  "No probe fixture is configured, so every GitHub check is skipped and stays unverified. Set `probe.githubFixture` in `.operator/config.json`.";

export const probeCleanup = [
  "The worktree-removal check removes the Herdr test worktree it created, because removing it is the check.",
  "The scratch repository and the recorded evidence stay until `operator setup probe cleanup` is approved on its own.",
  "The probe removes no Operative worktree, no branch, and no resource it did not create.",
];
