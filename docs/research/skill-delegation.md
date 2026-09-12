# Skill Delegation and Human Input

Date: 2026-09-12. Status: verified research report, not an approved design.
Recovered after the research worker hit a service usage limit, then completed by a
second pass that checked the cited documentation and source claims (see Verification).
Question: [Verify skill delegation and human-input constraints][issue].
Map: [Map the first Operator orchestration workflow][map].

## Result

Operator can reuse the model-invoked research, review, and grilling disciplines.
It cannot claim that unchanged skills permit autonomous invocation of `implement`,
`implement-spec`, or `wayfinder`, or that an Operator decision is a human answer.
Upstream explicitly separates user-invoked orchestration from model-invoked discipline. [U1]

A relay that carries actual human questions and answers can preserve the intent of HITL.
Neither the skills nor the two runtimes guarantee that an agent relay preserves authorship.
An explicit relay contract and runtime tests are required before mixed crews are supported.
The map permits technical choices within an approved brief, but requires escalation for scope,
unspecified user-visible behavior, security permissions, and conflicting requirements. [map]

## Evidence Scope

- Installed baseline: Operator commit `b6071e66ff3c0398d191dc258d3a434c2014d889`. [L1]
- Upstream snapshot: `mattpocock/skills` commit `3cca18b368ae95cdbdebbff572ccafa662551015`, dated 2026-09-04. [U1]
- Git blob IDs match for all eight inspected skill files and their `agents/openai.yaml` files: `implement`, `implement-spec`, `research`, `code-review`, `grilling`, `wayfinder`, `grill-me`, and `grill-with-docs`.
- `skills-lock.json` records source, source path, and computed hash, but not an upstream commit. The blob comparison, not the lockfile alone, establishes this match. [L1]
- The worktree contains `.agents/skills/`, `AGENTS.md`, and `CONTEXT.md`; it has no `.claude/`, `.opencode/`, or `CLAUDE.md`. This is a project snapshot, not an audit of all home-directory installations.
- Read-only version commands returned OpenCode `1.18.29` and Claude Code `2.1.260`. OpenCode source below is pinned to the tag's commit, `16747470f976aca3d362ad730bcd3fe82ecc2c9a`. [O6]
- Official web documentation was read on the report date. It is mutable and contains features newer than these binaries; it is not proof that every described feature works locally.
- No agent configuration, installed skill, issue resolution, or map was changed. No model-driven compatibility experiment was run.

## Installed Contracts

The following requirements are unchanged from the inspected upstream snapshot.
Line references identify the exact point where a delegated workflow needs care.

| Skill | Contract and conflict | Safe boundary or proposed adaptation |
| --- | --- | --- |
| `implement` | Lines 4, 9, 13-15: user-only invocation; TDD at pre-agreed seams; review; commit to the current branch. An Operator cannot automatically invoke this unchanged user-only skill under upstream's rule. [U2][U1] | A human invokes it, or approves a separately named worker adaptation. Pass the approved spec, seams, review base, worktree, and commit authority. |
| `implement-spec` | Lines 4, 23-35: user-only invocation; draft PR; independent implementer worktrees; merger subagents; review; ready PR; worktree cleanup. It is a second coordinator, not a simple implementation worker. [U3] | Do not nest it unchanged under Operator. PR creation, integration, and deletion need the map's distinct approval rules; do not infer them from the skill text. |
| `research` | Lines 6-12: start a background agent, use primary sources, and save one cited Markdown file. Wayfinder also tells the already spawned researcher to load this skill. [U4][U7] | Clarify coordinator versus worker entry. This verification pass used a background agent for documentation checks, while the assigned crew member owned the final report. That division is not a built-in recursion guard. |
| `code-review` | Lines 19, 32, 58-78: ask for a missing fixed point or spec; run Standards and Spec in parallel; preserve separate reports. [U5] | Supply an approved fixed-point SHA and spec pointer. Missing inputs return to Operator, not invented defaults. Run the two axes at a host level that can launch them. |
| `grilling` | Lines 8, 24, 26, 28: ask the current frontier; wait for user answers; facts are the agent's job; decisions are the user's; do not act until the user confirms shared understanding. [U6] | Relay actual human answers. An Operator recommendation, inferred preference, or technical decision cannot fill the user's side of this interview. |
| `wayfinder` | Lines 4, 75-80, 105, 115, 123-125: user-only; HITL resolves through live exchange; research is AFK; at most one non-research resolution per session; claim first; publish resolution and update map. [U7] | Keep HITL decisions live. Main Operator serializes tracker writes in this assignment; workers return artifacts. This write-ownership split is an explicit local adaptation. |
| `grill-me`, `grill-with-docs` | Both have `disable-model-invocation: true`; their bodies call `grilling`, with `domain-modeling` added by `grill-with-docs`. [U8][U12] | Operator can call the model-invoked primitives, not automatically invoke these user-only wrappers. The human requirements remain. |

`implement` also reaches a less visible human gate: installed TDD lines 20-24 require
the seams to be written down and confirmed by the user before any test is written.
An existing explicit approval can be cited; an unconfirmed or changed seam needs a human
answer. Calling it a routine technical choice does not remove this requirement. [U9]

There is no blanket upstream ban on delegation: research and review require it.
The conflicts are specific: user-only entry points, nested coordinator behavior,
missing user inputs, unconditional side effects, and substitution of an agent for a human.
Upstream's invitation to adapt skills permits a fork; it does not make that fork unchanged upstream. [U1]

## Discovery and Instructions

| Area | OpenCode | Claude Code |
| --- | --- | --- |
| Project skills | Discovers `.opencode/skills`, `.claude/skills`, and `.agents/skills` up to the worktree boundary. Global equivalents also load. [O1] | Documents `.claude/skills`, plus personal, managed, plugin, and additional-directory sources. `.agents/skills` is not a documented native discovery path. [C1] |
| This checkout | `.agents/skills` is a documented source unless external discovery is disabled. [O1][O7] | The checkout alone does not establish discoverable project skills. A `.claude/skills` entry or plugin setup is needed. [C1] |
| Agent definitions | `.opencode/agents/*.md` or the `agent` object in `opencode.json`; `mode` is `primary`, `subagent`, or `all`. [O2] | `.claude/agents/*.md`, user or managed agents, plugins, or session-local `--agents` JSON. Name and description are required. [C2] |
| Main agent | A custom primary agent can be selected; `default_agent` must identify a suitable primary agent. [O2][O3] | `claude --agent <name>` or the `agent` setting runs that definition as the main thread. Its prompt replaces the default system prompt; project memory still loads. [C2] |
| Project instructions | Loads `AGENTS.md`, with `CLAUDE.md` as a fallback, plus configured `instructions`. Plain file references are not automatically expanded. [O4] | Loads `CLAUDE.md`, not `AGENTS.md`. An explicit `@AGENTS.md` import or symlink can share the instructions. Ancestor memory files are combined; nested files load on access. [C3] |
| Crew context | Task creates a child session from a task prompt, not a copy of the parent's full conversation. Instruction loading is a separate runtime path. [O6][O8] | Normal subagents do not inherit conversation history or already invoked skills. Custom subagents load the CLAUDE.md hierarchy; built-in Explore and Plan skip it. `skills` explicitly preloads eligible skills. Conversation forks are an exception. [C2] |

Proposed setup: keep one authoritative project skill tree and expose it through the
required host path, for example per-skill relative symlinks in `.claude/skills` pointing
to `.agents/skills`. Claude documents symlinked skill folders; OpenCode's pinned scanner
follows symlinks. Test the complete installed layout before adopting it. [C1][O7]

Do not treat duplicate paths as harmless: OpenCode warns on duplicate names and stores
one value per name, with concurrent loading in this version. No stable winner should be
assumed. Claude gives enterprise skills priority over personal skills, then project skills;
plugin skills have namespaced identities. Local names can also replace bundled skills.
In particular, Matt's `code-review` must not be confused with Claude's bundled review. [O7][C1]

`agents/openai.yaml` is not an OpenCode or Claude Code crew definition in their documented
agent formats. Its `allow_implicit_invocation: false` is not a portable enforcement mechanism.
`CONTEXT.md` and tracker/ADR pointers must be part of the assignment's explicit read contract;
their names alone do not establish that each crew member received them. [L1][O2][C2][O4][C3]

## Invocation and Runtime

Claude supports `disable-model-invocation: true`: only the user invokes that skill, its
description is not offered for automatic invocation, and it cannot be preloaded through
a subagent's `skills` field. `user-invocable: false` is a different control for model-only
use. None of the inspected model-invoked skills uses that second flag. [C1][C2]

OpenCode documents only the common skill metadata and ignores unknown frontmatter.
The pinned loader does not carry `disable-model-invocation` into its skill record.
Thus these installed user-only skills are not protected by that flag in OpenCode.
Use explicit skill permissions and an approved invocation policy if this restriction must
hold. `ask` requires approval to load; `deny` rejects the skill tool call. Neither is
automatically equivalent to upstream's user-only orchestration rule. [O1][O7]

Claude's `skillOverrides` can restrict local skill visibility without editing the file,
but it does not affect plugin skills. A visibility override is not permission to remove
an upstream human gate. OpenCode commands can select an agent and `subtask` behavior;
that is host command configuration, not portable Claude skill frontmatter. [C1][O5]

Claude documents `/skill-name` expansion in `claude -p` prompts. Therefore a process
can submit text through a nominal user invocation path. This proves a transport feature,
not human authorship. Operator-generated `/implement` text must not be passed off as
the user's invocation. Any authorized automated launch needs an explicit adapted contract. [C4][U1]

Native subagent limits differ and change with versions:

- OpenCode 1.18.29 defaults `subagent_depth` to 1. A child also receives a `task` denial unless its definition explicitly supplies a task rule. Both depth and permission matter for nested review or research. [O3][O6]
- OpenCode 1.18.29 requires `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` for native background task calls. Separate Herdr processes are not the same feature. [O6]
- OpenCode's pinned default agent permissions deny `question`; Build and Plan explicitly allow it. A custom Operator or crew definition must not assume the same question access as Build. [O9]
- Current Claude docs allow three subagent layers by default, configurable with `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`. Defaults changed in earlier releases; the old blanket claim that Claude subagents cannot spawn subagents is no longer correct. [C2]
- Normal Claude subagents lack `AskUserQuestion`, even if listed in `tools`. Conversation forks have different tool inheritance, so they need a separate test contract. [C2][C6]
- Current Claude background subagents can surface permission prompts in the main session, a change from versions before 2.1.186. A permission prompt is not a grilling answer. [C2]

## Mixed Crews

Here, Crew member remains the project's subordinate role. A Crew member started as a
separate process can be a main-thread agent in that runtime, not a native child session.
This distinction prevents false assumptions about context, nesting, and question tools. [L1][O2][C2]

| Operator / Crew member host | Assessment |
| --- | --- |
| OpenCode / OpenCode | Native delegation exists, subject to depth, task permissions, background flags, and worktree setup. Herdr-per-member isolation still needs verification. |
| Claude Code / Claude Code | Native delegation exists, with explicit context and tool limits. Native `isolation: worktree` automatically removes unchanged worktrees, so it does not meet the map's separate deletion-approval rule unchanged. [C2][map] |
| OpenCode / Claude Code | No cross-host native subagent contract was found in the reviewed sources. Separate-process launch, question relay, and result collection need a verified Herdr/Operator adapter. |
| Claude Code / OpenCode | Same limit in the reverse direction. Shared Markdown does not connect sessions, permissions, or transcripts. |

These are documentation and source findings, not four passed compatibility tests.
Using a Claude model inside OpenCode is not the same as using the Claude Code runtime.
Keep the review coordinator at Operator level, or explicitly permit nesting; do not silently
replace two independent review contexts with one review because the worker cannot spawn.
Both axes can share the approved diff/spec pointers without sharing each other's findings. [U5][O2][C2]

## Human Input

The following is a proposed relay contract, not a feature already supplied by the skills.

1. A Crew member emits the exact question, numbered frontier, options, recommendation, evidence pointers, and blocked prerequisite. It identifies which work can continue independently.
2. Operator classifies the response source: looked-up fact, recorded human requirement, Operator decision within the brief, or new human answer. These categories remain distinct in storage and in the reply.
3. A HITL question reaches the human through Operator. Operator may add a separately labeled recommendation, but must preserve the question and must not answer on the human's behalf.
4. Record a stable question ID, assignment/session IDs, question revision, exact human reply, source message pointer, time, and applicable scope/spec revision. Link summaries to the original reply; do not replace it with an agent paraphrase.
5. Reply only to the matching pending question. Changed options, changed scope, missing answers, cancellation, and contradictions require clarification, not a default approval. Silence and timeouts never become consent.
6. Recompute the frontier after real answers. Dependent branches wait; independent research or implementation within an approved brief can continue. Obtain the user's final shared-understanding confirmation before acting on the grilling outcome. [U6][map]

What must remain live human input: unresolved grilling decisions; the reaction and decision
that resolve a wayfinder prototype; human-only task actions or approvals; and the final
grilling confirmation. Wayfinder explicitly requires a live exchange for HITL resolution.
A historical requirement can be reused as evidence, but an inferred answer, old preference,
or asynchronously completed questionnaire alone does not establish that a new HITL ticket
had that exchange. Ask the human to confirm its application when the decision is new. [U6][U7]

The map's reserved approvals also remain human authority: new scope or unspecified behavior,
security changes, conflicting requirements, machine-wide setup, merge, publication, and
worktree deletion. Commits, pushes, and PR creation need workflow authorization, which can
be granted in advance for a defined artifact/branch. This report's commit/push authorization
does not authorize any of those other actions. [map]

Claude's SDK documents a real input bridge: `canUseTool` pauses for tool approval or a main
agent's `AskUserQuestion`, and the host returns the human's answer. It is not available as
a question tool in normal Agent-tool subagents. Pre-approved tools can skip the callback;
use enforcement outside prose when an operation must always be checked. [C6]
Headless mode without a permission host denies unresolved permission requests. `dontAsk`
and `--permission-prompts none` are not substitutes for HITL; they remove or deny input
paths. Do not turn on permission bypass merely to keep a crew unattended. [C4]

## Installation Ownership

Upstream offers two distinct models: editable project files via `skills.sh`, updated on
request with `npx skills update`; or a Claude plugin bundle managed by the plugin system.
It explicitly says to choose one, because installing both duplicates the skills. [U1]

The inspected plugin manifest is version `1.2.3` and lists 25 promoted skills. It excludes
`implement-spec`, which remains under `in-progress`; installing the plugin is not equivalent
to this project's full copied set. The official marketplace entry, pinned below, currently points through its `sha` field
at the same upstream commit examined here. Future updates depend on that catalog
pin and the client's update policy, not merely on upstream publishing a tag. [U10][U11]

Claude's official marketplace enables auto-update by default, but users and administrators
can change it. Downloaded changes become active on reload or next launch. The upstream
README's automatic-update description is therefore conditional, not a timing guarantee.
OpenCode's own binary autoupdate is separate from updates to copied skill files. [C5][O3]

Proposed ownership: the project maintainer owns pinned source files, approved adaptations,
and runtime-specific agent definitions. Operator setup owns only explicitly approved new
files or bounded edits; it must preserve existing settings and report name conflicts.
The user owns global settings; a plugin manager owns its cache. Never patch that cache.
For mixed crews, one copied source tree is the simplest candidate for consistent versions;
choosing it over a plugin subscription remains a decision, not this report's authorization.

OpenCode merges configuration layers, with project/runtime and managed overrides.
Claude combines user, project, local, CLI, and managed settings; permission lists merge.
Thus a project file alone does not prove the effective permission policy. Inspect effective
settings and provenance without exporting credentials, then verify in each worktree. [O3][C7]

## Follow-up Questions

- [Define Operator authority and question routing](https://github.com/fveracoechea/operator/issues/2): Will the human approve model-invoked Operator adaptations of user-only entry points, or require a direct user invocation for each? Which record proves live HITL answers and final confirmation?
- [Define safe project-local setup](https://github.com/fveracoechea/operator/issues/5): Which single skill tree and instruction bridge will both hosts use? How will setup handle an existing plugin, global name collision, disabled discovery, or stronger managed permissions without overwriting them?
- [Choose CLI and skill distribution contracts](https://github.com/fveracoechea/operator/issues/7): Who reviews upstream updates and pins the source revision? Is `implement-spec` explicitly excluded, or supported as a separately owned adaptation outside the promoted plugin set?
- [Define quality gates and reviewed completion](https://github.com/fveracoechea/operator/issues/9): Who approves test seams and review base SHAs? Does Operator launch the two review axes, or can a worker do so under an explicit nested-delegation capability?
- [Choose the Operator skill and CLI boundary](https://github.com/fveracoechea/operator/issues/10): What enforces approval scope and answer authorship outside model prose? Does the relay use host-native input callbacks, structured blocked results, or another verified Herdr path?
- [Define crew assignment and recovery lifecycle](https://github.com/fveracoechea/operator/issues/11): Which host/version combinations are tested, and how are pending questions restored without replaying an answer against a changed question or a different worktree?

## Verification

First pass, completed before the worker's usage-limit interruption: instruction and issue
reads; upstream Git blob comparison; official documentation review; pinned OpenCode source
checks; marketplace pin check; local binary version checks.

Second pass, 2026-09-12, re-ran the verification independently:

- Fresh clone of `mattpocock/skills`; all eight `SKILL.md` files and all eight
  `agents/openai.yaml` files re-compared by git blob ID against this worktree: all 16 match. [L1][U1]
- Cited line references in `implement`, `implement-spec`, `research`, `code-review`,
  `grilling`, `wayfinder`, `grill-me`, `grill-with-docs`, and `tdd` re-read locally; each
  quoted requirement (user-only entry, live-exchange HITL, pre-agreed seams, review axes,
  parallel sub-agents) appears at the cited lines.
- Every OpenCode and Claude Code documentation citation re-fetched and checked: all claims
  confirmed, including skill discovery paths and worktree boundary, unknown-frontmatter
  ignoring, `disable-model-invocation` semantics, subagent depth, `AskUserQuestion`
  removal from normal subagents, permission-prompt surfacing for background subagents,
  headless denial, `canUseTool`, and settings layer merging.
- Pinned OpenCode source re-checked: `skill/index.ts` logs a duplicate-name warning and
  stores one value per name with no guaranteed precedence; `task.ts` enforces
  `subagent_depth` default 1 and the background-subagents flag; `agent.ts` denies
  `question` by default while Build and Plan allow it.
- `plugin.json` re-checked: version 1.2.3, 25 promoted skills, `implement-spec` excluded;
  the official marketplace entry pins upstream by its `sha` field. [U10][U11]
- Local binaries re-checked: OpenCode 1.18.29, Claude Code 2.1.260.
- `skills-lock.json` re-inspected: 37 entries, each with source, source type, path, and
  computed hash, and no upstream commit field. [L1]

Minor corrections made during verification: `grill-me` and `grilling` live under
`skills/productivity/` upstream (not `engineering/`); the marketplace entry uses a `sha`
field rather than a ref; the duplicate-name warning appears in source code while the docs
only say to keep names unique.

Not completed: end-to-end skill discovery, denial, nesting, question relay, resume, or mixed
crew tests. No configuration or skill update was installed to obtain these findings.
The later capability test should cover all four host pairs with conflicting skill names,
a user-only invocation attempt, a missing review base, an unanswered HITL round, a denied
side effect, and recovery after interruption. A blocked question must remain blocked.

## Sources

[issue]: https://github.com/fveracoechea/operator/issues/8
[map]: https://github.com/fveracoechea/operator/issues/1
[L1]: https://github.com/fveracoechea/operator/tree/b6071e66ff3c0398d191dc258d3a434c2014d889
[U1]: https://github.com/mattpocock/skills/blob/3cca18b368ae95cdbdebbff572ccafa662551015/README.md
[U2]: https://github.com/mattpocock/skills/blob/3cca18b368ae95cdbdebbff572ccafa662551015/skills/engineering/implement/SKILL.md#L4-L15
[U3]: https://github.com/mattpocock/skills/blob/3cca18b368ae95cdbdebbff572ccafa662551015/skills/in-progress/implement-spec/SKILL.md#L4-L35
[U4]: https://github.com/mattpocock/skills/blob/3cca18b368ae95cdbdebbff572ccafa662551015/skills/engineering/research/SKILL.md#L6-L12
[U5]: https://github.com/mattpocock/skills/blob/3cca18b368ae95cdbdebbff572ccafa662551015/skills/engineering/code-review/SKILL.md#L17-L78
[U6]: https://github.com/mattpocock/skills/blob/3cca18b368ae95cdbdebbff572ccafa662551015/skills/productivity/grilling/SKILL.md#L6-L28
[U7]: https://github.com/mattpocock/skills/blob/3cca18b368ae95cdbdebbff572ccafa662551015/skills/engineering/wayfinder/SKILL.md#L73-L128
[U8]: https://github.com/mattpocock/skills/tree/3cca18b368ae95cdbdebbff572ccafa662551015/skills/engineering/grill-with-docs
[U9]: https://github.com/fveracoechea/operator/blob/b6071e66ff3c0398d191dc258d3a434c2014d889/.agents/skills/tdd/SKILL.md#L18-L26
[U10]: https://github.com/mattpocock/skills/blob/3cca18b368ae95cdbdebbff572ccafa662551015/.claude-plugin/plugin.json
[U11]: https://github.com/anthropics/claude-plugins-official/blob/3deb821cb71ccfaaf2ffa9935e977df314ce5cd5/.claude-plugin/marketplace.json
[U12]: https://github.com/mattpocock/skills/blob/3cca18b368ae95cdbdebbff572ccafa662551015/skills/productivity/grill-me/SKILL.md
[O1]: https://opencode.ai/docs/skills/
[O2]: https://opencode.ai/docs/agents/
[O3]: https://opencode.ai/docs/config/
[O4]: https://opencode.ai/docs/rules/
[O5]: https://opencode.ai/docs/commands/
[O6]: https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/opencode/src/tool/task.ts
[O7]: https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/opencode/src/skill/index.ts
[O8]: https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/opencode/src/session/instruction.ts
[O9]: https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/opencode/src/agent/agent.ts
[C1]: https://code.claude.com/docs/en/skills
[C2]: https://code.claude.com/docs/en/sub-agents
[C3]: https://code.claude.com/docs/en/memory
[C4]: https://code.claude.com/docs/en/headless
[C5]: https://code.claude.com/docs/en/discover-plugins
[C6]: https://code.claude.com/docs/en/agent-sdk/user-input
[C7]: https://code.claude.com/docs/en/settings
