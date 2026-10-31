---
"@fveracoechea/operator": minor
---

Internal review of a draft PR is on by default (ADR-0020).
A PR brief now tells the implementer to open a draft PR, run `operator pr associate`, tell the SuperAgent, and stop. When a PR is already recorded, the brief tells the owner of a draft PR that it is the internal reviewer.
`operator config apply --set review.internal=false` turns internal review off for the device. A plan's `internalReview` field turns it off or on for all its assignments, and a PR assignment's `internalReview` field turns it off or on for that assignment. The most specific value wins. A report assignment refuses the field.
With internal review off, the brief is unchanged and the implementer opens a ready PR.
