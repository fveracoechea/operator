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
