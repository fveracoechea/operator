# Native delegation retro for PR #420

Recorded on 2026-11-20.
Related pages: [user constraints](issue-373-user-constraints.md), [landing history](issue-373-landing.md), [index](index.md).

## Observed failure and sources

On 2026-11-20, OpenCode session `ses_e07f39eccffez05InJlTWSkRyA` received a native PR #420 implementation assignment that explicitly excluded Operator and Herdr.
Its only tool call loaded `worker-agent`; it then stopped because that skill required an absolute brief.
The session's final response reported no repository changes.
The retro read that session's messages through OpenCode's read-only session API, not Operator state.
The session ID was a local evidence pointer, not a public transcript URL.

On 2026-11-20, the installed skill at `/home/fveracoechea/.config/opencode/skills/worker-agent/SKILL.md` matched the stop instruction returned in that session.
Its observed SHA-256 was `7ea0aeb9326a8f05a8e150e8085a00f510f15d45ed5faa0c4b3b0581b5658ba6`.
Its description scoped it to SuperAgent delegation with an absolute brief; its body assumed Operator dispatch and recorded-state reporting.
The native assignment did not meet that route's requirements.
This evidence supported a workflow-selection failure, not a finding that PR #420's code or tests failed.

On 2026-11-20, the supervising session supplied `/tmp/opencode/issue373-pr420-brief.md` as the replacement native brief.
The retro verified its explicit native identity, allowed tools, output paths, authority boundary, and test-concurrency limit.
The brief was a local context pointer, not permanent public evidence.
Its existence did not prove completion or qualification of the replacement session.

## Bounded process correction

On 2026-11-20, this retro adopted the replacement brief's explicit route for this completion effort.
Future native assignments would identify themselves as native chief-of-staff work and give the brief, evidence destination, and stopping boundary before task details.
They would use engineering skills for the task, rather than an Operator dispatch role.
Before continuing a dispatch, the supervisor would check that its first response followed the native route and retained the authority boundary.
An absolute brief alone would not convert native work into an Operator assignment.
The [later ownership decision](issue-373-user-constraints.md#later-ownership-decision-on-2026-11-20) removed the earlier inventory's ownership uncertainty without removing work-preservation checks.

## Procedure access and existing checks

On 2026-11-20, the retro verified `retro`, `to-spec`, `to-tickets`, and `implement-spec` at `/home/fveracoechea/.agents/skills/<name>/SKILL.md`.
Those host files supplemented the [checkout-local missing-pointer record](issue-373-user-constraints.md#known-chief-of-staff-pointer-limitation).
The retro followed the installed `retro/SKILL.md`; the other three procedures were only located, not executed.
This host observation was not a portable path guarantee or a global skill repair.

At `fveracoechea/operator@3f40479`, `package.json` and `.github/workflows/quality.yml` already wired static quality and sharded tests into PR CI.
At that commit, `format:check` omitted `docs/wiki/`, so this documentation review checked that directory explicitly.
At that commit, `tools/check-skill-shape.ts` checked the bundled `skills/` tree, not the chief-of-staff procedure paths or native dispatch selection.
The command-example and guide-resolution tests in `src/modules/operator-cli/run.command-examples.test.ts` also did not validate native routing.
The retro found no basis to describe the repository as lacking quality checks.

## Pursued and deferred changes

On 2026-11-20, the retro pursued only the dated routing lesson, host procedure pointers, and ownership supersession in this wiki.
It left global skills, agent instructions, runtime code, and CI unchanged.
It deferred global trigger changes because one misrouted native session did not establish a defect in the Operator-only skill's contract.
It deferred a procedure-link checker to a separately authorized tooling task; missing files were mechanically checkable, but repairing tooling exceeded this docs-only assignment.
It deferred a dispatch regression check until an authorized native dispatch entry point and observable routing contract were defined.
No transcript export, full test suite, runtime operation, ready transition, review post, or merge formed part of this retro.
