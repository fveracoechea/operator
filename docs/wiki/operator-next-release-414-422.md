# Next release scope for #414 and #422

## Authorization on 2026-11-21

The person requested completion of existing PRs #415 and #423 for 3.0.0, then explicitly instructed their merge to main.
The approved amendments are [#414](https://github.com/fveracoechea/operator/issues/414#issuecomment-7067082608) and [#422](https://github.com/fveracoechea/operator/issues/422#issuecomment-7067082891).
Supervisor delivery remains parked-only.
Changed known ready heads require separate current-feedback-owner validation, bound to exact head and readiness provenance.
Unknown migration heads remain unknown; ordinary corrections preserve readiness and review rounds.
Changed stack integration head or review base instead requires fresh review, including after exhausted earlier rounds.

## Integration boundary

The accepted #373 baseline was `fveracoechea/operator@ab228eba553720f4da0a2980533106fb9e5c38ac`.
Live main advanced only through owned-skill guidance to `5c329a4003bf1f7bdba36fba47f6cef9daa0c4a1` before #415's refresh.
That commit was ordinarily merged into the existing #415 lineage in an isolated worktree.
Land #415 before #423 and verify their combined delivery/stack exclusion.
This sequence creates no fictitious native tracker blocker.
Preserve shipped migrations through 0027, including handoffs and the inactive stack foundation; append delivery storage after them.

## Qualification and release boundary

Scoped tests and static checks qualify only their recorded candidate and scope.
Mutation diagnostics are non-gating and must not be described as a clean campaign when unfinished.
Final full quality, current CI, isolated smoke, and independent review require the actual final candidate; this entry claims none in advance.
The shared fixture correction is `8198c29d3e40ef7b7132f51505722b8ee256584a`; its baseline receipts do not qualify future feature changes.
Feature landing does not authorize runtime activation, real-device migration, tags, or publication.
ADR-0007 still requires quality and release smoke on the merged version commit, followed by explicit publication authorization.

## Independent #415 corrections on 2026-11-21

Both independent reviews requested changes at `bc9ad9907151a3939302d19b0a5a540eb66920cd`, tree `567840e17ae717bfb6484b2a6f994381f56254e6`.
Main and merge-base were `e5606a7b7168248992655dcc04ba4f45e1cd4f61`.
The review reports are `/tmp/opencode/operator-next-release-415-standards.md` and `/tmp/opencode/operator-next-release-415-spec.md`.
They reproduced blocked queued feedback waits, blocked queued correction validation, missing selected-recovery arguments, and unreconciled refused queue admission.

The correction distinguishes queue observation and evidence from relay or delivery admission.
Unfinished direct requests and competing stack effects still block those operations.
Selected recovery keeps its source and assignment without resubmitting an unknown request.
Each new queue admission has an attempt identity.
Only a typed mutation-level refusal, with absent membership at the same open head, releases that exact attempt.
Generic errors, partial responses, lost answers, and absent membership alone retain the receipt.
An old refusal cannot clear a later same-head attempt.
Queued feedback correction, validation, wait, parking, and batch-owned completion have a public CLI regression.

All receipts below use `/tmp/opencode/issue373-qualification/runs/`.
The frozen `pr415-final-qualification-quality.json` failed with 4,821 passing tests and 27 failures.
The same-head `pr415-final-qualification-linux-flake.json` passed, but does not qualify a corrected descendant.
The full run also found outdated synthetic migration prefixes, omitted correction evidence in installed workflows, stale guard-test selectors, and guide-budget failures.
Their corrections retain the assertions and do not weaken production gates.
`pr415-corrections-red.json` captures five reproduced failures, including public queued-wait and selected-recovery failures.
`pr415-corrections-owning2.json` records 353 passing tests across 20 files, including isolated source and registry delivery.
`pr415-corrections-static3.json` records passing static checks.
Those dirty-tree diagnostic receipts are development evidence, not final qualification.
Final descendant receipts are `pr415-corrected-final-quality.json`, `pr415-corrected-final-linux-flake.json`, and `pr415-corrected-final-delivery.json`.
Their actual head, tree, outcomes, CI, and fresh review verdicts must be read from the receipts and `/tmp/opencode/operator-next-release-415-landing.md`.
This entry does not claim those future runs or merge readiness.

The earlier guard mutation diagnostic recorded 39 killed mutants and 15 survivors, with no untested or incomplete mutants.
It was not a complete changed-production campaign and remains non-gating.
Populated direct-intent and source/assignment exclusion assertions were added for the concrete review gap.
No new mutation campaign or zero-survivor requirement was added.
