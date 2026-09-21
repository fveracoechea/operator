import type { InputName } from "./fingerprints.ts";

type LiveCheck = { name: string; summary: string; inputs: InputName[] };

/**
 * The checks a static observation cannot prove. They launch agents and use the model provider, so
 * they run only under their own approval and their results are read back from recorded evidence.
 * Each check names the inputs it was proven against, so a change invalidates it alone.
 */
export const liveChecks: LiveCheck[] = [
  {
    name: "herdr-worktree",
    summary: "Herdr creates, reports, and holds one managed test worktree.",
    inputs: ["platform", "tool:herdr", "tool:git"],
  },
  {
    name: "instruction-and-skill-loading",
    summary: "The launched agent loads the project instructions and the selected skill contents.",
    inputs: [
      "platform",
      "selection",
      "operator-release",
      "project-skills",
      "project-instructions",
      "tool:herdr",
    ],
  },
  {
    name: "question-and-answer",
    summary: "A test question reaches the Operator and its answer is acknowledged.",
    inputs: ["platform", "selection", "operator-release", "tool:herdr"],
  },
  {
    name: "result-reporting",
    summary: "The Operative reports a synthetic result through the supported protocol.",
    inputs: ["platform", "selection", "operator-release", "tool:herdr"],
  },
  {
    name: "review-sub-agents",
    summary: "One review agent runs its native Standards and Spec sub-agents in parallel.",
    inputs: ["platform", "selection", "operator-release", "tool:herdr"],
  },
  {
    name: "host-termination",
    summary: "Herdr stops the launched host process and reports it stopped.",
    inputs: ["platform", "selection", "tool:herdr"],
  },
  {
    name: "provider-compatibility",
    summary: "The selected models answer through their provider for each selected host.",
    inputs: ["selection"],
  },
];

export const probeTemporaryResources = [
  "One Herdr-managed test worktree, holding synthetic files only.",
  "One Herdr crew agent on the Operator host.",
  "One Herdr crew agent on the Crew host, which runs the review sub-agents.",
];

export const probeProviderUse = [
  "Each launched host sends synthetic prompts to its own model provider and is billed for them.",
  "No project work, commit, push, or issue tracker write is part of the probe.",
];

export const probeCleanup = "Test-worktree deletion needs its own separate approval.";
