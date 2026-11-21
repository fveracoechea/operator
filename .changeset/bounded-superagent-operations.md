---
"@fveracoechea/operator": major
---

Require the current PR-feedback owner to record `operator pr validate --file <text|->` evidence after a changed known ready head.
Validation is exact-head and readiness-bound, preserves ordinary review rounds and readiness, and does not replace GitHub approval or fresh stack review.
Unknown migration heads retain their existing policy.

Enforce source-wide merge holds for new owner and parked-supervisor merge or enqueue effects.
A hold cannot cancel an accepted direct request or queue entry.
Persist direct request intent before submission and recover its original UUID without duplicate submissions.
An uncertain request without a UUID remains unresolved rather than being blindly retried.
Keep queue membership readback, parking, batch-owned completion, and unlanded-work cleanup protections.

Add explicitly requested local HTTP(S) opening through one fixed direct-argv opener.
Unsupported desktop contexts refuse with a manual next step; acceptance does not prove that a browser opened.
